import { describe, it, expect, vi } from "vitest";

interface FakeDoc {
  _id: string;
  project: string;
  status: string;
  created_at: Date;
  claimed_at?: Date | null;
  run_id?: string | null;
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

describe("reclaimStale", () => {
  it("resets only observations past the staleness threshold, unsetting run_id and claimed_at", async () => {
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
    const db = { collection: () => collection };

    const count = await reclaimStale(db as any, "proj-a", 600000);

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
});
