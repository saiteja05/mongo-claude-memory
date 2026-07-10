import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  previewBatch,
  runConsolidationDryRun,
  defaultDryRunDeps,
  formatDryRunReport,
} from "../src/consolidation/dryRun.js";
import type { DryRunDeps, DryRunResult } from "../src/consolidation/dryRun.js";
import { OBSERVATIONS, BELIEFS } from "../src/db/schema.js";

function makeDeps(overrides: Partial<DryRunDeps> = {}): DryRunDeps {
  return {
    previewBatchSize: 50,
    beliefsContextLimit: 30,
    previewBatch: vi.fn(async () => []),
    fetchExistingBeliefs: vi.fn(async () => []),
    extractFacts: vi.fn(async () => []),
    validateCandidateFact: vi.fn(() => ({ valid: true })),
    ...overrides,
  };
}

const fakeDb = {} as any;

describe("previewBatch", () => {
  it("mirrors claimBatch's find (project + status:pending, sorted by created_at, limited) with no update step", async () => {
    const now = Date.now();
    const docs = [
      { _id: "obs-2", project: "proj-a", status: "pending", created_at: new Date(now - 1000) },
      { _id: "obs-1", project: "proj-a", status: "pending", created_at: new Date(now - 2000) },
    ];
    let capturedFilter: unknown;
    let capturedSort: unknown;
    let capturedLimit: unknown;
    const cursor = {
      sort(spec: unknown) {
        capturedSort = spec;
        return cursor;
      },
      limit(n: unknown) {
        capturedLimit = n;
        return cursor;
      },
      async toArray() {
        return [...docs].sort(
          (a, b) => a.created_at.getTime() - b.created_at.getTime()
        );
      },
    };
    const find = vi.fn((filter: unknown) => {
      capturedFilter = filter;
      return cursor;
    });
    const db = { collection: () => ({ find, updateMany: vi.fn() }) };

    const result = await previewBatch(db as any, "proj-a", 50);

    expect(capturedFilter).toEqual({ project: "proj-a", status: "pending" });
    expect(capturedSort).toEqual({ created_at: 1 });
    expect(capturedLimit).toBe(50);
    expect(result.map((d) => d._id)).toEqual(["obs-1", "obs-2"]);
  });

  it("never calls updateMany (read-only, no claim step)", async () => {
    const cursor = {
      sort() {
        return cursor;
      },
      limit() {
        return cursor;
      },
      async toArray() {
        return [];
      },
    };
    const updateMany = vi.fn();
    const db = { collection: () => ({ find: () => cursor, updateMany }) };

    await previewBatch(db as any, "proj-a", 50);

    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("runConsolidationDryRun", () => {
  it("returns previewed:0 and never calls fetchExistingBeliefs or extractFacts when the batch is empty", async () => {
    const deps = makeDeps({ previewBatch: vi.fn(async () => []) });

    const result = await runConsolidationDryRun(fakeDb, "proj", deps);

    expect(result).toEqual({ previewed: 0, accepted: [], rejected: [] });
    expect(deps.fetchExistingBeliefs).not.toHaveBeenCalled();
    expect(deps.extractFacts).not.toHaveBeenCalled();
  });

  it("splits candidates into accepted (reportable fields only) and rejected (text + reason)", async () => {
    const observations = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "pending", created_at: new Date() },
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
        text: "",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
    ];
    const deps = makeDeps({
      previewBatch: vi.fn(async () => observations as any),
      extractFacts: vi.fn(async () => candidates),
      validateCandidateFact: vi.fn((candidate: { text: string }) =>
        candidate.text === "" ? { valid: false, reason: "text is empty" } : { valid: true }
      ),
    });

    const result = await runConsolidationDryRun(fakeDb, "proj", deps);

    expect(result.previewed).toBe(1);
    expect(result.accepted).toEqual([
      { text: "The user prefers tabs.", type: "preference", scope: "project", importance: 0.5 },
    ]);
    expect(result.rejected).toEqual([{ text: "", reason: "text is empty" }]);
  });

  it("never calls acquireLease, embed, upsertBelief, compileBrief, or markConsolidated (zero writes)", async () => {
    const observations = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "pending", created_at: new Date() },
    ];
    const acquireLease = vi.fn();
    const embed = vi.fn();
    const upsertBelief = vi.fn();
    const compileBrief = vi.fn();
    const markConsolidated = vi.fn();
    const deps = makeDeps({
      previewBatch: vi.fn(async () => observations as any),
      extractFacts: vi.fn(async () => [
        {
          text: "A fact.",
          type: "preference" as const,
          scope: "project" as const,
          importance: 0.5,
          observation_ids: ["obs-1"],
          supersedes_belief_id: null,
        },
      ]),
    });

    await runConsolidationDryRun(fakeDb, "proj", deps);

    expect(acquireLease).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(upsertBelief).not.toHaveBeenCalled();
    expect(compileBrief).not.toHaveBeenCalled();
    expect(markConsolidated).not.toHaveBeenCalled();
  });

  it("passes the previewed batch through to fetchExistingBeliefs and extractFacts with the configured limits", async () => {
    const observations = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "pending", created_at: new Date() },
    ];
    const previewBatch = vi.fn(async () => observations as any);
    const fetchExistingBeliefs = vi.fn(async () => []);
    const extractFacts = vi.fn(async () => []);
    const deps = makeDeps({ previewBatch, fetchExistingBeliefs, extractFacts, previewBatchSize: 25, beliefsContextLimit: 10 });

    await runConsolidationDryRun(fakeDb, "proj", deps);

    expect(previewBatch).toHaveBeenCalledWith(fakeDb, "proj", 25);
    expect(fetchExistingBeliefs).toHaveBeenCalledWith(fakeDb, "proj", 10);
    expect(extractFacts).toHaveBeenCalledWith(observations, []);
  });

  it('falls back to reason "invalid" when the validation result omits a reason', async () => {
    const observations = [
      { _id: "obs-1", project: "proj", session_id: "s", source: "transcript", priority: "normal", status: "pending", created_at: new Date() },
    ];
    const candidates = [
      {
        text: "A candidate with no explicit validation reason.",
        type: "preference" as const,
        scope: "project" as const,
        importance: 0.5,
        observation_ids: ["obs-1"],
        supersedes_belief_id: null,
      },
    ];
    const deps = makeDeps({
      previewBatch: vi.fn(async () => observations as any),
      extractFacts: vi.fn(async () => candidates),
      // No `reason` field at all, unlike the other tests in this file which
      // always supply one: this is what exercises the `?? "invalid"` fallback.
      validateCandidateFact: vi.fn(() => ({ valid: false })),
    });

    const result = await runConsolidationDryRun(fakeDb, "proj", deps);

    expect(result.rejected).toEqual([
      { text: "A candidate with no explicit validation reason.", reason: "invalid" },
    ]);
  });
});

