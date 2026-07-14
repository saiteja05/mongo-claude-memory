import { describe, it, expect, vi } from "vitest";

interface FakeDoc {
  _id: string;
  project: string;
  status: string;
  created_at: Date;
  claimed_at?: Date | null;
  run_id?: string | null;
  text?: string;
}

interface FakeLock {
  _id: string;
  holder: string;
  heldUntil: Date;
}

// Mimics an ObjectId well enough for the ordering test below: a distinct
// object instance per construction (so two instances built from the same
// hex string are reference-unequal, exactly like the real BSON driver
// deserializing a fresh ObjectId per query), but with a stable toString().
class FakeObjectId {
  constructor(private readonly hex: string) {}
  toString() {
    return this.hex;
  }
}

function applyFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("$lt" in (value as Record<string, unknown>)) {
        const bound = (value as { $lt: Date }).$lt;
        const actual = doc[key];
        return actual !== undefined && actual !== null && (actual as Date) < bound;
      }
      if ("$in" in (value as Record<string, unknown>)) {
        return (value as { $in: unknown[] }).$in.includes(doc[key]);
      }
      if ("$ne" in (value as Record<string, unknown>)) {
        return doc[key] !== (value as { $ne: unknown }).$ne;
      }
    }
    return doc[key] === value;
  });
}

function makeFakeObservationsCollection(initialDocs: FakeDoc[]) {
  const state: FakeDoc[] = initialDocs.map((d) => ({ ...d }));

  function find(filter: Record<string, unknown>, options?: { projection?: Record<string, 1> }) {
    let sortSpec: Record<string, number> | null = null;
    let limitN: number | null = null;
    const cursor = {
      sort(spec: Record<string, number>) {
        sortSpec = spec;
        return cursor;
      },
      limit(n: number) {
        limitN = n;
        return cursor;
      },
      async toArray() {
        let results = state.filter((d) => applyFilter(d as Record<string, unknown>, filter));
        if (sortSpec) {
          const [field, dir] = Object.entries(sortSpec)[0];
          results = [...results].sort((a, b) => {
            const av = (a as Record<string, unknown>)[field];
            const bv = (b as Record<string, unknown>)[field];
            const cmp = av! > bv! ? 1 : av! < bv! ? -1 : 0;
            return cmp * dir;
          });
        }
        if (limitN !== null) {
          results = results.slice(0, limitN);
        }
        if (options?.projection) {
          const keys = Object.keys(options.projection);
          return results.map((r) => {
            const out: Record<string, unknown> = {};
            for (const k of keys) out[k] = (r as Record<string, unknown>)[k];
            return out;
          });
        }
        return results.map((r) => ({ ...r }));
      },
    };
    return cursor;
  }

  async function updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    let modifiedCount = 0;
    for (const doc of state) {
      if (applyFilter(doc as Record<string, unknown>, filter)) {
        if (update.$set) Object.assign(doc, update.$set as Record<string, unknown>);
        if (update.$unset) {
          for (const key of Object.keys(update.$unset as Record<string, unknown>)) {
            delete (doc as Record<string, unknown>)[key];
          }
        }
        modifiedCount++;
      }
    }
    return { modifiedCount };
  }

  return { state, find, updateMany };
}

function makeFakeLocksCollection(lock: FakeLock | null) {
  const findOne = vi.fn(async (filter: { _id: string }) => {
    return lock && lock._id === filter._id ? lock : null;
  });
  return { findOne };
}

function makeDb(
  observationsCollection: ReturnType<typeof makeFakeObservationsCollection>,
  lock: FakeLock | null = null
) {
  const locksCollection = makeFakeLocksCollection(lock);
  return {
    collection: (name: string) => (name === "locks" ? locksCollection : observationsCollection),
  };
}

