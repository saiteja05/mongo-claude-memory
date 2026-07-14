import type { Db, Document } from "mongodb";
import { OBSERVATIONS, BELIEFS } from "../db/schema.js";
import type { Observation } from "../db/schema.js";
import type { CandidateFact, ExistingBeliefContext } from "./extractFacts.js";
import type { UpsertBeliefResult } from "./upsertBelief.js";
import { validateCandidateFact } from "./validateFact.js";
import { classifyInjection as defaultClassifyInjection } from "./classifyInjection.js";
import type { ClassifyInjectionResult } from "./classifyInjection.js";
import { isNonRetryableLLMError } from "../llm/errors.js";
import { appendFailure } from "../telemetry/failureLog.js";
import { quarantineDroppedCandidate } from "./quarantine.js";

export interface RunConsolidationResult {
  processed: number;
  skipped: boolean;
  reason?: string;
  leaseLost?: boolean;
}

export interface RunConsolidationDeps {
  runId: string;
  leaseMs: number;
  claimBatchSize: number;
  reclaimAfterMs: number;
  beliefsContextLimit: number;
  dedupeSimilarityThreshold: number;
  // Circuit breaker (config.ts's maxConsecutiveTerminalExtractionFailures):
  // when extractWithSplit isolates and marks failed this many single
  // observations in a row without a successful extraction in between, the
  // run aborts on the assumption of a global provider problem (invalid
  // credentials, quota exhaustion) rather than continuing to mark the rest
  // of the queue failed one observation at a time. Required, not optional,
  // like the other run-shape fields above: production callers wire it from
  // config (buildDeps in cli.ts), tests set it explicitly to control when the
  // breaker trips.
  maxConsecutiveTerminalExtractionFailures: number;
  // "auto" (Atlas autoEmbed) skips the embed() call entirely for belief
  // documents, since Atlas computes the embedding server-side from the
  // "text" path. Optional, defaulting to "appside" (current behavior), so
  // existing callers/tests that omit it are unaffected.
  embeddingMode?: "appside" | "auto";
  // Total text-length budget for one claimed batch (see claim.ts). Optional
  // so existing callers/tests that omit it keep claimBatch's own default.
  consolidationBatchMaxChars?: number;
  reclaimStale: (db: Db, project: string, reclaimAfterMs: number, runId: string) => Promise<number>;
  acquireLease: (db: Db, project: string, runId: string, leaseMs: number) => Promise<boolean>;
  renewLease: (db: Db, project: string, runId: string, leaseMs: number) => Promise<boolean>;
  releaseLease: (db: Db, project: string, runId: string) => Promise<void>;
  claimBatch: (
    db: Db,
    project: string,
    runId: string,
    batchSize: number,
    maxChars?: number
  ) => Promise<Observation[]>;
  fetchExistingBeliefs: (db: Db, project: string, limit: number) => Promise<ExistingBeliefContext[]>;
  extractFacts: (
    observations: Observation[],
    existingBeliefs: ExistingBeliefContext[]
  ) => Promise<CandidateFact[]>;
  // Second, independent LLM-based prompt-injection check, run per-candidate
  // alongside the deterministic validateCandidateFact/validateBeliefText
  // checks (DESIGN.md section 9). Optional: when omitted, defaults to the
  // real classifyInjection (classifyInjection.ts), which itself fails open
  // on any provider error or malformed response, so production callers that
  // do not set this field still get the real check, while tests must
  // explicitly inject a fake to avoid making a real LLM call.
  classifyInjection?: (text: string) => Promise<ClassifyInjectionResult>;
  // Quarantines a candidate dropped by validateCandidateFact (stage
  // "deny-list") or classifyInjection (stage "classifier") so a
  // false-positive drop is recoverable instead of gone forever. Optional:
  // when omitted, defaults to the real quarantineDroppedCandidate
  // (quarantine.ts), which itself never throws (a quarantine failure must
  // never fail a consolidation run), so production callers that do not set
  // this field still get the real quarantine, while tests must explicitly
  // inject a fake to observe it without touching a real db.
  quarantineDropped?: typeof quarantineDroppedCandidate;
  embed: (texts: string[]) => Promise<number[][]>;
  upsertBelief: (
    db: Db,
    project: string,
    candidate: CandidateFact,
    embedding: number[] | null,
    threshold: number,
    candidateEvidenceAt?: Date
  ) => Promise<UpsertBeliefResult>;
  compileBrief: (db: Db, scopeKey: string) => Promise<void>;
  markConsolidated: (
    db: Db,
    project: string,
    runId: string,
    observationIds: unknown[]
  ) => Promise<void>;
  // Terminal single-observation failure marker, called by extractWithSplit
  // below once a non-retryable LLM failure has been isolated down to one
  // observation. Optional so existing callers/tests that omit it still get
  // the real markObservationFailed; tests that need to observe or stub it
  // can inject their own.
  markFailed?: (
    db: Db,
    project: string,
    runId: string,
    observationId: string,
    reasonName: string
  ) => Promise<void>;
}

