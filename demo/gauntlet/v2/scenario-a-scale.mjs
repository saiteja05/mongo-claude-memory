#!/usr/bin/env node
// Scenario A (long-horizon gap 1 from the red team): nothing in the existing
// gauntlet tests whether the RIGHT beliefs survive brief compilation when
// hundreds of beliefs compete for the token cap. Every existing seed/recall
// session seeds a handful of facts per project, so the project-scope query
// in compileBrief.ts never has to choose a winner under real pressure.
//
// This scenario builds that pressure deterministically:
//   1. Inserts 12 TARGET beliefs (facts about a fictional "meridian" API
//      gateway, invented so model world-knowledge cannot answer the recall
//      questions) plus 188 template-generated FILLER beliefs, all under one
//      project, all scope "project".
//   2. Runs the real compiler (dist/consolidation/compileBrief.js) against
//      the scratch database and reads back the resulting brief document.
//   3. Measures, with no LLM involved, which of the 12 targets survived
//      ranking into the brief's content, the brief's token_estimate against
//      the configured cap, and how many beliefs (out of 200) made it in.
//   4. Optionally closes the loop end to end: spins up an isolated
//      CLAUDE_CONFIG_DIR (hooks settings.json + mcp.json, mirroring
//      setup.mjs) and a scratch workspace directory, then asks each target's
//      recall question in one fresh "claude -p" session per target, with no
//      --mcp-config/--allowedTools grant, so a correct answer can only come
//      from the brief the SessionStart hook injected, never from a
//      memory_search tool call.
//
// Project key correctness: the SessionStart hook derives its project key
// from the session's cwd via getProjectKey(cwd) (dist/project/projectKey.js),
// NOT from any string this script picks. If beliefs were inserted under an
// arbitrary literal like "v2-scale-fixture", the hook would look for
// brief:<derived-key>, find nothing, and every recall trial would silently
// run memoryless. Two requirements follow:
//
//   1. The scratch workspace must be its OWN git repository. It lives nested
//      inside the mongo-claude-memory repo, and getProjectKey's path mode
//      runs "git rev-parse --git-common-dir" from the cwd: without its own
//      .git that command still SUCCEEDS by resolving the ENCLOSING repo, so
//      the hook would derive the parent repo's key, not this fixture's. The
//      pure path-hash fallback only fires when git resolution fails
//      entirely, which it never does for a directory nested inside a repo.
//      So this script git-inits the workspace (fixed committer identity and
//      a minimal commit, same pattern as demo/gauntlet/setup.mjs) before
//      anything else.
//   2. The key must be derived AFTER that git init, via
//      getProjectKey(workspaceDir), and used as the `project` field on every
//      belief and as the compileBrief scopeKey, so the brief the hook
//      fetches at recall time is the exact brief compiled here. A hard
//      pre-flight assertion right before recall recomputes the key exactly
//      the way the hook will and verifies the brief document exists under
//      it in the scratch DB, exiting nonzero if not.
//
// "v2-scale-fixture" is only the human-readable prefix of the derived key
// (basename of the workspace repo root), not the key in full.
//
// Determinism: fixture generation uses a mulberry32 PRNG seeded with a fixed
// constant (FIXTURE_SEED), so --dry-run and a real run generate byte-for-byte
// identical beliefs given the same seed, and the only non-deterministic input
// to the whole scenario is the model's own answers during recall.
//
// answers.jsonl accumulates across runs (each line stamped with its own
// runId), matching lib.mjs's appendJsonl helper; summary.json is overwritten
// each run with the latest snapshot.

