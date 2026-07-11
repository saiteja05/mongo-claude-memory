#!/usr/bin/env node
// Engine arm only: runs the memory engine's consolidator against the gauntlet DB,
// then prints belief counts by project and brief token estimates (no content dumps).

import { spawn } from "node:child_process";
import path from "node:path";
import { repoRoot, gauntletDb, mongoClient } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/consolidate.mjs [--help]

Runs "node dist/consolidation/cli.js" from the repo root with
MEMORY_MONGODB_DB=${"claude_memory_gauntlet"} (overridable via GAUNTLET_DB) and the
rest of the process environment passed through (Mongo/Voyage/LLM credentials).
Streams the consolidator's own output, then queries the gauntlet database and
prints belief counts by project/status and each brief's token_estimate.

Engine arm only: the stock arm has no consolidator, its memory is stock
Claude Code auto-memory.
`;

function runConsolidator(root) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MEMORY_MONGODB_DB: gauntletDb() };
    const child = spawn("node", [path.join(root, "dist", "consolidation", "cli.js")], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        reject(new Error("node not found on PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => resolve(code));
  });
}

async function printSummary() {
  const { client, db } = await mongoClient();
  try {
    const beliefs = db.collection("beliefs");
    const byProject = await beliefs
      .aggregate([
        { $group: { _id: { project: "$project", status: "$status" }, count: { $sum: 1 } } },
        { $sort: { "_id.project": 1, "_id.status": 1 } },
      ])
      .toArray();

    console.log("\nBelief counts by project/status:");
    if (byProject.length === 0) {
      console.log("  (no beliefs found in gauntlet DB)");
    }
    for (const row of byProject) {
      console.log(`  ${row._id.project || "(unknown)"} / ${row._id.status || "(unknown)"}: ${row.count}`);
    }

    const briefs = db.collection("briefs");
    const briefDocs = await briefs.find({}).project({ _id: 1, token_estimate: 1, generation: 1 }).toArray();
    console.log("\nBrief token estimates:");
    if (briefDocs.length === 0) {
      console.log("  (no briefs found in gauntlet DB)");
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
  console.log(`Running consolidator against database "${gauntletDb()}"...`);
  const code = await runConsolidator(root);
  if (code !== 0) {
    console.error(`consolidator exited with code ${code}`);
    process.exit(code || 1);
  }

  await printSummary();
}

main().catch((err) => {
  console.error("consolidate failed:", err && err.message ? err.message : err);
  process.exit(1);
});
