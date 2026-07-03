import fs from "node:fs/promises";
import path from "node:path";
import { ensureCodeGraph } from "./aipi-tools.js";
import { assertAipiHostScopedModel, modelToPiModelId } from "./pi-subagents.js";

export const ONBOARDING_MEMORY_FILES = [
  "project.md",
  "business-rules.md",
  "decisions.md",
  "knowledge.md",
  "environment.md",
  "procedures.md",
  "deployment.md",
  "glossary.md",
];

const STUB_MARKERS = [
  "seeded by `/aipi-init`",
  "Seeded by `/aipi-init`",
  "Seeded by `aipi` project template",
  "No environment facts have been confirmed yet.",
  "No deployment path has been confirmed yet.",
  "No business rules have been accepted yet.",
  "No durable decisions have been recorded yet.",
  "No reusable project knowledge has been promoted yet.",
  "No procedures have been confirmed yet.",
  "No glossary terms have been confirmed yet.",
];
const ONBOARDING_MEMORY_SCHEMA_VERSION = 2;

const SKIP_DIRS = new Set([
  ".git",
  ".aipi",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".expo",
  ".venv",
  "venv",
  "__pycache__",
]);
const LOW_PRIORITY_INVENTORY_DIRS = new Set([
  ".aihaus",
  ".aipi",
  "docs",
  "doc",
  "documentation",
]);

const LANGUAGE_EXTENSIONS = new Map([
  [".js", "JavaScript"],
  [".jsx", "React JSX"],
  [".ts", "TypeScript"],
  [".tsx", "React Native / React TSX"],
  [".py", "Python"],
  [".md", "Markdown"],
  [".json", "JSON"],
  [".yml", "YAML"],
  [".yaml", "YAML"],
  [".css", "CSS"],
  [".html", "HTML"],
]);

const ONBOARDING_SWARM_DIMENSIONS = [
  {
    id: "architecture",
    agent_id: "onboarding-architecture",
    title: "Architecture, components, and entry points",
    memory_files: ["project.md", "knowledge.md"],
  },
  {
    id: "stack-validation",
    agent_id: "onboarding-stack-validation",
    title: "Stack, build, test, and CI",
    memory_files: ["environment.md", "procedures.md"],
  },
  {
    id: "domain-rules",
    agent_id: "onboarding-domain-rules",
    title: "Domain and business rules from models/services",
    memory_files: ["business-rules.md", "glossary.md"],
  },
  {
    id: "conventions",
    agent_id: "onboarding-conventions",
    title: "Conventions, lint, format, and patterns",
    memory_files: ["decisions.md", "procedures.md"],
  },
  {
    id: "deployment-environment",
    agent_id: "onboarding-deployment-environment",
    title: "Deployment and environment from configs",
    memory_files: ["environment.md", "deployment.md"],
  },
];

export function parseOnboardArgs(args = "") {
  const tokens = String(args).trim().split(/\s+/).filter(Boolean);
  const options = {
    targetRoot: null,
    noQuestions: false,
    noPullEmbeddings: false,
    rebuildGraph: false,
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--target") {
      const value = tokens[index + 1];
      if (!value) throw new Error("Missing value after --target");
      options.targetRoot = value;
      index += 1;
      continue;
    }
    if (token === "--no-questions") {
      options.noQuestions = true;
      continue;
    }
    if (token === "--rebuild-graph") {
      options.rebuildGraph = true;
      continue;
    }
    if (token === "--no-pull-embeddings") {
      options.noPullEmbeddings = true;
      continue;
    }
    throw new Error(`Unknown /aipi-onboard option: ${token}`);
  }

  return options;
}

export async function maybeRunPostInitOnboarding({
  projectRoot,
  ctx = {},
  coordinator = null,
  skip = false,
  now = () => new Date(),
  log = null,
  onProgress = null,
  pullEmbeddings = true,
  env = process.env,
} = {}) {
  if (skip) {
    return {
      action: "skipped",
      reason: "disabled",
      message: "AIPI onboarding skipped; run `/aipi-onboard` to seed project memory.",
    };
  }

  if (!isInteractiveContext(ctx)) {
    return nudge("non_interactive", log);
  }

  const hostModel = resolveOnboardingHostModel({ ctx, coordinator });
  if (!hostModel.ok) {
    return nudge("no_host_model", log);
  }

  return runProjectOnboarding({
    projectRoot,
    ctx,
    coordinator,
    hostModel: hostModel.model,
    source: "auto",
    now,
    onProgress,
    pullEmbeddings,
    env,
  });
}

export async function runProjectOnboarding({
  projectRoot,
  ctx = {},
  answers = {},
  askUser = true,
  coordinator = null,
  hostModel = null,
  source = "manual",
  now = () => new Date(),
  // Freshness-gated by default: a fresh manifest is reused; stale or
  // semantic-recoverable graphs rebuild; rebuildGraph forces a full rebuild.
  graphBuilder = ensureCodeGraph,
  rebuildGraph = false,
  materializeGraph = true,
  runWorker = Boolean(coordinator && hostModel),
  onProgress = null,
  pullEmbeddings = true,
  env = process.env,
  platform = process.platform,
} = {}) {
  const root = assertProjectRoot(projectRoot);
  const shouldPullEmbeddings = resolvePullEmbeddings({ pullEmbeddings, env });
  await emitOnboardingProgress(onProgress, {
    phase: "start",
    status: "running",
    message: "AIPI onboarding: starting repository inventory.",
  }, now);
  const inventory = await inventoryRepository(root);
  await emitOnboardingProgress(onProgress, {
    phase: "inventory",
    status: "done",
    message: `AIPI onboarding: inventory collected (${inventory.files_sample.length} files sampled).`,
  }, now);
  let graph = null;
  if (materializeGraph) {
    await emitOnboardingProgress(onProgress, {
      phase: "graph",
      status: "running",
      message: "AIPI onboarding: building code graph.",
    }, now);
    graph = await graphBuilder({
      projectRoot: root,
      now,
      env,
      rebuild: rebuildGraph,
      pullEmbeddings: shouldPullEmbeddings,
      platform,
      onProgress: (event) => emitOnboardingProgress(onProgress, event, now),
    });
    const graphBuildNote = graph.graph_build?.startsWith("reused")
      ? `reused fresh index (${graph.graph_build})`
      : "built";
    await emitOnboardingProgress(onProgress, {
      phase: "graph",
      status: "done",
      message: `AIPI onboarding: code graph ${graphBuildNote} (${graph.files?.length ?? 0} files, semantic ${graph.vector?.status ?? "unknown"}).`,
    }, now);
  }
  const investigation = await runOnboardingInvestigation({
    root,
    coordinator,
    hostModel,
    inventory,
    graph,
    now,
    enabled: Boolean(runWorker),
    onProgress,
  });
  const recommendations = askUser
    ? await askRecommendationQuestions({ ctx, inventory, investigation })
    : { asked: [], answers: {} };
  const collectedAnswers = {
    ...answers,
    ...recommendations.answers,
  };
  const memory = await seedProjectMemory({
    projectRoot: root,
    inventory,
    answers: collectedAnswers,
    investigation,
    now,
    force: false,
  });
  await emitOnboardingProgress(onProgress, {
    phase: "memory",
    status: "done",
    message: `AIPI onboarding: project memory seeded (${memory.written.length} written, ${memory.skipped_customized.length} preserved).`,
  }, now);

  const result = {
    schema: "aipi.project-onboarding.v1",
    action: "onboard",
    source,
    project_root: root,
    inventory,
    answers: collectedAnswers,
    memory,
    graph: graph
      ? {
          path: ".aipi/state/aipi-graph.json",
          sqlite_path: graph.sqlite?.path ?? ".aipi/state/aipi-graph.sqlite",
          sqlite_status: graph.sqlite?.status ?? "unknown",
          vector_status: graph.vector?.status ?? graph.sqlite?.vector?.status ?? "unknown",
          vector_dimensions: graph.vector?.dimensions ?? graph.sqlite?.vector?.dimensions ?? null,
          embedding_model: graph.vector?.embedding_model ?? graph.sqlite?.vector?.embedding_model ?? null,
          semantic_readiness: graph.vector?.readiness ?? null,
          embedding_pull: graph.vector?.embedding_pull ?? graph.sqlite?.embedding_pull ?? null,
          file_count: graph.files?.length ?? 0,
        }
      : null,
    semantic_readiness: graph?.vector?.readiness ?? null,
    embedding_pull: graph?.vector?.embedding_pull ?? graph?.sqlite?.embedding_pull ?? null,
    pull_embeddings: shouldPullEmbeddings,
    investigation,
    recommendations,
  };
  await recordOnboardingTrace(root, result);
  return result;
}

