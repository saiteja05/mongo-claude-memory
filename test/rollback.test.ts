import { describe, it, expect, vi } from "vitest";
import { ObjectId } from "mongodb";
import { runRollback, formatRollbackReport } from "../src/consolidation/rollback.js";
import type { RollbackDeps, RollbackResult } from "../src/consolidation/rollback.js";

interface FakeObservation {
  _id: string;
  run_id?: string;
  status: string;
}

interface FakeBelief {
  _id: string | ObjectId;
  project: string;
  scope: string;
  status: string;
  observation_ids: string[];
  supersedes?: string | null;
  version?: number;
}

function makeFakeDb(observations: FakeObservation[], beliefs: FakeBelief[]) {
  const obsState: FakeObservation[] = observations.map((d) => ({ ...d }));
  const beliefState: FakeBelief[] = beliefs.map((d) => ({ ...d }));

  function matchId(actual: unknown, wanted: unknown): boolean {
    return String(actual) === String(wanted);
  }

  const observationsCollection = {
    find(filter: { run_id?: string }) {
      return {
        async toArray() {
          return obsState.filter((d) => d.run_id === filter.run_id);
        },
      };
    },
    async updateMany(filter: { _id: { $in: unknown[] }; status: string }, update: any) {
      let modifiedCount = 0;
      for (const doc of obsState) {
        if (
          filter._id.$in.some((id) => matchId(doc._id, id)) &&
          doc.status === filter.status
        ) {
          if (update.$set) Object.assign(doc, update.$set);
          if (update.$unset) {
            for (const key of Object.keys(update.$unset)) delete (doc as any)[key];
          }
          modifiedCount++;
        }
      }
      return { modifiedCount };
    },
  };

  const beliefsCollection = {
    find(filter: { observation_ids: { $in: string[] } }) {
      return {
        async toArray() {
          return beliefState.filter((b) =>
            b.observation_ids.some((id) => filter.observation_ids.$in.includes(id))
          );
        },
      };
    },
    async findOne(filter: { supersedes?: string; status?: string }) {
      const doc = beliefState.find(
        (b) =>
          (filter.supersedes === undefined || b.supersedes === filter.supersedes) &&
          (filter.status === undefined || b.status === filter.status)
      );
      return doc ?? null;
    },
    async updateOne(filter: { _id: unknown; version?: number; status?: string }, update: any) {
      const doc = beliefState.find((b) => matchId(b._id, filter._id));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      // CAS guard: when the filter includes a version, it must still match
      // the document's current version (simulates real MongoDB behavior for
      // the rollback.ts tombstone write's compare-and-swap filter).
      if (filter.version !== undefined && doc.version !== filter.version) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      // Status guard: the restore path filters on status "archived" so a
      // tombstoned (user-forgotten) or already-active belief is never
      // resurrected by a rollback.
      if (filter.status !== undefined && doc.status !== filter.status) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$inc) {
        for (const [key, value] of Object.entries(update.$inc)) {
          (doc as any)[key] = ((doc as any)[key] ?? 0) + (value as number);
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  const db = {
    collection: (name: string) =>
      name === "observations" ? observationsCollection : beliefsCollection,
  };

  return { db, obsState, beliefState };
}

function makeDeps(overrides: Partial<RollbackDeps> = {}): RollbackDeps {
  return {
    compileBrief: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("runRollback", () => {
  it("returns an all-zero result and makes no belief/observation writes when the run has no observations", async () => {
    const { db, beliefState } = makeFakeDb([], []);
    const compileBrief = vi.fn(async () => undefined);

    const result = await runRollback(db as any, "run-none", makeDeps({ compileBrief }));

    expect(result).toEqual({
      revertedBeliefs: [],
      restoredBeliefs: [],
      needsManualReview: [],
      resetObservations: 0,
      recompiledScopes: [],
    });
    expect(compileBrief).not.toHaveBeenCalled();
    expect(beliefState).toEqual([]);
  });

  it("tombstones a sole-contributor belief, resets its observations to pending, and recompiles its project", async () => {
    const beliefId = new ObjectId().toString();
    const { db, obsState, beliefState } = makeFakeDb(
      [
        { _id: "obs-1", run_id: "run-a", status: "consolidated" },
        { _id: "obs-2", run_id: "run-a", status: "consolidated" },
      ],
      [
        {
          _id: beliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1", "obs-2"],
          supersedes: null,
          version: 1,
        },
      ]
    );
    const compileBrief = vi.fn(async () => undefined);

    const result = await runRollback(db as any, "run-a", makeDeps({ compileBrief }));

    expect(result.revertedBeliefs).toEqual([beliefId]);
    expect(result.restoredBeliefs).toEqual([]);
    expect(result.needsManualReview).toEqual([]);
    expect(result.resetObservations).toBe(2);
    expect(result.recompiledScopes).toEqual(["proj"]);

    const belief = beliefState.find((b) => String(b._id) === beliefId)!;
    expect(belief.status).toBe("tombstoned");
    expect(belief.version).toBe(2);

    expect(obsState.every((o) => o.status === "pending")).toBe(true);
    expect(obsState.every((o) => !("run_id" in o))).toBe(true);
    expect(compileBrief).toHaveBeenCalledWith(db, "proj");
  });

  it("also restores the superseded belief and recompiles only 'global' (not the project) when the reverted belief has scope core", async () => {
    const oldBeliefId = new ObjectId().toString();
    const newBeliefId = new ObjectId().toString();
    const { db, beliefState } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: oldBeliefId,
          project: "proj",
          scope: "core",
          status: "archived",
          observation_ids: ["obs-0"],
          supersedes: null,
        },
        {
          _id: newBeliefId,
          project: "proj",
          scope: "core",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: oldBeliefId,
        },
      ]
    );
    const compileBrief = vi.fn(async () => undefined);

    const result = await runRollback(db as any, "run-a", makeDeps({ compileBrief }));

    expect(result.revertedBeliefs).toEqual([newBeliefId]);
    expect(result.restoredBeliefs).toEqual([oldBeliefId]);
    // compileBrief's project-scope filter never matches scope:"core", so a
    // core-scoped belief only ever needs the "global" brief recompiled: the
    // project brief recompile would be a wasted no-op call.
    expect(result.recompiledScopes).toEqual(["global"]);

    const oldBelief = beliefState.find((b) => String(b._id) === oldBeliefId)!;
    expect(oldBelief.status).toBe("active");
    const newBelief = beliefState.find((b) => String(b._id) === newBeliefId)!;
    expect(newBelief.status).toBe("tombstoned");

    expect(compileBrief).toHaveBeenCalledWith(db, "global");
    expect(compileBrief).not.toHaveBeenCalledWith(db, "proj");
    expect(compileBrief).toHaveBeenCalledTimes(1);
  });

  it("recompiles the project scope (not global) when a project-scoped belief is reverted", async () => {
    const beliefId = new ObjectId().toString();
    const { db } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: beliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: null,
        },
      ]
    );
    const compileBrief = vi.fn(async () => undefined);

    const result = await runRollback(db as any, "run-a", makeDeps({ compileBrief }));

    expect(result.recompiledScopes).toEqual(["proj"]);
    expect(compileBrief).toHaveBeenCalledWith(db, "proj");
    expect(compileBrief).not.toHaveBeenCalledWith(db, "global");
    expect(compileBrief).toHaveBeenCalledTimes(1);
  });

  it("leaves a merged belief (observation_ids shared with another run) completely untouched and reports it in needsManualReview", async () => {
    const beliefId = new ObjectId().toString();
    const { db, beliefState, obsState } = makeFakeDb(
      [
        { _id: "obs-1", run_id: "run-a", status: "consolidated" },
        // obs-2 belongs to a different run and is not part of this rollback's
        // run_id at all, but it is still one of the belief's observation_ids:
        // this is the merged-belief case (upsertBelief's dedupe path unions
        // observation_ids across runs).
        { _id: "obs-2", run_id: "run-b", status: "consolidated" },
      ],
      [
        {
          _id: beliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1", "obs-2"],
          supersedes: null,
          version: 3,
        },
      ]
    );
    const compileBrief = vi.fn(async () => undefined);

    const result = await runRollback(db as any, "run-a", makeDeps({ compileBrief }));

    expect(result.revertedBeliefs).toEqual([]);
    expect(result.restoredBeliefs).toEqual([]);
    expect(result.needsManualReview).toEqual([
      {
        beliefId,
        observationIds: ["obs-1", "obs-2"],
        runObservationIds: ["obs-1"],
        reason: "shared with another run at snapshot time",
      },
    ]);
    expect(result.recompiledScopes).toEqual([]);

    // The belief must not have been mutated at all: status and version
    // stay exactly as they started.
    const belief = beliefState.find((b) => String(b._id) === beliefId)!;
    expect(belief.status).toBe("active");
    expect(belief.version).toBe(3);
    expect(compileBrief).not.toHaveBeenCalled();

    // Only this run's own observation (obs-1) is reset; obs-2 belongs to
    // another run and must be untouched.
    const obs1 = obsState.find((o) => o._id === "obs-1")!;
    expect(obs1.status).toBe("pending");
    const obs2 = obsState.find((o) => o._id === "obs-2")!;
    expect(obs2.status).toBe("consolidated");
    expect(obs2.run_id).toBe("run-b");
  });

  it("does not tombstone a sole-contributor belief when the tombstone updateOne's CAS reports matchedCount 0 (stale version: mutated concurrently between snapshot read and write), and reports it in needsManualReview instead", async () => {
    const beliefId = new ObjectId().toString();
    const { db, beliefState, obsState } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: beliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: null,
          version: 1,
        },
      ]
    );

    // Simulate a concurrent consolidation run merging a new observation into
    // this same belief (and bumping its version) between rollback's snapshot
    // read and its tombstone write: the CAS filter (matched on the stale
    // version rollback read) no longer matches anything, so the real driver
    // would report matchedCount 0 here.
    const beliefsCollection = db.collection("beliefs") as any;
    const realUpdateOne = beliefsCollection.updateOne.bind(beliefsCollection);
    beliefsCollection.updateOne = vi.fn(async (filter: any, update: any) => {
      if (update.$set?.status === "tombstoned") {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      return realUpdateOne(filter, update);
    });

    const compileBrief = vi.fn(async () => undefined);
    const result = await runRollback(db as any, "run-a", makeDeps({ compileBrief }));

    expect(result.revertedBeliefs).toEqual([]);
    expect(result.restoredBeliefs).toEqual([]);
    expect(result.needsManualReview).toEqual([
      {
        beliefId,
        observationIds: ["obs-1"],
        runObservationIds: ["obs-1"],
        reason: "changed during rollback",
      },
    ]);
    expect(result.recompiledScopes).toEqual([]);
    expect(compileBrief).not.toHaveBeenCalled();

    // The belief must never have been tombstoned: status stays exactly as it
    // started (the failed CAS write must not fall back to an unconditional
    // write).
    const belief = beliefState.find((b) => String(b._id) === beliefId)!;
    expect(belief.status).toBe("active");
    expect(belief.version).toBe(1);

    // The observation reset is unconditional on the belief-level outcome, so
    // it still happens even though the belief itself was left alone.
    const obs1 = obsState.find((o) => o._id === "obs-1")!;
    expect(obs1.status).toBe("pending");
  });

  it("defaults compileBrief to the real implementation when deps are not supplied", async () => {
    const { db } = makeFakeDb([], []);
    const result = await runRollback(db as any, "run-none");
    expect(result.recompiledScopes).toEqual([]);
  });

  it("falls back to the raw string, without throwing, when a reverted belief's supersedes is not a valid ObjectId string", async () => {
    const beliefId = new ObjectId().toString();
    const { db, beliefState } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: beliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: "not-a-valid-objectid",
          version: 1,
        },
      ]
    );
    const compileBrief = vi.fn(async () => undefined);

    const result = await runRollback(db as any, "run-a", makeDeps({ compileBrief }));

    expect(result.revertedBeliefs).toEqual([beliefId]);
    // toFilterId's catch branch falls back to the raw string, so the restore
    // write's filter is on that string id. No matching belief exists in this
    // fixture, so the guarded restore matches nothing: the caller does not
    // throw, and the unrestorable target is reported for manual review
    // rather than falsely listed as restored.
    expect(result.restoredBeliefs).toEqual([]);
    expect(result.needsManualReview).toEqual([
      {
        beliefId: "not-a-valid-objectid",
        observationIds: [],
        runObservationIds: [],
        reason: "superseded belief not restorable (already active, tombstoned, or missing)",
      },
    ]);

    const belief = beliefState.find((b) => String(b._id) === beliefId)!;
    expect(belief.status).toBe("tombstoned");
  });

  it("restores an archived superseded belief with a version bump and a status-archived filter", async () => {
    const oldBeliefId = new ObjectId().toString();
    const newBeliefId = new ObjectId().toString();
    const { db, beliefState } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: oldBeliefId,
          project: "proj",
          scope: "project",
          status: "archived",
          observation_ids: ["obs-0"],
          supersedes: null,
          version: 3,
        },
        {
          _id: newBeliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: oldBeliefId,
          version: 1,
        },
      ]
    );

    const result = await runRollback(db as any, "run-a", makeDeps());

    expect(result.restoredBeliefs).toEqual([oldBeliefId]);
    expect(result.needsManualReview).toEqual([]);
    const restored = beliefState.find((b) => String(b._id) === oldBeliefId)!;
    expect(restored.status).toBe("active");
    // Every mutation bumps version, the restore included.
    expect(restored.version).toBe(4);
  });

  it("skips restoring the superseded belief and reports it for manual review when a newer belief has since superseded the one being rolled back and is still active", async () => {
    const oldBeliefId = new ObjectId().toString(); // grandparent, archived when superseded
    const rolledBackBeliefId = new ObjectId().toString(); // this run's belief, gets tombstoned below
    const newerSuccessorId = new ObjectId().toString(); // supersedes rolledBackBeliefId, still active
    const { db, beliefState } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: oldBeliefId,
          project: "proj",
          scope: "project",
          status: "archived",
          observation_ids: ["obs-0"],
          supersedes: null,
          version: 3,
        },
        {
          _id: rolledBackBeliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: oldBeliefId,
          version: 1,
        },
        {
          // Written by a different, unrelated run after this run's belief:
          // its observation_ids never overlap with run-a's, so it is not
          // itself touched by this rollback at all.
          _id: newerSuccessorId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-2"],
          supersedes: rolledBackBeliefId,
          version: 1,
        },
      ]
    );

    const result = await runRollback(db as any, "run-a", makeDeps());

    expect(result.revertedBeliefs).toEqual([rolledBackBeliefId]);
    expect(result.restoredBeliefs).toEqual([]);
    expect(result.needsManualReview).toEqual([
      {
        beliefId: oldBeliefId,
        observationIds: [],
        runObservationIds: [],
        reason: "a newer belief has since superseded this one and is still active",
      },
    ]);

    const rolledBack = beliefState.find((b) => String(b._id) === rolledBackBeliefId)!;
    expect(rolledBack.status).toBe("tombstoned");

    // Restoring the grandparent would have produced two simultaneously
    // active beliefs (it and newerSuccessorId) for the same lineage: it must
    // stay archived, and the newer successor must be left completely
    // untouched.
    const grandparent = beliefState.find((b) => String(b._id) === oldBeliefId)!;
    expect(grandparent.status).toBe("archived");
    const newerSuccessor = beliefState.find((b) => String(b._id) === newerSuccessorId)!;
    expect(newerSuccessor.status).toBe("active");
    expect(newerSuccessor.version).toBe(1);
  });

  it("never resurrects a tombstoned (user-forgotten) superseded belief, reporting it for manual review instead", async () => {
    const oldBeliefId = new ObjectId().toString();
    const newBeliefId = new ObjectId().toString();
    const { db, beliefState } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: oldBeliefId,
          project: "proj",
          scope: "project",
          status: "tombstoned",
          observation_ids: ["obs-0"],
          supersedes: null,
          version: 2,
        },
        {
          _id: newBeliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: oldBeliefId,
          version: 1,
        },
      ]
    );

    const result = await runRollback(db as any, "run-a", makeDeps());

    expect(result.restoredBeliefs).toEqual([]);
    expect(result.needsManualReview).toEqual([
      {
        beliefId: oldBeliefId,
        observationIds: [],
        runObservationIds: [],
        reason: "superseded belief not restorable (already active, tombstoned, or missing)",
      },
    ]);
    const tombstoned = beliefState.find((b) => String(b._id) === oldBeliefId)!;
    expect(tombstoned.status).toBe("tombstoned");
  });

  it("reports a missing superseded belief for manual review instead of listing it as restored", async () => {
    const missingId = new ObjectId().toString();
    const newBeliefId = new ObjectId().toString();
    const { db } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: newBeliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: missingId,
          version: 1,
        },
      ]
    );

    const result = await runRollback(db as any, "run-a", makeDeps());

    expect(result.restoredBeliefs).toEqual([]);
    expect(result.needsManualReview).toEqual([
      {
        beliefId: missingId,
        observationIds: [],
        runObservationIds: [],
        reason: "superseded belief not restorable (already active, tombstoned, or missing)",
      },
    ]);
  });

  it("excludes a reverted belief from the recompile scopes when its scope is neither 'core' nor 'project'", async () => {
    const beliefId = new ObjectId().toString();
    const { db, beliefState } = makeFakeDb(
      [{ _id: "obs-1", run_id: "run-a", status: "consolidated" }],
      [
        {
          _id: beliefId,
          project: "proj",
          scope: "archive",
          status: "active",
          observation_ids: ["obs-1"],
          supersedes: null,
          version: 1,
        },
      ]
    );
    const compileBrief = vi.fn(async () => undefined);

    const result = await runRollback(db as any, "run-a", makeDeps({ compileBrief }));

    // The belief is still reverted normally: only the recompile-scopes side
    // effect is skipped for an out-of-band scope value.
    expect(result.revertedBeliefs).toEqual([beliefId]);
    expect(result.recompiledScopes).toEqual([]);
    expect(compileBrief).not.toHaveBeenCalled();

    const belief = beliefState.find((b) => String(b._id) === beliefId)!;
    expect(belief.status).toBe("tombstoned");
  });

  it("leaves a run's observation untouched (undercounted in resetObservations) when its status is not 'consolidated'", async () => {
    const beliefId = new ObjectId().toString();
    const { db, obsState } = makeFakeDb(
      [
        { _id: "obs-1", run_id: "run-a", status: "consolidated" },
        // Same run, but not in status "consolidated": the resetObservations
        // updateMany filter only matches status "consolidated", so this one
        // must be left exactly as is (not reset to pending).
        { _id: "obs-2", run_id: "run-a", status: "processing" },
      ],
      [
        {
          _id: beliefId,
          project: "proj",
          scope: "project",
          status: "active",
          observation_ids: ["obs-1", "obs-2"],
          supersedes: null,
          version: 1,
        },
      ]
    );
    const compileBrief = vi.fn(async () => undefined);

    const result = await runRollback(db as any, "run-a", makeDeps({ compileBrief }));

    // Only obs-1 (status "consolidated") is counted and reset; obs-2 is
    // undercounted and left alone.
    expect(result.resetObservations).toBe(1);

    const obs1 = obsState.find((o) => o._id === "obs-1")!;
    expect(obs1.status).toBe("pending");
    expect(obs1.run_id).toBeUndefined();

    const obs2 = obsState.find((o) => o._id === "obs-2")!;
    expect(obs2.status).toBe("processing");
    expect(obs2.run_id).toBe("run-a");
  });
});

