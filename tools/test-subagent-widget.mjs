import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSubagentsRuntimePaths, writeSubagentRunStatus } from "../extensions/aipi/runtime/pi-subagents.js";
import { refreshSubagentWidget, renderSubagentWidgetLines } from "../extensions/aipi/runtime/subagent-widget.js";

// --- pure render: nothing active -> [] (clears the widget) ---
assert.deepEqual(renderSubagentWidgetLines(null), []);
assert.deepEqual(renderSubagentWidgetLines([]), []);
assert.deepEqual(renderSubagentWidgetLines([{ id: "r", state: "complete" }]), []);

// --- pure render: only ACTIVE runs are listed, with the model suffix ---
const lines = renderSubagentWidgetLines([
  { id: "research-explore-auth-1", state: "running", steps: [{ agent: "aipi-worker", status: "running", model: "anthropic/claude-opus-4-8", thinking: "high" }] },
  { id: "research-find-callers-2", state: "queued", steps: [{ agent: "aipi-worker", status: "queued" }] },
  { id: "research-done-3", state: "complete", steps: [{ agent: "aipi-worker", status: "complete" }] },
]);
assert.ok(lines[0].includes("2 running"), lines[0]);
assert.ok(
  lines.some((l) => l.includes("research-explore-auth-1") && l.includes("claude-opus-4-8") && l.includes("high")),
  "running run shows model + set intelligence (thinking level)",
);
assert.ok(lines.some((l) => l.includes("research-find-callers-2")), "queued run shown");
assert.ok(!lines.some((l) => l.includes("research-done-3")), "completed run is NOT shown");

// --- pure render: overflow past the row cap is summarized ---
const many = Array.from({ length: 11 }, (_, i) => ({ id: `r-${i}`, state: "running", steps: [] }));
const manyLines = renderSubagentWidgetLines(many);
assert.ok(manyLines[0].includes("11 running"));
assert.ok(manyLines.some((l) => l.includes("+3 more")), "rows past the cap summarized");

// --- refreshSubagentWidget: PULLS the run-store and pushes; mode guard blocks non-TUI ---
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagent-widget-"));
try {
  const paths = projectSubagentsRuntimePaths(tempRoot, "research-explore-auth-1");
  await fs.mkdir(paths.asyncDir, { recursive: true });
  // writeSubagentRunStatus stamps pid: process.pid — this test process is alive, so the vendored reconciler
  // keeps the run as long as its lastUpdate is recent (a real run updates within the 10-min timeout, far under
  // the 24h stale-alive-pid window). Use a current timestamp so the live run is not stale-reaped.
  const nowMs = Date.now();
  await writeSubagentRunStatus(paths, "research-explore-auth-1", {
    state: "running",
    cwd: tempRoot,
    startedAt: nowMs,
    lastUpdate: nowMs,
    steps: [{ agent: "aipi-worker", status: "running", model: "anthropic/claude-opus-4-8" }],
  });

  const calls = [];
  await refreshSubagentWidget({ mode: "tui", ui: { setWidget: (key, content) => calls.push({ key, content }) } }, tempRoot);
  assert.equal(calls.length, 1, "TUI mode pushes the widget");
  assert.equal(calls[0].key, "aipi-subagents");
  assert.ok(Array.isArray(calls[0].content) && calls[0].content[0].includes("1 running"));
  assert.ok(calls[0].content.some((l) => l.includes("research-explore-auth-1")), "a live (fresh-pid) run survives reconcile and shows");

  // completing the run clears the widget (no active runs -> undefined).
  await writeSubagentRunStatus(paths, "research-explore-auth-1", {
    state: "complete",
    cwd: tempRoot,
    startedAt: nowMs,
    lastUpdate: nowMs + 1000,
    endedAt: nowMs + 1000,
    steps: [{ agent: "aipi-worker", status: "complete" }],
  });
  const cleared = [];
  await refreshSubagentWidget({ mode: "tui", ui: { setWidget: (key, content) => cleared.push({ key, content }) } }, tempRoot);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].content, undefined, "no active runs clears the widget");

  // non-TUI mode is a no-op.
  const headless = [];
  await refreshSubagentWidget({ mode: "json", ui: { setWidget: (k, c) => headless.push({ k, c }) } }, tempRoot);
  assert.equal(headless.length, 0, "non-TUI mode does not touch the widget");

  console.log("AIPI_SUBAGENT_WIDGET_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
