import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureSessionEnd,
  captureSessionEndWithTimeout,
  chunkTranscript,
  stripInjectedBriefs,
  type SessionEndInput,
} from "../src/hooks/sessionEnd.js";
import { TRANSCRIPT_TAIL_LENGTH } from "../src/capture/constants.js";

afterEach(() => {
  vi.useRealTimers();
});

const baseInput: SessionEndInput = {
  session_id: "sess-1",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/some/repo",
  permission_mode: "default",
  hook_event_name: "SessionEnd",
  reason: "other",
};

// Budget large enough that basic (short-transcript) tests never hit the
// chunk-dropping path; derivation itself is covered by its own tests below.
const AMPLE_BUDGET = 500000;

// captureSessionEnd's catch and captureSessionEndWithTimeout's telemetry both
// call appendFailure, which otherwise defaults to writing under the real
// ~/.mongo-claude-memory; point it at a scratch file for every test in this
// file so none of them ever touch that (same approach as sessionStart.test.ts).
let savedFailureLog: string | undefined;
let failureLogFile: string;

beforeEach(() => {
  savedFailureLog = process.env.MEMORY_FAILURE_LOG;
  failureLogFile = path.join(
    mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-sessionend-")),
    "failures.log"
  );
  process.env.MEMORY_FAILURE_LOG = failureLogFile;
});

afterEach(() => {
  if (savedFailureLog === undefined) delete process.env.MEMORY_FAILURE_LOG;
  else process.env.MEMORY_FAILURE_LOG = savedFailureLog;
});

function readFailureLines(): string[] {
  if (!existsSync(failureLogFile)) return [];
  return readFileSync(failureLogFile, "utf8").trim().split("\n").filter(Boolean);
}

describe("captureSessionEnd", () => {
  it("writes one chunk observation via writeObservations when transcript content is present", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["id-1"]);

    await captureSessionEnd(baseInput, {
      readTranscript: async () => "some transcript tail content",
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: AMPLE_BUDGET,
      writeObservations,
    });

    expect(writeObservations).toHaveBeenCalledTimes(1);
    expect(writeObservations).toHaveBeenCalledWith([
      {
        project: "myrepo-abc123",
        session_id: "sess-1",
        source: "transcript",
        priority: "normal",
        text: "some transcript tail content",
        chunk_index: 0,
        chunk_count: 1,
      },
    ]);
  });

  it("does not write when the transcript file is missing or unreadable", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["id-1"]);

    await captureSessionEnd(baseInput, {
      readTranscript: async () => null,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: AMPLE_BUDGET,
      writeObservations,
    });

    expect(writeObservations).not.toHaveBeenCalled();
  });

  it("fails open (never throws) when writeObservations rejects, and logs sessionEnd.captureError with the error's name only", async () => {
    const err = new Error("mongo is down");
    err.name = "MongoServerError";
    const writeObservations = vi.fn().mockRejectedValue(err);

    await expect(
      captureSessionEnd(baseInput, {
        readTranscript: async () => "some content",
        getProjectKey: () => "myrepo-abc123",
        transcriptCaptureMaxChars: AMPLE_BUDGET,
        writeObservations,
      })
    ).resolves.toBeUndefined();

    const lines = readFailureLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ sessionEnd\.captureError MongoServerError$/);
    // Name only, never the message: a driver message can embed connection details.
    expect(lines[0]).not.toContain("mongo is down");
  });

  it("fails open (never throws) when readTranscript rejects, simulating a hang/timeout upstream, and logs sessionEnd.captureError", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["id-1"]);

    await expect(
      captureSessionEnd(baseInput, {
        readTranscript: async () => {
          throw new Error("simulated timeout");
        },
        getProjectKey: () => "myrepo-abc123",
        transcriptCaptureMaxChars: AMPLE_BUDGET,
        writeObservations,
      })
    ).resolves.toBeUndefined();
    expect(writeObservations).not.toHaveBeenCalled();

    const lines = readFailureLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ sessionEnd\.captureError Error$/);
  });
});

