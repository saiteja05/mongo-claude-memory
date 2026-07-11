#!/usr/bin/env node
// Asks each recall question, in a fresh session, against one or both arms,
// N trials each. Engine arm recall runs add --mcp-config/--strict-mcp-config
// plus an --allowedTools grant for memory_search, so the model can call it
// without hitting a permission prompt. Stock arm recall gets no extra flags.

import path from "node:path";
import fs from "node:fs/promises";
import {
  ARMS,
  loadFacts,
  configDir,
  workspaceDir,
  mcpConfigPath,
  armDir,
  gauntletDb,
  buildClaudeArgs,
  runClaude,
  appendLog,
  appendJsonl,
  ensureDir,
  sleep,
  flagValue,
  MEMORY_SEARCH_TOOL,
} from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/recall.mjs [--arm stock|engine] [--trials N] [--facts f01,f02] [--dry-run] [--help]

Asks each fact's recall question in a brand new "claude -p" session (never
--continue), against the given arm(s), --trials times per fact (default 2).

  --arm stock|engine     restrict to one arm (default: both)
  --trials N             number of trials per fact (default: 2)
  --facts f01,f02        restrict to a comma-separated list of fact ids
  --dry-run              print the exact commands without executing them
  --help                 print this message

Appends each answer to state/<arm>/answers.jsonl as
{ factId, trial, answer, durationMs }. Sequential, 2s sleep between calls.
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

function envForArm(arm) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir(arm) };
  if (arm === "engine") {
    env.MEMORY_MONGODB_DB = gauntletDb();
    // Cold Atlas connects can exceed the engine's default 800ms fail-open
    // budget; give the hooks (SessionStart brief fetch) a realistic window.
    env.HOOK_INTERNAL_TIMEOUT_MS = env.HOOK_INTERNAL_TIMEOUT_MS || "5000";
  }
  return env;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const dryRun = argv.includes("--dry-run");
  const arms = armsToRun(argv);
  const trials = trialsCount(argv);
  const { facts } = loadFacts();
  const targetFacts = factsToRun(argv, facts);

  for (const arm of arms) {
    const cwd = workspaceDir(arm);
    const env = envForArm(arm);
    const mcpConfigFile = arm === "engine" ? mcpConfigPath("engine") : null;
    const allowedTools = arm === "engine" ? [MEMORY_SEARCH_TOOL] : null;
    const answersPath = path.join(armDir(arm), "answers.jsonl");

    for (const fact of targetFacts) {
      for (let trial = 1; trial <= trials; trial++) {
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
        console.log(`[${arm}] ${fact.id} trial ${trial}/${trials} ${ok ? "ok" : "FAILED"} (${seconds}s)`);

        await appendJsonl(answersPath, {
          factId: fact.id,
          trial,
          answer: result.stdout || "",
          durationMs: result.durationMs,
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
