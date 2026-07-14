#!/usr/bin/env node
// Long-horizon gap 2 (RED-TEAM.md finding 2): "no A-to-B-to-C supersede
// chains, no corrections separated by days, no test that recency ranking
// beats importance when they conflict." Every correction the v1 gauntlet
// exercises (f08/f09) lands inside the SAME consolidation batch as its own
// planting. This scenario builds a genuine A to B to C chain across THREE
// separate sessions, running one full consolidation pass between each one,
// so every correction after the first has to reconcile against a belief
// store that is already consolidated, not merge inside one extraction batch.
//
// Fixture: a fictional "meridian-batch" worker service (invented, not world
// knowledge). Version A: the batch flush interval is 45 seconds. Version B:
// raised to 90 seconds after a queue backlog incident. Version C: settled at
// 120 seconds after load testing. Expected final truth is 120 seconds; 45
// and 90 are the stale forms recall must not echo as the current answer.
//
// This is a standalone scenario, not part of the v1 gauntlet's four-arm
// pipeline (setup.mjs/seed.mjs/recall.mjs/grade.mjs): it runs its own
// isolated scratch database and its own engine-style config dir/workspace
// under demo/gauntlet/v2/state/chain/, and does everything (seed, manual
// SessionEnd, consolidate, quarantine, verify, recall, grade) in one pass.
//
// Plain Node.js ESM, no build step, no new dependencies. Reuses lib.mjs's
// generic helpers (mongoClient, buildClaudeArgs, runClaude, containsAny,
// appendJsonl, countFilesInDir, walkFiles, sleep, MODEL); the arm-scoped
// helpers in lib.mjs/setup.mjs/seed.mjs/recall.mjs/ensure-indexes.mjs/
// consolidate.mjs (configDir(arm), nativeMemoryDirs(arm), etc.) are not
// reusable as-is since this scenario has no "arm", so their exact semantics
// are reimplemented below against this scenario's own config dir path.

import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  repoRoot,
  MODEL,
  buildClaudeArgs,
  runClaude,
  containsAny,
  appendJsonl,
  countFilesInDir,
  walkFiles,
  ensureDir,
  sleep,
  mongoClient,
  MCP_SERVER_NAME,
  MEMORY_SEARCH_TOOL,
} from "../lib.mjs";

const USAGE = `Usage: node demo/gauntlet/v2/scenario-b-chain.mjs [--reset] [--dry-run] [--help]

Long-horizon gap 2: an A to B to C correction chain for one invented fact
(meridian-batch's batch flush interval: 45s -> 90s -> 120s), each correction
arriving in its OWN session with a full consolidation pass in between, so
each one has to supersede an already-consolidated belief rather than merge
inside one extraction batch.

Runs entirely against its own scratch database, "claude_memory_gauntlet_v2_chain"
(GAUNTLET_DB is deliberately not consulted here: this scenario's database name
is fixed so it can never collide with, or be redirected onto, the v1
gauntlet's databases or the real memory database), and its own state dir,
demo/gauntlet/v2/state/chain/ (config dir + a git-inited "meridian-batch"
fixture workspace).

  --reset      drop the scratch database and delete demo/gauntlet/v2/state/chain/,
               then exit. Refuses to run if the resolved database name is not a
               safe gauntlet-scoped name.
  --dry-run    print the plan (state paths, the three session prompts, the
               chain assertions, the recall question) and the exact commands
               that would run. Makes no DB connection and spawns no "claude" or
               "node" child process.
  --help       print this message

Behavior (real run):
  1. Writes the scratch config dir (hooks settings.json + mcp.json, mirroring
     demo/gauntlet/setup.mjs's engine-arm shape) and git-inits the
     meridian-batch fixture workspace (mirroring setup.mjs's workspace files),
     with a real initial commit before any project key is derived or any
     session runs: a workspace with no commit of its own risks getProjectKey
     resolving to the outer mongo-claude-memory repo instead (git walks up to
     find the nearest .git), which would point every hook and every DB
     assertion below at the wrong project.
  2. Runs "node dist/db/setupIndexes.js" against the scratch database, then
     polls until beliefs_vec/beliefs_text (and beliefs_vec_auto, if present)
     are queryable, exactly like demo/gauntlet/ensure-indexes.mjs. Write-time
     reconciliation (the mechanism this scenario is built to exercise) needs
     beliefs_vec queryable, so nothing seeds before this passes.
  3. Runs three seed sessions, each ONE fresh "claude -p" turn (never
     --continue) in the meridian-batch workspace:
       session 1: states the flush interval is 45 seconds, asks for a config note
       session 2: "Update:" raises it to 90 seconds, asks to revise the note
       session 3: "Update:" settles it at 120 seconds, asks to revise again
     After EACH session: invokes dist/hooks/sessionEnd.js manually against
     that session's own newest transcript (same payload shape as seed.mjs,
     reason "other", with the same stale-transcript mtime guard), then runs
     ONE consolidation pass ("node dist/consolidation/cli.js") against the
     scratch database with MEMORY_MONGODB_DB overridden and every other env
     var (LLM_PROVIDER, ANTHROPIC_API_KEY / AWS credentials / OLLAMA_*,
     VOYAGE_*) inherited unchanged from the calling shell, then quarantines
     any native Claude Code auto-memory that accumulated under the scratch
     config dir.
  4. Verifies the chain with direct, deterministic reads against the beliefs
     collection: exactly one active belief on the flush-interval topic
     asserting 120, the 45- and 90-second beliefs both archived, and a
     supersede lineage that actually links them. Prints the real chain found
     (id/status/supersedes/text) either way.
  5. Pre-recall sanity gate: asserts that a "brief:<projectKey>" document
     exists in the scratch database's briefs collection, where projectKey is
     computed the same way the hooks compute it (getProjectKey against the
     git-inited meridian-batch workspace). Exits nonzero with a clear message
     if it is missing, since recall against a missing or mismatched project
     brief would silently grade against the wrong (or empty) memory.
  6. Runs 2 fresh recall trials asking what the batch flush interval is,
     grading word-boundary against the 120-second forms (wrong: 45/90-second
     forms), recording answers to state/chain/answers.jsonl. Before each
     trial, cleans empty native-memory scaffold dirs and hard-refuses on any
     non-empty one, mirroring recall.mjs's engine-arm contamination gate.
  7. Prints a summary table and writes state/chain/summary.json.

Exit code: nonzero only on infrastructure failure (missing "claude"/"node" on
PATH, setupIndexes or its index-queryable poll failing, a DB connection
failure, an accumulated seed/consolidate/sessionEnd failure, a missing
pre-recall brief document, or native-memory contamination found before a
recall trial). A broken chain or a failed recall trial is a RESULT, reported
in the summary and in summary.json, and never by itself turns the exit code
nonzero.
`;

