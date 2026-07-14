#!/usr/bin/env node
// Scenario C, long-horizon gap 5: forget-and-stay-forgotten. Nothing in the
// v1 gauntlet ever verifies that a forgotten fact STAYS forgotten across a
// brief recompile, a local disk cache, and fresh-session recall. This
// scenario seeds two invented facts in one session, consolidates them into
// beliefs, forgets exactly one via the real runMemoryForget contract (the
// same call src/mcp/server.ts makes for the memory_forget tool), then checks
// that the forgotten fact does not resurface anywhere: not in the belief's
// status, not in the recompiled brief, not in the local brief cache, and not
// in a fresh session's recall answer, while the sibling fact that was NOT
// forgotten still recalls correctly (a surgical forget, not a blunt wipe).
//
// Self-contained on top of demo/gauntlet/lib.mjs (mongoClient, MODEL,
// buildClaudeArgs, runClaude, containsAny, appendJsonl,
// keywordRegexSource, walkFiles, ensureDir, sleep, hasFlag). It does NOT use
// lib.mjs's arm-shaped path helpers (armDir/configDir/workspaceDir/
// nativeMemoryDirs): those are hardcoded to demo/gauntlet/state/<arm> for the
// v1 four-arm run, and this scenario's state deliberately lives under
// demo/gauntlet/v2/state/forget/ instead, so the equivalent path/contamination
// helpers below are re-derived to take an explicit directory instead of an
// arm name.
//
// Imports the built runMemoryForget and getProjectKey straight from dist/,
// the same modules src/mcp/server.ts loads at runtime: this proves the real
// production forget path, not a reimplementation of it.

import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

import {
  repoRoot,
  mongoClient,
  MODEL,
  buildClaudeArgs,
  runClaude,
  containsAny,
  appendJsonl,
  keywordRegexSource,
  walkFiles,
  ensureDir,
  sleep,
  hasFlag,
  MCP_SERVER_NAME,
  MEMORY_SEARCH_TOOL,
} from "../lib.mjs";

import { getProjectKey } from "../../../dist/project/projectKey.js";
import { runMemoryForget } from "../../../dist/mcp/memoryForget.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, "state", "forget");
const CONFIG_DIR = path.join(STATE_DIR, "config");
const WORKSPACE_DIR = path.join(STATE_DIR, "workspace", "meridian-secrets");
const CACHE_DIR = path.join(STATE_DIR, "brief-cache");
const MCP_CONFIG_PATH = path.join(CONFIG_DIR, "mcp.json");
const RUN_INFO_PATH = path.join(STATE_DIR, "run.json");
const LOG_PATH = path.join(STATE_DIR, "log.jsonl");
const ANSWERS_PATH = path.join(STATE_DIR, "answers.jsonl");
const SUMMARY_PATH = path.join(STATE_DIR, "summary.json");

const USAGE = `Usage: node demo/gauntlet/v2/scenario-c-forget.mjs [--reset] [--dry-run] [--help]

Proves the full forget path (long-horizon gap 5: nothing else verifies a
forgotten fact stays forgotten) against a dedicated scratch database and a
dedicated scratch Claude Code config dir / workspace, both isolated from the
v1 gauntlet:

  database:   ${scratchDbNameForUsage()}  (override with GAUNTLET_FORGET_DB, must contain "gauntlet")
  state dir:  demo/gauntlet/v2/state/forget/
              config/     scratch CLAUDE_CONFIG_DIR (hooks + mcp.json)
              workspace/  scratch git repo, fictional "meridian-secrets" service
              brief-cache/ scratch MEMORY_BRIEF_CACHE_DIR (isolated so cache writes/deletes are observable)

Steps: setup (+ optional reset) and index wait, seed one session with two
invented facts (a KEEP fact and a FORGET fact), one consolidation pass,
pre-forget recall of both facts, the real memory_forget call against the
FORGET belief, deterministic post-forget checks (tombstone, recompiled
brief, local cache), then post-forget recall (FORGET must not resurface,
KEEP must still work). Native Claude Code auto-memory is fully wiped after
seeding and before EVERY recall trial (control-arm semantics), so recall
answers measure the engine's forget path alone.

  --reset      drops the scratch database and deletes state/forget/ before
               provisioning starts. Refuses to run if the resolved database
               name does not contain "gauntlet" or equals "claude_memory".
  --dry-run    prints the plan only. Makes no database connection, spawns no
               "claude" process, and writes nothing to disk.
  --help       print this message

Writes demo/gauntlet/v2/state/forget/summary.json and log.jsonl. Exits
non-zero only on infrastructure failures (missing build, unreachable DB,
index timeout, no transcript captured, no belief to forget, etc.);
resurfacing of the forgotten fact is a reported RESULT, not a script error.
`;

