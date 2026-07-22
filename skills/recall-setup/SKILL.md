---
name: recall-setup
description: Guide users through installing dependencies and configuring environment variables for the Recall memory plugin. Use this skill when a user has just installed the Recall plugin and its hooks or commands are not working (missing node_modules, no MongoDB connection configured), or when they ask how to set up Recall's Atlas connection, Voyage embeddings, or LLM provider.
---

# Recall Setup

This skill guides users through the one-time setup needed after installing the Recall plugin: installing dependencies, configuring the required MongoDB connection, and optionally the embeddings and LLM provider settings.

## Overview

Recall ships as source plus a pre-built `dist/` directory, but its `node_modules` are not committed, so a fresh install needs one `npm install` before the hooks or MCP tools will run. It also needs exactly one environment variable, a MongoDB connection string, before it has anywhere to read and write memory. Everything else has a working default.

This is a step-by-step guide. **This skill never asks for, requests, or handles credential values.** Wherever a step needs a secret (a connection string, an API key), the instructions only show the export line with a placeholder: the user fills it in and saves it themselves.

## Step 1: Discover the Install Path

Two ways to find where the plugin was installed, in this order of preference:

1. **Check for the dependency nudge already in context.** On SessionStart, if `node_modules` has not been installed yet, `pluginGuard.js` emits an additional-context message that starts with `[Recall memory plugin: dependencies not installed yet...]` and embeds the resolved plugin root verbatim, inside a `cd "<path>" && npm install` snippet. If that message is already present in the current session's context, read the path straight out of it: no discovery step needed.

2. **Otherwise, ask Claude Code directly:**

   ```bash
   claude plugin list --json
   ```

   Find the entry whose `id` starts with `recall@` and read its `installPath` field. That absolute path is the plugin root used in every step below (referred to as `<install-path>`).

## Step 2: Install Dependencies (One-Time)

Run, inside `<install-path>`:

```bash
npm install
```

This uses the committed `package-lock.json`, so the resolved versions match what was tested. `npm run build` is **not** needed here: the plugin ships `dist/` pre-built and committed, so there is nothing left to compile after `npm install`.

## Step 3: Required Environment Variable

Recall needs exactly one of these two variables set, to know which MongoDB deployment to read and write memory from:

- `MDB_MCP_CONNECTION_STRING` (preferred): shared with the official MongoDB MCP plugin, so if that is already configured, Recall picks it up automatically with no extra setup.
- `MEMORY_MONGODB_URI`: use this instead if Recall should point at a different deployment than the MongoDB MCP plugin, or if that plugin is not installed.

Check whether either is already set, without ever displaying the value:

```bash
env | grep -E "^(MDB_MCP_CONNECTION_STRING|MEMORY_MONGODB_URI)="
```

If the command prints a line, a connection string is configured (the grep only matches the variable name and its assignment, so treat the mere presence of output as "set", not the value after it). If it prints nothing, one of the two needs to be added; see Step 5.

## Step 4: Optional but Recommended Environment Variables

Everything below has a safe default and can be skipped for a first setup. These are the ones worth knowing about:

- `VOYAGE_API_KEY`: enables Voyage embeddings for semantic memory search. Without it, embedding-dependent features degrade gracefully instead of failing.
  - `VOYAGE_BASE_URL` (default `https://api.voyageai.com`): override this if the key is an Atlas-issued model API key rather than a Voyage-issued one, since those must be pointed at MongoDB's own endpoint instead of Voyage's.
- `LLM_PROVIDER` (default `anthropic`): which LLM backend runs fact extraction and consolidation, one of `anthropic`, `bedrock`, or `ollama`.
  - `anthropic` (default): set `ANTHROPIC_API_KEY`. Optionally `ANTHROPIC_MODEL` (default `claude-sonnet-5`).
  - `bedrock`: set `AWS_REGION` (or `BEDROCK_REGION`, default `us-east-1`) along with whatever AWS credentials the SDK expects from the environment. Optionally `BEDROCK_MODEL`.
  - `ollama`: set `OLLAMA_BASE_URL` (default `http://localhost:11434`) if Ollama is not running on the default local port. Optionally `OLLAMA_MODEL` (default `llama3.1`).
- `MEMORY_MONGODB_DB` (default `claude_memory`): override this only if Recall should use a different database name than the default.

Every other variable in the plugin's configuration (timeouts, batch sizes, TTLs, similarity thresholds) has a working default and never needs to be touched for first setup.

## Step 5: Update the Shell Profile

**This skill never asks for, requests, or handles credential values.** Tell the user to add the export lines themselves, directly to their own shell profile (or a file sourced from it, such as `~/.mcp-env`). The plugin's hooks and MCP-server subprocesses inherit these variables ambiently from whatever environment launched the Claude Code session; this skill has no other way to hand them along.

Example shape (adapt to whichever variables from Steps 3 and 4 apply):

```bash
export MDB_MCP_CONNECTION_STRING="<paste-your-connection-string-here>"
export VOYAGE_API_KEY="<paste-your-voyage-key-here>"
```

After saving, the user should reload the profile (for example `source ~/.zshrc`) and restart the Claude Code session so the new environment is inherited; see Step 7 for why a restart matters.

## Step 6: Set Up Indexes (One-Time, Idempotent)

Recall needs its Atlas indexes created before search and consolidation work correctly. The package defines this as the `setup:indexes` script, but since this skill runs from outside the repo's own directory, invoke the built script directly against the resolved install path instead:

```bash
node "<install-path>/dist/db/setupIndexes.js"
```

This is safe to re-run: it is idempotent and will not duplicate or corrupt existing indexes.

## Step 7: Verify

Run the `/recall-doctor` command to check Atlas connectivity and index health, and relay its output as the definitive "did it work" signal.

If dependencies were just installed for the first time in this session, the hooks that already ran (SessionStart) loaded before `node_modules` existed, so they will still report the missing-dependency guard until the session restarts. Restart the session, or run `/clear`, so SessionStart re-runs and picks up the now-installed dependencies before relying on `/recall-doctor` or any memory feature.
