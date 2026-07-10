import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fakeDb = {} as any;

const ENV_KEYS = [
  "MDB_MCP_CONNECTION_STRING",
  "MEMORY_MONGODB_URI",
  "EMBEDDING_MODE",
  "RERANK_MODE",
] as const;

let savedEnv: Record<string, string | undefined>;

function hasStage(pipeline: any[], key: string): boolean {
  return pipeline.some((stage) => Object.prototype.hasOwnProperty.call(stage, key));
}

function stageIndex(pipeline: any[], key: string): number {
  return pipeline.findIndex((stage) => Object.prototype.hasOwnProperty.call(stage, key));
}

const baseDocs = [
  { _id: "b1", text: "the user prefers tabs", scope: "project", type: "preference", importance: 0.6, fusionScore: 1.2 },
  { _id: "b2", text: "the team uses strict mode", scope: "core", type: "convention", importance: 0.8, fusionScore: 1.1 },
];

beforeEach(() => {
  vi.resetModules();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("runMemorySearch", () => {
  it("uses the full $rankFusion pipeline shaped per DESIGN.md 8.2 when embedding succeeds, with fusionScore added before $rerank", async () => {
    const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

    const embed = vi.fn(async () => [[0.1, 0.2, 0.3]]);
    const rerank = vi.fn(async () => []);
    const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
      if (hasStage(pipeline, "$rerank")) {
        return baseDocs.map((d) => ({ ...d, rerankScore: 0.9 }));
      }
      return baseDocs;
    });
    const updateUseCount = vi.fn(async () => undefined);

    const result = await runMemorySearch(
      fakeDb,
      { query: "tabs vs spaces", project: "myrepo-abc", limit: 5 },
      { embed, rerank, aggregate, updateUseCount }
    );

    expect(result.degraded).toBeNull();
    expect(aggregate).toHaveBeenCalledTimes(2);

    const basePipeline = aggregate.mock.calls[0][1];
    expect(basePipeline).toHaveLength(3);
    expect(basePipeline[0].$rankFusion.input.pipelines.vector[0].$vectorSearch).toMatchObject({
      index: "beliefs_vec",
      path: "embedding",
      queryVector: [0.1, 0.2, 0.3],
      numCandidates: 150,
      limit: 50,
    });
    expect(basePipeline[0].$rankFusion.input.pipelines.vector[0].$vectorSearch.filter).toMatchObject({
      project: "myrepo-abc",
      status: "active",
    });
    expect(basePipeline[0].$rankFusion.input.pipelines.text[0].$search).toMatchObject({ index: "beliefs_text" });
    expect(basePipeline[0].$rankFusion.input.pipelines.text[0].$search.compound.must).toEqual([
      { text: { query: "tabs vs spaces", path: "text" } },
    ]);
    expect(basePipeline[0].$rankFusion.combination).toEqual({ weights: { vector: 2, text: 1 } });
    expect(basePipeline[0].$rankFusion.scoreDetails).toBe(true);
    expect(basePipeline[1]).toEqual({ $addFields: { fusionScore: { $meta: "score" } } });
    expect(basePipeline[2]).toEqual({ $limit: 50 });

    // fusionScore ($addFields) must appear before any $rerank stage in the
    // rerank-appended pipeline's ordering.
    const rerankPipeline = aggregate.mock.calls[1][1];
    const addFieldsIdx = stageIndex(rerankPipeline, "$addFields");
    const rerankIdx = stageIndex(rerankPipeline, "$rerank");
    expect(addFieldsIdx).toBeGreaterThanOrEqual(0);
    expect(rerankIdx).toBeGreaterThan(addFieldsIdx);
    expect(rerankPipeline[rerankIdx].$rerank).toMatchObject({
      path: "text",
      model: "rerank-2.5-lite",
      numDocsToRerank: 50,
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ _id: "b1", score: 0.9 });
    expect(updateUseCount).toHaveBeenCalledTimes(1);
  });

  it("falls back to text-only when computeQueryEmbedding returns null (Voyage down)", async () => {
    const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

    const embed = vi.fn(async () => {
      throw new Error("Voyage is down");
    });
    const rerank = vi.fn(async () => []);
    const aggregate = vi.fn(async (_db: any, _pipeline: any[]) => baseDocs);
    const updateUseCount = vi.fn(async () => undefined);

    const result = await runMemorySearch(
      fakeDb,
      { query: "tabs vs spaces", project: "myrepo-abc" },
      { embed, rerank, aggregate, updateUseCount }
    );

    expect(aggregate).toHaveBeenCalledTimes(1);
    const pipeline = aggregate.mock.calls[0][1];
    expect(hasStage(pipeline, "$rankFusion")).toBe(false);
    expect(hasStage(pipeline, "$vectorSearch")).toBe(false);
    expect(pipeline[0].$search).toMatchObject({ index: "beliefs_text" });
    expect(result.degraded).toBe("text-only: vector search unavailable");
    expect(result.results).toHaveLength(2);
  });

  it("falls back to vector-only when the full pipeline's aggregate call rejects with a simulated unknown-stage error", async () => {
    const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

    const embed = vi.fn(async () => [[0.1, 0.2]]);
    const rerank = vi.fn(async () => [
      { index: 0, relevance_score: 0.7 },
      { index: 1, relevance_score: 0.9 },
    ]);
    const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
      if (hasStage(pipeline, "$rankFusion")) {
        throw new Error("PlanExecutor error :: caused by :: Unrecognized pipeline stage name: '$rankFusion'");
      }
      if (hasStage(pipeline, "$rerank")) {
        throw new Error("Unrecognized pipeline stage name: '$rerank'");
      }
      return baseDocs;
    });
    const updateUseCount = vi.fn(async () => undefined);

    const result = await runMemorySearch(
      fakeDb,
      { query: "tabs vs spaces", project: "myrepo-abc" },
      { embed, rerank, aggregate, updateUseCount }
    );

    expect(result.degraded).toBe("vector-only: Atlas Search unavailable");
    const successfulBaseCall = aggregate.mock.calls.find(
      (call) => !hasStage(call[1], "$rankFusion") && !hasStage(call[1], "$rerank")
    );
    expect(successfulBaseCall).toBeDefined();
    expect(hasStage(successfulBaseCall![1], "$vectorSearch")).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it("returns an empty array with a degraded reason, never throwing, when both the full and vector-only arms fail", async () => {
    const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

    const embed = vi.fn(async () => [[0.1, 0.2]]);
    const rerank = vi.fn(async () => []);
    const aggregate = vi.fn(async () => {
      throw new Error("mongot unavailable");
    });
    const updateUseCount = vi.fn(async () => undefined);

    const result = await runMemorySearch(
      fakeDb,
      { query: "tabs vs spaces", project: "myrepo-abc" },
      { embed, rerank, aggregate, updateUseCount }
    );

    expect(result.results).toEqual([]);
    expect(result.degraded).toBeTruthy();
    expect(updateUseCount).not.toHaveBeenCalled();
  });

  it("returns an empty array with a degraded reason when text-only also fails (no vector arm available)", async () => {
    const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

    const embed = vi.fn(async () => {
      throw new Error("Voyage is down");
    });
    const rerank = vi.fn(async () => []);
    const aggregate = vi.fn(async () => {
      throw new Error("Atlas Search unavailable too");
    });
    const updateUseCount = vi.fn(async () => undefined);

    const result = await runMemorySearch(
      fakeDb,
      { query: "tabs vs spaces", project: "myrepo-abc" },
      { embed, rerank, aggregate, updateUseCount }
    );

    expect(result.results).toEqual([]);
    expect(result.degraded).toBeTruthy();
  });

  it("caches native $rerank unavailability after the first rejection and uses the Voyage rerank fallback on the next call without retrying $rerank", async () => {
    const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

    const embed = vi.fn(async () => [[0.1, 0.2]]);
    const rerank = vi.fn(async () => [
      { index: 1, relevance_score: 0.99 },
      { index: 0, relevance_score: 0.5 },
    ]);
    const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
      if (hasStage(pipeline, "$rerank")) {
        throw new Error("Unrecognized pipeline stage name: '$rerank' (feature not enabled)");
      }
      return baseDocs;
    });
    const updateUseCount = vi.fn(async () => undefined);
    const deps = { embed, rerank, aggregate, updateUseCount };

    const first = await runMemorySearch(fakeDb, { query: "q1", project: "myrepo-abc" }, deps);
    // Call 1: base pipeline succeeds (1 call), $rerank-appended pipeline is attempted and rejects (1 call).
    expect(aggregate).toHaveBeenCalledTimes(2);
    expect(rerank).toHaveBeenCalledTimes(1);
    expect(first.results[0]._id).toBe("b2"); // reordered by the injected Voyage rerank fallback

    aggregate.mockClear();
    rerank.mockClear();

    const second = await runMemorySearch(fakeDb, { query: "q2", project: "myrepo-abc" }, deps);
    // Call 2: rerankAvailable is cached false, so only the base pipeline runs;
    // $rerank is never attempted again, and the Voyage fallback is used directly.
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(hasStage(aggregate.mock.calls[0][1], "$rerank")).toBe(false);
    expect(rerank).toHaveBeenCalledTimes(1);
    expect(second.results[0]._id).toBe("b2");
  });

  it("attempts the use_count/last_used side effect after a successful search, and its failure does not throw out of runMemorySearch", async () => {
    const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

    const embed = vi.fn(async () => [[0.1, 0.2]]);
    const rerank = vi.fn(async () => []);
    const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
      if (hasStage(pipeline, "$rerank")) return baseDocs.map((d) => ({ ...d, rerankScore: 1 }));
      return baseDocs;
    });
    const updateUseCount = vi.fn(async () => {
      throw new Error("update failed");
    });

    await expect(
      runMemorySearch(fakeDb, { query: "q", project: "myrepo-abc" }, { embed, rerank, aggregate, updateUseCount })
    ).resolves.toBeDefined();

    expect(updateUseCount).toHaveBeenCalledTimes(1);
    expect(updateUseCount.mock.calls[0][1]).toEqual(["b1", "b2"]);
  });

  describe("embeddingMode auto", () => {
    it("skips computeQueryEmbedding entirely and builds query:{text} pipelines against beliefs_vec_auto", async () => {
      process.env.EMBEDDING_MODE = "auto";
      const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

      const embed = vi.fn(async () => [[0.1, 0.2, 0.3]]);
      const rerank = vi.fn(async () => []);
      const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
        if (hasStage(pipeline, "$rerank")) return baseDocs.map((d) => ({ ...d, rerankScore: 0.9 }));
        return baseDocs;
      });
      const updateUseCount = vi.fn(async () => undefined);

      const result = await runMemorySearch(
        fakeDb,
        { query: "tabs vs spaces", project: "myrepo-abc" },
        { embed, rerank, aggregate, updateUseCount }
      );

      expect(embed).not.toHaveBeenCalled();
      const basePipeline = aggregate.mock.calls[0][1];
      const vectorArm = basePipeline[0].$rankFusion.input.pipelines.vector[0].$vectorSearch;
      expect(vectorArm).toMatchObject({
        index: "beliefs_vec_auto",
        path: "text",
        query: { text: "tabs vs spaces" },
        model: "voyage-4",
      });
      expect(vectorArm.queryVector).toBeUndefined();
      expect(result.degraded).toBeNull();
      expect(result.results).toHaveLength(2);
    });

    it("uses query:{text} in the vector-only autoEmbed fallback when the full pipeline fails", async () => {
      process.env.EMBEDDING_MODE = "auto";
      const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

      const embed = vi.fn(async () => [[0.1, 0.2, 0.3]]);
      const rerank = vi.fn(async () => []);
      const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
        if (hasStage(pipeline, "$rankFusion")) {
          throw new Error("Unrecognized pipeline stage name: '$rankFusion'");
        }
        if (hasStage(pipeline, "$rerank")) {
          throw new Error("Unrecognized pipeline stage name: '$rerank'");
        }
        return baseDocs;
      });
      const updateUseCount = vi.fn(async () => undefined);

      const result = await runMemorySearch(
        fakeDb,
        { query: "tabs vs spaces", project: "myrepo-abc" },
        { embed, rerank, aggregate, updateUseCount }
      );

      expect(embed).not.toHaveBeenCalled();
      expect(result.degraded).toBe("vector-only: Atlas Search unavailable");
      const successfulBaseCall = aggregate.mock.calls.find(
        (call) => !hasStage(call[1], "$rankFusion") && !hasStage(call[1], "$rerank")
      );
      expect(successfulBaseCall).toBeDefined();
      expect(successfulBaseCall![1][0].$vectorSearch).toMatchObject({
        index: "beliefs_vec_auto",
        path: "text",
        query: { text: "tabs vs spaces" },
      });
    });

    it("falls back to text-only when both autoEmbed pipelines fail, never calling embed", async () => {
      process.env.EMBEDDING_MODE = "auto";
      const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

      const embed = vi.fn(async () => [[0.1, 0.2]]);
      const rerank = vi.fn(async () => []);
      const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
        if (hasStage(pipeline, "$rankFusion")) throw new Error("no rankFusion");
        if (hasStage(pipeline, "$vectorSearch")) throw new Error("no vectorSearch");
        return baseDocs;
      });
      const updateUseCount = vi.fn(async () => undefined);

      const result = await runMemorySearch(
        fakeDb,
        { query: "tabs vs spaces", project: "myrepo-abc" },
        { embed, rerank, aggregate, updateUseCount }
      );

      expect(embed).not.toHaveBeenCalled();
      expect(result.degraded).toBe("text-only: vector search unavailable");
      expect(result.results).toHaveLength(2);
    });
  });

  describe("rerankMode", () => {
    it("native: never falls back to the Voyage rerank API when native $rerank fails", async () => {
      process.env.RERANK_MODE = "native";
      const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

      const embed = vi.fn(async () => [[0.1, 0.2]]);
      const rerank = vi.fn(async () => []);
      const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
        if (hasStage(pipeline, "$rerank")) throw new Error("native rerank unavailable");
        return baseDocs;
      });
      const updateUseCount = vi.fn(async () => undefined);

      const result = await runMemorySearch(
        fakeDb,
        { query: "q", project: "myrepo-abc" },
        { embed, rerank, aggregate, updateUseCount }
      );

      expect(rerank).not.toHaveBeenCalled();
      expect(result.degraded).toBeTruthy();
      expect(result.results).toHaveLength(2);
    });

    it("native: uses the native $rerank result when it succeeds", async () => {
      process.env.RERANK_MODE = "native";
      const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

      const embed = vi.fn(async () => [[0.1, 0.2]]);
      const rerank = vi.fn(async () => []);
      const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
        if (hasStage(pipeline, "$rerank")) return baseDocs.map((d) => ({ ...d, rerankScore: 0.9 }));
        return baseDocs;
      });
      const updateUseCount = vi.fn(async () => undefined);

      const result = await runMemorySearch(
        fakeDb,
        { query: "q", project: "myrepo-abc" },
        { embed, rerank, aggregate, updateUseCount }
      );

      expect(rerank).not.toHaveBeenCalled();
      expect(result.degraded).toBeNull();
      expect(result.results[0].score).toBe(0.9);
    });

    it("appside: never issues a $rerank stage, always goes straight to the Voyage rerank API", async () => {
      process.env.RERANK_MODE = "appside";
      const { runMemorySearch } = await import("../src/mcp/memorySearch.js");

      const embed = vi.fn(async () => [[0.1, 0.2]]);
      const rerank = vi.fn(async () => [
        { index: 1, relevance_score: 0.99 },
        { index: 0, relevance_score: 0.5 },
      ]);
      const aggregate = vi.fn(async (_db: any, pipeline: any[]) => {
        // If a $rerank stage were ever issued, this test should fail loudly
        // rather than silently succeeding on a mocked response.
        if (hasStage(pipeline, "$rerank")) {
          throw new Error("appside mode must never issue a $rerank stage");
        }
        return baseDocs;
      });
      const updateUseCount = vi.fn(async () => undefined);

      const result = await runMemorySearch(
        fakeDb,
        { query: "q", project: "myrepo-abc" },
        { embed, rerank, aggregate, updateUseCount }
      );

      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(rerank).toHaveBeenCalledTimes(1);
      expect(result.results[0]._id).toBe("b2");
    });
  });
});
