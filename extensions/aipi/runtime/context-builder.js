import fs from "node:fs/promises";
import path from "node:path";
import { aipiRetrieve } from "./aipi-tools.js";

const DEFAULT_MAX_ARTIFACTS_PER_STEP = 4;
const DEFAULT_MAX_EXCERPT_LINES = 80;
const DEFAULT_MAX_MEMORY_REFS = 6;
const DEFAULT_MAX_BLAST_RADIUS_REFS = 5;

export class ContextMaterializationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ContextMaterializationError";
    this.code = "AIPI_CONTEXT_BLOCKED";
    this.details = details;
  }
}

export async function buildStepContext({
  root,
  state,
  workflow,
  step,
  contract = {},
} = {}) {
  if (!root) throw new Error("root is required");
  if (!state?.run_id) throw new Error("state.run_id is required");
  if (!step?.id) throw new Error("step.id is required");

  const contextPolicy = contract.contextMaterialization ?? {};
  const maxArtifacts = contextPolicy.maxArtifactsPerStep ?? DEFAULT_MAX_ARTIFACTS_PER_STEP;
  const maxLines = contextPolicy.maxExcerptLinesPerArtifact ?? DEFAULT_MAX_EXCERPT_LINES;
  const provenance = [];
  const priorSteps = [];

  for (const ref of step.context_from ?? []) {
    const entry = state.steps.find((candidate) => candidate.id === ref);
    if (!entry) {
      throw new ContextMaterializationError(`step ${step.id} references missing context step ${ref}`, {
        step_id: step.id,
        missing_step: ref,
      });
    }

    const result = await readStepResultSummary({ root, state, stepId: ref });
    const artifacts = await materializeArtifactExcerpts({
      root,
      stepId: ref,
      artifacts: entry.artifacts ?? [],
      status: entry.status,
      maxArtifacts,
      maxLines,
    });

    for (const artifact of artifacts) {
      provenance.push({
        kind: "artifact",
        source_step: ref,
        ref: artifact.path,
        lines: artifact.lines,
      });
    }

    priorSteps.push({
      step_id: ref,
      status: entry.status,
      verdict: entry.verdict ?? null,
      result,
      artifacts,
    });
  }

  const contractRef = await materializeContractRef({ root, state, maxLines });
  if (contractRef) {
    provenance.push({ kind: "contract", ref: contractRef.path, lines: contractRef.lines });
  }

  const contextQuery = [step.name, step.prompt, step.stage, ...(step.agents ?? [])].filter(Boolean).join(" ");
  const memory = await materializeProjectMemory({
    root,
    query: contextQuery,
    maxRefs: DEFAULT_MAX_MEMORY_REFS,
    maxLines: Math.min(24, maxLines),
  });
  for (const ref of memory.refs) {
    provenance.push({ kind: "memory", ref: ref.path, line: ref.line });
  }

  const graph = await readGraphStatus(root);
  if (graph.path) provenance.push({ kind: "code_graph", ref: graph.path, status: graph.status });

  const blastRadius = await materializeBlastRadius({
    root,
    query: contextQuery,
    maxRefs: DEFAULT_MAX_BLAST_RADIUS_REFS,
  });
  for (const ref of blastRadius.refs) {
    provenance.push({ kind: "blast_radius", ref: ref.path, line: ref.line, source: ref.source });
  }

  const userInputs = await materializeRunUserInputs({ root, state });
  for (const ref of userInputs.refs) {
    provenance.push({ kind: "user_input", ref: userInputs.path, line: ref.line, step_id: ref.step_id });
  }

  // FIX 4d: forward gate-failure feedback from a prior review FAIL so the step knows which
  // HIGH/CRITICAL findings it must address. ABSENT (not null) when no feedback has been recorded,
  // so workers that do not need it never see the field at all.
  const gfFeedback = state.gate_failure_feedback?.[step.id];
  const hasGfFeedback = Array.isArray(gfFeedback) && gfFeedback.length > 0;
  if (hasGfFeedback) {
    provenance.push({ kind: "gate_failure_remediation", count: gfFeedback.length });
  }

  const context = {
    schema: "aipi.context-packet.v1",
    run_id: state.run_id,
    workflow: workflow?.name ?? state.workflow,
    step_id: step.id,
    stage: step.stage ?? null,
    agents: step.agents ?? [],
    contract_path: state.contract_path,
    contract: contractRef,
    prior_steps: priorSteps,
    memory,
    code_graph: graph,
    blast_radius: blastRadius,
    user_inputs: userInputs,
    ...(hasGfFeedback ? { gate_failure_remediation: gfFeedback } : {}),
    provenance,
  };

  const contextRelPath = path.posix.join(runRelDir(state), "steps", step.id, "CONTEXT.json");
  await writeRunInternalArtifact({
    root,
    state,
    relPath: contextRelPath,
    content: `${JSON.stringify(context, null, 2)}\n`,
  });

  return context;
}