describe("formatRollbackReport", () => {
  function makeResult(overrides: Partial<RollbackResult> = {}): RollbackResult {
    return {
      revertedBeliefs: [],
      restoredBeliefs: [],
      needsManualReview: [],
      resetObservations: 0,
      recompiledScopes: [],
      ...overrides,
    };
  }

  it("renders the reverted and restored belief id lines when both are present", () => {
    const result = makeResult({
      revertedBeliefs: ["belief-1", "belief-2"],
      restoredBeliefs: ["belief-0"],
      resetObservations: 3,
    });

    const report = formatRollbackReport("run-a", result);

    expect(report).toContain('[rollback] run_id="run-a": reverted 2 belief(s), restored 1 belief(s), reset 3 observation(s) to pending');
    expect(report).toContain("Reverted (tombstoned) belief ids: belief-1, belief-2");
    expect(report).toContain("Restored (reactivated) belief ids: belief-0");
  });

  it("omits the reverted and restored lines entirely when both lists are empty", () => {
    const result = makeResult();

    const report = formatRollbackReport("run-a", result);

    expect(report).not.toContain("Reverted (tombstoned)");
    expect(report).not.toContain("Restored (reactivated)");
  });

  it("appends the '(reason)' suffix to a needsManualReview item that has a reason", () => {
    const result = makeResult({
      needsManualReview: [
        {
          beliefId: "belief-1",
          observationIds: ["obs-1", "obs-2"],
          runObservationIds: ["obs-1"],
          reason: "shared with another run at snapshot time",
        },
      ],
    });

    const report = formatRollbackReport("run-a", result);

    expect(report).toContain("Needs manual review (left untouched):");
    expect(report).toContain(
      "  - belief belief-1: this run contributed 1 of 2 observation(s) (shared with another run at snapshot time)"
    );
  });

  it("omits the '(reason)' suffix for a needsManualReview item without a reason", () => {
    const result = makeResult({
      needsManualReview: [
        {
          beliefId: "belief-1",
          observationIds: ["obs-1", "obs-2"],
          runObservationIds: ["obs-1"],
        },
      ],
    });

    const report = formatRollbackReport("run-a", result);

    expect(report).toContain("  - belief belief-1: this run contributed 1 of 2 observation(s)");
    expect(report).not.toContain("(shared with another run");
    // No trailing " (...)" suffix at all after "observation(s)".
    const line = report.split("\n").find((l) => l.includes("belief belief-1"))!;
    expect(line.endsWith("observation(s)")).toBe(true);
  });

  it("uses the 'No briefs needed recompilation.' fallback text when recompiledScopes is empty", () => {
    const result = makeResult({ recompiledScopes: [] });

    const report = formatRollbackReport("run-a", result);

    expect(report).toContain("No briefs needed recompilation.");
  });

  it("lists the recompiled scopes instead of the fallback text when recompiledScopes is non-empty", () => {
    const result = makeResult({ recompiledScopes: ["global", "proj-a"] });

    const report = formatRollbackReport("run-a", result);

    expect(report).toContain("Recompiled brief(s) for scope(s): global, proj-a");
    expect(report).not.toContain("No briefs needed recompilation.");
  });
});