/**
 * Default beliefs-context query: up to `limit` active beliefs for the
 * project, most recently updated first, so the LLM's dedupe/supersede
 * context window contains the beliefs most likely to be relevant to new
 * observations rather than an arbitrary natural-order slice.
 */
export async function fetchExistingBeliefs(
  db: Db,
  project: string,
  limit: number
): Promise<ExistingBeliefContext[]> {
  const docs = await db
    .collection<Document>(BELIEFS)
    .find({ project, status: "active" }, { projection: { text: 1 } })
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray();
  return docs.map((doc) => ({ _id: String(doc._id), text: String(doc.text) }));
}

/**
 * Default consolidated-marking: only marks observations still owned by this
 * run_id and still "claimed", so a document extractWithSplit already moved
 * to "failed" (or one some other run already reset) can never be silently
 * flipped back to "consolidated" by this call.
 */
export async function markConsolidated(
  db: Db,
  project: string,
  runId: string,
  observationIds: unknown[]
): Promise<void> {
  await db.collection<Observation>(OBSERVATIONS).updateMany(
    { _id: { $in: observationIds as never[] }, project, run_id: runId, status: "claimed" },
    { $set: { status: "consolidated" } }
  );
}

/**
 * Default terminal-failure marking: moves a single observation to "failed"
 * (excluded from reclaimStale and findPendingProjects, so it is never handed
 * back for reprocessing), only while it is still owned by this run_id and
 * still "claimed", mirroring markConsolidated's guard. reasonName must be an
 * error NAME only (e.g. "NonRetryableLLMError"), never an error message:
 * provider/driver error messages can embed connection strings or other
 * secret-bearing detail, and failure_reason is a persisted field.
 */
export async function markObservationFailed(
  db: Db,
  project: string,
  runId: string,
  observationId: string,
  reasonName: string
): Promise<void> {
  await db.collection<Observation>(OBSERVATIONS).updateOne(
    { _id: observationId as never, project, run_id: runId, status: "claimed" },
    { $set: { status: "failed", failed_at: new Date(), failure_reason: reasonName } }
  );
}

/**
 * Defense-in-depth wrapper around the (possibly injected) quarantineDropped
 * dependency: the real quarantineDroppedCandidate already guarantees it
 * never throws, but an injected dependency (in tests, or a future caller)
 * might not uphold that contract itself. A quarantine failure must never
 * fail a consolidation run, so any rejection here is swallowed rather than
 * propagated.
 */
async function quarantineSafely(
  db: Db,
  project: string,
  runId: string,
  candidate: CandidateFact,
  stage: "deny-list" | "classifier",
  reason: string,
  quarantineDropped: typeof quarantineDroppedCandidate
): Promise<void> {
  try {
    await quarantineDropped(db, project, runId, candidate, stage, reason);
  } catch {
    // Swallowed: quarantine is best effort, never allowed to fail the run.
  }
}

interface ExtractWithSplitResult {
  candidates: CandidateFact[];
  failedIds: string[];
  leaseLost: boolean;
}

