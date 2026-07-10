import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { loadConfig } from "../config.js";
import type { Config } from "../config.js";
import { getDb, closeDb } from "../db/client.js";
import { OBSERVATIONS } from "../db/schema.js";
import { embed } from "../embeddings/voyage.js";
import { runConsolidation, fetchExistingBeliefs, markConsolidated } from "./run.js";
import type { RunConsolidationDeps } from "./run.js";
import { reclaimStale, claimBatch } from "./claim.js";
import { acquireLease, renewLease, releaseLease } from "./lock.js";
import { extractFacts } from "./extractFacts.js";
import { upsertBelief } from "./upsertBelief.js";
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

async function findPendingProjects(db: Db): Promise<string[]> {
  const projects = await db
    .collection(OBSERVATIONS)
    .distinct("project", { status: "pending" });
  return projects as string[];
}

function buildDeps(config: Config, runId: string): RunConsolidationDeps {
  return {
    runId,
    leaseMs: config.leaseMs,
    claimBatchSize: config.claimBatchSize,
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
    embed: (texts: string[]) => embed(texts, "document"),
    upsertBelief: (db, project, candidate, embedding, threshold) =>
      upsertBelief(db, project, candidate, embedding, threshold, {
        mode: config.embeddingMode,
        model: config.voyageModel,
      }),
    compileBrief,
    markConsolidated,
  };
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
          err instanceof Error ? err.message : "unknown error"
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

    if (!config.anthropicApiKey) {
      // Mirrors how the rest of the system degrades when a credential is
      // missing (DESIGN.md section 10): log clearly and exit cleanly.
      console.error("[consolidate] ANTHROPIC_API_KEY is not configured; skipping consolidation run.");
      return;
    }

    const dryRun = args.includes("--dry-run");
    const argProject = args.find((arg) => !arg.startsWith("--"));

    const db = await getDb();

    const projects = argProject ? [argProject] : await findPendingProjects(db);
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
      `[consolidate] unexpected failure: ${err instanceof Error ? err.message : "unknown error"}`
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
