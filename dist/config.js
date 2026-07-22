// Configuration loader. Never logs actual secret values, only presence/absence.
function envInt(name, fallback, opts) {
    const raw = process.env[name];
    if (raw === undefined || raw === "")
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed))
        return fallback;
    if (opts?.min !== undefined && parsed < opts.min)
        return fallback;
    return parsed;
}
// Unlike envInt, an unset or non-numeric value here yields undefined rather
// than a fixed fallback: callers that need model-aware behavior when this is
// left unset (consolidationBatchMaxChars) tell "unset" apart from "explicitly
// set to some number" this way. An explicit value is still returned as-is
// with no min bound, matching this field's pre-existing lack of one.
function envIntOptional(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === "")
        return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function envFloat(name, fallback, opts) {
    const raw = process.env[name];
    if (raw === undefined || raw === "")
        return fallback;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed))
        return fallback;
    if (opts?.min !== undefined && parsed < opts.min)
        return fallback;
    if (opts?.max !== undefined && parsed > opts.max)
        return fallback;
    return parsed;
}
/**
 * Loads configuration from environment variables. Throws a clear, secret-free
 * error if MONGODB_URI cannot be resolved, since nothing can function without it.
 * VOYAGE_API_KEY is intentionally allowed to be absent here; callers that need
 * it (embedding/read paths) must handle its absence gracefully (fail open).
 */
