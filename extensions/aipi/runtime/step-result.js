const defaultContract = {
  stepResultSchema: {
    id: "aipi.step-result.v1",
    required: ["schema", "step_id", "agent_ids", "verdict", "evidence", "artifacts"],
    // Additive, optional provenance stamped by the coordinator (backward compatible —
    // absence is valid). Surfaces model-class resolution so a swap can't hide.
    optional: [
      "model_requested",
      "model_resolved",
      "model_fallback",
      "model_warning",
      "model_host",
      "model_family",
      "model_cross_family",
      "models",
      "blocker_question",
      "awaiting_user_input",
      "aipi_shell_less",
      "gate_kind",
    ],
  },
  stepVerdicts: ["PASS", "FAIL", "SKIPPED", "BLOCKED", "BLOCKED_TO_PLANNING"],
  evidenceRungs: ["written", "ran", "verified", "blocked"],
  policyDecisions: ["ALLOW", "BLOCK", "HUMAN_REVIEW_REQUIRED"],
  skipConditions: {
    explicit_tdd_waiver: { requiresEvidence: ["contract", "reason"] },
    no_actionable_findings: { requiresEvidence: ["review_artifacts"] },
    no_deployment_surface: { requiresEvidence: ["changed_surface"] },
    no_durable_memory_signal: { requiresEvidence: ["memory_candidate_scan"] },
    no_external_unknowns: { requiresEvidence: ["context_packet"] },
    not_homolog_or_no_ui_flow: { requiresEvidence: ["ops_classification"] },
    no_internal_context: { requiresEvidence: ["scope"] },
    no_external_research_needed: { requiresEvidence: ["scope", "context_packet"] },
  },
};

// RC2: a memory-promotion SKIP (no_durable_memory_signal) must be backed by a STRUCTURED scan record of this
// exact schema — not a bare evidence token a worker can mention for free — so "no durable signal" is an
// auditable claim that the step actually scanned and found nothing, never a silent way to promote zero.
export const MEMORY_CANDIDATE_SCAN_SCHEMA = "aipi.memory-candidate-scan.v1";

const evidenceRank = new Map([
  ["written", 1],
  ["ran", 2],
  ["verified", 3],
  ["blocked", 0],
]);

const nonExecutingEvidenceSources = new Set([
  "aipi-local-executor",
  "aipi-subagent-fanout",
]);

// Stages whose deliverable IS running code — a PASS legitimately requires ran/verified evidence even when a
// worker is shell-less. Defense-in-depth: a worker is only ever marked shell-less for a parallel REVIEW
// fanout (never a code/verify step), so these should never be shell-less in practice — but if one ever is
// (misconfiguration), keep it on the strict bar rather than accepting `written`.
const executionEvidenceStages = new Set([
  "implementation",
  "fix",
  "tdd",
  "local-verification",
  "final-verification",
  "regression",
  "homolog",
  "ops",
  "deployment-plan",
]);

function requiresExecutionEvidence(step) {
  return executionEvidenceStages.has(String(step?.stage ?? "").toLowerCase());
}

const reviewArtifactNamePattern = /(^|[/\\])(?:CODE-REVIEW|SECURITY|DEV-REVIEW|HUMAN-REVIEW|COMPLEXITY-REVIEW|INTEGRATION|BLAST-RADIUS|PLAN-REVIEW)(?:\.[A-Za-z0-9_-]+)?$/i;
const reviewAgentPattern = /\b(review|reviewer|auditor|adversarial|contrarian|security|blast-radius|integration-checker|complexity-reviewer)\b/i;
const actionableFindingPattern = /\b(?:CRITICAL|HIGH|BLOCKER|P0|P1)\b\s*(?:[:\]-]|finding|issue|risk|vulnerability|bug)/i;
const findingLabelPattern = /\b(?:severity|impact|priority)\s*[:=]\s*(?:CRITICAL|HIGH|BLOCKER|P0|P1)\b/i;
const resolvedFindingPattern = /\b(?:resolved|fixed|mitigated|closed|not\s+applicable|none|no)\b.*\b(?:CRITICAL|HIGH|BLOCKER|P0|P1)\b|\b(?:CRITICAL|HIGH|BLOCKER|P0|P1)\b.*\b(?:resolved|fixed|mitigated|closed|none|0)\b/i;