/**
 * Mutable, per-run counter of consecutive single-observation terminal
 * extraction failures, threaded through every recursive extractWithSplit
 * call for one runConsolidation invocation. Any successful extractFacts call
 * (at any level: the whole batch or a split half) resets it to 0; only a
 * leaf (single-observation) non-retryable failure increments it. Plain
 * mutable object rather than a return value, since extractWithSplit already
 * returns its own result shape and the counter must survive across sibling
 * recursive calls (left then right), not just within one call.
 */
interface CircuitBreakerState {
  consecutiveFailures: number;
}

/**
 * Thrown when the consecutive-single-observation-failure circuit breaker
 * trips. Deliberately uncaught anywhere in extractWithSplit's own recursion
 * (only the deps.extractFacts call itself is wrapped in a try/catch at each
 * level), so it propagates all the way out of runConsolidation exactly like
 * an unhandled transient extraction failure does: the existing finally still
 * releases the lease, and markConsolidated is never reached for the
 * observations that were still claimed when the breaker tripped, leaving
 * them for the stale-claim sweep to reclaim rather than branding the rest of
 * the queue failed one observation at a time. The message is hand-authored
 * (never a provider error's raw message), so it is safe for cli.ts's
 * generic run-failed catch to log in full.
 */
class ConsolidationCircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsolidationCircuitBreakerError";
  }
}

/**
 * Split-retry wrapper around deps.extractFacts (P1: a claimed batch that
 * fails extraction non-retryably, e.g. output truncated by max_tokens, or an
 * input too large for the model's context, used to be reclaimed by the
 * stale-claim sweep and re-fail identically forever). On a non-retryable
 * failure (isNonRetryableLLMError), the batch is bisected and each half
 * retried on its own, recursively, until the single observation actually
 * responsible is isolated and marked "failed" via deps.markFailed, letting
 * every other observation in the original batch still be processed
 * normally. A transient failure is NOT split: it is rethrown immediately,
 * exactly as before this change, since dividing the batch does nothing for
 * a network blip or a rate limit that will recover on its own.
 *
 * Renews the lease before every extraction attempt, including this
 * function's very first (whole-batch) call, not just once per original
 * batch: each split half is its own LLM call, so a batch that ends up
 * bisected several times can otherwise still be mid-split after the
 * original lease's heldUntil has passed. Reports leaseLost immediately
 * (without attempting extraction) and, for a split, does not attempt the
 * right half once the left half has already reported it, so a lease lost
 * mid-split stops the whole subtree rather than continuing to spend calls
 * under a lease this run no longer holds.
 *
 * Worst case O(n) extractFacts calls for n observations (a full binary split
 * down to n single-observation leaves has n-1 internal nodes, each of which
 * only re-attempts once before dividing further), not O(n log n): no
 * subtree is ever retried as a whole after it has already been split once.
 *
 * breaker carries the run-scoped consecutive-single-observation-failure
 * count (see CircuitBreakerState above). A successful extraction, at any
 * level, resets it to 0; a leaf (single-observation) non-retryable failure
 * increments it and, once it reaches deps.maxConsecutiveTerminalExtractionFailures,
 * throws ConsolidationCircuitBreakerError instead of returning normally,
 * aborting the whole run on the assumption of a global provider problem
 * (invalid credentials, quota exhaustion) rather than continuing to mark the
 * rest of the queue failed one observation at a time.
 */
