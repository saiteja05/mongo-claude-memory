import type { Db, Document } from "mongodb";
import { OBSERVATIONS, BELIEFS } from "../db/schema.js";
import type { Observation } from "../db/schema.js";
import type { CandidateFact, ExistingBeliefContext } from "./extractFacts.js";
import type { UpsertBeliefResult } from "./upsertBelief.js";
import { validateCandidateFact } from "./validateFact.js";
import { classifyInjection as defaultClassifyInjection } from "./classifyInjection.js";
import type { ClassifyInjectionResult } from "./classifyInjection.js";

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

/** Default consolidated-marking: only marks observations still owned by this run_id. */
export async function markConsolidated(
  db: Db,
  project: string,
  runId: string,
  observationIds: unknown[]
): Promise<void> {
  await db.collection<Observation>(OBSERVATIONS).updateMany(
    { _id: { $in: observationIds as never[] }, project, run_id: runId },
    { $set: { status: "consolidated" } }
  );
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
    const candidates = await deps.extractFacts(claimed, existingBeliefs);

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
        continue;
      }

      const classification = await (deps.classifyInjection ?? defaultClassifyInjection)(candidate.text);
      if (classification.isInjection) {
        console.error(
          `[consolidate] dropped candidate fact (classifyInjection flagged as prompt injection` +
            `${classification.reason ? `: ${classification.reason}` : ""}): "${candidate.text.slice(0, 80)}"`
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
    // same unproductive text.
    const claimedIds = claimed.map((doc) => doc._id);
    await deps.markConsolidated(db, project, deps.runId, claimedIds);

    return { processed, skipped: false };
  } finally {
    await deps.releaseLease(db, project, deps.runId);
  }
}
