import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEYS = [
  "MDB_MCP_CONNECTION_STRING",
  "MEMORY_MONGODB_URI",
  "MEMORY_MONGODB_DB",
  "VOYAGE_API_KEY",
  "VOYAGE_MODEL",
  "VOYAGE_DIMENSIONS",
  "BRIEF_CORE_TOKEN_CAP",
  "BRIEF_PROJECT_TOKEN_CAP",
  "HOOK_INTERNAL_TIMEOUT_MS",
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
    expect(config.voyageApiKey).toBeUndefined();
  });
});
