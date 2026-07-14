import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "../src/config.js";

const loadConfig = vi.fn();
const getDb = vi.fn();
const closeDb = vi.fn(async () => undefined);
const embed = vi.fn();
const runConsolidation = vi.fn();
const fetchExistingBeliefs = vi.fn();
const markConsolidated = vi.fn();
const markObservationFailed = vi.fn();
const reclaimStale = vi.fn();
const claimBatch = vi.fn();
const acquireLease = vi.fn();
const renewLease = vi.fn();
const releaseLease = vi.fn();
const extractFacts = vi.fn();
const upsertBelief = vi.fn();
const compileBrief = vi.fn();
const runConsolidationDryRun = vi.fn();
const formatDryRunReport = vi.fn(() => "dry-run-report");
const defaultDryRunDeps = vi.fn(() => ({}) as any);
const runRollback = vi.fn();
const formatRollbackReport = vi.fn(() => "rollback-report");
const runReconcileSweep = vi.fn();
const formatReconcileReport = vi.fn(() => "reconcile-report");
const getStatusReport = vi.fn();
const formatStatusReport = vi.fn(() => "status-report");

vi.mock("../src/config.js", () => ({ loadConfig }));
vi.mock("../src/db/client.js", () => ({ getDb, closeDb }));
vi.mock("../src/embeddings/voyage.js", () => ({ embed }));
vi.mock("../src/consolidation/run.js", () => ({
  runConsolidation,
  fetchExistingBeliefs,
  markConsolidated,
  markObservationFailed,
}));
vi.mock("../src/consolidation/claim.js", () => ({ reclaimStale, claimBatch }));
vi.mock("../src/consolidation/lock.js", () => ({ acquireLease, renewLease, releaseLease }));
vi.mock("../src/consolidation/extractFacts.js", () => ({ extractFacts }));
vi.mock("../src/consolidation/upsertBelief.js", () => ({ upsertBelief }));
vi.mock("../src/consolidation/compileBrief.js", () => ({ compileBrief }));
vi.mock("../src/consolidation/dryRun.js", () => ({
  runConsolidationDryRun,
  formatDryRunReport,
  defaultDryRunDeps,
}));
vi.mock("../src/consolidation/rollback.js", () => ({ runRollback, formatRollbackReport }));
vi.mock("../src/consolidation/reconcileSweep.js", () => ({ runReconcileSweep, formatReconcileReport }));
vi.mock("../src/consolidation/status.js", () => ({ getStatusReport, formatStatusReport }));

const { main, runDoctor, findPendingProjects, resolveBatchMaxChars } = await import(
  "../src/consolidation/cli.js"
);
const { computeBatchMaxCharsDefault } = await import("../src/llm/contextWindow.js");

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    mongodbUri: "mongodb://fake",
    mongodbDb: "claude_memory",
    voyageApiKey: "voyage-key",
    voyageModel: "voyage-4",
    voyageDimensions: 1024,
    briefCoreTokenCap: 800,
    briefProjectTokenCap: 1200,
    hookInternalTimeoutMs: 800,
    sessionStartTimeoutMs: 3000,
    hookWriteTimeoutMs: 5000,
    observationTtlDays: 30,
    sessionEndTimeoutMs: 5000,
    anthropicApiKey: "anthropic-key",
    anthropicModel: "claude-sonnet-5",
    llmProvider: "anthropic",
    llmTimeoutMs: 60000,
    ollamaContextTokens: 8192,
    leaseMs: 300000,
    claimBatchSize: 50,
    consolidationBatchMaxChars: 300000,
    reclaimAfterMs: 600000,
    beliefsContextLimit: 30,
    dedupeSimilarityThreshold: 0.93,
    reconcileSimilarityThreshold: 0.75,
    reconcileMaxPairs: 25,
    embeddingMode: "appside",
    ...overrides,
  };
}

function makeFakeDb(pendingProjects: string[] = []) {
  const distinct = vi.fn(async () => pendingProjects);
  const db = { collection: vi.fn(() => ({ distinct })) };
  return { db, distinct };
}

