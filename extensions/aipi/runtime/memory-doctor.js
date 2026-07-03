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

// FIX 4: parse the ISO-ish timestamp embedded in a candidate filename stem back to a Date.
// Candidate filenames use timestamp.replace(/[:.]/g, "-") which turns "2026-06-15T10:00:00.000Z"
// into "2026-06-15T10-00-00-000Z". Reconstruct by restoring the colons and dot.
function parseCandidateFilenameTimestamp(stem) {
  const m = stem.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)/);
  if (!m) return null;
  const d = new Date(`${m[1]}:${m[2]}:${m[3]}.${m[4]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function runMemoryDoctor({ projectRoot, now = () => new Date() } = {}) {
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

  // --- Candidates: count pending (.json + legacy .md-only); unreadable json is a hard problem. ---
  const nowMs = now().getTime();
  let pendingCandidates = 0;
  let unreadableCandidates = 0;
  let legacyCandidates = 0;
  let oldestCandidateAgeDays = null;

  const allCandEntries = await readDirNames(path.join(root, CANDIDATES_DIR));
  const jsonCandFiles = new Set(allCandEntries.filter((n) => n.endsWith(".json")));
  const mdCandFiles = allCandEntries.filter((n) => n.endsWith(".md"));

  for (const name of jsonCandFiles) {
    pendingCandidates += 1;
    let parsedCand = null;
    try {
      parsedCand = JSON.parse(await fs.readFile(path.join(root, CANDIDATES_DIR, name), "utf8"));
    } catch {
      unreadableCandidates += 1;
      add("error", "candidate_unreadable", `candidate ${name} is not parseable JSON`);
    }
    // Age: prefer created_at from JSON, fall back to filename timestamp prefix
    const createdAt = parsedCand?.created_at ? new Date(parsedCand.created_at) : null;
    const refDate = (createdAt && !Number.isNaN(createdAt.getTime()))
      ? createdAt
      : parseCandidateFilenameTimestamp(name.replace(/\.json$/, ""));
    if (refDate) {
      const ageDays = Math.floor((nowMs - refDate.getTime()) / 86400000);
      if (oldestCandidateAgeDays === null || ageDays > oldestCandidateAgeDays) {
        oldestCandidateAgeDays = ageDays;
      }
    }
  }

  // FIX 4a: also count legacy .md-only candidates (no .json sibling) as pending
  for (const name of mdCandFiles) {
    const stem = name.replace(/\.md$/, "");
    if (jsonCandFiles.has(`${stem}.json`)) continue; // has a json sibling → already counted
    legacyCandidates += 1;
    pendingCandidates += 1;
    const refDate = parseCandidateFilenameTimestamp(stem);
    if (refDate) {
      const ageDays = Math.floor((nowMs - refDate.getTime()) / 86400000);
      if (oldestCandidateAgeDays === null || ageDays > oldestCandidateAgeDays) {
        oldestCandidateAgeDays = ageDays;
      }
    }
  }

  // FIX 4b: warn when there are pending candidates (any kind); strict gate will fail, lenient passes
  if (pendingCandidates > 0) {
    const ageStr = oldestCandidateAgeDays !== null ? `, oldest: ${oldestCandidateAgeDays} day(s)` : "";
    add("warn", "candidates_pending", `${pendingCandidates} pending memory candidate(s)${ageStr}`);
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
      legacy_candidates: legacyCandidates,
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
