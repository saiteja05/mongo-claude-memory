import { describe, it, expect, vi } from "vitest";

interface FakeLock {
  _id: string;
  holder: string;
  heldUntil: Date;
}

/**
 * A minimal fake `locks` collection that reproduces just enough of real
 * Mongo's upsert-vs-duplicate-key behavior for findOneAndUpdate: the update
 * only "matches" (and succeeds) when no document exists yet or the existing
 * document's heldUntil is before the filter's cutoff; otherwise it throws a
 * duplicate-key error, exactly like a real unique-index collision on the
 * upsert's insert path.
 */
function makeFakeLocksDb(initial?: FakeLock) {
  let lock: FakeLock | undefined = initial;

  const findOneAndUpdate = vi.fn(
    async (
      filter: { _id: string; heldUntil: { $lt: Date } },
      update: { $set: { holder: string; heldUntil: Date } }
    ) => {
      const noLiveLease = !lock || lock._id !== filter._id || lock.heldUntil < filter.heldUntil.$lt;
      if (noLiveLease) {
        lock = { _id: filter._id, holder: update.$set.holder, heldUntil: update.$set.heldUntil };
        return { value: lock };
      }
      const err = new Error("E11000 duplicate key error collection: locks index: _id_") as Error & {
        code: number;
      };
      err.code = 11000;
      throw err;
    }
  );

  const updateOne = vi.fn(
    async (filter: { _id: string; holder: string }, update: { $set: { heldUntil: Date } }) => {
      if (lock && lock._id === filter._id && lock.holder === filter.holder) {
        lock.heldUntil = update.$set.heldUntil;
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
  );

  const db = { collection: () => ({ findOneAndUpdate, updateOne }) };
  return { db, findOneAndUpdate, updateOne, getLock: () => lock };
}

describe("acquireLease", () => {
  it("succeeds when no lease exists", async () => {
    const { acquireLease } = await import("../src/consolidation/lock.js");
    const { db } = makeFakeLocksDb();

    const acquired = await acquireLease(db as any, "myproj", "run-1", 300000);

    expect(acquired).toBe(true);
  });

  it("fails (returns false) when a live lease exists, via the duplicate-key error path", async () => {
    const { acquireLease } = await import("../src/consolidation/lock.js");
    const { db } = makeFakeLocksDb({
      _id: "consolidate:myproj",
      holder: "other-run",
      heldUntil: new Date(Date.now() + 60000),
    });

    const acquired = await acquireLease(db as any, "myproj", "run-1", 300000);

    expect(acquired).toBe(false);
  });

  it("succeeds when an existing lease is expired", async () => {
    const { acquireLease } = await import("../src/consolidation/lock.js");
    const { db, getLock } = makeFakeLocksDb({
      _id: "consolidate:myproj",
      holder: "old-run",
      heldUntil: new Date(Date.now() - 1000),
    });

    const acquired = await acquireLease(db as any, "myproj", "run-2", 300000);

    expect(acquired).toBe(true);
    expect(getLock()?.holder).toBe("run-2");
  });

  it("propagates non-duplicate-key errors instead of treating them as lease contention", async () => {
    const { acquireLease } = await import("../src/consolidation/lock.js");
    const findOneAndUpdate = vi.fn(async () => {
      throw new Error("network error");
    });
    const db = { collection: () => ({ findOneAndUpdate }) };

    await expect(acquireLease(db as any, "myproj", "run-1", 300000)).rejects.toThrow(
      "network error"
    );
  });
});

describe("releaseLease", () => {
  it("clears the lease when the holder matches", async () => {
    const { releaseLease } = await import("../src/consolidation/lock.js");
    const { db, getLock } = makeFakeLocksDb({
      _id: "consolidate:myproj",
      holder: "run-1",
      heldUntil: new Date(Date.now() + 60000),
    });

    await releaseLease(db as any, "myproj", "run-1");

    expect(getLock()?.heldUntil.getTime()).toBe(new Date(0).getTime());
  });

  it("is a no-op when the holder does not match (lease already stolen by a new run)", async () => {
    const { releaseLease } = await import("../src/consolidation/lock.js");
    const newHeldUntil = new Date(Date.now() + 60000);
    const { db, getLock } = makeFakeLocksDb({
      _id: "consolidate:myproj",
      holder: "new-run",
      heldUntil: newHeldUntil,
    });

    // A stale run (run-1) whose lease already expired and was stolen tries
    // to release; it must not clobber new-run's live lease.
    await releaseLease(db as any, "myproj", "run-1");

    expect(getLock()?.holder).toBe("new-run");
    expect(getLock()?.heldUntil.getTime()).toBe(newHeldUntil.getTime());
  });
});

describe("renewLease", () => {
  it("extends heldUntil and returns true when the holder matches (matchedCount 1)", async () => {
    const { renewLease } = await import("../src/consolidation/lock.js");
    const originalHeldUntil = new Date(Date.now() + 1000);
    const { db, getLock } = makeFakeLocksDb({
      _id: "consolidate:myproj",
      holder: "run-1",
      heldUntil: originalHeldUntil,
    });

    const renewed = await renewLease(db as any, "myproj", "run-1", 300000);

    expect(renewed).toBe(true);
    expect(getLock()?.heldUntil.getTime()).toBeGreaterThan(originalHeldUntil.getTime());
  });

  it("returns false without extending anything when the holder does not match (matchedCount 0, lease already taken over)", async () => {
    const { renewLease } = await import("../src/consolidation/lock.js");
    const otherHeldUntil = new Date(Date.now() + 60000);
    const { db, getLock } = makeFakeLocksDb({
      _id: "consolidate:myproj",
      holder: "new-run",
      heldUntil: otherHeldUntil,
    });

    // A run (run-1) that lost the lease to new-run tries to renew; it must
    // not be able to extend new-run's live lease, and must be told it no
    // longer holds exclusivity.
    const renewed = await renewLease(db as any, "myproj", "run-1", 300000);

    expect(renewed).toBe(false);
    expect(getLock()?.holder).toBe("new-run");
    expect(getLock()?.heldUntil.getTime()).toBe(otherHeldUntil.getTime());
  });
});