let originalArgv: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalArgv = process.argv;
  process.exitCode = undefined;
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function setArgs(...args: string[]) {
  process.argv = ["node", "cli.js", ...args];
}

describe("main (default consolidation path)", () => {
  it("with no args, consolidates every project with pending observations", async () => {
    loadConfig.mockReturnValue(makeConfig());
    const { db, distinct } = makeFakeDb(["proj-a", "proj-b"]);
    getDb.mockResolvedValue(db);
    runConsolidation.mockResolvedValue({ processed: 3, skipped: false });

    setArgs();
    await main();

    expect(distinct).toHaveBeenCalledWith("project", { status: "pending" });
    expect(runConsolidation).toHaveBeenCalledTimes(2);
    expect(runConsolidation.mock.calls[0][1]).toBe("proj-a");
    expect(runConsolidation.mock.calls[1][1]).toBe("proj-b");
    expect(getStatusReport).not.toHaveBeenCalled();
    expect(runRollback).not.toHaveBeenCalled();
    expect(closeDb).toHaveBeenCalled();
  });

  it("with a project positional, consolidates only that project (skips the pending-projects scan)", async () => {
    loadConfig.mockReturnValue(makeConfig());
    const { db, distinct } = makeFakeDb();
    getDb.mockResolvedValue(db);
    runConsolidation.mockResolvedValue({ processed: 1, skipped: false });

    setArgs("my-project");
    await main();

    expect(distinct).not.toHaveBeenCalled();
    expect(runConsolidation).toHaveBeenCalledTimes(1);
    expect(runConsolidation.mock.calls[0][1]).toBe("my-project");
  });

  it("skips the run cleanly (no crash) when ANTHROPIC_API_KEY is missing", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));

    setArgs("my-project");
    await main();

    expect(getDb).not.toHaveBeenCalled();
    expect(runConsolidation).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("with llmProvider bedrock and no ANTHROPIC_API_KEY, proceeds past the gate (uses AWS credentials instead)", async () => {
    loadConfig.mockReturnValue(makeConfig({ llmProvider: "bedrock", anthropicApiKey: undefined }));
    const { db } = makeFakeDb();
    getDb.mockResolvedValue(db);
    runConsolidation.mockResolvedValue({ processed: 1, skipped: false });

    setArgs("my-project");
    await main();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(getDb).toHaveBeenCalled();
    expect(runConsolidation).toHaveBeenCalledTimes(1);
  });

  it("with llmProvider ollama and no ANTHROPIC_API_KEY, proceeds past the gate (ollama needs no API key)", async () => {
    loadConfig.mockReturnValue(makeConfig({ llmProvider: "ollama", anthropicApiKey: undefined }));
    const { db } = makeFakeDb();
    getDb.mockResolvedValue(db);
    runConsolidation.mockResolvedValue({ processed: 1, skipped: false });

    setArgs("my-project");
    await main();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(getDb).toHaveBeenCalled();
    expect(runConsolidation).toHaveBeenCalledTimes(1);
  });

  it("with llmProvider anthropic (explicit) and no ANTHROPIC_API_KEY, still skips the run cleanly", async () => {
    loadConfig.mockReturnValue(makeConfig({ llmProvider: "anthropic", anthropicApiKey: undefined }));

    setArgs("my-project");
    await main();

    expect(getDb).not.toHaveBeenCalled();
    expect(runConsolidation).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("--dry-run combined with a project runs the dry-run path, not real consolidation", async () => {
    loadConfig.mockReturnValue(makeConfig());
    const { db } = makeFakeDb();
    getDb.mockResolvedValue(db);
    runConsolidationDryRun.mockResolvedValue({ previewed: 0, accepted: [], rejected: [] });

    setArgs("--dry-run", "my-project");
    await main();

    expect(runConsolidationDryRun).toHaveBeenCalledTimes(1);
    expect(runConsolidationDryRun.mock.calls[0][1]).toBe("my-project");
    expect(runConsolidation).not.toHaveBeenCalled();
    expect(formatDryRunReport).toHaveBeenCalledWith("my-project", { previewed: 0, accepted: [], rejected: [] });
  });

  it("a project literally named 'status' still runs consolidation for that project, not the status subcommand", async () => {
    loadConfig.mockReturnValue(makeConfig());
    const { db } = makeFakeDb();
    getDb.mockResolvedValue(db);
    runConsolidation.mockResolvedValue({ processed: 0, skipped: false });

    setArgs("status");
    await main();

    expect(runConsolidation).toHaveBeenCalledTimes(1);
    expect(runConsolidation.mock.calls[0][1]).toBe("status");
    expect(getStatusReport).not.toHaveBeenCalled();
  });

  it("a project literally named 'rollback' still runs consolidation for that project, not the rollback subcommand", async () => {
    loadConfig.mockReturnValue(makeConfig());
    const { db } = makeFakeDb();
    getDb.mockResolvedValue(db);
    runConsolidation.mockResolvedValue({ processed: 0, skipped: false });

    setArgs("rollback");
    await main();

    expect(runConsolidation).toHaveBeenCalledTimes(1);
    expect(runConsolidation.mock.calls[0][1]).toBe("rollback");
    expect(runRollback).not.toHaveBeenCalled();
  });
});

describe("main (configuration error before any DB connection)", () => {
  it("logs only the error name, never err.message (may embed a raw connection string), when loadConfig() throws", async () => {
    loadConfig.mockImplementation(() => {
      throw new Error("invalid connection string: mongodb+srv://user:supersecret@cluster0.example.mongodb.net/");
    });

    setArgs("my-project");
    await main();

    expect(getDb).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).toContain("configuration error");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("mongodb+srv://");
    expect(logged).not.toContain("supersecret");
  });
});

