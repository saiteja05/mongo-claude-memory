import { ObjectId } from "mongodb";
import type { Db, Document } from "mongodb";
import { BELIEFS } from "../db/schema.js";
import { compileBrief as defaultCompileBrief } from "../consolidation/compileBrief.js";

export interface MemoryForgetParams {
  project: string;
  beliefId: string;
}

export interface MemoryForgetResult {
  matched: boolean;
  /**
   * Whether the affected brief(s) were successfully recompiled after the
   * tombstone. False either because nothing matched (no recompile needed) or
   * because the recompile itself failed (the forget still succeeded; the
   * belief stays out of the brief at the next consolidation-driven recompile).
   */
  recompiled: boolean;
}

export interface MemoryForgetDeps {
  compileBrief: (db: Db, scopeKey: "global" | string) => Promise<void>;
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
 *
 * On a matched tombstone, the affected brief is recompiled immediately (the
 * project brief always, plus the global brief when the belief's scope is
 * "core"), so a forgotten belief stops being injected at the very next
 * SessionStart instead of lingering until an unrelated consolidation run.
 * A recompile failure never fails the forget: it is logged to stderr and
 * reported as recompiled: false.
 */
export async function runMemoryForget(
  db: Db,
  params: MemoryForgetParams,
  deps: MemoryForgetDeps = { compileBrief: defaultCompileBrief }
): Promise<MemoryForgetResult> {
  const beliefs = db.collection<Document>(BELIEFS);
  const filter = { _id: toFilterId(params.beliefId) as never, project: params.project };

  // Fetch the belief's scope first: it determines whether the global (core)
  // brief must also be recompiled after the tombstone.
  const existing = await beliefs.findOne(filter, { projection: { scope: 1, project: 1 } });

  const result = await beliefs.updateOne(filter, {
    $set: { status: "tombstoned", updated_at: new Date() },
    $inc: { version: 1 },
  });

  const matched = result.matchedCount > 0;
  let recompiled = false;

  if (matched) {
    try {
      await deps.compileBrief(db, params.project);
      if (existing?.scope === "core") {
        await deps.compileBrief(db, "global");
      }
      recompiled = true;
    } catch (err) {
      // Never fail the forget over a recompile problem, and never echo raw
      // driver errors (they can embed connection details); the error name is
      // enough to diagnose.
      console.error(
        `memory_forget: brief recompile failed after tombstone (${
          err instanceof Error ? err.name : "unknown error"
        }); the tombstoned belief drops out at the next consolidation recompile`
      );
    }
  }

  return { matched, recompiled };
}
