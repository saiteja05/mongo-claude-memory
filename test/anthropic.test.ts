import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// NonRetryableLLMError is imported dynamically inside each test, after
// vi.resetModules() runs in beforeEach: a static top-level import here would
// bind to the module registry's pre-reset instance of src/llm/errors.ts,
// which is a different class object (and so fails instanceof) than the one
// anthropic.ts's own dynamic import transitively re-evaluates post-reset.

const ENV_KEYS = [
  "MDB_MCP_CONNECTION_STRING",
  "MEMORY_MONGODB_URI",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "LLM_TIMEOUT_MS",
] as const;

const SECRET_API_KEY = "sk-ant-totally-secret-anthropic-key";

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
  process.env.ANTHROPIC_API_KEY = SECRET_API_KEY;
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

describe("callWithTool", () => {
  it("retries after a 429 and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return fakeResponse(429, {});
      return fakeResponse(200, {
        content: [
          { type: "tool_use", id: "toolu_1", name: "emit_result", input: { foo: "bar" } },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    const resultPromise = callWithTool(
      "system prompt",
      "user prompt",
      "emit_result",
      { type: "object", properties: {} }
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ foo: "bar" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_ATTEMPTS (3) retries and never leaks the API key in the thrown error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => fakeResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    const resultPromise = callWithTool(
      "system prompt",
      "user prompt",
      "emit_result",
      { type: "object", properties: {} }
    );
    resultPromise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    try {
      await resultPromise;
      expect.unreachable("callWithTool should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(SECRET_API_KEY);
      // Exhausting retries on a transient failure (a 500 every attempt) must
      // stay a plain Error, not NonRetryableLLMError: consolidation's
      // split-retry only splits a batch on a non-retryable classification,
      // and splitting does nothing useful for a transient failure.
      expect(err).not.toBeInstanceOf(NonRetryableLLMError);
    }
  });

  it("does not retry a non-retryable 400 response, and classifies the final error as NonRetryableLLMError", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(400, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toBeInstanceOf(NonRetryableLLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a well-formed 200 response missing the expected tool_use block, without retrying, classified as NonRetryableLLMError", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        content: [{ type: "text", text: "no tool call here" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toBeInstanceOf(NonRetryableLLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects immediately with zero HTTP calls when the API key is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchMock = vi.fn(async () => fakeResponse(200, { content: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("throws a non-retryable error (single attempt) when the response stopped on max_tokens, classified as NonRetryableLLMError", async () => {
    // The tool_use block is present but was truncated mid-output: consuming
    // it would silently lose facts, so the call must fail without retrying
    // (a retry would truncate identically).
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        stop_reason: "max_tokens",
        content: [
          { type: "tool_use", id: "toolu_1", name: "emit_result", input: { partial: true } },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    const resultPromise = callWithTool("system prompt", "user prompt", "emit_result", {
      type: "object",
      properties: {},
    });
    await expect(resultPromise).rejects.toThrow(/max_tokens.*reduce batch size/);
    await expect(resultPromise).rejects.toBeInstanceOf(NonRetryableLLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a hung request once LLM_TIMEOUT_MS elapses instead of waiting forever", async () => {
    process.env.LLM_TIMEOUT_MS = "150";
    // A fetch that never resolves on its own; it only rejects when the
    // caller's AbortController fires.
    const fetchMock = vi.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError"))
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow(/failed after 3 attempts/);
    // The abort is treated as retryable, so all attempts ran and each one was
    // cut off by the timeout rather than hanging.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
