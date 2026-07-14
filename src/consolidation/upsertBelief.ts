import { ObjectId } from "mongodb";
import type { Collection, Db, Document } from "mongodb";
import { BELIEFS } from "../db/schema.js";
import type { CandidateFact } from "./extractFacts.js";
import { RECONCILE_TOP_K } from "./reconcileBelief.js";
import type { ReconcileVerdict } from "./reconcileBelief.js";
import { appendFailure } from "../telemetry/failureLog.js";

const BELIEFS_VECTOR_INDEX = "beliefs_vec"; // matches setupIndexes.ts (Phase 0)
const BELIEFS_VECTOR_INDEX_AUTO = "beliefs_vec_auto"; // matches setupIndexes.ts autoEmbed index
const VOYAGE_MODEL_VERSION = "voyage-4";

export interface SimilarBelief {
  _id: string;
  text: string;
  score: number;
}

export type UpsertAction = "insert" | "update" | "supersede";

export interface UpsertBeliefResult {
  beliefId: string;
  action: UpsertAction;
}

/**
 * "appside" (default): the caller has already computed a Voyage embedding
 * and findSimilarBelief/upsertBelief run the dedupe $vectorSearch against
 * beliefs_vec with that queryVector, writing the embedding onto the doc.
 * "auto": Atlas autoEmbed manages embeddings server-side; the dedupe
 * $vectorSearch runs against beliefs_vec_auto with a text query instead of a
 * vector, and no embedding field is written onto the doc.
 */
export interface EmbeddingModeOptions {
  mode?: "appside" | "auto";
  model?: string;
  /** The candidate's text, used as the $vectorSearch text query when mode is "auto". */
  queryText?: string;
}

/**
 * Runs a $vectorSearch against the beliefs_vec index and returns up to `k`
 * matches scoring at or above `threshold` (an empty array if none qualify,
 * never null; the empty case just means there are no active beliefs close
 * enough yet). The filter is scope-aware: a scope "core" candidate (a
 * durable identity/preference fact meant to be global, not project-specific)
 * is matched against core beliefs from ANY project, with no project
 * constraint, so the same fact restated while working in a different repo is
 * still recognized as a duplicate of the belief already stored under another
 * repo's project value. Any other scope (in practice, "project" or
 * "archive") stays filtered by project, plus an explicit scope filter
 * matching the candidate's own scope, so a project-scoped (or
 * archive-scoped) search can never accidentally match a core-scoped belief,
 * or a belief of the other non-core scope, that happens to share the same
 * project field value. Kept as its own small exported function so it is
 * separately testable with a mocked aggregate() call.
 */
export async function findSimilarBeliefs(
  db: Db,
  project: string,
  scope: CandidateFact["scope"],
  embedding: number[],
  threshold: number,
  k: number,
  options: EmbeddingModeOptions = {}
): Promise<SimilarBelief[]> {
  const filter: Document =
    scope === "core"
      ? { scope: "core", status: "active" }
      : { project, scope, status: "active" };

  const vectorSearchStage =
    options.mode === "auto"
      ? {
          index: BELIEFS_VECTOR_INDEX_AUTO,
          path: "text",
          query: { text: options.queryText ?? "" },
          model: options.model ?? VOYAGE_MODEL_VERSION,
          filter,
          numCandidates: 100,
          limit: k,
        }
      : {
          index: BELIEFS_VECTOR_INDEX,
          path: "embedding",
          queryVector: embedding,
          filter,
          numCandidates: 100,
          limit: k,
        };

  const results = await db
    .collection<Document>(BELIEFS)
    .aggregate([
      { $vectorSearch: vectorSearchStage },
      {
        $project: { text: 1, score: { $meta: "vectorSearchScore" } },
      },
    ])
    .toArray();

  return (results as { _id: unknown; text: string; score: number }[])
    .filter((r) => r.score >= threshold)
    .map((r) => ({ _id: String(r._id), text: r.text, score: r.score }));
}

