#!/usr/bin/env node
// Drops the base gauntlet database plus both engine-arm databases (engine,
// engine-native) and deletes demo/gauntlet/state/. Requires --yes. Refuses to
// run against anything other than dedicated gauntlet databases, so it can
// never touch the user's real memory database.

import fs from "node:fs/promises";
import { gauntletDb, engineArms, gauntletDbFor, stateRoot, mongoClient } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/reset.mjs --yes [--help]

Drops three databases:
  - the base gauntlet database (default "claude_memory_gauntlet", overridable
    via GAUNTLET_DB)
  - the engine-arm database (\`<base>_engine\`)
  - the engine-native-arm database (\`<base>_engine_native\`)
and deletes demo/gauntlet/state/ (which also removes state/run.json, the
run provenance file, so a fresh setup.mjs mints a new run id).

Refuses to run if any of the three resolved database names equals
"claude_memory" (the real memory database) or does not contain the substring
"gauntlet": belt and suspenders so a misconfigured GAUNTLET_DB cannot aim any
of the three drops at a database outside the gauntlet's own namespace.

Without --yes, prints what it would do and exits without making any changes.
`;

function resolveTargetDbs() {
  const base = gauntletDb();
  const engineDbs = engineArms().map((arm) => gauntletDbFor(arm));
  return [base, ...engineDbs];
}

function unsafeDbNames(dbNames) {
  return dbNames.filter((name) => name === "claude_memory" || !name.includes("gauntlet"));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const dbNames = resolveTargetDbs();
  const stateDir = stateRoot();

  const unsafe = unsafeDbNames(dbNames);
  if (unsafe.length > 0) {
    console.error(
      `Refusing to run: the following target database name(s) are unsafe: ${unsafe.join(", ")}. ` +
        `Each target database must contain "gauntlet" and must never be "claude_memory", the real ` +
        `memory database. Set GAUNTLET_DB to something else (default is "claude_memory_gauntlet").`
    );
    process.exit(1);
  }

  const yes = argv.includes("--yes");

  if (!yes) {
    console.log("Dry run (pass --yes to actually do this):");
    for (const name of dbNames) {
      console.log(`  Would drop database: ${name}`);
    }
    console.log(`  Would delete directory: ${stateDir}`);
    process.exit(0);
  }

  for (const dbName of dbNames) {
    console.log(`Dropping database "${dbName}"...`);
    const { client, db } = await mongoClient(dbName);
    try {
      await db.dropDatabase();
      console.log(`  dropped ${dbName}`);
    } finally {
      await client.close();
    }
  }

  console.log(`Deleting ${stateDir}...`);
  await fs.rm(stateDir, { recursive: true, force: true });
  console.log("  deleted");

  console.log("Reset complete.");
}

main().catch((err) => {
  console.error("reset failed:", err && err.message ? err.message : err);
  process.exit(1);
});
