# Memory gauntlet

A reproducible benchmark comparing this repo's MongoDB Atlas memory engine against Claude Code's native memory (`CLAUDE.md` auto-memory) and against a memoryless baseline. A fixed corpus of facts is seeded into headless `claude -p` sessions across four isolated arms, recall questions are then asked in fresh sessions, and answers are graded by word-boundary keyword matching, cross-checked by a blinded LLM judge, and rendered into `REPORT.md`.

## The four arms

| Arm | Native auto-memory | MongoDB engine | Seeded | Purpose |
|---|---|---|---|---|
| `control` | none (no hooks, no `CLAUDE.md`, no auto-memory) | none | never | Guessability baseline: what a memoryless model gets right on its own. Native memory for this arm is wiped before every recall trial so an earlier trial's guess cannot leak into the next. |
| `stock` | active | none | yes | Claude Code's native memory alone. |
| `engine` | quarantined | active, own database | yes | The MongoDB engine alone. Native auto-memory is deleted after every seed session and swept again at the end of seeding; `recall.mjs` refuses to run (a hard gate, not a cleanup) if any native memory directory still exists for this arm. |
| `engine-native` | active | active, own database | yes | The engine plus native memory both running, the realistic configuration most engine users run day to day. Capture is measured per store here: native, engine, and combined (either store). |

`control` is never seeded: seeding it would defeat the point of measuring guessability, so `seed.mjs` refuses `--arm control` outright.

Each engine arm (`engine`, `engine-native`) gets its own dedicated database (`gauntletDbFor` in `lib.mjs`: `<GAUNTLET_DB>_engine` and `<GAUNTLET_DB>_engine_native`), so the two never read or write each other's beliefs or briefs even though they run the same product. `setup.mjs` generates each arm's `mcp.json` with that arm's own database name baked into the MCP server's environment, so hooks, MCP traffic, and every downstream script for one arm always agree on which database it means.

## Prerequisites

- Node.js 20+
- The `claude` CLI on PATH
- This repo built: `npm run build` (from the repo root)
- A MongoDB Atlas cluster, for the two engine arms and for the capture/grade/report steps that read from it
- An embedding provider (Voyage or an Atlas model API key) and an LLM provider, for the consolidator and for `judge.mjs`
- `demo/gauntlet/facts.json`, provided by the maintainer (see "Local-only artifacts" below)

## Environment variables (names only, values are never printed by these scripts)

| Variable | Needed for |
|---|---|
| `MDB_MCP_CONNECTION_STRING` or `MEMORY_MONGODB_URI` | engine-arm hooks/MCP, `ensure-indexes`, `consolidate`, `capture-check`, `recall`, `grade`, `reset` |
| `VOYAGE_API_KEY` | `consolidate` (embeddings), engine-arm recall (`memory_search`) |
| `ANTHROPIC_API_KEY` (`LLM_PROVIDER=anthropic`, the default), AWS credentials (`LLM_PROVIDER=bedrock`), or a local Ollama server (`LLM_PROVIDER=ollama`) | `consolidate` (fact extraction), `judge.mjs` (adjudication, same provider dispatch as the engine) |
| `GAUNTLET_DB` (optional) | overrides the base database name (default `claude_memory_gauntlet`); each engine arm's own database is derived from this |
| `GAUNTLET_TURN_TIMEOUT_MS` (optional) | overrides the per-call timeout for seed/recall `claude` invocations, default 180000 |
| `GAUNTLET_INDEX_TIMEOUT_MS` (optional) | overrides `ensure-indexes.mjs`'s per-arm index-poll timeout, default 300000 |
| `GAUNTLET_MODEL` (optional) | pins the model used for every seed and recall `claude` invocation; default is the rolling alias `claude-sonnet-5`. Any run whose numbers will be published or compared over time should pin a dated snapshot instead, since a rolling alias can change the model under a comparison without notice |
| `GAUNTLET_RESUME` (optional) | set to `1` to let `recall.mjs` resume into an existing `answers.jsonl`, skipping already-recorded `(factId, trial)` pairs |
| `JUDGE_SHUFFLE_SEED` (optional) | seeds `judge.mjs`'s deterministic presentation-order shuffle; default is a fixed constant |
| `JUDGE_MAX_CALLS` (optional) | caps `judge.mjs`'s LLM call budget for one run, default 200; the run refuses to start if the work list exceeds it |

