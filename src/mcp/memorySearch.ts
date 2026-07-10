import type { Db, Document } from "mongodb";
import { BELIEFS } from "../db/schema.js";
import { embed as voyageEmbed, rerank as voyageRerank } from "../embeddings/voyage.js";

const VECTOR_INDEX = "beliefs_vec"; // matches setupIndexes.ts (Phase 0)
const TEXT_INDEX = "beliefs_text"; // matches setupIndexes.ts (Phase 0)
const RERANK_MODEL = "rerank-2.5-lite";
const CANDIDATE_LIMIT = 50;
const VECTOR_NUM_CANDIDATES = 150;
const DEFAULT_RESULT_LIMIT = 8;

export interface MemorySearchParams {
  query: string;
  project: string;
  scope?: string;
  limit?: number;
}

export interface MemorySearchResultItem {
  _id: string;
  text: string;
  scope: string;
  type: string;
  importance: number;
  score: number;
}

export interface MemorySearchResult {
  results: MemorySearchResultItem[];
  degraded: string | null;
}

type EmbedFn = (
  texts: string[],
  inputType: "query" | "document",
  model?: string
) => Promise<number[][]>;

type RerankFn = (
  query: string,
  documents: string[],
  model?: string
) => Promise<Array<{ index: number; relevance_score: number }>>;

type AggregateFn = (db: Db, pipeline: Document[]) => Promise<Document[]>;

type UpdateUseCountFn = (db: Db, ids: unknown[]) => Promise<void>;

export interface MemorySearchDeps {
  embed: EmbedFn;
  rerank: RerankFn;
  aggregate: AggregateFn;
  updateUseCount: UpdateUseCountFn;
}

async function defaultAggregate(db: Db, pipeline: Document[]): Promise<Document[]> {
  return db.collection<Document>(BELIEFS).aggregate(pipeline).toArray();
}

async function defaultUpdateUseCount(db: Db, ids: unknown[]): Promise<void> {
  if (ids.length === 0) return;
  await db.collection<Document>(BELIEFS).updateMany(
    { _id: { $in: ids as never[] } },
    { $inc: { use_count: 1 }, $set: { last_used: new Date() } }
  );
}

const defaultDeps: MemorySearchDeps = {
  embed: voyageEmbed,
  rerank: voyageRerank,
  aggregate: defaultAggregate,
  updateUseCount: defaultUpdateUseCount,
};

// Module-level cache: native $rerank availability is checked lazily on first
// use rather than at server startup (running a native $rerank probe against
// real data on every cold boot has a real cost even when the server sits
// idle all session; a deliberate cost-driven deviation from DESIGN.md 8.2's
// literal "capability-checked at server startup" wording). null = not yet
// determined; true/false = determined for the rest of the process lifetime.
let rerankAvailable: boolean | null = null;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/**
 * Computes the query embedding for the vector arm of retrieval. Never lets a
 * Voyage failure (down, rate-limited, misconfigured) propagate: catches any
 * error, logs one line to stderr, and returns null so the caller can fall
 * back to text-only (DESIGN.md 8.3).
 */
export async function computeQueryEmbedding(
  query: string,
  embedFn: EmbedFn
): Promise<number[] | null> {
  try {
    const vectors = await embedFn([query], "query");
    return vectors[0] ?? null;
  } catch (err) {
    console.error(
      `[memorySearch] query embedding failed, falling back to text-only: ${errMsg(err)}`
    );
    return null;
  }
}

function statusProjectFilter(project: string, scope: string | undefined): Document {
  const filter: Document = { project, status: "active" };
  if (scope) filter.scope = scope;
  return filter;
}

function searchCompoundFilter(project: string, scope: string | undefined): Document[] {
  const clauses: Document[] = [
    { equals: { path: "status", value: "active" } },
    { equals: { path: "project", value: project } },
  ];
  if (scope) clauses.push({ equals: { path: "scope", value: scope } });
  return clauses;
}

/**
 * DESIGN.md 8.2 baseline: $rankFusion over a $vectorSearch arm and a $search
 * (BM25) arm, fusionScore projected via $addFields BEFORE any rerank stage
 * (rerank overwrites {$meta:"score"}), then $limit.
 */
