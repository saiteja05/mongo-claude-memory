import { describe, it, expect, vi } from "vitest";
import { runMemoryWrite } from "../src/mcp/memoryWrite.js";

const fakeDb = {} as any;

describe("runMemoryWrite", () => {
  it("writes an observation with source mcp_write and priority high", async () => {
    const writeObservation = vi.fn().mockResolvedValue("obs-1");

    const result = await runMemoryWrite(
      fakeDb,
      { project: "myrepo-abc", text: "the user prefers tabs" },
      { writeObservation }
    );

    expect(result.ok).toBe(true);
    expect(result.observationId).toBe("obs-1");
    expect(writeObservation).toHaveBeenCalledTimes(1);
    const [, params] = writeObservation.mock.calls[0];
    expect(params).toMatchObject({
      project: "myrepo-abc",
      source: "mcp_write",
      priority: "high",
      text: "the user prefers tabs",
    });
  });

  it("passes session_id through when provided, and defaults it otherwise", async () => {
    const writeObservation = vi.fn().mockResolvedValue("obs-1");

    await runMemoryWrite(
      fakeDb,
      { project: "myrepo-abc", text: "some text", session_id: "sess-42" },
      { writeObservation }
    );

    expect(writeObservation.mock.calls[0][1].session_id).toBe("sess-42");

    writeObservation.mockClear();
    await runMemoryWrite(fakeDb, { project: "myrepo-abc", text: "some text" }, { writeObservation });
    expect(writeObservation.mock.calls[0][1].session_id).toBe("mcp:memory_write");
  });

  it("rejects empty text without calling writeObservation", async () => {
    const writeObservation = vi.fn().mockResolvedValue("obs-1");

    const result = await runMemoryWrite(fakeDb, { project: "myrepo-abc", text: "" }, { writeObservation });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(writeObservation).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only text without calling writeObservation", async () => {
    const writeObservation = vi.fn().mockResolvedValue("obs-1");

    const result = await runMemoryWrite(fakeDb, { project: "myrepo-abc", text: "   " }, { writeObservation });

    expect(result.ok).toBe(false);
    expect(writeObservation).not.toHaveBeenCalled();
  });

  it("never touches the beliefs collection: the db handle it receives is only ever passed through to writeObservation", async () => {
    const collectionSpy = vi.fn();
    const dbWithSpy = { collection: collectionSpy };
    const writeObservation = vi.fn().mockResolvedValue("obs-1");

    await runMemoryWrite(dbWithSpy as any, { project: "myrepo-abc", text: "text" }, { writeObservation });

    // runMemoryWrite itself must never call db.collection (that would mean it
    // is bypassing writeObservation and touching a collection directly).
    expect(collectionSpy).not.toHaveBeenCalled();
    expect(writeObservation).toHaveBeenCalledWith(dbWithSpy, expect.anything());
  });
});