None of these scripts read `claude_memory`, the real memory database. `reset.mjs` refuses to run if any of its three resolved database names equals `claude_memory` or does not contain the substring `gauntlet`.

## Run order

```bash
node demo/gauntlet/reset.mjs --yes             # start clean: drops all three gauntlet databases and state/

node demo/gauntlet/setup.mjs                   # create all four arms' config/workspace, mint a run id, check env
node demo/gauntlet/ensure-indexes.mjs          # recreate and wait for both engine arms' Atlas search indexes
node demo/gauntlet/seed.mjs                    # run the 5-session, 14-turn seed corpus against stock, engine, engine-native

# Consolidate, repeating until every engine-arm database reports fully drained:
until node demo/gauntlet/consolidate.mjs | grep -q "all engine-arm databases drained"; do sleep 5; done

node demo/gauntlet/capture-check.mjs           # measure capture rate per arm/store (no LLM calls)
node demo/gauntlet/recall.mjs                  # ask the 12 recall questions, 2 trials each, all four arms
node demo/gauntlet/grade.mjs                   # grade raw + adjudicated (adjudications.json), write state/results.json
node demo/gauntlet/judge.mjs                   # blinded LLM adjudicator, writes adjudications-judge.json (disagreements only)

# Review demo/gauntlet/adjudications-judge.json by hand; merge accepted entries into demo/gauntlet/adjudications.json
node demo/gauntlet/grade.mjs                   # re-grade with the reviewed adjudications merged in

node demo/gauntlet/report.mjs --date YYYY-MM-DD   # render REPORT.md
```

`ensure-indexes.mjs` recreates the Atlas search indexes that `reset.mjs` dropped along with the databases, and waits for them to become queryable before seeding proceeds: without it, `$vectorSearch` against a missing index returns empty rather than erroring, so vector dedupe and reconciliation would silently no-op for the whole run, in whichever engine arm's database was affected.

Every script prints usage with `--help` and exits 0. `seed.mjs` and `recall.mjs` accept `--dry-run` to print the exact commands without executing anything. `seed.mjs` accepts `--arm` and `--sessions`; `recall.mjs` accepts `--arm`, `--trials`, and `--facts`, to scope a run to a subset.

## Provenance and resume rules

`setup.mjs` writes `state/run.json` (run id, timestamp, model, arm list) every time it runs; re-running `setup.mjs` mints a new run id, since a fresh setup is treated as the start of a new run. Every downstream script reads `state/run.json` and stamps or checks against its `runId`:

- `seed.mjs` and `recall.mjs` stamp every log line and, for recall, every recorded answer with the run id.
- `grade.mjs` hard-errors if an arm's `answers.jsonl` mixes more than one run id, or if its run id does not match `state/run.json`'s.
- `report.mjs` refuses to render (hard error, exit 1) unless `state/run.json`, `state/results.json`, and `state/capture.json` all carry the same run id, so state from two different runs can never be merged into one report undetected.

`recall.mjs` refuses to append to an arm's `answers.jsonl` if that file already exists, unless `GAUNTLET_RESUME=1` is set: appending to an existing file would otherwise silently duplicate trials. With `GAUNTLET_RESUME=1`, `(factId, trial)` pairs already on disk are skipped, so a crashed run can resume without duplicating trials. To start an arm over from scratch, run `reset.mjs --yes` first.

## Grading

`grade.mjs` matches each fact's `expected_any` and `wrong_any` keyword lists against the recorded answer text on word boundaries, not as a plain substring: each keyword is wrapped in non-alphanumeric boundary guards, so "Render" does not match inside "rendered" and "15 minutes" does not match inside "115 minutes", while punctuation and whitespace (`orderId:attempt`, `strict: true`) remain fine boundaries.

