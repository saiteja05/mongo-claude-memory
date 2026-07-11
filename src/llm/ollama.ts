import { loadConfig } from "../config.js";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;
const MAX_TOKENS = 4096;

interface OllamaToolCall {
  function: {
    name: string;
    arguments: object | string;
  };
}

interface OllamaChatResponse {
  message: {
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done_reason?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

class NonRetryableOllamaError extends Error {}

/**
 * Ollama counterpart to src/llm/anthropic.ts's callWithTool, talking to a
 * local Ollama server's chat API instead of the hosted Anthropic Messages
 * API. Same contract and retry shape (full-jitter backoff, max MAX_ATTEMPTS
 * attempts). Unlike Anthropic/Bedrock, Ollama's chat API has no forced
 * tool_choice equivalent: whether a tool call comes back at all depends on
 * the chosen model's own function-calling behavior, not on anything this
 * client can force. That is a real, honest limitation of the local-model
 * path, not a bug to work around here. There is also no API key for Ollama,
 * so unlike anthropic.ts there is nothing to guard or redact on that front.
 */
export async function callWithTool(
  systemPrompt: string,
  userPrompt: string,
  toolName: string,
  toolSchema: object
): Promise<unknown> {
  const config = loadConfig();

  const body = JSON.stringify({
    model: config.ollamaModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: toolName,
          description: `Emit the structured result as arguments to ${toolName}.`,
          parameters: toolSchema,
        },
      },
    ],
    stream: false,
    options: { num_predict: MAX_TOKENS },
  });

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Hard wall-clock timeout per attempt (same budget as anthropic.ts):
    // without it a hung request would stall the consolidation run indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (!isRetryableStatus(response.status)) {
          throw new NonRetryableOllamaError(
            `Ollama chat request failed with non-retryable status ${response.status}`
          );
        }
        throw new Error(
          `Ollama chat request failed with status ${response.status}`
        );
      }

      const json = (await response.json()) as OllamaChatResponse;

      // A "length" done_reason means the output was cut off mid-JSON
      // (Ollama's equivalent of Anthropic's stop_reason === "max_tokens"):
      // the parsed arguments would be silently incomplete, and marking the
      // batch consolidated from it would lose facts. Fail the run
      // non-retryably (a retry would truncate identically) so the batch
      // stays claimed and reclaimable.
      if (json.done_reason === "length") {
        throw new NonRetryableOllamaError(
          "extraction output truncated; reduce batch size"
        );
      }

      const toolCall = json.message.tool_calls?.find(
        (call) => call.function.name === toolName
      );

      if (!toolCall) {
        throw new NonRetryableOllamaError(
          `Ollama response did not include a tool call for "${toolName}"`
        );
      }

      const { arguments: args } = toolCall.function;
      return typeof args === "string" ? JSON.parse(args) : args;
    } catch (err) {
      lastError = err;
      if (err instanceof NonRetryableOllamaError) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        // Full jitter: randomize within [0.5x, 1.5x) of the exponential delay
        // so concurrent retries after a shared failure do not all retry in
        // lockstep. Also covers a plain fetch/network exception (e.g. the
        // local Ollama server is not running yet): that is neither a
        // NonRetryableOllamaError nor a status code, so it falls through
        // this same generic retry path, exactly like anthropic.ts.
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
        await sleep(delay);
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(`Ollama chat call failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
}
