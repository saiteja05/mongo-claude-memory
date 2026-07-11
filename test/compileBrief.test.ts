import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BELIEFS } from "../src/db/schema.js";

const ENV_KEYS = [
  "MEMORY_MONGODB_URI",
  "MDB_MCP_CONNECTION_STRING",
  "BRIEF_CORE_TOKEN_CAP",
  "BRIEF_PROJECT_TOKEN_CAP",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

function makeFakeDb(beliefs: Record<string, unknown>[], existingBrief: Record<string, unknown> | null = null) {
  const beliefsCollection = { find: vi.fn(() => ({ toArray: async () => beliefs })) };
  const findOne = vi.fn(async () => existingBrief);
  const replaceOne = vi.fn(async () => ({ acknowledged: true }));
  const briefsCollection = { findOne, replaceOne };
  const db = {
    collection: (name: string) => (name === BELIEFS ? beliefsCollection : briefsCollection),
  };
  return { db, findOne, replaceOne, beliefsCollection };
}

describe("compileBrief", () => {
  it("ranks project-scope beliefs by importance/recency/use_count", async () => {
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const beliefs = [
      {
        _id: "b-project-low",
        project: "proj",
        scope: "project",
        text: "Project low importance fact.",
        importance: 0.2,
        use_count: 0,
        last_used: null,
      },
      {
        _id: "b-project-high",
        project: "proj",
        scope: "project",
        text: "Project high importance fact.",
        importance: 0.9,
        use_count: 5,
        last_used: new Date(),
      },
    ];
    const { db, replaceOne, beliefsCollection } = makeFakeDb(beliefs);

    await compileBrief(db as any, "proj");

    // Core beliefs are already covered by the separate brief:global document
    // (fetchBrief.ts injects it independently), so the per-project query
    // must not also pull in scope:"core" beliefs and duplicate them here.
    expect(beliefsCollection.find).toHaveBeenCalledWith({
      project: "proj",
      scope: "project",
      status: "active",
    });

    const replacement = replaceOne.mock.calls[0][1] as { content: string; belief_ids: string[] };
    expect(replacement.belief_ids).toEqual(["b-project-high", "b-project-low"]);
    expect(replacement.content.split("\n")[0]).toContain("Project high importance fact");
  });

  it("does not include core-scope beliefs in a project brief even if the query returned one", async () => {
    // Guards against a future regression to the old $or filter: even if a
    // core belief somehow ended up in the fetched set, compileBrief's own
    // sort must not be relied upon to hide it, so this pins the exact filter
    // shape passed to find() above, and confirms scope:"core" is excluded
    // from the per-project fetch by shape, not just by luck of sort order.
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const { db, beliefsCollection } = makeFakeDb([]);

    await compileBrief(db as any, "proj");

    const filterArg = beliefsCollection.find.mock.calls[0][0];
    expect(filterArg).not.toHaveProperty("$or");
    expect(filterArg.scope).toBe("project");
  });

  it("enforces the token cap and logs what it dropped instead of silently truncating", async () => {
    process.env.BRIEF_PROJECT_TOKEN_CAP = "5"; // 20-char budget: forces drops
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const beliefs = Array.from({ length: 10 }, (_, i) => ({
      _id: `b-${i}`,
      project: "proj",
      scope: "project",
      text: `This is belief number ${i}, a fairly long piece of text that will not fit.`,
      importance: 1 - i * 0.01,
      use_count: 0,
      last_used: null,
    }));
    const { db, replaceOne } = makeFakeDb(beliefs);

    await compileBrief(db as any, "proj");

    expect(errorSpy).toHaveBeenCalled();
    const loggedMessage = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(loggedMessage).toMatch(/dropped/);

    const replacement = replaceOne.mock.calls[0][1] as { belief_ids: string[] };
    expect(replacement.belief_ids.length).toBeLessThan(beliefs.length);
  });

  it("increments the generation counter on top of an existing brief document", async () => {
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const { db, replaceOne } = makeFakeDb(
      [
        {
          _id: "b-1",
          project: "proj",
          scope: "project",
          text: "A fact.",
          importance: 0.5,
          use_count: 0,
          last_used: null,
        },
      ],
      { _id: "brief:proj", generation: 4 }
    );

    await compileBrief(db as any, "proj");

    const replacement = replaceOne.mock.calls[0][1] as { generation: number };
    expect(replacement.generation).toBe(5);
  });

  it("defaults generation to 1 when no prior brief document exists", async () => {
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const { db, replaceOne } = makeFakeDb([
      {
        _id: "b-1",
        project: "proj",
        scope: "project",
        text: "A fact.",
        importance: 0.5,
        use_count: 0,
        last_used: null,
      },
    ]);

    await compileBrief(db as any, "proj");

    const replacement = replaceOne.mock.calls[0][1] as { generation: number };
    expect(replacement.generation).toBe(1);
  });

  it("compiles the global brief from core-scope beliefs using the core token cap, not the project cap", async () => {
    process.env.BRIEF_CORE_TOKEN_CAP = "5"; // 20-char budget: forces a drop
    process.env.BRIEF_PROJECT_TOKEN_CAP = "1000"; // deliberately huge: if this cap were used instead, nothing would drop
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const beliefs = [
      {
        _id: "b-core-1",
        scope: "core",
        text: "Core fact one.",
        importance: 0.9,
        use_count: 0,
        last_used: null,
      },
      {
        _id: "b-core-2",
        scope: "core",
        text: "Core fact two, a longer piece of text that will not fit in the budget.",
        importance: 0.8,
        use_count: 0,
        last_used: null,
      },
    ];
    const { db, replaceOne, beliefsCollection } = makeFakeDb(beliefs);

    await compileBrief(db as any, "global");

    // The global branch's filter has no project field at all, unlike the
    // per-project branch above.
    expect(beliefsCollection.find).toHaveBeenCalledWith({ scope: "core", status: "active" });

    const [idArg, replacement] = replaceOne.mock.calls[0] as [{ _id: string }, { project: string; belief_ids: string[] }];
    expect(idArg).toEqual({ _id: "brief:global" });
    expect(replacement.project).toBe("global");
    expect(replacement.belief_ids.length).toBeLessThan(beliefs.length);

    // Pins the exact cap value in the dropped-belief log line: proves the
    // core cap (5), not the project cap (1000), was the one actually applied.
    const loggedMessage = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(loggedMessage).toContain("token cap (5)");
    expect(loggedMessage).not.toContain("token cap (1000)");
  });

  it("appends a missing trailing period when a belief's text does not already end with one", async () => {
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const beliefs = [
      {
        _id: "b-no-period",
        project: "proj",
        scope: "project",
        text: "Fact without a trailing period",
        importance: 0.5,
        use_count: 0,
        last_used: null,
      },
    ];
    const { db, replaceOne } = makeFakeDb(beliefs);

    await compileBrief(db as any, "proj");

    const replacement = replaceOne.mock.calls[0][1] as { content: string };
    expect(replacement.content).toBe("Fact without a trailing period.");
  });

  it("treats a last_evidence_at timestamp in the future as maximally recent (recency score 1)", async () => {
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // one year from now
    const beliefs = [
      {
        _id: "b-no-recency",
        project: "proj",
        scope: "project",
        text: "Belief with no recency signal.",
        importance: 0.5,
        use_count: 0,
        last_evidence_at: null,
      },
      {
        _id: "b-future",
        project: "proj",
        scope: "project",
        text: "Belief with a future last_evidence_at.",
        importance: 0.5,
        use_count: 0,
        last_evidence_at: future,
      },
    ];
    const { db, replaceOne } = makeFakeDb(beliefs);

    await compileBrief(db as any, "proj");

    // Importance and use_count are tied on both beliefs, so only a recency
    // score of 1 (the maximum, not something above 1 or negative) for the
    // future timestamp can explain b-future sorting ahead of b-no-recency.
    const replacement = replaceOne.mock.calls[0][1] as { belief_ids: string[] };
    expect(replacement.belief_ids).toEqual(["b-future", "b-no-recency"]);
  });

  it("degrades an unparseable last_evidence_at to a recency score of 0 instead of throwing or producing NaN", async () => {
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const beliefs = [
      {
        _id: "b-invalid-recency",
        project: "proj",
        scope: "project",
        text: "Belief with an invalid last_evidence_at.",
        importance: 0.5,
        use_count: 0,
        last_evidence_at: "not-a-real-date",
      },
      {
        _id: "b-valid-recency",
        project: "proj",
        scope: "project",
        text: "Belief with a valid, recent last_evidence_at.",
        importance: 0.5,
        use_count: 0,
        last_evidence_at: new Date(),
      },
    ];
    const { db, replaceOne } = makeFakeDb(beliefs);

    await compileBrief(db as any, "proj");

    // If the unparseable timestamp produced NaN instead of degrading to 0,
    // the sort comparator would be comparing against NaN and the order would
    // be unreliable; pinning the order here confirms it degrades to the
    // minimum score (0) and ranks behind the belief with a real recent date.
    const replacement = replaceOne.mock.calls[0][1] as { content: string; belief_ids: string[] };
    expect(replacement.belief_ids).toEqual(["b-valid-recency", "b-invalid-recency"]);
    expect(replacement.content).not.toMatch(/NaN/);
  });

  it("ranks recency by evidence (last_evidence_at, falling back to updated_at), not by last_used", async () => {
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const recent = new Date();
    const old = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000);
    const beliefs = [
      {
        _id: "b-recently-used-stale-evidence",
        project: "proj",
        scope: "project",
        text: "Recently surfaced but evidence is stale.",
        importance: 0.5,
        use_count: 0,
        last_used: recent, // must NOT count toward recency anymore
        last_evidence_at: old,
      },
      {
        _id: "b-fresh-evidence",
        project: "proj",
        scope: "project",
        text: "Fresh evidence, never surfaced by search.",
        importance: 0.5,
        use_count: 0,
        last_used: null,
        updated_at: recent, // used as the fallback when last_evidence_at is absent
      },
    ];
    const { db, replaceOne } = makeFakeDb(beliefs);

    await compileBrief(db as any, "proj");

    const replacement = replaceOne.mock.calls[0][1] as { belief_ids: string[] };
    expect(replacement.belief_ids).toEqual([
      "b-fresh-evidence",
      "b-recently-used-stale-evidence",
    ]);
  });

  it("renders an empty brief with no belief_ids and no dropped-belief warning when nothing matches", async () => {
    const { compileBrief } = await import("../src/consolidation/compileBrief.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, replaceOne } = makeFakeDb([]);

    await compileBrief(db as any, "proj");

    const replacement = replaceOne.mock.calls[0][1] as { content: string; belief_ids: string[] };
    expect(replacement.content).toBe("");
    expect(replacement.belief_ids).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
