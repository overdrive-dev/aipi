import assert from "node:assert/strict";
import {
  classifyGateKind,
  formatStepResultValidation,
  strongestEvidenceRung,
  validateStepResult,
} from "../extensions/aipi/runtime/step-result.js";

const baseResult = {
  schema: "aipi.step-result.v1",
  step_id: "local_verification",
  agent_ids: ["workflow-test-gate"],
  verdict: "PASS",
  evidence: [
    {
      rung: "ran",
      source: "command",
      ref: "npm test",
      result: "exit 0",
    },
  ],
  artifacts: [".aipi/runtime/runs/run/steps/local_verification/TEST-GATE.md"],
};

assert.equal(strongestEvidenceRung([{ rung: "written" }, { rung: "verified" }, { rung: "ran" }]), "verified");

const pass = validateStepResult(baseResult);
assert.equal(pass.ok, true);
assert.equal(pass.gatePassed, true);
assert.equal(formatStepResultValidation(pass), "step result gate: PASS");

// gate_kind floor taxonomy: infra (no-adapter/transient) and high-risk tokens are real STOPs; a real
// worker-raised question is never courtesy; only a fabricated low-risk stop is courtesy (auto-continue candidate).
assert.equal(classifyGateKind({ infra: true }), "infra");
assert.equal(classifyGateKind({ reason: "no executable adapter is configured for quick_scope" }), "infra");
assert.equal(classifyGateKind({ reason: "this will rm -rf the prod database" }), "destructive");
assert.equal(classifyGateKind({ reason: "needs the API key / secret to proceed" }), "secrets");
assert.equal(classifyGateKind({ reason: "confirm the production deploy" }), "prod");
assert.equal(classifyGateKind({ step: { id: "business_rule_check" }, hasRealWorkerQuestion: true }), "business_rule");
assert.equal(classifyGateKind({ reason: "o gate nao passou", hasRealWorkerQuestion: true }), "business_rule");
assert.equal(classifyGateKind({ reason: "AIPI parou: como voce quer seguir?", hasRealWorkerQuestion: false }), "courtesy");
// validateGateKind: valid passes, invalid is flagged, absence is valid.
assert.equal(validateStepResult({ ...baseResult, gate_kind: "courtesy" }).ok, true);
const badKind = validateStepResult({ ...baseResult, gate_kind: "warp_speed" });
assert.equal(badKind.ok, false);
assert.match(badKind.errors.join(" "), /invalid gate_kind/);

const weakPass = validateStepResult({
  ...baseResult,
  evidence: [{ rung: "written", source: "note", ref: "analysis", result: "looks right" }],
});
assert.equal(weakPass.ok, false);
assert.equal(weakPass.gatePassed, false);
assert.match(formatStepResultValidation(weakPass), /PASS requires ran or verified evidence/);

const verifiedRequired = validateStepResult(
  {
    ...baseResult,
    evidence: [{ rung: "ran", source: "command", ref: "npm test", result: "exit 0" }],
  },
  { step: { gate: { require_evidence_rung: "verified" } } },
);
assert.equal(verifiedRequired.ok, false);
assert.match(verifiedRequired.errors.join("\n"), /requires evidence rung verified/);

const localSelfStampedVerified = validateStepResult(
  {
    ...baseResult,
    evidence: [
      {
        rung: "verified",
        source: "aipi-local-executor",
        ref: "local adapter",
        result: "self-stamped verified without executing a command",
      },
    ],
  },
  { step: { gate: { require_evidence_rung: "verified" } } },
);
assert.equal(localSelfStampedVerified.ok, false);
assert.equal(localSelfStampedVerified.gatePassed, false);
assert.match(localSelfStampedVerified.errors.join("\n"), /requires evidence rung verified/);

