// AIPI subagent coordinator - stable tool surface for the forked pi-subagents runtime.
//
// The public aipi_* tools stay stable, but workers now run through the single
// AIPI-owned forked runtime. This coordinator owns spawn/status/collect/cancel,
// owned-file allocation, model provenance, budgets, tracing, and resumable state.
//
// Tool `parameters` below use JSON Schema for readability. The Pi extension API
// expects its schema builder (Type.Object) per /docs/latest/extensions — swap
// before loading if required.

import os from "node:os";
import fsSync from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OwnedFileRegistry, wrapWriteToolWithOwnership } from "./owned-files.js";
import { validateStepResult } from "./step-result.js";
import { aipiRetrieve } from "./aipi-tools.js";
import {
  BUILTIN_MODEL_CLASSES,
  HOST_DEFAULT_MODEL,
  loadKnownModelClassesSync,
  resolveSpawnModelDecision,
} from "./model-router.js";
import {
  PI_SUBAGENTS_ISOLATION,
  assertAipiHostScopedModel,
  assertAipiSupportedHostModel,
  extractToolText,
  normalizePiSubagentsBackend,
  normalizePiSubagentsRunner,
} from "./pi-subagents.js";

const DEFAULT_CONCURRENCY = Math.max(1, os.cpus().length - 2);
const STEP_RESULT_SCHEMA = "aipi.step-result.v1";
export const SUBAGENT_STATE_ENTRY = "aipi.subagents.state";
export const SUBAGENT_EVENT_ENTRY = "aipi.subagents.event";
export const AIPI_ANTHROPIC_OAUTH_EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "provider",
  "anthropic-oauth-only.ts",
);

const JobState = {
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  CANCELLED: "cancelled",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
  REDISPATCHED: "redispatched",
};

export class SubagentCoordinator {
  #pi;
  #maxConcurrent;
  #jobs = new Map(); // agent_id -> job
  #queue = []; // agent_ids waiting for a slot
  #runningCount = 0;
  #registry;
  #root;
  #piSubagentsRunner;
  #knownModelClasses;
  #hostModel;
  #env;

