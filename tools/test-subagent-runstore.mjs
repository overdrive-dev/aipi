import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSubagentView, projectSubagentsRuntimePaths, writeSubagentRunStatus } from "../extensions/aipi/runtime/pi-subagents.js";

// The bridge writes a per-run status.json in the NATIVE run-store shape so the vendored reader
// (summarizeAsyncRunDir / listAsyncRuns) — the data layer behind /aipi-subagents — sees our foreground fork.
const bg = (file) =>
  import(new URL(`../extensions/aipi/runtime/vendor/pi-subagents/src/runs/background/${file}`, import.meta.url).href);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-runstore-"));
try {
  const { summarizeAsyncRunDir, listAsyncRuns } = await bg("async-status.ts");

  const paths = projectSubagentsRuntimePaths(tempRoot, "run-alpha");
  await fs.mkdir(paths.asyncDir, { recursive: true });

  // 1. running status is written and parses back as a native AsyncRunSummary.
  await writeSubagentRunStatus(paths, "run-alpha", {
    state: "running",
    cwd: tempRoot,
    startedAt: 1000,
    lastUpdate: 1000,
    steps: [{ agent: "aipi-worker", status: "running", model: "anthropic/claude-opus-4-8" }],
  });
  const running = summarizeAsyncRunDir(path.join(paths.asyncDir, "run-alpha"), { reconcile: false });
  assert.equal(running.id, "run-alpha", "id comes from status.runId");
  assert.equal(running.state, "running");
  assert.equal(running.mode, "single");
  assert.equal(running.steps[0].agent, "aipi-worker");
  assert.equal(running.steps[0].model, "anthropic/claude-opus-4-8");

  // 2. completing the run flips state and records endedAt (the same run dir, overwritten).
  await writeSubagentRunStatus(paths, "run-alpha", {
    state: "complete",
    cwd: tempRoot,
    startedAt: 1000,
    lastUpdate: 2000,
    endedAt: 2000,
    steps: [{ agent: "aipi-worker", status: "complete", model: "anthropic/claude-opus-4-8", toolCount: 3 }],
  });
  const complete = summarizeAsyncRunDir(path.join(paths.asyncDir, "run-alpha"), { reconcile: false });
  assert.equal(complete.state, "complete");
  assert.equal(complete.endedAt, 2000);
  assert.equal(complete.steps[0].status, "complete");

  // 3. a second, failed run — listAsyncRuns surfaces BOTH (the list the view renders).
  const paths2 = projectSubagentsRuntimePaths(tempRoot, "run-beta");
  await writeSubagentRunStatus(paths2, "run-beta", {
    state: "failed",
    cwd: tempRoot,
    startedAt: 1500,
    lastUpdate: 1800,
    endedAt: 1800,
    steps: [{ agent: "aipi-worker", status: "failed", error: "boom" }],
  });
  const ids = listAsyncRuns(paths.asyncDir, { reconcile: false }).map((run) => run.id).sort();
  assert.deepEqual(ids, ["run-alpha", "run-beta"]);

  // 4. best-effort: a status write never throws even on a bogus path.
  await writeSubagentRunStatus({ asyncDir: "\0/invalid" }, "x", { state: "running" });

  // 5. loadSubagentView jiti-loads the vendored TS component + its data layer (resolves pi-tui deps). This is
  //    the risky wiring behind /aipi-subagents; the component is not instantiated (no TTY in tests).
  const view = loadSubagentView();
  assert.equal(typeof view.SubagentViewComponent, "function", "SubagentViewComponent class loads");
  assert.equal(typeof view.loadSubagentRuns, "function", "loadSubagentRuns loads");
  assert.ok(Array.isArray(view.loadSubagentRuns(paths.asyncDir, paths.resultsDir)), "loadSubagentRuns returns a list");

  console.log("AIPI_SUBAGENT_RUNSTORE_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