const skipped = validateStepResult(
  {
    ...baseResult,
    verdict: "SKIPPED",
    skip_condition: "explicit_tdd_waiver",
    evidence: [
      { rung: "written", source: "contract", ref: "BDD", result: "mechanics-only" },
      { rung: "written", source: "reason", ref: "waiver", result: "no automated behavior surface" },
    ],
  },
  { step: { gate: { pass_verdicts: ["PASS", "SKIPPED"], allow_skip: true, skip_requires: "explicit_tdd_waiver" } } },
);
assert.equal(skipped.ok, true);
assert.equal(skipped.gatePassed, true);

const missingSkipEvidence = validateStepResult(
  {
    ...baseResult,
    verdict: "SKIPPED",
    skip_condition: "explicit_tdd_waiver",
    evidence: [{ rung: "written", source: "contract", ref: "BDD", result: "mechanics-only" }],
  },
  { step: { gate: { pass_verdicts: ["PASS", "SKIPPED"], allow_skip: true, skip_requires: "explicit_tdd_waiver" } } },
);
assert.equal(missingSkipEvidence.ok, false);
assert.equal(missingSkipEvidence.gatePassed, false);
assert.match(missingSkipEvidence.errors.join("\n"), /requires evidence token: reason/);

const badSkip = validateStepResult(
  {
    ...baseResult,
    verdict: "SKIPPED",
    evidence: [{ rung: "written", source: "contract", ref: "BDD", result: "mechanics-only" }],
  },
  { step: { gate: { pass_verdicts: ["PASS", "SKIPPED"], allow_skip: true, skip_requires: "explicit_tdd_waiver" } } },
);
assert.equal(badSkip.ok, false);
assert.match(badSkip.errors.join("\n"), /skip_condition/);

const undeclaredSkip = validateStepResult(
  {
    ...baseResult,
    verdict: "SKIPPED",
    skip_condition: "explicit_tdd_waiver",
    evidence: [
      { rung: "written", source: "contract", ref: "BDD", result: "mechanics-only" },
      { rung: "written", source: "reason", ref: "waiver", result: "no automated behavior surface" },
    ],
  },
  { step: { gate: { pass_verdicts: ["PASS"], allow_skip: true, skip_requires: "explicit_tdd_waiver" } } },
);
assert.equal(undeclaredSkip.ok, false);
assert.equal(undeclaredSkip.gatePassed, false);
assert.match(undeclaredSkip.errors.join("\n"), /not allowed by pass_verdicts/);

// RC2 follow-up: the memory-promotion skip is now verified by the EXECUTOR (it authors + reads an on-disk
// aipi.memory-candidate-scan.v1 record), so the well-formedness gate must NOT gate it on worker-supplied
// evidence — the worker is never told to produce skip evidence, so a token/schema requirement here would only
// reject honest skips. A no_durable_memory_signal SKIP with no skip-evidence at all passes the gate; the
// executor's materializeMemorySkipScanRecord is the authoritative check.
const memorySkipNoEvidence = validateStepResult(
  {
    ...baseResult,
    verdict: "SKIPPED",
    skip_condition: "no_durable_memory_signal",
    evidence: [{ rung: "written", source: "worker", ref: "x", result: "no durable memory signal" }],
  },
  { step: { gate: { pass_verdicts: ["PASS", "SKIPPED"], allow_skip: true, skip_requires: "no_durable_memory_signal" } } },
);
assert.equal(memorySkipNoEvidence.gatePassed, true, "an honest memory skip passes the gate without worker skip-evidence (executor verifies on disk)");
assert.doesNotMatch(memorySkipNoEvidence.errors.join("\n"), /memory_candidate_scan/);