  constructor(
    pi,
    {
      maxConcurrent = DEFAULT_CONCURRENCY,
      root,
      piSubagentsRunner = null,
      knownModelClasses = null,
      hostModel = null,
      env = process.env,
    } = {},
  ) {
    this.#pi = pi;
    this.#maxConcurrent = maxConcurrent;
    this.#root = root ?? process.cwd();
    this.#registry = new OwnedFileRegistry(this.#root);
    this.#piSubagentsRunner = piSubagentsRunner;
    this.#knownModelClasses =
      knownModelClasses != null
        ? new Set(knownModelClasses)
        : (loadKnownModelClassesSync(this.#root) ?? new Set(BUILTIN_MODEL_CLASSES));
    this.#hostModel = hostModel;
    this.#env = env;
  }

  get registry() {
    return this.#registry;
  }

  // aipi_spawn_agent
  spawn(descriptor) {
    return this.#spawnNew(descriptor);
  }

  setHostModel(model) {
    this.#hostModel = model ?? null;
  }

  getHostModel() {
    return this.#hostModel;
  }

  dispatch(descriptor) {
    const interrupted = this.#findInterruptedJob(descriptor);
    if (!interrupted) return { ...this.#spawnNew(descriptor), redispatched: false };

    this.#registry.release(interrupted.agentId);
    interrupted.state = JobState.REDISPATCHED;
    interrupted.finishedAt = Date.now();
    interrupted.lastSummary = "redispatched";
    this.#trace("redispatched", interrupted, {
      reason: "clean-boundary redispatch",
      step_id: descriptor.step_id ?? interrupted.descriptor?.step_id ?? null,
    });
    const next = this.#spawnNew(descriptor);
    this.#persist();
    return {
      ...next,
      redispatched: true,
      redispatched_from: interrupted.agentId,
    };
  }

  #spawnNew(descriptor) {
    const isolation = normalizeIsolation(descriptor, this.#env);
    if (descriptor.cwd) {
      throw new Error(
        "AIPI forked subagents always run with cwd set to the project root; per-worker cwd is unsupported.",
      );
    }
    assertSupportedIsolation(isolation);
    // Hybrid model-class policy: validate BEFORE any side effects so a strict-rejected
    // spawn (unknown class without allow_fallback) leaves no orphaned allocation.
    const descriptorWithHostModel = withHostModel(descriptor, this.#hostModel);
    const modelResolution = resolveSpawnModelDecision({
      knownClasses: this.#knownModelClasses,
      descriptor: descriptorWithHostModel,
    });
    if (modelResolution.resolved === HOST_DEFAULT_MODEL) {
      const err = new Error("AIPI worker spawn requires a concrete host model; current session model was unavailable.");
      err.code = "AIPI_HOST_MODEL_UNAVAILABLE";
      throw err;
    }
    if (modelResolution.host_fallback) {
      assertAipiSupportedHostModel(descriptorWithHostModel.host_model ?? descriptorWithHostModel.hostModel, {
        requireModel: true,
      });
    }
    assertAipiHostScopedModel(modelResolution.resolved, { requireModel: true });
    const workerDescriptor = withWorkerContextPacket(
      descriptorWithResolvedModel(descriptorWithHostModel, modelResolution),
      { root: this.#root },
    );
    const base = descriptor.agent_id ?? "agent";
    const agentId = `${base}:${randomUUID().slice(0, 8)}`;
    if (Array.isArray(descriptor.owned_files) && descriptor.owned_files.length) {
      this.#registry.allocate(agentId, descriptor.owned_files); // throws on overlap
    }
    if (modelResolution.warning) this.#emitModelWarning(agentId, modelResolution.warning);
    const budget = normalizeBudget(descriptor.budget);
    this.#jobs.set(agentId, {
      agentId,
      descriptor: workerDescriptor,
      isolation,
      modelResolution,
      state: JobState.QUEUED,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      abortReason: null,
      budget,
      budgetTimeoutMs: budget.timeoutMs,
      toolCallCount: 0,
      promptStartedAt: null,
      promptEndedAt: null,
      controller: new AbortController(),
      lastSummary: null,
      harnessHandle: null,
      ownedFileBaseline: snapshotOwnedFiles(this.#root, descriptor.owned_files),
    });
    const job = this.#jobs.get(agentId);
    this.#queue.push(agentId);
    this.#trace("queued", job, budgetTraceData(job));
    this.#persist();
    this.#pump();
    return { agent_id: agentId };
  }

  // aipi_agent_status
  status(agentId) {
    const job = this.#requireJob(agentId);
    const model = job.modelResolution ?? null;
    return {
      agent_id: agentId,
      state: job.state,
      elapsed_ms: job.startedAt ? (job.finishedAt ?? Date.now()) - job.startedAt : 0,
      last_summary: job.lastSummary,
      error: job.error,
      model_requested: model?.requested ?? null,
      model_resolved: model?.resolved ?? null,
      model_fallback: model?.fallback ?? false,
      model_source: model?.source ?? null,
      model_warning: model?.warning ?? null,
      budget_timeout_ms: job.budgetTimeoutMs,
      budget_max_tool_calls: job.budget?.maxToolCalls ?? null,
      tool_call_count: job.toolCallCount ?? 0,
      remaining_tool_calls:
        typeof job.budget?.maxToolCalls === "number"
          ? Math.max(0, job.budget.maxToolCalls - (job.toolCallCount ?? 0))
          : null,
      abort_reason: job.abortReason,
    };
  }

  // aipi_collect_agent — structured result + artifact pointers, never memory.
  collect(agentId) {
    const job = this.#requireJob(agentId);
    if (job.state !== JobState.DONE) {
      return { agent_id: agentId, ready: false, state: job.state };
    }
    return {
      agent_id: agentId,
      ready: true,
      step_result: job.result?.stepResult ?? null,
      artifacts: job.result?.artifacts ?? [],
    };
  }

  // aipi_cancel_agent
  cancel(agentId) {
    const job = this.#requireJob(agentId);
    if (job.state === JobState.RUNNING || job.state === JobState.QUEUED) {
      job.controller.abort();
      job.state = JobState.CANCELLED;
      job.finishedAt = Date.now();
      job.abortReason = "user_cancelled";
      this.#registry.release(agentId);
      this.#trace("cancelled", job, { reason: job.abortReason });
    }
    this.#persist();
    return { agent_id: agentId, cancelled: true, reassign: job.descriptor.owned_files ?? [] };
  }

  // aipi_steer_agent — bounded follow-up; only meaningful while running.
  steer(agentId, message) {
    const job = this.#requireJob(agentId);
    if (job.state !== JobState.RUNNING) {
      return { agent_id: agentId, accepted: false, reason: `not steerable in state ${job.state}` };
    }
    const result = this.#steerWorkerSession(job, message);
    this.#trace("steer", job, { accepted: result.accepted, reason: result.reason });
    return { agent_id: agentId, ...result };
  }

  // Retention only; never deletes durable memory.
  cleanup() {
    const removedAgents = [];
    const retainedByState = {};
    for (const [agentId, job] of this.#jobs) {
      if ([JobState.DONE, JobState.CANCELLED, JobState.FAILED, JobState.REDISPATCHED].includes(job.state)) {
        this.#registry.release(agentId);
        this.#jobs.delete(agentId);
        removedAgents.push({ agent_id: agentId, state: job.state });
      } else {
        retainedByState[job.state] = (retainedByState[job.state] ?? 0) + 1;
      }
    }
    this.#trace("cleanup", null, {
      removed_agents: removedAgents.length,
      retained_agents: this.#jobs.size,
      retained_by_state: retainedByState,
    });
    this.#persist();
    return {
      schema: "aipi.subagents.cleanup.v1",
      removed_agents: removedAgents.length,
      removed: removedAgents,
      retained_agents: this.#jobs.size,
      retained_by_state: retainedByState,
      durable_memory_deleted: false,
    };
  }

