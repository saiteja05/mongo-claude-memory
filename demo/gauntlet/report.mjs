#!/usr/bin/env node
// Renders demo/gauntlet/REPORT.md from state/capture.json and state/results.json.

import path from "node:path";
import fs from "node:fs/promises";
import { ARMS, gauntletRoot, armDir, stateRoot, loadFacts, readJsonl, flagValue } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/report.mjs --date YYYY-MM-DD [--help]

Renders demo/gauntlet/REPORT.md from state/capture.json (capture-check.mjs)
and state/results.json (grade.mjs). Requires --date so the report never
fabricates one; if omitted, falls back to the newest timestamp found across
both arms' state/<arm>/answers.jsonl files.

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

function headlineTable(capture, results) {
  const stockCapture = capture ? pct(capture.overall.stock.rate) : "n/a";
  const engineCapture = capture ? pct(capture.overall.engine.rate) : "n/a";
  const stockRecall = results ? pct(results.summary.stock.recallRate) : "n/a";
  const engineRecall = results ? pct(results.summary.engine.recallRate) : "n/a";
  const stockStale = results ? String(results.summary.stock.stale) : "n/a";
  const engineStale = results ? String(results.summary.engine.stale) : "n/a";
  const stockDisagree = results ? String(results.summary.stock.disagreementCount) : "n/a";
  const engineDisagree = results ? String(results.summary.engine.disagreementCount) : "n/a";

  const kinds = new Set([
    ...(results ? Object.keys(results.summary.stock.byKind) : []),
    ...(results ? Object.keys(results.summary.engine.byKind) : []),
  ]);

  let kindRows = "";
  for (const kind of kinds) {
    const s = results.summary.stock.byKind[kind];
    const e = results.summary.engine.byKind[kind];
    kindRows += `| Recall rate: ${kind} | ${s ? pct(s.rate) : "n/a"} | ${e ? pct(e.rate) : "n/a"} |\n`;
  }

  return `| Metric | Stock (native memory) | Engine (Atlas memory) |
|---|---|---|
| Capture rate (overall) | ${stockCapture} | ${engineCapture} |
| Recall rate (overall) | ${stockRecall} | ${engineRecall} |
${kindRows}| Trial disagreement (facts) | ${stockDisagree} | ${engineDisagree} |
| Stale recalls | ${stockStale} | ${engineStale} |
`;
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

  let rows = "";
  for (const fact of facts) {
    const cap = captureByFact[fact.id];
    const stockFr = resultsByFact.stock[fact.id];
    const engineFr = resultsByFact.engine[fact.id];
    const stockVerdicts = stockFr ? stockFr.trials.map((t) => t.verdict).join("/") : "n/a";
    const engineVerdicts = engineFr ? engineFr.trials.map((t) => t.verdict).join("/") : "n/a";
    rows += `| ${fact.id} | ${fact.kind} | ${cap ? (cap.stock ? "yes" : "no") : "n/a"} | ${cap ? (cap.engine ? "yes" : "no") : "n/a"} | ${stockVerdicts} | ${engineVerdicts} |\n`;
  }

  return `| Fact | Kind | Stock captured | Engine captured | Stock recall trials | Engine recall trials |
|---|---|---|---|---|---|
${rows}`;
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

  if (!capture) console.error("Warning: state/capture.json not found, run capture-check.mjs first.");
  if (!results) console.error("Warning: state/results.json not found, run grade.mjs first.");

  const trials = results && results.perArm.stock[0] ? results.perArm.stock[0].trials.length : "n/a";

  const report = `# Memory gauntlet report

Run date: ${date}

## Headline results

${headlineTable(capture, results)}

## Methodology

- Model used for all seed, recall, and fixture sessions: claude-sonnet-5
- Seed sessions: ${sessions.length}
- Recall questions: ${facts.length}
- Trials per question: ${trials}
- Grading: keyword matching, case-insensitive substring match against each fact's expected_any list; a wrong_any hit with no expected_any hit is graded stale (indicates recall of a superseded fact)
- Fixture project: orderflow, a fictional Node/Express/Stripe payments service (see demo/gauntlet/facts.json)
- Two arms, isolated by a dedicated CLAUDE_CONFIG_DIR and workspace git repo each: stock (Claude Code's native CLAUDE.md/auto-memory) and engine (this repo's MongoDB Atlas memory engine, hooks plus MCP memory_search)
- SessionEnd in print mode: Claude Code cancels SessionEnd (teardown) hooks under \`claude -p\`, so the engine arm's transcript capture cannot rely on the native hook during seeding. The harness invokes the same hook binary (dist/hooks/sessionEnd.js) manually after each engine seed session, with the same payload Claude Code would have sent, pointed at the session's real transcript (logged as phase "sessionEnd-manual"). The native SessionEnd hook fires normally in interactive use; this is a print-mode limitation of the harness environment, not of the engine.

## Per-fact appendix

${perFactAppendix(facts, capture, results)}

## Honesty and caveats

- [ ] Confirm whether stock Claude Code's auto-memory actually wrote any topic files in headless (\`claude -p\`) mode, or whether it requires interactive session end to persist. Record the observed behavior here.
- [ ] Confirm the engine arm's hooks fired on every seed turn (check state/engine/log.jsonl for exit codes and durations), and that every seed session has a "sessionEnd-manual" entry with exit code 0 (the native SessionEnd hook is cancelled by print mode; the manual invocation is the transcript capture path in this harness).
- [ ] Confirm the consolidator ran to completion before capture-check.mjs and recall.mjs (check consolidate.mjs output and the belief counts it printed).
- [ ] Note any turns that hit the turn timeout (GAUNTLET_TURN_TIMEOUT_MS) or any claude CLI failures, and whether they were retried.
- [ ] Note whether the fixture's small scale (${facts.length} facts, 5 sessions) is representative, or whether a larger run would be needed before drawing product conclusions.
- Some planted facts may overlap with general best practices, so a memoryless model can occasionally guess correctly; the corrected-fact and incidental-fact categories are the strongest discriminators.
`;

  const outPath = path.join(gauntletRoot(), "REPORT.md");
  await fs.writeFile(outPath, report, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error("report failed:", err && err.message ? err.message : err);
  process.exit(1);
});
