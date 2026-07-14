import { getDb } from "../db/client.js";
import { BRIEFS } from "../db/schema.js";
import type { Brief } from "../db/schema.js";

export interface BriefResult {
  global: string | null;
  project: string | null;
  // How this result came to be, so a caller (the local brief cache) can tell
  // a healthy "nothing to say" apart from an outage. "fetched" covers any
  // completed fetch, INCLUDING when both briefs are null, because a project
  // with nothing recorded yet (or fully forgotten) is a healthy empty, not an
  // outage. "timeout" is the internal race timer winning; "error" is the
  // swallowed-rejection path. Additive/optional: existing consumers that only
  // read .global/.project are unaffected.
  source?: "fetched" | "timeout" | "error";
  // ISO string of the newest generated_at across the two brief documents;
  // null when neither document has one. Only meaningful when source is
  // "fetched".
  generatedAt?: string | null;
}

const EMPTY_RESULT: BriefResult = { global: null, project: null };

/**
 * Fetches the global and project briefs with two findOne calls, raced
 * against timeoutMs. Never rejects: on timeout or any Mongo error, resolves
 * with { global: null, project: null, source: "timeout" | "error" } so the
 * caller can always fail open.
 */
export async function getBriefs(projectKey: string, timeoutMs: number): Promise<BriefResult> {
  const fetchPromise = (async (): Promise<BriefResult> => {
    const db = await getDb();
    const collection = db.collection<Brief>(BRIEFS);

    const [globalDoc, projectDoc] = await Promise.all([
      collection.findOne({ _id: "brief:global" }),
      collection.findOne({ _id: `brief:${projectKey}` }),
    ]);

    // Newest generated_at across whichever docs actually exist; null when
    // neither has one.
    const generatedTimestamps = [globalDoc?.generated_at, projectDoc?.generated_at]
      .filter((value): value is Date => value instanceof Date)
      .map((value) => value.getTime());
    const generatedAt =
      generatedTimestamps.length > 0
        ? new Date(Math.max(...generatedTimestamps)).toISOString()
        : null;

    return {
      global: globalDoc?.content ?? null,
      project: projectDoc?.content ?? null,
      // A completed fetch is "fetched" even when both briefs are null: the
      // local brief cache fallback in sessionStart.ts must only ever kick in
      // on an outage, never on a healthy connection that legitimately has
      // nothing to say (e.g. a fully-forgotten project), so this distinction
      // has to survive past this function.
      source: "fetched",
      generatedAt,
    };
  })();

  const timeoutPromise = new Promise<BriefResult>((resolve) => {
    const timer = setTimeout(() => resolve({ ...EMPTY_RESULT, source: "timeout" }), timeoutMs);
    // Do not let this timer keep the process alive.
    timer.unref?.();
  });

  // Swallow late rejections from fetchPromise if the timeout already won the
  // race, so a slow Mongo error never surfaces as an unhandled rejection.
  const guardedFetch = fetchPromise.catch(
    (): BriefResult => ({ ...EMPTY_RESULT, source: "error" })
  );

  try {
    return await Promise.race([guardedFetch, timeoutPromise]);
  } catch {
    return { ...EMPTY_RESULT, source: "error" };
  }
}
