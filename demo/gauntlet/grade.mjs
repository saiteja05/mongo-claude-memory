#!/usr/bin/env node
// Grades recall answers against facts.json using keyword matching, per arm,
// then applies an optional manual adjudication overlay (adjudications.json)
// so human-audited corrections are reproducible. Both raw keyword numbers and
// adjudicated numbers are reported; adjudicated is the headline.

import path from "node:path";
import fs from "node:fs/promises";
import { ARMS, loadFacts, armDir, stateRoot, gauntletRoot, readJsonl, containsAny, ensureDir } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/grade.mjs [--help]

Reads state/<arm>/answers.jsonl for both arms plus facts.json. Per answer:
  correct: contains any expected_any keyword (case-insensitive)
  stale:   contains no expected_any keyword, but does contain a wrong_any keyword
  miss:    neither

If demo/gauntlet/adjudications.json exists (an array of
{arm, factId, trial, verdict, reason}), each entry overrides that specific
answer's verdict after keyword grading. Keyword grading has known false
positives (an expected keyword inside a hedge or example list) and false
negatives (a correct answer phrased outside the keyword list); the overlay
makes human-audited corrections reproducible.

Writes state/results.json with per-arm per-fact per-trial verdicts (raw and
adjudicated), recall rates overall and by kind for both gradings, trial
disagreement, stale-recall counts, and the list of applied adjudications.
Prints both tables, adjudicated as the headline. Does not call the claude CLI.
`;

const VALID_VERDICTS = new Set(["correct", "stale", "miss"]);

function gradeAnswer(fact, answerText) {
  const expected = fact.expected_any || [];
  const wrong = fact.wrong_any || [];
  if (containsAny(answerText, expected)) return "correct";
  if (containsAny(answerText, wrong)) return "stale";
  return "miss";
}

async function loadAdjudications() {
  const p = path.join(gauntletRoot(), "adjudications.json");
  let raw;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("adjudications.json must be a JSON array");
  }
  for (const entry of parsed) {
    if (!ARMS.includes(entry.arm) || !entry.factId || !Number.isInteger(entry.trial) || !VALID_VERDICTS.has(entry.verdict)) {
      throw new Error(
        `invalid adjudication entry: ${JSON.stringify({ arm: entry.arm, factId: entry.factId, trial: entry.trial, verdict: entry.verdict })}`
      );
    }
  }
  return parsed;
}

async function gradeArm(arm, facts, adjudications) {
  const answersPath = path.join(armDir(arm), "answers.jsonl");
  const answers = await readJsonl(answersPath);
  const byFact = {};
  for (const a of answers) {
    byFact[a.factId] = byFact[a.factId] || [];
    byFact[a.factId].push(a);
  }

  const armAdjudications = adjudications.filter((e) => e.arm === arm);
  const applied = [];

  const factResults = [];
  for (const fact of facts) {
    const trials = (byFact[fact.id] || []).sort((a, b) => a.trial - b.trial);
    const verdicts = trials.map((t) => {
      const rawVerdict = gradeAnswer(fact, t.answer || "");
      const override = armAdjudications.find((e) => e.factId === fact.id && e.trial === t.trial);
      let verdict = rawVerdict;
      let adjudicated = false;
      if (override) {
        verdict = override.verdict;
        adjudicated = true;
        applied.push({
          arm,
          factId: fact.id,
          trial: t.trial,
          rawVerdict,
          verdict: override.verdict,
          reason: override.reason || "",
        });
      }
      return { trial: t.trial, rawVerdict, verdict, adjudicated, durationMs: t.durationMs };
    });
    const distinctRaw = new Set(verdicts.map((v) => v.rawVerdict));
    const distinctAdj = new Set(verdicts.map((v) => v.verdict));
    factResults.push({
      factId: fact.id,
      kind: fact.kind,
      trials: verdicts,
      disagreementRaw: distinctRaw.size > 1,
      disagreement: distinctAdj.size > 1,
    });
  }

  // Any adjudication entry that never matched an answer is surfaced, never silently dropped.
  const unmatched = armAdjudications.filter(
    (e) => !applied.some((a) => a.factId === e.factId && a.trial === e.trial)
  );

  return { factResults, applied, unmatched };
}

function summarize(factResults, verdictField, disagreementField) {
  let correct = 0;
  let stale = 0;
  let miss = 0;
  let totalTrials = 0;
  const byKind = {};
  let disagreementCount = 0;

  for (const fr of factResults) {
    byKind[fr.kind] = byKind[fr.kind] || { correct: 0, total: 0 };
    if (fr[disagreementField]) disagreementCount++;
    for (const t of fr.trials) {
      totalTrials++;
      byKind[fr.kind].total++;
      const v = t[verdictField];
      if (v === "correct") {
        correct++;
        byKind[fr.kind].correct++;
      } else if (v === "stale") {
        stale++;
      } else {
        miss++;
      }
    }
  }

  const byKindRates = {};
  for (const [k, v] of Object.entries(byKind)) {
    byKindRates[k] = { correct: v.correct, total: v.total, rate: v.total ? v.correct / v.total : 0 };
  }

  return {
    totalTrials,
    correct,
    stale,
    miss,
    recallRate: totalTrials ? correct / totalTrials : 0,
    byKind: byKindRates,
    disagreementCount,
    disagreementFacts: factResults.filter((f) => f[disagreementField]).map((f) => f.factId),
  };
}

function printSummary(arm, label, summary) {
  console.log(`\n[${arm}] ${label} recall rate: ${summary.correct}/${summary.totalTrials} (${(summary.recallRate * 100).toFixed(0)}%)`);
  console.log(`[${arm}] ${label} stale recalls: ${summary.stale}, misses: ${summary.miss}`);
  console.log(`[${arm}] ${label} trial disagreement on ${summary.disagreementCount} fact(s): ${summary.disagreementFacts.join(", ") || "none"}`);
  console.log(`[${arm}] ${label} recall rate by kind:`);
  for (const [kind, v] of Object.entries(summary.byKind)) {
    console.log(`    ${kind.padEnd(14)} ${v.correct}/${v.total}  (${(v.rate * 100).toFixed(0)}%)`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const { facts } = loadFacts();
  const adjudications = await loadAdjudications();
  if (adjudications.length > 0) {
    console.log(`Loaded ${adjudications.length} adjudication(s) from adjudications.json`);
  }

  const results = {};
  const summaries = {};
  const allApplied = [];
  const allUnmatched = [];

  for (const arm of ARMS) {
    const { factResults, applied, unmatched } = await gradeArm(arm, facts, adjudications);
    results[arm] = factResults;
    summaries[arm] = {
      raw: summarize(factResults, "rawVerdict", "disagreementRaw"),
      adjudicated: summarize(factResults, "verdict", "disagreement"),
    };
    allApplied.push(...applied);
    allUnmatched.push(...unmatched);
  }

  console.log("\n=== ADJUDICATED (headline) ===");
  for (const arm of ARMS) printSummary(arm, "adjudicated", summaries[arm].adjudicated);

  console.log("\n=== RAW KEYWORD (for transparency) ===");
  for (const arm of ARMS) printSummary(arm, "raw", summaries[arm].raw);

  if (allApplied.length > 0) {
    console.log("\nApplied adjudications:");
    for (const a of allApplied) {
      console.log(`  [${a.arm}] ${a.factId} trial ${a.trial}: ${a.rawVerdict} -> ${a.verdict} (${a.reason})`);
    }
  }
  if (allUnmatched.length > 0) {
    console.log("\nWARNING: adjudication entries that matched no recorded answer:");
    for (const u of allUnmatched) {
      console.log(`  [${u.arm}] ${u.factId} trial ${u.trial}`);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    perArm: results,
    summary: summaries,
    adjudications: {
      applied: allApplied,
      unmatched: allUnmatched,
    },
  };

  await ensureDir(stateRoot());
  const outPath = path.join(stateRoot(), "results.json");
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error("grade failed:", err && err.message ? err.message : err);
  process.exit(1);
});
