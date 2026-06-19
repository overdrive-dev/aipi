import fs from "node:fs/promises";
import path from "node:path";
import { rebuildCodeGraph } from "./aipi-tools.js";
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

const DEFAULT_QUESTIONS = [
  {
    key: "purpose",
    question: "Qual e o proposito do projeto em uma frase?",
  },
  {
    key: "domain",
    question: "Quais dominios ou regras de negocio sao mais importantes agora?",
  },
  {
    key: "validation",
    question: "Quais comandos validam uma mudanca localmente?",
  },
];

export function parseOnboardArgs(args = "") {
  const tokens = String(args).trim().split(/\s+/).filter(Boolean);
  const options = {
    targetRoot: null,
    noQuestions: false,
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
  graphBuilder = rebuildCodeGraph,
  materializeGraph = true,
  runWorker = Boolean(coordinator && hostModel),
} = {}) {
  const root = assertProjectRoot(projectRoot);
  const inventory = await inventoryRepository(root);
  const collectedAnswers = {
    ...answers,
    ...(askUser ? await askOnboardingQuestions(ctx) : {}),
  };
  const worker = runWorker
    ? await runOnboardingInventoryWorker({ coordinator, hostModel, inventory, now }).catch((error) => ({
        status: "failed",
        error: String(error?.message ?? error),
      }))
    : { status: "not_run" };
  const memory = await seedProjectMemory({
    projectRoot: root,
    inventory,
    answers: collectedAnswers,
    now,
    force: false,
  });
  const graph = materializeGraph
    ? await graphBuilder({ projectRoot: root, now })
    : null;

  return {
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
          file_count: graph.files?.length ?? 0,
        }
      : null,
    worker,
  };
}

export function formatOnboardingResult(result) {
  if (result?.action === "skipped") return result.message;
  if (result?.action !== "onboard") return "AIPI onboarding did not run.";
  const memory = result.memory ?? {};
  const graph = result.graph ?? {};
  return [
    "AIPI onboarding complete:",
    `${memory.written?.length ?? 0} memory pages written, ${memory.skipped_customized?.length ?? 0} customized pages preserved.`,
    `graph=${graph.path ?? "not-built"} sqlite=${graph.sqlite_status ?? "unknown"} path=${graph.sqlite_path ?? ".aipi/state/aipi-graph.sqlite"}`,
  ].join("\n");
}

export async function inventoryRepository(projectRoot) {
  const root = assertProjectRoot(projectRoot);
  const topLevel = await listTopLevel(root);
  const files = await listRepoFiles(root, { maxFiles: 350 });
  const packageManifests = await readPackageManifests(root, files);
  const python = await readPythonManifests(root, files);
  const ci = files.filter((file) => file.startsWith(".github/workflows/") || /^\.gitlab-ci\.ya?ml$/i.test(file));
  const docker = files.filter((file) => /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i.test(file));
  const languages = languageSummary(files);
  const entryPoints = inferEntryPoints(files, packageManifests);
  const commands = inferCommands(packageManifests, python);

  return {
    top_level: topLevel,
    files_sample: files.slice(0, 80),
    languages,
    package_manifests: packageManifests,
    python,
    ci,
    docker,
    entry_points: entryPoints,
    commands,
    stack: inferStack({ files, packageManifests, python }),
  };
}

export function isStubMemoryPage(content) {
  const text = String(content ?? "");
  return STUB_MARKERS.some((marker) => text.includes(marker));
}