// Gate-kind taxonomy: the deterministic FLOOR for a blocked-gate stop. It is the authority that says STOP;
// the optional stop-classifier (AIPI_STOP_CLASSIFIER) may only DOWNGRADE a `courtesy` floor to continue,
// never the reverse, and never when any non-courtesy kind is present.
// - infra        = no-executable-adapter / transient provider failure. The step's work did NOT run; it must
//                  retry/fail-loud and NEVER auto-continue (would skip an unexecuted task — adversarial claim D).
// - destructive/secrets/prod/business_rule = a REAL gate; only a human resolves it.
// - courtesy     = a FABRICATED low-risk Sink-B stop the worker never raised, with zero high-risk tokens.
//                  The ONLY auto-continue candidate.
export const GATE_KINDS = Object.freeze(["destructive", "secrets", "prod", "business_rule", "courtesy", "infra"]);

const GATE_KIND_INFRA = /no executable adapter|refusing to self-stamp|transient|provider (?:error|failure|unavailable)|rate.?limit|timed?\s*out|timeout/i;
const GATE_KIND_DESTRUCTIVE = /\b(?:destructive|destrut\w*|delete|deletar|drop|truncate|overwrit\w*|irreversible|irrevers\w*|apagar|excluir|wipe|purge)\b|rm\s+-rf/i;
const GATE_KIND_SECRETS = /\b(?:secret|secrets|segredo|credential|credenc\w*|password|senha|api[_-]?key|private\s+key)\b|\.env\b/i;
const GATE_KIND_PROD = /\b(?:prod|production|produc\w*|deploy\w*|release|migration|migrac\w*|rollback|homolog\w*)\b/i;
const GATE_KIND_BUSINESS = /\b(?:business[_-]?rule|policy|pol[ií]tica|compliance|scope|escopo|pricing|billing|faturament\w*|cobran\w*)\b|regra de neg\w*/i;

// Classify a blocked-gate stop into the floor taxonomy. Conservative by construction: any high-risk token,
// or a real worker-raised question, is a non-courtesy (real) gate; only a fabricated low-risk stop with no
// worker question is `courtesy`. `infra` is asserted by the caller for the no-adapter/transient sink.
export function classifyGateKind({ reason = "", question = "", step = null, hasRealWorkerQuestion = false, infra = false } = {}) {
  if (infra) return "infra";
  const text = `${reason}\n${question}\n${step?.id ?? ""}\n${step?.stage ?? ""}`;
  if (GATE_KIND_INFRA.test(text)) return "infra";
  if (GATE_KIND_DESTRUCTIVE.test(text)) return "destructive";
  if (GATE_KIND_SECRETS.test(text)) return "secrets";
  if (GATE_KIND_PROD.test(text)) return "prod";
  if (GATE_KIND_BUSINESS.test(text)) return "business_rule";
  return hasRealWorkerQuestion ? "business_rule" : "courtesy";
}

