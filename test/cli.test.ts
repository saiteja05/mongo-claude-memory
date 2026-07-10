import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loadConfig = vi.fn();
const getDb = vi.fn();
const closeDb = vi.fn(async () => undefined);
const embed = vi.fn();
const runConsolidation = vi.fn();
const fetchExistingBeliefs = vi.fn();
const markConsolidated = vi.fn();
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
const getStatusReport = vi.fn();
const formatStatusReport = vi.fn(() => "status-report");

vi.mock("../src/config.js", () => ({ loadConfig }));
vi.mock("../src/db/client.js", () => ({ getDb, closeDb }));
vi.mock("../src/embeddings/voyage.js", () => ({ embed }));
vi.mock("../src/consolidation/run.js", () => ({
  runConsolidation,
  fetchExistingBeliefs,
  markConsolidated,
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
vi.mock("../src/consolidation/status.js", () => ({ getStatusReport, formatStatusReport }));

const { main } = await import("../src/consolidation/cli.js");

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
    observationTtlDays: 30,
    sessionEndTimeoutMs: 5000,
    anthropicApiKey: "anthropic-key",
    anthropicModel: "claude-sonnet-5",
    leaseMs: 300000,
    claimBatchSize: 50,
    reclaimAfterMs: 600000,
    beliefsContextLimit: 30,
    dedupeSimilarityThreshold: 0.93,
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