describe("captureSessionEndWithTimeout", () => {
  it("returns outcome timeout and logs sessionEnd.timeout with a CaptureTimeout reason when the body exceeds the timeout budget, without abandoning the write", async () => {
    vi.useFakeTimers();
    const writeObservations = vi.fn().mockResolvedValue(["id-1"]);

    const resultPromise = captureSessionEndWithTimeout(
      baseInput,
      {
        readTranscript: () => new Promise(() => {}), // never resolves
        getProjectKey: () => "myrepo-abc123",
        transcriptCaptureMaxChars: AMPLE_BUDGET,
        writeObservations,
      },
      1000
    );

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.outcome).toBe("timeout");
    expect(result.pendingWrite).not.toBeNull();
    expect(writeObservations).not.toHaveBeenCalled();

    const lines = readFailureLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ sessionEnd\.timeout CaptureTimeout$/);
  });

  it("produces outcome completed, a null pendingWrite, and no new telemetry on the normal (non-timeout) fast path", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["id-1"]);

    const result = await captureSessionEndWithTimeout(
      baseInput,
      {
        readTranscript: async () => "some transcript tail content",
        getProjectKey: () => "myrepo-abc123",
        transcriptCaptureMaxChars: AMPLE_BUDGET,
        writeObservations,
      },
      5000
    );

    expect(result).toEqual({ outcome: "completed", pendingWrite: null });
    expect(writeObservations).toHaveBeenCalledTimes(1);
    expect(readFailureLines()).toHaveLength(0);
  });

  it("still logs sessionEnd.captureError (not a timeout) when the write rejects before the timeout, on the fast path", async () => {
    const err = new Error("mongo is down");
    err.name = "MongoServerError";
    const writeObservations = vi.fn().mockRejectedValue(err);

    const result = await captureSessionEndWithTimeout(
      baseInput,
      {
        readTranscript: async () => "some content",
        getProjectKey: () => "myrepo-abc123",
        transcriptCaptureMaxChars: AMPLE_BUDGET,
        writeObservations,
      },
      5000
    );

    expect(result).toEqual({ outcome: "completed", pendingWrite: null });
    const lines = readFailureLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ sessionEnd\.captureError MongoServerError$/);
  });

  it("awaits the pending write's real settlement before a simulated main()-style finally may run closeDb, and logs lateCapture once it lands", async () => {
    vi.useFakeTimers();
    let resolveWrite: (value: unknown) => void = () => {};
    const writeObservations = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        })
    );

    const resultPromise = captureSessionEndWithTimeout(
      baseInput,
      {
        readTranscript: async () => "some transcript tail content",
        getProjectKey: () => "myrepo-abc123",
        transcriptCaptureMaxChars: AMPLE_BUDGET,
        writeObservations,
      },
      1000
    );

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;
    expect(result.outcome).toBe("timeout");
    expect(result.pendingWrite).not.toBeNull();

    // Reproduces main()'s finally block exactly: await the pending write (if
    // any) before running closeDb, so a slow-but-successful insert is never
    // severed by connection teardown.
    const closeDbSpy = vi.fn();
    const order: string[] = [];
    const finallyPromise = (async () => {
      if (result.pendingWrite) await result.pendingWrite;
      order.push("closeDb");
      closeDbSpy();
    })();

    // The write has not resolved yet: closeDb must not have run.
    await Promise.resolve();
    await Promise.resolve();
    expect(closeDbSpy).not.toHaveBeenCalled();

    resolveWrite(["id-1"]);
    await finallyPromise;

    expect(order).toEqual(["closeDb"]);
    expect(closeDbSpy).toHaveBeenCalledTimes(1);

    const lines = readFailureLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ sessionEnd\.timeout CaptureTimeout$/);
    expect(lines[1]).toMatch(/ sessionEnd\.lateCapture CaptureLandedLate$/);
  });

  it("swallows a write that rejects after the timeout: pendingWrite still resolves cleanly, no unhandled rejection, hook can exit", async () => {
    vi.useFakeTimers();
    const writeObservations = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("mongo is down")), 5000);
        })
    );

    const resultPromise = captureSessionEndWithTimeout(
      baseInput,
      {
        readTranscript: async () => "some transcript tail content",
        getProjectKey: () => "myrepo-abc123",
        transcriptCaptureMaxChars: AMPLE_BUDGET,
        writeObservations,
      },
      1000
    );

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;
    expect(result.outcome).toBe("timeout");
    expect(result.pendingWrite).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4000);
    await expect(result.pendingWrite!).resolves.toBeUndefined();

    const lines = readFailureLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ sessionEnd\.timeout CaptureTimeout$/);
    expect(lines[1]).toMatch(/ sessionEnd\.captureError Error$/);
  });
});

