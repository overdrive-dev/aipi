import assert from "node:assert/strict";
import { classifyStop, STOP_CLASSIFIER_FLAG } from "../extensions/aipi/runtime/stop-classifier.js";

const ON = { [STOP_CLASSIFIER_FLAG]: "1" };
const OFF = { [STOP_CLASSIFIER_FLAG]: "0" };
const courtesy = { gateKind: "courtesy", reason: "AIPI parou: como voce quer seguir?", question: "Mantenho o ritmo de checkpoints ou sigo?" };
const yes = async () => ({ decision: "continue" });
const no = async () => ({ decision: "stop" });

// Explicit AIPI_STOP_CLASSIFIER=0 => fail-STOP, even with a classifier that would continue.
assert.equal((await classifyStop({ ...courtesy, env: OFF, classifier: yes })).decision, "stop");
assert.equal((await classifyStop({ ...courtesy, env: OFF, classifier: yes })).reason, "classifier_disabled");

// ON by default (env unset): the deterministic discriminator continues a generic courtesy stop out of the box.
assert.equal((await classifyStop({ ...courtesy, env: {} })).decision, "continue");
assert.equal((await classifyStop({ ...courtesy, env: {} })).reason, "courtesy_downgrade");
// ...but keeps blocked when the reason reads like a real gate FAILURE (no flag, no model, deterministic default).
assert.equal(
  (await classifyStop({ gateKind: "courtesy", reason: "PASS requires memory_promotions", question: "Como voce quer seguir?", env: {} })).decision,
  "stop",
);

// Floor is authority: a non-courtesy gate is never a downgrade candidate, even flag-on + continue.
for (const gateKind of ["infra", "destructive", "secrets", "prod", "business_rule"]) {
  const r = await classifyStop({ gateKind, reason: "x", question: "como voce quer seguir?", env: ON, classifier: yes });
  assert.equal(r.decision, "stop", `${gateKind} must keep blocked`);
  assert.equal(r.reason, "floor_not_courtesy");
}

// Defense in depth: a high-risk token present keeps blocked even on a courtesy floor.
assert.equal(
  (await classifyStop({ gateKind: "courtesy", reason: "continue and deploy to prod?", question: "seguir?", env: ON, classifier: yes })).reason,
  "high_risk_token_present",
);

// No structured courtesy signal => keep blocked (the floor courtesy is coarse).
assert.equal(
  (await classifyStop({ gateKind: "courtesy", reason: "the gate did not pass", question: "", env: ON, classifier: yes })).reason,
  "no_courtesy_signal",
);

// Un-wired (no model callback) => fail-STOP, even with flag on + courtesy + signal.
assert.equal((await classifyStop({ ...courtesy, env: ON, classifier: null })).reason, "no_classifier");

// Model throws / times out => fail-STOP.
assert.equal((await classifyStop({ ...courtesy, env: ON, classifier: async () => { throw new Error("boom"); } })).reason, "classifier_error");
assert.equal(
  (await classifyStop({ ...courtesy, env: ON, classifier: () => new Promise(() => {}), timeoutMs: 20 })).reason,
  "classifier_error",
);

// Model says stop / real_gate / unknown => keep blocked. ONLY explicit continue downgrades.
assert.equal((await classifyStop({ ...courtesy, env: ON, classifier: no })).decision, "stop");
assert.equal((await classifyStop({ ...courtesy, env: ON, classifier: async () => ({ decision: "real_gate" }) })).decision, "stop");
assert.equal((await classifyStop({ ...courtesy, env: ON, classifier: async () => ({ decision: "banana" }) })).decision, "stop");

// The ONLY downgrade path: flag on + courtesy floor + signal + no high-risk token + model affirms continue.
const go = await classifyStop({ ...courtesy, env: ON, classifier: yes });
assert.equal(go.decision, "continue");
assert.equal(go.reason, "courtesy_downgrade");
assert.equal(go.floor_gate_kind, "courtesy");
assert.equal(go.llm_verdict, "continue");

console.log("AIPI_STOP_CLASSIFIER_TEST_OK");