export function formatOnboardingResult(result) {
  if (result?.action === "skipped") return result.message;
  if (result?.action !== "onboard") return "AIPI onboarding did not run.";
  const memory = result.memory ?? {};
  const graph = result.graph ?? {};
  const lines = [
    "AIPI onboarding complete:",
    `${memory.written?.length ?? 0} memory pages written, ${memory.skipped_customized?.length ?? 0} customized pages preserved.`,
    `graph=${graph.path ?? "not-built"} sqlite=${graph.sqlite_status ?? "unknown"} path=${graph.sqlite_path ?? ".aipi/state/aipi-graph.sqlite"}`,
    `investigation=${result.investigation?.mode ?? "unknown"} workers=${result.investigation?.spawned_count ?? 0}`,
  ];
  const readiness = result.semantic_readiness ?? graph.semantic_readiness;
  if (readiness?.status && readiness.status !== "ready") {
    lines.push(readiness.message ?? "semantic memory is OFF - run `ollama pull bge-m3`, then re-run onboarding / rebuild.");
  }
  return lines.join("\n");
}

export async function inventoryRepository(projectRoot) {
  const root = assertProjectRoot(projectRoot);
  const topLevel = await listTopLevel(root);
  const files = await listRepoFiles(root);
  const inferenceFiles = files.filter((file) => !isLowPriorityInventoryFile(file));
  const packageManifests = await readPackageManifests(root, files);
  const python = await readPythonManifests(root, files);
  const ci = files.filter((file) => file.startsWith(".github/workflows/") || /^\.gitlab-ci\.ya?ml$/i.test(file));
  const docker = files.filter((file) => /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i.test(file));
  const languages = languageSummary(inferenceFiles);
  const entryPoints = inferEntryPoints(inferenceFiles, packageManifests);
  const commands = inferCommands(packageManifests, python);
  const codeFiles = inferenceFiles.filter(isInvestigableCodeFile).slice(0, 120);
  const candidateRules = await inferCodeCandidateRules(root, inferenceFiles);
  const configFiles = files.filter((file) => /(^|\/)(\.env\.example|\.env\.sample|docker-compose\.ya?ml|Dockerfile|package\.json|pyproject\.toml|requirements.*\.txt)$/i.test(file));
  const manifestPaths = [
    ...packageManifests.map((manifest) => manifest.path),
    ...python.requirements,
    ...python.pyprojects,
  ];

  return {
    top_level: topLevel,
    files_sample: representativeFileSample({ files, manifestPaths, limit: 80 }),
    file_count: files.length,
    inference_file_count: inferenceFiles.length,
    has_code: codeFiles.length > 0,
    code_files: codeFiles,
    config_files: configFiles,
    languages,
    package_manifests: packageManifests,
    python,
    ci,
    docker,
    entry_points: entryPoints,
    commands,
    stack: inferStack({ files: inferenceFiles, packageManifests, python }),
    domains: inferDomains(inferenceFiles),
    candidate_rules: candidateRules,
  };
}

export function isStubMemoryPage(content) {
  const text = String(content ?? "");
  return STUB_MARKERS.some((marker) => text.includes(marker));
}

function isAutoSeededMemoryPage(content) {
  const text = String(content ?? "");
  return /Seeded (?:by|from).*\/aipi-onboard|Project memory seeded by \/aipi-onboard/i.test(text) ||
    /onboarding_seeded:\s*true/i.test(text);
}

function hasHumanMemoryEditMarker(content) {
  return /user-customized|human-customized|human-edited|manual edit|manual-edit|memory_promoted:\s*true/i.test(String(content ?? ""));
}

export async function seedProjectMemory({
  projectRoot,
  inventory,
  answers = {},
  investigation = null,
  now = () => new Date(),
  force = false,
} = {}) {
  const root = assertProjectRoot(projectRoot);
  const memoryRoot = path.join(root, ".aipi", "memory", "project");
  const summary = {
    written: [],
    skipped_customized: [],
    missing: [],
  };

  for (const file of ONBOARDING_MEMORY_FILES) {
    const target = path.join(memoryRoot, file);
    const existing = await fs.readFile(target, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing == null) {
      summary.missing.push(file);
      continue;
    }
    if (!force && !isStubMemoryPage(existing) && (!isAutoSeededMemoryPage(existing) || hasHumanMemoryEditMarker(existing))) {
      summary.skipped_customized.push(file);
      continue;
    }
    const date = now().toISOString().slice(0, 10);
    const frontmatter = onboardingFrontmatter({ existing, date });
    const content = renderMemoryPage({
      file,
      frontmatter,
      inventory,
      answers,
      investigation,
      date,
    });
    await fs.writeFile(target, content);
    summary.written.push(file);
  }

  return summary;
}

