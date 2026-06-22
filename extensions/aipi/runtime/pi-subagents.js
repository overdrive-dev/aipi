import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

export const PI_SUBAGENTS_PACKAGE = "pi-subagents@0.28.0";
export const PI_SUBAGENTS_VENDOR_ROOT = "extensions/aipi/runtime/vendor/pi-subagents";
export const PI_SUBAGENTS_ISOLATION = "pi_subagents";
export const PI_SUBAGENTS_LIVE_SPIKE_SCHEMA = "aipi.pi-subagents-spike.v1";
export const AIPI_SUBAGENTS_RUNTIME_ROOT = ".aipi/runtime/subagents";
export const AIPI_SUBAGENTS_AGENT_NAME = "aipi-worker";
export const AIPI_SUBAGENTS_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "write"];
export const AIPI_SUBAGENTS_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const AIPI_SUBAGENTS_GUARDED_WRITE_EXTENSION = "extensions/aipi/runtime/aipi-guarded-write-child.js";
export const AIPI_SUBAGENTS_DISALLOWED_PROVIDERS = [];
export const AIPI_HOST_SUPPORTED_PROVIDERS = ["anthropic"];
export const AIPI_HOST_MODEL_READINESS_MESSAGE =
  "AIPI host model is unavailable to the AIPI orchestrator turn.";

const LIVE_SPIKE_TASK = "Reply with the single word OK.";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.join(currentDir, "vendor", "pi-subagents");
const runSyncEntrypoint = path.join(vendorRoot, "src", "runs", "foreground", "execution.ts");
const guardedWriteExtensionPath = path.join(currentDir, "aipi-guarded-write-child.js");
let cachedJiti = null;

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

export function aipiHostModelReadiness(model, { requireProvider = false, requireModel = false } = {}) {
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
  if (!provider) {
    if (looksUnsupportedUnqualifiedHostModel(normalizedModelId)) {
      return unsupportedHostModelReadiness({
        code: "AIPI_HOST_MODEL_UNSUPPORTED",
        modelId: normalizedModelId,
        provider: null,
        detail:
          "Unqualified GPT/Codex-style host models are not supported for the orchestrator turn; use them as adversarial reviewers or choose a supported Anthropic host model.",
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
  if (!AIPI_HOST_SUPPORTED_PROVIDERS.includes(provider)) {
    return unsupportedHostModelReadiness({
      code: "AIPI_HOST_MODEL_UNSUPPORTED",
      modelId: normalizedModelId,
      provider,
      detail:
        `Host provider ${provider} is not supported for the orchestrator turn; use it as the adversarial reviewer or set the host to a supported Anthropic model.`,
    });
  }
  if (AIPI_SUBAGENTS_DISALLOWED_PROVIDERS.includes(provider)) {
    return unsupportedHostModelReadiness({
      code: "AIPI_HOST_MODEL_UNSUPPORTED",
      modelId: normalizedModelId,
      provider,
      detail: `Provider ${provider} is not available in this installed AIPI/Pi worker runtime.`,
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
  const envRestore = applyScopedRuntimeEnv({
    AIPI_SUBAGENTS_AGENT_DIR: paths.agentDir,
    AIPI_SUBAGENTS_RUNTIME_DIR: paths.runtimeRoot,
    AIPI_SUBAGENTS_PROJECT_ROOT: root,
    AIPI_SUBAGENTS_AGENT_ID: job?.agentId ?? params.id ?? AIPI_SUBAGENTS_AGENT_NAME,
    AIPI_SUBAGENTS_OWNED_FILES: JSON.stringify(ownedFiles),
    AIPI_SUBAGENTS_MAX_TOOL_CALLS: maxToolCalls == null ? "" : String(maxToolCalls),
  });
  try {
    const { runSync } = loadForkedRunSync();
    const result = await runSync(
      root,
      [createAipiWorkerAgentConfig({ thinking: params.thinking_level ?? undefined })],
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
  } finally {
    envRestore();
  }
}

function loadForkedRunSync() {
  if (!cachedJiti) {
    cachedJiti = createJiti(import.meta.url, {
      interopDefault: true,
      moduleCache: false,
    });
  }
  return cachedJiti(runSyncEntrypoint);
}

function createAipiWorkerAgentConfig({ thinking = undefined } = {}) {
  return {
    name: AIPI_SUBAGENTS_AGENT_NAME,
    package: "aipi",
    description: "AIPI-owned worker runtime forked from pi-subagents.",
    tools: [...AIPI_SUBAGENTS_READ_ONLY_TOOLS, guardedWriteExtensionPath],
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
      "Do not use shell, bash, exec, or a provider/model other than the selected worker model.",
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
