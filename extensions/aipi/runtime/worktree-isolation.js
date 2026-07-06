// Per-worker git worktree isolation for the AIPI subagent coordinator.
//
// A worktree job runs its forked worker in an isolated git worktree branched from
// HEAD, so parallel workers get real filesystem isolation (not just the logical
// owned-file fence) and each produces its own branch + diff. The captured diff is
// both the per-candidate review surface and the evidence source; for write-scope
// workers it is merged back into the real project on a passing verdict.
//
// Contract: base = HEAD, require a clean (tracked) working tree. Runtime artifacts
// under .aipi/runtime are gitignored, so they never enter the captured diff.
//
// The git runner is injectable so the mechanics are unit-testable against a real
// temp repo without the coordinator or the Pi runtime.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultGit(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

function gitChecked(git, cwd, args) {
  const res = git(cwd, args);
  if (res.status !== 0) {
    const command = `git -C ${cwd} ${args.join(" ")}`;
    throw new Error(res.stderr?.trim() || res.stdout?.trim() || `${command} failed`);
  }
  return res.stdout ?? "";
}

/**
 * True when the tree has no *tracked* modifications. Untracked artifacts (build
 * output, logs) do not block — matching the require-clean (manual) decision.
 */
export function isTrackedTreeClean(root, git = defaultGit) {
  const res = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  return res.status === 0 && (res.stdout ?? "").trim().length === 0;
}

/**
 * Create an isolated worktree branched from HEAD. Throws if `root` is not a git
 * repo or has tracked modifications.
 */
export function provisionWorkerWorktree({ root, runId, git = defaultGit, linkNodeModules = true }) {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || (inside.stdout ?? "").trim() !== "true") {
    throw new Error("worktree isolation requires a git repository");
  }
  if (!isTrackedTreeClean(root, git)) {
    throw new Error("worktree isolation requires a clean git working tree (tracked changes); commit or stash first");
  }
  const toplevel = gitChecked(git, root, ["rev-parse", "--show-toplevel"]).trim();
  const baseCommit = gitChecked(git, root, ["rev-parse", "HEAD"]).trim();
  const safe = String(runId).replace(/[^\w.-]/g, "_");
  const branch = `aipi-worker-${safe}`;
  const worktreePath = path.join(os.tmpdir(), `aipi-worktree-${safe}-${randomUUID().slice(0, 8)}`);

  const add = git(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
  if (add.status !== 0) {
    throw new Error(add.stderr?.trim() || add.stdout?.trim() || `failed to create worktree ${worktreePath}`);
  }

  let nodeModulesLinked = false;
  if (linkNodeModules) {
    try {
      const source = path.join(toplevel, "node_modules");
      const link = path.join(worktreePath, "node_modules");
      if (fs.existsSync(source) && !fs.existsSync(link)) {
        fs.symlinkSync(source, link);
        nodeModulesLinked = true;
      }
    } catch {
      // node_modules linking is best-effort (unsupported filesystems / permissions).
    }
  }

  return { path: worktreePath, agentCwd: worktreePath, branch, baseCommit, toplevel, nodeModulesLinked };
}

/**
 * Capture the worktree's changes vs its base commit. `git add -A` respects
 * .gitignore, so gitignored runtime artifacts (.aipi/runtime, node_modules) are
 * excluded. Returns the changed tracked-file list, the patch text, and whether
 * anything changed.
 */
export function captureWorktreeDiff({ worktree, git = defaultGit }) {
  gitChecked(git, worktree.path, ["add", "-A"]);
  const nameOnly = gitChecked(git, worktree.path, ["diff", "--cached", "--name-only", worktree.baseCommit]).trim();
  const changedFiles = nameOnly ? nameOnly.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  const patch = gitChecked(git, worktree.path, ["diff", "--cached", worktree.baseCommit]);
  return { changedFiles, patch, hasChanges: patch.trim().length > 0 };
}

/**
 * Merge a captured worktree patch into the real project working tree. Safe because
 * root is clean at HEAD and the patch is relative to that same HEAD. Never throws
 * on a non-applying patch — returns a structured result so the caller can decide.
 */
export function applyWorktreeDiffToRoot({ root, patch, git = defaultGit }) {
  if (!patch || !patch.trim()) return { applied: false, empty: true };
  const patchPath = path.join(os.tmpdir(), `aipi-worktree-patch-${process.pid}-${randomUUID().slice(0, 8)}.patch`);
  fs.writeFileSync(patchPath, patch, "utf-8");
  try {
    const check = git(root, ["apply", "--check", patchPath]);
    if (check.status !== 0) {
      return { applied: false, conflict: true, reason: (check.stderr ?? "").trim() || "patch does not apply cleanly" };
    }
    gitChecked(git, root, ["apply", patchPath]);
    return { applied: true };
  } finally {
    try { fs.rmSync(patchPath, { force: true }); } catch { /* best-effort */ }
  }
}

/** Remove the worktree and its branch. Best-effort; never throws. */
export function removeWorkerWorktree({ worktree, git = defaultGit }) {
  if (!worktree?.toplevel || !worktree?.path) return;
  try { gitChecked(git, worktree.toplevel, ["worktree", "remove", "--force", worktree.path]); } catch { /* best-effort */ }
  try { gitChecked(git, worktree.toplevel, ["branch", "-D", worktree.branch]); } catch { /* best-effort */ }
  try { git(worktree.toplevel, ["worktree", "prune"]); } catch { /* best-effort */ }
}
