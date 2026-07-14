import { ObjectId } from "mongodb";
import type { Db, Document } from "mongodb";
import { BELIEFS } from "../db/schema.js";
import type { BeliefScope } from "../db/schema.js";
import { findSimilarBeliefs } from "./upsertBelief.js";
import type { SimilarBelief } from "./upsertBelief.js";
import { RECONCILE_TOP_K, reconcileCandidate } from "./reconcileBelief.js";

// Bounds the active-beliefs fetch for one project's sweep: same rationale as
// compileBrief's MAX_BELIEFS_PER_COMPILE, keeps an operator sweep on a busy
// project from pulling an unbounded number of documents into memory and
// probing every one of them.
const MAX_BELIEFS_PER_SWEEP = 1000;

export interface ReconcileSweepDeps {
  threshold: number;
  maxPairs: number;
  embeddingMode: "appside" | "auto";
  model: string;
  reconcile: typeof reconcileCandidate;
  compileBrief: (db: Db, scopeKey: string) => Promise<void>;
}

export interface ReconcileSweepReport {
  beliefsScanned: number;
  pairsFound: number;
  pairsArbitrated: number;
  archivedSupersedes: string[];
  archivedDuplicates: string[];
  skippedCap: number;
  skippedContention: number;
  skippedErrors: number;
  recompiledScopes: string[];
}

interface SweepBelief {
  _id: unknown;
  text: string;
  scope: BeliefScope;
  embedding?: number[];
  version: number;
  last_evidence_at?: Date;
  updated_at?: Date;
  supersedes?: string | null;
  observation_ids?: string[];
}

// Belief _ids are normally real ObjectIds. Falls back to the raw string when
// it is not a valid ObjectId, matching the same convention already used by
// upsertBelief.ts's toFilterId and rollback.ts's toFilterId, so this stays
// testable without a live MongoDB.
function toFilterId(id: string): ObjectId | string {
  try {
    return new ObjectId(id);
  } catch {
    return id;
  }
}

