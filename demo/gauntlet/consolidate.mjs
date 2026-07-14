#!/usr/bin/env node
// Engine arms only: runs the memory engine's consolidator against BOTH
// engine-arm databases (engine, engine-native) sequentially, then prints
// belief counts by project and brief token estimates per database (no
// content dumps). The control and stock arms have no consolidator: control
// has no memory at all, and stock's memory is stock Claude Code auto-memory.

import { spawn } from "node:child_process";
import path from "node:path";
import { repoRoot, engineArms, gauntletDbFor, mongoClient } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/consolidate.mjs [--help]

For each engine arm (engine, engine-native), runs "node dist/consolidation/cli.js"
from the repo root with MEMORY_MONGODB_DB set to that arm's own database
(<GAUNTLET_DB or default>_engine / _engine_native) and the rest of the process
environment passed through (Mongo/Voyage/LLM credentials). Streams the
consolidator's own output for each database in turn, then queries that
database and prints belief counts by project/status and each brief's
token_estimate.

Engine arms only: control has no memory at all, and stock's memory is stock
Claude Code auto-memory, neither has a consolidator to run.

Drain-loop contract (read before wiring this into an automated loop):
the underlying consolidator (src/consolidation/cli.ts) prints the literal
line "[consolidate] no projects with pending observations; nothing to do."
whenever the ONE database it was just pointed at (via MEMORY_MONGODB_DB) has
no pending observations. That per-database line is streamed through
unmodified below, so it still appears, per database, the moment that
database drains, same as before this script covered two databases.

A drain loop that naively greps the combined output of one run of this
script for that bare substring will see a hit as soon as EITHER database
empties, not necessarily both, and would stop prematurely while the other
database still has pending observations. To signal "fully drained across
every engine-arm database", this script prints one additional combined line,
only when every arm's own run reported drained in this pass. Point any new
drain-loop tooling at that combined line, not the bare per-database
substring.
`;

const DRAINED_MESSAGE = "no projects with pending observations";

function runConsolidator(root, dbName) {
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
    child.stderr.on("data", (d) => {
      process.stderr.write(d);
    });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        reject(new Error("node not found on PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

async function printSummary(arm, dbName) {
  const { client, db } = await mongoClient(dbName);
  try {
    const beliefs = db.collection("beliefs");
    const byProject = await beliefs
      .aggregate([
        { $group: { _id: { project: "$project", status: "$status" }, count: { $sum: 1 } } },
        { $sort: { "_id.project": 1, "_id.status": 1 } },
      ])
      .toArray();

    console.log(`\n[${arm}] Belief counts by project/status (database "${dbName}"):`);
    if (byProject.length === 0) {
      console.log(`  (no beliefs found in ${dbName})`);
    }
    for (const row of byProject) {
      console.log(`  ${row._id.project || "(unknown)"} / ${row._id.status || "(unknown)"}: ${row.count}`);
    }

    const briefs = db.collection("briefs");
    const briefDocs = await briefs.find({}).project({ _id: 1, token_estimate: 1, generation: 1 }).toArray();
    console.log(`\n[${arm}] Brief token estimates (database "${dbName}"):`);
    if (briefDocs.length === 0) {
      console.log(`  (no briefs found in ${dbName})`);
    }
    for (const b of briefDocs) {
      console.log(`  ${b._id}: token_estimate=${b.token_estimate ?? "n/a"} generation=${b.generation ?? "n/a"}`);
    }
  } finally {
    await client.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const root = repoRoot();
  const results = {};

  // Sequential, not parallel: both arms are always attempted even if one
  // fails, so one invocation reports the full picture for both databases.
  for (const arm of engineArms()) {
    const dbName = gauntletDbFor(arm);
    console.log(`\n[${arm}] Running consolidator against database "${dbName}"...`);
    const { code, stdout } = await runConsolidator(root, dbName);
    const drained = stdout.includes(DRAINED_MESSAGE);
    results[arm] = { code, drained };

    if (code !== 0) {
      console.error(`[${arm}] consolidator exited with code ${code}`);
      continue;
    }
    await printSummary(arm, dbName);
  }

  // See the drain-loop contract in USAGE above: only emit the combined
  // "fully drained" signal when every engine arm's own run reported drained.
  const allDrained = engineArms().every((arm) => results[arm] && results[arm].drained);
  if (allDrained) {
    console.log(
      "\n[consolidate] all engine-arm databases drained: no projects with pending observations in any engine-arm database; nothing to do."
    );
  }

  const anyFailed = Object.values(results).some((r) => r.code !== 0);
  if (anyFailed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("consolidate failed:", err && err.message ? err.message : err);
  process.exit(1);
});
