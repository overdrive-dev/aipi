// Verifies orphan-run reaping: pid-less zombie runs (running/queued with no owning pid) are flipped to
// `abandoned` at session_start, pid'd runs are left to the vendored reconciler, and the pid stamp is written.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reapPidlessOrphanRuns } from "../extensions/aipi/runtime/aipi-orphan-run-reaper.js";
import { writeSubagentRunStatus, projectSubagentsRuntimePaths } from "../extensions/aipi/runtime/pi-subagents.js";

async function writeStatus(asyncDir, dirName, status) {
  const dir = path.join(asyncDir, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(status), "utf8");
  return path.join(dir, "status.json");
}
const readStatus = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

// --- reapPidlessOrphanRuns: only pid-less active runs become abandoned ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-reaper-"));
  const asyncDir = projectSubagentsRuntimePaths(root).asyncDir;
  await fs.mkdir(asyncDir, { recursive: true });

  const a = await writeStatus(asyncDir, "run-a", { runId: "contrarian:aa", state: "running", steps: [{ agent: "contrarian" }] });
  const b = await writeStatus(asyncDir, "run-b", { runId: "worker:bb", state: "running", pid: 2147480000 });
  const c = await writeStatus(asyncDir, "run-c", { runId: "done:cc", state: "complete" });
  const d = await writeStatus(asyncDir, "run-d", { runId: "curator:dd", state: "queued" });

  const result = await reapPidlessOrphanRuns(asyncDir);
  assert.equal(result.reaped, 2, "two pid-less active runs reaped");
  assert.deepEqual(result.ids.sort(), ["contrarian:aa", "curator:dd"], "reaps the pid-less running + queued runs");

  assert.equal((await readStatus(a)).state, "abandoned", "pid-less running → abandoned");
  assert.match((await readStatus(a)).abandoned_reason, /did not survive/, "records why it was abandoned");
  assert.deepEqual((await readStatus(a)).steps, [{ agent: "contrarian" }], "preserves the run's other fields");
  assert.equal((await readStatus(d)).state, "abandoned", "pid-less queued → abandoned");
  assert.equal((await readStatus(b)).state, "running", "a pid'd run is left to the vendored reconciler");
  assert.equal((await readStatus(c)).state, "complete", "a terminal run is untouched");

  // Idempotent: a second pass reaps nothing new.
  assert.equal((await reapPidlessOrphanRuns(asyncDir)).reaped, 0, "already-reaped runs are not re-touched");
  // Missing dir → no throw.
  assert.equal((await reapPidlessOrphanRuns(path.join(root, "nope"))).reaped, 0, "missing asyncDir → 0");

  await fs.rm(root, { recursive: true, force: true });
}

// --- writeSubagentRunStatus stamps the owning pid so the reconciler can reap orphans after a restart ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-pidstamp-"));
  const paths = projectSubagentsRuntimePaths(root, "contrarian:aa");
  await writeSubagentRunStatus(paths, "contrarian:aa", { state: "running", steps: [{ agent: "contrarian", status: "running" }] });
  const written = await readStatus(path.join(paths.asyncDir, "contrarian-aa", "status.json"));
  assert.equal(written.pid, process.pid, "running status carries the owning process pid");
  assert.equal(written.state, "running");
  await fs.rm(root, { recursive: true, force: true });
}

console.log("orphan-run-reaper: ok");
