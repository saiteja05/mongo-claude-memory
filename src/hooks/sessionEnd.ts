import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { getProjectKey } from "../project/projectKey.js";
import { getDb, closeDb } from "../db/client.js";
import { writeObservationsBulk, type WriteObservationParams } from "../capture/writeObservation.js";
import { TRANSCRIPT_TAIL_LENGTH } from "../capture/constants.js";
import { getBriefs, type BriefResult } from "../briefs/fetchBrief.js";
import { appendFailure } from "../telemetry/failureLog.js";

// Cheap rolling summary per DESIGN.md 5.1: the raw transcript file, chunked
// into consecutive TRANSCRIPT_TAIL_LENGTH-character slices and capped by
// config.transcriptCaptureMaxChars (shared constants in capture/constants.ts
// so writeObservation's clamp cannot silently diverge), not a parse of
// Claude Code's internal JSONL schema.

// Budget for the pre-capture brief fetch used to strip injected brief content
// from the transcript before it is chunked. Deliberately short: stripping is
// an optimization against the echo loop, not a requirement, so a slow fetch
// just skips it.
const BRIEF_STRIP_TIMEOUT_MS = 1500;

// Brief contents shorter than this are never stripped: removing tiny common
// substrings from the transcript would mangle unrelated text.
const MIN_BRIEF_STRIP_LENGTH = 40;

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
  readTranscript: (transcriptPath: string) => Promise<string | null>;
  /**
   * Bulk write: one insert round trip for every chunk of a session's
   * transcript capture, so a multi-chunk capture still fits inside
   * sessionEndTimeoutMs.
   */
  writeObservations: (paramsList: WriteObservationParams[]) => Promise<unknown>;
  // Total transcript capture budget in characters, wired from
  // config.transcriptCaptureMaxChars; caps how many TRANSCRIPT_TAIL_LENGTH
  // chunks a single session's capture can keep.
  transcriptCaptureMaxChars: number;
  getProjectKey: (cwd: string) => string;
  /**
   * Optional: fetches the currently injected briefs so their content can be
   * stripped from the transcript before it is chunked (echo-loop defense: the
   * injected brief is memory OUTPUT, and re-observing it would feed it back
   * into consolidation as if it were new evidence). Fail-open: any error or
   * absence just skips stripping.
   */
  getBriefs?: (projectKey: string, timeoutMs: number) => Promise<BriefResult>;
}

/**
 * Removes every exact occurrence of each brief's content from the transcript
 * tail. Only strips non-empty strings of length >= MIN_BRIEF_STRIP_LENGTH so
 * tiny common substrings can never be stripped out of unrelated text. Pure
 * and cheap: exact string splitting, no regex compilation on untrusted input.
 */
export function stripInjectedBriefs(
  tail: string,
  briefContents: Array<string | null | undefined>
): string {
  let result = tail;
  for (const content of briefContents) {
    if (typeof content !== "string" || content.length < MIN_BRIEF_STRIP_LENGTH) continue;
    // tail is read from the raw transcript JSONL file, so any newline/quote/
    // backslash in content appears there JSON-escaped, not as a real byte.
    const escaped = JSON.stringify(content).slice(1, -1);
    result = result.split(escaped).join("");
  }
  return result;
}

/**
 * Splits text into consecutive chunkSize slices. When there are more chunks
 * than maxChunks allows, keeps the first chunk (early session context) plus
 * the most recent (maxChunks - 1) chunks, so droppedChars reports the size
 * of the cut middle. maxChunks 1 is a degenerate budget with no room for both
 * a first and a last chunk: it keeps only the LAST chunk, preserving today's
 * pre-chunking most-recent-wins behavior rather than switching to a
 * first-chunk-only capture for a single slot. Pure function, no I/O.
 */
export function chunkTranscript(
  text: string,
  chunkSize: number,
  maxChunks: number
): { chunks: string[]; droppedChars: number } {
  if (!text) {
    return { chunks: [], droppedChars: 0 };
  }

  const allChunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    allChunks.push(text.slice(i, i + chunkSize));
  }

  if (allChunks.length <= maxChunks) {
    return { chunks: allChunks, droppedChars: 0 };
  }

  if (maxChunks <= 1) {
    const dropped = allChunks.slice(0, -1);
    const droppedChars = dropped.reduce((sum, chunk) => sum + chunk.length, 0);
    return { chunks: [allChunks[allChunks.length - 1]], droppedChars };
  }

  const tailChunks = allChunks.slice(allChunks.length - (maxChunks - 1));
  const droppedMiddle = allChunks.slice(1, allChunks.length - (maxChunks - 1));
  const droppedChars = droppedMiddle.reduce((sum, chunk) => sum + chunk.length, 0);
  return { chunks: [allChunks[0], ...tailChunks], droppedChars };
}

/**
 * Pure-ish core: reads the full transcript, strips any injected brief content
 * from it (echo-loop defense), chunks what is left, and, if there is
 * anything to capture, writes one observation per chunk in a single bulk
 * call. Never throws; any failure (missing transcript, writeObservations
 * rejecting) is swallowed so the hook can always fail open per DESIGN.md
 * section 10.
 */
export async function captureSessionEnd(
  input: SessionEndInput,
  deps: SessionEndDeps
): Promise<void> {
  try {
    const raw = await deps.readTranscript(input.transcript_path);
    if (!raw) return;

    const project = deps.getProjectKey(input.cwd);

    let briefs: BriefResult = { global: null, project: null };
    if (deps.getBriefs) {
      try {
        briefs = await deps.getBriefs(project, BRIEF_STRIP_TIMEOUT_MS);
      } catch {
        // Fail open: stripping is best-effort, capture proceeds unstripped.
      }
    }

    // Strip on the FULL transcript, before chunking: a brief straddling a
    // chunk boundary would survive as two unmatched halves if it were
    // stripped chunk-by-chunk instead, since stripInjectedBriefs only removes
    // an EXACT whole-string match.
    const text = stripInjectedBriefs(raw, [briefs.global, briefs.project]);
    if (!text.trim()) return;

    const maxChunks = Math.max(
      1,
      Math.floor(deps.transcriptCaptureMaxChars / TRANSCRIPT_TAIL_LENGTH)
    );
    const { chunks, droppedChars } = chunkTranscript(text, TRANSCRIPT_TAIL_LENGTH, maxChunks);
    if (chunks.length === 0) return;

    if (droppedChars > 0) {
      // Counts only, never content: a dropped transcript slice can contain
      // anything the session touched.
      console.error(
        `sessionEnd: transcript capture dropped ${droppedChars} chars, keeping ${chunks.length} of ${maxChunks} max chunks`
      );
    }

    const chunkCount = chunks.length;
    const paramsList: WriteObservationParams[] = chunks.map((chunkText, index) => ({
      project,
      session_id: input.session_id,
      source: "transcript",
      priority: "normal",
      text: chunkText,
      chunk_index: index,
      chunk_count: chunkCount,
    }));

    await deps.writeObservations(paramsList);
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

async function readTranscript(transcriptPath: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    const content = await readFile(transcriptPath, "utf8");
    if (!content) return null;
    return content;
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
      readTranscript,
      getProjectKey,
      getBriefs,
      transcriptCaptureMaxChars: config.transcriptCaptureMaxChars,
      writeObservations: async (paramsList) => {
        const db = await getDb();
        return writeObservationsBulk(db, paramsList);
      },
    };

    await captureSessionEndWithTimeout(input, deps, config.sessionEndTimeoutMs);
  } catch (err) {
    // Fail open: never let a hook throw. Leave one line of local telemetry.
    appendFailure("sessionEnd", err);
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
