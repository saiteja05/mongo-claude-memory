#!/usr/bin/env node
// Measures CAPTURE RATE per arm: did the planted fact make it into durable
// memory at all? No LLM calls, no claude CLI invocations.
//
// engine: search the gauntlet DB's beliefs collection (status active) for any
//         expected_any keyword, case-insensitive.
// stock:  recursively grep every .md file under state/stock/config/ for any
//         expected_any keyword, case-insensitive (auto-memory's MEMORY.md and
//         topic files, wherever they land under the config dir).

import path from "node:path";
import fs from "node:fs/promises";
import { loadFacts, configDir, stateRoot, walkFiles, containsAny, mongoClient, ensureDir } from "./lib.mjs";

const USAGE = `Usage: node demo/gauntlet/capture-check.mjs [--help]

Checks, per fact, whether it was captured into durable memory in each arm:
  engine: regex search over beliefs (status: active) in the gauntlet DB
  stock:  keyword grep over every .md file under state/stock/config/

Writes state/capture.json and prints a per-kind and overall capture rate table.
Does not call the claude CLI. Requires MDB_MCP_CONNECTION_STRING or
MEMORY_MONGODB_URI for the engine check; the stock check is pure local fs.
`;

async function checkEngineCapture(facts) {
  const { client, db } = await mongoClient();
  try {
    const beliefs = db.collection("beliefs");
    const results = {};
    for (const fact of facts) {
      const keywords = fact.expected_any || [];
      if (keywords.length === 0) {
        results[fact.id] = false;
        continue;
      }
      const pattern = keywords.map((k) => escapeRegex(k)).join("|");
      const hit = await beliefs.findOne({
        status: "active",
        text: { $regex: pattern, $options: "i" },
      });
      results[fact.id] = !!hit;
    }
    return results;
  } finally {
    await client.close();
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function checkStockCapture(facts) {
  const cfg = configDir("stock");
  const mdFiles = await walkFiles(cfg, (f) => f.endsWith(".md"));
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

function printTable(title, byKind, overall) {
  console.log(`\n${title}`);
  for (const [kind, v] of Object.entries(byKind)) {
    console.log(`  ${kind.padEnd(14)} ${v.hit}/${v.total}  (${(v.rate * 100).toFixed(0)}%)`);
  }
  console.log(`  ${"overall".padEnd(14)} ${overall.hit}/${overall.total}  (${(overall.rate * 100).toFixed(0)}%)`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const { facts } = loadFacts();

  console.log("Checking stock arm capture (local .md files)...");
  const stock = await checkStockCapture(facts);
  console.log(`  scanned ${stock.filesScanned} markdown file(s) under state/stock/config/`);

  console.log("Checking engine arm capture (gauntlet DB beliefs)...");
  let engineResults;
  try {
    engineResults = await checkEngineCapture(facts);
  } catch (err) {
    console.error(`  engine capture check failed: ${err && err.message ? err.message : err}`);
    engineResults = {};
    for (const f of facts) engineResults[f.id] = false;
  }

  const perFact = facts.map((f) => ({
    factId: f.id,
    kind: f.kind,
    stock: !!stock.results[f.id],
    engine: !!engineResults[f.id],
  }));

  const stockByKind = rateByKind(facts, (f) => stock.results[f.id]);
  const engineByKind = rateByKind(facts, (f) => engineResults[f.id]);
  const stockOverall = {
    total: facts.length,
    hit: perFact.filter((f) => f.stock).length,
  };
  stockOverall.rate = stockOverall.hit / stockOverall.total;
  const engineOverall = {
    total: facts.length,
    hit: perFact.filter((f) => f.engine).length,
  };
  engineOverall.rate = engineOverall.hit / engineOverall.total;

  printTable("Stock capture rate by kind:", stockByKind, stockOverall);
  printTable("Engine capture rate by kind:", engineByKind, engineOverall);

  const output = {
    generatedAt: new Date().toISOString(),
    facts: perFact,
    ratesByKind: { stock: stockByKind, engine: engineByKind },
    overall: { stock: stockOverall, engine: engineOverall },
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
