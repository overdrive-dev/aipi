import { executeWorkflowRun } from "./workflow-executor.js";
import { recordWorkflowUserInput, startWorkflowRun } from "./run-state.js";
import { assertPlanExecutable, planPolicyGate } from "./plan-policy.js";
import { readActivePlan, readPlan, setTaskStatus } from "./plan-state.js";
import { classifyStop } from "./stop-classifier.js";

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
  classifyStopFn = classifyStop,
  stopClassifier = null,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const loaded = planId ? await readPlan(projectRoot, planId) : await readActivePlan(projectRoot, { includeTerminal: true });
  const plan = loaded?.plan;
  if (!plan) throw new Error("No AIPI plan to execute; create and settle one first");
  // before_plan_execution gate: the plan must be settled, every question answered, and a runnable task
  // present. This is where answers stop being context and become a hard precondition (throws PlanPolicyError).
  assertPlanExecutable(plan);

  const planId_ = plan.plan_id;
  const taskOrder = plan.tasks.map((task) => task.task_id);
  const results = [];
  let halted = false;
  for (const taskId of taskOrder) {
    // RE-READ the plan fresh before gating/acting on each task. setTaskStatus persists to disk, so the
    // initial snapshot goes stale within this loop — without the re-read a depends_on chain would see the
    // prior task as still "pending", and a concurrent external edit to PLAN.json would slip past the gate.
    const fresh = (await readPlan(projectRoot, planId_)).plan;
    const task = fresh.tasks.find((entry) => entry.task_id === taskId);
    if (!task) continue;

    // Resume support: a task already finished in a prior execution is not re-run.
    if (["passed", "skipped"].includes(task.status)) {
      results.push({ task_id: taskId, status: task.status, resumed: true });
      continue;
    }

    // Policy gate (rules + answers + dependencies) BEFORE acting, on FRESH state. A violation blocks the
    // task and halts the plan — answers/rules are a hard precondition, not advisory context.
    const verdict = gate({ plan: fresh, task });
    if (!verdict.ok) {
      await setStatus({ projectRoot, planId: planId_, taskId, status: "blocked", notes: verdict.reason, now });
      results.push({ task_id: taskId, status: "blocked", reason: verdict.reason });
      halted = true;
      break;
    }

    // Crash recovery: a task left "running" with a run_id (the executor died mid-task) RESUMES that run
    // rather than orphaning it and starting a fresh one. A fresh task starts a new run + seeds answers.
    let runId;
    if (task.status === "running" && task.run_id) {
      runId = task.run_id;
    } else {
      await setStatus({ projectRoot, planId: planId_, taskId, status: "running", now });
      const started = await startRun({
        projectRoot,
        workflow: task.workflow,
        params: task.params,
        planId: planId_,
        taskId,
        now,
      });
      runId = started.runId;
      // Seed the run with the answers collected in pre-flight, so the run's steps consume them through the
      // existing user-input context path (no mid-run re-asking of what the plan already settled).
      for (const question of fresh.questions) {
        if (!isAnswered(question)) continue;
        if (question.task_id && question.task_id !== taskId) continue;
        await recordUserInput({
          projectRoot,
          runId,
          text: `Q: ${question.question}\nA: ${question.answer}`,
          source: "plan_preflight",
          now,
        });
      }
      // F1 cadence seed: recorded LAST (after the pre-flight answers) so it survives the last-N user-input
      // window (materializeRunUserInputs keeps only the most recent inputs). It gives the "how often do I
      // check in" decision a home, removing the *reason* the agent improvises a cadence/checkpoint question
      // mid-run. It does NOT pause the executor — the executor still runs the task to completion. The positive
      // half (real gate -> structured blocker) keeps a genuine gate from leaking into the suppression zone.
      await recordUserInput({
        projectRoot,
        runId,
        text:
          `EXECUTION CADENCE (plan-level, do not re-ask): ${plan.execution_cadence}. ` +
          "checkpoint_per_task = pause between tasks; autonomous_to_pr = run to the PR, stop only on a real blocker. " +
          "In both modes do NOT ask about pace/cadence/checkpoints ('want me to continue?', 'keep this rhythm?') — it is already decided. " +
          "If you hit a REAL gate (destructive / secrets / prod / scope / business-rule), STRUCTURE it as a blocker; never end the turn as a prose question.",
        source: "plan_cadence",
        now,
      });
    }

    const execution = await executeRun({ projectRoot, runId, adapter, notify });
    const taskStatus = mapRunStatusToTask(execution?.status);
    await setStatus({
      projectRoot,
      planId: planId_,
      taskId,
      status: taskStatus,
      runId,
      notes: `run ${execution?.status ?? "unknown"}`,
      now,
    });
    results.push({ task_id: taskId, run_id: runId, run_status: execution?.status ?? null, status: taskStatus });

    if (taskStatus !== "passed" && taskStatus !== "skipped") {
      // F4b net (opt-in): an OPTIONAL stop-classifier may auto-continue past a SPURIOUS courtesy stop so a
      // fabricated cadence question does not halt the WHOLE plan. Gated hard: only under autonomous_to_pr
      // cadence (checkpoint_per_task always keeps the human checkpoint), only a `courtesy` floor (Sink A/infra
      // and every real gate are excluded), and only when the flag-gated, fail-STOP classifier affirms continue.
      // The task stays blocked (surfaced for review); dependents are still protected — the next task's policy
      // gate re-reads fresh state and blocks on depends_on.
      const awaiting = execution?.state?.awaiting_user_input ?? null;
      if (taskStatus === "blocked" && plan.execution_cadence === "autonomous_to_pr" && awaiting?.gate_kind === "courtesy") {
        const verdict = await classifyStopFn({
          gateKind: awaiting.gate_kind,
          reason: execution?.state?.blocked_reason ?? "",
          question: awaiting.question ?? "",
          // undefined => classifyStop uses its default deterministic discriminator; a real model callback
          // (stopClassifier) overrides it when wired.
          classifier: stopClassifier ?? undefined,
        });
        results[results.length - 1].stop_classifier = { decision: verdict.decision, reason: verdict.reason };
        if (verdict.decision === "continue") {
          continue;
        }
      }
      halted = true;
      break;
    }
  }

  const finalPlan = (await readPlan(projectRoot, planId_)).plan;
  return { planId: planId_, status: finalPlan.status, halted, tasks: results, plan: finalPlan };
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
