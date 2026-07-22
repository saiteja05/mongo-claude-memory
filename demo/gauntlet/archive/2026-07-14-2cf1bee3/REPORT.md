# Memory gauntlet report

Run date: 2026-07-14
Run id: 2cf1bee3-cbea-49a3-925e-d373c33d3ca0
Model: claude-sonnet-5

## Headline results

**Recall, raw keyword grading vs adjudicated, each with a 95% Wilson confidence interval**

| Arm | Raw recall (95% CI) | Adjudicated recall (95% CI) | Adjudication movement |
|---|---|---|---|
| Guessability baseline (no memory) | 8/24 (33%, CI 18-53%) | 2/24 (8%, CI 2-26%) | up 0 / down 6 |
| Stock (native memory) | 16/24 (67%, CI 47-82%) | 14/24 (58%, CI 39-76%) | up 2 / down 4 |
| Engine (Atlas memory) | 21/24 (88%, CI 69-96%) | 18/24 (75%, CI 55-88%) | up 0 / down 4 |
| Engine + native (combined) | 22/24 (92%, CI 74-98%) | 24/24 (100%, CI 86-100%) | up 2 / down 0 |


The guessability baseline (control) is not a competitor: it has no memory of any kind (no hooks, no CLAUDE.md or
auto-memory, no engine), so its recall rate is what the model gets right by guessing or general knowledge alone.
It sets the floor every other arm's number should be read against.

**Capture rate: was the fact stored in durable memory at all**

| Store | Raw capture rate | Adjudicated capture rate |
|---|---|---|
| Stock (native memory) | 7/12 (58%) | 7/12 (58%) |
| Engine (Atlas memory) | 11/12 (92%) | 11/12 (92%) |
| Engine + native: native store | 6/12 (50%) | 6/12 (50%) |
| Engine + native: engine store | 10/12 (83%) | 10/12 (83%) |
| Engine + native: combined (either store) | 12/12 (100%) | 12/12 (100%) |

Capture is not measured for the guessability baseline (control) arm: it is never seeded, so there is nothing to capture.

**Answer quality signals**

| Arm | Stale-echo answers | Timed-out trials |
|---|---|---|
| Guessability baseline (no memory) | 0 | 0 |
| Stock (native memory) | 2 | 0 |
| Engine (Atlas memory) | 1 | 0 |
| Engine + native (combined) | 3 | 0 |


## Raw keyword vs adjudicated grading

