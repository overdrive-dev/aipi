import { createAipiSubagentsRunner, extractToolText, modelToPiModelId } from "./pi-subagents.js";

// Live LLM measurability judge for /aipi-goal. It runs ONE bounded, tool-less forked Pi worker (the same
// pi_subagents runtime used by /aipi-pi-subagents-spike and the coordinator) and asks it to classify each
// acceptance target as measurable|vague, returning strict JSON. It deliberately does NOT go through the
// subagent coordinator's evidence gate — this is a pure classification, not a code step, so it wants the raw
// model verdict, not a gated step-result.
//
// Degradation posture (matches the seam contract in goal-state.judgeGoalMeasurability):
// - No host model available => buildModelMeasurabilityJudge returns null; the caller uses the deterministic
//   floor (a goal can always be created).
// - The judge process fails (spawn error / timeout / unparseable output) => the judge returns
//   { unavailable: true }, and judgeGoalMeasurability falls back to the deterministic floor rather than
//   blocking creation on infra noise.
// - The model returns verdicts => they are applied FAIL-CLOSED: any target it does not explicitly affirm as
//   `measurable` rejects the goal (the vagueness gate the user asked for).

const JUDGE_RUN_ID = "goal-measurability-judge";
const DEFAULT_TIMEOUT_MS = 45_000;

export function buildModelMeasurabilityJudge({ root = process.cwd(), model = null, runner = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const modelId = modelToPiModelId(model);
  if (!modelId) return null; // no concrete host model -> caller uses the deterministic floor
  const spawnRunner = runner ?? createAipiSubagentsRunner({ root });

  return async function modelMeasurabilityJudge({ objective = "", criteria = [] } = {}) {
    const targets = (Array.isArray(criteria) ? criteria : []).filter((t) => t && t.target);
    if (!targets.length) return { unavailable: true, error: "no targets to judge" };

    let raw;
    try {
      raw = await spawnRunner.spawn(
        {
          agent: "aipi-worker",
          task: buildJudgePrompt({ objective, targets }),
          async: false,
          context: "fresh",
          model: modelId,
          allow_shell: false,
          max_tool_calls: 1,
          id: JUDGE_RUN_ID,
        },
        { signal: timeoutSignal(timeoutMs) },
      );
    } catch (error) {
      return { unavailable: true, error: String(error?.message ?? error) };
    }

    const parsed = parseJudgeJson(extractToolText(raw));
    if (!parsed) return { unavailable: true, error: "measurability judge returned no parseable JSON verdict" };
    return parsed;
  };
}

export function buildJudgePrompt({ objective = "", targets = [] } = {}) {
  return [
    "You are a strict acceptance-criteria auditor for a software goal.",
    "Do NOT use any tools. Judge only from the text below, then reply with JSON only.",
    "",
    `Objective: ${objective || "(none given)"}`,
    "",
    "For EACH target, decide whether it is MEASURABLE — it names something you can concretely CHECK",
    "(an observable behavior, a test or command outcome, or a specific value/state) — as opposed to",
    'open-ended improvement prose ("make it better", "cleaner", "faster") with nothing to verify.',
    "",
    "Targets:",
    ...targets.map((t) => `- ${t.target}: ${JSON.stringify(String(t.text ?? ""))}`),
    "",
    "Reply with ONLY this JSON object and nothing else:",
    '{"findings":[{"target":"<id>","verdict":"measurable"|"vague","reason":"<short>"}]}',
    'Use verdict "vague" for anything not concretely checkable. Include every target exactly once.',
  ].join("\n");
}

// Best-effort extraction of the verdict JSON from possibly-chatty model text: a fenced ```json block, then the
// outermost {...}, then the raw text. Returns the parsed object ({findings:[...]} or an array) or null.
export function parseJudgeJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const candidates = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  candidates.push(raw);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (Array.isArray(value) || Array.isArray(value?.findings)) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function timeoutSignal(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  try {
    return AbortSignal.timeout(n);
  } catch {
    return undefined;
  }
}
