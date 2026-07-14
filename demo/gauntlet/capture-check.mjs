#!/usr/bin/env node
// Measures CAPTURE RATE per arm: did the planted fact make it into durable
// memory at all? No LLM calls, no claude CLI invocations.
//
// control:       skipped entirely. It is never seeded (no hooks, no
//                CLAUDE.md/auto-memory, no MCP engine), so "was it captured"
//                is not a meaningful question for this arm.
// stock:         recursively grep every .md file under state/stock/config/ for
//                any expected_any keyword, case-insensitive (auto-memory's
//                MEMORY.md and topic files, wherever they land under the
//                config dir).
// engine:        search the gauntlet DB's beliefs collection (status active)
//                for any expected_any keyword, case-insensitive.
// engine-native: BOTH stores are active at once, so both are measured
//                separately: native (same markdown scan as stock, over this
//                arm's own config dir) and engine (same DB regex as engine,
//                against this arm's own database), plus a combined value
//                (captured in either store).
//
// Red-team finding: both arms used to silently report all-false capture on
// infrastructure errors (DB connect/query failure, missing config dir)
// instead of failing the run, and there was no adjudication overlay, so a
// known-wrong raw keyword figure shipped as the recorded number. This script
// now fails loudly on infra errors and supports an optional
// capture-adjudications.json overlay (see USAGE), following the same
// raw-plus-adjudicated pattern grade.mjs already uses for recall.

import path from "node:path";
import fs from "node:fs/promises";
import {
  ARMS,
  loadFacts,
  configDir,
  stateRoot,
  gauntletRoot,
  gauntletDbFor,
  walkFiles,
  containsAny,
  keywordRegexSource,
  mongoClient,
  ensureDir,
  readRunInfo,
} from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/capture-check.mjs [--help]

Checks, per fact, whether it was captured into durable memory in each arm:
  control:       skipped, never seeded, capture is undefined
  stock:         keyword grep over every .md file under state/stock/config/
  engine:        regex search over beliefs (status: active) in the engine arm's DB
  engine-native: both of the above, over the engine-native arm's own config dir
                 and database, plus a combined (captured-in-either) value

Any DB connect/query error, or a stock/engine-native markdown scan that finds
zero .md files after seeding, is treated as an infrastructure failure and
exits 1 rather than being silently recorded as false for every fact.

If demo/gauntlet/capture-adjudications.json exists (an array of
{arm, factId, captured, store, reason, author, timestamp}), each entry
overrides that specific (arm, factId[, store]) capture result after keyword
matching. store is "native", "engine", or null, and is only meaningful for
arm "engine-native" (its combined value is then recomputed from the
adjudicated native/engine booleans, not overridden directly). The overlay is
validated strictly before any DB access: unknown arm/factId, a missing or
empty reason/author, an invalid timestamp, or two entries targeting the same
(arm, factId, store) is a hard error naming the offending entry.

