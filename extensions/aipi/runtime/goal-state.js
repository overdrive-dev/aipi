import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// The GOAL layer sits ABOVE the plan layer. A plan is a BATCH of tasks; a goal is a single north-star
// OBJECTIVE with a MEASURABLE END. Its whole reason to exist is the acceptance gate: a goal is only
// ACCEPTED when it carries (a) a clear objective, (b) at least one checkable acceptance criterion (the
// "what to do" made precise), and (c) a measurable done_when. A proposal that misses any of these — or whose
// criteria are non-measurable prose ("make it better") — is REJECTED with reasons, never silently kept.
// This is the "verify == ship" invariant pushed up to the objective: you cannot even OPEN a goal without a
// definition of done, and (achieveGoal) you cannot CLOSE one until every required criterion is met with
// evidence. Once accepted, a goal can optionally DRIVE an /aipi-plan (linkGoalPlan) — the plan is the task
// breakdown, the goal is the contract it must satisfy.

const TERMINAL_GOAL_STATUSES = new Set(["achieved", "abandoned"]);

// Structural floors for the deterministic gate. Deliberately lenient — the floor only rejects the blatantly
// under-specified; the measurability judge is what separates measurable criteria from vague prose.
const MIN_OBJECTIVE_CHARS = 10;
const MIN_OBJECTIVE_WORDS = 2;
const MIN_CRITERION_CHARS = 6;
const MIN_DONE_WHEN_CHARS = 6;

export const GOAL_CRITERION_SEVERITIES = Object.freeze(["required", "recommended"]);

// ---- acceptance gate: structural (deterministic) ----

// Pure: the reasons a proposed goal cannot be ACCEPTED on structure alone. Mirrors plan-state.unsettledReasons
// — a hard precondition, not loose context. An empty array means the structure is complete (measurability is
// judged separately).
export function structuralRejectReasons(goal) {
  const reasons = [];
  const objective = String(goal?.objective ?? "").trim();
  if (!objective) {
    reasons.push("objective is required (state WHAT the goal achieves)");
  } else if (objective.length < MIN_OBJECTIVE_CHARS || wordCount(objective) < MIN_OBJECTIVE_WORDS) {
    reasons.push(`objective is too thin to act on: "${objective}"`);
  }

  const criteria = Array.isArray(goal?.criteria) ? goal.criteria : [];
  const usableCriteria = criteria.filter((c) => String(c?.text ?? "").trim().length >= MIN_CRITERION_CHARS);
  if (!usableCriteria.length) {
    reasons.push("at least one acceptance criterion is required (each a checkable statement of what 'done' looks like)");
  }

  const doneWhen = String(goal?.done_when ?? "").trim();
  if (!doneWhen) {
    reasons.push("done_when is required (the measurable end — how you will KNOW the goal is met)");
  } else if (doneWhen.length < MIN_DONE_WHEN_CHARS) {
    reasons.push(`done_when is too thin to be measurable: "${doneWhen}"`);
  }

  return reasons;
}

// ---- acceptance gate: measurability (deterministic floor + injectable model seam) ----

// Vague, open-ended-improvement prose with no observable end-state. Accent-stripped ASCII match (see
// normalizeText), so pt-BR and English share one pattern.
const VAGUE_PROSE =
  /\b(?:melhor\w*|better|improv\w*|otimiz\w*|optimi[sz]\w*|aprimor\w*|refin\w*|refactor\w*|mais rapid\w*|faster|mais limp\w*|cleaner|clean\b|robust\w*|escalab\w*|escalav\w*|scalab\w*|qualidade|quality|amigav\w*|user.?friendly|bonit\w*|nicer|nice\b|simplif\w*|organiz\w*|arrum\w*|ajeit\w*|polir|polish|tunar|tune\b|geral\b|generic\w*|adequad\w*|apropriad\w*|razoav\w*|solid\w*|maintainab\w*|manuteniv\w*|legiv\w*|readab\w*|performan\w*)\b/;

