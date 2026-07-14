import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runConsolidation,
  fetchExistingBeliefs,
  markConsolidated,
  markObservationFailed,
} from "../src/consolidation/run.js";
import type { RunConsolidationDeps } from "../src/consolidation/run.js";
import { BELIEFS, OBSERVATIONS } from "../src/db/schema.js";
import { NonRetryableLLMError } from "../src/llm/errors.js";

let savedFailureLog: string | undefined;

beforeEach(() => {
  savedFailureLog = process.env.MEMORY_FAILURE_LOG;
  // extractWithSplit's terminal single-observation failure path calls
  // appendFailure; redirect it to a scratch file so these tests never touch
  // the real ~/.mongo-claude-memory/failures.log.
  process.env.MEMORY_FAILURE_LOG = path.join(
    tmpdir(),
    "mongo-claude-memory-run-test-failures.log"
  );
});

afterEach(() => {
  if (savedFailureLog === undefined) delete process.env.MEMORY_FAILURE_LOG;
  else process.env.MEMORY_FAILURE_LOG = savedFailureLog;
});

function makeDeps(overrides: Partial<RunConsolidationDeps> = {}): RunConsolidationDeps {
  return {
    runId: "run-1",
    leaseMs: 300000,
    claimBatchSize: 50,
    reclaimAfterMs: 600000,
    beliefsContextLimit: 30,
    dedupeSimilarityThreshold: 0.93,
    // Matches config's default (3): most tests never approach the breaker,
    // only the ones in the "circuit breaker" describe block below override
    // it to a small number to make tripping it easy to arrange.
    maxConsecutiveTerminalExtractionFailures: 3,
    reclaimStale: vi.fn(async () => 0),
    acquireLease: vi.fn(async () => true),
    renewLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => undefined),
    claimBatch: vi.fn(async () => []),
    fetchExistingBeliefs: vi.fn(async () => []),
    extractFacts: vi.fn(async () => []),
    // Explicitly stubbed to isInjection:false, never left to the real
    // default: omitting this would fall through to the real classifyInjection,
    // which calls the real LLM provider dispatcher.
    classifyInjection: vi.fn(async () => ({ isInjection: false })),
    // Explicitly stubbed, never left to the real default: omitting this
    // would fall through to the real quarantineDroppedCandidate, which calls
    // loadConfig() and a real db collection.
    quarantineDropped: vi.fn(async () => undefined),
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

  it("drops a candidate flagged by classifyInjection as prompt injection, without upserting it, even though it passes deterministic validation", async () => {
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
        // Deliberately clean of any deterministic deny-list pattern: this
        // candidate must reach classifyInjection, not get dropped earlier by
        // validateCandidateFact, so the mocked classifier is what rejects it.
        text: "The project uses ESLint for linting.",
        type: "convention" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-2"],
        supersedes_belief_id: null,
      },
    ];
    const classifyInjection = vi
      .fn()
      .mockResolvedValueOnce({ isInjection: false })
      .mockResolvedValueOnce({ isInjection: true, reason: "reads like an instruction to the assistant" });
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
      classifyInjection,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 1, skipped: false });
    expect(classifyInjection).toHaveBeenCalledTimes(2);
    expect(deps.upsertBelief).toHaveBeenCalledTimes(1);
    // Still fully processed as a batch: the flagged candidate is dropped, not
    // left unconsolidated, same as a deterministically-invalid candidate.
    expect(deps.markConsolidated).toHaveBeenCalledWith(fakeDb, "proj", "run-1", ["obs-1", "obs-2"]);
    expect(errorSpy).toHaveBeenCalled(); // logged why the flagged candidate was dropped

    errorSpy.mockRestore();
  });

  it("passes consolidationBatchMaxChars through to claimBatch as the fifth argument", async () => {
    const claimBatch = vi.fn(async () => []);
    const deps = makeDeps({ claimBatch, consolidationBatchMaxChars: 123456 });

    await runConsolidation(fakeDb, "proj", deps);

    expect(claimBatch).toHaveBeenCalledWith(fakeDb, "proj", "run-1", 50, 123456);
  });

  it("passes each candidate's newest backing observation created_at to upsertBelief as candidateEvidenceAt", async () => {
    const older = new Date("2026-07-01T00:00:00Z");
    const newer = new Date("2026-07-05T00:00:00Z");
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: older },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: newer },
    ];
    const candidates = [
      {
        text: "The user prefers tabs.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1", "obs-2"],
        supersedes_belief_id: null,
      },
    ];
    const upsertBelief = vi.fn(async () => ({ beliefId: "belief-1", action: "insert" as const }));
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
      upsertBelief,
    });

    await runConsolidation(fakeDb, "proj", deps);

    expect(upsertBelief).toHaveBeenCalledTimes(1);
    const evidenceAt = (upsertBelief.mock.calls[0] as unknown[])[5];
    expect(evidenceAt).toEqual(newer);
  });

  it("passes undefined candidateEvidenceAt when a candidate's observation_ids resolve to no claimed observation", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const candidates = [
      {
        text: "The user prefers tabs.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["not-a-claimed-obs"],
        supersedes_belief_id: null,
      },
    ];
    const upsertBelief = vi.fn(async () => ({ beliefId: "belief-1", action: "insert" as const }));
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
      upsertBelief,
    });

    await runConsolidation(fakeDb, "proj", deps);

    expect((upsertBelief.mock.calls[0] as unknown[])[5]).toBeUndefined();
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
    // renewLease is called exactly once: extractWithSplit renews the lease
    // before its single (unsplit, successful) extractFacts attempt. The
    // per-candidate loop body (a second renewLease per candidate, embed,
    // upsertBelief) never runs at all when there are zero candidates to
    // iterate.
    expect(deps.renewLease).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce(true) // extractWithSplit's pre-extraction renewal
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

  it("marks a single observation failed (terminal, no retry) when extractFacts fails non-retryably on a batch of one, and excludes it from markConsolidated", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const markFailed = vi.fn(async () => undefined);
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => {
        throw new NonRetryableLLMError("extraction output truncated; reduce batch size");
      }),
      markFailed,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 0, skipped: false });
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(fakeDb, "proj", "run-1", "obs-1", "NonRetryableLLMError");
    // The failed observation is excluded from markConsolidated: it was moved
    // to a terminal "failed" status, not "consolidated".
    expect(deps.markConsolidated).toHaveBeenCalledWith(fakeDb, "proj", "run-1", []);
    expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "proj");
    expect(deps.upsertBelief).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled(); // logged the terminal failure

    errorSpy.mockRestore();
  });

  it("propagates a transient (non-NonRetryableLLMError) extraction failure immediately, without splitting the batch or marking any observation failed", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const extractFacts = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const markFailed = vi.fn();
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts,
      markFailed,
    });

    await expect(runConsolidation(fakeDb, "proj", deps)).rejects.toThrow("rate limited");

    // A transient failure is never split: dividing the batch does nothing
    // for a network blip or rate limit that will recover on retry regardless
    // of batch size, so extractFacts is called exactly once, on the whole
    // batch, before the error propagates.
    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(markFailed).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("splits a batch when extraction fails non-retryably, isolating and marking failed only the single poison observation while still processing the rest", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-3", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-4", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const poisonId = "obs-2";
    const extractFacts = vi.fn(async (observations: { _id: string }[]) => {
      if (observations.some((o) => o._id === poisonId)) {
        throw new NonRetryableLLMError("batch contains an oversized observation");
      }
      return observations.map((o) => ({
        text: `fact from ${o._id}`,
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: [o._id],
        supersedes_belief_id: null,
      }));
    });
    const markFailed = vi.fn(async () => undefined);
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts,
      markFailed,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result.processed).toBe(3); // obs-1, obs-3, obs-4 each yield one fact
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(fakeDb, "proj", "run-1", "obs-2", "NonRetryableLLMError");
    // Recursive splitting isolates the poison observation on its own:
    // extractFacts is called more than once (the whole batch, then
    // progressively smaller halves) rather than failing the whole batch
    // permanently.
    expect(extractFacts.mock.calls.length).toBeGreaterThan(1);
    const markConsolidatedIds = (deps.markConsolidated as ReturnType<typeof vi.fn>).mock
      .calls[0][3] as string[];
    expect(new Set(markConsolidatedIds)).toEqual(new Set(["obs-1", "obs-3", "obs-4"]));
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it("stops mid-split and reports leaseLost when the lease is lost before a split half's extraction attempt, without calling extractFacts on that half or its sibling", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const extractFacts = vi.fn(async (observations: unknown[]) => {
      if (observations.length > 1) {
        throw new NonRetryableLLMError("batch too large");
      }
      return [];
    });
    const renewLease = vi
      .fn()
      .mockResolvedValueOnce(true) // pre-extraction renewal for the whole batch
      .mockResolvedValueOnce(false); // pre-extraction renewal for the left half: lease lost
    const markFailed = vi.fn();
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts,
      renewLease,
      markFailed,
    });

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 0, skipped: false, leaseLost: true });
    // Only the initial whole-batch attempt: the left half never gets to call
    // extractFacts because its own pre-extraction lease renewal already
    // reported the lease lost, and the right half (the sibling) is never
    // attempted once the left half reports leaseLost.
    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(markFailed).not.toHaveBeenCalled();
    expect(deps.compileBrief).not.toHaveBeenCalled();
    expect(deps.markConsolidated).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
  });

  describe("circuit breaker (consecutive single-observation terminal failures)", () => {
    it("trips after exactly N consecutive single-observation terminal failures, aborting the run without ever calling markConsolidated, still releasing the lease, and logging the count and the last failure's error NAME", async () => {
      // Simulates the incident: every extraction call fails non-retryably
      // (a dead API key), so the whole batch and every split half fail too.
      // With the limit injected as 2, the breaker must trip on the second
      // single-observation leaf failure, never reaching obs-3/obs-4.
      const claimed = [
        { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
        { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
        { _id: "obs-3", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
        { _id: "obs-4", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      ];
      const extractFacts = vi.fn(async () => {
        throw new NonRetryableLLMError("invalid api key");
      });
      const markFailed = vi.fn(async () => undefined);
      const deps = makeDeps({
        claimBatch: vi.fn(async () => claimed as any),
        extractFacts,
        markFailed,
        maxConsecutiveTerminalExtractionFailures: 2,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(runConsolidation(fakeDb, "proj", deps)).rejects.toThrow();

      expect(markFailed).toHaveBeenCalledTimes(2);
      expect(markFailed).toHaveBeenNthCalledWith(1, fakeDb, "proj", "run-1", "obs-1", "NonRetryableLLMError");
      expect(markFailed).toHaveBeenNthCalledWith(2, fakeDb, "proj", "run-1", "obs-2", "NonRetryableLLMError");
      // Exactly 4 extractFacts calls: the whole batch, then [obs-1,obs-2],
      // then the obs-1 and obs-2 leaves. The top-level right half
      // ([obs-3,obs-4]) is never even attempted, since the breaker aborts
      // while still awaiting the left half's result.
      expect(extractFacts).toHaveBeenCalledTimes(4);
      expect(deps.markConsolidated).not.toHaveBeenCalled();
      expect(deps.compileBrief).not.toHaveBeenCalled();
      // Lease still released even though the run aborted: consolidation must
      // never wedge.
      expect(deps.releaseLease).toHaveBeenCalledTimes(1);

      const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("circuit breaker tripped");
      expect(logged).toContain("2 consecutive");
      expect(logged).toContain("NonRetryableLLMError");

      errorSpy.mockRestore();
    });

    it("does not trip when the same number of total single-observation failures occurs but a success always intervenes between them (never consecutive)", async () => {
      const claimed = [
        { _id: "obs-A", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
        { _id: "obs-B", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
        { _id: "obs-C", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
        { _id: "obs-D", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      ];
      // obs-A and obs-C are poison (always fail non-retryably, alone or in
      // any group that contains them); obs-B and obs-D always succeed alone.
      // The batch splits into [A,B] and [C,D], so each poison observation's
      // single-observation failure is separated from the other by a
      // successful extraction (B, then D), resetting the counter each time:
      // two total single-observation failures, zero of them consecutive.
      const poisonIds = new Set(["obs-A", "obs-C"]);
      const extractFacts = vi.fn(async (observations: { _id: string }[]) => {
        if (observations.some((o) => poisonIds.has(o._id))) {
          throw new NonRetryableLLMError("batch contains an oversized observation");
        }
        return observations.map((o) => ({
          text: `fact from ${o._id}`,
          type: "preference" as const,
          scope: "project" as const,
          importance: 0.5,
          observation_ids: [o._id],
          supersedes_belief_id: null,
        }));
      });
      const markFailed = vi.fn(async () => undefined);
      const deps = makeDeps({
        claimBatch: vi.fn(async () => claimed as any),
        extractFacts,
        markFailed,
        maxConsecutiveTerminalExtractionFailures: 2,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const result = await runConsolidation(fakeDb, "proj", deps);

      expect(result.processed).toBe(2); // obs-B and obs-D each yield one fact
      expect(markFailed).toHaveBeenCalledTimes(2);
      expect(markFailed).toHaveBeenCalledWith(fakeDb, "proj", "run-1", "obs-A", "NonRetryableLLMError");
      expect(markFailed).toHaveBeenCalledWith(fakeDb, "proj", "run-1", "obs-C", "NonRetryableLLMError");
      // Never trips: the run completes normally and marks the survivors
      // consolidated, unlike the aborted-run case above.
      const markConsolidatedIds = (deps.markConsolidated as ReturnType<typeof vi.fn>).mock
        .calls[0][3] as string[];
      expect(new Set(markConsolidatedIds)).toEqual(new Set(["obs-B", "obs-D"]));
      expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "proj");
      expect(deps.releaseLease).toHaveBeenCalledTimes(1);

      const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).not.toContain("circuit breaker tripped");

      errorSpy.mockRestore();
    });
  });

  it("quarantines a deny-list-dropped candidate with stage 'deny-list', the full text, and its observation ids", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const invalidCandidate = {
      text: "", // invalid: fails validateBeliefText (empty text)
      type: "preference" as const,
      scope: "project" as const,
      importance: 0.5,
      observation_ids: ["obs-2"],
      supersedes_belief_id: null,
    };
    const candidates = [
      {
        text: "The user prefers tabs.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
      invalidCandidate,
    ];
    const quarantineDropped = vi.fn(async () => undefined);
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
      quarantineDropped,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runConsolidation(fakeDb, "proj", deps);

    expect(quarantineDropped).toHaveBeenCalledTimes(1);
    expect(quarantineDropped).toHaveBeenCalledWith(
      fakeDb,
      "proj",
      "run-1",
      invalidCandidate,
      "deny-list",
      "text is empty"
    );

    errorSpy.mockRestore();
  });

  it("quarantines a classifier-dropped candidate with stage 'classifier' and the classifier's reason", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const flaggedCandidate = {
      // Deliberately clean of any deterministic deny-list pattern so it
      // reaches classifyInjection rather than being dropped earlier.
      text: "The project uses ESLint for linting.",
      type: "convention" as const,
      scope: "project" as const,
      importance: 0.5,
      observation_ids: ["obs-2"],
      supersedes_belief_id: null,
    };
    const candidates = [
      {
        text: "The user prefers tabs.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
      flaggedCandidate,
    ];
    const classifyInjection = vi
      .fn()
      .mockResolvedValueOnce({ isInjection: false })
      .mockResolvedValueOnce({ isInjection: true, reason: "reads like an instruction to the assistant" });
    const quarantineDropped = vi.fn(async () => undefined);
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
      classifyInjection,
      quarantineDropped,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runConsolidation(fakeDb, "proj", deps);

    expect(quarantineDropped).toHaveBeenCalledTimes(1);
    expect(quarantineDropped).toHaveBeenCalledWith(
      fakeDb,
      "proj",
      "run-1",
      flaggedCandidate,
      "classifier",
      "reads like an instruction to the assistant"
    );

    errorSpy.mockRestore();
  });

  it("does not fail the run, and still marks the batch consolidated, when the quarantine dependency itself rejects", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const candidates = [
      {
        text: "", // invalid: fails validateBeliefText, drops into the quarantine path
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
    ];
    const quarantineDropped = vi.fn(async () => {
      throw new Error("quarantine insert failed");
    });
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
      quarantineDropped,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 0, skipped: false });
    expect(quarantineDropped).toHaveBeenCalledTimes(1);
    expect(deps.markConsolidated).toHaveBeenCalledWith(fakeDb, "proj", "run-1", ["obs-1"]);
    expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "proj");
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it("still marks the whole batch consolidated when every candidate is dropped (deny-list or classifier)", async () => {
    const claimed = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
      { _id: "obs-2", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "claimed", created_at: new Date() },
    ];
    const candidates = [
      {
        text: "", // invalid: dropped by validateCandidateFact
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
      {
        text: "A perfectly clean candidate fact.", // dropped by the classifier instead
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-2"],
        supersedes_belief_id: null,
      },
    ];
    const classifyInjection = vi.fn(async () => ({ isInjection: true, reason: "flagged" }));
    const quarantineDropped = vi.fn(async () => undefined);
    const deps = makeDeps({
      claimBatch: vi.fn(async () => claimed as any),
      extractFacts: vi.fn(async () => candidates),
      classifyInjection,
      quarantineDropped,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runConsolidation(fakeDb, "proj", deps);

    expect(result).toEqual({ processed: 0, skipped: false });
    expect(quarantineDropped).toHaveBeenCalledTimes(2);
    expect(deps.upsertBelief).not.toHaveBeenCalled();
    expect(deps.markConsolidated).toHaveBeenCalledWith(fakeDb, "proj", "run-1", ["obs-1", "obs-2"]);
    expect(deps.compileBrief).toHaveBeenCalledWith(fakeDb, "proj");
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });
});

describe("fetchExistingBeliefs", () => {
  it("queries active beliefs for the project with a text-only projection, sorted by updated_at descending, with the given limit, mapping _id/text into ExistingBeliefContext", async () => {
    const docs = [
      { _id: "belief-1", text: "First belief." },
      { _id: "belief-2", text: "Second belief." },
    ];
    const limitFn = vi.fn(() => ({ toArray: async () => docs }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));
    const collectionFn = vi.fn(() => ({ find: findFn }));
    const db = { collection: collectionFn } as any;

    const result = await fetchExistingBeliefs(db, "proj", 30);

    expect(collectionFn).toHaveBeenCalledWith(BELIEFS);
    expect(findFn).toHaveBeenCalledWith(
      { project: "proj", status: "active" },
      { projection: { text: 1 } }
    );
    // Most recently updated first: the LLM's dedupe/supersede context window
    // must hold the freshest beliefs, not an arbitrary natural-order slice.
    expect(sortFn).toHaveBeenCalledWith({ updated_at: -1 });
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
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));
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
      { _id: { $in: ["obs-1", "obs-2"] }, project: "proj", run_id: "run-1", status: "claimed" },
      { $set: { status: "consolidated" } }
    );
  });
});

describe("markObservationFailed", () => {
  it("updates only the observation matching _id, the project, and the run_id while still claimed, setting status to failed with failed_at/failure_reason", async () => {
    const updateOneFn = vi.fn(async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }));
    const collectionFn = vi.fn(() => ({ updateOne: updateOneFn }));
    const db = { collection: collectionFn } as any;

    await markObservationFailed(db, "proj", "run-1", "obs-1", "NonRetryableLLMError");

    expect(collectionFn).toHaveBeenCalledWith(OBSERVATIONS);
    expect(updateOneFn).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOneFn.mock.calls[0] as [Record<string, unknown>, any];
    expect(filter).toEqual({ _id: "obs-1", project: "proj", run_id: "run-1", status: "claimed" });
    expect(update.$set.status).toBe("failed");
    expect(update.$set.failure_reason).toBe("NonRetryableLLMError");
    expect(update.$set.failed_at).toBeInstanceOf(Date);
  });
});
