import { executeWorkflowRun } from "./workflow-executor.js";
import { recordWorkflowUserInput, startWorkflowRun } from "./run-state.js";
import { planPolicyGate } from "./plan-policy.js";
import { readActivePlan, readPlan, setTaskStatus, unsettledReasons } from "./plan-state.js";

// The multi-run executor. It drives ONE workflow run per plan task, in plan order, AFTER the plan is
// settled (all questions answered in pre-flight). Per task it: checks the plan policy gate (rules +
// answers), marks the task running (kanban in_progress), starts a run bound to the plan/task, seeds the
// run's user-inputs with the pre-collected answers (so every step sees them via the existing context
// path), executes the run, then maps the run outcome back onto the task + its kanban card. It HALTS the
// plan on the first task that blocks or fails — autonomous on the happy path, stops for a human on a real
// block instead of barreling on.

export async function executePlanRun({
  projectRoot,
  planId = null,
  now = () => new Date(),
  startRun = startWorkflowRun,
  executeRun = executeWorkflowRun,
  recordUserInput = recordWorkflowUserInput,
  setStatus = setTaskStatus,
  gate = planPolicyGate,
  adapter = undefined,
  notify = null,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const loaded = planId ? await readPlan(projectRoot, planId) : await readActivePlan(projectRoot, { includeTerminal: true });
  const plan = loaded?.plan;
  if (!plan) throw new Error("No AIPI plan to execute; create and settle one first");
  if (plan.status !== "settled" && plan.status !== "executing") {
    const reasons = unsettledReasons(plan);
    throw new Error(`plan ${plan.plan_id} is not settled (status=${plan.status})${reasons.length ? `: ${reasons.join("; ")}` : ""}`);
  }

  const results = [];
  let halted = false;
  for (const task of plan.tasks) {
    // Resume support: a task already finished in a prior execution is not re-run.
    if (["passed", "skipped"].includes(task.status)) {
      results.push({ task_id: task.task_id, status: task.status, resumed: true });
      continue;
    }

    // Policy gate (rules + answers + dependencies) BEFORE acting. A violation blocks the task and halts the
    // plan — answers/rules are a hard precondition, not advisory context.
    const verdict = gate({ plan, task });
    if (!verdict.ok) {
      await setStatus({ projectRoot, planId: plan.plan_id, taskId: task.task_id, status: "blocked", notes: verdict.reason, now });
      results.push({ task_id: task.task_id, status: "blocked", reason: verdict.reason });
      halted = true;
      break;
    }

    await setStatus({ projectRoot, planId: plan.plan_id, taskId: task.task_id, status: "running", now });

    const started = await startRun({
      projectRoot,
      workflow: task.workflow,
      params: task.params,
      planId: plan.plan_id,
      taskId: task.task_id,
      now,
    });

    // Seed the run with the answers collected in pre-flight, so the run's steps consume them through the
    // existing user-input context path (no mid-run re-asking of what the plan already settled).
    for (const question of plan.questions) {
      if (!isAnswered(question)) continue;
      if (question.task_id && question.task_id !== task.task_id) continue;
      await recordUserInput({
        projectRoot,
        runId: started.runId,
        text: `Q: ${question.question}\nA: ${question.answer}`,
        source: "plan_preflight",
        now,
      });
    }

    const execution = await executeRun({ projectRoot, runId: started.runId, adapter, notify });
    const taskStatus = mapRunStatusToTask(execution?.status);
    await setStatus({
      projectRoot,
      planId: plan.plan_id,
      taskId: task.task_id,
      status: taskStatus,
      runId: started.runId,
      notes: `run ${execution?.status ?? "unknown"}`,
      now,
    });
    results.push({ task_id: task.task_id, run_id: started.runId, run_status: execution?.status ?? null, status: taskStatus });

    if (taskStatus !== "passed" && taskStatus !== "skipped") {
      halted = true;
      break;
    }
  }

  const finalPlan = (await readPlan(projectRoot, plan.plan_id)).plan;
  return { planId: plan.plan_id, status: finalPlan.status, halted, tasks: results, plan: finalPlan };
}

// Map a run's terminal status onto a plan task status.
export function mapRunStatusToTask(runStatus) {
  const status = String(runStatus ?? "").toLowerCase();
  if (status === "completed") return "passed";
  if (status === "skipped") return "skipped";
  if (status === "blocked" || status === "escalated_to_human" || status === "escalated_to_planning") return "blocked";
  return "failed";
}

function isAnswered(question) {
  return typeof question?.answer === "string" && question.answer.trim().length > 0;
}
