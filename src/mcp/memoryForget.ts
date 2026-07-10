import { ObjectId } from "mongodb";
import type { Db, Document } from "mongodb";
import { BELIEFS } from "../db/schema.js";

export interface MemoryForgetParams {
  project: string;
  beliefId: string;
}

export interface MemoryForgetResult {
  matched: boolean;
}

// Belief _ids are normally real ObjectIds. Falls back to the raw string when
// it is not a valid ObjectId so this stays testable without a live MongoDB,
// matching the same convention as upsertBelief.ts's toFilterId.
function toFilterId(id: string): ObjectId | string {
  try {
    return new ObjectId(id);
  } catch {
    return id;
  }
}

/**
 * Tombstones a belief in place. This is one of the two allowed exceptions to
 * the single-writer-is-the-consolidator rule (DESIGN.md 7.3). Filtered by
 * both _id AND project in the same atomic updateOne, so a caller cannot
 * tombstone a belief belonging to a different project by guessing an id.
 * Bumps version per the optimistic-concurrency guard already on Belief.
 * Returns whether a document actually matched, so the caller can distinguish
 * "already gone / wrong project" from "successfully forgotten".
 */
export async function runMemoryForget(
  db: Db,
  params: MemoryForgetParams
): Promise<MemoryForgetResult> {
  const result = await db.collection<Document>(BELIEFS).updateOne(
    { _id: toFilterId(params.beliefId) as never, project: params.project },
    {
      $set: { status: "tombstoned", updated_at: new Date() },
      $inc: { version: 1 },
    }
  );

  return { matched: result.matchedCount > 0 };
}