  // Rebuild after a parent restart. In-flight workers become `interrupted` for
  // re-dispatch from their last clean step boundary, never mid-write.
  restore(state) {
    if (!state) return { restored: false, restored_jobs: 0, interrupted_jobs: 0, reason: "no state" };
    this.#jobs = new Map();
    this.#queue = [];
    this.#runningCount = 0;
    this.#registry = new OwnedFileRegistry(this.#root);
    this.#registry.restore(state.ownedFiles);

    const states = {};
    let interruptedJobs = 0;
    for (const j of state.jobs ?? []) {
      if (!j?.agentId) continue;
      const restoredState = normalizeRestoredJobState(j.state);
      if (restoredState === JobState.INTERRUPTED && [JobState.QUEUED, JobState.RUNNING].includes(j.state)) {
        interruptedJobs += 1;
      }
      states[restoredState] = (states[restoredState] ?? 0) + 1;
      this.#jobs.set(j.agentId, {
        agentId: j.agentId,
        descriptor: j.descriptor ?? { agent_id: j.agentId, owned_files: [] },
        modelResolution: j.model
          ? { ...j.model, model: null, known: true, mismatch: false, warning: null }
          : null,
        state: restoredState,
        startedAt: typeof j.startedAt === "number" ? j.startedAt : null,
        finishedAt: typeof j.finishedAt === "number" ? j.finishedAt : null,
        result: j.result ?? null,
        error: j.error ?? null,
        abortReason: j.abortReason ?? null,
        budgetTimeoutMs: typeof j.budgetTimeoutMs === "number"
          ? j.budgetTimeoutMs
          : normalizeBudgetTimeoutMs(j.descriptor?.budget),
        budget: j.budget ?? normalizeBudget(j.descriptor?.budget),
        toolCallCount: j.toolCallCount ?? 0,
        promptStartedAt: j.promptStartedAt ?? null,
        promptEndedAt: j.promptEndedAt ?? null,
        controller: new AbortController(),
        lastSummary: j.lastSummary ?? null,
        harnessHandle: j.harnessHandle ?? null,
      });
    }
    this.#persist();
    this.#trace("restored", null, {
      restored_jobs: this.#jobs.size,
      interrupted_jobs: interruptedJobs,
      states,
    });
    return {
      restored: true,
      restored_jobs: this.#jobs.size,
      interrupted_jobs: interruptedJobs,
      states,
      owned_file_allocations: Array.isArray(state.ownedFiles) ? state.ownedFiles.length : 0,
    };
  }

  // --- internals ---

  #pump() {
    while (this.#runningCount < this.#maxConcurrent && this.#queue.length) {
      const agentId = this.#queue.shift();
      const job = this.#jobs.get(agentId);
      if (!job || job.state !== JobState.QUEUED) continue;
      this.#runJob(job);
    }
  }

  async #runJob(job) {
    job.state = JobState.RUNNING;
    job.startedAt = Date.now();
    this.#runningCount += 1;
    this.#trace("started", job, budgetTraceData(job));
    this.#persist();
    const budgetTimer = this.#startBudgetTimer(job);
    try {
      const raw = await this.#spawnWorkerSession(job, job.controller.signal);
      job.result = this.#parseResult(job, raw);
      job.state = JobState.DONE;
      this.#trace("done", job, { verdict: job.lastSummary, ...finishTraceData(job) });
    } catch (err) {
      job.state = job.controller.signal.aborted ? JobState.CANCELLED : JobState.FAILED;
      if (job.state === JobState.FAILED) {
        job.error = String(err?.message ?? err);
        this.#trace("failed", job, { error: job.error });
      } else {
        job.error ??= String(err?.message ?? err);
        this.#trace("cancelled", job, { reason: job.abortReason, error: job.error });
      }
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      job.finishedAt = Date.now();
      this.#trace("worker_cleanup", job, finishTraceData(job));
      this.#runningCount -= 1;
      this.#persist();
      this.#pump();
    }
  }

  #parseResult(job, raw) {
    const stepResult = raw?.stepResult ?? raw;
    const validation = validateStepResult(stepResult);
    if (!validation.ok) {
      throw new Error(
        `${job.agentId} returned invalid ${STEP_RESULT_SCHEMA}: ${validation.errors.join("; ")}`,
      );
    }
    if (stepResult?.verdict === "PASS" && !validation.gatePassed) {
      throw new Error(
        `${job.agentId} returned PASS without required evidence gate: ${validation.gateErrors.join("; ")}`,
      );
    }
    // Stamp authoritative model provenance — a worker can't reliably self-report which
    // model it ran on, so the coordinator records it so a PASS verdict can't hide a swap.
    if (Number.isFinite(Number(raw?.tool_call_count))) {
      job.toolCallCount = Math.max(job.toolCallCount ?? 0, Number(raw.tool_call_count));
    }
    if (stepResult?.verdict === "PASS") {
      const evidence = verifyWorkerPassEvidence({
        root: this.#root,
        job,
        raw,
        stepResult,
      });
      if (!evidence.passed) {
        downgradeWorkerPass(stepResult, evidence);
      } else {
        stepResult.aipi_real_evidence = {
          artifacts: evidence.existingArtifacts,
          owned_files_changed: evidence.changedOwnedFiles,
          exit_code: evidence.exitCode,
        };
      }
    }
    const model = job.modelResolution;
    if (model) {
      stepResult.model_requested = model.requested ?? null;
      stepResult.model_resolved = model.resolved ?? null;
      stepResult.model_fallback = model.fallback ?? false;
      if (model.warning) stepResult.model_warning = model.warning.message;
    }
    job.lastSummary = stepResult?.verdict ?? null;
    return { stepResult, artifacts: raw?.artifacts ?? stepResult?.artifacts ?? [] };
  }

  #emitModelWarning(agentId, warning) {
    const line = `[aipi:${agentId}] ${warning.code}: ${warning.message}`;
    // Best-effort surfacing; the durable signal also lives in status() + step_result.
    try {
      this.#pi?.log?.(line);
    } catch {
      /* logging is best-effort */
    }
  }

  #requireJob(agentId) {
    const job = this.#jobs.get(agentId);
    if (!job) throw new Error(`unknown agent ${agentId}`);
    return job;
  }

  #findInterruptedJob(descriptor) {
    const stepId = descriptor?.step_id ?? null;
    const catalogAgentId = descriptor?.agent_id ?? null;
    const ownedFiles = normalizedFileList(descriptor?.owned_files);
    for (const job of this.#jobs.values()) {
      if (job.state !== JobState.INTERRUPTED) continue;
      if (stepId && job.descriptor?.step_id !== stepId) continue;
      if (catalogAgentId && job.descriptor?.agent_id !== catalogAgentId) continue;
      if (!sameFileList(ownedFiles, normalizedFileList(job.descriptor?.owned_files))) continue;
      return job;
    }
    return null;
  }

  #persist() {
    // Survives reload/compaction; not in LLM context. Mirror to .aipi/runtime in
    // the run-state module (spike S4).
    this.#pi?.appendEntry?.(SUBAGENT_STATE_ENTRY, {
      jobs: [...this.#jobs.values()].map((j) => ({
        agentId: j.agentId,
        state: j.state,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        descriptor: {
          agent_id: j.descriptor.agent_id,
          owned_files: j.descriptor.owned_files ?? [],
        },
        result: j.result,
        error: j.error,
        abortReason: j.abortReason,
        budgetTimeoutMs: j.budgetTimeoutMs,
        budget: j.budget,
        toolCallCount: j.toolCallCount ?? 0,
        promptStartedAt: j.promptStartedAt,
        promptEndedAt: j.promptEndedAt,
        lastSummary: j.lastSummary,
        harnessHandle: j.harnessHandle ?? null,
        model: j.modelResolution
          ? {
              requested: j.modelResolution.requested ?? null,
              resolved: j.modelResolution.resolved ?? null,
              fallback: j.modelResolution.fallback ?? false,
              source: j.modelResolution.source ?? null,
            }
          : null,
      })),
      ownedFiles: this.#registry.snapshot(),
    });
  }

  // ===================================================================
  // Worker runtime seam - the ONLY place that creates worker sessions.
  // ===================================================================
  async #spawnWorkerSession(job, signal) {
    if (job.isolation !== PI_SUBAGENTS_ISOLATION) {
      throw new Error(`AIPI only supports ${PI_SUBAGENTS_ISOLATION} worker isolation; got ${job.isolation}`);
    }
    return this.#spawnPiSubagentsWorker(job, signal);
  }

  #makeWorkerTrace(job) {
    return (event, data = {}) => {
      if (event === "tool_start") this.#recordToolStart(job, data);
      this.#trace(event, job, {
        ...data,
        tool_call_count: job.toolCallCount ?? 0,
      });
    };
  }

  #recordToolStart(job, data = {}) {
    const maxToolCalls = job.budget?.maxToolCalls;
    const nextCount = (job.toolCallCount ?? 0) + 1;
    if (typeof maxToolCalls === "number" && nextCount > maxToolCalls) {
      job.abortReason = "budget_max_tool_calls";
      job.error = `budget max_tool_calls exceeded after ${job.toolCallCount ?? 0}/${maxToolCalls} tool calls`;
      this.#trace("budget_limit_exceeded", job, {
        limit: "max_tool_calls",
        value: maxToolCalls,
        tool_name: data.tool_name ?? null,
        tool_call_count: job.toolCallCount ?? 0,
      });
      job.controller.abort();
      throw new Error(job.error);
    }
    job.toolCallCount = nextCount;
  }

  async #spawnPiSubagentsWorker(job, signal) {
    if (signal?.aborted) throw new Error(`${job.agentId} was aborted before start`);
    const runner = normalizePiSubagentsRunner(this.#piSubagentsRunner, this.#pi, { root: this.#root });
    await this.#materializeWorkerRetrievalContext(job);
    const prompt = buildWorkerPrompt(job);
    const spawnParams = {
      agent: "aipi-worker",
      task: prompt,
      async: false,
      context: "fresh",
      model: job.descriptor?.model ?? null,
      thinking_level: job.descriptor?.thinking_level ?? null,
      owned_files: job.descriptor?.owned_files ?? [],
      max_tool_calls: job.budget?.maxToolCalls ?? null,
    };

    this.#trace("aipi_forked_subagent_start", job, {
      isolation: PI_SUBAGENTS_ISOLATION,
      spawn_agent: spawnParams.agent,
      owned_files: job.descriptor?.owned_files ?? [],
      runtime_root: ".aipi/runtime/subagents",
    });
    job.promptStartedAt = Date.now();
    this.#trace("worker_prompt_start", job, {
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
      isolation: PI_SUBAGENTS_ISOLATION,
    });

    const raw = await runner.spawn(spawnParams, {
      signal,
      job: serializeWorkerJob(job),
      ctx: { aipi_backend: PI_SUBAGENTS_ISOLATION, project_root: this.#root },
    });

    job.promptEndedAt = Date.now();
    this.#trace("worker_prompt_end", job, {
      prompt_elapsed_ms: job.promptEndedAt - job.promptStartedAt,
      isolation: PI_SUBAGENTS_ISOLATION,
    });
    if (signal?.aborted) throw new Error(`${job.agentId} was aborted`);

    const stepResult = raw?.stepResult ?? parseWorkerStepResult(extractToolText(raw));
    const normalized = {
      stepResult,
      artifacts: raw?.artifacts ?? stepResult.artifacts ?? [],
      tool_call_count: raw?.tool_call_count ?? raw?.toolCallCount ?? null,
      exit_code: raw?.exit_code ?? raw?.exitCode ?? null,
      pi_subagents_run_id: raw?.id ?? raw?.run_id ?? raw?.runId ?? null,
      harnessHandle: raw?.aipi_runtime ?? null,
    };
    job.harnessHandle = normalized.harnessHandle;
    this.#recordForkedToolCount(job, normalized.tool_call_count);
    this.#trace("aipi_forked_subagent_end", job, {
      isolation: PI_SUBAGENTS_ISOLATION,
      artifact_count: normalized.artifacts.length,
      tool_call_count: normalized.tool_call_count,
      pi_subagents_run_id: normalized.pi_subagents_run_id,
      runtime_root: normalized.harnessHandle?.runtime_root ?? null,
    });
    this.#enforceForkedToolBudget(job);
    return normalized;
  }

  #recordForkedToolCount(job, rawCount) {
    const numeric = Number(rawCount);
    if (!Number.isFinite(numeric)) return;
    job.toolCallCount = Math.max(job.toolCallCount ?? 0, Math.floor(numeric));
  }

  #enforceForkedToolBudget(job) {
    const maxToolCalls = job.budget?.maxToolCalls;
    if (typeof maxToolCalls !== "number" || (job.toolCallCount ?? 0) <= maxToolCalls) return;
    job.abortReason = "budget_max_tool_calls";
    job.error = `budget max_tool_calls exceeded after ${job.toolCallCount ?? 0}/${maxToolCalls} tool calls`;
    this.#trace("budget_limit_exceeded", job, {
      limit: "max_tool_calls",
      value: maxToolCalls,
      tool_call_count: job.toolCallCount ?? 0,
      isolation: PI_SUBAGENTS_ISOLATION,
    });
    throw new Error(job.error);
  }

  async #materializeWorkerRetrievalContext(job) {
    const prefetch = await buildWorkerRetrievalPrefetch({ descriptor: job.descriptor, root: this.#root });
    this.#trace("worker_context_prefetch", job, prefetch.trace);
    if (!prefetch.text) return;
    job.descriptor = {
      ...job.descriptor,
      context_packet: [job.descriptor.context_packet?.trim(), prefetch.text].filter(Boolean).join("\n\n"),
    };
  }

  #steerWorkerSession(_job, _message) {
    // SDK seam: forward a bounded follow-up to the live worker session.
    return {
      accepted: false,
      reason:
        "aipi-agent-session steering is disabled until worker prompt/response boundaries are resumable",
    };
  }

  #startBudgetTimer(job) {
    if (!job.budgetTimeoutMs) return null;
    const timer = setTimeout(() => {
      job.abortReason = "budget_timeout";
      job.error = `budget timeout after ${job.budgetTimeoutMs}ms`;
      this.#trace("budget_timeout", job, { timeout_ms: job.budgetTimeoutMs });
      job.controller.abort();
    }, job.budgetTimeoutMs);
    timer.unref?.();
    return timer;
  }

  #trace(event, job = null, data = {}) {
    try {
      this.#pi?.appendEntry?.(SUBAGENT_EVENT_ENTRY, {
        schema: "aipi.subagent-event.v1",
        recorded_at: new Date().toISOString(),
        event,
        agent_id: job?.agentId ?? data.agent_id ?? null,
        state: job?.state ?? null,
        ...data,
      });
    } catch {
      /* best-effort session trace */
    }
  }
}

