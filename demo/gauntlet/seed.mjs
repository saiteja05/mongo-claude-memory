#!/usr/bin/env node
// Runs the seed sessions (facts.json "sessions") against the three seeded
// arms, turn by turn: turn 1 is a fresh `claude -p`, later turns use
// --continue so they land in the same session. See lib.mjs for the full arm
// definitions; "control" is skipped below on purpose, see SEEDED_ARMS.
//
// Engine arms note: Claude Code cancels SessionEnd hooks in print mode
// (`claude -p` prints "SessionEnd hook [...] failed: Hook cancelled"), so no
// transcript observation lands via the native hook for either engine arm.
// The hook binary itself works, so after all turns of a seed session
// complete, this script finds the newest transcript .jsonl under that arm's
// own config dir's projects/ tree and pipes the SessionEnd payload to
// dist/hooks/sessionEnd.js manually, with that arm's own env (so it writes
// to that arm's own database). A rare double capture (if the native hook
// ever wins the race) is acceptable: consolidation dedupes semantically.
//
// Engine arm quarantine: native Claude Code auto-memory can accumulate under
// the engine arm's config dir while the model works a seed turn, that is
// expected model behavior and nothing here stops it from happening. If it
// survived, the engine arm's recall could quietly draw on the model's own
// auto-memory prose instead of facts recalled from the MongoDB engine, which
// would defeat the point of the arm. So this script deletes every native
// memory dir under the engine arm's config after each session, plus a final
// sweep at the end of the run that asserts none remain. The engine-native
// arm is deliberately left alone: native auto-memory there is the point of
// that arm (it mirrors the realistic configuration most engine users run).

import path from "node:path";
import { spawn } from "node:child_process";
import {
  loadFacts,
  configDir,
  workspaceDir,
  // Imported rather than defined locally: lib's envForArm deliberately does
  // NOT set HOOK_INTERNAL_TIMEOUT_MS. A red-team finding was that this
  // script used to widen the engine's default 800ms fail-open budget to
  // 5000ms for every seeded run, silently masking the exact production
  // default the audit flagged. Production defaults now apply unless the
  // operator exports an override in their own shell before invoking this
  // script.
  envForArm,
  engineArms,
  nativeMemoryDirs,
  readRunInfo,
  repoRoot,
  buildClaudeArgs,
  runClaude,
  appendLog,
  sleep,
  flagValue,
  walkFiles,
} from "./lib.mjs";
import fsp from "node:fs/promises";

// The arms this script ever seeds. "control" is intentionally excluded here:
// it measures per-fact guessability, i.e. what a memoryless model gets right
// anyway, so it must never be seeded with the facts.
const SEEDED_ARMS = ["stock", "engine", "engine-native"];

const USAGE = `Usage: node demo/gauntlet/seed.mjs [--arm stock|engine|engine-native] [--sessions s1,s2] [--dry-run] [--help]

Runs each seed session's turns against the given arm(s), in order, sequentially.
Turn 1 of a session is a fresh "claude -p" call; later turns use "--continue" so
they land in the same session. Defaults to all three seeded arms if --arm is
omitted. The "control" arm is never seeded here: it measures per-fact
guessability and must never see the facts.

  --arm stock|engine|engine-native   restrict to one arm (default: all three seeded arms)
  --sessions s1,s2                   restrict to a comma-separated list of session ids
  --dry-run                          print the exact commands without executing them
  --help                             print this message

Requires the "claude" CLI on PATH, state/<arm>/config and
state/<arm>/workspace/orderflow to exist, and state/run.json to exist (run
setup.mjs first for all of the above).

Engine arm note: Claude Code cancels SessionEnd hooks in print mode, so after
each engine or engine-native seed session this script invokes
dist/hooks/sessionEnd.js manually against the newest transcript under that
arm's own config dir (logged as phase "sessionEnd-manual"). The engine arm is
additionally quarantined of native auto-memory after every session and again
in a final sweep (logged as phase "quarantine" / "quarantine-verify").
`;

