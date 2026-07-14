import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeFakeDb(matchedCount: number, beliefDoc: Record<string, unknown> | null = null) {
  const findOne = vi.fn(async () => beliefDoc);
  const updateOne = vi.fn(async () => ({ matchedCount }));
  const db = { collection: () => ({ findOne, updateOne }) };
  return { db, findOne, updateOne };
}

function makeDeps(compileBriefImpl?: () => Promise<void>) {
  const compileBrief = vi.fn(compileBriefImpl ?? (async () => undefined));
  return { compileBrief };
}

let savedCacheDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/briefs/briefCache.js");
  // A matched tombstone now best-effort deletes a local brief cache file;
  // point it at a scratch dir so these tests never touch a real
  // ~/.mongo-claude-memory cache on the machine running them.
  savedCacheDir = process.env.MEMORY_BRIEF_CACHE_DIR;
  process.env.MEMORY_BRIEF_CACHE_DIR = mkdtempSync(
    path.join(tmpdir(), "mongo-claude-memory-forget-cache-")
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedCacheDir === undefined) delete process.env.MEMORY_BRIEF_CACHE_DIR;
  else process.env.MEMORY_BRIEF_CACHE_DIR = savedCacheDir;
});

describe("runMemoryForget", () => {
  it("matches on both _id and project, sets status tombstoned, and increments version", async () => {
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { db, updateOne } = makeFakeDb(1, { scope: "project", project: "myrepo-abc" });
    const deps = makeDeps();

    const result = await runMemoryForget(
      db as any,
      { project: "myrepo-abc", beliefId: "507f1f77bcf86cd799439011" },
      deps
    );

    expect(result.matched).toBe(true);
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0] as unknown as [any, any];
    expect(filter.project).toBe("myrepo-abc");
    expect(String(filter._id)).toBe("507f1f77bcf86cd799439011");
    expect(update.$set.status).toBe("tombstoned");
    expect(update.$set.updated_at).toBeInstanceOf(Date);
    expect(update.$inc).toEqual({ version: 1 });
  });

  it("returns matched:false and skips recompile when the update matches nothing (wrong project or nonexistent id)", async () => {
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { db } = makeFakeDb(0);
    const deps = makeDeps();

    const result = await runMemoryForget(
      db as any,
      { project: "some-other-project", beliefId: "507f1f77bcf86cd799439011" },
      deps
    );

    expect(result.matched).toBe(false);
    expect(result.recompiled).toBe(false);
    expect(deps.compileBrief).not.toHaveBeenCalled();
  });

  it("falls back to the raw string id when the beliefId is not a valid ObjectId (test doubles use plain string ids)", async () => {
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { db, updateOne } = makeFakeDb(1, { scope: "project", project: "myrepo-abc" });
    const deps = makeDeps();

    const result = await runMemoryForget(
      db as any,
      { project: "myrepo-abc", beliefId: "belief-1" },
      deps
    );

    expect(result.matched).toBe(true);
    const [filter] = updateOne.mock.calls[0] as unknown as [any];
    expect(filter._id).toBe("belief-1");
    expect(filter.project).toBe("myrepo-abc");
  });

  it("recompiles the project brief on a matched project-scope tombstone", async () => {
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { db } = makeFakeDb(1, { scope: "project", project: "myrepo-abc" });
    const deps = makeDeps();

    const result = await runMemoryForget(
      db as any,
      { project: "myrepo-abc", beliefId: "belief-1" },
      deps
    );

    expect(result).toEqual({ matched: true, recompiled: true });
    expect(deps.compileBrief).toHaveBeenCalledTimes(1);
    expect(deps.compileBrief).toHaveBeenCalledWith(db, "myrepo-abc");
  });

  it("also recompiles the global brief when the tombstoned belief has core scope", async () => {
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { db } = makeFakeDb(1, { scope: "core", project: "myrepo-abc" });
    const deps = makeDeps();

    const result = await runMemoryForget(
      db as any,
      { project: "myrepo-abc", beliefId: "belief-1" },
      deps
    );

    expect(result).toEqual({ matched: true, recompiled: true });
    expect(deps.compileBrief).toHaveBeenCalledTimes(2);
    expect(deps.compileBrief).toHaveBeenNthCalledWith(1, db, "myrepo-abc");
    expect(deps.compileBrief).toHaveBeenNthCalledWith(2, db, "global");
  });

  it("still returns matched:true (with recompiled:false) when the recompile fails, logging one stderr line", async () => {
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { db } = makeFakeDb(1, { scope: "project", project: "myrepo-abc" });
    const deps = makeDeps(async () => {
      throw new Error("brief recompile exploded");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runMemoryForget(
      db as any,
      { project: "myrepo-abc", beliefId: "belief-1" },
      deps
    );

    expect(result.matched).toBe(true);
    expect(result.recompiled).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("recompiles only the project brief when the belief document cannot be re-fetched (scope unknown)", async () => {
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { db } = makeFakeDb(1, null);
    const deps = makeDeps();

    const result = await runMemoryForget(
      db as any,
      { project: "myrepo-abc", beliefId: "belief-1" },
      deps
    );

    expect(result).toEqual({ matched: true, recompiled: true });
    expect(deps.compileBrief).toHaveBeenCalledTimes(1);
    expect(deps.compileBrief).toHaveBeenCalledWith(db, "myrepo-abc");
  });

  it("calls the local brief cache invalidator with the project key after a matched tombstone", async () => {
    vi.doMock("../src/briefs/briefCache.js", () => ({
      deleteBriefCache: vi.fn(),
    }));
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { deleteBriefCache } = await import("../src/briefs/briefCache.js");
    const { db } = makeFakeDb(1, { scope: "project", project: "myrepo-abc" });
    const deps = makeDeps();

    await runMemoryForget(db as any, { project: "myrepo-abc", beliefId: "belief-1" }, deps);

    expect(deleteBriefCache).toHaveBeenCalledWith("myrepo-abc");
  });

  it("does not invalidate the cache, and does not skip recompile, when the update matches nothing", async () => {
    vi.doMock("../src/briefs/briefCache.js", () => ({
      deleteBriefCache: vi.fn(),
    }));
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { deleteBriefCache } = await import("../src/briefs/briefCache.js");
    const { db } = makeFakeDb(0);
    const deps = makeDeps();

    await runMemoryForget(db as any, { project: "myrepo-abc", beliefId: "belief-1" }, deps);

    expect(deleteBriefCache).not.toHaveBeenCalled();
  });

  it("does not fail the forget, or change the reported result, when the cache invalidator throws", async () => {
    vi.doMock("../src/briefs/briefCache.js", () => ({
      deleteBriefCache: vi.fn(() => {
        throw new Error("cache delete exploded");
      }),
    }));
    const { runMemoryForget } = await import("../src/mcp/memoryForget.js");
    const { db } = makeFakeDb(1, { scope: "project", project: "myrepo-abc" });
    const deps = makeDeps();

    const result = await runMemoryForget(
      db as any,
      { project: "myrepo-abc", beliefId: "belief-1" },
      deps
    );

    expect(result).toEqual({ matched: true, recompiled: true });
  });
});