export function validateStepResult(result, { step = null, contract = defaultContract, artifactContents = null, shellLess = false } = {}) {
  const errors = [];
  const warnings = [];
  const schema = contract.stepResultSchema ?? defaultContract.stepResultSchema;

  if (!isPlainObject(result)) {
    return {
      ok: false,
      gatePassed: false,
      verdict: null,
      policyDecision: null,
      errors: ["step result must be an object"],
      warnings,
    };
  }

  for (const field of schema.required ?? []) {
    if (!(field in result)) errors.push(`missing required field: ${field}`);
  }

  if (result.schema !== schema.id) {
    errors.push(`invalid schema: ${result.schema ?? "missing"}`);
  }

  const validVerdicts = new Set(contract.stepVerdicts ?? defaultContract.stepVerdicts);
  if (!validVerdicts.has(result.verdict)) {
    errors.push(`invalid verdict: ${result.verdict ?? "missing"}`);
  }

  if (!Array.isArray(result.agent_ids) || result.agent_ids.length === 0) {
    errors.push("agent_ids must be a non-empty array");
  }

  if (!Array.isArray(result.evidence)) {
    errors.push("evidence must be an array");
  } else {
    validateEvidence(result.evidence, contract, errors);
  }

  if (!Array.isArray(result.artifacts)) {
    errors.push("artifacts must be an array");
  }

  validateModelProvenance(result, errors);
  validateBlockerQuestion(result, errors);
  validateGateKind(result, errors);
  validateReviewArtifacts(result, step, artifactContents, errors);

  const policyDecision = result.policy_decision ?? null;
  if (!policyDecision && stepRequiresPolicyDecision(step)) {
    errors.push("policy_decision is required for policy decision gates");
  }
  if (policyDecision) {
    const validPolicyDecisions = new Set(contract.policyDecisions ?? defaultContract.policyDecisions);
    if (!validPolicyDecisions.has(policyDecision)) {
      errors.push(`invalid policy_decision: ${policyDecision}`);
    }
  }

  const gatePassed =
    errors.length === 0 &&
    verdictPasses(result, step, contract, errors, warnings, shellLess) &&
    policyDecisionPasses(policyDecision, step);

  return {
    ok: errors.length === 0,
    gatePassed,
    verdict: result.verdict ?? null,
    policyDecision,
    errors,
    warnings,
  };
}

export function reviewArtifactFindings(result, { step = null, artifactContents = null } = {}) {
  if (result?.verdict !== "PASS") return [];
  if (!isReviewGateStep(step, result)) return [];
  if (!artifactContents || typeof artifactContents !== "object") return [];

  const findings = [];
  for (const [artifact, content] of Object.entries(artifactContents)) {
    if (!isReviewArtifactPath(artifact)) continue;
    const finding = firstUnresolvedHighSeverityFinding(content);
    if (finding) findings.push({ artifact, ...finding });
  }
  return findings;
}

export function strongestEvidenceRung(evidence = []) {
  let strongest = null;
  let rank = -1;
  for (const item of evidence) {
    const itemRank = evidenceRank.get(item?.rung) ?? -1;
    if (itemRank > rank) {
      strongest = item?.rung ?? null;
      rank = itemRank;
    }
  }
  return strongest;
}

export function formatStepResultValidation(validation) {
  if (validation.gatePassed) return "step result gate: PASS";
  const lines = [`step result gate: BLOCKED (${validation.verdict ?? "no verdict"})`];
  for (const error of validation.errors) lines.push(`- error: ${error}`);
  for (const warning of validation.warnings) lines.push(`- warning: ${warning}`);
  return lines.join("\n");
}

function validateEvidence(evidence, contract, errors) {
  const validRungs = new Set(contract.evidenceRungs ?? defaultContract.evidenceRungs);
  for (const [index, item] of evidence.entries()) {
    if (!isPlainObject(item)) {
      errors.push(`evidence[${index}] must be an object`);
      continue;
    }
    if (!validRungs.has(item.rung)) errors.push(`evidence[${index}] has invalid rung: ${item.rung}`);
    if (!item.source) errors.push(`evidence[${index}] missing source`);
    if (!item.ref) errors.push(`evidence[${index}] missing ref`);
    if (!item.result) errors.push(`evidence[${index}] missing result`);
  }
}

function validateReviewArtifacts(result, step, artifactContents, errors) {
  const findings = reviewArtifactFindings(result, { step, artifactContents });
  for (const finding of findings) {
    errors.push(`PASS contradicts unresolved ${finding.severity} finding in review artifact ${finding.artifact}: ${finding.preview}`);
  }
}

