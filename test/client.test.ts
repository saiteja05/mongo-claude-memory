import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const SECRET_URI = "mongodb+srv://user:supersecret@cluster0.example.mongodb.net/";

let savedUri: string | undefined;
let savedDb: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("mongodb");
  savedUri = process.env.MEMORY_MONGODB_URI;
  savedDb = process.env.MEMORY_MONGODB_DB;
  process.env.MEMORY_MONGODB_URI = SECRET_URI;
  delete process.env.MDB_MCP_CONNECTION_STRING;
});

afterEach(() => {
  if (savedUri === undefined) delete process.env.MEMORY_MONGODB_URI;
  else process.env.MEMORY_MONGODB_URI = savedUri;
  if (savedDb === undefined) delete process.env.MEMORY_MONGODB_DB;
  else process.env.MEMORY_MONGODB_DB = savedDb;
});

describe("getDb", () => {
  it("never includes the raw connection string in the thrown error, even when connect() rejects with an error embedding it", async () => {
    vi.doMock("mongodb", () => ({
      MongoClient: class {
        connect() {
          return Promise.reject(new Error(`connection failed: ${SECRET_URI}`));
        }
      },
    }));

    const { getDb } = await import("../src/db/client.js");

    await expect(getDb()).rejects.toThrow();
    try {
      await getDb();
      expect.unreachable("getDb should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).not.toContain(SECRET_URI);
      expect(message).not.toContain("supersecret");
    }
  });

  it("allows retrying (does not permanently cache a failed connection attempt)", async () => {
    let attempts = 0;
    vi.doMock("mongodb", () => ({
      MongoClient: class {
        connect() {
          attempts++;
          if (attempts === 1) return Promise.reject(new Error(`boom: ${SECRET_URI}`));
          return Promise.resolve(this);
        }
        db(name: string) {
          return { dbName: name };
        }
      },
    }));

    const { getDb } = await import("../src/db/client.js");

    await expect(getDb()).rejects.toThrow();
    const db = await getDb();
    expect((db as unknown as { dbName: string }).dbName).toBe("claude_memory");
    expect(attempts).toBe(2);
  });

  it("reuses the same connection across calls instead of reconnecting", async () => {
    let connectCalls = 0;
    vi.doMock("mongodb", () => ({
      MongoClient: class {
        connect() {
          connectCalls++;
          return Promise.resolve(this);
        }
        db(name: string) {
          return { dbName: name };
        }
      },
    }));

    const { getDb } = await import("../src/db/client.js");
    await getDb();
    await getDb();
    await getDb();

    expect(connectCalls).toBe(1);
  });
});