/**
 * Thin top-1 wrapper over findSimilarBeliefs, kept around (same signature
 * and export as before) because it is the shape the dedupe path and its
 * existing tests want: the single closest match above threshold, or null
 * when there isn't one.
 */
export async function findSimilarBelief(
  db: Db,
  project: string,
  scope: CandidateFact["scope"],
  embedding: number[],
  threshold: number,
  options: EmbeddingModeOptions = {}
): Promise<SimilarBelief | null> {
  const results = await findSimilarBeliefs(db, project, scope, embedding, threshold, 1, options);
  return results[0] ?? null;
}

// Belief _ids are normally real ObjectIds (auto-generated on insert). Falls
// back to the raw string when it is not a valid ObjectId (e.g. in tests with
// a mocked db that keys documents by a plain string id) so this stays
// testable without a live MongoDB. Cast to ObjectId in the fallback case
// since the Document filter type expects one; a mocked collection does not
// enforce this at runtime.
function toFilterId(id: string): ObjectId {
  try {
    return new ObjectId(id);
  } catch {
    return id as unknown as ObjectId;
  }
}

function newBeliefDoc(
  project: string,
  candidate: CandidateFact,
  embedding: number[] | null,
  now: Date,
  supersedes: string | undefined,
  evidenceAt: Date
): Document {
  const doc: Document = {
    project,
    scope: candidate.scope,
    type: candidate.type,
    text: candidate.text,
    model_version: VOYAGE_MODEL_VERSION,
    importance: candidate.importance,
    use_count: 0,
    last_used: null,
    created_at: now,
    updated_at: now,
    last_evidence_at: evidenceAt,
    version: 1,
    status: "active",
    supersedes: supersedes ?? null,
    observation_ids: candidate.observation_ids,
  };
  // embedding is omitted entirely (not even set to null/undefined) when Atlas
  // autoEmbed manages it server-side (embeddingMode "auto"), matching
  // schema.ts's "omitted when autoEmbed manages it" doc comment.
  if (embedding !== null) {
    doc.embedding = embedding;
  }
  return doc;
}

/**
 * Attempts to merge `candidate` into the active belief identified by
 * `similar` via a version-filtered compare-and-swap update, extracted out of
 * upsertBelief's dedupe branch so the same merge logic can also be reached
 * from the insert-path reconciliation block below (a "duplicate" verdict
 * merges into its target the same way a same-run dedupe match does).
 * Behavior is unchanged from before the extraction: up to 3 attempts,
 * retrying against a fresh read when a concurrent write wins the CAS race.
 * Returns null (never throws) when the belief has gone inactive by the time
 * of read or retry, or when the CAS stays contested for all attempts;
 * either way the caller falls through to inserting a new belief instead of
 * losing the candidate's contribution.
 */
