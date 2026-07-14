#!/usr/bin/env node
// Asks each recall question, in a fresh session, against one, some, or all
// four arms, N trials each. Per-arm wiring:
//   control       - no --mcp-config, no --allowedTools. Every native
//                   auto-memory directory for this arm is deleted before
//                   EVERY trial: the model's own guesses during trial 1 can
//                   be saved by the native memory tool and must not leak
//                   into trial 2, so each control trial must be independent.
//   stock         - unchanged: no extra flags, native auto-memory is the
//                   product under test for this arm and is left to
//                   accumulate across trials exactly as a real user would
//                   see it.
//   engine        - --mcp-config/--strict-mcp-config plus an --allowedTools
//                   grant for memory_search, against this arm's own
//                   database. Before EVERY trial a contamination gate checks
//                   every native auto-memory directory for this arm: an
//                   empty one is just the scaffold directory Claude Code
//                   creates at session start, so it is removed and the run
//                   continues; a directory that actually holds files is a
//                   hard refusal (no cleanup), since seeding owns the
//                   quarantine and recall only verifies it. A prior run
//                   scored engine recall answers out of native memory
//                   because a contamination check looked at the wrong path.
//   engine-native - same MCP config and allowedTools as engine (its own
//                   mcp.json, its own database), native auto-memory
//                   deliberately left alone: this is the realistic combined
//                   configuration most engine users actually run.
//
// Refuses to append to an arm's answers.jsonl unless GAUNTLET_RESUME=1 is
// set: appending duplicates silently inflated trial counts before. With
// GAUNTLET_RESUME=1, already-recorded (factId, trial) pairs are skipped so a
// crashed run can resume without duplicating trials. Every record is
// stamped with the run id and model from state/run.json (see readRunInfo).

import path from "node:path";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import {
  ARMS,
  engineArms,
  loadFacts,
  workspaceDir,
  mcpConfigPath,
  armDir,
  envForArm,
  nativeMemoryDirs,
  countFilesInDir,
  readRunInfo,
  buildClaudeArgs,
  runClaude,
  appendLog,
  appendJsonl,
  readJsonl,
  sleep,
  flagValue,
  MEMORY_SEARCH_TOOL,
} from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/recall.mjs [--arm control|stock|engine|engine-native] [--trials N] [--facts f01,f02] [--dry-run] [--help]

Asks each fact's recall question in a brand new "claude -p" session (never
--continue), against the given arm(s), --trials times per fact (default 2).

  --arm <arm>            restrict to one arm (default: all four)
  --trials N             number of trials per fact (default: 2)
  --facts f01,f02        restrict to a comma-separated list of fact ids
  --dry-run              print the exact commands without executing them
  --help                 print this message

Appends each answer to state/<arm>/answers.jsonl as
{ runId, model, factId, trial, answer, durationMs, timedOut, timestamp }.
Sequential, 2s sleep between calls.

Requires state/run.json (run "node demo/gauntlet/setup.mjs" first).

