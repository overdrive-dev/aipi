import fs from "node:fs/promises";
import path from "node:path";
import { aipiPromoteMemory, memoryPromotionHash } from "./aipi-tools.js";

const CANDIDATES_DIR = ".aipi/runtime/memory-candidates";

function deriveTitle(text) {
  const words = String(text ?? "").trim().split(/\s+/).slice(0, 9).join(" ");
  if (!words) return "business rule";
  return words.length > 80 ? `${words.slice(0, 77)}...` : words;
}

// Already-staged candidate hashes, so re-running capture on the same accepted rules does not spam duplicates.
async function existingCandidateHashes(root) {
  const dir = path.join(root, CANDIDATES_DIR);
  const entries = await fs.readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const hashes = new Set();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const candidate = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      if (candidate.promotion_hash) hashes.add(candidate.promotion_hash);
    } catch {
      // ignore unreadable candidate
    }
  }
  return hashes;
}

// RC1 deterministic capture: a SETTLED plan's human-accepted business_rules become structured CANDIDATES
// (status:candidate, via the approval-gated promote with NO approval_ref -> deferred). They are NEVER
// auto-promoted to durable memory — a human drains them via /aipi-memory promote. Fail-safe + dedup'd, so
// planned work that settles rules now produces candidates instead of nothing (closing RC1 for the plan path).
export async function captureSettledPlanRules({ projectRoot, plan, promoteMemory = aipiPromoteMemory, now = () => new Date() } = {}) {
  const root = path.resolve(projectRoot);
  const rules = Array.isArray(plan?.business_rules) ? plan.business_rules : [];
  if (!rules.length) return { captured: [] };
  const seen = await existingCandidateHashes(root);
  const captured = [];
  for (const rule of rules) {
    const text = String(rule?.text ?? "").trim();
    if (!text) continue;
    const title = deriveTitle(text);
    const content = `- **statement:** ${text}`;
    const source_ref = String(rule?.source ?? "").trim() || `plan:${plan?.plan_id ?? "unknown"}`;
    const hash = memoryPromotionHash({ kind: "business-rule", title, content, source_ref });
    if (seen.has(hash)) {
      captured.push({ rule_id: rule.rule_id ?? null, status: "duplicate" });
      continue;
    }
    seen.add(hash);
    const result = await promoteMemory({
      projectRoot: root,
      kind: "business-rule",
      title,
      content,
      source_ref,
      // No approval_ref => deferred => structured candidate (fail-safe; the human drains it).
      now,
    });
    captured.push({ rule_id: rule.rule_id ?? null, status: result.status, candidate: result.candidate_json_path ?? null });
  }
  return { captured };
}
