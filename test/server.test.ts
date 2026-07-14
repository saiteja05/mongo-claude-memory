import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const getDb = vi.fn();
const closeDb = vi.fn(async () => undefined);
const runMemorySearch = vi.fn();
const runMemoryWrite = vi.fn();
const runMemoryForget = vi.fn();

vi.mock("../src/db/client.js", () => ({ getDb, closeDb }));
vi.mock("../src/mcp/memorySearch.js", () => ({ runMemorySearch }));
vi.mock("../src/mcp/memoryWrite.js", () => ({ runMemoryWrite }));
vi.mock("../src/mcp/memoryForget.js", () => ({ runMemoryForget }));

const { buildServer, createShutdownHandler } = await import("../src/mcp/server.js");

const DEFAULT_PROJECT = "myrepo-default";
const fakeDb = { fake: true } as any;

// Builds a real McpServer via buildServer(), links it to a real SDK Client
// over an in-memory transport pair, and drives the whole exchange through the
// client's public API (never buildServer()'s internals). fn is run with the
// connected client, then both ends are closed regardless of outcome.
async function withClient<T>(
  defaultProject: string,
  fn: (client: InstanceType<typeof Client>) => Promise<T>
): Promise<T> {
  const server = buildServer(defaultProject);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function firstTextBlock(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") throw new Error("no text content block in result");
  return block.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  getDb.mockResolvedValue(fakeDb);
});

