import assert from "node:assert/strict";
import {
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

console.log("AIPI_STEP_RESULT_TEST_OK");
