import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb, closeDb } from "../db/client.js";
import { getProjectKey } from "../project/projectKey.js";
import { runMemorySearch } from "./memorySearch.js";
import { runMemoryWrite } from "./memoryWrite.js";
import { runMemoryForget } from "./memoryForget.js";
/**
 * Phase 4 escape hatch (DESIGN.md 5.3, 8.2): a stdio MCP server exposing
 * memory_search, memory_write, memory_forget. The always-injected brief
 * (Phase 1/3) remains the primary, free recall path; these tools are for
 * on-demand long-tail recall and the two targeted mutations DESIGN.md 7.3
 * allows outside the consolidator.
 */
function jsonResult(payload) {
    return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
    };
}
function errorResult(err) {
    // err.message can embed a raw connection string (e.g. a MongoParseError);
    // only the error name ever reaches the model-visible tool result.
    const name = err instanceof Error ? err.name : "unknown error";
    return {
        content: [{ type: "text", text: `memory tool failed: ${name} (see server logs for details)` }],
        isError: true,
    };
}
export function buildServer(defaultProject) {
    const server = new McpServer({
        name: "mongo-claude-memory",
        version: "0.1.0",
    });
    server.registerTool("memory_search", {
        title: "Search memory",
        description: "Hybrid ($rankFusion) search over consolidated beliefs for the long tail memory_search escape hatch. Falls back gracefully to text-only or vector-only when Voyage or Atlas Search is unavailable. Searching a project other than the one this server resolved is rejected unless MEMORY_MCP_ALLOW_CROSS_PROJECT=1 is set.",
        inputSchema: {
            query: z.string().min(1),
            project: z.string().min(1).optional(),
            scope: z.string().optional(),
            limit: z.number().int().positive().optional(),
        },
    }, async (args) => {
        try {
            const project = args.project ?? defaultProject;
            // Mirrors memory_forget's cross-project guard: an ok-style result
            // (not a protocol error) so the model can relay the reason instead
            // of surfacing a tool failure.
            if (project !== defaultProject && process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT !== "1") {
                return jsonResult({
                    results: [],
                    degraded: "cross-project search is disabled; set MEMORY_MCP_ALLOW_CROSS_PROJECT=1 to enable",
                });
            }
            const db = await getDb();
            const result = await runMemorySearch(db, {
                query: args.query,
                project,
                scope: args.scope,
                limit: args.limit,
            });
            return jsonResult(result);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool("memory_write", {
        title: "Write memory",
        description: "Writes a high-priority observation (source: mcp_write). Never writes directly to beliefs: only the offline consolidator promotes observations to beliefs (DESIGN.md 7.1, 7.3). Writing to a project other than the one this server resolved is rejected unless MEMORY_MCP_ALLOW_CROSS_PROJECT=1 is set.",
        inputSchema: {
            text: z.string().min(1),
            project: z.string().min(1).optional(),
            session_id: z.string().optional(),
        },
    }, async (args) => {
        try {
            const project = args.project ?? defaultProject;
            // Mirrors memory_forget's cross-project guard: an ok-style result
            // (not a protocol error) so the model can relay the reason instead
            // of surfacing a tool failure.
            if (project !== defaultProject && process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT !== "1") {
                return jsonResult({
                    ok: false,
                    error: "cross-project write is disabled; set MEMORY_MCP_ALLOW_CROSS_PROJECT=1 to enable",
                });
            }
            const db = await getDb();
            const result = await runMemoryWrite(db, {
                text: args.text,
                project,
                session_id: args.session_id,
            });
            return jsonResult(result);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool("memory_forget", {
        title: "Forget a belief",
        description: "Tombstones one belief in place by _id, scoped to the resolved project so a caller cannot tombstone another project's belief by guessing an id, then immediately recompiles the affected brief(s) so the belief stops being injected at the next SessionStart (recompiled: false in the result means the recompile failed and the next consolidation run will pick it up). Forgetting a belief in a DIFFERENT project than this server's resolved one is rejected unless MEMORY_MCP_ALLOW_CROSS_PROJECT=1 is set (the same guard also applies to memory_search and memory_write). One of the two allowed direct-write exceptions in DESIGN.md 7.3.",
        inputSchema: {
            beliefId: z.string().min(1),
            project: z.string().optional(),
        },
    }, async (args) => {
        try {
            const project = args.project ?? defaultProject;
            // Cross-project forgets are a destructive write outside the project
            // this server was launched in; keep them off by default. This is an
            // ok-style result (not a protocol error) so the model can relay the
            // reason instead of surfacing a tool failure.
            if (project !== defaultProject && process.env.MEMORY_MCP_ALLOW_CROSS_PROJECT !== "1") {
                return jsonResult({
                    matched: false,
                    recompiled: false,
                    error: "cross-project forget is disabled; set MEMORY_MCP_ALLOW_CROSS_PROJECT=1 to enable",
                });
            }
            const db = await getDb();
            const result = await runMemoryForget(db, {
                beliefId: args.beliefId,
                project,
            });
            return jsonResult(result);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return server;
}
/**
 * Builds the SIGINT/SIGTERM shutdown closure with its shuttingDown double-close
 * guard, factored out of main() so it is constructible with mocked close
 * functions in tests (test/server.test.ts) without needing a live process or
 * a real McpServer/db connection.
 */
export function createShutdownHandler(server, closeDbFn) {
    let shuttingDown = false;
    return async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        try {
            await server.close();
        }
        catch {
            // Ignore transport close errors; the process is exiting regardless.
        }
        try {
            await closeDbFn();
        }
        catch {
            // Ignore db close errors; the process is exiting regardless.
        }
    };
}
async function main() {
    const defaultProject = getProjectKey(process.cwd());
    const server = buildServer(defaultProject);
    const transport = new StdioServerTransport();
    const shutdown = createShutdownHandler(server, closeDb);
    process.on("SIGINT", () => {
        shutdown().finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
        shutdown().finally(() => process.exit(0));
    });
    process.on("exit", () => {
        // Best-effort synchronous-safe cleanup marker only; the async shutdown()
        // above already handles the real close on SIGINT/SIGTERM.
    });
    await server.connect(transport);
}
// Only run main() when this file is the actual entry point (node dist/mcp/server.js),
// never when imported as a module (e.g. by tests exercising buildServer() directly).
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
    main().catch((err) => {
        console.error("[mcp] server failed to start:", err instanceof Error ? err.name : "unknown error");
        process.exitCode = 1;
    });
}
