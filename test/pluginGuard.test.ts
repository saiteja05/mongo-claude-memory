import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { existsSync, mkdtempSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { run, missingDepsMessage } from "../src/hooks/pluginGuard.js";

const PLUGIN_ROOT = "/plugin/root";

// Used only by the real-subprocess regression test below (existsSync and
// spawn are mocked above for the run()-level unit tests, but execFileSync
// and the plain node:fs helpers here are left as the real implementations).
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..");
const compiledPluginGuardPath = path.join(repoRoot, "dist", "hooks", "pluginGuard.js");

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(existsSync).mockReset();
  vi.mocked(spawn).mockReset();
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
});

/** A minimal stand-in for ChildProcess: just enough EventEmitter surface for spawn's caller. */
function makeFakeChild(): EventEmitter {
  return new EventEmitter();
}

describe("run: deps present (canary found)", () => {
  it.each(["sessionStart", "userPromptSubmit", "sessionEnd"] as const)(
    "spawns dist/hooks/%s.js with stdio inherit and forwards a zero exit code",
    async (mode) => {
      vi.mocked(existsSync).mockReturnValue(true);
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      const resultPromise = run(["node", "pluginGuard.js", PLUGIN_ROOT, mode]);
      fakeChild.emit("exit", 0);
      const code = await resultPromise;

      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        [path.join(PLUGIN_ROOT, "dist", "hooks", `${mode}.js`)],
        { stdio: "inherit" }
      );
      expect(stdoutSpy).not.toHaveBeenCalled();
    }
  );

  it.each(["sessionStart", "userPromptSubmit", "sessionEnd"] as const)(
    "spawns dist/hooks/%s.js and forwards a nonzero exit code",
    async (mode) => {
      vi.mocked(existsSync).mockReturnValue(true);
      const fakeChild = makeFakeChild();
      vi.mocked(spawn).mockReturnValue(fakeChild as never);

      const resultPromise = run(["node", "pluginGuard.js", PLUGIN_ROOT, mode]);
      fakeChild.emit("exit", 7);
      const code = await resultPromise;

      expect(code).toBe(7);
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        [path.join(PLUGIN_ROOT, "dist", "hooks", `${mode}.js`)],
        { stdio: "inherit" }
      );
    }
  );

  it("defaults to exit code 0 when the child exits with a null code (e.g. killed by signal)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const fakeChild = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = run(["node", "pluginGuard.js", PLUGIN_ROOT, "sessionStart"]);
    fakeChild.emit("exit", null);
    const code = await resultPromise;

    expect(code).toBe(0);
  });

  it("resolves 0, and never throws, when the child emits an 'error' event", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const fakeChild = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    const resultPromise = run(["node", "pluginGuard.js", PLUGIN_ROOT, "sessionEnd"]);
    fakeChild.emit("error", new Error("ENOENT"));
    const code = await resultPromise;

    expect(code).toBe(0);
  });

  it("resolves 0, and never throws, when spawn() itself throws synchronously", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("spawn EAGAIN");
    });

    const code = await run(["node", "pluginGuard.js", PLUGIN_ROOT, "userPromptSubmit"]);

    expect(code).toBe(0);
  });
});

describe("run: deps missing (canary not found), sessionStart mode", () => {
  it("writes exactly one line of the SessionStart fallback JSON to stdout, and does not spawn", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const code = await run(["node", "pluginGuard.js", PLUGIN_ROOT, "sessionStart"]);

    expect(code).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);

    const written = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(PLUGIN_ROOT);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("npm install");
  });

  it("missingDepsMessage embeds the resolved plugin root and the npm install instruction", () => {
    const message = missingDepsMessage(PLUGIN_ROOT);
    expect(message).toContain(`cd "${PLUGIN_ROOT}"`);
    expect(message).toContain("npm install");
    expect(message.startsWith("[Recall memory plugin:")).toBe(true);
  });
});

describe("run: deps missing (canary not found), userPromptSubmit/sessionEnd modes", () => {
  it.each(["userPromptSubmit", "sessionEnd"] as const)(
    "exits 0 silently for %s: writes nothing to stdout and never spawns",
    async (mode) => {
      vi.mocked(existsSync).mockReturnValue(false);

      const code = await run(["node", "pluginGuard.js", PLUGIN_ROOT, mode]);

      expect(code).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    }
  );
});

describe("entry-point detection survives symlinked invocation paths (regression)", () => {
  it(
    "still runs main() and emits the SessionStart nudge when the compiled script is " +
      "invoked through a symlinked directory",
    () => {
      // Regression test for a real bug: new URL(import.meta.url).pathname is
      // symlink-resolved by Node's ESM loader, but path.resolve(process.argv[1])
      // only normalizes the literal argv string and never follows symlinks. If
      // the invocation path crosses a symlink, the old string comparison never
      // matched, isEntryPoint stayed false, and main() silently never ran, no
      // matter what mode or deps state. This spawns the REAL compiled
      // dist/hooks/pluginGuard.js as an actual child process (not the mocked
      // run() used above) through a directory symlink, and asserts on its real
      // stdout, so it only passes if main() genuinely executed.
      const realDir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-pluginguard-real-"));
      const outerDir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-pluginguard-outer-"));
      const pluginRootDir = mkdtempSync(
        path.join(tmpdir(), "mongo-claude-memory-pluginguard-root-")
      );
      const linkPath = path.join(outerDir, "linked");

      try {
        copyFileSync(compiledPluginGuardPath, path.join(realDir, "pluginGuard.js"));
        symlinkSync(realDir, linkPath, "dir");
        const scriptPath = path.join(linkPath, "pluginGuard.js");

        // pluginRootDir has no node_modules/mongodb, so this hits the "deps
        // missing, sessionStart" branch, which only ever writes to stdout if
        // main() actually ran (i.e. isEntryPoint was true).
        const stdout = execFileSync(
          process.execPath,
          [scriptPath, pluginRootDir, "sessionStart"],
          { encoding: "utf8" }
        );

        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
        expect(parsed.hookSpecificOutput.additionalContext).toContain(pluginRootDir);
        expect(parsed.hookSpecificOutput.additionalContext).toContain("npm install");
      } finally {
        rmSync(outerDir, { recursive: true, force: true });
        rmSync(realDir, { recursive: true, force: true });
        rmSync(pluginRootDir, { recursive: true, force: true });
      }
    }
  );
});

describe("run: missing or invalid argv", () => {
  it("exits 0 and does nothing when the plugin root (argv[2]) is missing", async () => {
    const code = await run(["node", "pluginGuard.js"]);

    expect(code).toBe(0);
    expect(existsSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("exits 0 and does nothing when the mode (argv[3]) is missing", async () => {
    const code = await run(["node", "pluginGuard.js", PLUGIN_ROOT]);

    expect(code).toBe(0);
    expect(existsSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("exits 0 and does nothing when the mode is not one of the 3 known modes", async () => {
    const code = await run(["node", "pluginGuard.js", PLUGIN_ROOT, "notARealMode"]);

    expect(code).toBe(0);
    expect(existsSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
