import { describe, it, expect, vi, afterEach } from "vitest";
import {
  captureSessionEnd,
  captureSessionEndWithTimeout,
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
