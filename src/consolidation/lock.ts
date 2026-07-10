import type { Db } from "mongodb";
import { LOCKS } from "../db/schema.js";
import type { Lock } from "../db/schema.js";

const DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * Acquires the per-project consolidation lease (DESIGN.md 7.2). The upsert's
 * filter only matches a document with no live lease (heldUntil in the past)
 * or no document at all; when a live lease exists, the filter fails to match
 * but the upsert still attempts an insert on the same _id, which collides and
 * throws a duplicate-key error (code 11000). That is the normal, expected
 * signal that another run holds the lease, not a fatal error.
 */
export async function acquireLease(
  db: Db,
  project: string,
  runId: string,
  leaseMs: number
): Promise<boolean> {
  const now = new Date();
  try {
    await db.collection<Lock>(LOCKS).findOneAndUpdate(
      { _id: `consolidate:${project}`, heldUntil: { $lt: now } },
      { $set: { holder: runId, heldUntil: new Date(now.getTime() + leaseMs) } },
      { upsert: true, returnDocument: "after" }
    );
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * Releases the lease only if we are still the holder, so a run whose lease
 * already expired and was stolen by another run never clobbers the new
 * holder's lease.
 */
export async function releaseLease(db: Db, project: string, runId: string): Promise<void> {
  await db.collection<Lock>(LOCKS).updateOne(
    { _id: `consolidate:${project}`, holder: runId },
    { $set: { heldUntil: new Date(0) } }
  );
}

/**
 * Extends the lease's heldUntil only if we are still the recorded holder,
 * mirroring releaseLease's holder-matching filter. A long-running
 * consolidation pass (a large batch, or a slow embed/LLM call) must call
 * this periodically instead of relying on the single lease acquired at the
 * start of the run, since that lease's original heldUntil can otherwise
 * pass while the run is still in progress, letting a second concurrent run
 * acquire the "expired" lease and process the same observations. Returns
 * true when we are still the holder and the lease was extended, false when
 * someone else has already taken over (we have lost exclusivity and must
 * stop).
 */
export async function renewLease(
  db: Db,
  project: string,
  runId: string,
  leaseMs: number
): Promise<boolean> {
  const now = new Date();
  const result = await db.collection<Lock>(LOCKS).updateOne(
    { _id: `consolidate:${project}`, holder: runId },
    { $set: { heldUntil: new Date(now.getTime() + leaseMs) } }
  );
  return result.matchedCount === 1;
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE
  );
}