function isReviewGateStep(step, result) {
  if (String(step?.stage ?? "").toLowerCase() === "review") return true;
  if (/\breview\b/i.test(String(step?.id ?? ""))) return true;
  if ((step?.agents ?? result?.agent_ids ?? []).some((agentId) => reviewAgentPattern.test(String(agentId)))) return true;
  return (result?.artifacts ?? []).some(isReviewArtifactPath);
}

function isReviewArtifactPath(artifact) {
  return reviewArtifactNamePattern.test(String(artifact ?? ""));
}

function firstUnresolvedHighSeverityFinding(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const severity = findingSeverity(line);
    if (!severity) continue;
    const windowText = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join(" ");
    if (resolvedFindingPattern.test(windowText)) continue;
    return {
      severity,
      line: index + 1,
      preview: line.trim().slice(0, 180),
    };
  }
  return null;
}

function findingSeverity(line) {
  const text = String(line ?? "");
  if (!actionableFindingPattern.test(text) && !findingLabelPattern.test(text)) return null;
  const match = text.match(/\b(CRITICAL|HIGH|BLOCKER|P0|P1)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function verdictPasses(result, step, contract, errors, warnings, shellLess = false) {
  const declaredPassVerdicts = passVerdictsForStep(step);
  // Verdict-ALLOWANCE (is this verdict accepted by THIS step's pass_verdicts / allow_skip) is a
  // STEP-GATE decision. The subagent coordinator validates a worker result for well-formedness
  // WITHOUT a step (the workflow executor re-validates with the real step + gate at the next stage),
  // so when there is no step we check only structural quality — PASS still needs evidence — and DEFER
  // gate allowance to the executor. Otherwise a worker legitimately returning SKIPPED / FAIL / BLOCKED
  // would be rejected as "invalid" by the coordinator and collapse into a spurious BLOCKED step,
  // which would re-trap the user the moment any real step skips or fails.
  if (step && !declaredPassVerdicts.has(result.verdict)) {
    errors.push(`verdict ${result.verdict} is not allowed by pass_verdicts: ${[...declaredPassVerdicts].join(", ")}`);
    return false;
  }

  if (result.verdict === "PASS") {
    return passEvidenceRule(result, step, errors, shellLess);
  }

  if (result.verdict === "SKIPPED") {
    // No step gate context (coordinator well-formedness pass): accept the skip shape and let the
    // executor enforce allow_skip / skip_requires against the real step.
    if (!step) return true;
    if (step.gate?.allow_skip !== true) {
      errors.push("SKIPPED is allowed only when the step gate declares allow_skip: true");
      return false;
    }
    if (step.gate.skip_requires && result.skip_condition !== step.gate.skip_requires) {
      errors.push(`SKIPPED must cite skip_condition: ${step.gate.skip_requires}`);
      return false;
    }
    const evidenceOk = skipEvidenceRule(result, step, contract, errors);
    if (evidenceOk) warnings.push("SKIPPED passed only through an explicit workflow skip gate");
    return evidenceOk;
  }

  // FAIL / BLOCKED / BLOCKED_TO_PLANNING are well-formed verdicts that simply do not PASS the gate;
  // without a step there is no gate to fail here, so defer the routing decision to the executor.
  if (!step) return true;
  errors.push(`verdict ${result.verdict} is listed in pass_verdicts but cannot pass this runtime gate`);
  return false;
}

function passVerdictsForStep(step) {
  const declared = Array.isArray(step?.gate?.pass_verdicts) ? step.gate.pass_verdicts : [];
  return new Set(declared.length ? declared : ["PASS"]);
}

function skipEvidenceRule(result, step, contract, errors) {
  const skipCondition = step?.gate?.skip_requires ?? result.skip_condition ?? null;
  if (!skipCondition) {
    errors.push("SKIPPED must cite a registered skip_condition");
    return false;
  }

  const skipConditions = contract.skipConditions ?? defaultContract.skipConditions;
  const rule = skipConditions?.[skipCondition] ?? null;
  if (!rule) {
    errors.push(`SKIPPED cites unknown skip_condition: ${skipCondition}`);
    return false;
  }

  const required = Array.isArray(rule.requiresEvidence) ? rule.requiresEvidence : [];
  if (!required.length) return true;

  const covered = new Set();
  for (const item of result.evidence ?? []) {
    const explicit = [
      item?.evidence_type,
      item?.evidence_token,
      item?.skip_evidence,
      ...(Array.isArray(item?.covers) ? item.covers : []),
    ].filter(Boolean);
    for (const token of explicit) covered.add(String(token));

    const text = `${item?.source ?? ""} ${item?.ref ?? ""} ${item?.result ?? ""}`;
    for (const token of required) {
      if (tokenMentioned(text, token)) covered.add(token);
    }
  }

  let ok = true;
  for (const token of required) {
    if (!covered.has(token)) {
      errors.push(`SKIPPED ${skipCondition} requires evidence token: ${token}`);
      ok = false;
    }
  }

  // Scoped strictly to the memory-promotion skip: beyond the token, require a STRUCTURED scan record declaring
  // the aipi.memory-candidate-scan.v1 schema. This is the RC2 teeth that stop a memory-promotion step from
  // claiming "no durable signal" with only a free-text token. Other skip conditions keep the token-only rule.
  if (skipCondition === "no_durable_memory_signal") {
    const hasScanRecord = (result.evidence ?? []).some((item) =>
      item?.schema === MEMORY_CANDIDATE_SCAN_SCHEMA
      || item?.evidence_schema === MEMORY_CANDIDATE_SCAN_SCHEMA
      || item?.evidence_type === MEMORY_CANDIDATE_SCAN_SCHEMA);
    if (!hasScanRecord) {
      errors.push(`SKIPPED ${skipCondition} requires a structured ${MEMORY_CANDIDATE_SCAN_SCHEMA} scan record (an evidence token alone is not enough)`);
      ok = false;
    }
  }
  return ok;
}

function tokenMentioned(text, token) {
  const escaped = escapeRegExp(String(token));
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "i").test(String(text ?? ""));
}

function passEvidenceRule(result, step, errors, shellLess = false) {
  const strongest = strongestGateEvidenceRung(result.evidence);
  const required = step?.gate?.require_evidence_rung ?? null;

  if (required) {
    const requiredRank = evidenceRank.get(required) ?? Number.POSITIVE_INFINITY;
    const strongestRank = evidenceRank.get(strongest) ?? -1;
    if (strongestRank < requiredRank) {
      errors.push(`PASS requires evidence rung ${required} or stronger`);
      return false;
    }
    return true;
  }

  // A shell-LESS worker (a parallel review fanout — it reads sources and WRITES findings, it has no shell)
  // can never reach ran/verified, so the ran/verified default below would force every honest PASS to BLOCKED.
  // Accept `written` for it. `shellLess` is a TRUSTED signal threaded from the descriptor's allow_shell flag
  // by the coordinator/executor — NEVER derived from the worker's own evidence (which the worker controls and
  // could forge: source/rung are not authoritative). Execution stages keep the strict bar even if somehow
  // shell-less, so a misconfigured code/verify step can't pass on `written`.
  if (shellLess && !requiresExecutionEvidence(step)) {
    if (strongest === null) {
      errors.push("PASS requires at least written evidence (a review artifact)");
      return false;
    }
    return true;
  }

  if (strongest !== "ran" && strongest !== "verified") {
    errors.push("PASS requires ran or verified evidence unless the step declares a stronger specific requirement");
    return false;
  }
  return true;
}

function strongestGateEvidenceRung(evidence = []) {
  let strongest = null;
  let rank = -1;
  for (const item of evidence) {
    const rung = gateEvidenceRung(item);
    const itemRank = evidenceRank.get(rung) ?? -1;
    if (itemRank > rank) {
      strongest = rung;
      rank = itemRank;
    }
  }
  return strongest;
}

function gateEvidenceRung(item) {
  if (
    nonExecutingEvidenceSources.has(item?.source) &&
    (item?.rung === "ran" || item?.rung === "verified")
  ) {
    return "written";
  }
  return item?.rung ?? null;
}

function policyDecisionPasses(policyDecision, step) {
  if (!policyDecision) return true;
  const passDecisions = new Set(step?.gate?.pass_decisions ?? ["ALLOW"]);
  return passDecisions.has(policyDecision);
}

function stepRequiresPolicyDecision(step) {
  const gate = step?.gate ?? {};
  return Boolean(
    gate.pass_decisions?.length ||
      gate.approval_decisions?.length ||
      gate.block_decisions?.length ||
      Object.keys(gate.on_policy_decision ?? {}).length,
  );
}

// Optional, additive model-provenance fields stamped by the coordinator. Absence is
// valid (backward compatible); when present they must be well-typed.
function validateModelProvenance(result, errors) {
  if ("model_requested" in result && result.model_requested != null && typeof result.model_requested !== "string") {
    errors.push("model_requested must be a string or null when present");
  }
  if ("model_resolved" in result && typeof result.model_resolved !== "string") {
    errors.push("model_resolved must be a string when present");
  }
  if ("model_fallback" in result && typeof result.model_fallback !== "boolean") {
    errors.push("model_fallback must be a boolean when present");
  }
  if ("model_host" in result && result.model_host != null && typeof result.model_host !== "string") {
    errors.push("model_host must be a string or null when present");
  }
  if ("model_family" in result && result.model_family != null && typeof result.model_family !== "string") {
    errors.push("model_family must be a string or null when present");
  }
  if ("model_cross_family" in result && typeof result.model_cross_family !== "boolean") {
    errors.push("model_cross_family must be a boolean when present");
  }
  // Aggregate (review-fanout) provenance: one entry per worker, each self-describing.
  if ("models" in result && result.models != null) {
    if (!Array.isArray(result.models)) {
      errors.push("models must be an array when present");
    } else if (!result.models.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
      errors.push("models entries must be objects when present");
    }
  }
}

// Optional, additive blocker prompt metadata. It is used only when the workflow
// branches to stop_for_user_question; ordinary historical blockers without this
// object remain valid.
function validateBlockerQuestion(result, errors) {
  for (const field of ["blocker_question", "awaiting_user_input"]) {
    if (!(field in result) || result[field] == null) continue;
    const value = result[field];
    if (!isPlainObject(value)) {
      errors.push(`${field} must be an object when present`);
      continue;
    }
    if (typeof value.question !== "string" || !value.question.trim()) {
      errors.push(`${field}.question must be a non-empty string`);
    }
    if ("options" in value) {
      if (!Array.isArray(value.options)) {
        errors.push(`${field}.options must be an array when present`);
      } else {
        if (value.options.length < 1 || value.options.length > 3) {
          errors.push(`${field}.options must contain 1-3 strings`);
        }
        for (const [index, option] of value.options.entries()) {
          if (typeof option !== "string" || !option.trim()) {
            errors.push(`${field}.options[${index}] must be a non-empty string`);
          }
        }
      }
    }
    if ("allow_free_text" in value && value.allow_free_text !== true) {
      errors.push(`${field}.allow_free_text must be true when present`);
    }
  }
}

// Optional, additive gate-kind taxonomy. Absence is valid; when present (top-level or on a blocker/awaiting
// object) it must be a registered kind.
function validateGateKind(result, errors) {
  const kinds = new Set(GATE_KINDS);
  if ("gate_kind" in result && result.gate_kind != null && !kinds.has(result.gate_kind)) {
    errors.push(`invalid gate_kind: ${result.gate_kind}`);
  }
  for (const field of ["blocker_question", "awaiting_user_input"]) {
    const value = result[field];
    if (isPlainObject(value) && "gate_kind" in value && value.gate_kind != null && !kinds.has(value.gate_kind)) {
      errors.push(`${field}.gate_kind is invalid: ${value.gate_kind}`);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
