import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reconcileCandidate } from "../src/consolidation/reconcileBelief.js";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.MEMORY_FAILURE_LOG;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MEMORY_FAILURE_LOG;
  else process.env.MEMORY_FAILURE_LOG = savedEnv;
});

const existing = [
  { _id: "belief-1", text: "the rate limit is 10 requests per second" },
  { _id: "belief-2", text: "the user prefers tabs over spaces" },
];

describe("reconcileCandidate", () => {
  it("returns the parsed verdicts when callLLM resolves with a well-formed response", async () => {
    const callLLM = vi.fn(async () => ({
      verdicts: [
        { belief_id: "belief-1", verdict: "supersedes" },
        { belief_id: "belief-2", verdict: "unrelated" },
      ],
    }));

    const result = await reconcileCandidate(
      "the rate limit is actually 20 requests per second",
      existing,
      callLLM
    );

    expect(result).toEqual([
      { beliefId: "belief-1", verdict: "supersedes" },
      { beliefId: "belief-2", verdict: "unrelated" },
    ]);
    expect(callLLM).toHaveBeenCalledTimes(1);
    const [systemPrompt, userPrompt, toolName, toolSchema] = callLLM.mock.calls[0];
    expect(systemPrompt).toBeTypeOf("string");
    expect(userPrompt).toContain("the rate limit is actually 20 requests per second");
    expect(userPrompt).toContain("belief_id=belief-1");
    expect(userPrompt).toContain("belief_id=belief-2");
    expect(toolName).toBeTypeOf("string");
    expect(toolSchema).toBeTypeOf("object");
  });

  it("drops a verdict whose belief_id was not in the provided list", async () => {
    const callLLM = vi.fn(async () => ({
      verdicts: [
        { belief_id: "belief-1", verdict: "duplicate" },
        { belief_id: "some-other-id-never-offered", verdict: "supersedes" },
      ],
    }));

    const result = await reconcileCandidate("candidate text", existing, callLLM);

    expect(result).toEqual([{ beliefId: "belief-1", verdict: "duplicate" }]);
  });

  it("drops a verdict whose verdict value is not one of the fixed enum values", async () => {
    const callLLM = vi.fn(async () => ({
      verdicts: [
        { belief_id: "belief-1", verdict: "duplicate" },
        { belief_id: "belief-2", verdict: "definitely_true" },
      ],
    }));

    const result = await reconcileCandidate("candidate text", existing, callLLM);

    expect(result).toEqual([{ beliefId: "belief-1", verdict: "duplicate" }]);
  });

  it("fails open ([]) and logs via appendFailure when callLLM rejects", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-reconcile-"));
    const logFile = path.join(dir, "failures.log");
    process.env.MEMORY_FAILURE_LOG = logFile;

    const callLLM = vi.fn(async () => {
      throw new Error("provider timed out");
    });

    const result = await reconcileCandidate("candidate text", existing, callLLM);

    expect(result).toEqual([]);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("reconcileBelief");
    expect(content).toContain("Error");
  });

  it("fails open ([]) and logs via appendFailure when callLLM resolves with a response missing the verdicts array", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-reconcile-missing-"));
    const logFile = path.join(dir, "failures.log");
    process.env.MEMORY_FAILURE_LOG = logFile;

    const callLLM = vi.fn(async () => ({ nothingHere: true }));

    const result = await reconcileCandidate("candidate text", existing, callLLM);

    expect(result).toEqual([]);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("reconcileBelief");
  });

  it("fails open ([]) when callLLM resolves with verdicts as a non-array value", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-reconcile-nonarray-"));
    process.env.MEMORY_FAILURE_LOG = path.join(dir, "failures.log");

    const callLLM = vi.fn(async () => ({ verdicts: "not-an-array" }));

    const result = await reconcileCandidate("candidate text", existing, callLLM);

    expect(result).toEqual([]);
  });

  it("drops junk entries inside the verdicts array (non-objects, missing fields) instead of throwing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mongo-claude-memory-reconcile-junk-"));
    process.env.MEMORY_FAILURE_LOG = path.join(dir, "failures.log");

    const callLLM = vi.fn(async () => ({
      verdicts: [42, "a string entry", null, { belief_id: "belief-1" }, { verdict: "duplicate" }],
    }));

    const result = await reconcileCandidate("candidate text", existing, callLLM);

    expect(result).toEqual([]);
  });
});
