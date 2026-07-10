import { loadConfig } from "../config.js";

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

class NonRetryableAnthropicError extends Error {}

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
    try {
      const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body,
      });

      if (!response.ok) {
        if (!isRetryableStatus(response.status)) {
          throw new NonRetryableAnthropicError(
            `Anthropic messages request failed with non-retryable status ${response.status}`
          );
        }
        throw new Error(
          `Anthropic messages request failed with status ${response.status}`
        );
      }

      const json = (await response.json()) as AnthropicMessagesResponse;
      const toolUse = json.content.find(
        (block) => block.type === "tool_use" && block.name === toolName
      );

      if (!toolUse) {
        throw new NonRetryableAnthropicError(
          `Anthropic response did not include a tool_use block for "${toolName}"`
        );
      }

      return toolUse.input;
    } catch (err) {
      lastError = err;
      if (err instanceof NonRetryableAnthropicError) {
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
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(`Anthropic messages call failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
}
