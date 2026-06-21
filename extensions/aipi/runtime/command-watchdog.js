import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const COMMAND_WATCHDOG_SCHEMA = "aipi.command-watchdog.v1";
const COMMAND_WATCHDOG_LOG = ".aipi/runtime/command-watchdog.jsonl";
const MAX_CAPTURE_CHARS = 64_000;
const MAX_EXCERPT_CHARS = 4_000;
const DEFAULT_MIN_RUNTIME_MS = 30_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 60_000;
const DEFAULT_HARD_CAP_MS = 600_000;
const DEFAULT_CHECK_AGENT_TIMEOUT_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 500;

const LONG_RUNNING_COMMAND_RE =
  /\b(npm\s+(test|run|install|ci|build)|pnpm\s+(test|run|install|build)|yarn\s+(test|run|install|build)|pytest|cargo\s+(test|build)|go\s+test|dotnet\s+test|mvn\s+test|gradle|docker\s+build|make(\s|$))\b/i;

export async function runGuardedCommand({
  command,
  cwd = null,
  projectRoot = null,
  env = process.env,
  platform = process.platform,
  minRuntimeMs = null,
  silenceTimeoutMs = null,
  hardCapMs = null,
  checkAgentTimeoutMs = null,
  killGraceMs = null,
  allowInteractive = false,
  checkAgent = null,
  onUpdate = null,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  now = () => Date.now(),
  recordTrace = true,
} = {}) {
  const commandText = String(command ?? "").trim();
  if (!commandText) throw new Error("runGuardedCommand requires command");
  const config = await loadCommandWatchdogConfig({
    projectRoot,
    env,
    overrides: { minRuntimeMs, silenceTimeoutMs, hardCapMs, checkAgentTimeoutMs, killGraceMs },
  });
  const resolvedCwd = cwd ? path.resolve(cwd) : projectRoot ? path.resolve(projectRoot) : process.cwd();
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const interactive = detectInteractiveTrap(commandText, { platform });

  if (!allowInteractive && interactive.action !== "allow") {
    const finishedAtMs = now();
    const result = commandWatchdogResult({
      command: commandText,
      cwd: resolvedCwd,
      status: "refused",
      verdict: "interactive_trap",
      startedAt,
      finishedAtMs,
      startedAtMs,
      reason: interactive.reason,
      interactive_trap: interactive,
      diagnose_note: buildDiagnoseNote({
        verdict: "interactive_trap",
        reason: interactive.reason,
        command: commandText,
        stdout: "",
        stderr: "",
        suggestion: interactive.recommendation,
      }),
      config,
    });
    if (recordTrace) await appendCommandWatchdogTrace(projectRoot, result).catch(() => null);
    return result;
  }

  let child;
  let spawnError = null;
  let stdout = "";
  let stderr = "";
  let lastOutputAtMs = startedAtMs;
  let killed = false;
  let killReason = null;
  let checkAgentInvocations = 0;
  let code = null;
  let signal = null;

  try {
    child = spawnFn(commandText, {
      cwd: resolvedCwd,
      env,
      shell: true,
      windowsHide: true,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    spawnError = error;
  }

  if (spawnError) {
    const finishedAtMs = now();
    const result = commandWatchdogResult({
      command: commandText,
      cwd: resolvedCwd,
      status: "spawn_error",
      verdict: "stuck",
      startedAt,
      finishedAtMs,
      startedAtMs,
      reason: String(spawnError?.message ?? spawnError),
      stdout,
      stderr,
      config,
    });
    if (recordTrace) await appendCommandWatchdogTrace(projectRoot, result).catch(() => null);
    return result;
  }

  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    stdout = appendCaptured(stdout, text);
    lastOutputAtMs = now();
    onUpdate?.({ type: "stdout", text });
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderr = appendCaptured(stderr, text);
    lastOutputAtMs = now();
    onUpdate?.({ type: "stderr", text });
  });

  const closePromise = new Promise((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, exitSignal) => {
      code = exitCode;
      signal = exitSignal;
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  const monitorResult = await monitorCommand({
    child,
    command: commandText,
    closePromise,
    config,
    checkAgent,
    now,
    output: () => ({ stdout, stderr }),
    getLastOutputAtMs: () => lastOutputAtMs,
    setLastOutputAtMs: (value) => {
      lastOutputAtMs = value;
    },
    onCheckAgentInvocation: () => {
      checkAgentInvocations += 1;
    },
  });

  if (monitorResult?.verdict === "stuck") {
    killed = true;
    killReason = monitorResult.reason;
    await killProcessTree(child.pid, { platform, killGraceMs: config.killGraceMs, spawnSyncFn });
    await Promise.race([closePromise, delay(config.killGraceMs + 500)]).catch(() => null);
  } else {
    await closePromise;
  }

  const finishedAtMs = now();
  const status = killed ? "killed" : spawnError ? "spawn_error" : code === 0 ? "completed" : "failed";
  const verdict = killed ? "stuck" : spawnError ? "stuck" : "working";
  const result = commandWatchdogResult({
    command: commandText,
    cwd: resolvedCwd,
    status,
    verdict,
    startedAt,
    finishedAtMs,
    startedAtMs,
    pid: child.pid ?? null,
    code,
    signal,
    killed,
    reason: killReason ?? (spawnError ? String(spawnError?.message ?? spawnError) : status),
    stdout,
    stderr,
    check_agent_invocations: checkAgentInvocations,
    check_agent: monitorResult?.check_agent ?? null,
    diagnose_note: killed
      ? buildDiagnoseNote({
          verdict: "stuck",
          reason: killReason,
          command: commandText,
          stdout,
          stderr,
          suggestion: monitorResult?.suggestion,
        })
      : null,
    config,
  });
  if (recordTrace) await appendCommandWatchdogTrace(projectRoot, result).catch(() => null);
  return result;
}

async function monitorCommand({
  child,
  command,
  closePromise,
  config,
  checkAgent,
  now,
  output,
  getLastOutputAtMs,
  setLastOutputAtMs,
  onCheckAgentInvocation,
}) {
  const startedAtMs = now();
  const intervalMs = Math.max(20, Math.min(1_000, Math.floor(config.silenceTimeoutMs / 4)));

  while (true) {
    const closed = await Promise.race([
      closePromise.then(() => true),
      delay(intervalMs).then(() => false),
    ]);
    if (closed) return null;

    const current = now();
    const runtimeMs = current - startedAtMs;
    const silenceMs = current - getLastOutputAtMs();
    if (runtimeMs >= config.hardCapMs) {
      return {
        verdict: "stuck",
        reason: `hard_cap_exceeded runtime=${runtimeMs}ms hard_cap=${config.hardCapMs}ms`,
        suggestion: "Split the command or run it with explicit non-interactive progress and a bounded timeout.",
      };
    }
    if (runtimeMs < config.minRuntimeMs || silenceMs < config.silenceTimeoutMs) continue;

    const partial = output();
    const ambiguous = isAmbiguousLongRunningCommand(command);
    if (ambiguous && typeof checkAgent === "function") {
      onCheckAgentInvocation?.();
      const check = await runCheckAgent({
        checkAgent,
        command,
        partialOutput: `${partial.stdout}\n${partial.stderr}`.trim().slice(-MAX_EXCERPT_CHARS),
        runtimeMs,
        silenceMs,
        timeoutMs: config.checkAgentTimeoutMs,
      });
      if (check.verdict === "working") {
        setLastOutputAtMs(now());
        continue;
      }
      return {
        verdict: "stuck",
        reason: `check_agent_${check.verdict}: ${check.reason}`,
        check_agent: check,
        suggestion: check.suggestion ?? "Re-run with explicit progress output or a non-interactive bounded command.",
      };
    }

    return {
      verdict: "stuck",
      reason: `silence_timeout_exceeded silence=${silenceMs}ms runtime=${runtimeMs}ms`,
      suggestion: "Use a non-interactive form, add progress output, or split the command into bounded steps.",
    };
  }
}

async function runCheckAgent({ checkAgent, command, partialOutput, runtimeMs, silenceMs, timeoutMs }) {
  try {
    const result = await Promise.race([
      Promise.resolve(checkAgent({
        schema: "aipi.command-watchdog-check.v1",
        command,
        partial_output: partialOutput,
        runtime_ms: runtimeMs,
        silence_ms: silenceMs,
      })),
      delay(timeoutMs).then(() => ({ verdict: "unknown", reason: `check_agent_timeout_${timeoutMs}ms` })),
    ]);
    const verdict = ["stuck", "working", "unknown"].includes(result?.verdict) ? result.verdict : "unknown";
    return {
      verdict,
      reason: String(result?.reason ?? "no reason returned"),
      suggestion: result?.suggestion ?? null,
    };
  } catch (error) {
    return { verdict: "unknown", reason: String(error?.message ?? error), suggestion: null };
  }
}

export function detectInteractiveTrap(command, { platform = process.platform } = {}) {
  const text = String(command ?? "").trim();
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  if (!text) return allowTrap();

  if (platform === "win32" && /\b(python3?|py)(\s+-3)?\s+-\s*<</i.test(normalized)) {
    return refuseTrap(
      "python_stdin_heredoc_windows",
      "Windows shell heredoc/stdin forwarding can drop into an interactive Python REPL.",
      "Use `python -c`, write a temporary .py file, or redirect stdin from a real file instead of `python - << HEREDOC`.",
    );
  }

  const tokens = shellWords(text);
  const first = normalizeCommandName(tokens[0]);
  const args = tokens.slice(1);
  if (!first) return allowTrap();

  const searchTrap = detectPathologicalSearchTrap({ text, first, args });
  if (searchTrap.action !== "allow") return searchTrap;

  if (["python", "python3", "py"].includes(first) && isPythonInteractiveArgs(first, args)) {
    return refuseTrap("python_repl", "Python was invoked without a script or with stdin `-`.", "Use `python -c`, a temporary .py file, or an explicit script path.");
  }
  if (first === "node" && args.length === 0) {
    return refuseTrap("node_repl", "Node was invoked without a script or `-e`.", "Use `node -e \"...\"` or an explicit script path.");
  }
  if (["irb", "r"].includes(first) && args.length === 0) {
    return refuseTrap(`${first}_repl`, `${first} was invoked without a non-interactive expression or script.`, "Use a non-interactive expression flag or a script file.");
  }
  if (first === "psql" && !hasOption(args, "-c", "--command")) {
    return refuseTrap("psql_interactive", "psql was invoked without `-c/--command`.", "Use `psql -c \"SQL\"` or a migration tool with non-interactive flags.");
  }
  if (first === "mysql" && !hasOption(args, "-e", "--execute")) {
    return refuseTrap("mysql_interactive", "mysql was invoked without `-e/--execute`.", "Use `mysql -e \"SQL\"` or a migration tool with non-interactive flags.");
  }
  if (first === "git" && args[0] === "rebase" && args.includes("-i")) {
    return refuseTrap("git_rebase_interactive", "git rebase -i opens an editor.", "Use a non-interactive rebase command or prepare the todo file explicitly.");
  }
  if (first === "git" && args[0] === "add" && args.includes("-i")) {
    return refuseTrap("git_add_interactive", "git add -i opens an interactive selector.", "Use explicit paths or `git add -p` only in an interactive human-controlled session.");
  }
  if (first === "git" && args[0] === "commit" && !hasOption(args, "-m", "--message")) {
    return refuseTrap("git_commit_editor", "git commit without `-m/--message` opens an editor.", "Use `git commit -m \"message\"` or provide `--file`.");
  }
  if (first === "ssh" && !sshHasRemoteCommand(args)) {
    return refuseTrap("ssh_interactive", "ssh without a remote command can open an interactive shell.", "Use `ssh host command` with BatchMode/non-interactive flags.");
  }
  if (["less", "more", "vim", "vi", "nano", "emacs"].includes(first)) {
    return refuseTrap("pager_or_editor", `${first} is an interactive pager/editor.`, "Use `cat`, `sed`, `rg`, or a non-interactive editor command.");
  }
  if (first === "npm" && args[0] === "init" && !args.includes("-y") && !args.includes("--yes")) {
    return refuseTrap("npm_init_interactive", "npm init prompts unless `-y/--yes` is present.", "Use `npm init -y` or write package.json directly.");
  }

  return allowTrap();
}

export function isAmbiguousLongRunningCommand(command) {
  return LONG_RUNNING_COMMAND_RE.test(String(command ?? ""));
}

export async function killProcessTree(pid, {
  platform = process.platform,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  spawnSyncFn = spawnSync,
} = {}) {
  if (!pid) return { killed: false, reason: "missing_pid" };
  if (platform === "win32") {
    const result = spawnSyncFn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return { killed: result.status === 0 || result.error == null, method: "taskkill" };
  }

  let method = "process_group";
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    method = "single_process";
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return { killed: false, reason: "already_exited", method };
    }
  }
  await delay(killGraceMs);
  try {
    if (method === "process_group") process.kill(-pid, "SIGKILL");
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already exited */
  }
  return { killed: true, method };
}