- **correct**: an `expected_any` keyword matched.
- **stale**: no `expected_any` match, but a `wrong_any` keyword matched (a superseded value recalled as if current).
- **miss**: neither matched.
- **staleEcho**: a diagnostic flag (verdict stays `correct`) set when both an expected and a wrong keyword matched in the same answer, i.e. the model recalled the current fact alongside a superseded one.

Both raw (keyword-only) and adjudicated recall rates are computed with a Wilson 95% confidence interval, overall and by fact kind, for every arm that has recorded answers. `grade.mjs` hard-errors before grading if any `answers.jsonl` contains two or more records for the same `(factId, trial)` (silent append inflation) rather than silently deduplicating.

## Adjudication integrity

Manual overrides live in `demo/gauntlet/adjudications.json`, an array of `{ arm, factId, trial, verdict, reason, author, timestamp, answerSha256 }`. `grade.mjs` validates every entry strictly before applying any of them: an unknown arm, fact id, or verdict; a non-integer trial; an empty or missing `reason` or `author`; an unparseable `timestamp`; a missing `answerSha256`; an entry targeting a trial with no recorded answer; a second entry for the same `(arm, factId, trial)` (no first-match-wins); or an `answerSha256` that does not match the sha256 of the exact recorded answer text, are all hard errors that name the offending entry. The hash binding is what stops a stale overlay from a previous run silently reattaching to a different answer that now occupies the same slot.

`judge.mjs` is a blinded, order-randomized, rubric-driven LLM adjudicator that cross-checks the same raw keyword grading:

- **Blinded**: the judge is never told which arm produced an answer, only the fact's ground-truth statement, the question asked, and the answer text.
- **Order-randomized**: the work list is shuffled with a seeded Fisher-Yates shuffle (`JUDGE_SHUFFLE_SEED`) so the judge cannot infer arm identity from call ordering.
- **Rubric-driven**: a fixed correct/stale/miss rubric (matching `grade.mjs`'s own semantics) is sent as the judge's system prompt.
- Only trials where the judge's verdict disagrees with the recorded `rawVerdict` in `state/results.json` are written, to `demo/gauntlet/adjudications-judge.json`, in the same hardened schema as `adjudications.json`.
- `JUDGE_MAX_CALLS` (default 200) bounds LLM spend; the run refuses to start if the work list exceeds it.
- The operator reviews `adjudications-judge.json` by hand and merges accepted entries into `adjudications.json` before re-running `grade.mjs`; the judge's output is a candidate list, never an auto-applied override.
- **Disclosed limitation**: judging with a model from the same family as the model that answered the recall questions (the default, since both default to Anthropic models) is a known limitation of this cross-check, not a hidden one. Set a different `LLM_PROVIDER` for `judge.mjs` where possible.

## Threats to validity this design controls

- **Contamination**: native Claude Code auto-memory lives at `<configDir>/projects/<slug>/memory/`, one level deeper than a naive check would look. The engine arm quarantines that path after every seed session and again in a final sweep, and `recall.mjs` hard-gates on it before every engine-arm trial, refusing to run rather than cleaning up, so seeding alone owns the guarantee.
- **Self-adjudication**: `judge.mjs` provides a blinded, order-randomized, independently-rubric-driven cross-check of the keyword grading, rather than relying on a single unblinded human pass over the same answers used to build the product under test.
- **Provenance**: a run id is minted once by `setup.mjs` and threaded through every downstream artifact; `report.mjs` refuses to render if any of them disagree, so state from two different runs cannot be merged into one report.
- **Substring grading**: keyword matching is word-boundary-safe, not a plain substring test, so common false positives ("Render" inside "rendered", "15 minutes" inside "115 minutes") do not silently inflate a score.
- **Masked production timeouts**: the harness sets no `HOOK_INTERNAL_TIMEOUT_MS` override for either engine arm. Production defaults (an 800ms fail-open budget) apply unless the operator explicitly exports one in their own shell before invoking these scripts, and that choice must be disclosed alongside any published run.
- **Guessability**: the `control` arm establishes a per-fact baseline of what a memoryless model gets right anyway, so a stock or engine win on a fact the control arm also gets right can be read against that baseline instead of assumed to be memory's doing.

## Known limitation: SessionEnd hooks in print mode

Claude Code cancels `SessionEnd` (teardown) hooks in print mode (`claude -p`): the run prints `SessionEnd hook [...] failed: Hook cancelled` and no transcript observation lands via the native hook, even though the same hook fires normally in interactive use. This affects both engine arms (`engine`, `engine-native`) during seeding. The harness works around this without changing the engine: after each engine or engine-native seed session, `seed.mjs` invokes the same hook binary (`dist/hooks/sessionEnd.js`) manually, piping it the same `SessionEnd` payload Claude Code would have sent, pointed at that session's real transcript file (rejecting a transcript older than the session that just ran, rather than risk capturing a stale one). This is logged as phase `sessionEnd-manual` in `state/<arm>/log.jsonl`. If the native hook ever does fire, a rare double capture is possible; consolidation dedupes semantically, so it does not skew results.

Neither `seed.mjs` nor `recall.mjs` sets `HOOK_INTERNAL_TIMEOUT_MS` for either engine arm: the engine's production fail-open default (800ms) applies to every benchmarked call unless the operator exports an override in their own shell before invoking these scripts. Any published run should state whether such an override was in effect, since it changes what a cold Atlas connect's failure mode looks like under benchmark conditions.

## Permissions

No permission-skipping flags are used. Seed turns are pure text prompts and need no tool permissions. Engine-arm recall runs (`engine`, `engine-native`) pass `--allowedTools "mcp__mongo-claude-memory__memory_search"` (matching the server key in the generated `mcp.json`) so the model can call `memory_search` without a permission prompt; `control` and `stock` recall get no extra flags.

## Isolation guarantees

- Each arm gets its own `CLAUDE_CONFIG_DIR` (`state/<arm>/config`) and its own workspace git repo (`state/<arm>/workspace/orderflow`), so no arm's hooks or native auto-memory can see another arm's sessions.
- `control` and `stock` config dirs are left deliberately empty by `setup.mjs`: no hooks, no `mcp.json`. `control` never gains memory of any kind by accident; `stock`'s only memory is whatever Claude Code's own native auto-memory writes.
- Each engine arm's hooks and MCP server write only to that arm's own dedicated database (`gauntletDbFor`), never the real `claude_memory` database and never the other engine arm's database.
- The `control` arm's native auto-memory directories are force-cleared before every recall trial, so a guess saved by the model in one trial cannot leak into the next.
- `demo/gauntlet/state/` is gitignored: seeded sessions, logs, and answers are local run artifacts, not committed.

## Long-horizon suite (v2)

`demo/gauntlet/v2/` holds three standalone scenarios that cover long-horizon behavior this four-arm benchmark does not exercise, each against its own scratch database and scratch config dir, isolated from the arms above. See `demo/gauntlet/v2/README.md` for full detail.

- **Scenario A (scale)**: whether the right beliefs survive brief compilation when 200 beliefs in one project compete for the token cap, ranking measured deterministically and closed with end-to-end recall.
- **Scenario B (chain)**: an A-to-B-to-C correction chain for one fact across three sessions, each reconciling against an already-consolidated belief store rather than merging inside the same batch as its own planting.
- **Scenario C (forget)**: whether a fact forgotten through the real `memory_forget` contract stays forgotten across the belief's status, the recompiled brief, the local brief cache, and fresh-session recall, while a sibling fact that was not forgotten still recalls correctly.

## Local-only artifacts

`demo/gauntlet/facts.json` and every result artifact this harness produces (`REPORT.md`, `operator-notes.md`, `adjudications*.json*`, `RED-TEAM.md`) are gitignored and local-only. A fresh clone of this repo does not have `facts.json`; it must be provided by the maintainer before any script here can run. Results stay out of the repo, rather than being committed as they are produced, until a run exists that has been through the full pipeline above, including the blinded judge cross-check and a human review of its disagreements, and is defensible as a published number rather than a single unaudited pass.
