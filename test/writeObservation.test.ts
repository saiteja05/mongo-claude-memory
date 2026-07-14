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
  const insertMany = vi.fn(async (docs: Record<string, unknown>[]) => ({
    insertedIds: Object.fromEntries(docs.map((_, index) => [index, `fake-id-${index}`])),
  }));
  const db = {
    collection: () => ({ insertOne, insertMany }),
  };
  return { db, insertOne, insertMany };
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

  it("keeps the END of an over-length transcript observation (the most recent content matters)", async () => {
    const { writeObservation } = await import("../src/capture/writeObservation.js");
    const { db, insertOne } = makeFakeDb();

    // 10k of "a" followed by 50k of "b": the clamp must keep the last 50k
    // (all "b"), never the first 50k.
    const longText = "a".repeat(10000) + "b".repeat(50000);
    await writeObservation(db as any, {
      project: "myrepo-abc",
      session_id: "sess-1",
      source: "transcript",
      priority: "normal",
      text: longText,
    });

    const doc = insertOne.mock.calls[0][0];
    const text = doc.text as string;
    expect(text.length).toBe(50000);
    expect(text).toBe("b".repeat(50000));
  });

  it("keeps the BEGINNING of an over-length user-authored observation (remember)", async () => {
    const { writeObservation } = await import("../src/capture/writeObservation.js");
    const { db, insertOne } = makeFakeDb();

    // 50k of "a" followed by 10k of "b": user-authored captures lead with the
    // point, so the clamp must keep the first 50k (all "a").
    const longText = "a".repeat(50000) + "b".repeat(10000);
    await writeObservation(db as any, {
      project: "myrepo-abc",
      session_id: "sess-1",
      source: "remember",
      priority: "high",
      text: longText,
    });

    const doc = insertOne.mock.calls[0][0];
    const text = doc.text as string;
    expect(text.length).toBe(50000);
    expect(text).toBe("a".repeat(50000));
  });

  it("shares its clamp constant with sessionEnd's transcript tail length so they cannot diverge", async () => {
    const { MAX_OBSERVATION_TEXT_LENGTH, TRANSCRIPT_TAIL_LENGTH } = await import(
      "../src/capture/constants.js"
    );
    expect(MAX_OBSERVATION_TEXT_LENGTH).toBe(TRANSCRIPT_TAIL_LENGTH);
    expect(TRANSCRIPT_TAIL_LENGTH).toBe(50000);
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

  it("omits chunk_index and chunk_count entirely when not provided", async () => {
    const { writeObservation } = await import("../src/capture/writeObservation.js");
    const { db, insertOne } = makeFakeDb();

    await writeObservation(db as any, {
      project: "myrepo-abc",
      session_id: "sess-1",
      source: "transcript",
      priority: "normal",
      text: "some content",
    });

    const doc = insertOne.mock.calls[0][0];
    expect("chunk_index" in doc).toBe(false);
    expect("chunk_count" in doc).toBe(false);
  });

  it("writes chunk_index and chunk_count when provided", async () => {
    const { writeObservation } = await import("../src/capture/writeObservation.js");
    const { db, insertOne } = makeFakeDb();

    await writeObservation(db as any, {
      project: "myrepo-abc",
      session_id: "sess-1",
      source: "transcript",
      priority: "normal",
      text: "some content",
      chunk_index: 2,
      chunk_count: 5,
    });

    const doc = insertOne.mock.calls[0][0];
    expect(doc.chunk_index).toBe(2);
    expect(doc.chunk_count).toBe(5);
  });
});