import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  repoRoot,
  ensureDir,
  mongoClient,
  MODEL,
  buildClaudeArgs,
  runClaude,
  appendJsonl,
  containsAny,
  sleep,
  MCP_SERVER_NAME,
} from "../lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SCRATCH_DB = "claude_memory_gauntlet_v2_scale";
const WORKSPACE_LABEL = "v2-scale-fixture";
// Fixed for determinism across runs: --dry-run and a real run must generate
// byte-for-byte identical fixtures given this same seed.
const FIXTURE_SEED = 20260713;
const TARGET_COUNT = 12;
const FILLER_COUNT = 188;
const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE = `Usage: node demo/gauntlet/v2/scenario-a-scale.mjs [--reset] [--dry-run] [--no-recall] [--help]

Long-horizon gap 1 (red team): tests whether the right beliefs survive brief
compilation when hundreds of beliefs compete for the token cap.

Steps:
  1. Creates the scratch workspace and git-inits it (its own .git, so the
     SessionStart hook resolves the workspace's key, not the enclosing
     repo's), then derives the real project key from it (see the header
     comment for why this ordering matters).
  2. Generates 12 TARGET beliefs (fictional "meridian" API gateway facts,
     invented so model world knowledge cannot answer them) plus 188
     template-generated FILLER beliefs, all deterministic (seeded PRNG).
  3. Inserts all 200 into "${SCRATCH_DB}", then imports and runs the real
     compileBrief (dist/consolidation/compileBrief.js) against that database.
  4. Prints deterministic ranking metrics (no LLM): which targets survived
     into the brief, token_estimate vs the configured cap, beliefs included.
  5. Unless --no-recall: wires an isolated CLAUDE_CONFIG_DIR (hooks +
     mcp.json, mirroring setup.mjs) and runs one fresh "claude -p" trial per
     target asking its recall question, with no memory_search tool grant, so
     a correct answer can only come from the SessionStart-injected brief.
     Appends results to state/scale/answers.jsonl.
  6. Writes state/scale/summary.json with every metric, the runId, and
     timestamps.

  --reset       drop the scratch database first (refuses if the resolved
                name does not contain "gauntlet")
  --dry-run     generate and print the fixtures only: distributions and the
                12 targets' ids/questions. No DB writes, no git init, no
                claude calls; the printed project key is provisional unless
                a previous live run already git-inited the workspace.
  --no-recall   run steps 1-4 only (fixtures, insert, compile, deterministic
                metrics) and stop before end-to-end recall.
  --help        print this message

Requires dist/ to be built (run "npm run build" first) and a MongoDB
connection string in MDB_MCP_CONNECTION_STRING or MEMORY_MONGODB_URI. Exits
nonzero only on infrastructure failure (fewer than 12 targets inserted, the
brief failed to compile, or the recall pre-flight project-key check failed);
ranking misses and recall misses are RESULTS, not errors, and never fail the
run.
`;

// --- fictional fixture world: the "meridian" API gateway -------------------
// Made up on purpose: service names, ports, header names, team names, and
// rotation periods with deliberately unusual values, so a model cannot
// answer any of these from world knowledge alone.
const TARGET_FACTS = [
  {
    id: "t01",
    statement:
      "The Meridian gateway rotates its service-to-service auth tokens every 45 days.",
    question: "How often does the Meridian gateway rotate its service-to-service auth tokens?",
    expected_any: ["45 days"],
    wrong_any: ["30 days", "60 days", "90 days"],
  },
  {
    id: "t02",
    statement: "The Meridian gateway's internal health-check listener runs on port 47331.",
    question: "What port does the Meridian gateway's internal health-check listener run on?",
    expected_any: ["47331"],
    wrong_any: ["8080", "3000", "47330"],
  },
  {
    id: "t03",
    statement: "The Meridian gateway's rate-limit lease renews every 21 minutes.",
    question: "How long is the Meridian gateway's rate-limit lease renewal window?",
    expected_any: ["21 minutes"],
    wrong_any: ["15 minutes", "30 minutes", "20 minutes"],
  },
  {
    id: "t04",
    statement:
      "The Meridian gateway propagates its trace epoch in the X-Meridian-Trace-Epoch header.",
    question: "What header does the Meridian gateway use to propagate its trace epoch?",
    expected_any: ["X-Meridian-Trace-Epoch"],
    wrong_any: ["X-Request-Id", "X-Trace-Id"],
  },
  {
    id: "t05",
    statement: "Team Lumen owns the Meridian gateway service.",
    question: "Which team owns the Meridian gateway service?",
    expected_any: ["Team Lumen", "Lumen"],
    wrong_any: ["Corvus Guild", "Team Corvus"],
  },
  {
    id: "t06",
    statement:
      "The Meridian gateway pins a request to a shard using the X-Meridian-Shard-Affinity header.",
    question: "What header does the Meridian gateway use to pin a request to a specific shard?",
    expected_any: ["X-Meridian-Shard-Affinity"],
    wrong_any: ["X-Shard-Id", "X-Affinity"],
  },
  {
    id: "t07",
    statement: "The Meridian gateway's failover listener runs on port 58210.",
    question: "What port does the Meridian gateway's failover listener run on?",
    expected_any: ["58210"],
    wrong_any: ["8443", "58211"],
  },
  {
    id: "t08",
    statement: "Meridian edge nodes rotate their TLS certificates every 17 hours.",
    question: "How often do Meridian edge nodes rotate their TLS certificates?",
    expected_any: ["17 hours"],
    wrong_any: ["24 hours", "12 hours"],
  },
  {
    id: "t09",
    statement: "Corvus Guild owns the Meridian gateway's billing-reconciliation job.",
    question: "Which team owns the Meridian gateway's billing-reconciliation job?",
    expected_any: ["Corvus Guild", "Corvus"],
    wrong_any: ["Team Lumen", "Lumen"],
  },
  {
    id: "t10",
    statement: "The Meridian gateway's retry queue is named meridian-ledger-retry-q.",
    question: "What is the Meridian gateway's retry queue named?",
    expected_any: ["meridian-ledger-retry-q"],
    wrong_any: ["meridian-retry-queue", "ledger-retry-queue"],
  },
  {
    id: "t11",
    statement: "The Meridian gateway's admin config API is served on port 61190.",
    question: "What port serves the Meridian gateway's admin config API?",
    expected_any: ["61190"],
    wrong_any: ["9090", "61191"],
  },
  {
    id: "t12",
    statement: "The Meridian gateway's edge-cache session lease has a TTL of 53 seconds.",
    question: "What is the TTL of the Meridian gateway's edge-cache session lease?",
    expected_any: ["53 seconds"],
    wrong_any: ["60 seconds", "30 seconds"],
  },
];

