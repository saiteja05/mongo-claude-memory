import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { quarantineDroppedCandidate } from "../src/consolidation/quarantine.js";
import { DROPPED_CANDIDATES } from "../src/db/schema.js";
import type { CandidateFact } from "../src/consolidation/extractFacts.js";

let savedMongoUri: string | undefined;
let savedMdbUri: string | undefined;
let savedTtlDays: string | undefined;
let savedFailureLog: string | undefined;

beforeEach(() => {
  savedMongoUri = process.env.MEMORY_MONGODB_URI;
  savedMdbUri = process.env.MDB_MCP_CONNECTION_STRING;
  savedTtlDays = process.env.DROPPED_CANDIDATE_TTL_DAYS;
  savedFailureLog = process.env.MEMORY_FAILURE_LOG;
  // quarantineDroppedCandidate calls loadConfig() itself, which throws when
  // no connection string is configured; pin a deterministic one plus a
  // deterministic TTL rather than relying on the ambient shell env.
  process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
  delete process.env.MDB_MCP_CONNECTION_STRING;
  process.env.DROPPED_CANDIDATE_TTL_DAYS = "7";
});

afterEach(() => {
  if (savedMongoUri === undefined) delete process.env.MEMORY_MONGODB_URI;
  else process.env.MEMORY_MONGODB_URI = savedMongoUri;
  if (savedMdbUri === undefined) delete process.env.MDB_MCP_CONNECTION_STRING;
  else process.env.MDB_MCP_CONNECTION_STRING = savedMdbUri;
  if (savedTtlDays === undefined) delete process.env.DROPPED_CANDIDATE_TTL_DAYS;
  else process.env.DROPPED_CANDIDATE_TTL_DAYS = savedTtlDays;
  if (savedFailureLog === undefined) delete process.env.MEMORY_FAILURE_LOG;
  else process.env.MEMORY_FAILURE_LOG = savedFailureLog;
});

function makeCandidate(overrides: Partial<CandidateFact> = {}): CandidateFact {
  return {
    text: "The user prefers tabs.",
    type: "preference",
    scope: "project",
    importance: 0.5,
    observation_ids: ["obs-1", "obs-2"],
    supersedes_belief_id: null,
    ...overrides,
  };
}

describe("quarantineDroppedCandidate", () => {
  it("inserts a doc with expiresAt = created_at + configured TTL days, full text, truncated reason, and provenance", async () => {
    const insertOneFn = vi.fn(async () => ({ insertedId: "id-1" }));
    const collectionFn = vi.fn(() => ({ insertOne: insertOneFn }));
    const db = { collection: collectionFn } as any;
    const candidate = makeCandidate();
    const longReason = "x".repeat(600);

    const before = Date.now();
    await quarantineDroppedCandidate(db, "proj", "run-1", candidate, "deny-list", longReason);
    const after = Date.now();

    expect(collectionFn).toHaveBeenCalledWith(DROPPED_CANDIDATES);
    expect(insertOneFn).toHaveBeenCalledTimes(1);
    const doc = insertOneFn.mock.calls[0][0] as Record<string, unknown>;

    expect(doc.project).toBe("proj");
    expect(doc.run_id).toBe("run-1");
    expect(doc.stage).toBe("deny-list");
    expect(doc.text).toBe(candidate.text);
    expect(doc.observation_ids).toEqual(["obs-1", "obs-2"]);
    expect(doc.type).toBe("preference");
    expect(doc.scope).toBe("project");
    expect(doc.importance).toBe(0.5);

    expect(doc.reason).toHaveLength(500);
    expect(doc.reason).toBe(longReason.slice(0, 500));

    expect(doc.created_at).toBeInstanceOf(Date);
    const createdAt = doc.created_at as Date;
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(createdAt.getTime()).toBeLessThanOrEqual(after);

    expect(doc.expiresAt).toBeInstanceOf(Date);
    const expiresAt = doc.expiresAt as Date;
    expect(expiresAt.getTime()).toBe(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it("preserves the reason unchanged when it is under the 500 char cap", async () => {
    const insertOneFn = vi.fn(async () => ({ insertedId: "id-1" }));
    const db = { collection: vi.fn(() => ({ insertOne: insertOneFn })) } as any;

    await quarantineDroppedCandidate(db, "proj", "run-1", makeCandidate(), "classifier", "short reason");

    const doc = insertOneFn.mock.calls[0][0] as Record<string, unknown>;
    expect(doc.reason).toBe("short reason");
    expect(doc.stage).toBe("classifier");
  });

  it("omits type/scope/importance from the doc when absent on the candidate", async () => {
    const insertOneFn = vi.fn(async () => ({ insertedId: "id-1" }));
    const db = { collection: vi.fn(() => ({ insertOne: insertOneFn })) } as any;
    const bareCandidate = {
      text: "bare fact",
      observation_ids: ["obs-1"],
    } as unknown as CandidateFact;

    await quarantineDroppedCandidate(db, "proj", "run-1", bareCandidate, "deny-list", "reason");

    const doc = insertOneFn.mock.calls[0][0] as Record<string, unknown>;
    expect(doc).not.toHaveProperty("type");
    expect(doc).not.toHaveProperty("scope");
    expect(doc).not.toHaveProperty("importance");
    expect(doc.text).toBe("bare fact");
    expect(doc.observation_ids).toEqual(["obs-1"]);
  });

  it("swallows an insertOne rejection without throwing, and records it via appendFailure", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-quarantine-"));
    const logFile = path.join(dir, "failures.log");
    process.env.MEMORY_FAILURE_LOG = logFile;

    const insertOneFn = vi.fn(async () => {
      throw new Error("insert failed");
    });
    const db = { collection: vi.fn(() => ({ insertOne: insertOneFn })) } as any;

    await expect(
      quarantineDroppedCandidate(db, "proj", "run-1", makeCandidate(), "deny-list", "reason")
    ).resolves.toBeUndefined();

    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("quarantineDroppedCandidate");
    expect(content).toContain("Error");
  });

  it("swallows a loadConfig failure (no connection string configured) without throwing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-quarantine-noconfig-"));
    const logFile = path.join(dir, "failures.log");
    process.env.MEMORY_FAILURE_LOG = logFile;
    delete process.env.MEMORY_MONGODB_URI;
    delete process.env.MDB_MCP_CONNECTION_STRING;

    const insertOneFn = vi.fn(async () => ({ insertedId: "id-1" }));
    const db = { collection: vi.fn(() => ({ insertOne: insertOneFn })) } as any;

    await expect(
      quarantineDroppedCandidate(db, "proj", "run-1", makeCandidate(), "deny-list", "reason")
    ).resolves.toBeUndefined();

    expect(insertOneFn).not.toHaveBeenCalled();
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("quarantineDroppedCandidate");
  });
});
