import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initProject } from "../extensions/aipi/runtime/project-init.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const labRoot = path.join(root, ".aipi-lab");
const projectRoot = path.join(labRoot, "taskboard");
const resultsRoot = path.join(labRoot, "results");
const templateRoot = path.join(root, "tools", "fixtures", "workflow-lab-template");
const appBaselineTag = "aipi-lab-app-baseline";
const readyBaselineTag = "aipi-lab-ready-baseline";

const scenarios = Object.freeze({
  feature: {
    prompt: [
      "Implemente no Taskboard um filtro de tarefas por prioridade.",
      "A API GET /api/tasks deve aceitar ?priority=low|medium|high e retornar somente as tarefas correspondentes.",
      "A interface deve oferecer um seletor All/Low/Medium/High, refletir a selecao em ?priority= na URL, restaura-la ao recarregar e atualizar a lista.",
      "Preserve o comportamento existente, adicione testes e execute typecheck, testes, build e o fluxo de navegador relevante.",
    ].join(" "),
    evalScript: "eval:feature",
  },
  bugfix: {
    prompt: [
      "Corrija o bug do Taskboard em que marcar novamente como completed uma tarefa que ja esta completed incrementa completionEvents outra vez.",
      "A transicao deve ser idempotente, com teste de regressao, sem alterar a contagem para uma repeticao do mesmo estado.",
      "Execute os testes e o build relevantes.",
    ].join(" "),
    evalScript: "eval:bugfix",
  },
  quick: {
    prompt: "Altere o texto vazio do Taskboard de 'No tasks yet.' para 'No tasks match this view.' sem mudar outro comportamento e verifique o build.",
    evalScript: "eval:quick",
  },
  ops: {
    prompt: "Prepare e verifique localmente o build de producao do Taskboard, o health check e um plano de rollback. Nao faca deploy nem use credenciais externas.",
    evalScript: "eval:ops",
  },
});

const argv = process.argv.slice(2);
const action = argv.shift() ?? "status";
const scenarioName = ["run", "verify"].includes(action) && argv[0] && !argv[0].startsWith("--")
  ? argv.shift()
  : "feature";
const options = parseOptions(argv);

try {
  if (action === "init") await initializeLab({ force: options.force });
  else if (action === "reset") await resetLab();
  else if (action === "run") await runLiveScenario(scenarioName, { phase: options.phase ?? "manual" });
  else if (action === "verify") await verifyScenario(scenarioName);
  else if (action === "status") await printStatus();
  else throw new Error(`Unknown lab action: ${action}`);
} catch (error) {
  console.error(`AIPI_WORKFLOW_LAB_ERROR ${String(error?.stack ?? error)}`);
  process.exitCode = 1;
}

async function initializeLab({ force = false } = {}) {
  assertLabPath(projectRoot);
  const hasProject = await exists(path.join(projectRoot, "package.json"));
  const hasGit = await exists(path.join(projectRoot, ".git"));
  if (hasProject && hasGit) {
    if (!force) {
      console.log(`AIPI_WORKFLOW_LAB_EXISTS root=${projectRoot}`);
      await refreshAipiBaseline();
      return;
    }
    await fs.rm(projectRoot, { recursive: true, force: true });
  } else if (hasProject) {
    console.log(`AIPI_WORKFLOW_LAB_RECOVER_INCOMPLETE root=${projectRoot}`);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }

  await fs.mkdir(labRoot, { recursive: true });
  await fs.cp(templateRoot, projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "LAB-SCENARIOS.md"), renderScenarioGuide());
  await run("npm.cmd", ["install", "--ignore-scripts"], { cwd: projectRoot, inherit: true });
  await run("npx.cmd", ["playwright", "install", "chromium"], { cwd: projectRoot, inherit: true });
  await run("git", ["init", "-b", "main"], { cwd: projectRoot });
  await run("git", ["config", "user.name", "AIPI Workflow Lab"], { cwd: projectRoot });
  await run("git", ["config", "user.email", "aipi-lab@local.invalid"], { cwd: projectRoot });
  await run("git", ["add", "-A"], { cwd: projectRoot });
  await run("git", ["commit", "-m", "lab: seed full-stack taskboard"], { cwd: projectRoot });
  await run("git", ["tag", "-f", appBaselineTag], { cwd: projectRoot });
  await refreshAipiBaseline();
  console.log(`AIPI_WORKFLOW_LAB_INIT_OK root=${projectRoot}`);
}

