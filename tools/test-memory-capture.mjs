import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { addBusinessRules, createPlan, readPlan, settlePlan } from "../extensions/aipi/runtime/plan-state.js";
import { captureSettledPlanRules } from "../extensions/aipi/runtime/memory-capture.js";
import { runMemoryCommand } from "../extensions/aipi/runtime/memory-command.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-capture-"));
const sourceRoot = path.resolve("templates/.aipi");
let tick = 0;
const nowBase = Date.parse("2026-06-30T00:00:00.000Z");
const now = () => new Date(nowBase + (tick++) * 1000);
const fixedRandom = () => Buffer.from("abcdef", "hex");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  // Settling a plan with an accepted business rule captures it as a structured CANDIDATE (not durable).
  const { planId } = await createPlan({ projectRoot: tempRoot, tasks: ["corrigir bug do pricing"], now, randomBytes: fixedRandom });
  await addBusinessRules({
    projectRoot: tempRoot,
    planId,
    rules: [{ text: "COORDENADOR e negado em GET /pricing (403)", source: "backend/app/api/v1/endpoints/pricing.py:42" }],
    now,
  });
  await settlePlan({ projectRoot: tempRoot, planId, now });

  const list = await runMemoryCommand({ projectRoot: tempRoot, args: "candidates" });
  const cand = list.candidates.find((c) => c.kind === "business-rule" && c.structured);
  assert.ok(cand, "settle captured the accepted rule as a structured candidate");
  assert.match(String(cand.source_ref), /pricing\.py:42/);
  // It is a CANDIDATE, not durable memory (the human still drains it).
  const rulesFile = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8").catch(() => "");
  assert.doesNotMatch(rulesFile, /COORDENADOR e negado em GET \/pricing/, "capture stages a candidate, it does NOT auto-write durable memory");

  // Dedup: re-capturing the same settled plan does not create a duplicate candidate.
  const before = (await runMemoryCommand({ projectRoot: tempRoot, args: "candidates" })).candidates.length;
  const again = await captureSettledPlanRules({ projectRoot: tempRoot, plan: (await readPlan(tempRoot, planId)).plan, now });
  assert.ok(again.captured.length && again.captured.every((c) => c.status === "duplicate"), "re-capture dedups by hash");
  const after = (await runMemoryCommand({ projectRoot: tempRoot, args: "candidates" })).candidates.length;
  assert.equal(after, before, "no duplicate candidate created on re-capture");

  // A plan with no business rules captures nothing.
  const { planId: p2 } = await createPlan({ projectRoot: tempRoot, tasks: ["tarefa sem regra"], now, randomBytes: fixedRandom });
  const cap2 = await captureSettledPlanRules({ projectRoot: tempRoot, plan: (await readPlan(tempRoot, p2)).plan, now });
  assert.deepEqual(cap2.captured, []);

  // Unit: captures each rule via the (injected) promote with kind/statement/source_ref, no approval_ref.
  const calls = [];
  const fakePlan = { plan_id: "plan-unit", business_rules: [{ rule_id: "r1", text: "Some accepted rule", source: "x.py:1" }] };
  const cap3 = await captureSettledPlanRules({
    projectRoot: tempRoot,
    plan: fakePlan,
    promoteMemory: async (opts) => { calls.push(opts); return { status: "deferred", candidate_json_path: ".aipi/runtime/memory-candidates/unit.json" }; },
    now,
  });
  assert.equal(cap3.captured.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "business-rule");
  assert.match(calls[0].content, /\*\*statement:\*\* Some accepted rule/);
  assert.equal(calls[0].source_ref, "x.py:1");
  assert.equal(calls[0].approval_ref ?? "", "", "capture never supplies an approval_ref (stays a candidate)");

  console.log("AIPI_MEMORY_CAPTURE_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
