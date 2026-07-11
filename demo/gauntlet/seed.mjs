#!/usr/bin/env node
// Runs the seed sessions (facts.json "sessions") against one or both arms,
// turn by turn: turn 1 is a fresh `claude -p`, later turns use --continue.
//
// Engine arm workaround: Claude Code cancels SessionEnd hooks in print mode
// (`claude -p` prints "SessionEnd hook [...] failed: Hook cancelled"), so no
// transcript observation lands via the native hook. The hook binary itself
// works, so after all turns of a seed session complete, this script finds the
// newest transcript .jsonl under the engine config dir's projects/ tree and
// pipes the SessionEnd payload to dist/hooks/sessionEnd.js manually, with the
// same env as the arm. A rare double capture (if the native hook ever wins
// the race) is acceptable: consolidation dedupes semantically.

import path from "node:path";
import { spawn } from "node:child_process";
import {
  ARMS,
  loadFacts,
  configDir,
  workspaceDir,
  gauntletDb,
  repoRoot,
  buildClaudeArgs,
  runClaude,
  appendLog,
  sleep,
  flagValue,
  walkFiles,
} from "./lib.mjs";
import fsp from "node:fs/promises";

const USAGE = `Usage: node demo/gauntlet/seed.mjs [--arm stock|engine] [--sessions s1,s2] [--dry-run] [--help]

Runs each seed session's turns against the given arm(s), in order, sequentially.
Turn 1 of a session is a fresh "claude -p" call; later turns use "--continue" so
they land in the same session. Defaults to both arms if --arm is omitted.

  --arm stock|engine   restrict to one arm (default: both)
  --sessions s1,s2     restrict to a comma-separated list of session ids
  --dry-run            print the exact commands without executing them
  --help               print this message

Requires the "claude" CLI on PATH. Requires state/<arm>/config and
state/<arm>/workspace/orderflow to exist (run setup.mjs first).

Engine arm note: Claude Code cancels SessionEnd hooks in print mode, so after
each engine seed session this script invokes dist/hooks/sessionEnd.js manually
against the newest transcript (logged as phase "sessionEnd-manual").
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

function sessionsToRun(argv, allSessions) {
  const raw = flagValue(argv, "--sessions");
  if (!raw) return allSessions;
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return allSessions.filter((s) => wanted.has(s.id));
}

function envForArm(arm) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir(arm) };
  if (arm === "engine") {
    env.MEMORY_MONGODB_DB = gauntletDb();
    // Cold Atlas connects can exceed the engine's default 800ms fail-open
    // budget; give the hooks a realistic window.
    env.HOOK_INTERNAL_TIMEOUT_MS = env.HOOK_INTERNAL_TIMEOUT_MS || "5000";
  }
  return env;
}

/** Finds the newest transcript .jsonl under <engine config dir>/projects/**. */
async function newestEngineTranscript() {
  const projectsDir = path.join(configDir("engine"), "projects");
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
  return newest;
}

/**
 * Manually invokes the SessionEnd hook binary against the newest engine-arm
 * transcript, piping the payload over stdin, because print mode cancels the
 * native SessionEnd hook before it can write the transcript observation.
 */
async function runManualSessionEnd(session, env, cwd) {
  const transcriptPath = await newestEngineTranscript();
  if (!transcriptPath) {
    console.error(`[engine] ${session.id} sessionEnd-manual: no transcript found under projects/, skipping`);
    await appendLog("engine", {
      phase: "sessionEnd-manual",
      session: session.id,
      exitCode: null,
      durationMs: 0,
      outputPreview: "no transcript found",
    });
    return;
  }

  const payload = JSON.stringify({
    session_id: path.basename(transcriptPath, ".jsonl"),
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "SessionEnd",
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
  console.log(`[engine] ${session.id} sessionEnd-manual ${ok ? "ok" : "FAILED"} (${(durationMs / 1000).toFixed(1)}s)`);
  if (!ok && result.stderr) console.error(`    stderr: ${result.stderr.slice(0, 400)}`);

  await appendLog("engine", {
    phase: "sessionEnd-manual",
    session: session.id,
    exitCode: result.code,
    durationMs,
    outputPreview: (result.stdout || "").slice(0, 400),
  });
}

async function runSession(arm, session, dryRun) {
  const cwd = workspaceDir(arm);
  const env = envForArm(arm);
  let failures = 0;

  for (let i = 0; i < session.turns.length; i++) {
    const text = session.turns[i];
    const args = buildClaudeArgs({ text, continueSession: i > 0 });

    if (dryRun) {
      console.log(`[${arm}] ${session.id} turn ${i + 1}/${session.turns.length} (dry-run):`);
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
    console.log(
      `[${arm}] ${session.id} turn ${i + 1}/${session.turns.length} ${ok ? "ok" : "FAILED"} (${seconds}s)`
    );
    if (!ok) {
      failures++;
      if (result.timedOut) console.error(`    timed out after ${result.durationMs}ms`);
      if (result.stderr) console.error(`    stderr: ${result.stderr.slice(0, 400)}`);
    }

    await appendLog(arm, {
      phase: "seed",
      session: session.id,
      turn: i + 1,
      exitCode: result.code,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      outputPreview: (result.stdout || "").slice(0, 400),
    });
  }

  // Engine arm: print mode cancels the native SessionEnd hook, so invoke the
  // same hook binary manually against the session's transcript.
  if (arm === "engine" && !dryRun) {
    await runManualSessionEnd(session, env, cwd);
  } else if (arm === "engine" && dryRun) {
    console.log(
      `[engine] ${session.id} sessionEnd-manual (dry-run): would pipe SessionEnd payload for the newest projects/**.jsonl transcript to node ${path.join(repoRoot(), "dist", "hooks", "sessionEnd.js")}`
    );
  }

  return failures;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const dryRun = argv.includes("--dry-run");
  const arms = armsToRun(argv);
  const facts = loadFacts();
  const sessions = sessionsToRun(argv, facts.sessions);

  const summary = {};

  for (const arm of arms) {
    let sessionsRun = 0;
    let failures = 0;
    for (const session of sessions) {
      const sessionFailures = await runSession(arm, session, dryRun);
      failures += sessionFailures;
      sessionsRun++;
      if (!dryRun) await sleep(2000);
    }
    summary[arm] = { sessionsRun, failures };
  }

  console.log("\nSeed summary:");
  for (const arm of arms) {
    const s = summary[arm];
    console.log(`  [${arm}] sessions run: ${s.sessionsRun}, failures: ${s.failures}`);
  }
}

main().catch((err) => {
  console.error("seed failed:", err && err.message ? err.message : err);
  process.exit(1);
});
