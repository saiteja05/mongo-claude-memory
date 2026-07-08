// Configuration loader. Never logs actual secret values, only presence/absence.
function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "")
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
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
        briefCoreTokenCap: envInt("BRIEF_CORE_TOKEN_CAP", 800),
        briefProjectTokenCap: envInt("BRIEF_PROJECT_TOKEN_CAP", 1200),
        hookInternalTimeoutMs: envInt("HOOK_INTERNAL_TIMEOUT_MS", 800),
    };
}
