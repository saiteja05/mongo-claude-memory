import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { loadConfig } from "../config.js";
import type { Config } from "../config.js";
import { getDb, closeDb } from "../db/client.js";
import { OBSERVATIONS, BRIEFS } from "../db/schema.js";
import { embed } from "../embeddings/voyage.js";
import { writeObservation } from "../capture/writeObservation.js";
import { runConsolidation, fetchExistingBeliefs, markConsolidated } from "./run.js";
import type { RunConsolidationDeps } from "./run.js";
import { reclaimStale, claimBatch } from "./claim.js";
import { acquireLease, renewLease, releaseLease } from "./lock.js";
import { extractFacts } from "./extractFacts.js";
import { classifyInjection } from "./classifyInjection.js";
import { upsertBelief } from "./upsertBelief.js";
import { reconcileCandidate } from "./reconcileBelief.js";
import { compileBrief } from "./compileBrief.js";
import { runConsolidationDryRun, formatDryRunReport, defaultDryRunDeps } from "./dryRun.js";
import { runRollback, formatRollbackReport } from "./rollback.js";
import { getStatusReport, formatStatusReport } from "./status.js";

/**
 * cli.ts, the cron/Atlas-Trigger entry point (dist/consolidation/cli.js). Not
 * a Claude Code hook, so it prints normal progress output and can exit
 * non-zero on a genuine crash, unlike the hooks which must always fail open
 * with exit(0).
 */

/**
 * Discovers projects with work to do: the union of projects with pending
 * observations AND projects with stale claimed observations (claimed longer
 * ago than reclaimAfterMs, i.e. a crashed run's stranded batch). Without the
 * second arm, a crashed run's batch would sit invisible to discovery forever
 * unless an operator happened to pass that project explicitly: the reclaim
 * sweep only runs inside a project's own consolidation pass.
 */
export async function findPendingProjects(db: Db, reclaimAfterMs: number): Promise<string[]> {
  const collection = db.collection(OBSERVATIONS);
  const pending = await collection.distinct("project", { status: "pending" });
  const staleThreshold = new Date(Date.now() - reclaimAfterMs);
  const stale = await collection.distinct("project", {
    status: "claimed",
    claimed_at: { $lt: staleThreshold },
  });
  return Array.from(new Set([...(pending as string[]), ...(stale as string[])]));
}

function buildDeps(config: Config, runId: string): RunConsolidationDeps {
  return {
    runId,
    leaseMs: config.leaseMs,
    claimBatchSize: config.claimBatchSize,
    consolidationBatchMaxChars: config.consolidationBatchMaxChars,
    reclaimAfterMs: config.reclaimAfterMs,
    beliefsContextLimit: config.beliefsContextLimit,
    dedupeSimilarityThreshold: config.dedupeSimilarityThreshold,
    embeddingMode: config.embeddingMode,
    reclaimStale,
    acquireLease,
    renewLease,
    releaseLease,
    claimBatch,
    fetchExistingBeliefs,
    extractFacts,
    classifyInjection,
    embed: (texts: string[]) => embed(texts, "document"),
    upsertBelief: (db, project, candidate, embedding, threshold, candidateEvidenceAt) =>
      upsertBelief(
        db,
        project,
        candidate,
        embedding,
        threshold,
        {
          mode: config.embeddingMode,
          model: config.voyageModel,
        },
        candidateEvidenceAt,
        { threshold: config.reconcileSimilarityThreshold, reconcile: reconcileCandidate }
      ),
    compileBrief,
    markConsolidated,
  };
}

export interface DoctorStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  steps: DoctorStep[];
}

/**
 * --doctor: end-to-end connectivity self-check for diagnosing silent
 * failures. Writes a canary observation to project "doctor:canary" (normal
 * priority, so the observation TTL cleans up any leftovers), reads it back,
 * deletes it, and times a brief:global fetch against the SessionStart
 * budget. Reports each step's latency and pass/fail; never prints connection
 * strings or raw driver error messages (error NAME only).
 */
export async function runDoctor(db: Db, sessionStartTimeoutMs: number): Promise<DoctorReport> {
  const steps: DoctorStep[] = [];

  async function step(name: string, fn: () => Promise<string | undefined>): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - startedAt, detail });
      return true;
    } catch (err) {
      steps.push({
        name,
        ok: false,
        ms: Date.now() - startedAt,
        detail: err instanceof Error ? err.name : "unknown error",
      });
      return false;
    }
  }

  let canaryId: unknown;
  const wrote = await step("write canary observation", async () => {
    canaryId = await writeObservation(db, {
      project: "doctor:canary",
      session_id: "doctor",
      source: "transcript",
      priority: "normal",
      text: `doctor canary written at ${new Date().toISOString()}`,
    });
    return undefined;
  });

  if (wrote) {
    await step("read canary back", async () => {
      const found = await db
        .collection(OBSERVATIONS)
        .findOne({ _id: canaryId as never });
      if (!found) throw new Error("CanaryNotFound");
      return undefined;
    });

    await step("delete canary", async () => {
      await db.collection(OBSERVATIONS).deleteOne({ _id: canaryId as never });
      return undefined;
    });
  }

  await step(`fetch brief:global within ${sessionStartTimeoutMs}ms budget`, async () => {
    const startedAt = Date.now();
    const doc = await db.collection(BRIEFS).findOne({ _id: "brief:global" as never });
    const elapsed = Date.now() - startedAt;
    if (elapsed > sessionStartTimeoutMs) {
      throw new Error("BriefFetchOverBudget");
    }
    return doc ? `found (${elapsed}ms)` : `no brief:global document yet (${elapsed}ms)`;
  });

  return { ok: steps.every((s) => s.ok), steps };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["[doctor] connectivity self-check:"];
  for (const step of report.steps) {
    lines.push(
      `  ${step.ok ? "PASS" : "FAIL"}  ${step.name} (${step.ms}ms)` +
        (step.detail ? ` ${step.detail}` : "")
    );
  }
  lines.push(report.ok ? "[doctor] all steps passed" : "[doctor] one or more steps FAILED");
  return lines.join("\n");
}