describe("buildServer", () => {
  it("registers exactly memory_search, memory_write, memory_forget, with the expected required/optional fields", async () => {
    await withClient(DEFAULT_PROJECT, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["memory_forget", "memory_search", "memory_write"]);

      const search = tools.find((t) => t.name === "memory_search")!;
      expect(search.inputSchema.required ?? []).toEqual(["query"]);
      expect(Object.keys(search.inputSchema.properties ?? {}).sort()).toEqual(
        ["limit", "project", "query", "scope"].sort()
      );

      const write = tools.find((t) => t.name === "memory_write")!;
      expect(write.inputSchema.required ?? []).toEqual(["text"]);
      expect(Object.keys(write.inputSchema.properties ?? {}).sort()).toEqual(
        ["project", "session_id", "text"].sort()
      );

      const forget = tools.find((t) => t.name === "memory_forget")!;
      expect(forget.inputSchema.required ?? []).toEqual(["beliefId"]);
      expect(Object.keys(forget.inputSchema.properties ?? {}).sort()).toEqual(["beliefId", "project"].sort());
    });
  });

  describe("memory_search", () => {
    it("falls back to the defaultProject passed to buildServer when args.project is omitted", async () => {
      runMemorySearch.mockResolvedValue({ results: [], degraded: null });

      await withClient(DEFAULT_PROJECT, async (client) => {
        await client.callTool({ name: "memory_search", arguments: { query: "tabs vs spaces" } });
      });

      expect(runMemorySearch).toHaveBeenCalledTimes(1);
      const [, params] = runMemorySearch.mock.calls[0];
      expect(params).toMatchObject({ query: "tabs vs spaces", project: DEFAULT_PROJECT });
    });

    it("accepts an explicit args.project equal to the default (same-project search works)", async () => {
      runMemorySearch.mockResolvedValue({ results: [], degraded: null });

      await withClient(DEFAULT_PROJECT, async (client) => {
        await client.callTool({
          name: "memory_search",
          arguments: { query: "tabs vs spaces", project: DEFAULT_PROJECT },
        });
      });

      const [, params] = runMemorySearch.mock.calls[0];
      expect(params).toMatchObject({ query: "tabs vs spaces", project: DEFAULT_PROJECT });
    });

    it("rejects a cross-project search by default without touching the DB", async () => {
      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({
          name: "memory_search",
          arguments: { query: "tabs vs spaces", project: "some-other-project" },
        })
      );

      expect(result.isError).toBeFalsy(); // ok-style result, not a protocol error
      expect(result.structuredContent).toMatchObject({
        results: [],
        degraded: "cross-project search is disabled; set MEMORY_MCP_ALLOW_CROSS_PROJECT=1 to enable",
      });
      expect(runMemorySearch).not.toHaveBeenCalled();
      expect(getDb).not.toHaveBeenCalled();
    });

    it("allows a cross-project search when MEMORY_MCP_ALLOW_CROSS_PROJECT=1", async () => {
      const saved = process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT;
      process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT = "1";
      try {
        runMemorySearch.mockResolvedValue({ results: [], degraded: null });

        await withClient(DEFAULT_PROJECT, async (client) => {
          await client.callTool({
            name: "memory_search",
            arguments: { query: "tabs vs spaces", project: "some-other-project" },
          });
        });

        const [, params] = runMemorySearch.mock.calls[0];
        expect(params).toMatchObject({ project: "some-other-project" });
      } finally {
        if (saved === undefined) {
          delete process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT;
        } else {
          process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT = saved;
        }
      }
    });

    it("returns structuredContent matching what runMemorySearch resolved, on success", async () => {
      const payload = {
        results: [{ _id: "b1", text: "the user prefers tabs", scope: "project", type: "preference", importance: 0.6, score: 0.9 }],
        degraded: null,
      };
      runMemorySearch.mockResolvedValue(payload);

      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({ name: "memory_search", arguments: { query: "tabs" } })
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(payload);
      expect(JSON.parse(firstTextBlock(result as CallToolResult))).toEqual(payload);
    });

    it("returns isError true with a 'memory tool failed' message when runMemorySearch throws, and never leaks err.message (which can embed a connection string)", async () => {
      runMemorySearch.mockRejectedValue(
        new Error("mongot unavailable: mongodb+srv://user:supersecret@cluster0.example.mongodb.net/")
      );

      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({ name: "memory_search", arguments: { query: "tabs" } })
      );

      expect(result.isError).toBe(true);
      const text = firstTextBlock(result as CallToolResult);
      expect(text).toContain("memory tool failed");
      expect(text).toContain("Error"); // error NAME only
      expect(text).not.toContain("mongot unavailable");
      expect(text).not.toContain("mongodb+srv://");
    });
  });

  describe("memory_write", () => {
    it("falls back to the defaultProject passed to buildServer when args.project is omitted", async () => {
      runMemoryWrite.mockResolvedValue({ ok: true, observationId: "obs-1" });

      await withClient(DEFAULT_PROJECT, async (client) => {
        await client.callTool({ name: "memory_write", arguments: { text: "the user prefers tabs" } });
      });

      const [, params] = runMemoryWrite.mock.calls[0];
      expect(params).toMatchObject({ text: "the user prefers tabs", project: DEFAULT_PROJECT });
    });

    it("accepts an explicit args.project equal to the default (same-project write works)", async () => {
      runMemoryWrite.mockResolvedValue({ ok: true, observationId: "obs-1" });

      await withClient(DEFAULT_PROJECT, async (client) => {
        await client.callTool({
          name: "memory_write",
          arguments: { text: "the user prefers tabs", project: DEFAULT_PROJECT },
        });
      });

      const [, params] = runMemoryWrite.mock.calls[0];
      expect(params).toMatchObject({ project: DEFAULT_PROJECT });
    });

    it("rejects a cross-project write by default without touching the DB", async () => {
      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({
          name: "memory_write",
          arguments: { text: "the user prefers tabs", project: "some-other-project" },
        })
      );

      expect(result.isError).toBeFalsy(); // ok-style result, not a protocol error
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: "cross-project write is disabled; set MEMORY_MCP_ALLOW_CROSS_PROJECT=1 to enable",
      });
      expect(runMemoryWrite).not.toHaveBeenCalled();
      expect(getDb).not.toHaveBeenCalled();
    });

    it("allows a cross-project write when MEMORY_MCP_ALLOW_CROSS_PROJECT=1", async () => {
      const saved = process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT;
      process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT = "1";
      try {
        runMemoryWrite.mockResolvedValue({ ok: true, observationId: "obs-1" });

        await withClient(DEFAULT_PROJECT, async (client) => {
          await client.callTool({
            name: "memory_write",
            arguments: { text: "the user prefers tabs", project: "some-other-project" },
          });
        });

        const [, params] = runMemoryWrite.mock.calls[0];
        expect(params).toMatchObject({ project: "some-other-project" });
      } finally {
        if (saved === undefined) {
          delete process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT;
        } else {
          process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT = saved;
        }
      }
    });

    it("returns structuredContent matching what runMemoryWrite resolved, on success", async () => {
      const payload = { ok: true, observationId: "obs-1" };
      runMemoryWrite.mockResolvedValue(payload);

      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({ name: "memory_write", arguments: { text: "some text" } })
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(payload);
    });

    it("returns isError true with a 'memory tool failed' message when runMemoryWrite throws, and never leaks err.message (which can embed a connection string)", async () => {
      runMemoryWrite.mockRejectedValue(
        new Error("write failed: mongodb+srv://user:supersecret@cluster0.example.mongodb.net/")
      );

      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({ name: "memory_write", arguments: { text: "some text" } })
      );

      expect(result.isError).toBe(true);
      const text = firstTextBlock(result as CallToolResult);
      expect(text).toContain("memory tool failed");
      expect(text).toContain("Error"); // error NAME only
      expect(text).not.toContain("write failed: mongodb");
      expect(text).not.toContain("mongodb+srv://");
    });
  });

  describe("memory_forget", () => {
    it("falls back to the defaultProject passed to buildServer when args.project is omitted", async () => {
      runMemoryForget.mockResolvedValue({ matched: true });

      await withClient(DEFAULT_PROJECT, async (client) => {
        await client.callTool({ name: "memory_forget", arguments: { beliefId: "507f1f77bcf86cd799439011" } });
      });

      const [, params] = runMemoryForget.mock.calls[0];
      expect(params).toMatchObject({ beliefId: "507f1f77bcf86cd799439011", project: DEFAULT_PROJECT });
    });

    it("accepts an explicit args.project equal to the default (same-project forget works)", async () => {
      runMemoryForget.mockResolvedValue({ matched: true, recompiled: true });

      await withClient(DEFAULT_PROJECT, async (client) => {
        await client.callTool({
          name: "memory_forget",
          arguments: { beliefId: "507f1f77bcf86cd799439011", project: DEFAULT_PROJECT },
        });
      });

      const [, params] = runMemoryForget.mock.calls[0];
      expect(params).toMatchObject({ project: DEFAULT_PROJECT });
    });

    it("rejects a cross-project forget by default without touching the DB", async () => {
      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({
          name: "memory_forget",
          arguments: { beliefId: "507f1f77bcf86cd799439011", project: "some-other-project" },
        })
      );

      expect(result.isError).toBeFalsy(); // ok-style result, not a protocol error
      expect(result.structuredContent).toMatchObject({
        matched: false,
        recompiled: false,
        error: "cross-project forget is disabled; set MEMORY_MCP_ALLOW_CROSS_PROJECT=1 to enable",
      });
      expect(runMemoryForget).not.toHaveBeenCalled();
      expect(getDb).not.toHaveBeenCalled();
    });

    it("allows a cross-project forget when MEMORY_MCP_ALLOW_CROSS_PROJECT=1", async () => {
      const saved = process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT;
      process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT = "1";
      try {
        runMemoryForget.mockResolvedValue({ matched: true, recompiled: true });

        await withClient(DEFAULT_PROJECT, async (client) => {
          await client.callTool({
            name: "memory_forget",
            arguments: { beliefId: "507f1f77bcf86cd799439011", project: "some-other-project" },
          });
        });

        const [, params] = runMemoryForget.mock.calls[0];
        expect(params).toMatchObject({ project: "some-other-project" });
      } finally {
        if (saved === undefined) {
          delete process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT;
        } else {
          process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT = saved;
        }
      }
    });

    it("returns structuredContent matching what runMemoryForget resolved, on success", async () => {
      const payload = { matched: false };
      runMemoryForget.mockResolvedValue(payload);

      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({ name: "memory_forget", arguments: { beliefId: "507f1f77bcf86cd799439011" } })
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(payload);
    });

    it("returns isError true with a 'memory tool failed' message when runMemoryForget throws, and never leaks err.message (which can embed a connection string)", async () => {
      runMemoryForget.mockRejectedValue(
        new Error("forget failed: mongodb+srv://user:supersecret@cluster0.example.mongodb.net/")
      );

      const result = await withClient(DEFAULT_PROJECT, (client) =>
        client.callTool({ name: "memory_forget", arguments: { beliefId: "507f1f77bcf86cd799439011" } })
      );

      expect(result.isError).toBe(true);
      const text = firstTextBlock(result as CallToolResult);
      expect(text).toContain("memory tool failed");
      expect(text).toContain("Error"); // error NAME only
      expect(text).not.toContain("forget failed: mongodb");
      expect(text).not.toContain("mongodb+srv://");
    });
  });
});

describe("createShutdownHandler", () => {
  it("only closes the server and db once, even when invoked twice (shuttingDown double-close guard)", async () => {
    const close = vi.fn(async () => undefined);
    const closeDbFn = vi.fn(async () => undefined);
    const shutdown = createShutdownHandler({ close }, closeDbFn);

    await shutdown();
    await shutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(closeDbFn).toHaveBeenCalledTimes(1);
  });

  it("swallows a server.close() rejection without throwing, and still closes the db", async () => {
    const close = vi.fn(async () => {
      throw new Error("transport close failed");
    });
    const closeDbFn = vi.fn(async () => undefined);
    const shutdown = createShutdownHandler({ close }, closeDbFn);

    await expect(shutdown()).resolves.toBeUndefined();
    expect(closeDbFn).toHaveBeenCalledTimes(1);
  });

  it("swallows a closeDb() rejection without throwing, after still closing the server", async () => {
    const close = vi.fn(async () => undefined);
    const closeDbFn = vi.fn(async () => {
      throw new Error("db close failed");
    });
    const shutdown = createShutdownHandler({ close }, closeDbFn);

    await expect(shutdown()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
