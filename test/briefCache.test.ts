import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  briefCacheDir,
  writeBriefCache,
  readBriefCache,
  deleteBriefCache,
} from "../src/briefs/briefCache.js";
import type { BriefResult } from "../src/briefs/fetchBrief.js";

let savedEnv: string | undefined;
let dir: string;

beforeEach(() => {
  savedEnv = process.env.MEMORY_BRIEF_CACHE_DIR;
  dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-briefcache-"));
  process.env.MEMORY_BRIEF_CACHE_DIR = dir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MEMORY_BRIEF_CACHE_DIR;
  else process.env.MEMORY_BRIEF_CACHE_DIR = savedEnv;
});

const sampleBriefs: BriefResult = {
  global: "Global brief content.",
  project: "Project brief content.",
  source: "fetched",
  generatedAt: "2026-07-01T00:00:00.000Z",
};

describe("briefCacheDir", () => {
  it("honors MEMORY_BRIEF_CACHE_DIR", () => {
    expect(briefCacheDir()).toBe(dir);
  });

  it("defaults to ~/.mongo-claude-memory/brief-cache when unset", () => {
    delete process.env.MEMORY_BRIEF_CACHE_DIR;
    expect(briefCacheDir()).toMatch(/\.mongo-claude-memory[/\\]brief-cache$/);
  });
});

describe("writeBriefCache / readBriefCache round trip", () => {
  it("round-trips global, project, and generatedAt", () => {
    writeBriefCache("myrepo-abc123", sampleBriefs);
    const result = readBriefCache("myrepo-abc123", 7);

    expect(result).not.toBeNull();
    expect(result?.global).toBe("Global brief content.");
    expect(result?.project).toBe("Project brief content.");
    expect(result?.generatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(typeof result?.cachedAt).toBe("string");
  });

  it("writes the cache file with mode 0600 (POSIX only)", () => {
    if (process.platform === "win32") return;
    writeBriefCache("myrepo-abc123", sampleBriefs);
    const file = path.join(dir, "myrepo-abc123.json");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null once cached_at is older than maxAgeDays", () => {
    writeBriefCache("myrepo-abc123", sampleBriefs);
    const file = path.join(dir, "myrepo-abc123.json");
    const stale = JSON.parse(readFileSync(file, "utf8"));
    stale.cached_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(file, JSON.stringify(stale), "utf8");

    expect(readBriefCache("myrepo-abc123", 7)).toBeNull();
  });

  it("returns null when maxAgeDays is 0, even for a freshly written file (reads disabled)", () => {
    writeBriefCache("myrepo-abc123", sampleBriefs);
    expect(readBriefCache("myrepo-abc123", 0)).toBeNull();
  });

  it("returns null on corrupt JSON without throwing", () => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "myrepo-abc123.json");
    writeFileSync(file, "{not valid json", "utf8");

    expect(() => readBriefCache("myrepo-abc123", 7)).not.toThrow();
    expect(readBriefCache("myrepo-abc123", 7)).toBeNull();
  });

  it("returns null when cached_at is missing or not a string", () => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "myrepo-abc123.json");
    writeFileSync(file, JSON.stringify({ global: "g", project: null }), "utf8");

    expect(readBriefCache("myrepo-abc123", 7)).toBeNull();
  });

  it("skips writing when the serialized payload exceeds the size cap (no file created)", () => {
    const huge: BriefResult = {
      global: "x".repeat(300000),
      project: null,
      source: "fetched",
    };
    writeBriefCache("oversized-project", huge);
    expect(existsSync(path.join(dir, "oversized-project.json"))).toBe(false);
  });

  it("refuses an oversized pre-existing file on read, without truncating it", () => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "oversized-project.json");
    writeFileSync(file, "x".repeat(300000), "utf8");

    expect(readBriefCache("oversized-project", 7)).toBeNull();
    expect(statSync(file).size).toBe(300000);
  });

  it("sanitizes a project key with path separators so it cannot escape the cache dir", () => {
    writeBriefCache("../../etc/passwd", sampleBriefs);

    const entries = readdirSync(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain("/");
    expect(entries[0]).not.toContain("\\");
    expect(readBriefCache("../../etc/passwd", 7)?.global).toBe("Global brief content.");
  });

  it("writes nothing when both global and project are null", () => {
    writeBriefCache("empty-project", { global: null, project: null, source: "fetched" });
    expect(existsSync(path.join(dir, "empty-project.json"))).toBe(false);
  });
});

describe("deleteBriefCache", () => {
  it("removes a previously written cache file", () => {
    writeBriefCache("myrepo-abc123", sampleBriefs);
    deleteBriefCache("myrepo-abc123");
    expect(existsSync(path.join(dir, "myrepo-abc123.json"))).toBe(false);
  });

  it("is silent when there is nothing to delete", () => {
    expect(() => deleteBriefCache("never-existed")).not.toThrow();
  });
});