describe("chunkTranscript", () => {
  it("returns one chunk with zero dropped chars when text is shorter than one chunk", () => {
    const result = chunkTranscript("short text", 100, 5);
    expect(result).toEqual({ chunks: ["short text"], droppedChars: 0 });
  });

  it("splits an exact multiple of chunkSize into full-size chunks with none dropped", () => {
    const text = "a".repeat(30);
    const result = chunkTranscript(text, 10, 5);
    expect(result.chunks).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(10)]);
    expect(result.droppedChars).toBe(0);
  });

  it("keeps every chunk when the chunk count exactly equals maxChunks", () => {
    const text = "a".repeat(10) + "b".repeat(10) + "c".repeat(10);
    const result = chunkTranscript(text, 10, 3);
    expect(result.chunks).toEqual(["a".repeat(10), "b".repeat(10), "c".repeat(10)]);
    expect(result.droppedChars).toBe(0);
  });

  it("keeps the first chunk plus the last (maxChunks - 1) chunks when count exceeds maxChunks (maxChunks >= 2), reporting the dropped middle", () => {
    const labels = ["A", "B", "C", "D", "E"]; // 5 chunks of 10 chars each
    const text = labels.map((c) => c.repeat(10)).join("");
    const result = chunkTranscript(text, 10, 3);
    // first (A) plus last 2 (D, E); B and C (20 chars total) are the dropped middle.
    expect(result.chunks).toEqual(["A".repeat(10), "D".repeat(10), "E".repeat(10)]);
    expect(result.droppedChars).toBe(20);
  });

  it("keeps only the LAST chunk when maxChunks is 1 (degenerate budget, preserves today's most-recent-wins semantics)", () => {
    const labels = ["A", "B", "C"];
    const text = labels.map((c) => c.repeat(10)).join("");
    const result = chunkTranscript(text, 10, 1);
    expect(result.chunks).toEqual(["C".repeat(10)]);
    expect(result.droppedChars).toBe(20);
  });

  it("returns an empty chunk list with zero dropped chars for empty text", () => {
    const result = chunkTranscript("", 10, 5);
    expect(result).toEqual({ chunks: [], droppedChars: 0 });
  });
});

// Builds a chunk-sized string with a distinctive, per-label marker repeated
// to fill it, so kept/dropped chunks can be identified by content in the
// captureSessionEnd chunking tests below without relying on chunk boundary
// arithmetic in the assertions themselves.
function makeLabeledChunk(label: string): string {
  const marker = `SECRET-${label}-`;
  const repeated = marker.repeat(Math.ceil(TRANSCRIPT_TAIL_LENGTH / marker.length));
  return repeated.slice(0, TRANSCRIPT_TAIL_LENGTH);
}

