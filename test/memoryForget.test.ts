import { describe, it, expect, vi } from "vitest";
import { runMemoryForget } from "../src/mcp/memoryForget.js";

function makeFakeDb(matchedCount: number) {
  const updateOne = vi.fn(async () => ({ matchedCount }));
  const db = { collection: () => ({ updateOne }) };
  return { db, updateOne };
}

describe("runMemoryForget", () => {
  it("matches on both _id and project, sets status tombstoned, and increments version", async () => {
    const { db, updateOne } = makeFakeDb(1);

    const result = await runMemoryForget(db as any, {
      project: "myrepo-abc",
      beliefId: "507f1f77bcf86cd799439011",
    });

    expect(result.matched).toBe(true);
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter.project).toBe("myrepo-abc");
    expect(String(filter._id)).toBe("507f1f77bcf86cd799439011");
    expect(update.$set.status).toBe("tombstoned");
    expect(update.$set.updated_at).toBeInstanceOf(Date);
    expect(update.$inc).toEqual({ version: 1 });
  });

  it("returns matched:false when the update matches nothing (wrong project or nonexistent id)", async () => {
    const { db } = makeFakeDb(0);

    const result = await runMemoryForget(db as any, {
      project: "some-other-project",
      beliefId: "507f1f77bcf86cd799439011",
    });

    expect(result.matched).toBe(false);
  });

  it("falls back to the raw string id when the beliefId is not a valid ObjectId (test doubles use plain string ids)", async () => {
    const { db, updateOne } = makeFakeDb(1);

    const result = await runMemoryForget(db as any, {
      project: "myrepo-abc",
      beliefId: "belief-1",
    });

    expect(result.matched).toBe(true);
    const [filter] = updateOne.mock.calls[0];
    expect(filter._id).toBe("belief-1");
    expect(filter.project).toBe("myrepo-abc");
  });
});
