import { describe, it, expect, vi } from "vitest";
import { runConsolidation, fetchExistingBeliefs, markConsolidated } from "../src/consolidation/run.js";
import type { RunConsolidationDeps } from "../src/consolidation/run.js";
import { BELIEFS, OBSERVATIONS } from "../src/db/schema.js";

function makeDeps(overrides: Partial<RunConsolidationDeps> = {}): RunConsolidationDeps {
  return {
    runId: "run-1",
    leaseMs: 300000,
    claimBatchSize: 50,
    reclaimAfterMs: 600000,
    beliefsContextLimit: 30,
    dedupeSimilarityThreshold: 0.93,
    reclaimStale: vi.fn(async () => 0),
    acquireLease: vi.fn(async () => true),
    renewLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => undefined),
    claimBatch: vi.fn(async () => []),
    fetchExistingBeliefs: vi.fn(async () => []),
    extractFacts: vi.fn(async () => []),
    embed: vi.fn(async () => [[0.1, 0.2]]),
    upsertBelief: vi.fn(async () => ({ beliefId: "belief-1", action: "insert" as const })),
    compileBrief: vi.fn(async () => undefined),
    markConsolidated: vi.fn(async () => undefined),
    ...overrides,
  };
}

const fakeDb = {} as any;

describe("runConsolidation", () => {
  it("returns skipped without calling claim/extract/etc when the lease is not acquired", async () => {
    const deps = makeDeps({ acquireLease: vi.fn(async () => false) });

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 0, skipped: true, reason: "lease held" });
    expect(deps.claimBatch).not.toHaveBeenCalled();
    expect(deps.extractFacts).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.upsertBelief).not.toHaveBeenCalled();
    // Never held the lease, so must never attempt to release it.
    expect(deps.releaseLease).not.toHaveBeenCalled();
  });

  it("releases the lease and returns processed:0 without calling the LLM when the claim batch is empty", async () => {
    const deps = makeDeps({ claimBatch: vi.fn(async () => []) });

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 0, skipped: false });
    expect(deps.extractFacts).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
    expect(deps.releaseLease).toHaveBeenCalledWith(fakeDb, "proj", "run-1");
  });

  it("processes valid candidates, marks observations consolidated, and compiles the project brief", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const candidates = [
      {
        text: "The user prefers tabs.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
      {
        text: "", // invalid: fails validateBeliefText, must be dropped, not upserted
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-2"],
        supersedes_belief_id: null,
      },
    ];
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 1, skipped: false });
    expect(deps.upsertBelief).toHaveBeenCalledTimes(1);
    expect(deps.markConsolidated).toHaveBeenCalledWith(fakeDb, "proj", "run-1", ["obs-1", "obs-2"]);
    expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "proj");
    expect(deps.compileBrief).not.toHaveBeenCalledWith(fakeDb, "global");
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled(); // logged why the empty-text candidate was dropped

    errorSpy.mockRestore();
  });

  it("also compiles the global brief when a candidate has scope 'core' and the project is not already 'global'", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const candidates = [
      {
        text: "The team always uses TypeScript strict mode.",
        type: "convention" as const,
        scope: "core" as const,
        importance: 0.8,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
    ];
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
    });

    await runConsolidation(fakeDb, "proj", deps);

    expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "proj");
    expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "global");
  });

  it("does not redundantly recompile the global brief when project is already 'global' and a candidate has scope 'core'", async () => {
    const claimed = [
      { _id: "obs-1", project: "global", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const candidates = [
      {
        text: "A core fact scoped globally from the start.",
        type: "convention" as const,
        scope: "core" as const,
        importance: 0.8,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
    ];
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
    });

    await runConsolidation(fakeDb, "global", deps);

    // globalChanged becomes true, but the guard is `project !== "global"`:
    // since project is already "global", the first compileBrief call (for
    // `project`) already compiled the global brief, so the second,
    // core-triggered call must not fire and duplicate the work.
    expect(deps.compileBrief).toHaveBeenCalledTimes(1);
    expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "global");
  });

  it("compiles the brief and marks the batch consolidated, without renewing the lease or upserting, when extractFacts returns no candidates for a non-empty batch", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => []),
    });

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 0, skipped: false });
    // The per-candidate loop body (renewLease, embed, upsertBelief) never
    // runs at all when there are zero candidates to iterate.
    expect(deps.renewLease).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.upsertBelief).not.toHaveBeenCalled();
    // Still fully processed: the project brief is recompiled and the whole
    // claimed batch is marked consolidated even though nothing was upserted.
    expect(deps.compileBrief).toHaveBeenCalledTimes(1);
    expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "proj");
    expect(deps.markConsolidated).toHaveBeenCalledWith(fakeDb, "proj", "run-1", ["obs-1", "obs-2"]);
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("always calls releaseLease, even when extractFacts throws partway through", async () => {
    const deps = makeDeps({
      claimBatch: vi.fn(async () => [
        { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      ] as any),
      extractFacts: vi.fn(async () => {
        throw new Error("LLM call failed");
      }),
    });

    await expect(runConsolidation(fakeDb, "proj", deps)).rejects.toThrow("LLM call failed");

    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
    expect(deps.releaseLease).toHaveBeenCalledWith(fakeDb, "proj", "run-1");
  });

  it("stops processing, skips compileBrief/markConsolidated, and reports leaseLost when renewLease reports the lease was taken over mid-run", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-3", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const candidates = [
      {
        text: "First candidate fact.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
      {
        text: "Second candidate fact.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-2"],
        supersedes_belief_id: null,
      },
      {
        text: "Third candidate fact.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-3"],
        supersedes_belief_id: null,
      },
    ];
    const renewLease = vi
      .fn()
      .mockResolvedValueOnce(true) // still holding for candidate 1
      .mockResolvedValueOnce(false); // lost the lease before candidate 2
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
      renewLease,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 1, skipped: false, leaseLost: true });
    expect(deps.upsertBelief).toHaveBeenCalledTimes(1);
    expect(deps.compileBrief).not.toHaveBeenCalled();
    expect(deps.markConsolidated).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled(); // logged that the lease was lost mid-run

    errorSpy.mockRestore();
  });

  it("always calls releaseLease, even when upsertBelief throws partway through", async () => {
    const deps = makeDeps({
      claimBatch: vi.fn(async () => [
        { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      ] as any),
      extractFacts: vi.fn(async () => [
        {
          text: "A valid fact.",
          type: "preference" as const,
          scope: "project" as const,
          importance: 0.5,
          observation_ids: ["obs-1"],
          supersedes_belief_id: null,
        },
      ]),
      upsertBelief: vi.fn(async () => {
        throw new Error("db write failed");
      }),
    });

    await expect(runConsolidation(fakeDb, "proj", deps)).rejects.toThrow("db write failed");

    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
    expect(deps.markConsolidated).not.toHaveBeenCalled();
  });
});