if (TARGET_FACTS.length !== TARGET_COUNT) {
  throw new Error(`TARGET_FACTS has ${TARGET_FACTS.length} entries, expected ${TARGET_COUNT}`);
}

// --- filler fixture templates: plausible, generic dev-project facts --------
const FILLER_SUBJECTS = [
  "the payments service",
  "the auth service",
  "the search indexer",
  "the billing worker",
  "the notification service",
  "the admin dashboard",
  "the analytics pipeline",
  "the file-upload service",
  "the recommendation engine",
  "the session store",
  "the rate limiter",
  "the webhook dispatcher",
  "the audit logger",
  "the feature-flag service",
  "the export job",
  "the import job",
  "the cache warmer",
  "the reconciliation worker",
  "the metrics aggregator",
  "the alerting service",
  "the onboarding flow",
  "the checkout service",
  "the inventory sync job",
  "the search reindex job",
  "the email digest job",
];

const FILLER_TEMPLATES = [
  (s, v) => `${s} deploys to ${v.env} via GitHub Actions.`,
  (s, v) => `${s} is written in ${v.lang} ${v.version}.`,
  (s, v) => `${s}'s primary datastore is ${v.db}.`,
  (s, v) => `${s} runs on a ${v.cron} schedule.`,
  (s, v) => `${s}'s on-call rotation is owned by the ${v.team} team.`,
  (s, v) => `${s} retries failed jobs up to ${v.n} times before giving up.`,
  (s, v) => `${s} logs to ${v.logdest}.`,
  (s, v) => `${s}'s configuration lives in ${v.configpath}.`,
  (s, v) => `${s} uses ${v.queue} as its job queue.`,
  (s, v) => `${s}'s test suite takes about ${v.mins} minutes to run in CI.`,
  (s, v) => `${s} is fronted by ${v.proxy}.`,
  (s, v) => `${s} emits metrics tagged with ${v.tag}.`,
];

const ENV_VALUES = ["staging", "production", "us-east-1", "eu-west-1", "the canary cluster"];
const LANG_VALUES = ["TypeScript", "Go", "Python", "Java", "Rust"];
const VERSION_VALUES = ["5.4", "1.22", "3.11", "17", "1.75"];
const DB_VALUES = ["PostgreSQL", "MongoDB", "Redis", "DynamoDB", "MySQL"];
const CRON_VALUES = ["hourly", "every 6 hours", "nightly", "every 15 minutes", "weekly"];
const TEAM_VALUES = ["Platform", "Payments", "Growth", "Infra", "Data"];
const N_VALUES = [1, 2, 3, 4, 5];
const LOGDEST_VALUES = ["Datadog", "CloudWatch", "an internal ELK stack", "Honeycomb"];
const CONFIGPATH_VALUES = [
  "config/production.yaml",
  "a Consul KV namespace",
  "an .env file loaded at boot",
  "a ConfigMap",
];
const QUEUE_VALUES = ["SQS", "RabbitMQ", "Kafka", "BullMQ", "a Postgres-backed queue"];
const MINS_VALUES = [3, 5, 8, 12, 20];
const PROXY_VALUES = ["an internal ALB", "Envoy", "nginx", "a service mesh sidecar"];
const TAG_VALUES = ["team:platform", "env:prod", "tier:critical", "service:core"];

// --- deterministic PRNG (mulberry32) ---------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

function randInt(rng, min, max) {
  return Math.floor(randRange(rng, min, max + 1));
}

