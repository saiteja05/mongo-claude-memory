#!/usr/bin/env node
// Creates per-arm state for the memory gauntlet: four isolated Claude Code
// "installations" (config dir + workspace repo) covering the control
// (no memory), stock (native auto-memory only), engine (MongoDB engine only),
// and engine-native (engine plus native auto-memory) arms. Idempotent: safe
// to re-run.

import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  repoRoot,
  ARMS,
  engineArms,
  armDir,
  configDir,
  workspaceDir,
  mcpConfigPath,
  gauntletDbFor,
  ensureDir,
  checkEnv,
  writeRunInfo,
  MCP_SERVER_NAME,
  MODEL,
} from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/setup.mjs [--help]

Creates idempotent per-arm state under demo/gauntlet/state/ for all four arms:
  state/control/config/                empty CLAUDE_CONFIG_DIR, no hooks, no mcp.json:
                                        the memoryless control arm, never seeded
  state/control/workspace/orderflow/   git repo workspace for the control arm
  state/stock/config/                  empty CLAUDE_CONFIG_DIR: the stock (native
                                        auto-memory only) arm
  state/stock/workspace/orderflow/     git repo workspace for the stock arm
  state/engine/config/                 CLAUDE_CONFIG_DIR for the engine (Atlas memory
                                        only) arm, wired with SessionStart/
                                        UserPromptSubmit/SessionEnd hooks and an
                                        mcp.json exposing the memory MCP server against
                                        its own dedicated database
  state/engine/workspace/orderflow/    git repo workspace for the engine arm
  state/engine-native/config/          same hooks + mcp.json as engine, against its own
                                        dedicated database, plus native auto-memory left
                                        enabled: the realistic combined configuration
  state/engine-native/workspace/orderflow/  git repo workspace for the engine-native arm

Also writes demo/gauntlet/state/run.json (run id, timestamp, model, arm list) so every
downstream script can be traced back to the setup that produced its state.

