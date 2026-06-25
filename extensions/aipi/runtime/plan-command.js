import path from "node:path";
import { materializeProjectMemory } from "./context-builder.js";
import {
  addBusinessRules,
  closePlan,
  createPlan,
  readActivePlan,
  recordPlanAnswer,
  settlePlan,
  unsettledReasons,
} from "./plan-state.js";

// The pre-flight phase: one discovery pass for a BATCH of tasks BEFORE any run starts. It creates the
// plan (which classifies tasks + puts each on the kanban), investigates the project's business rules ONCE
// over the combined task text (shared context), and returns a discovery report the orchestrator uses to
// draft the minimum clarifying questions. Questions/answers are then settled through the plan gate
// (settlePlan refuses to leave discovery until every question is answered) — so the answers become a hard
// precondition to autonomous execution, not loose context.

export async function preflightPlan({
  projectRoot,
  tasks,
  source = "preflight",
  now = () => new Date(),
  randomBytes = undefined,
  classify = undefined,
  recordKanban = undefined,
  investigate = materializeProjectMemory,
  maxRules = 6,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const createArgs = { projectRoot, tasks, source, now };
  if (randomBytes) createArgs.randomBytes = randomBytes;
  if (classify) createArgs.classify = classify;
  if (recordKanban) createArgs.recordKanban = recordKanban;
  const { planId, plan } = await createPlan(createArgs);

  // Investigate business rules ONCE: query project memory with the combined task text, attach the hits to
  // the plan as shared rules every task can cite.
  const query = plan.tasks.map((task) => task.text).join(" ");
  const memory = await investigate({ root: path.resolve(projectRoot), query, maxRefs: maxRules }).catch(() => ({ refs: [] }));
  const rules = (memory?.refs ?? [])
    .map((ref) => ({ text: oneLine(ref.excerpt ?? ref.text ?? ""), source: ref.line ? `${ref.path}:${ref.line}` : ref.path ?? null }))
    .filter((rule) => rule.text);
  if (rules.length) await addBusinessRules({ projectRoot, planId, rules, now });

  const settled = (await readActivePlan(projectRoot, { includeTerminal: true }))?.plan ?? plan;
  return { planId, plan: settled, discovery: buildDiscoveryReport(settled) };
}

export function buildDiscoveryReport(plan) {
  return {
    plan_id: plan.plan_id,
    status: plan.status,
    tasks: plan.tasks.map((task) => ({ task_id: task.task_id, text: task.text, workflow: task.workflow })),
    business_rules: plan.business_rules.map((rule) => ({ rule_id: rule.rule_id, text: rule.text, source: rule.source })),
    open_questions: plan.questions.filter((q) => !isAnswered(q)).map((q) => ({ question_id: q.question_id, task_id: q.task_id, question: q.question })),
    instruction:
      "Per the Autonomy Law (covered/gap/conflict/mechanics): for each business-visible decision either cite a rule above (covered) or draft ONE focused question (gap/conflict) and add it with addPlanQuestions. Surface questions to the user, record answers, then settle the plan. Pure mechanics need no question.",
  };
}

// ---- command surface (/aipi-plan) ----

export function parsePlanTasks(text) {
  const body = String(text ?? "");
  const lines = body.split(/\r?\n/);
  const tasks = lines
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  // A single non-empty line with no list markers is one task; never split a lone sentence on punctuation.
  if (tasks.length <= 1) {
    const single = body.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    return single ? [single] : [];
  }
  return tasks;
}

export function parsePlanArgs(args = "") {
  const trimmed = String(args ?? "").trim();
  if (!trimmed) return { action: "status" };
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0].toLowerCase();
  const singleWord = tokens.length === 1 && !trimmed.includes("\n");
  if (["status", "settle", "execute", "cancel", "list"].includes(first) && singleWord) {
    return { action: first };
  }
  if (first === "answer") {
    const questionId = tokens[1] ?? null;
    if (!questionId) throw new Error("/aipi-plan answer requires a question id");
    return { action: "answer", questionId, answer: tokens.slice(2).join(" ") };
  }
  if (first === "create") {
    return { action: "create", tasks: parsePlanTasks(trimmed.slice(tokens[0].length)) };
  }
  return { action: "create", tasks: parsePlanTasks(trimmed) };
}

