import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { getDb, closeDb } from "../db/client.js";
import { OBSERVATIONS, BRIEFS, BELIEFS } from "../db/schema.js";
import { embed } from "../embeddings/voyage.js";
import { writeObservation } from "../capture/writeObservation.js";
import { runConsolidation, fetchExistingBeliefs, markConsolidated, markObservationFailed } from "./run.js";
import { reclaimStale, claimBatch } from "./claim.js";
import { acquireLease, renewLease, releaseLease } from "./lock.js";
import { extractFacts } from "./extractFacts.js";
import { classifyInjection } from "./classifyInjection.js";
import { upsertBelief } from "./upsertBelief.js";
import { reconcileCandidate } from "./reconcileBelief.js";
import { compileBrief } from "./compileBrief.js";
import { runConsolidationDryRun, formatDryRunReport, defaultDryRunDeps } from "./dryRun.js";
import { runRollback, formatRollbackReport } from "./rollback.js";
import { runReconcileSweep, formatReconcileReport } from "./reconcileSweep.js";
import { getStatusReport, formatStatusReport } from "./status.js";
import { computeBatchMaxCharsDefault, getContextWindowTokens } from "../llm/contextWindow.js";
import { MAX_OBSERVATION_TEXT_LENGTH } from "../capture/constants.js";
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
export async function findPendingProjects(db, reclaimAfterMs) {
    const collection = db.collection(OBSERVATIONS);
    const pending = await collection.distinct("project", { status: "pending" });
    const staleThreshold = new Date(Date.now() - reclaimAfterMs);
    const stale = await collection.distinct("project", {
        status: "claimed",
        claimed_at: { $lt: staleThreshold },
    });
    return Array.from(new Set([...pending, ...stale]));
}
/**
 * Resolves the extraction batch's character budget: an explicit
 * CONSOLIDATION_BATCH_MAX_CHARS always wins (config.consolidationBatchMaxChars
 * is only defined when that env var was set to a valid number), otherwise
 * falls back to a model-aware default sized to the configured consolidation
 * model's context window (llm/contextWindow.ts), instead of one fixed
 * constant regardless of provider.
 */
export function resolveBatchMaxChars(config) {
    return config.consolidationBatchMaxChars ?? computeBatchMaxCharsDefault(config);
}
function buildDeps(config, runId) {
    return {
        runId,
        leaseMs: config.leaseMs,
        claimBatchSize: config.claimBatchSize,
        consolidationBatchMaxChars: resolveBatchMaxChars(config),
        reclaimAfterMs: config.reclaimAfterMs,
        beliefsContextLimit: config.beliefsContextLimit,
        dedupeSimilarityThreshold: config.dedupeSimilarityThreshold,
        maxConsecutiveTerminalExtractionFailures: config.maxConsecutiveTerminalExtractionFailures,
        embeddingMode: config.embeddingMode,
        reclaimStale,
        acquireLease,
        renewLease,
        releaseLease,
        claimBatch,
        fetchExistingBeliefs,
        extractFacts,
        classifyInjection,
        embed: (texts) => embed(texts, "document"),
        upsertBelief: (db, project, candidate, embedding, threshold, candidateEvidenceAt) => upsertBelief(db, project, candidate, embedding, threshold, {
            mode: config.embeddingMode,
            model: config.voyageModel,
        }, candidateEvidenceAt, { threshold: config.reconcileSimilarityThreshold, reconcile: reconcileCandidate }),
        compileBrief,
        markConsolidated,
        markFailed: markObservationFailed,
    };
}
// Wires --reconcile's deps from config the same way buildDeps wires
// upsertBelief's write-time reconciliation options: reconcileMaxPairs caps
// how many LLM arbitration calls one sweep can make, embeddingMode/voyageModel
// are the same fields buildDeps already passes through as upsertBelief's
// EmbeddingModeOptions.
function buildReconcileDeps(config) {
    return {
        threshold: config.reconcileSimilarityThreshold,
        maxPairs: config.reconcileMaxPairs,
        embeddingMode: config.embeddingMode,
        model: config.voyageModel,
        reconcile: reconcileCandidate,
        compileBrief,
    };
}
// Search index names the doctor's "search indexes" step checks for. These
// must match setupIndexes.ts's index names and upsertBelief.ts's
// BELIEFS_VECTOR_INDEX / BELIEFS_VECTOR_INDEX_AUTO constants exactly (kept as
// separate literals here, the same way upsertBelief.ts duplicates rather than
// imports setupIndexes.ts's names, since this file only reads them for a
// self-check and does not otherwise depend on those modules).
const BELIEFS_VECTOR_INDEX_APPSIDE = "beliefs_vec";
const BELIEFS_VECTOR_INDEX_AUTO = "beliefs_vec_auto";
const BELIEFS_TEXT_INDEX = "beliefs_text";
// A doctor step's own hand-authored failure detail (never derived from a
// driver/provider error's message, which can embed a connection string).
// step()'s catch handler below special-cases this type so it can safely
// surface the full message instead of falling back to the error NAME only,
// without weakening the "never print raw driver error messages" rule for
// every other step, which still only ever sees err.name.
class DoctorCheckFailure extends Error {
    constructor(message) {
        super(message);
        this.name = "DoctorCheckFailure";
    }
}
/**
 * --doctor: end-to-end connectivity self-check for diagnosing silent
 * failures. Writes a canary observation to project "doctor:canary" (normal
 * priority, so the observation TTL cleans up any leftovers), reads it back,
 * deletes it, times a brief:global fetch against the SessionStart budget,
 * and verifies the Atlas search indexes the configured embedding mode
 * requires actually exist and are queryable (a missing vector index makes
 * $vectorSearch return empty results instead of erroring, silently
 * disabling vector dedupe, memory_search, and reconciliation). Reports each
 * step's latency and pass/fail; never prints connection strings or raw
 * driver error messages (error NAME only).
 */
