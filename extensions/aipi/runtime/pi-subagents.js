import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { readHashlinePrompt } from "./hashline.js";

export const PI_SUBAGENTS_PACKAGE = "pi-subagents@0.28.0";
export const PI_SUBAGENTS_VENDOR_ROOT = "extensions/aipi/runtime/vendor/pi-subagents";
export const PI_SUBAGENTS_ISOLATION = "pi_subagents";
export const PI_SUBAGENTS_LIVE_SPIKE_SCHEMA = "aipi.pi-subagents-spike.v1";
export const AIPI_SUBAGENTS_RUNTIME_ROOT = ".aipi/runtime/subagents";
export const AIPI_SUBAGENTS_AGENT_NAME = "aipi-worker";
export const AIPI_SUBAGENTS_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "write", "aipi_shell", "aipi_ask_orchestrator"];
export const AIPI_SUBAGENTS_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const AIPI_SUBAGENTS_GUARDED_WRITE_EXTENSION = "extensions/aipi/runtime/aipi-guarded-write-child.js";
export const AIPI_SUBAGENTS_GUARDED_BASH_EXTENSION = "extensions/aipi/runtime/aipi-guarded-bash-child.js";
export const AIPI_SUBAGENTS_DISALLOWED_PROVIDERS = [];
export const AIPI_HOST_SUPPORTED_PROVIDERS = ["anthropic"];
export const AIPI_HOST_MODEL_READINESS_MESSAGE =
  "AIPI host model is unavailable to the AIPI orchestrator turn.";

const LIVE_SPIKE_TASK = "Reply with the single word OK.";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.join(currentDir, "vendor", "pi-subagents");
const runSyncEntrypoint = path.join(vendorRoot, "src", "runs", "foreground", "execution.ts");
const subagentViewEntrypoint = path.join(vendorRoot, "src", "tui", "subagent-view.ts");
const historyStoreEntrypoint = path.join(vendorRoot, "src", "runs", "background", "history-store.ts");
const guardedWriteExtensionPath = path.join(currentDir, "aipi-guarded-write-child.js");
const guardedBashExtensionPath = path.join(currentDir, "aipi-guarded-bash-child.js");
const askOrchestratorExtensionPath = path.join(currentDir, "aipi-ask-orchestrator-child.js");
const hashlineEditExtensionPath = path.join(currentDir, "aipi-hashline-edit-child.js");
let cachedJiti = null;

// EXPERIMENTAL: give workers content-hash-anchored editing (aipi_read_hashline + aipi_edit) alongside the
// guarded write. OFF by default — a package-level flag (not an env knob) flipped once we've confirmed the
// worker models reliably emit the `[PATH#TAG]` hashline format. When true, createAipiWorkerAgentConfig adds
// the two tools and extends the worker prompt with the hashline edit format. See aipi-hashline-edit-child.js.
export const HASHLINE_WORKER_EDIT_ENABLED = false;

export function normalizePiSubagentsBackend(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("-", "_");
  return normalized === PI_SUBAGENTS_ISOLATION ? PI_SUBAGENTS_ISOLATION : normalized;
}

export function projectSubagentsRuntimePaths(projectRoot = process.cwd(), runId = "run") {
  const runtimeRoot = path.join(projectRoot, AIPI_SUBAGENTS_RUNTIME_ROOT);
  const safeRunId = safePathSegment(runId);
  return {
    runtimeRoot,
    agentDir: path.join(runtimeRoot, "agent"),
    sessionsDir: path.join(runtimeRoot, "sessions", safeRunId),
    artifactsDir: path.join(runtimeRoot, "artifacts"),
    resultsDir: path.join(runtimeRoot, "async-subagent-results"),
    asyncDir: path.join(runtimeRoot, "async-subagent-runs"),
  };
}

export function modelToPiModelId(model) {
  if (!model) return null;
  if (typeof model === "string") return model;
  const provider = model.provider ?? model.provider_id ?? model.providerId;
  const id = model.id ?? model.model ?? model.model_id ?? model.modelId;
  if (provider && id) return `${provider}/${id}`;
  if (id) return String(id);
  return null;
}

