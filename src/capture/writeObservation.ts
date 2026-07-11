import type { Db, Document } from "mongodb";
import { OBSERVATIONS } from "../db/schema.js";
import type { ObservationSource, ObservationPriority } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { MAX_OBSERVATION_TEXT_LENGTH } from "./constants.js";

export interface WriteObservationParams {
  project: string;
  session_id: string;
  source: ObservationSource;
  priority: ObservationPriority;
  text: string;
}

/**
 * Inserts one observation document matching DESIGN.md section 6. High-priority
 * captures (user-driven: /remember, hash_line) never expire, so expiresAt is
 * omitted entirely rather than set to null or a far future date. Normal
 * priority (e.g. transcript tails) gets a TTL of config.observationTtlDays.
 */
export async function writeObservation(
  db: Db,
  params: WriteObservationParams
): Promise<unknown> {
  // Raw capture text is unbounded (transcript tails, pasted content); clamp
  // it so a single observation can never blow past a sane document size. The
  // clamp is source-aware: a transcript tail keeps its END (the most recent
  // content is the most valuable), while user-authored captures (remember,
  // hash_line, mcp_write) keep their BEGINNING (the user led with the point).
  const text =
    params.source === "transcript"
      ? params.text.slice(-MAX_OBSERVATION_TEXT_LENGTH)
      : params.text.slice(0, MAX_OBSERVATION_TEXT_LENGTH);

  const doc: Document = {
    project: params.project,
    session_id: params.session_id,
    source: params.source,
    priority: params.priority,
    text,
    status: "pending",
    run_id: null,
    claimed_at: null,
    created_at: new Date(),
  };

  // High-priority user captures (/remember, hash_line) never expire, per
  // DESIGN.md section 6 ("unset for high-priority user captures"); expiresAt
  // is omitted entirely rather than set to null.
  if (params.priority === "normal") {
    const config = loadConfig();
    doc.expiresAt = new Date(Date.now() + config.observationTtlDays * 24 * 60 * 60 * 1000);
  }

  const result = await db.collection<Document>(OBSERVATIONS).insertOne(doc);
  return result.insertedId;
}