function scratchDbNameForUsage() {
  return process.env.GAUNTLET_FORGET_DB || "claude_memory_gauntlet_v2_forget";
}

function scratchDbName() {
  return scratchDbNameForUsage();
}

/** Belt and suspenders, mirrors demo/gauntlet/reset.mjs's own guard. */
function assertSafeDbName(name) {
  if (name === "claude_memory" || !name.includes("gauntlet")) {
    console.error(
      `Refusing to run: database name "${name}" is unsafe. It must contain "gauntlet" and must never be ` +
        `"claude_memory", the real memory database. Set GAUNTLET_FORGET_DB to something else if you overrode it.`
    );
    process.exit(1);
  }
}

// Two invented facts, planted in ONE session, in ONE prompt: a KEEP fact that
// must survive the forget untouched, and a FORGET fact that gets tombstoned.
// Both keyword lists are deliberately specific strings unlikely to appear in
// a model's answer by coincidence or guesswork, so a keyword hit is real
// evidence of recall (or, after the forget, real evidence of resurfacing),
// not a coincidence.
const KEEP_FACT = {
  statement: "the metrics flush port is 9412",
  keywords: ["9412"],
};
const FORGET_FACT = {
  statement: "the legacy export token lives in the ops vault under key meridian-legacy-export",
  keywords: ["meridian-legacy-export", "legacy export token"],
};

const SEED_PROMPT =
  "For the meridian-secrets service, please put two separate operational facts on the record. " +
  "First: the metrics flush port is 9412. Second, and unrelated to the first: the legacy export token " +
  "lives in the ops vault under key meridian-legacy-export. Acknowledge both facts in your reply, briefly.";

const KEEP_QUESTION = "For the meridian-secrets service, what is the metrics flush port?";
const FORGET_QUESTION =
  "For the meridian-secrets service, where does the legacy export token live, and what is its ops vault key?";

/**
 * Question-echo exclusion: a live run found post-forget resurface detection
 * FAILING FALSELY, because the model's answer correctly DENIED the fact
 * ("nothing about a legacy export token or vault key") and that denial
 * naturally echoes back the question's own wording. A keyword drawn straight
 * from the question (like "legacy export token", which appears verbatim in
 * FORGET_QUESTION) will match inside a correct denial just as readily as it
 * would match inside a real resurfacing, so it is useless as resurfacing
 * evidence. This returns only the keywords that do NOT appear (word-boundary,
 * case-insensitive, same matcher as containsAny) in the question text itself:
 * for FORGET_FACT against FORGET_QUESTION that leaves only the actual vault
 * key value ("meridian-legacy-export"), which a model cannot guess or echo
 * from the question and can only produce by actually knowing it.
 */
function effectiveKeywords(keywords, questionText) {
  return keywords.filter((kw) => !containsAny(questionText, [kw]));
}

/**
 * Keyword list for a CORRECTNESS check (did the model recall the fact),
 * as opposed to a RESURFACING check (did a forgotten fact leak back out).
 * The two checks must be conservative in opposite directions: resurfacing
 * checks must be conservative about false accusations, so they favor
 * excluding question-echo keywords even if that shrinks the list a lot;
 * correctness checks must be conservative about false credit, so they must
 * never be left with an empty keyword list, since containsAny against an
 * empty list is always false and would make the check impossible to pass
 * (a different failure than a resurfacing false positive, but a failure
 * nonetheless). So the same question-echo exclusion is applied here, but
 * only when doing so does not empty out the list; if it would, this falls
 * back to the original, unfiltered keywords instead.
 */
function correctnessKeywords(keywords, questionText) {
  const effective = effectiveKeywords(keywords, questionText);
  return effective.length > 0 ? effective : keywords;
}

/** Appends one full-text recall answer record to state/forget/answers.jsonl. */
async function appendAnswer({ phase, label, trial, answer, durationMs, runId }) {
  await appendJsonl(ANSWERS_PATH, {
    phase,
    label,
    trial,
    answer,
    durationMs,
    runId,
    timestamp: new Date().toISOString(),
  });
}

function argHasHelp(argv) {
  return hasFlag(argv, "--help") || hasFlag(argv, "-h");
}

/**
 * Checks the handful of dist/ files this scenario spawns as subprocesses
 * (hooks invoked by the claude CLI via settings.json, the mcp server via
 * mcp.json, setupIndexes, and the consolidator). dist/project/projectKey.js
 * and dist/mcp/memoryForget.js are excluded here: this file imports them
 * statically at load time, so a missing one already fails loudly as a
 * Node module-resolution error before main() ever runs.
 */
