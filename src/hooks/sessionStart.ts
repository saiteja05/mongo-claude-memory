import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { getProjectKey } from "../project/projectKey.js";
import { getBriefs, type BriefResult } from "../briefs/fetchBrief.js";
import { writeBriefCache, readBriefCache, type StoredBriefCache } from "../briefs/briefCache.js";
import { closeDb } from "../db/client.js";
import { appendFailure } from "../telemetry/failureLog.js";

export interface SessionStartInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  source?: string;
  model?: string;
}

export interface SessionStartDeps {
  getBriefs: (projectKey: string, timeoutMs: number) => Promise<BriefResult>;
  getProjectKey: (cwd: string) => string;
  sessionStartTimeoutMs: number;
  writeBriefCache: (projectKey: string, briefs: BriefResult) => void;
  readBriefCache: (projectKey: string, maxAgeDays: number) => StoredBriefCache | null;
  briefCacheMaxAgeDays: number;
}

/**
 * Pure logic: combines the global and project briefs (if any) into the
 * additionalContext string, or returns null if there is nothing to inject.
 * Never throws; any rejection from deps.getBriefs is treated as "no brief".
 *
 * When Atlas is slower than the budget, getBriefs resolves empty and the
 * session would otherwise start memoryless. To soften that, a healthy fetch
 * with content refreshes a local last-known-good cache, and an empty result
 * caused by a timeout or error (never a healthy empty) falls back to that
 * cache, bounded by its own staleness budget.
 */
export async function buildAdditionalContext(
  input: SessionStartInput,
  deps: SessionStartDeps
): Promise<string | null> {
  const projectKey = deps.getProjectKey(input.cwd);

  let briefs: BriefResult;
  try {
    briefs = await deps.getBriefs(projectKey, deps.sessionStartTimeoutMs);
  } catch {
    // Mirrors getBriefs's own "error" classification: a rejection this far
    // up is still an outage, not a healthy empty, so the cache fallback
    // below must be allowed to run.
    briefs = { global: null, project: null, source: "error" };
  }

  if (briefs.global || briefs.project) {
    // A completed fetch with real content: refresh the local last-known-good
    // cache so a later outage has something to fall back to. Wrapped
    // defensively even though the real writeBriefCache cannot throw, because
    // a stubbed dep in tests must not be able to break the hook.
    if (briefs.source === "fetched") {
      try {
        deps.writeBriefCache(projectKey, briefs);
      } catch {
        // Never let a cache write break the hook.
      }
    }

    const parts: string[] = [];
    if (briefs.global) parts.push(briefs.global);
    if (briefs.project) parts.push(briefs.project);
    return parts.join("\n\n");
  }

  // Both briefs are empty. A healthy, completed fetch that legitimately has
  // nothing to say (a new or fully-forgotten project) must return null
  // WITHOUT touching the cache: resurrecting old content on a healthy
  // connection would make a deliberate forget look like it silently failed.
  if (briefs.source === "fetched") {
    return null;
  }

  // Empty because of a timeout or an error, not a healthy empty: fall back
  // to the last-known-good local cache, itself bounded by its own staleness
  // budget.
  const cached = deps.readBriefCache(projectKey, deps.briefCacheMaxAgeDays);
  if (!cached) {
    return null;
  }

  appendFailure("sessionStart.cacheServed", "BriefCacheFallback");

  const cachedParts: string[] = [];
  if (cached.global) cachedParts.push(cached.global);
  if (cached.project) cachedParts.push(cached.project);

  const notice =
    "[memory notice: this brief was served from a local cache because the live memory " +
    `fetch was unavailable; it was last refreshed ${cached.cachedAt}, compiled ` +
    `${cached.generatedAt ?? "unknown"}, and may be stale or contain since-forgotten items]`;

  return `${notice}\n\n${cachedParts.join("\n\n")}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Thin wiring: reads stdin, calls the pure logic with real deps, and prints
 * the hook contract JSON. Wrapped so that ANY error, at any stage, results in
 * a silent process.exit(0) (DESIGN.md section 10: memory failures must never
 * be visible as hook errors).
 */
async function main(): Promise<void> {
  // Everything routes through a single process.exit(0) at the very end (in
  // the finally block), never an early process.exit() inside try: calling
  // process.exit() terminates the process immediately and skips any
  // subsequent finally, so closeDb() would never run otherwise.
  try {
    if (!process.env.MDB_MCP_CONNECTION_STRING && !process.env.MEMORY_MONGODB_URI) {
      return;
    }

    const raw = await readStdin();
    const input = JSON.parse(raw) as SessionStartInput;

    const config = loadConfig();

    const startedAt = Date.now();
    const context = await buildAdditionalContext(input, {
      getBriefs,
      getProjectKey,
      sessionStartTimeoutMs: config.sessionStartTimeoutMs,
      writeBriefCache,
      readBriefCache,
      briefCacheMaxAgeDays: config.briefCacheMaxAgeDays,
    });

    if (!context) {
      // Cheap timeout detection: getBriefs resolves empty on both "no brief"
      // and "timed out", but only the timeout takes the full budget. An
      // empty result that consumed the whole budget is almost certainly the
      // race resolving empty due to timeout, worth one telemetry line.
      if (Date.now() - startedAt >= config.sessionStartTimeoutMs) {
        appendFailure("sessionStart.timeout", "BriefFetchTimeout");
      }
      return;
    }

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      })
    );
  } catch (err) {
    // Fail open: never let a hook throw. Leave one line of local telemetry.
    appendFailure("sessionStart", err);
  } finally {
    try {
      await closeDb();
    } catch {
      // Ignore close errors; the process is exiting regardless.
    }
    process.exit(0);
  }
}

// Only run main() when this file is the actual entry point (node dist/hooks/sessionStart.js),
// never when imported as a module (e.g. by tests exercising buildAdditionalContext directly).
const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  main();
}