describe("captureSessionEnd chunking", () => {
  it("derives maxChunks 10 from a 500000 char budget and keeps the first chunk plus the last 9", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["ok"]);
    const labels = Array.from({ length: 12 }, (_, i) => String(i)); // 12 chunks total
    const raw = labels.map(makeLabeledChunk).join("");

    await captureSessionEnd(baseInput, {
      readTranscript: async () => raw,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: 500000,
      writeObservations,
    });

    expect(writeObservations).toHaveBeenCalledTimes(1);
    const paramsList = writeObservations.mock.calls[0][0] as Array<{
      text: string;
      chunk_index: number;
      chunk_count: number;
    }>;
    expect(paramsList).toHaveLength(10);
    expect(paramsList[0].text).toBe(makeLabeledChunk("0"));
    // The last 9 of the 12 total chunks are indices 3..11.
    expect(paramsList[1].text).toBe(makeLabeledChunk("3"));
    expect(paramsList[9].text).toBe(makeLabeledChunk("11"));
    paramsList.forEach((params, index) => {
      expect(params.chunk_index).toBe(index);
      expect(params.chunk_count).toBe(10);
    });
  });

  it("clamps a 49999 char budget down to a single, most-recent chunk", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["ok"]);
    const labels = ["0", "1", "2"];
    const raw = labels.map(makeLabeledChunk).join("");

    await captureSessionEnd(baseInput, {
      readTranscript: async () => raw,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: 49999,
      writeObservations,
    });

    expect(writeObservations).toHaveBeenCalledTimes(1);
    const paramsList = writeObservations.mock.calls[0][0] as Array<{
      text: string;
      chunk_index: number;
      chunk_count: number;
    }>;
    expect(paramsList).toHaveLength(1);
    expect(paramsList[0].text).toBe(makeLabeledChunk("2"));
    expect(paramsList[0].chunk_index).toBe(0);
    expect(paramsList[0].chunk_count).toBe(1);
  });

  it("produces one observation with chunk_index 0 and chunk_count 1 for a short transcript", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["ok"]);

    await captureSessionEnd(baseInput, {
      readTranscript: async () => "a short transcript",
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: AMPLE_BUDGET,
      writeObservations,
    });

    const paramsList = writeObservations.mock.calls[0][0] as Array<{
      chunk_index: number;
      chunk_count: number;
    }>;
    expect(paramsList).toHaveLength(1);
    expect(paramsList[0].chunk_index).toBe(0);
    expect(paramsList[0].chunk_count).toBe(1);
  });

  it("produces 3 ordered entries with correct chunk fields for a 3-chunk transcript", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["ok"]);
    const labels = ["0", "1", "2"];
    const raw = labels.map(makeLabeledChunk).join("");

    await captureSessionEnd(baseInput, {
      readTranscript: async () => raw,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: AMPLE_BUDGET,
      writeObservations,
    });

    const paramsList = writeObservations.mock.calls[0][0] as Array<{
      text: string;
      chunk_index: number;
      chunk_count: number;
    }>;
    expect(paramsList).toHaveLength(3);
    labels.forEach((label, index) => {
      expect(paramsList[index].text).toBe(makeLabeledChunk(label));
      expect(paramsList[index].chunk_index).toBe(index);
      expect(paramsList[index].chunk_count).toBe(3);
    });
  });

  it("logs exactly one drop line with counts only (never content) when the transcript exceeds the budget", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["ok"]);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const labels = Array.from({ length: 12 }, (_, i) => String(i));
    const raw = labels.map(makeLabeledChunk).join("");

    await captureSessionEnd(baseInput, {
      readTranscript: async () => raw,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: 500000,
      writeObservations,
    });

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = consoleErrorSpy.mock.calls.map((call) => call.join(" ")).join(" ");
    // Chunks labeled 1 and 2 are the ones dropped; their content must never
    // reach the log line, only counts.
    expect(logged).not.toContain("SECRET-1-");
    expect(logged).not.toContain("SECRET-2-");
    expect(logged).toContain("100000"); // droppedChars: 2 dropped chunks * 50000 chars each

    consoleErrorSpy.mockRestore();
  });

  it("strips brief content spanning a chunk boundary before chunking, so no captured chunk contains any part of it", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["ok"]);
    // 50 chars, placed so it straddles the boundary between chunk 0 and
    // chunk 1: if stripping ran per-chunk (after splitting) instead of on
    // the full transcript first, neither chunk would contain the FULL
    // marker string, so stripInjectedBriefs's exact-match removal would
    // miss both truncated halves and leak them.
    const marker = "MARKERSTART" + "Q".repeat(30) + "MARKEREND";
    const prefix = "p".repeat(TRANSCRIPT_TAIL_LENGTH - 20);
    const suffix = "s".repeat(TRANSCRIPT_TAIL_LENGTH);
    const raw = prefix + marker + suffix;

    await captureSessionEnd(baseInput, {
      readTranscript: async () => raw,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: AMPLE_BUDGET,
      getBriefs: async () => ({ global: marker, project: null }),
      writeObservations,
    });

    expect(writeObservations).toHaveBeenCalledTimes(1);
    const paramsList = writeObservations.mock.calls[0][0] as Array<{ text: string }>;
    for (const params of paramsList) {
      expect(params.text).not.toContain("MARKERSTART");
      expect(params.text).not.toContain("MARKEREND");
    }
  });
});

