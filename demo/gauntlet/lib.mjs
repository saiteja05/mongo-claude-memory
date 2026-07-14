// Shared helpers for the memory gauntlet benchmark scripts.
// Plain Node.js ESM, no build step, no new dependencies.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { MongoClient } from "mongodb";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The four benchmark arms.
 *   control       - no memory of any kind: no hooks, no MCP server, no native
 *                   auto-memory. Never seeded. Measures per-fact guessability,
 *                   i.e. what a memoryless model gets right anyway.
 *   stock         - native Claude Code auto-memory only (CLAUDE.md and the
 *                   auto-memory files it writes under the config dir), no
 *                   MongoDB engine.
 *   engine        - this repo's MongoDB Atlas memory engine only. Native
 *                   Claude Code auto-memory is quarantined by the harness for
 *                   this arm: nothing should ever accumulate under its
 *                   config dir's projects/*\/memory (see nativeMemoryDirs).
 *   engine-native - the MongoDB engine AND native Claude Code auto-memory both
 *                   active at once, i.e. the realistic configuration most
 *                   engine users actually run day to day.
 */
export const ARMS = ["control", "stock", "engine", "engine-native"];

/** The two arms that talk to the MongoDB engine (hooks + mcp.json), each with its own dedicated database. */
export function engineArms() {
  return ["engine", "engine-native"];
}

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

/**
 * Per-engine-arm database name, so "engine" and "engine-native" never read or
 * write each other's beliefs/briefs even though they run the same product.
 * Returns null for arms that never talk to the engine at all (control, stock).
 */
export function gauntletDbFor(arm) {
  if (arm === "engine") return `${gauntletDb()}_engine`;
  if (arm === "engine-native") return `${gauntletDb()}_engine_native`;
  return null;
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

/**
 * Base env for spawning the `claude` CLI under a given arm's isolated config
 * dir. For the two engine arms, also points MEMORY_MONGODB_DB at that arm's
 * dedicated database.
 *
 * Deliberately does NOT set HOOK_INTERNAL_TIMEOUT_MS or any other engine
 * tuning knob: a red-team finding was that the harness widened the engine's
 * default fail-open budget (800ms) to 5000ms for every benchmarked run,
 * silently masking the exact production default the audit flagged. Production
 * defaults must apply here unless the operator exports an override in their
 * own shell before invoking the gauntlet scripts.
 */
export function envForArm(arm) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir(arm) };
  const db = gauntletDbFor(arm);
  if (db) env.MEMORY_MONGODB_DB = db;
  return env;
}

/**
 * Existing native Claude Code auto-memory directories for this arm: every
 * directory matching <configDir>/projects/*\/memory. Native auto-memory lives
 * one level under projects/<project-slug>/memory, NOT directly under
 * <configDir>/memory; a prior contamination check looked at configDir/memory,
 * always found nothing there, and shipped a false "no contamination"
 * negative even when the engine arm had a fully populated native memory store
 * one level deeper. Returns [] when the projects dir does not exist.
 */
export function nativeMemoryDirs(arm) {
  const projectsDir = path.join(configDir(arm), "projects");
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const memoryDir = path.join(projectsDir, entry.name, "memory");
    try {
      if (fs.statSync(memoryDir).isDirectory()) dirs.push(memoryDir);
    } catch {
      // no memory/ dir for this project, that is the expected common case
    }
  }
  return dirs;
}

/**
 * Recursively counts regular files under a directory. Returns 0 for a
 * missing or empty directory. Never throws: a directory that vanishes mid
 * walk, a permissions error, or any other fs failure on a subtree is
 * swallowed and that subtree counts as 0, since callers use this to tell an
 * inert empty scaffold apart from real content, not to audit filesystem
 * health. Symlinks are neither counted nor followed.
 */
export function countFilesInDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFilesInDir(full);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
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

/** Absolute path to the run provenance file written by setup.mjs. */
export function runInfoPath() {
  return path.join(stateRoot(), "run.json");
}