// Evidence recency, with the same epoch-0 fallback convention as
// upsertBelief.ts's mergeIntoActiveBelief: a belief missing both
// last_evidence_at and updated_at (should not happen on a real document, but
// keeps this defensive against loosely-typed test fixtures) sorts as the
// oldest possible.
function evidenceTime(belief: SweepBelief): number {
  const at = belief.last_evidence_at ?? belief.updated_at;
  if (!at) return 0;
  const millis = new Date(at as unknown as string | Date).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function zeroReport(beliefsScanned: number): ReconcileSweepReport {
  return {
    beliefsScanned,
    pairsFound: 0,
    pairsArbitrated: 0,
    archivedSupersedes: [],
    archivedDuplicates: [],
    skippedCap: 0,
    skippedContention: 0,
    skippedErrors: 0,
    recompiledScopes: [],
  };
}

/**
 * Operator sweep (cli.ts's "--reconcile" mode) over one project's existing
 * ACTIVE beliefs: heals contradictory or duplicate beliefs that were written
 * before upsertBelief.ts's write-time reconciliation block existed, or that
 * slipped past it (for example because the reconcile probe was only run
 * against candidates arriving after the fix). That write-time check only
 * ever looks at a new candidate against beliefs already in the collection,
 * so it can never retroactively repair two beliefs that are both already
 * sitting there contradicting each other. This sweep is the retroactive
 * counterpart: an explicit operator action, not something the system calls
 * itself, the same way rollback.ts's runRollback is.
 *
 * Steps: fetch this project's active beliefs (bounded, see
 * MAX_BELIEFS_PER_SWEEP), probe each one for near matches among the same
 * fetched set, dedupe the unordered pairs found, ask the LLM to arbitrate
 * each pair (oriented newer-vs-older by evidence recency), and apply
 * "supersedes" (archive the older, stamp lineage on the survivor) or
 * "duplicate" (archive the older, merge its observation_ids into the
 * survivor) verdicts with the same version-CAS discipline the rest of the
 * consolidation pipeline uses. Every pair is processed inside its own
 * try/catch so one bad pair (a thrown reconcile call, a driver error) can
 * never abort the rest of the sweep, and the function itself never throws:
 * cli.ts's existing top-level error handling is the only backstop, and it
 * should never actually be needed here.
 */
export async function runReconcileSweep(
  db: Db,
  project: string,
  deps: ReconcileSweepDeps
): Promise<ReconcileSweepReport> {
  const beliefsCollection = db.collection<Document>(BELIEFS);

  const beliefs = (await beliefsCollection
    .find(
      { project, status: "active" },
      {
        projection: {
          text: 1,
          scope: 1,
          embedding: 1,
          version: 1,
          last_evidence_at: 1,
          updated_at: 1,
          supersedes: 1,
          observation_ids: 1,
        },
      }
    )
    .sort({ updated_at: -1 })
    .limit(MAX_BELIEFS_PER_SWEEP)
    .toArray()) as unknown as SweepBelief[];

  if (beliefs.length === 0) {
    return zeroReport(0);
  }

  const report = zeroReport(beliefs.length);

  const byId = new Map<string, SweepBelief>();
  for (const belief of beliefs) {
    byId.set(String(belief._id), belief);
  }

  // Step 2 + 3: probe every belief against the same fetched set and collect
  // unordered pairs, deduped by a "smallerId|largerId" key so a pair found
  // from either side (A's probe surfaces B, or B's probe surfaces A) is only
  // ever queued once. A match outside this project's fetched set (possible
  // for a scope:"core" probe, which searches with no project constraint) is
  // skipped here: there is no version/evidence snapshot for it to reconcile
  // safely against within this sweep.
  const pairKeys = new Set<string>();
  const pairs: Array<[SweepBelief, SweepBelief]> = [];

  for (const belief of beliefs) {
    const selfId = String(belief._id);

    // appside mode with a stored embedding: reuse it as the query vector, so
    // the entire sweep makes zero calls to the Voyage embedding API (every
    // belief was already embedded once, at write time). Only when there is
    // no stored embedding to reuse (an anomalous doc) or the deployment mode
    // is "auto" does the probe fall back to a text query, which Atlas
    // autoEmbed turns into an embedding server-side, still without an
    // app-side embedding call.
    const hasStoredEmbedding = Array.isArray(belief.embedding) && belief.embedding.length > 0;
    const useTextQuery = deps.embeddingMode === "auto" || !hasStoredEmbedding;

    let near: SimilarBelief[];
    try {
      near = await findSimilarBeliefs(
        db,
        project,
        belief.scope,
        useTextQuery ? [] : (belief.embedding as number[]),
        deps.threshold,
        RECONCILE_TOP_K,
        useTextQuery
          ? { mode: "auto", model: deps.model, queryText: belief.text }
          : { mode: deps.embeddingMode, model: deps.model, queryText: belief.text }
      );
    } catch {
      // A probe failure (driver error, unreachable Atlas) must never abort
      // the whole sweep: skip this one belief's probe and keep going, same
      // fail-open discipline as the per-pair try/catch below.
      report.skippedErrors++;
      continue;
    }

    for (const match of near) {
      if (match._id === selfId) continue;
      if (!byId.has(match._id)) continue;

      const key = [selfId, match._id].sort().join("|");
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      report.pairsFound++;

      if (pairs.length >= deps.maxPairs) {
        report.skippedCap++;
        continue;
      }
      pairs.push([belief, byId.get(match._id)!]);
    }
  }

  if (report.skippedCap > 0) {
    console.error(
      `[reconcile] project="${project}": pair cap (${deps.maxPairs}) reached, skipped ${report.skippedCap} additional pair(s)`
    );
  }

  const archivedIds = new Set<string>();
  let coreTouched = false;

  for (const [beliefA, beliefB] of pairs) {
    const idA = String(beliefA._id);
    const idB = String(beliefB._id);

    // A belief archived earlier in this same sweep (as the "older" side of a
    // previous pair) can still appear as a member of a later pair; skip it
    // rather than reconcile against a belief that is no longer active.
    if (archivedIds.has(idA) || archivedIds.has(idB)) continue;

    try {
      // Step 4: orient by evidence recency, fallback updated_at (same
      // convention as upsertBelief.ts's mergeIntoActiveBelief). The newer
      // belief is the survivor; the older is the one judged against it.
      const [newer, older] = evidenceTime(beliefA) >= evidenceTime(beliefB)
        ? [beliefA, beliefB]
        : [beliefB, beliefA];
      const olderIdStr = String(older._id);
      const newerIdStr = String(newer._id);

      const verdicts = await deps.reconcile(newer.text, [{ _id: olderIdStr, text: older.text }]);
      report.pairsArbitrated++;

      // An empty result is reconcileCandidate's own fail-open case (provider
      // error, malformed response); treated the same as an explicit
      // "unrelated" verdict, so a reconcile failure on one pair only loses
      // this one pair's chance at healing, never surfaces as a sweep error.
      const verdict = verdicts.find((v) => v.beliefId === olderIdStr)?.verdict ?? "unrelated";
      if (verdict === "unrelated") continue;

      const now = new Date();
      const archiveResult = await beliefsCollection.updateOne(
        { _id: toFilterId(olderIdStr) as never, status: "active", version: older.version },
        { $set: { status: "archived", updated_at: now }, $inc: { version: 1 } }
      );

      if (archiveResult.matchedCount === 0) {
        // The older belief moved (archived, tombstoned, or merged) between
        // our snapshot read and this write: leave everything untouched
        // rather than archive out from under a concurrent write.
        report.skippedContention++;
        continue;
      }

      archivedIds.add(olderIdStr);
      if (older.scope === "core" || newer.scope === "core") {
        coreTouched = true;
      }

      if (verdict === "supersedes") {
        // Stamp lineage on the survivor only when it does not already point
        // somewhere: never overwrite an existing supersedes pointer, so a
        // belief that has already superseded some other fact keeps that
        // lineage intact rather than losing it to this sweep's pairing.
        if (newer.supersedes === null || newer.supersedes === undefined) {
          await beliefsCollection.updateOne(
            { _id: toFilterId(newerIdStr) as never, status: "active", supersedes: null },
            { $set: { supersedes: olderIdStr, updated_at: now }, $inc: { version: 1 } }
          );
        }
        report.archivedSupersedes.push(olderIdStr);
      } else if (verdict === "duplicate") {
        const olderObservationIds = Array.isArray(older.observation_ids) ? older.observation_ids : [];
        await beliefsCollection.updateOne(
          { _id: toFilterId(newerIdStr) as never, status: "active" },
          { $addToSet: { observation_ids: { $each: olderObservationIds } }, $inc: { version: 1 } }
        );
        report.archivedDuplicates.push(olderIdStr);
      }
    } catch {
      report.skippedErrors++;
      continue;
    }
  }

  if (archivedIds.size > 0) {
    await deps.compileBrief(db, project);
    report.recompiledScopes.push(project);
    if (coreTouched) {
      await deps.compileBrief(db, "global");
      report.recompiledScopes.push("global");
    }
  }

  return report;
}

/**
 * Renders a ReconcileSweepReport as readable multi-line text for CLI output,
 * following formatRollbackReport's style (rollback.ts): commas, colons, and
 * parentheses only, no em dashes.
 */
export function formatReconcileReport(project: string, report: ReconcileSweepReport): string {
  const lines: string[] = [];
  lines.push(
    `[reconcile] project="${project}": scanned ${report.beliefsScanned} active belief(s), found ${report.pairsFound} pair(s), arbitrated ${report.pairsArbitrated} pair(s)`
  );
  lines.push(
    `Archived ${report.archivedSupersedes.length} superseded belief(s) and ${report.archivedDuplicates.length} duplicate belief(s)`
  );

  if (report.archivedSupersedes.length > 0) {
    lines.push(`Archived (superseded) belief ids: ${report.archivedSupersedes.join(", ")}`);
  }

  if (report.archivedDuplicates.length > 0) {
    lines.push(`Archived (duplicate) belief ids: ${report.archivedDuplicates.join(", ")}`);
  }

  lines.push(
    `Skipped: ${report.skippedCap} over the pair cap, ${report.skippedContention} due to contention, ` +
      `${report.skippedErrors} due to errors`
  );

  lines.push(
    report.recompiledScopes.length > 0
      ? `Recompiled brief(s) for scope(s): ${report.recompiledScopes.join(", ")}`
      : "No briefs needed recompilation."
  );

  return lines.join("\n");
}
