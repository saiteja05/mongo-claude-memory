import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAdditionalContext, type SessionStartInput } from "../src/hooks/sessionStart.js";

const baseInput: SessionStartInput = {
  session_id: "sess-1",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/some/repo",
  hook_event_name: "SessionStart",
  source: "startup",
};

let savedFailureLog: string | undefined;

beforeEach(() => {
  // buildAdditionalContext's cache-fallback path calls appendFailure, which
  // otherwise defaults to writing under the real ~/.mongo-claude-memory;
  // point it at a scratch file so these tests never touch that.
  savedFailureLog = process.env.MEMORY_FAILURE_LOG;
  process.env.MEMORY_FAILURE_LOG = path.join(
    mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-sessionstart-")),
    "failures.log"
  );
});

afterEach(() => {
  if (savedFailureLog === undefined) delete process.env.MEMORY_FAILURE_LOG;
  else process.env.MEMORY_FAILURE_LOG = savedFailureLog;
});

describe("buildAdditionalContext", () => {
  it("combines global and project briefs when both are present", async () => {
    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache: vi.fn(),
      readBriefCache: vi.fn(),
      getBriefs: async () => ({
        global: "Global facts.",
        project: "Project facts.",
        source: "fetched",
      }),
    });

    expect(result).toBe("Global facts.\n\nProject facts.");
  });

  it("returns only the global brief when the project brief is absent", async () => {
    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache: vi.fn(),
      readBriefCache: vi.fn(),
      getBriefs: async () => ({ global: "Global facts.", project: null, source: "fetched" }),
    });

    expect(result).toBe("Global facts.");
  });

  it("returns only the project brief when the global brief is absent", async () => {
    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache: vi.fn(),
      readBriefCache: vi.fn(),
      getBriefs: async () => ({ global: null, project: "Project facts.", source: "fetched" }),
    });

    expect(result).toBe("Project facts.");
  });

  it("returns null, and never reads the cache, on a healthy empty fetch (source: fetched, both null)", async () => {
    const readBriefCache = vi.fn();

    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache: vi.fn(),
      readBriefCache,
      getBriefs: async () => ({ global: null, project: null, source: "fetched" }),
    });

    expect(result).toBeNull();
    // A healthy connection that legitimately has nothing to say (new or
    // fully-forgotten project) must not resurrect old cached content.
    expect(readBriefCache).not.toHaveBeenCalled();
  });

  it("fails open (returns null, never throws) when getBriefs rejects and there is no cache entry", async () => {
    const getBriefs = vi.fn().mockRejectedValue(new Error("simulated timeout"));
    const readBriefCache = vi.fn(() => null);

    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache: vi.fn(),
      readBriefCache,
      getBriefs,
    });

    expect(result).toBeNull();
    expect(getBriefs).toHaveBeenCalledWith("myrepo-abc123", 800);
  });

  it("calls writeBriefCache with the project key and briefs after a successful fetch with content", async () => {
    const writeBriefCache = vi.fn();
    const briefs = {
      global: "Global facts.",
      project: "Project facts.",
      source: "fetched" as const,
      generatedAt: "2026-07-01T00:00:00.000Z",
    };

    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache,
      readBriefCache: vi.fn(),
      getBriefs: async () => briefs,
    });

    expect(result).toBe("Global facts.\n\nProject facts.");
    expect(writeBriefCache).toHaveBeenCalledWith("myrepo-abc123", briefs);
  });

  it("does not throw, and still returns the live content, when the writeBriefCache dep itself throws", async () => {
    const writeBriefCache = vi.fn(() => {
      throw new Error("disk full");
    });

    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache,
      readBriefCache: vi.fn(),
      getBriefs: async () => ({ global: "Global facts.", project: null, source: "fetched" }),
    });

    expect(result).toBe("Global facts.");
    expect(writeBriefCache).toHaveBeenCalledTimes(1);
  });

  it("falls back to the local cache, annotated, when the fetch times out and a cache entry exists", async () => {
    const cached = {
      global: "Cached global facts.",
      project: null,
      generatedAt: "2026-07-01T00:00:00.000Z",
      cachedAt: "2026-07-10T00:00:00.000Z",
    };

    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache: vi.fn(),
      readBriefCache: () => cached,
      getBriefs: async () => ({ global: null, project: null, source: "timeout" }),
    });

    expect(result).not.toBeNull();
    const noticeIndex = result!.indexOf("memory notice");
    const cachedAtIndex = result!.indexOf(cached.cachedAt);
    const generatedAtIndex = result!.indexOf(cached.generatedAt);
    const bodyIndex = result!.indexOf(cached.global);
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(cachedAtIndex).toBeGreaterThan(noticeIndex);
    expect(generatedAtIndex).toBeGreaterThan(noticeIndex);
    // The annotation is a leading line, then a blank line, then the cached
    // body: the body must come strictly after the notice.
    expect(bodyIndex).toBeGreaterThan(noticeIndex);
    expect(result).toContain("[memory notice:");
    expect(result!.split("\n\n")[0]).toContain("memory notice");
    expect(result!.split("\n\n")[1]).toBe("Cached global facts.");
  });

  it("falls back to the local cache, annotated with 'unknown' compiled time, when the fetch errors and a cache entry exists", async () => {
    const cached = {
      global: null,
      project: "Cached project facts.",
      generatedAt: null,
      cachedAt: "2026-07-11T00:00:00.000Z",
    };

    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache: vi.fn(),
      readBriefCache: () => cached,
      getBriefs: async () => ({ global: null, project: null, source: "error" }),
    });

    expect(result).not.toBeNull();
    expect(result).toContain(cached.cachedAt);
    expect(result).toContain("compiled unknown");
    expect(result!.split("\n\n")[1]).toBe("Cached project facts.");
  });

  it("returns null when the fetch times out and there is no cache entry (cache miss)", async () => {
    const readBriefCache = vi.fn(() => null);

    const result = await buildAdditionalContext(baseInput, {
      getProjectKey: () => "myrepo-abc123",
      sessionStartTimeoutMs: 800,
      briefCacheMaxAgeDays: 7,
      writeBriefCache: vi.fn(),
      readBriefCache,
      getBriefs: async () => ({ global: null, project: null, source: "timeout" }),
    });

    expect(result).toBeNull();
    expect(readBriefCache).toHaveBeenCalledWith("myrepo-abc123", 7);
  });
});
