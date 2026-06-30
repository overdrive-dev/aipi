// End-to-end durable-memory lifecycle, exercised through the real public surfaces with only clock + git faked:
// capture (settled plan rule → candidate) → drain (/aipi-memory promote → durable + RC5 commit) →
// detect drift (changed code → queued) → reconcile (resolve) → doctor/verify (healthy) → audit-ledger trail.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryFixture } from "./_memory-fixture.mjs";
import { addBusinessRules, createPlan, settlePlan } from "../extensions/aipi/runtime/plan-state.js";
import {
  aipiPromoteMemory,
  commitDurableMemory,
  detectBusinessRuleDrift,
  parseBusinessRules,
} from "../extensions/aipi/runtime/aipi-tools.js";
import { runMemoryCommand } from "../extensions/aipi/runtime/memory-command.js";
import { runMemoryDoctor, verifyMemory } from "../extensions/aipi/runtime/memory-doctor.js";

const fx = await createMemoryFixture();
const { root, now, git } = fx;
const fixedRandom = () => Buffer.from("abcdef", "hex");
const impacted = "backend/app/api/v1/endpoints/pricing.py";
const rulesPath = path.join(root, ".aipi", "memory", "project", "business-rules.md");
// Drain through the real command, but inject the fake git into the commit so RC5 is deterministic + observable.
const promoteMemory = (opts) => aipiPromoteMemory({ ...opts, commitMemory: (cOpts) => commitDurableMemory({ ...cOpts, git }) });

try {
  // 1) CAPTURE — settling a plan with an accepted business rule stages a CANDIDATE, never durable memory.
  const { planId } = await createPlan({ projectRoot: root, tasks: ["fix pricing authz"], now, randomBytes: fixedRandom });
  await addBusinessRules({
    projectRoot: root,
    planId,
    rules: [{ text: "COORDENADOR is denied on GET /pricing (403)", source: `${impacted}:42` }],
    now,
  });
  await settlePlan({ projectRoot: root, planId, now });
  // The seeded template is present, but the captured rule must NOT have been written to durable memory.
  const afterCapture = await fs.readFile(rulesPath, "utf8").catch(() => "");
  assert.doesNotMatch(afterCapture, /COORDENADOR is denied on GET \/pricing/, "capture stages a candidate; it does NOT auto-write durable memory");

  // 2) CANDIDATES — the captured rule is listed and promotable.
  const list = await runMemoryCommand({ projectRoot: root, args: "candidates", now });
  const cand = list.candidates.find((c) => c.kind === "business-rule" && c.structured);
  assert.ok(cand, "the settled rule is captured as a structured candidate");

  // 3) DRAIN — /aipi-memory promote mints a human approval, writes durable memory, and commits it (RC5).
  const promote = await runMemoryCommand({ projectRoot: root, args: `promote ${cand.id}`, now, promoteMemory });
  assert.equal(promote.result.status, "promoted");
  assert.equal(promote.drained, true);
  assert.equal(promote.result.committed, true, "RC5: the durable write was committed through the injected git");
  const committed = git.commits();
  assert.ok(committed.length >= 1, "git commit was invoked for the durable memory");
  assert.ok(
    committed.some((c) => c.args.includes(".aipi/memory/project/business-rules.md")),
    "the commit pathspec includes business-rules.md",
  );

  // 4) DURABLE — the rule is now a contract in business-rules.md with impacted-files derived from its source.
  const rulesText = await fs.readFile(rulesPath, "utf8");
  assert.match(rulesText, /COORDENADOR is denied on GET \/pricing/);
  const rule = parseBusinessRules(rulesText).find((r) => /pricing\.py/.test(r.source));
  assert.ok(rule?.impacted_files.includes(impacted), "the promoted rule carries impacted-files");

  // 5) DETECT — changing the rule's impacted file surfaces a drift.
  const scan = await detectBusinessRuleDrift({ root, changedFiles: [impacted], now });
  assert.equal(scan.drifts.length, 1, "the code change drifted the rule");
  const driftId = scan.queued.find((q) => q.status === "queued").id;

  // 6) RECONCILE — the drift is listed, then resolved (hidden from the open surface).
  assert.equal((await runMemoryCommand({ projectRoot: root, args: "reconcile", now })).drifts.length, 1);
  const resolved = await runMemoryCommand({ projectRoot: root, args: `reconcile resolve ${driftId}`, now });
  assert.equal(resolved.op, "resolve");
  assert.equal((await runMemoryCommand({ projectRoot: root, args: "reconcile", now })).drifts.length, 0, "resolved drift hidden from the open list");

  // 7) DOCTOR / VERIFY — the subsystem is healthy and passes strict verification after reconciliation.
  const doctor = await runMemoryDoctor({ projectRoot: root });
  assert.equal(doctor.ok, true, "doctor reports healthy");
  assert.equal(doctor.counts.rules, 1);
  assert.equal(doctor.counts.open_drifts, 0);
  assert.equal(verifyMemory(doctor, { strict: true }).ok, true, "strict verify passes after the lifecycle settles");

  // 8) PROVENANCE — the audit ledger captured the full lifecycle, in order.
  const ledger = await fs.readFile(path.join(root, ".aipi", "memory", "audit-ledger.jsonl"), "utf8");
  const events = ledger.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).event);
  for (const event of ["deferred", "promoted", "drift_detected", "drift_resolved"]) {
    assert.ok(events.includes(event), `audit ledger records '${event}'`);
  }
  assert.ok(events.indexOf("deferred") < events.indexOf("promoted"), "ledger preserves capture→promote order");

  console.log("AIPI_MEMORY_LIFECYCLE_TEST_OK");
} finally {
  await fx.cleanup();
}