export function buildFullPipeline(
  query: string,
  queryVector: number[],
  project: string,
  scope?: string
): Document[] {
  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [
              {
                $vectorSearch: {
                  index: VECTOR_INDEX,
                  path: "embedding",
                  queryVector,
                  filter: statusProjectFilter(project, scope),
                  numCandidates: VECTOR_NUM_CANDIDATES,
                  limit: CANDIDATE_LIMIT,
                },
              },
            ],
            text: [
              {
                $search: {
                  index: TEXT_INDEX,
                  compound: {
                    must: [{ text: { query, path: "text" } }],
                    filter: searchCompoundFilter(project, scope),
                  },
                },
              },
              { $limit: CANDIDATE_LIMIT },
            ],
          },
        },
        combination: { weights: { vector: 2, text: 1 } },
        scoreDetails: true,
      },
    },
    { $addFields: { fusionScore: { $meta: "score" } } },
    { $limit: CANDIDATE_LIMIT },
  ];
}

/** Text-only fallback when the vector arm is unavailable (no query embedding). */
export function buildTextOnlyPipeline(query: string, project: string, scope?: string): Document[] {
  return [
    {
      $search: {
        index: TEXT_INDEX,
        compound: {
          must: [{ text: { query, path: "text" } }],
          filter: searchCompoundFilter(project, scope),
        },
      },
    },
    { $addFields: { fusionScore: { $meta: "searchScore" } } },
    { $limit: CANDIDATE_LIMIT },
  ];
}

/** Vector-only fallback when Atlas Search ($rankFusion/$search) is unavailable. */
export function buildVectorOnlyPipeline(
  queryVector: number[],
  project: string,
  scope?: string
): Document[] {
  return [
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: "embedding",
        queryVector,
        filter: statusProjectFilter(project, scope),
        numCandidates: VECTOR_NUM_CANDIDATES,
        limit: CANDIDATE_LIMIT,
      },
    },
    { $addFields: { fusionScore: { $meta: "vectorSearchScore" } } },
    { $limit: CANDIDATE_LIMIT },
  ];
}

interface RerankOutcome {
  docs: Document[];
  reranked: boolean;
}

/**
 * Application-side Voyage rerank fallback (DESIGN.md 8.2/8.3), applied to the
 * fused top-50. If Voyage rerank also fails, returns the fused top-K
 * unreranked rather than erroring.
 */
async function tryVoyageRerank(
  baseResults: Document[],
  query: string,
  limit: number,
  rerankFn: RerankFn
): Promise<RerankOutcome> {
  if (baseResults.length === 0) {
    return { docs: baseResults.slice(0, limit), reranked: false };
  }
  try {
    const texts = baseResults.map((doc) => String(doc.text ?? ""));
    const rerankResults = await rerankFn(query, texts, RERANK_MODEL);
    const docs = rerankResults
      .slice()
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, limit)
      .map((r) => ({ ...baseResults[r.index], voyageRerankScore: r.relevance_score }));
    return { docs, reranked: true };
  } catch (err) {
    console.error(
      `[memorySearch] Voyage rerank fallback failed, returning fused results unranked: ${errMsg(err)}`
    );
    return { docs: baseResults.slice(0, limit), reranked: false };
  }
}

/**
 * Attempts the base pipeline (whichever variant applies), with the
 * throw-anything-falls-back ladder from DESIGN.md 8.3: full -> vector-only ->
 * empty+degraded, or text-only -> empty+degraded.
 */
async function runBasePipeline(
  db: Db,
  query: string,
  queryVector: number[] | null,
  project: string,
  scope: string | undefined,
  aggregate: AggregateFn
): Promise<{
  docs: Document[];
  pipeline: Document[];
  path: "full" | "vector-only" | "text-only";
  degraded: string | null;
} | null> {
  if (queryVector) {
    const fullPipeline = buildFullPipeline(query, queryVector, project, scope);
    try {
      const docs = await aggregate(db, fullPipeline);
      return { docs, pipeline: fullPipeline, path: "full", degraded: null };
    } catch (err) {
      console.error(
        `[memorySearch] full $rankFusion pipeline failed, falling back to vector-only: ${errMsg(err)}`
      );
      const vectorPipeline = buildVectorOnlyPipeline(queryVector, project, scope);
      try {
        const docs = await aggregate(db, vectorPipeline);
        return {
          docs,
          pipeline: vectorPipeline,
          path: "vector-only",
          degraded: "vector-only: Atlas Search unavailable",
        };
      } catch (err2) {
        console.error(`[memorySearch] vector-only fallback also failed: ${errMsg(err2)}`);
        return null;
      }
    }
  }

  const textPipeline = buildTextOnlyPipeline(query, project, scope);
  try {
    const docs = await aggregate(db, textPipeline);
    return {
      docs,
      pipeline: textPipeline,
      path: "text-only",
      degraded: "text-only: vector search unavailable",
    };
  } catch (err) {
    console.error(`[memorySearch] text-only pipeline failed: ${errMsg(err)}`);
    return null;
  }
}

