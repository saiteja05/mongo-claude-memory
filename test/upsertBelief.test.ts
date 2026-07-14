import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ObjectId } from "mongodb";
import { upsertBelief, findSimilarBelief, findSimilarBeliefs } from "../src/consolidation/upsertBelief.js";
import type { CandidateFact } from "../src/consolidation/extractFacts.js";
import type { ReconcileVerdict } from "../src/consolidation/reconcileBelief.js";

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

  it("inserts a new belief instead of a false update when the CAS-guarded update stays contested for all 3 attempts (updateOne matchedCount 0 every time)", async () => {
    const existingId = new ObjectId().toString();
    const { db, updateOne, insertOne, findOne } = makeFakeBeliefsDb({
      aggregateResults: [{ _id: existingId, text: "old text", score: 0.97 }],
      findOneResult: { _id: existingId, text: "old text", observation_ids: ["obs-0"], version: 1 },
      updateOneResult: { matchedCount: 0, modifiedCount: 0 },
    });

    const candidate = makeCandidate({ text: "new merged text", observation_ids: ["obs-1"] });
    const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(result.action).not.toBe("update");
    expect(result.action).toBe("insert");
    // 3 CAS-guarded attempts, each re-reading the belief before retrying.
    expect(updateOne).toHaveBeenCalledTimes(3);
    expect(findOne).toHaveBeenCalledTimes(3);
    expect(insertOne).toHaveBeenCalledTimes(1);
    const [doc] = insertOne.mock.calls[0];
    expect(doc.text).toBe("new merged text");
    expect(doc.status).toBe("active");
  });

  it("retries the compare-and-swap update after a concurrent write changes the belief's version, succeeding against the freshly-read document", async () => {
    const existingId = new ObjectId().toString();
    const aggregate = vi.fn(() => ({
      toArray: async () => [{ _id: existingId, text: "old text", score: 0.97 }],
    }));
    const findOne = vi
      .fn()
      .mockResolvedValueOnce({ _id: existingId, text: "old text", observation_ids: ["obs-0"], version: 1 })
      .mockResolvedValueOnce({
        _id: existingId,
        text: "concurrently updated text",
        observation_ids: ["obs-0", "obs-99"],
        version: 2,
      });
    const updateOne = vi
      .fn()
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });
    const insertOne = vi.fn(async () => ({ insertedId: new ObjectId() }));
    const db = { collection: () => ({ aggregate, findOne, updateOne, insertOne }) };

    const candidate = makeCandidate({ text: "new merged text", observation_ids: ["obs-1"] });
    const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(result).toEqual({ beliefId: existingId, action: "update" });
    expect(insertOne).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenCalledTimes(2);

    const [firstFilter] = updateOne.mock.calls[0];
    expect(firstFilter.version).toBe(1);
    const [secondFilter, secondUpdate] = updateOne.mock.calls[1];
    expect(secondFilter.version).toBe(2);
    // Recomputed against the freshly-read document: merges the
    // concurrently-added obs-99 as well as this candidate's own obs-1.
    expect(secondUpdate.$set.observation_ids.sort()).toEqual(["obs-0", "obs-1", "obs-99"]);
    expect(secondUpdate.$set.text).toBe("new merged text");
  });

  it("falls through to the insert path when the belief has gone inactive by the time the CAS retry re-fetches it", async () => {
    const existingId = new ObjectId().toString();
    const aggregate = vi.fn(() => ({
      toArray: async () => [{ _id: existingId, text: "old text", score: 0.97 }],
    }));
    const findOne = vi
      .fn()
      .mockResolvedValueOnce({ _id: existingId, text: "old text", observation_ids: ["obs-0"], version: 1 })
      .mockResolvedValueOnce(null);
    const updateOne = vi.fn().mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
    const insertOne = vi.fn(async () => ({ insertedId: new ObjectId() }));
    const db = { collection: () => ({ aggregate, findOne, updateOne, insertOne }) };

    const candidate = makeCandidate({ text: "new merged text", observation_ids: ["obs-1"] });
    const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

    expect(result.action).toBe("insert");
    // Only one CAS attempt: the retry's re-fetch came back null (no longer
    // active), so the loop stops instead of retrying against nothing.
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(insertOne).toHaveBeenCalledTimes(1);
    const [doc] = insertOne.mock.calls[0];
    expect(doc.text).toBe("new merged text");
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
  describe("embeddingMode auto", () => {
    it("findSimilarBelief runs the dedupe $vectorSearch against beliefs_vec_auto with a text query instead of a queryVector", async () => {
      const { db, aggregate } = makeFakeBeliefsDb({ aggregateResults: [] });

      await findSimilarBelief(db as any, "proj", "project", [0.1, 0.2], 0.93, {
        mode: "auto",
        model: "voyage-4",
        queryText: "the user prefers tabs",
      });

      const [pipeline] = aggregate.mock.calls[0];
      expect((pipeline[0] as any).$vectorSearch).toMatchObject({
        index: "beliefs_vec_auto",
        path: "text",
        query: { text: "the user prefers tabs" },
        model: "voyage-4",
      });
      expect((pipeline[0] as any).$vectorSearch.queryVector).toBeUndefined();
    });

    it("upsertBelief in auto mode uses candidate.text as the dedupe query and passes the mode/model through", async () => {
      const { db, aggregate } = makeFakeBeliefsDb({ aggregateResults: [] });

      const candidate = makeCandidate({ text: "the user prefers tabs" });
      await upsertBelief(db as any, "proj", candidate, null, 0.93, {
        mode: "auto",
        model: "voyage-4",
      });

      const [pipeline] = aggregate.mock.calls[0];
      expect((pipeline[0] as any).$vectorSearch).toMatchObject({
        index: "beliefs_vec_auto",
        query: { text: "the user prefers tabs" },
        model: "voyage-4",
      });
    });

    it("does not write an embedding field on insert when embeddingMode is auto", async () => {
      const { db, insertOne } = makeFakeBeliefsDb({ aggregateResults: [] });

      const candidate = makeCandidate();
      await upsertBelief(db as any, "proj", candidate, null, 0.93, { mode: "auto" });

      expect(insertOne).toHaveBeenCalledTimes(1);
      const [doc] = insertOne.mock.calls[0];
      expect(Object.prototype.hasOwnProperty.call(doc, "embedding")).toBe(false);
    });

    it("does not write an embedding field on the supersede insert path when embeddingMode is auto", async () => {
      const oldId = new ObjectId().toString();
      const { db, insertOne } = makeFakeBeliefsDb({
        findOneResult: { _id: oldId, project: "proj", status: "active", text: "outdated fact" },
      });

      const candidate = makeCandidate({ text: "corrected fact", supersedes_belief_id: oldId });
      await upsertBelief(db as any, "proj", candidate, null, 0.93, { mode: "auto" });

      expect(insertOne).toHaveBeenCalledTimes(1);
      const [doc] = insertOne.mock.calls[0];
      expect(Object.prototype.hasOwnProperty.call(doc, "embedding")).toBe(false);
    });

    it("still writes an embedding field on insert in the default appside mode", async () => {
      const { db, insertOne } = makeFakeBeliefsDb({ aggregateResults: [] });

      const candidate = makeCandidate();
      await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93);

      const [doc] = insertOne.mock.calls[0];
      expect(doc.embedding).toEqual([0.1, 0.2]);
    });
  });

  describe("evidence recency (last_evidence_at)", () => {
    const older = new Date("2026-07-01T00:00:00Z");
    const newer = new Date("2026-07-05T00:00:00Z");

    it("stamps last_evidence_at from candidateEvidenceAt on insert", async () => {
      const { db, insertOne } = makeFakeBeliefsDb({ aggregateResults: [] });

      await upsertBelief(db as any, "proj", makeCandidate(), [0.1, 0.2], 0.93, {}, newer);

      const [doc] = insertOne.mock.calls[0];
      expect(doc.last_evidence_at).toEqual(newer);
    });

    it("overwrites text (and advances last_evidence_at) when the candidate's evidence is newer than the existing belief's", async () => {
      const existingId = new ObjectId().toString();
      const { db, updateOne } = makeFakeBeliefsDb({
        aggregateResults: [{ _id: existingId, text: "old text", score: 0.97 }],
        findOneResult: {
          _id: existingId,
          text: "old text",
          observation_ids: ["obs-0"],
          last_evidence_at: older,
        },
      });

      const candidate = makeCandidate({ text: "corrected text", observation_ids: ["obs-1"] });
      const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93, {}, newer);

      expect(result.action).toBe("update");
      const [, update] = updateOne.mock.calls[0];
      expect(update.$set.text).toBe("corrected text");
      expect(update.$set.last_evidence_at).toEqual(newer);
      expect(update.$inc.version).toBe(1);
    });

    it("skips the text overwrite (but still merges observation_ids and bumps version) when the candidate's evidence is older, logging one stderr line", async () => {
      const existingId = new ObjectId().toString();
      const { db, updateOne } = makeFakeBeliefsDb({
        aggregateResults: [{ _id: existingId, text: "newer corrected text", score: 0.97 }],
        findOneResult: {
          _id: existingId,
          text: "newer corrected text",
          observation_ids: ["obs-0"],
          last_evidence_at: newer,
        },
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const candidate = makeCandidate({ text: "stale replayed text", observation_ids: ["obs-1"] });
      const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93, {}, older);

      expect(result.action).toBe("update");
      const [, update] = updateOne.mock.calls[0];
      // Text must NOT regress to the stale replay; last_evidence_at must not
      // move backward either.
      expect(update.$set).not.toHaveProperty("text");
      expect(update.$set).not.toHaveProperty("last_evidence_at");
      // Provenance still accumulates and version still bumps.
      expect(update.$set.observation_ids.sort()).toEqual(["obs-0", "obs-1"]);
      expect(update.$inc.version).toBe(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain("skipped stale text overwrite");

      errorSpy.mockRestore();
    });

    it("treats a missing last_evidence_at on the existing belief as epoch 0, so the first stamped write wins", async () => {
      const existingId = new ObjectId().toString();
      const { db, updateOne } = makeFakeBeliefsDb({
        aggregateResults: [{ _id: existingId, text: "old unstamped text", score: 0.97 }],
        findOneResult: {
          _id: existingId,
          text: "old unstamped text",
          observation_ids: ["obs-0"],
          // no last_evidence_at field at all (pre-migration belief)
        },
      });

      const candidate = makeCandidate({ text: "first stamped text", observation_ids: ["obs-1"] });
      await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93, {}, older);

      const [, update] = updateOne.mock.calls[0];
      expect(update.$set.text).toBe("first stamped text");
      expect(update.$set.last_evidence_at).toEqual(older);
    });
  });

  describe("insert-path reconciliation", () => {
    // Below the dedupe threshold (0.93) but at or above a typical reconcile
    // threshold (0.75), so the same fake aggregate results exercise both
    // probes: the dedupe probe filters this out (similar stays null) while
    // the reconcile probe keeps it (near has one entry).
    const reconcileThreshold = 0.75;
    const nearScore = 0.8;

    it("does not call the injected reconcile fn when the reconcile probe finds no near matches (plain insert runs)", async () => {
      const { db, aggregate, insertOne } = makeFakeBeliefsDb({ aggregateResults: [] });
      const reconcile = vi.fn(async (): Promise<ReconcileVerdict[]> => []);

      const result = await upsertBelief(
        db as any,
        "proj",
        makeCandidate(),
        [0.1, 0.2],
        0.93,
        {},
        undefined,
        { threshold: reconcileThreshold, reconcile }
      );

      expect(result.action).toBe("insert");
      // dedupe probe + reconcile probe, both empty.
      expect(aggregate).toHaveBeenCalledTimes(2);
      expect(reconcile).not.toHaveBeenCalled();
      expect(insertOne).toHaveBeenCalledTimes(1);
    });

    it("archives the target via a status-filtered CAS updateOne and inserts the new belief with a supersedes pointer on a 'supersedes' verdict", async () => {
      const targetId = new ObjectId().toString();
      const { db, aggregate, updateOne, insertOne } = makeFakeBeliefsDb({
        aggregateResults: [{ _id: targetId, text: "old rate-limit fact", score: nearScore }],
      });
      const reconcile = vi.fn(
        async (): Promise<ReconcileVerdict[]> => [{ beliefId: targetId, verdict: "supersedes" }]
      );

      const candidate = makeCandidate({ text: "the rate limit is actually 20 requests/sec" });
      const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93, {}, undefined, {
        threshold: reconcileThreshold,
        reconcile,
      });

      expect(aggregate).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledWith(candidate.text, [
        { _id: targetId, text: "old rate-limit fact", score: nearScore },
      ]);
      expect(updateOne).toHaveBeenCalledTimes(1);
      const [archiveFilter, archiveUpdate] = updateOne.mock.calls[0];
      expect(archiveFilter.project).toBe("proj");
      expect(archiveFilter.status).toBe("active");
      expect(String(archiveFilter._id)).toBe(targetId);
      expect(archiveUpdate.$set.status).toBe("archived");
      expect(archiveUpdate.$inc.version).toBe(1);
      expect(insertOne).toHaveBeenCalledTimes(1);
      const [doc] = insertOne.mock.calls[0];
      expect(doc.supersedes).toBe(targetId);
      expect(doc.text).toBe(candidate.text);
      expect(doc.status).toBe("active");
      expect(result.action).toBe("supersede");
    });

    it("falls through to a plain insert with no supersedes pointer when the 'supersedes' archive's CAS matchedCount is 0 (archived meanwhile)", async () => {
      const targetId = new ObjectId().toString();
      const { db, updateOne, insertOne } = makeFakeBeliefsDb({
        aggregateResults: [{ _id: targetId, text: "old rate-limit fact", score: nearScore }],
        updateOneResult: { matchedCount: 0, modifiedCount: 0 },
      });
      const reconcile = vi.fn(
        async (): Promise<ReconcileVerdict[]> => [{ beliefId: targetId, verdict: "supersedes" }]
      );

      const candidate = makeCandidate({ text: "the rate limit is actually 20 requests/sec" });
      const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93, {}, undefined, {
        threshold: reconcileThreshold,
        reconcile,
      });

      expect(updateOne).toHaveBeenCalledTimes(1);
      expect(insertOne).toHaveBeenCalledTimes(1);
      const [doc] = insertOne.mock.calls[0];
      expect(doc.supersedes).toBeNull();
      expect(result.action).toBe("insert");
    });

    it("routes a 'duplicate' verdict through the merge path (action 'update')", async () => {
      const targetId = new ObjectId().toString();
      const { db, aggregate, findOne, updateOne, insertOne } = makeFakeBeliefsDb({
        aggregateResults: [{ _id: targetId, text: "old rate-limit fact", score: nearScore }],
        findOneResult: {
          _id: targetId,
          text: "old rate-limit fact",
          observation_ids: ["obs-0"],
          version: 1,
        },
      });
      const reconcile = vi.fn(
        async (): Promise<ReconcileVerdict[]> => [{ beliefId: targetId, verdict: "duplicate" }]
      );

      const candidate = makeCandidate({ text: "the rate limit is 20 requests/sec", observation_ids: ["obs-1"] });
      const result = await upsertBelief(db as any, "proj", candidate, [0.1, 0.2], 0.93, {}, undefined, {
        threshold: reconcileThreshold,
        reconcile,
      });

      expect(aggregate).toHaveBeenCalledTimes(2);
      expect(findOne).toHaveBeenCalledTimes(1);
      expect(updateOne).toHaveBeenCalledTimes(1);
      expect(insertOne).not.toHaveBeenCalled();
      expect(result).toEqual({ beliefId: targetId, action: "update" });
    });

    it("produces a plain insert on an 'unrelated' verdict", async () => {
      const targetId = new ObjectId().toString();
      const { db, updateOne, insertOne } = makeFakeBeliefsDb({
        aggregateResults: [{ _id: targetId, text: "unrelated fact", score: nearScore }],
      });
      const reconcile = vi.fn(
        async (): Promise<ReconcileVerdict[]> => [{ beliefId: targetId, verdict: "unrelated" }]
      );

      const result = await upsertBelief(db as any, "proj", makeCandidate(), [0.1, 0.2], 0.93, {}, undefined, {
        threshold: reconcileThreshold,
        reconcile,
      });

      expect(updateOne).not.toHaveBeenCalled();
      expect(insertOne).toHaveBeenCalledTimes(1);
      expect(result.action).toBe("insert");
    });

    it("produces a plain insert and logs via appendFailure when the injected reconcile fn throws", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-upsert-reconcile-"));
      const logFile = path.join(dir, "failures.log");
      const savedLog = process.env.MEMORY_FAILURE_LOG;
      process.env.MEMORY_FAILURE_LOG = logFile;

      try {
        const targetId = new ObjectId().toString();
        const { db, insertOne } = makeFakeBeliefsDb({
          aggregateResults: [{ _id: targetId, text: "some fact", score: nearScore }],
        });
        const reconcile = vi.fn(async (): Promise<ReconcileVerdict[]> => {
          throw new Error("reconcile provider timed out");
        });

        const result = await upsertBelief(db as any, "proj", makeCandidate(), [0.1, 0.2], 0.93, {}, undefined, {
          threshold: reconcileThreshold,
          reconcile,
        });

        expect(insertOne).toHaveBeenCalledTimes(1);
        expect(result.action).toBe("insert");
        const content = readFileSync(logFile, "utf8");
        expect(content).toContain("reconcileBelief.upsert");
      } finally {
        if (savedLog === undefined) delete process.env.MEMORY_FAILURE_LOG;
        else process.env.MEMORY_FAILURE_LOG = savedLog;
      }
    });

    it("produces a plain insert when the injected reconcile fn resolves with an empty verdict list", async () => {
      const targetId = new ObjectId().toString();
      const { db, updateOne, insertOne } = makeFakeBeliefsDb({
        aggregateResults: [{ _id: targetId, text: "some fact", score: nearScore }],
      });
      const reconcile = vi.fn(async (): Promise<ReconcileVerdict[]> => []);

      const result = await upsertBelief(db as any, "proj", makeCandidate(), [0.1, 0.2], 0.93, {}, undefined, {
        threshold: reconcileThreshold,
        reconcile,
      });

      expect(updateOne).not.toHaveBeenCalled();
      expect(insertOne).toHaveBeenCalledTimes(1);
      expect(result.action).toBe("insert");
    });

    it("makes exactly one aggregate call (the dedupe probe) and leaves behavior unchanged when reconcileOptions is absent", async () => {
      const { db, aggregate, insertOne } = makeFakeBeliefsDb({ aggregateResults: [] });

      const result = await upsertBelief(db as any, "proj", makeCandidate(), [0.1, 0.2], 0.93);

      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(insertOne).toHaveBeenCalledTimes(1);
      expect(result.action).toBe("insert");
    });

    it("short-circuits with no second aggregate call when reconcileOptions.threshold is >= 1", async () => {
      const { db, aggregate, insertOne } = makeFakeBeliefsDb({ aggregateResults: [] });
      const reconcile = vi.fn(async (): Promise<ReconcileVerdict[]> => []);

      const result = await upsertBelief(db as any, "proj", makeCandidate(), [0.1, 0.2], 0.93, {}, undefined, {
        threshold: 1,
        reconcile,
      });

      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
      expect(insertOne).toHaveBeenCalledTimes(1);
      expect(result.action).toBe("insert");
    });

    it("findSimilarBeliefs returns up to k results filtered by threshold, and findSimilarBelief still returns the top-1 match or null", async () => {
      const idHigh = new ObjectId().toString();
      const idMid = new ObjectId().toString();
      const idLow = new ObjectId().toString();
      const { db, aggregate } = makeFakeBeliefsDb({
        aggregateResults: [
          { _id: idHigh, text: "high match", score: 0.95 },
          { _id: idMid, text: "mid match", score: 0.8 },
          { _id: idLow, text: "low match", score: 0.4 },
        ],
      });

      const results = await findSimilarBeliefs(db as any, "proj", "project", [0.1, 0.2], reconcileThreshold, 3);

      expect(results).toEqual([
        { _id: idHigh, text: "high match", score: 0.95 },
        { _id: idMid, text: "mid match", score: 0.8 },
      ]);
      const [pipeline] = aggregate.mock.calls[0];
      expect((pipeline[0] as any).$vectorSearch.limit).toBe(3);
      expect((pipeline[0] as any).$vectorSearch.numCandidates).toBe(100);

      const top = await findSimilarBelief(db as any, "proj", "project", [0.1, 0.2], reconcileThreshold);
      expect(top).toEqual({ _id: idHigh, text: "high match", score: 0.95 });

      const { db: dbEmpty } = makeFakeBeliefsDb({ aggregateResults: [] });
      const none = await findSimilarBelief(dbEmpty as any, "proj", "project", [0.1, 0.2], 0.93);
      expect(none).toBeNull();
    });
  });
});