async function resetLab() {
  await ensureLab();
  assertLabPath(projectRoot);
  await run("git", ["reset", "--hard", appBaselineTag], { cwd: projectRoot, inherit: true });
  await cleanGeneratedState();
  await refreshAipiBaseline();
  await run("npm.cmd", ["run", "check:baseline"], { cwd: projectRoot, inherit: true });
  console.log(`AIPI_WORKFLOW_LAB_RESET_OK root=${projectRoot} baseline=${readyBaselineTag}`);
}

async function refreshAipiBaseline() {
  await ensureGitRepository();
  await initProject({
    sourceRoot: path.join(root, "templates", ".aipi"),
    targetRoot: projectRoot,
    force: true,
    resetMemory: true,
  });
  await seedProjectMemory();
  await seedModelCapabilities();
  await fs.rm(path.join(projectRoot, ".aipi", "runtime"), { recursive: true, force: true });
  await run("git", ["add", "-A"], { cwd: projectRoot });
  const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd: projectRoot, allowFailure: true });
  if (staged.code !== 0) {
    await run("git", ["commit", "-m", "lab: refresh current AIPI overlay"], { cwd: projectRoot });
  }
  await run("git", ["tag", "-f", readyBaselineTag], { cwd: projectRoot });
}

async function runLiveScenario(name, { phase }) {
  const scenario = requireScenario(name);
  await ensureLab();
  const status = await run("git", ["status", "--porcelain"], { cwd: projectRoot });
  if (status.stdout.trim()) {
    throw new Error(`lab repository must be clean before a live run; run npm run lab:reset first\n${status.stdout}`);
  }

  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  const outputDir = path.join(resultsRoot, `${stamp}-${phase}-${name}`);
  await fs.mkdir(outputDir, { recursive: true });
  const stdoutPath = path.join(outputDir, "pi-events.jsonl");
  const stderrPath = path.join(outputDir, "pi-stderr.log");
  const startedAt = new Date();
  const args = [
    path.join(root, "bin", "aipi.js"),
    "--mode", "json",
    "--model", "openai-codex/gpt-5.6-sol",
    "--thinking", "high",
    scenario.prompt,
  ];

  console.log(`AIPI_WORKFLOW_LAB_LIVE_START phase=${phase} scenario=${name}`);
  const live = await run(process.execPath, args, {
    cwd: projectRoot,
    stdoutPath,
    stderrPath,
    inherit: true,
    allowFailure: true,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  const finishedAt = new Date();
  const runs = await collectRunStates();
  const diff = await run("git", ["diff", readyBaselineTag, "--"], { cwd: projectRoot });
  await fs.writeFile(path.join(outputDir, "project.diff"), diff.stdout);
  const manifest = {
    schema: "aipi.workflow-lab-result.v1",
    phase,
    scenario: name,
    prompt: scenario.prompt,
    command: [process.execPath, ...args].join(" "),
    project_root: projectRoot,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    elapsed_ms: finishedAt.getTime() - startedAt.getTime(),
    exit_code: live.code,
    aipi_revision: await gitRevision(root),
    project_baseline: await gitRevision(projectRoot, readyBaselineTag),
    pi_version: await installedPiVersion(),
    model_topology: modelTopology(),
    runs,
    changed_files: await changedFiles(),
    stdout: path.basename(stdoutPath),
    stderr: path.basename(stderrPath),
  };
  await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`AIPI_WORKFLOW_LAB_LIVE_DONE phase=${phase} scenario=${name} exit=${live.code} result=${outputDir}`);
  if (live.code !== 0) process.exitCode = live.code;
}

async function verifyScenario(name) {
  const scenario = requireScenario(name);
  await ensureLab();
  await run("npm.cmd", ["run", "check:baseline"], { cwd: projectRoot, inherit: true });
  await run("npm.cmd", ["run", scenario.evalScript], { cwd: projectRoot, inherit: true });
  const changed = await changedFiles();
  const sourceChanges = changed.filter((file) => !file.startsWith(".aipi/"));
  if (["feature", "bugfix", "quick"].includes(name) && !sourceChanges.length) {
    throw new Error(`${name} verification requires at least one project change outside .aipi`);
  }
  console.log(JSON.stringify({
    schema: "aipi.workflow-lab-verification.v1",
    scenario: name,
    passed: true,
    changed_files: changed,
    runs: await collectRunStates(),
  }, null, 2));
}

async function printStatus() {
  const initialized = await exists(path.join(projectRoot, "package.json"));
  const status = initialized
    ? await run("git", ["status", "--short", "--branch"], { cwd: projectRoot })
    : { stdout: "not initialized" };
  console.log([
    `AIPI workflow lab: ${initialized ? "ready" : "missing"}`,
    `root=${projectRoot}`,
    `outer_ignored=${await isIgnoredByOuterGit()}`,
    status.stdout.trim(),
  ].join("\n"));
}

async function ensureLab() {
  if (!(await exists(path.join(projectRoot, "package.json")))) {
    throw new Error("workflow lab is not initialized; run npm run lab:init");
  }
  await ensureGitRepository();
}

async function ensureGitRepository() {
  if (!(await exists(path.join(projectRoot, ".git")))) {
    throw new Error(`workflow lab has no nested Git repository: ${projectRoot}`);
  }
}

async function cleanGeneratedState() {
  for (const relPath of ["dist", "dist-server", "playwright-report", "test-results", path.join(".aipi", "runtime")]) {
    await fs.rm(path.join(projectRoot, relPath), { recursive: true, force: true });
  }
}

async function seedProjectMemory() {
  const memoryRoot = path.join(projectRoot, ".aipi", "memory", "project");
  await fs.mkdir(memoryRoot, { recursive: true });
  await fs.writeFile(path.join(memoryRoot, "project.md"), [
    "# Taskboard project",
    "",
    "A trusted local full-stack dogfood application used to exercise AIPI workflows.",
    "",
    "- Frontend: React, Vite, TypeScript.",
    "- Backend: Express, TypeScript, in-memory task store.",
    "- Validation: Vitest, Supertest, TypeScript, Vite build, Playwright.",
    "- Commands: npm run check:baseline and the evaluator in LAB-SCENARIOS.md.",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(memoryRoot, "business-rules.md"), [
    "# Business rules",
    "",
    "### BR-TASK-001 - Priority is user-visible",
    "- **domain:** taskboard",
    "- **statement:** Every task has exactly one priority: low, medium, or high; users may filter the board without modifying tasks.",
    "- **status:** accepted",
    "",
    "### BR-TASK-002 - Filters are shareable",
    "- **domain:** taskboard",
    "- **statement:** An active priority filter is represented in the URL and restored on reload.",
    "- **status:** accepted",
    "",
    "### BR-TASK-003 - Completion is idempotent",
    "- **domain:** taskboard",
    "- **statement:** Repeating a completed-to-completed status request must not increment completion events.",
    "- **status:** accepted",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(memoryRoot, "procedures.md"), [
    "# Procedures",
    "",
    "Before handoff run npm run check:baseline plus the scenario evaluator named in LAB-SCENARIOS.md.",
    "Never deploy this application. It is local dogfood only.",
    "",
  ].join("\n"));
}

async function seedModelCapabilities() {
  const topology = modelTopology();
  const capabilities = {
    schema: "aipi.model-capabilities.v1",
    classes: topology,
    class_thinking: Object.fromEntries(Object.keys(topology).map((key) => [key, key === "context-fast" ? "low" : "high"])),
    models: Object.fromEntries([...new Set(Object.values(topology))].map((model) => [model.replace("/", ":"), {
      capabilities: {
        reasoning: "frontier",
        coding: "frontier",
        summarization: "high",
        context: "very_high",
        tool_use: "write_capable",
        structured_outputs: "supported",
        web: "supported",
        citations: "supported",
        evidence_audit: "supported",
      },
      evidence: ["Pinned workflow-lab topology; provider authentication is checked before live comparison."],
    }])),
    rule: "Workflow-lab models are pinned so before/after runs use the same provider topology.",
  };
  await fs.writeFile(path.join(projectRoot, ".aipi", "model-capabilities.json"), `${JSON.stringify(capabilities, null, 2)}\n`);
}

function modelTopology() {
  return {
    "orchestrator-heavy": "openai-codex/gpt-5.6-sol",
    "planner-heavy": "anthropic/claude-fable-5",
    "planner-adversarial-heavy": "openai-codex/gpt-5.6-sol",
    "research-heavy": "anthropic/claude-fable-5",
    "code-strong": "xai-auth/grok-4.5",
    "test-strong": "xai-auth/grok-4.5",
    "adversarial-heavy": "anthropic/claude-fable-5",
    "verifier-fast": "anthropic/claude-fable-5",
    "context-fast": "openai-codex/gpt-5.6-sol",
  };
}

async function collectRunStates() {
  const runsRoot = path.join(projectRoot, ".aipi", "runtime", "runs");
  const entries = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const state = JSON.parse(await fs.readFile(path.join(runsRoot, entry.name, "state.json"), "utf8"));
      runs.push({
        run_id: state.run_id,
        workflow: state.workflow,
        status: state.status,
        current_step: state.current_step,
        contract_path: state.contract_path,
        chain_id: state.chain_id ?? null,
        upstream_run_id: state.upstream_run_id ?? null,
        steps: state.steps,
      });
    } catch {
      // Raw events still capture incomplete runs.
    }
  }
  return runs.sort((a, b) => a.run_id.localeCompare(b.run_id));
}

async function changedFiles() {
  const result = await run("git", ["diff", "--name-only", readyBaselineTag, "--"], { cwd: projectRoot });
  return result.stdout.split(/\r?\n/).map((value) => value.trim().replaceAll("\\", "/")).filter(Boolean);
}

async function gitRevision(cwd, ref = "HEAD") {
  const result = await run("git", ["rev-parse", ref], { cwd, allowFailure: true });
  const dirty = await run("git", ["status", "--porcelain"], { cwd, allowFailure: true });
  return `${result.stdout.trim() || "unknown"}${dirty.stdout.trim() ? "+dirty" : ""}`;
}

async function installedPiVersion() {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

async function isIgnoredByOuterGit() {
  const result = await run("git", ["check-ignore", "-q", path.relative(root, projectRoot)], { cwd: root, allowFailure: true });
  return result.code === 0;
}

function requireScenario(name) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`Unknown scenario ${name}; choose ${Object.keys(scenarios).join(", ")}`);
  return scenario;
}

