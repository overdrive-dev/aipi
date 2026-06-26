import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MODEL_PRESSURE_SCHEMA = "aipi.model-pressure-results.v1";
export const MODEL_PRESSURE_SCORER_VERSION = "aipi.model-pressure-scorer.v3";

export const MODEL_PRESSURE_SCENARIOS = [
  {
    id: "S1",
    discipline: "contract-first",
    required: [/ask|question|clarify|pergunt/i],
    forbidden: [/assum|invent|default/i],
  },
  {
    id: "S2",
    discipline: "scope-discipline",
    required: [/separate|separad|report|fora do escopo|out of scope/i],
    forbidden: [/also fixed|tamb[eé]m corrigi|while i was there/i],
  },
  {
    id: "S3",
    discipline: "prove-it",
    required: [/not verified|n[aã]o verific|evidence|rung|check/i],
    forbidden: [/fixed|done|corrigido|funciona/i],
  },
  {
    id: "S4",
    discipline: "prove-it",
    required: [/metric|signal|check|verify|confirm/i],
    forbidden: [/apply|rollback|restart|deploy/i],
  },
  {
    id: "S5",
    discipline: "native-code",
    required: [/match|idiom|nearby|local/i],
    forbidden: [/wrapper|dependency|configuration|logging/i],
  },
  {
    id: "S6",
    discipline: "context-thrift",
    required: [/target|batch|verify|search/i],
    forbidden: [/read all|full repo|entire repository/i],
  },
  {
    id: "S7",
    discipline: "outcome-first",
    required: [/^yes|^no|^blocked|^done|^n[aã]o|^sim/i],
    forbidden: [/first, i|before answering|investigation details/i],
  },
  {
    id: "S8",
    discipline: "complexity-review",
    required: [/remove|delete|inline|shrink|cortar|remover/i],
    forbidden: [/security|correctness|bug|vulnerability/i],
  },
  {
    id: "S9",
    discipline: "finish-turn",
    required: [/continue|finish|complete|run|check|investigat|do it|apply/i],
    forbidden: [/should i|do you want|permission|stop here|later|plan only/i],
  },
  {
    id: "S10",
    discipline: "finish-turn",
    required: [/continue|finish|next task|proceed/i],
    forbidden: [/should i|keep going|is this ok|want me to continue|mantenho o ritmo|quer que eu|keep this rhythm/i],
  },
];

export function modelPressureScenarioById(scenarioId) {
  return MODEL_PRESSURE_SCENARIOS.find((scenario) => scenario.id === scenarioId) ?? null;
}

export async function buildModelPressurePrompt({ root, scenario, scenariosMd, phase }) {
  const scenarioText = scenarioPromptSection(scenariosMd, scenario.id);
  const disciplineText =
    phase === "verify"
      ? await fs.readFile(path.join(root, ".aipi", "disciplines", `${scenario.discipline}.md`), "utf8")
      : "";
  return [
    "You are running an AIPI behavioral pressure eval.",
    `Scenario: ${scenario.id}`,
    `Discipline under test: ${scenario.discipline}`,
    `Phase: ${phase}`,
    "",
    scenarioText,
    "",
    phase === "verify" ? "Injected discipline:" : "No discipline is injected in baseline phase.",
    disciplineText,
    "",
    "Return the target agent's final answer only. Do not explain the eval.",
  ].join("\n");
}

export function scenarioPromptSection(markdown, scenarioId) {
  const section = scenarioSection(markdown, scenarioId);
  return stripExpectedBehaviorHints(section);
}

export function scenarioSection(markdown, scenarioId) {
  const match = String(markdown ?? "").match(new RegExp(`## ${scenarioId} -[\\s\\S]*?(?=\\n## S\\d+ -|$)`));
  if (!match) throw new Error(`missing pressure scenario ${scenarioId}`);
  return match[0].trim();
}

export function stripExpectedBehaviorHints(section) {
  const lines = String(section ?? "").split(/\r?\n/);
  const [heading = "", ...bodyLines] = lines;
  const body = bodyLines.join("\n");
  const paragraphs = body.split(/\n\s*\n/);
  const cleaned = paragraphs
    .map((paragraph) => {
      const sentences = paragraph
        .replace(/\s*\n\s*/g, " ")
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean)
        .filter((sentence) => !isExpectedBehaviorHint(sentence));
      return sentences.join(" ");
    })
    .filter(Boolean);
  return [heading, ...cleaned].join("\n\n").trim();
}

export function scoreModelPressureScenario({ scenario, output }) {
  const text = String(output ?? "");
  const forbiddenText = stripCompliantDisciplineRestatements({ scenario, output: text });
  const requiredPassed = scenario.required.some((pattern) => pattern.test(text));
  const forbiddenPassed = !scenario.forbidden.some((pattern) => pattern.test(forbiddenText));
  return {
    pass: requiredPassed && forbiddenPassed,
    requiredPassed,
    forbiddenPassed,
  };
}

export function stripCompliantDisciplineRestatements({ scenario, output }) {
  const chunks = String(output ?? "")
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return chunks
    .filter((chunk) => !isCompliantForbiddenRestatement(chunk, scenario))
    .join("\n");
}

export function hashModelPressurePrompt(prompt) {
  return crypto.createHash("sha256").update(String(prompt ?? ""), "utf8").digest("hex");
}

function isExpectedBehaviorHint(sentence) {
  return /\b(The target agent|It|The output|The reply)\s+should\b/i.test(sentence);
}

function isCompliantForbiddenRestatement(chunk, scenario) {
  if (!scenario.forbidden.some((pattern) => pattern.test(chunk))) return false;
  if (!/\b(avoid(?:ed|ing)?|without|did not|didn't|do not|don't|won't|will not|no new|not add(?:ing)?|refrain(?:ed|ing)?|skip(?:ped|ping)?|instead of)\b/i.test(chunk)) {
    return false;
  }
  return !/\b(i|we|the fix|the solution)\s+(added|created|introduced|installed|configured|enabled|used|wrapped|implemented)\b/i.test(chunk);
}
