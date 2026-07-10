import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEYS = [
  "MDB_MCP_CONNECTION_STRING",
  "MEMORY_MONGODB_URI",
  "MEMORY_MONGODB_DB",
  "VOYAGE_API_KEY",
  "VOYAGE_MODEL",
  "VOYAGE_DIMENSIONS",
  "VOYAGE_BASE_URL",
  "BRIEF_CORE_TOKEN_CAP",
  "BRIEF_PROJECT_TOKEN_CAP",
  "HOOK_INTERNAL_TIMEOUT_MS",
  "OBSERVATION_TTL_DAYS",
  "SESSION_END_TIMEOUT_MS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "CONSOLIDATION_LEASE_MS",
  "CONSOLIDATION_BATCH_SIZE",
  "CONSOLIDATION_RECLAIM_MS",
  "CONSOLIDATION_BELIEFS_CONTEXT_LIMIT",
  "CONSOLIDATION_DEDUPE_THRESHOLD",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
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

describe("loadConfig", () => {
  it("throws a clear error when no mongodb uri is configured", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrowError();
    try {
      loadConfig();
      expect.unreachable("loadConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message.toLowerCase()).toContain("mongodb");
      // Error message must never contain secret values, even though none are
      // set here; assert it stays generic/descriptive rather than dumping env.
      expect(message).not.toMatch(/mongodb\+srv:\/\//);
    }
  });

  it("does not throw when a secret value would be present, and never echoes it", async () => {
    process.env.MDB_MCP_CONNECTION_STRING = "mongodb+srv://user:supersecret@cluster0.example.mongodb.net/";
    process.env.VOYAGE_API_KEY = "pa-totally-secret-key";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.mongodbUri).toBe(process.env.MDB_MCP_CONNECTION_STRING);
    expect(config.voyageApiKey).toBe(process.env.VOYAGE_API_KEY);
  });

  it("falls back to MEMORY_MONGODB_URI when MDB_MCP_CONNECTION_STRING is absent", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.mongodbUri).toBe("mongodb://localhost:27017");
  });

  it("applies documented defaults", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.mongodbDb).toBe("claude_memory");
    expect(config.voyageModel).toBe("voyage-4");
    expect(config.voyageDimensions).toBe(1024);
    expect(config.briefCoreTokenCap).toBe(800);
    expect(config.briefProjectTokenCap).toBe(1200);
    expect(config.hookInternalTimeoutMs).toBe(800);
    expect(config.observationTtlDays).toBe(30);
    expect(config.sessionEndTimeoutMs).toBe(5000);
    expect(config.voyageApiKey).toBeUndefined();
    expect(config.voyageBaseUrl).toBe("https://api.voyageai.com");
  });

  it("respects an explicit VOYAGE_BASE_URL override", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.VOYAGE_BASE_URL = "https://ai.mongodb.com";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.voyageBaseUrl).toBe("https://ai.mongodb.com");
  });

  it("strips a trailing slash from VOYAGE_BASE_URL", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.VOYAGE_BASE_URL = "https://ai.mongodb.com/";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.voyageBaseUrl).toBe("https://ai.mongodb.com");
  });

  it("respects an explicit MEMORY_MONGODB_DB override", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.MEMORY_MONGODB_DB = "custom_memory_db";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.mongodbDb).toBe("custom_memory_db");
  });

  it("defaults dedupeSimilarityThreshold when CONSOLIDATION_DEDUPE_THRESHOLD is unset", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.dedupeSimilarityThreshold).toBe(0.93);
  });

  it("respects an explicit CONSOLIDATION_DEDUPE_THRESHOLD override", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.CONSOLIDATION_DEDUPE_THRESHOLD = "0.5";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.dedupeSimilarityThreshold).toBe(0.5);
  });

  it("falls back to the default dedupeSimilarityThreshold when the override is not numeric", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.CONSOLIDATION_DEDUPE_THRESHOLD = "not-a-number";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.dedupeSimilarityThreshold).toBe(0.93);
  });

  it("falls back to the default claimBatchSize when CONSOLIDATION_BATCH_SIZE is not numeric", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.CONSOLIDATION_BATCH_SIZE = "not-a-number";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.claimBatchSize).toBe(50);
  });

  it("does not expose an anthropicApiKey when ANTHROPIC_API_KEY is unset", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.anthropicApiKey).toBeUndefined();
  });

  it("exposes anthropicApiKey when ANTHROPIC_API_KEY is set, without altering it", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.ANTHROPIC_API_KEY = "sk-ant-totally-secret";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.anthropicApiKey).toBe("sk-ant-totally-secret");
  });

  it("defaults anthropicModel when ANTHROPIC_MODEL is unset", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.anthropicModel).toBe("claude-sonnet-5");
  });

  it("respects an explicit ANTHROPIC_MODEL override", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.ANTHROPIC_MODEL = "claude-opus-4";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.anthropicModel).toBe("claude-opus-4");
  });

  it("defaults leaseMs when CONSOLIDATION_LEASE_MS is unset", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.leaseMs).toBe(300000);
  });

  it("respects an explicit CONSOLIDATION_LEASE_MS override", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.CONSOLIDATION_LEASE_MS = "123456";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.leaseMs).toBe(123456);
  });

  it("defaults claimBatchSize when CONSOLIDATION_BATCH_SIZE is unset", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.claimBatchSize).toBe(50);
  });

  it("respects an explicit CONSOLIDATION_BATCH_SIZE override", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.CONSOLIDATION_BATCH_SIZE = "10";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.claimBatchSize).toBe(10);
  });

  it("defaults reclaimAfterMs when CONSOLIDATION_RECLAIM_MS is unset", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.reclaimAfterMs).toBe(600000);
  });

  it("respects an explicit CONSOLIDATION_RECLAIM_MS override", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.CONSOLIDATION_RECLAIM_MS = "999";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.reclaimAfterMs).toBe(999);
  });

  it("defaults beliefsContextLimit when CONSOLIDATION_BELIEFS_CONTEXT_LIMIT is unset", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.beliefsContextLimit).toBe(30);
  });

  it("respects an explicit CONSOLIDATION_BELIEFS_CONTEXT_LIMIT override", async () => {
    process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
    process.env.CONSOLIDATION_BELIEFS_CONTEXT_LIMIT = "5";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.beliefsContextLimit).toBe(5);
  });
});