function verifyBuilt(root) {
  const required = [
    path.join(root, "dist", "hooks", "sessionStart.js"),
    path.join(root, "dist", "hooks", "userPromptSubmit.js"),
    path.join(root, "dist", "hooks", "sessionEnd.js"),
    path.join(root, "dist", "mcp", "server.js"),
    path.join(root, "dist", "db", "setupIndexes.js"),
    path.join(root, "dist", "consolidation", "cli.js"),
  ];
  const missing = required.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.error("Missing built file(s), run `npm run build` first:");
    for (const m of missing) console.error(`  ${m}`);
    return false;
  }
  return true;
}

function failInfra(message) {
  console.error(`[forget] INFRA ERROR: ${message}`);
  process.exit(1);
}

async function gitInitIfNeeded(dir) {
  await ensureDir(dir);
  const gitDir = path.join(dir, ".git");
  if (fs.existsSync(gitDir)) return;
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "gauntlet@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Memory Gauntlet"], { cwd: dir, stdio: "ignore" });
}

async function writeWorkspaceFiles(dir) {
  const readmePath = path.join(dir, "README.md");
  if (!fs.existsSync(readmePath)) {
    await fsp.writeFile(
      readmePath,
      "# meridian-secrets\n\nA fictional internal ops/secrets service used as the fixture for the memory " +
        "gauntlet's forget scenario (Scenario C, long-horizon gap 5). Not a real project.\n",
      "utf8"
    );
  }
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    const pkg = {
      name: "meridian-secrets",
      version: "0.0.0",
      private: true,
      description: "Fixture ops service repo for the memory gauntlet forget scenario.",
    };
    await fsp.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }
}

// Mirrors setup.mjs's writeEngineSettings, collapsed to this scenario's one
// config dir instead of looping over engine arms.
async function writeScenarioSettings(root, cfgDir) {
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

// Mirrors setup.mjs's writeEngineMcpConfig, pointed at this scenario's own
// scratch database.
async function writeScenarioMcpConfig(root, cfgDir, dbName) {
  const serverPath = path.join(root, "dist", "mcp", "server.js");
  const mcp = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [serverPath],
        env: {
          MEMORY_MONGODB_DB: dbName,
        },
      },
    },
    _passthroughEnvNote:
      "MDB_MCP_CONNECTION_STRING, MEMORY_MONGODB_URI, VOYAGE_API_KEY, VOYAGE_MODEL, VOYAGE_DIMENSIONS, " +
      "VOYAGE_BASE_URL, RERANK_MODE, EMBEDDING_MODE are inherited from the claude process environment at " +
      "spawn time (not set in this file).",
  };
  await ensureDir(cfgDir);
  await fsp.writeFile(MCP_CONFIG_PATH, JSON.stringify(mcp, null, 2) + "\n", "utf8");
  return MCP_CONFIG_PATH;
}

/**
 * Base env for every claude CLI invocation and every manual hook invocation
 * in this scenario: scratch CLAUDE_CONFIG_DIR, scratch database, scratch
 * brief cache dir. Deliberately does NOT set HOOK_INTERNAL_TIMEOUT_MS or any
 * other engine tuning knob, same rationale as lib.mjs's envForArm: production
 * defaults must apply here unless the operator exports an override in their
 * own shell.
 */
function scenarioEnv(dbName) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    MEMORY_MONGODB_DB: dbName,
    MEMORY_BRIEF_CACHE_DIR: CACHE_DIR,
  };
}

/**
 * Equivalent of lib.mjs's nativeMemoryDirs(arm), but parameterized by an
 * explicit config dir instead of an arm name, since this scenario's config
 * dir does not live under lib.mjs's arm-shaped state layout. Native
 * auto-memory lives at <cfgDir>/projects/<slug>/memory, one level under
 * projects/, not directly under cfgDir/memory.
 */
function nativeMemoryDirsUnder(cfgDir) {
  const projectsDir = path.join(cfgDir, "projects");
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

/**
 * Full native-memory wipe, mirrors seed.mjs's quarantineEngineArm. Runs
 * right after seeding AND before EVERY recall trial, pre-forget and
 * post-forget alike.
 *
 * Product insight the first live run of this scenario exposed, verbatim:
 * Claude Code's native auto-memory can save a fact DURING a recall trial,
 * and the engine's memory_forget cannot reach that native copy, so in a
 * combined engine-plus-native configuration a forgotten fact can survive in
 * native memory; this scenario wipes native memory to isolate the engine's
 * forget path specifically.
 *
 * That is why the recall phase uses control-arm semantics (wipe, never
 * refuse): in that live run, a PRE-forget recall trial itself wrote 2 real
 * files into the native memory dir (the model saved what it had just
 * recalled), so a hard contamination refusal aborts every honest run of
 * this engine-only measurement. The per-trial wipe IS the guarantee that
 * each answer comes from the engine's brief and memory_search alone. Only
 * dir and file counts are logged, never contents.
 */
async function quarantineNativeMemory(runId, phase) {
  const dirs = nativeMemoryDirsUnder(CONFIG_DIR);
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
    console.log(`[forget] quarantine (${phase}): removed ${dirs.length} native memory dir(s), ${fileCount} file(s)`);
  }
  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: `quarantine-${phase}`,
    runId,
    dirsRemoved: dirs.length,
    filesRemoved: fileCount,
  });
}