async function extractWithSplit(
  db: Db,
  project: string,
  observations: Observation[],
  existingBeliefs: ExistingBeliefContext[],
  deps: RunConsolidationDeps,
  breaker: CircuitBreakerState
): Promise<ExtractWithSplitResult> {
  const stillHolding = await deps.renewLease(db, project, deps.runId, deps.leaseMs);
  if (!stillHolding) {
    return { candidates: [], failedIds: [], leaseLost: true };
  }

  try {
    const candidates = await deps.extractFacts(observations, existingBeliefs);
    breaker.consecutiveFailures = 0;
    return { candidates, failedIds: [], leaseLost: false };
  } catch (err) {
    if (!isNonRetryableLLMError(err)) {
      throw err;
    }

    if (observations.length === 1) {
      const observationId = String(observations[0]._id);
      const reasonName = err instanceof Error ? err.name : "UnknownError";
      appendFailure("extractFacts.terminal", err);
      console.error(
        `[consolidate] project="${project}": observation ${observationId} failed extraction ` +
          `non-retryably (${reasonName}); marking it failed so it is not retried forever.`
      );
      await (deps.markFailed ?? markObservationFailed)(
        db,
        project,
        deps.runId,
        observationId,
        reasonName
      );

      breaker.consecutiveFailures += 1;
      if (breaker.consecutiveFailures >= deps.maxConsecutiveTerminalExtractionFailures) {
        console.error(
          `[consolidate] project="${project}": circuit breaker tripped after ` +
            `${breaker.consecutiveFailures} consecutive single-observation extraction failures ` +
            `(last: ${reasonName}); aborting this run on the assumption of a global provider ` +
            "problem (for example invalid credentials or quota exhaustion) rather than continuing " +
            "to mark the rest of the queue failed one observation at a time. Observations already " +
            `marked failed above stay failed; run --retry-failed ${project} once the provider is ` +
            "healthy again to requeue them."
        );
        throw new ConsolidationCircuitBreakerError(
          `project="${project}": aborted after ${breaker.consecutiveFailures} consecutive ` +
            `single-observation extraction failures (${reasonName})`
        );
      }

      return { candidates: [], failedIds: [observationId], leaseLost: false };
    }

    const mid = Math.ceil(observations.length / 2);
    const left = observations.slice(0, mid);
    const right = observations.slice(mid);

    const leftResult = await extractWithSplit(db, project, left, existingBeliefs, deps, breaker);
    if (leftResult.leaseLost) {
      return leftResult;
    }

    const rightResult = await extractWithSplit(db, project, right, existingBeliefs, deps, breaker);
    return {
      candidates: [...leftResult.candidates, ...rightResult.candidates],
      failedIds: [...leftResult.failedIds, ...rightResult.failedIds],
      leaseLost: rightResult.leaseLost,
    };
  }
}

/**
 * Orchestrates one consolidation pass for a single project (DESIGN.md 5.2).
 * Always releases the lease in a finally block, even if extraction or
 * upsert throws partway through, so a crashed or failing run never leaves a
 * lease dangling for its full TTL.
 */
