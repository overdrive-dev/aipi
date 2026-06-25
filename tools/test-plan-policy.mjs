import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  addBusinessRules,
  addPlanQuestions,
  createPlan,
  recordPlanAnswer,
  settlePlan,
} from "../extensions/aipi/runtime/plan-state.js";
import { executePlanRun } from "../extensions/aipi/runtime/plan-executor.js";
import {
  PlanPolicyError,
  assertPlanExecutable,
  planExecutionBlockers,
  planPolicyGate,
} from "../extensions/aipi/runtime/plan-policy.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-plan-policy-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
const now = () => new Date(`2026-06-24T03:00:${String(tick++).padStart(2, "0")}.000Z`);
const fixedRandom = () => Buffer.from("abcdef", "hex");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // ---- planPolicyGate: pure unit ----
  const basePlan = {
    tasks: [
      { task_id: "t1", status: "pending", depends_on: [], requires_rules: [], requires_answers: [] },
      { task_id: "t2", status: "pending", depends_on: ["t1"], requires_rules: [], requires_answers: [] },
    ],
    questions: [],
    business_rules: [],
  };
  assert.equal(planPolicyGate({ plan: basePlan, task: basePlan.tasks[0] }).ok, true);

  // dependency not satisfied -> blocked
  const depGate = planPolicyGate({ plan: basePlan, task: basePlan.tasks[1] });
  assert.equal(depGate.ok, false);
  assert.match(depGate.reason, /waits on dependency t1/);

  // unanswered task-scoped question -> blocked
  const qPlan = {
    tasks: [{ task_id: "t1", status: "pending", depends_on: [], requires_rules: [], requires_answers: [] }],
    questions: [{ question_id: "q1", task_id: "t1", question: "p?", answer: null }],
    business_rules: [],
  };
  assert.equal(planPolicyGate({ plan: qPlan, task: qPlan.tasks[0] }).ok, false);
  qPlan.questions[0].answer = "sim";
  assert.equal(planPolicyGate({ plan: qPlan, task: qPlan.tasks[0] }).ok, true);

  // requires_answers referencing a missing/unanswered question -> blocked
  const reqAnsPlan = {
    tasks: [{ task_id: "t1", status: "pending", depends_on: [], requires_rules: [], requires_answers: ["q9"] }],
    questions: [],
    business_rules: [],
  };
  assert.match(planPolicyGate({ plan: reqAnsPlan, task: reqAnsPlan.tasks[0] }).reason, /requires answer q9 which does not exist/);

  // requires_rules referencing a missing rule -> blocked; present -> ok
  const reqRulePlan = {
    tasks: [{ task_id: "t1", status: "pending", depends_on: [], requires_rules: ["r1"], requires_answers: [] }],
    questions: [],
    business_rules: [],
  };
  assert.match(planPolicyGate({ plan: reqRulePlan, task: reqRulePlan.tasks[0] }).reason, /requires business rule r1 which is not recorded/);
  reqRulePlan.business_rules = [{ rule_id: "r1", text: "x" }];
  assert.equal(planPolicyGate({ plan: reqRulePlan, task: reqRulePlan.tasks[0] }).ok, true);

  // ---- assertPlanExecutable / planExecutionBlockers ----
  assert.deepEqual(planExecutionBlockers(null), ["no plan"]);
  const discovery = { status: "discovery", tasks: [{ task_id: "t1", status: "pending" }], questions: [{ question_id: "q1", answer: null }] };
  const blockers = planExecutionBlockers(discovery);
  assert.ok(blockers.some((r) => /must be settled/.test(r)));
  assert.ok(blockers.some((r) => /q1 unanswered/.test(r)));
  assert.throws(() => assertPlanExecutable(discovery), PlanPolicyError);
  const ok = { status: "settled", tasks: [{ task_id: "t1", status: "pending" }], questions: [] };
  assert.equal(assertPlanExecutable(ok), true);

  // ---- executor integration: a requires_rules task with the rule MISSING halts the plan ----
  const { planId } = await createPlan({
    projectRoot: tempRoot,
    tasks: [{ text: "implementar cobrança", requires_rules: ["r1"] }],
    now,
    randomBytes: fixedRandom,
  });
  await settlePlan({ projectRoot: tempRoot, planId, now }); // no questions -> settles
  let started = 0;
  const blockedRun = await executePlanRun({
    projectRoot: tempRoot,
    planId,
    now,
    startRun: async () => { started += 1; return { runId: "r" }; },
    executeRun: async () => ({ status: "completed" }),
    recordUserInput: async () => {},
  });
  assert.equal(blockedRun.halted, true);
  assert.equal(blockedRun.tasks[0].status, "blocked");
  assert.match(blockedRun.tasks[0].reason, /requires business rule r1/);
  assert.equal(started, 0, "the gate blocks BEFORE starting any run");

  // Record the rule, re-execute: now the task runs.
  await addBusinessRules({ projectRoot: tempRoot, planId, rules: [{ text: "inativos não recebem cobrança" }], now });
  const okRun = await executePlanRun({
    projectRoot: tempRoot,
    planId,
    now,
    startRun: async () => { started += 1; return { runId: "r" }; },
    executeRun: async () => ({ status: "completed" }),
    recordUserInput: async () => {},
  });
  assert.equal(okRun.tasks[0].status, "passed");
  assert.equal(started, 1, "task runs once the required rule is recorded");

  // ---- executor refuses a plan with an unanswered question (before_plan_execution) ----
  const { planId: p2 } = await createPlan({ projectRoot: tempRoot, tasks: ["corrigir bug"], now, randomBytes: fixedRandom });
  await addPlanQuestions({ projectRoot: tempRoot, planId: p2, questions: [{ question: "qual regra?" }], now });
  // not settled (question open) -> executor throws before any run
  await assert.rejects(
    () => executePlanRun({ projectRoot: tempRoot, planId: p2, now, startRun: async () => ({ runId: "r" }), executeRun: async () => ({ status: "completed" }), recordUserInput: async () => {} }),
    PlanPolicyError,
  );
  await recordPlanAnswer({ projectRoot: tempRoot, planId: p2, questionId: "q1", answer: "regra X", now });
  await settlePlan({ projectRoot: tempRoot, planId: p2, now });
  const p2run = await executePlanRun({
    projectRoot: tempRoot,
    planId: p2,
    now,
    startRun: async () => ({ runId: "r2" }),
    executeRun: async () => ({ status: "completed" }),
    recordUserInput: async () => {},
  });
  assert.equal(p2run.tasks[0].status, "passed");

  console.log("AIPI_PLAN_POLICY_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
