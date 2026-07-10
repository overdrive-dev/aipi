import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  abandonGoal,
  achieveGoal,
  defaultGoalMeasurabilityJudge,
  judgeGoalMeasurability,
  proposeGoal,
  readActiveGoal,
  recordCriterionMet,
  structuralRejectReasons,
  unmetRequiredCriteria,
} from "../extensions/aipi/runtime/goal-state.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-goal-state-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
const nowBase = Date.parse("2026-07-08T00:00:00.000Z");
const now = () => new Date(nowBase + (tick++) * 1000);
const fixedRandom = () => Buffer.from("abcdef", "hex");

const CLEAR = {
  objective: "implementar login de usuarios com sessao persistida",
  criteria: [
    "o fluxo de login retorna 200 e cria a sessao",
    "logout invalida o token de sessao",
    { text: "a tela fica mais bonita", severity: "recommended" },
  ],
  done_when: "usuario loga e ve o dashboard",
};

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // --- deterministic per-target judge ---
  assert.equal(defaultGoalMeasurabilityJudge({ target: "c", text: "retorna 200 ao logar" }).verdict, "measurable");
  assert.equal(defaultGoalMeasurabilityJudge({ target: "c", text: "deixar o codigo melhor" }).verdict, "vague");
  assert.equal(defaultGoalMeasurabilityJudge({ target: "c", text: "codigo mais limpo" }).verdict, "vague");
  assert.equal(defaultGoalMeasurabilityJudge({ target: "c", text: "" }).verdict, "vague");
  // Neither vague prose nor an obvious observable => permissive floor passes it (the MODEL is the strict layer).
  assert.equal(defaultGoalMeasurabilityJudge({ target: "c", text: "a fatura mensal do cliente" }).verdict, "measurable");

  // --- structural gate ---
  assert.deepEqual(structuralRejectReasons({ objective: "fix", criteria: [], done_when: "" }).length >= 1, true);
  assert.equal(structuralRejectReasons({ objective: CLEAR.objective, criteria: [{ text: CLEAR.criteria[0] }], done_when: CLEAR.done_when }).length, 0);

  // --- REJECT: trivial objective (structural) ---
  const trivial = await proposeGoal({ projectRoot: tempRoot, objective: "fix", criteria: ["retorna 200"], done_when: "test passa", now, randomBytes: fixedRandom });
  assert.equal(trivial.accepted, false);
  assert.equal(trivial.phase, "structural");
  assert.ok(trivial.reasons.length >= 1);
  // Nothing persisted for a rejected proposal.
  assert.equal(await readActiveGoal(tempRoot), null, "rejected proposal must not become active");

  // --- REJECT: vague criteria (measurability, deterministic floor) ---
  const vague = await proposeGoal({
    projectRoot: tempRoot,
    objective: "melhorar a experiencia do usuario no app",
    criteria: ["deixar o codigo melhor", "app mais rapido"],
    done_when: "ficar mais limpo",
    now,
    randomBytes: fixedRandom,
  });
  assert.equal(vague.accepted, false);
  assert.equal(vague.phase, "measurability");
  assert.ok(vague.reasons.length >= 1);
  assert.equal(await readActiveGoal(tempRoot), null);

  // --- ACCEPT: clear objective + measurable criteria + done_when ---
  const accepted = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  assert.match(accepted.goalId, /^goal-20260708T00\d{4}Z-abcdef$/);
  assert.equal(accepted.goal.status, "accepted");
  assert.equal(accepted.goal.acceptance.measurability.judge, "deterministic");
  assert.equal(accepted.goal.criteria.length, 3);
  assert.equal(accepted.goal.criteria[2].severity, "recommended");
  // Persisted + active pointer written.
  const onDisk = JSON.parse(await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "goals", accepted.goalId, "GOAL.json"), "utf8"));
  assert.equal(onDisk.schema, "aipi.goal.v1");
  const active = await readActiveGoal(tempRoot);
  assert.equal(active.goalId, accepted.goalId);

  // --- injected MODEL judge: affirm-all accepts (judge=model) ---
  const affirmAll = ({ criteria }) => ({ findings: criteria.map((c) => ({ target: c.target, verdict: "measurable", reason: "ok" })) });
  const modelOk = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom, judge: affirmAll });
  assert.equal(modelOk.accepted, true);
  assert.equal(modelOk.goal.acceptance.measurability.judge, "model");

  // --- injected MODEL judge: FAIL-CLOSED on non-affirmation ---
  const rejectDoneWhen = ({ criteria }) => ({ findings: criteria.map((c) => ({ target: c.target, verdict: c.target === "done_when" ? "ambiguous" : "measurable" })) });
  const modelReject = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom, judge: rejectDoneWhen });
  assert.equal(modelReject.accepted, false);
  assert.equal(modelReject.phase, "measurability");

  // --- injected MODEL judge: a THROWN error/timeout is INFRA, so it DEGRADES to the deterministic floor
  //     (not fail-closed). A well-formed goal is accepted via the floor, never rejected with fake "error"
  //     verdicts — this is the goal_judge_timeout incident fix. ---
  const modelThrows = () => { throw new Error("model down"); };
  const modelErr = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom, judge: modelThrows });
  assert.equal(modelErr.accepted, true, "a well-formed goal is accepted via the floor when the judge throws");
  assert.equal(modelErr.goal.acceptance.measurability.judge, "deterministic_fallback");
  const errJudge = await judgeGoalMeasurability({ criteria: [{ criterion_id: "c1", text: "retorna 200 no login" }], done_when: "ve o dashboard", judge: modelThrows });
  assert.equal(errJudge.judge, "deterministic_fallback");
  assert.equal(errJudge.retryable, true);
  assert.ok(!errJudge.findings.some((f) => f.verdict === "error"), "no fake 'error' verdicts on infra failure");

  // --- achieve gate: verify == ship at the goal level ---
  const fresh = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom });
  const goalId = fresh.goalId;
  // An already-initialized project (.aipi/ present) does NOT trigger the fresh-.aipi warning.
  assert.equal(fresh.created_aipi_root, undefined, "no fresh-.aipi warning when .aipi already exists");
  // Only the 2 REQUIRED criteria block achievement (the recommended one does not).
  assert.equal(unmetRequiredCriteria(fresh.goal).length, 2);
  await assert.rejects(achieveGoal({ projectRoot: tempRoot, goalId, now }), /not achievable/);

  // Evidence is mandatory to check off a criterion.
  await assert.rejects(recordCriterionMet({ projectRoot: tempRoot, goalId, criterionId: "c1", evidence: "", now }), /requires evidence/);

  const met1 = await recordCriterionMet({ projectRoot: tempRoot, goalId, criterionId: "c1", evidence: "runtime/verify.log: 200 on POST /login", now });
  assert.equal(met1.goal.status, "active");
  await assert.rejects(achieveGoal({ projectRoot: tempRoot, goalId, now }), /not achievable/, "still one required criterion open");

  await recordCriterionMet({ projectRoot: tempRoot, goalId, criterionId: "c2", evidence: "test:auth logout invalidation passes", now });
  const done = await achieveGoal({ projectRoot: tempRoot, goalId, now });
  assert.equal(done.goal.status, "achieved");
  // An achieved goal is terminal -> the active pointer is cleared.
  assert.equal(await readActiveGoal(tempRoot), null, "achieved goal must clear the active pointer");

  // --- abandon ---
  const toAbandon = await proposeGoal({ projectRoot: tempRoot, ...CLEAR, now, randomBytes: fixedRandom });
  const abandoned = await abandonGoal({ projectRoot: tempRoot, goalId: toAbandon.goalId, reason: "descoped", now });
  assert.equal(abandoned.goal.status, "abandoned");
  assert.equal(await readActiveGoal(tempRoot), null);

  // --- STANDALONE: a goal needs NO /aipi-init. proposeGoal works in a bare directory (no .aipi scaffold),
  //     creating only its own runtime/goals/ on demand — the guard removal Victor asked about. ---
  const bareRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-goal-bare-"));
  try {
    const standalone = await proposeGoal({ projectRoot: bareRoot, ...CLEAR, now, randomBytes: fixedRandom });
    assert.equal(standalone.accepted, true, "a goal is accepted without /aipi-init");
    // cwd safety net: creating a fresh .aipi/ here is flagged so the caller can warn.
    assert.equal(standalone.created_aipi_root, bareRoot, "a fresh .aipi/ creation is flagged");
    assert.ok(String(standalone.warning ?? "").includes(".aipi/"), "carries a human-readable warning");
    const active = await readActiveGoal(bareRoot);
    assert.equal(active.goal.objective, CLEAR.objective, "the standalone goal persisted and is active");
    // It created only its OWN storage — no full install (runtime-contract.json is absent).
    await assert.rejects(fs.access(path.join(bareRoot, ".aipi", "runtime-contract.json")), "no full install was performed");
    await fs.access(path.join(bareRoot, ".aipi", "runtime", "goals", standalone.goalId, "GOAL.json"));
  } finally {
    await fs.rm(bareRoot, { recursive: true, force: true });
  }

  console.log("AIPI_GOAL_STATE_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