export async function runConsolidation(
  db: Db,
  project: string,
  deps: RunConsolidationDeps
): Promise<RunConsolidationResult> {
  await deps.reclaimStale(db, project, deps.reclaimAfterMs, deps.runId);

  const acquired = await deps.acquireLease(db, project, deps.runId, deps.leaseMs);
  if (!acquired) {
    return { processed: 0, skipped: true, reason: "lease held" };
  }

  try {
    const claimed = await deps.claimBatch(
      db,
      project,
      deps.runId,
      deps.claimBatchSize,
      deps.consolidationBatchMaxChars
    );
    if (claimed.length === 0) {
      return { processed: 0, skipped: false };
    }

    // Map observation id -> created_at so each candidate can carry the
    // timestamp of its newest backing observation (its "evidence time").
    // upsertBelief uses it to refuse stale text overwrites: without it, a
    // reprocessed old observation could regress a belief that a newer
    // correction already updated (dedupe last-write-wins).
    const observationCreatedAt = new Map<string, Date>();
    for (const doc of claimed) {
      if (doc.created_at instanceof Date) {
        observationCreatedAt.set(String(doc._id), doc.created_at);
      }
    }

    const existingBeliefs = await deps.fetchExistingBeliefs(db, project, deps.beliefsContextLimit);
    const breaker: CircuitBreakerState = { consecutiveFailures: 0 };
    const extraction = await extractWithSplit(db, project, claimed, existingBeliefs, deps, breaker);

    if (extraction.leaseLost) {
      console.error(
        `[consolidate] project="${project}": lease lost mid-run during extraction (another run has ` +
          "taken over); stopping and leaving the claimed observations for the stale-claim sweep to reclaim."
      );
      return { processed: 0, skipped: false, leaseLost: true };
    }

    const candidates = extraction.candidates;
    const failedIds = new Set(extraction.failedIds);

    let processed = 0;
    let globalChanged = false;
    let leaseLost = false;

    for (const candidate of candidates) {
      // Renew before every candidate's embed+upsert, not just once per
      // batch: a batch with many candidates, or a slow/rate-limited
      // embed/LLM call, can otherwise still be mid-loop after the original
      // lease's heldUntil has passed, letting a second concurrent run
      // acquire the "expired" lease and process the same observations.
      const stillHolding = await deps.renewLease(db, project, deps.runId, deps.leaseMs);
      if (!stillHolding) {
        console.error(
          `[consolidate] project="${project}": lease lost mid-run (another run has taken over); ` +
            `stopping after ${processed} processed candidate(s) and skipping brief compilation ` +
            "and markConsolidated for this run so the claimed observations are left for the stale-claim sweep to reclaim."
        );
        leaseLost = true;
        break;
      }

      const validation = validateCandidateFact(candidate);
      if (!validation.valid) {
        console.error(
          `[consolidate] dropped candidate fact (${validation.reason}): "${candidate.text.slice(0, 80)}"`
        );
        await quarantineSafely(
          db,
          project,
          deps.runId,
          candidate,
          "deny-list",
          validation.reason ?? "invalid",
          deps.quarantineDropped ?? quarantineDroppedCandidate
        );
        continue;
      }

      const classification = await (deps.classifyInjection ?? defaultClassifyInjection)(candidate.text);
      if (classification.isInjection) {
        console.error(
          `[consolidate] dropped candidate fact (classifyInjection flagged as prompt injection` +
            `${classification.reason ? `: ${classification.reason}` : ""}): "${candidate.text.slice(0, 80)}"`
        );
        await quarantineSafely(
          db,
          project,
          deps.runId,
          candidate,
          "classifier",
          classification.reason ?? "flagged",
          deps.quarantineDropped ?? quarantineDroppedCandidate
        );
        continue;
      }

      // In "auto" (Atlas autoEmbed) mode, skip the embed() call entirely:
      // Atlas computes and stores the embedding server-side from the belief
      // doc's "text" path, so no app-side Voyage call is needed here.
      const embedding =
        deps.embeddingMode === "auto" ? null : (await deps.embed([candidate.text]))[0];

      // The candidate's evidence time is the newest created_at among its
      // backing observations (undefined when none resolve, e.g. mocked ids;
      // upsertBelief falls back to now).
      const evidenceTimes = candidate.observation_ids
        .map((id) => observationCreatedAt.get(String(id)))
        .filter((date): date is Date => date instanceof Date);
      const candidateEvidenceAt =
        evidenceTimes.length > 0
          ? new Date(Math.max(...evidenceTimes.map((date) => date.getTime())))
          : undefined;

      await deps.upsertBelief(
        db,
        project,
        candidate,
        embedding,
        deps.dedupeSimilarityThreshold,
        candidateEvidenceAt
      );
      processed++;
      if (candidate.scope === "core") {
        globalChanged = true;
      }
    }

    if (leaseLost) {
      return { processed, skipped: false, leaseLost: true };
    }

    // Recompile the brief(s) before marking observations consolidated
    // (DESIGN.md 5.2 steps 8-9), so a crash between the two leaves the source
    // observations "claimed" (reclaimable by the sweep and reprocessable)
    // rather than durably "consolidated" with a brief that was never
    // recompiled to reflect them and no forcing function to retry.
    await deps.compileBrief(db, project);
    if (globalChanged && project !== "global") {
      await deps.compileBrief(db, "global");
    }

    // Mark every claimed observation consolidated once the batch has been
    // through the LLM pass, whether or not it yielded a valid fact: it was
    // still fully processed, and leaving it "claimed" forever would only be
    // cleared by the reclaim sweep, causing repeated reprocessing of the
    // same unproductive text. Observations extractWithSplit already moved to
    // "failed" are excluded: markConsolidated's own status: "claimed" guard
    // would no-op on them anyway, but excluding them here keeps this call's
    // intent explicit rather than relying on that guard alone.
    const claimedIds = claimed
      .map((doc) => doc._id)
      .filter((id) => !failedIds.has(String(id)));
    await deps.markConsolidated(db, project, deps.runId, claimedIds);

    return { processed, skipped: false };
  } finally {
    await deps.releaseLease(db, project, deps.runId);
  }
}