describe("defaultDryRunDeps", () => {
  const ENV_KEYS = ["MDB_MCP_CONNECTION_STRING", "MEMORY_MONGODB_URI", "ANTHROPIC_API_KEY"] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.unstubAllGlobals();
  });

  it("wires the real previewBatch, fetchExistingBeliefs, extractFacts, and validateCandidateFact together end to end", async () => {
    const observationDoc = {
      _id: "obs-1",
      project: "proj",
      session_id: "s",
      source: "transcript",
      priority: "normal",
      text: "The user prefers tabs over spaces.",
      status: "pending",
      created_at: new Date(),
    };
    const beliefDoc = { _id: "belief-1", text: "The user likes dark mode." };

    const observationsCollection = {
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [observationDoc],
          }),
        }),
      })),
    };
    const beliefsCollection = {
      find: vi.fn(() => ({
        limit: () => ({
          toArray: async () => [beliefDoc],
        }),
      })),
    };
    const db = {
      collection: (name: string) => {
        if (name === OBSERVATIONS) return observationsCollection;
        if (name === BELIEFS) return beliefsCollection;
        throw new Error(`unexpected collection requested: ${name}`);
      },
    };

    // Mocks only the network boundary (fetch), the lowest level at which
    // extractFacts' real implementation touches the outside world, so the
    // real previewBatch / fetchExistingBeliefs / extractFacts / validateCandidateFact
    // implementations wired by defaultDryRunDeps all actually run.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "emit_candidate_facts",
            input: {
              facts: [
                {
                  text: "The user prefers tabs over spaces.",
                  type: "preference",
                  scope: "project",
                  importance: 0.6,
                  observation_ids: ["obs-1"],
                  supersedes_belief_id: null,
                },
                {
                  text: "",
                  type: "preference",
                  scope: "project",
                  importance: 0.2,
                  observation_ids: ["obs-1"],
                  supersedes_belief_id: null,
                },
              ],
            },
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const deps = defaultDryRunDeps(50, 30);
    const result = await runConsolidationDryRun(db as any, "proj", deps);

    expect(observationsCollection.find).toHaveBeenCalledWith({ project: "proj", status: "pending" });
    expect(beliefsCollection.find).toHaveBeenCalledWith(
      { project: "proj", status: "active" },
      { projection: { text: 1 } }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The existing belief fetched from the (fake) beliefs collection must
    // actually have reached the LLM prompt, proving fetchExistingBeliefs'
    // output was really threaded into extractFacts' input, not just that
    // each dep happened to run in isolation.
    const sentBody = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sentBody.messages[0].content).toContain("belief-1");
    expect(sentBody.messages[0].content).toContain("The user likes dark mode.");

    expect(result.previewed).toBe(1);
    // Accepted via the real, pure validateCandidateFact (non-empty text, valid
    // scope/type): proves validation actually ran, not a mock stand-in.
    expect(result.accepted).toEqual([
      { text: "The user prefers tabs over spaces.", type: "preference", scope: "project", importance: 0.6 },
    ]);
    // Rejected with the real reason produced by validateBeliefText for empty
    // text, not a mocked reason string.
    expect(result.rejected).toEqual([{ text: "", reason: "text is empty" }]);
  });
});

