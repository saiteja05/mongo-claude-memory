// Collection interfaces matching DESIGN.md section 6 (data model) and
// section 7 (concurrency: the locks lease collection).

export const OBSERVATIONS = "observations";
export const BELIEFS = "beliefs";
export const BRIEFS = "briefs";
export const LOCKS = "locks";

export type ObservationSource =
  | "transcript"
  | "remember"
  | "hash_line"
  | "mcp_write";

export type ObservationPriority = "normal" | "high";

export type ObservationStatus = "pending" | "claimed" | "consolidated";

export interface Observation {
  _id?: string;
  project: string; // repo key; "global" allowed for cross-project facts
  session_id: string;
  source: ObservationSource;
  priority: ObservationPriority;
  text: string; // raw content or a transcript-summary chunk
  status: ObservationStatus;
  run_id?: string; // set when claimed, for idempotent reprocessing
  claimed_at?: Date; // for lease/claim reclaim on crash
  created_at: Date;
  expiresAt?: Date; // TTL target; unset for high-priority user captures
}

export type BeliefScope = "core" | "project" | "archive";

export type BeliefType =
  | "preference"
  | "convention"
  | "lesson"
  | "reference"
  | string;

export type BeliefStatus = "active" | "archived" | "tombstoned";

export interface Belief {
  _id?: string;
  project: string; // or "global"
  scope: BeliefScope;
  type: BeliefType;
  text: string; // the distilled fact (the field that gets embedded)
  embedding?: number[]; // voyage-4 @ 1024; omitted when autoEmbed manages it
  model_version?: string; // e.g. "voyage-4" stamped for future re-embed/migration
  importance: number; // consolidator-assigned; feeds ranking and brief inclusion
  use_count: number; // incremented when surfaced/used; feeds ranking
  last_used?: Date;
  created_at: Date;
  updated_at: Date;
  version: number; // optimistic-concurrency guard for targeted edits
  status: BeliefStatus;
  supersedes?: string; // belief _id this replaced, if any
  observation_ids: string[]; // provenance: source observations
  // type-specific fields (e.g. reference: { url, title }) may be added freely
  // by callers; this interface intentionally allows extra properties via
  // index signature so polymorphic fields are not rejected by the compiler.
  [key: string]: unknown;
}

export interface Brief {
  _id: string; // e.g. "brief:global" or "brief:<project>"
  project: string; // or "global"
  content: string; // compiled prose, token-capped
  token_estimate: number;
  belief_ids: string[]; // provenance for what went in
  generation: number; // monotonically increasing; supports rollback/debug
  generated_at: Date;
}

// Section 7.2: TTL lease enforcing one active consolidator run per project.
export interface Lock {
  _id: string; // e.g. "consolidate:" + project
  holder: string; // run_id of the current lease holder
  heldUntil: Date;
}
