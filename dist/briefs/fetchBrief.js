import { getDb } from "../db/client.js";
import { BRIEFS } from "../db/schema.js";
const EMPTY_RESULT = { global: null, project: null };
/**
 * Fetches the global and project briefs with two findOne calls, raced
 * against timeoutMs. Never rejects: on timeout or any Mongo error, resolves
 * with { global: null, project: null } so the caller can always fail open.
 */
export async function getBriefs(projectKey, timeoutMs) {
    const fetchPromise = (async () => {
        const db = await getDb();
        const collection = db.collection(BRIEFS);
        const [globalDoc, projectDoc] = await Promise.all([
            collection.findOne({ _id: "brief:global" }),
            collection.findOne({ _id: `brief:${projectKey}` }),
        ]);
        return {
            global: globalDoc?.content ?? null,
            project: projectDoc?.content ?? null,
        };
    })();
    const timeoutPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(EMPTY_RESULT), timeoutMs);
        // Do not let this timer keep the process alive.
        timer.unref?.();
    });
    // Swallow late rejections from fetchPromise if the timeout already won the
    // race, so a slow Mongo error never surfaces as an unhandled rejection.
    const guardedFetch = fetchPromise.catch(() => EMPTY_RESULT);
    try {
        return await Promise.race([guardedFetch, timeoutPromise]);
    }
    catch {
        return EMPTY_RESULT;
    }
}
