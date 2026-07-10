import type { Db } from "mongodb";
import { writeObservation } from "../capture/writeObservation.js";

export interface MemoryWriteParams {
  project: string;
  session_id?: string;
  text: string;
}

export interface MemoryWriteResult {
  ok: boolean;
  observationId?: unknown;
  error?: string;
}

export interface MemoryWriteDeps {
  writeObservation: typeof writeObservation;
}

const defaultDeps: MemoryWriteDeps = { writeObservation };

/**
 * memory_write is not a direct write to beliefs (DESIGN.md 7.1, 7.3: beliefs
 * have a single logical writer, the consolidator). This is a thin wrapper
 * around the same writeObservation() helper /remember uses, writing a
 * high-priority observation with source "mcp_write" and nothing else. It must
 * never touch the beliefs collection.
 */
export async function runMemoryWrite(
  db: Db,
  params: MemoryWriteParams,
  deps: Partial<MemoryWriteDeps> = {}
): Promise<MemoryWriteResult> {
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
