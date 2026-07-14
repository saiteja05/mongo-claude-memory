#!/usr/bin/env node
// Renders demo/gauntlet/REPORT.md from state/run.json, state/results.json
// (grade.mjs) and state/capture.json (capture-check.mjs). Raw and adjudicated
// recall are always shown side by side, never adjudicated-only; capture rate
// is shown alongside. Optional demo/gauntlet/operator-notes.md is included
// verbatim as a "Run notes and incidents" section.

import path from "node:path";
import fs from "node:fs/promises";
import { ARMS, gauntletRoot, armDir, stateRoot, loadFacts, readJsonl, flagValue, readRunInfo } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/report.mjs --date YYYY-MM-DD [--help]

Renders demo/gauntlet/REPORT.md from state/run.json, state/results.json
(grade.mjs) and state/capture.json (capture-check.mjs). Requires --date so
the report never fabricates one; if omitted, falls back to the newest
timestamp found across every arm's state/<arm>/answers.jsonl.

Refuses to render (hard error, exit 1) unless run.json, results.json, and
capture.json all carry the same runId: a red-team finding was that state
files from two different runs were merged into one report undetected (the
two files on disk actually differed by 29 minutes).

Headline shows raw keyword recall and adjudicated recall side by side for
every arm, each with a Wilson 95% confidence interval, plus how many verdicts
each arm's adjudications moved up or down. Capture rate is shown alongside,
with engine-native broken into native/engine/combined. The control arm is
rendered as the guessability baseline, not as a competitor.

If demo/gauntlet/operator-notes.md exists, its contents are included verbatim
as a "Run notes and incidents" section before the caveats.

  --date YYYY-MM-DD   the run date to print in the methodology section
  --help              print this message
`;

const ARM_LABELS = {
  control: "Guessability baseline (no memory)",
  stock: "Stock (native memory)",
  engine: "Engine (Atlas memory)",
  "engine-native": "Engine + native (combined)",
};

const VERDICT_RANK = { miss: 0, stale: 1, correct: 2 };

async function readTextIfExists(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Reads and parses a JSON file that this report cannot proceed without, throwing a clear "run X first" error rather than silently degrading. */
async function loadRequiredJson(p, hint) {
  let raw;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`missing ${p}: run "${hint}" first.`);
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`unparseable ${p}: ${err && err.message ? err.message : err}`);
  }
}

/** Hard provenance gate: refuses to render a report that mixes state from two different runs. */
function assertSameRun(runInfo, results, capture) {
  const ids = {
    "state/run.json": runInfo.runId,
    "state/results.json": results.runId,
    "state/capture.json": capture.runId,
  };
  const distinct = new Set(Object.values(ids));
  if (distinct.size > 1) {
    const lines = Object.entries(ids)
      .map(([file, id]) => `  ${file}: runId ${id}`)
      .join("\n");
    throw new Error(
      `refusing to render: state files disagree on runId, they were not produced by the same run.\n${lines}\n` +
        "This is the red-team finding where state files from different runs were merged undetected (two files on " +
        "disk differed by 29 minutes); re-run setup.mjs, recall.mjs, capture-check.mjs, and grade.mjs back to back " +
        "for one run before reporting."
    );
  }
}

async function inferDateFromAnswers() {
  let newest = null;
  for (const arm of ARMS) {
    const entries = await readJsonl(path.join(armDir(arm), "answers.jsonl"));
    for (const e of entries) {
      if (!e.timestamp) continue;
      const t = new Date(e.timestamp);
      if (!newest || t > newest) newest = t;
    }
  }
  return newest ? newest.toISOString().slice(0, 10) : null;
}

function pct(rate) {
  return `${(rate * 100).toFixed(0)}%`;
}

function fmtCi(ci) {
  return `${(ci.low * 100).toFixed(0)}-${(ci.high * 100).toFixed(0)}%`;
}

/** How many verdicts each arm's applied adjudications moved up (toward correct) or down (away from correct), ranking miss < stale < correct. */
function movementByArm(results) {
  const applied = (results && results.adjudications && results.adjudications.applied) || [];
  const out = {};
  for (const a of applied) {
    out[a.arm] = out[a.arm] || { up: 0, down: 0, same: 0 };
    const rawRank = VERDICT_RANK[a.rawVerdict];
    const newRank = VERDICT_RANK[a.verdict];
    if (newRank > rawRank) out[a.arm].up++;
    else if (newRank < rawRank) out[a.arm].down++;
    else out[a.arm].same++;
  }
  return out;
}

/** Groups one arm's flat perArm trial records by factId, sorted by trial number. */
function groupByFact(perArm, arm) {
  const map = new Map();
  const records = (perArm && perArm[arm]) || [];
  for (const r of records) {
    if (!map.has(r.factId)) map.set(r.factId, []);
    map.get(r.factId).push(r);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.trial - b.trial);
  return map;
}

function fmtTrialVerdicts(records) {
  if (!records || records.length === 0) return "n/a";
  return records.map((r) => (r.adjudicated ? `${r.verdict}*` : r.verdict)).join("/");
}

function isGuessable(controlByFact, factId) {
  const records = controlByFact.get(factId);
  if (!records || records.length === 0) return "n/a";
  return records.some((r) => r.verdict === "correct") ? "yes" : "no";
}

function trialsPerQuestion(results) {
  for (const arm of ARMS) {
    const records = results.perArm && results.perArm[arm];
    if (records && records.length > 0) {
      const firstFactId = records[0].factId;
      return records.filter((r) => r.factId === firstFactId).length;
    }
  }
  return "n/a";
}

function recallHeadlineTable(results) {
  const movement = movementByArm(results);
  let rows = "";
  for (const arm of ARMS) {
    const label = ARM_LABELS[arm] || arm;
    const s = results.summary && results.summary[arm];
    if (!s) {
      rows += `| ${label} | n/a | n/a | n/a |\n`;
      continue;
    }
    const raw = s.raw;
    const adj = s.adjudicated;
    const m = movement[arm] || { up: 0, down: 0 };
    rows += `| ${label} | ${raw.correct}/${raw.totalTrials} (${pct(raw.recallRate)}, CI ${fmtCi(raw.ci)}) | ${adj.correct}/${adj.totalTrials} (${pct(adj.recallRate)}, CI ${fmtCi(adj.ci)}) | up ${m.up} / down ${m.down} |\n`;
  }
  return `| Arm | Raw recall (95% CI) | Adjudicated recall (95% CI) | Adjudication movement |
