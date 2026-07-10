# mongo-claude-memory

A persistent, queryable memory engine for Claude Code, backed by MongoDB Atlas. It replaces Claude Code's file-based memory (`CLAUDE.md` auto memory, `#` quick-add, per-topic memory files) with a database-backed pipeline: every session's activity is captured as raw observations, an offline consolidation job distills those observations into deduplicated, ranked beliefs using an LLM, and a compiled brief is injected deterministically at the start of every session. A hybrid ($rankFusion) vector plus full-text search endpoint is also exposed over MCP for on-demand recall of the long tail that does not fit in the brief.

The result is memory that is deterministic at startup (a fixed-size brief is always present, unlike discretionary auto-memory recall), semantically searchable on demand, safe under untrusted input, and correct under concurrent sessions, worktrees, and machines writing at once.

For the full design rationale, verified Atlas capability matrix, and phased implementation plan, see `DESIGN.md`.

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

Indexes: Atlas Vector Search on `embedding` (`beliefs_vec`, scalar-quantized, filterable on `project`/`scope`/`status`), a parallel `autoEmbed`-backed vector index (`beliefs_vec_auto`), Atlas Search (BM25) on `text`/`type` (`beliefs_text`), and a compound b-tree index `{project, scope, status}` for the brief compiler. A partial TTL index expires `archived`/`tombstoned` beliefs after 90 days.

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
| `HOOK_INTERNAL_TIMEOUT_MS` | `800` | Fail-open budget for `SessionStart`'s brief fetch |
| `OBSERVATION_TTL_DAYS` | `30` | TTL for normal-priority observations |
| `SESSION_END_TIMEOUT_MS` | `5000` | Fail-open budget for the `SessionEnd` hook |
| `ANTHROPIC_API_KEY` | none | Required for fact extraction when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Extraction model |
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `bedrock` |
| `BEDROCK_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Cross-region inference profile ID, used when `LLM_PROVIDER=bedrock` |
| `AWS_REGION` / `BEDROCK_REGION` | `us-east-1` | AWS region for the Bedrock Converse API |
| `CONSOLIDATION_LEASE_MS` | `300000` | Per-project consolidation lease duration |
| `CONSOLIDATION_BATCH_SIZE` | `50` | Observations claimed per run |
| `CONSOLIDATION_RECLAIM_MS` | `600000` | Age after which a stale `claimed` observation is reclaimed to `pending` |
| `CONSOLIDATION_BELIEFS_CONTEXT_LIMIT` | `30` | Existing beliefs passed to the LLM as dedup/context |
| `CONSOLIDATION_DEDUPE_THRESHOLD` | `0.93` | Vector similarity threshold above which a candidate fact is treated as a duplicate of an existing belief |
| `EMBEDDING_MODE` | `appside` | `appside` or `auto` (see Configuration modes) |
| `RERANK_MODE` | `auto` | `auto`, `native`, or `appside` (see Configuration modes) |

### Index setup

Run once against a fresh Atlas database, and safely re-run at any time (every step checks for existing state before creating anything):

```bash
npm run setup:indexes
```

This creates the four collections if missing, the observation TTL index, the beliefs compound index and archival TTL index, both vector search indexes (`beliefs_vec` for app-side embeddings, `beliefs_vec_auto` for Atlas `autoEmbed`), and the `beliefs_text` BM25 search index. Search-index creation failures (for example, a Preview feature not enabled on a given cluster) are logged and skipped without blocking the rest of setup.

### Hook registration

Wire the following hooks into Claude Code's settings (`hooks` in `settings.json`), pointing at the built `dist/` entry points:

- `SessionStart`, matched on start, compact, and resume, running `node dist/hooks/sessionStart.js`. This is what re-injects the brief after a compaction, not only at the very first launch.
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

## Configuration modes

### Embedding modes (`EMBEDDING_MODE`)

| Mode | Behavior | Requires |
|---|---|---|
| `appside` (default) | The application computes 1024-dim `voyage-4` vectors and stores them on the belief document; queries are embedded app-side with `input_type=query`. | `VOYAGE_API_KEY` (or an Atlas model API key via `VOYAGE_BASE_URL`) |
| `auto` | Atlas `autoEmbed` (Preview) computes and stores the embedding server-side from the belief's `text` field on write, via the `beliefs_vec_auto` index; queries are also embedded server-side, via `query: { text: "..." }` passed to `$vectorSearch` against the same index; the app computes no vectors at all in this mode. | Atlas org must have `autoEmbed` enabled; Preview write cap is 2,000 RPM |

Both modes are live and both indexes are always created by `setup:indexes`, so a deployment can switch `EMBEDDING_MODE` without a separate index-setup step. `autoEmbed` is a Preview feature with per-model query rate limits (3 requests/minute per model), which is why `appside` is the default for high-frequency, hot-path search: `auto` is a better fit for lower-volume or non-latency-sensitive deployments.

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

---

## Development

```bash
npm run build          # compile TypeScript to dist/
npm test               # run the vitest suite
npm run setup:indexes  # idempotent Atlas collection/index setup
npm run consolidate    # run the consolidator CLI
npm run mcp            # start the MCP server (stdio)
```

The test suite (264 tests across the hooks, capture, consolidation, embeddings, MCP tools, and CLI modules) is fully mocked: no live Atlas cluster, Voyage key, or Anthropic/AWS credentials are needed to develop or run it. Live Atlas/Voyage behavior (hybrid search, `autoEmbed`, native `$rerank`, degradation paths) should be verified against a real cluster before relying on it in production, since Atlas capabilities move faster than any fixed test fixture.