const CHAIN_ROOT = path.join(repoRoot(), "demo", "gauntlet", "v2", "state", "chain");
const CFG_DIR = path.join(CHAIN_ROOT, "config");
const WORKSPACE_DIR = path.join(CHAIN_ROOT, "workspace", "meridian-batch");
const MCP_CONFIG_PATH = path.join(CFG_DIR, "mcp.json");
const LOG_PATH = path.join(CHAIN_ROOT, "log.jsonl");
const ANSWERS_PATH = path.join(CHAIN_ROOT, "answers.jsonl");
const SUMMARY_PATH = path.join(CHAIN_ROOT, "summary.json");

// Fixed, never read from GAUNTLET_DB: this scenario's database is a separate
// scratch namespace from the v1 gauntlet's databases on purpose, so a chain
// run can never share or corrupt v1 gauntlet state.
function scratchDb() {
  return "claude_memory_gauntlet_v2_chain";
}

/** Belt and suspenders, mirrors reset.mjs's unsafeDbNames check: refuses any name that is not gauntlet-scoped. */
function assertSafeDbName(name) {
  if (name === "claude_memory" || !name.includes("gauntlet")) {
    throw new Error(
      `refusing unsafe database name "${name}": must contain "gauntlet" and must never equal "claude_memory", the real memory database.`
    );
  }
}

const SESSION_1_PROMPT =
  "For the meridian-batch worker service, the batch flush interval is 45 seconds. Please add a short config note capturing this flush interval setting.";
const SESSION_2_PROMPT =
  "Update: after the queue backlog incident, we raised the batch flush interval for meridian-batch to 90 seconds. Please revise the config note to reflect the new flush interval.";
const SESSION_3_PROMPT =
  "Update: after load testing, we settled on a batch flush interval of 120 seconds for meridian-batch as the final setting. Please revise the config note again to reflect this.";

const SESSIONS = [
  { id: "chain-s1", prompt: SESSION_1_PROMPT, note: "plants version A: 45 seconds" },
  { id: "chain-s2", prompt: SESSION_2_PROMPT, note: "corrects to version B: 90 seconds" },
  { id: "chain-s3", prompt: SESSION_3_PROMPT, note: "corrects to version C: 120 seconds (final)" },
];

const RECALL_QUESTION = "What is the batch flush interval for meridian-batch?";
const RECALL_TRIALS = 2;

const FORTY_FIVE_FORMS = ["45 seconds", "45-second", "45 second"];
const NINETY_FORMS = ["90 seconds", "90-second", "90 second"];
const ONE_TWENTY_FORMS = ["120 seconds", "120-second", "120 second"];
const FLUSH_TOPIC_FORMS = ["flush interval"];

/** Env for every claude/node invocation this scenario spawns: inherits the caller's process env unchanged, only CLAUDE_CONFIG_DIR/MEMORY_MONGODB_DB are ever overridden. */
function chainEnv() {
  return { ...process.env, CLAUDE_CONFIG_DIR: CFG_DIR, MEMORY_MONGODB_DB: scratchDb() };
}

/** Env for a bare "node dist/..." invocation (setupIndexes, consolidation cli): only MEMORY_MONGODB_DB is overridden, every LLM/Voyage/Mongo credential is inherited from the caller's shell untouched. */
function consolidationEnv() {
  return { ...process.env, MEMORY_MONGODB_DB: scratchDb() };
}

