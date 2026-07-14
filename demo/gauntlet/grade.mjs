#!/usr/bin/env node
// Grades recall answers against facts.json using word-boundary keyword
// matching, per arm, then applies an optional manual adjudication overlay
// (adjudications.json) so human-audited corrections are reproducible. Both
// raw keyword numbers and adjudicated numbers are reported; adjudicated is
// the headline, but raw is always printed alongside, never hidden.

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import {
  ARMS,
  loadFacts,
  armDir,
  stateRoot,
  gauntletRoot,
  readJsonl,
  containsAny,
  ensureDir,
  readRunInfo,
} from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/grade.mjs [--help]

Reads state/<arm>/answers.jsonl for every arm in lib.ARMS that has one
(control included: its scores are the guessability baseline, i.e. what a
memoryless model gets right anyway) plus facts.json. Per answer:
  correct: contains any expected_any keyword (word-boundary match, case-insensitive)
  stale:   contains no expected_any keyword, but does contain a wrong_any keyword
  miss:    neither
  staleEcho: an expected AND a wrong keyword both matched (verdict stays "correct",
             but this is a diagnostic flag: the model recalled the right answer
             alongside the superseded one)

Hard errors (exit 1) before any grading happens:
  - two or more answers.jsonl records for the same (factId, trial): silent
    append inflation
  - answers.jsonl mixes more than one runId, or its runId does not match
    state/run.json: a stale answers file cannot be graded against a
    different run's provenance
  - an adjudications.json entry with an unknown arm/factId/verdict, a
    non-integer trial, an empty/missing reason or author, an unparseable
    timestamp, a missing answerSha256, a second entry for the same
    (arm, factId, trial) (no first-match-wins), an entry targeting a trial
    with no recorded answer, or an answerSha256 that does not match the
    sha256 of the recorded answer text (the hash binding that stops a stale
    overlay from a previous run silently applying to a different answer)

Writes state/results.json, stamped with the run id, containing per-arm
per-trial verdicts (raw and adjudicated), recall rates overall and by kind
for both gradings with a Wilson 95% confidence interval, trial disagreement,
stale-echo and timed-out counts, and the list of applied adjudications.
Prints both raw and adjudicated tables for every graded arm. Does not call
the claude CLI.
`;

const VALID_VERDICTS = new Set(["correct", "stale", "miss"]);
const Z_95 = 1.959963984540054;

function gradeAnswer(fact, answerText) {
  const expected = fact.expected_any || [];
  const wrong = fact.wrong_any || [];
  const hasExpected = containsAny(answerText, expected);
  const hasWrong = containsAny(answerText, wrong);
  if (hasExpected) return { verdict: "correct", staleEcho: hasWrong };
  if (hasWrong) return { verdict: "stale", staleEcho: false };
  return { verdict: "miss", staleEcho: false };
}

/** Wilson score interval for a 95% confidence bound on correct/total. */
function wilson(correct, total) {
  if (total === 0) return { low: 0, high: 0 };
  const phat = correct / total;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / total;
  const center = phat + z2 / (2 * total);
  const margin = Z_95 * Math.sqrt((phat * (1 - phat)) / total + z2 / (4 * total * total));
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads and validates one arm's answers.jsonl, or returns null if the file
 * does not exist (that arm was never recalled, and is skipped rather than
 * graded as all-miss). Hard errors on duplicate (factId, trial) records and
 * on provenance mismatch: every record in one file must share one runId, and
 * it must equal state/run.json's runId.
 */
async function loadArmAnswers(arm, runInfo) {
  const answersPath = path.join(armDir(arm), "answers.jsonl");
  if (!(await fileExists(answersPath))) return null;

  const records = await readJsonl(answersPath);

  const counts = new Map();
  for (const r of records) {
    const key = `${r.factId} trial ${r.trial}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const dupKeys = [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
  if (dupKeys.length > 0) {
    throw new Error(
      `${arm}: answers.jsonl has more than one record for the same (factId, trial): ${dupKeys.join(", ")}. ` +
        "This is the silent append-inflation the red-team flagged; fix the file (or reset.mjs and re-run recall) before grading."
    );
  }

  const runIds = new Set(records.map((r) => r.runId));
  if (runIds.size > 1) {
    throw new Error(
      `${arm}: answers.jsonl mixes multiple runIds (${[...runIds].join(", ")}); every record in one file must come from one run.`
    );
  }
  if (records.length > 0) {
    const [fileRunId] = runIds;
    if (fileRunId !== runInfo.runId) {
      throw new Error(
        `${arm}: answers.jsonl runId "${fileRunId}" does not match state/run.json runId "${runInfo.runId}". ` +
          "A stale answers file from a previous run cannot be graded against the current run's provenance."
      );
    }
  }

  return records;
}

/**
 * Loads and strictly validates adjudications.json against facts.json and the
 * answers actually on disk (answerLookup, keyed by "arm:factId:trial"). Any
 * invalid entry is a hard error naming the offending entry, never a silent
 * skip or a first-match-wins pick between conflicting entries.
 */
