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

  it("constructs MongoClient with short, explicit connection timeouts so closeDb() can never be blocked for the driver's ~30s default", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    vi.doMock("mongodb", () => ({
      MongoClient: class {
        constructor(_uri: string, options: Record<string, unknown>) {
          capturedOptions = options;
        }
        connect() {
          return Promise.resolve(this);
        }
        db(name: string) {
          return { dbName: name };
        }
      },
    }));

    const { getDb } = await import("../src/db/client.js");
    await getDb();

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.serverSelectionTimeoutMS).toBeTypeOf("number");
    expect(capturedOptions?.serverSelectionTimeoutMS as number).toBeLessThanOrEqual(5000);
    expect(capturedOptions?.connectTimeoutMS).toBeTypeOf("number");
    expect(capturedOptions?.connectTimeoutMS as number).toBeLessThanOrEqual(5000);
  });

  it("still rejects within a bounded time when connect() never settles (e.g. a blackholed DNS lookup for mongodb+srv://, which serverSelectionTimeoutMS/connectTimeoutMS do not cover)", async () => {
    vi.useFakeTimers();
    try {
      let closeCalls = 0;
      vi.doMock("mongodb", () => ({
        MongoClient: class {
          connect() {
            // Simulates a hung DNS SRV/TXT resolution: this promise never
            // settles, exactly like an unreachable resolver would.
            return new Promise(() => {});
          }
          close() {
            closeCalls++;
            return Promise.resolve();
          }
        },
      }));

      const { getDb } = await import("../src/db/client.js");

      const pending = expect(getDb()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
      expect(closeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it(
    "closes the late-resolved client, without affecting the already-rejected getDb() call, when connect() settles successfully after the hard timeout already fired",
    async () => {
      vi.useFakeTimers();
      try {
        let closeCalls = 0;
        let resolveConnect: (() => void) | undefined;
        vi.doMock("mongodb", () => ({
          MongoClient: class {
            connect() {
              // The real connect() is still in flight when the hard timeout
              // fires below; it is only resolved afterwards, from the test,
              // to simulate a slow DNS/socket/server-selection phase that
              // eventually succeeds too late to matter.
              return new Promise((resolve) => {
                resolveConnect = () => resolve(this);
              });
            }
            close() {
              closeCalls++;
              return Promise.resolve();
            }
          },
        }));

        const { getDb } = await import("../src/db/client.js");

        const pending = expect(getDb()).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(5000);
        await pending;
        expect(closeCalls).toBe(0);

        // The real connect() finally settles, well after we already gave up
        // and rejected. It resolved successfully, so the now-unwanted client
        // must be closed instead of leaked.
        resolveConnect?.();
        await vi.advanceTimersByTimeAsync(0);

        expect(closeCalls).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    },
    // Generous timeout: the assertions above resolve within milliseconds
    // once the fake timers are advanced, but this guards against the test
    // runner's real wall-clock deadline under heavy machine load.
    20000
  );
});

describe("closeDb", () => {
  it("resolves without error and without calling close() when no connection was ever established", async () => {
    let closeCalls = 0;
    vi.doMock("mongodb", () => ({
      MongoClient: class {
        connect() {
          return Promise.resolve(this);
        }
        close() {
          closeCalls++;
          return Promise.resolve();
        }
      },
    }));

    const { closeDb } = await import("../src/db/client.js");

    await expect(closeDb()).resolves.toBeUndefined();
    expect(closeCalls).toBe(0);
  });

  it("invokes the underlying client's close() after getDb() has already succeeded", async () => {
    let closeCalls = 0;
    vi.doMock("mongodb", () => ({
      MongoClient: class {
        connect() {
          return Promise.resolve(this);
        }
        close() {
          closeCalls++;
          return Promise.resolve();
        }
        db(name: string) {
          return { dbName: name };
        }
      },
    }));

    const { getDb, closeDb } = await import("../src/db/client.js");

    await getDb();
    expect(closeCalls).toBe(0);

    await closeDb();
    expect(closeCalls).toBe(1);
  });

  it("does not throw and does not attempt to call close() on a null client when the cached connection promise rejects", async () => {
    let closeCalls = 0;
    vi.doMock("mongodb", () => ({
      MongoClient: class {
        connect() {
          return Promise.reject(new Error(`boom: ${SECRET_URI}`));
        }
        close() {
          closeCalls++;
          return Promise.resolve();
        }
      },
    }));

    const { getDb, closeDb } = await import("../src/db/client.js");

    // Start the failing connection attempt but do not await it yet, so the
    // cached clientPromise is still set to a promise that has not settled
    // (and will soon reject) when closeDb() reads it below. Awaiting getDb()
    // first would let its own rejection handler null out the cache before
    // closeDb() ever saw it, which would just retest the "no connection"
    // path above instead of this one.
    const getDbPromise = getDb();
    const closeDbPromise = closeDb();

    await expect(getDbPromise).rejects.toThrow();
    await expect(closeDbPromise).resolves.toBeUndefined();
    expect(closeCalls).toBe(0);
  });
});
