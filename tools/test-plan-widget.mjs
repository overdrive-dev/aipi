import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { createPlan } from "../extensions/aipi/runtime/plan-state.js";
import { refreshPlanWidget, renderPlanWidgetLines } from "../extensions/aipi/runtime/plan-widget.js";

// --- pure render: no active plan -> [] (clears the widget) ---
assert.deepEqual(renderPlanWidgetLines(null), []);
assert.deepEqual(renderPlanWidgetLines({ plan: null }), []);

// --- pure render: a discovery plan with a passed task and an open question ---
const discovery = renderPlanWidgetLines({
  plan: {
    plan_id: "plan-1",
    status: "discovery",
    execution_cadence: "checkpoint_per_task",
    tasks: [
      { task_id: "t1", workflow: "bugfix", text: "corrigir o save", status: "pending" },
      { task_id: "t2", workflow: "ops", text: "deploy faturamento", status: "passed" },
    ],
    questions: [{ question_id: "q1", question: "persistir inativos?", answer: "" }],
  },
});
assert.ok(discovery[0].includes("plan-1") && discovery[0].includes("discovery"), discovery[0]);
assert.ok(discovery[0].includes("1/2 done"), "counts only passed/skipped tasks as done");
assert.ok(discovery.some((l) => l.includes("t1") && l.includes("corrigir o save")));
assert.ok(discovery.some((l) => l.includes("✓") && l.includes("t2")), "passed task shows the done glyph");
assert.ok(discovery.some((l) => l.includes("open question")), "open question surfaced");

// --- pure render: a settled plan (all answered) shows the ready line, not the question line ---
const settled = renderPlanWidgetLines({
  plan: {
    plan_id: "plan-2",
    status: "settled",
    execution_cadence: "autonomous_to_pr",
    tasks: [{ task_id: "t1", workflow: "feature", text: "x", status: "pending" }],
    questions: [{ question_id: "q1", answer: "sim" }],
  },
});
assert.ok(settled.some((l) => l.includes("settled") && l.includes("ready")));
assert.ok(!settled.some((l) => l.includes("open question")));

// --- refreshPlanWidget: PULLS the active plan and pushes it; the mode guard blocks non-TUI ---
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-plan-widget-"));
try {
  await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: tempRoot });
  let tick = 0;
  const now = () => new Date(Date.parse("2026-07-09T00:00:00.000Z") + (tick++) * 1000);
  await createPlan({ projectRoot: tempRoot, tasks: ["corrigir o bug do save"], now });

  const tuiCalls = [];
  const tuiCtx = { mode: "tui", ui: { setWidget: (key, content) => tuiCalls.push({ key, content }) } };
  await refreshPlanWidget(tuiCtx, tempRoot);
  assert.equal(tuiCalls.length, 1, "TUI mode pushes the widget");
  assert.equal(tuiCalls[0].key, "aipi-plan");
  assert.ok(Array.isArray(tuiCalls[0].content) && tuiCalls[0].content[0].includes("AIPI plan"));

  // non-TUI mode (headless / RPC / json / print) is a no-op — never touches the widget surface.
  const jsonCalls = [];
  await refreshPlanWidget({ mode: "json", ui: { setWidget: (k, c) => jsonCalls.push({ k, c }) } }, tempRoot);
  assert.equal(jsonCalls.length, 0, "non-TUI mode does not touch the widget");

  console.log("AIPI_PLAN_WIDGET_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
