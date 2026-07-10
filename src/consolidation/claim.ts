import type { Db } from "mongodb";
import { OBSERVATIONS } from "../db/schema.js";
import type { Observation } from "../db/schema.js";

/**
 * Crash recovery sweep (DESIGN.md 7.2): resets observations stuck in
 * "claimed" (a prior run claimed them but crashed before marking them
 * consolidated) back to "pending" so a future run can pick them up. Returns
 * the number of observations reclaimed.
 */
export async function reclaimStale(
  db: Db,
  project: string,
  reclaimAfterMs: number
): Promise<number> {
  const threshold = new Date(Date.now() - reclaimAfterMs);
  const result = await db.collection<Observation>(OBSERVATIONS).updateMany(
    { project, status: "claimed", claimed_at: { $lt: threshold } },
    { $set: { status: "pending" }, $unset: { run_id: "", claimed_at: "" } }
  );
  return result.modifiedCount;
}

/**
 * Claims up to batchSize pending observations for a project. Always includes
 * status:"pending" in the update filter (never trusts the prior find() result
 * to still be valid) and re-fetches only documents that this run_id actually
 * claimed, so a race with another claimer never returns a doc we do not
 * actually own.
 */
export async function claimBatch(
  db: Db,
  project: string,
  runId: string,
  batchSize: number
): Promise<Observation[]> {
  const collection = db.collection<Observation>(OBSERVATIONS);

  const candidates = await collection
    .find({ project, status: "pending" }, { projection: { _id: 1 } })
    .sort({ created_at: 1 })
    .limit(batchSize)
    .toArray();

  const ids = candidates.map((doc) => doc._id);
  if (ids.length === 0) {
    return [];
  }

  const now = new Date();
  await collection.updateMany(
    { _id: { $in: ids }, status: "pending" },
    { $set: { status: "claimed", run_id: runId, claimed_at: now } }
  );

  const claimed = await collection
    .find({ _id: { $in: ids }, run_id: runId, status: "claimed" })
    .toArray();

  // The re-fetch has no ordering guarantee of its own; restore the
  // created_at-ascending order established by the initial sorted find.
  const order = new Map(ids.map((id, index) => [id, index]));
  return claimed.sort((a, b) => (order.get(a._id) ?? 0) - (order.get(b._id) ?? 0));
}
