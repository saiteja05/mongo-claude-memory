import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { getProjectKey } from "../project/projectKey.js";
import { getBriefs, type BriefResult } from "../briefs/fetchBrief.js";
import { closeDb } from "../db/client.js";

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
  hookInternalTimeoutMs: number;
}

/**
 * Pure logic: combines the global and project briefs (if any) into the
 * additionalContext string, or returns null if there is nothing to inject.
 * Never throws; any rejection from deps.getBriefs is treated as "no brief".
 */
export async function buildAdditionalContext(
  input: SessionStartInput,
  deps: SessionStartDeps
): Promise<string | null> {
  const projectKey = deps.getProjectKey(input.cwd);

  let briefs: BriefResult;
  try {
    briefs = await deps.getBriefs(projectKey, deps.hookInternalTimeoutMs);
  } catch {
    briefs = { global: null, project: null };
  }

  if (!briefs.global && !briefs.project) {
    return null;
  }

  const parts: string[] = [];
  if (briefs.global) parts.push(briefs.global);
  if (briefs.project) parts.push(briefs.project);

  return parts.join("\n\n");
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

    const context = await buildAdditionalContext(input, {
      getBriefs,
      getProjectKey,
      hookInternalTimeoutMs: config.hookInternalTimeoutMs,
    });

    if (!context) {
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
  } catch {
    // Fail open: never let a hook throw.
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
