import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "MDB_MCP_CONNECTION_STRING",
  "MEMORY_MONGODB_URI",
  "VOYAGE_API_KEY",
  "VOYAGE_MODEL",
  "VOYAGE_DIMENSIONS",
  "VOYAGE_BASE_URL",
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

  it("aborts and eventually rejects instead of hanging when the request never settles", async () => {
    vi.useFakeTimers();
    // Simulate a hung Voyage response: the returned promise only ever settles
    // if the caller's AbortSignal fires, exactly like real fetch() behaves
    // when its signal is aborted.
    const fetchMock = vi.fn((_url: string, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted."));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { embed } = await import("../src/embeddings/voyage.js");
    const resultPromise = embed(["hello"], "query");
    resultPromise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("base URL configuration", () => {
  it("embed() and rerank() call fetch against the default api.voyageai.com URLs", async () => {
    const embedFetchMock = vi.fn(async () =>
      fakeResponse(200, { data: [{ embedding: [0.1, 0.2], index: 0 }] })
    );
    vi.stubGlobal("fetch", embedFetchMock);

    const { embed } = await import("../src/embeddings/voyage.js");
    await embed(["hello"], "query");

    expect(embedFetchMock).toHaveBeenCalledWith(
      "https://api.voyageai.com/v1/embeddings",
      expect.anything()
    );

    const rerankFetchMock = vi.fn(async () =>
      fakeResponse(200, { data: [{ index: 0, relevance_score: 0.9 }] })
    );
    vi.stubGlobal("fetch", rerankFetchMock);

    const { rerank } = await import("../src/embeddings/voyage.js");
    await rerank("query", ["doc a"]);

    expect(rerankFetchMock).toHaveBeenCalledWith(
      "https://api.voyageai.com/v1/rerank",
      expect.anything()
    );
  });

  it("embed() and rerank() call fetch against a configured VOYAGE_BASE_URL", async () => {
    process.env.VOYAGE_BASE_URL = "https://ai.mongodb.com";

    const embedFetchMock = vi.fn(async () =>
      fakeResponse(200, { data: [{ embedding: [0.1, 0.2], index: 0 }] })
    );
    vi.stubGlobal("fetch", embedFetchMock);

    const { embed } = await import("../src/embeddings/voyage.js");
    await embed(["hello"], "query");

    expect(embedFetchMock).toHaveBeenCalledWith(
      "https://ai.mongodb.com/v1/embeddings",
      expect.anything()
    );

    const rerankFetchMock = vi.fn(async () =>
      fakeResponse(200, { data: [{ index: 0, relevance_score: 0.9 }] })
    );
    vi.stubGlobal("fetch", rerankFetchMock);

    const { rerank } = await import("../src/embeddings/voyage.js");
    await rerank("query", ["doc a"]);

    expect(rerankFetchMock).toHaveBeenCalledWith(
      "https://ai.mongodb.com/v1/rerank",
      expect.anything()
    );
  });
});

describe("rerank", () => {
  it("aborts and eventually rejects instead of hanging when the request never settles", async () => {
    vi.useFakeTimers();
    // Same hung-response simulation as embed()'s abort test: the promise only
    // settles once the caller's AbortSignal fires.
    const fetchMock = vi.fn((_url: string, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted."));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerank } = await import("../src/embeddings/voyage.js");
    const resultPromise = rerank("query", ["doc a", "doc b"]);
    resultPromise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
