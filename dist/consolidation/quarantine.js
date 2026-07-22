import { DROPPED_CANDIDATES } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { appendFailure } from "../telemetry/failureLog.js";
const MAX_REASON_LENGTH = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Quarantines a candidate fact dropped by either the deterministic deny-list
 * validator (validateCandidateFact) or the LLM injection classifier
 * (classifyInjection) during consolidation (run.ts). Without this, a dropped
 * candidate's full text was gone forever: only an 80-char stderr line
 * remained, and its source observations were still marked consolidated, so a
 * false-positive drop silently lost a legitimate memory with no way to
 * recover or even notice it. Writes a TTL-bounded
 * (config.droppedCandidateTtlDays) document instead, keeping the full
 * candidate text recoverable and observable via status.ts.
 *
 * reason is truncated to 500 chars at write time (a classifier or validation
 * reason is normally short, but nothing enforces that upstream); text is
 * kept in full, since the whole point of this quarantine is to make the
 * complete original candidate recoverable.
 *
 * The entire body is wrapped in try/catch: a quarantine failure must never
 * fail a consolidation run, so any error here (a bad connection, a full
 * disk) is only logged via appendFailure, never rethrown. This function is
 * best effort and never throws.
 */
export async function quarantineDroppedCandidate(db, project, runId, candidate, stage, reason) {
    try {
        const config = loadConfig();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + config.droppedCandidateTtlDays * MS_PER_DAY);
        const doc = {
            project,
            run_id: runId,
            stage,
            reason: reason.slice(0, MAX_REASON_LENGTH),
            text: candidate.text,
            observation_ids: candidate.observation_ids,
            created_at: now,
            expiresAt,
        };
        if (candidate.type !== undefined) {
            doc.type = candidate.type;
        }
        if (candidate.scope !== undefined) {
            doc.scope = candidate.scope;
        }
        if (candidate.importance !== undefined) {
            doc.importance = candidate.importance;
        }
        await db.collection(DROPPED_CANDIDATES).insertOne(doc);
    }
    catch (err) {
        appendFailure("quarantineDroppedCandidate", err);
    }
}
