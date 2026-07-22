import { OBSERVATIONS } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { MAX_OBSERVATION_TEXT_LENGTH } from "./constants.js";
/**
 * Builds the observation document shared by writeObservation and
 * writeObservationsBulk, so the clamp, TTL, and chunk-field rules can never
 * diverge between the single-write and bulk-write paths. created_at is left
 * for each caller to set, since the single write stamps "now" while the bulk
 * write stamps a per-entry offset (see writeObservationsBulk).
 */
function buildObservationDoc(params, config) {
    // Raw capture text is unbounded (transcript tails, pasted content); clamp
    // it so a single observation can never blow past a sane document size. The
    // clamp is source-aware: a transcript tail keeps its END (the most recent
    // content is the most valuable), while user-authored captures (remember,
    // hash_line, mcp_write) keep their BEGINNING (the user led with the point).
    const text = params.source === "transcript"
        ? params.text.slice(-MAX_OBSERVATION_TEXT_LENGTH)
        : params.text.slice(0, MAX_OBSERVATION_TEXT_LENGTH);
    const doc = {
        project: params.project,
        session_id: params.session_id,
        source: params.source,
        priority: params.priority,
        text,
        status: "pending",
        run_id: null,
        claimed_at: null,
    };
    if (params.chunk_index !== undefined) {
        doc.chunk_index = params.chunk_index;
    }
    if (params.chunk_count !== undefined) {
        doc.chunk_count = params.chunk_count;
    }
    // High-priority user captures (/remember, hash_line) never expire, per
    // DESIGN.md section 6 ("unset for high-priority user captures"); expiresAt
    // is omitted entirely rather than set to null.
    if (params.priority === "normal") {
        doc.expiresAt = new Date(Date.now() + config.observationTtlDays * 24 * 60 * 60 * 1000);
    }
    return doc;
}
/**
 * Inserts one observation document matching DESIGN.md section 6. High-priority
 * captures (user-driven: /remember, hash_line) never expire, so expiresAt is
 * omitted entirely rather than set to null or a far future date. Normal
 * priority (e.g. transcript chunks) gets a TTL of config.observationTtlDays.
 */
export async function writeObservation(db, params) {
    const config = loadConfig();
    const doc = buildObservationDoc(params, config);
    doc.created_at = new Date();
    const result = await db.collection(OBSERVATIONS).insertOne(doc);
    return result.insertedId;
}
/**
 * Inserts many observation documents in one round trip: SessionEnd's chunked
 * transcript capture calls this once with every chunk instead of issuing N
 * sequential insertOnes, so the whole capture fits inside sessionEndTimeoutMs.
 * Builds each doc with the same shared doc-builder as writeObservation (same
 * source-aware clamp, same TTL rule), then stamps created_at as one shared
 * base timestamp plus the entry's index in milliseconds. That per-entry
 * offset matters because claimBatch sorts observations by created_at
 * ascending, and without it every doc from one insertMany would tie on
 * created_at (Date only has millisecond resolution), letting the batch come
 * back in an arbitrary order and scrambling one session's chunk order.
 */
export async function writeObservationsBulk(db, paramsList) {
    const config = loadConfig();
    const base = new Date();
    const docs = paramsList.map((params, index) => {
        const doc = buildObservationDoc(params, config);
        doc.created_at = new Date(base.getTime() + index);
        return doc;
    });
    const result = await db.collection(OBSERVATIONS).insertMany(docs, { ordered: true });
    return result.insertedIds;
}
