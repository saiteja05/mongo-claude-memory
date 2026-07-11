#!/usr/bin/env node
// Renders demo/gauntlet/REPORT.md from state/capture.json and state/results.json.
// Adjudicated numbers are the headline; raw keyword numbers are kept alongside
// for transparency. Optional demo/gauntlet/operator-notes.md is included
// verbatim as a "Run notes and incidents" section.

import path from "node:path";
import fs from "node:fs/promises";
import { ARMS, gauntletRoot, armDir, stateRoot, loadFacts, readJsonl, flagValue } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/report.mjs --date YYYY-MM-DD [--help]

Renders demo/gauntlet/REPORT.md from state/capture.json (capture-check.mjs)
and state/results.json (grade.mjs). Requires --date so the report never
fabricates one; if omitted, falls back to the newest timestamp found across
both arms' state/<arm>/answers.jsonl files.

Headline numbers are the adjudicated grading (keyword grading plus the manual
overrides in adjudications.json); raw keyword numbers are rendered alongside
for transparency, with an appendix listing every applied adjudication.

If demo/gauntlet/operator-notes.md exists, its contents are included verbatim
as a "Run notes and incidents" section before the caveats.

  --date YYYY-MM-DD   the run date to print in the methodology section
  --help              print this message
`;

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function readTextIfExists(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
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

/** Selects the adjudicated summary for an arm, tolerating an old-format results.json. */
function armSummary(results, arm, grading) {
  const s = results && results.summary && results.summary[arm];
  if (!s) return null;
  // New format: { raw: {...}, adjudicated: {...} }; old format: flat summary.
  if (s.raw && s.adjudicated) return s[grading];
  return grading === "raw" ? s : s;
}

function fmtCount(summary) {
  return summary ? `${summary.correct}/${summary.totalTrials}` : "n/a";
}

function headlineTable(capture, results) {
  const stockCapture = capture ? pct(capture.overall.stock.rate) : "n/a";
  const engineCapture = capture ? pct(capture.overall.engine.rate) : "n/a";
  const stock = armSummary(results, "stock", "adjudicated");
  const engine = armSummary(results, "engine", "adjudicated");

  const stockRecall = stock ? `${fmtCount(stock)} (${pct(stock.recallRate)})` : "n/a";
  const engineRecall = engine ? `${fmtCount(engine)} (${pct(engine.recallRate)})` : "n/a";
  const stockStale = stock ? String(stock.stale) : "n/a";
  const engineStale = engine ? String(engine.stale) : "n/a";
  const stockDisagree = stock ? String(stock.disagreementCount) : "n/a";
  const engineDisagree = engine ? String(engine.disagreementCount) : "n/a";

  const kinds = new Set([
    ...(stock ? Object.keys(stock.byKind) : []),
    ...(engine ? Object.keys(engine.byKind) : []),
  ]);

  let kindRows = "";
  for (const kind of kinds) {
    const s = stock && stock.byKind[kind];
    const e = engine && engine.byKind[kind];
    kindRows += `| Recall rate: ${kind} | ${s ? pct(s.rate) : "n/a"} | ${e ? pct(e.rate) : "n/a"} |\n`;
  }

  return `| Metric (adjudicated) | Stock (native memory) | Engine (Atlas memory) |
|---|---|---|
| Capture rate (overall) | ${stockCapture} | ${engineCapture} |
| Recall rate (overall) | ${stockRecall} | ${engineRecall} |
${kindRows}| Trial disagreement (facts) | ${stockDisagree} | ${engineDisagree} |
| Stale recalls | ${stockStale} | ${engineStale} |
`;
}

function rawVsAdjudicatedTable(results) {
  if (!results) return "n/a (no results.json)";
  const rows = [];
  for (const arm of ARMS) {
    const raw = armSummary(results, arm, "raw");
    const adj = armSummary(results, arm, "adjudicated");
    if (!raw || !adj) continue;
    rows.push(
      `| ${arm} | ${fmtCount(raw)} (${pct(raw.recallRate)}) | ${fmtCount(adj)} (${pct(adj.recallRate)}) | ${raw.stale} | ${adj.stale} |`
    );
  }
  if (rows.length === 0) return "n/a (results.json predates adjudication support; re-run grade.mjs)";
  return `| Arm | Raw keyword recall | Adjudicated recall | Raw stale | Adjudicated stale |
|---|---|---|---|---|
${rows.join("\n")}
`;
}

function adjudicationAppendix(results) {
  const applied = results && results.adjudications && results.adjudications.applied;
  if (!applied || applied.length === 0) {
    return "No manual adjudications were applied; adjudicated numbers equal raw keyword numbers.";
  }
  let rows = "";
  for (const a of applied) {
    rows += `| ${a.arm} | ${a.factId} | ${a.trial} | ${a.rawVerdict} | ${a.verdict} | ${a.reason} |\n`;
  }
  let out = `| Arm | Fact | Trial | Keyword verdict | Adjudicated verdict | Reason |