/**
 * Mirrors briefCache.ts's private (unexported) cacheFileFor: same charset
 * sanitization, needed here only so this scenario can assert on the concrete
 * cache file path for the derived project key. getProjectKey already
 * produces a slug within this safe charset, so the sanitization is a no-op
 * in practice, kept only to match the real implementation's contract exactly.
 */
function cacheFilePathFor(projectKey) {
  const safeName = projectKey.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(CACHE_DIR, `${safeName}.json`);
}

/** Mirrors seed.mjs's newestTranscript, parameterized by config dir instead of arm. */
async function newestTranscript(cfgDir) {
  const projectsDir = path.join(cfgDir, "projects");
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

/**
 * Manually invokes the SessionEnd hook binary, mirrors seed.mjs's
 * runManualSessionEnd: Claude Code cancels SessionEnd hooks in print mode
 * ("claude -p"), so the transcript observation never lands via the native
 * hook. Rejects a stale transcript (older than sessionStartMs) instead of
 * piping it, same guard as seed.mjs, so a leftover file from an earlier run
 * can never be mistaken for this session's.
 */
async function runManualSessionEnd(root, env, cwd, sessionStartMs, runId) {
  const { transcriptPath, mtimeMs } = await newestTranscript(CONFIG_DIR);

  if (!transcriptPath) {
    failInfra("no transcript found under config/projects/** after the seed session; nothing was captured");
  }
  if (mtimeMs < sessionStartMs) {
    failInfra(
      `stale transcript: newest file under config/projects/** is from ${new Date(mtimeMs).toISOString()}, ` +
        `expected something newer than ${new Date(sessionStartMs).toISOString()}`
    );
  }

  const payload = JSON.stringify({
    session_id: path.basename(transcriptPath, ".jsonl"),
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "SessionEnd",
    reason: "other",
  });

  const hookPath = path.join(root, "dist", "hooks", "sessionEnd.js");
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
  console.log(`[forget] sessionEnd-manual ${ok ? "ok" : "FAILED"} (${(durationMs / 1000).toFixed(1)}s)`);
  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "sessionEnd-manual",
    runId,
    exitCode: result.code,
    durationMs,
    outputPreview: (result.stdout || "").slice(0, 400),
  });

  if (!ok) {
    if (result.stderr) console.error(`    stderr: ${result.stderr.slice(0, 400)}`);
    failInfra("manual SessionEnd invocation failed; the seed session's facts were not captured as observations");
  }
}

const REQUIRED_INDEX_NAMES = ["beliefs_vec", "beliefs_text"];
const OPTIONAL_INDEX_NAME = "beliefs_vec_auto";

