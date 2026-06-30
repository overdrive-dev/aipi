import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { aipiPromoteMemory } from "../extensions/aipi/runtime/aipi-tools.js";
import { formatMemoryCommandResult, parseMemoryArgs, runMemoryCommand } from "../extensions/aipi/runtime/memory-command.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-cmd-"));
const sourceRoot = path.resolve("templates/.aipi");

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // Grammar.
  assert.deepEqual(parseMemoryArgs("candidates"), { action: "candidates" });
  assert.deepEqual(parseMemoryArgs("promote abc"), { action: "promote", id: "abc" });
  assert.deepEqual(parseMemoryArgs("discard abc"), { action: "discard", id: "abc" });
  assert.throws(() => parseMemoryArgs("promote"), /requires a candidate id/);
  assert.throws(() => parseMemoryArgs("discard"), /requires a candidate id/);

  // A promote with no approval defers and writes a structured candidate (P1).
  const deferred = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "business-rule",
    title: "Coord pricing",
    content: "- **statement:** COORDENADOR e negado em GET /pricing (403).",
    source_ref: "backend/app/api/v1/endpoints/pricing.py:42",
    now: () => new Date("2026-06-30T00:00:00.000Z"),
  });
  assert.equal(deferred.status, "deferred");
  const candId = path.basename(deferred.candidate_json_path).replace(/\.json$/, "");

  // candidates lists the structured candidate.
  const list = await runMemoryCommand({ projectRoot: tempRoot, args: "candidates" });
  assert.equal(list.action, "candidates");
  const found = list.candidates.find((c) => c.id === candId);
  assert.ok(found, "the deferred candidate is listed");
  assert.equal(found.structured, true);
  assert.equal(found.kind, "business-rule");
  assert.match(formatMemoryCommandResult(list), /pending/);

  // promote drains it: mints a HUMAN approval, the hardened gate accepts it, durable memory is written.
  const promote = await runMemoryCommand({ projectRoot: tempRoot, args: `promote ${candId}`, now: () => new Date("2026-06-30T01:00:00.000Z") });
  assert.equal(promote.action, "promote");
  assert.equal(promote.result.status, "promoted", "drain mints a human approval the hardened gate accepts");
  assert.equal(promote.drained, true);
  assert.equal(await pathExists(path.join(tempRoot, deferred.candidate_json_path)), false, "candidate json removed after promote");
  assert.equal(await pathExists(path.join(tempRoot, deferred.candidate_path)), false, "candidate md removed after promote");
  const rulesText = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8");
  assert.match(rulesText, /COORDENADOR/, "the rule reached durable memory");
  const approval = JSON.parse(await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "approvals", "approved", `${candId}-drain.json`), "utf8"));
  assert.equal(approval.decision, "APPROVED");
  assert.equal(approval.source, "human-drain");
  assert.match(formatMemoryCommandResult(promote), /AIPI memory promoted/);

  // the promoted candidate no longer appears.
  const list2 = await runMemoryCommand({ projectRoot: tempRoot, args: "candidates" });
  assert.equal(list2.candidates.some((c) => c.id === candId), false);

  // discard removes a candidate without promoting it.
  const deferred2 = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "decision",
    content: "A decision to discard.",
    source_ref: "docs/x.md:1",
    now: () => new Date("2026-06-30T02:00:00.000Z"),
  });
  const candId2 = path.basename(deferred2.candidate_json_path).replace(/\.json$/, "");
  const discard = await runMemoryCommand({ projectRoot: tempRoot, args: `discard ${candId2}` });
  assert.equal(discard.action, "discard");
  assert.ok(discard.removed.length >= 1);
  assert.equal(await pathExists(path.join(tempRoot, deferred2.candidate_json_path)), false, "discarded candidate removed");

  // path-traversal guard.
  await assert.rejects(() => runMemoryCommand({ projectRoot: tempRoot, args: "promote ../../etc/passwd" }), /invalid candidate id/);
  await assert.rejects(() => runMemoryCommand({ projectRoot: tempRoot, args: "promote does-not-exist" }), /no structured candidate/);

  // --- reconcile grammar + drift lifecycle (RC4 / P2-detect). ---
  assert.deepEqual(parseMemoryArgs("reconcile"), { action: "reconcile" });
  assert.deepEqual(parseMemoryArgs("reconcile scan"), { action: "reconcile-scan" });
  assert.deepEqual(parseMemoryArgs("reconcile dismiss d1"), { action: "reconcile-act", op: "dismiss", id: "d1" });
  assert.deepEqual(parseMemoryArgs("reconcile resolve d1"), { action: "reconcile-act", op: "resolve", id: "d1" });
  assert.throws(() => parseMemoryArgs("reconcile dismiss"), /requires a drift id/);
  assert.throws(() => parseMemoryArgs("reconcile bogus"), /Unknown .* reconcile subcommand/);

  // Nothing drifted yet.
  const empty = await runMemoryCommand({ projectRoot: tempRoot, args: "reconcile" });
  assert.equal(empty.action, "reconcile");
  assert.deepEqual(empty.drifts, []);
  assert.match(formatMemoryCommandResult(empty), /in sync with code/);

  // reconcile scan with an injected detector that surfaces a drift -> queued + listed.
  const scan = await runMemoryCommand({
    projectRoot: tempRoot,
    args: "reconcile scan",
    detectDrift: async ({ root }) => {
      await fs.mkdir(path.join(root, ".aipi", "runtime", "memory-drift"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".aipi", "runtime", "memory-drift", "BR-X-abc12345.json"),
        `${JSON.stringify({ schema: "aipi.memory-drift.v1", id: "BR-X-abc12345", status: "open", rule_id: "BR-X", title: "Pricing rule", signal: "impacted_files_changed", severity: "review", changed: ["pricing.py"], source: "pricing.py:1" })}\n`,
      );
      return { schema: "aipi.memory-drift-scan.v1", checked: 1, in_scope: 1, drifts: [{}], queued: [{ id: "BR-X-abc12345", status: "queued" }] };
    },
  });
  assert.equal(scan.action, "reconcile-scan");
  assert.equal(scan.drifts.length, 1);
  assert.match(formatMemoryCommandResult(scan), /BR-X-abc12345/);

  // reconcile (list) shows it.
  const listed = await runMemoryCommand({ projectRoot: tempRoot, args: "reconcile" });
  assert.equal(listed.drifts.length, 1);

  // dismiss removes it.
  const dismissed = await runMemoryCommand({ projectRoot: tempRoot, args: "reconcile dismiss BR-X-abc12345", now: () => new Date("2026-06-30T03:00:00.000Z") });
  assert.equal(dismissed.action, "reconcile-act");
  assert.equal(dismissed.id, "BR-X-abc12345");
  assert.match(formatMemoryCommandResult(dismissed), /dismissed/);
  assert.equal((await runMemoryCommand({ projectRoot: tempRoot, args: "reconcile" })).drifts.length, 0);
  await assert.rejects(() => runMemoryCommand({ projectRoot: tempRoot, args: "reconcile dismiss does-not-exist" }), /no drift/);

  // --- doctor + verify (P3-audit). ---
  assert.deepEqual(parseMemoryArgs("doctor"), { action: "doctor" });
  assert.deepEqual(parseMemoryArgs("verify"), { action: "verify", strict: false });
  assert.deepEqual(parseMemoryArgs("verify --strict"), { action: "verify", strict: true });
  assert.throws(() => parseMemoryArgs("verify bogus"), /Unexpected .* verify argument/);

  const doctor = await runMemoryCommand({ projectRoot: tempRoot, args: "doctor" });
  assert.equal(doctor.action, "doctor");
  assert.equal(doctor.doctor.schema, "aipi.memory-doctor.v1");
  assert.match(formatMemoryCommandResult(doctor), /AIPI memory doctor/);

  const verify = await runMemoryCommand({ projectRoot: tempRoot, args: "verify --strict" });
  assert.equal(verify.action, "verify");
  assert.equal(verify.verify.schema, "aipi.memory-verify.v1");
  assert.equal(typeof verify.verify.ok, "boolean");
  assert.match(formatMemoryCommandResult(verify), /AIPI memory verify --strict/);

  console.log("AIPI_MEMORY_COMMAND_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