export function latestSubagentStateFromEntries(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    if (!isSubagentStateEntry(entry)) continue;
    return entry.data ?? entry.value ?? entry.payload ?? null;
  }
  return null;
}

export function buildWorkerPrompt(job) {
  const descriptor = job.descriptor ?? {};
  const ownedFiles = descriptor.owned_files?.length
    ? descriptor.owned_files.map((file) => `- ${file}`).join("\n")
    : "(none)";
  const expectedArtifacts = descriptor.expected_artifacts?.length
    ? descriptor.expected_artifacts.map((file) => `- ${file}`).join("\n")
    : "(none)";
  const contextPacket = descriptor.context_packet?.trim() || "(no context packet provided)";

  return [
    "You are an AIPI spawned session worker.",
    `AIPI worker id: ${job.agentId}`,
    `Catalog agent id: ${descriptor.agent_id ?? "unknown"}`,
    `Model class: ${descriptor.model_class ?? "unresolved"}`,
    `Result schema: ${descriptor.result_schema ?? STEP_RESULT_SCHEMA}`,
    "",
    "Rules:",
    "- Use only the tools available in this worker session.",
    "- You may write only files listed in Owned files.",
    "- Do not write project memory under .aipi/memory.",
    "- If you cannot complete the assignment, return BLOCKED or FAIL as structured JSON.",
    "- A PASS result must include at least one evidence item with rung ran or verified.",
    "- Return only JSON. Do not wrap it in prose.",
    "",
    "Owned files:",
    ownedFiles,
    "",
    "Artifact target:",
    descriptor.artifact_target ?? "(none)",
    "",
    "Expected artifacts:",
    expectedArtifacts,
    "",
    "Before returning PASS, write every expected artifact with the write tool. If you cannot write one, return BLOCKED or FAIL.",
    "",
    "Context packet:",
    contextPacket,
    "",
    "Required output JSON shape:",
    JSON.stringify(
      {
        schema: STEP_RESULT_SCHEMA,
        step_id: descriptor.step_id ?? "step-id",
        agent_ids: [job.agentId],
        verdict: "PASS | FAIL | SKIPPED | BLOCKED | BLOCKED_TO_PLANNING",
        evidence: [
          {
            rung: "written | ran | verified | blocked",
            source: "tool | command | review | contract",
            ref: "specific file, command, or artifact",
            result: "short concrete outcome",
          },
        ],
        artifacts: ["relative/path/to/artifact"],
      },
      null,
      2,
    ),
  ].join("\n");
}

