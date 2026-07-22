import { describe, it, expect, vi, afterEach } from "vitest";
import type { Db } from "mongodb";
import { mkdtempSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  shouldCaptureAsHashLine,
  captureUserPromptSubmit,
  runUserPromptSubmitHook,
  type UserPromptSubmitInput,
} from "../src/hooks/userPromptSubmit.js";

// Used only by the real-subprocess regression test below: locates the
// already-built dist/ tree so it can be reached through a directory symlink
// created purely for that one test.
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");
const distDir = path.join(repoRoot, "dist");

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

describe("runUserPromptSubmitHook", () => {
  const fakeDb = {} as Db;

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeps(overrides: Partial<Parameters<typeof runUserPromptSubmitHook>[1]> = {}) {
    return {
      getDb: vi.fn(async () => fakeDb),
      writeObservation: vi.fn(async () => "id-1" as unknown),
      getProjectKey: () => "myrepo-abc123",
      hookWriteTimeoutMs: 5000,
      ...overrides,
    };
  }

  it("returns skipped for a non-# prompt and never touches the DB", async () => {
    const deps = makeDeps();

    const { outcome } = await runUserPromptSubmitHook(
      { ...baseInput, prompt: "please fix this bug" },
      deps
    );

    expect(outcome).toBe("skipped");
    expect(deps.getDb).not.toHaveBeenCalled();
    expect(deps.writeObservation).not.toHaveBeenCalled();
  });

  it("lands a hash-line write that takes 2s, well beyond the old 800ms race budget", async () => {
    vi.useFakeTimers();
    const writeObservation = vi.fn(
      (_db: Db, _params: unknown) =>
        new Promise((resolve) => setTimeout(() => resolve("id-1"), 2000))
    );
    const deps = makeDeps({ writeObservation: writeObservation as never });

    const pending = runUserPromptSubmitHook({ ...baseInput, prompt: "#remember this fact" }, deps);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await pending;
    expect(result.outcome).toBe("written");
    expect(result.pendingWrite).toBeNull();
    expect(writeObservation).toHaveBeenCalledTimes(1);
    const [, params] = writeObservation.mock.calls[0] as [Db, { text: string; priority: string }];
    expect(params.text).toBe("#remember this fact");
    expect(params.priority).toBe("high");
  });

  it("returns timeout (without throwing) when the write exceeds hookWriteTimeoutMs, but exposes a pendingWrite that is allowed to settle", async () => {
    vi.useFakeTimers();
    const writeObservation = vi.fn(
      (_db: Db, _params: unknown) =>
        new Promise((resolve) => setTimeout(() => resolve("id-1"), 60000))
    );
    const deps = makeDeps({ writeObservation: writeObservation as never });

    const pending = runUserPromptSubmitHook({ ...baseInput, prompt: "#remember this fact" }, deps);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await pending;
    expect(result.outcome).toBe("timeout");
    expect(result.pendingWrite).not.toBeNull();

    // The write is not abandoned/torn down when timeout wins: it keeps
    // running and pendingWrite only settles once it genuinely resolves.
    await vi.advanceTimersByTimeAsync(55000);
    await expect(result.pendingWrite).resolves.toBeUndefined();
    expect(writeObservation).toHaveBeenCalledTimes(1);
  });

  it("returns error (never throws) when the write rejects", async () => {
    const writeObservation = vi.fn(async () => {
      throw new Error("mongo is down");
    });
    const deps = makeDeps({ writeObservation: writeObservation as never });

    const result = await runUserPromptSubmitHook(
      { ...baseInput, prompt: "#remember this fact" },
      deps
    );
    expect(result.outcome).toBe("error");
    expect(result.pendingWrite).toBeNull();
  });

  it("returns error (never throws) when the DB connect itself rejects", async () => {
    const getDb = vi.fn(async () => {
      throw new Error("connect failed");
    });
    const deps = makeDeps({ getDb: getDb as never });

    const result = await runUserPromptSubmitHook(
      { ...baseInput, prompt: "#remember this fact" },
      deps
    );
    expect(result.outcome).toBe("error");
    expect(result.pendingWrite).toBeNull();
    expect(deps.writeObservation).not.toHaveBeenCalled();
  });
});

describe("entry-point detection survives symlinked invocation paths (regression)", () => {
  it(
    "still runs main() and logs a failure line when the compiled script is invoked " +
      "through a symlinked directory",
    () => {
      // Regression test for a real bug: fileURLToPath(import.meta.url) is
      // symlink-resolved by Node's ESM loader, but path.resolve(process.argv[1])
      // only normalizes the literal argv string and never follows symlinks. If
      // the invocation path crosses a symlink, the old string comparison never
      // matched, isEntryPoint stayed false, and main() silently never ran. This
      // spawns the REAL compiled dist/hooks/userPromptSubmit.js as an actual
      // child process, reached through a directory symlink to the real dist/
      // tree (so its relative imports still resolve), feeds it invalid JSON on
      // stdin so that main(), if it runs, reaches JSON.parse's catch and calls
      // appendFailure("userPromptSubmit", err) before any env-var check or DB
      // code ever runs, and asserts on the resulting failure log file. It only
      // passes if main() genuinely executed.
      const outerDir = mkdtempSync(
        path.join(tmpdir(), "mongo-claude-memory-userpromptsubmit-outer-")
      );
      const failureLogDir = mkdtempSync(
        path.join(tmpdir(), "mongo-claude-memory-userpromptsubmit-log-")
      );
      const failureLogFile = path.join(failureLogDir, "failures.log");
      const linkPath = path.join(outerDir, "linked");

      try {
        symlinkSync(distDir, linkPath, "dir");
        const scriptPath = path.join(linkPath, "hooks", "userPromptSubmit.js");

        execFileSync(process.execPath, [scriptPath], {
          input: "this is not valid json",
          encoding: "utf8",
          env: {
            ...process.env,
            MEMORY_FAILURE_LOG: failureLogFile,
          },
        });

        const logged = readFileSync(failureLogFile, "utf8");
        expect(logged).toMatch(/ userPromptSubmit SyntaxError$/m);
      } finally {
        rmSync(outerDir, { recursive: true, force: true });
        rmSync(failureLogDir, { recursive: true, force: true });
      }
    }
  );
});