function armsToRun(argv) {
  const arm = flagValue(argv, "--arm");
  if (!arm) return SEEDED_ARMS;
  if (arm === "control") {
    console.error(`Refusing --arm control: control measures guessability and must never be seeded.`);
    process.exit(1);
  }
  if (!SEEDED_ARMS.includes(arm)) {
    console.error(`Unknown --arm "${arm}", expected one of: ${SEEDED_ARMS.join(", ")}`);
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

/** Finds the newest transcript .jsonl under <arm's config dir>/projects/**, plus its mtime. */
async function newestTranscript(arm) {
  const projectsDir = path.join(configDir(arm), "projects");
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
 * Manually invokes the SessionEnd hook binary against the newest transcript
 * under this arm's own config dir, piping the payload over stdin, because
 * print mode cancels the native SessionEnd hook before it can write the
 * transcript observation. Called for both engine arms, each against its own
 * config dir and its own env, so each writes to its own database.
 *
 * sessionStartMs guards the newest-mtime heuristic: it previously could
 * silently capture a stale transcript left over from an earlier run. Any
 * transcript older than the session that just ran is rejected loudly instead
 * of being piped to the hook, and the session is counted as failed.
 */
async function runManualSessionEnd(arm, session, env, cwd, sessionStartMs, runId) {
  const { transcriptPath, mtimeMs } = await newestTranscript(arm);

  if (!transcriptPath) {
    console.error(`[${arm}] ${session.id} sessionEnd-manual: no transcript found under projects/, skipping`);
    await appendLog(arm, {
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
      `[${arm}] ${session.id} sessionEnd-manual: STALE TRANSCRIPT, expected the newest file under projects/** to be written between ${new Date(sessionStartMs).toISOString()} and now, but the newest one is from ${new Date(mtimeMs).toISOString()}`
    );
    await appendLog(arm, {
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
  console.log(`[${arm}] ${session.id} sessionEnd-manual ${ok ? "ok" : "FAILED"} (${(durationMs / 1000).toFixed(1)}s)`);
  if (!ok && result.stderr) console.error(`    stderr: ${result.stderr.slice(0, 400)}`);

  await appendLog(arm, {
    phase: "sessionEnd-manual",
    runId,
    session: session.id,
    exitCode: result.code,
    durationMs,
    outputPreview: (result.stdout || "").slice(0, 400),
  });

  return ok;
}

/**
 * Deletes every native auto-memory dir under the engine arm's config dir
 * (nativeMemoryDirs("engine")), fs.rm recursive force. Counts dirs and files
 * removed, never logs their content, and adds the counts into `totals` (a
 * running total across the whole seed run) when provided.
 */
async function quarantineEngineArm(runId, totals) {
  const dirs = nativeMemoryDirs("engine");
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
    console.log(`[engine] quarantine: removed ${dirs.length} native memory dir(s), ${fileCount} file(s)`);
  }
  await appendLog("engine", {
    phase: "quarantine",
    runId,
    dirsRemoved: dirs.length,
    filesRemoved: fileCount,
  });
  if (totals) {
    totals.dirs += dirs.length;
    totals.files += fileCount;
  }
  return { dirs: dirs.length, files: fileCount };
}

/**
 * Final post-seed safety net for the engine arm: repeats the quarantine,
 * then asserts nativeMemoryDirs("engine") is empty, failing loudly if not.
 * This is the core contamination fix: native auto-memory writes during
 * seeding are expected model behavior, and must never reach the engine arm's
 * recall.
 */
async function finalQuarantineSweep(runId, totals) {
  await quarantineEngineArm(runId, totals);
  const remaining = nativeMemoryDirs("engine");
  const ok = remaining.length === 0;
  await appendLog("engine", {
    phase: "quarantine-verify",
    runId,
    ok,
    remaining: remaining.length,
  });
  if (!ok) {
    console.error(
      `[engine] QUARANTINE FAILED: ${remaining.length} native memory dir(s) still present after the final sweep`
    );
    throw new Error(`engine arm quarantine failed: ${remaining.length} native memory dir(s) remain after seeding`);
  }
}

async function runSession(arm, session, dryRun, runId, quarantineTotals) {
  const cwd = workspaceDir(arm);
  const env = envForArm(arm);
  let failures = 0;
  const sessionStartMs = Date.now();

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
      runId,
      session: session.id,
      turn: i + 1,
      exitCode: result.code,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      outputPreview: (result.stdout || "").slice(0, 400),
    });
  }

  // Both engine arms: print mode cancels the native SessionEnd hook, so
  // invoke the same hook binary manually against the session's own
  // transcript, using this arm's own env so the write lands in this arm's
  // own database.
  const isEngineArm = engineArms().includes(arm);
  if (isEngineArm && !dryRun) {
    const sessionEndOk = await runManualSessionEnd(arm, session, env, cwd, sessionStartMs, runId);
    if (!sessionEndOk) failures++;

    // Engine arm only: quarantine native auto-memory after every session so
    // it never accumulates into the arm meant to hold ONLY MongoDB-engine
    // memory. engine-native is left alone on purpose, see the module comment.
    if (arm === "engine") {
      await quarantineEngineArm(runId, quarantineTotals);
    }
  } else if (isEngineArm && dryRun) {
    console.log(
      `[${arm}] ${session.id} sessionEnd-manual (dry-run): would pipe SessionEnd payload for the newest projects/**.jsonl transcript under ${configDir(arm)} to node ${path.join(repoRoot(), "dist", "hooks", "sessionEnd.js")}`
    );
    if (arm === "engine") {
      console.log(
        `[engine] quarantine (dry-run): would remove native memory dirs under ${configDir(arm)}/projects/*/memory`
      );
    }
  }

  return failures;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const { runId } = readRunInfo();

  const dryRun = argv.includes("--dry-run");
  const arms = armsToRun(argv);
  const facts = loadFacts();
  const sessions = sessionsToRun(argv, facts.sessions);

  const summary = {};
  const quarantineTotals = { dirs: 0, files: 0 };

  for (const arm of arms) {
    let sessionsRun = 0;
    let failures = 0;
    for (const session of sessions) {
      const sessionFailures = await runSession(arm, session, dryRun, runId, quarantineTotals);
      failures += sessionFailures;
      sessionsRun++;
      if (!dryRun) await sleep(2000);
    }
    summary[arm] = { sessionsRun, failures };
  }

  // Final post-seed sweep for the engine arm: repeats the quarantine and
  // asserts nothing native survived seeding. Only meaningful once real
  // sessions have run, so it is skipped entirely in dry-run mode.
  if (arms.includes("engine") && !dryRun) {
    await finalQuarantineSweep(runId, quarantineTotals);
  }

  let hadFailures = false;
  console.log(`\nSeed summary (run ${runId}):`);
  for (const arm of arms) {
    const s = summary[arm];
    if (s.failures > 0) hadFailures = true;
    console.log(`  [${arm}] sessions run: ${s.sessionsRun}, failures: ${s.failures}`);
  }
  if (arms.includes("engine")) {
    console.log(
      `  [engine] QUARANTINE: removed ${quarantineTotals.dirs} native memory dir(s), ${quarantineTotals.files} file(s) total`
    );
  }

  if (hadFailures) process.exitCode = 1;
}

main().catch((err) => {
  console.error("seed failed:", err && err.message ? err.message : err);
  process.exit(1);
});
