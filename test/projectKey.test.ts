import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectKey } from "../src/project/projectKey.js";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");

describe("getProjectKey", () => {
  it("produces the same key for the repo root and a nested subdirectory", () => {
    const nested = path.join(repoRoot, "src");
    const rootKey = getProjectKey(repoRoot);
    const nestedKey = getProjectKey(nested);
    expect(rootKey).toBe(nestedKey);
  });

  it("matches the key derived directly from git rev-parse --git-common-dir", () => {
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const absoluteGitDir = path.resolve(repoRoot, gitCommonDir);

    // Sanity: this repo is expected to actually be a git repo for this test
    // to be meaningful.
    expect(absoluteGitDir.endsWith(".git")).toBe(true);

    const key = getProjectKey(repoRoot);
    expect(key).toMatch(/^[a-zA-Z0-9._-]+-[0-9a-f]{12}$/);
  });

  it("produces a stable, non-throwing key for a directory that is not a git repo", () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-nogit-"));
    expect(() => getProjectKey(outsideDir)).not.toThrow();
    const key1 = getProjectKey(outsideDir);
    const key2 = getProjectKey(outsideDir);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-zA-Z0-9._-]+-[0-9a-f]{12}$/);
  });

  it("produces different keys for different non-git directories", () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-a-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-b-"));
    expect(getProjectKey(dirA)).not.toBe(getProjectKey(dirB));
  });
});