// Parses the run id for the "--rollback" operator flag: either "--run-id
// <id>" anywhere in the args, or the first remaining positional (any arg
// that is not itself a "--" flag) when --run-id is not given, e.g.
// "--rollback abc-123".
function parseRollbackRunId(args: string[]): string | undefined {
  const flagIndex = args.indexOf("--run-id");
  if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) {
    return args[flagIndex + 1];
  }
  return args.find((arg) => arg !== "--rollback" && !arg.startsWith("--"));
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  try {
    let config: Config;
    try {
      config = loadConfig();
    } catch (err) {
      // Missing MONGODB_URI: mirrors how hooks fail open on missing config,
      // a clean no-op rather than a crash (there is nothing this job can do).
      console.error(
        `[consolidate] configuration error, skipping run: ${
          err instanceof Error ? err.name : "unknown error"
        }`
      );
      return;
    }

    // "--status" and "--rollback" are read/operator subcommands, dispatched
    // off an explicit flag rather than a bare positional. This is
    // deliberate: the default consolidation path takes a project name as a
    // bare positional (see argProject below), and a project can legitimately
    // be named "status" or "rollback". Gating on an explicit "--" flag means
    // that positional can never collide with, or be silently reinterpreted
    // as, an operator subcommand. Neither flag calls the LLM, so neither
    // needs the ANTHROPIC_API_KEY check below, which stays scoped to the
    // default (and dry-run) consolidation path only.
    if (args.includes("--status")) {
      const db = await getDb();
      const report = await getStatusReport(db, config.reclaimAfterMs);
      console.log(formatStatusReport(report));
      return;
    }

    if (args.includes("--rollback")) {
      const runId = parseRollbackRunId(args);
      if (!runId) {
        console.error(
          "[consolidate] --rollback requires a run id: pass --run-id <id> or a positional id."
        );
        process.exitCode = 1;
        return;
      }
      const db = await getDb();
      const result = await runRollback(db, runId);
      console.log(formatRollbackReport(runId, result));
      return;
    }

    if (args.includes("--doctor")) {
      const db = await getDb();
      const report = await runDoctor(db, config.sessionStartTimeoutMs);
      console.log(formatDoctorReport(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
      return;
    }

    if (config.llmProvider === "anthropic" && !config.anthropicApiKey) {
      // Mirrors how the rest of the system degrades when a credential is
      // missing (DESIGN.md section 10): log clearly and exit cleanly. Only
      // applies to the anthropic provider: a bedrock-configured machine uses
      // AWS credentials instead, and an ollama-configured machine talks to a
      // local model, so neither should be gated on this check.
      console.error(
        "[consolidate] ANTHROPIC_API_KEY is not configured; skipping consolidation run. Set LLM_PROVIDER=bedrock to use AWS credentials, or LLM_PROVIDER=ollama for a local free model, instead."
      );
      return;
    }

    const dryRun = args.includes("--dry-run");
    const argProject = args.find((arg) => !arg.startsWith("--"));

    const db = await getDb();

    const projects = argProject
      ? [argProject]
      : await findPendingProjects(db, config.reclaimAfterMs);
    if (projects.length === 0) {
      console.log("[consolidate] no projects with pending observations; nothing to do.");
      return;
    }

    // Sequential, not parallel, to keep this simple and avoid needing a
    // connection pool sized for concurrency.
    for (const project of projects) {
      if (dryRun) {
        try {
          const deps = defaultDryRunDeps(config.claimBatchSize, config.beliefsContextLimit);
          const result = await runConsolidationDryRun(db, project, deps);
          console.log(formatDryRunReport(project, result));
        } catch (err) {
          console.error(
            `[consolidate] project="${project}": dry run failed: ${
              err instanceof Error ? err.message : "unknown error"
            }`
          );
          process.exitCode = 1;
        }
        continue;
      }

      const runId = randomUUID();
      try {
        const result = await runConsolidation(db, project, buildDeps(config, runId));
        if (result.skipped) {
          console.log(`[consolidate] project="${project}": skipped (${result.reason})`);
        } else {
          console.log(`[consolidate] project="${project}": processed ${result.processed} fact(s)`);
        }
      } catch (err) {
        console.error(
          `[consolidate] project="${project}": run failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`
        );
        process.exitCode = 1;
      }
    }
  } catch (err) {
    console.error(
      `[consolidate] unexpected failure: ${err instanceof Error ? err.name : "unknown error"}`
    );
    process.exitCode = 1;
  } finally {
    try {
      await closeDb();
    } catch {
      // Ignore close errors; the process is exiting regardless.
    }
  }
}

// Only run main() when this file is the actual entry point (node dist/consolidation/cli.js),
// never when imported as a module.
const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  main();
}