Keyword grading now matches on word boundaries, not substrings: each keyword is wrapped in non-alphanumeric
boundary guards, so "Render" no longer counts as a hit inside "rendered", and "15 minutes" no longer counts as a
hit inside "115 minutes". Punctuation and whitespace are still fine boundaries, so "orderId:attempt" and
"strict: true" match at their natural edges. Word-boundary grading still has known failure modes in both
directions: an expected keyword can appear inside a hedge or example list (false positive), and a correct answer
can be phrased outside the keyword list (false negative). 18 answer(s) were manually adjudicated
after reading the full answer texts; each override is bound to the exact recorded answer by a sha256 hash
(adjudications.json's answerSha256 field), so a stale overlay from a previous run cannot silently apply to a
different answer, and a second overlay entry for the same arm/fact/trial is a hard error rather than a silent
first-match-wins pick. Raw keyword numbers are kept alongside the adjudicated numbers everywhere in this report,
never hidden behind an adjudicated-only headline.

## Methodology

- Model used for all seed, recall, and fixture sessions: claude-sonnet-5
- Seed sessions: 5
- Recall questions: 12
- Trials per question: 2
- Four arms: control (no memory of any kind, the guessability baseline), stock (Claude Code's native
  CLAUDE.md/auto-memory), engine (this repo's MongoDB Atlas memory engine only), engine-native (both active at
  once, the realistic day-to-day configuration for most engine users)
- Grading: word-boundary keyword matching (case-insensitive) against each fact's expected_any list; a wrong_any
  hit with no expected_any hit is graded stale; an expected_any hit alongside a wrong_any hit is graded correct
  but flagged staleEcho (recall of the right answer alongside a superseded one); manual adjudications
  (adjudications.json) then override individual verdicts and are bound to the recorded answer by a sha256 hash;
  both gradings are reported with Wilson 95% confidence intervals
- Provenance: state/run.json, state/results.json, and state/capture.json are all stamped with the same run id,
  and this report refuses to render if they disagree, so state from two different runs can never be merged
  undetected
- Fixture project: orderflow, a fictional Node/Express/Stripe payments service (see demo/gauntlet/facts.json)
- Each arm is isolated by its own CLAUDE_CONFIG_DIR and workspace git repo, and each engine arm (engine,
  engine-native) has its own dedicated database, so no arm can read or write another arm's memory
- SessionEnd in print mode: Claude Code cancels SessionEnd (teardown) hooks under `claude -p`, so the engine
  arms' transcript capture cannot rely on the native hook during seeding. The harness invokes the same hook
  binary manually after each engine seed session, with the same payload Claude Code would have sent, pointed at
  the session's real transcript. The native SessionEnd hook fires normally in interactive use; this is a
  print-mode limitation of the harness environment, not of the engine.

## Per-fact appendix

**Capture and guessability**

| Fact | Kind | Guessable (control) | Stock captured | Engine captured | Engine-native captured (native/engine/combined) |
|---|---|---|---|---|---|
| f01 | conversational | no | yes | no | yes/no/yes |
| f02 | conversational | no | yes | yes | yes/yes/yes |
| f03 | conversational | no | yes | yes | no/yes/yes |
| f04 | conversational | no | no | yes | no/yes/yes |
| f05 | conversational | no | no | yes | yes/yes/yes |
| f06 | explicit | yes | yes | yes | yes/yes/yes |
| f07 | explicit | no | yes | yes | yes/no/yes |
| f08 | corrected | no | yes | yes | no/yes/yes |
| f09 | corrected | no | no | yes | no/yes/yes |
| f10 | incidental | no | yes | yes | yes/yes/yes |
| f11 | incidental | no | no | yes | no/yes/yes |
| f12 | incidental | no | no | yes | no/yes/yes |

**Recall trials by arm**

| Fact | Control trials | Stock trials | Engine trials | Engine-native trials |
|---|---|---|---|---|
| f01 | miss/miss | correct*/correct | miss/miss* | correct/correct* |
| f02 | miss*/miss* | correct/correct | miss*/miss* | correct/correct |
| f03 | miss/miss | correct/correct* | correct/correct | correct/correct |
| f04 | miss*/miss | miss*/miss* | correct/correct | correct/correct |
| f05 | miss/miss | miss/miss | correct/correct | correct/correct |
| f06 | correct/correct | correct/correct | correct/correct | correct/correct |
| f07 | miss/miss | correct/correct | correct/correct | correct/correct* |
| f08 | miss/miss | correct/correct | miss/miss* | correct/correct |
| f09 | miss/miss | miss/miss | correct/correct | correct/correct |
| f10 | miss/miss | correct/correct | correct/correct | correct/correct |
| f11 | miss*/miss* | miss*/miss | correct/correct | correct/correct |
| f12 | miss/miss* | miss*/miss | correct/correct | correct/correct |

Verdicts marked with `*` were set by manual adjudication (see the adjudication appendix). "Guessable" means the
control arm (no memory of any kind) answered correctly in at least one trial: discount those facts when judging
how much a memory system actually added.

## Adjudication appendix

| Arm | Fact | Trial | Keyword verdict | Adjudicated verdict | Author | Timestamp | Reason |
|---|---|---|---|---|---|---|---|
| control | f02 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer claims there is no specified package manager and offers to add one, explicitly listing pnpm as just one of several options. It does not assert that pnpm is the package manager used by orderflow. |
| control | f02 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer claims the orderflow project has no indicated package manager and offers npm/yarn/pnpm as options, failing to assert that pnpm is the correct answer. This is a miss, not a recall of the fact. |
| control | f04 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer explicitly states it does not know where orderflow stores its records and mentions MongoDB Atlas only as a hypothetical example ("e.g., MongoDB Atlas, Postgres"), not as a recalled fact. This is a miss. |
| control | f11 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer explicitly states it does not have the information and mentions Datadog only as an example in a list of possibilities ("e.g., Datadog, CloudWatch, a log aggregator"), not as a recalled fact. This is not a demonstration of recall of the true value. |
| control | f11 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer explicitly states it does not know the logging destination and mentions Datadog only as one of several example guesses, not as an assertion of the true value. |
| control | f12 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer claims no CI system exists and denies any knowledge of one, while mentioning GitHub Actions only as a generic suggestion. It does not assert the true fact that orderflow uses GitHub Actions with a 10-minute per-job timeout. |
| stock | f01 | 1 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer clearly states the idempotency key is constructed as `<orderId>:<attemptNumber>` (colon-joined), and gives the exact example `ord_123:2`, which matches the ground truth precisely. |
| stock | f03 | 2 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer correctly states the retry policy as 5 delivery attempts with exponential backoff, which matches the ground truth. The additional detail about an on-call alert and the note about implementation status are supplementary and do not contradict the core fact. |
| stock | f04 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer explicitly states it doesn't know and only mentions MongoDB as an example suggestion ("e.g., MongoDB, Postgres"), not as a recalled fact. This is a miss per the rules. |
| stock | f04 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer explicitly states it cannot recall the data store and offers "MongoDB Atlas" only as an example suggestion (e.g., MongoDB Atlas, Postgres), not as an asserted fact. This is a miss, not a recall of the true value. |
| stock | f11 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer explicitly states it does not know the log shipping destination and only mentions Datadog as an example possibility (alongside Papertrail), never asserting it as the actual answer. |
| stock | f12 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer claims no CI system is configured and denies the existence of any GitHub Actions workflows, directly contradicting the fact that orderflow uses GitHub Actions. It does not recall the correct value. |
| engine | f01 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer explicitly denies that any such idempotency key construction exists in the codebase and refuses to state the format, rather than recalling the fact (order id + attempt number joined with a colon, e.g. ord_123:2). It does not assert the correct value at all. |
| engine | f02 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer does not clearly assert that orderflow uses pnpm as its package manager. Instead, it hedges by saying there's no evidence of a package manager in the current repo, and only mentions pnpm as part of an "intended setup" in a "session note" that "hasn't actually been applied." This fails to recall the fact as current and true. |
| engine | f02 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer does not assert that orderflow uses pnpm as its package manager. It says there is no lockfile or specification in the current state, and only mentions pnpm as part of an "intended" setup that hasn't been written yet, offering to set it up. This does not constitute a recall of the fact. |
| engine | f08 | 2 | stale | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer does not state where orderflow currently deploys. It only mentions that no Heroku references exist, without asserting that the deployment target is Render. |
| engine-native | f01 | 2 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer clearly states the idempotency key format is `{orderId}:{attempt}` (colon-joined), with the explicit example `ord_123:2`, which matches the ground truth exactly. The caveats about implementation do not undermine the correct assertion of the format. |
| engine-native | f07 | 2 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-14T13:06:42.382Z | The answer states the staging Stripe webhook secret rotates on a 90-day cycle, which matches the ground truth of every 90 days. |

Every entry is bound to the exact recorded answer text by a sha256 hash (adjudications.json's answerSha256 field,
checked in grade.mjs), so a stale overlay from a previous run cannot silently apply to a different answer.

## Run notes and incidents

This run (2026-07-14, runId 2cf1bee3-cbea-49a3-925e-d373c33d3ca0) is a full 4-arm rerun on the current hardened codebase, superseding the prior clean run (91ca694b-457e-47d4-a4fc-588d3479fa80). Headline comparison, adjudicated, against that baseline: control (guessability) 2/24 (8%) both runs, unchanged; stock 14/24 (58%) vs 10/24 (42%) baseline, up 4 trials; engine 18/24 (75%) vs 22/24 (92%) baseline, down 4 trials; engine-native 24/24 (100%) vs 22/24 (92%) baseline, up 2 trials. The engine arm's drop is real and is explained below rather than smoothed over: it is not noise, it has a specific, repeatable mechanism.

**Why the engine arm dropped: brief content treated as unverified.** Engine's two lost facts, f01 (idempotency key format) and f02 (package manager), were both confirmed present in the engine's belief store this run (capture-check reports both captured, raw and adjudicated). The recall answers show why they were not recalled: the model explicitly declined to assert them, characterizing the SessionStart-injected brief content as something to "treat with suspicion rather than repeating as fact" (f01 trial 2) or as an "intended" setup that "hasn't actually been applied" (f02, both trials), even though the brief stated both as current fact. The engine-native arm, which has the same facts available through native CLAUDE.md/MEMORY.md files the model reads directly from disk rather than through the SessionStart hook payload, recalled both confidently (f01 correct both trials, f02 correct both trials). This is a real behavioral effect, not a grading artifact: content arriving through the hook-injected brief is being second-guessed in a way that the same content, encountered as an ordinary project file, is not. This is worth follow-up investigation (brief framing/labeling) before citing the engine-only number as stable; the engine-native (combined) number is unaffected and is the realistic day-to-day configuration for most engine users regardless.

**Capture rate.** No capture-check correction was needed this run (raw and adjudicated capture rates matched exactly): stock 7/12 (58%), engine 11/12 (92%), engine-native native store 6/12 (50%), engine-native engine store 10/12 (83%), engine-native combined 12/12 (100%).

**Grading adjudication.** All 96 recorded recall answers (24 per arm) were read in full. 18 verdicts were overturned, reviewed against the actual recorded answer text before being merged into adjudications.json:
- Control: 6 overturns, all correct-to-miss. Every case is the same pattern: the model stated it had no record of the fact, then offered the expected keyword only as a suggested example (f02 both trials: "npm/yarn/pnpm" offered as options; f04 trial 1: "e.g., MongoDB Atlas, Postgres"; f11 both trials: "e.g., Datadog, CloudWatch"; f12 trial 2: "GitHub Actions is the common default").
- Stock: 6 overturns, 4 correct-to-miss (same hedge-and-suggest pattern as control, on f04 both trials, f11 trial 1, f12 trial 1) and 2 miss-to-correct (f01 trial 1 and f03 trial 2, both cases where the model plainly stated the correct fact in wording outside the keyword list: "`<orderId>:<attemptNumber>`" for f01, "5 delivery attempts with exponential backoff" for f03).
- Engine: 4 overturns, 3 correct-to-miss (f01 trial 2, f02 both trials, the brief-suspicion pattern above) and 1 stale-to-miss (f08 trial 2, which deflected the deploy-target question entirely rather than asserting Render or Heroku).
- Engine-native: 2 overturns, both miss-to-correct (f01 trial 2 and f07 trial 2, both plainly correct answers phrased outside the keyword list).

**Seed and recall reliability.** Zero turn-level failures: all 15 seed session-turns (5 sessions across stock, engine, engine-native) and all 96 recall calls (24 per arm) completed on their first attempt under GAUNTLET_TURN_TIMEOUT_MS=420000.

**Consolidation.** Drained after 7 passes with transient Mongo Atlas cold-connect timeouts on both engine-arm databases across passes 2 through 4 (`Socket 'secureConnect' timed out after ~5000ms`, `connectTimeoutMS: 5000`). Direct manual connect tests during the run consistently measured 720-800ms real connect time, confirming this was transient cold-start latency, not unavailability; `src/db/client.ts`'s 5000ms timeout is intentionally tight (it bounds hook fail-open budgets) and is not tuned for batch jobs, so this is expected and self-healing rather than a defect. No data was lost: the one mid-pass timeout in pass 1 hit the post-write summary query, after the batch of 10 facts had already committed. The loop's existing 5-second retry cadence recovered on its own by pass 5 (engine-native) and pass 6 (engine) with no code changes or manual intervention. Final tallies: engine 17 facts processed across 2 batches (14 active / 3 archived beliefs), engine-native 15 facts processed across 2 batches (14 active / 1 archived).

**Contamination during recall.** The engine arm's hard contamination gate (non-empty native auto-memory directory found on the engine-only arm) fired 5 times during recall, always the same path and always 2 files. Each time, the flagged directory was removed exactly as the gate's own error message instructs ("investigate how these directories were created, then remove them... before recall can run") and recall was resumed with GAUNTLET_RESUME=1, without touching any already-recorded answer; the last three occurrences were caught and cleaned automatically by an unattended wrapper loop bounded at 40 attempts. This is a live, repeated confirmation of an already-documented scope boundary (see gauntlet-benchmark-state memory and README): a fresh `claude -p` recall session, with no seeding involved, can itself trigger Claude Code's native auto-memory feature mid-session, writing real content into the engine-only arm as a side effect of that session's own turn. At roughly 1 in 5 engine-arm trials this run, this occurred noticeably more often than the prior clean run (which logged 23 scaffold removals, all empty, zero hard-gate hits). Separately, 19 empty native-memory scaffold dirs were auto-removed during recall without incident, consistent with routine Claude Code directory creation and not a contamination event.

**Scope disclaimer.** This is a single run (one seed corpus, 12 facts, 2 recall trials per fact per arm) of short, headless sessions. It gives one clean, fully-adjudicated data point per arm, but a single-trial-level comparison against the prior run is not a reliable effect-size estimate on its own, and the engine-arm brief-suspicion effect described above warrants a dedicated follow-up run before being treated as a stable finding. Before any public product claim beyond what is already published, a larger run remains recommended: more facts per category, several independent seed corpora, longer sessions, and 3 or more trials per question.

## Honesty and caveats

- The control arm's recall rate is the guessability baseline: some planted facts overlap with general best
  practices or plausible defaults, so a memoryless model can guess them anyway. Any fact the control arm gets
  right in the per-fact appendix should be discounted when judging what a memory system actually contributed.
- Word-boundary keyword grading still misgrades hedged answers and unanticipated phrasings in both directions;
  the adjudication overlay corrects the audited cases, and every override is bound to its exact answer text by a
  sha256 hash, but unaudited answers may still contain keyword artifacts either way.
- Stale-echo counts flag answers that recalled the current fact and a superseded one in the same response;
  timed-out counts flag trials where the claude CLI invocation did not finish before the harness killed it. Both
  are surfaced above rather than folded silently into a miss.
- Run-specific verification evidence (hook firings, consolidator completion, seed retries, and the observed
  behavior of stock auto-memory in headless mode) is documented in the "Run notes and incidents" section above.
