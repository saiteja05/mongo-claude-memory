import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
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
  });

  it("does not retry a non-retryable 400 response", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(400, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a well-formed 200 response missing tool_calls entirely, without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        message: { content: "no tool call here" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/ollama.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when tool_calls is present but none match the requested toolName", async () => {
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
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a non-retryable error (single attempt) when done_reason is \"length\"", async () => {
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
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow(/truncated.*reduce batch size/);
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
