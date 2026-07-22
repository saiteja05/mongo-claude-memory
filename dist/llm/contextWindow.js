// Same heuristic used by consolidation/compileBrief.ts's local constant of
// the same name: a rough, model-agnostic chars-per-token ratio, good enough
// for a conservative batch-sizing estimate, not an exact tokenizer count.
export const CHARS_PER_TOKEN = 4;
// Fallback context window, in tokens, used whenever the configured model is
// not recognized by getContextWindowTokens below. Deliberately conservative
// (well under every current provider's actual minimum) so an unrecognized
// model name degrades to a smaller-than-necessary batch rather than one that
// risks overflowing the model's real context.
export const DEFAULT_CONTEXT_TOKENS = 32000;
// Leaves headroom for the system prompt, the existing-beliefs context, the
// tool schema, and the model's own output tokens, none of which are counted
// by the char-budget-of-observation-text calculation below. 0.6 is a
// deliberately conservative fraction of the raw context window, not a tuned
// value: better to under-fill a batch than to overflow one.
export const CONTEXT_SAFETY_MARGIN = 0.6;
/**
 * Resolves the configured consolidation model's context window, in tokens.
 * Anthropic's direct API and Bedrock's Anthropic cross-region inference
 * profiles both currently ship a 200k-token context; anything else
 * (including an unrecognized model name) falls back to
 * DEFAULT_CONTEXT_TOKENS. Ollama has no fixed context size of its own: the
 * server is asked for exactly config.ollamaContextTokens (see llm/ollama.ts's
 * num_ctx), so that configured value is authoritative for it rather than a
 * name-matched guess.
 */
export function getContextWindowTokens(config) {
    if (config.llmProvider === "ollama") {
        return config.ollamaContextTokens;
    }
    if (config.llmProvider === "bedrock") {
        // Cross-region inference profile IDs look like
        // "us.anthropic.claude-haiku-4-5-20251001-v1:0"; anthropic.claude.* on
        // Bedrock currently ships the same 200k-token window as the direct API.
        return config.bedrockModel.includes("anthropic.claude")
            ? 200000
            : DEFAULT_CONTEXT_TOKENS;
    }
    // Direct Anthropic API: every current claude- model ships a 200k-token
    // context window.
    return config.anthropicModel.startsWith("claude-")
        ? 200000
        : DEFAULT_CONTEXT_TOKENS;
}
/**
 * Model-aware default for the extraction batch's character budget
 * (config.consolidationBatchMaxChars, CONSOLIDATION_BATCH_MAX_CHARS), used
 * whenever that env var is not explicitly set. Capture volume must never be
 * bounded by model context (see capture/constants.ts), but the extraction
 * BATCH built from captured observations must fit the configured model, so
 * this budget scales with it instead of being one fixed constant regardless
 * of provider.
 */
export function computeBatchMaxCharsDefault(config) {
    const contextTokens = getContextWindowTokens(config);
    return Math.floor(contextTokens * CHARS_PER_TOKEN * CONTEXT_SAFETY_MARGIN);
}