function capitalize(s) {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

function daysAgo(now, days) {
  return new Date(now.getTime() - days * DAY_MS);
}

function statRange(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, avg };
}

// --- belief document construction (src/db/schema.ts Belief fields) --------
function makeBeliefDoc(rng, { project, type, text, importance, lastEvidenceAt, useCount, now, fixtureKind }) {
  const createdBeforeDays = randRange(rng, 1, 30);
  const boundedEvidence = Math.min(lastEvidenceAt.getTime(), now.getTime());
  const createdAt = new Date(boundedEvidence - createdBeforeDays * DAY_MS);
  const doc = {
    project,
    scope: "project",
    type,
    text,
    // embedding intentionally omitted: compileBrief.ts (src/consolidation/
    // compileBrief.ts) ranks and renders belief.text directly and never
    // reads belief.embedding, so brief compilation needs no vector at all.
    importance,
    use_count: useCount,
    created_at: createdAt,
    updated_at: lastEvidenceAt,
    last_evidence_at: lastEvidenceAt,
    version: 1,
    status: "active",
    observation_ids: [],
    // Extra field, not part of the core schema but allowed by Belief's index
    // signature: lets the insert-verification step count targets precisely
    // instead of trusting insertMany's aggregate count alone.
    fixture_kind: fixtureKind,
  };
  if (useCount > 0) doc.last_used = lastEvidenceAt;
  return doc;
}

function buildTargetBeliefs(rng, now, projectKey) {
  return TARGET_FACTS.map((fact) => {
    const importance = randRange(rng, 0.75, 0.95);
    const lastEvidenceAt = daysAgo(now, randRange(rng, 0, 7));
    const useCount = randInt(rng, 0, 12);
    const doc = makeBeliefDoc(rng, {
      project: projectKey,
      type: "reference",
      text: fact.statement,
      importance,
      lastEvidenceAt,
      useCount,
      now,
      fixtureKind: "target",
    });
    return { fact, doc, importance, lastEvidenceAt, useCount, inBrief: null };
  });
}

function buildFillerBeliefs(rng, now, projectKey) {
  const items = [];
  for (let i = 0; i < FILLER_COUNT; i++) {
    const subject = pick(rng, FILLER_SUBJECTS);
    const template = pick(rng, FILLER_TEMPLATES);
    const values = {
      env: pick(rng, ENV_VALUES),
      lang: pick(rng, LANG_VALUES),
      version: pick(rng, VERSION_VALUES),
      db: pick(rng, DB_VALUES),
      cron: pick(rng, CRON_VALUES),
      team: pick(rng, TEAM_VALUES),
      n: pick(rng, N_VALUES),
      logdest: pick(rng, LOGDEST_VALUES),
      configpath: pick(rng, CONFIGPATH_VALUES),
      queue: pick(rng, QUEUE_VALUES),
      mins: pick(rng, MINS_VALUES),
      proxy: pick(rng, PROXY_VALUES),
      tag: pick(rng, TAG_VALUES),
    };
    const text = capitalize(template(subject, values));
    const importance = randRange(rng, 0.3, 0.9);
    const lastEvidenceAt = daysAgo(now, randRange(rng, 0, 90));
    // The spec ties "use_count 0-12" to fillers explicitly; targets get the
    // same range below since use_count is a required schema field and the
    // ranking dimension this scenario stresses is importance/recency, not
    // use_count, so one shared range for both is a reasonable default.
    const useCount = randInt(rng, 0, 12);
    const doc = makeBeliefDoc(rng, {
      project: projectKey,
      type: "convention",
      text,
      importance,
      lastEvidenceAt,
      useCount,
      now,
      fixtureKind: "filler",
    });
    items.push({ doc, importance, lastEvidenceAt, useCount });
  }
  return items;
}

function generateFixtures(rng, now, projectKey) {
  const targets = buildTargetBeliefs(rng, now, projectKey);
  const fillerItems = buildFillerBeliefs(rng, now, projectKey);
  return { targets, fillerItems };
}

// --- scratch state paths -----------------------------------------------
function scenarioStateDir() {
  return path.join(HERE, "state", "scale");
}

function scratchWorkspaceDir() {
  return path.join(scenarioStateDir(), "workspace", WORKSPACE_LABEL);
}

function scratchConfigDir() {
  return path.join(scenarioStateDir(), "config");
}

function answersPath() {
  return path.join(scenarioStateDir(), "answers.jsonl");
}

function summaryPath() {
  return path.join(scenarioStateDir(), "summary.json");
}