|---|---|---|---|
${rows}`;
}

function captureHeadlineTable(capture) {
  const o = capture.overall || {};
  const fmt = (v) => (v ? `${v.hit}/${v.total} (${pct(v.rate)})` : "n/a");
  const en = o["engine-native"] || {};
  const rows =
    `| Stock (native memory) | ${fmt(o.stock && o.stock.raw)} | ${fmt(o.stock && o.stock.adjudicated)} |\n` +
    `| Engine (Atlas memory) | ${fmt(o.engine && o.engine.raw)} | ${fmt(o.engine && o.engine.adjudicated)} |\n` +
    `| Engine + native: native store | ${fmt(en.native && en.native.raw)} | ${fmt(en.native && en.native.adjudicated)} |\n` +
    `| Engine + native: engine store | ${fmt(en.engine && en.engine.raw)} | ${fmt(en.engine && en.engine.adjudicated)} |\n` +
    `| Engine + native: combined (either store) | ${fmt(en.combined && en.combined.raw)} | ${fmt(en.combined && en.combined.adjudicated)} |\n`;
  return `| Store | Raw capture rate | Adjudicated capture rate |
|---|---|---|
${rows}
Capture is not measured for the guessability baseline (control) arm: it is never seeded, so there is nothing to capture.`;
}

function qualitySignalsTable(results) {
  let rows = "";
  for (const arm of ARMS) {
    const label = ARM_LABELS[arm] || arm;
    const s = results.summary && results.summary[arm];
    rows += s ? `| ${label} | ${s.staleEchoCount} | ${s.timedOutCount} |\n` : `| ${label} | n/a | n/a |\n`;
  }
  return `| Arm | Stale-echo answers | Timed-out trials |
|---|---|---|
${rows}`;
}

function adjudicationAppendix(results) {
  const applied = results && results.adjudications && results.adjudications.applied;
  if (!applied || applied.length === 0) {
    return "No manual adjudications were applied; adjudicated numbers equal raw keyword numbers.";
  }
  let rows = "";
  for (const a of applied) {
    rows += `| ${a.arm} | ${a.factId} | ${a.trial} | ${a.rawVerdict} | ${a.verdict} | ${a.author} | ${a.timestamp} | ${a.reason} |\n`;
  }
  return `| Arm | Fact | Trial | Keyword verdict | Adjudicated verdict | Author | Timestamp | Reason |
|---|---|---|---|---|---|---|---|
${rows}
Every entry is bound to the exact recorded answer text by a sha256 hash (adjudications.json's answerSha256 field,
checked in grade.mjs), so a stale overlay from a previous run cannot silently apply to a different answer.`;
}

function perFactAppendix(facts, capture, results) {
  const captureByFact = new Map();
  if (capture) {
    for (const f of capture.facts) captureByFact.set(f.factId, f);
  }
  const controlByFact = groupByFact(results.perArm, "control");
  const stockByFact = groupByFact(results.perArm, "stock");
  const engineByFact = groupByFact(results.perArm, "engine");
  const engineNativeByFact = groupByFact(results.perArm, "engine-native");

  let captureRows = "";
  let trialRows = "";
  for (const fact of facts) {
    const cap = captureByFact.get(fact.id);
    const guessable = isGuessable(controlByFact, fact.id);
    const stockCap = cap ? (cap.stock.adjudicated ? "yes" : "no") : "n/a";
    const engineCap = cap ? (cap.engine.adjudicated ? "yes" : "no") : "n/a";
    const engineNativeCap = cap
      ? `${cap.engineNative.native.adjudicated ? "yes" : "no"}/${cap.engineNative.engine.adjudicated ? "yes" : "no"}/${cap.engineNative.combined.adjudicated ? "yes" : "no"}`
      : "n/a";
    captureRows += `| ${fact.id} | ${fact.kind} | ${guessable} | ${stockCap} | ${engineCap} | ${engineNativeCap} |\n`;
    trialRows += `| ${fact.id} | ${fmtTrialVerdicts(controlByFact.get(fact.id))} | ${fmtTrialVerdicts(stockByFact.get(fact.id))} | ${fmtTrialVerdicts(engineByFact.get(fact.id))} | ${fmtTrialVerdicts(engineNativeByFact.get(fact.id))} |\n`;
  }

  return `**Capture and guessability**

