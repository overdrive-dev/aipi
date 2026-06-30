import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMemoryDoctor, verifyMemory } from "../extensions/aipi/runtime/memory-doctor.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-doctor-"));
async function write(rel, content) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}
const rulesRel = ".aipi/memory/project/business-rules.md";

try {
  // Empty project: healthy, all zero, passes even strict verify (nothing to verify).
  let doc = await runMemoryDoctor({ projectRoot: root });
  assert.equal(doc.ok, true);
  assert.equal(doc.counts.rules, 0);
  assert.equal(verifyMemory(doc, { strict: true }).ok, true, "an empty project passes strict verify");

  // A healthy rule with impacted-files: clean.
  await write(rulesRel, [
    "### BR-1 - Pricing guard",
    "- **statement:** Coordinator denied on GET /pricing",
    "- **impacted-files:** backend/pricing.py",
    "- **verify:** ",
    "- **source:** backend/pricing.py:1",
    "",
  ].join("\n"));
  doc = await runMemoryDoctor({ projectRoot: root });
  assert.equal(doc.ok, true);
  assert.equal(doc.counts.rules, 1);
  assert.equal(doc.counts.rules_missing_impacted_files, 0);
  assert.equal(verifyMemory(doc, { strict: true }).ok, true);

  // A rule with no impacted-files is a WARNING: ok in lenient verify, FAIL in strict.
  await write(rulesRel, [
    "### BR-2 - Vague rule",
    "- **statement:** Something holds",
    "- **impacted-files:** ",
    "- **verify:** ",
    "",
  ].join("\n"));
  doc = await runMemoryDoctor({ projectRoot: root });
  assert.equal(doc.counts.rules_missing_impacted_files, 1);
  assert.equal(doc.ok, true, "missing impacted-files is a warning, not a hard error");
  assert.equal(verifyMemory(doc, { strict: false }).ok, true);
  assert.equal(verifyMemory(doc, { strict: true }).ok, false, "strict verify fails on a warning (missing impacted-files)");

  // A rule with no statement is a HARD error (fails verify in both modes).
  await write(rulesRel, ["### BR-3 - Broken", "- **impacted-files:** x.py", ""].join("\n"));
  doc = await runMemoryDoctor({ projectRoot: root });
  assert.equal(doc.ok, false, "a rule with no statement is a hard error");
  assert.ok(doc.problems.some((p) => p.code === "rule_no_statement"));
  assert.equal(verifyMemory(doc, { strict: false }).ok, false);

  // Restore a healthy rules file for the remaining cases.
  await write(rulesRel, ["### BR-1 - Pricing guard", "- **statement:** Coordinator denied", "- **impacted-files:** backend/pricing.py", ""].join("\n"));

  // An unreadable candidate is a hard error (the drain depends on parsing it).
  await write(".aipi/runtime/memory-candidates/2026-bad.json", "{ not json");
  doc = await runMemoryDoctor({ projectRoot: root });
  assert.ok(doc.problems.some((p) => p.code === "candidate_unreadable"));
  assert.equal(doc.counts.unreadable_candidates, 1);
  assert.equal(doc.ok, false);
  assert.equal(verifyMemory(doc, { strict: false }).ok, false, "unreadable candidate fails even lenient verify");
  await fs.rm(path.join(root, ".aipi/runtime/memory-candidates/2026-bad.json"));

  // Open drift is a WARNING (strict fails); a resolved tombstone is not counted.
  await write(".aipi/runtime/memory-drift/BR-1-open.json", JSON.stringify({ schema: "aipi.memory-drift.v1", id: "BR-1-open", status: "open", source: "backend/pricing.py:1" }));
  await write(".aipi/runtime/memory-drift/BR-1-done.json", JSON.stringify({ schema: "aipi.memory-drift.v1", id: "BR-1-done", status: "resolved" }));
  doc = await runMemoryDoctor({ projectRoot: root });
  assert.equal(doc.counts.open_drifts, 1, "only open drifts counted; tombstones excluded");
  assert.ok(doc.problems.some((p) => p.code === "open_drifts"));
  assert.equal(verifyMemory(doc, { strict: false }).ok, true, "open drift is a warning in lenient mode");
  assert.equal(verifyMemory(doc, { strict: true }).ok, false, "open drift fails strict verify");

  // An unreadable drift report is a hard error.
  await write(".aipi/runtime/memory-drift/BR-2-bad.json", "{ broken");
  doc = await runMemoryDoctor({ projectRoot: root });
  assert.ok(doc.problems.some((p) => p.code === "drift_unreadable"));
  assert.equal(doc.ok, false);
  await fs.rm(path.join(root, ".aipi/runtime/memory-drift/BR-2-bad.json"));

  // An invalid audit-ledger line corrupts the provenance trail → hard error.
  await write(".aipi/memory/audit-ledger.jsonl", `${JSON.stringify({ event: "promoted" })}\nNOT JSON\n`);
  doc = await runMemoryDoctor({ projectRoot: root });
  assert.equal(doc.counts.ledger_invalid, 1);
  assert.ok(doc.problems.some((p) => p.code === "ledger_invalid"));
  assert.equal(doc.ok, false);

  console.log("AIPI_MEMORY_DOCTOR_TEST_OK");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