Refuses to run against an arm whose answers.jsonl already exists unless
GAUNTLET_RESUME=1 is set, so re-running recall can never silently duplicate
trials. With GAUNTLET_RESUME=1, (factId, trial) pairs already recorded are
skipped. To start an arm over from scratch, run
"node demo/gauntlet/reset.mjs --yes" first.
`;

function armsToRun(argv) {
  const arm = flagValue(argv, "--arm");
  if (!arm) return ARMS;
  if (!ARMS.includes(arm)) {
    console.error(`Unknown --arm "${arm}", expected one of: ${ARMS.join(", ")}`);
    process.exit(1);
  }
  return [arm];
}

function factsToRun(argv, allFacts) {
  const raw = flagValue(argv, "--facts");
  if (!raw) return allFacts;
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return allFacts.filter((f) => wanted.has(f.id));
}

function trialsCount(argv) {
  const raw = flagValue(argv, "--trials");
  const n = Number.parseInt(raw ?? "2", 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** mcp.json only applies to the two engine arms, each pointed at its own file. */
function mcpConfigForArm(arm) {
  return engineArms().includes(arm) ? mcpConfigPath(arm) : null;
}

/** memory_search is only ever an allowed tool on the two engine arms. */
function allowedToolsForArm(arm) {
  return engineArms().includes(arm) ? [MEMORY_SEARCH_TOOL] : null;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Set of "factId:trial" keys already present in an arm's answers.jsonl. */
async function loadCompletedTrials(answersPath) {
  const records = await readJsonl(answersPath);
  return new Set(records.map((r) => `${r.factId}:${r.trial}`));
}

/**
 * Before every control-arm trial: delete every native auto-memory directory
 * for this arm so a prior trial's saved guesses cannot leak into the next
 * one. Logs directory and file counts only, never directory names or file
 * contents. In --dry-run mode this only reads and reports; it never deletes.
 */
async function cleanControlNativeMemory(arm, dryRun) {
  const dirs = nativeMemoryDirs(arm);
  if (dirs.length === 0) return;

  let fileCount = 0;
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir);
      fileCount += entries.length;
    } catch {
      // directory vanished between listing and reading, nothing to count
    }
  }

  if (dryRun) {
    console.log(`[${arm}] (dry-run): would clear native memory before this trial: ${dirs.length} dir(s), ${fileCount} file(s)`);
    return;
  }

  console.log(`[${arm}] clearing native memory before this trial: ${dirs.length} dir(s), ${fileCount} file(s)`);
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Before every engine-arm (never engine-native) trial: partitions this arm's
 * native auto-memory directories into empty scaffolds and directories that
 * actually hold files. Claude Code creates an empty projects/<slug>/memory/
 * directory at session start whether or not it ever writes a memory file
 * into it, so an empty directory left behind by the immediately preceding
 * trial's own session is normal runtime noise, not contamination: this
 * function removes those empty scaffolds (logging each removal) and lets the
 * run continue. A directory that holds one or more files is a hard gate, not
 * a cleanup: seeding owns the quarantine, recall only verifies it, so any
 * non-empty native auto-memory directory means seeding failed to quarantine
 * it or something wrote to it since, and recall must refuse rather than
 * silently score answers that may have come from native memory instead of
 * the engine.
 */
function assertNoEngineContamination(arm) {
  const dirs = nativeMemoryDirs(arm);
  if (dirs.length === 0) return;

  const empty = [];
  const nonEmpty = [];
  for (const dir of dirs) {
    const fileCount = countFilesInDir(dir);
    if (fileCount === 0) {
      empty.push(dir);
    } else {
      nonEmpty.push({ dir, fileCount });
    }
  }

  for (const dir of empty) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[${arm}] removed empty native-memory scaffold dir (0 files): ${dir}`);
  }

  if (nonEmpty.length === 0) return;

  console.error(`[${arm}] CONTAMINATION: native auto-memory found on an engine-only arm, refusing to run:`);
  for (const { dir, fileCount } of nonEmpty) {
    console.error(`    ${dir} (${fileCount} file(s))`);
  }
  console.error(
    "    a prior run scored engine recall answers out of native memory because a contamination check " +
      "looked at the wrong path. Seeding owns the quarantine for this arm, recall only verifies it and " +
      "never cleans it up. Investigate how these directories were created, then remove them (or reset " +
      "and reseed) before recall can run."
  );
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  // Provenance first, before anything else: every answers.jsonl record below
  // is stamped from this, and a missing run.json means setup.mjs never ran.
  const runInfo = readRunInfo();

  const dryRun = argv.includes("--dry-run");
  const arms = armsToRun(argv);
  const trials = trialsCount(argv);
  const { facts } = loadFacts();
  const targetFacts = factsToRun(argv, facts);
  const resume = process.env.GAUNTLET_RESUME === "1";

  for (const arm of arms) {
    const cwd = workspaceDir(arm);
    const env = envForArm(arm);
    const mcpConfigFile = mcpConfigForArm(arm);
    const allowedTools = allowedToolsForArm(arm);
    const answersPath = path.join(armDir(arm), "answers.jsonl");

    // Resume guard: evaluated before any claude process is spawned for this
    // arm. Recall appends, so re-running it without resuming used to
    // silently duplicate every trial already on disk.
    const alreadyExists = await fileExists(answersPath);
    let completed = new Set();
    if (alreadyExists && !resume) {
      console.error(
        `[${arm}] refusing to run: ${answersPath} already exists. Recall appends to this file, so ` +
          "re-running without resuming would silently duplicate trials. Set GAUNTLET_RESUME=1 to resume " +
          "a crashed run (trials already recorded are skipped), or run " +
          '"node demo/gauntlet/reset.mjs --yes" first to start this arm over from scratch.'
      );
      process.exit(1);
    }
    if (alreadyExists && resume) {
      completed = await loadCompletedTrials(answersPath);
      console.log(`[${arm}] GAUNTLET_RESUME=1: ${completed.size} trial(s) already recorded, will be skipped`);
    }

    for (const fact of targetFacts) {
      for (let trial = 1; trial <= trials; trial++) {
        if (completed.has(`${fact.id}:${trial}`)) {
          console.log(`[${arm}] ${fact.id} trial ${trial}/${trials} already recorded, skipping (GAUNTLET_RESUME=1)`);
          continue;
        }

        if (arm === "control") {
          await cleanControlNativeMemory(arm, dryRun);
        }
        if (arm === "engine") {
          assertNoEngineContamination(arm);
        }

        const args = buildClaudeArgs({
          text: fact.question,
          continueSession: false,
          mcpConfigFile,
          allowedTools,
        });

        if (dryRun) {
          console.log(`[${arm}] ${fact.id} trial ${trial}/${trials} (dry-run):`);
          console.log(`    cwd: ${cwd}`);
          console.log(`    CLAUDE_CONFIG_DIR: ${env.CLAUDE_CONFIG_DIR}`);
          console.log(`    claude ${args.map((a) => JSON.stringify(a)).join(" ")}`);
          continue;
        }

        const result = await runClaude({ args, env, cwd });

        if (result.notFound) {
          console.error("claude CLI not found on PATH");
          process.exit(1);
        }

        const ok = result.code === 0 && !result.timedOut;
        const seconds = (result.durationMs / 1000).toFixed(1);
        const suffix = result.timedOut ? " [timed out]" : "";
        console.log(`[${arm}] ${fact.id} trial ${trial}/${trials} ${ok ? "ok" : "FAILED"} (${seconds}s)${suffix}`);

        await appendJsonl(answersPath, {
          runId: runInfo.runId,
          model: runInfo.model,
          factId: fact.id,
          trial,
          answer: result.stdout || "",
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          timestamp: new Date().toISOString(),
        });

        await appendLog(arm, {
          phase: "recall",
          fact: fact.id,
          trial,
          exitCode: result.code,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          outputPreview: (result.stdout || "").slice(0, 400),
        });

        await sleep(2000);
      }
    }
  }

  if (!dryRun) {
    console.log("\nRecall complete.");
  }
}

main().catch((err) => {
  console.error("recall failed:", err && err.message ? err.message : err);
  process.exit(1);
});
