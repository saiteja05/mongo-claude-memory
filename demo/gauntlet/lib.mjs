// Shared helpers for the memory gauntlet benchmark scripts.
// Plain Node.js ESM, no build step, no new dependencies.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { MongoClient } from "mongodb";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ARMS = ["stock", "engine"];

/** Absolute path to the repo root (parent of demo/), resolved from this file's location. */
export function repoRoot() {
  return path.resolve(HERE, "..", "..");
}

/** Absolute path to demo/gauntlet, resolved from this file's location so scripts work from any cwd. */
export function gauntletRoot() {
  return HERE;
}

/** The dedicated gauntlet database name, overridable via GAUNTLET_DB, never the real memory DB. */
export function gauntletDb() {
  return process.env.GAUNTLET_DB || "claude_memory_gauntlet";
}

export function stateRoot() {
  return path.join(gauntletRoot(), "state");
}

export function armDir(arm) {
  return path.join(stateRoot(), arm);
}

export function configDir(arm) {
  return path.join(armDir(arm), "config");
}

export function workspaceDir(arm) {
  return path.join(armDir(arm), "workspace", "orderflow");
}

export function mcpConfigPath(arm) {
  return path.join(configDir(arm), "mcp.json");
}

export function loadFacts() {
  const p = path.join(gauntletRoot(), "facts.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Appends one JSON line to state/<arm>/log.jsonl. Never throws, logging is best effort. */
export async function appendLog(arm, entry) {
  try {
    const dir = armDir(arm);
    await ensureDir(dir);
    const record = { timestamp: new Date().toISOString(), ...entry };
    await fsp.appendFile(path.join(dir, "log.jsonl"), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // logging must never break the run
  }
}

export async function appendJsonl(filePath, record) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
}

export async function readJsonl(filePath) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

function defaultTurnTimeoutMs() {
  const raw = Number.parseInt(process.env.GAUNTLET_TURN_TIMEOUT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 180000;
}

/** The MCP server key written into the engine arm's mcp.json by setup.mjs. Keep the two in sync. */
export const MCP_SERVER_NAME = "mongo-claude-memory";

/** The fully qualified MCP tool name allowed on engine-arm recall runs. */
export const MEMORY_SEARCH_TOOL = `mcp__${MCP_SERVER_NAME}__memory_search`;

/**
 * Builds the argv (excluding the "claude" binary itself) for one CLI invocation.
 * - Seed turn 1 of a session: -p "<text>" --model claude-sonnet-5
 * - Later turns of the same session: -p --continue "<text>" --model claude-sonnet-5
 * - Recall (always fresh): -p "<text>" --model claude-sonnet-5
 * Seed turns are pure text prompts and need no tool permissions, so no
 * permission flags are passed. Engine-arm recall runs pass mcpConfigFile and
 * allowedTools so the model may call memory_search over MCP; stock-arm recall
 * gets no extra flags.
 */
export function buildClaudeArgs({ text, continueSession = false, mcpConfigFile = null, allowedTools = null }) {
  const args = ["-p"];
  if (continueSession) args.push("--continue");
  args.push(text, "--model", "claude-sonnet-5");
  if (mcpConfigFile) args.push("--mcp-config", mcpConfigFile, "--strict-mcp-config");
  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }
  return args;
}

/**
 * Spawns the `claude` CLI. Never throws: ENOENT and timeouts are reported in the
 * resolved object rather than as rejections, so callers can log and continue.
 */
export function runClaude({ args, env, cwd, timeoutMs }) {
  const effectiveTimeoutMs = timeoutMs || defaultTurnTimeoutMs();
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        code: null,
        stdout: "",
        stderr: String((err && err.message) || err),
        durationMs: 0,
        timedOut: false,
        notFound: !!(err && err.code === "ENOENT"),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let notFound = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // process may already be gone
      }
    }, effectiveTimeoutMs);

    child.on("error", (err) => {
      if (err && err.code === "ENOENT") notFound = true;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, durationMs: Date.now() - startedAt, timedOut, notFound });
      }
    });

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut, notFound });
      }
    });
  });
}

/** Resolves the connection string env var name that is actually set, for messaging (never the value). */
export function connectionStringEnvName() {
  if (process.env.MDB_MCP_CONNECTION_STRING) return "MDB_MCP_CONNECTION_STRING";
  if (process.env.MEMORY_MONGODB_URI) return "MEMORY_MONGODB_URI";
  return null;
}

/** Opens a MongoClient against the gauntlet database. Throws with an env-var-name-only message if unset. */
export async function mongoClient() {
  const uri = process.env.MDB_MCP_CONNECTION_STRING || process.env.MEMORY_MONGODB_URI;
  if (!uri) {
    throw new Error(
      "missing connection string: set MDB_MCP_CONNECTION_STRING or MEMORY_MONGODB_URI"
    );
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(gauntletDb());
  return { client, db };
}

export function checkEnv(names) {
  return names.map((name) => ({ name, set: !!process.env[name] }));
}

/** Case-insensitive substring match of any keyword in `text`. */
export function containsAny(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (keywords || []).some((kw) => lower.includes(String(kw).toLowerCase()));
}

/** Recursively lists files under a directory matching a predicate. Tolerates a missing directory. */
export async function walkFiles(dir, predicate) {
  const results = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (!predicate || predicate(full)) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

export function printUsageAndExit(usage) {
  console.log(usage);
  process.exit(0);
}

export function hasFlag(argv, name) {
  return argv.includes(name);
}

export function flagValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1 || idx === argv.length - 1) return null;
  return argv[idx + 1];
}