describe("reclaimStale", () => {
  it("resets only observations past the staleness threshold, unsetting run_id and claimed_at, when there is no lock document at all", async () => {
    const { reclaimStale } = await import("../src/consolidation/claim.js");
    const now = Date.now();
    const collection = makeFakeObservationsCollection([
      {
        _id: "stale-1",
        project: "proj-a",
        status: "claimed",
        created_at: new Date(now - 100000),
        claimed_at: new Date(now - 700000), // older than 600000ms threshold
        run_id: "crashed-run",
      },
      {
        _id: "fresh-1",
        project: "proj-a",
        status: "claimed",
        created_at: new Date(now - 100000),
        claimed_at: new Date(now - 1000), // well within threshold
        run_id: "active-run",
      },
      {
        _id: "other-project-1",
        project: "proj-b",
        status: "claimed",
        created_at: new Date(now - 100000),
        claimed_at: new Date(now - 700000),
        run_id: "crashed-run",
      },
    ]);
    const db = makeDb(collection, null);

    const count = await reclaimStale(db as any, "proj-a", 600000, "caller-run");

    expect(count).toBe(1);
    const staleDoc = collection.state.find((d) => d._id === "stale-1")!;
    expect(staleDoc.status).toBe("pending");
    expect("run_id" in staleDoc).toBe(false);
    expect("claimed_at" in staleDoc).toBe(false);

    const freshDoc = collection.state.find((d) => d._id === "fresh-1")!;
    expect(freshDoc.status).toBe("claimed");

    const otherProjectDoc = collection.state.find((d) => d._id === "other-project-1")!;
    expect(otherProjectDoc.status).toBe("claimed");
  });

  it("excludes the live lease holder's stale claim from the reset when another run currently holds the project's lease", async () => {
    const { reclaimStale } = await import("../src/consolidation/claim.js");
    const now = Date.now();
    const collection = makeFakeObservationsCollection([
      {
        // Belongs to the run that currently holds the live lease: even
        // though its claimed_at is past the staleness threshold, it must be
        // left alone, since that run is alive and simply taking a long time
        // to process its batch, not crashed.
        _id: "live-holder-claim",
        project: "proj-a",
        status: "claimed",
        created_at: new Date(now - 100000),
        claimed_at: new Date(now - 700000),
        run_id: "live-run",
      },
      {
        // A genuinely crashed run's claim, unrelated to the live holder: must
        // still be reclaimed normally.
        _id: "crashed-claim",
        project: "proj-a",
        status: "claimed",
        created_at: new Date(now - 100000),
        claimed_at: new Date(now - 700000),
        run_id: "crashed-run",
      },
    ]);
    const lock: FakeLock = {
      _id: "consolidate:proj-a",
      holder: "live-run",
      heldUntil: new Date(now + 60000), // still in the future: a live lease
    };
    const db = makeDb(collection, lock);

    const count = await reclaimStale(db as any, "proj-a", 600000, "caller-run");

    expect(count).toBe(1);
    const liveHolderDoc = collection.state.find((d) => d._id === "live-holder-claim")!;
    expect(liveHolderDoc.status).toBe("claimed");
    const crashedDoc = collection.state.find((d) => d._id === "crashed-claim")!;
    expect(crashedDoc.status).toBe("pending");
  });

  it("reclaims normally (no exclusion) when the live lease is held by the caller's own run", async () => {
    const { reclaimStale } = await import("../src/consolidation/claim.js");
    const now = Date.now();
    const collection = makeFakeObservationsCollection([
      {
        _id: "own-stale-claim",
        project: "proj-a",
        status: "claimed",
        created_at: new Date(now - 100000),
        claimed_at: new Date(now - 700000),
        run_id: "caller-run",
      },
    ]);
    const lock: FakeLock = {
      _id: "consolidate:proj-a",
      holder: "caller-run",
      heldUntil: new Date(now + 60000),
    };
    const db = makeDb(collection, lock);

    const count = await reclaimStale(db as any, "proj-a", 600000, "caller-run");

    expect(count).toBe(1);
    const doc = collection.state.find((d) => d._id === "own-stale-claim")!;
    expect(doc.status).toBe("pending");
  });

  it("reclaims normally (no exclusion) when the recorded lease has already expired", async () => {
    const { reclaimStale } = await import("../src/consolidation/claim.js");
    const now = Date.now();
    const collection = makeFakeObservationsCollection([
      {
        _id: "stale-claim",
        project: "proj-a",
        status: "claimed",
        created_at: new Date(now - 100000),
        claimed_at: new Date(now - 700000),
        run_id: "expired-holder",
      },
    ]);
    const lock: FakeLock = {
      _id: "consolidate:proj-a",
      holder: "expired-holder",
      heldUntil: new Date(now - 1000), // already expired: not a live lease
    };
    const db = makeDb(collection, lock);

    const count = await reclaimStale(db as any, "proj-a", 600000, "caller-run");

    expect(count).toBe(1);
    const doc = collection.state.find((d) => d._id === "stale-claim")!;
    expect(doc.status).toBe("pending");
  });
});