async function loadAdjudications(facts, answerLookup) {
  const p = path.join(gauntletRoot(), "adjudications.json");
  let raw;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`unparseable adjudications.json: ${err && err.message ? err.message : err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("adjudications.json must be a JSON array");
  }

  const factIds = new Set(facts.map((f) => f.id));
  const seenCoord = new Set();

  parsed.forEach((entry, i) => {
    const label = `adjudications.json entry ${i} (${JSON.stringify({
      arm: entry && entry.arm,
      factId: entry && entry.factId,
      trial: entry && entry.trial,
    })})`;

    if (!entry || typeof entry !== "object") {
      throw new Error(`invalid ${label}: not an object`);
    }
    if (!ARMS.includes(entry.arm)) {
      throw new Error(`invalid ${label}: unknown arm "${entry.arm}"`);
    }
    if (!factIds.has(entry.factId)) {
      throw new Error(`invalid ${label}: unknown factId "${entry.factId}"`);
    }
    if (!VALID_VERDICTS.has(entry.verdict)) {
      throw new Error(`invalid ${label}: unknown verdict "${entry.verdict}"`);
    }
    if (!Number.isInteger(entry.trial)) {
      throw new Error(`invalid ${label}: trial must be an integer`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`invalid ${label}: reason must be a non-empty string`);
    }
    if (typeof entry.author !== "string" || entry.author.trim().length === 0) {
      throw new Error(`invalid ${label}: author must be a non-empty string`);
    }
    if (typeof entry.timestamp !== "string" || Number.isNaN(Date.parse(entry.timestamp))) {
      throw new Error(`invalid ${label}: timestamp must be a parseable date string`);
    }
    if (typeof entry.answerSha256 !== "string" || entry.answerSha256.trim().length === 0) {
      throw new Error(`invalid ${label}: answerSha256 is missing`);
    }

    const coord = `${entry.arm}|${entry.factId}|${entry.trial}`;
    if (seenCoord.has(coord)) {
      throw new Error(
        `invalid ${label}: a second adjudication entry targets the same (arm, factId, trial) as an earlier entry. ` +
          "No first-match-wins: remove or merge the duplicate."
      );
    }
    seenCoord.add(coord);

    const answerRecord = answerLookup.get(`${entry.arm}:${entry.factId}:${entry.trial}`);
    if (!answerRecord) {
      throw new Error(
        `invalid ${label}: targets ${entry.arm}/${entry.factId} trial ${entry.trial}, which has no recorded answer.`
      );
    }

    const expectedHash = sha256Hex(answerRecord.answer || "");
    if (String(entry.answerSha256).toLowerCase() !== expectedHash) {
      throw new Error(
        `invalid ${label}: answerSha256 does not match the sha256 of the recorded answer text (expected ${expectedHash}). ` +
          "This hash binding is what stops a stale overlay from a previous run silently applying to a different answer; " +
          "regenerate the entry from the current answer."
      );
    }
  });

  return parsed;
}

/** Grades one arm's answers into flat trial records, applying any matching adjudication overrides. */
function gradeArm(arm, facts, answers, adjudications) {
  const factsById = new Map(facts.map((f) => [f.id, f]));
  const armAdjudications = adjudications.filter((e) => e.arm === arm);
  const overrideByKey = new Map(armAdjudications.map((e) => [`${e.factId}:${e.trial}`, e]));

  const trialRecords = [];
  const applied = [];

  for (const a of answers) {
    const fact = factsById.get(a.factId);
    if (!fact) {
      throw new Error(`${arm}: answers.jsonl references unknown factId "${a.factId}" (not present in facts.json)`);
    }

    const { verdict: rawVerdict, staleEcho } = gradeAnswer(fact, a.answer || "");
    const override = overrideByKey.get(`${a.factId}:${a.trial}`);

    let verdict = rawVerdict;
    let adjudicated = false;
    let adjudicationReason = null;
    if (override) {
      verdict = override.verdict;
      adjudicated = true;
      adjudicationReason = override.reason;
      applied.push({
        arm,
        factId: a.factId,
        trial: a.trial,
        rawVerdict,
        verdict: override.verdict,
        reason: override.reason,
        author: override.author,
        timestamp: override.timestamp,
      });
    }

    trialRecords.push({
      factId: a.factId,
      trial: a.trial,
      kind: fact.kind,
      rawVerdict,
      verdict,
      staleEcho,
      timedOut: !!a.timedOut,
      durationMs: a.durationMs,
      adjudicated,
      adjudicationReason,
    });
  }

  trialRecords.sort((x, y) => (x.factId === y.factId ? x.trial - y.trial : x.factId.localeCompare(y.factId)));

  return { trialRecords, applied };
}

/** Aggregates a flat trial-record array into totals, a Wilson CI, and per-kind and per-fact disagreement breakdowns, for one grading (rawVerdict or verdict). */
function summarize(trialRecords, verdictField) {
  let correct = 0;
  let stale = 0;
  let miss = 0;
  const byKind = {};
  const verdictsByFact = new Map();

  for (const t of trialRecords) {
    byKind[t.kind] = byKind[t.kind] || { correct: 0, total: 0 };
    byKind[t.kind].total++;

    const v = t[verdictField];
    if (v === "correct") {
      correct++;
      byKind[t.kind].correct++;
    } else if (v === "stale") {
      stale++;
    } else {
      miss++;
    }

    if (!verdictsByFact.has(t.factId)) verdictsByFact.set(t.factId, new Set());
    verdictsByFact.get(t.factId).add(v);
  }

  const byKindRates = {};
  for (const [k, v] of Object.entries(byKind)) {
    byKindRates[k] = { correct: v.correct, total: v.total, rate: v.total ? v.correct / v.total : 0 };
  }

  const disagreementFacts = [...verdictsByFact.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([factId]) => factId);

  const totalTrials = trialRecords.length;
  return {
    totalTrials,
    correct,
    stale,
    miss,
    recallRate: totalTrials ? correct / totalTrials : 0,
    ci: wilson(correct, totalTrials),
    byKind: byKindRates,
    disagreementCount: disagreementFacts.length,
    disagreementFacts,
  };
}

function extraCounts(trialRecords) {
  return {
    staleEchoCount: trialRecords.filter((t) => t.staleEcho).length,
    timedOutCount: trialRecords.filter((t) => t.timedOut).length,
  };
}

function fmtPct(rate) {
  return `${(rate * 100).toFixed(0)}%`;
}

function fmtCi(ci) {
  return `${(ci.low * 100).toFixed(0)}-${(ci.high * 100).toFixed(0)}%`;
}

function printSummary(arm, label, summary) {
  console.log(
    `\n[${arm}] ${label} recall rate: ${summary.correct}/${summary.totalTrials} (${fmtPct(summary.recallRate)}, 95% CI ${fmtCi(summary.ci)})`
  );
  console.log(`[${arm}] ${label} stale recalls: ${summary.stale}, misses: ${summary.miss}`);
  console.log(
    `[${arm}] ${label} trial disagreement on ${summary.disagreementCount} fact(s): ${summary.disagreementFacts.join(", ") || "none"}`
  );
  console.log(`[${arm}] ${label} recall rate by kind:`);
  for (const [kind, v] of Object.entries(summary.byKind)) {
    console.log(`    ${kind.padEnd(14)} ${v.correct}/${v.total}  (${fmtPct(v.rate)})`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const runInfo = readRunInfo();
  const { facts } = loadFacts();

  const armsAnswers = {};
  for (const arm of ARMS) {
    armsAnswers[arm] = await loadArmAnswers(arm, runInfo);
  }
  const gradableArms = ARMS.filter((arm) => armsAnswers[arm] !== null);
  const skippedArms = ARMS.filter((arm) => armsAnswers[arm] === null);
  if (skippedArms.length > 0) {
    console.log(`Skipping arm(s) with no answers.jsonl yet: ${skippedArms.join(", ")}`);
  }

  const answerLookup = new Map();
  for (const arm of gradableArms) {
    for (const a of armsAnswers[arm]) {
      answerLookup.set(`${arm}:${a.factId}:${a.trial}`, a);
    }
  }

  const adjudications = await loadAdjudications(facts, answerLookup);
  if (adjudications.length > 0) {
    console.log(`Loaded ${adjudications.length} adjudication(s) from adjudications.json`);
  }

  const perArm = {};
  const summaries = {};
  const allApplied = [];

  for (const arm of gradableArms) {
    const { trialRecords, applied } = gradeArm(arm, facts, armsAnswers[arm], adjudications);
    perArm[arm] = trialRecords;
    const extras = extraCounts(trialRecords);
    summaries[arm] = {
      raw: summarize(trialRecords, "rawVerdict"),
      adjudicated: summarize(trialRecords, "verdict"),
      staleEchoCount: extras.staleEchoCount,
      timedOutCount: extras.timedOutCount,
    };
    allApplied.push(...applied);
  }

  console.log("\n=== ADJUDICATED (headline) ===");
  for (const arm of gradableArms) printSummary(arm, "adjudicated", summaries[arm].adjudicated);

  console.log("\n=== RAW KEYWORD (for transparency) ===");
  for (const arm of gradableArms) printSummary(arm, "raw", summaries[arm].raw);

  console.log("\n=== Answer quality signals ===");
  for (const arm of gradableArms) {
    console.log(`[${arm}] stale-echo (expected and wrong keyword both matched): ${summaries[arm].staleEchoCount}, timed out: ${summaries[arm].timedOutCount}`);
  }

  if (allApplied.length > 0) {
    console.log("\nApplied adjudications:");
    for (const a of allApplied) {
      console.log(`  [${a.arm}] ${a.factId} trial ${a.trial}: ${a.rawVerdict} -> ${a.verdict} (${a.reason})`);
    }
  }

  const output = {
    runId: runInfo.runId,
    generatedAt: new Date().toISOString(),
    perArm,
    summary: summaries,
    adjudications: { applied: allApplied },
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