function assertProjectRoot(projectRoot) {
  if (!projectRoot) throw new Error("projectRoot is required");
  return path.resolve(projectRoot);
}

function nudge(reason, log) {
  const result = {
    action: "skipped",
    reason,
    message: "AIPI init complete. Run `/aipi-onboard` to seed project memory.",
  };
  log?.(result.message);
  return result;
}

function resolvePullEmbeddings({ pullEmbeddings = true, env = process.env } = {}) {
  if (pullEmbeddings === false) return false;
  return !/^(0|false|no|off)$/i.test(String(env.AIPI_PULL_EMBEDDINGS ?? "").trim());
}

async function emitOnboardingProgress(onProgress, event, now = () => new Date()) {
  if (typeof onProgress !== "function") return;
  try {
    await Promise.resolve(onProgress({
      schema: "aipi.project-onboarding.progress.v1",
      emitted_at: now().toISOString(),
      ...event,
    }));
  } catch {
    /* progress is best-effort; onboarding result remains authoritative */
  }
}

async function recordOnboardingTrace(root, result) {
  const trace = {
    schema: "aipi.project-onboarding.trace.v1",
    recorded_at: new Date().toISOString(),
    source: result.source,
    action: result.action,
    memory: result.memory,
    graph: result.graph,
    semantic_readiness: result.semantic_readiness,
    embedding_pull: result.embedding_pull ?? null,
    pull_embeddings: result.pull_embeddings ?? null,
    investigation: {
      mode: result.investigation?.mode ?? null,
      status: result.investigation?.status ?? null,
      spawned_count: result.investigation?.spawned_count ?? 0,
    },
    recommendations: {
      asked_count: result.recommendations?.asked?.length ?? 0,
      keys: Object.keys(result.recommendations?.answers ?? {}),
    },
  };
  const tracePath = path.join(root, ".aipi", "runtime", "onboarding", "onboarding.jsonl");
  await fs.mkdir(path.dirname(tracePath), { recursive: true });
  await fs.appendFile(tracePath, `${JSON.stringify(trace)}\n`);
}

function isInteractiveContext(ctx) {
  return Boolean(ctx?.hasUI === true && (typeof ctx?.ui?.select === "function" || typeof ctx?.ui?.input === "function"));
}

function resolveOnboardingHostModel({ ctx = {}, coordinator = null } = {}) {
  const candidates = [
    ctx.model,
    ctx.current_model,
    ctx.currentModel,
    ctx.selected_model,
    ctx.selectedModel,
    ctx.payload?.model,
    typeof ctx.getModel === "function" ? ctx.getModel() : null,
    coordinator?.getHostModel?.(),
  ];
  for (const candidate of candidates) {
    const modelId = modelToPiModelId(candidate);
    try {
      assertAipiHostScopedModel(modelId, { requireProvider: true });
      return { ok: true, model: candidate };
    } catch {
      /* try next candidate */
    }
  }
  return { ok: false, model: null };
}

async function askRecommendationQuestions({ ctx, inventory, investigation }) {
  const question = buildRecommendationQuestion({ inventory, investigation });
  if (!question) return { asked: [], answers: {} };
  const asked = [{ key: question.key, question: question.question, options: question.options, allow_free_text: true }];
  if (typeof ctx?.ui?.select !== "function") {
    return { asked, answers: {}, skipped_reason: "select_unavailable" };
  }
  const selected = await Promise.resolve(ctx.ui.select(question.question, [...question.options, "Other / free text"]));
  const answer = String(selected ?? "").trim();
  if (!answer) return { asked, answers: {} };
  return {
    asked,
    answers: {
      [question.key]: answer === "Other / free text" && typeof ctx?.ui?.input === "function"
        ? String(await Promise.resolve(ctx.ui.input("Describe the project priority in one sentence.")) ?? "").trim()
        : answer,
    },
  };
}

function buildRecommendationQuestion({ inventory }) {
  if (!inventory?.has_code) {
    return {
      key: "purpose",
      question: "No code was found yet. Which project direction should AIPI assume?",
      options: [
        "Scaffold only and keep memory minimal",
        "Prepare for a new application",
        "Import context later",
      ],
    };
  }
  const purpose = inferProjectPurpose(inventory);
  if (purpose.confidence >= 0.6) return null;
  return {
    key: "purpose",
    question: "AIPI inferred several possible project priorities. Which should it record?",
    options: [
      purpose.text,
      "Stabilize the existing application",
      "Map the codebase before feature work",
    ].filter(Boolean).slice(0, 3),
  };
}