Requires state/run.json (written by setup.mjs) for run provenance. Writes
state/capture.json with both raw and adjudicated numbers and prints a
per-kind and overall capture rate table. Does not call the claude CLI.
Requires MDB_MCP_CONNECTION_STRING or MEMORY_MONGODB_URI for the engine and
engine-native checks; the stock and engine-native "native" checks are pure
local fs.
`;

// Arms for which "was this fact captured" is a meaningful question. control
// is deliberately excluded: it is never seeded, so it has no capture story.
const CAPTURE_ARMS = ARMS.filter((arm) => arm !== "control");
const VALID_STORES = new Set(["native", "engine", null]);

/** Case-insensitive keyword grep over every .md file under `dir`. Never throws on a missing dir (walkFiles tolerates it); the caller decides what zero files scanned means. */
async function checkMarkdownCapture(dir, facts) {
  const mdFiles = await walkFiles(dir, (f) => f.endsWith(".md"));
  const contents = [];
  for (const f of mdFiles) {
    try {
      contents.push(await fs.readFile(f, "utf8"));
    } catch {
      // unreadable file, skip
    }
  }
  const combined = contents.join("\n\n---\n\n");
  const results = {};
  for (const fact of facts) {
    results[fact.id] = containsAny(combined, fact.expected_any || []);
  }
  return { results, filesScanned: mdFiles.length };
}

/**
 * Regex search over active beliefs in `dbName` for each fact's expected_any
 * keywords. Any connect or query failure is a hard error naming `armLabel`,
 * never a silent all-false result (red-team finding).
 */
async function checkBeliefsCapture(dbName, facts, armLabel) {
  let client;
  let db;
  try {
    ({ client, db } = await mongoClient(dbName));
  } catch (err) {
    throw new Error(`${armLabel} arm: failed to connect to the gauntlet DB (${err && err.message ? err.message : err})`);
  }
  try {
    const beliefs = db.collection("beliefs");
    const results = {};
    for (const fact of facts) {
      const keywords = fact.expected_any || [];
      if (keywords.length === 0) {
        results[fact.id] = false;
        continue;
      }
      const pattern = keywords.map((k) => keywordRegexSource(k)).join("|");
      let hit;
      try {
        hit = await beliefs.findOne({
          status: "active",
          text: { $regex: pattern, $options: "i" },
        });
      } catch (err) {
        throw new Error(
          `${armLabel} arm: beliefs query failed for fact ${fact.id} (${err && err.message ? err.message : err})`
        );
      }
      results[fact.id] = !!hit;
    }
    return results;
  } finally {
    await client.close();
  }
}

async function loadCaptureAdjudications(factIds) {
  const p = path.join(gauntletRoot(), "capture-adjudications.json");
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
    throw new Error(`unparseable capture-adjudications.json: ${err && err.message ? err.message : err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("capture-adjudications.json must be a JSON array");
  }

  const seen = new Set();
  parsed.forEach((entry, i) => {
    const label = `capture-adjudications.json entry ${i} (${JSON.stringify(entry)})`;
    if (!entry || typeof entry !== "object") {
      throw new Error(`invalid ${label}: not an object`);
    }
    if (!CAPTURE_ARMS.includes(entry.arm)) {
      throw new Error(`invalid ${label}: unknown arm "${entry.arm}"`);
    }
    if (!factIds.has(entry.factId)) {
      throw new Error(`invalid ${label}: unknown factId "${entry.factId}"`);
    }
    if (typeof entry.captured !== "boolean") {
      throw new Error(`invalid ${label}: captured must be a boolean`);
    }
    const store = entry.store === undefined ? null : entry.store;
    if (!VALID_STORES.has(store)) {
      throw new Error(`invalid ${label}: store must be "native", "engine", or null`);
    }
    if (entry.arm === "engine-native" && store === null) {
      throw new Error(`invalid ${label}: engine-native entries must set store to "native" or "engine"`);
    }
    if (entry.arm !== "engine-native" && store !== null) {
      throw new Error(`invalid ${label}: store is only meaningful for arm "engine-native"`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`invalid ${label}: reason must be a non-empty string`);
    }
    if (typeof entry.author !== "string" || entry.author.trim().length === 0) {
      throw new Error(`invalid ${label}: author must be a non-empty string`);
    }
    if (typeof entry.timestamp !== "string" || Number.isNaN(Date.parse(entry.timestamp))) {
      throw new Error(`invalid ${label}: timestamp must be a valid ISO date string`);
    }
    const key = `${entry.arm}|${entry.factId}|${store}`;
    if (seen.has(key)) {
      throw new Error(`invalid ${label}: duplicate adjudication for arm "${entry.arm}" factId "${entry.factId}" store "${store}"`);
    }
    seen.add(key);
  });

  return parsed;
}

/** Applies any matching (arm, store) overrides on top of a raw capture map, returning the adjudicated map and appending applied entries to `appliedOut`. */
function applyAdjudications(arm, store, rawResults, adjudications, appliedOut) {
  const adjusted = { ...rawResults };
  for (const entry of adjudications) {
    if (entry.arm !== arm) continue;
    const entryStore = entry.store === undefined ? null : entry.store;
    if (entryStore !== store) continue;
    const rawValue = !!rawResults[entry.factId];
    adjusted[entry.factId] = entry.captured;
    appliedOut.push({
      arm,
      store,
      factId: entry.factId,
      raw: rawValue,
      adjudicated: entry.captured,
      reason: entry.reason,
      author: entry.author,
      timestamp: entry.timestamp,
    });
  }
  return adjusted;
}

function rateByKind(facts, resultsFor) {
  const kinds = {};
  for (const fact of facts) {
    const k = fact.kind;
    kinds[k] = kinds[k] || { total: 0, hit: 0 };
    kinds[k].total++;
    if (resultsFor(fact)) kinds[k].hit++;
  }
  const out = {};
  for (const [k, v] of Object.entries(kinds)) {
    out[k] = { total: v.total, hit: v.hit, rate: v.total ? v.hit / v.total : 0 };
  }
  return out;
}

function overallRate(facts, resultsFor) {
  const total = facts.length;
  const hit = facts.filter(resultsFor).length;
  return { total, hit, rate: total ? hit / total : 0 };
}

function summarize(facts, resultsFor) {
  return { byKind: rateByKind(facts, resultsFor), overall: overallRate(facts, resultsFor) };
}

function printTable(title, summary) {
  console.log(`\n${title}`);
  for (const [kind, v] of Object.entries(summary.byKind)) {
    console.log(`  ${kind.padEnd(14)} ${v.hit}/${v.total}  (${(v.rate * 100).toFixed(0)}%)`);
  }
  const o = summary.overall;
  console.log(`  ${"overall".padEnd(14)} ${o.hit}/${o.total}  (${(o.rate * 100).toFixed(0)}%)`);
}