export function modelProvider(modelId) {
  const text = String(modelId ?? "");
  const separator = text.indexOf("/");
  return separator > 0 ? text.slice(0, separator).toLowerCase() : null;
}

export function aipiHostModelReadiness(model, { requireProvider = false, requireModel = false, env = process.env } = {}) {
  const modelId = modelToPiModelId(model);
  const normalizedModelId = String(modelId ?? "").trim();
  const provider = modelProvider(normalizedModelId);
  if (!normalizedModelId) {
    return (requireProvider || requireModel)
      ? unsupportedHostModelReadiness({
          code: "AIPI_HOST_MODEL_UNAVAILABLE",
          modelId: null,
          provider: null,
          detail: "No host model was available.",
        })
      : {
          ok: true,
          code: "AIPI_HOST_MODEL_UNKNOWN",
          model_id: null,
          provider: null,
          message: null,
        };
  }
  // Provider-AVAILABILITY gate (runtime capability, not policy): a provider the installed worker runtime
  // literally cannot run is always rejected. Empty by default, so normally a no-op.
  if (provider && AIPI_SUBAGENTS_DISALLOWED_PROVIDERS.includes(provider)) {
    return unsupportedHostModelReadiness({
      code: "AIPI_HOST_MODEL_UNSUPPORTED",
      modelId: normalizedModelId,
      provider,
      detail: `Provider ${provider} is not available in this installed AIPI/Pi worker runtime.`,
    });
  }
  const allowlist = aipiHostProviderAllowlist(env);
  // MODEL-AGNOSTIC by default: any model/provider may be the AIPI host/orchestrator (and any other role).
  // The orchestration is provider-neutral; whether a given model produces valid step structured-outputs is a
  // model-capability question, not a policy one. Set AIPI_HOST_PROVIDERS (comma list, e.g. "anthropic") to
  // restrict the host to specific providers; unset/empty = allow ALL.
  if (!allowlist) {
    return {
      ok: true,
      code: provider ? "AIPI_HOST_MODEL_SUPPORTED" : "AIPI_HOST_MODEL_UNQUALIFIED_ALLOWED",
      model_id: normalizedModelId,
      provider: provider ?? null,
      message: null,
    };
  }
  // Operator restricted the host providers — enforce membership.
  if (!provider) {
    if (looksUnsupportedUnqualifiedHostModel(normalizedModelId)) {
      return unsupportedHostModelReadiness({
        code: "AIPI_HOST_MODEL_UNSUPPORTED",
        modelId: normalizedModelId,
        provider: null,
        detail: `Unqualified host model and AIPI_HOST_PROVIDERS restricts the host to: ${[...allowlist].join(", ")}. Remove the restriction or qualify the host model with a provider.`,
      });
    }
    return {
      ok: true,
      code: "AIPI_HOST_MODEL_UNQUALIFIED_ALLOWED",
      model_id: normalizedModelId,
      provider: null,
      message: null,
    };
  }
  if (!allowlist.has(provider)) {
    return unsupportedHostModelReadiness({
      code: "AIPI_HOST_MODEL_UNSUPPORTED",
      modelId: normalizedModelId,
      provider,
      detail: `Host provider ${provider} is not in AIPI_HOST_PROVIDERS (${[...allowlist].join(", ")}). Remove the restriction or set the host to an allowed provider.`,
    });
  }
  return {
    ok: true,
    code: "AIPI_HOST_MODEL_SUPPORTED",
    model_id: normalizedModelId,
    provider,
    message: null,
  };
}

// Model-agnostic by default: no provider is privileged as the AIPI host/orchestrator. AIPI_HOST_PROVIDERS
// (comma list) optionally restricts the host to specific providers; unset/empty = allow ALL providers.
export function aipiHostProviderAllowlist(env = process.env) {
  const raw = String(env?.AIPI_HOST_PROVIDERS ?? "").trim();
  if (!raw) return null;
  const set = new Set(raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean));
  return set.size ? set : null;
}

function looksUnsupportedUnqualifiedHostModel(modelId) {
  const normalized = String(modelId ?? "").toLowerCase();
  if (!normalized || /\bclaude|anthropic\b/.test(normalized)) return false;
  return /\b(gpt|codex|openai|gemini|mistral|llama|deepseek)\b/.test(normalized);
}