async function runOnboardingInvestigation({ root, coordinator, hostModel, inventory, graph, now, enabled, onProgress = null }) {
  if (!inventory.has_code) {
    await emitOnboardingProgress(onProgress, {
      phase: "investigation",
      status: "skipped",
      message: "AIPI onboarding: investigation skipped for empty repository.",
    }, now);
    return {
      mode: "empty_repo",
      status: "skipped_empty_repo",
      spawned_count: 0,
      dimensions: [],
      summary: "No substantive code files were detected; onboarding used the lightweight scaffold path.",
    };
  }
  if (!enabled || !coordinator || !hostModel) {
    await emitOnboardingProgress(onProgress, {
      phase: "investigation",
      status: "skipped",
      message: "AIPI onboarding: using deterministic repository facts.",
    }, now);
    return {
      mode: "deterministic",
      status: "worker_unavailable",
      spawned_count: 0,
      dimensions: [],
      summary: "Repository facts were inferred deterministically because no project-scoped worker swarm was available.",
    };
  }
  const runId = `onboarding-${now().toISOString().replace(/[^0-9A-Za-z]+/g, "-")}`;
  const spawned = [];
  await emitOnboardingProgress(onProgress, {
    phase: "investigation",
    status: "running",
    message: `AIPI onboarding: starting investigation swarm (${ONBOARDING_SWARM_DIMENSIONS.length} workers).`,
  }, now);
  for (const dimension of ONBOARDING_SWARM_DIMENSIONS) {
    const artifact = `.aipi/runtime/onboarding/${runId}/${dimension.id}.md`;
    const { agent_id: agentId } = coordinator.spawn({
      agent_id: dimension.agent_id,
      step_id: `project_onboarding_${dimension.id}`,
      model: hostModel,
      context_packet: [
        `Investigate this repository for AIPI onboarding: ${dimension.title}.`,
        "Use repository-local evidence and AIPI graph tools when available: aipi_retrieve first, then aipi_impact, aipi_callers, aipi_semantic_search for narrower checks.",
        "Write a concise markdown artifact with facts and confidence. Do not ask the user and do not write durable memory.",
        onboardingDimensionInstruction(dimension),
        `Memory pages this finding can inform: ${dimension.memory_files.join(", ")}`,
        `Graph source: ${graph?.source ?? "not-built"}; semantic readiness: ${graph?.vector?.readiness?.status ?? graph?.vector?.status ?? "unknown"}`,
        `Deterministic inventory: ${JSON.stringify(inventory).slice(0, 5000)}`,
      ].filter(Boolean).join("\n"),
      owned_files: [artifact],
      expected_artifacts: [artifact],
      artifact_target: path.posix.dirname(artifact),
      // 120s proved too tight in the field: the stack dimension hit the budget
      // while a hung environment probe was still inside the 60s watchdog
      // silence window, killing an otherwise-progressing worker 2s early.
      budget: { timeout_ms: 240000, max_tool_calls: 30 },
    });
    spawned.push({ ...dimension, agent_id: agentId, artifact });
    await emitOnboardingProgress(onProgress, {
      phase: "investigation",
      status: "spawned",
      worker_id: dimension.id,
      worker_title: dimension.title,
      worker_index: spawned.length,
      worker_count: ONBOARDING_SWARM_DIMENSIONS.length,
      message: `AIPI onboarding: investigating ${spawned.length}/${ONBOARDING_SWARM_DIMENSIONS.length}: ${dimension.title}.`,
    }, now);
  }
  const dimensions = await Promise.all(spawned.map(async (worker, index) => {
    try {
      await waitForCoordinatorDone(coordinator, worker.agent_id);
      const collected = coordinator.collect(worker.agent_id);
      const candidateRules = worker.id === "domain-rules"
        ? await readCandidateRulesFromArtifacts({ root, artifacts: collected.artifacts?.length ? collected.artifacts : [worker.artifact] })
        : [];
      const result = {
        id: worker.id,
        title: worker.title,
        agent_id: worker.agent_id,
        status: collected.ready ? "done" : "not_ready",
        verdict: collected.step_result?.verdict ?? null,
        artifacts: collected.artifacts?.length ? collected.artifacts : [worker.artifact],
      };
      if (candidateRules.length) result.candidate_rules = candidateRules;
      await emitOnboardingProgress(onProgress, {
        phase: "investigation",
        status: result.status,
        worker_id: worker.id,
        worker_title: worker.title,
        worker_index: index + 1,
        worker_count: spawned.length,
        message: `AIPI onboarding: investigation ${index + 1}/${spawned.length} ${result.status}: ${worker.title}.`,
      }, now);
      return result;
    } catch (error) {
      const result = {
        id: worker.id,
        title: worker.title,
        agent_id: worker.agent_id,
        status: "failed",
        error: String(error?.message ?? error),
        artifacts: [worker.artifact],
      };
      await emitOnboardingProgress(onProgress, {
        phase: "investigation",
        status: "failed",
        worker_id: worker.id,
        worker_title: worker.title,
        worker_index: index + 1,
        worker_count: spawned.length,
        message: `AIPI onboarding: investigation ${index + 1}/${spawned.length} failed: ${worker.title}.`,
      }, now);
      return result;
    }
  }));
  await emitOnboardingProgress(onProgress, {
    phase: "investigation",
    status: dimensions.every((item) => item.status === "done") ? "done" : "partial",
    message: `AIPI onboarding: investigation swarm finished (${dimensions.filter((item) => item.status === "done").length}/${dimensions.length} done).`,
  }, now);
  return {
    mode: "swarm",
    status: dimensions.every((item) => item.status === "done") ? "done" : "partial",
    spawned_count: spawned.length,
    dimensions,
    summary: "Project onboarding investigated architecture, stack/validation, domain rules, conventions, and deployment/environment via spawned workers.",
  };
}

function onboardingDimensionInstruction(dimension) {
  if (dimension?.id === "stack-validation") {
    return [
      "Derive the stack, build, test, and CI picture from FILES: package.json scripts, lockfiles, pyproject/requirements, Dockerfiles, compose files, Makefile, and CI workflow/buildspec configs.",
      "Do NOT execute environment or version probe commands (node/python/docker/git --version, docker info, installers): they hang on machines where the tool is absent or stopped, and workstation verification is `aipi setup`'s job, not onboarding's.",
      "Only run a shell command when a file alone cannot answer, and prefer fast bounded commands.",
    ].join(" ");
  }
  if (dimension?.id !== "domain-rules") return null;
  return [
    "For domain-rules, mine actual source code for concrete candidate rules.",
    "Look for validation guards, schema constraints, model field constraints/enums, state transitions, authorization checks, price/quantity/date/quota invariants, uniqueness/required-field checks, and service conditionals.",
    "Emit each rule as: - CANDIDATE: <specific rule statement> | source_ref: <path:line or symbol> | evidence: <short evidence>.",
    "Keep rules CANDIDATE, not accepted; do not emit generic 'Changes touching <domain>' boilerplate when concrete evidence exists.",
  ].join(" ");
}

async function readCandidateRulesFromArtifacts({ root, artifacts = [] } = {}) {
  const rules = [];
  for (const artifact of artifacts) {
    const abs = safeArtifactPath(root, artifact);
    if (!abs) continue;
    const text = await fs.readFile(abs, "utf8").catch(() => "");
    rules.push(...parseCandidateRulesFromText(text, artifact));
  }
  return mergeCandidateRules(rules);
}

function safeArtifactPath(root, artifact) {
  const rel = String(artifact ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return abs === root || abs.startsWith(rootWithSep) ? abs : null;
}

function parseCandidateRulesFromText(text, artifact) {
  const lines = String(text ?? "").split(/\r?\n/);
  const rules = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/CANDIDATE:/i.test(line)) continue;
    const statement = line
      .replace(/^[-*]\s*/, "")
      .replace(/^CANDIDATE:\s*/i, "")
      .split(/\s+\|\s+source_ref:|\s+\(source_ref:/i)[0]
      .trim();
    const sourceRef = line.match(/source_ref:\s*([^|)]+)/i)?.[1]?.trim()
      ?? lines[index + 1]?.match(/source_ref:\s*(.+)$/i)?.[1]?.trim()
      ?? artifact;
    const evidence = line.match(/evidence:\s*([^|)]+)/i)?.[1]?.trim() ?? "";
    if (statement && sourceRef) {
      rules.push({
        statement: stripTrailingPunctuation(statement),
        source_ref: sourceRef,
        evidence,
        status: "candidate",
        source: "swarm-domain-rules",
      });
    }
  }
  return rules;
}

