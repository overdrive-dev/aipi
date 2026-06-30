import fs from "node:fs/promises";
import path from "node:path";
import { listBusinessRuleDrifts, parseBusinessRules } from "./aipi-tools.js";

// P3-audit: a read-only health check + strict verifier for the durable-memory subsystem. The doctor inspects
// what is on disk (durable rules, pending candidates, open drifts, the audit ledger) and reports problems;
// verifyMemory turns that into a pass/fail gate. Fail-safe: anything it cannot read where it expected content
// is a problem (counts as drift), never a silent pass — so a release/strict run surfaces a sick memory store.

const PROJECT_MEMORY_DIR = ".aipi/memory/project";
const CANDIDATES_DIR = ".aipi/runtime/memory-candidates";
const AUDIT_LEDGER = ".aipi/memory/audit-ledger.jsonl";
const BUSINESS_RULES = "business-rules.md";

async function readDirNames(abs) {
  return fs.readdir(abs).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

// Returns { text, missing }. ENOENT → missing:true (absence is fine); any other read error rethrows.
async function readTextOrMissing(abs) {
  try {
    return { text: await fs.readFile(abs, "utf8"), missing: false };
  } catch (error) {
    if (error.code === "ENOENT") return { text: null, missing: true };
    throw error;
  }
}

export async function runMemoryDoctor({ projectRoot } = {}) {
  const root = path.resolve(projectRoot ?? ".");
  const problems = [];
  const add = (severity, code, message) => problems.push({ severity, code, message });

  // --- Durable business rules: each must have a statement; impacted-files keeps it drift-detectable. ---
  const rules = await (async () => {
    const { text } = await readTextOrMissing(path.join(root, PROJECT_MEMORY_DIR, BUSINESS_RULES));
    return text ? parseBusinessRules(text) : [];
  })();
  let rulesMissingImpacted = 0;
  for (const rule of rules) {
    const label = rule.id ?? rule.title ?? "(unnamed rule)";
    if (!rule.statement) add("error", "rule_no_statement", `business rule ${label} has no statement`);
    if (!rule.impacted_files.length) {
      rulesMissingImpacted += 1;
      add("warn", "rule_no_impacted_files", `business rule ${label} has no impacted-files (drift detection is blind to it)`);
    }
  }

  // --- Candidates: count pending; an unreadable candidate is a hard problem (the drain depends on parsing it). ---
  let pendingCandidates = 0;
  let unreadableCandidates = 0;
  for (const name of await readDirNames(path.join(root, CANDIDATES_DIR))) {
    if (!name.endsWith(".json")) continue;
    pendingCandidates += 1;
    try {
      JSON.parse(await fs.readFile(path.join(root, CANDIDATES_DIR, name), "utf8"));
    } catch {
      unreadableCandidates += 1;
      add("error", "candidate_unreadable", `candidate ${name} is not parseable JSON`);
    }
  }

  // --- Drift queue: open drifts are unreconciled (a warning); an unreadable report is a hard problem. ---
  let openDrifts = 0;
  let unreadableDrifts = 0;
  const drifts = await listBusinessRuleDrifts(root, { includeResolved: true }).catch((error) => {
    add("error", "drift_queue_unreadable", `drift queue could not be read: ${error.message}`);
    return [];
  });
  for (const drift of drifts) {
    if (drift.status === "unreadable") {
      unreadableDrifts += 1;
      add("error", "drift_unreadable", `drift report ${drift.id} is not parseable JSON`);
    } else if ((drift.status ?? "open") === "open") {
      openDrifts += 1;
    }
  }
  if (openDrifts > 0) {
    add("warn", "open_drifts", `${openDrifts} open business-rule drift(s) awaiting reconciliation`);
  }

  // --- Audit ledger: append-only JSONL; an invalid line means the provenance trail is corrupt. ---
  const { text: ledgerText } = await readTextOrMissing(path.join(root, AUDIT_LEDGER));
  let ledgerLines = 0;
  let ledgerInvalid = 0;
  if (ledgerText != null) {
    for (const line of ledgerText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      ledgerLines += 1;
      try {
        JSON.parse(line);
      } catch {
        ledgerInvalid += 1;
      }
    }
    if (ledgerInvalid > 0) add("error", "ledger_invalid", `${ledgerInvalid} unparseable line(s) in audit-ledger.jsonl`);
  }

  return {
    schema: "aipi.memory-doctor.v1",
    root,
    counts: {
      rules: rules.length,
      rules_missing_impacted_files: rulesMissingImpacted,
      pending_candidates: pendingCandidates,
      unreadable_candidates: unreadableCandidates,
      open_drifts: openDrifts,
      unreadable_drifts: unreadableDrifts,
      ledger_lines: ledgerLines,
      ledger_invalid: ledgerInvalid,
    },
    problems,
    ok: problems.every((p) => p.severity !== "error"),
  };
}

// Strict turns warnings (open drifts, rules with no impacted-files) into failures too, so a release gate
// refuses to ship on an unreconciled or under-specified memory store. Non-strict fails only on hard errors.
export function verifyMemory(doctor, { strict = false } = {}) {
  const errors = doctor.problems.filter((p) => p.severity === "error");
  const warnings = doctor.problems.filter((p) => p.severity === "warn");
  return {
    schema: "aipi.memory-verify.v1",
    ok: strict ? doctor.problems.length === 0 : errors.length === 0,
    strict,
    errors: errors.length,
    warnings: warnings.length,
    problems: doctor.problems,
    counts: doctor.counts,
  };
}

export function formatMemoryDoctor(doctor) {
  const c = doctor.counts;
  const lines = [
    `AIPI memory doctor: ${doctor.ok ? "healthy" : "PROBLEMS"} (${doctor.problems.filter((p) => p.severity === "error").length} error, ${doctor.problems.filter((p) => p.severity === "warn").length} warn)`,
    `rules=${c.rules} (no-impacted=${c.rules_missing_impacted_files}) candidates=${c.pending_candidates} open_drifts=${c.open_drifts} ledger_lines=${c.ledger_lines}`,
    ...doctor.problems.map((p) => `- [${p.severity}] ${p.code}: ${p.message}`),
  ];
  return lines.join("\n");
}
