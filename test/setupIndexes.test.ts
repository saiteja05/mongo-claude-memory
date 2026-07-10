import { describe, it, expect, beforeEach, vi } from "vitest";
import { BELIEFS as BELIEFS_NAME } from "../src/db/schema.js";

interface FakeState {
  existingCollections: Set<string>;
  existingIndexNames: Set<string>;
  existingSearchIndexNames: Set<string>;
  searchIndexesUnsupported: boolean;
}

function makeFakeDb(state: FakeState, calls: string[]) {
  return {
    listCollections(filter: { name: string }) {
      return {
        toArray: async () =>
          state.existingCollections.has(filter.name) ? [{ name: filter.name }] : [],
      };
    },
    async createCollection(name: string) {
      calls.push(`createCollection:${name}`);
      state.existingCollections.add(name);
    },
    collection(name: string) {
      return {
        async indexes() {
          return [...state.existingIndexNames]
            .filter((n) => n.startsWith(`${name}:`))
            .map((n) => ({ name: n.split(":")[1] }));
        },
        async createIndex(_keys: unknown, options: { name: string }) {
          calls.push(`createIndex:${name}:${options.name}`);
          state.existingIndexNames.add(`${name}:${options.name}`);
        },
        listSearchIndexes(searchName: string) {
          if (state.searchIndexesUnsupported) {
            return {
              toArray: async () => {
                throw new Error("mongot not available");
              },
            };
          }
          return {
            toArray: async () =>
              state.existingSearchIndexNames.has(`${name}:${searchName}`)
                ? [{ name: searchName }]
                : [],
          };
        },
        async createSearchIndex(def: { name: string }) {
          calls.push(`createSearchIndex:${name}:${def.name}`);
          state.existingSearchIndexNames.add(`${name}:${def.name}`);
        },
      };
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/db/client.js");
});

describe("setupIndexes", () => {
  it("creates all collections and indexes from a clean database", async () => {
    const calls: string[] = [];
    const state: FakeState = {
      existingCollections: new Set(),
      existingIndexNames: new Set(),
      existingSearchIndexNames: new Set(),
      searchIndexesUnsupported: false,
    };
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => makeFakeDb(state, calls),
      closeDb: async () => {},
    }));

    const { setupIndexes } = await import("../src/db/setupIndexes.js");
    await setupIndexes();

    expect(calls).toContain("createCollection:observations");
    expect(calls).toContain("createCollection:beliefs");
    expect(calls).toContain("createCollection:briefs");
    expect(calls).toContain("createCollection:locks");
    expect(calls).toContain("createIndex:observations:expiresAt_ttl");
    expect(calls).toContain("createIndex:beliefs:project_scope_status");
    expect(calls).toContain("createSearchIndex:beliefs:beliefs_vec");
    expect(calls).toContain("createSearchIndex:beliefs:beliefs_text");
  });

  it("is idempotent: skips creation for collections and indexes that already exist", async () => {
    const calls: string[] = [];
    const state: FakeState = {
      existingCollections: new Set(["observations", "beliefs", "briefs", "locks"]),
      existingIndexNames: new Set([
        "observations:expiresAt_ttl",
        "beliefs:project_scope_status",
        "beliefs:archived_tombstoned_ttl",
      ]),
      existingSearchIndexNames: new Set(["beliefs:beliefs_vec", "beliefs:beliefs_text"]),
      searchIndexesUnsupported: false,
    };
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => makeFakeDb(state, calls),
      closeDb: async () => {},
    }));

    const { setupIndexes } = await import("../src/db/setupIndexes.js");
    await setupIndexes();

    expect(calls).toEqual([]);
  });

  it("creates the beliefs archived/tombstoned TTL index when it does not already exist", async () => {
    const calls: string[] = [];
    const state: FakeState = {
      existingCollections: new Set(["observations", "beliefs", "briefs", "locks"]),
      existingIndexNames: new Set([
        "observations:expiresAt_ttl",
        "beliefs:project_scope_status",
      ]),
      existingSearchIndexNames: new Set(["beliefs:beliefs_vec", "beliefs:beliefs_text"]),
      searchIndexesUnsupported: false,
    };
    const createIndexCalls: Array<{ keys: unknown; options: unknown }> = [];
    const db = makeFakeDb(state, calls);
    const beliefsCollection = db.collection(BELIEFS_NAME);
    const originalCreateIndex = beliefsCollection.createIndex.bind(beliefsCollection);
    beliefsCollection.createIndex = async (keys: unknown, options: { name: string }) => {
      createIndexCalls.push({ keys, options });
      return originalCreateIndex(keys, options);
    };
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => ({
        ...db,
        collection: (name: string) => (name === BELIEFS_NAME ? beliefsCollection : db.collection(name)),
      }),
      closeDb: async () => {},
    }));

    const { setupIndexes } = await import("../src/db/setupIndexes.js");
    await setupIndexes();

    expect(calls).toContain("createIndex:beliefs:archived_tombstoned_ttl");
    const ttlCall = createIndexCalls.find(
      (c) => (c.options as { name: string }).name === "archived_tombstoned_ttl"
    );
    expect(ttlCall).toBeDefined();
    expect(ttlCall?.keys).toEqual({ updated_at: 1 });
    expect(ttlCall?.options).toEqual({
      name: "archived_tombstoned_ttl",
      expireAfterSeconds: 7776000,
      partialFilterExpression: { status: { $in: ["archived", "tombstoned"] } },
    });
  });

  it("skips creating the beliefs archived/tombstoned TTL index when it already exists", async () => {
    const calls: string[] = [];
    const state: FakeState = {
      existingCollections: new Set(["observations", "beliefs", "briefs", "locks"]),
      existingIndexNames: new Set([
        "observations:expiresAt_ttl",
        "beliefs:project_scope_status",
        "beliefs:archived_tombstoned_ttl",
      ]),
      existingSearchIndexNames: new Set(["beliefs:beliefs_vec", "beliefs:beliefs_text"]),
      searchIndexesUnsupported: false,
    };
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => makeFakeDb(state, calls),
      closeDb: async () => {},
    }));

    const { setupIndexes } = await import("../src/db/setupIndexes.js");
    await setupIndexes();

    expect(calls).not.toContain("createIndex:beliefs:archived_tombstoned_ttl");
  });

  it("treats a listSearchIndexes failure (non-Atlas deployment) as a clear skip, not a fatal error", async () => {
    const calls: string[] = [];
    const state: FakeState = {
      existingCollections: new Set(["observations", "beliefs", "briefs", "locks"]),
      existingIndexNames: new Set([
        "observations:expiresAt_ttl",
        "beliefs:project_scope_status",
      ]),
      existingSearchIndexNames: new Set(),
      searchIndexesUnsupported: true,
    };
    vi.doMock("../src/db/client.js", () => ({
      getDb: async () => makeFakeDb(state, calls),
      closeDb: async () => {},
    }));

    const { setupIndexes } = await import("../src/db/setupIndexes.js");
    await expect(setupIndexes()).resolves.toBeUndefined();

    expect(calls.some((c) => c.startsWith("createSearchIndex:"))).toBe(false);
  });
});
