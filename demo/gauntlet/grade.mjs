#!/usr/bin/env node
// Grades recall answers against facts.json using keyword matching, per arm.

import path from "node:path";
import fs from "node:fs/promises";
import { ARMS, loadFacts, armDir, stateRoot, readJsonl, containsAny, ensureDir } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/grade.mjs [--help]

Reads state/<arm>/answers.jsonl for both arms plus facts.json. Per answer:
  correct: contains any expected_any keyword (case-insensitive)
  stale:   contains no expected_any keyword, but does contain a wrong_any keyword
  miss:    neither

Writes state/results.json with per-arm per-fact per-trial verdicts, recall
rate overall and by kind, trial disagreement ("variance"), and stale-recall
counts. Prints a summary table. Does not call the claude CLI.
`;

function gradeAnswer(fact, answerText) {
  const expected = fact.expected_any || [];
  const wrong = fact.wrong_any || [];
  if (containsAny(answerText, expected)) return "correct";
  if (containsAny(answerText, wrong)) return "stale";
  return "miss";
}

async function gradeArm(arm, facts) {
  const answersPath = path.join(armDir(arm), "answers.jsonl");
  const answers = await readJsonl(answersPath);
  const byFact = {};
  for (const a of answers) {
    byFact[a.factId] = byFact[a.factId] || [];
    byFact[a.factId].push(a);
  }

  const factResults = [];
  for (const fact of facts) {
    const trials = (byFact[fact.id] || []).sort((a, b) => a.trial - b.trial);
    const verdicts = trials.map((t) => ({
      trial: t.trial,
      verdict: gradeAnswer(fact, t.answer || ""),
      durationMs: t.durationMs,
    }));
    const distinctVerdicts = new Set(verdicts.map((v) => v.verdict));
    factResults.push({
      factId: fact.id,
      kind: fact.kind,
      trials: verdicts,
      disagreement: distinctVerdicts.size > 1,
    });
  }
  return factResults;
}

function summarize(factResults) {
  let correct = 0;
  let stale = 0;
  let miss = 0;
  let totalTrials = 0;
  const byKind = {};
  let disagreementCount = 0;

  for (const fr of factResults) {
    byKind[fr.kind] = byKind[fr.kind] || { correct: 0, total: 0 };
    if (fr.disagreement) disagreementCount++;
    for (const t of fr.trials) {
      totalTrials++;
      byKind[fr.kind].total++;
      if (t.verdict === "correct") {
        correct++;
        byKind[fr.kind].correct++;
      } else if (t.verdict === "stale") {
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
    disagreementFacts: factResults.filter((f) => f.disagreement).map((f) => f.factId),
  };
}

function printSummary(arm, summary) {
  console.log(`\n[${arm}] recall rate: ${summary.correct}/${summary.totalTrials} (${(summary.recallRate * 100).toFixed(0)}%)`);
  console.log(`[${arm}] stale recalls: ${summary.stale}, misses: ${summary.miss}`);
  console.log(`[${arm}] trial disagreement on ${summary.disagreementCount} fact(s): ${summary.disagreementFacts.join(", ") || "none"}`);
  console.log(`[${arm}] recall rate by kind:`);
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
  const results = {};
  const summaries = {};

  for (const arm of ARMS) {
    const factResults = await gradeArm(arm, facts);
    results[arm] = factResults;
    summaries[arm] = summarize(factResults);
    printSummary(arm, summaries[arm]);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    perArm: results,
    summary: summaries,
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
