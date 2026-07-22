import { BELIEFS, BRIEFS, DROPPED_CANDIDATES, LOCKS, OBSERVATIONS } from "../db/schema.js";
const LOCK_PROJECT_PREFIX = "consolidate:";
function groupByProjectStatus(docs) {
    return docs.map((doc) => ({
        project: String(doc._id?.project ?? ""),
        status: String(doc._id?.status ?? ""),
        count: doc.count,
    }));
}
function groupByProjectStage(docs) {
    return docs.map((doc) => ({
        project: String(doc._id?.project ?? ""),
        stage: String(doc._id?.stage ?? ""),
        count: doc.count,
    }));
}
function lockProjectLabel(id) {
    const raw = String(id);
    return raw.startsWith(LOCK_PROJECT_PREFIX) ? raw.slice(LOCK_PROJECT_PREFIX.length) : raw;
}
/**
 * Read-only point-in-time snapshot of the consolidation system's state:
 * observation and belief counts by project/status, stale claim count,
 * current lock state, brief metadata, and quarantined dropped-candidate
 * counts by project/stage. Never mutates anything, including the
 * stale-claim count (unlike claim.ts's reclaimStale, which is the mutating
 * counterpart of this same staleness check).
 */
export async function getStatusReport(db, reclaimAfterMs) {
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - reclaimAfterMs);
    const observationsCollection = db.collection(OBSERVATIONS);
    const beliefsCollection = db.collection(BELIEFS);
    const observationCountsRaw = (await observationsCollection
        .aggregate([{ $group: { _id: { project: "$project", status: "$status" }, count: { $sum: 1 } } }])
        .toArray());
    const observationCounts = groupByProjectStatus(observationCountsRaw);
    const staleClaimCount = await observationsCollection.countDocuments({
        status: "claimed",
        claimed_at: { $lt: staleThreshold },
    });
    const lockDocs = await db.collection(LOCKS).find({}).toArray();
    const locks = lockDocs.map((doc) => ({
        project: lockProjectLabel(doc._id),
        holder: String(doc.holder ?? ""),
        heldUntil: doc.heldUntil,
        live: doc.heldUntil > now,
    }));
    const beliefCountsRaw = (await beliefsCollection
        .aggregate([{ $group: { _id: { project: "$project", status: "$status" }, count: { $sum: 1 } } }])
        .toArray());
    const beliefCounts = groupByProjectStatus(beliefCountsRaw);
    const briefDocs = await db.collection(BRIEFS).find({}).toArray();
    const briefs = briefDocs.map((doc) => ({
        id: String(doc._id),
        tokenEstimate: Number(doc.token_estimate ?? 0),
        beliefCount: Array.isArray(doc.belief_ids) ? doc.belief_ids.length : 0,
        generation: Number(doc.generation ?? 0),
        generatedAt: doc.generated_at,
    }));
    const droppedCandidatesRaw = (await db
        .collection(DROPPED_CANDIDATES)
        .aggregate([{ $group: { _id: { project: "$project", stage: "$stage" }, count: { $sum: 1 } } }])
        .toArray());
    const droppedCandidates = groupByProjectStage(droppedCandidatesRaw);
    return { observationCounts, staleClaimCount, locks, beliefCounts, briefs, droppedCandidates };
}
/**
 * Renders a StatusReport as readable multi-line text for CLI output. Labeled
 * explicitly as a current snapshot (a single point in time), not a time
 * series or historical trend. No em dashes: uses commas and parentheses
 * instead.
 */
export function formatStatusReport(report) {
    const lines = [];
    lines.push("[status] current snapshot (point in time, not a time series):");
    lines.push("Observations by project/status:");
    if (report.observationCounts.length === 0) {
        lines.push("  (none)");
    }
    else {
        for (const row of report.observationCounts) {
            lines.push(`  - project="${row.project}", status=${row.status}: ${row.count}`);
        }
    }
    lines.push(`Stale claims (past reclaim threshold, not yet reclaimed): ${report.staleClaimCount}`);
    const failedObservationCount = report.observationCounts
        .filter((row) => row.status === "failed")
        .reduce((sum, row) => sum + row.count, 0);
    lines.push(`Failed observations (terminal, will not retry): ${failedObservationCount}`);
    lines.push("Locks:");
    if (report.locks.length === 0) {
        lines.push("  (none)");
    }
    else {
        for (const lock of report.locks) {
            lines.push(`  - project="${lock.project}", holder=${lock.holder}, heldUntil=${lock.heldUntil.toISOString()}, ` +
                `live=${lock.live}`);
        }
    }
    lines.push("Beliefs by project/status:");
    if (report.beliefCounts.length === 0) {
        lines.push("  (none)");
    }
    else {
        for (const row of report.beliefCounts) {
            lines.push(`  - project="${row.project}", status=${row.status}: ${row.count}`);
        }
    }
    lines.push("Dropped candidates (quarantined, TTL-bounded):");
    if (report.droppedCandidates.length === 0) {
        lines.push("  (none)");
    }
    else {
        for (const row of report.droppedCandidates) {
            lines.push(`  - project="${row.project}", stage=${row.stage}: ${row.count}`);
        }
    }
    lines.push("Briefs:");
    if (report.briefs.length === 0) {
        lines.push("  (none)");
    }
    else {
        for (const brief of report.briefs) {
            lines.push(`  - id=${brief.id}, generation=${brief.generation}, beliefCount=${brief.beliefCount}, ` +
                `tokenEstimate=${brief.tokenEstimate}, generatedAt=${brief.generatedAt.toISOString()}`);
        }
    }
    return lines.join("\n");
}
