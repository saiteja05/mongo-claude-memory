#!/usr/bin/env node
// Runs the engine's index setup against BOTH engine-arm databases (engine,
// engine-native), then polls Atlas until each database's beliefs collection
// search indexes are queryable. reset.mjs drops both databases, which drops
// their Atlas search indexes with them; $vectorSearch against a missing
// index returns empty instead of erroring, so running seed/consolidate/
// recall before the indexes are back would silently no-op vector dedupe and
// reconciliation for the whole run, in whichever engine arm's database was
// affected. Run this after reset.mjs/setup.mjs and before seed.mjs.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { repoRoot, engineArms, gauntletDbFor, mongoClient, sleep } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/ensure-indexes.mjs [--help]

For each engine arm (engine, engine-native), runs "node dist/db/setupIndexes.js"
from the repo root with MEMORY_MONGODB_DB set to that arm's own database
(<GAUNTLET_DB or default>_engine / _engine_native) and the rest of the process
environment passed through (Mongo credentials). Then polls that database's
beliefs collection's Atlas Search indexes (beliefs_vec, beliefs_text, and
beliefs_vec_auto if it exists) every 5 seconds until every one of them is
queryable, or until GAUNTLET_INDEX_TIMEOUT_MS elapses (default 300000) for
that arm.

Both arms are always attempted, even if one fails first, so a single
invocation reports the full picture for both databases; the script exits
non-zero if either arm failed.

Idempotent: if the indexes already exist and are queryable, this passes
quickly. Run this after reset.mjs/setup.mjs and before seed.mjs; seeding
before the indexes are queryable makes vector dedupe and reconciliation
silently no-op for the whole run.
`;

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
      if (err && err.code === "ENOENT") {
        reject(new Error("node not found on PATH"));
      } else {
        reject(err);
      }
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

/** Polls until beliefs_vec/beliefs_text (and beliefs_vec_auto, if present) are queryable. Logs are labeled per arm. */
async function pollUntilQueryable(db, timeoutMs, arm) {
  const startedAt = Date.now();
  let targetNames = null;

  for (;;) {
    const statusByName = await fetchSearchIndexStatus(db);

    if (targetNames === null) {
      targetNames = [...REQUIRED_INDEX_NAMES];
      if (statusByName.has(OPTIONAL_INDEX_NAME)) targetNames.push(OPTIONAL_INDEX_NAME);
      console.log(`[${arm}] Waiting for search indexes to become queryable: ${targetNames.join(", ")}`);
    }

    const rows = targetNames.map((name) => {
      const entry = statusByName.get(name);
      return {
        name,
        queryable: !!entry && entry.queryable,
        status: entry ? entry.status : "(not found)",
      };
    });

    if (rows.every((row) => row.queryable)) {
      console.log(`[${arm}] All required search indexes are queryable:`);
      for (const row of rows) {
        console.log(`  ${row.name}: queryable=${row.queryable} status=${row.status}`);
      }
      return true;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      console.error(`[${arm}] Timed out after ${timeoutMs}ms waiting for search indexes to become queryable.`);
      console.error(`[${arm}] Not yet queryable:`);
      for (const row of rows) {
        if (!row.queryable) {
          console.error(`  ${row.name}: queryable=${row.queryable} status=${row.status}`);
        }
      }
      console.error(
        `[${arm}] Do not seed the gauntlet until these indexes are queryable. Rerun this script once ` +
          "the Atlas index build finishes, or check the Atlas UI for a build error."
      );
      return false;
    }

    await sleep(5000);
  }
}

/** Runs setup + polling for one engine arm's database. Never throws: failures are reported in the returned ok flag. */
async function ensureIndexesForArm(root, arm, timeoutMs) {
  const dbName = gauntletDbFor(arm);
  console.log(`[${arm}] Running index setup against database "${dbName}"...`);
  const code = await runSetupIndexes(root, dbName);
  if (code !== 0) {
    console.error(`[${arm}] index setup exited with code ${code}`);
    return false;
  }

  const { client, db } = await mongoClient(dbName);
  try {
    return await pollUntilQueryable(db, timeoutMs, arm);
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
  const timeoutMs = defaultIndexTimeoutMs();

  const setupIndexesPath = path.join(root, "dist", "db", "setupIndexes.js");
  if (!fs.existsSync(setupIndexesPath)) {
    console.error(`Missing built index setup script, run \`npm run build\` first: ${setupIndexesPath}`);
    process.exit(1);
  }

  // Both engine-arm databases are always attempted, even if one fails first,
  // so a single invocation reports the full picture instead of stopping at
  // the first arm and leaving the operator to guess about the second.
  const results = {};
  for (const arm of engineArms()) {
    results[arm] = await ensureIndexesForArm(root, arm, timeoutMs);
  }

  console.log("\nPer-arm index status:");
  for (const arm of engineArms()) {
    console.log(`  [${arm}] ${results[arm] ? "ok" : "FAILED"}`);
  }

  if (Object.values(results).some((ok) => !ok)) {
    process.exit(1);
  }

  console.log("Index check complete.");
}

main().catch((err) => {
  console.error("ensure-indexes failed:", err && err.message ? err.message : err);
  process.exit(1);
});
