// The plan-level policy gate. This is what makes captured answers + business rules a HARD precondition to
// autonomous execution rather than loose context: the multi-run executor consults it before acting on each
// task and refuses to run a task whose answers are missing, whose dependencies have not passed, or (slice
// 4) whose required business rules are unresolved. Pure functions — no I/O — so they are trivially testable
// and can run anywhere (executor, command, a future before_plan_execution hook).

export function planPolicyGate({ plan, task } = {}) {
  if (!plan || !task) return { ok: false, reason: "missing plan or task" };

  // 1. Every plan-wide question must be answered (defense; settle already enforces this).
  const openPlanWide = (plan.questions ?? []).filter((q) => q.task_id == null && !isAnswered(q));
  if (openPlanWide.length) {
    return { ok: false, reason: `plan-wide question unanswered: ${openPlanWide[0].question}` };
  }

  // 2. Every question scoped to THIS task must be answered before the task may run.
  const openForTask = (plan.questions ?? []).filter((q) => q.task_id === task.task_id && !isAnswered(q));
  if (openForTask.length) {
    return { ok: false, reason: `question for ${task.task_id} unanswered: ${openForTask[0].question}` };
  }

  // 3. Declared cross-task dependencies must have passed/skipped first.
  for (const dep of task.depends_on ?? []) {
    const dependency = (plan.tasks ?? []).find((entry) => entry.task_id === dep);
    if (!dependency) return { ok: false, reason: `unknown dependency ${dep} for ${task.task_id}` };
    if (!["passed", "skipped"].includes(dependency.status)) {
      return { ok: false, reason: `${task.task_id} waits on dependency ${dep} (status=${dependency.status})` };
    }
  }

  return { ok: true };
}

// Plan-level blockers preventing execution from STARTING at all (consumed by the command + a future
// before_plan_execution hook). A settled plan with answers + at least one runnable task is executable.
export function planExecutionBlockers(plan) {
  const reasons = [];
  if (!plan) {
    reasons.push("no plan");
    return reasons;
  }
  if (plan.status !== "settled" && plan.status !== "executing") {
    reasons.push(`plan status is ${plan.status} (must be settled)`);
  }
  for (const question of plan.questions ?? []) {
    if (!isAnswered(question)) reasons.push(`question ${question.question_id} unanswered`);
  }
  const runnable = (plan.tasks ?? []).filter((task) => !["passed", "skipped"].includes(task.status));
  if (!runnable.length) reasons.push("no runnable tasks remain");
  return reasons;
}

function isAnswered(question) {
  return typeof question?.answer === "string" && question.answer.trim().length > 0;
}
