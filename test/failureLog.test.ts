import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendFailure, failureLogPath } from "../src/telemetry/failureLog.js";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.MEMORY_FAILURE_LOG;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MEMORY_FAILURE_LOG;
  else process.env.MEMORY_FAILURE_LOG = savedEnv;
});

describe("appendFailure", () => {
  it("appends one line with an ISO timestamp, the component, and the error NAME only (never the message)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-faillog-"));
    const logFile = path.join(dir, "nested", "failures.log");
    process.env.MEMORY_FAILURE_LOG = logFile;

    const err = new Error("mongodb+srv://user:secret@cluster.example.net failed");
    err.name = "MongoServerSelectionError";
    appendFailure("sessionStart", err);
    appendFailure("memorySearch", "AllPathsFailed");

    const content = readFileSync(logFile, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z sessionStart MongoServerSelectionError$/);
    expect(lines[1]).toMatch(/ memorySearch AllPathsFailed$/);
    // Never the message: a driver message can embed connection details.
    expect(content).not.toContain("mongodb+srv");
    expect(content).not.toContain("secret");
  });

  it("swallows its own errors when the destination is unwritable", () => {
    // A path nested under a regular FILE (not a directory) cannot be created,
    // so mkdirSync inside appendFailure fails; it must swallow that.
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-faillog-bad-"));
    const blockingFile = path.join(dir, "blocking");
    writeFileSync(blockingFile, "i am a file", "utf8");
    process.env.MEMORY_FAILURE_LOG = path.join(blockingFile, "sub", "failures.log");

    expect(() => appendFailure("sessionEnd", new Error("boom"))).not.toThrow();
    expect(existsSync(path.join(blockingFile, "sub"))).toBe(false);
  });

  it("defaults to ~/.mongo-claude-memory/failures.log when MEMORY_FAILURE_LOG is unset", () => {
    delete process.env.MEMORY_FAILURE_LOG;
    expect(failureLogPath()).toMatch(/\.mongo-claude-memory[/\\]failures\.log$/);
  });
});
