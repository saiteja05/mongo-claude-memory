#!/usr/bin/env node
// Creates per-arm state for the memory gauntlet: two isolated Claude Code
// "installations" (config dir + workspace repo), one running stock auto-memory,
// one wired to this repo's MongoDB Atlas memory engine. Idempotent: safe to re-run.

import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  repoRoot,
  ARMS,
  armDir,
  configDir,
  workspaceDir,
  mcpConfigPath,
  ensureDir,
  checkEnv,
  MCP_SERVER_NAME,
} from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/setup.mjs [--help]

Creates idempotent per-arm state under demo/gauntlet/state/:
  state/stock/config/                CLAUDE_CONFIG_DIR for the stock (native memory) arm
  state/stock/workspace/orderflow/   git repo workspace for the stock arm
  state/engine/config/                CLAUDE_CONFIG_DIR for the engine (Atlas memory) arm,
                                       wired with SessionStart/UserPromptSubmit/SessionEnd hooks
                                       and an mcp.json exposing the memory MCP server
  state/engine/workspace/orderflow/  git repo workspace for the engine arm

Verifies dist/hooks/*.js exist (run "npm run build" first if not) and prints an
env var checklist (names only, never values).

Safe to re-run: existing git repos are left alone, generated config files are
rewritten deterministically.
`;

function printEnvChecklist() {
  console.log("\nEnvironment checklist (names only):");
  const connString = checkEnv(["MDB_MCP_CONNECTION_STRING", "MEMORY_MONGODB_URI"]);
  const anyConnString = connString.some((c) => c.set);
  for (const c of connString) {
    console.log(`  [${c.set ? "x" : " "}] ${c.name}`);
  }
  if (!anyConnString) {
    console.log("      -> at least one of the above is required for the engine arm");
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

async function writeEngineMcpConfig(root, cfgDir) {
  const serverPath = path.join(root, "dist", "mcp", "server.js");
  const mcp = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [serverPath],
        env: {
          MEMORY_MONGODB_DB: "claude_memory_gauntlet",
        },
      },
    },
    _passthroughEnvNote:
      "MDB_MCP_CONNECTION_STRING, MEMORY_MONGODB_URI, VOYAGE_API_KEY, VOYAGE_MODEL, VOYAGE_DIMENSIONS, VOYAGE_BASE_URL, RERANK_MODE, EMBEDDING_MODE are inherited from the claude process environment at spawn time (not set in this file). GAUNTLET_DB, if set in the parent environment, overrides MEMORY_MONGODB_DB above only for scripts in this harness, not for this MCP config file itself.",
  };
  await ensureDir(cfgDir);
  const p = mcpConfigPath("engine");
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

    if (arm === "engine") {
      const settingsPath = await writeEngineSettings(root, cfg);
      const mcpPath = await writeEngineMcpConfig(root, cfg);
      console.log(`[${arm}] wrote hooks settings: ${settingsPath}`);
      console.log(`[${arm}] wrote mcp config:     ${mcpPath}`);
    }
  }

  printEnvChecklist();
  console.log("Setup complete.");
}

main().catch((err) => {
  console.error("setup failed:", err && err.message ? err.message : err);
  process.exit(1);
});
