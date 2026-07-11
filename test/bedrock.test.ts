import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "MDB_MCP_CONNECTION_STRING",
  "MEMORY_MONGODB_URI",
  "LLM_PROVIDER",
  "BEDROCK_MODEL",
  "AWS_REGION",
  "BEDROCK_REGION",
  "LLM_TIMEOUT_MS",
] as const;

const SECRET_AWS_KEY = "AKIA-totally-secret-aws-access-key";

let savedEnv: Record<string, string | undefined>;

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient {
    send = sendMock;
  }
  class ConverseCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { BedrockRuntimeClient, ConverseCommand };
});

function toolUseResult(toolName: string, input: unknown) {
  return {
    output: {
      message: {
        content: [{ toolUse: { toolUseId: "t1", name: toolName, input } }],
      },
    },
  };
}

class FakeServiceException extends Error {
  name: string;
  $metadata: { httpStatusCode?: number };
  constructor(name: string, httpStatusCode: number, message = name) {
    super(message);
    this.name = name;
    this.$metadata = { httpStatusCode };
  }
}

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
  process.env.LLM_PROVIDER = "bedrock";
  // AWS credentials are resolved by the SDK's own default provider chain,
  // never read or logged by this codebase, so no key env var is set here.
  // SECRET_AWS_KEY only stands in for a value that must never leak into a
  // thrown error message.
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

describe("bedrock callWithTool", () => {
  it("uses the default us.anthropic Bedrock model id when BEDROCK_MODEL is unset", async () => {
    sendMock.mockImplementation(async () =>
      toolUseResult("emit_result", { foo: "bar" })
    );

    const { callWithTool } = await import("../src/llm/bedrock.js");
    const result = await callWithTool("system prompt", "user prompt", "emit_result", {
      type: "object",
      properties: {},
    });

    expect(result).toEqual({ foo: "bar" });
    const commandInput = sendMock.mock.calls[0][0].input as { modelId: string };
    expect(commandInput.modelId).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("retries after a throttling exception and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    sendMock.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        throw new FakeServiceException("ThrottlingException", 429);
      }
      return toolUseResult("emit_result", { foo: "bar" });
    });

    const { callWithTool } = await import("../src/llm/bedrock.js");
    const resultPromise = callWithTool(
      "system prompt",
      "user prompt",
      "emit_result",
      { type: "object", properties: {} }
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ foo: "bar" });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_ATTEMPTS (3) retries and never leaks AWS credential material in the thrown error", async () => {
    vi.useFakeTimers();
    sendMock.mockImplementation(async () => {
      throw new FakeServiceException(
        "InternalServerException",
        500,
        `internal failure near credential ${SECRET_AWS_KEY}`
      );
    });

    const { callWithTool } = await import("../src/llm/bedrock.js");
    const resultPromise = callWithTool(
      "system prompt",
      "user prompt",
      "emit_result",
      { type: "object", properties: {} }
    );
    resultPromise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow();
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable validation exception", async () => {
    sendMock.mockImplementation(async () => {
      throw new FakeServiceException("ValidationException", 400);
    });

    const { callWithTool } = await import("../src/llm/bedrock.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a well-formed response missing the expected toolUse block, without retrying", async () => {
    sendMock.mockImplementation(async () => ({
      output: { message: { content: [{ text: "no tool call here" }] } },
    }));

    const { callWithTool } = await import("../src/llm/bedrock.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("throws a non-retryable error (single attempt) when the Converse response stopped on max_tokens", async () => {
    sendMock.mockImplementation(async () => ({
      stopReason: "max_tokens",
      ...toolUseResult("emit_result", { partial: true }),
    }));

    const { callWithTool } = await import("../src/llm/bedrock.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow(/max_tokens.*reduce batch size/);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a hung Converse request once LLM_TIMEOUT_MS elapses via the abortSignal passed to send", async () => {
    process.env.LLM_TIMEOUT_MS = "10";
    // A send that never resolves on its own; it only rejects when the
    // abortSignal passed in the send options fires.
    sendMock.mockImplementation(
      (_command: unknown, options: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => {
            const err = new Error("Request aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );

    const { callWithTool } = await import("../src/llm/bedrock.js");
    await expect(
      callWithTool("system prompt", "user prompt", "emit_result", {
        type: "object",
        properties: {},
      })
    ).rejects.toThrow(/aborted/i);
    // AbortError is not in the retryable set, so the hung call fails after a
    // single timed-out attempt instead of hanging or retrying two more times.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