// ---------------------------------------------------------------------------
// --reset
// ---------------------------------------------------------------------------

async function runReset(dryRun) {
  const dbName = scratchDb();
  assertSafeDbName(dbName);

  if (dryRun) {
    console.log("Dry run (--reset --dry-run):");
    console.log(`  Would drop database: ${dbName}`);
    console.log(`  Would delete directory: ${CHAIN_ROOT}`);
    return;
  }

  console.log(`Dropping database "${dbName}"...`);
  const { client, db } = await mongoClient(dbName);
  try {
    await db.dropDatabase();
    console.log("  dropped");
  } finally {
    await client.close();
  }

  console.log(`Deleting ${CHAIN_ROOT}...`);
  await fsp.rm(CHAIN_ROOT, { recursive: true, force: true });
  console.log("  deleted");
  console.log("Reset complete.");
}

// ---------------------------------------------------------------------------
// Config dir + workspace (mirrors setup.mjs's engine-arm shape)
// ---------------------------------------------------------------------------

async function gitInitIfNeeded(dir) {
  await ensureDir(dir);
  const gitDir = path.join(dir, ".git");
  if (fs.existsSync(gitDir)) return;
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "gauntlet@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Memory Gauntlet"], { cwd: dir, stdio: "ignore" });
}

/**
 * Commits whatever writeWorkspaceFiles wrote, if this workspace has no
 * commit yet. Belt and suspenders on top of gitInitIfNeeded: getProjectKey's
 * path mode only needs "git rev-parse --git-common-dir" to resolve, which
 * works on a bare "git init" with zero commits, but a nested workspace with
 * no .git at all resolves to the OUTER mongo-claude-memory repo's key
 * instead (git walks up to find one), which silently points every hook and
 * every DB assertion in this scenario at the wrong project. A real initial
 * commit here removes any doubt that this workspace is its own repo before
 * any project key is derived or any session runs.
 */
async function commitInitialWorkspaceIfNeeded(dir) {
  try {
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: "ignore" });
    return; // already has at least one commit
  } catch {
    // no commits yet, fall through and create one
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial commit (meridian-batch fixture)"], {
    cwd: dir,
    stdio: "ignore",
  });
}

async function writeWorkspaceFiles(dir) {
  const readmePath = path.join(dir, "README.md");
  if (!fs.existsSync(readmePath)) {
    await fsp.writeFile(
      readmePath,
      "# meridian-batch\n\nA batch processing worker service (Node) used as a fixture repo for the memory gauntlet's long-horizon correction-chain scenario (gap 2). Not a real project.\n",
      "utf8"
    );
  }
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    const pkg = {
      name: "meridian-batch",
      version: "0.0.0",
      private: true,
      description: "Fixture batch worker service repo for the memory gauntlet long-horizon chain scenario.",
    };
    await fsp.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }
}

async function writeChainSettings(root, cfgDir) {
  const settingsPath = path.join(cfgDir, "settings.json");
  const hookCmd = (rel) => `node ${path.join(root, "dist", "hooks", rel)}`;
  const settings = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [{ type: "command", command: hookCmd("sessionStart.js") }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: hookCmd("userPromptSubmit.js") }],
        },
      ],
      SessionEnd: [
        {
          hooks: [{ type: "command", command: hookCmd("sessionEnd.js") }],
        },
      ],
    },
  };
  await ensureDir(cfgDir);
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settingsPath;
}

async function writeChainMcpConfig(root, cfgDir) {
  const serverPath = path.join(root, "dist", "mcp", "server.js");
  const mcp = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [serverPath],
        env: {
          MEMORY_MONGODB_DB: scratchDb(),
        },
      },
    },
    _passthroughEnvNote:
      "MDB_MCP_CONNECTION_STRING, MEMORY_MONGODB_URI, VOYAGE_API_KEY, VOYAGE_MODEL, VOYAGE_DIMENSIONS, VOYAGE_BASE_URL, RERANK_MODE, EMBEDDING_MODE are inherited from the claude process environment at spawn time (not set in this file), same convention as demo/gauntlet/setup.mjs.",
  };
  await ensureDir(cfgDir);
  await fsp.writeFile(MCP_CONFIG_PATH, JSON.stringify(mcp, null, 2) + "\n", "utf8");
  return MCP_CONFIG_PATH;
}

async function writeChainConfig(root) {
  await gitInitIfNeeded(WORKSPACE_DIR);
  await writeWorkspaceFiles(WORKSPACE_DIR);
  await commitInitialWorkspaceIfNeeded(WORKSPACE_DIR);
  const settingsPath = await writeChainSettings(root, CFG_DIR);
  const mcpPath = await writeChainMcpConfig(root, CFG_DIR);
  console.log(`[chain] config dir: ${CFG_DIR}`);
  console.log(`[chain] workspace:  ${WORKSPACE_DIR}`);
  console.log(`[chain] wrote hooks settings: ${settingsPath}`);
  console.log(`[chain] wrote mcp config:     ${mcpPath} (database: ${scratchDb()})`);
}