export function buildWorkerTools(sdk, { root, registry, agentId, trace = null }) {
  const readTools = buildReadOnlyToolDefinitions(sdk, root);
  const writeTool = buildWriteToolDefinition(sdk, root);
  const guardedWrite = wrapWriteToolWithOwnership(writeTool, { registry, agentId });
  const customTools = [...readTools, guardedWrite].map((tool) => wrapToolWithTrace(tool, trace));
  const toolNames = [...new Set(customTools.map((tool) => tool?.name).filter(Boolean))];

  if (!toolNames.includes("write")) {
    throw new Error("AIPI worker toolset must include the guarded write tool");
  }

  return { customTools, toolNames };
}

function wrapToolWithTrace(toolDef, trace) {
  if (!toolDef || typeof toolDef.execute !== "function" || typeof trace !== "function") {
    return toolDef;
  }
  return {
    ...toolDef,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      try {
        trace("tool_start", { tool_name: toolDef.name });
        const result = await toolDef.execute(toolCallId, params, signal, onUpdate, ctx);
        trace("tool_end", {
          tool_name: toolDef.name,
          is_error: Boolean(result?.isError),
        });
        return result;
      } catch (error) {
        trace("tool_error", {
          tool_name: toolDef.name,
          error: String(error?.message ?? error),
        });
        throw error;
      }
    },
  };
}

export function parseWorkerStepResult(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("worker returned empty assistant text");

  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return parsed?.stepResult ?? parsed;
    } catch {
      // Try the next extraction strategy.
    }
  }

  throw new Error(`worker did not return parseable ${STEP_RESULT_SCHEMA} JSON`);
}

function buildReadOnlyToolDefinitions(sdk, root) {
  if (typeof sdk.createReadOnlyToolDefinitions === "function") {
    return sdk.createReadOnlyToolDefinitions(root);
  }

  return [
    sdk.createReadToolDefinition?.(root),
    sdk.createGrepToolDefinition?.(root),
    sdk.createFindToolDefinition?.(root),
    sdk.createLsToolDefinition?.(root),
  ].filter(Boolean);
}

function buildWriteToolDefinition(sdk, root) {
  const tool =
    sdk.createWriteToolDefinition?.(root) ??
    sdk.createToolDefinition?.("write", root);
  if (!tool) throw new Error("Pi SDK createWriteToolDefinition is unavailable");
  return tool;
}

function normalizeRestoredJobState(state) {
  if (state === JobState.QUEUED || state === JobState.RUNNING) {
    return JobState.INTERRUPTED;
  }
  if (Object.values(JobState).includes(state)) return state;
  return JobState.INTERRUPTED;
}