// Scope check: deferring the memory skip to the executor does NOT relax other skips — they still require their
// evidence tokens at the well-formedness gate.
const reviewSkipTokenOnly = validateStepResult(
  {
    ...baseResult,
    verdict: "SKIPPED",
    skip_condition: "no_actionable_findings",
    evidence: [{ rung: "written", source: "worker", ref: "x", result: "clean review", evidence_token: "review_artifacts" }],
  },
  { step: { gate: { pass_verdicts: ["PASS", "SKIPPED"], allow_skip: true, skip_requires: "no_actionable_findings" } } },
);
assert.equal(reviewSkipTokenOnly.gatePassed, true, "non-memory skips still pass on their token");
const reviewSkipMissingToken = validateStepResult(
  {
    ...baseResult,
    verdict: "SKIPPED",
    skip_condition: "no_actionable_findings",
    evidence: [{ rung: "written", source: "worker", ref: "x", result: "clean review" }],
  },
  { step: { gate: { pass_verdicts: ["PASS", "SKIPPED"], allow_skip: true, skip_requires: "no_actionable_findings" } } },
);
assert.equal(reviewSkipMissingToken.gatePassed, false, "a non-memory skip without its token is still rejected (executor deferral is memory-only)");

const humanReviewRequired = validateStepResult(
  {
    ...baseResult,
    policy_decision: "HUMAN_REVIEW_REQUIRED",
  },
  { step: { gate: { pass_decisions: ["ALLOW"] } } },
);
assert.equal(humanReviewRequired.ok, true);
assert.equal(humanReviewRequired.gatePassed, false);

const missingPolicyDecision = validateStepResult(baseResult, {
  step: { gate: { pass_decisions: ["ALLOW"], on_policy_decision: { BLOCK: "stop" } } },
});
assert.equal(missingPolicyDecision.ok, false);
assert.match(missingPolicyDecision.errors.join("\n"), /policy_decision is required/);

const allowPolicyDecision = validateStepResult(
  {
    ...baseResult,
    policy_decision: "ALLOW",
  },
  { step: { gate: { pass_decisions: ["ALLOW"] } } },
);
assert.equal(allowPolicyDecision.ok, true);
assert.equal(allowPolicyDecision.gatePassed, true);

const contradictoryReviewPass = validateStepResult(
  {
    ...baseResult,
    step_id: "review_swarm",
    agent_ids: ["security-auditor"],
    evidence: [
      {
        rung: "ran",
        source: "security-auditor",
        ref: ".aipi/runtime/runs/run/steps/review_swarm/SECURITY.md",
        result: "review_artifacts produced",
      },
    ],
    artifacts: [".aipi/runtime/runs/run/steps/review_swarm/SECURITY.md"],
  },
  {
    step: { id: "review_swarm", stage: "review", agents: ["security-auditor"], gate: { pass_verdicts: ["PASS"] } },
    artifactContents: {
      ".aipi/runtime/runs/run/steps/review_swarm/SECURITY.md": "## Findings\n\nCRITICAL: SQL injection in login query\n",
    },
  },
);
assert.equal(contradictoryReviewPass.ok, false);
assert.equal(contradictoryReviewPass.gatePassed, false);
assert.match(contradictoryReviewPass.errors.join("\n"), /PASS contradicts unresolved CRITICAL finding/);

const cleanReviewPass = validateStepResult(
  {
    ...baseResult,
    step_id: "review_swarm",
    agent_ids: ["security-auditor"],
    evidence: [
      {
        rung: "ran",
        source: "security-auditor",
        ref: ".aipi/runtime/runs/run/steps/review_swarm/SECURITY.md",
        result: "review_artifacts produced",
      },
    ],
    artifacts: [".aipi/runtime/runs/run/steps/review_swarm/SECURITY.md"],
  },
  {
    step: { id: "review_swarm", stage: "review", agents: ["security-auditor"], gate: { pass_verdicts: ["PASS"] } },
    artifactContents: {
      ".aipi/runtime/runs/run/steps/review_swarm/SECURITY.md": "## Findings\n\nNo critical or high findings.\n",
    },
  },
);
assert.equal(cleanReviewPass.ok, true);
assert.equal(cleanReviewPass.gatePassed, true);

