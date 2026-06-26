#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const defaultPackageRoot = path.dirname(path.dirname(currentFile));
const defaultProviderExtensionPaths = ["./extensions/aipi/provider/anthropic-oauth-only.ts"];
const mcpBridgeExtensionPath = "./extensions/aipi/mcp-bridge.js";

export function aipiProviderExtensionPaths({
  packageRoot = defaultPackageRoot,
  readFileSync = fs.readFileSync,
} = {}) {
  const contract = readRuntimeContractSync({ packageRoot, readFileSync });
  const configured = Object.values(contract?.providerAuth ?? {})
    .map((provider) => provider?.extensionPath)
    .filter(Boolean);
  return configured.length ? configured : defaultProviderExtensionPaths;
}

export function aipiExtensionPaths({
  packageRoot = defaultPackageRoot,
  readFileSync = fs.readFileSync,
  cwd = process.cwd(),
  existsSync = fs.existsSync,
} = {}) {
  // Provider auth extensions load before AIPI so model routing sees registered
  // providers when workflow sessions start.
  const extensionPaths = [
    ...aipiProviderExtensionPaths({ packageRoot, readFileSync }),
  ];
  if (hasAipiMcpConfig({ cwd, existsSync })) {
    extensionPaths.push(mcpBridgeExtensionPath);
  }
  extensionPaths.push("./extensions/aipi/index.js");
  return extensionPaths.map((extensionPath) => resolvePackagePath(packageRoot, extensionPath));
}

export function aipiMcpConfigPath({ cwd = process.cwd() } = {}) {
  return path.join(cwd, ".aipi", "mcp.json");
}

export function hasAipiMcpConfig({
  cwd = process.cwd(),
  existsSync = fs.existsSync,
} = {}) {
  return existsSync(aipiMcpConfigPath({ cwd }));
}

function readRuntimeContractSync({
  packageRoot = defaultPackageRoot,
  readFileSync = fs.readFileSync,
} = {}) {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, "templates", ".aipi", "runtime-contract.json"), "utf8"));
  } catch {
    return null;
  }
}

function resolvePackagePath(packageRoot, relOrAbsPath) {
  if (path.isAbsolute(relOrAbsPath)) return relOrAbsPath;
  return path.resolve(packageRoot, relOrAbsPath);
}

export function parseAipiUpdateArgs(userArgs = []) {
  const options = { dryRun: false };
  for (const arg of userArgs) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`unknown aipi update option: ${arg}`);
  }
  return options;
}

export function parseAipiStatusArgs(userArgs = [], { cwd = process.cwd() } = {}) {
  const options = { json: false, strict: false, target: cwd };
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--target") {
      const target = userArgs[index + 1];
      if (!target) throw new Error("aipi status --target requires a directory");
      options.target = path.resolve(cwd, target);
      index += 1;
      continue;
    }
    throw new Error(`unknown aipi status option: ${arg}`);
  }
  return options;
}

export function parseAipiWorkflowArgs(userArgs = [], { cwd = process.cwd() } = {}) {
  const options = { json: false, target: cwd, workflowArgs: [] };
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--target") {
      const target = userArgs[index + 1];
      if (!target) throw new Error("aipi workflow --target requires a directory");
      options.target = path.resolve(cwd, target);
      index += 1;
      continue;
    }
    options.workflowArgs.push(arg);
  }
  return options;
}

export function parseAipiMemoryArgs(userArgs = [], { cwd = process.cwd() } = {}) {
  const options = { json: false, target: cwd, memoryArgs: [] };
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--target") {
      const target = userArgs[index + 1];
      if (!target) throw new Error("aipi memory --target requires a directory");
      options.target = path.resolve(cwd, target);
      index += 1;
      continue;
    }
    options.memoryArgs.push(arg);
  }
  return options;
}

export function parseAipiModelsArgs(userArgs = [], { cwd = process.cwd() } = {}) {
  const options = { json: false, target: cwd, modelsArgs: [] };
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--target") {
      const value = userArgs[index + 1];
      if (!value) throw new Error("missing value after --target");
      options.target = path.resolve(cwd, value);
      options.modelsArgs.push(arg, value);
      index += 1;
      continue;
    }
    options.modelsArgs.push(arg);
  }
  return options;
}

