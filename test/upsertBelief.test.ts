import { describe, it, expect, vi } from "vitest";
import { ObjectId } from "mongodb";
import { upsertBelief, findSimilarBelief } from "../src/consolidation/upsertBelief.js";
import type { CandidateFact } from "../src/consolidation/extractFacts.js";

function makeCandidate(overrides: Partial<CandidateFact> = {}): CandidateFact {
  return {
    text: "The user prefers tabs over spaces.",
    type: "preference",
    scope: "project",
    importance: 0.6,
    observation_ids: ["obs-1"],
    supersedes_belief_id: null,
    ...overrides,
  };
}

function makeFakeBeliefsDb(opts: {
  aggregateResults?: unknown[];
  findOneResult?: Record<string, unknown> | null;
  updateOneResult?: { matchedCount: number; modifiedCount: number };
}) {
  const aggregate = vi.fn(() => ({ toArray: async () => opts.aggregateResults ?? [] }));
  const findOne = vi.fn(async () => opts.findOneResult ?? null);
  const updateOne = vi.fn(async () => opts.updateOneResult ?? { matchedCount: 1, modifiedCount: 1 });
  const insertOne = vi.fn(async () => ({ insertedId: new ObjectId() }));
  const db = { collection: () => ({ aggregate, findOne, updateOne, insertOne }) };
  return { db, aggregate, findOne, updateOne, insertOne };
}

describe("findSimilarBelief", () => {
  it("returns the top match when its score exceeds the threshold", async () => {
    const id = new ObjectId().toString();
    const { db } = makeFakeBeliefsDb({
      aggregateResults: [{ _id: id, text: "old fact", score: 0.97 }],
    });

    const result = await findSimilarBelief(db as any, "proj", "project", [0.1, 0.2], 0.93);

    expect(result).toEqual({ _id: id, text: "old fact", score: 0.97 });
  });

  it("returns null when the top match is below the threshold", async () => {
    const { db } = makeFakeBeliefsDb({
      aggregateResults: [{ _id: new ObjectId().toString(), text: "old fact", score: 0.5 }],
    });

    const result = await findSimilarBelief(db as any, "proj", "project", [0.1, 0.2], 0.93);

    expect(result).toBeNull();
  });

  it("returns null when there are no active beliefs yet", async () => {
    const { db } = makeFakeBeliefsDb({ aggregateResults: [] });
    const result = await findSimilarBelief(db as any, "proj", "project", [0.1, 0.2], 0.93);
    expect(result).toBeNull();
  });

  it("filters by scope core with no project constraint when the candidate's scope is core", async () => {
    const { db, aggregate } = makeFakeBeliefsDb({ aggregateResults: [] });

    await findSimilarBelief(db as any, "proj", "core", [0.1, 0.2], 0.93);

    const [pipeline] = aggregate.mock.calls[0];
    expect((pipeline[0] as any).$vectorSearch.filter).toEqual({ scope: "core", status: "active" });
  });

  it("filters by project AND scope project (never just project) when the candidate's scope is project", async () => {
    const { db, aggregate } = makeFakeBeliefsDb({ aggregateResults: [] });

    await findSimilarBelief(db as any, "proj", "project", [0.1, 0.2], 0.93);

    const [pipeline] = aggregate.mock.calls[0];
    expect((pipeline[0] as any).$vectorSearch.filter).toEqual({
      project: "proj",
      scope: "project",
      status: "active",
    });
  });
});

