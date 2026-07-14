import { describe, it, expect, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { ReconcileSweepDeps } from "../src/consolidation/reconcileSweep.js";
import type { ReconcileVerdict } from "../src/consolidation/reconcileBelief.js";

const findSimilarBeliefs = vi.fn();

vi.mock("../src/consolidation/upsertBelief.js", () => ({ findSimilarBeliefs }));

const { runReconcileSweep, formatReconcileReport } = await import(
  "../src/consolidation/reconcileSweep.js"
);

interface FakeBelief {
  _id: string;
  project: string;
  status: string;
  scope: "core" | "project" | "archive";
  text: string;
  embedding?: number[];
  version: number;
  observation_ids: string[];
  supersedes: string | null;
  last_evidence_at: Date;
}

let beliefCounter = 0;

function makeBelief(overrides: Partial<FakeBelief> = {}): FakeBelief {
  beliefCounter += 1;
  return {
    _id: new ObjectId().toString(),
    project: "proj",
    status: "active",
    scope: "project",
    text: `fact ${beliefCounter}`,
    version: 1,
    observation_ids: [],
    supersedes: null,
    last_evidence_at: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function makeFakeDb(beliefs: FakeBelief[]) {
  const state: FakeBelief[] = beliefs.map((b) => ({ ...b }));

  function matchId(actual: unknown, wanted: unknown): boolean {
    return String(actual) === String(wanted);
  }

  const updateOne = vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const doc = state.find((b) => matchId(b._id, filter._id));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (filter.status !== undefined && doc.status !== filter.status) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (filter.version !== undefined && doc.version !== filter.version) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (
      Object.prototype.hasOwnProperty.call(filter, "supersedes") &&
      doc.supersedes !== (filter.supersedes as string | null)
    ) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    if (update.$set) Object.assign(doc, update.$set as Record<string, unknown>);
    if (update.$inc) {
      for (const [key, value] of Object.entries(update.$inc as Record<string, number>)) {
        (doc as unknown as Record<string, number>)[key] =
          ((doc as unknown as Record<string, number>)[key] ?? 0) + value;
      }
    }
    if (update.$addToSet) {
      for (const [key, value] of Object.entries(update.$addToSet as Record<string, unknown>)) {
        const each: string[] =
          value && Array.isArray((value as { $each?: string[] }).$each)
            ? (value as { $each: string[] }).$each
            : [value as string];
        const current: string[] = Array.isArray((doc as unknown as Record<string, unknown>)[key])
          ? ((doc as unknown as Record<string, unknown>)[key] as string[])
          : [];
        (doc as unknown as Record<string, unknown>)[key] = Array.from(new Set([...current, ...each]));
      }
    }

    return { matchedCount: 1, modifiedCount: 1 };
  });

  const find = vi.fn((filter: { project: string; status: string }) => ({
    sort: () => ({
      limit: () => ({
        async toArray() {
          return state.filter((b) => b.project === filter.project && b.status === filter.status);
        },
      }),
    }),
  }));

  const beliefsCollection = { find, updateOne };
  const db = { collection: () => beliefsCollection };
  return { db, state, find, updateOne };
}

function makeDeps(overrides: Partial<ReconcileSweepDeps> = {}): ReconcileSweepDeps {
  return {
    threshold: 0.75,
    maxPairs: 25,
    embeddingMode: "appside",
    model: "voyage-4",
    reconcile: vi.fn(async (): Promise<ReconcileVerdict[]> => []),
    compileBrief: vi.fn(async () => undefined),
    ...overrides,
  };
}

// Wires findSimilarBeliefs's mock so that a call probing on behalf of a given
// belief (identified by its own text, passed through as options.queryText)
// returns exactly the near-match list configured for it. Any belief not
// listed here reports no matches, so tests only need to describe the probes
// that matter to them.
function stubMatches(matches: Record<string, Array<{ _id: string; text: string; score: number }>>) {
  findSimilarBeliefs.mockImplementation(
    async (
      _db: unknown,
      _project: string,
      _scope: string,
      _embedding: number[],
      _threshold: number,
      _k: number,
      options: { queryText?: string }
    ) => matches[options.queryText ?? ""] ?? []
  );
}

describe("runReconcileSweep", () => {
  it("returns a zeroed report and makes no probe or LLM calls when the project has no active beliefs", async () => {
    const { db } = makeFakeDb([]);
    const reconcile = vi.fn(async (): Promise<ReconcileVerdict[]> => []);

    const report = await runReconcileSweep(db as any, "empty-proj", makeDeps({ reconcile }));

    expect(report).toEqual({
      beliefsScanned: 0,
      pairsFound: 0,
      pairsArbitrated: 0,
      archivedSupersedes: [],
      archivedDuplicates: [],
      skippedCap: 0,
      skippedContention: 0,
      skippedErrors: 0,
      recompiledScopes: [],
    });
    expect(findSimilarBeliefs).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("dedupes a pair found from both sides (A's probe surfaces B, B's probe surfaces A) into a single arbitrated pair", async () => {
    const a = makeBelief({ text: "fact A", last_evidence_at: new Date("2026-07-05") });
    const b = makeBelief({ text: "fact B", last_evidence_at: new Date("2026-07-01") });
    const { db } = makeFakeDb([a, b]);

    stubMatches({
      [a.text]: [{ _id: b._id, text: b.text, score: 0.9 }],
      [b.text]: [{ _id: a._id, text: a.text, score: 0.9 }],
    });

    const reconcile = vi.fn(async (): Promise<ReconcileVerdict[]> => []);
    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile }));

    expect(report.beliefsScanned).toBe(2);
    expect(report.pairsFound).toBe(1);
    expect(report.pairsArbitrated).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("caps queued pairs at maxPairs, counts the remainder as skippedCap, and logs exactly one stderr line about it", async () => {
    const a = makeBelief({ text: "fact A" });
    const b = makeBelief({ text: "fact B" });
    const c = makeBelief({ text: "fact C" });
    const { db } = makeFakeDb([a, b, c]);

    stubMatches({
      [a.text]: [
        { _id: b._id, text: b.text, score: 0.9 },
        { _id: c._id, text: c.text, score: 0.9 },
      ],
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reconcile = vi.fn(async (): Promise<ReconcileVerdict[]> => []);

    const report = await runReconcileSweep(db as any, "proj", makeDeps({ maxPairs: 1, reconcile }));

    expect(report.pairsFound).toBe(2);
    expect(report.skippedCap).toBe(1);
    expect(report.pairsArbitrated).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("pair cap");

    errorSpy.mockRestore();
  });

  it("archives the older belief via a status+version CAS and stamps supersedes lineage on the survivor when it has none yet", async () => {
    const newer = makeBelief({
      text: "newer fact",
      last_evidence_at: new Date("2026-07-05"),
      supersedes: null,
      version: 3,
    });
    const older = makeBelief({ text: "older fact", last_evidence_at: new Date("2026-07-01"), version: 2 });
    const { db, state, updateOne } = makeFakeDb([newer, older]);

    stubMatches({ [newer.text]: [{ _id: older._id, text: older.text, score: 0.9 }] });

    const reconcile = vi.fn(
      async (): Promise<ReconcileVerdict[]> => [{ beliefId: older._id, verdict: "supersedes" }]
    );
    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile }));

    expect(report.archivedSupersedes).toEqual([older._id]);
    expect(updateOne).toHaveBeenCalledTimes(2); // archive + lineage stamp

    const olderDoc = state.find((b) => b._id === older._id)!;
    expect(olderDoc.status).toBe("archived");
    expect(olderDoc.version).toBe(3); // 2, bumped once by the archive write

    const newerDoc = state.find((b) => b._id === newer._id)!;
    expect(newerDoc.supersedes).toBe(older._id);
    expect(newerDoc.version).toBe(4); // 3, bumped once by the stamp write
  });

  it("does not stamp (or call updateOne a second time for) supersedes lineage when the survivor already has a supersedes pointer", async () => {
    const newer = makeBelief({
      text: "newer fact",
      last_evidence_at: new Date("2026-07-05"),
      supersedes: "existing-lineage-id",
      version: 3,
    });
    const older = makeBelief({ text: "older fact", last_evidence_at: new Date("2026-07-01"), version: 2 });
    const { db, state, updateOne } = makeFakeDb([newer, older]);

    stubMatches({ [newer.text]: [{ _id: older._id, text: older.text, score: 0.9 }] });

    const reconcile = vi.fn(
      async (): Promise<ReconcileVerdict[]> => [{ beliefId: older._id, verdict: "supersedes" }]
    );
    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile }));

    expect(report.archivedSupersedes).toEqual([older._id]);
    expect(updateOne).toHaveBeenCalledTimes(1); // archive only, no stamp call at all

    const newerDoc = state.find((b) => b._id === newer._id)!;
    expect(newerDoc.supersedes).toBe("existing-lineage-id"); // untouched
    expect(newerDoc.version).toBe(3); // untouched, no stamp write happened
  });

  it("merges the older belief's observation_ids into the survivor via $addToSet on a 'duplicate' verdict", async () => {
    const newer = makeBelief({
      text: "newer fact",
      last_evidence_at: new Date("2026-07-05"),
      observation_ids: ["obs-new"],
    });
    const older = makeBelief({
      text: "older fact",
      last_evidence_at: new Date("2026-07-01"),
      observation_ids: ["obs-old-1", "obs-old-2"],
    });
    const { db, state } = makeFakeDb([newer, older]);

    stubMatches({ [newer.text]: [{ _id: older._id, text: older.text, score: 0.9 }] });

    const reconcile = vi.fn(
      async (): Promise<ReconcileVerdict[]> => [{ beliefId: older._id, verdict: "duplicate" }]
    );
    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile }));

    expect(report.archivedDuplicates).toEqual([older._id]);
    const olderDoc = state.find((b) => b._id === older._id)!;
    expect(olderDoc.status).toBe("archived");
    const newerDoc = state.find((b) => b._id === newer._id)!;
    expect(newerDoc.observation_ids.sort()).toEqual(["obs-new", "obs-old-1", "obs-old-2"]);
  });

  it("increments skippedContention and mutates nothing else when the archive updateOne's CAS reports matchedCount 0", async () => {
    const newer = makeBelief({ text: "newer fact", last_evidence_at: new Date("2026-07-05") });
    const older = makeBelief({ text: "older fact", last_evidence_at: new Date("2026-07-01"), version: 5 });
    const { db, state, updateOne } = makeFakeDb([newer, older]);

    stubMatches({ [newer.text]: [{ _id: older._id, text: older.text, score: 0.9 }] });

    // Force the archive CAS to fail once, simulating a concurrent write that
    // raced ahead between this sweep's snapshot read and its archive write.
    updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    const reconcile = vi.fn(
      async (): Promise<ReconcileVerdict[]> => [{ beliefId: older._id, verdict: "supersedes" }]
    );
    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile }));

    expect(report.skippedContention).toBe(1);
    expect(report.archivedSupersedes).toEqual([]);
    expect(updateOne).toHaveBeenCalledTimes(1); // only the failed archive attempt, no follow-up write

    const olderDoc = state.find((b) => b._id === older._id)!;
    expect(olderDoc.status).toBe("active");
    expect(olderDoc.version).toBe(5);
  });

  it("increments skippedErrors and continues to the next pair when the reconcile call throws", async () => {
    const a1 = makeBelief({ text: "pair1 newer", last_evidence_at: new Date("2026-07-05") });
    const a2 = makeBelief({ text: "pair1 older", last_evidence_at: new Date("2026-07-01") });
    const b1 = makeBelief({ text: "pair2 newer", last_evidence_at: new Date("2026-07-05") });
    const b2 = makeBelief({ text: "pair2 older", last_evidence_at: new Date("2026-07-01") });
    const { db, state } = makeFakeDb([a1, a2, b1, b2]);

    stubMatches({
      [a1.text]: [{ _id: a2._id, text: a2.text, score: 0.9 }],
      [b1.text]: [{ _id: b2._id, text: b2.text, score: 0.9 }],
    });

    const reconcile = vi
      .fn<[string, unknown[]], Promise<ReconcileVerdict[]>>()
      .mockRejectedValueOnce(new Error("provider timed out"))
      .mockResolvedValueOnce([{ beliefId: b2._id, verdict: "supersedes" }]);

    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile }));

    expect(report.skippedErrors).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(report.archivedSupersedes).toEqual([b2._id]);
    const b2Doc = state.find((b) => b._id === b2._id)!;
    expect(b2Doc.status).toBe("archived");
  });

  it("recompiles only the project scope when everything archived is project-scoped", async () => {
    const newer = makeBelief({ text: "newer fact", scope: "project", last_evidence_at: new Date("2026-07-05") });
    const older = makeBelief({ text: "older fact", scope: "project", last_evidence_at: new Date("2026-07-01") });
    const { db } = makeFakeDb([newer, older]);

    stubMatches({ [newer.text]: [{ _id: older._id, text: older.text, score: 0.9 }] });

    const reconcile = vi.fn(
      async (): Promise<ReconcileVerdict[]> => [{ beliefId: older._id, verdict: "supersedes" }]
    );
    const compileBrief = vi.fn(async () => undefined);

    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile, compileBrief }));

    expect(report.recompiledScopes).toEqual(["proj"]);
    expect(compileBrief).toHaveBeenCalledTimes(1);
    expect(compileBrief).toHaveBeenCalledWith(db, "proj");
  });

  it("also recompiles global when a core-scope belief is involved in an archived pair", async () => {
    const newer = makeBelief({ text: "newer fact", scope: "core", last_evidence_at: new Date("2026-07-05") });
    const older = makeBelief({ text: "older fact", scope: "core", last_evidence_at: new Date("2026-07-01") });
    const { db } = makeFakeDb([newer, older]);

    stubMatches({ [newer.text]: [{ _id: older._id, text: older.text, score: 0.9 }] });

    const reconcile = vi.fn(
      async (): Promise<ReconcileVerdict[]> => [{ beliefId: older._id, verdict: "supersedes" }]
    );
    const compileBrief = vi.fn(async () => undefined);

    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile, compileBrief }));

    expect(report.recompiledScopes).toEqual(["proj", "global"]);
    expect(compileBrief).toHaveBeenCalledTimes(2);
    expect(compileBrief).toHaveBeenNthCalledWith(1, db, "proj");
    expect(compileBrief).toHaveBeenNthCalledWith(2, db, "global");
  });

  it("passes the belief's own stored embedding as the queryVector in appside mode (no text-query fallback)", async () => {
    const belief = makeBelief({ text: "fact with embedding", embedding: [0.11, 0.22, 0.33] });
    const other = makeBelief({ text: "other fact" });
    const { db } = makeFakeDb([belief, other]);

    findSimilarBeliefs.mockResolvedValue([]);

    await runReconcileSweep(db as any, "proj", makeDeps({ embeddingMode: "appside" }));

    const call = findSimilarBeliefs.mock.calls.find(
      ([, , , , , , options]: any[]) => options.queryText === belief.text
    )!;
    const [, , , embeddingArg, , , optionsArg] = call as any[];
    expect(embeddingArg).toEqual([0.11, 0.22, 0.33]);
    expect(optionsArg.mode).toBe("appside");
  });

  it("skips a later pair when one of its members was already archived earlier in the same sweep", async () => {
    const a = makeBelief({ text: "fact A", last_evidence_at: new Date("2026-07-10") });
    const b = makeBelief({ text: "fact B", last_evidence_at: new Date("2026-07-05") });
    const c = makeBelief({ text: "fact C", last_evidence_at: new Date("2026-07-01") });
    const { db, state } = makeFakeDb([a, b, c]);

    stubMatches({
      [a.text]: [{ _id: b._id, text: b.text, score: 0.9 }],
      [b.text]: [{ _id: c._id, text: c.text, score: 0.9 }],
    });

    const reconcile = vi.fn(
      async (): Promise<ReconcileVerdict[]> => [{ beliefId: b._id, verdict: "supersedes" }]
    );
    const report = await runReconcileSweep(db as any, "proj", makeDeps({ reconcile }));

    // Only the A-B pair is ever arbitrated: B-C is skipped once B is archived
    // from the A-B pair, since B is no longer an active belief to reconcile.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(report.archivedSupersedes).toEqual([b._id]);
    const cDoc = state.find((x) => x._id === c._id)!;
    expect(cDoc.status).toBe("active");
  });
});

