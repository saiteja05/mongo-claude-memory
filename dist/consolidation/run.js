import { OBSERVATIONS, BELIEFS } from "../db/schema.js";
import { validateCandidateFact } from "./validateFact.js";
import { classifyInjection as defaultClassifyInjection } from "./classifyInjection.js";
import { isNonRetryableLLMError } from "../llm/errors.js";
import { appendFailure } from "../telemetry/failureLog.js";
import { quarantineDroppedCandidate } from "./quarantine.js";
/**
 * Default beliefs-context query: up to `limit` active beliefs for the
 * project, most recently updated first, so the LLM's dedupe/supersede
 * context window contains the beliefs most likely to be relevant to new
 * observations rather than an arbitrary natural-order slice.
 */
export async function fetchExistingBeliefs(db, project, limit) {
    const docs = await db
        .collection(BELIEFS)
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
export async function markConsolidated(db, project, runId, observationIds) {
    await db.collection(OBSERVATIONS).updateMany({ _id: { $in: observationIds }, project, run_id: runId, status: "claimed" }, { $set: { status: "consolidated" } });
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
export async function markObservationFailed(db, project, runId, observationId, reasonName) {
    await db.collection(OBSERVATIONS).updateOne({ _id: observationId, project, run_id: runId, status: "claimed" }, { $set: { status: "failed", failed_at: new Date(), failure_reason: reasonName } });
}
/**
 * Defense-in-depth wrapper around the (possibly injected) quarantineDropped
 * dependency: the real quarantineDroppedCandidate already guarantees it
 * never throws, but an injected dependency (in tests, or a future caller)
 * might not uphold that contract itself. A quarantine failure must never
 * fail a consolidation run, so any rejection here is swallowed rather than
 * propagated.
 */
async function quarantineSafely(db, project, runId, candidate, stage, reason, quarantineDropped) {
    try {
        await quarantineDropped(db, project, runId, candidate, stage, reason);
    }
    catch {
        // Swallowed: quarantine is best effort, never allowed to fail the run.
    }
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
    constructor(message) {
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
async function extractWithSplit(db, project, observations, existingBeliefs, deps, breaker) {
    const stillHolding = await deps.renewLease(db, project, deps.runId, deps.leaseMs);
    if (!stillHolding) {
        return { candidates: [], failedIds: [], leaseLost: true };
    }
    try {
        const candidates = await deps.extractFacts(observations, existingBeliefs);
        breaker.consecutiveFailures = 0;
        return { candidates, failedIds: [], leaseLost: false };
    }
    catch (err) {
        if (!isNonRetryableLLMError(err)) {
            throw err;
        }
        if (observations.length === 1) {
            const observationId = String(observations[0]._id);
            const reasonName = err instanceof Error ? err.name : "UnknownError";
            appendFailure("extractFacts.terminal", err);
            console.error(`[consolidate] project="${project}": observation ${observationId} failed extraction ` +
                `non-retryably (${reasonName}); marking it failed so it is not retried forever.`);
            await (deps.markFailed ?? markObservationFailed)(db, project, deps.runId, observationId, reasonName);
            breaker.consecutiveFailures += 1;
            if (breaker.consecutiveFailures >= deps.maxConsecutiveTerminalExtractionFailures) {
                console.error(`[consolidate] project="${project}": circuit breaker tripped after ` +
                    `${breaker.consecutiveFailures} consecutive single-observation extraction failures ` +
                    `(last: ${reasonName}); aborting this run on the assumption of a global provider ` +
                    "problem (for example invalid credentials or quota exhaustion) rather than continuing " +
                    "to mark the rest of the queue failed one observation at a time. Observations already " +
                    `marked failed above stay failed; run --retry-failed ${project} once the provider is ` +
                    "healthy again to requeue them.");
                throw new ConsolidationCircuitBreakerError(`project="${project}": aborted after ${breaker.consecutiveFailures} consecutive ` +
                    `single-observation extraction failures (${reasonName})`);
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
export async function runConsolidation(db, project, deps) {
    await deps.reclaimStale(db, project, deps.reclaimAfterMs, deps.runId);
    const acquired = await deps.acquireLease(db, project, deps.runId, deps.leaseMs);
    if (!acquired) {
        return { processed: 0, skipped: true, reason: "lease held" };
    }
    try {
        const claimed = await deps.claimBatch(db, project, deps.runId, deps.claimBatchSize, deps.consolidationBatchMaxChars);
        if (claimed.length === 0) {
            return { processed: 0, skipped: false };
        }
        // Map observation id -> created_at so each candidate can carry the
        // timestamp of its newest backing observation (its "evidence time").
        // upsertBelief uses it to refuse stale text overwrites: without it, a
        // reprocessed old observation could regress a belief that a newer
        // correction already updated (dedupe last-write-wins).
        const observationCreatedAt = new Map();
        for (const doc of claimed) {
            if (doc.created_at instanceof Date) {
                observationCreatedAt.set(String(doc._id), doc.created_at);
            }
        }
        const existingBeliefs = await deps.fetchExistingBeliefs(db, project, deps.beliefsContextLimit);
        const breaker = { consecutiveFailures: 0 };
        const extraction = await extractWithSplit(db, project, claimed, existingBeliefs, deps, breaker);
        if (extraction.leaseLost) {
            console.error(`[consolidate] project="${project}": lease lost mid-run during extraction (another run has ` +
                "taken over); stopping and leaving the claimed observations for the stale-claim sweep to reclaim.");
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
                console.error(`[consolidate] project="${project}": lease lost mid-run (another run has taken over); ` +
                    `stopping after ${processed} processed candidate(s) and skipping brief compilation ` +
                    "and markConsolidated for this run so the claimed observations are left for the stale-claim sweep to reclaim.");
                leaseLost = true;
                break;
            }
            const validation = validateCandidateFact(candidate);
            if (!validation.valid) {
                console.error(`[consolidate] dropped candidate fact (${validation.reason}): "${candidate.text.slice(0, 80)}"`);
                await quarantineSafely(db, project, deps.runId, candidate, "deny-list", validation.reason ?? "invalid", deps.quarantineDropped ?? quarantineDroppedCandidate);
                continue;
            }
            const classification = await (deps.classifyInjection ?? defaultClassifyInjection)(candidate.text);
            if (classification.isInjection) {
                console.error(`[consolidate] dropped candidate fact (classifyInjection flagged as prompt injection` +
                    `${classification.reason ? `: ${classification.reason}` : ""}): "${candidate.text.slice(0, 80)}"`);
                await quarantineSafely(db, project, deps.runId, candidate, "classifier", classification.reason ?? "flagged", deps.quarantineDropped ?? quarantineDroppedCandidate);
                continue;
            }
            // In "auto" (Atlas autoEmbed) mode, skip the embed() call entirely:
            // Atlas computes and stores the embedding server-side from the belief
            // doc's "text" path, so no app-side Voyage call is needed here.
            const embedding = deps.embeddingMode === "auto" ? null : (await deps.embed([candidate.text]))[0];
            // The candidate's evidence time is the newest created_at among its
            // backing observations (undefined when none resolve, e.g. mocked ids;
            // upsertBelief falls back to now).
            const evidenceTimes = candidate.observation_ids
                .map((id) => observationCreatedAt.get(String(id)))
                .filter((date) => date instanceof Date);
            const candidateEvidenceAt = evidenceTimes.length > 0
                ? new Date(Math.max(...evidenceTimes.map((date) => date.getTime())))
                : undefined;
            await deps.upsertBelief(db, project, candidate, embedding, deps.dedupeSimilarityThreshold, candidateEvidenceAt);
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
    }
    finally {
        await deps.releaseLease(db, project, deps.runId);
    }
}
