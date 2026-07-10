import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { judgeGoalMeasurability, proposeGoal } from "../extensions/aipi/runtime/goal-state.js";
import { buildJudgePrompt, buildModelMeasurabilityJudge, parseJudgeJson } from "../extensions/aipi/runtime/goal-judge.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-goal-judge-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
const nowBase = Date.parse("2026-07-08T00:00:00.000Z");
const now = () => new Date(nowBase + (tick++) * 1000);
const fixedRandom = () => Buffer.from("abcdef", "hex");

const CLEAR = {
  objective: "implementar login de usuarios com sessao persistida",
  criteria: ["o fluxo de login retorna 200 e cria a sessao", "logout invalida o token de sessao"],
  done_when: "usuario loga e ve o dashboard",
};

// Fake forked-runner: returns canned worker output instead of spawning a real model.
const runnerReturning = (out) => ({ spawn: async () => (typeof out === "string" ? { output: out } : out) });
const throwingRunner = { spawn: async () => { throw new Error("spawn failed"); } };
const MODEL = "anthropic/claude-test";

const affirmJson = JSON.stringify({ findings: [
  { target: "criterion:c1", verdict: "measurable", reason: "ok" },
  { target: "criterion:c2", verdict: "measurable", reason: "ok" },
  { target: "done_when", verdict: "measurable", reason: "ok" },
] });
const rejectJson = JSON.stringify({ findings: [
  { target: "criterion:c1", verdict: "measurable" },
  { target: "criterion:c2", verdict: "measurable" },
  { target: "done_when", verdict: "vague", reason: "no observable end-state" },
] });

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // --- no host model => no judge (caller uses the deterministic floor) ---
  assert.equal(buildModelMeasurabilityJudge({ root: ".", model: null }), null);

  // --- parseJudgeJson robustness ---
  assert.deepEqual(parseJudgeJson('{"findings":[]}').findings, []);
  assert.equal(parseJudgeJson('prefix ```json\n{"findings":[{"target":"done_when","verdict":"vague"}]}\n``` suffix').findings.length, 1);
  assert.equal(parseJudgeJson('here it is: {"findings":[{"target":"x","verdict":"measurable"}]} thanks').findings.length, 1);
  assert.equal(parseJudgeJson("no json at all"), null);
  assert.equal(parseJudgeJson(""), null);

  // --- buildJudgePrompt lists every target ---
  const prompt = buildJudgePrompt({ objective: "o", targets: [{ target: "criterion:c1", text: "t" }, { target: "done_when", text: "u" }] });
  assert.match(prompt, /criterion:c1/);
  assert.match(prompt, /done_when/);

  // --- the judge parses a JSON reply / fenced reply ---
  const judgeOk = buildModelMeasurabilityJudge({ root: ".", model: MODEL, runner: runnerReturning(affirmJson) });
  const parsed = await judgeOk({ objective: "o", criteria: [{ target: "criterion:c1", text: "t" }, { target: "done_when", text: "u" }] });
  assert.ok(Array.isArray(parsed.findings) && parsed.findings.length === 3);

  const judgeFenced = buildModelMeasurabilityJudge({ root: ".", model: MODEL, runner: runnerReturning("```json\n" + affirmJson + "\n```") });
  assert.ok((await judgeFenced({ criteria: [{ target: "criterion:c1", text: "t" }] })).findings);

  // --- infra failures => { unavailable, retryable } (never throws; a no-op sleep skips the retry backoff) ---
  const noSleep = async () => {};
  const judgeThrows = buildModelMeasurabilityJudge({ root: ".", model: MODEL, runner: throwingRunner, sleep: noSleep });
  const throwsResult = await judgeThrows({ criteria: [{ target: "criterion:c1", text: "t" }] });
  assert.equal(throwsResult.unavailable, true);
  assert.equal(throwsResult.retryable, true, "an infra failure is retryable");
  const judgeGarbage = buildModelMeasurabilityJudge({ root: ".", model: MODEL, runner: runnerReturning("totally not json"), sleep: noSleep });
  assert.equal((await judgeGarbage({ criteria: [{ target: "criterion:c1", text: "t" }] })).unavailable, true);

  // --- the judge RETRIES on a cold-load timeout: a runner that throws once then succeeds is affirmed ---
  let calls = 0;
  const flakyRunner = { spawn: async () => { calls += 1; if (calls === 1) throw new Error("model cold-loading"); return { output: affirmJson }; } };
  const judgeFlaky = buildModelMeasurabilityJudge({ root: ".", model: MODEL, runner: flakyRunner, sleep: noSleep });
  assert.ok((await judgeFlaky({ criteria: [{ target: "criterion:c1", text: "t" }] })).findings, "retry recovers a cold-loaded model");
  assert.equal(calls, 2, "one retry after the first-call timeout");

  // --- judgeGoalMeasurability wiring: model affirm => ok+model ---
  const rModel = await judgeGoalMeasurability({
    objective: "impl login",
    criteria: [{ criterion_id: "c1", text: "retorna 200" }, { criterion_id: "c2", text: "logout invalida token" }],
    done_when: "ve o dashboard",
    judge: buildModelMeasurabilityJudge({ root: ".", model: MODEL, runner: runnerReturning(affirmJson) }),
  });
  assert.equal(rModel.judge, "model");
  assert.equal(rModel.ok, true);

  // --- infra unavailable => deterministic_fallback (does NOT block a measurable goal) ---
  const rFallbackOk = await judgeGoalMeasurability({
    objective: "x",
    criteria: [{ criterion_id: "c1", text: "retorna 200 no login" }],
    done_when: "ve o dashboard",
    judge: judgeThrows,
  });
  assert.equal(rFallbackOk.judge, "deterministic_fallback");
  assert.equal(rFallbackOk.ok, true);

  // --- infra unavailable + vague => the floor still rejects ---
  const rFallbackVague = await judgeGoalMeasurability({
    objective: "x",
    criteria: [{ criterion_id: "c1", text: "deixar melhor" }],
    done_when: "mais limpo",
    judge: judgeThrows,
  });
  assert.equal(rFallbackVague.judge, "deterministic_fallback");
  assert.equal(rFallbackVague.ok, false);

  // --- THE INCIDENT: a THROWN judge error / a hung judge (outer guard fires) must degrade to the floor, NOT
  //     fail-closed. An infra timeout is not "criterion not measurable". ---
  const rThrown = await judgeGoalMeasurability({
    objective: "x",
    criteria: [{ criterion_id: "c1", text: "retorna 200 no login" }],
    done_when: "ve o dashboard",
    judge: () => Promise.reject(new Error("goal_judge_timeout")),
    timeoutMs: 50,
  });
  assert.equal(rThrown.judge, "deterministic_fallback", "a thrown judge error degrades, NOT fail-closed");
  assert.equal(rThrown.retryable, true);
  assert.equal(rThrown.ok, true, "a well-formed goal still passes the floor when the judge throws");
  assert.ok(!rThrown.findings.some((f) => f.verdict === "error"), "no fake 'error' verdicts");
  assert.match(String(rThrown.judge_unavailable_reason), /goal_judge_timeout/);

  const rHung = await judgeGoalMeasurability({
    objective: "x",
    criteria: [{ criterion_id: "c1", text: "retorna 200 no login" }],
    done_when: "ve o dashboard",
    judge: () => new Promise(() => {}), // never resolves -> the outer withTimeout fires
    timeoutMs: 50,
  });
  assert.equal(rHung.judge, "deterministic_fallback", "an outer-timeout (hung judge) degrades, NOT fail-closed");
  assert.equal(rHung.ok, true);

  // --- proposeGoal end-to-end with the live-style judge ---
  const modelAccept = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom, judge: buildModelMeasurabilityJudge({ root: tempRoot, model: MODEL, runner: runnerReturning(affirmJson) }) });
  assert.equal(modelAccept.accepted, true);
  assert.equal(modelAccept.goal.acceptance.measurability.judge, "model");

  const modelReject = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom, judge: buildModelMeasurabilityJudge({ root: tempRoot, model: MODEL, runner: runnerReturning(rejectJson) }) });
  assert.equal(modelReject.accepted, false);
  assert.equal(modelReject.phase, "measurability");
  assert.equal(modelReject.judge, "model");

  const fallbackAccept = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom, judge: judgeThrows });
  assert.equal(fallbackAccept.accepted, true);
  assert.equal(fallbackAccept.goal.acceptance.measurability.judge, "deterministic_fallback");

  // THE INCIDENT end-to-end: a well-formed goal + a judge that TIMES OUT is now ACCEPTED via the floor (was
  // rejected with fake per-target "error" verdicts). The acceptance records the infra caveat transparently.
  const timeoutAccept = await proposeGoal({
    projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom,
    judge: () => Promise.reject(new Error("goal_judge_timeout")),
    timeoutMs: 50,
  });
  assert.equal(timeoutAccept.accepted, true, "the incident goal is now accepted, not fail-closed");
  assert.equal(timeoutAccept.goal.acceptance.measurability.judge, "deterministic_fallback");
  assert.match(String(timeoutAccept.goal.acceptance.measurability.judge_unavailable_reason), /goal_judge_timeout/);

  // A genuinely vague goal + a down judge rejects with phase "judge_unavailable" + retryable (infra caveat,
  // not a confident semantic verdict).
  const timeoutReject = await proposeGoal({
    projectRoot: tempRoot,
    objective: "deixar o app melhor",
    criteria: ["deixar mais limpo"],
    done_when: "ficar bom",
    now, randomBytes: fixedRandom,
    judge: () => Promise.reject(new Error("goal_judge_timeout")),
    timeoutMs: 50,
  });
  assert.equal(timeoutReject.accepted, false);
  assert.equal(timeoutReject.phase, "judge_unavailable", "a down judge yields judge_unavailable, not measurability");
  assert.equal(timeoutReject.retryable, true);

  console.log("AIPI_GOAL_JUDGE_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