// Makes the scratch workspace its OWN git repository (fixed committer
// identity, same pattern as setup.mjs's gitInitIfNeeded, plus one minimal
// commit so the git dir is a real repository root). Without this,
// getProjectKey's "git rev-parse --git-common-dir" resolves the ENCLOSING
// mongo-claude-memory repo and the SessionStart hook derives the parent
// repo's key instead of this fixture's; see the header comment.
async function ensureWorkspaceGitRepo(dir) {
  await ensureDir(dir);
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(["init", "-q"]);
    git(["config", "user.email", "gauntlet@example.com"]);
    git(["config", "user.name", "Memory Gauntlet"]);
  }
  const readmePath = path.join(dir, "README.md");
  if (!fs.existsSync(readmePath)) {
    await fsp.writeFile(
      readmePath,
      `# ${WORKSPACE_LABEL}\n\nScratch workspace for the gauntlet v2 scale scenario. Not a real project.\n`,
      "utf8"
    );
  }
  let hasCommit = true;
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir, stdio: "ignore" });
  } catch {
    hasCommit = false;
  }
  if (!hasCommit) {
    git(["add", "-A"]);
    git(["commit", "-q", "--no-gpg-sign", "-m", "fixture workspace init"]);
  }
}

function assertSafeDbName(name) {
  if (!name.includes("gauntlet")) {
    console.error(
      `Refusing: scratch database name "${name}" does not contain "gauntlet". This guard exists ` +
        "so this scenario can never be pointed at a database outside the gauntlet's own namespace."
    );
    process.exit(1);
  }
}

// --- engine-arm-style config dir (mirrors setup.mjs) ------------------------
function verifyHooksExist(root) {
  const hookFiles = ["sessionStart.js", "userPromptSubmit.js", "sessionEnd.js"].map((f) =>
    path.join(root, "dist", "hooks", f)
  );
  const missing = hookFiles.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.error("Missing built hook files, run `npm run build` first:");
    for (const m of missing) console.error(`  ${m}`);
    return false;
  }
  return true;
}

async function writeScratchSettings(root, cfgDir) {
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
        { hooks: [{ type: "command", command: hookCmd("userPromptSubmit.js") }] },
      ],
      SessionEnd: [{ hooks: [{ type: "command", command: hookCmd("sessionEnd.js") }] }],
    },
  };
  await ensureDir(cfgDir);
  const settingsPath = path.join(cfgDir, "settings.json");
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settingsPath;
}

// Written for parity with the real engine-arm config, even though this
// scenario never passes --mcp-config to the claude CLI: recall here measures
// passive SessionStart brief injection only, never a memory_search tool call.
async function writeScratchMcpConfig(root, cfgDir) {
  const serverPath = path.join(root, "dist", "mcp", "server.js");
  const mcp = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [serverPath],
        env: { MEMORY_MONGODB_DB: SCRATCH_DB },
      },
    },
    _note:
      "Present for parity with the real engine-arm config (see setup.mjs). This scenario's " +
      "recall trials do not pass --mcp-config, so memory_search is never an allowed tool: the " +
      "point is to measure whether the SessionStart-injected brief alone carries the fact, not " +
      "whether the model can proactively search memory.",
  };
  await ensureDir(cfgDir);
  const mcpPath = path.join(cfgDir, "mcp.json");
  await fsp.writeFile(mcpPath, JSON.stringify(mcp, null, 2) + "\n", "utf8");
  return mcpPath;
}

// --- dry-run report ----------------------------------------------------
function printDryRunReport(projectKey, targets, fillerItems, now, doReset, workspaceInitialized) {
  if (workspaceInitialized) {
    console.log(`Derived project key: ${projectKey} (workspace git repo already initialized)`);
  } else {
    console.log(
      `Provisional project key: ${projectKey} (dry-run does not git-init the workspace; a live ` +
        "run git-inits it FIRST and derives the key from the workspace's own .git dir, so the " +
        "real key will differ)"
    );
  }
  if (doReset) {
    console.log(`(dry-run) --reset given: would also drop database "${SCRATCH_DB}" first.`);
  }
  console.log("(dry-run) no DB writes, no git init, no claude calls.\n");

  const targetImportances = targets.map((t) => t.importance);
  const targetDaysAgo = targets.map((t) => (now.getTime() - t.lastEvidenceAt.getTime()) / DAY_MS);
  const fillerImportances = fillerItems.map((f) => f.importance);
  const fillerDaysAgo = fillerItems.map((f) => (now.getTime() - f.lastEvidenceAt.getTime()) / DAY_MS);
  const fillerUseCounts = fillerItems.map((f) => f.useCount);

  const ti = statRange(targetImportances);
  const td = statRange(targetDaysAgo);
  const fi = statRange(fillerImportances);
  const fd = statRange(fillerDaysAgo);
  const fu = statRange(fillerUseCounts);

  console.log("Fixture distributions:");
  console.log(
    `  targets (${targets.length}): importance ${ti.min.toFixed(3)}-${ti.max.toFixed(3)} ` +
      `(avg ${ti.avg.toFixed(3)}), last_evidence_at ${td.min.toFixed(1)}-${td.max.toFixed(1)} days ago`
  );
  console.log(
    `  fillers (${fillerItems.length}): importance ${fi.min.toFixed(3)}-${fi.max.toFixed(3)} ` +
      `(avg ${fi.avg.toFixed(3)}), last_evidence_at ${fd.min.toFixed(1)}-${fd.max.toFixed(1)} days ago, ` +
      `use_count ${fu.min}-${fu.max}`
  );

  console.log(`\n${targets.length} target facts:`);
  for (const t of targets) {
    console.log(`  [${t.fact.id}] ${t.fact.question}`);
  }
}