describe("claimBatch", () => {
  it("claims pending observations and returns them sorted by created_at ascending", async () => {
    const { claimBatch } = await import("../src/consolidation/claim.js");
    const now = Date.now();
    const collection = makeFakeObservationsCollection([
      { _id: "obs-2", project: "proj-a", status: "pending", created_at: new Date(now - 1000) },
      { _id: "obs-1", project: "proj-a", status: "pending", created_at: new Date(now - 2000) },
    ]);
    const db = { collection: () => collection };

    const claimed = await claimBatch(db as any, "proj-a", "run-1", 50);

    expect(claimed.map((d) => d._id)).toEqual(["obs-1", "obs-2"]);
    expect(claimed.every((d) => d.status === "claimed" && d.run_id === "run-1")).toBe(true);
  });

  it("returns [] without calling updateMany when there is nothing pending", async () => {
    const { claimBatch } = await import("../src/consolidation/claim.js");
    const collection = makeFakeObservationsCollection([]);
    const updateManySpy = vi.spyOn(collection, "updateMany");
    const db = { collection: () => collection };

    const claimed = await claimBatch(db as any, "proj-a", "run-1", 50);

    expect(claimed).toEqual([]);
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it("excludes a document that 'disappeared' (was claimed by another run) between find and update", async () => {
    const { claimBatch } = await import("../src/consolidation/claim.js");
    const now = Date.now();
    const collection = makeFakeObservationsCollection([
      { _id: "obs-1", project: "proj-a", status: "pending", created_at: new Date(now - 3000) },
      { _id: "obs-2", project: "proj-a", status: "pending", created_at: new Date(now - 2000) },
      { _id: "obs-3", project: "proj-a", status: "pending", created_at: new Date(now - 1000) },
    ]);

    // Simulate a concurrent claimer winning the race on obs-2 right before our
    // updateMany runs: by the time our update executes, obs-2 is no longer
    // status:"pending", so our updateMany (which always re-checks
    // status:"pending" in its filter) will not match it.
    const realUpdateMany = collection.updateMany.bind(collection);
    collection.updateMany = async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const target = collection.state.find((d) => d._id === "obs-2")!;
      target.status = "claimed";
      target.run_id = "other-run";
      return realUpdateMany(filter, update);
    };

    const db = { collection: () => collection };
    const claimed = await claimBatch(db as any, "proj-a", "run-1", 50);

    expect(claimed.map((d) => d._id)).toEqual(["obs-1", "obs-3"]);
  });

  it("stops accumulating candidates once the total text length would exceed the char budget", async () => {
    const { claimBatch } = await import("../src/consolidation/claim.js");
    const now = Date.now();
    const collection = makeFakeObservationsCollection([
      { _id: "obs-1", project: "proj-a", status: "pending", created_at: new Date(now - 3000), text: "a".repeat(60) },
      { _id: "obs-2", project: "proj-a", status: "pending", created_at: new Date(now - 2000), text: "b".repeat(60) },
      { _id: "obs-3", project: "proj-a", status: "pending", created_at: new Date(now - 1000), text: "c".repeat(60) },
    ]);
    const db = { collection: () => collection };

    // Budget of 130 chars: obs-1 (60) + obs-2 (60) = 120 fits; adding obs-3
    // would reach 180 > 130, so only the first two are claimed.
    const claimed = await claimBatch(db as any, "proj-a", "run-1", 50, 130);

    expect(claimed.map((d) => d._id)).toEqual(["obs-1", "obs-2"]);
    const leftBehind = collection.state.find((d) => d._id === "obs-3")!;
    expect(leftBehind.status).toBe("pending");
  });

  it("always claims at least one observation even when it alone exceeds the char budget", async () => {
    const { claimBatch } = await import("../src/consolidation/claim.js");
    const now = Date.now();
    const collection = makeFakeObservationsCollection([
      { _id: "obs-huge", project: "proj-a", status: "pending", created_at: new Date(now - 2000), text: "x".repeat(1000) },
      { _id: "obs-next", project: "proj-a", status: "pending", created_at: new Date(now - 1000), text: "y".repeat(10) },
    ]);
    const db = { collection: () => collection };

    const claimed = await claimBatch(db as any, "proj-a", "run-1", 50, 100);

    // The oversized first candidate is still taken (the queue must never
    // wedge), but nothing else joins it in the batch.
    expect(claimed.map((d) => d._id)).toEqual(["obs-huge"]);
    const next = collection.state.find((d) => d._id === "obs-next")!;
    expect(next.status).toBe("pending");
  });

  it("restores created_at-ascending order correctly when _id is an object type that gets a fresh instance per find() call (real BSON ObjectId behavior)", async () => {
    const { claimBatch } = await import("../src/consolidation/claim.js");
    const now = Date.now();

    // hex-1 is older than hex-2, so per claimBatch's contract it must come
    // first in the returned order.
    const backing: Record<string, { created_at: Date; status: string; run_id?: string }> = {
      "hex-1": { created_at: new Date(now - 2000), status: "pending" },
      "hex-2": { created_at: new Date(now - 1000), status: "pending" },
    };

    function idsFromFilter(filter: { _id?: { $in: FakeObjectId[] } }): string[] {
      return (filter._id?.$in ?? []).map((id) => id.toString());
    }

    const collection = {
      find(filter: Record<string, unknown>, options?: { projection?: Record<string, 1> }) {
        let sortSpec: Record<string, number> | null = null;
        let limitN: number | null = null;
        const cursor = {
          sort(spec: Record<string, number>) {
            sortSpec = spec;
            return cursor;
          },
          limit(n: number) {
            limitN = n;
            return cursor;
          },
          async toArray() {
            const idFilter = filter as { _id?: { $in: FakeObjectId[] } };
            let hexIds = Object.keys(backing).filter((hex) => {
              const doc = backing[hex];
              if (filter.status !== undefined && doc.status !== filter.status) return false;
              if (filter.run_id !== undefined && doc.run_id !== filter.run_id) return false;
              if (idFilter._id?.$in !== undefined && !idsFromFilter(idFilter).includes(hex)) return false;
              return true;
            });
            if (sortSpec?.created_at) {
              hexIds = [...hexIds].sort(
                (a, b) => backing[a].created_at.getTime() - backing[b].created_at.getTime()
              );
            }
            if (limitN !== null) hexIds = hexIds.slice(0, limitN);
            // The re-fetch (the second find(), filtered on _id.$in) is
            // deliberately returned in reverse of insertion order here: this
            // makes the test fail loudly if claimBatch's restore-order step
            // is a silent no-op, instead of passing by accident because the
            // fake happened to already return the right order.
            const ordered = idFilter._id?.$in !== undefined ? [...hexIds].reverse() : hexIds;
            return ordered.map((hex) => {
              // A fresh FakeObjectId instance every call: matches the real
              // BSON driver deserializing a new ObjectId object per query
              // for the same id value.
              const doc: Record<string, unknown> = { _id: new FakeObjectId(hex), ...backing[hex] };
              if (options?.projection) {
                const keys = Object.keys(options.projection);
                const out: Record<string, unknown> = {};
                for (const k of keys) out[k] = doc[k];
                return out;
              }
              return doc;
            });
          },
        };
        return cursor;
      },
      async updateMany(filter: { _id?: { $in: FakeObjectId[] }; status?: string }, update: { $set?: Record<string, unknown> }) {
        const hexIds = idsFromFilter(filter);
        let modifiedCount = 0;
        for (const hex of hexIds) {
          const doc = backing[hex];
          if (doc && doc.status === filter.status) {
            if (update.$set?.status) doc.status = update.$set.status as string;
            if (update.$set?.run_id) doc.run_id = update.$set.run_id as string;
            modifiedCount++;
          }
        }
        return { modifiedCount };
      },
    };

    const db = { collection: () => collection };
    const claimed = await claimBatch(db as any, "proj-a", "run-1", 50);

    expect(claimed.map((d: any) => d._id.toString())).toEqual(["hex-1", "hex-2"]);
  });
});