export function parseAipiOnboardArgs(userArgs = [], { cwd = process.cwd() } = {}) {
  const options = { json: false, target: cwd, noQuestions: false, noPullEmbeddings: false, onboardArgs: [] };
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--target") {
      const target = userArgs[index + 1];
      if (!target) throw new Error("aipi onboard --target requires a directory");
      options.target = path.resolve(cwd, target);
      options.onboardArgs.push(arg, target);
      index += 1;
      continue;
    }
    if (arg === "--no-questions") {
      options.noQuestions = true;
      options.onboardArgs.push(arg);
      continue;
    }
    if (arg === "--no-pull-embeddings") {
      options.noPullEmbeddings = true;
      options.onboardArgs.push(arg);
      continue;
    }
    throw new Error(`unknown aipi onboard option: ${arg}`);
  }
  return options;
}

export function parseAipiDiagnoseArgs(userArgs = [], { cwd = process.cwd() } = {}) {
  const options = { json: false, help: false, target: cwd, diagnoseArgs: [] };
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index];
    if (arg === "--json") {
      options.json = true;
      options.diagnoseArgs.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      options.diagnoseArgs.push(arg);
      continue;
    }
    if (arg === "--target") {
      const target = userArgs[index + 1];
      if (!target) throw new Error("aipi diagnose --target requires a directory");
      options.target = path.resolve(cwd, target);
      options.diagnoseArgs.push(arg, target);
      index += 1;
      continue;
    }
    options.diagnoseArgs.push(arg);
  }
  return options;
}

export function inspectAipiRepo({
  packageRoot = defaultPackageRoot,
  existsSync = fs.existsSync,
  spawnSyncFn = spawnSync,
} = {}) {
  if (!existsSync(path.join(packageRoot, ".git"))) {
    return { isGitCheckout: false };
  }

  const git = (args) => spawnSyncFn("git", ["-C", packageRoot, ...args], { encoding: "utf8" });
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const status = git(["status", "--porcelain"]);

  return {
    isGitCheckout: true,
    hasHead: head.status === 0,
    hasUpstream: upstream.status === 0,
    upstream: upstream.status === 0 ? upstream.stdout.trim() : null,
    statusOk: status.status === 0,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : true,
    errors: {
      head: head.status === 0 ? null : (head.stderr || head.stdout || "HEAD does not resolve").trim(),
      upstream: upstream.status === 0 ? null : (upstream.stderr || upstream.stdout || "no upstream configured").trim(),
      status: status.status === 0 ? null : (status.stderr || status.stdout || "git status failed").trim(),
    },
  };
}

function skippedStep(label, message) {
  return { label, kind: "manual", message };
}