export function loadConfig() {
    const mongodbUri = process.env.MDB_MCP_CONNECTION_STRING || process.env.MEMORY_MONGODB_URI;
    if (!mongodbUri) {
        throw new Error("MongoDB connection string is not configured. Set MDB_MCP_CONNECTION_STRING " +
            "(shared with the mongodb MCP plugin) or MEMORY_MONGODB_URI.");
    }
    return {
        mongodbUri,
        mongodbDb: process.env.MEMORY_MONGODB_DB || "claude_memory",
        voyageApiKey: process.env.VOYAGE_API_KEY,
        voyageModel: process.env.VOYAGE_MODEL || "voyage-4",
        voyageDimensions: envInt("VOYAGE_DIMENSIONS", 1024),
        voyageBaseUrl: (process.env.VOYAGE_BASE_URL || "https://api.voyageai.com").replace(/\/$/, ""),
        briefCoreTokenCap: envInt("BRIEF_CORE_TOKEN_CAP", 800),
        briefProjectTokenCap: envInt("BRIEF_PROJECT_TOKEN_CAP", 1200),
        // Max age, in days, of the local brief cache served when Atlas is
        // unreachable; 0 disables cache reads.
        briefCacheMaxAgeDays: envInt("BRIEF_CACHE_MAX_AGE_DAYS", 7, { min: 0 }),
        hookInternalTimeoutMs: envInt("HOOK_INTERNAL_TIMEOUT_MS", 800, { min: 100 }),
        // SessionStart's brief fetch gets its own budget: a cold Atlas connect
        // alone can exceed the 800ms general default. Precedence:
        // SESSION_START_TIMEOUT_MS if set, else HOOK_INTERNAL_TIMEOUT_MS if set
        // (users who explicitly tuned it keep their value), else 3000.
        sessionStartTimeoutMs: envInt("SESSION_START_TIMEOUT_MS", envInt("HOOK_INTERNAL_TIMEOUT_MS", 3000, { min: 100 }), { min: 100 }),
        // Budget for the UserPromptSubmit hash-line capture write. This path only
        // runs when the user explicitly asked to remember something, so a rare
        // extra couple of seconds is an acceptable price for not losing the data.
        hookWriteTimeoutMs: envInt("HOOK_WRITE_TIMEOUT_MS", 5000, { min: 100 }),
        observationTtlDays: envInt("OBSERVATION_TTL_DAYS", 30, { min: 1 }),
        // Retention, in days, for quarantined dropped candidate facts.
        droppedCandidateTtlDays: envInt("DROPPED_CANDIDATE_TTL_DAYS", 30, { min: 1 }),
        sessionEndTimeoutMs: envInt("SESSION_END_TIMEOUT_MS", 5000, { min: 100 }),
        // Total SessionEnd transcript capture budget in chars; chunked into 50k
        // observations, first chunk plus most recent kept.
        transcriptCaptureMaxChars: envInt("TRANSCRIPT_CAPTURE_MAX_CHARS", 500000, {
            min: 50000,
        }),
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        llmProvider: process.env.LLM_PROVIDER === "bedrock"
            ? "bedrock"
            : process.env.LLM_PROVIDER === "ollama"
                ? "ollama"
                : "anthropic",
        // Hard wall-clock cap on a single LLM call (fact extraction). Without it,
        // a hung request could stall a consolidation run indefinitely.
        llmTimeoutMs: envInt("LLM_TIMEOUT_MS", 60000, { min: 100 }),
        bedrockModel: process.env.BEDROCK_MODEL || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        bedrockRegion: process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-east-1",
        ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, ""),
        ollamaModel: process.env.OLLAMA_MODEL || "llama3.1",
        // Ollama's own request-time context size (llm/ollama.ts's num_ctx); also
        // read by llm/contextWindow.ts to size the extraction batch for it.
        ollamaContextTokens: envInt("OLLAMA_CONTEXT_TOKENS", 8192, { min: 1024 }),
        leaseMs: envInt("CONSOLIDATION_LEASE_MS", 300000, { min: 1000 }),
        claimBatchSize: envInt("CONSOLIDATION_BATCH_SIZE", 50, { min: 1 }),
        // Character budget for one extraction batch. CONSOLIDATION_BATCH_SIZE
        // counts observations; transcript observations can be 50k chars each, so
        // a count-only bound could build a prompt past the model's context
        // limit. Left undefined when unset, so consolidation/cli.ts's
        // resolveBatchMaxChars can fall back to a model-aware default
        // (llm/contextWindow.ts) instead of one fixed number regardless of
        // provider.
        consolidationBatchMaxChars: envIntOptional("CONSOLIDATION_BATCH_MAX_CHARS"),
        reclaimAfterMs: envInt("CONSOLIDATION_RECLAIM_MS", 600000, { min: 1000 }),
        beliefsContextLimit: envInt("CONSOLIDATION_BELIEFS_CONTEXT_LIMIT", 30),
        dedupeSimilarityThreshold: envFloat("CONSOLIDATION_DEDUPE_THRESHOLD", 0.93, {
            min: 0,
            max: 1,
        }),
        // Similarity floor for the write-time reconciliation probe; 1 disables
        // reconciliation entirely.
        reconcileSimilarityThreshold: envFloat("CONSOLIDATION_RECONCILE_THRESHOLD", 0.75, {
            min: 0,
            max: 1,
        }),
        // Cap on LLM arbitration calls per --reconcile sweep.
        reconcileMaxPairs: envInt("CONSOLIDATION_RECONCILE_MAX_PAIRS", 25, { min: 1 }),
        // Circuit breaker: when this many single-observation extractions fail
        // non-retryably in a row within one run, the run aborts on the
        // assumption of a global provider problem rather than continuing to
        // brand the whole queue failed.
        maxConsecutiveTerminalExtractionFailures: envInt("CONSOLIDATION_MAX_CONSECUTIVE_TERMINAL_FAILURES", 3, { min: 1 }),
        // "auto" selects Atlas autoEmbed (the server computes and stores the
        // embedding from the "text" path, no app-side Voyage call); anything
        // else, including unset, keeps the appside (current) behavior.
        embeddingMode: process.env.EMBEDDING_MODE === "auto" ? "auto" : "appside",
        // "native" always uses the Atlas $rerank stage, "appside" always uses
        // the Voyage rerank API, "auto" (default) probes native and caches the
        // result, falling back to Voyage rerank on failure.
        rerankMode: process.env.RERANK_MODE === "native" || process.env.RERANK_MODE === "appside"
            ? process.env.RERANK_MODE
            : "auto",
    };
}
