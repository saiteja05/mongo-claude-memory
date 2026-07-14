# Memory gauntlet v2: long-horizon suite

Three standalone scenarios that extend the v1 gauntlet (`demo/gauntlet/`) to cover long-horizon behavior the four-arm benchmark does not exercise. Each scenario is a single self-contained script (plain Node.js ESM, no build step of its own beyond the repo's `npm run build`), runs against its own scratch database and its own scratch Claude Code config dir and workspace, and never touches the v1 gauntlet's databases, state, or the real `claude_memory` database.

The three coverage gaps exercised here:

- **Brief ranking under real token-cap pressure** (Scenario A). Every v1 gauntlet seed session plants a handful of facts per project, so the project-scope query in the brief compiler never has to choose a winner among hundreds of competing beliefs. Scenario A builds that pressure directly: 200 beliefs in one project, 12 of them the facts recall actually needs, and measures which of the 12 survive into the token-capped brief.
- **Cross-session correction chains with per-session consolidation** (Scenario B). Every correction in the v1 gauntlet lands inside the same consolidation batch as its own planting, so it never has to reconcile against an already-consolidated belief store. Scenario B plants a fact, corrects it, and corrects it again, each in its own session with a full consolidation pass in between, and verifies the resulting supersede lineage by walking it, not by guessing membership from keywords.
- **Forget-then-recall with cache and search assertions** (Scenario C). Nothing in the v1 gauntlet verifies that a forgotten fact stays forgotten. Scenario C forgets one of two planted facts through the real `memory_forget` contract and checks every place the fact could resurface: the belief's own status, the recompiled brief, the local brief cache, and a fresh session's recall answer, while confirming the sibling fact that was not forgotten still recalls correctly.

Each scenario is a RESULT-producing measurement, not a pass/fail test: a ranking miss, a broken chain, or a resurfaced fact is recorded in that scenario's `summary.json` and printed in its report, never treated as a script failure. A script exits non-zero only on an infrastructure failure (missing build artifacts, an unreachable database, a missing `claude` binary, a project-key mismatch, or a similar condition that would make the measurement itself meaningless).

## Prerequisites

Same baseline as the v1 gauntlet (see `demo/gauntlet/README.md`):

- Node.js 20+ and the `claude` CLI on PATH
- This repo built: `npm run build` (from the repo root)
- A MongoDB Atlas cluster
- Git available on PATH (each scenario git-inits its own scratch workspace; see "Project-key rule" below)

## Env requirements

| Variable | Needed for |
|---|---|
| `MDB_MCP_CONNECTION_STRING` or `MEMORY_MONGODB_URI` | every scenario: scratch database access, index setup |
| `LLM_PROVIDER` (`anthropic` default with `ANTHROPIC_API_KEY`, `bedrock` with AWS credentials, or `ollama` with a local server), plus `VOYAGE_API_KEY` for embeddings | consolidation in Scenario B (one pass per session) and Scenario C (one pass after seeding); not needed by Scenario A's deterministic brief-ranking leg, since `compileBrief` ranks belief text directly and never reads an embedding |
| `GAUNTLET_TURN_TIMEOUT_MS` (optional, default 180000) | the per-call timeout for every `claude -p` invocation across all three scenarios (seed turns and recall trials alike), inherited from `demo/gauntlet/lib.mjs` |
| `GAUNTLET_INDEX_TIMEOUT_MS` (optional, default 300000) | Scenario B's and Scenario C's poll for `beliefs_vec`/`beliefs_text` becoming queryable before seeding |
| `GAUNTLET_MODEL` (optional) | pins the model used for every `claude` invocation in all three scenarios; default is the rolling `claude-sonnet-5` alias |
| `GAUNTLET_FORGET_DB` (optional) | overrides Scenario C's scratch database name (default `claude_memory_gauntlet_v2_forget`); still must pass the "gauntlet" safety guard below |

None of these scripts read or write `claude_memory`, the real memory database.

## Scratch database naming and the safety guard

Each scenario owns a fixed, hardcoded scratch database name, deliberately not derived from the v1 gauntlet's `GAUNTLET_DB`, so a v2 run can never collide with or be redirected onto a v1 gauntlet database or the real memory database:

| Scenario | Database |
|---|---|
| A (scale) | `claude_memory_gauntlet_v2_scale` |
| B (chain) | `claude_memory_gauntlet_v2_chain` |
| C (forget) | `claude_memory_gauntlet_v2_forget` (or `GAUNTLET_FORGET_DB`, if set) |

Every scenario asserts its resolved database name contains the substring `gauntlet` and, where the name can be overridden by an environment variable (Scenario C), that it never equals `claude_memory`. This assertion runs before any drop or write and exits the process immediately if it fails, so a misconfigured environment variable can never point a `--reset` or a seed run at a database outside the gauntlet's own namespace.

## Project-key rule: scratch workspaces must be their own git repos

The `SessionStart` hook and the MCP server derive their project key from the session's working directory via `getProjectKey(cwd)`, which walks up from `cwd` looking for a git repository (`git rev-parse --git-common-dir`) and falls back to a path hash only when git resolution fails outright. A scratch workspace directory nested inside the `mongo-claude-memory` repo, without a `.git` of its own, does not make git resolution fail: it makes git resolution succeed against the *enclosing* repo instead. If a scenario inserted beliefs under a project key derived from its own workspace path while the hook resolved the enclosing repo's key, every hook and every downstream assertion would silently look for the wrong project, and recall would run against an empty or unrelated brief without any visible error.

Each of the three scripts avoids this by git-initializing its scratch workspace, with a fixed committer identity and a real initial commit, before deriving or using any project key, and by deriving the key from that workspace directory (`getProjectKey(workspaceDir)`) rather than from any literal string the script picks:

- **Scenario A** git-inits `state/scale/workspace/v2-scale-fixture` first, derives the key from it, and asserts the derived key starts with the workspace label prefix before inserting any belief; it also re-derives the key immediately before recall and asserts a `brief:<key>` document exists under it, exiting non-zero otherwise.
- **Scenario B** git-inits `state/chain/workspace/meridian-batch` and commits before any of the three seed sessions runs, and asserts a `brief:<key>` document exists (Scenario B's pre-recall sanity gate) before running recall trials.
- **Scenario C** git-inits `state/forget/workspace/meridian-secrets` before deriving the key and before the single seed session runs.

A human-readable label (`v2-scale-fixture`, `meridian-batch`, `meridian-secrets`) is only the prefix of the derived key, never the key in full; the key itself is whatever `getProjectKey` computes from the git-inited workspace path.

## Scenario A: scale (brief ranking under token-cap pressure)

**What it builds.** A scratch git workspace (`v2-scale-fixture`) and 200 beliefs in one project, all scope `project`: 12 TARGET beliefs about a fictional "meridian" API gateway (invented so a model's world knowledge cannot answer the recall questions on its own) plus 188 template-generated FILLER beliefs describing generic dev-project facts (deploy targets, languages, datastores, on-call rotations, and similar). Fixture generation uses a seeded `mulberry32` PRNG (`FIXTURE_SEED`), so a `--dry-run` and a real run produce byte-for-byte identical fixtures.

**What it measures.**
- Deterministically (no LLM involved): which of the 12 targets survived ranking into the real brief compiler's (`dist/consolidation/compileBrief.js`) output, the brief's `token_estimate` against the configured cap (`BRIEF_PROJECT_TOKEN_CAP`), and how many of the 200 beliefs made it into the brief at all.
- End to end (unless `--no-recall`): one fresh `claude -p` session per target, asking that target's recall question, with no `--mcp-config` or `--allowedTools` grant at all, so a correct answer can only come from the brief the `SessionStart` hook injected, never from a `memory_search` tool call.

**Deterministic vs end-to-end legs.** Steps 1 through 4 (fixture generation, insert, compile, ranking metrics) are deterministic and require no LLM credentials. Step 5 (recall) is the end-to-end leg and is the only place a real `claude` session runs; `--no-recall` stops before it.

**Flags.**
- `--reset`: drops the scratch database, then continues into the same run (fixture generation, insert, compile, and, unless `--no-recall`, recall). Reset-then-run, not reset-and-exit; see "Reset semantics differ across scenarios" below.
- `--dry-run`: generates and prints the fixtures and the provisional project key only. No database writes, no git init, no `claude` calls.
- `--no-recall`: runs the deterministic leg only and stops before end-to-end recall.
- `--help`: prints usage and exits.

## Scenario B: chain (cross-session correction chains)

**What it builds.** A scratch git workspace (`meridian-batch`, a fictional batch worker service) and an A-to-B-to-C correction chain for one invented fact, its flush interval: 45 seconds, then raised to 90 seconds after a queue-backlog incident, then settled at 120 seconds after load testing. Each version is planted in its own fresh `claude -p` session (never `--continue`), followed by a manual `SessionEnd` invocation (print-mode sessions cancel the native `SessionEnd` hook; see the v1 gauntlet README's "Known limitation" section) and one full consolidation pass (`dist/consolidation/cli.js`) before the next session runs, so each correction after the first has to reconcile against an already-consolidated belief store rather than merge inside the same extraction batch as its own planting.

**What it measures.**
- Deterministically (direct reads against the beliefs collection, no LLM): exactly one active belief on the flush-interval topic asserting 120 seconds, and a real supersede lineage: that belief's `supersedes` pointer resolves to an archived 90-second belief, whose own `supersedes` pointer resolves to an archived 45-second belief. Chain members are identified by walking these lineage pointers, not by keyword membership: a live run found the settled belief's own text narrating its provenance ("raised from 90 seconds following load testing"), which would wrongly rope the active belief into a keyword-based "mentions 90" bucket even though the lineage is correct.
- End to end: 2 fresh recall trials asking the current flush interval, graded word-boundary against the 120-second forms (correct) and the 45-/90-second forms (stale).

**Deterministic vs end-to-end legs.** The three seed sessions and the two recall trials are end-to-end legs (real `claude -p` calls and real consolidation passes). Chain verification (step 4) is the deterministic leg: direct database reads, no LLM calls, run after all three seed sessions complete.

**Flags.**
- `--reset`: drops the scratch database and deletes `state/chain/`, then **exits**. This is reset-and-exit, not reset-then-run; see below.
- `--dry-run`: prints the plan (state paths, the three session prompts, the chain assertions, the recall question) and the exact commands that would run. No database connection, no `claude` or `node` child process.
- `--help`: prints usage and exits.

## Scenario C: forget (forget-then-recall with cache and search assertions)

**What it builds.** A scratch git workspace (`meridian-secrets`, a fictional ops/secrets service) and two invented facts planted in one session, one prompt: a KEEP fact (a metrics flush port) that must survive untouched, and a FORGET fact (a legacy export token's vault key) that gets tombstoned. Both fact keyword lists are specific strings a model is unlikely to produce by coincidence.

**What it measures.** After one seed session and one consolidation pass, and after a pre-forget recall trial for each fact (both expected to recall correctly), the scenario calls the real `runMemoryForget(db, { project, beliefId })`, the exact contract `src/mcp/server.ts` uses for the `memory_forget` tool, against the FORGET belief. It then checks every place the forgotten fact could resurface:
- the belief's own `status` (must become `tombstoned`),
- the recompiled brief's content (must be clean of the FORGET fact's keywords),
- the local brief cache file for the derived project key (must be deleted), and
- two fresh post-forget recall trials for the FORGET question (must not resurface) plus one fresh recall trial for the KEEP question (must still recall correctly, proving this is a surgical forget, not a blunt wipe).

Native Claude Code auto-memory under the scratch config dir is fully wiped after seeding and again before every single recall trial, pre-forget and post-forget alike (control-arm semantics: wipe, never refuse), so every recall answer measures the engine's brief and `memory_search` alone. A live run of this scenario found that a recall trial can itself write a fact it just recalled into native auto-memory, and the engine's `memory_forget` has no reach into that native store; wiping before every trial is what isolates the engine's forget path from that separate, native store. This is the same boundary of `memory_forget`'s scope documented in `DESIGN.md` and the root `README.md`.

**Deterministic vs end-to-end legs.** The seed session and every recall trial (pre-forget and post-forget) are end-to-end legs. The tombstone check, the recompiled-brief-content check, and the cache-file-deleted check are the deterministic leg: direct reads against the database and the local filesystem, no LLM calls.

**Flags.**
- `--reset`: drops the scratch database and deletes `state/forget/`, then continues into the same run (provisioning, seeding, forgetting, recall). Reset-then-run, not reset-and-exit; see below.
- `--dry-run`: prints the plan only. No database connection, no `claude` process, no disk writes.
- `--help`: prints usage and exits.

## Reset semantics differ across scenarios

`--reset` does not mean the same thing in all three scripts, and the difference is deliberate, not an inconsistency to paper over:

- **Scenario A** and **Scenario C**: `--reset` drops the scratch database (and, for C, deletes the scenario's state directory too), then the script **keeps running** the rest of its steps against the now-clean database in the same invocation.
- **Scenario B**: `--reset` drops the scratch database, deletes `state/chain/`, and **exits immediately**. A separate, unflagged invocation is required to actually run the scenario afterward.

Running `node demo/gauntlet/v2/scenario-a-scale.mjs --reset` or `scenario-c-forget.mjs --reset` performs a full clean run in one command. Running `scenario-b-chain.mjs --reset` only cleans; run `node demo/gauntlet/v2/scenario-b-chain.mjs` again (without `--reset`) to seed and measure.

## Question-echo exclusion in Scenario C's resurface grading

Scenario C's post-forget resurface check does not use the FORGET fact's full keyword list as-is. A live run of this scenario found the naive version failing falsely: the model's answer correctly *denied* the fact ("nothing about a legacy export token or vault key"), and that correct denial naturally echoes back words from the question itself. `FORGET_QUESTION` literally contains the phrase "legacy export token", so a keyword list that includes that phrase matches just as readily inside a correct denial as inside a genuine resurfacing, making it useless as resurfacing evidence.

The fix: before grading a recall answer for resurfacing, the scenario filters the fact's keyword list down to only the keywords that do **not** appear (case-insensitive, word-boundary) in the question text itself. For the FORGET fact against `FORGET_QUESTION`, that leaves only the actual vault key value (`meridian-legacy-export`), a string a model cannot guess or echo from the question and can only produce by actually still knowing it. This filtered list is used only for the resurfacing check. The correctness checks (did the model recall the fact, run pre-forget) apply the same question-echo filter, but fall back to the original, unfiltered keyword list if filtering would empty it out entirely, since an empty keyword list can never match and would make a correctness check impossible to pass regardless of what the model says.

## Running a scenario

```bash
node demo/gauntlet/v2/scenario-a-scale.mjs --reset        # full clean run: fixtures, insert, compile, recall
node demo/gauntlet/v2/scenario-b-chain.mjs --reset         # clean only, then exits
node demo/gauntlet/v2/scenario-b-chain.mjs                 # seed 3 sessions, consolidate between each, verify, recall
node demo/gauntlet/v2/scenario-c-forget.mjs --reset        # full clean run: seed, consolidate, forget, recall
```

Every script prints usage with `--help` and exits 0. Each writes its own `summary.json` and `log.jsonl`/`answers.jsonl` under `demo/gauntlet/v2/state/<scenario>/`, none of which are shared with or read by the v1 gauntlet's own `state/` directory.