// Must stay ABOVE the worker budget (240s) or the wait gives up while the
// coordinator would still let the worker finish.
async function waitForCoordinatorDone(coordinator, agentId, { timeoutMs = 270000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const status = coordinator.status(agentId);
    if (["done", "failed", "cancelled", "canceled"].includes(String(status.state).toLowerCase())) {
      if (status.state !== "done") throw new Error(status.error ?? `onboarding worker ended as ${status.state}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("onboarding worker timed out");
}

async function listTopLevel(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort();
}

async function listRepoFiles(root, { maxFiles = null } = {}) {
  const out = [];
  await walkBreadthFirst(root, out, maxFiles);
  return out;
}

async function walkBreadthFirst(root, out, maxFiles) {
  const queue = [""];
  while (queue.length) {
    if (maxFiles != null && out.length >= maxFiles) return;
    const relDir = queue.shift();
    const absDir = path.join(root, relDir);
    const entries = (await fs.readdir(absDir, { withFileTypes: true }).catch(() => []))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = path.posix.join(relDir.replaceAll("\\", "/"), entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(rel);
      if (maxFiles != null && out.length >= maxFiles) return;
    }
  }
}

function representativeFileSample({ files = [], manifestPaths = [], limit = 80 } = {}) {
  const out = [];
  const seen = new Set();
  const add = (file) => {
    if (!file || seen.has(file) || out.length >= limit) return;
    seen.add(file);
    out.push(file);
  };
  for (const file of manifestPaths) add(file);
  const byTopLevel = new Map();
  for (const file of files) {
    const top = file.split("/")[0] || ".";
    if (!byTopLevel.has(top)) byTopLevel.set(top, []);
    byTopLevel.get(top).push(file);
  }
  const buckets = [...byTopLevel.entries()]
    .sort(([left], [right]) => inventoryPriority(left) - inventoryPriority(right) || left.localeCompare(right))
    .map(([, bucket]) => bucket);
  let index = 0;
  while (out.length < limit && buckets.some((bucket) => index < bucket.length)) {
    for (const bucket of buckets) add(bucket[index]);
    index += 1;
  }
  return out;
}

function inventoryPriority(topLevel) {
  return LOW_PRIORITY_INVENTORY_DIRS.has(String(topLevel ?? "").toLowerCase()) ? 10 : 0;
}

async function readPackageManifests(root, files) {
  const manifests = [];
  for (const rel of files.filter((file) => file.endsWith("package.json"))) {
    const parsed = await readJson(path.join(root, rel));
    if (!parsed) continue;
    manifests.push({
      path: rel,
      name: parsed.name ?? null,
      scripts: parsed.scripts ?? {},
      dependencies: Object.keys(parsed.dependencies ?? {}),
      devDependencies: Object.keys(parsed.devDependencies ?? {}),
    });
  }
  return manifests;
}

async function readPythonManifests(root, files) {
  const requirements = files.filter((file) => /(^|\/)requirements.*\.txt$/i.test(file));
  const pyprojects = files.filter((file) => file.endsWith("pyproject.toml"));
  return {
    requirements,
    pyproject: pyprojects[0] ?? null,
    pyprojects,
    has_pytest: files.some((file) => /(^|\/)tests?\//.test(file) || /(^|\/)pytest\.ini$/.test(file)),
    has_manage_py: files.includes("manage.py"),
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function languageSummary(files) {
  const counts = new Map();
  for (const file of files) {
    const language = LANGUAGE_EXTENSIONS.get(path.extname(file).toLowerCase());
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => ({ language, count }));
}

function inferEntryPoints(files, packageManifests) {
  const candidates = [
    "App.tsx",
    "App.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "frontend/src/App.tsx",
    "frontend/src/App.jsx",
    "backend/app.py",
    "backend/main.py",
    "app.py",
    "main.py",
    "manage.py",
  ];
  return [
    ...candidates.filter((candidate) => files.includes(candidate)),
    ...packageManifests.flatMap((manifest) => Object.entries(manifest.scripts ?? {})
      .filter(([name]) => /^(start|dev|serve)$/i.test(name))
      .map(([name, command]) => `${manifest.path} script:${name} -> ${command}`)),
  ];
}

function inferCommands(packageManifests, python) {
  const commands = [];
  for (const manifest of packageManifests) {
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (/^(test|lint|build|typecheck|start|dev|serve)$/i.test(name)) {
        commands.push(`${manifest.path}: npm run ${name} (${command})`);
      }
    }
  }
  if (python.has_pytest) commands.push("pytest");
  if (python.requirements.length) commands.push(`pip install -r ${python.requirements[0]}`);
  return commands;
}

function inferStack({ files, packageManifests, python }) {
  const deps = new Set(packageManifests.flatMap((manifest) => [
    ...manifest.dependencies,
    ...manifest.devDependencies,
  ]));
  const stack = [];
  if (deps.has("react-native") || deps.has("expo")) stack.push("React Native");
  else if (deps.has("react")) stack.push("React");
  if (deps.has("next")) stack.push("Next.js");
  if (files.some((file) => file.endsWith(".py")) || python.pyprojects?.length || python.requirements.length) stack.push("Python");
  if (deps.has("express")) stack.push("Express");
  if (deps.has("vite")) stack.push("Vite");
  if (files.some((file) => /^backend\//.test(file)) && files.some((file) => /^frontend\//.test(file))) {
    stack.push("frontend/backend monorepo");
  }
  return [...new Set(stack)];
}

function isLowPriorityInventoryFile(file) {
  const firstSegment = String(file ?? "").replaceAll("\\", "/").split("/")[0]?.toLowerCase();
  return LOW_PRIORITY_INVENTORY_DIRS.has(firstSegment);
}

function isInvestigableCodeFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (![".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".rb", ".php", ".java", ".cs"].includes(ext)) return false;
  return !/(^|\/)(node_modules|dist|build|coverage|\.aipi)\//.test(file);
}

function inferDomains(files) {
  const domains = [];
  const joined = files.join("\n").toLowerCase();
  for (const [label, pattern] of [
    ["authentication", /\b(auth|login|session|user|account)\b/],
    ["billing", /\b(billing|payment|invoice|subscription|checkout|price)\b/],
    ["care workflows", /\b(patient|appointment|clinical|care|task)\b/],
    ["content", /\b(post|article|cms|media|asset)\b/],
    ["operations", /\b(order|workflow|queue|job|ticket)\b/],
    ["deployment", /\b(docker|deploy|k8s|helm|terraform)\b/],
  ]) {
    if (pattern.test(joined)) domains.push(label);
  }
  return domains;
}

function extractFrontmatter(content) {
  const match = String(content ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? match[0] : "";
}

function onboardingFrontmatter({ existing, date }) {
  const frontmatter = extractFrontmatter(existing);
  const lines = frontmatter
    ? frontmatter.replace(/^---\r?\n/, "").replace(/\r?\n---\r?\n?$/, "").split(/\r?\n/)
    : [];
  const fields = new Map();
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) fields.set(match[1], match[2]);
  }
  fields.set("onboarding_seeded", "true");
  fields.set("onboarding_schema_version", String(ONBOARDING_MEMORY_SCHEMA_VERSION));
  fields.set("onboarding_updated_at", date);
  const out = ["---"];
  for (const [key, value] of fields.entries()) out.push(`${key}: ${value}`);
  out.push("---", "");
  return out.join("\n");
}

function renderMemoryPage({ file, frontmatter, inventory, answers, investigation, date }) {
  const renderers = {
    "project.md": renderProjectPage,
    "business-rules.md": renderBusinessRulesPage,
    "decisions.md": renderDecisionsPage,
    "knowledge.md": renderKnowledgePage,
    "environment.md": renderEnvironmentPage,
    "procedures.md": renderProceduresPage,
    "deployment.md": renderDeploymentPage,
    "glossary.md": renderGlossaryPage,
  };
  const insights = deriveProjectInsights({ inventory, answers, investigation });
  const body = (renderers[file] ?? renderKnowledgePage)({ inventory, answers, investigation, insights, date });
  return `${frontmatter || ""}${body}\n`;
}

function renderProjectPage({ inventory, insights, date }) {
  return [
    "# Project Context",
    "",
    "## Current truth",
    "",
    insights.purpose,
    "",
    "## Details",
    "",
    "### Stack",
    "",
    listOrNone(inventory.stack),
    "",
    "### Repository layout",
    "",
    listOrNone(inventory.top_level),
    "",
    "### Entry points",
    "",
    listOrNone(inventory.entry_points),
    "",
    "### Commands",
    "",
    listOrNone(inventory.commands),
    "",
    "### Investigation",
    "",
    listOrNone(insights.investigationFacts),
    "",
    "## Links",
    "",
    "- rules: business-rules.md",
    "- decisions: decisions.md",
    "- environment: environment.md",
    "",
    "## Timeline",
    "",
    `- ${date}: Project memory seeded by /aipi-onboard from repository investigation.`,
  ].join("\n");
}

function renderBusinessRulesPage({ insights, date }) {
  return [
    "# Business Rules",
    "",
    "## Current truth",
    "",
    insights.businessSummary,
    "",
    "## Details",
    "",
    "### Candidate domains",
    "",
    listOrNone(insights.domains),
    "",
    "### Candidate rules from code",
    "",
    listOrNone(insights.candidateRules),
    "",
    "## Links",
    "",
    "- project: project.md",
    "- decisions: decisions.md",
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded from /aipi-onboard repository investigation; treat candidate rules as inferred until accepted.`,
  ].join("\n");
}

function renderDecisionsPage({ inventory, insights, date }) {
  return [
    "# Decisions",
    "",
    "## Current truth",
    "",
    "Observed technical choices were inferred from repository files; keep them as candidate decisions until explicitly changed.",
    "",
    "## Details",
    "",
    "### Observed technical choices",
    "",
    listOrNone(inventory.stack.map((item) => `Uses ${item}`)),
    "",
    "### Conventions evidence",
    "",
    listOrNone(insights.conventions),
    "",
    "## Links",
    "",
    "- project: project.md",
    "- knowledge: knowledge.md",
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard from repository inventory.`,
  ].join("\n");
}

function renderKnowledgePage({ inventory, insights, date }) {
  return [
    "# Knowledge",
    "",
    "## Current truth",
    "",
    "Repository inventory has been captured for future context retrieval.",
    "",
    "## Details",
    "",
    "### Languages",
    "",
    listOrNone(inventory.languages.map((item) => `${item.language}: ${item.count} files`)),
    "",
    "### Manifests",
    "",
    listOrNone([
      ...inventory.package_manifests.map((item) => item.path),
      ...inventory.python.requirements,
      ...(inventory.python.pyprojects ?? [inventory.python.pyproject]),
    ].filter(Boolean)),
    "",
    "### High-signal files",
    "",
    listOrNone(insights.highSignalFiles),
    "",
    "## Links",
    "",
    "- project: project.md",
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard.`,
  ].join("\n");
}

function renderEnvironmentPage({ inventory, insights, date }) {
  return [
    "# Environment",
    "",
    "## Current truth",
    "",
    "No secrets were recorded. Only commands and credential locations belong here.",
    "",
    "## Details",
    "",
    "### Local",
    "",
    listOrNone(inventory.commands),
    "",
    "### CI",
    "",
    listOrNone(inventory.ci),
    "",
    "### Config files",
    "",
    listOrNone(inventory.config_files),
    "",
    "### Credentials",
    "",
    "- Anthropic OAuth sidecar: `~/.pi/agent/anthropic-auth.json`",
    "- Anthropic OAuth sidecar override: `PI_ANTHROPIC_AUTH_FILE`",
    "- Login command: `/login anthropic`",
    "",
    "### Readiness notes",
    "",
    listOrNone(insights.environmentNotes),
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard.`,
  ].join("\n");
}

function renderProceduresPage({ inventory, insights, date }) {
  return [
    "# Procedures",
    "",
    "## Current truth",
    "",
    "Procedures are inferred from repository commands and still need confirmation.",
    "",
    "## Details",
    "",
    "### Local validation",
    "",
    listOrNone(inventory.commands),
    "",
    "### Recommended sequence",
    "",
    listOrNone(insights.validationSequence),
    "",
    "## Links",
    "",
    "- environment: environment.md",
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard.`,
  ].join("\n");
}

function renderDeploymentPage({ inventory, insights, date }) {
  return [
    "# Deployment",
    "",
    "## Current truth",
    "",
    "Deployment remains advisory until commands and approval rules are confirmed.",
    "",
    "Production actions are policy-gated inside the Pi process. Shell access is not approval.",
    "",
    "Until the Pi `tool_call` policy layer exists, deployment and production files are advisory planning artifacts only.",
    "",
    "## Details",
    "",
    "### Deployment evidence found",
    "",
    listOrNone([...inventory.docker, ...inventory.ci]),
    "",
    "### Deployment notes",
    "",
    listOrNone(insights.deploymentNotes),
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard.`,
  ].join("\n");
}

function renderGlossaryPage({ insights, date }) {
  const terms = insights.glossaryTerms.slice(0, 20);
  return [
    "# Glossary",
    "",
    "## Current truth",
    "",
    "Glossary terms are inferred from repository stack, domains, and file names.",
    "",
    "## Details",
    "",
    "### Candidate terms",
    "",
    listOrNone(terms),
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard.`,
  ].join("\n");
}

function deriveProjectInsights({ inventory, answers = {}, investigation = null }) {
  const purpose = String(answers.purpose ?? "").trim() || inferProjectPurpose(inventory).text;
  const domains = [...new Set([
    ...structuredListTerms(answers.domain ?? ""),
    ...(inventory.domains ?? []),
    ...inferDomainTermsFromPaths(inventory.code_files ?? []),
  ])].slice(0, 12);
  const concreteCandidateRules = mergeCandidateRules([
    ...(investigation?.dimensions ?? []).flatMap((dimension) => dimension.candidate_rules ?? []),
    ...(inventory.candidate_rules ?? []),
  ]);
  const candidateRules = inferCandidateRules({ inventory, domains, concreteCandidateRules });
  const highSignalFiles = [
    ...(inventory.entry_points ?? []),
    ...(inventory.code_files ?? []).filter((file) => /(^|\/)(app|main|index|server|api|routes|models|services)\./i.test(file)),
    ...(inventory.package_manifests ?? []).map((manifest) => manifest.path),
  ].slice(0, 20);
  const investigationFacts = [
    investigation?.mode === "swarm" ? `Swarm investigation ran with ${investigation.spawned_count} workers.` : investigation?.summary,
    ...(investigation?.dimensions ?? []).map((item) => `${item.title}: ${item.status}`),
  ].filter(Boolean);
  const conventions = [
    inventory.commands.some((command) => /lint/i.test(command)) ? "Lint command detected." : null,
    inventory.commands.some((command) => /test|jest|pytest/i.test(command)) ? "Automated test command detected." : null,
    inventory.languages.some((item) => /TypeScript/.test(item.language)) ? "TypeScript is part of the codebase." : null,
  ].filter(Boolean);
  const environmentNotes = [
    inventory.ci.length ? "CI workflow files were detected." : "No CI workflow file detected.",
    inventory.docker.length ? "Docker/deployment config was detected." : "No Docker deployment file detected.",
    inventory.config_files.length ? "Configuration files were found and should be used before asking for environment details." : null,
  ].filter(Boolean);
  const validationSequence = inventory.commands.filter((command) => /test|lint|build|typecheck/i.test(command));
  const deploymentNotes = [
    ...inventory.docker.map((file) => `Deployment evidence: ${file}`),
    ...inventory.ci.map((file) => `CI evidence: ${file}`),
    inventory.docker.length || inventory.ci.length ? "Keep production execution gated; onboarding records evidence only." : "No deployment path inferred from repository files.",
  ];
  const glossaryTerms = [...new Set([
    ...inventory.stack,
    ...domains,
    ...inferDomainTermsFromPaths(inventory.code_files ?? []),
  ])];
  return {
    purpose,
    domains,
    businessSummary: concreteCandidateRules.length
      ? `Concrete candidate business rules were inferred from source evidence (${concreteCandidateRules.length}); review and accept before treating them as policy.`
      : domains.length
      ? `Candidate business/domain context inferred from code: ${domains.join(", ")}.`
      : "No accepted business rules were found; onboarding recorded code-derived candidates only.",
    candidateRules,
    highSignalFiles,
    investigationFacts,
    conventions,
    environmentNotes,
    validationSequence,
    deploymentNotes,
    glossaryTerms,
  };
}

function inferProjectPurpose(inventory = {}) {
  const names = (inventory.package_manifests ?? []).map((manifest) => manifest.name).filter(Boolean);
  const stack = inventory.stack ?? [];
  const domains = inventory.domains ?? [];
  if (names.length && stack.length) {
    return {
      confidence: 0.75,
      text: `${names[0]} appears to be a ${stack.join(" + ")} project${domains.length ? ` for ${domains.slice(0, 3).join(", ")}` : ""}.`,
    };
  }
  if (stack.length) {
    return {
      confidence: 0.65,
      text: `This appears to be a ${stack.join(" + ")} project inferred from repository files.`,
    };
  }
  return {
    confidence: 0.35,
    text: "Map the existing repository before feature work.",
  };
}

function inferDomainTermsFromPaths(files = []) {
  const terms = new Set();
  for (const file of files) {
    for (const segment of file.split(/[\/_.-]+/)) {
      if (/^(src|lib|app|index|main|test|tests|spec|components|utils|hooks|pages|api)$/i.test(segment)) continue;
      if (segment.length >= 4 && /^[a-z][a-z0-9]+$/i.test(segment)) terms.add(segment.toLowerCase());
    }
  }
  return [...terms].slice(0, 12);
}

async function inferCodeCandidateRules(root, files = []) {
  const targets = files
    .filter(isInvestigableCodeFile)
    .sort((left, right) => ruleScanPriority(left) - ruleScanPriority(right) || left.localeCompare(right))
    .slice(0, 200);
  const rules = [];
  for (const rel of targets) {
    const abs = path.join(root, rel);
    const text = await fs.readFile(abs, "utf8").catch(() => "");
    if (!text) continue;
    rules.push(...extractCandidateRulesFromSource(rel, text.slice(0, 80_000)));
    if (rules.length >= 20) break;
  }
  return mergeCandidateRules(rules).slice(0, 12);
}

function ruleScanPriority(file) {
  if (/(^|\/)(models?|services?|schemas?|validators?|validation|rules?|polic(?:y|ies)|permissions?|auth|billing|payments?|orders?|subscriptions?|pricing|quota|state|status)(\/|\.|-|_)/i.test(file)) return 0;
  if (/(^|\/)(api|routes|controllers?)(\/|\.|-|_)/i.test(file)) return 1;
  if (/(^|\/)(src|app|backend|frontend)\//i.test(file)) return 2;
  return 5;
}

function extractCandidateRulesFromSource(rel, text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const rules = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sourceRef = `${rel}:${index + 1}`;
    const guard = line.match(/\bif\s*(?:\(\s*)?([A-Za-z_$][\w.$]*)\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)/);
    if (guard && isRejectingGuard(lines.slice(index, index + 4).join(" "))) {
      rules.push({
        statement: comparisonGuardStatement(guard[1], guard[2], guard[3]),
        source_ref: sourceRef,
        evidence: compactEvidence(line),
        status: "candidate",
        source: "static-guard-scan",
      });
    }

    for (const rule of schemaConstraintRules(line, sourceRef)) rules.push(rule);
  }
  return rules;
}

function schemaConstraintRules(line, sourceRef) {
  const rules = [];
  const zod = line.match(/\b([A-Za-z_$][\w$]*)\s*:\s*z\.(number|string)\(\)([^,\n}]*)/);
  if (zod) {
    for (const constraint of zod[3].matchAll(/\.(min|max)\((-?\d+(?:\.\d+)?)/g)) {
      rules.push({
        statement: zodConstraintStatement(zod[1], zod[2], constraint[1], constraint[2]),
        source_ref: sourceRef,
        evidence: compactEvidence(line),
        status: "candidate",
        source: "static-schema-scan",
      });
    }
  }

  const field = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*[^=]+=\s*Field\((.*)\)/);
  if (field) {
    for (const constraint of field[2].matchAll(/\b(ge|gt|le|lt)\s*=\s*(-?\d+(?:\.\d+)?)/g)) {
      rules.push({
        statement: fieldConstraintStatement(field[1], constraint[1], constraint[2]),
        source_ref: sourceRef,
        evidence: compactEvidence(line),
        status: "candidate",
        source: "static-schema-scan",
      });
    }
  }

  const literal = line.match(/\b([A-Za-z_]\w*)\s*:\s*Literal\[([^\]]+)\]/);
  if (literal) {
    const values = literal[2].match(/["'][^"']+["']/g)?.map((value) => value.replace(/^["']|["']$/g, "")) ?? [];
    if (values.length) {
      rules.push({
        statement: `${humanizeIdentifier(literal[1])} must be one of ${values.join(", ")}`,
        source_ref: sourceRef,
        evidence: compactEvidence(line),
        status: "candidate",
        source: "static-schema-scan",
      });
    }
  }
  return rules;
}

function inferCandidateRules({ inventory, domains, concreteCandidateRules = [] }) {
  const concrete = mergeCandidateRules(concreteCandidateRules);
  if (concrete.length) return concrete.map(formatCandidateRule);

  const rules = [];
  if (inventory.commands.length) {
    rules.push({
      statement: "Local changes should be validated with the detected repository commands before handoff",
      source_ref: commandSourceRef(inventory.commands[0]),
      evidence: inventory.commands[0],
      status: "candidate",
      source: "deterministic-fallback",
    });
  }
  if (inventory.ci.length) {
    rules.push({
      statement: "CI workflow definitions are part of the delivery contract",
      source_ref: inventory.ci[0],
      evidence: inventory.ci[0],
      status: "candidate",
      source: "deterministic-fallback",
    });
  }
  for (const domain of domains.slice(0, 5)) {
    rules.push({
      statement: `Changes touching ${domain} should preserve behavior inferred from related models, services, and tests`,
      source_ref: domainSourceRef(domain, inventory.code_files ?? []),
      evidence: `domain inferred from repository inventory: ${domain}`,
      status: "candidate",
      source: "deterministic-fallback",
    });
  }
  return mergeCandidateRules(rules).map(formatCandidateRule);
}

function isRejectingGuard(windowText) {
  return /\b(throw|raise|abort|forbid|forbidden|unauthori[sz]ed|denied)\b/i.test(windowText) ||
    /\breturn\s+(false|null|undefined)\b/i.test(windowText) ||
    /\breturn\b[^;\n]*(error|invalid|reject)/i.test(windowText);
}

function comparisonGuardStatement(identifier, operator, value) {
  const label = humanizeIdentifier(identifier);
  if (operator === "<") return `${label} must be at least ${value}`;
  if (operator === "<=") return `${label} must be greater than ${value}`;
  if (operator === ">") return `${label} must be at most ${value}`;
  if (operator === ">=") return `${label} must be less than ${value}`;
  return `${label} must satisfy ${operator} ${value}`;
}

function zodConstraintStatement(identifier, type, method, value) {
  const label = humanizeIdentifier(identifier);
  if (type === "string") {
    return method === "min" ? `${label} length must be at least ${value}` : `${label} length must be at most ${value}`;
  }
  return method === "min" ? `${label} must be at least ${value}` : `${label} must be at most ${value}`;
}

function fieldConstraintStatement(identifier, constraint, value) {
  const label = humanizeIdentifier(identifier);
  if (constraint === "ge") return `${label} must be at least ${value}`;
  if (constraint === "gt") return `${label} must be greater than ${value}`;
  if (constraint === "le") return `${label} must be at most ${value}`;
  if (constraint === "lt") return `${label} must be less than ${value}`;
  return `${label} must satisfy ${constraint} ${value}`;
}

function humanizeIdentifier(identifier) {
  return String(identifier ?? "")
    .split(".")
    .at(-1)
    .replace(/^[_$]+|[_$]+$/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_$-]+/g, " ")
    .trim()
    .toLowerCase() || "value";
}

function compactEvidence(line) {
  return String(line ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
}

function commandSourceRef(command) {
  const match = String(command ?? "").match(/^([^:]+):/);
  return match?.[1] ?? "repository-commands";
}

function domainSourceRef(domain, codeFiles = []) {
  const token = String(domain ?? "").split(/\s+/)[0]?.toLowerCase();
  const matched = codeFiles.find((file) => token && file.toLowerCase().includes(token));
  return matched ?? codeFiles[0] ?? "repository-inventory";
}

function formatCandidateRule(rule) {
  const sourceRef = String(rule.source_ref ?? "").trim() || "repository-inventory";
  const evidence = String(rule.evidence ?? "").trim();
  return `CANDIDATE: ${stripTrailingPunctuation(rule.statement)}. source_ref: ${sourceRef}${evidence ? `; evidence: ${evidence}` : ""}`;
}

function mergeCandidateRules(rules = []) {
  const out = [];
  const seen = new Set();
  for (const rule of rules) {
    const normalized = normalizeCandidateRule(rule);
    if (!normalized) continue;
    const key = `${normalized.statement.toLowerCase()}|${normalized.source_ref.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeCandidateRule(rule) {
  if (!rule) return null;
  if (typeof rule === "string") {
    return {
      statement: stripTrailingPunctuation(rule),
      source_ref: "repository-inventory",
      evidence: "",
      status: "candidate",
      source: "unknown",
    };
  }
  const statement = stripTrailingPunctuation(rule.statement ?? rule.title ?? rule.content ?? "");
  const sourceRef = String(rule.source_ref ?? rule.sourceRef ?? "").trim();
  if (!statement || !sourceRef) return null;
  return {
    statement,
    source_ref: sourceRef,
    evidence: String(rule.evidence ?? "").trim(),
    status: "candidate",
    source: String(rule.source ?? "unknown"),
  };
}

function stripTrailingPunctuation(value) {
  return String(value ?? "").trim().replace(/[.;:]+$/g, "");
}

function listOrNone(items) {
  const clean = [...new Set((items ?? []).filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
  return clean.length ? clean.map((item) => `- ${item}`).join("\n") : "- none detected";
}

function structuredListTerms(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const bulletLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (bulletLines.length > 1) {
    const stripped = bulletLines
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter((line) => isShortStructuredTerm(line));
    return stripped.length === bulletLines.length ? stripped : [];
  }
  if (/[.?!]/.test(text)) return [];
  const separator = text.includes(";") ? /;/ : text.includes(",") ? /,/ : null;
  if (!separator) return isShortStructuredTerm(text) ? [text] : [];
  const parts = text.split(separator).map((item) => item.trim()).filter(Boolean);
  if (!parts.length || !parts.every(isShortStructuredTerm)) return [];
  return parts;
}

function isShortStructuredTerm(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 40) return false;
  return text.split(/\s+/).length <= 4;
}