function defaultIndexTimeoutMs() {
  const raw = Number.parseInt(process.env.GAUNTLET_INDEX_TIMEOUT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

function runSetupIndexes(root, dbName) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MEMORY_MONGODB_DB: dbName };
    const child = spawn("node", [path.join(root, "dist", "db", "setupIndexes.js")], {
      cwd: root,
      env,
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

// Adapted from demo/gauntlet/ensure-indexes.mjs, collapsed to this scenario's
// single scratch database instead of looping over both engine arms: the
// dedupe/reconciliation vector index must be queryable before seeding, or
// consolidation silently no-ops dedupe for the whole run.
async function ensureIndexesReady(root, dbName) {
  console.log(`[forget] running index setup against database "${dbName}"...`);
  const code = await runSetupIndexes(root, dbName);
  if (code !== 0) {
    failInfra(`index setup exited with code ${code}`);
  }

  const { client, db } = await mongoClient(dbName);
  try {
    const timeoutMs = defaultIndexTimeoutMs();
    const startedAt = Date.now();
    let targetNames = null;

    for (;;) {
      const statusByName = await fetchSearchIndexStatus(db);
      if (targetNames === null) {
        targetNames = [...REQUIRED_INDEX_NAMES];
        if (statusByName.has(OPTIONAL_INDEX_NAME)) targetNames.push(OPTIONAL_INDEX_NAME);
        console.log(`[forget] waiting for search indexes to become queryable: ${targetNames.join(", ")}`);
      }

      const rows = targetNames.map((name) => {
        const entry = statusByName.get(name);
        return { name, queryable: !!entry && entry.queryable, status: entry ? entry.status : "(not found)" };
      });

      if (rows.every((row) => row.queryable)) {
        console.log("[forget] all required search indexes are queryable:");
        for (const row of rows) console.log(`  ${row.name}: queryable=${row.queryable} status=${row.status}`);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        for (const row of rows) {
          if (!row.queryable) console.error(`  ${row.name}: queryable=${row.queryable} status=${row.status}`);
        }
        failInfra(`timed out after ${timeoutMs}ms waiting for search indexes to become queryable`);
      }

      await sleep(5000);
    }
  } finally {
    await client.close();
  }
}

// Mirrors consolidate.mjs's runConsolidator against a single database.
// Consolidation env inherited from the caller, unmodified, other than the
// scratch database name: no widened timeouts, no substituted credentials.
function runConsolidationPass(root, dbName) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MEMORY_MONGODB_DB: dbName };
    const child = spawn("node", [path.join(root, "dist", "consolidation", "cli.js")], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") reject(new Error("node not found on PATH"));
      else reject(err);
    });
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

async function withDb(dbName, fn) {
  const { client, db } = await mongoClient(dbName);
  try {
    return await fn(db);
  } finally {
    await client.close();
  }
}

/** One recall trial: fresh session, engine config env, memory_search allowed. */
async function recallTrial(dbName, question) {
  const env = scenarioEnv(dbName);
  const args = buildClaudeArgs({
    text: question,
    continueSession: false,
    mcpConfigFile: MCP_CONFIG_PATH,
    allowedTools: [MEMORY_SEARCH_TOOL],
  });
  const result = await runClaude({ args, env, cwd: WORKSPACE_DIR });
  if (result.notFound) failInfra('"claude" CLI not found on PATH');
  return result;
}

function printPlan() {
  const dbName = scratchDbName();
  console.log("Scenario C (forget) plan, dry-run: no database connection, no claude process.\n");
  console.log(`Scratch database:      ${dbName}`);
  console.log(`Scratch config dir:    ${CONFIG_DIR}`);
  console.log(`Scratch workspace:     ${WORKSPACE_DIR}`);
  console.log(`Scratch brief cache:   ${CACHE_DIR}`);
  console.log(`Run info file:         ${RUN_INFO_PATH}`);
  console.log(`Summary output:        ${SUMMARY_PATH}`);
  console.log("");
  console.log("Steps that would run:");
  console.log("  1. (optional) --reset: drop the scratch database, delete state/forget/");
  console.log("  2. verify dist/ build artifacts exist");
  console.log("  3. mint + write a run id, provision workspace git repo + scratch config (hooks, mcp.json)");
  console.log("  4. run dist/db/setupIndexes.js against the scratch database, poll until search indexes are queryable");
  console.log('  5. seed ONE session, ONE prompt, planting a KEEP fact ("metrics flush port is 9412") and a');
  console.log('     FORGET fact ("legacy export token ... key meridian-legacy-export")');
  console.log("  6. manually invoke the SessionEnd hook against that session's transcript (print mode cancels it natively)");
  console.log("  7. quarantine native Claude Code auto-memory under the scratch config dir (full wipe)");
  console.log("  8. one consolidation pass against the scratch database");
  console.log("  9. pre-forget recall: 1 fresh trial each for KEEP and FORGET, assert both recall correctly (flagged if not);");
  console.log("     full native-memory wipe before EACH trial (a trial can itself save what it recalled into native memory)");
  console.log("  10. assert the local brief cache file for the derived project key now exists");
  console.log("  11. find the FORGET belief by regex, call the real runMemoryForget(db, { project, beliefId })");
  console.log("  12. deterministic checks: belief tombstoned, recompiled brief clean of FORGET keywords, cache file deleted");
  console.log("  13. post-forget recall: 2 fresh FORGET trials (must NOT resurface) + 1 fresh KEEP trial (must still work);");
  console.log("     full native-memory wipe before EACH trial, control-arm semantics, so the engine's forget path is");
  console.log("     measured in isolation (memory_forget cannot reach a native auto-memory copy of the fact)");
  console.log("  14. print summary table, write state/forget/summary.json");
  console.log("");
  console.log(
    "Project key is derived via getProjectKey(workspace dir) once the workspace git repo exists; not printed " +
      "here since it would be misleading before that git init happens (the fallback non-git key differs from it)."
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argHasHelp(argv)) {
    console.log(USAGE);
    process.exit(0);
  }

  const dbName = scratchDbName();
  assertSafeDbName(dbName);

  const dryRun = hasFlag(argv, "--dry-run");
  if (dryRun) {
    printPlan();
    return;
  }

  const doReset = hasFlag(argv, "--reset");
  const root = repoRoot();

  if (doReset) {
    console.log(`[forget] --reset: dropping database "${dbName}"...`);
    await withDb(dbName, async (db) => {
      await db.dropDatabase();
    });
    console.log(`[forget] --reset: deleting ${STATE_DIR}...`);
    await fsp.rm(STATE_DIR, { recursive: true, force: true });
    console.log("[forget] --reset: done.");
  }

  if (!verifyBuilt(root)) {
    process.exit(1);
  }

  await ensureDir(STATE_DIR);
  const runId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await fsp.writeFile(
    RUN_INFO_PATH,
    JSON.stringify({ runId, createdAt, model: MODEL(), dbName }, null, 2) + "\n",
    "utf8"
  );
  console.log(`[forget] run id: ${runId}`);

  // Every recall/hook invocation below reads process.env.MEMORY_BRIEF_CACHE_DIR
  // (briefCache.ts) at call time, including the deleteBriefCache() call INSIDE
  // runMemoryForget when we invoke it directly, in-process, further down. It
  // must be set on this process's own env, not only on the env objects handed
  // to spawned children.
  process.env.MEMORY_BRIEF_CACHE_DIR = CACHE_DIR;
  await ensureDir(CACHE_DIR);

  await gitInitIfNeeded(WORKSPACE_DIR);
  await writeWorkspaceFiles(WORKSPACE_DIR);
  await writeScenarioSettings(root, CONFIG_DIR);
  await writeScenarioMcpConfig(root, CONFIG_DIR, dbName);
  console.log(`[forget] workspace: ${WORKSPACE_DIR}`);
  console.log(`[forget] config dir: ${CONFIG_DIR}`);

  await ensureIndexesReady(root, dbName);

  const projectKey = getProjectKey(WORKSPACE_DIR);
  console.log(`[forget] derived project key: ${projectKey}`);

  // --- Seed: one session, one turn, two facts. ---
  const env = scenarioEnv(dbName);
  const sessionStartMs = Date.now();
  const seedArgs = buildClaudeArgs({ text: SEED_PROMPT, continueSession: false });
  console.log("[forget] seeding one session with the KEEP and FORGET facts...");
  const seedResult = await runClaude({ args: seedArgs, env, cwd: WORKSPACE_DIR });
  if (seedResult.notFound) failInfra('"claude" CLI not found on PATH');
  if (seedResult.code !== 0 || seedResult.timedOut) {
    failInfra(
      `seed session failed (code=${seedResult.code}, timedOut=${seedResult.timedOut}): ${(seedResult.stderr || "").slice(0, 400)}`
    );
  }
  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "seed",
    runId,
    exitCode: seedResult.code,
    durationMs: seedResult.durationMs,
    outputPreview: (seedResult.stdout || "").slice(0, 400),
  });

  await runManualSessionEnd(root, env, WORKSPACE_DIR, sessionStartMs, runId);
  await quarantineNativeMemory(runId, "post-seed");

  // --- One consolidation pass. ---
  console.log("[forget] running one consolidation pass...");
  const consolidateResult = await runConsolidationPass(root, dbName);
  if (consolidateResult.code !== 0) {
    failInfra(`consolidation exited with code ${consolidateResult.code}`);
  }

  // --- Pre-forget recall: both facts, 1 trial each, fresh sessions.
  // Full native-memory wipe before EVERY trial (see quarantineNativeMemory
  // for the product insight behind this): each trial can itself write into
  // native auto-memory, so each subsequent trial must start clean. ---
  console.log("[forget] pre-forget recall: KEEP fact...");
  await quarantineNativeMemory(runId, "pre-trial-keep");
  const preKeep = await recallTrial(dbName, KEEP_QUESTION);
  const preKeepCorrect = containsAny(preKeep.stdout, correctnessKeywords(KEEP_FACT.keywords, KEEP_QUESTION));
  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "recall-pre-keep",
    runId,
    correct: preKeepCorrect,
    outputPreview: (preKeep.stdout || "").slice(0, 400),
  });
  await appendAnswer({
    phase: "pre-forget",
    label: "keep",
    trial: 1,
    answer: preKeep.stdout || "",
    durationMs: preKeep.durationMs,
    runId,
  });
  if (!preKeepCorrect) {
    console.error("[forget] FLAGGED: pre-forget KEEP recall missed the fact; continuing anyway.");
  }

  console.log("[forget] pre-forget recall: FORGET fact...");
  await quarantineNativeMemory(runId, "pre-trial-forget");
  const preForgetAnswer = await recallTrial(dbName, FORGET_QUESTION);
  const preForgetCorrect = containsAny(
    preForgetAnswer.stdout,
    correctnessKeywords(FORGET_FACT.keywords, FORGET_QUESTION)
  );
  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "recall-pre-forget",
    runId,
    correct: preForgetCorrect,
    outputPreview: (preForgetAnswer.stdout || "").slice(0, 400),
  });
  await appendAnswer({
    phase: "pre-forget",
    label: "forget",
    trial: 1,
    answer: preForgetAnswer.stdout || "",
    durationMs: preForgetAnswer.durationMs,
    runId,
  });
  if (!preForgetCorrect) {
    console.error("[forget] FLAGGED: pre-forget FORGET recall missed the fact; continuing anyway.");
  }

  const cacheFilePath = cacheFilePathFor(projectKey);
  const cachePresentAfterPreForget = fs.existsSync(cacheFilePath);
  console.log(
    `[forget] brief cache file after pre-forget recall: ${cachePresentAfterPreForget ? "present" : "MISSING (flagged)"} (${cacheFilePath})`
  );

  // --- Forget: find the belief, call the real contract, capture the result. ---
  console.log("[forget] locating the FORGET belief by regex before forgetting it...");
  const forgetPattern = FORGET_FACT.keywords.map((k) => keywordRegexSource(k)).join("|");

  const forgetOutcome = await withDb(dbName, async (db) => {
    const beliefs = db.collection("beliefs");
    const found = await beliefs.findOne({
      status: "active",
      project: projectKey,
      text: { $regex: forgetPattern, $options: "i" },
    });
    if (!found) {
      failInfra(
        "no active belief matched the FORGET fact's keywords; consolidation did not produce a belief to forget"
      );
    }
    const beliefId = found._id.toString();
    console.log(`[forget] found FORGET belief _id=${beliefId}, calling runMemoryForget(db, { project, beliefId })...`);

    // Exact contract src/mcp/server.ts uses for the memory_forget tool:
    // runMemoryForget(db, { project, beliefId }), default deps (real
    // compileBrief). No text-match variant exists; belief id is the only
    // accepted target, hence the regex lookup above.
    const forgetResult = await runMemoryForget(db, { project: projectKey, beliefId });

    const refetched = await beliefs.findOne({ _id: found._id });
    const tombstoned = refetched?.status === "tombstoned";

    const briefsColl = db.collection("briefs");
    const [globalBrief, projectBrief] = await Promise.all([
      briefsColl.findOne({ _id: "brief:global" }),
      briefsColl.findOne({ _id: `brief:${projectKey}` }),
    ]);
    const briefsChecked = [];
    let briefClean = true;
    for (const [label, doc] of [["global", globalBrief], ["project", projectBrief]]) {
      if (!doc) continue;
      const clean = !containsAny(doc.content, FORGET_FACT.keywords);
      briefsChecked.push({ brief: label, clean });
      if (!clean) briefClean = false;
    }

    return { beliefId, forgetResult, tombstoned, briefClean, briefsChecked };
  });

  const cacheDeletedAfterForget = !fs.existsSync(cacheFilePath);
  console.log(
    `[forget] belief tombstoned: ${forgetOutcome.tombstoned}, recompiled brief clean: ${forgetOutcome.briefClean}, ` +
      `cache deleted: ${cacheDeletedAfterForget}`
  );

  // --- Post-forget recall. ---
  // Resurface detection uses the question-echo-excluded keyword list (see
  // effectiveKeywords above): a correct denial naturally echoes the
  // question's own wording back ("nothing about a legacy export token or
  // vault key"), and FORGET_QUESTION itself contains the literal phrase
  // "legacy export token", so that keyword alone is not evidence of
  // resurfacing. Only tokens absent from the question (the actual vault key
  // value, "meridian-legacy-export") are unguessable enough to count.
  const forgetResurfaceKeywords = effectiveKeywords(FORGET_FACT.keywords, FORGET_QUESTION);
  console.log(
    `[forget] resurface keyword list (question-echo excluded): ${JSON.stringify(forgetResurfaceKeywords)} ` +
      `(full list was ${JSON.stringify(FORGET_FACT.keywords)})`
  );

  console.log("[forget] post-forget recall: FORGET fact, 2 trials (must not resurface)...");
  const forgetTrials = [];
  for (let trial = 1; trial <= 2; trial++) {
    await quarantineNativeMemory(runId, `post-forget-trial-${trial}`);
    const answer = await recallTrial(dbName, FORGET_QUESTION);
    const resurfaced = containsAny(answer.stdout, forgetResurfaceKeywords);
    forgetTrials.push({
      trial,
      resurfaced,
      verdict: resurfaced ? "FAIL (resurfaced)" : "PASS (forgotten)",
      answer: answer.stdout || "",
      durationMs: answer.durationMs,
    });
    await appendJsonl(LOG_PATH, {
      timestamp: new Date().toISOString(),
      phase: "recall-post-forget",
      runId,
      trial,
      resurfaced,
      outputPreview: (answer.stdout || "").slice(0, 400),
    });
    await appendAnswer({
      phase: "post-forget",
      label: "forget",
      trial,
      answer: answer.stdout || "",
      durationMs: answer.durationMs,
      runId,
    });
    await sleep(2000);
  }

  console.log("[forget] post-forget recall: KEEP fact, 1 trial (must still be correct)...");
  await quarantineNativeMemory(runId, "post-forget-keep");
  const keepAnswerAfter = await recallTrial(dbName, KEEP_QUESTION);
  const keepStillCorrect = containsAny(keepAnswerAfter.stdout, KEEP_FACT.keywords);
  await appendJsonl(LOG_PATH, {
    timestamp: new Date().toISOString(),
    phase: "recall-post-keep",
    runId,
    correct: keepStillCorrect,
    outputPreview: (keepAnswerAfter.stdout || "").slice(0, 400),
  });
  await appendAnswer({
    phase: "post-forget",
    label: "keep",
    trial: 1,
    answer: keepAnswerAfter.stdout || "",
    durationMs: keepAnswerAfter.durationMs,
    runId,
  });

  // --- Summary. ---
  const summary = {
    runId,
    model: MODEL(),
    createdAt,
    dbName,
    projectKey,
    preForget: {
      keep: { correct: preKeepCorrect, answer: preKeep.stdout || "" },
      forget: { correct: preForgetCorrect, answer: preForgetAnswer.stdout || "" },
    },
    cachePresentAfterPreForget,
    forget: {
      beliefId: forgetOutcome.beliefId,
      matched: forgetOutcome.forgetResult.matched,
      recompiled: forgetOutcome.forgetResult.recompiled,
    },
    postForget: {
      tombstoned: forgetOutcome.tombstoned,
      briefClean: forgetOutcome.briefClean,
      briefsChecked: forgetOutcome.briefsChecked,
      cacheDeleted: cacheDeletedAfterForget,
      recall: {
        forgetTrials,
        keepTrial: { correct: keepStillCorrect, answer: keepAnswerAfter.stdout || "" },
      },
    },
  };
  await ensureDir(STATE_DIR);
  await fsp.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log(`\n=== Scenario C (forget) summary, run ${runId} ===`);
  console.log(`Database:                ${dbName}`);
  console.log(`Project key:              ${projectKey}`);
  console.log("");
  console.log("Pre-forget recall (1 trial each, fresh session):");
  console.log(`  KEEP fact:              ${preKeepCorrect ? "correct" : "MISS (flagged)"}`);
  console.log(`  FORGET fact:            ${preForgetCorrect ? "correct" : "MISS (flagged)"}`);
  console.log(`  brief cache present:    ${cachePresentAfterPreForget ? "yes" : "NO (flagged)"}`);
  console.log("");
  console.log("Forget call (runMemoryForget, same contract as the memory_forget MCP tool):");
  console.log(`  belief id:              ${forgetOutcome.beliefId}`);
  console.log(`  matched:                ${forgetOutcome.forgetResult.matched}`);
  console.log(`  recompiled:             ${forgetOutcome.forgetResult.recompiled}`);
  console.log("");
  console.log("Post-forget deterministic checks:");
  console.log(`  belief tombstoned:      ${forgetOutcome.tombstoned ? "yes" : "NO (FAIL)"}`);
  console.log(`  recompiled brief clean: ${forgetOutcome.briefClean ? "yes" : "NO (FAIL)"}`);
  console.log(`  brief cache deleted:    ${cacheDeletedAfterForget ? "yes" : "NO (FAIL)"}`);
  console.log("");
  console.log("Post-forget recall:");
  for (const t of forgetTrials) {
    console.log(`  FORGET trial ${t.trial}:         ${t.verdict}`);
  }
  console.log(`  KEEP trial (surgical): ${keepStillCorrect ? "PASS (still correct)" : "FAIL (regressed)"}`);
  console.log("");
  console.log(`Summary written to ${SUMMARY_PATH}`);
}

main().catch((err) => {
  console.error("scenario-c-forget failed:", err && err.message ? err.message : err);
  process.exit(1);
});