export async function runDoctor(db, sessionStartTimeoutMs, embeddingMode = "appside") {
    const steps = [];
    async function step(name, fn) {
        const startedAt = Date.now();
        try {
            const detail = await fn();
            steps.push({ name, ok: true, ms: Date.now() - startedAt, detail });
            return true;
        }
        catch (err) {
            const detail = err instanceof DoctorCheckFailure
                ? err.message
                : err instanceof Error
                    ? err.name
                    : "unknown error";
            steps.push({ name, ok: false, ms: Date.now() - startedAt, detail });
            return false;
        }
    }
    let canaryId;
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
                .findOne({ _id: canaryId });
            if (!found)
                throw new Error("CanaryNotFound");
            return undefined;
        });
        await step("delete canary", async () => {
            await db.collection(OBSERVATIONS).deleteOne({ _id: canaryId });
            return undefined;
        });
    }
    await step(`fetch brief:global within ${sessionStartTimeoutMs}ms budget`, async () => {
        const startedAt = Date.now();
        const doc = await db.collection(BRIEFS).findOne({ _id: "brief:global" });
        const elapsed = Date.now() - startedAt;
        if (elapsed > sessionStartTimeoutMs) {
            throw new Error("BriefFetchOverBudget");
        }
        return doc ? `found (${elapsed}ms)` : `no brief:global document yet (${elapsed}ms)`;
    });
    await step("search indexes", async () => {
        const requiredVectorIndex = embeddingMode === "auto" ? BELIEFS_VECTOR_INDEX_AUTO : BELIEFS_VECTOR_INDEX_APPSIDE;
        const requiredNames = [requiredVectorIndex, BELIEFS_TEXT_INDEX];
        let indexDocs;
        try {
            indexDocs = await db
                .collection(BELIEFS)
                .aggregate([{ $listSearchIndexes: {} }])
                .toArray();
        }
        catch (err) {
            // Older clusters (no mongot / Atlas Search support) throw here rather
            // than returning an empty list. Fail this step soft with the error
            // NAME only (never err.message, which can embed a connection string)
            // plus a static, hand-authored note; every other doctor step above and
            // below runs independently and is unaffected either way.
            const name = err instanceof Error ? err.name : "unknown error";
            throw new DoctorCheckFailure(`${name}: search-index verification is unavailable on this cluster (no $listSearchIndexes support).`);
        }
        const queryableByName = new Map();
        for (const doc of indexDocs) {
            if (typeof doc.name === "string") {
                queryableByName.set(doc.name, doc.queryable === true);
            }
        }
        const results = requiredNames.map((name) => ({
            name,
            found: queryableByName.has(name),
            queryable: queryableByName.get(name) === true,
        }));
        const summary = results
            .map((r) => `${r.name}: ${r.found ? `found, queryable=${r.queryable}` : "MISSING"}`)
            .join(", ");
        if (results.every((r) => r.found && r.queryable)) {
            return summary;
        }
        throw new DoctorCheckFailure(`${summary} -- run node dist/db/setupIndexes.js to create the missing search index(es). ` +
            "A missing vector index makes $vectorSearch return empty instead of erroring, so vector " +
            "dedupe, memory_search, and reconciliation silently degrade.");
    });
    return { ok: steps.every((s) => s.ok), steps };
}
export function formatDoctorReport(report) {
    const lines = ["[doctor] connectivity self-check:"];
    for (const step of report.steps) {
        lines.push(`  ${step.ok ? "PASS" : "FAIL"}  ${step.name} (${step.ms}ms)` +
            (step.detail ? ` ${step.detail}` : ""));
    }
    lines.push(report.ok ? "[doctor] all steps passed" : "[doctor] one or more steps FAILED");
    return lines.join("\n");
}
// Parses the run id for the "--rollback" operator flag: either "--run-id
// <id>" anywhere in the args, or the first remaining positional (any arg
// that is not itself a "--" flag) when --run-id is not given, e.g.
// "--rollback abc-123".
function parseRollbackRunId(args) {
    const flagIndex = args.indexOf("--run-id");
    if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) {
        return args[flagIndex + 1];
    }
    return args.find((arg) => arg !== "--rollback" && !arg.startsWith("--"));
}
// Parses the project positional for the "--reconcile" operator flag: the
// first remaining arg that is not itself a "--" flag (and not "--reconcile"
// itself), the same bare-positional convention parseRollbackRunId falls back
// to for "--rollback".
function parseReconcileProject(args) {
    return args.find((arg) => arg !== "--reconcile" && !arg.startsWith("--"));
}
// Parses the project positional for the "--retry-failed" operator flag: the
// first remaining arg that is not itself a "--" flag (and not "--retry-failed"
// itself), the same bare-positional convention parseReconcileProject uses.
// Required, refused the same way --rollback refuses a missing run id: there
// is no sane default project to reset "failed" observations for.
function parseRetryFailedProject(args) {
    return args.find((arg) => arg !== "--retry-failed" && !arg.startsWith("--"));
}
/**
 * --retry-failed <project>: undoes markObservationFailed / the circuit
 * breaker's terminal path by resetting every "failed" observation in the
 * named project back to "pending" and clearing the fields that failure (and
 * the claim it happened under) set, so the next consolidation run picks them
 * up as if they had never been claimed. This is the only operator path that
 * can un-fail an observation; before it existed, recovering from a bad batch
 * of terminal failures required a hand-written Mongo update. Zero matches
 * (nothing was "failed" for this project) is a normal outcome, not an error.
 */
