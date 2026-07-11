import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { getProjectKey } from "../project/projectKey.js";
import { getBriefs } from "../briefs/fetchBrief.js";
import { closeDb } from "../db/client.js";
import { appendFailure } from "../telemetry/failureLog.js";
/**
 * Pure logic: combines the global and project briefs (if any) into the
 * additionalContext string, or returns null if there is nothing to inject.
 * Never throws; any rejection from deps.getBriefs is treated as "no brief".
 */
export async function buildAdditionalContext(input, deps) {
    const projectKey = deps.getProjectKey(input.cwd);
    let briefs;
    try {
        briefs = await deps.getBriefs(projectKey, deps.sessionStartTimeoutMs);
    }
    catch {
        briefs = { global: null, project: null };
    }
    if (!briefs.global && !briefs.project) {
        return null;
    }
    const parts = [];
    if (briefs.global)
        parts.push(briefs.global);
    if (briefs.project)
        parts.push(briefs.project);
    return parts.join("\n\n");
}
async function readStdin() {
    const chunks = [];
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
async function main() {
    // Everything routes through a single process.exit(0) at the very end (in
    // the finally block), never an early process.exit() inside try: calling
    // process.exit() terminates the process immediately and skips any
    // subsequent finally, so closeDb() would never run otherwise.
    try {
        if (!process.env.MDB_MCP_CONNECTION_STRING && !process.env.MEMORY_MONGODB_URI) {
            return;
        }
        const raw = await readStdin();
        const input = JSON.parse(raw);
        const config = loadConfig();
        const startedAt = Date.now();
        const context = await buildAdditionalContext(input, {
            getBriefs,
            getProjectKey,
            sessionStartTimeoutMs: config.sessionStartTimeoutMs,
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
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: context,
            },
        }));
    }
    catch (err) {
        // Fail open: never let a hook throw. Leave one line of local telemetry.
        appendFailure("sessionStart", err);
    }
    finally {
        try {
            await closeDb();
        }
        catch {
            // Ignore close errors; the process is exiting regardless.
        }
        process.exit(0);
    }
}
// Only run main() when this file is the actual entry point (node dist/hooks/sessionStart.js),
// never when imported as a module (e.g. by tests exercising buildAdditionalContext directly).
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
    main();
}
