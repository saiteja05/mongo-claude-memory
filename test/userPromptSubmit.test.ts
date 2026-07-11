import { describe, it, expect, vi } from "vitest";
import {
  shouldCaptureAsHashLine,
  captureUserPromptSubmit,
  type UserPromptSubmitInput,
} from "../src/hooks/userPromptSubmit.js";

describe("shouldCaptureAsHashLine", () => {
  it("returns true for a prompt starting with # and more content", () => {
    expect(shouldCaptureAsHashLine("#remember this")).toBe(true);
  });

  it("returns true when there is leading whitespace before the #", () => {
    expect(shouldCaptureAsHashLine("  # remember this")).toBe(true);
  });

  it("returns false for a bare lone #", () => {
    expect(shouldCaptureAsHashLine("#")).toBe(false);
  });

  it("returns false for # followed only by whitespace", () => {
    expect(shouldCaptureAsHashLine("#   ")).toBe(false);
  });

  it("returns false when the prompt does not start with #", () => {
    expect(shouldCaptureAsHashLine("hello # not a hash line")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(shouldCaptureAsHashLine("")).toBe(false);
  });
});

const baseInput: UserPromptSubmitInput = {
  session_id: "sess-1",
  prompt_id: "prompt-1",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/some/repo",
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  prompt: "",
};

describe("captureUserPromptSubmit", () => {
  it("writes a high-priority hash_line observation for a hash-line prompt", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    await captureUserPromptSubmit(
      { ...baseInput, prompt: "#remember this fact" },
      { getProjectKey: () => "myrepo-abc123", writeObservation }
    );

    expect(writeObservation).toHaveBeenCalledTimes(1);
    expect(writeObservation).toHaveBeenCalledWith({
      project: "myrepo-abc123",
      session_id: "sess-1",
      source: "hash_line",
      priority: "high",
      text: "#remember this fact",
    });
  });

  it("does not write for a normal (non-hash-line) prompt", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    await captureUserPromptSubmit(
      { ...baseInput, prompt: "please fix this bug" },
      { getProjectKey: () => "myrepo-abc123", writeObservation }
    );

    expect(writeObservation).not.toHaveBeenCalled();
  });

  it("falls back to the legacy prompt_text field when prompt is absent", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    const legacyInput = {
      ...baseInput,
      prompt_text: "#legacy hash line capture",
    } as UserPromptSubmitInput;
    delete (legacyInput as Partial<UserPromptSubmitInput>).prompt;

    await captureUserPromptSubmit(legacyInput, {
      getProjectKey: () => "myrepo-abc123",
      writeObservation,
    });

    expect(writeObservation).toHaveBeenCalledTimes(1);
    expect(writeObservation).toHaveBeenCalledWith({
      project: "myrepo-abc123",
      session_id: "sess-1",
      source: "hash_line",
      priority: "high",
      text: "#legacy hash line capture",
    });
  });

  it("prefers prompt over prompt_text when both are present", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    await captureUserPromptSubmit(
      { ...baseInput, prompt: "#current field wins", prompt_text: "#stale legacy value" },
      { getProjectKey: () => "myrepo-abc123", writeObservation }
    );

    expect(writeObservation).toHaveBeenCalledTimes(1);
    expect(writeObservation).toHaveBeenCalledWith(
      expect.objectContaining({ text: "#current field wins" })
    );
  });

  it("fails open (never throws) when writeObservation rejects", async () => {
    const writeObservation = vi.fn().mockRejectedValue(new Error("mongo is down"));

    await expect(
      captureUserPromptSubmit(
        { ...baseInput, prompt: "#remember this fact" },
        { getProjectKey: () => "myrepo-abc123", writeObservation }
      )
    ).resolves.toBeUndefined();
  });
});
