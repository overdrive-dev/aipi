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
const now = () => new Date(`2026-06-24T02:00:${String(tick++).padStart(2, "0")}.000Z`);
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
  // task-scoped answer seeded ONLY into t1's run.
  assert.equal(seeds.filter((s) => s.runId === "run-t1").length, 1);
  assert.equal(seeds.filter((s) => s.runId === "run-t2").length, 0);
  assert.match(seeds[0].text, /persistir inativos\?/);
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

  console.log("AIPI_PLAN_EXECUTOR_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