describe("formatReconcileReport", () => {
  function makeReport(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      beliefsScanned: 0,
      pairsFound: 0,
      pairsArbitrated: 0,
      archivedSupersedes: [],
      archivedDuplicates: [],
      skippedCap: 0,
      skippedContention: 0,
      skippedErrors: 0,
      recompiledScopes: [],
      ...overrides,
    } as any;
  }

  it("renders the summary line and archived-id lines when there is something to report", () => {
    const report = makeReport({
      beliefsScanned: 10,
      pairsFound: 3,
      pairsArbitrated: 3,
      archivedSupersedes: ["belief-1"],
      archivedDuplicates: ["belief-2"],
    });

    const text = formatReconcileReport("proj", report);

    expect(text).toContain(
      '[reconcile] project="proj": scanned 10 active belief(s), found 3 pair(s), arbitrated 3 pair(s)'
    );
    expect(text).toContain("Archived (superseded) belief ids: belief-1");
    expect(text).toContain("Archived (duplicate) belief ids: belief-2");
  });

  it("omits the archived-id lines when both archive lists are empty", () => {
    const text = formatReconcileReport("proj", makeReport());

    expect(text).not.toContain("Archived (superseded)");
    expect(text).not.toContain("Archived (duplicate)");
  });

  it("uses the 'No briefs needed recompilation.' fallback when recompiledScopes is empty, and lists scopes otherwise", () => {
    const noneText = formatReconcileReport("proj", makeReport());
    expect(noneText).toContain("No briefs needed recompilation.");

    const someText = formatReconcileReport("proj", makeReport({ recompiledScopes: ["proj", "global"] }));
    expect(someText).toContain("Recompiled brief(s) for scope(s): proj, global");
    expect(someText).not.toContain("No briefs needed recompilation.");
  });
});
