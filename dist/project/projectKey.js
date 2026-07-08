import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
/**
 * Produces the same project key for every worktree of the same repository
 * (DESIGN.md: memory is "keyed per git repo, shared across worktrees").
 *
 * `git rev-parse --git-common-dir` returns the shared .git directory across
 * all worktrees of a repo (as opposed to `--git-dir`, which returns a
 * per-worktree path under .git/worktrees/<name>), so hashing its resolved
 * absolute path gives a stable, worktree-independent key.
 *
 * Falls back to hashing the resolved cwd itself if not inside a git repo, so
 * this function never throws.
 */
export function getProjectKey(cwd) {
    const resolvedCwd = path.resolve(cwd);
    try {
        const output = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: resolvedCwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const absoluteGitDir = path.resolve(resolvedCwd, output);
        const hash = createHash("sha256").update(absoluteGitDir).digest("hex").slice(0, 12);
        // absoluteGitDir is normally "<repo-root>/.git"; take its parent's
        // basename as the human-readable repo name.
        const repoRoot = path.dirname(absoluteGitDir);
        const readableName = path.basename(repoRoot) || "repo";
        return `${readableName}-${hash}`;
    }
    catch {
        const hash = createHash("sha256").update(resolvedCwd).digest("hex").slice(0, 12);
        const readableName = path.basename(resolvedCwd) || "dir";
        return `${readableName}-${hash}`;
    }
}