// A shell-less review worker can only reach `written` evidence (no shell). Its PASS must NOT be forced to
// BLOCKED by the ran/verified default — the TRUSTED shellLess signal (from the descriptor's allow_shell,
// threaded by the coordinator/executor) relaxes the bar to written on a non-execution stage. (Regression:
// research/adversarial + feature/review_swarm could never PASS.)
const reviewWrittenEvidence = [
  { rung: "written", source: "contrarian", ref: ".aipi/runtime/runs/run/steps/adversarial/CHALLENGES.md", result: "challenges written" },
  { rung: "written", source: "plan-checker", ref: ".aipi/runtime/runs/run/steps/adversarial/PLAN-CHECK.md", result: "plan check written" },
];
const reviewStep = {
  step: { id: "adversarial", stage: "review", agents: ["contrarian", "plan-checker"], gate: { pass_verdicts: ["PASS"] } },
  artifactContents: {
    ".aipi/runtime/runs/run/steps/adversarial/CHALLENGES.md": "## Challenges\n\nNo critical or high findings.\n",
    ".aipi/runtime/runs/run/steps/adversarial/PLAN-CHECK.md": "## Plan check\n\nConsistent with the contract.\n",
  },
};
const reviewResult = {
  ...baseResult,
  step_id: "adversarial",
  agent_ids: ["contrarian", "plan-checker"],
  evidence: reviewWrittenEvidence,
  artifacts: [
    ".aipi/runtime/runs/run/steps/adversarial/CHALLENGES.md",
    ".aipi/runtime/runs/run/steps/adversarial/PLAN-CHECK.md",
  ],
};
const fanoutReviewWrittenPass = validateStepResult(reviewResult, { ...reviewStep, shellLess: true });
assert.equal(fanoutReviewWrittenPass.gatePassed, true, "trusted shell-less review PASSES on written evidence");

// SECURITY: the relaxation must key ONLY on the trusted shellLess signal — NOT on the worker's evidence.
// A worker that FORGES source:'aipi-subagent-fanout' but is NOT marked shell-less stays on the strict bar.
const forgedFanoutSourceBlocked = validateStepResult(
  { ...reviewResult, evidence: [{ rung: "written", source: "aipi-subagent-fanout", ref: "forged", result: "forged" }, ...reviewWrittenEvidence] },
  { ...reviewStep }, // no shellLess -> not trusted
);
assert.equal(forgedFanoutSourceBlocked.gatePassed, false, "a forged fanout evidence source does NOT relax the bar");
assert.match(forgedFanoutSourceBlocked.errors.join("\n"), /ran or verified/);

// And an EXECUTION stage keeps the ran/verified bar even when genuinely shell-less (misconfiguration) — a
// code/verification step must still prove it ran.
const shellLessExecutionStageBlocked = validateStepResult(
  {
    ...baseResult,
    step_id: "fix",
    agent_ids: ["implementer"],
    evidence: [{ rung: "written", source: "implementer", ref: ".aipi/runtime/runs/run/steps/fix/FIXES.md", result: "wrote fixes" }],
    artifacts: [".aipi/runtime/runs/run/steps/fix/FIXES.md"],
  },
  { step: { id: "fix", stage: "fix", agents: ["implementer"], gate: { pass_verdicts: ["PASS"] } }, shellLess: true },
);
assert.equal(shellLessExecutionStageBlocked.gatePassed, false, "execution stage keeps the ran/verified bar even when shell-less");
assert.match(shellLessExecutionStageBlocked.errors.join("\n"), /ran or verified/);