// --- brief metrics -------------------------------------------------------
function computeBriefMetrics(targets, briefDoc, tokenCap) {
  const rows = targets.map((t) => ({
    id: t.fact.id,
    question: t.fact.question,
    inBrief: containsAny(briefDoc.content, t.fact.expected_any),
  }));
  const inBriefCount = rows.filter((r) => r.inBrief).length;
  return {
    rows,
    inBriefCount,
    total: rows.length,
    tokenEstimate: briefDoc.token_estimate,
    tokenCap,
    beliefIdsCount: briefDoc.belief_ids.length,
  };
}

function printBriefTable(metrics, totalInserted) {
  console.log("\n=== Brief compilation metrics ===");
  console.log(`Token estimate: ${metrics.tokenEstimate} / cap ${metrics.tokenCap}`);
  console.log(`Beliefs included in brief: ${metrics.beliefIdsCount}/${totalInserted}`);
  console.log(`Targets present in brief: ${metrics.inBriefCount}/${metrics.total}`);
  console.log("");
  console.log(`  ${"id".padEnd(5)} ${"in brief".padEnd(9)} question`);
  for (const r of metrics.rows) {
    console.log(`  ${r.id.padEnd(5)} ${(r.inBrief ? "yes" : "no").padEnd(9)} ${r.question}`);
  }
}

// --- recall --------------------------------------------------------------
async function runRecall({ targets, runId, model, workspaceDir, configDirPath }) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDirPath, MEMORY_MONGODB_DB: SCRATCH_DB };
  const rows = [];

  for (const t of targets) {
    const args = buildClaudeArgs({ text: t.fact.question, continueSession: false });
    const result = await runClaude({ args, env, cwd: workspaceDir });

    if (result.notFound) {
      throw new Error("claude CLI not found on PATH");
    }

    const answer = result.stdout || "";
    const correct = containsAny(answer, t.fact.expected_any);
    const stale = !correct && containsAny(answer, t.fact.wrong_any);
    const ok = result.code === 0 && !result.timedOut;
    const verdict = correct ? "correct" : stale ? "stale" : "miss";
    console.log(
      `[${t.fact.id}] ${ok ? "ok" : "FAILED"} (${(result.durationMs / 1000).toFixed(1)}s) ${verdict}` +
        `${result.timedOut ? " [timed out]" : ""}`
    );

    await appendJsonl(answersPath(), {
      runId,
      model,
      factId: t.fact.id,
      trial: 1,
      question: t.fact.question,
      answer,
      inBrief: t.inBrief,
      correct,
      verdict,
      exitCode: result.code,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      timestamp: new Date().toISOString(),
    });

    rows.push({
      id: t.fact.id,
      inBrief: t.inBrief,
      correct,
      verdict,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    });

    await sleep(1000);
  }

  const correctCount = rows.filter((r) => r.correct).length;
  return { ran: true, rows, correctCount, total: rows.length };
}

function printRecallTable(metrics) {
  if (!metrics.ran) {
    console.log("\nRecall: skipped (--no-recall).");
    return;
  }
  console.log("\n=== Recall metrics ===");
  console.log(`Recall correct: ${metrics.correctCount}/${metrics.total}`);
  console.log("");
  console.log(`  ${"id".padEnd(5)} ${"in brief".padEnd(9)} ${"correct".padEnd(8)} duration`);
  for (const r of metrics.rows) {
    console.log(
      `  ${r.id.padEnd(5)} ${(r.inBrief ? "yes" : "no").padEnd(9)} ${(r.correct ? "yes" : "no").padEnd(8)} ` +
        `${(r.durationMs / 1000).toFixed(1)}s${r.timedOut ? " [timed out]" : ""}`
    );
  }
}