/** Writes run provenance ({ runId, createdAt, model, arms }) to state/run.json. */
export async function writeRunInfo(info) {
  await ensureDir(stateRoot());
  await fsp.writeFile(runInfoPath(), JSON.stringify(info, null, 2) + "\n", "utf8");
}

/**
 * Reads run provenance written by setup.mjs. Throws a helpful error (not a
 * raw ENOENT/SyntaxError) when state/run.json is missing or unparseable, so
 * every downstream script fails loudly instead of silently running without a
 * run id.
 */
export function readRunInfo() {
  const p = runInfoPath();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    throw new Error(`missing ${p}: run "node demo/gauntlet/setup.mjs" first to create run provenance.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`unparseable ${p}: run "node demo/gauntlet/setup.mjs" first to regenerate run provenance.`);
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
 * The Claude model used for every gauntlet CLI invocation, read from
 * GAUNTLET_MODEL with a default of the rolling "claude-sonnet-5" alias. The
 * default is a rolling alias, not a fixed snapshot: any run whose numbers
 * will be published or compared across time should pin a dated snapshot id
 * (e.g. claude-sonnet-5-20260304) via GAUNTLET_MODEL, since a rolling alias
 * can change the model underneath a comparison without notice.
 */
export function MODEL() {
  return process.env.GAUNTLET_MODEL || "claude-sonnet-5";
}

/**
 * Builds the argv (excluding the "claude" binary itself) for one CLI invocation.
 * - Seed turn 1 of a session: -p "<text>" --model <MODEL()>
 * - Later turns of the same session: -p --continue "<text>" --model <MODEL()>
 * - Recall (always fresh): -p "<text>" --model <MODEL()>
 * Seed turns are pure text prompts and need no tool permissions, so no
 * permission flags are passed. Engine-arm recall runs pass mcpConfigFile and
 * allowedTools so the model may call memory_search over MCP; stock-arm recall
 * gets no extra flags.
 */
export function buildClaudeArgs({ text, continueSession = false, mcpConfigFile = null, allowedTools = null }) {
  const args = ["-p"];
  if (continueSession) args.push("--continue");
  args.push(text, "--model", MODEL());
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

/**
 * Opens a MongoClient against a gauntlet database. Defaults to gauntletDb()
 * (the base database name) when dbName is omitted, which is what every
 * pre-existing caller (capture-check.mjs, and any other zero-arg call site)
 * still gets. Pass an explicit dbName (e.g. gauntletDbFor("engine")) to reach
 * one of the per-engine-arm databases instead. Throws with an
 * env-var-name-only message if no connection string is set.
 */
export async function mongoClient(dbName) {
  const uri = process.env.MDB_MCP_CONNECTION_STRING || process.env.MEMORY_MONGODB_URI;
  if (!uri) {
    throw new Error(
      "missing connection string: set MDB_MCP_CONNECTION_STRING or MEMORY_MONGODB_URI"
    );
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName || gauntletDb());
  return { client, db };
}

export function checkEnv(names) {
  return names.map((name) => ({ name, set: !!process.env[name] }));
}

/**
 * Builds the case-insensitive, word-boundary-safe regex source for one
 * keyword: the escaped keyword wrapped in (?<![A-Za-z0-9]) and
 * (?![A-Za-z0-9]) guards, so "Render" does not match inside "rendered" and
 * "15 minutes" does not match inside "115 minutes". Punctuation and
 * whitespace are fine boundaries, so "orderId:attempt" and "strict: true"
 * still match at their natural edges. A plain substring test was a red-team
 * finding: it counted "Render" as a hit anywhere inside "rendered", and "15
 * minutes" as a hit anywhere inside "115 minutes". Exported so other
 * checkers (capture-check.mjs's DB regex) can build the same semantics
 * instead of duplicating the escaping and boundary logic.
 */
export function keywordRegexSource(keyword) {
  const escaped = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`;
}

/** Case-insensitive, word-boundary-safe match of any keyword in `text`. */
export function containsAny(text, keywords) {
  if (!text) return false;
  return (keywords || []).some((kw) => new RegExp(keywordRegexSource(kw), "i").test(text));
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
