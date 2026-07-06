import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyWorktreeDiffToRoot,
  captureWorktreeDiff,
  isTrackedTreeClean,
  provisionWorkerWorktree,
  removeWorkerWorktree,
} from "../extensions/aipi/runtime/worktree-isolation.js";

// The module defaults to `git` (correct in the real harness/CI). This test resolves
// the binary (PATH first, then a known Windows install) so it also runs in sandboxes
// where git isn't on PATH, and injects that runner into the module's `git` param.
function resolveGit() {
  if (spawnSync("git", ["--version"], { encoding: "utf-8" }).status === 0) return "git";
  for (const candidate of ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "git";
}
const GIT = resolveGit();
const runner = (cwd, args) => {
  const res = spawnSync(GIT, ["-C", cwd, ...args], { encoding: "utf-8" });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
};
function git(cwd, args) {
  const res = runner(cwd, args);
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout || res.status}`);
  return res.stdout;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aipi-wt-iso-"));

try {
  // A real git repo with a committed source file and a gitignore for runtime artifacts.
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@aipi.dev"]);
  git(root, ["config", "user.name", "aipi-test"]);
  git(root, ["config", "core.autocrlf", "false"]); // keep LF so fixture comparisons are stable on Windows
  fs.writeFileSync(path.join(root, ".gitignore"), ".aipi/runtime/\nnode_modules/\n", "utf-8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.txt"), "v1\n", "utf-8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);

  assert.equal(isTrackedTreeClean(root, runner), true, "fresh commit is clean");

  // 1. Provision an isolated worktree branched from HEAD.
  const worktree = provisionWorkerWorktree({ root, runId: "job1", git: runner });
  assert.equal(fs.existsSync(worktree.path), true, "worktree dir exists");
  assert.equal(worktree.branch, "aipi-worker-job1");
  assert.ok(worktree.baseCommit && worktree.baseCommit.length >= 7, "base commit captured");
  assert.equal(fs.readFileSync(path.join(worktree.path, "src", "a.txt"), "utf-8"), "v1\n", "worktree checked out HEAD");

  // 2. Simulate a worker: change a tracked file, add a new one, and write a gitignored artifact.
  fs.writeFileSync(path.join(worktree.path, "src", "a.txt"), "v2\n", "utf-8");
  fs.writeFileSync(path.join(worktree.path, "src", "b.txt"), "new\n", "utf-8");
  fs.mkdirSync(path.join(worktree.path, ".aipi", "runtime"), { recursive: true });
  fs.writeFileSync(path.join(worktree.path, ".aipi", "runtime", "junk.txt"), "runtime\n", "utf-8");

  // 3. Capture the diff — gitignored runtime artifact must be excluded.
  const diff = captureWorktreeDiff({ worktree, git: runner });
  assert.equal(diff.hasChanges, true);
  assert.deepEqual([...diff.changedFiles].sort(), ["src/a.txt", "src/b.txt"], "only tracked source changes; .aipi/runtime excluded");
  assert.match(diff.patch, /v2/);
  assert.match(diff.patch, /new/);
  assert.doesNotMatch(diff.patch, /junk/, "gitignored runtime file not in patch");

  // 4. Root is untouched (real isolation).
  assert.equal(fs.readFileSync(path.join(root, "src", "a.txt"), "utf-8"), "v1\n", "root unchanged during isolated run");
  assert.equal(fs.existsSync(path.join(root, "src", "b.txt")), false, "new file stayed in the worktree");

  // 5. Merge-back applies the worktree's changes into the real project.
  const applied = applyWorktreeDiffToRoot({ root, patch: diff.patch, git: runner });
  assert.equal(applied.applied, true, "patch applied cleanly");
  assert.equal(fs.readFileSync(path.join(root, "src", "a.txt"), "utf-8"), "v2\n", "root file updated");
  assert.equal(fs.readFileSync(path.join(root, "src", "b.txt"), "utf-8"), "new\n", "root gained the new file");

  // 6. Cleanup removes the worktree and its branch.
  removeWorkerWorktree({ worktree, git: runner });
  assert.equal(fs.existsSync(worktree.path), false, "worktree dir removed");
  assert.equal(git(root, ["branch", "--list", "aipi-worker-job1"]).trim(), "", "worktree branch deleted");

  // 7. Require-clean: root now has the applied (uncommitted) changes → provisioning refuses.
  assert.equal(isTrackedTreeClean(root, runner), false, "root is dirty after merge-back");
  assert.throws(() => provisionWorkerWorktree({ root, runId: "job2", git: runner }), /clean git working tree/, "dirty tree rejected");

  // 8. Empty patch is a no-op, not an error.
  const empty = applyWorktreeDiffToRoot({ root, patch: "", git: runner });
  assert.equal(empty.applied, false);
  assert.equal(empty.empty, true);

  console.log("AIPI_WORKTREE_ISOLATION_TEST_OK");
} finally {
  try { runner(root, ["worktree", "prune"]); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
