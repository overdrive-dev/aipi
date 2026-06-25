import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { aipiKanbanUpdate } from "./aipi-tools.js";

// The plan layer sits ABOVE the single-run workflow engine. A plan holds SEVERAL tasks, the clarifying
// questions gathered for them in one pre-flight phase, and the business rules investigated once. The
// existing run engine stays single-run; the multi-run executor (see executePlanRun) drives one run per
// task in plan order, recording each task's lifecycle on the SAME kanban surface workers already use
// (.aipi/runtime/kanban.jsonl) so every task is trackable individually.

const TERMINAL_PLAN_STATUSES = new Set(["completed", "cancelled", "abandoned"]);

// Per-workflow free-text param that carries a task's text (mirrors lifecycle-hooks.WORKFLOW_PRIMARY_PARAM).
// Kept local so the plan layer does not import the lifecycle hooks (which would later be a require cycle
// once the input router imports the plan layer). feature is contract-driven and takes no free-text param.
const WORKFLOW_PRIMARY_PARAM = Object.freeze({
  bugfix: "bug",
  ops: "objective",
  planning: "request",
  quick: "request",
  research: "topic",
});

// Map a plan task's lifecycle status to a kanban status, so the board reads in domain terms.
const TASK_TO_KANBAN_STATUS = Object.freeze({
  pending: "planned",
  running: "in_progress",
  passed: "done",
  skipped: "skipped",
  blocked: "blocked",
  failed: "failed",
});

// A deliberately small, dependency-free task classifier. The pre-flight phase may pass an explicit
// workflow per task; when it does not, this picks a sensible workflow from keywords. It is intentionally
// simpler than classifyAipiCodePipeline (which also decides routing/skip semantics) — here we only need a
// workflow name + its primary param. Defaults to planning (the safe, contract-producing path).
export function classifyPlanTask(text) {
  const normalized = String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  if (/\b(deploy|deployment|release|prod|producao|homolog|homologacao|migration|migracao|rollback|infra|pipeline|ci|cd)\b/.test(normalized)) {
    return { workflow: "ops", param: WORKFLOW_PRIMARY_PARAM.ops };
  }
  if (/\b(bug|bugfix|erro|falha|quebrou|quebra|regressao|defeito|consertar|conserta|corrigir|corrige|corrija|fix)\b/.test(normalized)) {
    return { workflow: "bugfix", param: WORKFLOW_PRIMARY_PARAM.bugfix };
  }
  if (/\b(pesquisar|pesquisa|investigar|investiga|research|analisar|analise|comparar|comparacao|avaliar|avaliacao|estudar)\b/.test(normalized)) {
    return { workflow: "research", param: WORKFLOW_PRIMARY_PARAM.research };
  }
  return { workflow: "planning", param: WORKFLOW_PRIMARY_PARAM.planning };
}

