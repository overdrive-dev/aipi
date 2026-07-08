import { readActivePlan } from "./plan-state.js";
import {
  abandonGoal,
  achieveGoal,
  linkGoalPlan,
  proposeGoal,
  readActiveGoal,
  readGoal,
  recordCriterionMet,
  unmetRequiredCriteria,
} from "./goal-state.js";

// Command surface for /aipi-goal — the top-level, measurable objective. The whole point is the acceptance
// gate: `set` only ACCEPTS a goal that carries a clear objective + checkable criteria + a measurable
// done_when; otherwise it prints exactly why and keeps nothing.

// Labels (accent-stripped, snake-cased) that switch the section a spec line belongs to. Both pt-BR and English.
const SPEC_LABELS = {
  objective: "objective",
  objetivo: "objective",
  goal: "objective",
  meta: "objective",
  alvo: "objective",
  criteria: "criteria",
  criterios: "criteria",
  criterio: "criteria",
  criterion: "criteria",
  acceptance: "criteria",
  acceptance_criteria: "criteria",
  aceitacao: "criteria",
  criterios_de_aceitacao: "criteria",
  done_when: "done_when",
  done: "done_when",
  donewhen: "done_when",
  fim: "done_when",
  pronto_quando: "done_when",
  concluido_quando: "done_when",
  feito_quando: "done_when",
  dod: "done_when",
  definition_of_done: "done_when",
};

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

// Parse a free-text goal spec into { objective, criteria: string[], done_when }. Recognizes labeled sections
// (objective:/criteria:/done_when: and pt-BR aliases); list items under `criteria:` become individual
// criteria; unlabeled leading text is the objective.
export function parseGoalSpec(text) {
  const spec = { objective: "", criteria: [], done_when: "" };
  let section = "objective";
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const isBullet = LIST_MARKER.test(rawLine);
    if (!isBullet) {
      const label = detectLabel(rawLine);
      if (label) {
        section = label.section;
        if (label.rest) addSpecContent(spec, section, label.rest);
        continue;
      }
    }
    const content = rawLine.replace(LIST_MARKER, "").trim();
    if (content) addSpecContent(spec, section, content);
  }
  spec.objective = spec.objective.trim();
  spec.done_when = spec.done_when.trim();
  return spec;
}

export function parseGoalArgs(args = "") {
  const trimmed = String(args ?? "").trim();
  if (!trimmed) return { action: "status" };
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0].toLowerCase();
  const singleWord = tokens.length === 1 && !trimmed.includes("\n");

  if (["status", "achieve"].includes(first) && singleWord) return { action: first };
  if (["cancel", "abandon"].includes(first) && singleWord) return { action: "abandon" };

  if (first === "show") {
    const goalId = tokens[1] ?? null;
    return goalId ? { action: "show", goalId } : { action: "status" };
  }

  if (first === "plan") {
    return { action: "plan", planId: tokens[1] ?? null };
  }

  if (first === "criterion") {
    const criterionId = tokens[1] ?? null;
    const verb = (tokens[2] ?? "").toLowerCase();
    if (!criterionId || verb !== "met") {
      throw new Error("/aipi-goal criterion expects: criterion <id> met <evidence>");
    }
    return { action: "criterion_met", criterionId, evidence: tokens.slice(3).join(" ") };
  }

  if (["set", "create", "propose", "new"].includes(first)) {
    return { action: "set", spec: parseGoalSpec(trimmed.slice(tokens[0].length)) };
  }

  // Bare spec (no leading verb): treat the whole input as a goal definition.
  return { action: "set", spec: parseGoalSpec(trimmed) };
}