function updatePlanSkipForRepo(packageRoot, repoInfo) {
  if (!repoInfo?.isGitCheckout) {
    return skippedStep(
      "aipi",
      `AIPI at ${packageRoot} is not a git checkout; reinstall it with your install method (e.g. pi install npm:<aipi-source>).`,
    );
  }
  if (repoInfo.hasHead === false) {
    return skippedStep("aipi", "git pull skipped because this checkout has no commits yet.");
  }
  if (repoInfo.hasUpstream === false) {
    return skippedStep("aipi", "git pull skipped because this checkout has no upstream remote configured.");
  }
  if (repoInfo.statusOk === false) {
    return skippedStep("aipi", `git pull skipped because git status failed: ${repoInfo.errors?.status ?? "unknown error"}`);
  }
  if (repoInfo.dirty) {
    return skippedStep("aipi", "git pull skipped because the working tree has local changes.");
  }
  return null;
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function executeUpdateStep({
  step,
  dryRun,
  env,
  spawnSyncFn,
  log,
  errorLog,
  platform = process.platform,
}) {
  let { command, args } = step;
  if (step.kind === "pi") {
    const spec = createRawPiSpawnSpec({ env, userArgs: step.args });
    command = spec.command;
    args = spec.args;
  }

  if (dryRun) {
    log(`aipi update [${step.label}] would run: ${formatCommand(command, args)}`);
    return true;
  }

  log(`aipi update [${step.label}] -> ${formatCommand(command, args)}`);
  // On Windows a `.cmd`/`.bat` (e.g. npm.cmd) can't be spawned directly, and per-arg
  // cmd.exe quoting is fragile (cmd /c strips outer quotes). Run it through a shell as
  // ONE command string instead. git.exe and POSIX commands spawn directly (no shell).
  const useShell = step.kind !== "pi" && platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const result = useShell
    ? spawnSyncFn(toShellCommandLine(command, args), { stdio: "inherit", env, shell: true })
    : spawnSyncFn(command, args, { stdio: "inherit", env });
  if (result.error || result.status !== 0) {
    errorLog(`aipi update [${step.label}] failed: ${result.error?.message ?? `exit ${result.status}`}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

export function buildPiArgs(userArgs, {
  packageRoot = defaultPackageRoot,
  cwd = process.cwd(),
  existsSync = fs.existsSync,
} = {}) {
  const extensionArgs = [];
  for (const extensionPath of aipiExtensionPaths({ packageRoot, cwd, existsSync })) {
    extensionArgs.push("--extension", extensionPath);
  }
  return [...extensionArgs, ...userArgs];
}

export function readAipiPackageVersion({
  packageRoot = defaultPackageRoot,
  readFileSync = fs.readFileSync,
} = {}) {
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  return packageJson.version ?? "unknown";
}

export function piCliJsCandidates({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  const candidates = [];
  const rel = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

  if (env.AIPI_PI_CLI_JS) candidates.push(env.AIPI_PI_CLI_JS);
  if (env.npm_config_prefix) candidates.push(path.join(env.npm_config_prefix, rel));

  if (platform === "win32") {
    if (env.APPDATA) candidates.push(path.join(env.APPDATA, "npm", rel));
    if (homeDir) candidates.push(path.join(homeDir, "AppData", "Roaming", "npm", rel));
  } else {
    if (homeDir) candidates.push(path.join(homeDir, ".npm-global", "lib", rel));
    candidates.push(path.join("/usr", "local", "lib", rel));
  }

  return [...new Set(candidates)];
}

export function pathCommandCandidates(command, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const pathValue = env.PATH ?? env.Path ?? "";
  const pathDirs = pathValue.split(path.delimiter).filter(Boolean);
  const names = platform === "win32"
    ? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]
    : [command];

  return pathDirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

export function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  return `"${text.replace(/(\\*)"/g, '$1$1\\"')}"`;
}

export function createPiSpawnSpec({
  env = process.env,
  cwd = process.cwd(),
  existsSync = fs.existsSync,
  homeDir = os.homedir(),
  nodeExecPath = process.execPath,
  platform = process.platform,
  userArgs = process.argv.slice(2),
  packageRoot = defaultPackageRoot,
} = {}) {
  const piArgs = buildPiArgs(userArgs, { packageRoot, cwd, existsSync });
  return createRawPiSpawnSpec({
    env,
    existsSync,
    homeDir,
    nodeExecPath,
    platform,
    userArgs: piArgs,
  });
}

export function createRawPiSpawnSpec({
  env = process.env,
  existsSync = fs.existsSync,
  homeDir = os.homedir(),
  nodeExecPath = process.execPath,
  platform = process.platform,
  userArgs = process.argv.slice(2),
} = {}) {
  if (env.AIPI_PI_BIN) {
    return createCommandSpawnSpec(env.AIPI_PI_BIN, userArgs, platform);
  }

  const cliJs = piCliJsCandidates({ env, homeDir, platform }).find((candidate) => existsSync(candidate));
  if (cliJs) {
    return {
      command: nodeExecPath,
      args: [cliJs, ...userArgs],
    };
  }

  const command = pathCommandCandidates("pi", { env, platform }).find((candidate) => existsSync(candidate)) ?? "pi";
  return createCommandSpawnSpec(command, userArgs, platform);
}

function createCommandSpawnSpec(command, args, platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")],
    };
  }

  return { command, args };
}

// Build a single shell command line (used with spawnSync(..., { shell: true })) so a
// `.cmd`/`.bat` resolves via the shell. Quote only tokens that contain spaces/quotes;
// passing one string (not an args array) avoids the shell+args DEP0190 warning.
function toShellCommandLine(command, args) {
  const quote = (value) => {
    const text = String(value);
    return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
  };
  return [command, ...args].map(quote).join(" ");
}