function renderScenarioGuide() {
  return [
    "# Workflow lab scenarios",
    "",
    ...Object.entries(scenarios).flatMap(([name, scenario]) => [
      `## ${name}`,
      scenario.prompt,
      `Acceptance command: npm run ${scenario.evalScript}.`,
      "",
    ]),
  ].join("\n");
}

function parseOptions(args) {
  const out = { force: false, phase: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--force") out.force = true;
    else if (args[index] === "--phase") out.phase = args[++index] ?? null;
    else throw new Error(`Unknown lab option: ${args[index]}`);
  }
  return out;
}

function assertLabPath(candidate) {
  const resolvedLab = path.resolve(labRoot);
  const resolved = path.resolve(candidate);
  const prefix = resolvedLab.endsWith(path.sep) ? resolvedLab : `${resolvedLab}${path.sep}`;
  if (resolved !== resolvedLab && !resolved.startsWith(prefix)) {
    throw new Error(`refusing filesystem operation outside workflow lab: ${resolved}`);
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, {
  cwd = root,
  allowFailure = false,
  inherit = false,
  stdoutPath = null,
  stderrPath = null,
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    const invocation = normalizeCommand(command, args);
    const child = spawn(invocation.command, invocation.args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const stdoutFile = stdoutPath ? fsSync.createWriteStream(stdoutPath) : null;
    const stderrFile = stderrPath ? fsSync.createWriteStream(stderrPath) : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      stdoutFile?.write(chunk);
      if (inherit) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      stderrFile?.write(chunk);
      if (inherit) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      stdoutFile?.end();
      stderrFile?.end();
      const result = { code: code ?? 1, stdout, stderr };
      if (!allowFailure && result.code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with ${result.code}\n${stderr || stdout}`));
      } else {
        resolve(result);
      }
    });
  });
}

function normalizeCommand(command, args) {
  if (process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) {
    return { command, args };
  }
  const npmRoot = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin");
  const cli = command.toLowerCase() === "npx.cmd" ? "npx-cli.js" : "npm-cli.js";
  return { command: process.execPath, args: [path.join(npmRoot, cli), ...args] };
}
