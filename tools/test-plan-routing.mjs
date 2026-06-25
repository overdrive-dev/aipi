import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  aipiMultiTaskEnabled,
  createAipiLifecycleHandlers,
  detectTaskBatch,
} from "../extensions/aipi/runtime/lifecycle-hooks.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-plan-routing-"));
const sourceRoot = path.resolve("templates/.aipi");
const priorMultiTask = process.env.AIPI_MULTI_TASK;

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // ---- aipiMultiTaskEnabled: opt-in, default off ----
  assert.equal(aipiMultiTaskEnabled({}), false);
  assert.equal(aipiMultiTaskEnabled({ AIPI_MULTI_TASK: "1" }), true);
  assert.equal(aipiMultiTaskEnabled({ AIPI_MULTI_TASK: "true" }), true);
  assert.equal(aipiMultiTaskEnabled({ AIPI_MULTI_TASK: "0" }), false);

  // ---- detectTaskBatch: conservative (needs list markers on >=2 lines) ----
  assert.deepEqual(detectTaskBatch("- corrigir bug A\n- fazer deploy B"), ["corrigir bug A", "fazer deploy B"]);
  assert.deepEqual(detectTaskBatch("1. primeiro\n2) segundo\n3. terceiro"), ["primeiro", "segundo", "terceiro"]);
  assert.deepEqual(detectTaskBatch("corrigir o bug do save"), [], "single line is not a batch");
  assert.deepEqual(detectTaskBatch("uma frase\noutra frase qualquer"), [], "2-line prose (no markers) is not a batch");
  assert.deepEqual(detectTaskBatch("/aipi-plan algo"), [], "a command is not a batch");
  assert.deepEqual(detectTaskBatch(""), []);

  // ---- handleInput integration ----
  const notes = [];
  const entries = [];
  const handlers = createAipiLifecycleHandlers({
    pi: { appendEntry: (type, data) => entries.push({ type, data }) },
    projectRootResolver: () => tempRoot,
    coordinator: { setHostModel() {}, getHostModel: () => null },
  });
  const ctx = { ui: { notify: (message, kind) => notes.push({ message, kind }) } };
  const batchText = "- corrigir o bug do save\n- fazer deploy do faturamento\n- investigar lentidão na listagem";

  // multi-task OFF (default): a batch is NOT intercepted (no plan suggestion).
  delete process.env.AIPI_MULTI_TASK;
  const off = await handlers.input({ type: "input", text: batchText, source: "interactive" }, ctx);
  assert.deepEqual(off, { action: "continue" });
  assert.equal(notes.filter((n) => /multi-task/i.test(n.message ?? "")).length, 0, "off: no plan suggestion");

  // multi-task ON: a clear batch is offered to /aipi-plan (suggestion + continue, non-destructive).
  process.env.AIPI_MULTI_TASK = "1";
  const on = await handlers.input({ type: "input", text: batchText, source: "interactive" }, ctx);
  assert.deepEqual(on, { action: "continue" });
  const suggestion = notes.find((n) => /multi-task/i.test(n.message ?? ""));
  assert.ok(suggestion, "on: a plan suggestion is surfaced");
  assert.match(suggestion.message, /detected 3 tasks/);
  assert.match(suggestion.message, /\/aipi-plan/);
  assert.ok(
    entries.some((e) => e.type === "aipi.input.route" && e.data.input === "suggest_plan" && e.data.task_count === 3),
    "the suggest_plan route is recorded",
  );

  // ON but a single message (not a batch) is left to normal single-task handling (no suggestion).
  const single = await handlers.input({ type: "input", text: "corrige o save por favor", source: "interactive" }, ctx);
  assert.deepEqual(single, { action: "continue" });
  assert.equal(notes.filter((n) => /multi-task/i.test(n.message ?? "")).length, 1, "single message adds no new suggestion");

  console.log("AIPI_PLAN_ROUTING_TEST_OK");
} finally {
  if (priorMultiTask === undefined) delete process.env.AIPI_MULTI_TASK;
  else process.env.AIPI_MULTI_TASK = priorMultiTask;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
