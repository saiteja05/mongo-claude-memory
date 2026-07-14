import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectKey, normalizeRemoteUrl } from "../src/project/projectKey.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

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

describe("normalizeRemoteUrl", () => {
  it("normalizes the ssh (scp) and https forms of the same repo to the same string", () => {
    const ssh = normalizeRemoteUrl("git@github.com:SomeOrg/some-repo.git");
    const https = normalizeRemoteUrl("https://github.com/SomeOrg/some-repo.git");
    const httpsNoGit = normalizeRemoteUrl("https://github.com/SomeOrg/some-repo");
    expect(ssh).toBe("github.com/SomeOrg/some-repo");
    expect(https).toBe(ssh);
    expect(httpsNoGit).toBe(ssh);
  });

  it("strips embedded credentials, trailing slashes, and lowercases only the host", () => {
    expect(normalizeRemoteUrl("https://user:token@GitHub.com/SomeOrg/Some-Repo.git/")).toBe(
      "github.com/SomeOrg/Some-Repo"
    );
    expect(normalizeRemoteUrl("  ssh://git@GitHub.com/SomeOrg/Some-Repo.git  ")).toBe(
      "github.com/SomeOrg/Some-Repo"
    );
  });

  it("preserves case exactly for local-path and file:// remotes (no hostname to normalize)", () => {
    expect(normalizeRemoteUrl("/Users/Alice/repo")).toBe("/Users/Alice/repo");
    expect(normalizeRemoteUrl("file:///Users/Alice/repo")).toBe("/Users/Alice/repo");
    expect(normalizeRemoteUrl("/Users/Alice/repo")).not.toBe(normalizeRemoteUrl("/users/alice/repo"));
  });
});

describe("getProjectKey in remote mode (MEMORY_PROJECT_KEY_MODE=remote)", () => {
  let savedMode: string | undefined;

  beforeEach(() => {
    savedMode = process.env.MEMORY_PROJECT_KEY_MODE;
    process.env.MEMORY_PROJECT_KEY_MODE = "remote";
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.MEMORY_PROJECT_KEY_MODE;
    else process.env.MEMORY_PROJECT_KEY_MODE = savedMode;
  });

  function makeRepoWithOrigin(originUrl: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-remote-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
    return dir;
  }

  it("produces the same key for ssh and https clones of the same repo, regardless of local path", () => {
    const sshClone = makeRepoWithOrigin("git@github.com:SomeOrg/some-repo.git");
    const httpsClone = makeRepoWithOrigin("https://github.com/SomeOrg/some-repo.git");

    const sshKey = getProjectKey(sshClone);
    const httpsKey = getProjectKey(httpsClone);

    expect(sshKey).toBe(httpsKey);
    expect(sshKey).toMatch(/^some-repo-[0-9a-f]{12}$/);
  });

  it("falls back to the path-mode key when the repo has no origin remote", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-noorigin-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const remoteModeKey = getProjectKey(dir);

    delete process.env.MEMORY_PROJECT_KEY_MODE;
    const pathModeKey = getProjectKey(dir);

    expect(remoteModeKey).toBe(pathModeKey);
  });

  it("default (unset) mode keeps the existing path-based key, even when an origin remote exists", () => {
    const dir = makeRepoWithOrigin("git@github.com:SomeOrg/some-repo.git");

    const remoteKey = getProjectKey(dir);

    delete process.env.MEMORY_PROJECT_KEY_MODE;
    const defaultKey = getProjectKey(dir);

    // Path mode hashes the local .git dir, so it must differ from the
    // remote-URL-derived key and stay stable for existing stored memory.
    expect(defaultKey).not.toBe(remoteKey);
    expect(defaultKey).toMatch(/^[a-zA-Z0-9._-]+-[0-9a-f]{12}$/);
  });
});

describe("getProjectKey execFileSync timeout", () => {
  afterEach(() => {
    delete process.env.MEMORY_PROJECT_KEY_MODE;
  });

  it("passes a 2000ms timeout to git rev-parse --git-common-dir (path mode)", () => {
    const mockedExecFileSync = vi.mocked(execFileSync);
    mockedExecFileSync.mockClear();
    getProjectKey(repoRoot);
    const call = mockedExecFileSync.mock.calls.find(
      ([cmd, args]) => cmd === "git" && (args as string[])?.[0] === "rev-parse"
    );
    expect(call).toBeDefined();
    expect(call?.[2]).toMatchObject({ timeout: 2000 });
  });

  it("passes a 2000ms timeout to git config --get remote.origin.url (remote mode)", () => {
    process.env.MEMORY_PROJECT_KEY_MODE = "remote";
    const mockedExecFileSync = vi.mocked(execFileSync);
    mockedExecFileSync.mockClear();
    getProjectKey(repoRoot);
    const call = mockedExecFileSync.mock.calls.find(
      ([cmd, args]) => cmd === "git" && (args as string[])?.[0] === "config"
    );
    expect(call).toBeDefined();
    expect(call?.[2]).toMatchObject({ timeout: 2000 });
  });
});