|---|---|---|---|---|---|
${rows}`;
  const unmatched = results.adjudications.unmatched || [];
  if (unmatched.length > 0) {
    out += `\nWarning: ${unmatched.length} adjudication entr${unmatched.length === 1 ? "y" : "ies"} matched no recorded answer: ${unmatched.map((u) => `${u.arm}/${u.factId}/trial ${u.trial}`).join(", ")}.\n`;
  }
  return out;
}

function perFactAppendix(facts, capture, results) {
  const captureByFact = {};
  if (capture) {
    for (const f of capture.facts) captureByFact[f.factId] = f;
  }
  const resultsByFact = { stock: {}, engine: {} };
  if (results) {
    for (const arm of ARMS) {
      for (const fr of results.perArm[arm]) resultsByFact[arm][fr.factId] = fr;
    }
  }

  const fmtTrial = (t) => (t.adjudicated ? `${t.verdict}*` : t.verdict);

  let rows = "";
  for (const fact of facts) {
    const cap = captureByFact[fact.id];
    const stockFr = resultsByFact.stock[fact.id];
    const engineFr = resultsByFact.engine[fact.id];
    const stockVerdicts = stockFr ? stockFr.trials.map(fmtTrial).join("/") : "n/a";
    const engineVerdicts = engineFr ? engineFr.trials.map(fmtTrial).join("/") : "n/a";
    rows += `| ${fact.id} | ${fact.kind} | ${cap ? (cap.stock ? "yes" : "no") : "n/a"} | ${cap ? (cap.engine ? "yes" : "no") : "n/a"} | ${stockVerdicts} | ${engineVerdicts} |\n`;
  }

  return `| Fact | Kind | Stock captured | Engine captured | Stock recall trials | Engine recall trials |
|---|---|---|---|---|---|
${rows}
Verdicts marked with \`*\` were set by manual adjudication (see the adjudication appendix).`;
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
  const capture = await readJson(path.join(stateRoot(), "capture.json"));
  const results = await readJson(path.join(stateRoot(), "results.json"));
  const operatorNotes = await readTextIfExists(path.join(gauntletRoot(), "operator-notes.md"));

  if (!capture) console.error("Warning: state/capture.json not found, run capture-check.mjs first.");
  if (!results) console.error("Warning: state/results.json not found, run grade.mjs first.");

  const trials = results && results.perArm.stock[0] ? results.perArm.stock[0].trials.length : "n/a";
  const appliedCount =
    results && results.adjudications && results.adjudications.applied
      ? results.adjudications.applied.length
      : 0;

  const runNotesSection = operatorNotes
    ? `## Run notes and incidents

${operatorNotes.trim()}

`
    : "";

  const report = `# Memory gauntlet report

Run date: ${date}

## Headline results (adjudicated)

${headlineTable(capture, results)}

## Raw keyword vs adjudicated grading

Keyword grading has known failure modes in both directions: an expected
keyword can appear inside a hedge or example list (false positive), and a
correct answer can be phrased outside the keyword list (false negative).
${appliedCount} answer(s) were manually adjudicated after reading the full
answer texts; the overrides live in demo/gauntlet/adjudications.json and are
reapplied deterministically by grade.mjs, so the corrected numbers are
reproducible. Raw keyword numbers are kept below for transparency.

${rawVsAdjudicatedTable(results)}

## Methodology

- Model used for all seed, recall, and fixture sessions: claude-sonnet-5
- Seed sessions: ${sessions.length}
- Recall questions: ${facts.length}
- Trials per question: ${trials}
- Grading: keyword matching, case-insensitive substring match against each fact's expected_any list; a wrong_any hit with no expected_any hit is graded stale (indicates recall of a superseded fact); manual adjudications (adjudications.json) then override individual verdicts, and both gradings are reported
- Fixture project: orderflow, a fictional Node/Express/Stripe payments service (see demo/gauntlet/facts.json)
- Two arms, isolated by a dedicated CLAUDE_CONFIG_DIR and workspace git repo each: stock (Claude Code's native CLAUDE.md/auto-memory) and engine (this repo's MongoDB Atlas memory engine, hooks plus MCP memory_search)
- SessionEnd in print mode: Claude Code cancels SessionEnd (teardown) hooks under \`claude -p\`, so the engine arm's transcript capture cannot rely on the native hook during seeding. The harness invokes the same hook binary (dist/hooks/sessionEnd.js) manually after each engine seed session, with the same payload Claude Code would have sent, pointed at the session's real transcript (logged as phase "sessionEnd-manual"). The native SessionEnd hook fires normally in interactive use; this is a print-mode limitation of the harness environment, not of the engine.

## Per-fact appendix

${perFactAppendix(facts, capture, results)}

## Adjudication appendix

${adjudicationAppendix(results)}

${runNotesSection}## Honesty and caveats

- Some planted facts may overlap with general best practices, so a memoryless model can occasionally guess correctly; the corrected-fact and incidental-fact categories are the strongest discriminators.
- Keyword grading alone misgrades hedged answers and unanticipated phrasings; the adjudication overlay corrects the audited cases, but unaudited answers may still contain keyword artifacts in either direction.
- Run-specific verification evidence (hook firings, consolidator completion, seed retries, and the observed behavior of stock auto-memory in headless mode) is documented in the "Run notes and incidents" section above.
`;

  const outPath = path.join(gauntletRoot(), "REPORT.md");
  await fs.writeFile(outPath, report, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error("report failed:", err && err.message ? err.message : err);
  process.exit(1);
});
