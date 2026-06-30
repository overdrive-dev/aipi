import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  aipiPromoteMemory,
  parseBusinessRules,
  detectBusinessRuleDrift,
  listBusinessRuleDrifts,
  resolveBusinessRuleDrift,
} from "../extensions/aipi/runtime/aipi-tools.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-drift-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
const nowBase = Date.parse("2026-06-30T00:00:00.000Z");
const now = () => new Date(nowBase + (tick++) * 1000);
const rulesRel = path.join(".aipi", "memory", "project", "business-rules.md");
const rulesAbs = path.join(tempRoot, rulesRel);

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// Promote a DURABLE business rule (mints a valid human-style approval artifact first).
async function promoteRule({ statement, source, verify = "", impacted = "" }) {
  const approvalRel = path.posix.join(".aipi", "runtime", "approvals", "approved", `drift-test-${tick}.json`);
  await fs.mkdir(path.dirname(path.join(tempRoot, approvalRel)), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, approvalRel),
    `${JSON.stringify({ schema: "aipi.memory-promotion-approval.v1", decision: "APPROVED", source: "drift-test" })}\n`,
  );
  const lines = [`- **statement:** ${statement}`];
  if (impacted) lines.push(`- **impacted-files:** ${impacted}`);
  if (verify) lines.push(`- **verify:** ${verify}`);
  const result = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "business-rule",
    title: statement.split(/\s+/).slice(0, 6).join(" "),
    content: lines.join("\n"),
    source_ref: source,
    approval_ref: approvalRel,
    now,
  });
  assert.equal(result.status, "promoted", `rule promoted: ${statement}`);
  return result;
}

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // --- Schema: a promoted business rule carries the rule-contract fields (impacted-files / verify / last-verified). ---
  await promoteRule({
    statement: "COORDENADOR e negado em GET /pricing (403)",
    source: "backend/app/api/v1/endpoints/pricing.py:42",
    impacted: "backend/app/api/v1/endpoints/pricing.py",
    verify: "pytest backend/tests/test_pricing.py -k coordenador",
  });
  const rulesText = await fs.readFile(rulesAbs, "utf8");
  assert.match(rulesText, /- \*\*impacted-files:\*\*/, "rendered rule carries impacted-files");
  assert.match(rulesText, /- \*\*verify:\*\*/, "rendered rule carries verify anchor");
  assert.match(rulesText, /- \*\*last-verified:\*\*/, "rendered rule carries last-verified");

  // --- Parser: round-trips the contract fields. ---
  const parsed = parseBusinessRules(rulesText);
  assert.ok(parsed.length >= 1, "parseBusinessRules found the rule");
  const rule = parsed.find((r) => /pricing/.test(r.source));
  assert.ok(rule, "parsed the pricing rule");
  assert.ok(rule.id && rule.id.startsWith("BR-"), "parsed a BR- id");
  assert.match(rule.statement, /COORDENADOR e negado/);
  assert.deepEqual(rule.impacted_files, ["backend/app/api/v1/endpoints/pricing.py"]);
  assert.match(rule.verify, /pytest/);
  assert.match(rule.last_verified, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(rule.promotion_hash, "parsed the promotion hash");

  // --- Default impacted-files derived from the source code path when not given explicitly. ---
  await promoteRule({ statement: "Tenant isolation enforced on order reads", source: "backend/app/services/orders.py:10" });
  const derived = parseBusinessRules(await fs.readFile(rulesAbs, "utf8")).find((r) => /orders\.py/.test(r.source));
  assert.deepEqual(derived.impacted_files, ["backend/app/services/orders.py"], "impacted-files defaults to the source code path");
  // F1 regression: an EMPTY verify field must parse to "" — not swallow the next line (the rationale).
  assert.equal(derived.verify, "", "a rule with no verify anchor parses to empty verify (no next-line capture)");

  // F1 regression: a minimal non-code rule renders empty impacted-files/verify that parse WITHOUT phantom tokens.
  await promoteRule({ statement: "Escalation requires manager approval", source: "discussion with ops team" });
  const minimal = parseBusinessRules(await fs.readFile(rulesAbs, "utf8")).find((r) => /Escalation requires/.test(r.statement));
  assert.ok(minimal, "parsed the minimal rule");
  assert.deepEqual(minimal.impacted_files, [], "empty impacted-files parses to [] (no phantom '-' / '**verify:**' tokens)");
  assert.equal(minimal.verify, "", "empty verify parses to ''");

  // A "### BR-…" heading inside a fenced code block (e.g. the seeded rule TEMPLATE) is an example, not a rule.
  const fenced = parseBusinessRules([
    "# Business Rules",
    "## Rule Template",
    "```text",
    "### BR-001 - <business-language title>",
    "- **statement:** <what must be true>",
    "```",
    "### BR-REAL - An actual rule",
    "- **statement:** Real rule statement",
    "- **impacted-files:** backend/real.py",
    "",
  ].join("\n"));
  assert.equal(fenced.length, 1, "headings inside a fenced code block are ignored");
  assert.equal(fenced[0].id, "BR-REAL", "only the real (unfenced) rule is parsed");

  // --- Detection: a rule whose impacted file changed in this run surfaces as drift (review severity). ---
  const hit = await detectBusinessRuleDrift({ root: tempRoot, changedFiles: ["backend/app/api/v1/endpoints/pricing.py"], now });
  assert.equal(hit.drifts.length, 1, "one rule drifted");
  assert.equal(hit.drifts[0].signal, "impacted_files_changed");
  assert.equal(hit.drifts[0].severity, "review");
  assert.ok(hit.checked >= 2, "checked all rules with impacted files");

  // --- An unrelated change produces NO drift. ---
  const miss = await detectBusinessRuleDrift({ root: tempRoot, changedFiles: ["frontend/src/unrelated.tsx"], now, queue: false });
  assert.equal(miss.drifts.length, 0, "unrelated change -> no drift");

  // --- Never mutates business-rules.md. ---
  const before = await fs.readFile(rulesAbs, "utf8");
  await detectBusinessRuleDrift({ root: tempRoot, changedFiles: ["backend/app/api/v1/endpoints/pricing.py"], now });
  assert.equal(await fs.readFile(rulesAbs, "utf8"), before, "drift detection NEVER mutates business-rules.md");

  // --- Queue + dedup: the drift is written to the drift queue; re-detecting the same drift does not duplicate. ---
  const drifts1 = await listBusinessRuleDrifts(tempRoot);
  const pricingDrift = drifts1.find((d) => /pricing/.test(d.source ?? ""));
  assert.ok(pricingDrift, "drift report queued");
  assert.equal(pricingDrift.status, "open");
  await detectBusinessRuleDrift({ root: tempRoot, changedFiles: ["backend/app/api/v1/endpoints/pricing.py"], now });
  const drifts2 = await listBusinessRuleDrifts(tempRoot);
  assert.equal(drifts2.length, drifts1.length, "re-detecting the same drift does not duplicate the report");

  // --- Ledger records the drift_detected event. ---
  const ledger = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "audit-ledger.jsonl"), "utf8").catch(() => "");
  assert.match(ledger, /"event":"drift_detected"/, "drift detection appends an audit-ledger entry");

  // --- Executable verify anchor (opt-in): passing verify means the rule still holds (NOT drift). ---
  await promoteRule({
    statement: "Refund cap is 100 per order",
    source: "backend/app/services/refunds.py:5",
    impacted: "backend/app/services/refunds.py",
    verify: "pytest backend/tests/test_refunds.py",
  });
  const verifyPass = await detectBusinessRuleDrift({
    root: tempRoot,
    changedFiles: ["backend/app/services/refunds.py"],
    runVerify: async () => ({ status: 0 }),
    queue: false,
    now,
  });
  assert.equal(verifyPass.drifts.find((d) => /refunds/.test(d.source))?.signal ?? "none", "none", "passing verify -> rule still holds, no drift");

  // --- Failing verify anchor -> high-severity verify_failed drift. ---
  const verifyFail = await detectBusinessRuleDrift({
    root: tempRoot,
    changedFiles: ["backend/app/services/refunds.py"],
    runVerify: async () => ({ status: 1 }),
    queue: false,
    now,
  });
  const refundDrift = verifyFail.drifts.find((d) => /refunds/.test(d.source));
  assert.ok(refundDrift, "failing verify surfaced a drift");
  assert.equal(refundDrift.signal, "verify_failed");
  assert.equal(refundDrift.severity, "high");

  // --- F3 regression: only a REAL numeric exit code may pass. Everything else (missing, null, false, "", [],
  // {exitCode:0}) FAILS SAFE — surfaces a high verify_failed drift. `status:null` is the spawnSync signal-killed
  // (timeout/OOM) shape, so this is the case that matters most. ---
  for (const runVerify of [
    async () => ({}),
    async () => undefined,
    async () => ({ exitCode: 0 }),
    async () => ({ status: null }),
    async () => ({ status: false }),
    async () => ({ status: "" }),
    async () => ({ status: [] }),
  ]) {
    const r = await detectBusinessRuleDrift({ root: tempRoot, changedFiles: ["backend/app/services/refunds.py"], runVerify, queue: false, now });
    const d = r.drifts.find((x) => /refunds/.test(x.source));
    assert.ok(d, "non-numeric verify status still surfaces a drift (fail-safe, not fail-open)");
    assert.equal(d.signal, "verify_failed");
    assert.equal(d.severity, "high");
  }
  // A real numeric 0 still means pass (no drift); a real non-zero means fail.
  assert.equal(
    (await detectBusinessRuleDrift({ root: tempRoot, changedFiles: ["backend/app/services/refunds.py"], runVerify: async () => ({ status: 0 }), queue: false, now })).drifts.find((x) => /refunds/.test(x.source)) ?? null,
    null,
    "a real numeric status 0 means pass (no drift)",
  );

  // --- git fallback: with no explicit changedFiles, derive them from the injected git runner. ---
  const fakeGit = (root, gitArgs) => {
    if (gitArgs[0] === "diff" && gitArgs.includes("--name-only")) {
      return { status: 0, stdout: "backend/app/api/v1/endpoints/pricing.py\n" };
    }
    return { status: 0, stdout: "" };
  };
  const fallback = await detectBusinessRuleDrift({ root: tempRoot, git: fakeGit, queue: false, now });
  assert.ok(fallback.drifts.some((d) => /pricing/.test(d.source)), "git fallback derives changed files when none are passed");

  // --- F2 regression: dismiss STICKS — re-detecting on the same (still-dirty) changedFiles does not re-queue. ---
  await promoteRule({ statement: "Audit log retention is 90 days", source: "backend/app/services/audit.py:3", impacted: "backend/app/services/audit.py" });
  await detectBusinessRuleDrift({ root: tempRoot, changedFiles: ["backend/app/services/audit.py"], now });
  const auditId = (await listBusinessRuleDrifts(tempRoot)).find((d) => /audit\.py/.test(d.source ?? ""))?.id;
  assert.ok(auditId, "audit drift queued");
  await resolveBusinessRuleDrift({ root: tempRoot, id: auditId, action: "dismiss", now });
  assert.equal((await listBusinessRuleDrifts(tempRoot)).some((d) => d.id === auditId), false, "dismissed drift hidden from the open list");
  assert.equal((await listBusinessRuleDrifts(tempRoot, { includeResolved: true })).some((d) => d.id === auditId && d.status === "dismissed"), true, "dismissed drift kept as a tombstone on disk");
  const reDetect = await detectBusinessRuleDrift({ root: tempRoot, changedFiles: ["backend/app/services/audit.py"], now });
  assert.equal(reDetect.queued.find((q) => q.id === auditId)?.status, "duplicate", "re-detect does NOT re-queue a dismissed drift (tombstone suppresses)");
  assert.equal((await listBusinessRuleDrifts(tempRoot)).some((d) => d.id === auditId), false, "dismissed drift stays dismissed after re-detect");

  // --- F2 residual: a dismissed tombstone is REAPED once its cause clears, so a GENUINE future re-violation
  // re-surfaces (dismiss is scoped to its episode, not permanent) — verified in an isolated root. ---
  const reapRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-drift-reap-"));
  try {
    await initProject({ sourceRoot, targetRoot: reapRoot });
    await fs.writeFile(path.join(reapRoot, ".aipi", "memory", "project", "business-rules.md"), [
      "### BR-500 - Pricing guard",
      "- **statement:** Pricing guard holds",
      "- **impacted-files:** backend/pricing.py",
      "- **verify:** ",
      "- **source:** backend/pricing.py:1",
      "",
    ].join("\n"));
    const q1 = await detectBusinessRuleDrift({ root: reapRoot, changedFiles: ["backend/pricing.py"], now });
    const drid = q1.queued.find((x) => x.status === "queued").id;
    await resolveBusinessRuleDrift({ root: reapRoot, id: drid, action: "dismiss", now });
    // Same cause still present -> tombstone persists, no re-queue.
    await detectBusinessRuleDrift({ root: reapRoot, changedFiles: ["backend/pricing.py"], now });
    assert.equal(await pathExists(path.join(reapRoot, ".aipi", "runtime", "memory-drift", `${drid}.json`)), true, "tombstone persists while its cause is still in the change set");
    assert.equal((await listBusinessRuleDrifts(reapRoot)).length, 0, "dismissed drift stays hidden while its cause persists");
    // Cause clears (e.g. committed) -> a scan with unrelated changes reaps the stale tombstone.
    await detectBusinessRuleDrift({ root: reapRoot, changedFiles: ["frontend/src/elsewhere.tsx"], now });
    assert.equal(await pathExists(path.join(reapRoot, ".aipi", "runtime", "memory-drift", `${drid}.json`)), false, "stale tombstone reaped once its cause is gone");
    // Genuine future re-violation -> re-surfaces as a fresh open drift.
    const q2 = await detectBusinessRuleDrift({ root: reapRoot, changedFiles: ["backend/pricing.py"], now });
    assert.equal(q2.queued.find((x) => x.id === drid)?.status, "queued", "a genuine future re-violation re-surfaces after the tombstone is reaped");
    assert.equal((await listBusinessRuleDrifts(reapRoot)).some((d) => d.id === drid), true, "re-surfaced drift is open again");
  } finally {
    await fs.rm(reapRoot, { recursive: true, force: true });
  }

  // --- F2 (multi-impacted-file): the drift id must NOT depend on which SUBSET of a rule's files matched, so a
  // dismissal STICKS even as later steps of the same run touch MORE of that rule's impacted files. ---
  const multiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-drift-multi-"));
  try {
    await initProject({ sourceRoot, targetRoot: multiRoot });
    await fs.writeFile(path.join(multiRoot, ".aipi", "memory", "project", "business-rules.md"), [
      "### BR-900 - Multi-file rule",
      "- **statement:** Multi guard holds",
      "- **impacted-files:** backend/a.py, backend/b.py",
      "- **verify:** ",
      "- **source:** backend/a.py:1",
      "",
    ].join("\n"));
    const m1 = await detectBusinessRuleDrift({ root: multiRoot, changedFiles: ["backend/a.py"], now });
    const mid = m1.queued.find((x) => x.status === "queued").id;
    await resolveBusinessRuleDrift({ root: multiRoot, id: mid, action: "dismiss", now });
    // Step 2: MORE of the rule's files are now in the change set (a.py still dirty) — id must be unchanged.
    const m2 = await detectBusinessRuleDrift({ root: multiRoot, changedFiles: ["backend/a.py", "backend/b.py"], now });
    assert.equal(m2.queued.find((x) => x.id === mid)?.status, "duplicate", "dismissal sticks as the matched subset grows (id independent of changed subset)");
    assert.equal(m2.queued.filter((x) => x.status === "queued").length, 0, "no fresh open drift queued for the same rule when more of its files change");
    assert.equal((await listBusinessRuleDrifts(multiRoot)).length, 0, "no duplicate open report; the dismissal holds");
  } finally {
    await fs.rm(multiRoot, { recursive: true, force: true });
  }

  // --- Resolve tombstones the report (hidden from the open list, kept on disk) and audits it. ---
  const toResolve = (await listBusinessRuleDrifts(tempRoot))[0];
  const resolved = await resolveBusinessRuleDrift({ root: tempRoot, id: toResolve.id, action: "resolve", now });
  assert.equal(resolved.id, toResolve.id);
  assert.equal(resolved.status, "resolved");
  assert.equal(await pathExists(path.join(tempRoot, ".aipi", "runtime", "memory-drift", `${toResolve.id}.json`)), true, "resolved report kept on disk as a tombstone");
  assert.equal((await listBusinessRuleDrifts(tempRoot)).some((d) => d.id === toResolve.id), false, "resolved drift hidden from the open list");
  assert.match(await fs.readFile(path.join(tempRoot, ".aipi", "memory", "audit-ledger.jsonl"), "utf8"), /"event":"drift_resolved"/);
  await assert.rejects(() => resolveBusinessRuleDrift({ root: tempRoot, id: "../escape", action: "dismiss", now }), /invalid drift id/);

  // --- F4 regression: two DISTINCT rules sharing a BR- id both surface (no silent collision drop). ---
  const dupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-drift-dup-"));
  try {
    await initProject({ sourceRoot, targetRoot: dupRoot });
    await fs.writeFile(path.join(dupRoot, ".aipi", "memory", "project", "business-rules.md"), [
      "### BR-001 - First rule",
      "- **statement:** First distinct rule about pricing",
      "- **impacted-files:** backend/pricing.py",
      "- **verify:** ",
      "",
      "### BR-001 - Second rule",
      "- **statement:** Second distinct rule about pricing",
      "- **impacted-files:** backend/pricing.py",
      "- **verify:** ",
      "",
    ].join("\n"));
    const dup = await detectBusinessRuleDrift({ root: dupRoot, changedFiles: ["backend/pricing.py"], now });
    assert.equal(dup.drifts.length, 2, "both same-id rules detected");
    const queuedIds = new Set(dup.queued.filter((q) => q.status === "queued").map((q) => q.id));
    assert.equal(queuedIds.size, 2, "two DISTINCT reports queued (no collision drop)");
    assert.equal((await listBusinessRuleDrifts(dupRoot)).length, 2, "both drift reports landed on disk");
  } finally {
    await fs.rm(dupRoot, { recursive: true, force: true });
  }

  // --- Early-out: a project with no business-rules.md detects nothing and never throws. ---
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-drift-empty-"));
  try {
    const empty = await detectBusinessRuleDrift({ root: emptyRoot, changedFiles: ["x.py"], now });
    assert.equal(empty.checked, 0);
    assert.deepEqual(empty.drifts, []);
  } finally {
    await fs.rm(emptyRoot, { recursive: true, force: true });
  }

  console.log("AIPI_MEMORY_DRIFT_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
