import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SubagentCoordinator } from "../extensions/aipi/runtime/subagents.js";

// The coordinator's worktree module calls `git` from PATH. In sandboxes where git
// isn't on PATH, prepend the known Windows install so the real coordinator path runs.
function ensureGitOnPath() {
  if (spawnSync("git", ["--version"], { encoding: "utf-8" }).status === 0) return;
  for (const dir of ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\bin"]) {
    if (fs.existsSync(path.join(dir, "git.exe"))) {
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
      return;
    }
  }
}
ensureGitOnPath();

function git(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout ?? "";
}

async function waitFor(pred, timeoutMs = 15000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function setupRepo(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aipi-wt-coord-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@aipi.dev"]);
  git(root, ["config", "user.name", "aipi-test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".aipi/runtime/\nnode_modules/\n", "utf-8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "review.js"), "export const value = 1;\n", "utf-8");
  if (opts.workerIsolation) {
    fs.mkdirSync(path.join(root, ".aipi"), { recursive: true });
    fs.writeFileSync(path.join(root, ".aipi", "runtime-contract.json"), JSON.stringify({ isolationModel: { workerIsolation: opts.workerIsolation } }), "utf-8");
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

// Runs one coordinator job whose fake worker edits src/review.js in whatever project_root it is
// handed (the worktree, for worktree jobs) and returns PASS. Returns the observed project_root +
// collected result.
async function runWorktreeJob({ root, env = {}, descriptor, workerContent }) {
  const captured = {};
  const coordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root,
      maxConcurrent: 1,
      env,
      piSubagentsRunner: {
        async spawn(params, options = {}) {
          const projectRoot = options.ctx?.project_root ?? root;
          captured.projectRoot = projectRoot;
          fs.writeFileSync(path.join(projectRoot, "src", "review.js"), workerContent, "utf-8");
          const stepResult = {
            schema: "aipi.step-result.v1",
            step_id: descriptor.step_id ?? "fix",
            agent_ids: [params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "worker"],
            verdict: "PASS",
            evidence: [{ rung: "ran", source: "fake-worker", ref: "src/review.js", result: "edited in worktree" }],
            artifacts: ["src/review.js"],
          };
          return {
            content: [{ type: "text", text: JSON.stringify(stepResult) }],
            artifacts: ["src/review.js"],
            tool_call_count: 1,
            exit_code: 0,
            run_id: "fake-worktree-run",
          };
        },
      },
    },
  );
  const { agent_id } = coordinator.spawn({
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    owned_files: ["src/review.js"],
    context_packet: "BDD: keep the value in sync.",
    ...descriptor,
  });
  await waitFor(() => ["done", "failed"].includes(coordinator.status(agent_id).state));
  return {
    seenProjectRoot: captured.projectRoot,
    status: coordinator.status(agent_id),
    collect: coordinator.collect(agent_id),
  };
}

function cleanup(root) {
  try { spawnSync("git", ["-C", root, "worktree", "prune"], { encoding: "utf-8" }); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

// Case 1: explicit descriptor isolation + write_scope project -> worktree + merge-back.
{
  const root = setupRepo();
  try {
    const content = "export const value = 2; // edited by worker in its worktree\n";
    const r = await runWorktreeJob({
      root,
      descriptor: { agent_id: "fixer", step_id: "fix", isolation: "per_worker_worktree", write_scope: "project" },
      workerContent: content,
    });
    assert.equal(r.status.state, "done", `job failed: ${r.status.error ?? ""}`);
    assert.ok(r.seenProjectRoot && r.seenProjectRoot !== root, "worker got a distinct project_root");
    assert.match(r.seenProjectRoot.replaceAll("\\", "/"), /aipi-worktree-/, "explicit isolation -> worktree");
    assert.equal(r.collect.step_result.verdict, "PASS");
    assert.ok(r.collect.step_result.aipi_worktree_merged, "merge-back recorded on the step result");
    assert.deepEqual(r.collect.step_result.aipi_worktree_merged.files, ["src/review.js"]);
    assert.equal(fs.readFileSync(path.join(root, "src", "review.js"), "utf-8"), content, "root source updated via merge-back");
    assert.equal(fs.existsSync(r.seenProjectRoot), false, "worktree removed after the job");
  } finally {
    cleanup(root);
  }
}

// Case 2: DEFAULT ON. No descriptor isolation, no contract, clean git repo -> the worker runs in a
// worktree and (write_scope: project) merges back. Worktree isolation is the built-in default.
{
  const root = setupRepo();
  try {
    const content = "export const value = 2; // default-on worktree\n";
    const r = await runWorktreeJob({
      root,
      descriptor: { agent_id: "plain", step_id: "fix", write_scope: "project" },
      workerContent: content,
    });
    assert.equal(r.status.state, "done", `default-on job failed: ${r.status.error ?? ""}`);
    assert.ok(r.seenProjectRoot && r.seenProjectRoot !== root, "default routed to a worktree with no config");
    assert.match(r.seenProjectRoot.replaceAll("\\", "/"), /aipi-worktree-/, "default -> worktree");
    assert.ok(r.collect.step_result.aipi_worktree_merged, "default write worker merged back");
    assert.equal(fs.readFileSync(path.join(root, "src", "review.js"), "utf-8"), content, "root updated via merge-back");
  } finally {
    cleanup(root);
  }
}

// Case 3: config OFF. The project's .aipi/runtime-contract.json sets
// isolationModel.workerIsolation = pi_subagents, so a default spawn runs at the project root (no
// worktree) even in a clean git repo. Proves the default can be turned off via config.
{
  const root = setupRepo({ workerIsolation: "pi_subagents" });
  try {
    const r = await runWorktreeJob({
      root,
      descriptor: { agent_id: "off", step_id: "review" },
      workerContent: "export const value = 5;\n",
    });
    assert.equal(r.status.state, "done", `config-off job failed: ${r.status.error ?? ""}`);
    assert.equal(r.seenProjectRoot, root, "contract pi_subagents -> runs at the project root, no worktree");
    assert.equal(r.collect.step_result.aipi_worktree_merged, undefined, "no merge when isolation is configured off");
  } finally {
    cleanup(root);
  }
}

// Case 4: graceful fallback. Default worktree, but the tree is dirty -> provisioning refuses, so the
// worker falls back to the shared project root instead of failing. This is what makes worktree safe
// as a blanket default.
{
  const root = setupRepo();
  try {
    fs.writeFileSync(path.join(root, "src", "review.js"), "export const value = 999; // uncommitted\n", "utf-8");
    const r = await runWorktreeJob({
      root,
      descriptor: { agent_id: "dirty", step_id: "review" },
      workerContent: "export const value = 8;\n",
    });
    assert.equal(r.status.state, "done", `fallback job should still finish: ${r.status.error ?? ""}`);
    assert.equal(r.seenProjectRoot, root, "dirty tree -> default worktree falls back to the project root");
    assert.equal(r.collect.step_result.aipi_worktree_merged, undefined, "no merge on the fallback path");
  } finally {
    cleanup(root);
  }
}

console.log("AIPI_WORKTREE_COORDINATOR_TEST_OK");