// An OBSERVABLE end-state: a number/threshold, a comparison, a runnable/check hint, a concrete behavior verb,
// or a when/then structure. Its presence means the target has something you can actually check.
const OBSERVABLE =
  /\d|(?:<=|>=|==|!=|<|>|=)|\b(?:test\w*|teste\w*|passa\w*|pass(?:es|ing|ed)?|falha\w*|fail\w*|exit\b|build\w*|compil\w*|lint\w*|ci\b|cd\b|cobertura|coverage|green|verde|retorn\w*|returns?|exib\w*|mostr\w*|display\w*|renderiz\w*|render\w*|respond\w*|status|20\d|40\d|50\d|salv\w*|persist\w*|cri(?:a|ar|ando)\b|remov\w*|delet\w*|bloqu\w*|rejeit\w*|reject\w*|aceit\w*|accept\w*|log(?:a|ar|in|out|ged)?\b|login|logout|redirec\w*|redirect\w*|endpoint|rota\b|route\w*|arquivo|file\b|exist\w*|contain\w*|conte\w*|igual\w*|equal\w*|valid\w*|autentic\w*|authenticat\w*|autoriz\w*|authoriz\w*|sess\w*|session|token|dashboard|vejo|visualiz\w*|carreg\w*|load\w*|abre\b|abrir\b|open\w*|habilit\w*|enable\w*|desabilit\w*|disable\w*|schema|migrac\w*|migrat\w*|deploy\w*|dentro de|within|menos de|less than|no maximo|at most|pelo menos|at least)\b|\b(?:quando|when|se|if)\b[\s\S]*\b(?:entao|then|deve|devem|must|should|espera\w*|expect\w*)\b/;

// Deterministic per-target verdict. Coarse BY DESIGN and permissive where unsure: it only flags the target
// `vague` when it reads as improvement prose AND carries no observable. Anything with an observable — or that
// is neither clearly vague nor clearly measurable — passes the floor as `measurable`. The strict fail-closed
// judgment on the ambiguous residue is the MODEL's job (see judgeGoalMeasurability's injected `judge`), exactly
// mirroring how stop-classifier keeps a lenient deterministic floor and lets a model refine the residue.
export function defaultGoalMeasurabilityJudge({ target, text }) {
  const normalized = normalizeText(text);
  if (!normalized) return { target, verdict: "vague", reason: "empty" };
  if (OBSERVABLE.test(normalized)) return { target, verdict: "measurable", reason: "has an observable end-state" };
  if (VAGUE_PROSE.test(normalized)) {
    return { target, verdict: "vague", reason: "open-ended improvement prose with nothing to check" };
  }
  return { target, verdict: "measurable", reason: "no vague-prose signal" };
}

// Judge whether every criterion and the done_when are MEASURABLE. Returns { ok, judge, findings }.
// - No `judge` (or not a function) => the deterministic floor decides (defaultGoalMeasurabilityJudge).
// - A `judge` function is a MODEL callback: it is handed the whole goal and returns per-target verdicts. It is
//   FAIL-CLOSED — a missing verdict, an error, a timeout, or any non-`measurable` verdict rejects that target.
//   Only an explicit `measurable` from the model passes. (Same posture as stop-classifier: the model must
//   affirm; doubt/error keeps the gate closed.)
export async function judgeGoalMeasurability({
  objective = "",
  criteria = [],
  done_when = "",
  judge = null,
  timeoutMs = 2000,
} = {}) {
  // Only REQUIRED criteria + the done_when carry the measurable-end guarantee (they are what gates "done" —
  // see unmetRequiredCriteria/achieveGoal). Recommended criteria are aspirational and exempt: a vague
  // nice-to-have never blocks achievement, so its vagueness is harmless.
  const targets = [
    ...criteria
      .map((c, index) => ({ id: c?.criterion_id ?? `c${index + 1}`, text: String(c?.text ?? "").trim(), severity: c?.severity }))
      .filter((c) => c.text && c.severity !== "recommended")
      .map((c) => ({ target: `criterion:${c.id}`, text: c.text })),
    { target: "done_when", text: String(done_when ?? "").trim() },
  ];

  if (typeof judge !== "function") {
    const findings = targets.map(({ target, text }) => defaultGoalMeasurabilityJudge({ target, text }));
    return { ok: findings.every((f) => f.verdict === "measurable"), judge: "deterministic", findings };
  }

  let verdicts;
  try {
    const raw = await withTimeout(judge({ objective, criteria: targets, done_when }), timeoutMs, "goal_judge_timeout");
    // Infra degrade: the model judge could not run (spawn error / timeout / unparseable). Do NOT block goal
    // creation on infra noise — fall back to the deterministic floor. (A real `vague` VERDICT still rejects.)
    if (raw && raw.unavailable) {
      return deterministicMeasurabilityFallback(targets, raw.error ?? "judge unavailable");
    }
    verdicts = normalizeJudgeVerdicts(raw);
  } catch (error) {
    // A THROWN error/timeout is INFRA, not a semantic verdict — an unreachable judge does not make a criterion
    // "not measurable". Degrade to the deterministic floor exactly like the { unavailable } path above, rather
    // than fail-closed rejecting every target (which masked judge outages as immeasurability). A genuine
    // `vague` VERDICT from a reachable judge still rejects; only infra failures degrade.
    return deterministicMeasurabilityFallback(targets, error?.message ?? error);
  }

  const findings = targets.map(({ target }) => {
    const verdict = verdicts.get(target);
    if (verdict?.verdict === "measurable") return { target, verdict: "measurable", reason: verdict.reason ?? "model affirmed" };
    // Anything the model did not explicitly affirm is fail-closed.
    return {
      target,
      verdict: verdict?.verdict === "vague" ? "vague" : "ambiguous",
      reason: verdict?.reason ?? "model did not affirm measurability",
    };
  });
  return { ok: findings.every((f) => f.verdict === "measurable"), judge: "model", findings };
}