function normalizeBudgetTimeoutMs(budget) {
  const value = budget?.timeout_ms ?? budget?.timeoutMs ?? budget?.max_runtime_ms ?? budget?.maxRuntimeMs;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const ms = Math.floor(numeric);
  return ms > 0 ? ms : null;
}

function normalizeBudget(budget) {
  return {
    timeoutMs: normalizeBudgetTimeoutMs(budget),
    maxToolCalls: normalizeBudgetMaxToolCalls(budget),
  };
}

function normalizeBudgetMaxToolCalls(budget) {
  const value = budget?.max_tool_calls ?? budget?.maxToolCalls;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const count = Math.floor(numeric);
  return count > 0 ? count : null;
}

function budgetTraceData(job) {
  return {
    budget_timeout_ms: job.budgetTimeoutMs ?? null,
    budget_max_tool_calls: job.budget?.maxToolCalls ?? null,
  };
}

function finishTraceData(job) {
  const finishedAt = job.finishedAt ?? Date.now();
  return {
    elapsed_ms: job.startedAt ? finishedAt - job.startedAt : 0,
    tool_call_count: job.toolCallCount ?? 0,
    prompt_elapsed_ms:
      job.promptStartedAt && job.promptEndedAt ? job.promptEndedAt - job.promptStartedAt : null,
  };
}

function normalizedFileList(files) {
  return [...new Set((files ?? []).map((file) => String(file).replaceAll("\\", "/")))].sort();
}