async function mergeIntoActiveBelief(
  collection: Collection<Document>,
  similar: SimilarBelief,
  candidate: CandidateFact,
  evidenceAt: Date,
  now: Date
): Promise<UpsertBeliefResult | null> {
  const existingFilterId = toFilterId(similar._id);
  let existing = await collection.findOne({ _id: existingFilterId, status: "active" });

  // CAS retry loop: two concurrent consolidation runs can both read the
  // same active belief and each compute a merge from their own read.
  // Filtering the update on the exact version just read means only one of
  // them can win per attempt; the loser (matchedCount 0) re-reads the
  // now-current document and retries its merge against it instead of
  // silently losing its own contribution to a write that reports success.
  // matchedCount 0 can also mean a concurrent rollback or supersede
  // archived or tombstoned this exact belief; the re-read's null result
  // is how that case is told apart from a version race.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts && existing; attempt++) {
    const existingObservationIds: string[] = Array.isArray(existing.observation_ids)
      ? (existing.observation_ids as string[])
      : [];
    const mergedObservationIds = Array.from(
      new Set([...existingObservationIds, ...candidate.observation_ids])
    );
    const existingText = typeof existing.text === "string" ? (existing.text as string) : similar.text;
    const textChanged = existingText !== candidate.text;

    // Evidence-recency guard: only let the candidate's text overwrite the
    // existing text when the candidate's evidence is at least as new as the
    // evidence already backing the belief. Without this, replaying an OLD
    // observation (crash reprocessing, delayed batch) through the dedupe
    // path would regress a belief that a newer correction already updated.
    // A belief without a last_evidence_at stamp (written before this field
    // existed) is treated as epoch 0, so the first stamped write wins.
    const existingEvidenceAt =
      existing.last_evidence_at instanceof Date ? existing.last_evidence_at : new Date(0);
    const evidenceIsFresh = evidenceAt.getTime() >= existingEvidenceAt.getTime();

    // observation_ids always merge and version always bumps, regardless of
    // evidence freshness: provenance accumulates even from stale replays.
    const setFields: Document = {
      observation_ids: mergedObservationIds,
      updated_at: now,
    };
    if (evidenceIsFresh) {
      setFields.text = textChanged ? candidate.text : existingText;
      setFields.last_evidence_at = evidenceAt;
    } else if (textChanged) {
      console.error(`[consolidate] skipped stale text overwrite for belief ${similar._id}`);
    }

    const updateResult = await collection.updateOne(
      { _id: existingFilterId, status: "active", version: existing.version },
      {
        $set: setFields,
        $inc: { version: 1 },
      }
    );

    if (updateResult.matchedCount > 0) {
      return { beliefId: similar._id, action: "update" };
    }

    existing =
      attempt < maxAttempts
        ? await collection.findOne({ _id: existingFilterId, status: "active" })
        : null;
  }

  return null;
}

/**
 * Given one validated candidate fact and its precomputed embedding,
 * implements the dedup-or-supersede-or-insert logic (DESIGN.md 5.2 steps 4-6,
 * section 6). Returns the belief _id that was written and which action was
 * taken.
 */
