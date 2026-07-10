import { describe, it, expect, vi } from "vitest";
import { runRemember } from "../src/capture/remember.js";

describe("runRemember", () => {
  it("returns a usage error and does not call writeObservation for empty text", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    const result = await runRemember("", "/some/repo", {
      hasMongoConfig: () => true,
      getProjectKey: () => "myrepo-abc123",
      writeObservation,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/usage/i);
    expect(writeObservation).not.toHaveBeenCalled();
  });

  it("returns a clear error and does not call writeObservation when Mongo is not configured", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    const result = await runRemember("remember this fact", "/some/repo", {
      hasMongoConfig: () => false,
      getProjectKey: () => "myrepo-abc123",
      writeObservation,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/not configured/i);
    expect(writeObservation).not.toHaveBeenCalled();
  });

  it("writes a high-priority remember observation and reports success", async () => {
    const writeObservation = vi.fn().mockResolvedValue("id-1");

    const result = await runRemember("remember this fact", "/some/repo", {
      hasMongoConfig: () => true,
      getProjectKey: () => "myrepo-abc123",
      writeObservation,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("myrepo-abc123");
    expect(writeObservation).toHaveBeenCalledWith({
      project: "myrepo-abc123",
      session_id: "cli:remember",
      source: "remember",
      priority: "high",
      text: "remember this fact",
    });
  });

  it("reports a clear, secret-free error and does not throw when writeObservation rejects", async () => {
    const writeObservation = vi
      .fn()
      .mockRejectedValue(new Error("connection failed: mongodb+srv://user:secret@cluster/"));

    const result = await runRemember("remember this fact", "/some/repo", {
      hasMongoConfig: () => true,
      getProjectKey: () => "myrepo-abc123",
      writeObservation,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toBeDefined();
    expect(result.stderr).not.toContain("secret");
    expect(result.stderr).not.toContain("mongodb+srv://");
  });
});