export async function runGoalCommand({
  args = "",
  projectRoot,
  now = () => new Date(),
  randomBytes = undefined,
  judge = null,
  timeoutMs = undefined,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const command = parseGoalArgs(args);

  if (command.action === "status") {
    return { action: "status", active: await readActiveGoal(projectRoot) };
  }

  if (command.action === "show") {
    const { goal } = await readGoal(projectRoot, command.goalId);
    return { action: "show", goal };
  }

  if (command.action === "set") {
    const proposeArgs = {
      projectRoot,
      objective: command.spec.objective,
      criteria: command.spec.criteria,
      done_when: command.spec.done_when,
      now,
      judge,
    };
    if (randomBytes) proposeArgs.randomBytes = randomBytes;
    if (timeoutMs !== undefined) proposeArgs.timeoutMs = timeoutMs;
    const result = await proposeGoal(proposeArgs);
    return { action: "set", ...result };
  }

  if (command.action === "criterion_met") {
    const { goal, criterion } = await recordCriterionMet({
      projectRoot,
      criterionId: command.criterionId,
      evidence: command.evidence,
      now,
    });
    const met = goal.criteria.filter((c) => c.status === "met").length;
    return { action: "criterion_met", criterion, met, total: goal.criteria.length };
  }

  if (command.action === "achieve") {
    try {
      const { goal } = await achieveGoal({ projectRoot, now });
      return { action: "achieve", achieved: true, goal };
    } catch (error) {
      if (error.unmet) return { action: "achieve", achieved: false, unmet: error.unmet };
      throw error;
    }
  }

  if (command.action === "plan") {
    let planId = command.planId;
    if (!planId) {
      const activePlan = await readActivePlan(projectRoot);
      if (!activePlan) {
        return { action: "plan", linked: false };
      }
      planId = activePlan.planId;
    }
    const { goal } = await linkGoalPlan({ projectRoot, planId, now });
    return { action: "plan", linked: true, planId, goalId: goal.goal_id };
  }

  if (command.action === "abandon") {
    return { action: "abandon", ...(await abandonGoal({ projectRoot, reason: "abandoned via /aipi-goal", now })) };
  }

  throw new Error(`Unknown /aipi-goal action: ${command.action}`);
}

export function formatGoalCommandResult(result) {
  if (result.action === "status") {
    if (!result.active) return "AIPI goal: no active goal. Set one with /aipi-goal set (objective + criteria + done_when).";
    return formatGoalSummary(result.active.goal);
  }

  if (result.action === "show") {
    return formatGoalSummary(result.goal);
  }

  if (result.action === "set") {
    if (result.accepted) {
      const goal = result.goal;
      const lines = [
        `AIPI goal ACCEPTED: ${goal.goal_id}`,
        `objective: ${goal.objective}`,
        "criteria:",
        ...goal.criteria.map((c) => `  - ${c.criterion_id} ${c.text}`),
        `done_when: ${goal.done_when}`,
        "Next: /aipi-goal plan to bind a plan, then mark criteria met (/aipi-goal criterion <id> met <evidence>).",
      ];
      if (goal.acceptance?.measurability?.judge === "deterministic_fallback") {
        lines.push("(note: the LLM judge was unavailable — the deterministic vagueness floor decided.)");
      }
      return lines.join("\n");
    }
    const lines = [
      `AIPI goal NOT accepted (${result.phase} gate) — fix and resubmit:`,
      ...result.reasons.map((r) => `- ${r}`),
      result.phase === "measurability"
        ? "A measurable criterion names something you can CHECK (a behavior, a test, a value), not an open-ended 'make it better'."
        : "A goal needs an objective, at least one acceptance criterion, and a done_when.",
    ];
    if (result.judge === "deterministic_fallback") {
      lines.push("(note: the LLM judge was unavailable — the deterministic vagueness floor decided.)");
    }
    return lines.join("\n");
  }

  if (result.action === "criterion_met") {
    return `Criterion ${result.criterion.criterion_id} marked met. ${result.met}/${result.total} criteria met.`;
  }

  if (result.action === "achieve") {
    if (result.achieved) return `AIPI goal ACHIEVED: ${result.goal.goal_id} 🎯 (verify == ship)`;
    return [
      "AIPI goal NOT achievable — required criteria still unmet:",
      ...result.unmet.map((c) => `- ${c.criterion_id} ${c.text}`),
      "Mark each met with evidence: /aipi-goal criterion <id> met <evidence>.",
    ].join("\n");
  }

  if (result.action === "plan") {
    if (!result.linked) return "No active AIPI plan to bind. Create one with /aipi-plan, then /aipi-goal plan.";
    return `AIPI goal ${result.goalId} bound to plan ${result.planId}. The plan is now the goal's task breakdown.`;
  }

  if (result.action === "abandon") {
    return `AIPI goal abandoned: ${result.goalId}`;
  }

  return "AIPI goal: ok";
}

// ---- internals ----

function formatGoalSummary(goal) {
  const met = goal.criteria.filter((c) => c.status === "met").length;
  const unmet = unmetRequiredCriteria(goal);
  const lines = [
    `AIPI goal ${goal.goal_id} [${goal.status}]`,
    `objective: ${goal.objective}`,
    `done_when: ${goal.done_when}`,
    `criteria: ${met}/${goal.criteria.length} met`,
    ...goal.criteria.map((c) => `  - ${c.criterion_id} [${c.status}] ${c.text}${c.evidence ? ` (evidence: ${c.evidence})` : ""}`),
  ];
  if (goal.plan_id) lines.push(`plan: ${goal.plan_id}`);
  if (goal.status !== "achieved" && goal.status !== "abandoned") {
    lines.push(unmet.length ? `remaining: ${unmet.length} required criterion/criteria to meet before /aipi-goal achieve.` : "all required criteria met — run /aipi-goal achieve.");
  }
  return lines.join("\n");
}

function detectLabel(line) {
  const match = line.trim().match(/^([\p{L}][\p{L}_ -]*?)\s*:\s*([\s\S]*)$/u);
  if (!match) return null;
  const key = match[1]
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const section = SPEC_LABELS[key];
  return section ? { section, rest: match[2].trim() } : null;
}

function addSpecContent(spec, section, content) {
  if (section === "criteria") {
    spec.criteria.push(content);
    return;
  }
  spec[section] = spec[section] ? `${spec[section]} ${content}` : content;
}
