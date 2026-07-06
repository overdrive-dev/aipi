import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport,
  makeGitRunner,
  resolveGit,
  runGitAudit,
  scanWorktreeEvents,
  summarizeEvents,
} from "./aipi-worktree-audit.mjs";

const runner = makeGitRunner(resolveGit());
function git(root, args) {
  const r = runner(root, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.err || r.out}`);
  return r.out;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aipi-wt-audit-"));
const leakedWorktreePath = path.join(os.tmpdir(), `aipi-worktree-audit-leak-${Date.now()}`);

try {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@a.dev"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(root, "a.txt"), "1\n", "utf-8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);

  // Clean repo, no leaks, no events -> OK.
  const clean = buildReport({ root, git: (r) => runGitAudit(r, runner), events: [], tmpLeftovers: [] });
  assert.equal(clean.git.isRepo, true);
  assert.equal(clean.git.cleanTracked, true);
  assert.deepEqual(clean.git.leakedWorktrees, []);
  assert.deepEqual(clean.git.leakedBranches, []);
  assert.equal(clean.ok, true);

  // Leaked worktree + branch (never cleaned up) -> detected.
  git(root, ["worktree", "add", leakedWorktreePath, "-b", "aipi-worker-testleak", "HEAD"]);
  const audit = runGitAudit(root, runner);
  assert.equal(audit.leakedWorktrees.length, 1, "leaked worktree detected");
  assert.match(audit.leakedWorktrees[0], /aipi-worktree-/);
  assert.ok(audit.leakedBranches.includes("aipi-worker-testleak"), "leaked branch detected");

  // Session-style JSONL with worktree_* entries including a merge conflict.
  const eventsFile = path.join(root, "session.jsonl");
  fs.writeFileSync(eventsFile, `${[
    JSON.stringify({ name: "aipi.subagents.event", value: { schema: "aipi.subagent-event.v1", event: "worktree_provisioned", agent_id: "fixer:1", branch: "aipi-worker-fixer" } }),
    JSON.stringify({ name: "aipi.subagents.event", value: { schema: "aipi.subagent-event.v1", event: "worktree_merged", agent_id: "fixer:1" } }),
    JSON.stringify({ name: "aipi.subagents.event", value: { schema: "aipi.subagent-event.v1", event: "worktree_merge_conflict", agent_id: "fixer:2", reason: "patch does not apply" } }),
    JSON.stringify({ name: "unrelated", value: { schema: "something.else" } }),
  ].join("\n")}\n`, "utf-8");
  const events = scanWorktreeEvents([eventsFile]);
  assert.equal(events.length, 3, "3 worktree_* events parsed (unrelated line ignored)");
  const summary = summarizeEvents(events);
  assert.equal(summary.counts.worktree_provisioned, 1);
  assert.equal(summary.counts.worktree_merged, 1);
  assert.equal(summary.issues.length, 1, "conflict flagged as an issue");

  // Full report: leaks + conflict + a temp leftover -> ISSUES with all three problems.
  const report = buildReport({ root, git: (r) => runGitAudit(r, runner), events, tmpLeftovers: [leakedWorktreePath] });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => /leaked worktree/.test(p)), "reports leaked worktree");
  assert.ok(report.problems.some((p) => /leaked aipi-worker-\* branch/.test(p)), "reports leaked branch");
  assert.ok(report.problems.some((p) => /merge-conflict/.test(p)), "reports conflict trace");
  assert.ok(report.problems.some((p) => /leftover worktree dir/.test(p)), "reports temp leftover");

  console.log("AIPI_WORKTREE_AUDIT_TEST_OK");
} finally {
  try { runner(root, ["worktree", "remove", "--force", leakedWorktreePath]); } catch {}
  try { runner(root, ["worktree", "prune"]); } catch {}
  fs.rmSync(leakedWorktreePath, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
