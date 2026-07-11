import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { getProjectKey } from "../project/projectKey.js";
import { getDb, closeDb } from "../db/client.js";
import { writeObservation } from "../capture/writeObservation.js";

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
  try {
    if (!process.env.MDB_MCP_CONNECTION_STRING && !process.env.MEMORY_MONGODB_URI) {
      return;
    }

    const raw = await readStdin();
    const input = JSON.parse(raw) as UserPromptSubmitInput;

    const config = loadConfig();

    const body = (async () => {
      const db = await getDb();
      await captureUserPromptSubmit(input, {
        getProjectKey,
        writeObservation: (params) => writeObservation(db, params),
      });
    })();

    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), config.hookInternalTimeoutMs);
      timer.unref?.();
    });

    await Promise.race([body.catch(() => undefined), timeout]);
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

// Only run main() when this file is the actual entry point (node dist/hooks/userPromptSubmit.js),
// never when imported as a module (e.g. by tests exercising captureUserPromptSubmit directly).
const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  main();
}
