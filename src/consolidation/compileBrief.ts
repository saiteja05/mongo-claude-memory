import type { Db, Document } from "mongodb";
import { loadConfig } from "../config.js";
import { BELIEFS, BRIEFS } from "../db/schema.js";

const CHARS_PER_TOKEN = 4;

// Ranking weights for the brief compiler (DESIGN.md 8.1: "blend of importance,
// recency, and use_count"). Importance dominates since it is the
// consolidator's own quality judgment; recency and use_count are secondary
// signals that keep the brief fresh without letting a rarely-used but
// important belief get buried.
const WEIGHT_IMPORTANCE = 0.6;
const WEIGHT_RECENCY = 0.25;
const WEIGHT_USE_COUNT = 0.15;

// Diminishing returns past 10 uses: a belief used 50 times should not crowd
// out one used 10 times, so the use_count contribution is capped at 1.0.
const USE_COUNT_SATURATION = 10;

function scopeRank(scope: unknown): number {
  if (scope === "core") return 0;
  if (scope === "project") return 1;
  return 2; // archive or unknown scope should never reach an active-only query
}

function recencyScore(timestamp: unknown): number {
  if (!timestamp) return 0;
  const millis = new Date(timestamp as string | Date).getTime();
  if (!Number.isFinite(millis)) return 0;
  const daysSince = (Date.now() - millis) / (24 * 60 * 60 * 1000);
  if (daysSince < 0) return 1;
  return 1 / (1 + daysSince);
}

function useCountScore(useCount: unknown): number {
  const count = typeof useCount === "number" ? useCount : 0;
  return Math.min(1, count / USE_COUNT_SATURATION);
}

function rankScore(belief: Document): number {
  const importance = typeof belief.importance === "number" ? belief.importance : 0;
  // Recency is EVIDENCE recency (last_evidence_at, falling back to
  // updated_at), not last_used: last_used only moves on the rare occasions a
  // belief is surfaced by memory_search, so ranking on it left the freshness
  // signal effectively dead. Evidence recency moves whenever new supporting
  // observations arrive, which is the freshness that matters for a brief.
  return (
    importance * WEIGHT_IMPORTANCE +
    recencyScore(belief.last_evidence_at ?? belief.updated_at) * WEIGHT_RECENCY +
    useCountScore(belief.use_count) * WEIGHT_USE_COUNT
  );
}

function sortBeliefs(beliefs: Document[]): Document[] {
  return [...beliefs].sort((a, b) => {
    const scopeDiff = scopeRank(a.scope) - scopeRank(b.scope);
    if (scopeDiff !== 0) return scopeDiff;
    return rankScore(b) - rankScore(a);
  });
}

function beliefLine(belief: Document): string {
  const text = typeof belief.text === "string" ? belief.text.trim() : "";
  return text.endsWith(".") ? text : `${text}.`;
}

interface RenderResult {
  content: string;
  beliefIds: string[];
}

/**
 * Renders sorted beliefs into a token-capped prose brief. Stops including
 * beliefs (rather than truncating one mid-sentence) once the next line would
 * exceed the cap, and logs to stderr what was dropped instead of silently
 * truncating (DESIGN.md 8.1).
 */
function render(sorted: Document[], tokenCap: number, scopeKey: string): RenderResult {
  const maxChars = tokenCap * CHARS_PER_TOKEN;
  const lines: string[] = [];
  const beliefIds: string[] = [];
  let usedChars = 0;
  let droppedCount = 0;
  const droppedIds: string[] = [];

  for (const belief of sorted) {
    const line = beliefLine(belief);
    const additional = line.length + (lines.length > 0 ? 1 : 0); // + newline
    if (usedChars + additional > maxChars) {
      droppedCount++;
      droppedIds.push(String(belief._id));
      continue;
    }
    lines.push(line);
    beliefIds.push(String(belief._id));
    usedChars += additional;
  }

  if (droppedCount > 0) {
    console.error(
      `[compileBrief] scope="${scopeKey}": token cap (${tokenCap}) reached, dropped ${droppedCount} ` +
        `belief(s) rather than truncate: ${droppedIds.join(", ")}`
    );
  }

  return { content: lines.join("\n"), beliefIds };
}

/**
 * Recompiles and atomically swaps one brief (DESIGN.md 5.2 step 8, 7.4, 8.1).
 * scopeKey "global" compiles the core-scope tier into brief:global; any other
 * string compiles that project's project-scope tier only into brief:<project>.
 * Core beliefs are not duplicated into project briefs: fetchBrief.ts already
 * fetches brief:global and brief:<project> as a separate pair (mirroring the
 * SessionStart hook's global+project brief pair from Phase 1), so the core
 * tier is already covered once per session via brief:global.
 */
export async function compileBrief(db: Db, scopeKey: "global" | string): Promise<void> {
  const config = loadConfig();
  // Loosely typed (Document) rather than Belief/Brief here: the filter shape
  // differs between the global and project case, and the replacement doc
  // must omit _id (the driver's WithoutId<Brief> forbids it in the
  // replacement body even though it appears in the filter).
  const beliefsCollection = db.collection<Document>(BELIEFS);
  const briefsCollection = db.collection<Document>(BRIEFS);

  const isGlobal = scopeKey === "global";
  const briefId = isGlobal ? "brief:global" : `brief:${scopeKey}`;
  const briefProject = isGlobal ? "global" : scopeKey;
  const tokenCap = isGlobal ? config.briefCoreTokenCap : config.briefProjectTokenCap;

  // Core beliefs are already covered by the separate brief:global document
  // (fetchBrief.ts injects brief:global and brief:<project> as two distinct
  // documents), so the project-scope filter here must not also pull in
  // scope:"core" beliefs: doing so would duplicate every core fact inside
  // every project brief on top of the global brief, wasting the fixed token
  // budget the brief compiler is built to bound.
  const filter: Document = isGlobal
    ? { scope: "core", status: "active" }
    : { project: scopeKey, scope: "project", status: "active" };

  const beliefs = await beliefsCollection.find(filter).toArray();
  const sorted = sortBeliefs(beliefs);
  const { content, beliefIds } = render(sorted, tokenCap, scopeKey);

  const existing = await briefsCollection.findOne({ _id: briefId as never });
  const generation = ((existing?.generation as number | undefined) ?? 0) + 1;

  await briefsCollection.replaceOne(
    { _id: briefId as never },
    {
      project: briefProject,
      content,
      token_estimate: Math.ceil(content.length / CHARS_PER_TOKEN),
      belief_ids: beliefIds,
      generation,
      generated_at: new Date(),
    },
    { upsert: true }
  );
}
