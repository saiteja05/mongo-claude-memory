import { writeObservation } from "../capture/writeObservation.js";
const defaultDeps = { writeObservation };
/**
 * memory_write is not a direct write to beliefs (DESIGN.md 7.1, 7.3: beliefs
 * have a single logical writer, the consolidator). This is a thin wrapper
 * around the same writeObservation() helper /remember uses, writing a
 * high-priority observation with source "mcp_write" and nothing else. It must
 * never touch the beliefs collection.
 */
export async function runMemoryWrite(db, params, deps = {}) {
    const { writeObservation: writeObs } = { ...defaultDeps, ...deps };
    const text = params.text.trim();
    if (text.length === 0) {
        return { ok: false, error: "text must not be empty" };
    }
    const observationId = await writeObs(db, {
        project: params.project,
        session_id: params.session_id ?? "mcp:memory_write",
        source: "mcp_write",
        priority: "high",
        text,
    });
    return { ok: true, observationId };
}
