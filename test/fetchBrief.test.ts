import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/db/client.js");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getBriefs", () => {
  it("returns both briefs when both documents are found", async () => {
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

    expect(result).toEqual({ global: "Global brief.", project: "Project brief." });
  });

  it("fails open to { global: null, project: null } when the db lookup rejects, without waiting for the timeout", async () => {
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => {
        throw new Error("mongo is down");
      },
    }));

    const { getBriefs } = await import("../src/briefs/fetchBrief.js");
    // A large timeout proves the empty result came from the rejection path,
    // not from the race's timeout arm.
    const result = await getBriefs("myproj", 60_000);

    expect(result).toEqual({ global: null, project: null });
  });

  it("fails open to { global: null, project: null } when the lookup exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    vi.doMock("../src/db/client.js", () => ({
      // Never resolves, simulating a hung/slow Mongo call.
      getDb: () => new Promise(() => {}),
    }));

    const { getBriefs } = await import("../src/briefs/fetchBrief.js");
    const resultPromise = getBriefs("myproj", 800);

    await vi.advanceTimersByTimeAsync(800);
    const result = await resultPromise;

    expect(result).toEqual({ global: null, project: null });
  });
});
