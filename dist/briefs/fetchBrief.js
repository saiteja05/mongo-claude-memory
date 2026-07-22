import { getDb } from "../db/client.js";
import { BRIEFS } from "../db/schema.js";
const EMPTY_RESULT = { global: null, project: null };
/**
 * Fetches the global and project briefs with two findOne calls, raced
 * against timeoutMs. Never rejects: on timeout or any Mongo error, resolves
 * with { global: null, project: null, source: "timeout" | "error" } so the
 * caller can always fail open.
 */
export async function getBriefs(projectKey, timeoutMs) {
    const fetchPromise = (async () => {
        const db = await getDb();
        const collection = db.collection(BRIEFS);
        const [globalDoc, projectDoc] = await Promise.all([
            collection.findOne({ _id: "brief:global" }),
            collection.findOne({ _id: `brief:${projectKey}` }),
        ]);
        // Newest generated_at across whichever docs actually exist; null when
        // neither has one.
        const generatedTimestamps = [globalDoc?.generated_at, projectDoc?.generated_at]
            .filter((value) => value instanceof Date)
            .map((value) => value.getTime());
        const generatedAt = generatedTimestamps.length > 0
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
    const timeoutPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ...EMPTY_RESULT, source: "timeout" }), timeoutMs);
        // Do not let this timer keep the process alive.
        timer.unref?.();
    });
    // Swallow late rejections from fetchPromise if the timeout already won the
    // race, so a slow Mongo error never surfaces as an unhandled rejection.
    const guardedFetch = fetchPromise.catch(() => ({ ...EMPTY_RESULT, source: "error" }));
    try {
        return await Promise.race([guardedFetch, timeoutPromise]);
    }
    catch {
        return { ...EMPTY_RESULT, source: "error" };
    }
}
