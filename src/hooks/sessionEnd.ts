import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { getProjectKey } from "../project/projectKey.js";
import { getDb, closeDb } from "../db/client.js";
import { writeObservation } from "../capture/writeObservation.js";

// Cheap rolling summary per DESIGN.md 5.1: the last N characters of the raw
// transcript file, not a parse of Claude Code's internal JSONL schema.
const TRANSCRIPT_TAIL_LENGTH = 50000;

export interface SessionEndInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  reason: string;
  last_assistant_message?: string;
}

export interface SessionEndDeps {
  readTranscriptTail: (transcriptPath: string) => Promise<string | null>;
  writeObservation: (params: {
    project: string;
    session_id: string;
    source: "transcript";
    priority: "normal";
    text: string;
  }) => Promise<unknown>;
  getProjectKey: (cwd: string) => string;
}

/**
 * Pure-ish core: reads the transcript tail and, if there is anything to
 * capture, writes one observation. Never throws; any failure (missing
 * transcript, writeObservation rejecting) is swallowed so the hook can always
 * fail open per DESIGN.md section 10.
 */
export async function captureSessionEnd(
  input: SessionEndInput,
  deps: SessionEndDeps
): Promise<void> {
  try {
    const tail = await deps.readTranscriptTail(input.transcript_path);
    if (!tail) return;

    const project = deps.getProjectKey(input.cwd);
    await deps.writeObservation({
      project,
      session_id: input.session_id,
      source: "transcript",
      priority: "normal",
      text: tail,
    });
  } catch {
    // Fail open: a hook must never surface a memory-path error to the user.
  }
}

/**
 * Races captureSessionEnd against timeoutMs, same pattern as fetchBrief.ts's
 * getBriefs: on timeout, resolves (does not reject) so the caller always
 * fails open regardless of whether the body finished in time.
 */
export async function captureSessionEndWithTimeout(
  input: SessionEndInput,
  deps: SessionEndDeps,
  timeoutMs: number
): Promise<void> {
  const bodyPromise = captureSessionEnd(input, deps).catch(() => undefined);

  const timeoutPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([bodyPromise, timeoutPromise]);
  } catch {
    // Fail open: never let a hook throw.
  }
}

async function readTranscriptTail(transcriptPath: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    const content = await readFile(transcriptPath, "utf8");
    if (!content) return null;
    return content.slice(-TRANSCRIPT_TAIL_LENGTH);
  } catch {
    // Missing file, unreadable, or a fresh session with no transcript yet.
    return null;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Thin wiring, mirroring sessionStart.ts: reads stdin, runs the capture logic
 * against real deps, races it against config.sessionEndTimeoutMs, and always
 * exits 0. SessionEnd's return value is ignored by Claude Code (docs-verified,
 * non-blocking event), so nothing is ever printed to stdout.
 */
async function main(): Promise<void> {
  // Everything routes through the single process.exit(0) at the end of the
  // finally block below, never an early process.exit() inside try: exit()
  // terminates the process immediately and skips any later finally.
  try {
    if (!process.env.MDB_MCP_CONNECTION_STRING && !process.env.MEMORY_MONGODB_URI) {
      return;
    }

    const raw = await readStdin();
    const input = JSON.parse(raw) as SessionEndInput;

    const config = loadConfig();

    const deps: SessionEndDeps = {
      readTranscriptTail,
      getProjectKey,
      writeObservation: async (params) => {
        const db = await getDb();
        return writeObservation(db, params);
      },
    };

    await captureSessionEndWithTimeout(input, deps, config.sessionEndTimeoutMs);
  } catch {
    // Fail open: never let a hook throw.
  } finally {
    try {
      await closeDb();
    } catch {
      // Ignore close errors too; the process is exiting regardless.
    }
    process.exit(0);
  }
}

// Only run main() when this file is the actual entry point (node dist/hooks/sessionEnd.js),
// never when imported as a module (e.g. by tests exercising captureSessionEnd directly).
const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  main();
}