Verifies dist/hooks/*.js exist (run "npm run build" first if not) and prints an
env var checklist (names only, never values).

Safe to re-run: existing git repos are left alone, generated config files are
rewritten deterministically. Re-running does mint a new run.json (new runId),
since a fresh setup is treated as the start of a new run.
`;

function printEnvChecklist() {
  console.log("\nEnvironment checklist (names only):");
  const connString = checkEnv(["MDB_MCP_CONNECTION_STRING", "MEMORY_MONGODB_URI"]);
  const anyConnString = connString.some((c) => c.set);
  for (const c of connString) {
    console.log(`  [${c.set ? "x" : " "}] ${c.name}`);
  }
  if (!anyConnString) {
    console.log("      -> at least one of the above is required for the engine and engine-native arms");
  }
  console.log("      engine-arm databases (each isolated from the other):");
  for (const arm of engineArms()) {
    console.log(`        ${arm.padEnd(14)} ${gauntletDbFor(arm)}`);
  }

  const voyage = checkEnv(["VOYAGE_API_KEY"])[0];
  console.log(`  [${voyage.set ? "x" : " "}] ${voyage.name}`);

  const anthropic = checkEnv(["ANTHROPIC_API_KEY"])[0];
  const awsCreds = checkEnv(["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "AWS_SESSION_TOKEN"]);
  const anyAws = awsCreds.some((c) => c.set);
  const llmProvider = process.env.LLM_PROVIDER || "anthropic (default)";
  console.log(`  [${anthropic.set ? "x" : " "}] ${anthropic.name}  (needed if LLM_PROVIDER=anthropic)`);
  console.log(
    `  [${anyAws ? "x" : " "}] AWS credentials (AWS_ACCESS_KEY_ID / AWS_PROFILE / AWS_SESSION_TOKEN)  (needed if LLM_PROVIDER=bedrock)`
  );
  console.log(`      current LLM_PROVIDER: ${llmProvider}`);
  console.log("");
}

function verifyHooksBuilt(root) {
  const hookFiles = ["sessionStart.js", "userPromptSubmit.js", "sessionEnd.js"].map((f) =>
    path.join(root, "dist", "hooks", f)
  );
  const missing = hookFiles.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.error("Missing built hook files, run `npm run build` first:");
    for (const m of missing) console.error(`  ${m}`);
    return false;
  }
  const mcpServer = path.join(root, "dist", "mcp", "server.js");
  if (!fs.existsSync(mcpServer)) {
    console.error(`Missing built MCP server, run \`npm run build\` first: ${mcpServer}`);
    return false;
  }
  return true;
}

async function gitInitIfNeeded(dir) {
  await ensureDir(dir);
  const gitDir = path.join(dir, ".git");
  if (fs.existsSync(gitDir)) return;
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "gauntlet@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Memory Gauntlet"], { cwd: dir, stdio: "ignore" });
}

async function writeWorkspaceFiles(dir) {
  const readmePath = path.join(dir, "README.md");
  if (!fs.existsSync(readmePath)) {
    await fsp.writeFile(
      readmePath,
      "# orderflow\n\nA payments service (Node, Express, Stripe) used as a fixture repo for the memory gauntlet benchmark. Not a real project.\n",
      "utf8"
    );
  }
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    const pkg = {
      name: "orderflow",
      version: "0.0.0",
      private: true,
      description: "Fixture payments service repo for the memory gauntlet benchmark.",
    };
    await fsp.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }
}

// Shared across both engine arms (engine, engine-native): identical hooks,
// only the mcp.json's MEMORY_MONGODB_DB differs per arm (see writeEngineMcpConfig).
async function writeEngineSettings(root, cfgDir) {
  const settingsPath = path.join(cfgDir, "settings.json");
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
        {
          hooks: [{ type: "command", command: hookCmd("userPromptSubmit.js") }],
        },
      ],
      SessionEnd: [
        {
          hooks: [{ type: "command", command: hookCmd("sessionEnd.js") }],
        },
      ],
    },
  };
  await ensureDir(cfgDir);
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settingsPath;
}

// Writes mcp.json for one engine arm, pointed at that arm's own dedicated
// database (gauntletDbFor(arm)), so "engine" and "engine-native" never share
// beliefs/briefs. This also fixes a prior bug where the DB name here was the
// literal "claude_memory_gauntlet": GAUNTLET_DB only overrode the scripts'
// own connections, so a custom GAUNTLET_DB used to split hooks/MCP traffic
// (this file) from the scripts (seed/recall/consolidate/etc.) across two
// different databases without warning.
async function writeEngineMcpConfig(root, cfgDir, arm) {
  const serverPath = path.join(root, "dist", "mcp", "server.js");
  const dbName = gauntletDbFor(arm);
  const mcp = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [serverPath],
        env: {
          MEMORY_MONGODB_DB: dbName,
        },
      },
    },
    _passthroughEnvNote:
      "MDB_MCP_CONNECTION_STRING, MEMORY_MONGODB_URI, VOYAGE_API_KEY, VOYAGE_MODEL, VOYAGE_DIMENSIONS, VOYAGE_BASE_URL, RERANK_MODE, EMBEDDING_MODE are inherited from the claude process environment at spawn time (not set in this file). MEMORY_MONGODB_DB above is derived from GAUNTLET_DB (or its default) via gauntletDbFor, so this file and every script in this harness always agree on the database name for this arm.",
  };
  await ensureDir(cfgDir);
  const p = mcpConfigPath(arm);
  await fsp.writeFile(p, JSON.stringify(mcp, null, 2) + "\n", "utf8");
  return p;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const root = repoRoot();
  if (!verifyHooksBuilt(root)) {
    process.exit(1);
  }

  for (const arm of ARMS) {
    const cfg = configDir(arm);
    const ws = workspaceDir(arm);
    await ensureDir(cfg);
    await gitInitIfNeeded(ws);
    await writeWorkspaceFiles(ws);
    console.log(`[${arm}] config dir: ${cfg}`);
    console.log(`[${arm}] workspace:  ${ws}`);

    if (arm === "control") {
      // Deliberately left empty: no settings.json, no mcp.json. This is what
      // makes control the memoryless arm, i.e. it must never gain hooks or
      // an MCP server, by accident or by copy-paste from the engine arms.
      console.log(`[${arm}] config dir left empty (no hooks, no mcp.json): the memoryless control arm`);
    } else if (arm === "stock") {
      // Deliberately left empty too: only native Claude Code auto-memory
      // (CLAUDE.md / MEMORY.md, written by Claude Code itself, not by us)
      // should ever populate this config dir.
      console.log(`[${arm}] config dir left empty (no hooks, no mcp.json): native auto-memory only`);
    } else if (engineArms().includes(arm)) {
      const settingsPath = await writeEngineSettings(root, cfg);
      const mcpPath = await writeEngineMcpConfig(root, cfg, arm);
      console.log(`[${arm}] wrote hooks settings: ${settingsPath}`);
      console.log(`[${arm}] wrote mcp config:     ${mcpPath} (database: ${gauntletDbFor(arm)})`);
    }
  }

  printEnvChecklist();

  const runInfo = {
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    model: MODEL(),
    arms: ARMS,
  };
  await writeRunInfo(runInfo);
  console.log(`Run id: ${runInfo.runId}`);

  console.log("Setup complete.");
}

main().catch((err) => {
  console.error("setup failed:", err && err.message ? err.message : err);
  process.exit(1);
});
