import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = ["MEMORY_MONGODB_URI", "MDB_MCP_CONNECTION_STRING", "OBSERVATION_TTL_DAYS"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.MEMORY_MONGODB_URI = "mongodb://localhost:27017";
  delete process.env.MDB_MCP_CONNECTION_STRING;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function makeFakeDb() {
  const insertOne = vi.fn(async (doc: Record<string, unknown>) => ({ insertedId: "fake-id" }));
  const db = {
    collection: () => ({ insertOne }),
  };
  return { db, insertOne };
}

describe("writeObservation", () => {
  it("omits expiresAt entirely for priority 'high'", async () => {
    const { writeObservation } = await import("../src/capture/writeObservation.js");
    const { db, insertOne } = makeFakeDb();

    await writeObservation(db as any, {
      project: "myrepo-abc",
      session_id: "sess-1",
      source: "remember",
      priority: "high",
      text: "remember this",
    });

    expect(insertOne).toHaveBeenCalledTimes(1);
    const doc = insertOne.mock.calls[0][0];
    expect("expiresAt" in doc).toBe(false);
    expect(doc.status).toBe("pending");
    expect(doc.run_id).toBeNull();
    expect(doc.claimed_at).toBeNull();
    expect(doc.priority).toBe("high");
    expect(doc.source).toBe("remember");
    expect(doc.project).toBe("myrepo-abc");
    expect(doc.session_id).toBe("sess-1");
    expect(doc.created_at).toBeInstanceOf(Date);
  });

  it("sets expiresAt to roughly now + observationTtlDays for priority 'normal'", async () => {
    process.env.OBSERVATION_TTL_DAYS = "30";
    const { writeObservation } = await import("../src/capture/writeObservation.js");
    const { db, insertOne } = makeFakeDb();

    const before = Date.now();
    await writeObservation(db as any, {
      project: "myrepo-abc",
      session_id: "sess-1",
      source: "transcript",
      priority: "normal",
      text: "some transcript tail",
    });
    const after = Date.now();

    const doc = insertOne.mock.calls[0][0];
    expect(doc.expiresAt).toBeInstanceOf(Date);
    const expectedMin = before + 30 * 24 * 60 * 60 * 1000 - 5000;
    const expectedMax = after + 30 * 24 * 60 * 60 * 1000 + 5000;
    const expiresMs = (doc.expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThan(expectedMin);
    expect(expiresMs).toBeLessThan(expectedMax);
  });

  it("truncates overly long text to the max length", async () => {
    const { writeObservation } = await import("../src/capture/writeObservation.js");
    const { db, insertOne } = makeFakeDb();

    const longText = "a".repeat(30000);
    await writeObservation(db as any, {
      project: "myrepo-abc",
      session_id: "sess-1",
      source: "transcript",
      priority: "normal",
      text: longText,
    });

    const doc = insertOne.mock.calls[0][0];
    expect((doc.text as string).length).toBe(20000);
  });

  it("returns the inserted id", async () => {
    const { writeObservation } = await import("../src/capture/writeObservation.js");
    const { db } = makeFakeDb();

    const result = await writeObservation(db as any, {
      project: "myrepo-abc",
      session_id: "sess-1",
      source: "hash_line",
      priority: "high",
      text: "#remember this",
    });

    expect(result).toBe("fake-id");
  });
});
