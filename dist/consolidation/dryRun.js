import { OBSERVATIONS } from "../db/schema.js";
import { extractFacts as defaultExtractFacts } from "./extractFacts.js";
import { fetchExistingBeliefs as defaultFetchExistingBeliefs } from "./run.js";
import { validateCandidateFact as defaultValidateCandidateFact } from "./validateFact.js";
/**
 * Read-only mirror of claimBatch's initial find (same filter, sort, and
 * limit), with no updateMany claim step: this never changes an
 * observation's status, run_id, or claimed_at, so it is safe to call
 * repeatedly without affecting a later real consolidation run.
 */
export async function previewBatch(db, project, batchSize) {
    return db
        .collection(OBSERVATIONS)
        .find({ project, status: "pending" })
        .sort({ created_at: 1 })
        .limit(batchSize)
        .toArray();
}
/**
 * Default deps for runConsolidationDryRun, wiring the real implementations
 * from run.ts / extractFacts.ts / validateFact.ts. Exported so callers (the
 * CLI) can build the numeric fields from config while reusing these
 * defaults for the function fields.
 */
export function defaultDryRunDeps(previewBatchSize, beliefsContextLimit) {
    return {
        previewBatchSize,
        beliefsContextLimit,
        previewBatch,
        fetchExistingBeliefs: defaultFetchExistingBeliefs,
        extractFacts: defaultExtractFacts,
        validateCandidateFact: defaultValidateCandidateFact,
    };
}
/**
 * Read-only preview of one consolidation pass: previews a batch, extracts
 * candidate facts, and validates them, but never calls acquireLease, embed,
 * upsertBelief, compileBrief, or markConsolidated. Makes zero writes.
 *
 * If the preview batch is empty, returns immediately without calling
 * fetchExistingBeliefs or extractFacts, so an empty project never costs an
 * LLM call.
 */
export async function runConsolidationDryRun(db, project, deps) {
    const observations = await deps.previewBatch(db, project, deps.previewBatchSize);
    if (observations.length === 0) {
        return { previewed: 0, accepted: [], rejected: [] };
    }
    const existingBeliefs = await deps.fetchExistingBeliefs(db, project, deps.beliefsContextLimit);
    const candidates = await deps.extractFacts(observations, existingBeliefs);
    const accepted = [];
    const rejected = [];
    for (const candidate of candidates) {
        const validation = deps.validateCandidateFact(candidate);
        if (validation.valid) {
            accepted.push({
                text: candidate.text,
                type: candidate.type,
                scope: candidate.scope,
                importance: candidate.importance,
            });
        }
        else {
            rejected.push({ text: candidate.text, reason: validation.reason ?? "invalid" });
        }
    }
    return { previewed: observations.length, accepted, rejected };
}
/**
 * Renders a DryRunResult as readable multi-line text for CLI output. No em
 * dashes: uses commas and parentheses instead.
 */
export function formatDryRunReport(project, result) {
    const lines = [];
    lines.push(`[dry-run] project="${project}": previewed ${result.previewed}, accepted ${result.accepted.length}, ` +
        `rejected ${result.rejected.length} (no writes were made)`);
    if (result.accepted.length > 0) {
        lines.push("Accepted facts (would be written on a real run):");
        for (const fact of result.accepted) {
            lines.push(`  - type=${fact.type}, scope=${fact.scope}, importance=${fact.importance}: ${fact.text}`);
        }
    }
    if (result.rejected.length > 0) {
        lines.push("Rejected facts:");
        for (const fact of result.rejected) {
            lines.push(`  - ${fact.text} (reason: ${fact.reason})`);
        }
    }
    return lines.join("\n");
}
