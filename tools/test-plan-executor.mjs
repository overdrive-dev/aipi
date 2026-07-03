import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { clearActiveRun, startWorkflowRun } from "../extensions/aipi/runtime/run-state.js";
import {
  addPlanQuestions,
  createPlan,
  readPlan,
  recordPlanAnswer,
  setTaskStatus,
  settlePlan,
} from "../extensions/aipi/runtime/plan-state.js";
import { executePlanRun, mapRunStatusToTask } from "../extensions/aipi/runtime/plan-executor.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-plan-exec-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
// Epoch-based so a large number of now() calls rolls over minutes cleanly (2-digit seconds would overflow
// past :59 once enough steps run).
const nowBase = Date.parse("2026-06-24T02:00:00.000Z");
const now = () => new Date(nowBase + (tick++) * 1000);
const fixedRandom = () => Buffer.from("abcdef", "hex");

async function readKanban(root) {
  const text = await fs.readFile(path.join(root, ".aipi", "runtime", "kanban.jsonl"), "utf8").catch(() => "");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // mapRunStatusToTask
  assert.equal(mapRunStatusToTask("completed"), "passed");
  assert.equal(mapRunStatusToTask("skipped"), "skipped");
  assert.equal(mapRunStatusToTask("blocked"), "blocked");
  assert.equal(mapRunStatusToTask("escalated_to_human"), "blocked");
  assert.equal(mapRunStatusToTask("failed"), "failed");
  assert.equal(mapRunStatusToTask("cancelled"), "failed");

  // REAL startWorkflowRun stamps plan_id/task_id into state.json.
  const started = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "bugfix",
    params: { bug: "x" },
    planId: "plan-stamp",
    taskId: "t9",
    now,
    randomBytes: fixedRandom,
  });
  const stamped = JSON.parse(await fs.readFile(path.join(tempRoot, started.runRelDir, "state.json"), "utf8"));
  assert.equal(stamped.plan_id, "plan-stamp");
  assert.equal(stamped.task_id, "t9");
  await clearActiveRun(tempRoot, started.runId);

  // --- Happy path: 2 tasks, one task-scoped question, all runs complete. ---
  const { planId } = await createPlan({
    projectRoot: tempRoot,
    tasks: ["corrigir o bug A", "fazer deploy B"],
    now,
    randomBytes: fixedRandom,
  });
  await addPlanQuestions({ projectRoot: tempRoot, planId, questions: [{ task_id: "t1", question: "persistir inativos?" }], now });
  await recordPlanAnswer({ projectRoot: tempRoot, planId, questionId: "q1", answer: "Sim", now });
  await settlePlan({ projectRoot: tempRoot, planId, now });

  const kanbanBefore = (await readKanban(tempRoot)).length;
  const startCalls = [];
  const seeds = [];
  const fakeStart = async (opts) => {
    startCalls.push(opts);
    return { runId: `run-${opts.taskId}`, runRelDir: `.aipi/runtime/runs/run-${opts.taskId}` };
  };
  const fakeExec = async (opts) => ({ status: "completed", runId: opts.runId });
  const fakeRecord = async (opts) => { seeds.push(opts); };

  const res = await executePlanRun({
    projectRoot: tempRoot,
    planId,
    now,
    startRun: fakeStart,
    executeRun: fakeExec,
    recordUserInput: fakeRecord,
  });
  assert.equal(res.status, "completed");
  assert.deepEqual(res.tasks.map((t) => t.status), ["passed", "passed"]);
  assert.equal(res.halted, false);
  // started with the right workflow/params, bound to the plan/task.
  assert.equal(startCalls[0].workflow, "bugfix");
  assert.equal(startCalls[0].params.bug, "corrigir o bug A");
  assert.equal(startCalls[0].planId, planId);
  assert.equal(startCalls[0].taskId, "t1");
  assert.equal(startCalls[1].workflow, "ops");
  // task-scoped answer seeded ONLY into t1's run (filter to plan_preflight; cadence is seeded into both).
  assert.equal(seeds.filter((s) => s.runId === "run-t1" && s.source === "plan_preflight").length, 1);
  assert.equal(seeds.filter((s) => s.runId === "run-t2" && s.source === "plan_preflight").length, 0);
  assert.match(seeds.find((s) => s.source === "plan_preflight").text, /persistir inativos\?/);
  // F1: the cadence directive is seeded once per FRESH run, LAST (after pre-flight answers), so it survives
  // the last-N user-input window and removes the reason to improvise a cadence/checkpoint question.
  const cadenceSeeds = seeds.filter((s) => s.source === "plan_cadence");
  assert.equal(cadenceSeeds.length, 2, "cadence directive seeded once per fresh run");
  assert.match(cadenceSeeds[0].text, /EXECUTION CADENCE \(plan-level, do not re-ask\)/);
  assert.match(cadenceSeeds[0].text, /checkpoint_per_task/);
  assert.match(cadenceSeeds[0].text, /do NOT ask about pace\/cadence\/checkpoints/);
  assert.deepEqual(
    seeds.filter((s) => s.runId === "run-t1").map((s) => s.source),
    ["plan_preflight", "plan_cadence"],
    "cadence is seeded LAST (after the pre-flight answers)",
  );
  // each task got running + done kanban cards.
  assert.equal((await readKanban(tempRoot)).length, kanbanBefore + 4);
  const finished = (await readPlan(tempRoot, planId)).plan;
  assert.equal(finished.tasks[0].run_id, "run-t1");
  assert.equal(finished.tasks[1].run_id, "run-t2");

  // --- Block path: first task blocks, plan HALTS (second task never starts). ---
  const { planId: p2 } = await createPlan({ projectRoot: tempRoot, tasks: ["corrigir bug C", "fazer deploy D"], now, randomBytes: fixedRandom });
  await settlePlan({ projectRoot: tempRoot, planId: p2, now });
  const startCalls2 = [];
  const res2 = await executePlanRun({
    projectRoot: tempRoot,
    planId: p2,
    now,
    startRun: async (opts) => { startCalls2.push(opts); return { runId: `r2-${opts.taskId}` }; },
    executeRun: async (opts) => ({ status: opts.runId === "r2-t1" ? "blocked" : "completed" }),
    recordUserInput: async () => {},
  });
  assert.equal(res2.halted, true);
  assert.equal(res2.status, "blocked");
  assert.deepEqual(res2.tasks.map((t) => t.status), ["blocked"]);
  assert.equal(startCalls2.length, 1, "second task never starts after a block");

  // --- Not-settled guard. ---
  const { planId: p3 } = await createPlan({ projectRoot: tempRoot, tasks: ["algo qualquer"], now, randomBytes: fixedRandom });
  await assert.rejects(
    () => executePlanRun({ projectRoot: tempRoot, planId: p3, now, startRun: fakeStart, executeRun: fakeExec, recordUserInput: fakeRecord }),
    /not executable|must be settled/,
  );

  // --- Resume: a task already passed is not re-run. ---
  const { planId: p4 } = await createPlan({ projectRoot: tempRoot, tasks: ["corrigir E", "deploy F"], now, randomBytes: fixedRandom });
  await settlePlan({ projectRoot: tempRoot, planId: p4, now });
  await setTaskStatus({ projectRoot: tempRoot, planId: p4, taskId: "t1", status: "passed", now });
  const startCalls4 = [];
  const res4 = await executePlanRun({
    projectRoot: tempRoot,
    planId: p4,
    now,
    startRun: async (opts) => { startCalls4.push(opts); return { runId: `r4-${opts.taskId}` }; },
    executeRun: async () => ({ status: "completed" }),
    recordUserInput: async () => {},
  });
  assert.equal(res4.tasks[0].resumed, true);
  assert.equal(res4.tasks[1].status, "passed");
  assert.equal(startCalls4.length, 1, "only the unfinished task is started on resume");
  assert.equal(startCalls4[0].taskId, "t2");

  // --- Review HIGH: intra-run dependency chain. t2 depends_on t1; both must pass in ONE execute (the
  //     gate for t2 must see t1 as passed via the per-iteration re-read, not the stale initial snapshot). ---
  const { planId: pdep } = await createPlan({
    projectRoot: tempRoot,
    tasks: ["preparar a base", { text: "fazer o deploy", depends_on: ["t1"] }],
    now,
    randomBytes: fixedRandom,
  });
  await settlePlan({ projectRoot: tempRoot, planId: pdep, now });
  const depCalls = [];
  const resDep = await executePlanRun({
    projectRoot: tempRoot,
    planId: pdep,
    now,
    startRun: async (opts) => { depCalls.push(opts.taskId); return { runId: `rd-${opts.taskId}` }; },
    executeRun: async () => ({ status: "completed" }),
    recordUserInput: async () => {},
  });
  assert.deepEqual(resDep.tasks.map((t) => t.status), ["passed", "passed"], "dependent task is NOT blocked by a stale snapshot");
  assert.deepEqual(depCalls, ["t1", "t2"]);

  // --- Review MEDIUM: crash recovery. A task left "running" with a run_id resumes that run instead of
  //     orphaning it and starting a new one. ---
  const { planId: pcrash } = await createPlan({ projectRoot: tempRoot, tasks: ["tarefa que crashou"], now, randomBytes: fixedRandom });
  await settlePlan({ projectRoot: tempRoot, planId: pcrash, now });
  await setTaskStatus({ projectRoot: tempRoot, planId: pcrash, taskId: "t1", status: "running", runId: "crashed-run-1", now });
  let startedCrash = 0;
  let resumedRunId = null;
  const resCrash = await executePlanRun({
    projectRoot: tempRoot,
    planId: pcrash,
    now,
    startRun: async () => { startedCrash += 1; return { runId: "new-run" }; },
    executeRun: async (opts) => { resumedRunId = opts.runId; return { status: "completed" }; },
    recordUserInput: async () => {},
  });
  assert.equal(startedCrash, 0, "a stuck running task resumes its run; no new run is started");
  assert.equal(resumedRunId, "crashed-run-1");
  assert.equal(resCrash.tasks[0].status, "passed");

  // --- F4b consumer: stop-classifier gating of the halt decision. ---
  async function makeSettledPlan(tasks, cadence) {
    const { planId: pid } = await createPlan({ projectRoot: tempRoot, tasks, now, randomBytes: fixedRandom });
    if (cadence) {
      const pPath = path.join(tempRoot, ".aipi", "runtime", "plans", pid, "PLAN.json");
      const raw = JSON.parse(await fs.readFile(pPath, "utf8"));
      raw.execution_cadence = cadence;
      await fs.writeFile(pPath, JSON.stringify(raw));
    }
    await settlePlan({ projectRoot: tempRoot, planId: pid, now });
    return pid;
  }
  const blockedCourtesy = (firstRunId) => async (opts) => ({
    status: opts.runId === firstRunId ? "blocked" : "completed",
    state: opts.runId === firstRunId
      ? { blocked_reason: "AIPI parou: como voce quer seguir?", awaiting_user_input: { gate_kind: "courtesy", question: "Mantenho o ritmo?" } }
      : {},
  });

  // (a) autonomous + courtesy + classifier=continue => plan does NOT halt; both tasks start; the task stays blocked.
  const pA = await makeSettledPlan(["corrigir bug A2", "corrigir bug B2"], "autonomous_to_pr");
  const aCalls = [];
  const resA = await executePlanRun({
    projectRoot: tempRoot, planId: pA, now,
    startRun: async (opts) => { aCalls.push(opts.taskId); return { runId: `ra-${opts.taskId}` }; },
    executeRun: blockedCourtesy("ra-t1"),
    recordUserInput: async () => {},
    classifyStopFn: async () => ({ decision: "continue", reason: "courtesy_downgrade" }),
  });
  assert.equal(resA.halted, false, "courtesy stop under autonomous does not halt the plan");
  assert.deepEqual(aCalls, ["t1", "t2"]);
  assert.equal(resA.tasks[0].status, "blocked");
  assert.equal(resA.tasks[0].stop_classifier.decision, "continue");

  // (b) checkpoint_per_task (default) keeps the human checkpoint: classifier is NEVER consulted; plan halts.
  const pB = await makeSettledPlan(["corrigir bug C2", "corrigir bug D2"]);
  let bConsulted = false;
  const bCalls = [];
  const resB = await executePlanRun({
    projectRoot: tempRoot, planId: pB, now,
    startRun: async (opts) => { bCalls.push(opts.taskId); return { runId: `rb-${opts.taskId}` }; },
    executeRun: blockedCourtesy("rb-t1"),
    recordUserInput: async () => {},
    classifyStopFn: async () => { bConsulted = true; return { decision: "continue" }; },
  });
  assert.equal(resB.halted, true, "checkpoint cadence halts on a courtesy stop");
  assert.equal(bConsulted, false, "classifier is not consulted under checkpoint_per_task");
  assert.equal(bCalls.length, 1);

  // (c) infra (Sink A) is never courtesy: classifier is NEVER consulted; plan halts even autonomous + continue.
  const pC = await makeSettledPlan(["corrigir bug E2", "corrigir bug F2"], "autonomous_to_pr");
  let cConsulted = false;
  const resC = await executePlanRun({
    projectRoot: tempRoot, planId: pC, now,
    startRun: async (opts) => ({ runId: `rc-${opts.taskId}` }),
    executeRun: async (opts) => ({
      status: opts.runId === "rc-t1" ? "blocked" : "completed",
      state: opts.runId === "rc-t1"
        ? { blocked_reason: "no executable adapter is configured", awaiting_user_input: { gate_kind: "infra", question: "Como voce quer seguir?" } }
        : {},
    }),
    recordUserInput: async () => {},
    classifyStopFn: async () => { cConsulted = true; return { decision: "continue" }; },
  });
  assert.equal(resC.halted, true, "infra (Sink A) halts — never auto-continued");
  assert.equal(cConsulted, false, "classifier is not consulted for an infra stop");

  // (d) DEFAULT is automatic: the real classifyStop is ON by default with the deterministic discriminator,
  // so a generic courtesy stop under autonomous cadence auto-continues (no flag, no model wiring).
  const pD = await makeSettledPlan(["corrigir bug G2", "corrigir bug H2"], "autonomous_to_pr");
  const dCalls = [];
  const resD = await executePlanRun({
    projectRoot: tempRoot, planId: pD, now,
    startRun: async (opts) => { dCalls.push(opts.taskId); return { runId: `rd-${opts.taskId}` }; },
    executeRun: blockedCourtesy("rd-t1"),
    recordUserInput: async () => {},
  });
  assert.equal(resD.halted, false, "default-on deterministic classifier auto-continues a generic courtesy stop");
  assert.deepEqual(dCalls, ["t1", "t2"]);
  assert.equal(resD.tasks[0].stop_classifier.decision, "continue");

  // (e) DEFAULT keeps blocked when the courtesy stop's reason reads like a real gate FAILURE.
  const pE = await makeSettledPlan(["corrigir bug I2", "corrigir bug J2"], "autonomous_to_pr");
  const eCalls = [];
  const resE = await executePlanRun({
    projectRoot: tempRoot, planId: pE, now,
    startRun: async (opts) => { eCalls.push(opts.taskId); return { runId: `re-${opts.taskId}` }; },
    executeRun: async (opts) => ({
      status: opts.runId === "re-t1" ? "blocked" : "completed",
      state: opts.runId === "re-t1"
        // FIX 1: "PASS requires memory_promotions" is no longer generatable (coerced to SKIPPED instead).
        // Use a gate-failure string that fires GATE_FAILURE_SIGNAL (has "verdict" and "memory_promotions")
        // so the stop classifier's defaultStopClassifier still returns "stop" even with a courtesy question.
        ? { blocked_reason: "AIPI parou em quick_memory: memory promotion gate verdict FAIL — memory_promotions missing. Como voce quer seguir?", awaiting_user_input: { gate_kind: "courtesy", question: "Como voce quer seguir?" } }
        : {},
    }),
    recordUserInput: async () => {},
  });
  assert.equal(resE.halted, true, "default-on keeps blocked on a gate-failure-flavored courtesy stop");
  assert.equal(eCalls.length, 1);
  assert.equal(resE.tasks[0].stop_classifier.decision, "stop");

  console.log("AIPI_PLAN_EXECUTOR_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
