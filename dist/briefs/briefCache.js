import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Local last-known-good cache for the compiled briefs SessionStart injects.
 * When Atlas is slower than config.sessionStartTimeoutMs, getBriefs resolves
 * empty and the session would otherwise start memoryless; this cache lets
 * sessionStart.ts fall back to whatever was last fetched successfully,
 * bounded by config.briefCacheMaxAgeDays so a long-dead cache is never served
 * as if it were current.
 *
 * Follows failureLog.ts's safe-IO conventions: every exported function here
 * swallows its own errors (this is a best-effort convenience cache, never a
 * new failure mode) and never throws.
 */
export function briefCacheDir() {
    return (process.env.MEMORY_BRIEF_CACHE_DIR ||
        path.join(os.homedir(), ".mongo-claude-memory", "brief-cache"));
}
// projectKey is already a name-hash12 slug produced by getProjectKey, but a
// filesystem path must never trust its input: strip anything outside the
// safe charset before it becomes part of a file name, so a crafted key can
// never traverse out of the cache directory.
function cacheFileFor(projectKey) {
    const safeName = projectKey.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(briefCacheDir(), `${safeName}.json`);
}
// Briefs are token-capped to roughly 8 KB (BRIEF_CORE/PROJECT_TOKEN_CAP); 256
// KiB is a generous hard bound so a corrupt or hand-edited cache file can
// never be treated as valid or grow disk usage unbounded.
const MAX_CACHE_BYTES = 262144;
/**
 * Best-effort write of the last-known-good brief pair to disk. Only
 * meaningful when there is content: the caller already gates this on
 * source === "fetched" and at least one non-null brief, but stays defensive
 * here in case a future caller does not.
 */
export function writeBriefCache(projectKey, briefs) {
    try {
        if (!briefs.global && !briefs.project)
            return;
        const payload = {
            global: briefs.global,
            project: briefs.project,
            generated_at: briefs.generatedAt ?? null,
            cached_at: new Date().toISOString(),
        };
        const data = JSON.stringify(payload);
        // Skip silently rather than write a cache file that read-side size
        // checks would just refuse anyway.
        if (Buffer.byteLength(data, "utf8") > MAX_CACHE_BYTES)
            return;
        const dir = briefCacheDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cacheFileFor(projectKey), data, { encoding: "utf8", mode: 0o600 });
    }
    catch {
        // Best-effort convenience cache: a write failure must never surface.
    }
}
/**
 * Reads back the last-known-good brief pair, or null when there is nothing
 * usable: reads disabled (maxAgeDays <= 0), no file, an oversized file
 * (refused rather than truncated), unparseable JSON, a missing/invalid
 * cached_at, or a cached_at older than maxAgeDays. Never throws.
 */
export function readBriefCache(projectKey, maxAgeDays) {
    try {
        if (maxAgeDays <= 0)
            return null;
        const target = cacheFileFor(projectKey);
        const stats = fs.statSync(target);
        if (stats.size > MAX_CACHE_BYTES)
            return null;
        const raw = fs.readFileSync(target, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.cached_at !== "string")
            return null;
        const cachedAtMs = new Date(parsed.cached_at).getTime();
        if (!Number.isFinite(cachedAtMs))
            return null;
        const ageMs = Date.now() - cachedAtMs;
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        if (ageMs > maxAgeMs)
            return null;
        return {
            global: typeof parsed.global === "string" ? parsed.global : null,
            project: typeof parsed.project === "string" ? parsed.project : null,
            generatedAt: typeof parsed.generated_at === "string" ? parsed.generated_at : null,
            cachedAt: parsed.cached_at,
        };
    }
    catch {
        // Missing file, corrupt JSON, or anything else: no usable cache.
        return null;
    }
}
/**
 * Best-effort removal of a project's cached brief, e.g. after a forget makes
 * the cached content stale. Silent when the file does not exist.
 */
export function deleteBriefCache(projectKey) {
    try {
        fs.rmSync(cacheFileFor(projectKey), { force: true });
    }
    catch {
        // Best-effort: a failed delete must never fail the caller.
    }
}