describe("upsertBelief", () => {
  it("updates the existing belief in place on a high-similarity match", async () => {
    const existingId = new ObjectId().toString();
    const { db, updateOne, insertOne, aggregate } = makeFakeBeliefsDb({
      aggregateResults: [{ _id: existingId, text: "old text", score: 0.97 }],
      findOneResult: { _id: existingId, text: "old text", observation_ids: ["obs-0"] },
    });

    const candidate = makeCandidate({ text: "new merged text", observation_ids: ["obs-1"] });
    const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(result).toEqual({ beliefId: existingId, action: "update" });
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(insertOne).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.text).toBe("new merged text");
    expect(update.$set.observation_ids.sort()).toEqual(["obs-0", "obs-1"]);
    expect(update.$inc.version).toBe(1);
  });

  it("inserts a new belief instead of a false update when the matched belief was archived or tombstoned concurrently (updateOne matchedCount 0)", async () => {
    const existingId = new ObjectId().toString();
    const { db, updateOne, insertOne } = makeFakeBeliefsDb({
      aggregateResults: [{ _id: existingId, text: "old text", score: 0.97 }],
      findOneResult: { _id: existingId, text: "old text", observation_ids: ["obs-0"] },
      updateOneResult: { matchedCount: 0, modifiedCount: 0 },
    });

    const candidate = makeCandidate({ text: "new merged text", observation_ids: ["obs-1"] });
    const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(result.action).not.toBe("update");
    expect(result.action).toBe("insert");
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(insertOne).toHaveBeenCalledTimes(1);
    const [doc] = insertOne.mock.calls[0];
    expect(doc.text).toBe("new merged text");
    expect(doc.status).toBe("active");
  });

  it("inserts a new belief when there is no close match", async () => {
    const { db, updateOne, insertOne } = makeFakeBeliefsDb({ aggregateResults: [] });

    const candidate = makeCandidate();
    const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(result.action).toBe("insert");
    expect(updateOne).not.toHaveBeenCalled();
    expect(insertOne).toHaveBeenCalledTimes(1);
    const [doc] = insertOne.mock.calls[0];
    expect(doc.project).toBe("proj");
    expect(doc.text).toBe(candidate.text);
    expect(doc.status).toBe("active");
    expect(doc.use_count).toBe(0);
    expect(doc.version).toBe(1);
    expect(doc.observation_ids).toEqual(["obs-1"]);
  });

  it("inserts a new belief when the top match is below the dedupe threshold", async () => {
    const { db, insertOne } = makeFakeBeliefsDb({
      aggregateResults: [{ _id: new ObjectId().toString(), text: "unrelated", score: 0.4 }],
    });

    const result = await upsertBelief(db as any, "proj", makeCandidate(), [0.1, 0.2], 0.93);

    expect(result.action).toBe("insert");
    expect(insertOne).toHaveBeenCalledTimes(1);
  });

  it("archives the old belief and inserts a new one when supersedes_belief_id resolves to an active belief", async () => {
    const oldId = new ObjectId().toString();
    const { db, updateOne, insertOne, aggregate } = makeFakeBeliefsDb({
      findOneResult: { _id: oldId, project: "proj", status: "active", text: "outdated fact" },
    });

    const candidate = makeCandidate({
      text: "corrected fact",
      supersedes_belief_id: oldId,
    });
    const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(result.action).toBe("supersede");
    expect(aggregate).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(update.$set.status).toBe("archived");
    expect(insertOne).toHaveBeenCalledTimes(1);
    const [doc] = insertOne.mock.calls[0];
    expect(doc.supersedes).toBe(oldId);
    expect(doc.text).toBe("corrected fact");
    expect(doc.status).toBe("active");
  });

  it("falls back to the dedupe path when supersedes_belief_id does not resolve to an active belief", async () => {
    const { db, aggregate, insertOne } = makeFakeBeliefsDb({
      findOneResult: null, // old belief lookup finds nothing (already archived/gone)
      aggregateResults: [],
    });

    const candidate = makeCandidate({ supersedes_belief_id: new ObjectId().toString() });
    const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("insert");
    expect(insertOne).toHaveBeenCalledTimes(1);
  });

  it("increments version (in addition to setting status archived) when archiving the superseded belief in the supersede path", async () => {
    const oldId = new ObjectId().toString();
    const { db, updateOne } = makeFakeBeliefsDb({
      findOneResult: { _id: oldId, project: "proj", status: "active", text: "outdated fact" },
    });

    const candidate = makeCandidate({ text: "corrected fact", supersedes_belief_id: oldId });
    await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.status).toBe("archived");
    expect(update.$inc.version).toBe(1);
  });

  it("passes a scope core candidate's scope through to findSimilarBelief so the vector search filter has no project constraint", async () => {
    const { db, aggregate } = makeFakeBeliefsDb({ aggregateResults: [] });

    const candidate = makeCandidate({ scope: "core" });
    await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    const [pipeline] = aggregate.mock.calls[0];
    expect((pipeline[0] as any).$vectorSearch.filter).toEqual({ scope: "core", status: "active" });
  });

  it("passes a scope project candidate's scope through to findSimilarBelief so the vector search filter includes both project and scope", async () => {
    const { db, aggregate } = makeFakeBeliefsDb({ aggregateResults: [] });

    const candidate = makeCandidate({ scope: "project" });
    await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    const [pipeline] = aggregate.mock.calls[0];
    expect((pipeline[0] as any).$vectorSearch.filter).toEqual({
      project: "proj",
      scope: "project",
      status: "active",
    });
  });
});