describe("writeObservationsBulk", () => {
  it("issues exactly one insertMany for a list of params", async () => {
    const { writeObservationsBulk } = await import("../src/capture/writeObservation.js");
    const { db, insertMany } = makeFakeDb();

    await writeObservationsBulk(db as any, [
      {
        project: "myrepo-abc",
        session_id: "sess-1",
        source: "transcript",
        priority: "normal",
        text: "chunk one",
        chunk_index: 0,
        chunk_count: 2,
      },
      {
        project: "myrepo-abc",
        session_id: "sess-1",
        source: "transcript",
        priority: "normal",
        text: "chunk two",
        chunk_index: 1,
        chunk_count: 2,
      },
    ]);

    expect(insertMany).toHaveBeenCalledTimes(1);
    const docs = insertMany.mock.calls[0][0] as Record<string, unknown>[];
    expect(docs).toHaveLength(2);
    const options = insertMany.mock.calls[0][1] as Record<string, unknown>;
    expect(options.ordered).toBe(true);
  });

  it("applies the same source-aware clamp per doc as writeObservation", async () => {
    const { writeObservationsBulk } = await import("../src/capture/writeObservation.js");
    const { db, insertMany } = makeFakeDb();

    // Transcript chunk keeps its END; remember (user-authored) keeps its
    // BEGINNING, same rule as the single-write path.
    const longTranscript = "a".repeat(10000) + "b".repeat(50000);
    const longRemember = "c".repeat(50000) + "d".repeat(10000);

    await writeObservationsBulk(db as any, [
      {
        project: "myrepo-abc",
        session_id: "sess-1",
        source: "transcript",
        priority: "normal",
        text: longTranscript,
      },
      {
        project: "myrepo-abc",
        session_id: "sess-1",
        source: "remember",
        priority: "high",
        text: longRemember,
      },
    ]);

    const docs = insertMany.mock.calls[0][0] as Array<{ text: string }>;
    expect(docs[0].text).toBe("b".repeat(50000));
    expect(docs[1].text).toBe("c".repeat(50000));
  });

  it("stamps created_at values strictly increasing by one millisecond per entry", async () => {
    const { writeObservationsBulk } = await import("../src/capture/writeObservation.js");
    const { db, insertMany } = makeFakeDb();

    await writeObservationsBulk(
      db as any,
      Array.from({ length: 4 }, (_, index) => ({
        project: "myrepo-abc",
        session_id: "sess-1",
        source: "transcript" as const,
        priority: "normal" as const,
        text: `chunk ${index}`,
        chunk_index: index,
        chunk_count: 4,
      }))
    );

    const docs = insertMany.mock.calls[0][0] as Array<{ created_at: Date }>;
    for (let i = 1; i < docs.length; i++) {
      expect(docs[i].created_at.getTime()).toBe(docs[i - 1].created_at.getTime() + 1);
    }
  });

  it("persists chunk_index and chunk_count when present, and omits both when absent", async () => {
    const { writeObservationsBulk } = await import("../src/capture/writeObservation.js");
    const { db, insertMany } = makeFakeDb();

    await writeObservationsBulk(db as any, [
      {
        project: "myrepo-abc",
        session_id: "sess-1",
        source: "transcript",
        priority: "normal",
        text: "with chunk fields",
        chunk_index: 0,
        chunk_count: 1,
      },
      {
        project: "myrepo-abc",
        session_id: "sess-2",
        source: "remember",
        priority: "high",
        text: "no chunk fields",
      },
    ]);

    const docs = insertMany.mock.calls[0][0] as Record<string, unknown>[];
    expect(docs[0].chunk_index).toBe(0);
    expect(docs[0].chunk_count).toBe(1);
    expect("chunk_index" in docs[1]).toBe(false);
    expect("chunk_count" in docs[1]).toBe(false);
  });

  it("sets a per-doc TTL for normal priority and omits expiresAt for high priority", async () => {
    process.env.OBSERVATION_TTL_DAYS = "30";
    const { writeObservationsBulk } = await import("../src/capture/writeObservation.js");
    const { db, insertMany } = makeFakeDb();

    await writeObservationsBulk(db as any, [
      {
        project: "myrepo-abc",
        session_id: "sess-1",
        source: "transcript",
        priority: "normal",
        text: "expires",
      },
      {
        project: "myrepo-abc",
        session_id: "sess-1",
        source: "remember",
        priority: "high",
        text: "never expires",
      },
    ]);

    const docs = insertMany.mock.calls[0][0] as Array<{ expiresAt?: Date }>;
    expect(docs[0].expiresAt).toBeInstanceOf(Date);
    expect("expiresAt" in docs[1]).toBe(false);
  });
});
