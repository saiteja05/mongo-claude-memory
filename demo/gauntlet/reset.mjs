#!/usr/bin/env node
// Drops the gauntlet database and deletes demo/gauntlet/state/. Requires --yes.
// Refuses to run against anything other than the dedicated gauntlet DB, so it
// can never touch the user's real memory database.

import fs from "node:fs/promises";
import { gauntletDb, stateRoot, mongoClient } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/reset.mjs --yes [--help]

Drops the gauntlet database (default "claude_memory_gauntlet", overridable
via GAUNTLET_DB) and deletes demo/gauntlet/state/. Refuses to run if
GAUNTLET_DB resolves to "claude_memory" (the real memory database).

Without --yes, prints what it would do and exits without making any changes.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const dbName = gauntletDb();
  const stateDir = stateRoot();

  if (dbName === "claude_memory") {
    console.error(
      `Refusing to run: GAUNTLET_DB resolves to "claude_memory", the real memory database. ` +
        `Set GAUNTLET_DB to something else (default is "claude_memory_gauntlet").`
    );
    process.exit(1);
  }

  const yes = argv.includes("--yes");

  if (!yes) {
    console.log("Dry run (pass --yes to actually do this):");
    console.log(`  Would drop database: ${dbName}`);
    console.log(`  Would delete directory: ${stateDir}`);
    process.exit(0);
  }

  console.log(`Dropping database "${dbName}"...`);
  const { client, db } = await mongoClient();
  try {
    await db.dropDatabase();
    console.log(`  dropped ${dbName}`);
  } finally {
    await client.close();
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