export function assertAipiSupportedHostModel(model, options = {}) {
  const readiness = aipiHostModelReadiness(model, options);
  if (readiness.ok) return readiness;
  const error = new Error(readiness.message);
  error.code = readiness.code;
  error.readiness = readiness;
  throw error;
}

export function assertAipiHostScopedModel(modelId, {
  allowedProvider = null,
  allowedProviders = null,
  requireProvider = false,
  requireModel = false,
} = {}) {
  const normalizedModelId = String(modelId ?? "").trim();
  const provider = modelProvider(normalizedModelId);
  if (!normalizedModelId) {
    if (requireProvider || requireModel) {
      throw new Error("AIPI forked subagents require a concrete host model; got none");
    }
    return;
  }
  if (!provider) {
    return;
  }
  if (AIPI_SUBAGENTS_DISALLOWED_PROVIDERS.includes(provider)) {
    throw new Error(`AIPI forked subagents cannot run provider model ${normalizedModelId} in this installation`);
  }
  const allowed = normalizeAllowedProviders(allowedProviders ?? allowedProvider);
  if (allowed.size && !allowed.has(provider)) {
    throw new Error(`AIPI forked subagents only allow host provider ${[...allowed].join(", ")}; got ${normalizedModelId}`);
  }
}

function unsupportedHostModelReadiness({ code, modelId, provider, detail }) {
  const suffix = modelId ? ` Current host model: ${modelId}.` : "";
  return {
    ok: false,
    code,
    model_id: modelId,
    provider,
    message: `${AIPI_HOST_MODEL_READINESS_MESSAGE}${suffix} ${detail}`.trim(),
  };
}

function normalizeAllowedProviders(value) {
  const list = Array.isArray(value) ? value : [value];
  return new Set(list.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean));
}

export function createAipiSubagentsRunner({ root = process.cwd() } = {}) {
  return {
    async spawn(params, options = {}) {
      return runAipiForkedSubagent({
        root,
        params,
        job: options.job,
        signal: options.signal,
        onUpdate: options.onUpdate,
      });
    },
    async cancel(_handle) {
      return { cancelled: false, reason: "blocking run is cancelled through AbortSignal" };
    },
    async cleanup(handle = {}) {
      for (const dir of [handle.sessionDir, handle.artifactsDir].filter(Boolean)) {
        await fs.rm(dir, { recursive: true, force: true });
      }
      return { cleaned: true };
    },
  };
}

export function createPiSubagentsRunner(_pi, options = {}) {
  return createAipiSubagentsRunner(options);
}

export function normalizePiSubagentsRunner(runner, _pi, options = {}) {
  if (!runner) return createAipiSubagentsRunner(options);
  if (typeof runner === "function") {
    return {
      async spawn(params, options = {}) {
        return runner(params, options);
      },
    };
  }
  if (typeof runner.spawn === "function") return runner;
  if (typeof runner.execute === "function") {
    return {
      async spawn(params, options = {}) {
        return runner.execute("aipi-pi-subagents", params, options.signal, options.onUpdate, options.ctx);
      },
    };
  }
  throw new Error("AIPI pi-subagents runner must expose spawn(params) or execute(...).");
}