export function classifyAipiInvocation(userArgs = []) {
  const first = userArgs[0];
  if (!first || first === "--") return { kind: "pass-through" };
  if (first === "--version" || first === "-v") return { kind: "aipi-version" };
  if (first === "--help" || first === "-h") return { kind: "aipi-help" };
  if (first === "--pi-version") return { kind: "raw-pi", args: ["--version"] };
  if (first === "--pi-help") return { kind: "raw-pi", args: ["--help"] };
  if (first === "status" || first === "doctor") return { kind: "aipi-status", args: userArgs.slice(1) };
  if (first === "workflow" || first === "workflows") return { kind: "aipi-workflow", args: userArgs.slice(1) };
  if (first === "memory" || first === "memories") return { kind: "aipi-memory", args: userArgs.slice(1) };
  if (first === "effort" || first === "models" || first === "model") return { kind: "aipi-models", args: userArgs.slice(1) };
  if (first === "onboard" || first === "onboarding") return { kind: "aipi-onboard", args: userArgs.slice(1) };
  if (first === "diagnose" || first === "diagnostics") return { kind: "aipi-diagnose", args: userArgs.slice(1) };
  if (first === "update") return { kind: "aipi-update", args: userArgs.slice(1) };
  return { kind: "pass-through" };
}

export function readPiVersion({
  env = process.env,
  existsSync = fs.existsSync,
  homeDir = os.homedir(),
  nodeExecPath = process.execPath,
  platform = process.platform,
  spawnSyncFn = spawnSync,
} = {}) {
  const spec = createRawPiSpawnSpec({
    env,
    existsSync,
    homeDir,
    nodeExecPath,
    platform,
    userArgs: ["--version"],
  });
  const result = spawnSyncFn(spec.command, spec.args, {
    encoding: "utf8",
    env,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, version: null, error: result.error?.message ?? result.stderr ?? "unknown error" };
  }
  const text = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return { ok: Boolean(text), version: text ?? null, error: text ? null : "empty version output" };
}

export function formatAipiVersion({ aipiVersion, piVersion }) {
  if (piVersion?.ok) return `aipi ${aipiVersion} (pi ${piVersion.version})`;
  return `aipi ${aipiVersion} (pi: not found)`;
}

// `aipi update` updates Pi and the AIPI checkout together.
export function buildAipiUpdatePlan({
  packageRoot = defaultPackageRoot,
  existsSync = fs.existsSync,
  repoInfo = null,
  platform = process.platform,
} = {}) {
  const steps = [
    { label: "pi", kind: "pi", args: ["update", "--self"], note: "update the Pi runtime" },
  ];

  const effectiveRepoInfo = repoInfo ?? {
    isGitCheckout: existsSync(path.join(packageRoot, ".git")),
  };
  const skip = updatePlanSkipForRepo(packageRoot, effectiveRepoInfo);
  if (skip) {
    steps.push(skip);
  } else {
    // npm on Windows is `npm.cmd` (a batch file); a bare `npm` spawn is ENOENT.
    // git is `git.exe`, a real executable, so it stays as-is.
    const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
    steps.push({ label: "aipi", kind: "exec", command: "git", args: ["-C", packageRoot, "pull", "--ff-only"], note: "pull the latest AIPI" });
    // `npm ci` (not `install`): a reproducible install straight from package-lock that NEVER mutates
    // the lockfile. `npm install` can normalize lock fields (e.g. a transitive bin path), which would
    // leave the runtime checkout dirty and make the NEXT `git pull --ff-only` get skipped — silently
    // freezing the engine. ci keeps the checkout clean so consecutive updates keep working.
    steps.push({ label: "aipi-deps", kind: "exec", command: npmCommand, args: ["ci", "--prefix", packageRoot], note: "reproducible install from package-lock; never mutates the lockfile" });
  }

  return steps;
}