// --- summary ---------------------------------------------------------------
function buildSummary({ runId, startedAt, projectKey, targets, fillerItems, briefMetrics, recallMetrics, tokenCap }) {
  return {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    scratchDb: SCRATCH_DB,
    projectKey,
    model: MODEL(),
    fixture: {
      seed: FIXTURE_SEED,
      targetCount: targets.length,
      fillerCount: fillerItems.length,
      totalBeliefs: targets.length + fillerItems.length,
    },
    brief: {
      tokenEstimate: briefMetrics.tokenEstimate,
      tokenCap,
      beliefIdsCount: briefMetrics.beliefIdsCount,
      targetsInBrief: briefMetrics.inBriefCount,
      targetsInBriefIds: briefMetrics.rows.filter((r) => r.inBrief).map((r) => r.id),
      targetsMissingFromBrief: briefMetrics.rows.filter((r) => !r.inBrief).map((r) => r.id),
    },
    recall: recallMetrics.ran
      ? {
          ran: true,
          correct: recallMetrics.correctCount,
          total: recallMetrics.total,
          perTarget: recallMetrics.rows,
        }
      : { ran: false },
  };
}

function printFinalSummary(summary) {
  console.log("\n=== Summary ===");
  console.log(`runId: ${summary.runId}`);
  console.log(`Targets in brief: ${summary.brief.targetsInBrief}/${summary.fixture.targetCount}`);
  console.log(`Brief token estimate: ${summary.brief.tokenEstimate} / cap ${summary.brief.tokenCap}`);
  console.log(`Beliefs included in brief: ${summary.brief.beliefIdsCount}/${summary.fixture.totalBeliefs}`);
  if (summary.recall.ran) {
    console.log(`Recall correct: ${summary.recall.correct}/${summary.recall.total}`);
  } else {
    console.log("Recall: skipped (--no-recall)");
  }
}