export async function materializeProjectMemory({
  root,
  query = "",
  maxRefs = DEFAULT_MAX_MEMORY_REFS,
  maxLines = 24,
} = {}) {
  const memoryRoot = path.join(root, ".aipi", "memory", "project");
  const files = await listMarkdownFiles(memoryRoot);
  const terms = tokenize(query);
  const refs = [];

  for (const file of files) {
    const rel = path.relative(root, file).replaceAll("\\", "/");
    const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
    const scored = [];
    for (const [index, line] of lines.entries()) {
      const score = scoreLine(line, terms);
      if (score > 0 || /^#{1,3}\s+/.test(line)) {
        scored.push({ score, index, line });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    for (const hit of scored.slice(0, Math.max(1, Math.min(2, maxRefs - refs.length)))) {
      refs.push({
        path: rel,
        line: hit.index + 1,
        excerpt: excerptAround(lines, hit.index, Math.min(6, maxLines)),
      });
      if (refs.length >= maxRefs) break;
    }
    if (refs.length >= maxRefs) break;
  }

  return {
    source: ".aipi/memory/project",
    status: files.length ? "available" : "missing",
    refs,
  };
}

async function materializeBlastRadius({ root, query = "", maxRefs = DEFAULT_MAX_BLAST_RADIUS_REFS } = {}) {
  if (!query?.trim()) {
    return {
      source: "aipi_retrieve",
      status: "skipped",
      reason: "empty query",
      refs: [],
      relationships: [],
    };
  }
  try {
    const retrieval = await aipiRetrieve({ projectRoot: root, query, limit: maxRefs });
    return {
      source: "aipi_retrieve",
      status: "available",
      graph: retrieval.graph,
      fusion: retrieval.fusion,
      refs: (retrieval.refs ?? []).slice(0, maxRefs),
      relationships: (retrieval.relationships ?? []).slice(0, maxRefs),
    };
  } catch (error) {
    return {
      source: "aipi_retrieve",
      status: "unavailable",
      reason: String(error?.message ?? error),
      refs: [],
      relationships: [],
    };
  }
}

async function readStepResultSummary({ root, state, stepId }) {
  const resultPath = path.join(root, runRelDir(state), "steps", stepId, "RESULT.json");
  const parsed = await readJson(resultPath);
  if (!parsed) return null;
  return {
    verdict: parsed.result?.verdict ?? null,
    gate_passed: parsed.validation?.gatePassed ?? null,
    policy_decision: parsed.validation?.policyDecision ?? parsed.result?.policy_decision ?? null,
    missing_artifacts: parsed.missing_artifacts ?? [],
  };
}

async function materializeArtifactExcerpts({
  root,
  stepId,
  artifacts,
  status,
  maxArtifacts,
  maxLines,
}) {
  const selected = [];
  for (const rel of artifacts.slice(0, maxArtifacts)) {
    const abs = path.join(root, rel);
    const text = await fs.readFile(abs, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (text == null) {
      if (status !== "skipped") {
        throw new ContextMaterializationError(`context artifact missing for step ${stepId}: ${rel}`, {
          step_id: stepId,
          artifact: rel,
        });
      }
      continue;
    }
    const lines = text.split(/\r?\n/);
    selected.push({
      path: rel,
      lines: `1-${Math.min(lines.length, maxLines)}`,
      excerpt: lines.slice(0, maxLines).join("\n"),
      truncated: lines.length > maxLines,
    });
  }
  return selected;
}

async function materializeContractRef({ root, state, maxLines }) {
  if (!state.contract_path) return null;
  const abs = path.join(root, state.contract_path);
  const text = await fs.readFile(abs, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text == null) {
    return {
      path: state.contract_path,
      status: "missing",
      excerpt: "",
      lines: null,
    };
  }
  const lines = text.split(/\r?\n/);
  return {
    path: state.contract_path,
    status: "available",
    lines: `1-${Math.min(lines.length, maxLines)}`,
    excerpt: lines.slice(0, maxLines).join("\n"),
    truncated: lines.length > maxLines,
  };
}

async function readGraphStatus(root) {
  const graphRel = ".aipi/state/aipi-graph.json";
  const sqliteRel = ".aipi/state/aipi-graph.sqlite";
  const graphAbs = path.join(root, graphRel);
  const parsed = await readJson(graphAbs);
  if (!parsed) {
    return {
      path: graphRel,
      sqlite_path: sqliteRel,
      status: "missing",
      stale: true,
      note: "Run aipi_retrieve, aipi_impact, or aipi_callers to rebuild the JSON/SQLite graph index.",
    };
  }
  return {
    path: graphRel,
    sqlite_path: sqliteRel,
    status: parsed.schema === "aipi.code-graph.v1" ? "available" : "unknown-schema",
    stale: Boolean(parsed.stale),
    built_at: parsed.built_at ?? null,
    source: parsed.source ?? null,
    sqlite: parsed.sqlite ?? { path: sqliteRel, status: "unknown" },
    vector: parsed.vector ?? parsed.sqlite?.vector ?? { status: "unknown", engine: "sqlite-vec" },
    file_count: parsed.files?.length ?? 0,
    symbol_count: parsed.symbols?.length ?? 0,
    relationship_count: parsed.relationships?.length ?? parsed.sqlite?.relationship_count ?? 0,
  };
}

async function materializeRunUserInputs({ root, state, maxRefs = 4, maxChars = 1200 } = {}) {
  const relPath = path.posix.join(runRelDir(state), "USER-INPUT.jsonl");
  const absPath = path.join(root, relPath);
  const text = await fs.readFile(absPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!text.trim()) {
    return {
      path: relPath,
      status: "missing",
      refs: [],
    };
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  const refs = [];
  for (const [index, line] of lines.entries()) {
    const parsed = safeJson(line);
    if (!parsed) continue;
    refs.push({
      line: index + 1,
      recorded_at: parsed.recorded_at ?? null,
      step_id: parsed.step_id ?? null,
      state_status: parsed.state_status ?? null,
      source: parsed.source ?? null,
      text: truncateText(parsed.text ?? "", maxChars),
    });
  }

  return {
    path: relPath,
    status: refs.length ? "available" : "unreadable",
    refs: refs.slice(-maxRefs),
  };
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function tokenize(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/)
      .filter((token) => token.length >= 4),
  );
}

function scoreLine(line, terms) {
  if (!terms.size) return 0;
  const normalized = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += 1;
  }
  return score;
}

function excerptAround(lines, index, maxLines) {
  const before = Math.max(0, index - Math.floor(maxLines / 2));
  return lines.slice(before, before + maxLines).join("\n");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateText(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[AIPI context pruned ${value.length - maxChars} chars from user input]`;
}

async function writeRunInternalArtifact({ root, state, relPath, content }) {
  const normalized = relPath.replaceAll("\\", "/");
  const expectedPrefix = `${runRelDir(state)}/`;
  if (!normalized.startsWith(expectedPrefix)) {
    throw new Error(`context write is outside active run namespace: ${relPath}`);
  }
  const abs = path.resolve(root, normalized);
  const runRoot = path.resolve(root, runRelDir(state));
  const runRootWithSep = runRoot.endsWith(path.sep) ? runRoot : `${runRoot}${path.sep}`;
  if (abs !== runRoot && !abs.startsWith(runRootWithSep)) {
    throw new Error(`context write escapes run root: ${relPath}`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function runRelDir(state) {
  return path.posix.join(".aipi", "runtime", "runs", state.run_id);
}
