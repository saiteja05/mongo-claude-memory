import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "MDB_MCP_CONNECTION_STRING",
  "MEMORY_MONGODB_URI",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
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
    }
  });

  it("does not retry a non-retryable 400 response", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(400, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a well-formed 200 response missing the expected tool_use block, without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, {
        content: [{ type: "text", text: "no tool call here" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { callWithTool } = await import("../src/llm/anthropic.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow();
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
});