function sameFileList(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizeIsolation(descriptor = {}, env = process.env) {
  const explicit = descriptor.isolation ?? descriptor.isolation_mode;
  const requested = normalizePiSubagentsBackend(explicit ?? "");
  if (requested) return requested;
  return PI_SUBAGENTS_ISOLATION;
}

function assertSupportedIsolation(isolationOrDescriptor = {}) {
  const normalized =
    typeof isolationOrDescriptor === "string"
      ? isolationOrDescriptor
      : normalizeIsolation(isolationOrDescriptor);
  if (normalized === PI_SUBAGENTS_ISOLATION) return;
  throw new Error(
    `AIPI worker isolation ${normalized} is unsupported; ` +
      `current AIPI supports only the forked ${PI_SUBAGENTS_ISOLATION} runtime.`,
  );
}

function serializeWorkerJob(job) {
  return {
    agentId: job.agentId,
    descriptor: job.descriptor,
    budget: job.budget,
    modelResolution: job.modelResolution
      ? {
          requested: job.modelResolution.requested ?? null,
          resolved: job.modelResolution.resolved ?? null,
          fallback: job.modelResolution.fallback ?? false,
          source: job.modelResolution.source ?? null,
        }
      : null,
  };
}

function snapshotOwnedFiles(root, files = []) {
  const out = {};
  for (const file of normalizedFileList(files)) {
    const absPath = resolveProjectPath(root, file);
    if (!absPath) continue;
    try {
      const stat = fsSync.statSync(absPath);
      out[file] = { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      out[file] = { exists: false, mtimeMs: null, size: null };
    }
  }
  return out;
}

function verifyWorkerPassEvidence({ root, job, raw, stepResult }) {
  const exitCode = numericOrNull(raw?.exit_code ?? raw?.exitCode);
  if (exitCode != null && exitCode !== 0) {
    return {
      passed: false,
      reason: `child exit code was ${exitCode}`,
      exitCode,
      existingArtifacts: [],
      changedOwnedFiles: [],
    };
  }

  const artifactRefs = normalizedFileList([
    ...(Array.isArray(raw?.artifacts) ? raw.artifacts : []),
    ...(Array.isArray(stepResult?.artifacts) ? stepResult.artifacts : []),
  ]);
  const existingArtifacts = artifactRefs.filter((file) => pathExistsUnderRoot(root, file));
  const changedOwnedFiles = changedOwnedFilesSinceSnapshot(root, job.descriptor?.owned_files, job.ownedFileBaseline);
  const passed = existingArtifacts.length > 0 || changedOwnedFiles.length > 0;
  return {
    passed,
    reason: passed
      ? "PASS has real artifact or owned-file evidence"
      : "no named artifact exists under the project root and no owned file changed",
    exitCode,
    existingArtifacts,
    changedOwnedFiles,
  };
}

function downgradeWorkerPass(stepResult, evidence) {
  stepResult.verdict = "BLOCKED";
  stepResult.aipi_verdict_downgraded = true;
  stepResult.aipi_verdict_downgrade_reason = evidence.reason;
  stepResult.evidence = [
    ...(Array.isArray(stepResult.evidence) ? stepResult.evidence : []),
    {
      rung: "blocked",
      source: "aipi-subagent-coordinator",
      ref: "real-evidence-check",
      result: `PASS downgraded: ${evidence.reason}`,
    },
  ];
}

function changedOwnedFilesSinceSnapshot(root, files = [], baseline = {}) {
  const changed = [];
  for (const file of normalizedFileList(files)) {
    const absPath = resolveProjectPath(root, file);
    if (!absPath) continue;
    try {
      const stat = fsSync.statSync(absPath);
      const before = baseline?.[file] ?? { exists: false, mtimeMs: null, size: null };
      if (!before.exists || stat.mtimeMs !== before.mtimeMs || stat.size !== before.size) {
        changed.push(file);
      }
    } catch {
      /* missing owned files are not evidence of PASS */
    }
  }
  return changed;
}

function pathExistsUnderRoot(root, candidate) {
  const absPath = resolveProjectPath(root, candidate);
  if (!absPath) return false;
  try {
    fsSync.accessSync(absPath);
    return true;
  } catch {
    return false;
  }
}

function resolveProjectPath(root, candidate) {
  const value = String(candidate ?? "").trim();
  if (!value) return null;
  const absRoot = path.resolve(root);
  const absPath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(absRoot, value);
  const rel = path.relative(absRoot, absPath);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return absPath;
  return null;
}

function numericOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function withHostModel(descriptor = {}, hostModel = null) {
  const model = hostModel ?? descriptor.host_model ?? descriptor.hostModel ?? null;
  if (!model) return { ...descriptor };
  return {
    ...descriptor,
    host_model: model,
  };
}

function descriptorWithResolvedModel(descriptor = {}, modelResolution = null) {
  const {
    host_model: _hostModel,
    hostModel: _hostModelAlias,
    ...rest
  } = descriptor;
  const resolvedModel = modelResolution?.model ?? rest.model ?? null;
  const next = {
    ...rest,
    model_resolution_source: modelResolution?.source ?? rest.model_resolution_source,
  };
  if (resolvedModel) next.model = resolvedModel;
  else delete next.model;
  return next;
}

function withWorkerContextPacket(descriptor = {}, { root = process.cwd() } = {}) {
  const injected = buildWorkerContextAugmentation({ descriptor, root });
  if (!injected) return descriptor;
  return {
    ...descriptor,
    context_packet: [descriptor.context_packet?.trim(), injected].filter(Boolean).join("\n\n"),
  };
}

function buildWorkerContextAugmentation({ descriptor = {}, root = process.cwd() } = {}) {
  const graph = readGraphSummarySync(root);
  const blastSeeds = [
    ...(descriptor.owned_files ?? []),
    ...(descriptor.expected_artifacts ?? []),
    descriptor.artifact_target,
  ]
    .filter(Boolean)
    .map((item) => String(item).replaceAll("\\", "/"));
  return [
    "AIPI injected context:",
    "- memory_refs: .aipi/memory/project/business-rules.md, .aipi/memory/project/decisions.md, .aipi/memory/project/project.md",
    `- blast_radius_seeds: ${blastSeeds.length ? blastSeeds.join(", ") : "(none)"}`,
    `- code_graph: ${graph.status}; source=${graph.source ?? "unknown"}; built_at=${graph.built_at ?? "unknown"}`,
    "- use aipi_retrieve for fused semantic/lexical/graph/rule context before editing; use aipi_impact/aipi_callers for narrower follow-up.",
  ].join("\n");
}

async function buildWorkerRetrievalPrefetch({ descriptor = {}, root = process.cwd(), limit = 8 } = {}) {
  const graph = readGraphSummarySync(root);
  const query = workerRetrievalQuery(descriptor);
  const baseTrace = {
    source: "aipi_retrieve",
    query: query ? truncateText(query, 240) : null,
    graph_status: graph.status,
    graph_source: graph.source ?? null,
  };
  if (graph.status !== "available") {
    const payload = {
      schema: "aipi.worker-retrieval-prefetch.v1",
      source: "aipi_retrieve",
      status: "unavailable",
      reason: "AIPI code graph is missing; run /aipi-onboard or rebuild the graph before spawning workers.",
      graph,
      refs: [],
      relationships: [],
    };
    return {
      text: workerRetrievalPrefetchText(payload),
      trace: { ...baseTrace, status: payload.status, reason: payload.reason, ref_count: 0, relationship_count: 0 },
    };
  }
  if (!query) {
    const payload = {
      schema: "aipi.worker-retrieval-prefetch.v1",
      source: "aipi_retrieve",
      status: "skipped",
      reason: "No worker retrieval seeds were available.",
      graph,
      refs: [],
      relationships: [],
    };
    return {
      text: workerRetrievalPrefetchText(payload),
      trace: { ...baseTrace, status: payload.status, reason: payload.reason, ref_count: 0, relationship_count: 0 },
    };
  }

  try {
    const retrieval = await aipiRetrieve({ projectRoot: root, query, limit });
    const refs = compactWorkerRetrievalRefs(retrieval.refs, limit);
    const relationships = compactWorkerRetrievalRelationships(retrieval.relationships, limit * 2);
    const payload = {
      schema: "aipi.worker-retrieval-prefetch.v1",
      source: "aipi_retrieve",
      status: "available",
      query: truncateText(query, 600),
      graph: retrieval.graph ?? graph,
      fusion: retrieval.fusion ?? null,
      refs,
      relationships,
      provenance: "prefetched before worker prompt from aipi_retrieve using worker seeds",
    };
    return {
      text: workerRetrievalPrefetchText(payload),
      trace: {
        ...baseTrace,
        status: payload.status,
        ref_count: refs.length,
        relationship_count: relationships.length,
      },
    };
  } catch (error) {
    const payload = {
      schema: "aipi.worker-retrieval-prefetch.v1",
      source: "aipi_retrieve",
      status: "unavailable",
      reason: String(error?.message ?? error),
      graph,
      refs: [],
      relationships: [],
    };
    return {
      text: workerRetrievalPrefetchText(payload),
      trace: { ...baseTrace, status: payload.status, reason: payload.reason, ref_count: 0, relationship_count: 0 },
    };
  }
}

function workerRetrievalQuery(descriptor = {}) {
  const parts = [
    descriptor.task,
    descriptor.goal,
    descriptor.prompt,
    descriptor.context_packet,
    ...(descriptor.owned_files ?? []),
    ...(descriptor.expected_artifacts ?? []),
    descriptor.artifact_target,
  ]
    .filter(Boolean)
    .map((item) => String(item).replaceAll("\\", "/").trim())
    .filter(Boolean);
  return uniqueStrings(parts).join("\n").slice(0, 4000);
}

function workerRetrievalPrefetchText(payload) {
  return [
    "AIPI deterministic retrieval prefetch:",
    JSON.stringify(payload, null, 2),
    "AIPI follow-up hint: use aipi_impact or aipi_callers only when this prefetch leaves a narrower blast-radius question.",
  ].join("\n");
}

function compactWorkerRetrievalRefs(refs = [], limit = 8) {
  return (refs ?? []).slice(0, Math.max(1, limit)).map((ref) => ({
    path: ref.path ?? null,
    line: ref.line ?? ref.ref?.span?.start_line ?? null,
    source: ref.source ?? null,
    excerpt: truncateText(ref.excerpt ?? ref.text ?? "", 360),
    relationships: compactWorkerRetrievalRelationships(ref.relationships, 4),
    governing_rules: compactWorkerRetrievalRelationships(ref.governing_rules, 4),
  }));
}

function compactWorkerRetrievalRelationships(relationships = [], limit = 12) {
  return (relationships ?? []).slice(0, Math.max(1, limit)).map((edge) => ({
    source_kind: edge.source_kind ?? null,
    source_ref: edge.source_ref ?? null,
    relation: edge.relation ?? null,
    target_kind: edge.target_kind ?? null,
    target_ref: edge.target_ref ?? null,
    evidence: edge.evidence ?? null,
    source: edge.source ?? null,
  }));
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function readGraphSummarySync(root) {
  try {
    const graph = JSON.parse(fsSync.readFileSync(path.join(root, ".aipi", "state", "aipi-graph.json"), "utf8"));
    return {
      status: graph.schema === "aipi.code-graph.v1" ? "available" : "unknown-schema",
      source: graph.source ?? null,
      built_at: graph.built_at ?? null,
    };
  } catch {
    return { status: "missing", source: null, built_at: null };
  }
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function currentHostModelFromContext(ctx = {}) {
  return ctx?.model ??
    ctx?.current_model ??
    ctx?.currentModel ??
    ctx?.selected_model ??
    ctx?.selectedModel ??
    ctx?.payload?.model ??
    null;
}

export async function createWorkerProviderOptions(sdk, { cwd = process.cwd() } = {}) {
  const authStorage = createWorkerAuthStorage(sdk);
  const modelRegistry = createWorkerModelRegistry(sdk, authStorage);
  const resourceLoader = await createWorkerResourceLoader(sdk, { cwd });
  return {
    ...(authStorage ? { authStorage } : {}),
    ...(modelRegistry ? { modelRegistry } : {}),
    ...(resourceLoader ? { resourceLoader } : {}),
  };
}

function createWorkerAuthStorage(sdk) {
  if (typeof sdk?.AuthStorage?.create !== "function") return null;
  return sdk.AuthStorage.create();
}

function createWorkerModelRegistry(sdk, authStorage) {
  if (!authStorage) return null;
  if (typeof sdk?.ModelRegistry?.create === "function") {
    return sdk.ModelRegistry.create(authStorage);
  }
  if (typeof sdk?.ModelRegistry?.inMemory === "function") {
    return sdk.ModelRegistry.inMemory(authStorage);
  }
  return null;
}

async function createWorkerResourceLoader(sdk, { cwd }) {
  if (typeof sdk?.DefaultResourceLoader !== "function") return null;
  const loaderOptions = {
    cwd,
    additionalExtensionPaths: [AIPI_ANTHROPIC_OAUTH_EXTENSION_PATH],
  };
  if (typeof sdk.getAgentDir === "function") {
    loaderOptions.agentDir = sdk.getAgentDir();
  }
  const loader = new sdk.DefaultResourceLoader(loaderOptions);
  await Promise.resolve(loader.reload?.());
  return loader;
}

function isSubagentStateEntry(entry) {
  return entry?.customType === SUBAGENT_STATE_ENTRY ||
    entry?.name === SUBAGENT_STATE_ENTRY ||
    entry?.type === SUBAGENT_STATE_ENTRY;
}

// Register the stable AIPI tool surface. Orchestrator-only tools.
export function registerSubagentTools(pi, coordinator) {
  const idOnly = {
    type: "object",
    required: ["agent_id"],
    properties: { agent_id: { type: "string" } },
  };

  pi.registerTool({
    name: "aipi_spawn_agent",
    description:
      "Spawn an AIPI session worker with a context packet, model class, shared project root, and owned-file scope. Returns an agent_id.",
    parameters: {
      type: "object",
      required: ["agent_id"],
      properties: {
        agent_id: { type: "string", description: "Catalog id of a runtime: session agent." },
        model_class: {
          type: "string",
          description:
            "Capability class from .aipi/model-classes.yaml (e.g. code-strong). Unknown classes are rejected unless allow_fallback is true.",
        },
        allow_fallback: {
          type: "boolean",
          description:
            "Defaults to true. Set false to fail loud when model_class is unknown or unbound instead of using the current host model. Host fallback is surfaced via model_resolved + model_fallback on status and step_result.",
        },
        context_packet: { type: "string", description: "BDD-scoped context excerpts." },
        owned_files: { type: "array", items: { type: "string" } },
        artifact_target: { type: "string" },
        budget: { type: "object" },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return jsonResult(coordinator.spawn(withHostModel(params, currentHostModelFromContext(ctx))));
    },
  });

  pi.registerTool({
    name: "aipi_agent_status",
    description: "Return live state, elapsed time, and last summary for a spawned agent.",
    parameters: idOnly,
    async execute(_id, params) {
      return jsonResult(coordinator.status(params.agent_id));
    },
  });

  pi.registerTool({
    name: "aipi_collect_agent",
    description:
      "Collect a finished worker's aipi.step-result.v1 and artifact pointers. Does not write durable memory.",
    parameters: idOnly,
    async execute(_id, params) {
      return jsonResult(coordinator.collect(params.agent_id));
    },
  });

  pi.registerTool({
    name: "aipi_cancel_agent",
    description: "Abort a worker and return its owned files for reassignment.",
    parameters: idOnly,
    async execute(_id, params) {
      return jsonResult(coordinator.cancel(params.agent_id));
    },
  });

  pi.registerTool({
    name: "aipi_cleanup_agents",
    description:
      "Apply subagent retention cleanup for finished workers. Releases owned-file allocations and never deletes durable memory.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      return jsonResult(coordinator.cleanup());
    },
  });

  pi.registerTool({
    name: "aipi_steer_agent",
    description:
      "Send a bounded follow-up to a running worker when the workflow permits changing its assignment.",
    parameters: {
      type: "object",
      required: ["agent_id", "message"],
      properties: { agent_id: { type: "string" }, message: { type: "string" } },
    },
    async execute(_id, params) {
      return jsonResult(coordinator.steer(params.agent_id, params.message));
    },
  });
}

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
