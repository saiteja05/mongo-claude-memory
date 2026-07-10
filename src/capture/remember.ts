import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getProjectKey } from "../project/projectKey.js";
import { getDb, closeDb } from "../db/client.js";
import { writeObservation } from "./writeObservation.js";

export interface RememberDeps {
  writeObservation: (params: {
    project: string;
    session_id: string;
    source: "remember";
    priority: "high";
    text: string;
  }) => Promise<unknown>;
  getProjectKey: (cwd: string) => string;
  hasMongoConfig: () => boolean;
}

export interface RememberResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * Testable core: takes the already-parsed argument text and cwd, and returns
 * a result describing what to print and whether the process should exit
 * non-zero. Unlike the hooks, this is a user-invoked CLI script, so failures
 * are reported, never swallowed (DESIGN.md 5.1 / the hooks-vs-CLI distinction).
 */
export async function runRemember(
  text: string,
  cwd: string,
  deps: RememberDeps
): Promise<RememberResult> {
  if (text.length === 0) {
    return { ok: false, stderr: "Usage: remember <text to save>" };
  }

  if (!deps.hasMongoConfig()) {
    return {
      ok: false,
      stderr:
        "Memory is not configured yet: set MDB_MCP_CONNECTION_STRING or MEMORY_MONGODB_URI.",
    };
  }

  try {
    const project = deps.getProjectKey(cwd);
    await deps.writeObservation({
      project,
      session_id: "cli:remember",
      source: "remember",
      priority: "high",
      text,
    });
    return { ok: true, stdout: `Saved to memory (project: ${project}).` };
  } catch (err) {
    return {
      ok: false,
      stderr: `Failed to save to memory: ${err instanceof Error ? err.name : "unknown error"}`,
    };
  }
}

function hasMongoConfig(): boolean {
  return Boolean(process.env.MDB_MCP_CONNECTION_STRING || process.env.MEMORY_MONGODB_URI);
}

/**
 * Reads the remembered text for the CLI's main() entry point.
 *
 * The `/remember` slash command (.claude/commands/remember.md) writes the raw
 * argument text to a file with the Write tool and passes the file's path here
 * with `--file <path>`, rather than having the model interpolate the raw text
 * into a shell command string. A file path is safe to embed in a shell
 * command; arbitrary user text is not (it could contain quotes and shell
 * metacharacters that break out of the command). Falls back to joining argv
 * for direct/manual invocation (e.g. `node remember.js some text`).
 */
async function readArgText(args: string[]): Promise<string> {
  const fileFlagIndex = args.indexOf("--file");
  if (fileFlagIndex === -1) {
    return args.join(" ").trim();
  }

  const filePath = args[fileFlagIndex + 1];
  if (!filePath) {
    throw new Error("--file requires a path argument");
  }
  const contents = await readFile(filePath, "utf8");
  return contents.trim();
}

async function main(): Promise<void> {
  let exitCode = 0;
  let text: string;

  try {
    text = await readArgText(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `Failed to read remembered text: ${err instanceof Error ? err.name : "unknown error"}\n`
    );
    process.exit(1);
    return;
  }

  try {
    const result = await runRemember(text, process.cwd(), {
      hasMongoConfig,
      getProjectKey,
      writeObservation: async (params) => {
        const db = await getDb();
        return writeObservation(db, params);
      },
    });

    if (result.stdout) process.stdout.write(result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    exitCode = result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `Failed to save to memory: ${err instanceof Error ? err.name : "unknown error"}\n`
    );
    exitCode = 1;
  } finally {
    await closeDb().catch(() => undefined);
  }

  process.exit(exitCode);
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  main();
}
