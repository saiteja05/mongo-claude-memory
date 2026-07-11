import { ObjectId } from "mongodb";
import type { Db, Document } from "mongodb";
import { BELIEFS, OBSERVATIONS } from "../db/schema.js";
import { compileBrief as defaultCompileBrief } from "./compileBrief.js";

export interface RollbackResult {
  revertedBeliefs: string[];
  restoredBeliefs: string[];
  needsManualReview: Array<{
    beliefId: string;
    observationIds: string[];
    runObservationIds: string[];
    // Optional, distinguishes "shared with another run at snapshot time"
    // (soleContributor was false) from "changed during rollback" (looked
    // like a sole contributor at read time, but the tombstone CAS write
    // below found the belief had already moved on).
    reason?: string;
  }>;
  resetObservations: number;
  recompiledScopes: string[];
}

export interface RollbackDeps {
  compileBrief: (db: Db, scopeKey: string) => Promise<void>;
}

// Belief _ids are normally real ObjectIds (auto-generated on insert). Falls
// back to the raw string when it is not a valid ObjectId, matching the same
// convention already used by upsertBelief.ts's toFilterId and
// memoryForget.ts's toFilterId, so this stays testable without a live
// MongoDB.
function toFilterId(id: string): ObjectId | string {
  try {
    return new ObjectId(id);
  } catch {
    return id;
  }
}

/**
 * Reverts one consolidation run's belief-level effects (DESIGN.md 7: an
 * operator escape hatch for a bad run, not something the system calls
 * itself). For every belief touched by this run's observations:
 *
 * - If this run was the sole contributor to that belief (every one of its
 *   observation_ids came from this run), the belief is tombstoned and, if it
 *   superseded an older belief, that older belief is restored to active.
 * - If other runs also contributed observation_ids to that belief (the
 *   merged-belief case: upsertBelief's dedupe path unions observation_ids
 *   across runs), the belief is left completely untouched and reported in
 *   needsManualReview instead, since a full revert would also discard
 *   another run's legitimate contribution.
 * - Even when this run looks like the sole contributor from the snapshot
 *   read above, the tombstone write itself is guarded by a version
 *   compare-and-swap (filtered on both _id and the exact belief.version we
 *   read). If a concurrent consolidation run merged a new observation into
 *   this same belief between the snapshot read and this write (upsertBelief's
 *   dedupe/"update" path matches on status "active" only, with no
 *   rollback-awareness), the belief's version will have moved on, the CAS
 *   write matches nothing, and we report it in needsManualReview instead of
 *   silently tombstoning out from under that other run's contribution.
 *
 * Also resets this run's observations back to "pending" so they can be
 * reprocessed, and recompiles the brief(s) for every scope actually changed.
 */
