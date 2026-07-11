import { describe, it, expect, vi } from "vitest";
import { buildAdditionalContext, type SessionStartInput } from "../src/hooks/sessionStart.js";

const baseInput: SessionStartInput = {
  session_id: "sess-1",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/some/repo",
  hook_event_name: "SessionStart",
  source: "startup",
};

describe("buildAdditionalContext", () => {
  it("combines global and project briefs when both are present", async () => {
    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      getBriefs: async () => ({ global: "Global facts.", project: "Project facts." }),
    });

    expect(result).toBe("Global facts.\n\nProject facts.");
  });

  it("returns only the global brief when the project brief is absent", async () => {
    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      getBriefs: async () => ({ global: "Global facts.", project: null }),
    });

    expect(result).toBe("Global facts.");
  });

  it("returns only the project brief when the global brief is absent", async () => {
    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      getBriefs: async () => ({ global: null, project: "Project facts." }),
    });

    expect(result).toBe("Project facts.");
  });

  it("returns null when neither brief is present (no output)", async () => {
    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      getBriefs: async () => ({ global: null, project: null }),
    });

    expect(result).toBeNull();
  });

  it("fails open (returns null, never throws) when getBriefs rejects, simulating a timeout", async () => {
    const getBriefs = vi.fn().mockRejectedValue(new Error("simulated timeout"));

    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      getBriefs,
    });

    expect(result).toBeNull();
    expect(getBriefs).toHaveBeenCalledWith("myrepo-abc123", 800);
  });
});