export async function createPlan({
  projectRoot,
  tasks = [],
  source = "preflight",
  now = () => new Date(),
  randomBytes = (size) => crypto.randomBytes(size),
  classify = classifyPlanTask,
  recordKanban = aipiKanbanUpdate,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const normalizedTasks = normalizeTaskInputs(tasks, classify);
  if (!normalizedTasks.length) throw new Error("createPlan requires at least one task");

  const root = path.resolve(projectRoot);
  await assertAipiInstalled(root);

  const createdAt = now().toISOString();
  const planId = generatePlanId(now, randomBytes);
  const planRelDir = path.posix.join(".aipi", "runtime", "plans", planId);
  const planDir = path.join(root, ".aipi", "runtime", "plans", planId);

  const plan = {
    schema: "aipi.plan.v1",
    plan_id: planId,
    status: "discovery",
    source,
    created_at: createdAt,
    plan_rel_dir: planRelDir,
    tasks: normalizedTasks.map((task, index) => ({
      task_id: `t${index + 1}`,
      text: task.text,
      workflow: task.workflow,
      params: task.params,
      kanban_task: task.kanban_task,
      depends_on: task.depends_on,
      requires_rules: task.requires_rules,
      requires_answers: task.requires_answers,
      status: "pending",
      run_id: null,
      notes: null,
    })),
    questions: [],
    business_rules: [],
    current_task: null,
    settled_at: null,
  };

  await fs.mkdir(planDir, { recursive: true });
  await persistPlan(root, plan);
  await fs.writeFile(path.join(root, ".aipi", "runtime", "plans", "active"), `${planId}\n`);

  // Register EACH task on the kanban individually (status "planned"), so the board tracks them one by one
  // from the moment the plan is created — before any run starts.
  for (const task of plan.tasks) {
    await recordKanban({
      projectRoot: root,
      task: task.kanban_task,
      status: TASK_TO_KANBAN_STATUS.pending,
      run_id: null,
      notes: `plan ${planId} ${task.task_id} (${task.workflow})`,
      now,
    });
  }

  return { planId, plan };
}

export async function readActivePlan(projectRoot, { includeTerminal = false } = {}) {
  const root = path.resolve(projectRoot);
  const activePath = path.join(root, ".aipi", "runtime", "plans", "active");
  const planId = (await fs.readFile(activePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).trim();
  if (!planId) return null;

  const plan = await readPlanState(root, planId).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!plan) {
    await clearActivePlan(root, planId);
    return null;
  }
  if (!includeTerminal && isTerminalPlanStatus(plan.status)) {
    await clearActivePlan(root, planId);
    return null;
  }
  return { planId, plan };
}

export async function readPlan(projectRoot, planId) {
  const root = path.resolve(projectRoot);
  const plan = await readPlanState(root, planId);
  return { planId, plan };
}

export async function addPlanQuestions({ projectRoot, planId = null, questions = [], now = () => new Date() } = {}) {
  const { root, plan } = await loadPlanForMutation(projectRoot, planId);
  // Questions are a DISCOVERY-phase artifact. Adding one after settle would silently un-settle the plan
  // (settle requires every question answered), so the phase boundary is enforced here.
  if (plan.status !== "discovery") {
    throw new Error(`addPlanQuestions is discovery-phase only; plan ${plan.plan_id} status is ${plan.status}`);
  }
  const createdAt = now().toISOString();
  const existing = plan.questions.length;
  const added = [];
  for (const [index, raw] of questions.entries()) {
    const question = String(raw?.question ?? "").trim();
    if (!question) throw new Error("addPlanQuestions: each question requires non-empty question text");
    const taskId = raw?.task_id ?? null;
    if (taskId && !plan.tasks.some((task) => task.task_id === taskId)) {
      throw new Error(`addPlanQuestions: unknown task_id ${taskId}`);
    }
    const entry = {
      question_id: `q${existing + index + 1}`,
      task_id: taskId,
      question,
      options: Array.isArray(raw?.options) ? raw.options.map((opt) => String(opt)) : [],
      allow_free_text: raw?.allow_free_text !== false,
      answer: null,
      answered_at: null,
      source: raw?.source ?? "preflight",
      created_at: createdAt,
    };
    plan.questions.push(entry);
    added.push(entry);
  }
  await persistPlan(root, plan);
  return { plan, added };
}

export async function recordPlanAnswer({ projectRoot, planId = null, questionId, answer, now = () => new Date() } = {}) {
  if (!questionId) throw new Error("recordPlanAnswer requires questionId");
  const { root, plan } = await loadPlanForMutation(projectRoot, planId);
  // Answers are collected in DISCOVERY; once settled the definition is closed (changing an answer would
  // mutate a settled spec the executor already trusts). Re-opening requires an explicit new discovery.
  if (plan.status !== "discovery") {
    throw new Error(`recordPlanAnswer is discovery-phase only; plan ${plan.plan_id} status is ${plan.status}`);
  }
  const question = plan.questions.find((entry) => entry.question_id === questionId);
  if (!question) throw new Error(`recordPlanAnswer: unknown question_id ${questionId}`);
  question.answer = String(answer ?? "");
  question.answered_at = now().toISOString();
  await persistPlan(root, plan);
  return { plan, question };
}

export async function addBusinessRules({ projectRoot, planId = null, rules = [], now = () => new Date() } = {}) {
  const { root, plan } = await loadPlanForMutation(projectRoot, planId);
  const createdAt = now().toISOString();
  const existing = plan.business_rules.length;
  for (const [index, raw] of rules.entries()) {
    const text = String(raw?.text ?? raw ?? "").trim();
    if (!text) continue;
    plan.business_rules.push({
      rule_id: `r${existing + index + 1}`,
      text,
      source: raw?.source ?? null,
      recorded_at: createdAt,
    });
  }
  await persistPlan(root, plan);
  return { plan };
}

// Pure: the reasons a plan cannot be settled yet. The settlement gate (and the execution gate) key on
// this — answers are not "context", they are a hard precondition to leaving discovery.
export function unsettledReasons(plan) {
  const reasons = [];
  if (!plan?.tasks?.length) reasons.push("plan has no tasks");
  const unanswered = (plan?.questions ?? []).filter((q) => !isAnswered(q));
  for (const q of unanswered) {
    reasons.push(`question ${q.question_id} is unanswered: ${q.question}`);
  }
  return reasons;
}

export async function settlePlan({ projectRoot, planId = null, now = () => new Date() } = {}) {
  const { root, plan } = await loadPlanForMutation(projectRoot, planId);
  const reasons = unsettledReasons(plan);
  if (reasons.length) {
    const error = new Error(`plan not settleable: ${reasons.join("; ")}`);
    error.reasons = reasons;
    throw error;
  }
  plan.status = "settled";
  plan.settled_at = now().toISOString();
  await persistPlan(root, plan);
  return { plan };
}

export async function setTaskStatus({
  projectRoot,
  planId = null,
  taskId,
  status,
  runId = undefined,
  notes = null,
  now = () => new Date(),
  recordKanban = aipiKanbanUpdate,
} = {}) {
  if (!taskId) throw new Error("setTaskStatus requires taskId");
  const kanbanStatus = TASK_TO_KANBAN_STATUS[status];
  if (!kanbanStatus) throw new Error(`setTaskStatus: unsupported status ${status}`);
  const { root, plan } = await loadPlanForMutation(projectRoot, planId);
  const task = plan.tasks.find((entry) => entry.task_id === taskId);
  if (!task) throw new Error(`setTaskStatus: unknown task_id ${taskId}`);

  task.status = status;
  if (runId !== undefined) task.run_id = runId;
  if (notes != null) task.notes = notes;
  plan.current_task = status === "running" ? taskId : plan.current_task === taskId && isTerminalTaskStatus(status) ? null : plan.current_task;
  plan.status = rollupPlanStatus(plan);
  await persistPlan(root, plan);

  // Record this task's transition on the kanban INDIVIDUALLY (one event per task per transition).
  await recordKanban({
    projectRoot: root,
    task: task.kanban_task,
    status: kanbanStatus,
    run_id: task.run_id ?? null,
    notes: notes ?? `plan ${plan.plan_id} ${taskId} -> ${status}`,
    now,
  });

  return { plan, task };
}

export async function clearActivePlan(projectRoot, planId = null) {
  const root = path.resolve(projectRoot);
  const activePath = path.join(root, ".aipi", "runtime", "plans", "active");
  if (planId) {
    const activePlanId = (await fs.readFile(activePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })).trim();
    if (activePlanId && activePlanId !== planId) {
      return { cleared: false, active_plan_id: activePlanId, reason: "different_active_plan" };
    }
  }
  await fs.rm(activePath, { force: true });
  return { cleared: true, active_plan_id: planId ?? null };
}

