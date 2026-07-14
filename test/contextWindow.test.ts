import { describe, it, expect } from "vitest";
import {
  getContextWindowTokens,
  computeBatchMaxCharsDefault,
  DEFAULT_CONTEXT_TOKENS,
  CHARS_PER_TOKEN,
  CONTEXT_SAFETY_MARGIN,
} from "../src/llm/contextWindow.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    mongodbUri: "mongodb://fake",
    mongodbDb: "claude_memory",
    voyageApiKey: undefined,
    voyageModel: "voyage-4",
    voyageDimensions: 1024,
    voyageBaseUrl: "https://api.voyageai.com",
    briefCoreTokenCap: 800,
    briefProjectTokenCap: 1200,
    briefCacheMaxAgeDays: 7,
    hookInternalTimeoutMs: 800,
    sessionStartTimeoutMs: 3000,
    hookWriteTimeoutMs: 5000,
    observationTtlDays: 30,
    droppedCandidateTtlDays: 30,
    sessionEndTimeoutMs: 5000,
    transcriptCaptureMaxChars: 500000,
    anthropicApiKey: "anthropic-key",
    anthropicModel: "claude-sonnet-5",
    llmProvider: "anthropic",
    llmTimeoutMs: 60000,
    bedrockModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    bedrockRegion: "us-east-1",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "llama3.1",
    ollamaContextTokens: 8192,
    leaseMs: 300000,
    claimBatchSize: 50,
    consolidationBatchMaxChars: undefined,
    reclaimAfterMs: 600000,
    beliefsContextLimit: 30,
    dedupeSimilarityThreshold: 0.93,
    reconcileSimilarityThreshold: 0.75,
    reconcileMaxPairs: 25,
    embeddingMode: "appside",
    rerankMode: "auto",
    ...overrides,
  };
}

describe("constants", () => {
  it("match the documented defaults", () => {
    expect(DEFAULT_CONTEXT_TOKENS).toBe(32000);
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(CONTEXT_SAFETY_MARGIN).toBe(0.6);
  });
});

describe("getContextWindowTokens", () => {
  it("returns 200000 for the direct Anthropic API with a claude- prefixed model", () => {
    const config = makeConfig({ llmProvider: "anthropic", anthropicModel: "claude-sonnet-5" });
    expect(getContextWindowTokens(config)).toBe(200000);
  });

  it("falls back to DEFAULT_CONTEXT_TOKENS for the direct Anthropic API with an unrecognized model name", () => {
    const config = makeConfig({ llmProvider: "anthropic", anthropicModel: "some-other-model" });
    expect(getContextWindowTokens(config)).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("returns 200000 for a Bedrock cross-region inference profile whose id includes anthropic.claude", () => {
    const config = makeConfig({
      llmProvider: "bedrock",
      bedrockModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(getContextWindowTokens(config)).toBe(200000);
  });

  it("falls back to DEFAULT_CONTEXT_TOKENS for a Bedrock model id that is not an anthropic.claude profile", () => {
    const config = makeConfig({ llmProvider: "bedrock", bedrockModel: "amazon.titan-text-express-v1" });
    expect(getContextWindowTokens(config)).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("returns config.ollamaContextTokens exactly for the ollama provider (the default 8192)", () => {
    const config = makeConfig({ llmProvider: "ollama", ollamaContextTokens: 8192 });
    expect(getContextWindowTokens(config)).toBe(8192);
  });

  it("returns config.ollamaContextTokens exactly for the ollama provider (a custom value)", () => {
    const config = makeConfig({ llmProvider: "ollama", ollamaContextTokens: 16384 });
    expect(getContextWindowTokens(config)).toBe(16384);
  });
});

describe("computeBatchMaxCharsDefault", () => {
  it("computes 480000 for a 200000-token context (Anthropic/Bedrock claude)", () => {
    const config = makeConfig({ llmProvider: "anthropic", anthropicModel: "claude-sonnet-5" });
    // 200000 tokens * 4 chars/token * 0.6 safety margin.
    expect(computeBatchMaxCharsDefault(config)).toBe(480000);
  });

  it("computes 76800 for the DEFAULT_CONTEXT_TOKENS fallback (unrecognized model)", () => {
    const config = makeConfig({ llmProvider: "anthropic", anthropicModel: "some-other-model" });
    // 32000 tokens * 4 chars/token * 0.6 safety margin.
    expect(computeBatchMaxCharsDefault(config)).toBe(76800);
  });

  it("computes 19660 for the default Ollama context (8192 tokens)", () => {
    const config = makeConfig({ llmProvider: "ollama", ollamaContextTokens: 8192 });
    // floor(8192 * 4 * 0.6) = floor(19660.8) = 19660.
    expect(computeBatchMaxCharsDefault(config)).toBe(19660);
  });

  it("computes 39321 for a custom Ollama context (16384 tokens), flooring rather than rounding", () => {
    const config = makeConfig({ llmProvider: "ollama", ollamaContextTokens: 16384 });
    // floor(16384 * 4 * 0.6) = floor(39321.6) = 39321.
    expect(computeBatchMaxCharsDefault(config)).toBe(39321);
  });
});