// --- dynamic dist imports ----------------------------------------------
async function importDist(root, ...segments) {
  const p = path.join(root, "dist", ...segments);
  try {
    return await import(pathToFileURL(p).href);
  } catch (err) {
    throw new Error(
      `failed to load ${path.join("dist", ...segments)} (${err && err.message ? err.message : err}); ` +
        'run "npm run build" first.'
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const root = repoRoot();
  const dryRun = argv.includes("--dry-run");
  const doReset = argv.includes("--reset");
  const noRecall = argv.includes("--no-recall");

  assertSafeDbName(SCRATCH_DB);

  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const now = new Date();
  const rng = mulberry32(FIXTURE_SEED);

  const workspaceDir = scratchWorkspaceDir();
  const configDirPath = scratchConfigDir();

  const { getProjectKey } = await importDist(root, "project", "projectKey.js");

  if (dryRun) {
    // Dry runs have no side effects at all (no DB writes, no git init, no
    // claude calls), so the workspace is not git-inited here. If a previous
    // live run already initialized it, the key below is the real one;
    // otherwise it is provisional and printDryRunReport says so.
    const workspaceInitialized = fs.existsSync(path.join(workspaceDir, ".git"));
    const dryKey = getProjectKey(workspaceDir);
    const dryFixtures = generateFixtures(rng, now, dryKey);
    printDryRunReport(dryKey, dryFixtures.targets, dryFixtures.fillerItems, now, doReset, workspaceInitialized);
    return;
  }

  // Git-init the scratch workspace FIRST, then derive the project key from
  // it: every later step (belief inserts, the compileBrief scopeKey, the
  // brief assertion, recall) depends on this ordering. See the header
  // comment for the failure mode this prevents.
  await ensureWorkspaceGitRepo(workspaceDir);
  const projectKey = getProjectKey(workspaceDir);
  console.log(`Derived project key from workspace git repo: ${projectKey}`);
  if (!projectKey.startsWith(`${WORKSPACE_LABEL}-`)) {
    throw new Error(
      `Derived project key "${projectKey}" does not start with "${WORKSPACE_LABEL}-": getProjectKey ` +
        "resolved something other than the scratch workspace's own git repo (likely the enclosing " +
        "repo). Refusing to insert beliefs under the wrong key."
    );
  }

  const { targets, fillerItems } = generateFixtures(rng, now, projectKey);

  if (doReset) {
    console.log(`--reset: dropping scratch database "${SCRATCH_DB}"...`);
    const { client, db } = await mongoClient(SCRATCH_DB);
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
    console.log("  dropped.");
  }

  const { BELIEFS, BRIEFS } = await importDist(root, "db", "schema.js");
  const { compileBrief } = await importDist(root, "consolidation", "compileBrief.js");
  const { loadConfig } = await importDist(root, "config.js");

  const { client, db } = await mongoClient(SCRATCH_DB);
  try {
    const allBeliefs = [...targets.map((t) => t.doc), ...fillerItems.map((f) => f.doc)];

    console.log(
      `Inserting ${allBeliefs.length} belief(s) (${targets.length} targets, ${fillerItems.length} fillers) ` +
        `into "${SCRATCH_DB}" for project "${projectKey}"...`
    );
    const insertResult = await db.collection(BELIEFS).insertMany(allBeliefs);
    console.log(`  inserted ${insertResult.insertedCount}`);

    const insertedTargetCount = await db
      .collection(BELIEFS)
      .countDocuments({ project: projectKey, fixture_kind: "target" });

    if (insertResult.insertedCount !== allBeliefs.length || insertedTargetCount < TARGET_COUNT) {
      throw new Error(
        `Insert verification failed: expected ${allBeliefs.length} beliefs (${TARGET_COUNT} targets), got ` +
          `insertedCount=${insertResult.insertedCount}, targetCount=${insertedTargetCount}.`
      );
    }

    console.log(`Compiling the project brief for "${projectKey}"...`);
    await compileBrief(db, projectKey);

    const briefDoc = await db.collection(BRIEFS).findOne({ _id: `brief:${projectKey}` });
    if (!briefDoc) {
      throw new Error(
        `Brief compilation failed: no brief document found for _id "brief:${projectKey}" after compileBrief().`
      );
    }

    const config = loadConfig();
    const tokenCap = config.briefProjectTokenCap;

    const briefMetrics = computeBriefMetrics(targets, briefDoc, tokenCap);
    for (const row of briefMetrics.rows) {
      const target = targets.find((t) => t.fact.id === row.id);
      if (target) target.inBrief = row.inBrief;
    }
    printBriefTable(briefMetrics, allBeliefs.length);

    let recallMetrics = { ran: false };
    if (noRecall) {
      console.log("\n--no-recall: stopping before step 5 (end-to-end recall).");
    } else {
      if (!verifyHooksExist(root)) {
        throw new Error('missing built hook files under dist/hooks/, run "npm run build" first.');
      }

      // Hard pre-flight assertion, the guard for project-key drift: recompute
      // the key exactly the way the SessionStart hook will (from the
      // workspace cwd, AFTER the workspace exists as its own git repo) and
      // verify a brief document exists under it in the scratch DB. If this
      // fails, every recall trial would silently run memoryless, so it is an
      // infrastructure error and the run exits nonzero, not a result.
      const recallKey = getProjectKey(workspaceDir);
      const recallBrief = await db.collection(BRIEFS).findOne({ _id: `brief:${recallKey}` });
      if (recallKey !== projectKey || !recallBrief) {
        console.error(
          `Recall pre-flight FAILED: getProjectKey(workspace) returned "${recallKey}" but beliefs ` +
            `and the brief were written under "${projectKey}", and the brief doc "brief:${recallKey}" ` +
            `${recallBrief ? "exists" : "does NOT exist"} in "${SCRATCH_DB}". The SessionStart hook ` +
            "would find no brief and every trial would run memoryless. Check that the scratch " +
            "workspace is its own git repo (it must not resolve to the enclosing repo)."
        );
        process.exit(1);
      }
      console.log(
        `\nRecall pre-flight OK: brief "brief:${recallKey}" exists ` +
          `(token_estimate=${recallBrief.token_estimate}, belief_ids=${recallBrief.belief_ids.length}). ` +
          "Proceeding to recall."
      );

      const settingsPath = await writeScratchSettings(root, configDirPath);
      const mcpPath = await writeScratchMcpConfig(root, configDirPath);
      console.log(`Wrote hooks settings: ${settingsPath}`);
      console.log(`Wrote mcp config:     ${mcpPath}`);

      recallMetrics = await runRecall({
        targets,
        runId,
        model: MODEL(),
        workspaceDir,
        configDirPath,
      });
      printRecallTable(recallMetrics);
    }

    const summary = buildSummary({
      runId,
      startedAt,
      projectKey,
      targets,
      fillerItems,
      briefMetrics,
      recallMetrics,
      tokenCap,
    });
    await ensureDir(scenarioStateDir());
    await fsp.writeFile(summaryPath(), JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(`\nWrote ${summaryPath()}`);

    printFinalSummary(summary);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("scenario-a-scale failed:", err && err.message ? err.message : err);
  process.exit(1);
});