export async function runAipiForkedSubagent({
  root = process.cwd(),
  params = {},
  job = null,
  signal = null,
  onUpdate = null,
} = {}) {
  const runId = job?.agentId ?? params.id ?? `aipi-${Date.now()}`;
  const paths = projectSubagentsRuntimePaths(root, runId);
  await Promise.all([
    fs.mkdir(paths.agentDir, { recursive: true }),
    fs.mkdir(paths.sessionsDir, { recursive: true }),
    fs.mkdir(paths.artifactsDir, { recursive: true }),
    fs.mkdir(paths.resultsDir, { recursive: true }),
    fs.mkdir(paths.asyncDir, { recursive: true }),
  ]);

  const modelId = modelToPiModelId(params.model ?? job?.descriptor?.model);
  assertAipiHostScopedModel(modelId, { requireModel: true });
  const modelIdProvider = modelProvider(modelId);
  const maxToolCalls = normalizeMaxToolCalls(
    params.max_tool_calls ?? params.maxToolCalls ?? job?.budget?.maxToolCalls ?? job?.budget?.max_tool_calls,
  );

  const ownedFiles = normalizeOwnedFiles(params.owned_files ?? job?.descriptor?.owned_files);
  const writeScope = params.write_scope ?? job?.descriptor?.write_scope ?? "artifacts";

  // Bridge this foreground fork into the native subagent run-store so /aipi-subagents can see it live.
  const startedAt = Date.now();
  const runLabel = job?.descriptor?.label ?? params.id ?? AIPI_SUBAGENTS_AGENT_NAME;
  const thinkingLevel = params.thinking_level ?? job?.descriptor?.thinking_level ?? null;
  await writeSubagentRunStatus(paths, runId, {
    state: "running",
    cwd: root,
    startedAt,
    lastUpdate: startedAt,
    steps: [subagentRunStep({ agent: runLabel, status: "running", model: modelId, thinking: thinkingLevel })],
  });

  const envRestore = applyScopedRuntimeEnv({
    AIPI_SUBAGENTS_AGENT_DIR: paths.agentDir,
    AIPI_SUBAGENTS_RUNTIME_DIR: paths.runtimeRoot,
    AIPI_SUBAGENTS_PROJECT_ROOT: root,
    AIPI_SUBAGENTS_AGENT_ID: job?.agentId ?? params.id ?? AIPI_SUBAGENTS_AGENT_NAME,
    AIPI_SUBAGENTS_OWNED_FILES: JSON.stringify(ownedFiles),
    AIPI_SUBAGENTS_WRITE_SCOPE: writeScope === "project" ? "project" : "artifacts",
    AIPI_SUBAGENTS_MAX_TOOL_CALLS: maxToolCalls == null ? "" : String(maxToolCalls),
  });
  try {
    const { runSync } = loadForkedRunSync();
    const result = await runSync(
      root,
      [createAipiWorkerAgentConfig({
        thinking: params.thinking_level ?? undefined,
        // Single-lead workers get the guarded shell; parallel fanout (review) workers do not (allow_shell:false).
        allowShell: (params.allow_shell ?? job?.descriptor?.allow_shell) !== false,
        // Make the worker budget-aware so it writes its result before the tool-call limit discards its work.
        maxToolCalls,
      })],
      AIPI_SUBAGENTS_AGENT_NAME,
      params.task ?? "",
      {
        cwd: root,
        signal,
        onUpdate,
        runId,
        sessionDir: paths.sessionsDir,
        artifactsDir: paths.artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeJsonl: true,
          includeMetadata: true,
          cleanupDays: 7,
        },
        modelOverride: modelId ?? undefined,
        availableModels: modelId && modelIdProvider
          ? [{
              provider: modelIdProvider,
              id: modelId.slice(modelId.indexOf("/") + 1),
              fullId: modelId,
            }]
          : undefined,
        preferredModelProvider: modelIdProvider ?? undefined,
        maxSubagentDepth: 0,
        maxToolCalls: maxToolCalls ?? undefined,
      },
    );
    const output = result.finalOutput ?? "";
    if (result.exitCode !== 0 || result.error) {
      throw new Error(result.error ?? `AIPI forked subagent exited ${result.exitCode}`);
    }
    await writeSubagentRunStatus(paths, runId, {
      state: "complete",
      cwd: root,
      startedAt,
      lastUpdate: Date.now(),
      endedAt: Date.now(),
      steps: [subagentRunStep({
        agent: runLabel,
        status: "complete",
        model: result.model ?? modelId,
        thinking: thinkingLevel,
        toolCount: result.progressSummary?.toolCount ?? result.progress?.toolCount ?? 0,
      })],
    });
    return {
      content: [{ type: "text", text: output }],
      output,
      assistant_text: output,
      tool_call_count: result.progressSummary?.toolCount ?? result.progress?.toolCount ?? 0,
      exit_code: result.exitCode,
      run_id: runId,
      sessionFile: result.sessionFile ?? null,
      artifacts: result.artifactPaths ? Object.values(result.artifactPaths).filter(Boolean) : [],
      aipi_runtime: {
        cwd: root,
        runtime_root: paths.runtimeRoot,
        agent_dir: paths.agentDir,
        session_dir: paths.sessionsDir,
        artifacts_dir: paths.artifactsDir,
      },
      model_resolved: result.model ?? modelId ?? null,
    };
  } catch (error) {
    await writeSubagentRunStatus(paths, runId, {
      state: "failed",
      cwd: root,
      startedAt,
      lastUpdate: Date.now(),
      endedAt: Date.now(),
      steps: [subagentRunStep({ agent: runLabel, status: "failed", model: modelId, thinking: thinkingLevel, error: String(error?.message ?? error) })],
    });
    throw error;
  } finally {
    envRestore();
  }
}

