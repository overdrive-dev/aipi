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
// Per-attempt spawn budget. A forked Pi worker takes seconds to spawn + run, so this must be generous — the
// old outer 2s cap in proposeGoal preempted this entirely and the model judge never got to run.
export const GOAL_JUDGE_ATTEMPT_TIMEOUT_MS = 30_000;
// Retry once: a cold-loaded local model (e.g. Ollama) that times out on the first call is usually warm for the
// next, so a second attempt frequently succeeds — this is the "warm-up" without a provider-specific ping.
export const GOAL_JUDGE_ATTEMPTS = 2;
const GOAL_JUDGE_RETRY_BACKOFF_MS = 1_500;
// The TOTAL time the judge may take. proposeGoal's outer guard must sit ABOVE this so the judge's own graceful
// { unavailable } wins the race instead of the outer timeout throwing and fail-closing.
export const GOAL_JUDGE_TOTAL_BUDGET_MS = GOAL_JUDGE_ATTEMPT_TIMEOUT_MS * GOAL_JUDGE_ATTEMPTS + GOAL_JUDGE_RETRY_BACKOFF_MS;

export function buildModelMeasurabilityJudge({
  root = process.cwd(),
  model = null,
  runner = null,
  attemptTimeoutMs = GOAL_JUDGE_ATTEMPT_TIMEOUT_MS,
  attempts = GOAL_JUDGE_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const modelId = modelToPiModelId(model);
  if (!modelId) return null; // no concrete host model -> caller uses the deterministic floor
  const spawnRunner = runner ?? createAipiSubagentsRunner({ root });
  const maxAttempts = Math.max(1, attempts);

  return async function modelMeasurabilityJudge({ objective = "", criteria = [] } = {}) {
    const targets = (Array.isArray(criteria) ? criteria : []).filter((t) => t && t.target);
    if (!targets.length) return { unavailable: true, error: "no targets to judge" };
    const task = buildJudgePrompt({ objective, targets });

    let lastError = "measurability judge produced no verdict";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let raw;
      try {
        raw = await spawnRunner.spawn(
          { agent: "aipi-worker", task, async: false, context: "fresh", model: modelId, allow_shell: false, max_tool_calls: 1, id: JUDGE_RUN_ID },
          { signal: timeoutSignal(attemptTimeoutMs) },
        );
      } catch (error) {
        lastError = String(error?.message ?? error);
        if (attempt < maxAttempts) {
          await sleep(GOAL_JUDGE_RETRY_BACKOFF_MS); // let a cold model finish loading before the retry
          continue;
        }
        break;
      }
      const parsed = parseJudgeJson(extractToolText(raw));
      if (parsed) return parsed;
      lastError = "measurability judge returned no parseable JSON verdict";
      if (attempt < maxAttempts) await sleep(GOAL_JUDGE_RETRY_BACKOFF_MS);
    }
    // Infra failure (timeout / spawn error / unparseable across all attempts): degrade, do NOT reject. Marked
    // retryable so the caller can distinguish "judge was down" from a real "vague" verdict.
    return { unavailable: true, retryable: true, error: lastError };
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