export async function runRetryFailed(db, project) {
    const result = await db.collection(OBSERVATIONS).updateMany({ project, status: "failed" }, {
        $set: { status: "pending" },
        $unset: { failed_at: "", failure_reason: "", run_id: "", claimed_at: "" },
    });
    return result.modifiedCount;
}
export async function main() {
    const args = process.argv.slice(2);
    try {
        let config;
        try {
            config = loadConfig();
        }
        catch (err) {
            // Missing MONGODB_URI: mirrors how hooks fail open on missing config,
            // a clean no-op rather than a crash (there is nothing this job can do).
            console.error(`[consolidate] configuration error, skipping run: ${err instanceof Error ? err.name : "unknown error"}`);
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
                console.error("[consolidate] --rollback requires a run id: pass --run-id <id> or a positional id.");
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
            const report = await runDoctor(db, config.sessionStartTimeoutMs, config.embeddingMode);
            console.log(formatDoctorReport(report));
            if (!report.ok) {
                process.exitCode = 1;
            }
            return;
        }
        // "--retry-failed" is also a read/operator-adjacent subcommand placed
        // alongside --status/--rollback/--doctor, not gated behind the
        // ANTHROPIC_API_KEY check below: it only issues a plain updateMany, no
        // LLM call, so it must keep working even when the very provider outage
        // that caused the failures it is recovering from is still unresolved.
        if (args.includes("--retry-failed")) {
            const retryProject = parseRetryFailedProject(args);
            if (!retryProject) {
                console.error("[consolidate] --retry-failed requires a project: pass it as a positional argument.");
                process.exitCode = 1;
                return;
            }
            const db = await getDb();
            const resetCount = await runRetryFailed(db, retryProject);
            if (resetCount === 0) {
                console.log(`[consolidate] project="${retryProject}": no failed observations to retry.`);
            }
            else {
                console.log(`[consolidate] project="${retryProject}": reset ${resetCount} failed observation(s) to ` +
                    "pending; the next consolidation run will pick them up.");
            }
            return;
        }
        if (config.llmProvider === "anthropic" && !config.anthropicApiKey) {
            // Mirrors how the rest of the system degrades when a credential is
            // missing (DESIGN.md section 10): log clearly and exit cleanly. Only
            // applies to the anthropic provider: a bedrock-configured machine uses
            // AWS credentials instead, and an ollama-configured machine talks to a
            // local model, so neither should be gated on this check.
            console.error("[consolidate] ANTHROPIC_API_KEY is not configured; skipping consolidation run. Set LLM_PROVIDER=bedrock to use AWS credentials, or LLM_PROVIDER=ollama for a local free model, instead.");
            return;
        }
        // "--reconcile" is also an operator subcommand, but unlike --status and
        // --rollback it does call the LLM (arbitrating each near-duplicate pair
        // it finds), so it is dispatched after the ANTHROPIC_API_KEY guard above
        // rather than alongside --status/--rollback/--doctor. The project
        // positional is required (not optional the way the default consolidation
        // path's argProject is): a sweep with no project to scope it to has
        // nothing to do.
        if (args.includes("--reconcile")) {
            const reconcileProject = parseReconcileProject(args);
            if (!reconcileProject) {
                console.error("[consolidate] --reconcile requires a project: pass it as a positional argument.");
                process.exitCode = 1;
                return;
            }
            const db = await getDb();
            const result = await runReconcileSweep(db, reconcileProject, buildReconcileDeps(config));
            console.log(formatReconcileReport(reconcileProject, result));
            return;
        }
        const dryRun = args.includes("--dry-run");
        const argProject = args.find((arg) => !arg.startsWith("--"));
        const db = await getDb();
        // Warn (never block the run on it) when the resolved extraction batch
        // budget is smaller than a single observation can be
        // (MAX_OBSERVATION_TEXT_LENGTH): every claimed batch would then risk
        // containing an observation larger than the model can extract from in
        // one call. On Anthropic/Bedrock that surfaces as the terminal
        // single-observation "failed" path once split-retry isolates it; Ollama
        // instead silently truncates its own context (num_ctx), so this is the
        // only signal an operator gets for that provider that the configured
        // model's context is undersized for the observations being captured.
        const resolvedBatchMaxChars = resolveBatchMaxChars(config);
        if (resolvedBatchMaxChars < MAX_OBSERVATION_TEXT_LENGTH) {
            console.error(`[consolidate] warning: extraction batch budget (${resolvedBatchMaxChars} chars, from ` +
                `${getContextWindowTokens(config)} configured context tokens) is smaller than a single ` +
                `observation can be (${MAX_OBSERVATION_TEXT_LENGTH} chars); large observations may fail ` +
                "extraction or be silently truncated depending on the configured provider.");
        }
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
                }
                catch (err) {
                    console.error(`[consolidate] project="${project}": dry run failed: ${err instanceof Error ? err.message : "unknown error"}`);
                    process.exitCode = 1;
                }
                continue;
            }
            const runId = randomUUID();
            try {
                const result = await runConsolidation(db, project, buildDeps(config, runId));
                if (result.skipped) {
                    console.log(`[consolidate] project="${project}": skipped (${result.reason})`);
                }
                else {
                    console.log(`[consolidate] project="${project}": processed ${result.processed} fact(s)`);
                }
            }
            catch (err) {
                console.error(`[consolidate] project="${project}": run failed: ${err instanceof Error ? err.message : "unknown error"}`);
                process.exitCode = 1;
            }
        }
    }
    catch (err) {
        console.error(`[consolidate] unexpected failure: ${err instanceof Error ? err.name : "unknown error"}`);
        process.exitCode = 1;
    }
    finally {
        try {
            await closeDb();
        }
        catch {
            // Ignore close errors; the process is exiting regardless.
        }
    }
}
// Only run main() when this file is the actual entry point (node dist/consolidation/cli.js),
// never when imported as a module.
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
    main();
}
