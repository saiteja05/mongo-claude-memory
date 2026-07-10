import { describe, it, expect, vi } from "vitest";
import { getStatusReport, formatStatusReport } from "../src/consolidation/status.js";
import { OBSERVATIONS, BELIEFS, BRIEFS, LOCKS } from "../src/db/schema.js";

function makeFakeDb(opts: {
  observationGroups?: unknown[];
  staleClaimCount?: number;
  beliefGroups?: unknown[];
  locks?: Record<string, unknown>[];
  briefs?: Record<string, unknown>[];
}) {
  const countDocuments = vi.fn(async () => opts.staleClaimCount ?? 0);

  const observationsCollection = {
    aggregate: vi.fn(() => ({ toArray: async () => opts.observationGroups ?? [] })),
    countDocuments,
  };
  const beliefsCollection = {
    aggregate: vi.fn(() => ({ toArray: async () => opts.beliefGroups ?? [] })),
  };
  const locksCollection = {
    find: vi.fn(() => ({ toArray: async () => opts.locks ?? [] })),
  };
  const briefsCollection = {
    find: vi.fn(() => ({ toArray: async () => opts.briefs ?? [] })),
  };

  const collections: Record<string, unknown> = {
    [OBSERVATIONS]: observationsCollection,
    [BELIEFS]: beliefsCollection,
    [LOCKS]: locksCollection,
    [BRIEFS]: briefsCollection,
  };

  const db = { collection: (name: string) => collections[name] };
  return { db, observationsCollection, beliefsCollection, locksCollection, briefsCollection };
}

describe("getStatusReport", () => {
  it("is read-only: never calls updateMany/updateOne/deleteMany on any collection", async () => {
    const { db, observationsCollection, beliefsCollection } = makeFakeDb({});
    (observationsCollection as any).updateMany = vi.fn();
    (beliefsCollection as any).updateOne = vi.fn();

    await getStatusReport(db as any, 600000);

    expect((observationsCollection as any).updateMany).not.toHaveBeenCalled();
    expect((beliefsCollection as any).updateOne).not.toHaveBeenCalled();
  });

  it("maps grouped observation and belief counts by project/status", async () => {
    const { db } = makeFakeDb({
      observationGroups: [
        { _id: { project: "proj-a", status: "pending" }, count: 3 },
        { _id: { project: "proj-a", status: "consolidated" }, count: 7 },
      ],
      beliefGroups: [{ _id: { project: "proj-a", status: "active" }, count: 5 }],
    });

    const report = await getStatusReport(db as any, 600000);

    expect(report.observationCounts).toEqual([
      { project: "proj-a", status: "pending", count: 3 },
      { project: "proj-a", status: "consolidated", count: 7 },
    ]);
    expect(report.beliefCounts).toEqual([{ project: "proj-a", status: "active", count: 5 }]);
  });

  it("counts stale claims via countDocuments with the reclaim threshold, without mutating them", async () => {
    const { db, observationsCollection } = makeFakeDb({ staleClaimCount: 4 });

    const report = await getStatusReport(db as any, 600000);

    expect(report.staleClaimCount).toBe(4);
    const [filter] = observationsCollection.countDocuments.mock.calls[0];
    expect(filter.status).toBe("claimed");
    expect(filter.claimed_at.$lt).toBeInstanceOf(Date);
  });

  it("maps locks, stripping the consolidate: prefix and computing live from heldUntil", async () => {
    const now = Date.now();
    const { db } = makeFakeDb({
      locks: [
        { _id: "consolidate:proj-a", holder: "run-1", heldUntil: new Date(now + 60000) },
        { _id: "consolidate:proj-b", holder: "run-2", heldUntil: new Date(now - 60000) },
      ],
    });

    const report = await getStatusReport(db as any, 600000);

    expect(report.locks).toEqual([
      { project: "proj-a", holder: "run-1", heldUntil: new Date(now + 60000), live: true },
      { project: "proj-b", holder: "run-2", heldUntil: new Date(now - 60000), live: false },
    ]);
  });

  it("maps briefs to id/tokenEstimate/beliefCount/generation/generatedAt", async () => {
    const generatedAt = new Date();
    const { db } = makeFakeDb({
      briefs: [
        {
          _id: "brief:global",
          token_estimate: 200,
          belief_ids: ["b-1", "b-2"],
          generation: 3,
          generated_at: generatedAt,
        },
      ],
    });

    const report = await getStatusReport(db as any, 600000);

    expect(report.briefs).toEqual([
      { id: "brief:global", tokenEstimate: 200, beliefCount: 2, generation: 3, generatedAt },
    ]);
  });
});

describe("formatStatusReport", () => {
  it("labels the output as a current snapshot, not a time series", () => {
    const text = formatStatusReport({
      observationCounts: [],
      staleClaimCount: 0,
      locks: [],
      beliefCounts: [],
      briefs: [],
    });

    expect(text).toMatch(/snapshot/i);
    expect(text).not.toMatch(/—/); // no em dashes anywhere in generated text
  });

  it("includes counts, locks, and brief metadata in the rendered text", () => {
    const now = new Date();
    const text = formatStatusReport({
      observationCounts: [{ project: "proj-a", status: "pending", count: 3 }],
      staleClaimCount: 1,
      locks: [{ project: "proj-a", holder: "run-1", heldUntil: now, live: true }],
      beliefCounts: [{ project: "proj-a", status: "active", count: 5 }],
      briefs: [{ id: "brief:proj-a", tokenEstimate: 100, beliefCount: 5, generation: 2, generatedAt: now }],
    });

    expect(text).toContain("proj-a");
    expect(text).toContain("pending");
    expect(text).toContain("run-1");
    expect(text).toContain("brief:proj-a");
    expect(text).not.toMatch(/—/);
  });
});
