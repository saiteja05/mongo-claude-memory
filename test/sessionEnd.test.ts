import { describe, it, expect, vi, afterEach } from "vitest";
import {
  captureSessionEnd,
  captureSessionEndWithTimeout,
  stripInjectedBriefs,
  type SessionEndInput,
} from "../src/hooks/sessionEnd.js";

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

describe("captureSessionEnd", () => {
  it("writes one transcript observation when transcript content is present", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    await captureSessionEnd(baseInput, {
      readTranscriptTail: async () => "some transcript tail content",
      getProjectKey: () => "myrepo-abc123",
      writeObservation,
    });

    expect(writeObservation).toHaveBeenCalledTimes(1);
    expect(writeObservation).toHaveBeenCalledWith({
      project: "myrepo-abc123",
      session_id: "sess-1",
      source: "transcript",
      priority: "normal",
      text: "some transcript tail content",
    });
  });

  it("does not write when the transcript file is missing or unreadable", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    await captureSessionEnd(baseInput, {
      readTranscriptTail: async () => null,
      getProjectKey: () => "myrepo-abc123",
      writeObservation,
    });

    expect(writeObservation).not.toHaveBeenCalled();
  });

  it("fails open (never throws) when writeObservation rejects", async () => {
    const writeObservation = vi.fn().mockRejectedValue(new Error("mongo is down"));

    await expect(
      captureSessionEnd(baseInput, {
        readTranscriptTail: async () => "some content",
        getProjectKey: () => "myrepo-abc123",
        writeObservation,
      })
    ).resolves.toBeUndefined();
  });

  it("fails open (never throws) when readTranscriptTail rejects, simulating a hang/timeout upstream", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    await expect(
      captureSessionEnd(baseInput, {
        readTranscriptTail: async () => {
          throw new Error("simulated timeout");
        },
        getProjectKey: () => "myrepo-abc123",
        writeObservation,
      })
    ).resolves.toBeUndefined();
    expect(writeObservation).not.toHaveBeenCalled();
  });

  it("fails open when the body exceeds the timeout budget (simulated hang)", async () => {
    vi.useFakeTimers();
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    const resultPromise = captureSessionEndWithTimeout(
      baseInput,
      {
        readTranscriptTail: () => new Promise(() => {}), // never resolves
        getProjectKey: () => "myrepo-abc123",
        writeObservation,
      },
      1000
    );

    await vi.advanceTimersByTimeAsync(1000);
    await expect(resultPromise).resolves.toBeUndefined();
    expect(writeObservation).not.toHaveBeenCalled();
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
});

describe("captureSessionEnd brief stripping", () => {
  const brief = "Prefers pnpm over npm. This repo's CI gate is npm run build && npm test.";

  it("strips the injected brief content from the captured tail when getBriefs resolves", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    await captureSessionEnd(baseInput, {
      readTranscriptTail: async () => `context: ${brief} then real work happened`,
      getProjectKey: () => "myrepo-abc123",
      getBriefs: async () => ({ global: brief, project: null }),
      writeObservation,
    });

    expect(writeObservation).toHaveBeenCalledTimes(1);
    const params = writeObservation.mock.calls[0][0] as { text: string };
    expect(params.text).not.toContain("Prefers pnpm");
    expect(params.text).toContain("then real work happened");
  });

  it("skips the write entirely when stripping leaves nothing but whitespace", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    await captureSessionEnd(baseInput, {
      readTranscriptTail: async () => `  ${brief}  `,
      getProjectKey: () => "myrepo-abc123",
      getBriefs: async () => ({ global: brief, project: null }),
      writeObservation,
    });

    expect(writeObservation).not.toHaveBeenCalled();
  });

  it("captures unstripped (fail-open) when getBriefs rejects", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");
    const tail = `context: ${brief} then real work happened`;

    await captureSessionEnd(baseInput, {
      readTranscriptTail: async () => tail,
      getProjectKey: () => "myrepo-abc123",
      getBriefs: async () => {
        throw new Error("mongo is down");
      },
      writeObservation,
    });

    expect(writeObservation).toHaveBeenCalledTimes(1);
    const params = writeObservation.mock.calls[0][0] as { text: string };
    expect(params.text).toBe(tail);
  });
});