// Infra degrade path shared by the { unavailable } signal and a THROWN judge error/timeout: the model judge
// could not produce a verdict, so decide on the deterministic floor (a well-formed goal — verifiable verbs +
// a binary done_when — passes) and mark the result retryable so the caller can surface "judge was down" rather
// than a false immeasurability. Never fail-closed on infra noise.
function deterministicMeasurabilityFallback(targets, reason) {
  const findings = targets.map(({ target, text }) => defaultGoalMeasurabilityJudge({ target, text }));
  return {
    ok: findings.every((f) => f.verdict === "measurable"),
    judge: "deterministic_fallback",
    judge_unavailable_reason: String(reason ?? "judge unavailable"),
    retryable: true,
    findings,
  };
}

export function measurabilityRejectReasons(measurability) {
  return (measurability?.findings ?? [])
    .filter((f) => f.verdict !== "measurable")
    .map((f) => `${f.target} is not measurable (${f.verdict}): ${f.reason}`);
}

// ---- create (== accept): the gate ----

// Propose a goal. Runs the FULL acceptance gate (structural, then measurability). On rejection it returns
// { accepted: false, reasons, ... } and persists NOTHING — a rejected proposal is not a goal. On acceptance it
// persists the goal, writes the active pointer, and returns { accepted: true, goalId, goal }.
export async function proposeGoal({
  projectRoot,
  objective,
  criteria = [],
  done_when,
  source = "command",
  now = () => new Date(),
  randomBytes = (size) => crypto.randomBytes(size),
  judge = null,
  timeoutMs = 2000,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const root = path.resolve(projectRoot);
  // The goal is STANDALONE: it does not require /aipi-init. persistGoal creates its own
  // .aipi/runtime/goals/ on demand (mkdir -p), and a goal (objective + criteria + done_when) depends on
  // none of the project scaffold (memory, kanban, workflows) that the plan/workflow layers need. So there is
  // deliberately no assertAipiInstalled gate here — you can set a measurable goal in any directory.

  const draft = buildGoalDraft({ objective, criteria, done_when });

  const structural = structuralRejectReasons(draft);
  if (structural.length) {
    return { accepted: false, phase: "structural", reasons: structural, findings: [] };
  }

  const measurability = await judgeGoalMeasurability({
    objective: draft.objective,
    criteria: draft.criteria,
    done_when: draft.done_when,
    judge,
    timeoutMs,
  });
  if (!measurability.ok) {
    // When the model judge was DOWN, the rejection came from the deterministic floor — surface that so the
    // caller sees an infra caveat (retryable), not a confident semantic verdict.
    const judgeDown = Boolean(measurability.judge_unavailable_reason);
    return {
      accepted: false,
      phase: judgeDown ? "judge_unavailable" : "measurability",
      reasons: measurabilityRejectReasons(measurability),
      findings: measurability.findings,
      judge: measurability.judge,
      ...(judgeDown ? { judge_unavailable_reason: measurability.judge_unavailable_reason, retryable: true } : {}),
    };
  }

  const createdAt = now().toISOString();
  const goalId = generateGoalId(now, randomBytes);
  const goal = {
    schema: "aipi.goal.v1",
    goal_id: goalId,
    status: "accepted",
    source,
    objective: draft.objective,
    criteria: draft.criteria,
    done_when: draft.done_when,
    created_at: createdAt,
    accepted_at: createdAt,
    achieved_at: null,
    abandoned_at: null,
    plan_id: null,
    close_reason: null,
    acceptance: {
      accepted_at: createdAt,
      structural: { ok: true, reasons: [] },
      measurability: {
        ok: true,
        judge: measurability.judge,
        findings: measurability.findings,
        // Transparency: a soft-accept via the deterministic floor when the model judge was unreachable.
        ...(measurability.judge_unavailable_reason ? { judge_unavailable_reason: measurability.judge_unavailable_reason } : {}),
      },
    },
  };

  // Safety net for the cwd pin: the AIPI session anchors the project on its working directory (resolveProjectRoot
  // does NOT search upward). If .aipi/ does not exist yet, persisting will create a fresh one HERE — which is
  // wrong if the session was opened from a parent/unintended folder. Flag it so the caller can warn.
  const aipiExisted = await pathExists(path.join(root, ".aipi"));
  await persistGoal(root, goal);
  await fs.writeFile(path.join(goalsDir(root), "active"), `${goalId}\n`);
  return {
    accepted: true,
    goalId,
    goal,
    ...(aipiExisted ? {} : {
      created_aipi_root: root,
      warning: `Created a new .aipi/ at ${root}. The AIPI session anchors on its working directory — confirm this is the intended project root, not a parent or wrong folder.`,
    }),
  };
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// ---- read ----

export async function readActiveGoal(projectRoot, { includeTerminal = false } = {}) {
  const root = path.resolve(projectRoot);
  const activePath = path.join(goalsDir(root), "active");
  const goalId = (await fs.readFile(activePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).trim();
  if (!goalId) return null;

  const goal = await readGoalState(root, goalId).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!goal) {
    await clearActiveGoal(root, goalId);
    return null;
  }
  if (!includeTerminal && isTerminalGoalStatus(goal.status)) {
    await clearActiveGoal(root, goalId);
    return null;
  }
  return { goalId, goal };
}

export async function readGoal(projectRoot, goalId) {
  const root = path.resolve(projectRoot);
  const goal = await readGoalState(root, goalId);
  return { goalId, goal };
}

// ---- mutate ----

// Mark ONE acceptance criterion met, with evidence. This is the per-criterion checkoff that achieveGoal gates
// on — "verify == ship" at the goal level: a goal cannot be achieved on prose, only on each required criterion
// carrying a concrete evidence reference.
export async function recordCriterionMet({
  projectRoot,
  goalId = null,
  criterionId,
  evidence,
  now = () => new Date(),
} = {}) {
  if (!criterionId) throw new Error("recordCriterionMet requires criterionId");
  const text = String(evidence ?? "").trim();
  if (!text) throw new Error("recordCriterionMet requires evidence (a concrete reference proving the criterion is met)");
  const { root, goal } = await loadGoalForMutation(projectRoot, goalId);
  const criterion = goal.criteria.find((c) => c.criterion_id === criterionId);
  if (!criterion) throw new Error(`recordCriterionMet: unknown criterion_id ${criterionId}`);
  criterion.status = "met";
  criterion.evidence = text;
  criterion.met_at = now().toISOString();
  if (goal.status === "accepted") goal.status = "active";
  await persistGoal(root, goal);
  return { goal, criterion };
}

// Pure: the criteria that still block achievement (required + not met).
export function unmetRequiredCriteria(goal) {
  return (goal?.criteria ?? []).filter((c) => c.severity !== "recommended" && c.status !== "met");
}

export async function achieveGoal({ projectRoot, goalId = null, now = () => new Date() } = {}) {
  const { root, goal } = await loadGoalForMutation(projectRoot, goalId);
  const unmet = unmetRequiredCriteria(goal);
  if (unmet.length) {
    const error = new Error(
      `goal not achievable: ${unmet.length} required criterion/criteria still unmet (${unmet.map((c) => c.criterion_id).join(", ")})`,
    );
    error.unmet = unmet.map((c) => ({ criterion_id: c.criterion_id, text: c.text }));
    throw error;
  }
  goal.status = "achieved";
  goal.achieved_at = now().toISOString();
  await persistGoal(root, goal);
  await clearActiveGoal(root, goal.goal_id);
  return { goalId: goal.goal_id, goal };
}

// Bind an accepted goal to a plan it will drive. The goal is the contract; the plan is the task breakdown.
export async function linkGoalPlan({ projectRoot, goalId = null, planId, now = () => new Date() } = {}) {
  if (!planId) throw new Error("linkGoalPlan requires planId");
  const { root, goal } = await loadGoalForMutation(projectRoot, goalId);
  goal.plan_id = planId;
  if (goal.status === "accepted") goal.status = "active";
  goal.plan_linked_at = now().toISOString();
  await persistGoal(root, goal);
  return { goal };
}

export async function abandonGoal({ projectRoot, goalId = null, reason = "", now = () => new Date() } = {}) {
  const { root, goal } = await loadGoalForMutation(projectRoot, goalId);
  goal.status = "abandoned";
  goal.abandoned_at = now().toISOString();
  goal.close_reason = reason || null;
  await persistGoal(root, goal);
  await clearActiveGoal(root, goal.goal_id);
  return { goalId: goal.goal_id, goal };
}

export async function clearActiveGoal(projectRoot, goalId = null) {
  const root = path.resolve(projectRoot);
  const activePath = path.join(goalsDir(root), "active");
  if (goalId) {
    const activeGoalId = (await fs.readFile(activePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })).trim();
    if (activeGoalId && activeGoalId !== goalId) {
      return { cleared: false, active_goal_id: activeGoalId, reason: "different_active_goal" };
    }
  }
  await fs.rm(activePath, { force: true });
  return { cleared: true, active_goal_id: goalId ?? null };
}

export async function persistGoal(root, goal) {
  const dir = path.join(goalsDir(root), goal.goal_id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "GOAL.json"), `${JSON.stringify(goal, null, 2)}\n`);
  await fs.writeFile(path.join(dir, "GOAL.md"), renderGoalManifest(goal));
}