| Fact | Kind | Guessable (control) | Stock captured | Engine captured | Engine-native captured (native/engine/combined) |
|---|---|---|---|---|---|
${captureRows}
**Recall trials by arm**

| Fact | Control trials | Stock trials | Engine trials | Engine-native trials |
|---|---|---|---|---|
${trialRows}
Verdicts marked with \`*\` were set by manual adjudication (see the adjudication appendix). "Guessable" means the
control arm (no memory of any kind) answered correctly in at least one trial: discount those facts when judging
how much a memory system actually added.`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  let date = flagValue(argv, "--date");
  if (!date) {
    date = await inferDateFromAnswers();
  }
  if (!date) {
    console.error("No --date given and no timestamps found in state/<arm>/answers.jsonl. Pass --date explicitly.");
    process.exit(1);
  }

  const { facts, sessions } = loadFacts();
  const runInfo = readRunInfo();
  const results = await loadRequiredJson(path.join(stateRoot(), "results.json"), "node demo/gauntlet/grade.mjs");
  const capture = await loadRequiredJson(path.join(stateRoot(), "capture.json"), "node demo/gauntlet/capture-check.mjs");
  assertSameRun(runInfo, results, capture);

  const operatorNotes = await readTextIfExists(path.join(gauntletRoot(), "operator-notes.md"));

  const trials = trialsPerQuestion(results);
  const appliedCount =
    results.adjudications && results.adjudications.applied ? results.adjudications.applied.length : 0;

  const runNotesSection = operatorNotes
    ? `## Run notes and incidents

${operatorNotes.trim()}

`
    : "";

  const report = `# Memory gauntlet report

Run date: ${date}
Run id: ${runInfo.runId}
Model: ${runInfo.model}

## Headline results

**Recall, raw keyword grading vs adjudicated, each with a 95% Wilson confidence interval**

${recallHeadlineTable(results)}

The guessability baseline (control) is not a competitor: it has no memory of any kind (no hooks, no CLAUDE.md or
auto-memory, no engine), so its recall rate is what the model gets right by guessing or general knowledge alone.
It sets the floor every other arm's number should be read against.

**Capture rate: was the fact stored in durable memory at all**

${captureHeadlineTable(capture)}

**Answer quality signals**

${qualitySignalsTable(results)}

## Raw keyword vs adjudicated grading

Keyword grading now matches on word boundaries, not substrings: each keyword is wrapped in non-alphanumeric
boundary guards, so "Render" no longer counts as a hit inside "rendered", and "15 minutes" no longer counts as a
hit inside "115 minutes". Punctuation and whitespace are still fine boundaries, so "orderId:attempt" and
"strict: true" match at their natural edges. Word-boundary grading still has known failure modes in both
directions: an expected keyword can appear inside a hedge or example list (false positive), and a correct answer
can be phrased outside the keyword list (false negative). ${appliedCount} answer(s) were manually adjudicated
after reading the full answer texts; each override is bound to the exact recorded answer by a sha256 hash
(adjudications.json's answerSha256 field), so a stale overlay from a previous run cannot silently apply to a
different answer, and a second overlay entry for the same arm/fact/trial is a hard error rather than a silent
first-match-wins pick. Raw keyword numbers are kept alongside the adjudicated numbers everywhere in this report,
never hidden behind an adjudicated-only headline.

## Methodology

- Model used for all seed, recall, and fixture sessions: ${runInfo.model}
- Seed sessions: ${sessions.length}
- Recall questions: ${facts.length}
- Trials per question: ${trials}
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
- SessionEnd in print mode: Claude Code cancels SessionEnd (teardown) hooks under \`claude -p\`, so the engine
  arms' transcript capture cannot rely on the native hook during seeding. The harness invokes the same hook
  binary manually after each engine seed session, with the same payload Claude Code would have sent, pointed at
  the session's real transcript. The native SessionEnd hook fires normally in interactive use; this is a
  print-mode limitation of the harness environment, not of the engine.

## Per-fact appendix

${perFactAppendix(facts, capture, results)}

## Adjudication appendix

${adjudicationAppendix(results)}

${runNotesSection}## Honesty and caveats

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
`;

  const outPath = path.join(gauntletRoot(), "REPORT.md");
  await fs.writeFile(outPath, report, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error("report failed:", err && err.message ? err.message : err);
  process.exit(1);
});