export async function upsertBelief(
  db: Db,
  project: string,
  candidate: CandidateFact,
  embedding: number[] | null,
  dedupeSimilarityThreshold: number,
  options: EmbeddingModeOptions = {},
  candidateEvidenceAt?: Date,
  // Optional write-time reconciliation pass (bug fix: a candidate that
  // contradicts an existing belief but scores below dedupeSimilarityThreshold
  // used to become a permanent second active belief). Absent by default so
  // every existing caller and test keeps today's exact behavior; cli.ts's
  // buildDeps is the only caller that passes it in production.
  reconcileOptions?: {
    threshold: number;
    reconcile: (candidateText: string, existing: SimilarBelief[]) => Promise<ReconcileVerdict[]>;
  }
): Promise<UpsertBeliefResult> {
  const collection = db.collection<Document>(BELIEFS);
  const now = new Date();
  const evidenceAt = candidateEvidenceAt ?? now;

  if (candidate.supersedes_belief_id) {
    const oldFilterId = toFilterId(candidate.supersedes_belief_id);
    const old = await collection.findOne({ _id: oldFilterId, project, status: "active" });

    if (old) {
      await collection.updateOne(
        { _id: oldFilterId },
        // version is incremented here too (not just on the dedupe/"update"
        // path below), so version stays a reliable "has this belief changed
        // at all" signal across every belief-mutating write in the repo, not
        // only some of them: rollback.ts's tombstone compare-and-swap relies
        // on that being true for every mutation path, with no exceptions.
        { $set: { status: "archived", updated_at: now }, $inc: { version: 1 } }
      );

      const inserted = await collection.insertOne(
        newBeliefDoc(project, candidate, embedding, now, candidate.supersedes_belief_id, evidenceAt)
      );
      return { beliefId: String(inserted.insertedId), action: "supersede" };
    }
  }

  const similar = await findSimilarBelief(
    db,
    project,
    candidate.scope,
    embedding ?? [],
    dedupeSimilarityThreshold,
    { mode: options.mode, model: options.model, queryText: candidate.text }
  );

  if (similar) {
    const merged = await mergeIntoActiveBelief(collection, similar, candidate, evidenceAt, now);
    if (merged) {
      return merged;
    }
  }

  // Write-time reconciliation (bug fix): the dedupe branch above only ever
  // fires above dedupeSimilarityThreshold (typically 0.93). A candidate that
  // contradicts an existing belief but scores below that, for example two
  // differently-worded rate-limit facts, fell straight through to insertOne
  // and became a second permanent active belief with no reconciliation at
  // all. This block runs a wider, lower-threshold probe and, only when that
  // probe finds anything, asks an LLM to judge each near match, then acts on
  // "supersedes" (archive-and-replace) or "duplicate" (merge) verdicts before
  // ever reaching the plain insert below. Entirely wrapped in try/catch: any
  // failure here (probe error, reconcile call throwing, a malformed verdict)
  // is logged via appendFailure and falls through to the plain insert, the
  // same as if reconciliation had never run, so this can never turn into a
  // new way for the write path to throw.
  if (reconcileOptions && reconcileOptions.threshold < 1) {
    try {
      const near = await findSimilarBeliefs(
        db,
        project,
        candidate.scope,
        embedding ?? [],
        reconcileOptions.threshold,
        RECONCILE_TOP_K,
        { mode: options.mode, model: options.model, queryText: candidate.text }
      );

      // Common case: nothing scores even the wider reconcile threshold, so
      // there is nothing to reconcile against. Skipping the LLM call here
      // (rather than calling it with an empty list) keeps the common,
      // genuinely-new-fact path free of any reconcile cost.
      if (near.length > 0) {
        const verdicts = await reconcileOptions.reconcile(candidate.text, near);

        // "supersedes" verdicts are applied before "duplicate" verdicts: a
        // candidate that both supersedes one near match and duplicates
        // another should archive-and-replace the contradicted belief rather
        // than quietly merge into it.
        const ordered = [
          ...verdicts.filter((v) => v.verdict === "supersedes"),
          ...verdicts.filter((v) => v.verdict === "duplicate"),
        ];

        for (const verdict of ordered) {
          if (verdict.verdict === "supersedes") {
            const targetFilterId = toFilterId(verdict.beliefId);
            // Status-filtered CAS: unlike candidate.supersedes_belief_id's
            // findOne-then-update above, this path has no prior read to
            // trust, so the archive itself must be the compare-and-swap. A
            // matchedCount of 0 means the target was archived (or
            // tombstoned) by something else in the meantime; that verdict is
            // simply skipped rather than treated as an error.
            const archiveFilter: Document =
              candidate.scope === "core"
                ? { _id: targetFilterId, status: "active" }
                : { _id: targetFilterId, project, status: "active" };
            const archived = await collection.updateOne(archiveFilter, {
              $set: { status: "archived", updated_at: now },
              $inc: { version: 1 },
            });
            if (archived.matchedCount === 0) {
              continue;
            }

            const inserted = await collection.insertOne(
              newBeliefDoc(project, candidate, embedding, now, verdict.beliefId, evidenceAt)
            );
            return { beliefId: String(inserted.insertedId), action: "supersede" };
          }

          if (verdict.verdict === "duplicate") {
            const target = near.find((n) => n._id === verdict.beliefId);
            if (!target) {
              continue;
            }
            const merged = await mergeIntoActiveBelief(collection, target, candidate, evidenceAt, now);
            if (merged) {
              return merged;
            }
          }
        }
      }
    } catch (err) {
      appendFailure("reconcileBelief.upsert", err);
    }
  }

  const inserted = await collection.insertOne(
    newBeliefDoc(project, candidate, embedding, now, undefined, evidenceAt)
  );
  return { beliefId: String(inserted.insertedId), action: "insert" };
}
