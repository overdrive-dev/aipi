import { createAipiSubagentsRunner, extractToolText, modelToPiModelId } from "./pi-subagents.js";

// Supervisor seam: when a workflow BLOCKS and would stop to ask the user "how do you want to proceed?",
// first ask the ORCHESTRATOR MODEL to resolve it from the run context — via ONE bounded, tool-less forked
// worker (the same goal-judge pattern), run synchronously so there is no turn-deadlock. If it confidently
// picks one of the offered options, the run continues WITHOUT bothering the user; otherwise (it chooses
// ESCALATE, is unsure, or the judge is unavailable) it FAILS SAFE to the existing user picker. Never throws.
//
// Fail-safe posture (mirrors goal-judge): no host model -> buildBlockedRunSupervisor returns null and the
// caller uses the user picker; any spawn/timeout/parse failure -> { unavailable:true }; a choice is honored
// ONLY when it matches an offered option verbatim (the supervisor can never invent an action).

const SUPERVISOR_RUN_ID = "aipi-block-supervisor";
export const SUPERVISOR_ATTEMPT_TIMEOUT_MS = 45_000;

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

function buildSupervisorPrompt({ workflow, step, question, reason, options, context }) {
  return [
    "You are the ORCHESTRATOR supervising an AIPI workflow that just BLOCKED and needs a decision to proceed.",
    `Workflow: ${workflow ?? "?"} · blocked step: ${step ?? "?"}`,
    `Why it blocked: ${reason || question || "unknown"}`,
    "",
    "Valid ways to proceed (you must choose EXACTLY one label, copied verbatim, or ESCALATE):",
    ...options.map((option, index) => `  ${index + 1}. ${option}`),
    context ? `\nRun context / prior findings:\n${context}` : "",
    "",
    "Decide FROM THE CONTEXT. Pick an option ONLY when you are confident it is correct and safe — e.g. a",
    "recoverable or mechanical block, or a decision the context already answers. If it genuinely needs a human",
    "(a real product/business call, something destructive, secrets, or a truly ambiguous choice), choose ESCALATE.",
    "",
    'Return ONLY strict JSON, no prose: {"choice":"<one option label verbatim, or ESCALATE>","confident":true|false,"reason":"one short sentence"}',
  ].filter(Boolean).join("\n");
}

function parseSupervisorJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* try the next extraction */
    }
  }
  return null;
}

// null when there is no concrete host model (caller falls back to the user picker). Otherwise returns an async
// supervise({ workflow, step, question, reason, options, context }) => { resolved, choice, reason } |
// { resolved:false, reason } (escalate) | { unavailable:true }.
export function buildBlockedRunSupervisor({
  root = process.cwd(),
  model = null,
  runner = null,
  attemptTimeoutMs = SUPERVISOR_ATTEMPT_TIMEOUT_MS,
} = {}) {
  const modelId = modelToPiModelId(model);
  if (!modelId) return null;
  const spawnRunner = runner ?? createAipiSubagentsRunner({ root });

  return async function superviseBlockedRun({ workflow = null, step = null, question = "", reason = "", options = [], context = "" } = {}) {
    const opts = (Array.isArray(options) ? options : []).map((option) => String(option ?? "").trim()).filter(Boolean);
    if (!opts.length) return { unavailable: true };
    const task = buildSupervisorPrompt({ workflow, step, question, reason, options: opts, context });
    let raw;
    try {
      raw = await spawnRunner.spawn(
        { agent: "aipi-worker", task, async: false, context: "fresh", model: modelId, allow_shell: false, max_tool_calls: 1, id: SUPERVISOR_RUN_ID },
        { signal: timeoutSignal(attemptTimeoutMs) },
      );
    } catch (error) {
      return { unavailable: true, error: String(error?.message ?? error) };
    }
    const parsed = parseSupervisorJson(extractToolText(raw));
    if (!parsed || typeof parsed.choice !== "string") return { unavailable: true };
    const choice = parsed.choice.trim();
    const reasonOut = typeof parsed.reason === "string" ? parsed.reason.trim() : null;
    if (parsed.confident === false || /^escalate$/i.test(choice)) {
      return { resolved: false, reason: reasonOut };
    }
    // Honor a choice ONLY when it matches an offered option verbatim — never let the supervisor invent an action.
    const match = opts.find((option) => option.toLowerCase() === choice.toLowerCase());
    if (!match) return { resolved: false, reason: reasonOut };
    return { resolved: true, choice: match, reason: reasonOut };
  };
}
