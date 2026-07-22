# Memory gauntlet report

Run date: 2026-07-21
Run id: ebbf2617-1e2b-49cf-a547-2aa5c3f222b0
Model: claude-sonnet-5

## Headline results

**Recall, raw keyword grading vs adjudicated, each with a 95% Wilson confidence interval**

| Arm | Raw recall (95% CI) | Adjudicated recall (95% CI) | Adjudication movement |
|---|---|---|---|
| Guessability baseline (no memory) | 5/24 (21%, CI 9-40%) | 0/24 (0%, CI 0-14%) | up 0 / down 5 |
| Stock (native memory) | 16/24 (67%, CI 47-82%) | 11/24 (46%, CI 28-65%) | up 1 / down 6 |
| Engine (Atlas memory) | 18/24 (75%, CI 55-88%) | 14/24 (58%, CI 39-76%) | up 0 / down 4 |
| Engine + native (combined) | 20/24 (83%, CI 64-93%) | 24/24 (100%, CI 86-100%) | up 4 / down 0 |


The guessability baseline (control) is not a competitor: it has no memory of any kind (no hooks, no CLAUDE.md or
auto-memory, no engine), so its recall rate is what the model gets right by guessing or general knowledge alone.
It sets the floor every other arm's number should be read against.

**Capture rate: was the fact stored in durable memory at all**

| Store | Raw capture rate | Adjudicated capture rate |
|---|---|---|
| Stock (native memory) | 5/12 (42%) | 5/12 (42%) |
| Engine (Atlas memory) | 9/12 (75%) | 9/12 (75%) |
| Engine + native: native store | 6/12 (50%) | 6/12 (50%) |
| Engine + native: engine store | 11/12 (92%) | 11/12 (92%) |
| Engine + native: combined (either store) | 11/12 (92%) | 11/12 (92%) |

Capture is not measured for the guessability baseline (control) arm: it is never seeded, so there is nothing to capture.

**Answer quality signals**

| Arm | Stale-echo answers | Timed-out trials |
|---|---|---|
| Guessability baseline (no memory) | 0 | 0 |
| Stock (native memory) | 0 | 0 |
| Engine (Atlas memory) | 0 | 0 |
| Engine + native (combined) | 4 | 0 |


## Raw keyword vs adjudicated grading

Keyword grading now matches on word boundaries, not substrings: each keyword is wrapped in non-alphanumeric
boundary guards, so "Render" no longer counts as a hit inside "rendered", and "15 minutes" no longer counts as a
hit inside "115 minutes". Punctuation and whitespace are still fine boundaries, so "orderId:attempt" and
"strict: true" match at their natural edges. Word-boundary grading still has known failure modes in both
directions: an expected keyword can appear inside a hedge or example list (false positive), and a correct answer
can be phrased outside the keyword list (false negative). 20 answer(s) were manually adjudicated
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
| f01 | conversational | no | yes | no | no/no/no |
| f02 | conversational | no | yes | yes | yes/yes/yes |
| f03 | conversational | no | no | yes | no/yes/yes |
| f04 | conversational | no | no | yes | no/yes/yes |
| f05 | conversational | no | yes | yes | no/yes/yes |
| f06 | explicit | no | no | yes | yes/yes/yes |
| f07 | explicit | no | yes | yes | yes/yes/yes |
| f08 | corrected | no | no | no | yes/yes/yes |
| f09 | corrected | no | no | yes | no/yes/yes |
| f10 | incidental | no | yes | no | yes/yes/yes |
| f11 | incidental | no | no | yes | yes/yes/yes |
| f12 | incidental | no | no | yes | no/yes/yes |

**Recall trials by arm**

| Fact | Control trials | Stock trials | Engine trials | Engine-native trials |
|---|---|---|---|---|
| f01 | miss/miss | correct/correct* | miss/miss | correct*/correct* |
| f02 | miss*/miss* | correct/correct | miss*/correct | correct/correct |
| f03 | miss/miss | miss/miss | miss*/correct | correct/correct* |
| f04 | miss/miss | miss*/miss* | correct/correct | correct/correct |
| f05 | miss/miss | correct/correct | correct/correct | correct/correct |
| f06 | miss*/miss* | correct/miss* | correct/correct | correct/correct* |
| f07 | miss/miss | correct/correct | correct/correct | correct/correct |
| f08 | miss/miss | miss*/miss | miss/miss | correct/correct |
| f09 | miss/miss | miss/miss | correct/miss* | correct/correct |
| f10 | miss/miss | correct/correct | miss/miss | correct/correct |
| f11 | miss*/miss | miss*/miss* | correct/correct | correct/correct |
| f12 | miss/miss | miss/miss | correct/miss* | correct/correct |

Verdicts marked with `*` were set by manual adjudication (see the adjudication appendix). "Guessable" means the
control arm (no memory of any kind) answered correctly in at least one trial: discount those facts when judging
how much a memory system actually added.

## Adjudication appendix

