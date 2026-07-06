import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect the agent + runtime dirs to a temp sandbox BEFORE importing the modules,
// so durable history snapshots never touch the real ~/.pi agent dir. The modules
// compute HISTORY_DIR / TEMP_ROOT_DIR at import time, hence dynamic import below.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aipi-subagent-view-"));
process.env.AIPI_SUBAGENTS_AGENT_DIR = path.join(tempRoot, "agent");
process.env.AIPI_SUBAGENTS_RUNTIME_DIR = path.join(tempRoot, "runtime");

const bg = (file) =>
  import(new URL(`../extensions/aipi/runtime/vendor/pi-subagents/src/runs/background/${file}`, import.meta.url).href);

function writeRun(asyncRoot, runId, state) {
  const dir = path.join(asyncRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const status = {
    runId,
    sessionId: "test-session",
    state,
    mode: "single",
    startedAt: now - 5000,
    lastUpdate: now - 1000,
    ...(state === "complete" || state === "failed" ? { endedAt: now } : {}),
    steps: [{ agent: "worker", status: state === "complete" ? "complete" : state === "failed" ? "failed" : "running" }],
    outputFile: "output-0.log",
  };
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
  return dir;
}

try {
  const { listAsyncRuns, summarizeAsyncRunDir } = await bg("async-status.ts");
  const { snapshotRunToHistory, listHistoryRuns, loadSubagentRuns } = await bg("history-store.ts");
  const { inspectSubagentStatus } = await bg("run-status.ts");

  // 1. listAsyncRuns + summarizeAsyncRunDir read structured summaries, state filter works.
  {
    const asyncRoot = path.join(tempRoot, "async1");
    writeRun(asyncRoot, "run-queued", "queued");
    writeRun(asyncRoot, "run-running", "running");
    const doneDir = writeRun(asyncRoot, "run-done", "complete");

    const runs = listAsyncRuns(asyncRoot, { reconcile: false });
    assert.deepEqual(runs.map((r) => r.id).sort(), ["run-done", "run-queued", "run-running"]);
    const done = runs.find((r) => r.id === "run-done");
    assert.equal(done.state, "complete");
    assert.equal(done.mode, "single");
    assert.equal(done.steps[0].agent, "worker");

    const single = summarizeAsyncRunDir(doneDir, { reconcile: false });
    assert.equal(single.id, "run-done");
    assert.equal(single.state, "complete");

    const active = listAsyncRuns(asyncRoot, { reconcile: false, states: ["running", "queued"] });
    assert.deepEqual(active.map((r) => r.id).sort(), ["run-queued", "run-running"]);
  }

  // 2. History store snapshots terminal runs, skips live runs, captures the result payload.
  {
    const asyncRoot = path.join(tempRoot, "async2");
    const historyDir = path.join(tempRoot, "history2");
    const resultsDir = path.join(tempRoot, "results2");
    fs.mkdirSync(resultsDir, { recursive: true });

    const doneDir = writeRun(asyncRoot, "hist-done", "complete");
    fs.writeFileSync(path.join(resultsDir, "hist-done.json"), JSON.stringify({ runId: "hist-done", success: true, summary: "ok" }), "utf-8");
    const runningDir = writeRun(asyncRoot, "hist-running", "running");

    snapshotRunToHistory({ asyncDir: doneDir, runId: "hist-done", resultsDir, historyDir });
    snapshotRunToHistory({ asyncDir: runningDir, runId: "hist-running", resultsDir, historyDir });

    const history = listHistoryRuns(historyDir);
    assert.deepEqual(history.map((r) => r.id), ["hist-done"], "only terminal run snapshotted");
    assert.equal(history[0].state, "complete");

    const snap = JSON.parse(fs.readFileSync(path.join(historyDir, "hist-done.json"), "utf-8"));
    assert.equal(snap.summary.id, "hist-done");
    assert.equal(snap.result.summary, "ok");
    assert.equal(typeof snap.snapshotAt, "number");
  }

  // 3. inspectSubagentStatus format=json returns live + durable history (list / single / not-found).
  {
    const asyncRoot = path.join(tempRoot, "async3");
    const resultsDir = path.join(tempRoot, "results3");
    fs.mkdirSync(resultsDir, { recursive: true });

    writeRun(asyncRoot, "live-run", "running");
    const goneDir = writeRun(path.join(tempRoot, "gone3"), "old-run", "complete");
    snapshotRunToHistory({ asyncDir: goneDir, runId: "old-run", resultsDir });

    const listRes = inspectSubagentStatus({ format: "json" }, { asyncDirRoot: asyncRoot, resultsDir });
    assert.equal(listRes.isError, undefined);
    const ids = JSON.parse(listRes.content[0].text).runs.map((r) => r.id);
    assert.ok(ids.includes("live-run"), "live run present in json");
    assert.ok(ids.includes("old-run"), "history run merged into json");

    const oneRes = inspectSubagentStatus({ format: "json", id: "live-run" }, { asyncDirRoot: asyncRoot, resultsDir });
    assert.equal(JSON.parse(oneRes.content[0].text).run.id, "live-run");

    const missing = inspectSubagentStatus({ format: "json", id: "nope" }, { asyncDirRoot: asyncRoot, resultsDir });
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).run, null);
  }

  // 4. loadSubagentRuns merges live + durable history (the data layer behind the /subagents pane).
  {
    const asyncRoot = path.join(tempRoot, "async4");
    const resultsDir = path.join(tempRoot, "results4");
    fs.mkdirSync(resultsDir, { recursive: true });
    writeRun(asyncRoot, "live-4", "running");
    const goneDir = writeRun(path.join(tempRoot, "gone4"), "old-4", "complete");
    snapshotRunToHistory({ asyncDir: goneDir, runId: "old-4", resultsDir });

    const ids = loadSubagentRuns(asyncRoot, resultsDir).map((r) => r.id);
    assert.ok(ids.includes("live-4"), "live run present in loadSubagentRuns");
    assert.ok(ids.includes("old-4"), "history run present in loadSubagentRuns");
  }

  console.log("AIPI_SUBAGENT_VIEW_TEST_OK");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
