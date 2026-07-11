// Configuration loader. Never logs actual secret values, only presence/absence.

export interface Config {
  mongodbUri: string;
  mongodbDb: string;
  voyageApiKey: string | undefined;
  voyageModel: string;
  voyageDimensions: number;
  voyageBaseUrl: string;
  briefCoreTokenCap: number;
  briefProjectTokenCap: number;
  hookInternalTimeoutMs: number;
  sessionStartTimeoutMs: number;
  hookWriteTimeoutMs: number;
  observationTtlDays: number;
  sessionEndTimeoutMs: number;
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  llmProvider: "anthropic" | "bedrock";
  llmTimeoutMs: number;
  bedrockModel: string;
  bedrockRegion: string;
  leaseMs: number;
  claimBatchSize: number;
  consolidationBatchMaxChars: number;
  reclaimAfterMs: number;
  beliefsContextLimit: number;
  dedupeSimilarityThreshold: number;
  embeddingMode: "appside" | "auto";
  rerankMode: "auto" | "native" | "appside";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Loads configuration from environment variables. Throws a clear, secret-free
 * error if MONGODB_URI cannot be resolved, since nothing can function without it.
 * VOYAGE_API_KEY is intentionally allowed to be absent here; callers that need
 * it (embedding/read paths) must handle its absence gracefully (fail open).
 */
export function loadConfig(): Config {
  const mongodbUri =
    process.env.MDB_MCP_CONNECTION_STRING || process.env.MEMORY_MONGODB_URI;

  if (!mongodbUri) {
    throw new Error(
      "MongoDB connection string is not configured. Set MDB_MCP_CONNECTION_STRING " +
        "(shared with the mongodb MCP plugin) or MEMORY_MONGODB_URI."
    );
  }

  return {
    mongodbUri,
    mongodbDb: process.env.MEMORY_MONGODB_DB || "claude_memory",
    voyageApiKey: process.env.VOYAGE_API_KEY,
    voyageModel: process.env.VOYAGE_MODEL || "voyage-4",
    voyageDimensions: envInt("VOYAGE_DIMENSIONS", 1024),
    voyageBaseUrl: (process.env.VOYAGE_BASE_URL || "https://api.voyageai.com").replace(
      /\/$/,
      ""
    ),
    briefCoreTokenCap: envInt("BRIEF_CORE_TOKEN_CAP", 800),
    briefProjectTokenCap: envInt("BRIEF_PROJECT_TOKEN_CAP", 1200),
    hookInternalTimeoutMs: envInt("HOOK_INTERNAL_TIMEOUT_MS", 800),
    // SessionStart's brief fetch gets its own budget: a cold Atlas connect
    // alone can exceed the 800ms general default. Precedence:
    // SESSION_START_TIMEOUT_MS if set, else HOOK_INTERNAL_TIMEOUT_MS if set
    // (users who explicitly tuned it keep their value), else 3000.
    sessionStartTimeoutMs: envInt(
      "SESSION_START_TIMEOUT_MS",
      envInt("HOOK_INTERNAL_TIMEOUT_MS", 3000)
    ),
    // Budget for the UserPromptSubmit hash-line capture write. This path only
    // runs when the user explicitly asked to remember something, so a rare
    // extra couple of seconds is an acceptable price for not losing the data.
    hookWriteTimeoutMs: envInt("HOOK_WRITE_TIMEOUT_MS", 5000),
    observationTtlDays: envInt("OBSERVATION_TTL_DAYS", 30),
    sessionEndTimeoutMs: envInt("SESSION_END_TIMEOUT_MS", 5000),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
    llmProvider: process.env.LLM_PROVIDER === "bedrock" ? "bedrock" : "anthropic",
    // Hard wall-clock cap on a single LLM call (fact extraction). Without it,
    // a hung request could stall a consolidation run indefinitely.
    llmTimeoutMs: envInt("LLM_TIMEOUT_MS", 60000),
    bedrockModel:
      process.env.BEDROCK_MODEL || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    bedrockRegion: process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-east-1",
    leaseMs: envInt("CONSOLIDATION_LEASE_MS", 300000),
    claimBatchSize: envInt("CONSOLIDATION_BATCH_SIZE", 50),
    // Character budget for one extraction batch. CONSOLIDATION_BATCH_SIZE
    // counts observations; transcript observations can be 50k chars each, so
    // a count-only bound could build a prompt past the model's context limit.
    consolidationBatchMaxChars: envInt("CONSOLIDATION_BATCH_MAX_CHARS", 300000),
    reclaimAfterMs: envInt("CONSOLIDATION_RECLAIM_MS", 600000),
    beliefsContextLimit: envInt("CONSOLIDATION_BELIEFS_CONTEXT_LIMIT", 30),
    dedupeSimilarityThreshold: envFloat("CONSOLIDATION_DEDUPE_THRESHOLD", 0.93),
    // "auto" selects Atlas autoEmbed (the server computes and stores the
    // embedding from the "text" path, no app-side Voyage call); anything
    // else, including unset, keeps the appside (current) behavior.
    embeddingMode: process.env.EMBEDDING_MODE === "auto" ? "auto" : "appside",
    // "native" always uses the Atlas $rerank stage, "appside" always uses
    // the Voyage rerank API, "auto" (default) probes native and caches the
    // result, falling back to Voyage rerank on failure.
    rerankMode:
      process.env.RERANK_MODE === "native" || process.env.RERANK_MODE === "appside"
        ? process.env.RERANK_MODE
        : "auto",
  };
}
