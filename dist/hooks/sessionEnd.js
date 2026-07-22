import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { getProjectKey } from "../project/projectKey.js";
import { getDb, closeDb } from "../db/client.js";
import { writeObservationsBulk } from "../capture/writeObservation.js";
import { TRANSCRIPT_TAIL_LENGTH } from "../capture/constants.js";
import { getBriefs } from "../briefs/fetchBrief.js";
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
/**
 * Removes every exact occurrence of each brief's content from the transcript
 * tail. Only strips non-empty strings of length >= MIN_BRIEF_STRIP_LENGTH so
 * tiny common substrings can never be stripped out of unrelated text. Pure
 * and cheap: exact string splitting, no regex compilation on untrusted input.
 */
export function stripInjectedBriefs(tail, briefContents) {
    let result = tail;
    for (const content of briefContents) {
        if (typeof content !== "string" || content.length < MIN_BRIEF_STRIP_LENGTH)
            continue;
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
export function chunkTranscript(text, chunkSize, maxChunks) {
    if (!text) {
        return { chunks: [], droppedChars: 0 };
    }
    const allChunks = [];
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
 * Core capture logic, deliberately left free to throw or reject: reads the
 * full transcript, strips any injected brief content from it (echo-loop
 * defense), chunks what is left, and, if there is anything to capture,
 * writes one observation per chunk in a single bulk call.
 *
 * Unlike captureSessionEnd just below, this function does NOT swallow its
 * own errors. captureSessionEndWithTimeout needs the real settlement
 * (resolved or rejected) of the in-flight write to tell a late-arriving
 * success from a late-arriving failure once a race against the timeout
 * budget is lost; captureSessionEnd wraps this in its own fail-open
 * try/catch for every other, non-timeout-aware caller.
 */
async function runSessionEndCapture(input, deps) {
    const raw = await deps.readTranscript(input.transcript_path);
    if (!raw)
        return;
    const project = deps.getProjectKey(input.cwd);
    let briefs = { global: null, project: null };
    if (deps.getBriefs) {
        try {
            briefs = await deps.getBriefs(project, BRIEF_STRIP_TIMEOUT_MS);
        }
        catch {
            // Fail open: stripping is best-effort, capture proceeds unstripped.
        }
    }
    // Strip on the FULL transcript, before chunking: a brief straddling a
    // chunk boundary would survive as two unmatched halves if it were
    // stripped chunk-by-chunk instead, since stripInjectedBriefs only removes
    // an EXACT whole-string match.
    const text = stripInjectedBriefs(raw, [briefs.global, briefs.project]);
    if (!text.trim())
        return;
    const maxChunks = Math.max(1, Math.floor(deps.transcriptCaptureMaxChars / TRANSCRIPT_TAIL_LENGTH));
    const { chunks, droppedChars } = chunkTranscript(text, TRANSCRIPT_TAIL_LENGTH, maxChunks);
    if (chunks.length === 0)
        return;
    if (droppedChars > 0) {
        // Counts only, never content: a dropped transcript slice can contain
        // anything the session touched.
        console.error(`sessionEnd: transcript capture dropped ${droppedChars} chars, keeping ${chunks.length} of ${maxChunks} max chunks`);
    }
    const chunkCount = chunks.length;
    const paramsList = chunks.map((chunkText, index) => ({
        project,
        session_id: input.session_id,
        source: "transcript",
        priority: "normal",
        text: chunkText,
        chunk_index: index,
        chunk_count: chunkCount,
    }));
    await deps.writeObservations(paramsList);
}
/**
 * Pure-ish core: a thin fail-open wrapper around runSessionEndCapture. Never
 * throws; any failure (missing transcript that throws instead of resolving
 * null, writeObservations rejecting) is swallowed so the hook can always
 * fail open per DESIGN.md section 10, and is also recorded as one name-only
 * appendFailure("sessionEnd.captureError", <error name>) line, so a genuine,
 * non-timeout capture failure is not completely invisible to an operator
 * either.
 */
export async function captureSessionEnd(input, deps) {
    try {
        await runSessionEndCapture(input, deps);
    }
    catch (err) {
        appendFailure("sessionEnd.captureError", err);
    }
}
/**
 * Races runSessionEndCapture against timeoutMs, same pendingWrite pattern as
 * userPromptSubmit.ts's runUserPromptSubmitHook: on timeout, the in-flight
 * capture is NOT abandoned. It is handed back as pendingWrite so the caller
 * can await it, right where closeDb() would otherwise have severed it mid
 * insert, instead of the old behavior where Promise.race simply discarded
 * whichever side of the race lost, silently dropping a write that was about
 * to succeed.
 *
 * Failure semantics:
 * - A timeout is ALWAYS reported, the instant the race is lost, via
 *   appendFailure("sessionEnd.timeout", "CaptureTimeout"), before
 *   pendingWrite is ever awaited: the pending await happens strictly after
 *   this verdict, so the telemetry line exists even if the process is
 *   killed before the pending write settles.
 * - Once pendingWrite does settle, the result is recorded either way: a
 *   write that actually completes after the timeout additionally logs
 *   appendFailure("sessionEnd.lateCapture", "CaptureLandedLate"), so an
 *   operator can tell a race that still landed the data from one that lost
 *   it outright; a write that ultimately fails logs
 *   appendFailure("sessionEnd.captureError", <error name>) instead, the same
 *   as any other non-timeout capture failure.
 * - The normal (non-timeout) fast path logs nothing new; a fast-path failure
 *   (settled before the timeout, but rejected) still logs
 *   "sessionEnd.captureError" so it is never silent either.
 *
 * Every log line is name-only (component plus a fixed reason or the error's
 * name), never transcript content. This function itself never throws: every
 * branch resolves.
 */
export async function captureSessionEndWithTimeout(input, deps, timeoutMs) {
    const bodyPromise = runSessionEndCapture(input, deps);
    // Never let the body's own rejection surface as an unhandled rejection or
    // fail the Promise.race below: turn it into a plain settlement record
    // immediately, right where the promise is created.
    const bodySettled = bodyPromise.then(() => ({ ok: true }), (err) => ({ ok: false, err }));
    const timeoutPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
    });
    const verdict = await Promise.race([
        bodySettled.then(() => "completed"),
        timeoutPromise,
    ]);
    if (verdict === "timeout") {
        appendFailure("sessionEnd.timeout", "CaptureTimeout");
        return {
            outcome: "timeout",
            pendingWrite: bodySettled.then((settled) => {
                if (settled.ok) {
                    appendFailure("sessionEnd.lateCapture", "CaptureLandedLate");
                }
                else {
                    appendFailure("sessionEnd.captureError", settled.err);
                }
            }),
        };
    }
    // Fast path: the body settled before the timeout. A failure here is a
    // genuine (non-timeout) capture failure, not a lost race, so it is logged
    // the same way captureSessionEnd logs one for any other direct caller.
    const settled = await bodySettled;
    if (!settled.ok) {
        appendFailure("sessionEnd.captureError", settled.err);
    }
    return { outcome: "completed", pendingWrite: null };
}
async function readTranscript(transcriptPath) {
    const { readFile } = await import("node:fs/promises");
    try {
        const content = await readFile(transcriptPath, "utf8");
        if (!content)
            return null;
        return content;
    }
    catch {
        // Missing file, unreadable, or a fresh session with no transcript yet.
        return null;
    }
}
async function readStdin() {
    const chunks = [];
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
async function main() {
    // Everything routes through the single process.exit(0) at the end of the
    // finally block below, never an early process.exit() inside try: exit()
    // terminates the process immediately and skips any later finally.
    let pendingWrite = null;
    try {
        if (!process.env.MDB_MCP_CONNECTION_STRING && !process.env.MEMORY_MONGODB_URI) {
            return;
        }
        const raw = await readStdin();
        const input = JSON.parse(raw);
        const config = loadConfig();
        const deps = {
            readTranscript,
            getProjectKey,
            getBriefs,
            transcriptCaptureMaxChars: config.transcriptCaptureMaxChars,
            writeObservations: async (paramsList) => {
                const db = await getDb();
                return writeObservationsBulk(db, paramsList);
            },
        };
        const result = await captureSessionEndWithTimeout(input, deps, config.sessionEndTimeoutMs);
        pendingWrite = result.pendingWrite;
    }
    catch (err) {
        // Fail open: never let a hook throw. Leave one line of local telemetry.
        appendFailure("sessionEnd", err);
    }
    finally {
        // Await any still-in-flight capture before closing the DB connection: a
        // timeout outcome means the write raced past its budget, not that it was
        // abandoned, so closeDb() must not sever it mid-insert (same pattern as
        // userPromptSubmit.ts's main()).
        if (pendingWrite) {
            await pendingWrite;
        }
        try {
            await closeDb();
        }
        catch {
            // Ignore close errors too; the process is exiting regardless.
        }
        process.exit(0);
    }
}
// Only run main() when this file is the actual entry point (node dist/hooks/sessionEnd.js),
// never when imported as a module (e.g. by tests exercising captureSessionEnd directly).
// Node's ESM loader resolves symlinks when it builds import.meta.url, but
// path.resolve(process.argv[1]) only normalizes the literal argv string and never touches
// symlinks, so if the invocation path crosses a symlink (e.g. macOS /tmp -> /private/tmp) the
// two strings never match. realpathSync on both sides removes that asymmetry; the try/catch
// keeps this defensive (never throw here) so a deleted file or an unusual argv[1] just falls
// back to isEntryPoint=false.
let isEntryPoint = false;
if (process.argv[1] !== undefined) {
    try {
        isEntryPoint = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
    }
    catch {
        isEntryPoint = false;
    }
}
if (isEntryPoint) {
    main();
}
