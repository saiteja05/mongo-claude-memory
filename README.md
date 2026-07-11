# mongo-claude-memory

A persistent, queryable memory engine for Claude Code, backed by MongoDB Atlas. It replaces Claude Code's file-based memory (`CLAUDE.md` auto memory, `#` quick-add, per-topic memory files) with a database-backed pipeline: every session's activity is captured as raw observations, an offline consolidation job distills those observations into deduplicated, ranked beliefs using an LLM, and a compiled brief is injected deterministically at the start of every session. A hybrid ($rankFusion) vector plus full-text search endpoint is also exposed over MCP for on-demand recall of the long tail that does not fit in the brief.

The result is memory that is deterministic at startup (a fixed-size brief is always present, unlike discretionary auto-memory recall), semantically searchable on demand, safe under untrusted input, and correct under concurrent sessions, worktrees, and machines writing at once.

For the full design rationale, verified Atlas capability matrix, and phased implementation plan, see `DESIGN.md`.

---

## Contents

- [Architecture overview](#architecture-overview)
- [What stays unchanged](#what-stays-unchanged)
- [Data model](#data-model)
  - [`observations`](#observations)
  - [`beliefs`](#beliefs)
  - [`briefs`](#briefs)
  - [`locks`](#locks)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Install and build](#install-and-build)
  - [Environment variables](#environment-variables)
  - [Index setup](#index-setup)
  - [Hook registration](#hook-registration)
  - [MCP registration](#mcp-registration)
  - [Consolidator scheduling](#consolidator-scheduling)
- [Using it](#using-it)
  - [1. What happens automatically](#1-what-happens-automatically)
  - [2. Explicitly remembering something](#2-explicitly-remembering-something)
  - [3. Recalling something](#3-recalling-something)
  - [4. Forgetting something](#4-forgetting-something)
  - [5. Keeping memory tidy](#5-keeping-memory-tidy)
- [Configuration modes](#configuration-modes)
  - [Embedding modes (`EMBEDDING_MODE`)](#embedding-modes-embedding_mode)
  - [Rerank modes (`RERANK_MODE`)](#rerank-modes-rerank_mode)
  - [LLM provider (`LLM_PROVIDER`)](#llm-provider-llm_provider)
  - [`VOYAGE_BASE_URL`: native Voyage vs. Atlas model API key](#voyage_base_url-native-voyage-vs-atlas-model-api-key)
  - [Credential matrix by combination](#credential-matrix-by-combination)
- [Search pipeline](#search-pipeline)
- [Operations](#operations)
  - [Safety properties](#safety-properties)
- [Development](#development)

---

## Architecture overview

```
                        ┌───────────────────────────────────────────┐
                        │              Claude Code session           │
                        └───────────────────────────────────────────┘
                            │                │                  │
                     SessionStart      UserPromptSubmit      SessionEnd
                       (inject)         (# capture)         (transcript)
                            │                │                  │
                            │                ▼                  ▼
                            │          ┌───────────────────────────┐
                            │          │   observations (append)   │
                            │          │  source: transcript |     │
                            │          │  remember | hash_line |   │
                            │◄── also ─┤  mcp_write                │
                            │  written │  status: pending          │
                            │  by /remember and memory_write (MCP) │
                            │          └───────────┬───────────────┘
                            │                      │
                            │                      │  cron / trigger
                            │                      ▼
                            │          ┌───────────────────────────┐
                            │          │   consolidation (offline)  │
                            │          │  1. acquire per-project    │
                            │          │     lease (locks)          │
                            │          │  2. claim pending batch    │
                            │          │  3. LLM: extract facts     │
                            │          │  4. embed (voyage-4)       │
                            │          │  5. vector dedupe/upsert   │
                            │          │  6. supersede/archive      │
                            │          │  7. recompile brief        │
                            │          │  8. mark consolidated      │
                            │          └───────────┬───────────────┘
                            │                      │
                            │                      ▼
                            │          ┌───────────────────────────┐
                            │          │   beliefs (durable, ranked)│
                            │          │  scope: core | project |   │
                            │          │  archive                  │
                            │          └───────────┬───────────────┘
                            │                      │
                            │                      ▼
                            │          ┌───────────────────────────┐
                            └─────────►│   briefs (compiled, capped)│
                          findOne, ~10ms│  brief:global,             │
                          fail-open 800ms│  brief:<project>          │
                                        └───────────┬───────────────┘
                                                    │
                                                    │
                        ┌───────────────────────────┴───────────────┐
                        │            MCP server (escape hatch)       │
                        │  memory_search  ($rankFusion + rerank)      │
                        │  memory_write   (writes an observation)     │
                        │  memory_forget  (tombstones a belief)       │
                        └─────────────────────────────────────────────┘
```

Capture is a pure, lock-free append (every writer does an independent `insertOne`, so unlimited concurrent sessions and worktrees never contend). Consolidation is the single place where judgment happens, offline, under a lease, with hindsight. Recall at session start is a single indexed `findOne`: no embedding call, no search, on the hot path. `memory_search` is an on-demand hybrid search for anything that did not make it into the capped brief.

---

## What stays unchanged

This system integrates through Claude Code's public extension points only, so it is worth being explicit about the boundary: everything below keeps behaving exactly as it does in stock Claude Code.

- **Claude Code itself is not modified, forked, wrapped, or proxied.** Integration is entirely through official extension points: hooks registered in `settings.json`, an MCP server, and a `/remember` slash command. Removing those three registrations returns Claude Code to stock behavior with zero residue.
- **`CLAUDE.md` keeps working exactly as before.** This system does not read, move, or replace hand-written `CLAUDE.md` instructions (root or nested). It replaces only Claude Code's *learned* auto memory (the `MEMORY.md` index and topic files), the discretionary recall path, not the instructional one.
- **The conversation loop, model selection, permissions and approval model, other tools, and compaction behavior are untouched.** This system only adds context at `SessionStart` (re-injected on compact and resume) and offers three optional MCP tools (`memory_search`, `memory_write`, `memory_forget`); it changes nothing else about how a session runs.
- **This does not fix in-session context bloat or autocompact thrashing.** If a single oversized tool read or command output fills the context window and triggers repeated auto-compaction, that is a within-session token-budget problem (one read or output too large for the window), not the cross-session memory-loss problem this system solves. The fix for that is smaller reads or `/clear`, not a bigger model and not this memory engine: the brief injected at `SessionStart` here is capped at `BRIEF_CORE_TOKEN_CAP` plus `BRIEF_PROJECT_TOKEN_CAP` (800 plus 1200 tokens by default), a small, fixed addition that neither causes nor cures that failure mode.
- **Failure isolation is total.** If MongoDB, Voyage, or the LLM provider is unreachable, all three hooks fail open and exit `0`, so a session behaves like stock Claude Code plus, at most, a missing brief. `memory_search` degrades to an explicit empty or degraded result rather than throwing.
- **No data leaves infrastructure the user chose.** Memory lives only in the user's own Atlas cluster, and embedding, rerank, and fact-extraction calls go only to the providers the user configured (Voyage or the Atlas model API, Anthropic or Bedrock).

---

## Data model

Four collections, defined in `src/db/schema.ts`.

### `observations`
Raw, high-volume capture. Append-only; never updated except by the consolidator's claim/consolidate lifecycle.

| Field | Type | Notes |
|---|---|---|
| `project` | string | Repo key (see project key derivation below), or `"global"` |
| `session_id` | string | Originating session |
| `source` | `"transcript" \| "remember" \| "hash_line" \| "mcp_write"` | Capture path |
| `priority` | `"normal" \| "high"` | High-priority captures never expire |
| `text` | string | Raw content or a transcript-summary chunk |
| `status` | `"pending" \| "claimed" \| "consolidated"` | Lifecycle state |
| `run_id` | string (optional) | Set when claimed, for idempotent reprocessing |
| `claimed_at` | Date (optional) | For lease/reclaim on crash |
| `created_at` | Date | |
| `expiresAt` | Date (optional) | TTL target; unset for high-priority captures |

### `beliefs`
Consolidated, durable, polymorphic facts. The only collection with a single logical writer (the consolidator), aside from two narrow exceptions (`memory_forget` tombstone, `use_count` increments).

| Field | Type | Notes |
|---|---|---|
| `project` | string | Or `"global"` |
| `scope` | `"core" \| "project" \| "archive"` | `core` is always-injected globally; `project` is per-repo |
| `type` | `"preference" \| "convention" \| "lesson" \| "reference" \| string` | Open-ended |
| `text` | string | The distilled fact; the field that gets embedded |
| `embedding` | `number[]` (optional) | `voyage-4` @ 1024 dims; omitted when Atlas `autoEmbed` manages it |
| `model_version` | string (optional) | e.g. `"voyage-4"`, for future re-embed migrations |
| `importance` | number | Consolidator-assigned; feeds ranking and brief inclusion |
| `use_count` | number | Incremented when surfaced/used; feeds ranking |
| `last_used` | Date (optional) | |
| `created_at` / `updated_at` | Date | |
| `version` | number | Optimistic-concurrency guard for targeted edits |
| `status` | `"active" \| "archived" \| "tombstoned"` | Archived/tombstoned excluded from briefs and search |
| `supersedes` | string (optional) | `_id` of the belief this replaced |
| `observation_ids` | `string[]` | Provenance |

Indexes: Atlas Vector Search on `embedding` (`beliefs_vec`, scalar-quantized, filterable on `project`/`scope`/`status`) or, when `EMBEDDING_MODE=auto`, an `autoEmbed`-backed vector index (`beliefs_vec_auto`) instead, only one of the two is created based on the configured `EMBEDDING_MODE`, plus Atlas Search (BM25) on `text`/`type` (`beliefs_text`), and a compound b-tree index `{project, scope, status}` for the brief compiler. A partial TTL index expires `archived`/`tombstoned` beliefs after 90 days.

### `briefs`
The materialized injection payload, one document per scope key.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | `"brief:global"` or `"brief:<project>"` |
| `project` | string | Or `"global"` |
| `content` | string | Compiled prose, token-capped |
| `token_estimate` | number | |
| `belief_ids` | `string[]` | Provenance for what went in |
| `generation` | number | Monotonically increasing; supports rollback/debug |
| `generated_at` | Date | |

Read path is a single `findOne({_id})`; single-document atomicity guarantees a session never sees a half-written brief.

### `locks`
The TTL lease enforcing one active consolidator run per project.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | `"consolidate:" + project` |
| `holder` | string | `run_id` of the current lease holder |
| `heldUntil` | Date | Lease expiry; a crashed holder self-expires |

---

## Getting started

### Prerequisites
- Node.js (see `package.json` for toolchain; TypeScript 5.7, compiled to `dist/`)
- A MongoDB Atlas cluster (Atlas Search and Atlas Vector Search require Atlas, not a self-managed deployment)
- A Voyage AI API key, or a MongoDB Atlas model API key (the Atlas Embedding and Reranking API), for embeddings and reranking
- An Anthropic API key, or AWS credentials for Bedrock, for the consolidator's fact-extraction LLM call

### Install and build

```bash
npm install
npm run build
```

### Environment variables

All configuration is loaded by `loadConfig()` in `src/config.ts`. Nothing is required beyond a connection string; everything else has a sane default and degrades gracefully if absent.

| Variable | Default | Notes |
|---|---|---|
| `MDB_MCP_CONNECTION_STRING` | none | Preferred connection string source (shared with the MongoDB MCP plugin). Required unless `MEMORY_MONGODB_URI` is set. |
| `MEMORY_MONGODB_URI` | none | Fallback connection string if the MCP-shared one is not set. One of these two is mandatory. |
| `MEMORY_MONGODB_DB` | `claude_memory` | Database name |
| `VOYAGE_API_KEY` | none | Voyage AI (or Atlas model API) key. Absent is tolerated at load time; embedding/read paths handle its absence by degrading, never crashing. |
| `VOYAGE_MODEL` | `voyage-4` | Embedding/rerank model |
| `VOYAGE_DIMENSIONS` | `1024` | Embedding dimensionality |
| `VOYAGE_BASE_URL` | `https://api.voyageai.com` | Set to `https://ai.mongodb.com` to use an Atlas model API key instead of a native Voyage key |
| `BRIEF_CORE_TOKEN_CAP` | `800` | Token cap for the global (`core`) brief |
| `BRIEF_PROJECT_TOKEN_CAP` | `1200` | Token cap for the per-project brief |
| `SESSION_START_TIMEOUT_MS` | `3000` | Fail-open budget for `SessionStart`'s brief fetch. When unset, falls back to `HOOK_INTERNAL_TIMEOUT_MS` if that is set, else 3000 (cold Atlas connects need more than the 800ms general default) |
| `HOOK_INTERNAL_TIMEOUT_MS` | `800` | General hook-internal fail-open default; also the `SessionStart` fallback when `SESSION_START_TIMEOUT_MS` is unset |
| `HOOK_WRITE_TIMEOUT_MS` | `5000` | Budget for the `UserPromptSubmit` hash-line capture write. Explicit remember requests get a longer budget so an in-flight insert is not killed mid-write |
| `OBSERVATION_TTL_DAYS` | `30` | TTL for normal-priority observations |
| `SESSION_END_TIMEOUT_MS` | `5000` | Fail-open budget for the `SessionEnd` hook |
| `ANTHROPIC_API_KEY` | none | Required for fact extraction when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Extraction model |
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `bedrock` |
| `LLM_TIMEOUT_MS` | `60000` | Hard wall-clock cap per LLM call attempt (fact extraction), Anthropic and Bedrock alike |
| `BEDROCK_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Cross-region inference profile ID, used when `LLM_PROVIDER=bedrock` |
| `AWS_REGION` / `BEDROCK_REGION` | `us-east-1` | AWS region for the Bedrock Converse API |
| `CONSOLIDATION_LEASE_MS` | `300000` | Per-project consolidation lease duration |
| `CONSOLIDATION_BATCH_SIZE` | `50` | Observations claimed per run (document count bound) |
| `CONSOLIDATION_BATCH_MAX_CHARS` | `300000` | Total text-length budget per claimed batch; at least one observation is always taken. Bounds the extraction prompt in characters, since a count-only bound can exceed the model's context limit on large transcript observations |
| `CONSOLIDATION_RECLAIM_MS` | `600000` | Age after which a stale `claimed` observation is reclaimed to `pending`; also the age at which a crashed run's project is rediscovered by the no-argument consolidator |
| `CONSOLIDATION_BELIEFS_CONTEXT_LIMIT` | `30` | Existing beliefs passed to the LLM as dedup/context (most recently updated first) |
| `CONSOLIDATION_DEDUPE_THRESHOLD` | `0.93` | Vector similarity threshold above which a candidate fact is treated as a duplicate of an existing belief |
| `EMBEDDING_MODE` | `appside` | `appside` or `auto` (see Configuration modes) |
| `RERANK_MODE` | `auto` | `auto`, `native`, or `appside` (see Configuration modes) |
| `MEMORY_PROJECT_KEY_MODE` | `path` | `path` keys memory by the local `.git` directory path (stable per machine/clone); `remote` keys by the normalized `remote.origin.url`, so every clone on every machine shares one key. Switching modes re-keys project memory: beliefs stored under the old key stay there. `remote` falls back to `path` when there is no origin remote |
| `MEMORY_MCP_ALLOW_CROSS_PROJECT` | unset | Set to `1` to allow `memory_forget` to tombstone beliefs in a project other than the MCP server's resolved one. Off by default; `memory_search` and `memory_write` are unrestricted either way |
| `MEMORY_FAILURE_LOG` | `~/.mongo-claude-memory/failures.log` | Destination for the silent-failure telemetry log (see Diagnosing silent failures) |

### Index setup

Run once against a fresh Atlas database, and safely re-run at any time (every step checks for existing state before creating anything):

```bash
npm run setup:indexes
```

This creates the four collections if missing, the observation TTL index, the beliefs compound index and archival TTL index, the vector search index matching the current `EMBEDDING_MODE` (`beliefs_vec` for app-side embeddings, `beliefs_vec_auto` for Atlas `autoEmbed`, only one is created, not both), and the `beliefs_text` BM25 search index. Search-index creation failures (for example, a Preview feature not enabled on a given cluster) are logged and skipped without blocking the rest of setup.

### Hook registration

Wire the following hooks into Claude Code's settings (`hooks` in `settings.json`), pointing at the built `dist/` entry points:

- `SessionStart`, matched with `"startup|resume|clear|compact"`, running `node dist/hooks/sessionStart.js`. This is what re-injects the brief after a compaction, a `/clear`, or a resume, not only at the very first launch.
- `UserPromptSubmit`, running `node dist/hooks/userPromptSubmit.js`, to capture prompts whose first non-whitespace character is `#` as high-priority observations.
- `SessionEnd`, running `node dist/hooks/sessionEnd.js`, to capture a transcript summary as an observation.

All three hooks fail open unconditionally: any error, timeout, or missing configuration results in a silent no-op and a normal `exit(0)`, never a visible hook failure.

A `/remember` slash command is provided at `.claude/commands/remember.md`; it writes the exact argument text to a temp file (to avoid shell-quoting issues) and invokes `node dist/capture/remember.js --file <path>`, which writes a high-priority observation with `source: "remember"`.

### MCP registration

Register the MCP server (`node dist/mcp/server.js`, stdio transport) to expose `memory_search`, `memory_write`, and `memory_forget` as tools. It reads the same environment variables as the hooks and resolves a default project key from the working directory it is launched in.

### Consolidator scheduling

The consolidator (`node dist/consolidation/cli.js`) is a cron/trigger entry point, not a hook: unlike the hooks, it prints normal progress output and can exit non-zero on a genuine crash. Example crontab line, running every 15 minutes:

```
*/15 * * * * cd /path/to/mongo-claude-memory && /usr/bin/env node dist/consolidation/cli.js >> /var/log/mongo-claude-memory-consolidate.log 2>&1
```

Invoked with no arguments, it discovers and processes every project with pending observations. Pass a project key as a positional argument to process a single project.

---

## Using it

Once the hooks and MCP server are registered (see Getting started above), day-to-day use has four modes: things that happen without you doing anything, explicitly saving a fact, recalling something on demand, and forgetting something. A fifth section covers the maintenance job that turns raw capture into durable memory.

### 1. What happens automatically

Nothing to configure per session. Three hooks run without any user action:

- **`SessionStart`** (startup, resume, clear, compact): fetches `brief:global` and `brief:<project>` with a single `findOne` each and injects their combined `content` as `additionalContext`. Conceptually, the injected brief reads like a short paragraph of standing facts and conventions, for example "Prefers pnpm over npm. This repo's CI gate is `npm run build && npm test`. Uses Bedrock in prod, Anthropic API in dev." It is capped at `BRIEF_CORE_TOKEN_CAP` (800 tokens, global) plus `BRIEF_PROJECT_TOKEN_CAP` (1200 tokens, per project), so it is always a small, fixed-size block, not the full memory store.
- **`UserPromptSubmit`**: any prompt whose first non-whitespace character is `#` is captured as a high-priority observation (`source: "hash_line"`), the same mechanism Claude Code's own quick-add uses. For example typing `# always run migrations before seeding` writes that line to `observations`; the prompt still passes through to Claude unmodified.
- **`SessionEnd`**: captures the last 50,000 characters of the session transcript as one normal-priority observation (`source: "transcript"`), for the consolidator to later extract facts from. Before writing, it strips any exact occurrence of the currently injected brief content from the tail (echo-loop defense: the injected brief is memory output, not new evidence).

All three hooks fail open: if MongoDB is unreachable or misconfigured, they no-op silently and exit `0`. You will never see a memory-path error surface in a session.

### 2. Explicitly remembering something

Two ways to write a fact directly, both landing in `observations` as high-priority (never expire, never subject to `OBSERVATION_TTL_DAYS`):

**`/remember` slash command**, typed in Claude Code:

```
/remember always run migrations before seeding the dev database
```

This writes the argument text to a temp file, then runs `node dist/capture/remember.js --file <path>`, which resolves the project key from the current working directory and writes an observation with `source: "remember"`. On success it prints `Saved to memory (project: <project>).`

**`memory_write` MCP tool**, for Claude to call on your behalf mid-conversation:

```json
{
  "tool": "memory_write",
  "arguments": {
    "text": "This repo's CI gate is npm run build && npm test",
    "project": "mongo-claude-memory"
  }
}
```

`project` and `session_id` are optional and default to the server's resolved project key and `"mcp:memory_write"` respectively. Either path writes only an observation, never a belief directly: only the offline consolidator promotes an observation into a durable, ranked belief.

### 3. Recalling something

The always-injected brief is the first, free recall path; `memory_search` is the on-demand tool for anything that did not fit in the brief's token cap. A user would just ask a natural question:

> "What did we decide about the rerank fallback order?"

and Claude calls the tool itself:

```json
{
  "tool": "memory_search",
  "arguments": {
    "query": "rerank fallback order",
    "project": "mongo-claude-memory",
    "scope": "project",
    "limit": 5
  }
}
```

| Parameter | Required | Notes |
|---|---|---|
| `query` | yes | Free-text search string |
| `project` | no | Defaults to the MCP server's resolved project key |
| `scope` | no | `core`, `project`, or `archive`; unset searches without a scope filter |
| `limit` | no | Defaults to 8 |

The response is:

```json
{
  "results": [
    { "_id": "...", "text": "...", "scope": "project", "type": "convention", "importance": 0.8, "score": 0.71 }
  ],
  "degraded": null
}
```

`degraded` is `null` on a full hybrid ($rankFusion vector + BM25, optionally reranked) run. If part of the pipeline is unavailable it becomes a short reason string instead of throwing, for example `"vector-only: Atlas Search unavailable"`, `"text-only: vector search unavailable"`, or, if everything fails, `"unavailable: memory search failed on every path"` with an empty `results` array.

### 4. Forgetting something

```json
{
  "tool": "memory_forget",
  "arguments": {
    "beliefId": "665f1a2b3c4d5e6f7a8b9c0d",
    "project": "mongo-claude-memory"
  }
}
```

This does not hard-delete anything. It sets that belief's `status` to `"tombstoned"`, bumps `version`, and updates `updated_at`, filtered on both `_id` and `project` so a caller cannot tombstone another project's belief by guessing an id, then immediately recompiles the affected brief(s) so the belief stops being injected at the very next `SessionStart`. A tombstoned belief is excluded from the brief and from `memory_search` results, and is hard-deleted only later, by the partial TTL index, 90 days after tombstoning.

Forgetting a belief in a project other than the MCP server's resolved one is rejected by default (destructive writes stay scoped to the project you are working in); set `MEMORY_MCP_ALLOW_CROSS_PROJECT=1` to allow it. `memory_search` and `memory_write` are unrestricted either way (reads and appends are low-risk).

### 5. Keeping memory tidy

Observations pile up from capture; the consolidator (`node dist/consolidation/cli.js`) is the offline job that turns them into deduplicated, ranked beliefs and recompiles the brief. It is a cron/trigger entry point, not a hook, so it prints normal output and exits non-zero on a genuine failure. See Consolidator scheduling above for the recommended cron line (every 15 minutes).

```bash
# Process every project with pending observations
node dist/consolidation/cli.js

# Process a single project only
node dist/consolidation/cli.js mongo-claude-memory
```

A run acquires a per-project lease, claims a batch of pending observations, extracts facts with the configured LLM, embeds and vector-dedupes them against existing beliefs, upserts (or supersedes/archives) beliefs, recompiles the affected brief, and marks the batch consolidated.

**Preview without writing anything:**

```bash
node dist/consolidation/cli.js mongo-claude-memory --dry-run
```

Runs the same extraction and dedup logic and reports what would change, without touching `beliefs`, `briefs`, or observation status.

**Check health:**

```bash
node dist/consolidation/cli.js --status
```

Reports pending/claimed/consolidated observation counts, stale-claim counts, current lock/lease state, belief counts by project and status, and brief metadata, all as a point-in-time snapshot. No LLM call.

**Undo a bad run:**

```bash
node dist/consolidation/cli.js --rollback --run-id <id>
```

(or `--rollback <id>` as a bare positional). Reverts the belief and brief changes made by that specific run, using each belief's provenance (`observation_ids`, `supersedes`, `generation`). Find the run id in the consolidator's own log output or via `--status`.

---

## Configuration modes

### Embedding modes (`EMBEDDING_MODE`)

| Mode | Behavior | Requires |
|---|---|---|
| `appside` (default) | The application computes 1024-dim `voyage-4` vectors and stores them on the belief document; queries are embedded app-side with `input_type=query`. | `VOYAGE_API_KEY` (or an Atlas model API key via `VOYAGE_BASE_URL`) |
| `auto` | Atlas `autoEmbed` (Preview) computes and stores the embedding server-side from the belief's `text` field on write, via the `beliefs_vec_auto` index; queries are also embedded server-side, via `query: { text: "..." }` passed to `$vectorSearch` against the same index; the app computes no vectors at all in this mode. | Atlas org must have `autoEmbed` enabled; Preview write cap is 2,000 RPM |

Both modes are live, but `setup:indexes` only creates the index for the currently configured mode (to avoid paying for embedding computation in both places at once): switching `EMBEDDING_MODE` requires re-running `npm run setup:indexes` to create the newly-needed index, a one-time idempotent step, not a migration. `autoEmbed` is a Preview feature with per-model query rate limits (3 requests/minute per model), which is why `appside` is the default for high-frequency, hot-path search: `auto` is a better fit for lower-volume or non-latency-sensitive deployments.

### Rerank modes (`RERANK_MODE`)

| Mode | Behavior | Requires |
|---|---|---|
| `auto` (default) | Probes the native Atlas `$rerank` stage once and caches the result; falls back to the Voyage rerank API on failure. | `VOYAGE_API_KEY` for the fallback path; Atlas 8.3+ with `$rerank` enabled in project settings for the native path |
| `native` | Always uses the Atlas `$rerank` stage. | Atlas 8.3+ (auto-upgrade track), `$rerank` enabled in Project Settings |
| `appside` | Always uses the application-side Voyage `rerank()` API. | `VOYAGE_API_KEY` |

### LLM provider (`LLM_PROVIDER`)

| Provider | Behavior | Requires |
|---|---|---|
| `anthropic` (default) | Direct Anthropic API call for fact extraction, with forced tool choice. | `ANTHROPIC_API_KEY` |
| `bedrock` | AWS Bedrock Converse API, using a cross-region inference profile ID. | AWS credentials resolvable in the environment (standard AWS SDK credential chain), `AWS_REGION`/`BEDROCK_REGION` |

### `VOYAGE_BASE_URL`: native Voyage vs. Atlas model API key

| `VOYAGE_BASE_URL` | Credential type |
|---|---|
| `https://api.voyageai.com` (default) | A native Voyage AI API key |
| `https://ai.mongodb.com` | An Atlas Embedding and Reranking API key (no separate Voyage account needed) |

### Credential matrix by combination

| Configuration | Credentials needed |
|---|---|
| `EMBEDDING_MODE=appside`, `RERANK_MODE=appside`, native Voyage | `VOYAGE_API_KEY` against `api.voyageai.com` |
| `EMBEDDING_MODE=appside`, `RERANK_MODE=appside`, Atlas model API | `VOYAGE_API_KEY` set to an Atlas model API key, `VOYAGE_BASE_URL=https://ai.mongodb.com` |
| `EMBEDDING_MODE=auto`, `RERANK_MODE=auto` | `VOYAGE_API_KEY` for query embedding and rerank fallback (write-path embedding is server-side and needs no app credential); Atlas org enablement for `autoEmbed` and `$rerank` |
| Any embedding/rerank mode + `LLM_PROVIDER=anthropic` | Add `ANTHROPIC_API_KEY` |
| Any embedding/rerank mode + `LLM_PROVIDER=bedrock` | Add AWS credentials in the environment; no `ANTHROPIC_API_KEY` needed |

---

## Search pipeline

`memory_search` (exposed over MCP) is the on-demand, long-tail retrieval path; the always-injected brief remains the primary, free recall path for anything that fits in the token cap.

1. **Hybrid fusion**: a single `$rankFusion` aggregation stage (GA on MongoDB 8.0+) fuses a `$vectorSearch` arm (`beliefs_vec`, filtered on `project`/`scope`/`status`) and a `$search` BM25 arm (`beliefs_text`, same filters), combined with weights `{vector: 2, text: 1}`. In `appside` mode, the query vector is computed app-side with `voyage-4` (`input_type=query`). In `auto` mode, the vector arm instead targets `beliefs_vec_auto` with `query: { text: "..." }`, and no app-side query vector is computed at all.
2. **Rerank**: the fused top candidates are optionally reranked for precision, per `RERANK_MODE` above, before the final `$limit`. The fusion score is projected to a named field before reranking, since `$rerank` overwrites `{$meta:"score"}`.
3. **Never-throw degradation ladder**: if Voyage embedding is unavailable, the vector arm is dropped and the query proceeds text-only; if Atlas Search is unavailable, it proceeds vector-only; if both fail, the result is an explicit empty, degraded response rather than a thrown error. No memory-search failure is ever allowed to surface as a session-derailing error.

---

## Operations

The consolidator CLI (`src/consolidation/cli.ts`, `node dist/consolidation/cli.js`) supports several operator modes, gated on explicit flags so a project cannot collide with a subcommand name:

- **Default run**: `node dist/consolidation/cli.js [project]`. With no project argument, discovers and processes every project with pending observations; with one, processes only that project.
- **Dry run**: `node dist/consolidation/cli.js [project] --dry-run`. Runs extraction and dedup logic and reports what would change, without writing anything.
- **Status**: `node dist/consolidation/cli.js --status`. Reports pending/claimed/consolidated observation counts and lease state, without touching the LLM.
- **Rollback**: `node dist/consolidation/cli.js --rollback --run-id <id>` (or `--rollback <id>`). Reverts the belief and brief changes made by a specific consolidation run, using each belief's provenance (`observation_ids`, `supersedes`, `generation`).

### Safety properties

- **Single-writer lease**: only one consolidator process may hold the lease for a given project at a time (`locks` collection, TTL-backed). A crashed holder's lease self-expires; a stale-claim reclaim sweep resets `claimed` observations back to `pending` so no data is stranded.
- **Idempotent writes**: belief upserts are keyed by semantic similarity against the `CONSOLIDATION_DEDUPE_THRESHOLD`, so reprocessing the same observations after a crash never creates duplicate beliefs.
- **Never-throw hooks**: `SessionStart`, `UserPromptSubmit`, and `SessionEnd` all wrap their entire body in a fail-open guard; any failure, including a missing connection string, results in a silent no-op and a clean process exit, never a visible error to the session.
- **Injection deny-list**: extracted facts pass a schema and content validator before being written as beliefs (no imperative-to-the-assistant phrasing, no tool or hook directives), since observation text is untrusted transcript content and must never be treated as an instruction to the extraction LLM or to future sessions.
- **TTL cleanup**: normal-priority observations expire after `OBSERVATION_TTL_DAYS` (default 30); archived or tombstoned beliefs expire after 90 days via a partial TTL index. High-priority captures (`/remember`, `hash_line`, `mcp_write`) never expire as observations, and active beliefs are never hard-deleted by the pipeline, only archived or tombstoned with provenance.

### Diagnosing silent failures

The hooks fail open by design: when MongoDB, Voyage, or the LLM is unreachable, a session behaves like stock Claude Code with no visible error. Two tools exist so "silently doing nothing" is still diagnosable:

- **Failure log.** Every fail-open catch in the three hooks, plus `memory_search`'s total-failure path, appends one line to a local log file: ISO timestamp, component (for example `sessionStart.timeout`, `userPromptSubmit.error`, `sessionEnd`, `memorySearch`), and the error's name only, never its message (driver messages can embed connection details). The file lives at `$MEMORY_FAILURE_LOG`, defaulting to `~/.mongo-claude-memory/failures.log`. If memory seems inert, read this file first.
- **`--doctor`.** `node dist/consolidation/cli.js --doctor` runs an end-to-end connectivity self-check: connects, writes a canary observation to project `doctor:canary` (normal priority, so the observation TTL cleans up any leftovers), reads it back, deletes it, and times a `brief:global` fetch against the `SESSION_START_TIMEOUT_MS` budget. It prints each step's latency and pass/fail and exits non-zero when any step fails. It never prints connection strings.

---

## Development

```bash
npm run build          # compile TypeScript to dist/
npm test               # run the vitest suite
npm run setup:indexes  # idempotent Atlas collection/index setup
npm run consolidate    # run the consolidator CLI
npm run mcp            # start the MCP server (stdio)
```

The test suite (265 tests across the hooks, capture, consolidation, embeddings, MCP tools, and CLI modules) is fully mocked: no live Atlas cluster, Voyage key, or Anthropic/AWS credentials are needed to develop or run it. Live Atlas/Voyage behavior (hybrid search, `autoEmbed`, native `$rerank`, degradation paths) should be verified against a real cluster before relying on it in production, since Atlas capabilities move faster than any fixed test fixture.
