import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  addBusinessRules,
  addPlanQuestions,
  classifyPlanTask,
  clearActivePlan,
  closePlan,
  createPlan,
  readActivePlan,
  readPlan,
  recordPlanAnswer,
  setTaskStatus,
  settlePlan,
  unsettledReasons,
} from "../extensions/aipi/runtime/plan-state.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-plan-state-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
const now = () => new Date(`2026-06-24T00:00:${String(tick++).padStart(2, "0")}.000Z`);
const fixedRandom = () => Buffer.from("abcdef", "hex");

async function readKanban(root) {
  const text = await fs.readFile(path.join(root, ".aipi", "runtime", "kanban.jsonl"), "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // classifyPlanTask: keyword routing + accent-insensitive.
  assert.equal(classifyPlanTask("corrigir o bug do save").workflow, "bugfix");
  assert.equal(classifyPlanTask("fazer deploy em produção").workflow, "ops");
  assert.equal(classifyPlanTask("pesquisar opções de cache").workflow, "research");
  assert.equal(classifyPlanTask("adicionar coluna nova na tela").workflow, "planning");
  assert.equal(classifyPlanTask("migração de schema").workflow, "ops");
  assert.deepEqual(classifyPlanTask("corrigir bug"), { workflow: "bugfix", param: "bug" });

  // createPlan: classifies, plumbs the primary param, registers EACH task on the kanban individually.
  const { planId, plan } = await createPlan({
    projectRoot: tempRoot,
    tasks: [
      "corrigir o bug do save no perfil",
      "fazer deploy do serviço de faturamento",
      { text: "implementar contrato de convite", workflow: "feature" },
      "investigar lentidão na listagem",
    ],
    now,
    randomBytes: fixedRandom,
  });
  assert.match(planId, /^plan-20260624T0000\d\dZ-abcdef$/);
  assert.equal(plan.status, "discovery");
  assert.equal(plan.tasks.length, 4);
  assert.deepEqual(plan.tasks.map((t) => t.task_id), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(plan.tasks.map((t) => t.workflow), ["bugfix", "ops", "feature", "research"]);
  assert.equal(plan.tasks[0].params.bug, "corrigir o bug do save no perfil");
  assert.equal(plan.tasks[1].params.objective, "fazer deploy do serviço de faturamento");
  assert.deepEqual(plan.tasks[2].params, {}, "feature is contract-driven: no free-text param");
  assert.equal(plan.tasks[3].params.topic, "investigar lentidão na listagem");

  // Each task is on the kanban as its own "planned" card.
  let kanban = await readKanban(tempRoot);
  assert.equal(kanban.length, 4, "one kanban card per task at creation");
  assert.ok(kanban.every((e) => e.schema === "aipi.kanban-event.v1" && e.status === "planned"));
  assert.deepEqual(
    kanban.map((e) => e.task),
    plan.tasks.map((t) => t.kanban_task),
  );

  // PLAN.json + active pointer are persisted and readable.
  const active = await readActivePlan(tempRoot);
  assert.equal(active.planId, planId);
  assert.equal(active.plan.tasks.length, 4);
  const planFile = JSON.parse(await fs.readFile(path.join(tempRoot, plan.plan_rel_dir, "PLAN.json"), "utf8"));
  assert.equal(planFile.schema, "aipi.plan.v1");

  // Questions + answers: the settlement gate keys on ALL questions being answered.
  await addPlanQuestions({
    projectRoot: tempRoot,
    questions: [
      { task_id: "t1", question: "O save deve persistir em perfis inativos?", options: ["Sim", "Não"] },
      { question: "Podemos pausar faturamento durante o deploy?", options: ["Sim", "Não"] },
    ],
    now,
  });
  let reasons = unsettledReasons((await readActivePlan(tempRoot)).plan);
  assert.equal(reasons.length, 2, "two unanswered questions block settlement");
  await assert.rejects(() => settlePlan({ projectRoot: tempRoot, now }), /not settleable/);

  await recordPlanAnswer({ projectRoot: tempRoot, questionId: "q1", answer: "Sim", now });
  await recordPlanAnswer({ projectRoot: tempRoot, questionId: "q2", answer: "Não", now });
  assert.equal(unsettledReasons((await readActivePlan(tempRoot)).plan).length, 0);

  await addBusinessRules({
    projectRoot: tempRoot,
    rules: [{ text: "Perfis inativos não recebem cobrança", source: ".aipi/memory/project/business-rules.md:12" }],
    now,
  });

  const settled = await settlePlan({ projectRoot: tempRoot, now });
  assert.equal(settled.plan.status, "settled");
  assert.ok(settled.plan.settled_at);

  // Task transitions update status AND append an individual kanban event each time.
  await setTaskStatus({ projectRoot: tempRoot, taskId: "t1", status: "running", runId: "20260624T0001Z-run1", now });
  kanban = await readKanban(tempRoot);
  assert.equal(kanban.length, 5);
  assert.equal(kanban.at(-1).status, "in_progress");
  assert.equal(kanban.at(-1).run_id, "20260624T0001Z-run1");
  assert.equal(kanban.at(-1).task, plan.tasks[0].kanban_task);

  await setTaskStatus({ projectRoot: tempRoot, taskId: "t1", status: "passed", now });
  await setTaskStatus({ projectRoot: tempRoot, taskId: "t2", status: "passed", now });
  await setTaskStatus({ projectRoot: tempRoot, taskId: "t3", status: "skipped", now });
  const afterMost = (await readActivePlan(tempRoot)).plan;
  assert.equal(afterMost.status, "executing", "still executing while t4 is pending");

  await setTaskStatus({ projectRoot: tempRoot, taskId: "t4", status: "passed", now });
  const done = (await readActivePlan(tempRoot, { includeTerminal: true })).plan;
  assert.equal(done.status, "completed", "all tasks passed/skipped -> plan completed");
  kanban = await readKanban(tempRoot);
  assert.equal(kanban.length, 9, "4 created + 5 transitions");

  // A blocked task rolls the plan up to blocked.
  const { plan: plan2 } = await createPlan({ projectRoot: tempRoot, tasks: ["corrigir outro bug"], now, randomBytes: fixedRandom });
  await setTaskStatus({ projectRoot: tempRoot, planId: plan2.plan_id, taskId: "t1", status: "blocked", now });
  assert.equal((await readPlan(tempRoot, plan2.plan_id)).plan.status, "blocked");

  // closePlan / clearActivePlan terminal handling.
  await closePlan({ projectRoot: tempRoot, planId: plan2.plan_id, status: "cancelled", reason: "test", now });
  assert.equal(await readActivePlan(tempRoot), null, "cancelled plan is cleared from active");
  const cleared = await clearActivePlan(tempRoot);
  assert.equal(cleared.cleared, true);

  console.log("AIPI_PLAN_STATE_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