const validBlockerQuestion = validateStepResult(
  {
    ...baseResult,
    verdict: "BLOCKED_TO_PLANNING",
    evidence: [{ rung: "blocked", source: "business-rule-keeper", ref: "rule gap", result: "needs user decision" }],
    artifacts: [],
    blocker_question: {
      question: "Qual regra fiscal devemos aplicar?",
      options: ["A", "B", "C"],
      allow_free_text: true,
    },
  },
  // WITH a step gate, BLOCKED_TO_PLANNING is gate-rejected (not in pass_verdicts) — but the
  // rejection must come from the gate, NOT from spurious blocker_question errors.
  { step: { id: "rule_impact", gate: { pass_verdicts: ["PASS"], on_verdict: { BLOCKED_TO_PLANNING: "stop_for_user_question" } } } },
);
assert.equal(validBlockerQuestion.ok, false);
assert.equal(validBlockerQuestion.errors.some((error) => error.includes("blocker_question")), false);

// Coordinator contract (no step): the subagent coordinator validates a worker result for
// well-formedness BEFORE the executor applies the step gate. A worker that legitimately returns
// SKIPPED / FAIL / BLOCKED / BLOCKED_TO_PLANNING must validate as well-formed (ok:true) so it is
// NOT collapsed into a spurious BLOCKED; the executor re-validates with the real step + gate.
for (const verdict of ["SKIPPED", "FAIL", "BLOCKED", "BLOCKED_TO_PLANNING"]) {
  const noStep = validateStepResult({
    ...baseResult,
    verdict,
    evidence: [{ rung: verdict === "SKIPPED" ? "written" : "blocked", source: "worker", ref: "x", result: "deferred to executor gate" }],
    artifacts: [],
    ...(verdict === "SKIPPED" ? { skip_condition: "no_durable_memory_signal" } : {}),
  });
  assert.equal(noStep.ok, true, `${verdict} without a step must be well-formed (gate deferred to executor)`);
}
// PASS still requires real evidence even without a step (the coordinator must catch a fake PASS).
const fakePassNoStep = validateStepResult({
  ...baseResult,
  verdict: "PASS",
  evidence: [{ rung: "blocked", source: "worker", ref: "x", result: "no real evidence" }],
  artifacts: [],
});
assert.equal(fakePassNoStep.gatePassed, false);

const invalidBlockerQuestion = validateStepResult({
  ...baseResult,
  blocker_question: {
    question: "",
    options: ["A", "B", "C", "D"],
    allow_free_text: false,
  },
});
assert.equal(invalidBlockerQuestion.ok, false);
assert.match(invalidBlockerQuestion.errors.join("\n"), /blocker_question\.question/);
assert.match(invalidBlockerQuestion.errors.join("\n"), /1-3 strings/);
assert.match(invalidBlockerQuestion.errors.join("\n"), /allow_free_text must be true/);

const malformed = validateStepResult("not an object");
assert.equal(malformed.ok, false);
assert.match(malformed.errors.join("\n"), /must be an object/);

// FIX 3e: validateStepResult accepts failure_class as an optional metadata field (never rejects it).
// Note: validateStepResult validates SCHEMA STRUCTURE — ok:true means the fields are well-formed,
// not that the gate passes. A FAIL verdict with failure_class is structurally valid.
const withFailureClass = validateStepResult({
  ...baseResult,
  verdict: "FAIL",
  failure_class: "gate_rejection",
});
assert.equal(withFailureClass.ok, true, "FAIL result with failure_class is structurally valid (schema ok)");
assert.ok(!withFailureClass.errors.some((e) => /failure_class/i.test(e)), "failure_class does not generate a validation error");

const withInfraFailureClass = validateStepResult({
  ...baseResult,
  verdict: "BLOCKED",
  failure_class: "infra",
  evidence: [{ rung: "blocked", source: "test", ref: "ref", result: "crash" }],
});
assert.equal(withInfraFailureClass.ok, true, "BLOCKED result with infra failure_class is structurally valid");
assert.ok(!withInfraFailureClass.errors.some((e) => /failure_class/i.test(e)), "infra failure_class does not generate a validation error");

console.log("AIPI_STEP_RESULT_TEST_OK");