export async function runAipiUpdate({
  packageRoot = defaultPackageRoot,
  existsSync = fs.existsSync,
  spawnSyncFn = spawnSync,
  env = process.env,
  userArgs = [],
  log = console.log,
  errorLog = console.error,
  platform = process.platform,
} = {}) {
  let options;
  try {
    options = parseAipiUpdateArgs(userArgs);
  } catch (error) {
    errorLog(`aipi update failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const repoInfo = inspectAipiRepo({ packageRoot, existsSync, spawnSyncFn });
  for (const step of buildAipiUpdatePlan({ packageRoot, existsSync, repoInfo, platform })) {
    if (step.kind === "manual") {
      log(`aipi update [${step.label}] skipped: ${step.message}`);
      continue;
    }
    const ok = executeUpdateStep({
      step,
      dryRun: options.dryRun,
      env,
      spawnSyncFn,
      log,
      errorLog,
      platform,
    });
    if (!ok) {
      return;
    }
  }
  log(options.dryRun ? "aipi update dry-run complete." : "aipi update complete.");
}

export async function runAipiStatus({
  packageRoot = defaultPackageRoot,
  env = process.env,
  homeDir = os.homedir(),
  cwd = process.cwd(),
  userArgs = [],
  log = console.log,
  errorLog = console.error,
  statusFns = null,
} = {}) {
  let options;
  try {
    options = parseAipiStatusArgs(userArgs, { cwd });
  } catch (error) {
    errorLog(`aipi status failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }

  try {
    const fns = statusFns ?? await import("../extensions/aipi/runtime/provider-auth.js");
    const report = await fns.buildAipiStatusReport({
      projectRoot: options.target,
      root: packageRoot,
      env,
      homeDir,
    });
    const kind = fns.aipiStatusKind(report);
    log(options.json ? JSON.stringify(report, null, 2) : fns.formatAipiStatus(report));
    if (options.strict && kind !== "info") process.exitCode = 1;
    return report;
  } catch (error) {
    errorLog(`aipi status failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

export async function runAipiWorkflow({
  cwd = process.cwd(),
  userArgs = [],
  log = console.log,
  errorLog = console.error,
  workflowFns = null,
} = {}) {
  let options;
  try {
    options = parseAipiWorkflowArgs(userArgs, { cwd });
  } catch (error) {
    errorLog(`aipi workflow failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }

  try {
    const fns = workflowFns ?? await import("../extensions/aipi/runtime/run-state.js");
    // CR-59-3 / ADV-58-3: surface per-step progress on the CLI workflow surface so a long
    // `run`/`execute` is not a silent black box. Progress goes to STDERR (errorLog) so it never
    // corrupts the stdout result, and is suppressed entirely under --json to keep machine output
    // a single clean JSON document (`aipi workflow ... --json | jq` stays parseable).
    const notify = options.json
      ? null
      : (message) => errorLog(`aipi workflow: ${message}`);
    const result = await fns.runWorkflowCommand({
      args: options.workflowArgs.join(" "),
      projectRoot: options.target,
      notify,
    });
    log(options.json ? JSON.stringify(result, null, 2) : fns.formatWorkflowCommandResult(result));
    return result;
  } catch (error) {
    errorLog(`aipi workflow failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

export async function runAipiMemory({
  cwd = process.cwd(),
  userArgs = [],
  log = console.log,
  errorLog = console.error,
  memoryFns = null,
} = {}) {
  let options;
  try {
    options = parseAipiMemoryArgs(userArgs, { cwd });
  } catch (error) {
    errorLog(`aipi memory failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }

  try {
    const fns = memoryFns ?? await import("../extensions/aipi/runtime/memory-command.js");
    const result = await fns.runMemoryCommand({
      args: options.memoryArgs.join(" "),
      projectRoot: options.target,
    });
    log(options.json ? JSON.stringify(result, null, 2) : fns.formatMemoryCommandResult(result));
    return result;
  } catch (error) {
    errorLog(`aipi memory failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

// CR-60-1: a readline-backed prompt UI so a bare interactive `aipi effort` can drive the setup wizard
// from the terminal. Built only when the CLI is interactive and not in --json mode. Uses the PROMISE
// readline API (`node:readline/promises`) so `rl.question()` actually awaits and RETURNS the user's
// answer — the callback API returns `undefined`, which left `ui.input()` answer-less and broke the
// bare-CLI wizard. `input`/`output` are injectable so the real UI can be exercised in tests.
export function createCliPromptUi({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  return {
    async input(question) {
      return rl.question(`${question}: `);
    },
    async prompt(question) {
      return rl.question(`${question}: `);
    },
    close() {
      rl.close();
    },
  };
}

export async function runAipiModels({
  cwd = process.cwd(),
  userArgs = [],
  log = console.log,
  errorLog = console.error,
  modelsFns = null,
  // CR-60-1: an interactive terminal (TTY) opens the wizard on a bare `aipi effort`; --json and
  // non-interactive (piped/CI) callers stay status-only so stdout remains machine-safe.
  isInteractive = process.stdin?.isTTY === true,
  promptAdapter = null,
  // Injectable streams for the readline prompt UI (tests drive the REAL createCliPromptUi this way).
  promptStreams = null,
} = {}) {
  let options;
  try {
    options = parseAipiModelsArgs(userArgs, { cwd });
  } catch (error) {
    errorLog(`aipi models failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }

  try {
    const fns = modelsFns ?? await import("../extensions/aipi/runtime/models-command.js");
    // Pass a prompt UI ONLY for an interactive, non-JSON invocation. runModelsCommand then opens the
    // 4-bucket wizard for a bare action; explicit `status`/`setup ...` flags keep their behavior.
    const ui = options.json ? null : (promptAdapter ?? (isInteractive ? createCliPromptUi(promptStreams ?? undefined) : null));
    try {
      const result = await fns.runModelsCommand({
        args: options.modelsArgs,
        projectRoot: options.target,
        cwd,
        ui,
      });
      log(options.json ? JSON.stringify(result, null, 2) : fns.formatModelsCommandResult(result));
      return result;
    } finally {
      ui?.close?.();
    }
  } catch (error) {
    errorLog(`aipi models failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

export async function runAipiOnboard({
  cwd = process.cwd(),
  userArgs = [],
  log = console.log,
  errorLog = console.error,
  onboardingFns = null,
} = {}) {
  let options;
  try {
    options = parseAipiOnboardArgs(userArgs, { cwd });
  } catch (error) {
    errorLog(`aipi onboard failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }

  try {
    const fns = onboardingFns ?? await import("../extensions/aipi/runtime/onboarding.js");
    const result = await fns.runProjectOnboarding({
      projectRoot: options.target,
      askUser: false,
      runWorker: false,
      pullEmbeddings: !options.noPullEmbeddings,
      onProgress: options.json ? null : (event) => log(event.message),
    });
    log(options.json ? JSON.stringify(result, null, 2) : fns.formatOnboardingResult(result));
    return result;
  } catch (error) {
    errorLog(`aipi onboard failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

export async function runAipiDiagnose({
  cwd = process.cwd(),
  userArgs = [],
  log = console.log,
  errorLog = console.error,
  diagnoseFns = null,
} = {}) {
  let options;
  try {
    options = parseAipiDiagnoseArgs(userArgs, { cwd });
  } catch (error) {
    errorLog(`aipi diagnose failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }

  try {
    const fns = diagnoseFns ?? await import("../extensions/aipi/runtime/diagnose.js");
    const result = await fns.runDiagnoseCommand({
      args: options.diagnoseArgs.join(" "),
      projectRoot: cwd,
    });
    if (result.help) {
      log(result.text);
    } else {
      log(options.json ? JSON.stringify(result, null, 2) : fns.formatDiagnoseCommandResult(result));
    }
    return result;
  } catch (error) {
    errorLog(`aipi diagnose failed: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}

export function formatAipiHelp({ aipiVersion }) {
  return [
    `aipi ${aipiVersion} - BDD-contract agent harness on Pi`,
    "",
    "Usage:",
    "  aipi",
    "  aipi [pi flags] [@files] [messages]",
    "  aipi with no arguments starts an interactive Pi session with AIPI preloaded.",
    "  aipi with arguments runs pi with the AIPI extensions preloaded; all other Pi flags pass through.",
    "",
    "AIPI commands inside a session:",
    "  /aipi-init [--dry-run] [--force] [--reset-memory] [--target <dir>] [--no-pull-embeddings]",
    "  /aipi-onboard [--target <dir>] [--no-questions] [--no-pull-embeddings]",
    "  /aipi-status",
    "  /aipi-workflow [list | status | start <name> | run <name> | execute]",
    "  /aipi-memory [status | refs | query <terms>]",
    "  /aipi-effort [setup | status | check] [--planner <spec>] [--adversarial <spec>] [--doer <spec>] [--mover <spec>] [--class <class>=<spec>]",
    "                  spec = provider/model[:level] (level = low|medium|high|xhigh); 4 provider-agnostic buckets",
    "  /aipi-models [setup | status | check]  (alias of /aipi-effort)",
    "  /aipi-diagnose [<run_id>] [--share] [--json]",
    "  /aipi-mcp",
    "  /aipi-probe-a",
    "  /aipi-probe-a-prime",
    "  /aipi-pi-subagents-spike",
    "",
    "Wrapper commands:",
    "  aipi status [--target <dir>] [--json] [--strict]",
    "                  Show AIPI readiness outside a Pi session",
    "  aipi doctor      Alias for aipi status",
    "  aipi workflow [--target <dir>] [--json] [list|status|start <name>|run <name>|execute]",
    "                  Inspect or drive AIPI workflow state outside a Pi session",
    "  aipi memory [--target <dir>] [--json] [status|refs|query <terms>]",
    "                  Inspect AIPI Markdown memory and code graph state outside a Pi session",
    "  aipi effort [--target <dir>] [--json] [setup|status|check] [--planner <spec>] [--adversarial <spec>] [--doer <spec>] [--mover <spec>] [--class <class>=<spec>]",
    "                  Configure the 4-bucket (planner/adversarial/doer/mover) provider-agnostic model topology; each bucket = (model, thinking level)",
    "  aipi models [--target <dir>] [--json] ...   Alias of aipi effort",
    "  aipi onboard [--target <dir>] [--json] [--no-questions] [--no-pull-embeddings]",
    "                  Inventory a project and seed AIPI project memory outside a Pi session",
    "  aipi diagnose [<run_id>] [--target <dir>] [--share] [--json]",
    "                  Explain the most recent failed/blocked AIPI run and write a redacted report",
    "  aipi update [--dry-run]",
    "                  Update Pi (pi update --self) and AIPI together",
    "",
    "Wrapper options:",
    "  --version, -v   Show AIPI and wrapped Pi versions",
    "  --help, -h      Show this AIPI help",
    "  --pi-version    Forward raw --version to Pi",
    "  --pi-help       Forward raw --help to Pi",
    "",
    "Auth: Anthropic via pinned provider adapter; run /login anthropic.",
    "",
    "Environment:",
    "  AIPI_PI_CLI_JS  Path to @earendil-works/pi-coding-agent/dist/cli.js",
    "  AIPI_PI_BIN     Path to a Pi executable or shim",
  ].join("\n");
}

export async function main() {
  const userArgs = process.argv.slice(2);
  const invocation = classifyAipiInvocation(userArgs);

  if (invocation.kind === "aipi-version") {
    const aipiVersion = readAipiPackageVersion();
    const piVersion = readPiVersion();
    console.log(formatAipiVersion({ aipiVersion, piVersion }));
    if (!piVersion.ok) process.exitCode = 1;
    return;
  }

  if (invocation.kind === "aipi-help") {
    console.log(formatAipiHelp({ aipiVersion: readAipiPackageVersion() }));
    return;
  }

  if (invocation.kind === "aipi-update") {
    await runAipiUpdate({ userArgs: invocation.args });
    return;
  }

  if (invocation.kind === "aipi-status") {
    await runAipiStatus({ userArgs: invocation.args });
    return;
  }

  if (invocation.kind === "aipi-workflow") {
    await runAipiWorkflow({ userArgs: invocation.args });
    return;
  }

  if (invocation.kind === "aipi-memory") {
    await runAipiMemory({ userArgs: invocation.args });
    return;
  }

  if (invocation.kind === "aipi-models") {
    await runAipiModels({ userArgs: invocation.args });
    return;
  }

  if (invocation.kind === "aipi-onboard") {
    await runAipiOnboard({ userArgs: invocation.args });
    return;
  }

  if (invocation.kind === "aipi-diagnose") {
    await runAipiDiagnose({ userArgs: invocation.args });
    return;
  }

  const spec = invocation.kind === "raw-pi"
    ? createRawPiSpawnSpec({ userArgs: invocation.args })
    : createPiSpawnSpec({ userArgs });
  const child = spawn(spec.command, spec.args, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`aipi failed to start pi: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(currentFile)) {
  main();
}
