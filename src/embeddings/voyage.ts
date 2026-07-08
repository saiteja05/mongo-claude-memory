import { loadConfig } from "../config.js";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

interface VoyageEmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

class NonRetryableVoyageError extends Error {}

/**
 * Embeds a batch of texts with Voyage. Retries with exponential backoff on
 * network errors or 429/5xx responses (max 3 attempts, base delay 300ms).
 * Never includes the API key in any thrown error.
 */
export async function embed(
  texts: string[],
  inputType: "query" | "document",
  model?: string
): Promise<number[][]> {
  const config = loadConfig();
  if (!config.voyageApiKey) {
    throw new Error("VOYAGE_API_KEY is not configured; cannot embed text.");
  }

  const body = JSON.stringify({
    input: texts,
    model: model ?? config.voyageModel,
    input_type: inputType,
    output_dimension: config.voyageDimensions,
  });

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.voyageApiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      if (!response.ok) {
        if (!isRetryableStatus(response.status)) {
          // Non-retryable (e.g. 400 bad request): fail immediately, no retry.
          throw new NonRetryableVoyageError(
            `Voyage embeddings request failed with non-retryable status ${response.status}`
          );
        }
        throw new Error(
          `Voyage embeddings request failed with status ${response.status}`
        );
      }

      const json = (await response.json()) as VoyageEmbeddingsResponse;
      return json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    } catch (err) {
      lastError = err;
      if (err instanceof NonRetryableVoyageError) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        // Full jitter: randomize within [0.5x, 1.5x) of the exponential delay so
        // concurrent retries after a shared 429 do not all retry in lockstep.
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(`Voyage embeddings failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
}
