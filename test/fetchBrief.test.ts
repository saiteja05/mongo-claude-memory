import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/db/client.js");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getBriefs", () => {
  it("returns both briefs, with source \"fetched\", when both documents are found", async () => {
    const findOne = vi.fn(async ({ _id }: { _id: string }) => {
      if (_id === "brief:global") return { _id, content: "Global brief." };
      if (_id === "brief:myproj") return { _id, content: "Project brief." };
      return null;
    });
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => ({ collection: () => ({ findOne }) }),
    }));

    const { getBriefs } = await import("../src/briefs/fetchBrief.js");
    const result = await getBriefs("myproj", 800);

    expect(result).toEqual({
      global: "Global brief.",
      project: "Project brief.",
      source: "fetched",
      generatedAt: null,
    });
  });

  it("sets source \"fetched\" and generatedAt null on a healthy empty (neither brief exists; not an outage)", async () => {
    const findOne = vi.fn(async () => null);
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => ({ collection: () => ({ findOne }) }),
    }));

    const { getBriefs } = await import("../src/briefs/fetchBrief.js");
    const result = await getBriefs("myproj", 800);

    expect(result).toEqual({
      global: null,
      project: null,
      source: "fetched",
      generatedAt: null,
    });
  });

  it("carries the newest generated_at across the two brief documents, as an ISO string", async () => {
    const olderGeneratedAt = new Date("2026-06-01T00:00:00.000Z");
    const newerGeneratedAt = new Date("2026-07-01T00:00:00.000Z");
    const findOne = vi.fn(async ({ _id }: { _id: string }) => {
      if (_id === "brief:global") {
        return { _id, content: "Global brief.", generated_at: olderGeneratedAt };
      }
      if (_id === "brief:myproj") {
        return { _id, content: "Project brief.", generated_at: newerGeneratedAt };
      }
      return null;
    });
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => ({ collection: () => ({ findOne }) }),
    }));

    const { getBriefs } = await import("../src/briefs/fetchBrief.js");
    const result = await getBriefs("myproj", 800);

    expect(result.generatedAt).toBe(newerGeneratedAt.toISOString());
  });

  it("sets source \"error\" and fails open to nulls when the db lookup rejects, without waiting for the timeout", async () => {
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => {
        throw new Error("mongo is down");
      },
    }));

    const { getBriefs } = await import("../src/briefs/fetchBrief.js");
    // A large timeout proves the empty result came from the rejection path,
    // not from the race's timeout arm.
    const result = await getBriefs("myproj", 60_000);

    expect(result).toEqual({ global: null, project: null, source: "error" });
  });

  it("sets source \"timeout\" and fails open to nulls when the lookup exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    vi.doMock("../src/db/client.js", () => ({
      // Never resolves, simulating a hung/slow Mongo call.
      getDb: () => new Promise(() => {}),
    }));

    const { getBriefs } = await import("../src/briefs/fetchBrief.js");
    const resultPromise = getBriefs("myproj", 800);

    await vi.advanceTimersByTimeAsync(800);
    const result = await resultPromise;

    expect(result).toEqual({ global: null, project: null, source: "timeout" });
  });
});