// One native run-store step (the shape summarizeAsyncRunDir reads). Only the agent + status are required;
// model/toolCount/error are attached when known so the drilldown shows them.
function subagentRunStep({ agent, status, model, thinking, toolCount, error }) {
  return {
    agent: agent ?? AIPI_SUBAGENTS_AGENT_NAME,
    status,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(typeof toolCount === "number" ? { toolCount } : {}),
    ...(error ? { error } : {}),
  };
}

// Write a per-run status.json under asyncDir in the native format that loadSubagentRuns / summarizeAsyncRunDir
// consume, so the foreground fork shows up in the /aipi-subagents view. Best-effort: a status-write failure
// must NEVER break a real run, so all errors are swallowed.
export async function writeSubagentRunStatus(paths, runId, patch) {
  try {
    const dir = path.join(paths.asyncDir, safePathSegment(runId));
    await fs.mkdir(dir, { recursive: true });
    // Stamp the owning process pid so the vendored stale-run reconciler (loadSubagentRuns -> reconcileAsyncRun)
    // can detect an orphan: AIPI forked runs execute IN THIS process, so after an AIPI restart the recorded pid
    // is dead (ESRCH) and the reconciler reaps the run to `failed` instead of leaving it a zombie `running` in
    // the /aipi-subagents view and the widget. A live in-process run keeps process.pid (alive) and is untouched.
    const status = { runId, mode: "single", steps: [], pid: process.pid, ...patch };
    await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(status), "utf8");
  } catch {
    // Telemetry only; the run continues regardless.
  }
}

function getJiti() {
  if (!cachedJiti) {
    cachedJiti = createJiti(import.meta.url, {
      interopDefault: true,
      moduleCache: false,
    });
  }
  return cachedJiti;
}

function loadForkedRunSync() {
  return getJiti()(runSyncEntrypoint);
}

// Load the vendored subagent view (a TS TUI component) + its data layer via jiti, so /aipi-subagents can
// render our foreground runs. Named exports; the component is instantiated by the caller inside ctx.ui.custom.
export function loadSubagentView() {
  const jiti = getJiti();
  return {
    SubagentViewComponent: jiti(subagentViewEntrypoint).SubagentViewComponent,
    loadSubagentRuns: jiti(historyStoreEntrypoint).loadSubagentRuns,
  };
}