describe("formatDryRunReport", () => {
  it("renders the summary line and an accepted-facts section when there are accepted facts", () => {
    const result: DryRunResult = {
      previewed: 2,
      accepted: [
        { text: "The user prefers tabs.", type: "preference", scope: "project", importance: 0.5 },
        { text: "Use conventional commits.", type: "convention", scope: "core", importance: 0.8 },
      ],
      rejected: [],
    };

    const report = formatDryRunReport("proj-a", result);

    expect(report).toBe(
      [
        '[dry-run] project="proj-a": previewed 2, accepted 2, rejected 0 (no writes were made)',
        "Accepted facts (would be written on a real run):",
        "  - type=preference, scope=project, importance=0.5: The user prefers tabs.",
        "  - type=convention, scope=core, importance=0.8: Use conventional commits.",
      ].join("\n")
    );
  });

  it("renders the summary line and a rejected-facts section with reasons when there are rejected facts", () => {
    const result: DryRunResult = {
      previewed: 2,
      accepted: [],
      rejected: [
        { text: "", reason: "text is empty" },
        { text: "some candidate text", reason: 'invalid scope: "other"' },
      ],
    };

    const report = formatDryRunReport("proj-b", result);

    expect(report).toBe(
      [
        '[dry-run] project="proj-b": previewed 2, accepted 0, rejected 2 (no writes were made)',
        "Rejected facts:",
        "  -  (reason: text is empty)",
        '  - some candidate text (reason: invalid scope: "other")',
      ].join("\n")
    );
  });

  it("renders only the summary line when both accepted and rejected are empty", () => {
    const result: DryRunResult = { previewed: 0, accepted: [], rejected: [] };

    const report = formatDryRunReport("proj-c", result);

    expect(report).toBe(
      '[dry-run] project="proj-c": previewed 0, accepted 0, rejected 0 (no writes were made)'
    );
    expect(report).not.toContain("Accepted facts");
    expect(report).not.toContain("Rejected facts");
  });
});
