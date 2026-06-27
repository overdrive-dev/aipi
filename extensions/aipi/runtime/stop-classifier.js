// Stop classifier (F4b) — the OPTIONAL net that decides whether a blocked-gate stop is a spurious
// courtesy/cadence stop (safe to continue) or a real one (keep blocked). It complements F1/F2 (which drop
// the rate at the source); it is the net for the residue, never a substitute.
//
// SAFETY POSTURE (every branch errs toward STOP — fail-open-to-continue would be an irreversible blow-past
// of a real gate, an asymmetric cost):
// - ON by default (set AIPI_STOP_CLASSIFIER=0 to disable). It is consulted ONLY by the forked plan executor
//   under autonomous_to_pr cadence — the default cadence (checkpoint_per_task) never consults it — so the
//   blast radius of "on by default" is bounded to runs that explicitly opted into autonomous execution.
// - The deterministic floor (gate_kind) is the AUTHORITY. This may ONLY downgrade a `courtesy` floor to
//   continue. It can never turn a non-courtesy gate into continue, and never the reverse.
// - Defense in depth: a high-risk token present, or the absence of a structured courtesy signal => keep-blocked
//   (the floor `courtesy` is coarse — it also covers some fabricated gate failures).
// - The discriminator defaults to a DETERMINISTIC one (the plan-sanctioned regex floor): it continues a generic
//   fabricated proceed-question but keeps blocked on any gate-FAILURE language. A low-effort HOST-family model
//   callback can be INJECTED to refine the residue (mirrors applyAutoDispatchVeto's intentClassifier). An
//   explicit null callback, a model error/timeout, or an ambiguous verdict => keep-blocked.
// Replay note: the result always carries floor_gate_kind alongside the verdict, so an audit can prove the
// FLOOR — not the discriminator — decided every STOP.

export const STOP_CLASSIFIER_FLAG = "AIPI_STOP_CLASSIFIER";

const HIGH_RISK =
  /\b(?:destructive|destrut\w*|delete|deletar|drop|truncate|overwrit\w*|irreversible|irrevers\w*|apagar|excluir|wipe|purge|secret|secrets|segredo|credential|credenc\w*|password|senha|api[_-]?key|private\s+key|prod|production|produc\w*|deploy\w*|release|migration|migrac\w*|rollback|business[_-]?rule|policy|compliance|scope|escopo)\b|rm\s+-rf|\.env\b/i;

const COURTESY_SIGNAL =
  /\b(?:cadence|caden\w*|checkpoint|pacing|rhythm|ritmo|keep going|keep this|want me to|should i|how do you want|como voce quer|quer que eu|mantenho|seguir|prosseguir|proceed|continue|continuar)\b/i;

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on", "enabled"].includes(String(value ?? "").toLowerCase());
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

function stop(reason, gateKind, extra = {}) {
  return { decision: "stop", reason, floor_gate_kind: gateKind ?? null, llm_verdict: null, ...extra };
}

// Gate-FAILURE language: a fabricated stop whose reason reads like a real gate that did not pass (missing
// evidence, required artifacts, policy/contract/acceptance, etc.) is NOT a courtesy stop — keep blocked.
const GATE_FAILURE_SIGNAL =
  /\b(?:requires?|must (?:include|have|cite|be)|evidence|no executable|memory_promotions|policy_decision|human[_ ]?review|contract|acceptance|missing|invalid|forbidden|verdict|not allowed|exhausted)\b/i;

// Default discriminator (the plan-sanctioned regex floor). The hard gates (flag, floor==courtesy, no high-risk
// token, courtesy signal present) already passed before this runs; here we only separate a generic proceed
// question (continue) from a real gate FAILURE that happened to be fabricated with a courtesy phrasing (stop).
export function defaultStopClassifier({ reason = "", question = "" } = {}) {
  return { decision: GATE_FAILURE_SIGNAL.test(`${reason}\n${question}`) ? "stop" : "continue" };
}

// Returns { decision: "stop" | "continue", reason, floor_gate_kind, llm_verdict, ... }.
export async function classifyStop({
  gateKind = null,
  reason = "",
  question = "",
  env = process.env,
  classifier = defaultStopClassifier,
  timeoutMs = 1500,
} = {}) {
  // ON by default; AIPI_STOP_CLASSIFIER=0 (or false/off) disables and keeps everything blocked.
  if (!isTruthyFlag(env?.[STOP_CLASSIFIER_FLAG] ?? "1")) return stop("classifier_disabled", gateKind);
  // Floor is authority: only a `courtesy` floor is even a downgrade candidate.
  if (gateKind !== "courtesy") return stop("floor_not_courtesy", gateKind);
  const text = `${reason}\n${question}`;
  // Never decide with a high-risk token present.
  if (HIGH_RISK.test(text)) return stop("high_risk_token_present", gateKind);
  // The floor `courtesy` is coarse; without a structured courtesy signal we do NOT downgrade.
  if (!COURTESY_SIGNAL.test(text)) return stop("no_courtesy_signal", gateKind);
  // No model wired => fail-STOP. The floor alone never auto-continues; a model must affirm.
  if (typeof classifier !== "function") return stop("no_classifier", gateKind);

  let verdict;
  try {
    const raw = await withTimeout(classifier({ reason, question, gate_kind: gateKind }), timeoutMs, "stop_classifier_timeout");
    verdict = normalizeStopVerdict(raw);
  } catch (error) {
    return stop("classifier_error", gateKind, { llm_verdict: "error", error: String(error?.message ?? error) });
  }
  // ONLY an explicit continue downgrades; real_gate / retry_infra / unknown all keep blocked.
  if (verdict.decision === "continue") {
    return { decision: "continue", reason: "courtesy_downgrade", floor_gate_kind: gateKind, llm_verdict: "continue", rationale: verdict.reason };
  }
  return stop("classifier_did_not_continue", gateKind, { llm_verdict: verdict.decision });
}

function normalizeStopVerdict(raw) {
  const value = typeof raw === "string" ? { decision: raw } : raw ?? {};
  let decision = String(value.decision ?? value.verdict ?? value.intent ?? "").trim().toLowerCase();
  if (value.continue === true) decision = "continue";
  const known = ["continue", "stop", "real_gate", "retry_infra"].includes(decision) ? decision : "stop";
  return { decision: known === "continue" ? "continue" : "stop", reason: String(value.reason ?? value.rationale ?? known).slice(0, 240) };
}