function printEngineNativeTable(title, native, engine, combined) {
  console.log(`\n${title}`);
  const kinds = new Set([
    ...Object.keys(native.byKind),
    ...Object.keys(engine.byKind),
    ...Object.keys(combined.byKind),
  ]);
  const fmt = (v) => `${v.hit}/${v.total} (${(v.rate * 100).toFixed(0)}%)`;
  for (const kind of kinds) {
    console.log(
      `  ${kind.padEnd(14)} native ${fmt(native.byKind[kind])}   engine ${fmt(engine.byKind[kind])}   combined ${fmt(combined.byKind[kind])}`
    );
  }
  console.log(
    `  ${"overall".padEnd(14)} native ${fmt(native.overall)}   engine ${fmt(engine.overall)}   combined ${fmt(combined.overall)}`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  // Provenance first: every downstream number in capture.json is stamped with
  // the run this data came from.
  const runInfo = readRunInfo();
  console.log(`Run id: ${runInfo.runId}`);

  const { facts } = loadFacts();
  const factIds = new Set(facts.map((f) => f.id));

  // Adjudication overlay is loaded and strictly validated before any DB
  // access or filesystem scanning below, so a bad overlay fails the run
  // immediately instead of silently applying to whatever the checks produce.
  const adjudications = await loadCaptureAdjudications(factIds);
  if (adjudications.length > 0) {
    console.log(`Loaded ${adjudications.length} capture adjudication(s) from capture-adjudications.json`);
  }

  console.log("[control] skipped: never seeded, capture is undefined for the memoryless control arm.");

  const allApplied = [];

  // --- stock: native auto-memory only ---
  console.log("Checking stock arm capture (local .md files)...");
  const stockCfg = configDir("stock");
  const stockScan = await checkMarkdownCapture(stockCfg, facts);
  if (stockScan.filesScanned === 0) {
    // Red-team finding: this used to fall through and silently record every
    // fact as not captured, indistinguishable from a real all-miss result.
    // Zero markdown files after seeding means the harness never ran (or the
    // config dir is wrong), not a real capture result, so fail the run.
    throw new Error(
      `stock arm: found 0 markdown files under ${stockCfg} after seeding; treating this as an infrastructure failure, not a real all-miss capture result. Run setup.mjs and seed.mjs for this arm first.`
    );
  }
  console.log(`  scanned ${stockScan.filesScanned} markdown file(s) under state/stock/config/`);
  const stockApplied = [];
  const stockAdjResults = applyAdjudications("stock", null, stockScan.results, adjudications, stockApplied);
  allApplied.push(...stockApplied);
  const stockRawSummary = summarize(facts, (f) => stockScan.results[f.id]);
  const stockAdjSummary = summarize(facts, (f) => stockAdjResults[f.id]);

  // --- engine: MongoDB engine only ---
  console.log("Checking engine arm capture (gauntlet DB beliefs)...");
  const engineRaw = await checkBeliefsCapture(gauntletDbFor("engine"), facts, "engine");
  const engineApplied = [];
  const engineAdjResults = applyAdjudications("engine", null, engineRaw, adjudications, engineApplied);
  allApplied.push(...engineApplied);
  const engineRawSummary = summarize(facts, (f) => engineRaw[f.id]);
  const engineAdjSummary = summarize(facts, (f) => engineAdjResults[f.id]);

  // --- engine-native: both stores measured separately, plus combined ---
  console.log("Checking engine-native arm capture (native .md files AND gauntlet DB beliefs)...");
  const engineNativeCfg = configDir("engine-native");
  const nativeScan = await checkMarkdownCapture(engineNativeCfg, facts);
  if (nativeScan.filesScanned === 0) {
    // Same red-team finding as the stock check above: zero files is an
    // infrastructure failure, not a genuine all-miss for the native store.
    throw new Error(
      `engine-native arm: found 0 markdown files under ${engineNativeCfg} after seeding; treating this as an infrastructure failure, not a real all-miss capture result. Run setup.mjs and seed.mjs for this arm first.`
    );
  }
  console.log(`  scanned ${nativeScan.filesScanned} markdown file(s) under state/engine-native/config/ (native store)`);
  const engineNativeEngineRaw = await checkBeliefsCapture(gauntletDbFor("engine-native"), facts, "engine-native");

  const nativeApplied = [];
  const nativeAdjResults = applyAdjudications("engine-native", "native", nativeScan.results, adjudications, nativeApplied);
  allApplied.push(...nativeApplied);
  const engineStoreApplied = [];
  const engineStoreAdjResults = applyAdjudications(
    "engine-native",
    "engine",
    engineNativeEngineRaw,
    adjudications,
    engineStoreApplied
  );
  allApplied.push(...engineStoreApplied);

  // combined is captured-in-either-store, derived from the (possibly
  // adjudicated) per-store booleans, not overridden directly.
  const combinedRaw = {};
  const combinedAdj = {};
  for (const fact of facts) {
    combinedRaw[fact.id] = !!nativeScan.results[fact.id] || !!engineNativeEngineRaw[fact.id];
    combinedAdj[fact.id] = !!nativeAdjResults[fact.id] || !!engineStoreAdjResults[fact.id];
  }

  const nativeRawSummary = summarize(facts, (f) => nativeScan.results[f.id]);
  const nativeAdjSummary = summarize(facts, (f) => nativeAdjResults[f.id]);
  const engineStoreRawSummary = summarize(facts, (f) => engineNativeEngineRaw[f.id]);
  const engineStoreAdjSummary = summarize(facts, (f) => engineStoreAdjResults[f.id]);
  const combinedRawSummary = summarize(facts, (f) => combinedRaw[f.id]);
  const combinedAdjSummary = summarize(facts, (f) => combinedAdj[f.id]);

  console.log("\n=== RAW KEYWORD (for transparency) ===");
  printTable("Stock capture rate by kind (raw):", stockRawSummary);
  printTable("Engine capture rate by kind (raw):", engineRawSummary);
  printEngineNativeTable("Engine-native capture rate by kind (raw):", nativeRawSummary, engineStoreRawSummary, combinedRawSummary);

  console.log("\n=== ADJUDICATED (headline) ===");
  printTable("Stock capture rate by kind (adjudicated):", stockAdjSummary);
  printTable("Engine capture rate by kind (adjudicated):", engineAdjSummary);
  printEngineNativeTable("Engine-native capture rate by kind (adjudicated):", nativeAdjSummary, engineStoreAdjSummary, combinedAdjSummary);

  if (allApplied.length > 0) {
    console.log("\nApplied capture adjudications:");
    for (const a of allApplied) {
      const storeLabel = a.store ? `/${a.store}` : "";
      console.log(`  [${a.arm}${storeLabel}] ${a.factId}: ${a.raw} -> ${a.adjudicated} (${a.reason})`);
    }
  }

  const perFact = facts.map((f) => ({
    factId: f.id,
    kind: f.kind,
    stock: { raw: !!stockScan.results[f.id], adjudicated: !!stockAdjResults[f.id] },
    engine: { raw: !!engineRaw[f.id], adjudicated: !!engineAdjResults[f.id] },
    engineNative: {
      native: { raw: !!nativeScan.results[f.id], adjudicated: !!nativeAdjResults[f.id] },
      engine: { raw: !!engineNativeEngineRaw[f.id], adjudicated: !!engineStoreAdjResults[f.id] },
      combined: { raw: !!combinedRaw[f.id], adjudicated: !!combinedAdj[f.id] },
    },
  }));

  const output = {
    runId: runInfo.runId,
    generatedAt: new Date().toISOString(),
    arms: {
      control: { skipped: true, reason: "never seeded, capture is undefined" },
      stock: { storesChecked: ["native"] },
      engine: { storesChecked: ["engine"] },
      "engine-native": { storesChecked: ["native", "engine"] },
    },
    facts: perFact,
    ratesByKind: {
      stock: { raw: stockRawSummary.byKind, adjudicated: stockAdjSummary.byKind },
      engine: { raw: engineRawSummary.byKind, adjudicated: engineAdjSummary.byKind },
      "engine-native": {
        native: { raw: nativeRawSummary.byKind, adjudicated: nativeAdjSummary.byKind },
        engine: { raw: engineStoreRawSummary.byKind, adjudicated: engineStoreAdjSummary.byKind },
        combined: { raw: combinedRawSummary.byKind, adjudicated: combinedAdjSummary.byKind },
      },
    },
    overall: {
      stock: { raw: stockRawSummary.overall, adjudicated: stockAdjSummary.overall },
      engine: { raw: engineRawSummary.overall, adjudicated: engineAdjSummary.overall },
      "engine-native": {
        native: { raw: nativeRawSummary.overall, adjudicated: nativeAdjSummary.overall },
        engine: { raw: engineStoreRawSummary.overall, adjudicated: engineStoreAdjSummary.overall },
        combined: { raw: combinedRawSummary.overall, adjudicated: combinedAdjSummary.overall },
      },
    },
    adjudications: { applied: allApplied },
  };

  await ensureDir(stateRoot());
  const outPath = path.join(stateRoot(), "capture.json");
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error("capture-check failed:", err && err.message ? err.message : err);
  process.exit(1);
});