// ---- internals ----

function buildGoalDraft({ objective, criteria, done_when }) {
  return {
    objective: String(objective ?? "").trim(),
    done_when: String(done_when ?? "").trim(),
    criteria: normalizeCriteria(criteria),
  };
}

function normalizeCriteria(criteria) {
  const list = Array.isArray(criteria) ? criteria : criteria == null ? [] : [criteria];
  const out = [];
  for (const raw of list) {
    const text = String((typeof raw === "string" ? raw : raw?.text) ?? "").trim();
    if (!text) continue;
    const severity = GOAL_CRITERION_SEVERITIES.includes(raw?.severity) ? raw.severity : "required";
    out.push({
      criterion_id: `c${out.length + 1}`,
      text,
      severity,
      status: "open",
      evidence: null,
      met_at: null,
    });
  }
  return out;
}

async function loadGoalForMutation(projectRoot, goalId) {
  const root = path.resolve(projectRoot);
  const goal = goalId
    ? await readGoalState(root, goalId)
    : (await readActiveGoal(root, { includeTerminal: true }))?.goal;
  if (!goal) throw new Error("No active AIPI goal; propose a goal first");
  return { root, goal };
}

async function readGoalState(root, goalId) {
  const goalPath = path.join(goalsDir(root), goalId, "GOAL.json");
  return JSON.parse(await fs.readFile(goalPath, "utf8"));
}