function toResultItem(doc: Document, scoreField: string): MemorySearchResultItem {
  const rawScore = doc[scoreField];
  return {
    _id: String(doc._id),
    text: typeof doc.text === "string" ? doc.text : "",
    scope: typeof doc.scope === "string" ? doc.scope : "",
    type: typeof doc.type === "string" ? doc.type : "",
    importance: typeof doc.importance === "number" ? doc.importance : 0,
    score: typeof rawScore === "number" ? rawScore : 0,
  };
}

/**
 * Composes the full memory_search flow: embed the query (or degrade to
 * text-only), run the base pipeline with graceful fallback, rerank (native
 * $rerank with a cached capability check, else the Voyage rerank API, else
 * unranked), and fire the best-effort use_count side effect. Never throws:
 * every failure mode collapses to an empty result with a degraded reason
 * (DESIGN.md 10, "no memory failure may ever degrade the coding session").
 */
export async function runMemorySearch(
  db: Db,
  params: MemorySearchParams,
  deps: Partial<MemorySearchDeps> = {}
): Promise<MemorySearchResult> {
  const { embed: embedFn, rerank: rerankFn, aggregate, updateUseCount } = {
    ...defaultDeps,
    ...deps,
  };

  const limit = params.limit ?? DEFAULT_RESULT_LIMIT;
  const queryVector = await computeQueryEmbedding(params.query, embedFn);

  const base = await runBasePipeline(
    db,
    params.query,
    queryVector,
    params.project,
    params.scope,
    aggregate
  );

  if (!base) {
    return {
      results: [],
      degraded: "unavailable: memory search failed on every path",
    };
  }

  const { docs: baseResults, pipeline: basePipeline, path, degraded: baseDegraded } = base;
  const eligibleForNativeRerank = path === "full" || path === "vector-only";

  let finalDocs: Document[];
  let scoreField: string;
  let degraded = baseDegraded;

  if (eligibleForNativeRerank && rerankAvailable !== false) {
    const rerankPipeline: Document[] = [
      ...basePipeline,
      {
        $rerank: {
          query: { text: params.query },
          path: "text",
          model: RERANK_MODEL,
          numDocsToRerank: CANDIDATE_LIMIT,
        },
      },
      { $addFields: { rerankScore: { $meta: "score" } } },
      { $limit: limit },
    ];
    try {
      finalDocs = await aggregate(db, rerankPipeline);
      rerankAvailable = true;
      scoreField = "rerankScore";
    } catch (err) {
      console.error(
        `[memorySearch] native $rerank unavailable, caching and falling back to Voyage rerank: ${errMsg(err)}`
      );
      rerankAvailable = false;
      const fallback = await tryVoyageRerank(baseResults, params.query, limit, rerankFn);
      finalDocs = fallback.docs;
      scoreField = fallback.reranked ? "voyageRerankScore" : "fusionScore";
    }
  } else if (eligibleForNativeRerank) {
    // rerankAvailable is cached false: skip straight to the fallback.
    const fallback = await tryVoyageRerank(baseResults, params.query, limit, rerankFn);
    finalDocs = fallback.docs;
    scoreField = fallback.reranked ? "voyageRerankScore" : "fusionScore";
  } else {
    // text-only path: rerank is not attempted (DESIGN.md instructs reranking
    // only for the full or vector-derived pipeline).
    finalDocs = baseResults.slice(0, limit);
    scoreField = "fusionScore";
  }

  const results = finalDocs.map((doc) => toResultItem(doc, scoreField));

  // Best-effort recall side effect (DESIGN.md 7.3): fired without awaiting so
  // a slow or hanging updateMany can never add latency to the returned
  // results, and errors are swallowed here so they never throw out of
  // runMemorySearch.
  void updateUseCount(
    db,
    finalDocs.map((doc) => doc._id)
  ).catch((err) => {
    console.error(`[memorySearch] use_count increment failed (non-fatal): ${errMsg(err)}`);
  });

  return { results, degraded: degraded ?? null };
}