describe("fetchExistingBeliefs", () => {
  it("queries active beliefs for the project with a text-only projection and the given limit, mapping _id/text into ExistingBeliefContext", async () => {
    const docs = [
      { _id: "belief-1", text: "First belief." },
      { _id: "belief-2", text: "Second belief." },
    ];
    const limitFn = vi.fn(() => ({ toArray: async () => docs }));
    const findFn = vi.fn(() => ({ limit: limitFn }));
    const collectionFn = vi.fn(() => ({ find: findFn }));
    const db = { collection: collectionFn } as any;

    const result = await fetchExistingBeliefs(db, "proj", 30);

    expect(collectionFn).toHaveBeenCalledWith(BELIEFS);
    expect(findFn).toHaveBeenCalledWith(
      { project: "proj", status: "active" },
      { projection: { text: 1 } }
    );
    expect(limitFn).toHaveBeenCalledWith(30);
    expect(result).toEqual([
      { _id: "belief-1", text: "First belief." },
      { _id: "belief-2", text: "Second belief." },
    ]);
  });

  it("stringifies non-string _id and text fields when mapping into ExistingBeliefContext", async () => {
    // _id is typically an ObjectId in real usage, not a plain string; the
    // mapping must coerce it (and text) to a string rather than passing
    // whatever raw type the driver returned through untouched.
    const docs = [{ _id: { toString: () => "obj-id-1" }, text: 123 }];
    const limitFn = vi.fn(() => ({ toArray: async () => docs }));
    const findFn = vi.fn(() => ({ limit: limitFn }));
    const db = { collection: vi.fn(() => ({ find: findFn })) } as any;

    const result = await fetchExistingBeliefs(db, "proj", 10);

    expect(result).toEqual([{ _id: "obj-id-1", text: "123" }]);
  });
});

describe("markConsolidated", () => {
  it("updates only observations matching _id in the claimed list, the project, and the run_id, setting status to consolidated", async () => {
    const updateManyFn = vi.fn(async () => ({ acknowledged: true, matchedCount: 2, modifiedCount: 2 }));
    const collectionFn = vi.fn(() => ({ updateMany: updateManyFn }));
    const db = { collection: collectionFn } as any;

    await markConsolidated(db, "proj", "run-1", ["obs-1", "obs-2"]);

    expect(collectionFn).toHaveBeenCalledWith(OBSERVATIONS);
    expect(updateManyFn).toHaveBeenCalledWith(
      { _id: { $in: ["obs-1", "obs-2"] }, project: "proj", run_id: "run-1" },
      { $set: { status: "consolidated" } }
    );
  });
});
