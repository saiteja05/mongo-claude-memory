import { ObjectId } from "mongodb";
import type { Db, Document } from "mongodb";
import { BELIEFS } from "../db/schema.js";
import type { CandidateFact } from "./extractFacts.js";

const BELIEFS_VECTOR_INDEX = "beliefs_vec"; // matches setupIndexes.ts (Phase 0)
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
 * Runs a $vectorSearch against the beliefs_vec index and returns the single
 * closest match (or null if there are no active beliefs yet). The filter is
 * scope-aware: a scope "core" candidate (a durable identity/preference fact
 * meant to be global, not project-specific) is matched against core beliefs
 * from ANY project, with no project constraint, so the same fact restated
 * while working in a different repo is still recognized as a duplicate of
 * the belief already stored under another repo's project value. Any other
 * scope (in practice, "project" or "archive") stays filtered by project,
 * plus an explicit scope filter matching the candidate's own scope, so a
 * project-scoped (or archive-scoped) search can never accidentally match a
 * core-scoped belief, or a belief of the other non-core scope, that happens
 * to share the same project field value. Kept as its own small exported
 * function so it is separately testable with a mocked aggregate() call.
 */
export async function findSimilarBelief(
  db: Db,
  project: string,
  scope: CandidateFact["scope"],
  embedding: number[],
  threshold: number
): Promise<SimilarBelief | null> {
  const filter: Document =
    scope === "core"
      ? { scope: "core", status: "active" }
      : { project, scope, status: "active" };

  const results = await db
    .collection<Document>(BELIEFS)
    .aggregate([
      {
        $vectorSearch: {
          index: BELIEFS_VECTOR_INDEX,
          path: "embedding",
          queryVector: embedding,
          filter,
          numCandidates: 100,
          limit: 1,
        },
      },
      {
        $project: { text: 1, score: { $meta: "vectorSearchScore" } },
      },
    ])
    .toArray();

  const top = results[0] as { _id: unknown; text: string; score: number } | undefined;
  if (!top) return null;
  if (top.score < threshold) return null;

  return { _id: String(top._id), text: top.text, score: top.score };
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
  embedding: number[],
  now: Date,
  supersedes: string | undefined
): Document {
  return {
    project,
    scope: candidate.scope,
    type: candidate.type,
    text: candidate.text,
    embedding,
    model_version: VOYAGE_MODEL_VERSION,
    importance: candidate.importance,
    use_count: 0,
    last_used: null,
    created_at: now,
    updated_at: now,
    version: 1,
    status: "active",
    supersedes: supersedes ?? null,
    observation_ids: candidate.observation_ids,
  };
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
  embedding: number[],
  dedupeSimilarityThreshold: number
): Promise<UpsertBeliefResult> {
  const collection = db.collection<Document>(BELIEFS);
  const now = new Date();

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
        newBeliefDoc(project, candidate, embedding, now, candidate.supersedes_belief_id)
      );
      return { beliefId: String(inserted.insertedId), action: "supersede" };
    }
  }

  const similar = await findSimilarBelief(
    db,
    project,
    candidate.scope,
    embedding,
    dedupeSimilarityThreshold
  );

  if (similar) {
    const existingFilterId = toFilterId(similar._id);
    const existing = await collection.findOne({ _id: existingFilterId, status: "active" });

    const existingObservationIds: string[] = Array.isArray(existing?.observation_ids)
      ? (existing!.observation_ids as string[])
      : [];
    const mergedObservationIds = Array.from(
      new Set([...existingObservationIds, ...candidate.observation_ids])
    );
    const existingText = typeof existing?.text === "string" ? (existing!.text as string) : similar.text;
    const textChanged = existingText !== candidate.text;

    const updateResult = await collection.updateOne(
      { _id: existingFilterId, status: "active" },
      {
        $set: {
          text: textChanged ? candidate.text : existingText,
          observation_ids: mergedObservationIds,
          updated_at: now,
        },
        $inc: { version: 1 },
      }
    );

    // matchedCount 0 means a concurrent rollback or supersede archived or
    // tombstoned this exact belief between the vectorSearch read above and
    // this write, so the compare-and-swap filter above matched nothing.
    // Fall through to the insert path below instead of returning a false
    // "update" success on what is now an inert document.
    if (updateResult.matchedCount > 0) {
      return { beliefId: similar._id, action: "update" };
    }
  }

  const inserted = await collection.insertOne(
    newBeliefDoc(project, candidate, embedding, now, undefined)
  );
  return { beliefId: String(inserted.insertedId), action: "insert" };
}
