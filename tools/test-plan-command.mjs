import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { addPlanQuestions, readActivePlan } from "../extensions/aipi/runtime/plan-state.js";
import {
  buildDiscoveryReport,
  formatPlanCommandResult,
  parsePlanArgs,
  parsePlanTasks,
  preflightPlan,
  runPlanCommand,
} from "../extensions/aipi/runtime/plan-command.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-plan-cmd-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
const nowBase = Date.parse("2026-06-24T01:00:00.000Z");
const now = () => new Date(nowBase + (tick++) * 1000);

async function readKanban(root) {
  const text = await fs.readFile(path.join(root, ".aipi", "runtime", "kanban.jsonl"), "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// Deterministic rule investigator (stands in for materializeProjectMemory).
const fakeInvestigate = async () => ({
  refs: [{ path: ".aipi/memory/project/business-rules.md", line: 12, excerpt: "Perfis inativos não recebem cobrança" }],
});

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // parsePlanTasks: bullets, numbers, single line, plain newlines.
  assert.deepEqual(parsePlanTasks("- a\n- b\n- c"), ["a", "b", "c"]);
  assert.deepEqual(parsePlanTasks("1. primeiro\n2) segundo"), ["primeiro", "segundo"]);
  assert.deepEqual(parsePlanTasks("corrigir o bug do save"), ["corrigir o bug do save"]);
  assert.deepEqual(parsePlanTasks(""), []);
  assert.deepEqual(parsePlanTasks("fix bug\ndeploy svc"), ["fix bug", "deploy svc"]);

  // parsePlanArgs grammar.
  assert.deepEqual(parsePlanArgs(""), { action: "status" });
  assert.deepEqual(parsePlanArgs("status"), { action: "status" });
  assert.deepEqual(parsePlanArgs("settle"), { action: "settle" });
  assert.deepEqual(parsePlanArgs("execute"), { action: "execute" });
  assert.deepEqual(parsePlanArgs("cancel"), { action: "cancel" });
  assert.deepEqual(parsePlanArgs("answer q3 Sim, pode"), { action: "answer", questionId: "q3", answer: "Sim, pode" });
  assert.deepEqual(parsePlanArgs("create\n- a\n- b"), { action: "create", tasks: ["a", "b"] });
  assert.deepEqual(parsePlanArgs("- a\n- b"), { action: "create", tasks: ["a", "b"] });
  assert.deepEqual(parsePlanArgs("corrigir bug do save"), { action: "create", tasks: ["corrigir bug do save"] });
  assert.throws(() => parsePlanArgs("answer"), /requires a question id/);
  // cadence verb: bare = read-only query; checkpoint|autonomous (incl. full names) set; bad value throws.
  assert.deepEqual(parsePlanArgs("cadence"), { action: "cadence", set: false });
  assert.deepEqual(parsePlanArgs("cadence autonomous"), { action: "cadence", set: true, cadence: "autonomous_to_pr" });
  assert.deepEqual(parsePlanArgs("cadence checkpoint"), { action: "cadence", set: true, cadence: "checkpoint_per_task" });
  assert.deepEqual(parsePlanArgs("cadence autonomous_to_pr"), { action: "cadence", set: true, cadence: "autonomous_to_pr" });
  assert.throws(() => parsePlanArgs("cadence warp"), /checkpoint \| autonomous/);

  // create -> pre-flight: classifies tasks, investigates rules once, one kanban card per task.
  const created = await runPlanCommand({
    projectRoot: tempRoot,
    args: "- corrigir o bug do save no perfil\n- fazer deploy do faturamento",
    now,
    investigate: fakeInvestigate,
  });
  assert.equal(created.action, "create");
  assert.equal(created.plan.tasks.length, 2);
  assert.deepEqual(created.plan.tasks.map((t) => t.workflow), ["bugfix", "ops"]);
  assert.equal(created.plan.business_rules.length, 1, "rules investigated once and attached");
  assert.equal(created.discovery.business_rules[0].source, ".aipi/memory/project/business-rules.md:12");
  assert.equal((await readKanban(tempRoot)).length, 2, "one kanban card per task");
  assert.match(formatPlanCommandResult(created), /AIPI plan created/);

  // cadence: query default, then set to autonomous in discovery (the enabler for the stop-classifier).
  const cadQuery = await runPlanCommand({ projectRoot: tempRoot, args: "cadence", now });
  assert.equal(cadQuery.set, false);
  assert.equal(cadQuery.cadence, "checkpoint_per_task");
  const cadSet = await runPlanCommand({ projectRoot: tempRoot, args: "cadence autonomous", now });
  assert.equal(cadSet.set, true);
  assert.equal(cadSet.cadence, "autonomous_to_pr");
  assert.match(formatPlanCommandResult(cadSet), /autonomous_to_pr/);
  assert.equal((await readActivePlan(tempRoot)).plan.execution_cadence, "autonomous_to_pr");

  // Orchestrator drafts a clarifying question (engine enforces it must be answered to settle).
  await addPlanQuestions({
    projectRoot: tempRoot,
    questions: [{ task_id: "t1", question: "O save deve persistir em perfis inativos?", options: ["Sim", "Não"] }],
    now,
  });

  // settle is BLOCKED while the question is open.
  const blocked = await runPlanCommand({ projectRoot: tempRoot, args: "settle", now });
  assert.equal(blocked.settled, false);
  assert.equal(blocked.reasons.length, 1);
  assert.match(formatPlanCommandResult(blocked), /NOT settled/);

  // answer it, then settle passes.
  const answered = await runPlanCommand({ projectRoot: tempRoot, args: "answer q1 Sim", now });
  assert.equal(answered.action, "answer");
  assert.equal(answered.remaining, 0);

  const settled = await runPlanCommand({ projectRoot: tempRoot, args: "settle", now });
  assert.equal(settled.settled, true);
  assert.equal(settled.plan.status, "settled");
  assert.equal(settled.plan.execution_cadence, "autonomous_to_pr", "settle freezes the chosen cadence");
  // After settle the cadence is frozen: changing it is rejected.
  await assert.rejects(() => runPlanCommand({ projectRoot: tempRoot, args: "cadence checkpoint", now }), /discovery-phase only/);

  // execute dispatches to the injected plan executor with the active plan.
  let executorCalledWith = null;
  const exec = await runPlanCommand({
    projectRoot: tempRoot,
    args: "execute",
    now,
    planExecutor: async (opts) => {
      executorCalledWith = opts;
      return { status: "completed" };
    },
  });
  assert.equal(exec.action, "execute");
  assert.equal(exec.execution.status, "completed");
  assert.ok(executorCalledWith.planId, "executor receives the active plan id");

  // status reflects the active settled plan; cancel clears it.
  const status = await runPlanCommand({ projectRoot: tempRoot, args: "status", now });
  assert.equal(status.active.plan.status, "settled");
  await runPlanCommand({ projectRoot: tempRoot, args: "cancel", now });
  assert.equal(await readActivePlan(tempRoot), null);

  // Real materializeProjectMemory path (template memory present) does not throw.
  const realCreate = await runPlanCommand({ projectRoot: tempRoot, args: "investigar opções de cache na listagem", now });
  assert.equal(realCreate.plan.tasks[0].workflow, "research");
  assert.ok(buildDiscoveryReport(realCreate.plan).instruction.includes("Autonomy Law"));

  console.log("AIPI_PLAN_COMMAND_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