export async function runRollback(
  db: Db,
  runId: string,
  deps: RollbackDeps = { compileBrief: defaultCompileBrief }
): Promise<RollbackResult> {
  const observationsCollection = db.collection<Document>(OBSERVATIONS);
  const beliefsCollection = db.collection<Document>(BELIEFS);

  const runObservations = await observationsCollection.find({ run_id: runId }).toArray();
  const runObsIds = runObservations.map((doc) => String(doc._id));

  const revertedBeliefs: string[] = [];
  const restoredBeliefs: string[] = [];
  const needsManualReview: RollbackResult["needsManualReview"] = [];
  const scopesToRecompile = new Set<string>();

  if (runObsIds.length === 0) {
    return {
      revertedBeliefs,
      restoredBeliefs,
      needsManualReview,
      resetObservations: 0,
      recompiledScopes: [],
    };
  }

  const runObsIdSet = new Set(runObsIds);
  const touchedBeliefs = await beliefsCollection
    .find({ observation_ids: { $in: runObsIds } })
    .toArray();

  const now = new Date();
  for (const belief of touchedBeliefs) {
    const observationIds = Array.isArray(belief.observation_ids)
      ? (belief.observation_ids as string[])
      : [];
    const soleContributor = observationIds.every((id) => runObsIdSet.has(id));

    if (!soleContributor) {
      // Other runs contributed to this belief's provenance too: never mutate
      // it here, only report it so an operator can review it manually.
      needsManualReview.push({
        beliefId: String(belief._id),
        observationIds,
        runObservationIds: observationIds.filter((id) => runObsIdSet.has(id)),
        reason: "shared with another run at snapshot time",
      });
      continue;
    }

    // CAS guard: filter on both _id and the exact version we read into
    // touchedBeliefs above, matching Belief.version's documented role as an
    // optimistic-concurrency guard (src/db/schema.ts). If matchedCount is 0,
    // some other write (most likely a concurrent consolidation run's dedupe
    // merge) changed this belief's version between our snapshot read and
    // this write, so our snapshot is stale: do not proceed with tombstoning
    // it, since that would silently destroy the other write's contribution.
    // Attempted before the restore-superseded-belief write below so a failed
    // CAS here never leaves an old belief restored to active while the new
    // belief it was superseded by stays active too (a duplicate).
    const tombstoneResult = await beliefsCollection.updateOne(
      { _id: belief._id as never, version: belief.version as never },
      { $set: { status: "tombstoned", updated_at: now }, $inc: { version: 1 } }
    );

    if (tombstoneResult.matchedCount === 0) {
      needsManualReview.push({
        beliefId: String(belief._id),
        observationIds,
        runObservationIds: observationIds.filter((id) => runObsIdSet.has(id)),
        reason: "changed during rollback",
      });
      continue;
    }

    revertedBeliefs.push(String(belief._id));

    if (belief.supersedes) {
      // Restore guards: (a) filter on status "archived" so a belief the user
      // explicitly forgot (tombstoned) is never resurrected by a rollback,
      // and a belief that is somehow already active is not double-restored;
      // (b) $inc version so the every-mutation-bumps-version invariant that
      // this file's own tombstone CAS depends on holds here too.
      const restoreResult = await beliefsCollection.updateOne(
        { _id: toFilterId(String(belief.supersedes)) as never, status: "archived" },
        { $set: { status: "active", updated_at: now }, $inc: { version: 1 } }
      );
      if (restoreResult.matchedCount > 0) {
        restoredBeliefs.push(String(belief.supersedes));
      } else {
        needsManualReview.push({
          beliefId: String(belief.supersedes),
          observationIds: [],
          runObservationIds: [],
          reason: "superseded belief not restorable (already active, tombstoned, or missing)",
        });
      }
    }

    // compileBrief's project-scope filter only matches scope:"project", so a
    // core-scoped belief's project brief never includes it: only add
    // belief.project to the recompile set for a project-scoped belief, and
    // always add "global" for a core-scoped one, to avoid a wasted no-op
    // compileBrief call for the project scope on a core-scoped revert.
    if (belief.scope === "project" && typeof belief.project === "string") {
      scopesToRecompile.add(belief.project);
    }
    if (belief.scope === "core") {
      scopesToRecompile.add("global");
    }
  }

  const resetResult = await observationsCollection.updateMany(
    { _id: { $in: runObsIds as never[] }, status: "consolidated" },
    { $set: { status: "pending" }, $unset: { run_id: "", claimed_at: "" } }
  );

  const recompiledScopes: string[] = [];
  for (const scopeKey of scopesToRecompile) {
    await deps.compileBrief(db, scopeKey);
    recompiledScopes.push(scopeKey);
  }

  return {
    revertedBeliefs,
    restoredBeliefs,
    needsManualReview,
    resetObservations: resetResult.modifiedCount,
    recompiledScopes,
  };
}

/**
 * Renders a RollbackResult as readable multi-line text for CLI output. No em
 * dashes: uses commas and parentheses instead.
 */
export function formatRollbackReport(runId: string, result: RollbackResult): string {
  const lines: string[] = [];
  lines.push(
    `[rollback] run_id="${runId}": reverted ${result.revertedBeliefs.length} belief(s), ` +
      `restored ${result.restoredBeliefs.length} belief(s), reset ${result.resetObservations} observation(s) to pending`
  );

  if (result.revertedBeliefs.length > 0) {
    lines.push(`Reverted (tombstoned) belief ids: ${result.revertedBeliefs.join(", ")}`);
  }

  if (result.restoredBeliefs.length > 0) {
    lines.push(`Restored (reactivated) belief ids: ${result.restoredBeliefs.join(", ")}`);
  }

  if (result.needsManualReview.length > 0) {
    lines.push("Needs manual review (left untouched):");
    for (const item of result.needsManualReview) {
      lines.push(
        `  - belief ${item.beliefId}: this run contributed ${item.runObservationIds.length} of ` +
          `${item.observationIds.length} observation(s)` +
          (item.reason ? ` (${item.reason})` : "")
      );
    }
  }

  lines.push(
    result.recompiledScopes.length > 0
      ? `Recompiled brief(s) for scope(s): ${result.recompiledScopes.join(", ")}`
      : "No briefs needed recompilation."
  );

  return lines.join("\n");
}