describe("main (unexpected failure reachable before a validated DB connection)", () => {
  it("logs only the error name, never err.message, when getDb() rejects with an error embedding the connection string", async () => {
    loadConfig.mockReturnValue(makeConfig());
    getDb.mockRejectedValue(
      new Error("connect failed: mongodb+srv://user:supersecret@cluster0.example.mongodb.net/")
    );

    setArgs("my-project");
    await main();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).toContain("unexpected failure");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("mongodb+srv://");
    expect(logged).not.toContain("supersecret");
    expect(process.exitCode).toBe(1);
  });
});

describe("main (--status subcommand)", () => {
  it("runs the status report and never touches the ANTHROPIC_API_KEY check", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));
    const db = {};
    getDb.mockResolvedValue(db);
    getStatusReport.mockResolvedValue({
      observationCounts: [],
      staleClaimCount: 0,
      locks: [],
      beliefCounts: [],
      briefs: [],
    });

    setArgs("--status");
    await main();

    expect(getStatusReport).toHaveBeenCalledWith(db, 600000);
    expect(formatStatusReport).toHaveBeenCalled();
    expect(runConsolidation).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("status-report");
  });
});

describe("main (--rollback subcommand)", () => {
  it("accepts the run id via --run-id", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));
    const db = {};
    getDb.mockResolvedValue(db);
    runRollback.mockResolvedValue({
      revertedBeliefs: [],
      restoredBeliefs: [],
      needsManualReview: [],
      resetObservations: 0,
      recompiledScopes: [],
    });

    setArgs("--rollback", "--run-id", "run-abc-123");
    await main();

    expect(runRollback).toHaveBeenCalledWith(db, "run-abc-123");
    expect(logSpy).toHaveBeenCalledWith("rollback-report");
  });

  it("accepts the run id via a bare positional", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));
    const db = {};
    getDb.mockResolvedValue(db);
    runRollback.mockResolvedValue({
      revertedBeliefs: [],
      restoredBeliefs: [],
      needsManualReview: [],
      resetObservations: 0,
      recompiledScopes: [],
    });

    setArgs("--rollback", "run-abc-123");
    await main();

    expect(runRollback).toHaveBeenCalledWith(db, "run-abc-123");
  });

  it("errors and sets a non-zero exit code when no run id is given", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));

    setArgs("--rollback");
    await main();

    expect(runRollback).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("main (--reconcile subcommand)", () => {
  it("dispatches to runReconcileSweep with the project positional, wires deps from config, and prints the formatted report", async () => {
    loadConfig.mockReturnValue(
      makeConfig({
        reconcileSimilarityThreshold: 0.8,
        reconcileMaxPairs: 10,
        embeddingMode: "appside",
        voyageModel: "voyage-4",
      })
    );
    const db = {};
    getDb.mockResolvedValue(db);
    runReconcileSweep.mockResolvedValue({
      beliefsScanned: 0,
      pairsFound: 0,
      pairsArbitrated: 0,
      archivedSupersedes: [],
      archivedDuplicates: [],
      skippedCap: 0,
      skippedContention: 0,
      skippedErrors: 0,
      recompiledScopes: [],
    });

    setArgs("--reconcile", "my-project");
    await main();

    expect(runReconcileSweep).toHaveBeenCalledTimes(1);
    const [calledDb, calledProject, calledDeps] = runReconcileSweep.mock.calls[0];
    expect(calledDb).toBe(db);
    expect(calledProject).toBe("my-project");
    expect(calledDeps.threshold).toBe(0.8);
    expect(calledDeps.maxPairs).toBe(10);
    expect(calledDeps.embeddingMode).toBe("appside");
    expect(typeof calledDeps.reconcile).toBe("function");
    expect(typeof calledDeps.compileBrief).toBe("function");
    expect(formatReconcileReport).toHaveBeenCalledWith("my-project", expect.any(Object));
    expect(logSpy).toHaveBeenCalledWith("reconcile-report");
  });

  it("errors and sets a non-zero exit code, without calling runReconcileSweep or getDb, when no project is given", async () => {
    loadConfig.mockReturnValue(makeConfig());

    setArgs("--reconcile");
    await main();

    expect(getDb).not.toHaveBeenCalled();
    expect(runReconcileSweep).not.toHaveBeenCalled();
    expect(formatReconcileReport).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("is gated behind the ANTHROPIC_API_KEY guard (unlike --status/--rollback/--doctor): skips cleanly, never reaching the sweep, when the key is missing", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));

    setArgs("--reconcile", "my-project");
    await main();

    expect(getDb).not.toHaveBeenCalled();
    expect(runReconcileSweep).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("main (--retry-failed subcommand)", () => {
  function makeRetryFailedDb(modifiedCount: number) {
    const updateMany = vi.fn(async () => ({
      acknowledged: true,
      matchedCount: modifiedCount,
      modifiedCount,
    }));
    const collectionFn = vi.fn(() => ({ updateMany }));
    const db = { collection: collectionFn };
    return { db, updateMany, collectionFn };
  }

  it("errors and sets a non-zero exit code, without touching the DB, when no project is given", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));

    setArgs("--retry-failed");
    await main();

    expect(getDb).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("issues the exact updateMany filter/update shape against the observations collection and prints the reset count", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));
    const { db, updateMany, collectionFn } = makeRetryFailedDb(5);
    getDb.mockResolvedValue(db);

    setArgs("--retry-failed", "my-project");
    await main();

    expect(collectionFn).toHaveBeenCalledWith("observations");
    expect(updateMany).toHaveBeenCalledWith(
      { project: "my-project", status: "failed" },
      {
        $set: { status: "pending" },
        $unset: { failed_at: "", failure_reason: "", run_id: "", claimed_at: "" },
      }
    );
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("reset 5 failed observation");
    expect(printed).toContain("my-project");
    expect(runConsolidation).not.toHaveBeenCalled();
  });

  it("prints the normal zero-match message, not an error, when there are no failed observations to retry", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));
    const { db } = makeRetryFailedDb(0);
    getDb.mockResolvedValue(db);

    setArgs("--retry-failed", "my-project");
    await main();

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("no failed observations to retry");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("does not require ANTHROPIC_API_KEY: works the same during the outage that caused the failures being retried", async () => {
    loadConfig.mockReturnValue(makeConfig({ anthropicApiKey: undefined }));
    const { db, updateMany } = makeRetryFailedDb(1);
    getDb.mockResolvedValue(db);

    setArgs("--retry-failed", "my-project");
    await main();

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("findPendingProjects", () => {
  it("unions projects with pending observations and projects with stale claimed observations", async () => {
    const distinct = vi.fn(async (_field: string, filter: Record<string, unknown>) => {
      if (filter.status === "pending") return ["proj-pending", "proj-both"];
      return ["proj-stranded", "proj-both"];
    });
    const db = { collection: vi.fn(() => ({ distinct })) };

    const projects = await findPendingProjects(db as any, 600000);

    expect(projects.sort()).toEqual(["proj-both", "proj-pending", "proj-stranded"]);
    expect(distinct).toHaveBeenCalledTimes(2);
    expect(distinct).toHaveBeenNthCalledWith(1, "project", { status: "pending" });
    const [, staleFilter] = distinct.mock.calls[1];
    expect(staleFilter.status).toBe("claimed");
    // The staleness threshold is now - reclaimAfterMs, i.e. roughly 10
    // minutes in the past for the configured 600000ms.
    const lt = (staleFilter.claimed_at as { $lt: Date }).$lt;
    expect(lt).toBeInstanceOf(Date);
    expect(Date.now() - lt.getTime()).toBeGreaterThan(590000);
    expect(Date.now() - lt.getTime()).toBeLessThan(610000);
  });
});

describe("runDoctor (--doctor)", () => {
  type SearchIndexesSpec = Array<{ name: string; queryable: boolean }> | "throw";

  const defaultSearchIndexes: SearchIndexesSpec = [
    { name: "beliefs_vec", queryable: true },
    { name: "beliefs_text", queryable: true },
  ];

  function makeDoctorDb(
    opts: { canaryFound?: boolean; searchIndexes?: SearchIndexesSpec } = {}
  ) {
    let insertedDoc: Record<string, unknown> | null = null;
    const observationsCollection = {
      insertOne: vi.fn(async (doc: Record<string, unknown>) => {
        insertedDoc = doc;
        return { insertedId: "canary-id" };
      }),
      findOne: vi.fn(async () =>
        (opts.canaryFound ?? true) ? { _id: "canary-id", project: "doctor:canary" } : null
      ),
      deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
    };
    const briefsCollection = {
      findOne: vi.fn(async () => null), // no brief:global yet is still a PASS
    };
    const searchIndexesSpec = opts.searchIndexes ?? defaultSearchIndexes;
    const aggregate = vi.fn(() => ({
      toArray: async () => {
        if (searchIndexesSpec === "throw") {
          throw new Error("no $listSearchIndexes support on this cluster");
        }
        return searchIndexesSpec;
      },
    }));
    const beliefsCollection = { aggregate };
    const db = {
      collection: vi.fn((name: string) => {
        if (name === "observations") return observationsCollection;
        if (name === "beliefs") return beliefsCollection;
        return briefsCollection;
      }),
    };
    return {
      db,
      observationsCollection,
      briefsCollection,
      beliefsCollection,
      getInserted: () => insertedDoc,
    };
  }

  it("happy path: writes, reads back, and deletes a canary, times the brief fetch, checks search indexes, and reports all steps passing", async () => {
    loadConfig.mockReturnValue(makeConfig());
    const { db, observationsCollection, briefsCollection, getInserted } = makeDoctorDb();

    const report = await runDoctor(db as any, 3000, "appside");

    expect(report.ok).toBe(true);
    expect(report.steps).toHaveLength(5);
    expect(report.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    expect(report.steps.every((s: { ms: number }) => typeof s.ms === "number")).toBe(true);

    // Canary hygiene: project doctor:canary, normal priority (TTL cleans up
    // leftovers), and the same document is deleted afterward.
    const inserted = getInserted() as Record<string, unknown>;
    expect(inserted.project).toBe("doctor:canary");
    expect(inserted.priority).toBe("normal");
    expect(observationsCollection.deleteOne).toHaveBeenCalledWith({ _id: "canary-id" });
    expect(briefsCollection.findOne).toHaveBeenCalledWith({ _id: "brief:global" });

    const searchStep = report.steps.find((s: { name: string }) => s.name === "search indexes")!;
    expect(searchStep.ok).toBe(true);
    expect(searchStep.detail).toContain("beliefs_vec");
    expect(searchStep.detail).toContain("beliefs_text");
  });

  it("reports a failed step (and ok:false) when the canary cannot be read back, using the error name only", async () => {
    loadConfig.mockReturnValue(makeConfig());
    const { db } = makeDoctorDb({ canaryFound: false });

    const report = await runDoctor(db as any, 3000, "appside");

    expect(report.ok).toBe(false);
    const readStep = report.steps.find((s: { name: string }) => s.name === "read canary back")!;
    expect(readStep.ok).toBe(false);
    expect(readStep.detail).toBe("Error"); // error NAME only, never a message
  });

  it("main dispatches --doctor, prints the report, and sets exit code 0 on success", async () => {
    loadConfig.mockReturnValue(makeConfig());
    const { db } = makeDoctorDb();
    getDb.mockResolvedValue(db);

    setArgs("--doctor");
    await main();

    expect(process.exitCode).toBeUndefined();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("[doctor]");
    expect(printed).toContain("all steps passed");
    expect(printed).not.toContain("mongodb://"); // never a connection string
    expect(runConsolidation).not.toHaveBeenCalled();
  });

  describe("search indexes step", () => {
    it("passes (and doctor is overall ok) when the required indexes are present and queryable", async () => {
      const { db } = makeDoctorDb({
        searchIndexes: [
          { name: "beliefs_vec", queryable: true },
          { name: "beliefs_text", queryable: true },
        ],
      });

      const report = await runDoctor(db as any, 3000, "appside");

      expect(report.ok).toBe(true);
      const step = report.steps.find((s: { name: string }) => s.name === "search indexes")!;
      expect(step.ok).toBe(true);
    });

    it("fails the step, and the overall doctor result, when the required vector index is missing, and includes the setupIndexes.js hint", async () => {
      const { db } = makeDoctorDb({
        searchIndexes: [{ name: "beliefs_text", queryable: true }],
      });

      const report = await runDoctor(db as any, 3000, "appside");

      expect(report.ok).toBe(false);
      const step = report.steps.find((s: { name: string }) => s.name === "search indexes")!;
      expect(step.ok).toBe(false);
      expect(step.detail).toContain("beliefs_vec");
      expect(step.detail).toContain("MISSING");
      expect(step.detail).toContain("setupIndexes.js");
    });

    it("fails the step when a required index is present but not queryable", async () => {
      const { db } = makeDoctorDb({
        searchIndexes: [
          { name: "beliefs_vec", queryable: false },
          { name: "beliefs_text", queryable: true },
        ],
      });

      const report = await runDoctor(db as any, 3000, "appside");

      const step = report.steps.find((s: { name: string }) => s.name === "search indexes")!;
      expect(step.ok).toBe(false);
      expect(report.ok).toBe(false);
      expect(step.detail).toContain("beliefs_vec");
    });

    it("in auto mode requires beliefs_vec_auto: a mock with only beliefs_vec (appside's index) fails", async () => {
      const { db } = makeDoctorDb({
        searchIndexes: [
          { name: "beliefs_vec", queryable: true },
          { name: "beliefs_text", queryable: true },
        ],
      });

      const report = await runDoctor(db as any, 3000, "auto");

      const step = report.steps.find((s: { name: string }) => s.name === "search indexes")!;
      expect(step.ok).toBe(false);
      expect(step.detail).toContain("beliefs_vec_auto");
      expect(step.detail).toContain("MISSING");
    });

    it("in appside mode requires beliefs_vec: a mock with only beliefs_vec_auto (auto's index) fails", async () => {
      const { db } = makeDoctorDb({
        searchIndexes: [
          { name: "beliefs_vec_auto", queryable: true },
          { name: "beliefs_text", queryable: true },
        ],
      });

      const report = await runDoctor(db as any, 3000, "appside");

      const step = report.steps.find((s: { name: string }) => s.name === "search indexes")!;
      expect(step.ok).toBe(false);
      expect(step.detail).toContain("beliefs_vec: MISSING");
    });

    it("passes in auto mode when beliefs_vec_auto and beliefs_text are present and queryable", async () => {
      const { db } = makeDoctorDb({
        searchIndexes: [
          { name: "beliefs_vec_auto", queryable: true },
          { name: "beliefs_text", queryable: true },
        ],
      });

      const report = await runDoctor(db as any, 3000, "auto");

      const step = report.steps.find((s: { name: string }) => s.name === "search indexes")!;
      expect(step.ok).toBe(true);
      expect(report.ok).toBe(true);
    });

    it("fails soft with the error NAME when $listSearchIndexes throws (older cluster, no search support), leaving other steps unaffected", async () => {
      const { db } = makeDoctorDb({ searchIndexes: "throw" });

      const report = await runDoctor(db as any, 3000, "appside");

      expect(report.ok).toBe(false);
      const step = report.steps.find((s: { name: string }) => s.name === "search indexes")!;
      expect(step.ok).toBe(false);
      expect(step.detail).toContain("Error"); // error NAME only, never err.message
      expect(step.detail).not.toContain("no $listSearchIndexes support on this cluster"); // never the raw message
      expect(step.detail).toContain("unavailable");

      // Every other doctor step still ran and passed; this step's failure is isolated.
      const otherSteps = report.steps.filter((s: { name: string }) => s.name !== "search indexes");
      expect(otherSteps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    });
  });
});

describe("resolveBatchMaxChars", () => {
  it("an explicit consolidationBatchMaxChars always wins over the model-aware default", () => {
    const config = makeConfig({
      llmProvider: "ollama",
      ollamaContextTokens: 8192,
      consolidationBatchMaxChars: 12345,
    }) as unknown as Config;

    expect(resolveBatchMaxChars(config)).toBe(12345);
  });

  it("falls back to the real model-aware default (computeBatchMaxCharsDefault) when unset", () => {
    const config = makeConfig({
      llmProvider: "ollama",
      ollamaContextTokens: 8192,
      consolidationBatchMaxChars: undefined,
    }) as unknown as Config;

    // 8192 tokens * 4 chars/token * 0.6 safety margin, floored: 19660.
    expect(resolveBatchMaxChars(config)).toBe(19660);
    expect(resolveBatchMaxChars(config)).toBe(computeBatchMaxCharsDefault(config));
  });
});

describe("main: extraction batch budget warning", () => {
  it("logs a warning when the resolved batch budget is smaller than a single observation can be", async () => {
    loadConfig.mockReturnValue(
      makeConfig({
        llmProvider: "ollama",
        anthropicApiKey: undefined,
        ollamaContextTokens: 8192,
        consolidationBatchMaxChars: undefined,
      })
    );
    const { db } = makeFakeDb();
    getDb.mockResolvedValue(db);
    runConsolidation.mockResolvedValue({ processed: 0, skipped: false });

    setArgs("my-project");
    await main();

    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("extraction batch budget");
    expect(logged).toContain("19660 chars");
  });

  it("logs no warning when the resolved batch budget is at or above a single observation's max size", async () => {
    loadConfig.mockReturnValue(
      makeConfig({ consolidationBatchMaxChars: undefined }) // anthropic default: 200k-token model, well over 50000 chars
    );
    const { db } = makeFakeDb();
    getDb.mockResolvedValue(db);
    runConsolidation.mockResolvedValue({ processed: 0, skipped: false });

    setArgs("my-project");
    await main();

    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("extraction batch budget");
  });
});
