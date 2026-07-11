# Memory gauntlet

A reproducible A/B benchmark comparing Claude Code's native memory (CLAUDE.md
and auto-memory) against this repo's MongoDB Atlas memory engine. Identical
facts are seeded into headless `claude -p` sessions in two isolated arms, then
recall questions are asked in fresh sessions and graded by keyword matching.

## Prerequisites

- Node.js 20+
- The `claude` CLI on PATH
- This repo built: `npm run build` (from the repo root)
- A MongoDB Atlas cluster for the engine arm and the capture/grade steps that read from it
- The engine arm's consolidator step needs an LLM provider and an embedding provider configured

## Environment variables (names only, values are never printed by these scripts)

| Variable | Needed for |
|---|---|
| `MDB_MCP_CONNECTION_STRING` or `MEMORY_MONGODB_URI` | engine arm hooks/MCP, consolidate, capture-check, recall, grade, reset |
| `VOYAGE_API_KEY` | consolidate (embeddings), engine arm recall (memory_search) |
| `ANTHROPIC_API_KEY` (if `LLM_PROVIDER=anthropic`, the default) or AWS credentials with `LLM_PROVIDER=bedrock` | consolidate (fact extraction) |
| `GAUNTLET_DB` (optional) | overrides the dedicated database name, default `claude_memory_gauntlet` |
| `GAUNTLET_TURN_TIMEOUT_MS` (optional) | overrides the per-call timeout, default 180000 |

None of these scripts read `claude_memory`, the real memory database. `reset.mjs`
refuses to run if `GAUNTLET_DB` resolves to `claude_memory`.

## Run order

```bash
node demo/gauntlet/setup.mjs             # create both arms' config/workspace, check env
node demo/gauntlet/seed.mjs               # run the 5 seed sessions against both arms
node demo/gauntlet/consolidate.mjs        # engine arm only: distill observations into beliefs
node demo/gauntlet/capture-check.mjs      # measure capture rate (no LLM calls)
node demo/gauntlet/recall.mjs             # ask recall questions in fresh sessions, both arms
node demo/gauntlet/grade.mjs              # grade answers, write state/results.json
node demo/gauntlet/report.mjs --date YYYY-MM-DD   # render REPORT.md
```

Every script prints usage with `--help` and exits 0. `seed.mjs` and `recall.mjs`
accept `--dry-run` to print the exact commands without executing anything.

To start over:

```bash
node demo/gauntlet/reset.mjs --yes
```

Without `--yes`, `reset.mjs` only prints what it would do.

## Cost note

Every seed turn and recall trial is pinned to `--model claude-sonnet-5`. The
default fixture is 5 seed sessions (12 turns total) and 12 recall questions at
2 trials each per arm, so a full run is a bounded, known number of headless
`claude -p` invocations, not an open-ended cost.

## Known limitation: SessionEnd hooks in print mode

Claude Code cancels SessionEnd (teardown) hooks in print mode (`claude -p`):
the run prints `SessionEnd hook [...] failed: Hook cancelled` and no transcript
observation lands, even though the same hook fires fine in interactive use.
The harness works around this without changing the engine: after each engine
seed session, `seed.mjs` invokes the exact same hook binary
(`dist/hooks/sessionEnd.js`) manually, piping it the same SessionEnd payload
Claude Code would have sent, pointed at the session's real transcript file.
This is logged as phase `sessionEnd-manual` in `state/engine/log.jsonl`. If
the native hook ever does fire, a rare double capture is possible;
consolidation dedupes semantically, so it does not skew results.

The engine arm also runs with `HOOK_INTERNAL_TIMEOUT_MS=5000` (set by
`seed.mjs` and `recall.mjs`) so cold Atlas connects are not cut off by the
engine's default 800ms fail-open budget.

## Permissions

No permission-skipping flags are used. Seed turns are pure text prompts and
need no tool permissions. Engine-arm recall runs pass
`--allowedTools "mcp__mongo-claude-memory__memory_search"` (matching the
server key in the generated `mcp.json`) so the model can call `memory_search`
without a permission prompt; stock-arm recall gets no extra flags.

## Isolation guarantees

- Each arm gets its own `CLAUDE_CONFIG_DIR` (`state/stock/config`,
  `state/engine/config`) and its own workspace git repo
  (`state/stock/workspace/orderflow`, `state/engine/workspace/orderflow`),
  so native auto-memory and the engine's hooks never see each other's sessions.
- The engine arm's hooks and MCP server always write to a dedicated database
  (`claude_memory_gauntlet` by default, overridable via `GAUNTLET_DB`), never
  the real `claude_memory` database.
- `demo/gauntlet/state/` is gitignored: seeded sessions, logs, and answers are
  local run artifacts, not committed.
