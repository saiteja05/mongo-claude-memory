import { loadConfig } from "../config.js";
import { NonRetryableLLMError, isNonRetryableLLMError } from "./errors.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;
const MAX_TOKENS = 4096;

interface AnthropicContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[];
  stop_reason?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Generic Anthropic Messages API client, mirroring src/embeddings/voyage.ts's
 * retry shape. Knows nothing about observations or beliefs: it forces a
 * single named tool call via tool_choice and returns the parsed tool_use
 * input (the structured JSON the model produced). Retries with full-jitter
 * backoff (max 3 attempts). Never includes the API key in any thrown error.
 */
export async function callWithTool(
  systemPrompt: string,
  userPrompt: string,
  toolName: string,
  toolSchema: object
): Promise<unknown> {
  const config = loadConfig();
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured; cannot call the LLM.");
  }

  const body = JSON.stringify({
    model: config.anthropicModel,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: [
      {
        name: toolName,
        description: `Emit the structured result as arguments to ${toolName}.`,
        input_schema: toolSchema,
      },
    ],
    tool_choice: { type: "tool", name: toolName },
  });

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Hard wall-clock timeout per attempt: without it a hung request would
    // stall the consolidation run indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (!isRetryableStatus(response.status)) {
          throw new NonRetryableLLMError(
            `Anthropic messages request failed with non-retryable status ${response.status}`
          );
        }
        throw new Error(
          `Anthropic messages request failed with status ${response.status}`
        );
      }

      const json = (await response.json()) as AnthropicMessagesResponse;

      // A max_tokens stop means the tool output was cut off mid-JSON: the
      // parsed input would be silently incomplete, and marking the batch
      // consolidated from it would lose facts. Fail the run non-retryably
      // (a retry would truncate identically) so the batch stays claimed and
      // reclaimable.
      if (json.stop_reason === "max_tokens") {
        throw new NonRetryableLLMError(
          "extraction output truncated by max_tokens; reduce batch size"
        );
      }

      const toolUse = json.content.find(
        (block) => block.type === "tool_use" && block.name === toolName
      );

      if (!toolUse) {
        throw new NonRetryableLLMError(
          `Anthropic response did not include a tool_use block for "${toolName}"`
        );
      }

      return toolUse.input;
    } catch (err) {
      lastError = err;
      if (isNonRetryableLLMError(err)) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        // Full jitter: randomize within [0.5x, 1.5x) of the exponential delay
        // so concurrent retries after a shared 429 do not all retry in lockstep.
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
  const message = `Anthropic messages call failed after ${MAX_ATTEMPTS} attempts: ${reason}`;
  // Classification-preserving: a non-retryable underlying cause (truncated
  // output, missing tool_use, a permanent HTTP status) stays a
  // NonRetryableLLMError through this wrap, so consolidation's split-retry
  // can tell "retrying the same input will never work" apart from a
  // transient failure that exhausted all attempts.
  throw isNonRetryableLLMError(lastError) ? new NonRetryableLLMError(message) : new Error(message);
}