export async function seedProjectMemory({
  projectRoot,
  inventory,
  answers = {},
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
    if (!force && !isStubMemoryPage(existing)) {
      summary.skipped_customized.push(file);
      continue;
    }
    const frontmatter = extractFrontmatter(existing);
    const content = renderMemoryPage({
      file,
      frontmatter,
      inventory,
      answers,
      date: now().toISOString().slice(0, 10),
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

function isInteractiveContext(ctx) {
  return Boolean(ctx?.hasUI === true && typeof ctx?.ui?.input === "function");
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

async function askOnboardingQuestions(ctx) {
  const answers = {};
  if (typeof ctx?.ui?.input !== "function") return answers;
  for (const item of DEFAULT_QUESTIONS) {
    const answer = await Promise.resolve(ctx.ui.input(item.question));
    if (answer != null && String(answer).trim()) answers[item.key] = String(answer).trim();
  }
  return answers;
}

async function runOnboardingInventoryWorker({ coordinator, hostModel, inventory, now }) {
  const runId = `onboarding-${now().toISOString().replace(/[^0-9A-Za-z]+/g, "-")}`;
  const artifact = `.aipi/runtime/onboarding/${runId}/INVENTORY.md`;
  const { agent_id: agentId } = coordinator.spawn({
    agent_id: "onboarding-inventory",
    step_id: "project_onboarding_inventory",
    model: hostModel,
    context_packet: [
      "Inventory this repository for AIPI onboarding.",
      "Write a concise markdown inventory artifact. Do not write durable memory.",
      `Current deterministic inventory: ${JSON.stringify(inventory).slice(0, 4000)}`,
    ].join("\n"),
    owned_files: [artifact],
    expected_artifacts: [artifact],
    artifact_target: path.posix.dirname(artifact),
    budget: { timeout_ms: 120000, max_tool_calls: 20 },
  });
  await waitForCoordinatorDone(coordinator, agentId);
  const collected = coordinator.collect(agentId);
  return {
    status: collected.ready ? "done" : "not_ready",
    agent_id: agentId,
    verdict: collected.step_result?.verdict ?? null,
    artifacts: collected.artifacts ?? [],
  };
}

async function waitForCoordinatorDone(coordinator, agentId, { timeoutMs = 180000 } = {}) {
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

async function listRepoFiles(root, { maxFiles = 350 } = {}) {
  const out = [];
  await walk(root, "", out, maxFiles);
  return out;
}

async function walk(root, relDir, out, maxFiles) {
  if (out.length >= maxFiles) return;
  const absDir = path.join(root, relDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    const rel = path.posix.join(relDir.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, rel, out, maxFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(rel);
  }
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
  const pyproject = files.find((file) => file.endsWith("pyproject.toml"));
  return {
    requirements,
    pyproject: pyproject ?? null,
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
  if (files.some((file) => file.endsWith(".py")) || python.pyproject || python.requirements.length) stack.push("Python");
  if (deps.has("express")) stack.push("Express");
  if (deps.has("vite")) stack.push("Vite");
  if (files.some((file) => /^backend\//.test(file)) && files.some((file) => /^frontend\//.test(file))) {
    stack.push("frontend/backend monorepo");
  }
  return [...new Set(stack)];
}

function extractFrontmatter(content) {
  const match = String(content ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? match[0] : "";
}

function renderMemoryPage({ file, frontmatter, inventory, answers, date }) {
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
  const body = (renderers[file] ?? renderKnowledgePage)({ inventory, answers, date });
  return `${frontmatter || ""}${body}\n`;
}

function renderProjectPage({ inventory, answers, date }) {
  return [
    "# Project Context",
    "",
    "## Current truth",
    "",
    answers.purpose || "Project purpose was not provided during onboarding.",
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
    "## Open questions",
    "",
    answers.validation ? "- Confirm whether the listed validation commands are authoritative." : "- Which validation command is authoritative for local changes?",
    answers.domain ? "- Convert the stated domain context into accepted business rules." : "- Which business rules are authoritative for this project?",
    "",
    "## Links",
    "",
    "- rules: business-rules.md",
    "- decisions: decisions.md",
    "- environment: environment.md",
    "",
    "## Timeline",
    "",
    `- ${date}: Project memory seeded by /aipi-onboard from repository inventory.`,
  ].join("\n");
}

function renderBusinessRulesPage({ answers, date }) {
  return [
    "# Business Rules",
    "",
    "## Current truth",
    "",
    answers.domain || "No accepted business rules were provided during onboarding.",
    "",
    "## Details",
    "",
    "### Candidate domains",
    "",
    answers.domain ? listOrNone(splitListish(answers.domain)) : "- To be confirmed with the user before implementation decisions.",
    "",
    "## Open questions",
    "",
    "- Which candidate rules are accepted product policy?",
    "",
    "## Links",
    "",
    "- project: project.md",
    "- decisions: decisions.md",
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded from /aipi-onboard answers; treat as candidate context until accepted.`,
  ].join("\n");
}

function renderDecisionsPage({ inventory, date }) {
  return [
    "# Decisions",
    "",
    "## Current truth",
    "",
    "No durable architecture/product decisions were confirmed during onboarding.",
    "",
    "## Details",
    "",
    "### Observed technical choices",
    "",
    listOrNone(inventory.stack.map((item) => `Uses ${item}`)),
    "",
    "## Open questions",
    "",
    "- Which observed technical choices are deliberate decisions versus inherited defaults?",
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

function renderKnowledgePage({ inventory, date }) {
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
      inventory.python.pyproject,
    ].filter(Boolean)),
    "",
    "## Open questions",
    "",
    "- Which files are the highest-signal context for common changes?",
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

function renderEnvironmentPage({ inventory, answers, date }) {
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
    "### Credentials",
    "",
    "- Anthropic OAuth sidecar: `~/.pi/agent/anthropic-auth.json`",
    "- Anthropic OAuth sidecar override: `PI_ANTHROPIC_AUTH_FILE`",
    "- Login command: `/login anthropic`",
    "",
    "## Open questions",
    "",
    answers.validation ? `- User stated validation context: ${answers.validation}` : "- Which commands are safe for builder role?",
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard.`,
  ].join("\n");
}

function renderProceduresPage({ inventory, answers, date }) {
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
    listOrNone(answers.validation ? splitListish(answers.validation) : inventory.commands),
    "",
    "## Open questions",
    "",
    "- What is the required pre-merge validation sequence?",
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

function renderDeploymentPage({ inventory, date }) {
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
    "## Open questions",
    "",
    "- What is the production approval record format?",
    "- What rollback command is safe and tested?",
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard.`,
  ].join("\n");
}

function renderGlossaryPage({ inventory, answers, date }) {
  const terms = [
    ...inventory.stack,
    ...splitListish(answers.domain ?? ""),
  ].slice(0, 20);
  return [
    "# Glossary",
    "",
    "## Current truth",
    "",
    "Glossary terms are candidates from onboarding and need product confirmation.",
    "",
    "## Details",
    "",
    "### Candidate terms",
    "",
    listOrNone(terms),
    "",
    "## Open questions",
    "",
    "- Which terms have project-specific meanings?",
    "",
    "## Timeline",
    "",
    `- ${date}: Seeded by /aipi-onboard.`,
  ].join("\n");
}

function listOrNone(items) {
  const clean = [...new Set((items ?? []).filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
  return clean.length ? clean.map((item) => `- ${item}`).join("\n") : "- none detected";
}

function splitListish(value) {
  return String(value ?? "")
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