export async function loadCommandWatchdogConfig({ projectRoot = null, env = process.env, overrides = {} } = {}) {
  const fileConfig = await readCommandWatchdogConfigFile(projectRoot);
  return {
    minRuntimeMs: positiveDurationMs(
      overrides.minRuntimeMs ?? fileConfig.min_runtime_ms ?? fileConfig.minRuntimeMs ??
        envDurationMs(env, ["AIPI_CMD_MIN_RUNTIME_MS"], ["AIPI_CMD_MIN_RUNTIME"]),
      DEFAULT_MIN_RUNTIME_MS,
    ),
    silenceTimeoutMs: positiveDurationMs(
      overrides.silenceTimeoutMs ?? fileConfig.silence_timeout_ms ?? fileConfig.silenceTimeoutMs ??
        envDurationMs(env, ["AIPI_CMD_SILENCE_TIMEOUT_MS"], ["AIPI_CMD_SILENCE_TIMEOUT"]),
      DEFAULT_SILENCE_TIMEOUT_MS,
    ),
    hardCapMs: positiveDurationMs(
      overrides.hardCapMs ?? fileConfig.hard_cap_ms ?? fileConfig.hardCapMs ??
        envDurationMs(env, ["AIPI_CMD_HARD_CAP_MS"], ["AIPI_CMD_HARD_CAP"]),
      DEFAULT_HARD_CAP_MS,
    ),
    checkAgentTimeoutMs: positiveDurationMs(
      overrides.checkAgentTimeoutMs ?? fileConfig.check_agent_timeout_ms ?? fileConfig.checkAgentTimeoutMs,
      DEFAULT_CHECK_AGENT_TIMEOUT_MS,
    ),
    killGraceMs: positiveDurationMs(
      overrides.killGraceMs ?? fileConfig.kill_grace_ms ?? fileConfig.killGraceMs,
      DEFAULT_KILL_GRACE_MS,
    ),
  };
}

