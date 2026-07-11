import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { loadConfig } from "../config.js";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirrors src/llm/anthropic.ts's isRetryableStatus: treats throttling and
 * transient service-side failures as retryable, everything else (bad input,
 * access denied, not found) as non-retryable.
 */
function isRetryableError(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  const name = (err as { name?: string })?.name;
  return (
    name === "ThrottlingException" ||
    name === "ServiceUnavailableException" ||
    name === "InternalServerException" ||
    name === "ModelTimeoutException"
  );
}

class NonRetryableBedrockError extends Error {}

let cachedClient: BedrockRuntimeClient | undefined;

function getClient(region: string): BedrockRuntimeClient {
  if (!cachedClient) {
    cachedClient = new BedrockRuntimeClient({ region });
  }
  return cachedClient;
}

/**
 * Bedrock counterpart to src/llm/anthropic.ts's callWithTool. Same contract
 * (forces a single named tool call, returns the parsed tool input, retries
 * with full-jitter backoff for up to MAX_ATTEMPTS), but talks to Amazon
 * Bedrock's Converse API instead of the direct Anthropic Messages API.
 * Credentials are resolved through the AWS SDK's default provider chain, so
 * no raw AWS secret ever passes through this module or its error messages.
 */
export async function callWithTool(
  systemPrompt: string,
  userPrompt: string,
  toolName: string,
  toolSchema: object
): Promise<unknown> {
  const config = loadConfig();
  const client = getClient(config.bedrockRegion);

  const command = new ConverseCommand({
    modelId: config.bedrockModel,
    system: [{ text: systemPrompt }],
    messages: [{ role: "user", content: [{ text: userPrompt }] }],
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: toolName,
            description: `Emit the structured result as arguments to ${toolName}.`,
            // toolSchema is a plain JSON Schema object; the SDK's DocumentType
            // (from @smithy/types) is a recursive union that any JSON value
            // structurally satisfies, but TypeScript cannot prove that from a
            // generic `object`, hence the explicit escape hatch here.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            inputSchema: { json: toolSchema as any },
          },
        },
      ],
      toolChoice: { tool: { name: toolName } },
    },
  });

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Hard wall-clock timeout per attempt (same budget as anthropic.ts):
    // without it a hung Converse request would stall the run indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
    timer.unref?.();

    try {
      const response = await client.send(command, { abortSignal: controller.signal });

      // A max_tokens stop means the tool output was cut off mid-JSON: the
      // parsed input would be silently incomplete, and marking the batch
      // consolidated from it would lose facts. Fail the run non-retryably
      // (a retry would truncate identically) so the batch stays claimed and
      // reclaimable.
      if (response.stopReason === "max_tokens") {
        throw new NonRetryableBedrockError(
          "extraction output truncated by max_tokens; reduce batch size"
        );
      }

      const blocks: ContentBlock[] = response.output?.message?.content ?? [];
      const toolUse = blocks.find(
        (block) => block.toolUse !== undefined && block.toolUse.name === toolName
      );

      if (!toolUse || !toolUse.toolUse) {
        throw new NonRetryableBedrockError(
          `Bedrock response did not include a toolUse block for "${toolName}"`
        );
      }

      return toolUse.toolUse.input;
    } catch (err) {
      lastError = err;
      if (err instanceof NonRetryableBedrockError || !isRetryableError(err)) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        // Full jitter, matching src/llm/anthropic.ts's backoff shape.
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
  throw new Error(`Bedrock converse call failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
}

// Exposed for tests only, to reset the cached client between mocked runs.
export function __resetClientForTests(): void {
  cachedClient = undefined;
}