export function createAipiWorkerAgentConfig({
  thinking = undefined,
  allowShell = true,
  maxToolCalls = null,
  hashlineEdit = HASHLINE_WORKER_EDIT_ENABLED,
} = {}) {
  // Shell (aipi_shell, formerly aipi_guarded_bash) is granted ONLY to single-lead, sequential workers —
  // NOT to parallel fanout (review_swarm) workers. A shell bypasses the owned-file/controller-path write
  // guards (it can write outside its owned files, touch .git or .aipi/memory), so giving it to PARALLEL
  // workers would void write-disjointness and controller-path protection. A single-lead worker runs alone
  // (same trust as the main agent), so its shell is acceptable; parallel reviewers stay shell-less and
  // read the verify step's evidence instead. (Validator/tests still see both names in source — they are
  // conditionally included.)
  const shellTools = allowShell ? ["aipi_shell", guardedBashExtensionPath] : [];
  // Additive, flag-gated hashline editing. Both worker classes (lead + parallel reviewer) may receive it:
  // aipi_edit self-enforces the SAME owned-file scope as the guarded write, so it is safe for fanout too.
  const hashlineTools = hashlineEdit
    ? ["aipi_read_hashline", "aipi_edit", hashlineEditExtensionPath]
    : [];
  return {
    name: AIPI_SUBAGENTS_AGENT_NAME,
    package: "aipi",
    description: "AIPI-owned worker runtime forked from pi-subagents.",
    // The guarded-write extension (the .js path) loads and registers a tool named "write", but the
    // child pi process filters every tool — including extension-registered ones — through the
    // `--tools` ALLOWLIST. Without the "write" NAME in the allowlist the registered write tool is
    // stripped, leaving workers unable to author their owned artifacts (every step BLOCKED). Listing
    // "write" activates it; the extension's guarded write overrides the unguarded builtin write by
    // name (custom tools win in the child registry), so owned-file scoping is still enforced.
    tools: [
      ...AIPI_SUBAGENTS_READ_ONLY_TOOLS,
      "write",
      guardedWriteExtensionPath,
      ...shellTools,
      // Live back-channel to the orchestrator — every worker (lead or parallel reviewer) may ask; it
      // only pauses for an answer, it never bypasses the owned-file/controller write guards.
      "aipi_ask_orchestrator",
      askOrchestratorExtensionPath,
      ...hashlineTools,
    ],
    extensions: [],
    fallbackModels: [],
    thinking,
    systemPromptMode: "replace",
    inheritProjectContext: true,
    inheritSkills: false,
    defaultContext: "fresh",
    completionGuard: false,
    systemPrompt: [
      "You are an AIPI worker running inside the project-scoped AIPI subagent runtime.",
      "Use only the allowed project tools. The write tool is guarded by AIPI owned-file scope.",
      allowShell
        ? "For shell (tests, typecheck, build, git, lint) use aipi_shell — your only shell; do not use raw bash/exec. Prefer running the real verification (e.g. the project's test command) over claiming a result."
        : "You have NO shell in this parallel review step; review by reading the code and the verify step's test evidence, and do not claim a result you did not see verified.",
      "Do not use a provider/model other than the selected worker model.",
      "If you hit an ambiguity you cannot resolve from your task or context — a missing or contradictory decision, an underspecified requirement, a 'which option' choice, or missing access/info — call aipi_ask_orchestrator with ONE focused question instead of guessing; you will get an answer and continue. Do not ask about things you can determine yourself from the code, the context packet, or aipi_retrieve.",
      maxToolCalls
        ? `You have a LIMITED tool-call budget (about ${maxToolCalls} calls). Exceeding it interrupts you and DISCARDS your work — nothing is delivered. So pace yourself: don't spend the whole budget exploring; write your complete result/findings (and any owned-file artifacts) well BEFORE you run low. A delivered partial result beats being cut off with nothing.`
        : "You have a LIMITED tool-call budget; exceeding it interrupts you and DISCARDS your work. Pace yourself and write your complete result well before you run low — a delivered partial beats being cut off with nothing.",
      ...(hashlineEdit
        ? [
            "To EDIT an existing file, prefer the hashline flow: call aipi_read_hashline to get the file's `[PATH#TAG]` header and `LINE:TEXT` numbered rows, then aipi_edit with a patch anchored on that TAG. aipi_edit REJECTS a stale TAG instead of corrupting the file — if that happens, re-read with aipi_read_hashline and retry. Use the write tool only to CREATE a new file. The hashline edit format:",
            readHashlinePrompt(),
          ]
        : []),
      "Follow the task exactly and return the requested output format.",
    ].join("\n"),
  };
}

function normalizeOwnedFiles(files) {
  return [...new Set((Array.isArray(files) ? files : [])
    .map((file) => String(file ?? "").trim().replaceAll("\\", "/"))
    .filter(Boolean))];
}

function normalizeMaxToolCalls(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const count = Math.floor(numeric);
  return count > 0 ? count : null;
}

