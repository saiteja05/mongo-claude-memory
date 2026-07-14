import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// NonRetryableLLMError is imported dynamically inside each test, after
// vi.resetModules() runs in beforeEach: a static top-level import here would
// bind to the module registry's pre-reset instance of src/llm/errors.ts,
// which is a different class object (and so fails instanceof) than the one
// ollama.ts's own dynamic import transitively re-evaluates post-reset.

const ENV_KEYS = [
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "OLLAMA_CONTEXT_TOKENS",
  "LLM_TIMEOUT_MS",
  "MEMORY_MONGODB_URI",
] as const;

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
        message: {
          content: "",
          tool_calls: [
            { function: { name: "emit_result", arguments: { foo: "bar" } } },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
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

  it("gives up after MAX_ATTEMPTS (3) retries and throws", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => fakeResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    const resultPromise = callWithTool(
      "system prompt",
      "user prompt",
      "emit_result",
      { type: "object", properties: {} }
    );
    resultPromise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow(/failed after 3 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    try {
      await resultPromise;
      expect.unreachable("callWithTool should have thrown");
    } catch (err) {
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

    const { callWithTool } = await import("../src/llm/ollama.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toBeInstanceOf(NonRetryableLLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a well-formed 200 response missing tool_calls entirely, without retrying, classified as NonRetryableLLMError", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        message: { content: "no tool call here" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toBeInstanceOf(NonRetryableLLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when tool_calls is present but none match the requested toolName, classified as NonRetryableLLMError", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        message: {
          content: "",
          tool_calls: [
            { function: { name: "some_other_tool", arguments: {} } },
          ],
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toBeInstanceOf(NonRetryableLLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a non-retryable error (single attempt) when done_reason is \"length\", classified as NonRetryableLLMError", async () => {
    // The tool call is present but was truncated mid-output: consuming it
    // would silently lose facts, so the call must fail without retrying
    // (a retry would truncate identically).
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        done_reason: "length",
        message: {
          content: "",
          tool_calls: [
            { function: { name: "emit_result", arguments: { partial: true } } },
          ],
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    const { NonRetryableLLMError } = await import("../src/llm/errors.js");
    const resultPromise = callWithTool("system prompt", "user prompt", "emit_result", {
      type: "object",
      properties: {},
    });
    await expect(resultPromise).rejects.toThrow(/truncated.*reduce batch size/);
    await expect(resultPromise).rejects.toBeInstanceOf(NonRetryableLLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses tool_calls[].function.arguments when it arrives as a JSON string", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        message: {
          content: "",
          tool_calls: [
            {
              function: {
                name: "emit_result",
                arguments: JSON.stringify({ foo: "bar" }),
              },
            },
          ],
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    const result = await callWithTool(
      "system prompt",
      "user prompt",
      "emit_result",
      { type: "object", properties: {} }
    );

    expect(result).toEqual({ foo: "bar" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses tool_calls[].function.arguments when it arrives as an already-parsed object", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        message: {
          content: "",
          tool_calls: [
            { function: { name: "emit_result", arguments: { foo: "bar" } } },
          ],
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    const result = await callWithTool(
      "system prompt",
      "user prompt",
      "emit_result",
      { type: "object", properties: {} }
    );

    expect(result).toEqual({ foo: "bar" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends num_ctx in the request body, defaulting to 8192 when OLLAMA_CONTEXT_TOKENS is unset", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        message: {
          content: "",
          tool_calls: [
            { function: { name: "emit_result", arguments: { foo: "bar" } } },
          ],
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    await callWithTool("system prompt", "user prompt", "emit_result", {
      type: "object",
      properties: {},
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sentBody = JSON.parse(init.body) as { options: { num_ctx: number } };
    expect(sentBody.options.num_ctx).toBe(8192);
  });

  it("sends num_ctx from OLLAMA_CONTEXT_TOKENS when it is overridden, so a small-context model's batch budget and its actual request stay in sync", async () => {
    process.env.OLLAMA_CONTEXT_TOKENS = "16384";
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        message: {
          content: "",
          tool_calls: [
            { function: { name: "emit_result", arguments: { foo: "bar" } } },
          ],
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    await callWithTool("system prompt", "user prompt", "emit_result", {
      type: "object",
      properties: {},
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sentBody = JSON.parse(init.body) as { options: { num_ctx: number } };
    expect(sentBody.options.num_ctx).toBe(16384);
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

    const { callWithTool } = await import("../src/llm/ollama.js");
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