// ---------------------------------------------------------------------------
// Index setup + queryable poll (mirrors ensure-indexes.mjs, for one database)
// ---------------------------------------------------------------------------

const REQUIRED_INDEX_NAMES = ["beliefs_vec", "beliefs_text"];
const OPTIONAL_INDEX_NAME = "beliefs_vec_auto";

function defaultIndexTimeoutMs() {
  const raw = Number.parseInt(process.env.GAUNTLET_INDEX_TIMEOUT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

function runSetupIndexes(root, dbName) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(root, "dist", "db", "setupIndexes.js")], {
      cwd: root,
      env: { ...process.env, MEMORY_MONGODB_DB: dbName },
      stdio: "inherit",
    });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") reject(new Error("node not found on PATH"));
      else reject(err);
    });
    child.on("close", (code) => resolve(code));
  });
}

async function fetchSearchIndexStatus(db) {
  const beliefs = db.collection("beliefs");
  const indexes = await beliefs.aggregate([{ $listSearchIndexes: {} }]).toArray();
  const byName = new Map();
  for (const idx of indexes) {
    byName.set(idx.name, { status: idx.status, queryable: idx.queryable === true });
  }
  return byName;
}

async function pollUntilQueryable(db, timeoutMs) {
  const startedAt = Date.now();
  let targetNames = null;

  for (;;) {
    const statusByName = await fetchSearchIndexStatus(db);

    if (targetNames === null) {
      targetNames = [...REQUIRED_INDEX_NAMES];
      if (statusByName.has(OPTIONAL_INDEX_NAME)) targetNames.push(OPTIONAL_INDEX_NAME);
      console.log(`[chain] Waiting for search indexes to become queryable: ${targetNames.join(", ")}`);
    }

    const rows = targetNames.map((name) => {
      const entry = statusByName.get(name);
      return { name, queryable: !!entry && entry.queryable, status: entry ? entry.status : "(not found)" };
    });

    if (rows.every((row) => row.queryable)) {
      console.log("[chain] All required search indexes are queryable:");
      for (const row of rows) console.log(`  ${row.name}: queryable=${row.queryable} status=${row.status}`);
      return true;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      console.error(`[chain] Timed out after ${timeoutMs}ms waiting for search indexes to become queryable.`);
      for (const row of rows) {
        if (!row.queryable) console.error(`  ${row.name}: queryable=${row.queryable} status=${row.status}`);
      }
      return false;
    }

    await sleep(5000);
  }
}

async function ensureIndexes(root, dryRun) {
  const dbName = scratchDb();
  if (dryRun) {
    console.log(
      `[chain] (dry-run): would run "node dist/db/setupIndexes.js" against database "${dbName}", then poll until ${REQUIRED_INDEX_NAMES.join(", ")} (and beliefs_vec_auto, if present) are queryable.`
    );
    return true;
  }

  console.log(`[chain] Running index setup against database "${dbName}"...`);
  const code = await runSetupIndexes(root, dbName);
  if (code !== 0) {
    console.error(`[chain] index setup exited with code ${code}`);
    return false;
  }

  const { client, db } = await mongoClient(dbName);
  try {
    return await pollUntilQueryable(db, defaultIndexTimeoutMs());
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Native auto-memory hygiene, reimplemented against a fixed config dir
// (lib.mjs's nativeMemoryDirs(arm)/countFilesInDir(dir) are the source
// semantics; nativeMemoryDirs is arm-scoped so it is reimplemented here
// against CFG_DIR directly, countFilesInDir is generic and imported as-is)
// ---------------------------------------------------------------------------

function nativeMemoryDirsForChain() {
  const projectsDir = path.join(CFG_DIR, "projects");
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
      // no memory/ dir for this project, the expected common case
    }
  }
  return dirs;
}

/** Mirrors seed.mjs's quarantineEngineArm, against this scenario's fixed config dir. Deletes every native auto-memory dir found, never throws. */
async function quarantineNativeMemory(runId) {
  const dirs = nativeMemoryDirsForChain();
  let fileCount = 0;
  for (const dir of dirs) {
    try {
      const files = await walkFiles(dir, () => true);
      fileCount += files.length;
    } catch {
      // best-effort count only, deletion below still proceeds
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
  if (dirs.length > 0) {
    console.log(`[chain] quarantine: removed ${dirs.length} native memory dir(s), ${fileCount} file(s)`);
  }
  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "quarantine",
    runId,
    dirsRemoved: dirs.length,
    filesRemoved: fileCount,
  });
  return { dirs: dirs.length, files: fileCount };
}

/**
 * Mirrors recall.mjs's assertNoEngineContamination against this scenario's
 * fixed config dir: an empty native-memory scaffold dir (the directory
 * Claude Code creates at session start whether or not it ever writes into
 * it) is normal runtime noise and is removed; a directory holding one or
 * more files is a hard refusal, since seeding owns the quarantine and this
 * check only verifies it. Throws (caller treats this as an infra failure)
 * rather than exiting the process directly, so the caller can decide whether
 * to abort immediately or finish printing whatever it already has.
 */