function goalsDir(root) {
  return path.join(root, ".aipi", "runtime", "goals");
}

function isTerminalGoalStatus(status) {
  return TERMINAL_GOAL_STATUSES.has(String(status ?? "").toLowerCase());
}

function generateGoalId(now, randomBytes) {
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `goal-${stamp}-${randomBytes(3).toString("hex")}`;
}

function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function normalizeJudgeVerdicts(raw) {
  const map = new Map();
  const findings = Array.isArray(raw) ? raw : Array.isArray(raw?.findings) ? raw.findings : [];
  for (const entry of findings) {
    const target = String(entry?.target ?? "").trim();
    if (!target) continue;
    const verdict = String(entry?.verdict ?? entry?.decision ?? "").trim().toLowerCase();
    const known = ["measurable", "vague", "ambiguous"].includes(verdict) ? verdict : "ambiguous";
    map.set(target, { verdict: known, reason: String(entry?.reason ?? "").slice(0, 240) });
  }
  return map;
}

function withTimeout(promise, timeoutMs, message) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || "timeout")), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function renderGoalManifest(goal) {
  const criteriaLines = goal.criteria.length
    ? goal.criteria
        .map((c) => `- ${c.criterion_id} [${c.status}]${c.severity === "recommended" ? " (recommended)" : ""} ${c.text}${c.evidence ? ` -> evidence: ${c.evidence}` : ""}`)
        .join("\n")
    : "- none";
  return `---
schema: aipi.goal-manifest.v1
goal_id: ${goal.goal_id}
status: ${goal.status}
created_at: ${goal.created_at}
accepted_at: ${goal.accepted_at ?? ""}
achieved_at: ${goal.achieved_at ?? ""}
plan_id: ${goal.plan_id ?? ""}
---

# AIPI Goal ${goal.goal_id}

- status: ${goal.status}
- objective: ${goal.objective}
- done_when: ${goal.done_when}
- criteria met: ${goal.criteria.filter((c) => c.status === "met").length}/${goal.criteria.length}

## Acceptance criteria

${criteriaLines}

## Measurability (accepted via ${goal.acceptance?.measurability?.judge ?? "?"} judge)

${(goal.acceptance?.measurability?.findings ?? []).map((f) => `- ${f.target}: ${f.verdict}`).join("\n") || "- none"}
`;
}