export async function runPlanCommand({
  args = "",
  projectRoot,
  now = () => new Date(),
  randomBytes = undefined,
  recordKanban = undefined,
  investigate = materializeProjectMemory,
  planExecutor = null,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const command = parsePlanArgs(args);

  if (command.action === "status") {
    return { action: "status", active: await readActivePlan(projectRoot) };
  }

  if (command.action === "create") {
    if (!command.tasks.length) throw new Error("/aipi-plan needs at least one task (one per line)");
    const result = await preflightPlan({ projectRoot, tasks: command.tasks, now, randomBytes, recordKanban, investigate });
    return { action: "create", ...result };
  }

  if (command.action === "answer") {
    const { plan, question } = await recordPlanAnswer({ projectRoot, questionId: command.questionId, answer: command.answer, now });
    return { action: "answer", question, remaining: unsettledReasons(plan).length };
  }

  if (command.action === "settle") {
    try {
      const { plan } = await settlePlan({ projectRoot, now });
      return { action: "settle", settled: true, plan };
    } catch (error) {
      if (error.reasons) return { action: "settle", settled: false, reasons: error.reasons };
      throw error;
    }
  }

  if (command.action === "cancel") {
    return { action: "cancel", ...(await closePlan({ projectRoot, status: "cancelled", reason: "cancelled via /aipi-plan", now })) };
  }

  if (command.action === "execute") {
    const active = await readActivePlan(projectRoot, { includeTerminal: true });
    if (!active) throw new Error("No active AIPI plan to execute; create one first");
    if (typeof planExecutor !== "function") {
      throw new Error("Plan execution is not available in this build");
    }
    return { action: "execute", execution: await planExecutor({ projectRoot, planId: active.planId, now }) };
  }

  throw new Error(`Unknown /aipi-plan action: ${command.action}`);
}

export function formatPlanCommandResult(result) {
  if (result.action === "status") {
    if (!result.active) return "AIPI plan: no active plan.";
    const plan = result.active.plan;
    return [
      `AIPI plan active: ${plan.plan_id}`,
      `status=${plan.status}`,
      `tasks=${plan.tasks.length}`,
      `open_questions=${plan.questions.filter((q) => !isAnswered(q)).length}`,
    ].join("\n");
  }
  if (result.action === "create") {
    const lines = [
      `AIPI plan created: ${result.planId} (${result.plan.tasks.length} tasks)`,
      ...result.discovery.tasks.map((task) => `- ${task.task_id} [${task.workflow}] ${task.text}`),
    ];
    if (result.discovery.business_rules.length) {
      lines.push(`business rules found: ${result.discovery.business_rules.length}`);
    }
    lines.push("Next: draft clarifying questions, collect answers, then /aipi-plan settle.");
    return lines.join("\n");
  }
  if (result.action === "answer") {
    return `Answer recorded for ${result.question.question_id}. ${result.remaining} question(s) still open.`;
  }
  if (result.action === "settle") {
    if (result.settled) return `AIPI plan settled: ${result.plan.plan_id}. Ready to execute.`;
    return [`AIPI plan NOT settled — answer the open questions first:`, ...result.reasons.map((r) => `- ${r}`)].join("\n");
  }
  if (result.action === "cancel") {
    return `AIPI plan cancelled: ${result.planId}`;
  }
  if (result.action === "execute") {
    return `AIPI plan execution: ${result.execution?.status ?? "done"}`;
  }
  return "AIPI plan: ok";
}

function isAnswered(question) {
  return typeof question?.answer === "string" && question.answer.trim().length > 0;
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