describe("stripInjectedBriefs", () => {
  const longBrief = "Prefers pnpm over npm. This repo's CI gate is npm run build && npm test."; // 73 chars

  it("strips one injected brief block from the tail", () => {
    const tail = `user: hello\n${longBrief}\nassistant: working on it`;
    const result = stripInjectedBriefs(tail, [longBrief]);
    expect(result).toBe("user: hello\n\nassistant: working on it");
    expect(result).not.toContain("Prefers pnpm");
  });

  it("strips multiple brief blocks and repeated occurrences", () => {
    const projectBrief = "Always run migrations before seeding the development database in orderflow.";
    const tail = `${longBrief}\nsome work\n${projectBrief}\nmore work\n${longBrief}`;
    const result = stripInjectedBriefs(tail, [longBrief, projectBrief]);
    expect(result).not.toContain("Prefers pnpm");
    expect(result).not.toContain("Always run migrations");
    expect(result).toContain("some work");
    expect(result).toContain("more work");
  });

  it("does not strip briefs shorter than the minimum length (tiny common substrings)", () => {
    const shortBrief = "npm test"; // well under 40 chars
    const tail = "the CI gate runs npm test on every push";
    expect(stripInjectedBriefs(tail, [shortBrief])).toBe(tail);
  });

  it("tolerates null/undefined brief contents", () => {
    const tail = "plain transcript content";
    expect(stripInjectedBriefs(tail, [null, undefined])).toBe(tail);
  });

  it("strips a brief from a transcript tail where the brief's newline is JSON-escaped (real serialized form)", () => {
    const brief = "Line one of the brief.\nLine two adds more context so it clears the minimum length.";
    const escapedBrief = JSON.stringify(brief).slice(1, -1);
    const tail = `some earlier turn\n${escapedBrief}\nassistant: continuing work`;

    const result = stripInjectedBriefs(tail, [brief]);

    expect(result).not.toContain(escapedBrief);
    expect(result).toContain("some earlier turn");
    expect(result).toContain("assistant: continuing work");
  });
});

describe("captureSessionEnd brief stripping", () => {
  const brief = "Prefers pnpm over npm. This repo's CI gate is npm run build && npm test.";

  it("strips the injected brief content from the captured transcript when getBriefs resolves", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["id-1"]);

    await captureSessionEnd(baseInput, {
      readTranscript: async () => `context: ${brief} then real work happened`,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: AMPLE_BUDGET,
      getBriefs: async () => ({ global: brief, project: null }),
      writeObservations,
    });

    expect(writeObservations).toHaveBeenCalledTimes(1);
    const paramsList = writeObservations.mock.calls[0][0] as Array<{ text: string }>;
    expect(paramsList[0].text).not.toContain("Prefers pnpm");
    expect(paramsList[0].text).toContain("then real work happened");
  });

  it("skips the write entirely when stripping leaves nothing but whitespace", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["id-1"]);

    await captureSessionEnd(baseInput, {
      readTranscript: async () => `  ${brief}  `,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: AMPLE_BUDGET,
      getBriefs: async () => ({ global: brief, project: null }),
      writeObservations,
    });

    expect(writeObservations).not.toHaveBeenCalled();
  });

  it("captures unstripped (fail-open) when getBriefs rejects", async () => {
    const writeObservations = vi.fn().mockResolvedValue(["id-1"]);
    const tail = `context: ${brief} then real work happened`;

    await captureSessionEnd(baseInput, {
      readTranscript: async () => tail,
      getProjectKey: () => "myrepo-abc123",
      transcriptCaptureMaxChars: AMPLE_BUDGET,
      getBriefs: async () => {
        throw new Error("mongo is down");
      },
      writeObservations,
    });

    expect(writeObservations).toHaveBeenCalledTimes(1);
    const paramsList = writeObservations.mock.calls[0][0] as Array<{ text: string }>;
    expect(paramsList[0].text).toBe(tail);
  });
});