export async function closePlan({ projectRoot, planId = null, status = "cancelled", reason = "", now = () => new Date() } = {}) {
  const terminal = normalizeCloseStatus(status);
  const { root, plan } = await loadPlanForMutation(projectRoot, planId);
  plan.status = terminal;
  plan.closed_at = now().toISOString();
  plan.close_reason = reason || null;
  await persistPlan(root, plan);
  await clearActivePlan(root, plan.plan_id);
  return { planId: plan.plan_id, status: terminal, plan };
}

export async function persistPlan(root, plan) {
  const planDir = path.join(root, ".aipi", "runtime", "plans", plan.plan_id);
  await fs.mkdir(planDir, { recursive: true });
  await fs.writeFile(path.join(planDir, "PLAN.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await fs.writeFile(path.join(planDir, "PLAN.md"), renderPlanManifest(plan));
}

// ---- internals ----

function normalizeTaskInputs(tasks, classify) {
  const list = Array.isArray(tasks) ? tasks : [tasks];
  return list
    .map((raw) => {
      const text = String((typeof raw === "string" ? raw : raw?.text) ?? "").trim();
      if (!text) return null;
      const explicitWorkflow = typeof raw === "object" ? raw?.workflow ?? null : null;
      const classified = explicitWorkflow
        ? { workflow: explicitWorkflow, param: WORKFLOW_PRIMARY_PARAM[explicitWorkflow] ?? null }
        : classify(text);
      const param = classified.param ?? WORKFLOW_PRIMARY_PARAM[classified.workflow] ?? null;
      const params = {
        ...(typeof raw === "object" && raw?.params ? raw.params : {}),
        ...(param ? { [param]: text } : {}),
      };
      const dependsOn = typeof raw === "object" && Array.isArray(raw?.depends_on) ? raw.depends_on : [];
      const requiresRules = typeof raw === "object" && Array.isArray(raw?.requires_rules) ? raw.requires_rules : [];
      const requiresAnswers = typeof raw === "object" && Array.isArray(raw?.requires_answers) ? raw.requires_answers : [];
      return {
        text,
        workflow: classified.workflow,
        params,
        kanban_task: kanbanTaskLabel(text),
        depends_on: dependsOn,
        requires_rules: requiresRules,
        requires_answers: requiresAnswers,
      };
    })
    .filter(Boolean);
}

function kanbanTaskLabel(text) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}

// Derive plan status PURELY from task states so a recovered task clears a stale "blocked" (a task that
// went blocked -> running -> passed must not leave the plan stuck at "blocked").
function rollupPlanStatus(plan) {
  if (isTerminalPlanStatus(plan.status)) return plan.status;
  const tasks = plan.tasks ?? [];
  if (!tasks.length) return plan.status;
  if (tasks.some((task) => task.status === "blocked" || task.status === "failed")) return "blocked";
  if (tasks.every((task) => task.status === "passed" || task.status === "skipped")) return "completed";
  // Some task has started (running, or already passed/skipped with others pending) -> in flight.
  if (tasks.some((task) => ["running", "passed", "skipped"].includes(task.status))) return "executing";
  // All tasks still pending: ready to run (covers recovery from a prior "blocked").
  return plan.status === "discovery" ? "discovery" : "settled";
}

async function loadPlanForMutation(projectRoot, planId) {
  const root = path.resolve(projectRoot);
  const plan = planId
    ? await readPlanState(root, planId)
    : (await readActivePlan(root, { includeTerminal: true }))?.plan;
  if (!plan) throw new Error("No active AIPI plan; create a plan first");
  return { root, plan };
}

async function readPlanState(root, planId) {
  const planPath = path.join(root, ".aipi", "runtime", "plans", planId, "PLAN.json");
  return JSON.parse(await fs.readFile(planPath, "utf8"));
}

function isAnswered(question) {
  return typeof question?.answer === "string" && question.answer.trim().length > 0;
}

function isTerminalPlanStatus(status) {
  return TERMINAL_PLAN_STATUSES.has(String(status ?? "").toLowerCase());
}

function isTerminalTaskStatus(status) {
  return ["passed", "skipped", "blocked", "failed"].includes(String(status ?? "").toLowerCase());
}

function normalizeCloseStatus(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (normalized === "abandoned") return "abandoned";
  if (normalized === "completed") return "completed";
  throw new Error(`Unsupported AIPI plan close status: ${status}`);
}

async function assertAipiInstalled(projectRoot) {
  const contractPath = path.join(projectRoot, ".aipi", "runtime-contract.json");
  try {
    await fs.access(contractPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("AIPI is not installed in this project; run /aipi-init first");
    }
    throw error;
  }
}

function generatePlanId(now, randomBytes) {
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `plan-${stamp}-${randomBytes(3).toString("hex")}`;
}

function renderPlanManifest(plan) {
  const taskLines = plan.tasks
    .map((task) => `- ${task.task_id} [${task.status}] (${task.workflow}) ${task.kanban_task}${task.run_id ? ` run=${task.run_id}` : ""}`)
    .join("\n");
  const questionLines = plan.questions.length
    ? plan.questions
        .map((q) => `- ${q.question_id}${q.task_id ? ` (${q.task_id})` : ""}: ${q.question} -> ${isAnswered(q) ? q.answer : "UNANSWERED"}`)
        .join("\n")
    : "- none";
  const ruleLines = plan.business_rules.length
    ? plan.business_rules.map((r) => `- ${r.rule_id}: ${r.text}${r.source ? ` (${r.source})` : ""}`).join("\n")
    : "- none";
  return `---
schema: aipi.plan-manifest.v1
plan_id: ${plan.plan_id}
status: ${plan.status}
created_at: ${plan.created_at}
settled_at: ${plan.settled_at ?? ""}
---

# AIPI Plan ${plan.plan_id}

- status: ${plan.status}
- tasks: ${plan.tasks.length}
- current_task: ${plan.current_task ?? "none"}

## Tasks

${taskLines}

## Questions

${questionLines}

## Business rules

${ruleLines}
`;
}
