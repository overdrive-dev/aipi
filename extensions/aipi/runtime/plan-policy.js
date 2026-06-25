// The plan-level policy gate. This is what makes captured answers + business rules a HARD precondition to
// autonomous execution rather than loose context. Two layers:
//   1. assertPlanExecutable(plan) — the before_plan_execution gate. Run ONCE before the executor starts;
//      throws PlanPolicyError unless the plan is settled, every question is answered, and a runnable task
//      remains. Nothing executes against an unsettled or half-answered plan.
//   2. planPolicyGate({ plan, task }) — the per-task gate. The executor consults it before acting on each
//      task and refuses a task whose answers are missing, whose declared dependencies have not passed, or
//      whose declared required rules/answers are unresolved.
// Pure functions, no I/O — trivially testable and reusable (executor, command, a future lifecycle hook).

export class PlanPolicyError extends Error {
  constructor(reasons) {
    super(`plan is not executable: ${reasons.join("; ")}`);
    this.name = "PlanPolicyError";
    this.reasons = reasons;
  }
}

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

  // 4. Explicitly required answers must exist AND be answered (the orchestrator links a task to the
  //    questions that gate it — e.g. a plan-wide policy decision a later task depends on).
  for (const questionId of task.requires_answers ?? []) {
    const question = (plan.questions ?? []).find((q) => q.question_id === questionId);
    if (!question) return { ok: false, reason: `${task.task_id} requires answer ${questionId} which does not exist` };
    if (!isAnswered(question)) return { ok: false, reason: `${task.task_id} requires answer ${questionId} which is unanswered` };
  }

  // 5. Explicitly required business rules must be recorded on the plan (a task that asserts it depends on a
  //    settled rule cannot run until that rule is present — covered choices must cite a real rule).
  for (const ruleId of task.requires_rules ?? []) {
    const rule = (plan.business_rules ?? []).find((r) => r.rule_id === ruleId);
    if (!rule) return { ok: false, reason: `${task.task_id} requires business rule ${ruleId} which is not recorded` };
  }

  return { ok: true };
}

// The before_plan_execution gate. Throws PlanPolicyError if the plan must not start executing.
export function assertPlanExecutable(plan) {
  const reasons = planExecutionBlockers(plan);
  if (reasons.length) throw new PlanPolicyError(reasons);
  return true;
}

// Plan-level blockers preventing execution from STARTING at all.
export function planExecutionBlockers(plan) {
  const reasons = [];
  if (!plan) {
    reasons.push("no plan");
    return reasons;
  }
  // settled = ready; executing = mid-run; blocked = halted on a prior task but RESUMABLE once the blocker is
  // resolved (the per-task gate re-evaluates each blocked task on the next execute). discovery/terminal block.
  if (!["settled", "executing", "blocked"].includes(plan.status)) {
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