function applyScopedRuntimeEnv(next) {
  const previous = {};
  for (const [key, value] of Object.entries(next)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function safePathSegment(value) {
  return String(value ?? "run")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "run";
}

export function extractToolText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.output === "string") return result.output;
  if (typeof result?.result === "string") return result.result;
  if (typeof result?.assistant_text === "string") return result.assistant_text;
  if (typeof result?.assistantText === "string") return result.assistantText;
  if (Array.isArray(result?.content)) {
    return result.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (result?.stepResult) return JSON.stringify(result.stepResult);
  return "";
}

export async function runPiSubagentsLiveSpike({
  pi = null,
  projectRoot = process.cwd(),
  runner = null,
  providerEventLog = null,
  now = () => new Date(),
} = {}) {
  const logPath = providerEventLog ?? path.join(projectRoot, ".aipi", "runtime", "provider-events.jsonl");
  const before = await countJsonlLines(logPath);
  const startedAt = now().toISOString();
  const spawnParams = {
    agent: AIPI_SUBAGENTS_AGENT_NAME,
    task: LIVE_SPIKE_TASK,
    async: false,
    context: "fresh",
  };
  const resolvedRunner = normalizePiSubagentsRunner(runner, pi);
  const raw = await resolvedRunner.spawn(spawnParams);
  const finishedAt = now().toISOString();
  const after = await countJsonlLines(logPath);
  const text = extractToolText(raw).trim();
  const providerEventDelta = Math.max(0, after - before);
  const assistantTextOk = /\bOK\b/i.test(text);
  const providerEventObserved = providerEventDelta > 0;

  return {
    schema: PI_SUBAGENTS_LIVE_SPIKE_SCHEMA,
    package: PI_SUBAGENTS_PACKAGE,
    vendor_root: PI_SUBAGENTS_VENDOR_ROOT,
    runtime_root: AIPI_SUBAGENTS_RUNTIME_ROOT,
    backend: "aipi-forked-pi-subagents",
    command: "/aipi-pi-subagents-spike",
    started_at: startedAt,
    finished_at: finishedAt,
    spawn_params: spawnParams,
    assistant_text_returned: text.length > 0,
    assistant_text_ok: assistantTextOk,
    assistant_text_excerpt: text.slice(0, 240),
    provider_event_log: path.relative(projectRoot, logPath).replaceAll("\\", "/") || logPath,
    provider_events_before: before,
    provider_events_after: after,
    provider_event_delta: providerEventDelta,
    provider_event_observed: providerEventObserved,
    go_no_go: assistantTextOk && providerEventObserved ? "GO_CANDIDATE" : "NO_GO",
    go_criteria: [
      "assistant_text_ok must be true",
      "provider_event_observed must be true",
      "the run must occur inside a real AIPI/Pi session started through the `aipi` wrapper",
    ],
  };
}

export function formatPiSubagentsLiveSpike(result) {
  return [
    "AIPI pi-subagents live spike",
    `Package: ${result.package}`,
    `Runtime root: ${result.runtime_root}`,
    `Backend: ${result.backend}`,
    `Assistant text OK: ${result.assistant_text_ok}`,
    `Provider event observed: ${result.provider_event_observed} (delta ${result.provider_event_delta})`,
    `GO/NO-GO: ${result.go_no_go}`,
    `Text: ${result.assistant_text_excerpt || "(empty)"}`,
  ].join("\n");
}

export function formatPiSubagentsSmokeInstructions() {
  return [
    "AIPI forked pi-subagents live spike",
    "",
    "Preconditions:",
    "1. Start a real session through the `aipi` wrapper so the AIPI runtime and provider extension load.",
    "2. Authenticate/select the provider and model in that AIPI session.",
    "3. Run: /aipi-pi-subagents-spike",
    "",
    "GO criteria:",
    "1. assistant_text_ok=true for the worker reply to `OK`.",
    "2. provider_event_observed=true in .aipi/runtime/provider-events.jsonl after the worker run.",
    "3. worker session/artifact/result files are under .aipi/runtime/subagents/.",
    "4. no provider/model other than the selected worker model is attempted.",
    "",
    "No `pi install npm:pi-subagents` step is required.",
    "The forked pi-subagents runtime is the default AIPI worker runtime; no backend flag is required.",
  ].join("\n");
}

async function countJsonlLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter((line) => line.trim()).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}
