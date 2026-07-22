import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
function sha12(input) {
    return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
/**
 * Normalizes a git remote URL so that every common spelling of the same
 * repository produces the same string: trims whitespace, converts the scp
 * form (git@host:org/repo) to host/org/repo, strips the protocol and any
 * embedded credentials, strips a trailing slash and a trailing .git, and
 * lowercases the host (only the host: repository paths can be
 * case-sensitive on some servers).
 */
export function normalizeRemoteUrl(url) {
    let normalized = url.trim();
    const scpMatch = !normalized.includes("://")
        ? normalized.match(/^[^@/]+@([^:/]+):(.+)$/)
        : null;
    if (scpMatch) {
        normalized = `${scpMatch[1]}/${scpMatch[2]}`;
    }
    else {
        normalized = normalized.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // protocol
        normalized = normalized.replace(/^[^@/]+@/, ""); // user[:password]@ credentials
    }
    normalized = normalized.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    const slashIndex = normalized.indexOf("/");
    if (slashIndex > 0) {
        normalized = normalized.slice(0, slashIndex).toLowerCase() + normalized.slice(slashIndex);
    }
    return normalized;
}
function pathModeKey(resolvedCwd) {
    try {
        const output = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: resolvedCwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
        const absoluteGitDir = path.resolve(resolvedCwd, output);
        // absoluteGitDir is normally "<repo-root>/.git"; take its parent's
        // basename as the human-readable repo name.
        const repoRoot = path.dirname(absoluteGitDir);
        const readableName = path.basename(repoRoot) || "repo";
        return `${readableName}-${sha12(absoluteGitDir)}`;
    }
    catch {
        const readableName = path.basename(resolvedCwd) || "dir";
        return `${readableName}-${sha12(resolvedCwd)}`;
    }
}
function remoteModeKey(resolvedCwd) {
    try {
        const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: resolvedCwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
        if (!url)
            return null;
        const normalized = normalizeRemoteUrl(url);
        const basename = normalized.split("/").filter(Boolean).pop() || "repo";
        return `${basename}-${sha12(normalized)}`;
    }
    catch {
        // No origin remote, not a git repo, or git unavailable: the caller falls
        // back to path mode.
        return null;
    }
}
/**
 * Produces the same project key for every worktree of the same repository
 * (DESIGN.md: memory is "keyed per git repo, shared across worktrees").
 *
 * Two modes, selected by MEMORY_PROJECT_KEY_MODE:
 *
 * - "path" (default): hashes the resolved shared .git directory
 *   (`git rev-parse --git-common-dir`, which is worktree-independent, as
 *   opposed to `--git-dir`, which is per-worktree), falling back to hashing
 *   the resolved cwd outside a git repo. Stable on one machine, but a
 *   different clone path or a different machine produces a different key.
 * - "remote" (opt-in): hashes the normalized `remote.origin.url`, so every
 *   clone of the same repository on every machine shares one key. Falls back
 *   to the path-mode key when there is no origin remote. Switching modes
 *   re-keys project memory (existing beliefs stay under the old key).
 *
 * Never throws.
 */
export function getProjectKey(cwd) {
    const resolvedCwd = path.resolve(cwd);
    if (process.env.MEMORY_PROJECT_KEY_MODE === "remote") {
        const remoteKey = remoteModeKey(resolvedCwd);
        if (remoteKey)
            return remoteKey;
    }
    return pathModeKey(resolvedCwd);
}
