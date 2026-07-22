import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Local failure telemetry for the fail-open paths. The hooks are required to
 * swallow every error silently (a memory failure must never surface in a
 * coding session), which historically meant zero evidence when something was
 * broken. appendFailure gives each swallowed failure one line in a local log
 * file so an operator can diagnose silent failures after the fact.
 *
 * Log line format: <ISO timestamp> <component> <error NAME only>. Only the
 * error's name is ever written, never its message, because driver error
 * messages can embed connection details.
 *
 * The destination is $MEMORY_FAILURE_LOG, defaulting to
 * ~/.mongo-claude-memory/failures.log. All of this function's own errors are
 * swallowed: telemetry must never become a new failure mode.
 */
export function failureLogPath() {
    return (process.env.MEMORY_FAILURE_LOG ||
        path.join(os.homedir(), ".mongo-claude-memory", "failures.log"));
}
// Caps the log file so an extended outage (bad credentials, network issue)
// spamming appendFailure on every hook's fail-open path cannot grow it
// unbounded; past this size the file is rotated to one ".1" backup instead.
const MAX_LOG_BYTES = 5 * 1024 * 1024;
export function appendFailure(component, err) {
    try {
        const target = failureLogPath();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const name = err instanceof Error ? err.name : typeof err === "string" ? err : "UnknownError";
        try {
            const stats = fs.statSync(target);
            if (stats.size > MAX_LOG_BYTES) {
                fs.renameSync(target, `${target}.1`);
            }
        }
        catch {
            // fs.statSync throws when the target does not exist yet (expected on
            // first run): nothing to rotate, fall through to append below.
        }
        fs.appendFileSync(target, `${new Date().toISOString()} ${component} ${name}\n`, "utf8");
    }
    catch {
        // Telemetry must never throw or add a failure mode of its own.
    }
}
