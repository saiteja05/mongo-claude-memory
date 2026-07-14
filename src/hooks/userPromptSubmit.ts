import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "mongodb";
import { loadConfig } from "../config.js";
import { getProjectKey } from "../project/projectKey.js";
import { getDb, closeDb } from "../db/client.js";
import { writeObservation, type WriteObservationParams } from "../capture/writeObservation.js";
import { appendFailure } from "../telemetry/failureLog.js";

export interface UserPromptSubmitInput {
  session_id: string;
  prompt_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  /** The submitted prompt text, as Claude Code actually sends it. */
  prompt: string;
  /** Legacy field name; accepted as a fallback when `prompt` is absent. */
  prompt_text?: string;
}

/**
 * Resolves the prompt text from the hook payload. Claude Code sends the field
 * as `prompt`; `prompt_text` is accepted as a legacy fallback.
 */
export function resolvePromptText(input: UserPromptSubmitInput): string {
  return input.prompt ?? input.prompt_text ?? "";
}

export interface UserPromptSubmitDeps {
  writeObservation: (params: {
    project: string;
    session_id: string;
    source: "hash_line";
    priority: "high";
    text: string;
  }) => Promise<unknown>;
  getProjectKey: (cwd: string) => string;
}

/**
 * A prompt counts as a "hash line" capture only when, after trimming leading
 * whitespace, it starts with "#" AND has non-whitespace content after that
 * "#". A bare lone "#" is not a capture (nothing to remember).
 */
export function shouldCaptureAsHashLine(promptText: string): boolean {
  const trimmed = promptText.replace(/^\s+/, "");
  if (!trimmed.startsWith("#")) return false;
  const afterHash = trimmed.slice(1);
  return afterHash.trim().length > 0;
}

/**
 * Pure-ish core: writes a high-priority hash_line observation when the prompt
 * qualifies, otherwise does nothing. Never throws; per the corrected
 * UserPromptSubmit design (DESIGN.md 5.1), this hook never blocks or modifies
 * the prompt, so it has no return value to produce either way.
 */
export async function captureUserPromptSubmit(
  input: UserPromptSubmitInput,
  deps: UserPromptSubmitDeps
): Promise<void> {
  try {
    const promptText = resolvePromptText(input);
    if (!shouldCaptureAsHashLine(promptText)) return;

    const project = deps.getProjectKey(input.cwd);
    await deps.writeObservation({
      project,
      session_id: input.session_id,
      source: "hash_line",
      priority: "high",
      text: promptText,
    });
  } catch {
    // Fail open: a hook must never surface a memory-path error to the user.
  }
}

export type UserPromptSubmitHookOutcome = "skipped" | "written" | "timeout" | "error";

export interface UserPromptSubmitHookDeps {
  getDb: () => Promise<Db>;
  writeObservation: (db: Db, params: WriteObservationParams) => Promise<unknown>;
  getProjectKey: (cwd: string) => string;
  hookWriteTimeoutMs: number;
}

export interface UserPromptSubmitHookResult {
  outcome: UserPromptSubmitHookOutcome;
  /**
   * Only set when outcome is "timeout": the still in-flight write, with
   * errors already swallowed, so main() can await it before closeDb() runs
   * instead of severing the connection mid-insert.
   */
  pendingWrite: Promise<void> | null;
}

/**
 * Hook orchestrator with two deliberate behaviors:
 *
 * 1. Ordinary (non-#) prompts return "skipped" immediately, before any DB
 *    connect, so the common path pays zero memory latency.
 * 2. Hash-line captures are an explicit "remember this" from the user, so the
 *    write gets a dedicated, generous budget (hookWriteTimeoutMs, default
 *    5000ms) and is awaited to completion within it: a rare extra couple of
 *    seconds is an acceptable price for not losing the data. The old design
 *    raced the write against the general 800ms hook budget and then
 *    process.exit()ed, killing the in-flight insert and silently dropping the
 *    capture on cold connects.
 *
 * Never throws: timeout and error outcomes are returned, not raised, so the
 * caller can always exit 0 (fail open).
 */
export async function runUserPromptSubmitHook(
  input: UserPromptSubmitInput,
  deps: UserPromptSubmitHookDeps
): Promise<UserPromptSubmitHookResult> {
  const promptText = resolvePromptText(input);
  if (!shouldCaptureAsHashLine(promptText)) return { outcome: "skipped", pendingWrite: null };

  try {
    const write = (async () => {
      const db = await deps.getDb();
      const project = deps.getProjectKey(input.cwd);
      await deps.writeObservation(db, {
        project,
        session_id: input.session_id,
        source: "hash_line",
        priority: "high",
        text: promptText,
      });
      return "written" as const;
    })();

    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), deps.hookWriteTimeoutMs);
      timer.unref?.();
    });

    const outcome = await Promise.race([write, timeout]);

    if (outcome === "timeout") {
      return { outcome, pendingWrite: write.then(() => undefined).catch(() => undefined) };
    }
    return { outcome, pendingWrite: null };
  } catch {
    return { outcome: "error", pendingWrite: null };
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
 * Thin wiring, mirroring sessionStart.ts. Never prints anything: we
 * deliberately never emit a "block" decision or additionalContext, so the
 * prompt always passes through completely unmodified.
 */
async function main(): Promise<void> {
  // Everything routes through the single process.exit(0) at the end of the
  // finally block below, never an early process.exit() inside try: exit()
  // terminates the process immediately and skips any later finally.
  let pendingWrite: Promise<void> | null = null;
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as UserPromptSubmitInput;

    // Ordinary prompts exit right here: no config load, no DB connect, no
    // memory latency on the common path.
    if (!shouldCaptureAsHashLine(resolvePromptText(input))) {
      return;
    }

    if (!process.env.MDB_MCP_CONNECTION_STRING && !process.env.MEMORY_MONGODB_URI) {
      return;
    }

    const config = loadConfig();

    const result = await runUserPromptSubmitHook(input, {
      getDb,
      writeObservation,
      getProjectKey,
      hookWriteTimeoutMs: config.hookWriteTimeoutMs,
    });
    pendingWrite = result.pendingWrite;

    // A hash-line capture is an explicit user request to remember; if it was
    // lost (timeout or error), leave one line of local telemetry.
    if (result.outcome === "timeout" || result.outcome === "error") {
      appendFailure(`userPromptSubmit.${result.outcome}`, "CaptureFailed");
    }
  } catch (err) {
    // Fail open: never let a hook throw. Leave one line of local telemetry.
    appendFailure("userPromptSubmit", err);
  } finally {
    // Await any still-in-flight write before closing the DB connection: a
    // timeout outcome means the write raced past its budget, not that it was
    // abandoned, so closeDb() must not sever it mid-insert.
    if (pendingWrite) {
      await pendingWrite;
    }
    try {
      await closeDb();
    } catch {
      // Ignore close errors too; the process is exiting regardless.
    }
    process.exit(0);
  }
}

// Only run main() when this file is the actual entry point (node dist/hooks/userPromptSubmit.js),
// never when imported as a module (e.g. by tests exercising captureUserPromptSubmit directly).
const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  main();
}