function assertNoEngineContamination() {
  const dirs = nativeMemoryDirsForChain();
  if (dirs.length === 0) return;

  const empty = [];
  const nonEmpty = [];
  for (const dir of dirs) {
    const fileCount = countFilesInDir(dir);
    if (fileCount === 0) empty.push(dir);
    else nonEmpty.push({ dir, fileCount });
  }

  for (const dir of empty) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[chain] removed empty native-memory scaffold dir (0 files): ${dir}`);
  }

  if (nonEmpty.length === 0) return;

  console.error("[chain] CONTAMINATION: native auto-memory found in the scratch config, refusing to recall:");
  for (const { dir, fileCount } of nonEmpty) {
    console.error(`    ${dir} (${fileCount} file(s))`);
  }
  throw new Error(
    `native-memory contamination: ${nonEmpty.length} non-empty native memory dir(s) found before a recall trial. ` +
      "Seeding owns the quarantine for this scenario; recall only verifies it. Investigate, then reset and re-run."
  );
}

// ---------------------------------------------------------------------------
// Manual SessionEnd (mirrors seed.mjs's runManualSessionEnd/newestTranscript
// exactly, reimplemented against this scenario's fixed config dir)
// ---------------------------------------------------------------------------

async function newestTranscript() {
  const projectsDir = path.join(CFG_DIR, "projects");
  const files = await walkFiles(projectsDir, (f) => f.endsWith(".jsonl"));
  let newest = null;
  let newestMtime = 0;
  for (const f of files) {
    try {
      const stat = await fsp.stat(f);
      if (stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newest = f;
      }
    } catch {
      // file vanished between walk and stat, skip
    }
  }
  return { transcriptPath: newest, mtimeMs: newestMtime };
}

async function runManualSessionEnd(session, env, cwd, sessionStartMs, runId) {
  const { transcriptPath, mtimeMs } = await newestTranscript();

  if (!transcriptPath) {
    console.error(`[chain] ${session.id} sessionEnd-manual: no transcript found under projects/, skipping`);
    await appendJsonl(LOG_PATH, {
      timestamp: new Date().toISOString(),
      phase: "sessionEnd-manual",
      runId,
      session: session.id,
      exitCode: null,
      durationMs: 0,
      outputPreview: "no transcript found",
    });
    return false;
  }

  if (mtimeMs < sessionStartMs) {
    console.error(
      `[chain] ${session.id} sessionEnd-manual: STALE TRANSCRIPT, expected the newest file under projects/** to be written between ${new Date(sessionStartMs).toISOString()} and now, but the newest one is from ${new Date(mtimeMs).toISOString()}`
    );
    await appendJsonl(LOG_PATH, {
      timestamp: new Date().toISOString(),
      phase: "sessionEnd-manual",
      runId,
      session: session.id,
      exitCode: null,
      durationMs: 0,
      outputPreview: "stale transcript rejected",
    });
    return false;
  }

  const payload = JSON.stringify({
    session_id: path.basename(transcriptPath, ".jsonl"),
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "SessionEnd",
    reason: "other",
  });

  const hookPath = path.join(repoRoot(), "dist", "hooks", "sessionEnd.js");
  const startedAt = Date.now();

  const result = await new Promise((resolve) => {
    const child = spawn("node", [hookPath], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: String(err && err.message) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(payload);
    child.stdin.end();
  });

  const durationMs = Date.now() - startedAt;
  const ok = result.code === 0;
  console.log(`[chain] ${session.id} sessionEnd-manual ${ok ? "ok" : "FAILED"} (${(durationMs / 1000).toFixed(1)}s)`);
  if (!ok && result.stderr) console.error(`    stderr: ${result.stderr.slice(0, 400)}`);

  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "sessionEnd-manual",
    runId,
    session: session.id,
    exitCode: result.code,
    durationMs,
    outputPreview: (result.stdout || "").slice(0, 400),
  });

  return ok;
}

// ---------------------------------------------------------------------------
// Consolidation pass (mirrors consolidate.mjs's runConsolidator exactly)
// ---------------------------------------------------------------------------

function runConsolidator(root) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(root, "dist", "consolidation", "cli.js")], {
      cwd: root,
      env: consolidationEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      process.stderr.write(d);
    });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") reject(new Error("node not found on PATH"));
      else reject(err);
    });
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

// ---------------------------------------------------------------------------
// One seed session: fresh claude -p turn, manual SessionEnd, one
// consolidation pass, quarantine. Returns true iff every infra step ok.
// ---------------------------------------------------------------------------

async function runSeedSession(root, session, runId, dryRun) {
  const cwd = WORKSPACE_DIR;
  const env = chainEnv();
  const args = buildClaudeArgs({ text: session.prompt, continueSession: false });

  if (dryRun) {
    console.log(`[chain] ${session.id} (${session.note}) (dry-run):`);
    console.log(`    cwd: ${cwd}`);
    console.log(`    CLAUDE_CONFIG_DIR: ${env.CLAUDE_CONFIG_DIR}`);
    console.log(`    claude ${args.map((a) => JSON.stringify(a)).join(" ")}`);
    console.log(
      `    then (dry-run): would pipe a manual SessionEnd payload for the newest projects/**.jsonl transcript under ${CFG_DIR} to node dist/hooks/sessionEnd.js`
    );
    console.log(
      `    then (dry-run): would run "node dist/consolidation/cli.js" against database "${scratchDb()}" (MEMORY_MONGODB_DB overridden, all other env inherited)`
    );
    console.log(`    then (dry-run): would remove native memory dirs under ${CFG_DIR}/projects/*/memory`);
    return true;
  }

  const sessionStartMs = Date.now();
  const result = await runClaude({ args, env, cwd });

  if (result.notFound) {
    console.error("claude CLI not found on PATH");
    throw new Error("infra: claude CLI not found on PATH");
  }

  const ok = result.code === 0 && !result.timedOut;
  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log(`[chain] ${session.id} turn ${ok ? "ok" : "FAILED"} (${seconds}s)`);
  if (!ok) {
    if (result.timedOut) console.error(`    timed out after ${result.durationMs}ms`);
    if (result.stderr) console.error(`    stderr: ${result.stderr.slice(0, 400)}`);
  }

  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "seed",
    runId,
    session: session.id,
    exitCode: result.code,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    outputPreview: (result.stdout || "").slice(0, 400),
  });

  const sessionEndOk = await runManualSessionEnd(session, env, cwd, sessionStartMs, runId);

  console.log(`[chain] ${session.id} consolidate: running one pass against database "${scratchDb()}"...`);
  const { code: consolidateCode } = await runConsolidator(root);
  if (consolidateCode !== 0) {
    console.error(`[chain] ${session.id} consolidate FAILED (exit ${consolidateCode})`);
  }
  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "consolidate",
    runId,
    session: session.id,
    exitCode: consolidateCode,
  });

  await quarantineNativeMemory(runId);

  return ok && sessionEndOk && consolidateCode === 0;
}

// ---------------------------------------------------------------------------
// Chain verification: deterministic DB reads, no LLM calls
// ---------------------------------------------------------------------------

async function computeProjectKey() {
  const modPath = path.join(repoRoot(), "dist", "project", "projectKey.js");
  const mod = await import(pathToFileURL(modPath).href);
  return mod.getProjectKey(WORKSPACE_DIR);
}

/**
 * Pre-recall sanity gate: consolidation compiles brief:<projectKey> for
 * every project it just processed (src/consolidation/run.ts calls
 * compileBrief(db, project) after each pass), so by the time all three seed
 * sessions have each run a consolidation pass, this document must exist for
 * the exact project key this script derives from WORKSPACE_DIR. If it does
 * not, either the hooks derived a different project key than this script did
 * (e.g. the workspace was not its own git repo, see
 * commitInitialWorkspaceIfNeeded) or consolidation never actually processed
 * this project's observations, and recall would silently grade answers
 * against the wrong (or empty) memory. This is an infra failure, not a
 * RESULT: throws so main()'s top-level catch exits nonzero with a clear
 * message rather than letting recall run against a mismatched project.
 */
async function assertBriefExists(db, projectKey) {
  const briefId = `brief:${projectKey}`;
  const doc = await db.collection("briefs").findOne({ _id: briefId });
  if (!doc) {
    throw new Error(
      `infra: expected a "${briefId}" document in the briefs collection of database "${scratchDb()}" ` +
        "before recall (consolidation compiles brief:<projectKey> after every pass), but none was found. " +
        "This usually means the seed sessions' cwd did not resolve to the same project key this script " +
        "derives from WORKSPACE_DIR (check that the meridian-batch workspace is git-inited with a real " +
        "commit before any session runs), or consolidation never processed this project's observations."
    );
  }
  console.log(`[chain] pre-recall sanity: found ${briefId} (generated_at=${doc.generated_at ?? "unknown"})`);
}

/**
 * Chain members are identified by LINEAGE POSITION (walking supersedes
 * pointers from the active belief), not by which number keywords their text
 * happens to contain. A live run found the settled 120-second belief's own
 * text narrating its provenance ("...raised from 90 seconds following load
 * testing; this supersedes the prior 90-second value"), so an exclusive
 * "has90" keyword filter wrongly roped the ACTIVE belief into the 90-second
 * bucket too, and a has90.every(archived) check failed even though the real
 * chain was perfect. Mentioning an earlier value in a later belief's text is
 * expected, correct provenance, not a defect, so membership in a role
 * ("the 90-second belief", "the 45-second belief") must come from where a
 * belief sits in the supersedes chain, and the keyword check is only used
 * afterward, to sanity-check that the belief found at that position actually
 * talks about the number its role implies.
 */
async function verifyChain(db, projectKey) {
  const beliefs = db.collection("beliefs");
  const all = await beliefs.find({ project: projectKey }).sort({ created_at: 1 }).toArray();
  const topic = all.filter((b) => typeof b.text === "string" && containsAny(b.text, FLUSH_TOPIC_FORMS));

  console.log(`\n[chain] Actual belief chain for project "${projectKey}" (flush-interval topic):`);
  if (topic.length === 0) {
    console.log("  (no beliefs found matching the flush-interval topic)");
  }
  for (const b of topic) {
    console.log(
      `  _id=${b._id} status=${b.status} version=${b.version} supersedes=${b.supersedes ?? "null"} text="${b.text}"`
    );
  }

  const byId = new Map(topic.map((b) => [String(b._id), b]));

  const active = topic.filter((b) => b.status === "active");
  const activeBelief = active.find((b) => containsAny(b.text, ONE_TWENTY_FORMS));

  const ninetyBelief =
    activeBelief && activeBelief.supersedes ? byId.get(String(activeBelief.supersedes)) : null;
  const fortyFiveBelief =
    ninetyBelief && ninetyBelief.supersedes ? byId.get(String(ninetyBelief.supersedes)) : null;

  console.log("\n[chain] Lineage roles (found by walking supersedes pointers, not by keyword membership):");
  console.log(`  active belief (asserts 120s):                  ${activeBelief ? activeBelief._id : "(none found)"}`);
  console.log(`  -> supersedes (expected 90-second belief):     ${ninetyBelief ? ninetyBelief._id : "(none found)"}`);
  console.log(`  -> supersedes (expected 45-second belief):     ${fortyFiveBelief ? fortyFiveBelief._id : "(none found)"}`);

  const assertions = [
    {
      name: "exactly one active belief on this topic, asserting 120 seconds",
      pass: active.length === 1 && !!activeBelief,
    },
    {
      name: "the belief the active belief supersedes is the 90-second belief, archived (mentioning 45 as provenance is fine)",
      pass: !!ninetyBelief && ninetyBelief.status === "archived" && containsAny(ninetyBelief.text, NINETY_FORMS),
    },
    {
      name: "the belief the 90-second belief supersedes is the 45-second belief, archived",
      pass:
        !!fortyFiveBelief &&
        fortyFiveBelief.status === "archived" &&
        containsAny(fortyFiveBelief.text, FORTY_FIVE_FORMS),
    },
  ];

  console.log("\n[chain] Chain assertions:");
  for (const a of assertions) {
    console.log(`  [${a.pass ? "PASS" : "FAIL"}] ${a.name}`);
  }

  return { topic, assertions };
}

// ---------------------------------------------------------------------------
// Recall trials + grading
// ---------------------------------------------------------------------------

function gradeAnswer(answerText) {
  const hasExpected = containsAny(answerText, ONE_TWENTY_FORMS);
  const hasWrong = containsAny(answerText, [...FORTY_FIVE_FORMS, ...NINETY_FORMS]);
  if (hasExpected) return { verdict: "correct", staleEcho: hasWrong };
  if (hasWrong) return { verdict: "stale", staleEcho: false };
  return { verdict: "miss", staleEcho: false };
}

async function runRecallTrials(runId, dryRun) {
  const env = chainEnv();
  const cwd = WORKSPACE_DIR;
  const results = [];

  for (let trial = 1; trial <= RECALL_TRIALS; trial++) {
    if (dryRun) {
      console.log(`[chain] recall trial ${trial}/${RECALL_TRIALS} (dry-run):`);
      console.log(
        `    (dry-run): would clean empty native-memory scaffolds and hard-refuse on any non-empty one under ${CFG_DIR}/projects/*/memory`
      );
      console.log(`    cwd: ${cwd}`);
      console.log(`    CLAUDE_CONFIG_DIR: ${env.CLAUDE_CONFIG_DIR}`);
      const args = buildClaudeArgs({
        text: RECALL_QUESTION,
        continueSession: false,
        mcpConfigFile: MCP_CONFIG_PATH,
        allowedTools: [MEMORY_SEARCH_TOOL],
      });
      console.log(`    claude ${args.map((a) => JSON.stringify(a)).join(" ")}`);
      results.push({ trial, planned: true });
      continue;
    }

    assertNoEngineContamination();

    const args = buildClaudeArgs({
      text: RECALL_QUESTION,
      continueSession: false,
      mcpConfigFile: MCP_CONFIG_PATH,
      allowedTools: [MEMORY_SEARCH_TOOL],
    });

    const result = await runClaude({ args, env, cwd });
    if (result.notFound) {
      throw new Error("infra: claude CLI not found on PATH");
    }

    const { verdict, staleEcho } = gradeAnswer(result.stdout || "");
    const seconds = (result.durationMs / 1000).toFixed(1);
    console.log(
      `[chain] recall trial ${trial}/${RECALL_TRIALS}: ${verdict}${staleEcho ? " (stale-echo)" : ""} (${seconds}s)`
    );

    await appendJsonl(ANSWERS_PATH, {
      runId,
      model: MODEL(),
      trial,
      question: RECALL_QUESTION,
      answer: result.stdout || "",
      verdict,
      staleEcho,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      timestamp: new Date().toISOString(),
    });

    results.push({ trial, verdict, staleEcho, timedOut: result.timedOut, durationMs: result.durationMs });
    await sleep(2000);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dry-run plan (no DB connection, no child processes)
// ---------------------------------------------------------------------------

function printDryRunPlan() {
  console.log("Dry run: no DB connection will be made, no \"claude\" or \"node\" child process will be spawned.\n");
  console.log(`Scratch database: ${scratchDb()}`);
  console.log(`State root:       ${CHAIN_ROOT}`);
  console.log(`Config dir:       ${CFG_DIR}`);
  console.log(`Workspace:        ${WORKSPACE_DIR}\n`);

  console.log("Plan:");
  console.log(
    "  1. Write hooks settings.json + mcp.json, git-init the meridian-batch workspace with a real initial commit (before any project key is derived or any session runs)."
  );
  console.log("  2. Run dist/db/setupIndexes.js against the scratch database, poll until beliefs_vec/beliefs_text are queryable.");
  console.log("  3. Three seed sessions (each ONE fresh claude -p turn, sessionEnd-manual, one consolidation pass, quarantine):");
  for (const s of SESSIONS) {
    console.log(`       ${s.id} (${s.note}):`);
    console.log(`         "${s.prompt}"`);
  }
  console.log("  4. Chain verification (direct DB reads, members identified by lineage position, not keyword sets):");
  console.log("       - exactly one active belief on the flush-interval topic, asserting 120 seconds");
  console.log("       - the belief the active belief supersedes is the 90-second belief, archived");
  console.log("       - the belief the 90-second belief supersedes is the 45-second belief, archived");
  console.log(
    "  5. Pre-recall sanity gate: assert a \"brief:<projectKey>\" document exists in the scratch database's briefs collection (exit nonzero with a clear message otherwise)."
  );
  console.log(`  6. ${RECALL_TRIALS} fresh recall trials asking:`);
  console.log(`       "${RECALL_QUESTION}"`);
  console.log(`       expected (correct): ${ONE_TWENTY_FORMS.join(", ")}`);
  console.log(`       wrong (stale):      ${[...FORTY_FIVE_FORMS, ...NINETY_FORMS].join(", ")}`);
  console.log("  7. Print a summary table, write state/chain/summary.json.");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const dryRun = argv.includes("--dry-run");

  if (argv.includes("--reset")) {
    await runReset(dryRun);
    return;
  }

  if (dryRun) {
    printDryRunPlan();
    return;
  }

  assertSafeDbName(scratchDb());

  const root = repoRoot();
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  console.log(`[chain] run id: ${runId}`);
  console.log(`[chain] scratch database: ${scratchDb()}`);

  await ensureDir(CHAIN_ROOT);
  await writeChainConfig(root);

  const indexesOk = await ensureIndexes(root, false);
  if (!indexesOk) {
    console.error(
      "[chain] search indexes are not queryable, refusing to seed: write-time reconciliation needs beliefs_vec to work at all."
    );
    process.exitCode = 1;
    return;
  }

  let infraFailures = 0;
  for (const session of SESSIONS) {
    const ok = await runSeedSession(root, session, runId, false);
    if (!ok) infraFailures++;
    await sleep(2000);
  }

  const projectKey = await computeProjectKey();
  console.log(`\n[chain] project key: ${projectKey}`);

  let chainResult;
  const { client, db } = await mongoClient(scratchDb());
  try {
    chainResult = await verifyChain(db, projectKey);
    await assertBriefExists(db, projectKey);
  } finally {
    await client.close();
  }

  let recallResults = [];
  let contaminationFailure = false;
  try {
    recallResults = await runRecallTrials(runId, false);
  } catch (err) {
    contaminationFailure = true;
    console.error(`[chain] recall aborted: ${err && err.message ? err.message : err}`);
  }

  const finishedAt = new Date().toISOString();

  console.log("\n=== Summary ===");
  console.log(`Run id: ${runId}`);
  console.log("\nChain assertions:");
  for (const a of chainResult.assertions) {
    console.log(`  [${a.pass ? "PASS" : "FAIL"}] ${a.name}`);
  }
  console.log("\nRecall verdicts:");
  if (recallResults.length === 0) {
    console.log("  (none: recall was aborted, see contamination error above)");
  }
  for (const r of recallResults) {
    console.log(`  trial ${r.trial}: ${r.verdict}${r.staleEcho ? " (stale-echo)" : ""}`);
  }

  const summary = {
    runId,
    model: MODEL(),
    startedAt,
    finishedAt,
    scratchDb: scratchDb(),
    projectKey,
    chainAssertions: chainResult.assertions,
    chain: chainResult.topic.map((b) => ({
      _id: String(b._id),
      status: b.status,
      version: b.version,
      supersedes: b.supersedes ?? null,
      text: b.text,
    })),
    recall: recallResults,
    infraFailures,
    contaminationFailure,
  };
  await ensureDir(CHAIN_ROOT);
  await fsp.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${SUMMARY_PATH}`);

  if (infraFailures > 0 || contaminationFailure) {
    console.error(
      `\n[chain] ${infraFailures} seed/consolidate/sessionEnd infra failure(s)${contaminationFailure ? " plus a native-memory contamination failure" : ""}; exiting nonzero. Chain and recall RESULTS above are still valid for whatever completed.`
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("scenario-b-chain failed:", err && err.message ? err.message : err);
  process.exit(1);
});
