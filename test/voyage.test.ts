import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "MDB_MCP_CONNECTION_STRING",
  "MEMORY_MONGODB_URI",
  "VOYAGE_API_KEY",
  "VOYAGE_MODEL",
  "VOYAGE_DIMENSIONS",
] as const;

const SECRET_API_KEY = "pa-totally-secret-voyage-key";

let savedEnv: Record<string, string | undefined>;

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.resetModules();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
  process.env.VOYAGE_API_KEY = SECRET_API_KEY;
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
  vi.useRealTimers();
});

describe("embed", () => {
  it("retries after a 429 and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return fakeResponse(429, {});
      return fakeResponse(200, { data: [{ embedding: [0.1, 0.2], index: 0 }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { embed } = await import("../src/embeddings/voyage.js");
    const resultPromise = embed(["hello"], "query");
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual([[0.1, 0.2]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_ATTEMPTS (3) retries and never leaks the API key in the thrown error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => fakeResponse(429, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { embed } = await import("../src/embeddings/voyage.js");
    const resultPromise = embed(["hello"], "query");
    // Prevent an unhandled-rejection warning before we assert below.
    resultPromise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    try {
      await resultPromise;
      expect.unreachable("embed should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(SECRET_API_KEY);
    }
  });

  it("does not retry a non-retryable 400 response", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(400, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { embed } = await import("../src/embeddings/voyage.js");
    await expect(embed(["hello"], "query")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
