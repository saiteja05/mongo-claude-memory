import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
// WHY this file exists: in real ESM, all of a module's static imports are
// resolved and executed before that module's own code runs. sessionStart.ts,
// userPromptSubmit.ts, and sessionEnd.ts transitively import "mongodb"; on a
// freshly git-installed plugin (before `npm install` has ever run),
// node_modules/mongodb does not exist yet, so that import throws
// ERR_MODULE_NOT_FOUND as an uncaught exception, before those files' own
// fail-open try/catch is ever reached. This guard has zero non-builtin
// imports, so it can always run and intercept that case first.
const MODES = ["sessionStart", "userPromptSubmit", "sessionEnd"];
function isMode(value) {
    return value !== undefined && MODES.includes(value);
}
export function missingDepsMessage(pluginRoot) {
    return (`[Recall memory plugin: dependencies not installed yet. Run \`cd "${pluginRoot}" && ` +
        "npm install` once, then restart the session, to enable persistent memory. Until then " +
        "this is a normal, harmless no-op.]");
}
/**
 * Core logic: validates argv, checks the mongodb canary, and either prints
 * the SessionStart fallback context or spawns the real hook with the same
 * stdio, forwarding its exit code. Never throws; every branch resolves a
 * number, so the caller can always exit with it.
 */
export async function run(argv) {
    const pluginRoot = argv[2];
    const mode = argv[3];
    if (!pluginRoot || !isMode(mode)) {
        return 0;
    }
    const canary = path.join(pluginRoot, "node_modules", "mongodb", "package.json");
    if (!existsSync(canary)) {
        if (mode === "sessionStart") {
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "SessionStart",
                    additionalContext: missingDepsMessage(pluginRoot),
                },
            }));
        }
        // userPromptSubmit/sessionEnd have no stdout contract today; stay silent.
        return 0;
    }
    const realFile = path.join(pluginRoot, "dist", "hooks", `${mode}.js`);
    return new Promise((resolve) => {
        try {
            // stdio: "inherit" so the real hook receives the same stdin Claude
            // Code piped to this guard (the hook payload JSON), not a closed pipe.
            const child = spawn(process.execPath, [realFile], { stdio: "inherit" });
            child.on("exit", (code) => resolve(code ?? 0));
            child.on("error", () => resolve(0));
        }
        catch {
            resolve(0);
        }
    });
}
async function main() {
    const code = await run(process.argv);
    process.exit(code);
}
// Only run main() when this file is the actual entry point (node
// dist/hooks/pluginGuard.js ...), never when imported as a module (e.g. by
// tests exercising run() directly). Uses the global URL constructor instead
// of node:url's fileURLToPath, so this file's imports stay limited to
// node:fs, node:path, and node:child_process. Node's ESM loader resolves
// symlinks when it builds import.meta.url, but path.resolve(process.argv[1])
// only normalizes the literal argv string and never touches symlinks, so if
// the invocation path crosses a symlink (e.g. macOS /tmp -> /private/tmp)
// the two strings never match. realpathSync on both sides removes that
// asymmetry; the try/catch keeps this defensive (never throw here) so a
// deleted file or an unusual argv[1] just falls back to isEntryPoint=false.
const currentFile = decodeURIComponent(new URL(import.meta.url).pathname);
let isEntryPoint = false;
if (process.argv[1] !== undefined) {
    try {
        isEntryPoint = realpathSync(currentFile) === realpathSync(process.argv[1]);
    }
    catch {
        isEntryPoint = false;
    }
}
if (isEntryPoint) {
    main();
}