async function readCommandWatchdogConfigFile(projectRoot) {
  if (!projectRoot) return {};
  const configPath = path.join(projectRoot, ".aipi", "command-watchdog.json");
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

function commandWatchdogResult({
  command,
  cwd,
  status,
  verdict,
  startedAt,
  finishedAtMs,
  startedAtMs,
  pid = null,
  code = null,
  signal = null,
  killed = false,
  reason = null,
  stdout = "",
  stderr = "",
  check_agent_invocations = 0,
  check_agent = null,
  interactive_trap = null,
  diagnose_note = null,
  config,
}) {
  const elapsedMs = Math.max(0, finishedAtMs - startedAtMs);
  return {
    schema: COMMAND_WATCHDOG_SCHEMA,
    recorded_at: new Date(finishedAtMs).toISOString(),
    command,
    cwd,
    pid,
    status,
    verdict,
    code,
    signal,
    killed,
    reason,
    started_at: startedAt,
    elapsed_ms: elapsedMs,
    thresholds: {
      min_runtime_ms: config.minRuntimeMs,
      silence_timeout_ms: config.silenceTimeoutMs,
      hard_cap_ms: config.hardCapMs,
    },
    stdout,
    stderr,
    stdout_excerpt: excerpt(stdout),
    stderr_excerpt: excerpt(stderr),
    check_agent_invocations,
    check_agent,
    interactive_trap,
    diagnose_note,
  };
}

function buildDiagnoseNote({ verdict, reason, command, stdout, stderr, suggestion }) {
  return {
    schema: "aipi.command-watchdog-diagnose.v1",
    verdict,
    reason: reason ?? "unknown",
    partial_output_excerpt: excerpt(`${stdout ?? ""}\n${stderr ?? ""}`.trim()),
    suggested_fix: suggestion ?? suggestedFixForCommand(command),
  };
}

function suggestedFixForCommand(command) {
  const trap = detectInteractiveTrap(command);
  if (trap.action !== "allow") return trap.recommendation;
  return "Re-run with a bounded non-interactive form, explicit timeout, and progress output.";
}

async function appendCommandWatchdogTrace(projectRoot, entry) {
  if (!projectRoot) return;
  const logPath = path.join(projectRoot, COMMAND_WATCHDOG_LOG);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`);
}

function appendCaptured(current, next) {
  const combined = `${current}${next}`;
  return combined.length > MAX_CAPTURE_CHARS ? combined.slice(-MAX_CAPTURE_CHARS) : combined;
}

function excerpt(text) {
  const value = String(text ?? "");
  if (value.length <= MAX_EXCERPT_CHARS) return value;
  return value.slice(-MAX_EXCERPT_CHARS);
}

function envDurationMs(env, msNames, secondNames) {
  for (const name of msNames) {
    if (env?.[name] != null && env[name] !== "") return parseDurationMs(env[name], "ms");
  }
  for (const name of secondNames) {
    if (env?.[name] != null && env[name] !== "") return parseDurationMs(env[name], "s");
  }
  return null;
}

function positiveDurationMs(value, fallback) {
  const numeric = typeof value === "string" ? parseDurationMs(value, "ms") : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const ms = Math.floor(numeric);
  return ms > 0 ? ms : fallback;
}

function parseDurationMs(value, defaultUnit) {
  const text = String(value ?? "").trim().toLowerCase();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|sec|secs|second|seconds)?$/);
  if (!match) return Number.NaN;
  const number = Number(match[1]);
  const unit = match[2] ?? defaultUnit;
  return unit === "ms" ? number : number * 1000;
}

function shellWords(command) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|[^\s"']+/g;
  let match;
  while ((match = re.exec(command))) {
    words.push(match[1] ?? match[2] ?? match[0]);
  }
  return words;
}

function normalizeCommandName(value) {
  const base = path.basename(String(value ?? "").replaceAll("\\", "/")).toLowerCase();
  return base.replace(/\.(exe|cmd|bat)$/i, "");
}

function isPythonInteractiveArgs(first, args) {
  if (!args.length) return true;
  if (first === "py") {
    const nonVersionArgs = args.filter((arg) => !/^-\d+(\.\d+)?$/.test(arg));
    return !nonVersionArgs.length || nonVersionArgs[0] === "-";
  }
  return args[0] === "-";
}

function hasOption(args, short, long) {
  return args.some((arg) => arg === short || arg.startsWith(`${short}`) && short.length === 2 && arg.length > 2 ||
    arg === long || arg.startsWith(`${long}=`));
}

function sshHasRemoteCommand(args) {
  let positionals = 0;
  const optionsWithValue = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positionals += 1;
    if (positionals >= 2) return true;
  }
  return false;
}

function detectPathologicalSearchTrap({ text, first, args }) {
  if (!["grep", "egrep", "fgrep", "find"].includes(first)) return allowTrap();
  if (!searchesFromProjectRoot(first, args)) return allowTrap();

  if (isAipiInternalSearch(text)) {
    return refuseTrap(
      "aipi_internal_search",
      "This search targets AIPI extension/runtime internals that are not normally present in the project tree.",
      "Inspect the AIPI extension source, for example extensions/aipi/runtime/, or use aipi_retrieve/aipi_callers instead of scanning the project repository.",
    );
  }

  if (first === "find" || grepIsRecursive(args)) {
    if (!hasRealHeavyDirExcludes(args)) {
      return refuseTrap(
        "recursive_search_heavy_dirs",
        "Recursive project-root search would traverse heavy directories such as .aipi/state, .git, or node_modules.",
        "Use rg with real excludes, for example `rg --glob '!{.aipi,.git,node_modules}/**' <pattern>`, or add grep/find exclude/prune flags before running.",
      );
    }
  }

  return allowTrap();
}

function searchesFromProjectRoot(first, args) {
  if (first === "find") return args.includes(".");
  return args.includes(".") || args.includes("./");
}

function grepIsRecursive(args) {
  return args.some((arg) => arg === "-r" || arg === "-R" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg) ||
    arg === "--recursive" || arg === "--dereference-recursive");
}

function hasRealHeavyDirExcludes(args) {
  const text = args.join(" ").toLowerCase();
  const mentionsNodeModules = /node_modules/.test(text);
  const mentionsGit = /\.git/.test(text);
  const mentionsAipiState = /\.aipi(?:\/state)?/.test(text);
  const coversHeavyDirs = mentionsNodeModules && mentionsGit && mentionsAipiState;
  const hasGrepExclude = /--exclude-dir(?:=|\s+)/.test(text) && coversHeavyDirs;
  const hasFindPrune = coversHeavyDirs && (
    /(\.aipi\/state|\.aipi|\.git|node_modules).*(-prune|-not|-path)/.test(text) ||
    /(-prune|-not|-path).*(\.aipi\/state|\.aipi|\.git|node_modules)/.test(text)
  );
  return hasGrepExclude || hasFindPrune;
}

function isAipiInternalSearch(text) {
  return /\b(no executable adapter is configured|refusing to self-stamp|createLocalWorkflowAdapter|createSubagentWorkflowAdapter|aipi-local-executor)\b/i.test(text);
}

function allowTrap() {
  return { action: "allow", reason: null, recommendation: null };
}

function refuseTrap(pattern, reason, recommendation) {
  return {
    action: "refuse",
    mitigation: "refuse_with_warning",
    pattern,
    reason,
    recommendation,
  };
}
