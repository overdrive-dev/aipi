import path from "node:path";
import { materializeProjectMemory } from "./context-builder.js";
import { executePlanRun } from "./plan-executor.js";
import {
  addBusinessRules,
  closePlan,
  createPlan,
  readActivePlan,
  recordPlanAnswer,
  setPlanCadence,
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
    execution_cadence: plan.execution_cadence,
    instruction:
      "Per the Autonomy Law (covered/gap/conflict/mechanics): for each business-visible decision either cite a rule above (covered) or draft ONE focused question (gap/conflict) and add it with addPlanQuestions. Surface questions to the user, record answers, then settle the plan. Pure mechanics need no question. Cadence defaults to checkpoint_per_task (a human checkpoint between tasks); use /aipi-plan cadence autonomous to run to the PR (the stop-classifier then auto-continues spurious courtesy stops).",
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
  if (first === "cadence") {
    // bare `cadence` = read-only query (NOT in the singleWord action allow-list, so it doesn't collide).
    const value = (tokens[1] ?? "").toLowerCase();
    if (!value) return { action: "cadence", set: false };
    const map = {
      checkpoint: "checkpoint_per_task",
      checkpoint_per_task: "checkpoint_per_task",
      autonomous: "autonomous_to_pr",
      autonomous_to_pr: "autonomous_to_pr",
    };
    const cadence = map[value];
    if (!cadence) throw new Error("/aipi-plan cadence expects: checkpoint | autonomous");
    return { action: "cadence", set: true, cadence };
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
  planExecutor = executePlanRun,
  adapter = undefined,
  notify = null,
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

  if (command.action === "cadence") {
    if (!command.set) {
      const active = await readActivePlan(projectRoot, { includeTerminal: true });
      if (!active) throw new Error("No active AIPI plan; create one first");
      return { action: "cadence", set: false, cadence: active.plan.execution_cadence, planId: active.planId };
    }
    const { plan } = await setPlanCadence({ projectRoot, cadence: command.cadence, now });
    return { action: "cadence", set: true, cadence: plan.execution_cadence, planId: plan.plan_id };
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
    return { action: "execute", execution: await planExecutor({ projectRoot, planId: active.planId, now, adapter, notify }) };
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
  if (result.action === "cadence") {
    if (!result.set) {
      return `AIPI plan cadence: ${result.cadence} (${result.planId}). Change with /aipi-plan cadence checkpoint|autonomous.`;
    }
    const note = result.cadence === "autonomous_to_pr"
      ? "runs to the PR, stops only on a real blocker; the stop-classifier auto-continues spurious courtesy stops"
      : "pauses between tasks for a human checkpoint";
    return `AIPI plan cadence set to ${result.cadence} (${result.planId}) — ${note}.`;
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

// ---- natural-language binding (model-callable tools) ----

// Mirror of registerGoalTools: give the orchestrator model tools so a natural-language "monta um plano pra X"
// routes to the plan layer WITHOUT the user typing /aipi-plan. aipi_start_plan drafts the plan through the
// same pre-flight path (classify tasks + investigate business rules once) and returns the open discovery
// questions; the answer/settle tools let the model drive the discovery->settle gate from NL. The gate is
// unchanged: settlePlan still refuses to leave discovery until every question is answered.
export function registerPlanTools(pi, { projectRootResolver = () => process.cwd() } = {}) {
  pi.registerTool({
    name: "aipi_start_plan",
    description:
      "Draft an AIPI execution plan from a natural-language request to plan work. Use this instead of asking the user to type /aipi-plan. It classifies each task, investigates the project's business rules once, and returns the plan plus the open clarifying questions that must be settled before autonomous execution.",
    promptSnippet: "aipi_start_plan - draft an AIPI plan (tasks + discovery questions) from a natural-language planning request.",
    promptGuidelines: [
      "When the user asks you to build or draft a plan for some work (e.g. 'monta um plano pra X', 'planeje a migracao', 'faz um plano de refatoracao'), call aipi_start_plan with the concrete tasks instead of only outlining the plan in prose.",
      "After aipi_start_plan returns open_questions, surface each to the user with aipi_ask (the native selector — do NOT list the options as prose), record answers with aipi_answer_plan_question, then call aipi_settle_plan before execution — do not skip the discovery gate.",
    ],
    parameters: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "The tasks to plan — one concrete unit of work per item.",
        },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const projectRoot = projectRootResolver(ctx);
        const tasks = Array.isArray(params?.tasks)
          ? params.tasks.map((task) => String(task ?? "").trim()).filter(Boolean)
          : params?.tasks != null
            ? [String(params.tasks).trim()].filter(Boolean)
            : [];
        if (!tasks.length) return toolJson({ ok: false, error: "aipi_start_plan needs at least one task" });
        const result = await preflightPlan({ projectRoot, tasks, source: "tool" });
        return toolJson({ ok: true, action: "create", plan_id: result.planId, discovery: result.discovery });
      } catch (error) {
        return toolJson({ ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  pi.registerTool({
    name: "aipi_plan_status",
    description: "Show the active AIPI plan: id, status, tasks, business rules, and the still-open discovery questions.",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const active = await readActivePlan(projectRootResolver(ctx));
        return toolJson(active ? buildDiscoveryReport(active.plan) : { active: null });
      } catch (error) {
        return toolJson({ ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  pi.registerTool({
    name: "aipi_answer_plan_question",
    description:
      "Record the user's answer to one open discovery question on the active AIPI plan. Every question must be answered before the plan can settle.",
    parameters: {
      type: "object",
      required: ["question_id", "answer"],
      properties: {
        question_id: { type: "string", description: "The question id, e.g. q1." },
        answer: { type: "string", description: "The user's answer to that question." },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const { plan, question } = await recordPlanAnswer({
          projectRoot: projectRootResolver(ctx),
          questionId: params?.question_id,
          answer: params?.answer,
        });
        return toolJson({ ok: true, question, remaining: unsettledReasons(plan).length });
      } catch (error) {
        return toolJson({ ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  pi.registerTool({
    name: "aipi_settle_plan",
    description:
      "Settle the active AIPI plan, locking it for execution. Succeeds only when every discovery question is answered; otherwise returns the unsettled reasons so you can resolve them first.",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const { plan } = await settlePlan({ projectRoot: projectRootResolver(ctx) });
        return toolJson({ ok: true, settled: true, plan_id: plan.plan_id });
      } catch (error) {
        if (error.reasons) return toolJson({ ok: true, settled: false, reasons: error.reasons });
        return toolJson({ ok: false, error: String(error?.message ?? error) });
      }
    },
  });
}

// ---- internals ----

function toolJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function isAnswered(question) {
  return typeof question?.answer === "string" && question.answer.trim().length > 0;
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