| Arm | Fact | Trial | Keyword verdict | Adjudicated verdict | Author | Timestamp | Reason |
|---|---|---|---|---|---|---|---|
| control | f02 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer claims no package manager is specified and no lock file exists, failing to assert that orderflow uses pnpm. It does not recall the correct fact at all. |
| control | f02 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer claims there is no evidence of which package manager orderflow uses and does not assert pnpm (or any other package manager) as the answer. It asks the user for clarification rather than recalling the fact. |
| control | f06 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer mentions `strict: true` only as a general recommendation while claiming no project-specific rule exists, framing it as general advice rather than asserting it as the established rule for orderflow. This is a miss because the fact states orderflow *always* uses TypeScript strict mode, but the answer presents this only as a suggestion/example rather than recalling it as a known, current project requirement. |
| control | f06 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer explicitly disclaims having a memory entry pinning this rule and frames `"strict": true` as a general recommendation rather than asserting it as a known, established rule for orderflow. This hedging means it does not demonstrate recall of the fact. |
| control | f11 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer explicitly states it cannot find the logging destination and mentions Datadog only as a suggested example ("e.g., a specific log group, Datadog, etc."), not as a recalled fact. This does not constitute recall of the ground truth. |
| stock | f01 | 2 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer clearly states the idempotency key is constructed as `<orderId>:<attemptNumber>` (colon-joined), with the exact example `ord_123:2`, which matches the ground truth fact precisely. |
| stock | f04 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer explicitly states it cannot determine where order records are stored and mentions MongoDB Atlas only as a suggested example ("e.g. MongoDB Atlas, Postgres"), not as a recalled fact. This is a classic "miss" pattern where the true value appears only as a suggestion. |
| stock | f04 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer explicitly states it does not have a memory entry about where orders are persisted and does not assert MongoDB Atlas as the storage location. It only asks about storage as an open design question, which does not constitute recall of the fact. |
| stock | f06 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer frames `"strict": true` as a recommendation rather than asserting it as an existing, always-enabled requirement. It explicitly says "No tsconfig.json exists yet" and offers the setting as a suggestion, which does not constitute recall of the fact that orderflow always uses TypeScript strict mode. |
| stock | f08 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer claims it doesn't know the deploy target and explicitly states it cannot tell where orderflow deploys. While "Render" is mentioned as an example suggestion, it is presented only as a possible option the user might have in mind, not as a recalled fact. This does not constitute recall of the true value. |
| stock | f11 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer claims it cannot find the log shipping destination. While it mentions Datadog as an example in a list of possibilities, it does not assert Datadog as the actual answer, it only offers it as a suggestion alongside other options. |
| stock | f11 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer explicitly states it cannot determine where orderflow ships logs and does not assert Datadog as the answer. It mentions Datadog only as one of several example suggestions, which does not constitute recall of the fact. |
| engine | f02 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer does not assert that orderflow currently uses pnpm; instead, it says pnpm "should" be standardized on but "hasn't actually been added" yet, framing pnpm as a recommendation rather than the current fact. This is a miss, not a confident assertion of the ground truth. |
| engine | f03 | 1 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer explicitly refuses to assert the retry policy as fact, only mentioning "5 attempts with exponential backoff" as an unverified, unconfirmed claim from injected context. This does not constitute recall of the fact. |
| engine | f09 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer explicitly refuses to assert the fact's value (300 requests per minute), instead treating it as suspect injected context and declining to confirm it as current truth. This is a miss, not a correct recall. |
| engine | f12 | 2 | correct | miss | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer explicitly denies the existence of any CI system and claims there is no CI configuration in the repo. While it mentions GitHub Actions as a suggestion for setup, it actively contradicts the fact rather than recalling it. |
| engine-native | f01 | 1 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer clearly states the idempotency key format as `{orderId}:{attemptNumber}` (colon-delimited) and provides the exact matching example `ord_123:2`, which matches the ground truth. The additional context about attempt numbering and scaffolding does not contradict the fact. |
| engine-native | f01 | 2 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer clearly states the idempotency key format is `{orderId}:{attemptNumber}` (colon-delimited) and provides the exact example `ord_123:2`, which matches the ground truth. The additional caveats about implementation status do not contradict the core fact. |
| engine-native | f03 | 2 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer correctly states 5 delivery attempts with exponential backoff, which matches the ground truth. The additional detail about on-call alerts does not contradict the fact. |
| engine-native | f06 | 2 | miss | correct | judge:bedrock:us.anthropic.claude-sonnet-4-6 | 2026-07-22T02:30:00.991Z | The answer clearly states that `"strict": true` should always be enabled in orderflow's tsconfig.json, which directly matches the fact that orderflow always uses TypeScript strict mode. |

Every entry is bound to the exact recorded answer text by a sha256 hash (adjudications.json's answerSha256 field,
checked in grade.mjs), so a stale overlay from a previous run cannot silently apply to a different answer.

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
