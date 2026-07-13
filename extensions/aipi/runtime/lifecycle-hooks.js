import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BLOCKER_FREE_TEXT_OPTION,
  formatAwaitingUserInputPrompt,
  normalizeBlockerOptions,
} from "./blocker-input.js";
import {
  closeWorkflowRun,
  formatWorkflowCommandResult,
  readActiveRun,
  recordWorkflowUserInput,
  runWorkflowCommand,
} from "./run-state.js";
import { latestSubagentStateFromEntries } from "./subagents.js";
import {
  createSubagentWorkflowAdapter,
  isWorkflowBlockedDecisionOptions,
  parseWorkflowDefinition,
  WORKFLOW_BLOCKED_DECISION_KIND,
} from "./workflow-executor.js";
import { describeModel, resolveModelClass, resolveStepModel } from "./model-router.js";
import { aipiHostModelReadiness, modelProvider } from "./pi-subagents.js";
import { buildBlockedRunSupervisor } from "./workflow-supervisor.js";
import { normalizeExecutionCadence, readActivePlan } from "./plan-state.js";
import { redactSecrets } from "./redact.js";
import { appendRotatedJsonlLine } from "./runtime-log.js";

const LIFECYCLE_LOG = ".aipi/runtime/lifecycle.jsonl";
const TOOL_RESULT_LOG = ".aipi/runtime/tool-results.jsonl";
const PROVIDER_EVENT_LOG = ".aipi/runtime/provider-events.jsonl";
const PROVIDER_USAGE_LOG = ".aipi/runtime/provider-usage.jsonl";
const PROVIDER_BUDGET_LOG = ".aipi/runtime/provider-budget.jsonl";
const MODEL_ROUTING_LOG = ".aipi/runtime/model-routing.jsonl";
const CODE_PIPELINE_LOG = ".aipi/runtime/code-pipeline.jsonl";
const RUNTIME_ERROR_LOG = ".aipi/runtime/errors.jsonl";
const UNSUPPORTED_HOST_LOG = ".aipi/runtime/unsupported-host.jsonl";
const PROVIDER_PRICING_REL_PATH = ".aipi/provider-pricing.json";
const PROVIDER_BUDGET_REL_PATH = ".aipi/provider-budget.json";
const CONTEXT_EVENT_LOG = ".aipi/runtime/context-events.jsonl";
const DISCIPLINE_AUDIT_LOG = ".aipi/runtime/discipline-audit.jsonl";
const AGENT_CATALOG_REL_PATH = ".aipi/agents/catalog.yaml";
const DISCIPLINE_CATALOG_REL_PATH = ".aipi/disciplines/catalog.yaml";

const BUG_ROOT_CAUSE_PIPELINE_STAGES = [
  "reproduce",
  "root_cause_hypotheses",
  "verify_hypotheses",
  "confirm_root_cause",
  "fix_plan",
  "implement_fix",
  "regression_verify",
  "cross_model_review",
];

const DEPLOY_PRECHECK_PIPELINE_STAGES = [
  "classify_boundary",
  "risk_blast_radius",
  "rollback_readiness",
  "evidence_check",
  "confirm_before_execute",
  "execute_after_confirm",
  "post_deploy_verify",
];
const MAX_EXCERPT_CHARS = 1000;
const MAX_CONTEXT_TOOL_RESULT_CHARS = 1200;
const KEEP_FULL_AIPI_TOOL_RESULTS = 2;
const MAX_DISCIPLINE_CHARS = 1800;

export function registerAipiLifecycleHooks(pi, {
  projectRootResolver = (ctx) => ctx?.cwd ?? process.cwd(),
  coordinator = null,
  workflowCommandRunner = runWorkflowCommand,
  userInputRecorder = recordWorkflowUserInput,
  intentClassifier = null,
  intentClassifierTimeoutMs = 1500,
} = {}) {
  const handlers = createAipiLifecycleHandlers({
    pi,
    projectRootResolver,
    coordinator,
    workflowCommandRunner,
    userInputRecorder,
    intentClassifier,
    intentClassifierTimeoutMs,
  });
  for (const [eventName, handler] of Object.entries(handlers)) {
    pi.on?.(eventName, handler);
  }
  return handlers;
}

export function createAipiLifecycleHandlers({
  pi = null,
  projectRootResolver = (ctx) => ctx?.cwd ?? process.cwd(),
  coordinator = null,
  workflowCommandRunner = runWorkflowCommand,
  userInputRecorder = recordWorkflowUserInput,
  intentClassifier = null,
  intentClassifierTimeoutMs = 1500,
} = {}) {
  const rootFor = (ctx, event) => path.resolve(projectRootResolver(ctx, event) ?? process.cwd());
  const handlers = {
    session_start: async (event, ctx) => handleSessionStart({
      event,
      ctx,
      pi,
      projectRoot: rootFor(ctx, event),
      coordinator,
    }),
    session_shutdown: async (event, ctx) => {
      const projectRoot = rootFor(ctx, event);
      const persisted = await saveSubagentCoordinatorState({ coordinator, projectRoot }).catch(() => null);
      return recordLifecycleEvent({
        projectRoot,
        hook: "session_shutdown",
        event: {
          ...compactEvent(event),
          subagent_state_persisted: persisted?.persisted ?? false,
          subagent_state_jobs: persisted?.jobs ?? 0,
        },
      });
    },
    before_agent_start: async (event, ctx) => handleBeforeAgentStart({
      event,
      ctx,
      pi,
      projectRoot: rootFor(ctx, event),
      coordinator,
    }),
    session_before_switch: async (event, ctx) => {
      await writeRunHandoffSnapshot({
        projectRoot: rootFor(ctx, event),
        hook: "session_before_switch",
        event: compactEvent(event),
        pi,
      });
      return undefined;
    },
    session_before_fork: async (event, ctx) => {
      await writeRunHandoffSnapshot({
        projectRoot: rootFor(ctx, event),
        hook: "session_before_fork",
        event: compactEvent(event),
        pi,
      });
      return undefined;
    },
    session_before_compact: async (event, ctx) => {
      const handoff = await writeRunHandoffSnapshot({
        projectRoot: rootFor(ctx, event),
        hook: "session_before_compact",
        event: {
          customInstructions: event?.customInstructions ?? null,
          firstKeptEntryId: event?.preparation?.firstKeptEntryId ?? null,
          tokensBefore: event?.preparation?.tokensBefore ?? null,
        },
        pi,
      });
      if (!handoff?.snapshot?.active || !event?.preparation?.firstKeptEntryId) return undefined;
      return {
        compaction: buildAipiCompactionResult({
          snapshot: handoff.snapshot,
          handoffPath: handoff.path,
          preparation: event?.preparation,
        }),
      };
    },
    session_before_tree: async (event, ctx) => handleBeforeTree({ event, pi, projectRoot: rootFor(ctx, event) }),
    session_compact: async (event, ctx) => recordLifecycleEvent({
      projectRoot: rootFor(ctx, event),
      hook: "session_compact",
      event: {
        fromExtension: Boolean(event?.fromExtension),
        compactionEntryId: event?.compactionEntry?.id ?? null,
      },
    }),
    session_tree: async (event, ctx) => recordLifecycleEvent({
      projectRoot: rootFor(ctx, event),
      hook: "session_tree",
      event: compactEvent(event),
    }),
    input: async (event, ctx) => handleInput({
      event,
      ctx,
      pi,
      projectRoot: rootFor(ctx, event),
      coordinator,
      workflowCommandRunner,
      userInputRecorder,
      intentClassifier,
      intentClassifierTimeoutMs,
    }),
    context: async (event, ctx) => handleContext({ event, projectRoot: rootFor(ctx, event) }),
    tool_call: async (event, ctx) =>
      handleDisciplineHook({ event, ctx, pi, projectRoot: rootFor(ctx, event), hook: "tool_call" }),
    agent_end: async (event, ctx) =>
      handleEndDisciplineAudit({ event, ctx, pi, projectRoot: rootFor(ctx, event), hook: "agent_end" }),
    turn_end: async (event, ctx) =>
      handleEndDisciplineAudit({ event, ctx, pi, projectRoot: rootFor(ctx, event), hook: "turn_end" }),
    message_end: async (event, ctx) => {
      const projectRoot = rootFor(ctx, event);
      // Usage lives on the finalized assistant message — the provider HTTP hook
      // only sees status+headers on streamed requests. Capture is best-effort
      // and must never affect the audit result contract.
      await recordProviderUsageFromMessageEnd({ event, ctx, projectRoot }).catch(() => null);
      return handleEndDisciplineAudit({ event, ctx, pi, projectRoot, hook: "message_end" });
    },
    model_select: async (event, ctx) => handleModelSelect({
      event,
      ctx,
      pi,
      projectRoot: rootFor(ctx, event),
      coordinator,
    }),
    thinking_level_select: async (event, ctx) =>
      handleThinkingLevelSelect({ event, ctx, pi, projectRoot: rootFor(ctx, event) }),
    user_bash: async (event, ctx) => handleUserBash({ event, ctx, pi, projectRoot: rootFor(ctx, event) }),
    tool_result: async (event, ctx) => handleToolResult({ event, projectRoot: rootFor(ctx, event) }),
    before_provider_request: async (event, ctx) => handleBeforeProviderRequest({ event, projectRoot: rootFor(ctx, event) }),
    after_provider_response: async (event, ctx) => handleAfterProviderResponse({ event, projectRoot: rootFor(ctx, event) }),
  };
  return wrapLifecycleHandlers(handlers, { rootFor, pi });
}

function wrapLifecycleHandlers(handlers, { rootFor, pi } = {}) {
  return Object.fromEntries(Object.entries(handlers).map(([hook, handler]) => [
    hook,
    async (event, ctx) => {
      const heartbeatRoot = isTruthyFlag(process.env.AIPI_STALL_DISABLE) ? null : safeProjectRoot(rootFor, ctx, event);
      // Stall heartbeat: ANY hook firing means the host turn is making progress, so touch the per-project
      // heartbeat. When NO hook fires for a while (a silent/hung model send shows up as a mute "working…"),
      // the heartbeat's own timer surfaces how long it has been idle — and whether it's waiting on a model
      // response vs stalled before even sending — so a hang stops being invisible. Best-effort, never throws.
      if (heartbeatRoot) {
        try { updateStallHeartbeat({ hook, ctx, projectRoot: heartbeatRoot }); } catch { /* heartbeat is advisory */ }
      }
      try {
        return await handler(event, ctx);
      } catch (error) {
        const projectRoot = safeProjectRoot(rootFor, ctx, event);
        if (projectRoot) {
          const entry = await recordRuntimeError({
            projectRoot,
            hook,
            event,
            error,
          }).catch(() => null);
          if (entry) safeAppendEntry(pi, "aipi.runtime.error", entry);
        }
        safeNotify(ctx, `AIPI ${hook} failed: ${error.message}`, "error");
        throw error;
      }
    },
  ]));
}

function safeProjectRoot(rootFor, ctx, event) {
  try {
    return path.resolve(rootFor(ctx, event) ?? process.cwd());
  } catch {
    return null;
  }
}

// ── Stall heartbeat ───────────────────────────────────────────────────────────────────────────────────
// A turn can go silent for minutes — most painfully when a model request hangs at the network/SDK level
// BEFORE it is even dispatched (no before_provider_request fires, so nothing logs and the host shows a mute
// "working…"). aipi can't abort the host's own model call, but it CAN make the silence VISIBLE: a per-project
// heartbeat is touched by every lifecycle hook, and its own unref'd timer (which keeps firing on the event
// loop during a hung await) surfaces how long the turn has been idle once that crosses a threshold — and
// whether it is waiting on a model RESPONSE (request sent) or stalled BEFORE sending. The user then knows to
// wait or to cancel+resend instead of staring at an opaque spinner.
const STALL_STATUS_KEY = "aipi.stall.heartbeat";
const STALL_CHECK_MS = 10_000;
const DEFAULT_STALL_SOFT_MS = 45_000;
const DEFAULT_STALL_HARD_MS = 150_000;

const MIN_STALL_THRESHOLD_MS = 5_000; // a sub-5s threshold would surface on every normal pause — floor it
function stallThresholds(env = process.env) {
  const soft = Number.parseInt(env?.AIPI_STALL_SOFT_MS ?? "", 10);
  const hard = Number.parseInt(env?.AIPI_STALL_HARD_MS ?? "", 10);
  const softMs = Number.isFinite(soft) && soft >= MIN_STALL_THRESHOLD_MS ? soft : DEFAULT_STALL_SOFT_MS;
  const hardMs = Number.isFinite(hard) && hard >= MIN_STALL_THRESHOLD_MS ? hard : DEFAULT_STALL_HARD_MS;
  return { softMs, hardMs: Math.max(hardMs, softMs) };
}

// Pure formatter (testable): the status line for an idle turn, or null when still within the soft window.
export function formatStallStatus({ idleMs, pendingModelMs = null, softMs, hardMs }) {
  if (!Number.isFinite(idleMs) || idleMs < softMs) return null;
  // A request IS in flight: a long model generation is perfectly normal — inform with how long it's been,
  // but NEVER tell the user to cancel (a healthy multi-minute response would otherwise trip a false
  // "travado; Esc"). Count from when the request was sent.
  if (Number.isFinite(pendingModelMs)) {
    return `⏳ AIPI: esperando resposta do modelo há ${Math.round(pendingModelMs / 1000)}s`;
  }
  // No request in flight — the turn has gone idle BEFORE sending to the model. THIS is the suspicious hang (a
  // silent send-stall), so past the hard threshold suggest cancel+resend.
  const idleS = Math.round(idleMs / 1000);
  const tail = idleMs >= hardMs ? " — pode estar travado; Esc para cancelar e reenviar" : "";
  return `⏳ AIPI: sem atividade (antes de chamar o modelo) há ${idleS}s`.concat(tail);
}

export class StallHeartbeat {
  constructor({ env = process.env } = {}) {
    const { softMs, hardMs } = stallThresholds(env);
    this.softMs = softMs;
    this.hardMs = hardMs;
    this.ui = null;
    this.timer = null;
    this.armed = false;
    this.surfaced = false;
    this.lastActivityAt = 0;
    this.pendingModelSince = null;
  }

  arm(ctx, now = Date.now()) {
    if (typeof ctx?.ui?.setStatus !== "function") return; // only animate where there is an updatable status line
    this.ui = ctx.ui;
    this.lastActivityAt = now;
    this.pendingModelSince = null;
    this.armed = true;
    this.#startTimer();
  }

  touch(now = Date.now()) {
    this.lastActivityAt = now;
    this.#clearIfSurfaced();
  }

  modelRequestStarted(now = Date.now()) {
    this.pendingModelSince = now;
    this.touch(now);
  }

  modelResponded(now = Date.now()) {
    this.pendingModelSince = null;
    this.touch(now);
  }

  disarm() {
    this.armed = false;
    this.#stopTimer();
    this.#clearStatus();
    this.surfaced = false;
    this.pendingModelSince = null;
  }

  // Exposed for the timer and for tests (drive it with a controlled clock instead of real time).
  tick(now = Date.now()) {
    if (!this.armed) return;
    const pendingModelMs = this.pendingModelSince != null ? now - this.pendingModelSince : null;
    const status = formatStallStatus({
      idleMs: now - this.lastActivityAt,
      pendingModelMs,
      softMs: this.softMs,
      hardMs: this.hardMs,
    });
    if (status) {
      this.#setStatus(status);
      this.surfaced = true;
    } else {
      this.#clearIfSurfaced();
    }
  }

  #startTimer() {
    this.#stopTimer();
    this.timer = setInterval(() => {
      try { this.tick(); } catch { /* advisory */ }
    }, STALL_CHECK_MS);
    if (typeof this.timer?.unref === "function") this.timer.unref(); // never keep the process alive
  }

  #stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  #clearIfSurfaced() {
    if (this.surfaced) {
      this.#clearStatus();
      this.surfaced = false;
    }
  }

  #setStatus(text) {
    try { this.ui?.setStatus?.(STALL_STATUS_KEY, text); } catch { /* best-effort UI */ }
  }

  #clearStatus() {
    try { this.ui?.setStatus?.(STALL_STATUS_KEY, undefined); } catch { /* best-effort UI */ }
  }
}

const stallHeartbeats = new Map(); // projectRoot -> StallHeartbeat

export function getStallHeartbeat(projectRoot) {
  let hb = stallHeartbeats.get(projectRoot);
  if (!hb) {
    hb = new StallHeartbeat();
    stallHeartbeats.set(projectRoot, hb);
  }
  return hb;
}

// Cheap, cached "is this an AIPI project" check so the heartbeat never arms in a non-AIPI repo where the
// extension merely happens to be loaded (RS-3). Positives are cached permanently; a negative is re-checked
// (an existsSync stat is microseconds) so a freshly-onboarded project is picked up. fsSync mirrors the async
// isAipiInstalled contract (.aipi/runtime-contract.json) without an await on every hook.
const aipiProjectCache = new Map();
export function looksLikeAipiProject(projectRoot) {
  if (aipiProjectCache.get(projectRoot) === true) return true;
  let installed = false;
  try {
    installed = fsSync.existsSync(path.join(projectRoot, ".aipi", "runtime-contract.json"));
  } catch {
    installed = false;
  }
  if (installed) aipiProjectCache.set(projectRoot, true);
  return installed;
}

export function updateStallHeartbeat({ hook, ctx, projectRoot }) {
  if (!looksLikeAipiProject(projectRoot)) return; // RS-3: don't run the heartbeat in non-AIPI projects
  const hb = getStallHeartbeat(projectRoot);
  switch (hook) {
    case "before_agent_start":
      hb.arm(ctx);
      break;
    // Disarm only at the END OF THE WHOLE PROMPT (agent_end) — NOT turn_end. The host fires turn_end at the
    // end of EACH agent-loop turn (model call + tool round), many times per prompt; disarming there killed the
    // heartbeat after the first turn, so a stall on any later turn's model send went unwatched — defeating the
    // whole feature (FF-1). turn_end falls through to touch: a completed turn is activity; keep watching.
    case "agent_end":
    case "session_shutdown":
      hb.disarm();
      break;
    case "before_provider_request":
      hb.modelRequestStarted();
      break;
    case "after_provider_response":
      hb.modelResponded();
      break;
    default:
      hb.touch();
  }
}

export async function handleSessionStart({ event, ctx, pi, projectRoot, coordinator = null }) {
  const snapshot = await buildRunSnapshot(projectRoot);
  const hostModel = await captureCoordinatorHostModel({
    coordinator,
    event,
    ctx,
    source: "session_start",
  });
  const subagents = await restoreSubagentCoordinatorFromSession({ coordinator, ctx, pi, projectRoot });
  await recordLifecycleEvent({
    projectRoot,
    hook: "session_start",
    event: {
      ...compactEvent(event),
      subagents,
      host_model: hostModel?.model_id ?? null,
    },
    snapshot,
  });
  if (!snapshot.active) return undefined;

  safeAppendEntry(pi, "aipi.run.session", {
    schema: "aipi.run-session-marker.v1",
    hook: "session_start",
    reason: event?.reason ?? "unknown",
    ...snapshot,
  });
  safeSetSessionName(pi, `AIPI ${snapshot.workflow} ${snapshot.run_id.slice(0, 18)}`);
  return undefined;
}

// Session-transcript entries do not survive into a new session's manager, so a
// transcript-only persist can never be restored after a restart. The shutdown
// hook mirrors the coordinator snapshot to this file; session_start falls back
// to it when the transcript has no state.
const SUBAGENT_COORDINATOR_STATE_REL_PATH = ".aipi/runtime/subagents-coordinator-state.json";

export async function saveSubagentCoordinatorState({ coordinator = null, projectRoot } = {}) {
  if (!projectRoot || typeof coordinator?.snapshot !== "function") {
    return { persisted: false, reason: "no coordinator snapshot" };
  }
  const statePath = path.join(projectRoot, SUBAGENT_COORDINATOR_STATE_REL_PATH);
  const state = coordinator.snapshot();
  const jobs = Array.isArray(state?.jobs) ? state.jobs.length : 0;
  if (!jobs) {
    // Nothing to restore — remove any stale file so a later restore can't
    // resurrect state from a previous, unrelated session.
    await fs.rm(statePath, { force: true }).catch(() => null);
    return { persisted: false, reason: "no jobs", jobs: 0 };
  }
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({ saved_at: new Date().toISOString(), ...state }, null, 2)}\n`);
  return { persisted: true, jobs, path: SUBAGENT_COORDINATOR_STATE_REL_PATH };
}

export async function restoreSubagentCoordinatorFromSession({ coordinator = null, ctx = {}, pi = null, projectRoot = null } = {}) {
  if (!coordinator?.restore) {
    return { restored: false, reason: "no coordinator" };
  }

  const entries = await readSessionEntries(ctx);
  let state = latestSubagentStateFromEntries(entries);
  let source = "session";
  let diskLoadError = null;
  const statePath = projectRoot ? path.join(projectRoot, SUBAGENT_COORDINATOR_STATE_REL_PATH) : null;
  if (!state && statePath) {
    try {
      state = JSON.parse(await fs.readFile(statePath, "utf8"));
      source = "disk";
    } catch (error) {
      state = null;
      if (error?.code !== "ENOENT") diskLoadError = String(error?.message ?? error);
    }
  }
  if (!state) {
    return diskLoadError
      ? { restored: false, reason: "disk_load_failed", error: diskLoadError }
      : { restored: false, reason: "no_state_existed" };
  }

  try {
    const summary = coordinator.restore(state);
    const entry = {
      schema: "aipi.subagents.restore.v1",
      restored_at: new Date().toISOString(),
      source,
      ...(summary ?? { restored: false, reason: "empty summary" }),
    };
    safeAppendEntry(pi, "aipi.subagents.restore", entry);
    if (source === "disk" && entry.restored !== false && statePath) {
      // Consume the snapshot so a second restart cannot re-apply stale state.
      await fs.rm(statePath, { force: true }).catch(() => null);
    }
    return entry;
  } catch (error) {
    const entry = {
      schema: "aipi.subagents.restore.v1",
      restored_at: new Date().toISOString(),
      source,
      restored: false,
      reason: "restore_failed",
      error: String(error?.message ?? error),
    };
    safeAppendEntry(pi, "aipi.subagents.restore", entry);
    return entry;
  }
}

export async function handleInput({
  event,
  ctx,
  pi,
  projectRoot,
  coordinator = null,
  workflowCommandRunner = runWorkflowCommand,
  userInputRecorder = recordWorkflowUserInput,
  intentClassifier = null,
  intentClassifierTimeoutMs = 1500,
} = {}) {
  if (routingDisabled(event, ctx)) return { action: "continue" };
  if (!(await isAipiInstalled(projectRoot))) return { action: "continue" };
  // keepBlockedDecision: handleInput owns the EXPLICIT auto-detach of a workflow-blocked-decision
  // run (notify + audit + abandon, see the auto-detach branch below). Let it see that run rather
  // than have readActiveRun silently auto-clear it from under us (CR-59-2 central recovery still
  // covers every OTHER hook that consults the active run).
  const active = await readActiveRun(projectRoot, { keepBlockedDecision: true }).catch(() => null);
  const codePipeline = classifyAipiCodePipeline(event?.text ?? "", { activeRun: active, projectRoot });
  const hostBlock = await blockUnsupportedHostTurn({
    hook: "input",
    event,
    ctx,
    pi,
    projectRoot,
    coordinator,
    activeRun: active,
    codePipeline,
  });
  if (hostBlock) return hostBlock;
  // Multi-task mode (opt-in via AIPI_MULTI_TASK; default off). A CLEAR batch of tasks with no run/plan in
  // flight is offered to the plan pre-flight surface (/aipi-plan) instead of being treated as one task.
  // Non-destructive: it suggests, it does not hijack the turn, so single-task behavior is unchanged.
  if (
    aipiMultiTaskEnabled() &&
    !isContinuableActiveRun(active) &&
    !isAwaitingUserInput(active) &&
    !(await hasActivePlan(projectRoot))
  ) {
    const batch = detectTaskBatch(event?.text ?? "");
    if (batch.length >= 2) {
      safeAppendEntry(pi, "aipi.input.route", {
        schema: "aipi.input-route.v1",
        routed_at: new Date().toISOString(),
        input: "suggest_plan",
        task_count: batch.length,
        active_run_id: active?.runId ?? null,
        result_action: "continue",
        reason: "multi_task_batch",
      });
      safeNotify(ctx, formatPlanSuggestion(batch), "info");
      return { action: "continue" };
    }
  }
  let route = classifyAipiInputRoute(event?.text ?? "", { activeRun: active, codePipeline, autoDispatchEnabled: aipiAutoDispatchEnabled() });
  const classifier = await applyAutoDispatchVeto({
    text: event?.text ?? "",
    route,
    codePipeline,
    activeRun: active,
    projectRoot,
    ctx,
    intentClassifier,
    timeoutMs: intentClassifierTimeoutMs,
  });
  route = classifier.route;
  if (routeExecutesWorkflow(route)) {
    const hostReadiness = await resolveAipiHostInputReadiness({ event, ctx, coordinator });
    if (!hostReadiness.ok) {
      if (codePipeline.trace) {
        await recordCodePipelineTrace({
          projectRoot,
          pi,
          activeRun: active,
          pipeline: codePipelineWithDispatch({
            pipeline: codePipeline,
            route,
            skipped: "unsupported_host_model",
          }),
        }).catch(() => null);
      }
      safeAppendEntry(pi, "aipi.input.route", {
        schema: "aipi.input-route.v1",
        routed_at: new Date().toISOString(),
        input: route.intent,
        workflow_args: route.workflowArgs ?? null,
        workflow: route.workflowSuggestion ?? null,
        auto_dispatch: false,
        pipeline_classification: route.pipelineClassification ?? null,
        classifier_source: classifier.source,
        classifier_verdict: classifier.verdict ?? null,
        classifier_reason: classifier.reason ?? null,
        recorded_user_input: false,
        active_run_id: active?.runId ?? null,
        result_action: "continue",
        reason: "unsupported_host_model",
        host_model: hostReadiness.model_id,
        host_provider: hostReadiness.provider,
        readiness: hostReadiness,
      });
      safeNotify(ctx, hostReadiness.message, "error");
      return { action: "continue" };
    }
  }
  if (codePipeline.trace && !route?.autoDispatch) {
    // A classifier that decided auto_dispatch_workflow while auto-dispatch is
    // disabled must say so — dispatch:null in the trace is indistinguishable
    // from a dispatch that silently failed to launch.
    const pipelineForTrace = codePipeline.default_action === "auto_dispatch_workflow"
      ? codePipelineWithDispatch({ pipeline: codePipeline, route: route ?? {}, skipped: "auto_dispatch_disabled" })
      : codePipeline;
    await recordCodePipelineTrace({ projectRoot, pi, activeRun: active, pipeline: pipelineForTrace }).catch(() => null);
  }

  const adapter = buildExecutableWorkflowAdapter({ coordinator, ctx });

  if (route?.autoDispatch && !adapter) {
    const fallbackCommand = route.suggestedCommand ?? `/aipi-workflow ${route.workflowArgs}`;
    const message = formatWorkflowSuggestion(route.workflowSuggestion, fallbackCommand);
    if (codePipeline.trace) {
      await recordCodePipelineTrace({
        projectRoot,
        pi,
        activeRun: active,
        pipeline: codePipelineWithDispatch({
          pipeline: {
            ...codePipeline,
            default_action: "suggest_workflow",
          },
          route: {
            ...route,
            workflowArgs: fallbackCommand,
          },
          skipped: "no_executable_adapter",
        }),
      }).catch(() => null);
    }
    safeAppendEntry(pi, "aipi.input.route", {
      schema: "aipi.input-route.v1",
      routed_at: new Date().toISOString(),
      input: route.intent,
      workflow_suggestion: route.workflowSuggestion,
      suggested_command: fallbackCommand,
      auto_dispatch: false,
      pipeline_classification: route.pipelineClassification ?? null,
      classifier_source: classifier.source,
      classifier_verdict: classifier.verdict ?? null,
      classifier_reason: classifier.reason ?? null,
      recorded_user_input: false,
      active_run_id: active?.runId ?? null,
      result_action: "continue",
      reason: "no_executable_adapter",
    });
    safeNotify(ctx, message, "info");
    return { action: "continue" };
  }

  if (!route) {
    if (classifier.vetoed) {
      safeAppendEntry(pi, "aipi.input.route", {
        schema: "aipi.input-route.v1",
        routed_at: new Date().toISOString(),
        input: "auto_dispatch_vetoed",
        original_intent: classifier.originalRoute?.intent ?? null,
        workflow_args: classifier.originalRoute?.workflowArgs ?? null,
        workflow: classifier.originalRoute?.workflowSuggestion ?? null,
        auto_dispatch: false,
        pipeline_classification: classifier.originalRoute?.pipelineClassification ?? codePipeline.classification ?? null,
        classifier_source: classifier.source,
        classifier_verdict: classifier.verdict ?? null,
        classifier_reason: classifier.reason ?? null,
        active_run_id: active?.runId ?? null,
        result_action: "continue",
      });
    }
    if (isAwaitingUserInput(active)) {
      const terminalAction = blockerTerminalAction(event?.text);
      if (terminalAction) {
        return applyBlockedRunTerminalAction({
          ctx,
          pi,
          projectRoot,
          active,
          answer: event?.text,
          terminalAction,
          source: event?.source ?? "blocked_text",
        });
      }
      // ADV-58-1: a dead-end run blocked on the freestyle/retry/cancel meta-decision must
      // self-recover. A NEW substantive message (not a picker selection) means the user
      // moved on, so auto-detach (abandon + clear runs/active) and reprocess the input as a
      // FRESH turn. The user must NEVER be trapped re-prompted across sessions.
      if (isWorkflowBlockedDecisionRun(active) && isFreshSubstantiveBlockedInput(event?.text)) {
        await applyBlockedRunTerminalAction({
          ctx,
          pi,
          projectRoot,
          active,
          answer: event?.text,
          terminalAction: {
            status: "abandoned",
            code: "blocked_run_auto_detached",
            message:
              "AIPI destacou o run bloqueado automaticamente; tratando sua nova mensagem fora do workflow automatico.",
          },
          source: event?.source ?? "blocked_auto_detach",
        });
        // Reprocess as a fresh turn now that runs/active is cleared.
        return handleInput({
          event,
          ctx,
          pi,
          projectRoot,
          coordinator,
          workflowCommandRunner,
          userInputRecorder,
          intentClassifier,
          intentClassifierTimeoutMs,
        });
      }
      safeAppendEntry(pi, "aipi.input.route", {
        schema: "aipi.input-route.v1",
        routed_at: new Date().toISOString(),
        input: "blocked_text_prompt",
        active_run_id: active?.runId ?? null,
        handled: false,
        reason: "plain_text_not_captured",
      });
      safeNotify(ctx, formatAwaitingUserInputPrompt(active.state.awaiting_user_input), "info");
      return { action: "continue" };
    }
    return { action: "continue" };
  }

  try {
    if (route.answerInline) {
      const details = buildReadOnlyCheckDetails({ text: event?.text ?? "", route, codePipeline, activeRun: active });
      safeAppendEntry(pi, "aipi.input.route", {
        schema: "aipi.input-route.v1",
        routed_at: new Date().toISOString(),
        input: route.intent,
        workflow: route.workflowSuggestion ?? null,
        auto_dispatch: false,
        answer_inline: true,
        read_only: true,
        pipeline_classification: route.pipelineClassification ?? null,
        classifier_source: classifier.source,
        classifier_verdict: classifier.verdict ?? null,
        classifier_reason: classifier.reason ?? null,
        active_run_id: active?.runId ?? null,
        result_action: "continue",
        grounding_tools: details.grounding_tools,
      });
      return {
        action: "continue",
        message: {
          customType: "aipi.read-only-check",
          display: false,
          content: renderReadOnlyCheckHint(details),
          details,
        },
      };
    }
    if (route.suggestedCommand) {
      const message = formatWorkflowSuggestion(route.workflowSuggestion, route.suggestedCommand);
      safeAppendEntry(pi, "aipi.input.route", {
        schema: "aipi.input-route.v1",
        routed_at: new Date().toISOString(),
        input: route.intent,
        workflow_suggestion: route.workflowSuggestion,
        suggested_command: route.suggestedCommand,
        classifier_source: classifier.source,
        classifier_verdict: classifier.verdict ?? null,
        classifier_reason: classifier.reason ?? null,
        recorded_user_input: false,
        active_run_id: active?.runId ?? null,
        result_action: "continue",
      });
      safeNotify(ctx, message, "info");
      return { action: "continue" };
    }
    let recordedUserInput = false;
    if (route.recordUserInput) {
      await userInputRecorder({
        projectRoot,
        runId: active?.runId,
        text: event?.text ?? "",
        source: event?.source ?? "input",
      });
      recordedUserInput = true;
    }
    const result = await workflowCommandRunner({
      args: route.workflowArgs,
      projectRoot,
      adapter,
      parentInteractiveToolCallHook: "registered_parent_interactive_tool_call_hook",
      notify: makeProgressNotifier(ctx, pi),
      params: buildWorkflowParams(route, event),
    });
    const blockedAfterCommand = activeRunFromWorkflowCommandResult(result);
    if (route.recordInputAfterDispatch && blockedAfterCommand?.runId) {
      await userInputRecorder({
        projectRoot,
        runId: blockedAfterCommand.runId,
        text: event?.text ?? "",
        source: event?.source ?? "input",
      });
      recordedUserInput = true;
    }
    if (codePipeline.trace && route.autoDispatch) {
      await recordCodePipelineTrace({
        projectRoot,
        pi,
        activeRun: active,
        pipeline: codePipelineWithDispatch({ pipeline: codePipeline, route, result }),
      }).catch(() => null);
    }
    const entry = {
      schema: "aipi.input-route.v1",
      routed_at: new Date().toISOString(),
      input: route.intent,
      workflow_args: route.workflowArgs,
      workflow: route.workflowSuggestion ?? null,
      auto_dispatch: Boolean(route.autoDispatch),
      pipeline_classification: route.pipelineClassification ?? null,
      classifier_source: classifier.source,
      classifier_verdict: classifier.verdict ?? null,
      classifier_reason: classifier.reason ?? null,
      recorded_user_input: recordedUserInput,
      active_run_id: active?.runId ?? null,
      result_action: result.action,
      result_run_id: blockedAfterCommand?.runId ?? result?.run?.runId ?? null,
    };
    safeAppendEntry(pi, "aipi.input.route", entry);
    safeNotify(ctx, formatWorkflowCommandResult(result), "info");
    if (isAwaitingUserInput(blockedAfterCommand) && hasPickerUi(ctx, blockedAfterCommand)) {
      const pickerResult = await handleBlockedRunPicker({
        event,
        ctx,
        pi,
        projectRoot,
        active: blockedAfterCommand,
        adapter,
        workflowCommandRunner,
        userInputRecorder,
        // The orchestrator gets first crack at resolving the block from the run context (on the session
        // model); the human picker is the fallback. Null model -> supervisor null -> straight to the picker.
        supervisor: buildBlockedRunSupervisor({
          root: projectRoot,
          model: ctx?.model ?? ctx?.current_model ?? ctx?.currentModel ?? null,
        }),
      });
      if (pickerResult?.action === "handled") return pickerResult;
    }
    return { action: "handled" };
  } catch (error) {
    const message = `AIPI routing failed: ${error.message}`;
    if (codePipeline.trace && route?.autoDispatch) {
      await recordCodePipelineTrace({
        projectRoot,
        pi,
        activeRun: active,
        pipeline: codePipelineWithDispatch({ pipeline: codePipeline, route, error }),
      }).catch(() => null);
    }
    safeAppendEntry(pi, "aipi.input.route", {
      schema: "aipi.input-route.v1",
      routed_at: new Date().toISOString(),
      input: route.intent,
      workflow_args: route.workflowArgs,
      workflow: route.workflowSuggestion ?? null,
      auto_dispatch: Boolean(route.autoDispatch),
      pipeline_classification: route.pipelineClassification ?? null,
      classifier_source: classifier.source,
      classifier_verdict: classifier.verdict ?? null,
      classifier_reason: classifier.reason ?? null,
      recorded_user_input: Boolean(route.recordUserInput),
      active_run_id: active?.runId ?? null,
      error: error.message,
    });
    safeNotify(ctx, message, "error");
    return { action: "handled" };
  }
}

export async function handleBlockedRunPicker({
  event,
  ctx,
  pi,
  projectRoot,
  active,
  adapter,
  workflowCommandRunner = runWorkflowCommand,
  userInputRecorder = recordWorkflowUserInput,
  supervisor = null,
  maxLoops = 5,
} = {}) {
  if (!isAwaitingUserInput(active)) return { action: "continue" };

  if (!hasPickerUi(ctx, active)) {
    safeAppendEntry(pi, "aipi.input.route", {
      schema: "aipi.input-route.v1",
      routed_at: new Date().toISOString(),
      input: "blocked_text_prompt",
      active_run_id: active?.runId ?? null,
      handled: false,
      reason: "no_interactive_picker",
    });
    safeNotify(ctx, formatAwaitingUserInputPrompt(active.state.awaiting_user_input), "info");
    return { action: "continue" };
  }

  let current = active;
  for (let loop = 0; loop < maxLoops && isAwaitingUserInput(current) && hasPickerUi(ctx, current); loop += 1) {
    const awaiting = current.state.awaiting_user_input;
    const options = normalizeBlockerOptions(awaiting.options);
    const question = String(awaiting.question || awaiting.reason || "AIPI precisa de uma decisão do usuário para continuar.");
    const choices = [...options, BLOCKER_FREE_TEXT_OPTION];
    // Orchestrator-first: before asking the human, let the orchestrator supervisor try to resolve the block
    // from the run context. It only ever returns an offered option (or escalates), so this can never invent
    // an action; anything but a confident, offered choice falls through to the user picker (fail-safe).
    let selected;
    const supervised = supervisor
      ? await Promise.resolve(
          supervisor({
            workflow: current.state?.workflow ?? null,
            step: awaiting.step_id ?? current.state?.current_step ?? null,
            question,
            reason: awaiting.reason ?? question,
            options,
            context: (current.state?.steps ?? []).map((s) => `${s.id}=${s.status}`).join(" · "),
          }),
        ).catch(() => ({ unavailable: true }))
      : null;
    if (supervised?.resolved && options.includes(supervised.choice)) {
      selected = supervised.choice;
      safeNotify(
        ctx,
        `🤖 orquestrador resolveu o bloqueio em ${current.state?.current_step ?? "step"}: "${supervised.choice}"${supervised.reason ? ` — ${supervised.reason}` : ""}`,
        "info",
      );
    } else {
      selected = await ctx.ui.select(question, choices);
    }

    if (selected == null || selected === "") {
      safeAppendEntry(pi, "aipi.input.route", {
        schema: "aipi.input-route.v1",
        routed_at: new Date().toISOString(),
        input: "blocked_picker_dismissed",
        active_run_id: current.runId,
        handled: false,
      });
      safeNotify(ctx, "AIPI workflow continua bloqueado aguardando resposta.", "info");
      return { action: "continue" };
    }

    let answer = String(selected);
    if (answer === BLOCKER_FREE_TEXT_OPTION) {
      if (typeof ctx?.ui?.input !== "function") {
        safeNotify(ctx, formatAwaitingUserInputPrompt(awaiting), "info");
        return { action: "continue" };
      }
      const typed = await ctx.ui.input(question);
      if (typed == null || !String(typed).trim()) {
        safeAppendEntry(pi, "aipi.input.route", {
          schema: "aipi.input-route.v1",
          routed_at: new Date().toISOString(),
          input: "blocked_free_text_dismissed",
          active_run_id: current.runId,
          handled: false,
        });
        safeNotify(ctx, "AIPI workflow continua bloqueado aguardando resposta.", "info");
        return { action: "continue" };
      }
      answer = String(typed).trim();
    }

    const terminalAction = blockerTerminalAction(answer);
    if (terminalAction) {
      await userInputRecorder({
        projectRoot,
        runId: current.runId,
        text: answer,
        source: "blocker_picker",
      }).catch(() => null);
      return applyBlockedRunTerminalAction({
        ctx,
        pi,
        projectRoot,
        active: current,
        answer,
        terminalAction,
        source: "blocker_picker",
      });
    }

    await userInputRecorder({
      projectRoot,
      runId: current.runId,
      text: answer,
      source: "blocker_picker",
    });
    const result = await workflowCommandRunner({
      args: "execute",
      projectRoot,
      adapter,
      parentInteractiveToolCallHook: "registered_parent_interactive_tool_call_hook",
      notify: makeProgressNotifier(ctx, pi),
    });
    safeAppendEntry(pi, "aipi.input.route", {
      schema: "aipi.input-route.v1",
      routed_at: new Date().toISOString(),
      input: "blocked_picker_answer",
      workflow_args: "execute",
      recorded_user_input: true,
      active_run_id: current.runId,
      result_action: result.action,
      selected_free_text: selected === BLOCKER_FREE_TEXT_OPTION,
    });
    safeNotify(ctx, formatWorkflowCommandResult(result), "info");

    current = activeRunFromWorkflowCommandResult(result);
    if (!isAwaitingUserInput(current)) return { action: "handled" };
  }

  safeNotify(ctx, formatAwaitingUserInputPrompt(current?.state?.awaiting_user_input), "info");
  return { action: "handled" };
}

export function classifyAipiInputRoute(text, { activeRun = null, codePipeline = null, projectRoot = null, autoDispatchEnabled = false } = {}) {
  const original = String(text ?? "").trim();
  if (!original || original.startsWith("/") || original.startsWith("@")) return null;
  const normalized = normalizeInputText(original);

  // Status detection must stay a SHORT, intent-bearing query ("aipi status", "qual o status do run").
  // normalizeInputText flattens newlines, so an unbounded `.*` made any long paste that merely mentioned
  // ".aipi/..." and the word "status" hijack the turn into the status command. Bound it: a small input,
  // with the trigger word and "status" adjacent (no sentence boundary between them).
  if (
    normalized.length <= 80 &&
    /\b(aipi|workflow|run)\b[^.!?]{0,16}\b(status|estado)\b|\b(status|estado)\b[^.!?]{0,16}\b(aipi|workflow|run)\b/.test(
      normalized,
    )
  ) {
    return { intent: "status", workflowArgs: "status" };
  }

  if (isAwaitingUserInput(activeRun)) {
    return null;
  }

  const continuableRun = isContinuableActiveRun(activeRun);
  if (continuableRun && /^(ok|sim|s|continue|continuar|continua|segue|seguir|pode seguir|prossiga|prosseguir|vai|bora)\b/.test(normalized)) {
    return { intent: "continue_active_workflow", workflowArgs: "execute" };
  }
  if (!continuableRun && isContinuationOnlyRequest(normalized)) {
    return null;
  }

  if (continuableRun && /\b(review|revisao|revisar|adversarial|critica|auditoria)\b/.test(normalized)) {
    return { intent: "review_active_workflow", workflowArgs: "execute" };
  }

  const pipeline = codePipeline ?? classifyAipiCodePipeline(original, { activeRun, projectRoot });
  if (pipeline.reason === "explicit_skip_phrase") return null;
  // Auto-feeding substantive input into an active workflow is part of the auto-dispatch behavior; with
  // auto-dispatch off (the flexible-agent default) it stays the user's turn — they continue explicitly.
  if (autoDispatchEnabled && continuableRun && pipeline.substantive && pipeline.classification !== "trivial_or_mechanical") {
    return {
      intent: "continue_active_workflow",
      workflowArgs: "execute",
      recordUserInput: true,
      pipelineClassification: pipeline.classification,
    };
  }

  if (pipeline.classification === "read_only_check") {
    return buildReadOnlyCheckRoute(pipeline);
  }

  // Regex/heuristic auto-dispatch is UNCONDITIONALLY ON at runtime (aipiAutoDispatchEnabled() always
  // returns true, no opt-out): a substantive task routes to a forked workflow run so the per-role model
  // topology is actually exercised. When auto-dispatch is off it falls through to `null` and the full-tool
  // main agent handles it inline. NB: this function's own `autoDispatchEnabled` param still defaults to
  // false — callers that want the runtime behavior must pass aipiAutoDispatchEnabled(); bare unit calls
  // test the off branch.
  const autoWorkflow = autoDispatchEnabled ? autoDispatchWorkflowForPipeline(pipeline) : null;
  if (autoWorkflow) {
    return {
      intent: "auto_dispatch_workflow",
      workflowSuggestion: autoWorkflow,
      workflowArgs: `run ${autoWorkflow}`,
      // Carry the raw task text so it can be plumbed into the workflow's primary param (e.g. bug) —
      // without it the run starts with bug:"" and triage blocks on the unrendered "{{ bug }}".
      taskText: original,
      autoDispatch: true,
      recordInputAfterDispatch: true,
      pipelineClassification: pipeline.classification,
    };
  }

  // Keyword "suggest a workflow" is also auto-dispatch behavior — off by default so the flexible agent
  // isn't nagged to launch a pipeline for every task that mentions a trigger word.
  const workflow = autoDispatchEnabled ? workflowForInput(normalized) : null;
  if (!workflow) return null;
  if (workflow === "check") return buildReadOnlyCheckRoute(pipeline);
  return {
    intent: "suggest_workflow",
    workflowSuggestion: workflow,
    suggestedCommand: `/aipi-workflow run ${workflow}`,
  };
}

// Maps an auto-dispatched workflow to the free-text param that should carry the user's task text, so
// a pasted request actually reaches the run (bugfix triages a real bug instead of "{{ bug }}"). The
// feature workflow is contract-driven and has no free-text input param, so it gets none.
const WORKFLOW_PRIMARY_PARAM = Object.freeze({
  bugfix: "bug",
  ops: "objective",
  planning: "request",
  quick: "request",
  research: "topic",
});

function buildWorkflowParams(route, event) {
  const text = String(route?.taskText ?? event?.text ?? "").trim();
  if (!text) return {};
  const paramName = WORKFLOW_PRIMARY_PARAM[route?.workflowSuggestion ?? ""];
  return paramName ? { [paramName]: text } : {};
}

export function classifyAipiCodePipeline(text, { activeRun = null, projectRoot = null, env = process.env } = {}) {
  const original = String(text ?? "").trim();
  if (!original || original.startsWith("/") || original.startsWith("@")) {
    return { classification: "bypass", substantive: false, trace: false, reason: "command_or_empty" };
  }
  const normalized = normalizeInputText(original);
  if (/\b(skip|ignora|ignorar|nao rode|nao usar|sem)\b.*\b(aipi|pipeline|workflow|review)\b|\b(no|skip)\s+(aipi|pipeline|workflow|review)\b/.test(normalized)) {
    return { classification: "bypass", substantive: false, trace: true, reason: "explicit_skip_phrase" };
  }

  if (isReadOnlyCheckQuestion(normalized)) {
    return {
      classification: "read_only_check",
      substantive: false,
      trace: true,
      non_blocking: true,
      active_run_id: activeRun?.runId ?? null,
      workflow: "check",
      default_action: "answer_inline",
      reason: "interrogative_read_only_check",
      read_only: true,
      grounding: {
        required: true,
        mode: "inline",
        tools: ["aipi_retrieve", "aipi_callers", "aipi_impact"],
        cite: "path:line",
      },
    };
  }

  const deployIntent = /\b(deploy|deployment|release|prod|producao|homolog|homologacao|migration|migracao|rollback|pipeline|ci|cd|infra)\b/.test(normalized);
  const bugIntent = /\b(bug|bugfix|erro|falha|quebrou|regressao|defeito|consertar|conserta|corrigir|corrige|corrija)\b/.test(normalized);
  const codeIntent = /\b(implementar|implementa|corrigir|corrige|corrija|consertar|refatorar|refatora|alterar|altera|adicionar|adiciona|criar|bug|bugfix|feature|codigo|code|api|endpoint|funcao|componente|teste|tests?)\b/.test(normalized);
  const trivialIntent = /\b(typo|ortografia|comentario|comentario|formatar|formatacao|renomear|rename|pequeno ajuste|ajuste simples|fix simples|texto|copy)\b/.test(normalized);
  const activeWorkflow = isContinuableActiveRun(activeRun);
  if (deployIntent && !trivialIntent) {
    const autoDeploy = resolveAutoDeployPolicy({ normalized, projectRoot, env });
    return {
      classification: "deploy_precheck",
      substantive: true,
      trace: true,
      non_blocking: true,
      active_run_id: activeRun?.runId ?? null,
      workflow: "ops",
      workflow_alignment: {
        workflow: "ops.yaml",
        stages: ["classify_boundary", "policy_gate", "plan", "human_review"],
      },
      stages: DEPLOY_PRECHECK_PIPELINE_STAGES,
      precheck: {
        required: true,
        aligned_workflow: "ops.yaml",
        checks: [
          "environment_boundary",
          "risk_blast_radius",
          "rollback_readiness",
          "evidence",
        ],
        evidence_sources: [
          "project_memory",
          "blast_radius_memory",
          "tests_or_health_checks",
          "rollback_plan",
        ],
      },
      deploy_confirmation: {
        gate: "confirm_before_execute",
        required: !autoDeploy.enabled,
        mode: autoDeploy.enabled ? "auto_deploy_after_precheck" : "human_confirm_before_irreversible_command",
        scope: "irreversible_deploy_or_migration_command_only",
        blocks_chat_or_editing: false,
      },
      auto_deploy: {
        enabled: autoDeploy.enabled,
        reason: autoDeploy.reason,
        source: autoDeploy.source,
        precheck_still_required: true,
      },
      default_action: autoDeploy.enabled ? "precheck_then_execute" : "precheck_then_confirm",
    };
  }
  if (bugIntent && !trivialIntent) {
    return {
      classification: "root_cause_bugfix",
      substantive: true,
      trace: true,
      non_blocking: true,
      active_run_id: activeRun?.runId ?? null,
      workflow: "bugfix",
      workflow_alignment: {
        workflow: "bugfix.yaml",
        stages: ["triage", "reproduce", "fix", "verify"],
      },
      stages: BUG_ROOT_CAUSE_PIPELINE_STAGES,
      root_cause: {
        required: true,
        assumptions_required: true,
        evidence_required: true,
        confirm_before_fix: true,
        no_symptom_patch: true,
      },
      adversarial_review: {
        target: "diagnosis",
        challenge: "root_cause_hypotheses_and_evidence_before_diff",
      },
      cross_model_review: {
        required: true,
        reviewer_distinct_from_implementer: true,
        applies_to: "diagnosis_and_fix",
      },
      default_action: activeWorkflow ? "continue_active_workflow" : "auto_dispatch_workflow",
      dispatch_workflow: activeWorkflow ? null : "bugfix",
    };
  }
  if (codeIntent && !trivialIntent) {
    return {
      classification: "substantive_code_work",
      substantive: true,
      trace: true,
      non_blocking: true,
      active_run_id: activeRun?.runId ?? null,
      workflow: "planning",
      workflow_alignment: {
        workflow: "planning.yaml",
        stages: ["intake", "context", "requirements", "acceptance"],
        reason: "BDD contract must be created before feature implementation.",
      },
      stages: ["plan", "adversarial_review", "diff_review"],
      default_action: activeWorkflow ? "continue_active_workflow" : "auto_dispatch_workflow",
      dispatch_workflow: activeWorkflow ? null : "planning",
    };
  }
  if (trivialIntent) {
    return {
      classification: "trivial_or_mechanical",
      substantive: false,
      trace: true,
      non_blocking: true,
      active_run_id: activeRun?.runId ?? null,
      stages: [],
      default_action: "continue_without_pipeline",
    };
  }
  return { classification: "not_code_work", substantive: false, trace: false };
}

function autoDispatchWorkflowForPipeline(pipeline = {}) {
  if (pipeline.default_action !== "auto_dispatch_workflow") return null;
  if (pipeline.classification === "root_cause_bugfix") return "bugfix";
  if (pipeline.classification === "substantive_code_work") return "planning";
  return null;
}

function buildReadOnlyCheckRoute(pipeline = {}) {
  return {
    intent: "check_inline",
    workflowSuggestion: "check",
    answerInline: true,
    autoDispatch: false,
    pipelineClassification: pipeline.classification ?? "read_only_check",
    groundingTools: ["aipi_retrieve", "aipi_callers", "aipi_impact"],
  };
}

function routeExecutesWorkflow(route = null) {
  if (!route || route.answerInline || route.suggestedCommand) return false;
  const args = String(route.workflowArgs ?? "").trim();
  if (!args || args === "status") return false;
  return Boolean(route.autoDispatch || args === "execute" || args.startsWith("run "));
}

async function resolveAipiHostInputReadiness({ event = null, ctx = null, coordinator = null } = {}) {
  const eventModel = await resolveHostModelCandidate({ event, ctx }).catch(() => null);
  let coordinatorModel = null;
  if (!eventModel && typeof coordinator?.getHostModel === "function") {
    try {
      coordinatorModel = coordinator.getHostModel();
    } catch {
      coordinatorModel = null;
    }
  }
  return aipiHostModelReadiness(eventModel ?? coordinatorModel, { requireProvider: false });
}

// One blocked user turn used to fan out into up to 6 near-identical error
// records (input + before_agent_start + model_select hooks, each mirrored into
// two files). Coalesce per project: a new canonical errors.jsonl record is
// written on each new user turn (input hook) or when the blocked host/code
// changes; follow-up hooks of the same turn reference it via coalesced_with.
const lastUnsupportedHostBlock = new Map();

async function blockUnsupportedHostTurn({
  hook,
  event = null,
  ctx = null,
  pi = null,
  projectRoot,
  coordinator = null,
  activeRun = null,
  snapshot = null,
  codePipeline = null,
} = {}) {
  if (unsupportedHostGuardBypassed({ hook, event, ctx })) return null;
  const readiness = await resolveAipiHostInputReadiness({ event, ctx, coordinator });
  if (readiness.ok) {
    lastUnsupportedHostBlock.delete(projectRoot);
    return null;
  }

  const runSnapshot = snapshot ?? await buildRunSnapshot(projectRoot).catch(() => ({ active: false }));
  const blockKey = `${readiness.code}|${readiness.model_id ?? ""}|${readiness.provider ?? ""}`;
  const prior = lastUnsupportedHostBlock.get(projectRoot) ?? null;
  const needsCanonicalRecord = hook === "input" || prior?.key !== blockKey;
  let errorEntry = null;
  if (needsCanonicalRecord) {
    const diagnosticError = new Error(readiness.message);
    diagnosticError.name = "AipiUnsupportedHostError";
    diagnosticError.code = readiness.code;
    diagnosticError.readiness = readiness;
    errorEntry = await recordRuntimeError({
      projectRoot,
      hook,
      event: {
        ...compactEvent(event),
        unsupported_host_model: readiness.model_id,
        unsupported_host_provider: readiness.provider,
      },
      error: diagnosticError,
      expected: true,
    }).catch(() => null);
    if (errorEntry) {
      lastUnsupportedHostBlock.set(projectRoot, { key: blockKey, recorded_at: errorEntry.recorded_at });
    }
  }
  const canonicalRef = errorEntry?.recorded_at ?? (prior?.key === blockKey ? prior.recorded_at : null);

  const entry = {
    schema: "aipi.unsupported-host-block.v1",
    recorded_at: new Date().toISOString(),
    hook,
    run_id: runSnapshot?.run_id ?? activeRun?.runId ?? null,
    workflow: runSnapshot?.workflow ?? activeRun?.state?.workflow ?? null,
    step_id: runSnapshot?.step_id ?? activeRun?.state?.current_step ?? null,
    host_model: readiness.model_id,
    host_provider: readiness.provider,
    code: readiness.code,
    message: readiness.message,
    runtime_error_recorded: Boolean(errorEntry),
    runtime_error_ref: canonicalRef,
    coalesced_with: errorEntry ? null : canonicalRef,
    pipeline_classification: codePipeline?.classification ?? null,
  };
  safeAppendEntry(pi, "aipi.host.unsupported", entry);
  await appendRuntimeEvent(projectRoot, UNSUPPORTED_HOST_LOG, entry).catch(() => null);
  if (runSnapshot?.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(runSnapshot.run_id, "unsupported-host.jsonl"), entry).catch(() => null);
  }
  safeNotify(ctx, readiness.message, "error");

  if (hook === "model_select") {
    return {
      model: null,
      model_class: null,
      modelClass: null,
      source: "unsupported_host_model",
      thinking_level: null,
      thinkingLevel: null,
      warning: {
        code: readiness.code,
        severity: "error",
        message: readiness.message,
        host_model: readiness.model_id,
        host_provider: readiness.provider,
      },
      blocked: true,
      block_reason: readiness.code,
      status: "unsupported_host_model",
      readiness,
    };
  }

  return {
    action: "blocked",
    blocked: true,
    block_reason: readiness.code,
    readiness,
    message: {
      customType: "aipi.unsupported-host",
      display: true,
      content: readiness.message,
      details: entry,
    },
  };
}

function unsupportedHostGuardBypassed({ hook, event = null, ctx = null } = {}) {
  if (event?.aipiAllowUnsupportedHost === true || ctx?.aipiAllowUnsupportedHost === true) return true;
  if (hook !== "input") return false;
  const text = String(event?.text ?? "").trim();
  return text.startsWith("/") || text.startsWith("@");
}

function resolveAutoDeployPolicy({ normalized, projectRoot = null, env = process.env }) {
  if (/\b(auto[- ]?deploy|autodeploy|deploy automatico|implantacao automatica)\b/.test(normalized) ||
    /\b(sem confirmacao|sem pedir confirmacao|nao pedir confirmacao|skip confirm|no confirm)\b/.test(normalized)) {
    return { enabled: true, reason: "explicit_user_instruction", source: "input" };
  }

  if (isTruthyFlag(env?.AIPI_AUTO_DEPLOY) || isTruthyFlag(env?.AIPI_AUTODEPLOY)) {
    return { enabled: true, reason: "config_flag", source: "env" };
  }

  const projectPolicy = readProjectAutoDeployPolicy(projectRoot);
  if (projectPolicy.enabled) return projectPolicy;
  return { enabled: false, reason: "human_confirmation_required", source: "default" };
}

function readProjectAutoDeployPolicy(projectRoot) {
  if (!projectRoot) return { enabled: false, reason: "no_project_root", source: "project_memory" };
  const policyFiles = [
    ".aipi/memory/project/deployment.md",
    ".aipi/memory/project/business-rules.md",
    ".aipi/memory/project/procedures.md",
  ];
  for (const relPath of policyFiles) {
    const filePath = path.join(projectRoot, relPath);
    if (!fsSync.existsSync(filePath)) continue;
    let text = "";
    try {
      text = normalizeInputText(fsSync.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (hasDenyingAutoDeployPolicy(text)) continue;
    if (hasAllowingAutoDeployPolicy(text)) {
      return { enabled: true, reason: "project_memory_autodeploy_policy", source: relPath };
    }
  }
  return { enabled: false, reason: "no_project_memory_autodeploy_policy", source: "project_memory" };
}

function hasAllowingAutoDeployPolicy(normalizedText) {
  const mentionsAutoDeploy = /\b(auto[- ]?deploy|autodeploy|deploy automatico|implantacao automatica)\b/.test(normalizedText);
  const allows = /\b(permitido|permite|pode|autorizado|autoriza|allowed|enabled|habilitado|policy|politica)\b/.test(normalizedText);
  const mentionsPrecheck = /\b(prechecks?|pre-checks?|pre checks?|checks?|validacao|evidencia|rollback|smoke)\b/.test(normalizedText);
  return mentionsAutoDeploy && allows && mentionsPrecheck;
}

function hasDenyingAutoDeployPolicy(normalizedText) {
  return /\b(nao|not|never|nunca|proibido|bloqueado|deny|disabled)\b.{0,80}\b(auto[- ]?deploy|autodeploy|deploy automatico|implantacao automatica)\b/.test(normalizedText) ||
    /\b(auto[- ]?deploy|autodeploy|deploy automatico|implantacao automatica)\b.{0,80}\b(nao|not|never|nunca|proibido|bloqueado|deny|disabled)\b/.test(normalizedText);
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on", "enabled"].includes(String(value ?? "").toLowerCase());
}

function formatWorkflowSuggestion(workflow, command) {
  return `AIPI: isto parece ${workflow}; execute \`${command}\` se quiser abrir esse workflow.`;
}

async function applyAutoDispatchVeto({
  text = "",
  route = null,
  codePipeline = {},
  activeRun = null,
  projectRoot = null,
  ctx = {},
  intentClassifier = null,
  timeoutMs = 1500,
} = {}) {
  const base = {
    route,
    originalRoute: route,
    source: route?.autoDispatch ? "regex-fallback" : "regex",
    verdict: null,
    reason: route?.autoDispatch ? "no_intent_classifier" : null,
    vetoed: false,
  };
  if (!route?.autoDispatch) return base;
  if (typeof intentClassifier !== "function") return base;

  const started = Date.now();
  try {
    const raw = await withTimeout(
      intentClassifier({
        text,
        normalized: normalizeInputText(text),
        route,
        codePipeline,
        activeRun,
        projectRoot,
        ctx: { ...(ctx ?? {}), aipiDisableRouting: true },
        timeoutMs,
      }),
      timeoutMs,
      "intent_classifier_timeout",
    );
    const verdict = normalizeIntentClassifierVerdict(raw);
    const elapsedMs = Date.now() - started;
    if (verdict.veto) {
      return {
        route: null,
        originalRoute: route,
        source: "llm-veto",
        verdict: verdict.verdict,
        reason: verdict.reason,
        elapsedMs,
        vetoed: true,
      };
    }
    return {
      route,
      originalRoute: route,
      source: "llm-veto",
      verdict: verdict.verdict,
      reason: verdict.reason,
      elapsedMs,
      vetoed: false,
    };
  } catch (error) {
    return {
      ...base,
      source: "regex-fallback",
      verdict: "unavailable",
      reason: String(error?.message ?? error),
    };
  }
}

function normalizeIntentClassifierVerdict(raw) {
  const value = typeof raw === "string" ? { verdict: raw } : raw ?? {};
  const verdict = String(value.verdict ?? value.intent ?? value.route ?? "").trim().toLowerCase();
  const reason = String(value.reason ?? value.rationale ?? verdict ?? "unspecified").slice(0, 240);
  const veto = value.veto === true ||
    ["question", "no-workflow", "no_workflow", "check", "read_only_check", "answer_inline"].includes(verdict);
  return {
    verdict: verdict || "unknown",
    reason,
    veto,
  };
}

function withTimeout(promise, timeoutMs, message) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message}_${Math.floor(ms)}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildReadOnlyCheckDetails({ text = "", route = {}, codePipeline = {}, activeRun = null } = {}) {
  return {
    schema: "aipi.read-only-check.v1",
    input: String(text ?? ""),
    workflow: route.workflowSuggestion ?? "check",
    mode: "inline",
    read_only: true,
    active_run_id: activeRun?.runId ?? null,
    pipeline_classification: route.pipelineClassification ?? codePipeline.classification ?? null,
    grounding_tools: route.groundingTools ?? ["aipi_retrieve", "aipi_callers", "aipi_impact"],
    grounding_required: "Use AIPI read-only retrieval/call graph tools before answering codebase questions; cite path:line refs.",
  };
}

function renderReadOnlyCheckHint(details = {}) {
  return [
    "AIPI read-only check lane.",
    "Do not start a write workflow for this input.",
    `Question: ${details.input ?? ""}`,
    `Use: ${(details.grounding_tools ?? []).join(", ")}`,
    "Answer inline only after grounding in project files; cite path:line references.",
  ].join("\n");
}

async function recordCodePipelineTrace({ projectRoot, pi, activeRun = null, pipeline }) {
  const entry = {
    schema: "aipi.code-pipeline-trace.v1",
    recorded_at: new Date().toISOString(),
    active_run_id: activeRun?.runId ?? null,
    classification: pipeline.classification,
    substantive: Boolean(pipeline.substantive),
    non_blocking: pipeline.non_blocking !== false,
    reason: pipeline.reason ?? null,
    workflow: pipeline.workflow ?? null,
    workflow_alignment: pipeline.workflow_alignment ?? null,
    stages: pipeline.stages ?? [],
    root_cause: pipeline.root_cause ?? null,
    precheck: pipeline.precheck ?? null,
    deploy_confirmation: pipeline.deploy_confirmation ?? null,
    auto_deploy: pipeline.auto_deploy ?? null,
    adversarial_review: pipeline.adversarial_review ?? null,
    cross_model_review: pipeline.cross_model_review ?? null,
    default_action: pipeline.default_action ?? "continue",
    dispatch: pipeline.dispatch ?? null,
  };
  safeAppendEntry(pi, "aipi.code_pipeline.trace", entry);
  await appendRuntimeEvent(projectRoot, CODE_PIPELINE_LOG, entry);
  if (activeRun?.runId) {
    await appendRuntimeEvent(projectRoot, runScopedLog(activeRun.runId, "code-pipeline.jsonl"), entry);
  }
  return entry;
}

function codePipelineWithDispatch({ pipeline = {}, route = {}, result = null, error = null, skipped = null } = {}) {
  const dispatchedRun = activeRunFromWorkflowCommandResult(result);
  const dispatchAction = skipped ? "suggest_workflow" : "auto_dispatch_workflow";
  return {
    ...pipeline,
    workflow: route.workflowSuggestion ?? pipeline.workflow ?? null,
    default_action: pipeline.default_action ?? dispatchAction,
    dispatch: {
      action: dispatchAction,
      workflow: route.workflowSuggestion ?? null,
      workflow_args: route.workflowArgs ?? null,
      run_id: dispatchedRun?.runId ?? result?.run?.runId ?? null,
      result_action: error ? "error" : result?.action ?? "skipped",
      error: error?.message ?? null,
      skipped,
    },
  };
}

// The finish-audit warning is a constant string, and message_end fires once per assistant message — so an
// agent that legitimately wraps up across two messages could surface it twice. Dedupe to at most one per
// turn: remember the last surfaced warning per project root and reset it at the start of each turn
// (handleBeforeAgentStart). Keyed by projectRoot so concurrent projects don't suppress each other.
const lastSurfacedClaimWarning = new Map();

function auditEndDisciplineEvent({ event, hook, activeDisciplines = [] } = {}) {
  const text = extractUserFacingText(event, { hook });
  const claims = claimEvidenceFindings(text);
  const outcome = outcomeFirstFinding(text);
  // Only a genuine COMPLETION/hand-back claim warrants the warning. A claim term alone is not enough — it
  // fires on investigative narration that merely describes how code behaves ("o save funciona quando…",
  // "the flow works like X") and spams a warning on every mid-task message. Require completion framing so
  // only the agent actually asserting it finished ("corrigi", "fixed", "tudo passou", "safe to deploy")
  // without an evidence rung surfaces.
  const completionClaim = claims.length > 0 && isCompletionClaim(text);
  const checks = [];
  // The finish-turn entry was hardcoded state:"recorded" for every message —
  // inert by construction. Record it only when the discipline is actually active.
  if (activeDisciplines.some((discipline) => discipline.id === "finish-turn")) {
    checks.push({
      id: "finish-turn",
      state: "recorded",
      evidence: "finish-turn discipline activated for end-of-turn hook",
    });
  }
  checks.push(
    {
      id: "outcome-first",
      state: outcome ? "warn" : "pass",
      evidence: outcome ?? "first sentence is outcome-oriented or no user-facing text was present",
    },
    {
      id: "claim-evidence",
      state: completionClaim ? "warn" : "pass",
      evidence: completionClaim
        ? `unsupported completion claim(s): ${claims.map((claim) => claim.term).join(", ")}`
        : "no unsupported completion claim (fixed/passed/done) without an evidence rung",
    },
  );
  const state = hook === "message_end" && completionClaim ? "warn" : "pass";
  return {
    state,
    reason: state === "warn" ? "AIPI_MESSAGE_END_CLAIM_EVIDENCE_REQUIRED" : null,
    message:
      state === "warn"
        ? "AIPI message_end audit: user-facing claim requires an evidence rung such as written/ran/verified plus a concrete command, test, or artifact."
        : null,
    text_excerpt: truncateText(text, 480),
    checks,
    unsupported_claims: claims,
  };
}

// message_end fires for EVERY message role, not just the assistant's reply — Pi's own consumers gate on
// `event.message.role === "assistant"` (see vendored subagent-runner.ts:351). The finish-audit did NOT,
// so it read two kinds of non-claim text and flagged "done"/"fixed" words inside them:
//   1. AIPI's OWN injected context pointer (role "custom", display:false) — it carries the "DEFINITION OF
//      DONE" line, so the audit warned on AIPI's own context every turn.
//   2. Tool-result messages (role "user"/"tool") — git logs ("fix(...)"), file reads, code blobs.
// Neither is a user-facing completion claim. Gate strictly on the assistant role (and on block type) so
// only the agent's own prose is scanned; non-assistant messages carry no claim.
function extractUserFacingText(event = {}, { hook } = {}) {
  const role = event?.message?.role ?? event?.role ?? null;
  // message_end is the ONLY hook that surfaces the finish-audit warning, and Pi fires it for EVERY message
  // role (its own consumers gate on event.message.role === "assistant" — vendored subagent-runner.ts:351).
  // Fail CLOSED here: require an explicit assistant role. Pi always stamps it on a real reply, so this never
  // drops one — but it rejects role:"custom"/"user"/"tool" AND role-LESS messages (AIPI's injected
  // context-pointer can be returned without a role from handleBeforeAgentStart). agent_end/turn_end pass a
  // plain { text } with no role and never warn, so leave their recording behavior unchanged (fail open).
  if (hook === "message_end") {
    if (role !== "assistant") return "";
  } else if (role && role !== "assistant") {
    return "";
  }
  const candidates = [
    event.text,
    event.output,
    event.content,
    event.message?.content,
    event.message?.text,
    event.response?.content,
  ];
  for (const candidate of candidates) {
    const text = flattenText(candidate).trim();
    if (text && !isAipiInjectedContext(text)) return text;
  }
  return "";
}

// AIPI's injected context-pointer (renderContextPointer) is never a user-facing claim. The fail-closed
// role gate already rejects it (it is a role:"custom"/role-less message and message_end requires the
// assistant role), so this is pure defense-in-depth for the unlikely case it is ever merged INTO an
// assistant message. Match ONLY the unambiguous AIPI HEADER at the START — never body lines like
// "DEFINITION OF DONE" or "memory_refs:", which an assistant could legitimately echo while making a real,
// warnable completion claim (else the warning would be wrongly suppressed).
function isAipiInjectedContext(text) {
  const head = normalizeInputText(String(text ?? "").slice(0, 120));
  return head.startsWith("aipi project context") || head.startsWith("aipi active run context");
}

// Content blocks that are NOT the assistant's prose: tool calls/results, thinking, attachments. A
// tool_result block carries `.content` (e.g. a git log) that flattenText would otherwise read as the
// agent's own words — skip them so only genuine text blocks feed the claim scan.
const NON_USER_FACING_BLOCK_TYPES = new Set([
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "image",
  "document",
]);

function flattenText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.type === "string" && NON_USER_FACING_BLOCK_TYPES.has(value.type)) return "";
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return flattenText(value.content);
  }
  return "";
}

function claimEvidenceFindings(text) {
  const normalized = normalizeInputText(text);
  if (!normalized || hasEvidenceRung(text)) return [];
  const claimPatterns = [
    { term: "fixed", pattern: /\b(fixed|corrigido|corrigida|resolvido|resolvida|consertado|consertada)\b/ },
    { term: "passes", pattern: /\b(passes|passed|passou|passaram|ok|green)\b/ },
    { term: "works", pattern: /\b(works|working|funciona|funcionando)\b/ },
    { term: "verified", pattern: /\b(verified|verificado|validado|validada|testado|testada)\b/ },
    { term: "safe", pattern: /\b(safe|seguro|segura|safe to deploy|pronto para deploy)\b/ },
    { term: "done", pattern: /\b(done|completed|complete|concluido|concluida|feito|feita)\b/ },
  ];
  return claimPatterns
    .filter((claim) => claim.pattern.test(normalized))
    .map((claim) => ({
      term: claim.term,
      evidence_required: "written|ran|verified plus concrete command/test/artifact",
    }));
}

// True only when the text reads as the agent ASSERTING it finished the work (or handing it back as done),
// not investigative narration that happens to contain a claim word. This is the gate that stops the
// finish-audit warning from firing on every mid-task message — investigation describes the system
// ("o save funciona quando X", "the flow works like Y"); a completion claim asserts a change the agent made.
function isCompletionClaim(text) {
  const raw = String(text ?? "").trim();
  const normalized = normalizeInputText(text);
  if (!normalized) return false;
  // Investigative/intent framing in the LEAD (first sentence) means the message is about work the agent is
  // ABOUT to do, not a hand-back — suppress. Scoped to the lead so a trailing "next I'll…" clause or a
  // courtesy question AFTER a real completion claim doesn't silence the warning (CG-1).
  const lead = normalizeInputText(raw.split(/(?<=[.!?])\s+/)[0] ?? raw);
  const leadInvestigative =
    /\b(vou|irei|i'?ll|i will|let me|deixa eu|i'?m (going|tracing|looking|investigating|checking|examining|reading|trying|seeing)|investigando|analisando|examinando|verificando|rastreando|preciso|i need to|proximo passo|next step|likely|provavelmente|talvez|maybe|suspeito|parece que|it seems|fails? to|nao (funciona|salva|esta)|does ?n'?t (work|save))\b/.test(lead);
  if (leadInvestigative) return false;
  // A message that is a single bare question (no claim sentence before the trailing "?") is investigative.
  if (/\?\s*$/.test(raw) && !/[.!]/.test(raw.slice(0, -1))) return false;
  // Descriptive / historical / negated framing — describes existing or prior-state behavior, not a fresh
  // completion the agent just produced ("the flow works like this… already implemented", "foi corrigido na
  // PR anterior, mas o bug voltou") (CG-2).
  const descriptive =
    /\b(works? like|funciona (assim|como)|already (implemented|fixed|done|working)|ja (implementad|corrigid|resolvid|funciona)|na pr anterior|previously (fixed|implemented)|anteriormente)\b/.test(normalized) ||
    /\b(mas|but|porem|however|todavia)\b[^.!?\n]{0,60}\b(voltou|quebrou|broke|fails?|nao funciona|regrediu|back)\b/.test(normalized);
  if (descriptive) return false;
  return (
    // first-person past-tense completion (PT)
    /\b(corrigi|consertei|implementei|ajustei|conclui|finalizei|terminei|resolvi|apliquei|adicionei|criei|removi)\b/.test(normalized) ||
    // done-state participles/adjectives asserted as the result (PT) — incl. concluído (CG-3)
    /\b(corrigid[oa]s?|resolvid[oa]s?|consertad[oa]s?|implementad[oa]s?|ajustad[oa]s?|aplicad[oa]s?|adicionad[oa]s?|conclu[ií]d[oa]s?|restaurad[oa]s?|pront[oa]s?|funcionando)\b/.test(normalized) ||
    // PT "(agora) funciona / funciona agora" now-works (CG-3)
    /\b(funciona agora|agora funciona)\b/.test(normalized) ||
    // completion verbs / done-state (EN)
    /\b(fixed|implemented|resolved|completed|finished|shipped|applied|added|removed|restored|working now|now works|passing|done)\b/.test(normalized) ||
    // tests/all pass
    /\b(all|todos|todas|tudo)\b[^.!?\n]{0,40}\b(pass|passed|passes|passing|passou|passaram|green|verde)\b/.test(normalized) ||
    // explicit hand-back / deploy readiness — incl. PT "seguro/pronto para …" and "deploy está seguro" (CG-3)
    /\b(safe to (deploy|merge|ship)|seguro para (deploy|merge|produc|producao)|pronto para (deploy|merge|review|produc|producao|homolog))\b/.test(normalized) ||
    /\b(deploy|release|merge)\b[^.!?\n]{0,20}\b(seguro|safe)\b/.test(normalized) ||
    // close-out actions completed
    /\b(deployed|mergeado|merged|pr (aberto|criado|mergeado))\b/.test(normalized)
  );
}

function hasEvidenceRung(text) {
  const normalized = String(text ?? "").toLowerCase();
  return /\b(written|ran|verified|blocked)\b/.test(normalized) ||
    /\bevidence\b/.test(normalized) ||
    /`[^`]*(npm|node|git|pytest|cargo|go test|pnpm|yarn)[^`]*`/.test(normalized) ||
    /\b(npm|node|git|pytest|cargo|go test|pnpm|yarn)\b[^\n]*(->|passed|ok|exit\s*0|green)/.test(normalized) ||
    /\b[A-Z0-9_]+_OK\b/.test(String(text ?? ""));
}

function outcomeFirstFinding(text) {
  const firstSentence = String(text ?? "").trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  if (!firstSentence) return null;
  if (/^(i will|i'll|vou|posso|i can|next|plan|planned|pretendo)\b/i.test(firstSentence.trim())) {
    return "first sentence starts with process/intent instead of the user-facing outcome";
  }
  return null;
}

function normalizeInputText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isContinuableActiveRun(activeRun) {
  if (!activeRun?.runId) return false;
  const status = String(activeRun?.state?.status ?? "active").toLowerCase();
  return !["complete", "completed", "done", "failed", "cancelled", "canceled"].includes(status);
}

function isContinuationOnlyRequest(normalized) {
  return /^(ok\s+)?(resume|continue|continuar|continua|seguir|segue|pode seguir|prossiga|prosseguir)\b/.test(normalized) &&
    (
      /\b(onde parou|de onde parou|parou|atualizacao|update|depois da atualizacao|apos atualizacao)\b/.test(normalized) ||
      /\b(wave|onda|fix wave|test fix|trabalho|work|kanban|tarefa|task|ticket|nora-\d+)\b/.test(normalized)
    );
}

function isReadOnlyCheckQuestion(normalized) {
  const text = String(normalized ?? "").trim();
  if (!text) return false;
  if (isPoliteMutationRequest(text)) return false;
  const interrogative = /\?$/.test(text) ||
    /^(como|onde|por que|porque|qual|quais|quem|quando|sobrou|resta|existe|tem|ha|how|where|why|what|which|who|does|do|is|are)\b/.test(text) ||
    /\b(quem chama|who calls|what calls|onde fica|where is|como funciona|how does|how do)\b/.test(text);
  if (!interrogative) return false;
  return /\b(teste|testes|tests?|api|endpoint|funcao|function|componente|component|codigo|code|arquivo|file|classe|class|modulo|module|chama|calls?|impacto|impact|funciona|works|cobre|coverage|fluxo|flow|dependency|dependencia)\b/.test(text);
}

function isPoliteMutationRequest(normalized) {
  return /^(can you|could you|please|por favor|pode|voce pode|vc pode)\b.*\b(corrigir|corrige|corrija|consertar|implementar|implementa|adicionar|adiciona|criar|fix|implement|add|create|change|update)\b/.test(normalized);
}

function routingDisabled(event, ctx) {
  return Boolean(event?.aipiDisableRouting || ctx?.aipiDisableRouting || isTruthyFlag(process.env.AIPI_DISABLE_ROUTING));
}

// Multi-task mode is opt-in (default off) so single-task flex-agent behavior is the unchanged default.
export function aipiMultiTaskEnabled(env = process.env) {
  return isTruthyFlag(env?.AIPI_MULTI_TASK);
}

// Detect a CLEAR multi-task batch: a list of >=2 lines that are MOSTLY explicit list items (bullets,
// "1.", "1)"). Deliberately conservative — a single paragraph, a question, a continuation token, or a
// 2-line prose message is NOT a batch (those keep their normal single-task handling). The explicit
// /aipi-plan command is liberal (parsePlanTasks) for when the user wants any format.
export function detectTaskBatch(text) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("@")) return [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const markered = lines.filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line));
  if (markered.length >= 2 && markered.length >= Math.ceil(lines.length / 2)) {
    return lines.map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  }
  return [];
}

function formatPlanSuggestion(batch) {
  const preview = batch.slice(0, 5).map((task, index) => `${index + 1}. ${task}`).join("\n");
  return [
    `AIPI multi-task: detected ${batch.length} tasks. Run them as ONE governed plan:`,
    preview,
    batch.length > 5 ? `…and ${batch.length - 5} more` : "",
    "Use /aipi-plan (paste the list) to investigate rules once, answer the clarifying questions, then /aipi-plan settle && /aipi-plan execute.",
  ].filter(Boolean).join("\n");
}

async function hasActivePlan(projectRoot) {
  const activePath = path.join(path.resolve(projectRoot), ".aipi", "runtime", "plans", "active");
  const id = await fs.readFile(activePath, "utf8").catch(() => "");
  return Boolean(id.trim());
}

// A real agentic worker (reads the codebase, reasons, writes several artifacts) routinely takes
// minutes — far longer than the 120s spike-era default. With the short default the executor gave up
// and stamped the step BLOCKED ("worker did not finish: timeout") while the worker was still working
// and about to write its artifacts, so NO real workflow step could ever complete. The collect loop
// returns as soon as the worker is ready, so a generous ceiling only bounds a genuinely hung worker.
const AIPI_WORKFLOW_WORKER_COLLECT_TIMEOUT_MS = 20 * 60_000; // 20 minutes

// Flexible-agent default: AIPI does NOT auto-launch a forked, hard-gated workflow from keyword/regex
// intent. Auto-dispatch is UNCONDITIONAL (project decision — no opt-out): the orchestrator always hands
// substantive code/bug/deploy/research work to the per-role worker topology (this is what actually
// exercises the configured models — sonnet-5 for code, grok-4.5 for adversarial, etc.). Trivial edits
// (typo/rename/format), read-only questions, and continuations still resolve inline inside
// classifyAipiInputRoute regardless. The AIPI_AUTO_DISPATCH env var is intentionally no longer consulted.
function aipiAutoDispatchEnabled() {
  return true;
}

function buildExecutableWorkflowAdapter({ coordinator = null, ctx = {} } = {}) {
  if (typeof coordinator?.spawn !== "function" || typeof coordinator?.collect !== "function") return undefined;
  try {
    return createSubagentWorkflowAdapter(coordinator, {
      modelResolver: (modelArgs) => resolveStepModel({ ...modelArgs, ctx }),
      collectTimeoutMs: AIPI_WORKFLOW_WORKER_COLLECT_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

function isAwaitingUserInput(activeRun) {
  return Boolean(
    activeRun?.runId &&
      activeRun?.state?.status === "blocked" &&
      activeRun?.state?.awaiting_user_input?.step_id,
  );
}

// ADV-58-1: a run blocked on the run-level freestyle/retry/cancel META-decision (NOT a
// real business blocker_question). Detection is exact: the executor stamps
// awaiting_user_input.kind = "workflow_blocked_decision" for these, and we also accept
// the meta option-set as a robust fallback for runs persisted before the kind marker.
function isWorkflowBlockedDecisionRun(activeRun) {
  if (!isAwaitingUserInput(activeRun)) return false;
  const awaiting = activeRun.state.awaiting_user_input;
  if (awaiting?.kind === WORKFLOW_BLOCKED_DECISION_KIND) return true;
  return isWorkflowBlockedDecisionOptions(awaiting?.options);
}

// A new substantive message is one that is NOT selecting one of the meta options and NOT
// a bare picker token (1/2/3/retry/cancel/continue/continuar). Such a message means the
// user moved on; we auto-resolve to "continue outside the workflow".
function isFreshSubstantiveBlockedInput(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (raw.startsWith("/") || raw.startsWith("@")) return false;
  if (blockerTerminalAction(raw)) return false;
  const normalized = normalizeInputText(raw);
  if (/^[1-3]$/.test(normalized)) return false;
  if (/^(ok\s+)?(retry|tentar|tentar novamente|novamente|cancel|cancelar|continue|continuar|continua|seguir|segue|prossiga|prosseguir)$/.test(normalized)) {
    return false;
  }
  return true;
}

function blockerTerminalAction(value) {
  const normalized = normalizeInputText(value);
  if (!normalized) return null;
  if (/\b(cancelar|cancele|cancel|abort|abortar)\b.*\b(run|workflow|fluxo)\b/.test(normalized) ||
    /^cancelar este run$/.test(normalized)) {
    return {
      status: "cancelled",
      code: "blocked_run_cancelled",
      message: "AIPI workflow cancelado; o proximo input sera tratado como uma conversa nova.",
    };
  }
  if (/\b(continuar|continue|seguir|prosseguir)\b.*\b(fora|sem|outside|freestyle)\b.*\b(workflow|automatico|automatic)\b/.test(normalized) ||
    /^continuar fora do workflow automatico nesta conversa$/.test(normalized)) {
    return {
      status: "abandoned",
      code: "blocked_run_detached",
      message: "AIPI workflow destacado; o proximo input sera tratado fora do workflow automatico.",
    };
  }
  return null;
}

async function applyBlockedRunTerminalAction({
  ctx,
  pi,
  projectRoot,
  active,
  answer = "",
  terminalAction,
  source = "blocked_run",
} = {}) {
  const closed = await closeWorkflowRun({
    projectRoot,
    runId: active?.runId,
    status: terminalAction.status,
    reason: String(answer ?? terminalAction.message ?? "").trim() || terminalAction.message,
    source,
  });
  safeAppendEntry(pi, "aipi.input.route", {
    schema: "aipi.input-route.v1",
    routed_at: new Date().toISOString(),
    input: terminalAction.code,
    active_run_id: active?.runId ?? null,
    result_action: terminalAction.status,
    recorded_user_input: Boolean(answer),
    active_cleared: true,
  });
  safeNotify(ctx, terminalAction.message, terminalAction.status === "cancelled" ? "warning" : "info");
  return {
    action: "handled",
    run: closed,
  };
}

function hasPickerUi(ctx, activeRun) {
  return Boolean(
    ctx?.hasUI === true &&
      typeof ctx?.ui?.select === "function" &&
      normalizeBlockerOptions(activeRun?.state?.awaiting_user_input?.options).length > 0,
  );
}

function activeRunFromWorkflowCommandResult(result) {
  if (result?.execution?.runId && result?.execution?.state) {
    return { runId: result.execution.runId, state: result.execution.state };
  }
  if (result?.active?.runId && result?.active?.state) {
    return result.active;
  }
  if (result?.run?.runId && result?.execution?.state) {
    return { runId: result.run.runId, state: result.execution.state };
  }
  return null;
}

function workflowForInput(normalized) {
  if (isReadOnlyCheckQuestion(normalized)) {
    return "check";
  }

  if (/\b(deploy|deployment|rollback|release|producao|prod|homolog|homologacao|infra|ci|cd|pipeline)\b/.test(normalized)) {
    return "ops";
  }

  if (/\b(bug|bugfix|corrigir|corrige|corrija|consertar|conserta|erro|falha|quebrou|defeito|regressao)\b/.test(normalized)) {
    return "bugfix";
  }

  if (/\b(pesquisa|pesquisar|research|investigar|descobrir|comparar)\b/.test(normalized) ||
    /\b(ver|olhar|checar|validar|verificar)\b.*\b(docs?|documentacao|pacote|api|sdk|provider|provedor)\b/.test(normalized)) {
    return "research";
  }

  if (/\b(planejar|planejamento|plano|backlog|kanban|requisito|requisitos|bdd|contrato|regra de negocio|regras de negocio|analise de requisito|conflito de regra)\b/.test(normalized)) {
    return "planning";
  }

  if (/\b(review|revisao|revisar|adversarial|critica|auditoria)\b/.test(normalized)) {
    return "planning";
  }

  if (/\b(feature|funcionalidade|implementar|implementa|adicionar|adiciona|criar|nova tela|novo fluxo|construir)\b/.test(normalized)) {
    return "feature";
  }

  if (/\b(quick|ajuste rapido|mudanca pequena|pequeno ajuste|alteracao simples|fix simples)\b/.test(normalized)) {
    return "quick";
  }

  return null;
}

// Project instruction files the agent is pointed to every turn. These are PROJECT-authored (the engine
// ships templates but never hardcodes content) — including procedures.md, the home of the project's own
// "Definition of Done" / close-out (how THIS project finishes a task: tests, PR, CI, merge…). The engine
// only delivers whatever the project wrote; it prescribes nothing project-specific.
const PROJECT_GUIDANCE_REFS = Object.freeze([
  ".aipi/memory/project/project.md",
  ".aipi/memory/project/procedures.md",
  ".aipi/memory/project/business-rules.md",
  ".aipi/memory/project/decisions.md",
]);

// Surface the active multi-task plan on the HOST turn so advancing to the plan's OWN next task reads as
// "continue to the next step", not a new-scope gate — the missing signal that let the agent frame "start the
// next already-planned ticket" as fresh scope and end the turn asking permission. A plan is surfaced only once
// it is PAST discovery (settled): before settle its spec is not locked, so its tasks are not yet authorized to
// execute. Best-effort: any read error (or no active/pending plan) yields null and the pointer omits the line.
async function buildActivePlanPointer(projectRoot) {
  const active = await readActivePlan(projectRoot).catch(() => null);
  if (!active?.plan) return null;
  const { planId, plan } = active;
  if (plan.status === "discovery") return null;
  const pending = (plan.tasks ?? []).filter((task) => task.status === "pending");
  if (!pending.length) return null;
  const next = pending[0];
  return {
    plan_id: planId,
    status: plan.status,
    execution_cadence: normalizeExecutionCadence(plan.execution_cadence),
    pending_count: pending.length,
    next_task: { task_id: next.task_id, text: String(next.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160) },
  };
}

export async function handleBeforeAgentStart({ event, ctx, pi, projectRoot, coordinator = null }) {
  // Gate on install like the sibling hooks — without this the guidance pointer was injected into EVERY
  // project, including non-AIPI repos (pointing at a .aipi/memory/project/procedures.md that doesn't exist).
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  // New turn — clear the finish-audit dedupe so a fresh "fixed without evidence" claim can surface once.
  lastSurfacedClaimWarning.delete(projectRoot);
  const snapshot = await buildRunSnapshot(projectRoot);
  const hostBlock = await blockUnsupportedHostTurn({
    hook: "before_agent_start",
    event,
    ctx,
    pi,
    projectRoot,
    coordinator,
    snapshot,
  });
  if (hostBlock) return hostBlock;
  await captureCoordinatorHostModel({
    coordinator,
    event,
    ctx,
    source: "before_agent_start",
  });
  await recordLifecycleEvent({
    projectRoot,
    hook: "before_agent_start",
    event: {
      prompt_chars: String(event?.prompt ?? "").length,
      has_images: Boolean(event?.images?.length),
    },
    snapshot,
  });
  // Read once; used by both the flexible and active-run pointer payloads below.
  const planPointer = await buildActivePlanPointer(projectRoot);
  if (!snapshot.active) {
    // Flexible flow (no forced workflow): give the agent the project's guidance — conventions, procedures,
    // and the project's own DEFINITION OF DONE — so it carries the task through to the project's close-out
    // (tests / PR / CI / merge exactly as the PROJECT defines, nothing hardcoded) — plus the most recent run
    // so it can answer follow-ups. The code graph is NOT auto-queried here: it is a PULL tool the agent calls
    // when it actually needs impact analysis (aipi_impact/aipi_retrieve — see the guidance), not a per-turn
    // push that runs even on a "yes/no" reply.
    const recent = await buildRecentRunSummary(projectRoot).catch(() => null);
    const details = {
      schema: "aipi.context-pointer.v1",
      run: snapshot,
      memory_refs: PROJECT_GUIDANCE_REFS,
      active_disciplines: [],
      recent_run: recent,
      plan: planPointer,
    };
    safeAppendEntry(pi, "aipi.context.pointer", details);
    return {
      message: {
        customType: "aipi.context-pointer",
        display: false,
        content: renderContextPointer(details),
        details,
      },
    };
  }

  const activeDisciplines = await loadAndRecordActiveDisciplines({
    projectRoot,
    snapshot,
    event,
    ctx,
    pi,
    hook: "before_agent_start",
  });
  const details = {
    schema: "aipi.context-pointer.v1",
    run: snapshot,
    memory_refs: PROJECT_GUIDANCE_REFS,
    active_disciplines: activeDisciplines,
    plan: planPointer,
  };
  safeAppendEntry(pi, "aipi.context.pointer", details);
  return {
    message: {
      customType: "aipi.context-pointer",
      display: false,
      content: renderContextPointer(details),
      details,
    },
  };
}

// The context hook is a stateless per-turn filter over the FULL conversation
// history, so truncated_tool_results is a per-call rescan total that grows with
// the session (100, 102, 103…), not "new work this call". Track a watermark per
// project so the log can also report the delta.
const contextTruncationWatermarks = new Map();

export async function handleContext({ event, projectRoot }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const snapshot = await buildRunSnapshot(projectRoot);
  const activeDisciplines = await loadActiveDisciplines({
    projectRoot,
    snapshot,
    event,
    ctx: {},
    hook: "context",
  }).catch(() => []);
  const result = pruneAipiContextMessages(event?.messages ?? [], {
    snapshot,
    activeDisciplines,
  });

  if (!result.modified) return undefined;

  const watermarkKey = `${projectRoot}:${snapshot.run_id ?? "none"}`;
  const previousTruncations = contextTruncationWatermarks.get(watermarkKey) ?? 0;
  const newTruncations = Math.max(0, result.truncatedToolResults - previousTruncations);
  contextTruncationWatermarks.set(watermarkKey, result.truncatedToolResults);

  const entry = {
    schema: "aipi.context-event.v1",
    recorded_at: new Date().toISOString(),
    hook: "context",
    run_id: snapshot.run_id ?? null,
    workflow: snapshot.workflow ?? null,
    step_id: snapshot.step_id ?? null,
    removed_context_pointers: result.removedPointers,
    truncated_tool_results: result.truncatedToolResults,
    new_truncations_this_call: newTruncations,
    injected_context_pointer: result.injectedPointer,
    injection_candidates_evaluated: result.injectionCandidatesEvaluated,
    message_count_before: result.beforeCount,
    message_count_after: result.messages.length,
  };
  await appendRuntimeEvent(projectRoot, CONTEXT_EVENT_LOG, entry);
  if (snapshot.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "context-events.jsonl"), entry);
  }
  return { messages: result.messages };
}

export async function handleDisciplineHook({ event, ctx, pi, projectRoot, hook }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const snapshot = await buildRunSnapshot(projectRoot);
  await loadAndRecordActiveDisciplines({ projectRoot, snapshot, event, ctx, pi, hook });
  return undefined;
}

// Per-project counters of message_end audits since the last turn boundary.
// turn_end/agent_end collapse into ONE summary record instead of re-auditing
// the same text message_end already covered (field evidence: 97% of a 15MB
// audit log was duplicate pass records that could never warn).
const disciplineAuditTurnCounters = new Map();

export async function handleEndDisciplineAudit({ event, ctx, pi, projectRoot, hook }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  if (hook === "message_end") {
    // Non-assistant messages (tool results, custom pointers, user text) can
    // never warn — skip the snapshot and any persistence outright.
    const role = event?.message?.role ?? event?.role ?? null;
    if (role !== "assistant") return undefined;
  }
  const snapshot = await buildRunSnapshot(projectRoot);
  const activeDisciplines = await loadAndRecordActiveDisciplines({ projectRoot, snapshot, event, ctx, pi, hook });

  if (hook === "turn_end" || hook === "agent_end") {
    const counters = disciplineAuditTurnCounters.get(projectRoot) ?? { pass_count: 0, warn_count: 0 };
    disciplineAuditTurnCounters.delete(projectRoot);
    const summary = {
      schema: "aipi.end-discipline-audit-summary.v1",
      audited_at: new Date().toISOString(),
      hook,
      run_id: snapshot.run_id ?? null,
      workflow: snapshot.workflow ?? null,
      step_id: snapshot.step_id ?? null,
      agent_id: eventAgentId(event, ctx),
      active_disciplines: activeDisciplines.map((discipline) => discipline.id),
      pass_count: counters.pass_count,
      warn_count: counters.warn_count,
    };
    safeAppendEntry(pi, "aipi.discipline.end_audit", summary);
    await appendRuntimeEvent(projectRoot, DISCIPLINE_AUDIT_LOG, summary);
    if (snapshot.active) await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "discipline-audit.jsonl"), summary);
    return undefined;
  }

  const audit = auditEndDisciplineEvent({ event, hook, activeDisciplines });
  const entry = {
    schema: "aipi.end-discipline-audit.v1",
    audited_at: new Date().toISOString(),
    hook,
    run_id: snapshot.run_id ?? null,
    workflow: snapshot.workflow ?? null,
    step_id: snapshot.step_id ?? null,
    agent_id: eventAgentId(event, ctx),
    active_disciplines: activeDisciplines.map((discipline) => discipline.id),
    ...audit,
  };
  const counters = disciplineAuditTurnCounters.get(projectRoot) ?? { pass_count: 0, warn_count: 0 };
  if (audit.state === "pass") counters.pass_count += 1;
  else counters.warn_count += 1;
  disciplineAuditTurnCounters.set(projectRoot, counters);
  // Persist the full record only when it carries signal: a non-pass state or an
  // actually-active discipline. Plain pass-with-no-disciplines only increments
  // the per-turn counter above.
  if (audit.state !== "pass" || activeDisciplines.length > 0) {
    safeAppendEntry(pi, "aipi.discipline.end_audit", entry);
    await appendRuntimeEvent(projectRoot, DISCIPLINE_AUDIT_LOG, entry);
    if (snapshot.active) await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "discipline-audit.jsonl"), entry);
  }
  // B2 — the flexible-agent finish gate (anti-self-deception). Pi's message_end hook cannot hard-block the
  // main agent (only the forked-worker step-result gate can, via verifyWorkerPassEvidence), so instead of
  // recording the claim-evidence audit silently we SURFACE it: a "fixed/passed/done" claim with no evidence
  // rung (a real command/test/artifact) now warns the user, so an unverified "it works" can't pass unseen.
  if (hook === "message_end" && audit.state === "warn" && audit.message) {
    if (lastSurfacedClaimWarning.get(projectRoot) !== audit.message) {
      lastSurfacedClaimWarning.set(projectRoot, audit.message);
      safeNotify(ctx, audit.message, "warning");
    }
  }
  return undefined;
}

export async function handleModelSelect({ event, ctx, pi, projectRoot, coordinator = null }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const hostBlock = await blockUnsupportedHostTurn({
    hook: "model_select",
    event,
    ctx,
    pi,
    projectRoot,
    coordinator,
  });
  if (hostBlock) return hostBlock;
  let routing = await resolveLifecycleModelRoute({ event, ctx, projectRoot, hook: "model_select" });
  if (routing.status !== "manual_model_preserved" && modelCapabilityFloorBlocks(routing)) {
    await captureCoordinatorHostModel({
      coordinator,
      event,
      ctx,
      source: "model_select_blocked",
    });
    routing = {
      ...routing,
      status: "blocked_capability_floor",
      warning: modelCapabilityBlockWarning(routing),
    };
    await recordModelRoutingDecision({ projectRoot, routing });
    safeNotify(ctx, routing.warning.message, "error");
    return {
      model: null,
      model_class: routing.model_class,
      modelClass: routing.model_class,
      source: routing.source,
      thinking_level: null,
      thinkingLevel: null,
      warning: routing.warning,
      blocked: true,
      block_reason: routing.warning.code,
      capability_report: routing.capability_report ?? null,
      status: routing.status,
    };
  }
  await recordModelRoutingDecision({ projectRoot, routing });
  if (routing.warning) safeNotify(ctx, routing.warning.message, routing.warning.severity === "error" ? "error" : "warning");
  if (routing.status === "manual_model_preserved") {
    await captureCoordinatorHostModel({
      coordinator,
      event,
      ctx,
      routing: { ...routing, model: routing.manual_selection?.model ?? null },
      source: "model_select_manual_preserved",
    });
    return undefined;
  }
  await captureCoordinatorHostModel({
    coordinator,
    event,
    ctx,
    routing,
    source: "model_select",
  });
  if (!routing.model) return undefined;

  const modelResult = await safeSetModel(pi, routing.model);
  const thinkingResult = routing.thinking_level ? await safeSetThinkingLevel(pi, routing.thinking_level) : null;
  if (modelResult?.error || thinkingResult?.error) {
    safeNotify(
      ctx,
      `AIPI model routing applied by return value; Pi setter failed: ${modelResult?.error ?? thinkingResult?.error}`,
      "warning",
    );
  }
  return {
    model: routing.model,
    model_class: routing.model_class,
    modelClass: routing.model_class,
    source: routing.source,
    thinking_level: routing.thinking_level,
    thinkingLevel: routing.thinking_level,
    warning: routing.warning,
  };
}

export async function captureCoordinatorHostModel({
  coordinator = null,
  event = null,
  ctx = null,
  routing = null,
  source = "unknown",
} = {}) {
  if (typeof coordinator?.setHostModel !== "function") return null;
  const model = await resolveHostModelCandidate({ event, ctx, routing });
  if (!model) return null;
  coordinator.setHostModel(model);
  return {
    source,
    model,
    model_id: describeModel(model),
  };
}

async function resolveHostModelCandidate({ event = null, ctx = null, routing = null } = {}) {
  const asyncCandidates = [
    routing?.model,
    event?.applied_model,
    event?.appliedModel,
    event?.resolved_model,
    event?.resolvedModel,
    event?.current_model,
    event?.currentModel,
    event?.selected_model,
    event?.selectedModel,
    event?.model,
    event?.payload?.model,
    ctx?.model,
    ctx?.current_model,
    ctx?.currentModel,
    ctx?.selected_model,
    ctx?.selectedModel,
    ctx?.session?.model,
    ctx?.session?.current_model,
    ctx?.session?.currentModel,
    safeCallHostModelGetter(ctx?.getModel, ctx),
    safeCallHostModelGetter(ctx?.session?.getModel, ctx?.session),
    safeCallHostModelGetter(ctx?.sessionManager?.getModel, ctx?.sessionManager),
  ];
  for (const candidate of asyncCandidates) {
    const model = normalizeHostModelCandidate(await candidate);
    if (model) return model;
  }
  return null;
}

async function safeCallHostModelGetter(fn, receiver) {
  if (typeof fn !== "function") return null;
  try {
    return await fn.call(receiver);
  } catch {
    return null;
  }
}

function normalizeHostModelCandidate(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "host-default") return null;
    return normalizeModelRef(trimmed);
  }
  if (typeof value !== "object") return null;
  const provider = value.provider ?? value.family ?? null;
  const id = value.id ?? value.model ?? value.name ?? null;
  if (provider && id) return { provider, id };
  if (id && id !== "host-default") return String(id);
  if (provider && provider !== "host-default") return String(provider);
  return null;
}

function modelCapabilityFloorBlocks(routing) {
  const state = routing?.capability_report?.state ?? null;
  return Boolean(
    routing?.model &&
      ["missing_registry", "missing_model_capabilities", "fail"].includes(state),
  );
}

function modelCapabilityBlockWarning(routing) {
  const state = routing?.capability_report?.state ?? "unknown";
  const modelClass = routing?.model_class ?? "unknown";
  const resolvedModelId = routing?.model_id ?? describeModel(routing?.model);
  return {
    code: state === "fail" ? "AIPI_MODEL_CAPABILITY_FLOOR_UNMET" : "AIPI_MODEL_CAPABILITY_UNPROVEN",
    severity: "error",
    message: `AIPI model class "${modelClass}" resolved to "${resolvedModelId}" but its capability_floor is not proven; refusing model_select.`,
    model_class: modelClass,
    model_resolved: resolvedModelId,
    capability_state: state,
    unmet: routing?.capability_report?.unmet ?? [],
    missing: routing?.capability_report?.missing ?? [],
  };
}

export async function handleThinkingLevelSelect({ event, ctx, pi, projectRoot }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const routing = await resolveLifecycleModelRoute({ event, ctx, projectRoot, hook: "thinking_level_select" });
  await recordModelRoutingDecision({ projectRoot, routing });
  if (routing.warning) safeNotify(ctx, routing.warning.message, routing.warning.severity === "error" ? "error" : "warning");
  if (routing.status === "manual_thinking_preserved") return undefined;
  if (!routing.thinking_level) return undefined;

  const thinkingResult = await safeSetThinkingLevel(pi, routing.thinking_level);
  if (thinkingResult?.error) {
    safeNotify(ctx, `AIPI thinking-level routing applied by return value; Pi setter failed: ${thinkingResult.error}`, "warning");
  }
  return {
    thinking_level: routing.thinking_level,
    thinkingLevel: routing.thinking_level,
    model_class: routing.model_class,
    modelClass: routing.model_class,
    source: routing.source,
    warning: routing.warning,
  };
}

export async function resolveLifecycleModelRoute({ event, ctx, projectRoot, hook = "model_select" } = {}) {
  const snapshot = await buildRunSnapshot(projectRoot);
  const modelContext = buildLifecycleModelContext(event, ctx);
  const currentModel = currentModelFromEvent(event, ctx);
  const env = event?.env ?? process.env;
  const selector = {
    model_class: eventModelClass(event, ctx),
    agent_id: eventAgentId(event, ctx),
    source: null,
  };

  let resolution = null;
  let step = null;
  if (selector.model_class) {
    selector.source = "event_model_class";
    resolution = await resolveModelClass({ root: projectRoot, modelClass: selector.model_class, ctx: modelContext, env });
  } else if (selector.agent_id) {
    selector.source = "event_agent";
    step = { id: event?.step_id ?? event?.stepId ?? snapshot.step_id ?? null, agents: [selector.agent_id] };
    resolution = await resolveStepModel({ root: projectRoot, step, ctx: modelContext, env });
  } else {
    step = await activeWorkflowStepForRouting(projectRoot, snapshot);
    if (step) {
      selector.source = "active_workflow_step";
      selector.agent_id = step.agents?.[0] ?? null;
      resolution = await resolveStepModel({ root: projectRoot, step, ctx: modelContext, env });
    }
  }

  if (!resolution) {
    return {
      schema: "aipi.model-route.v1",
      hook,
      status: "no_context",
      snapshot,
      selector,
      step_id: snapshot.step_id ?? null,
      agent_id: selector.agent_id,
      model_class: null,
      model: null,
      model_id: null,
      thinking_level: null,
      source: "none",
      preferred_families: [],
      current_model: describeModel(normalizeModelRef(currentModel)),
      warning: null,
    };
  }

  const resolvedModelId = describeModel(resolution.model);
  const currentModelId = describeModel(normalizeModelRef(currentModel));
  const manualSelection = manualLifecycleSelection({
    hook,
    selector,
    resolution,
    currentModel,
    currentModelId,
    event,
    ctx,
  });
  const warning = manualSelection ? null : modelRoutingWarning({
    modelClass: resolution.model_class,
    resolvedModelId,
    currentModelId,
    source: resolution.source,
    preferredFamilies: resolution.preferred_families,
    familyWarning: resolution.family_warning,
    capabilityReport: resolution.capability_report,
  });
  const capabilityState = resolution.capability_report?.state ?? null;
  const routedStatus = resolvedModelId
    ? warning?.code === "AIPI_MODEL_MANUAL_DRIFT"
      ? "routed_with_drift"
      : ["missing_registry", "missing_model_capabilities", "fail"].includes(capabilityState)
      ? "needs_capability_evidence"
      : "routed"
    : "needs_configured_model";
  return {
    schema: "aipi.model-route.v1",
    hook,
    status: manualSelection?.status ?? routedStatus,
    snapshot,
    selector,
    step_id: step?.id ?? snapshot.step_id ?? null,
    agent_id: selector.agent_id,
    model_class: resolution.model_class,
    model: resolution.model,
    model_id: resolvedModelId,
    thinking_level: resolution.thinking_level ?? null,
    source: resolution.source,
    preferred_families: resolution.preferred_families ?? [],
    family_warning: resolution.family_warning ?? null,
    capability_report: resolution.capability_report ?? null,
    current_model: currentModelId,
    warning,
    manual_selection: manualSelection,
  };
}

export async function handleBeforeTree({ event, pi, projectRoot }) {
  const handoff = await writeRunHandoffSnapshot({
    projectRoot,
    hook: "session_before_tree",
    event: {
      targetId: event?.preparation?.targetId ?? null,
      oldLeafId: event?.preparation?.oldLeafId ?? null,
      commonAncestorId: event?.preparation?.commonAncestorId ?? null,
      userWantsSummary: Boolean(event?.preparation?.userWantsSummary),
    },
    pi,
  });
  if (!handoff?.snapshot?.active || !event?.preparation?.userWantsSummary) {
    return undefined;
  }
  return {
    customInstructions: renderTreeInstructions(handoff.snapshot),
    replaceInstructions: false,
    label: `AIPI ${handoff.snapshot.workflow}`,
  };
}

export async function handleUserBash({ event, ctx, pi, projectRoot }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const snapshot = await buildRunSnapshot(projectRoot);
  await loadAndRecordActiveDisciplines({ projectRoot, snapshot, event, ctx, pi, hook: "user_bash" });
  return undefined;
}

export async function handleToolResult({ event, projectRoot }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const snapshot = await buildRunSnapshot(projectRoot);
  const { content, redacted, excerpt } = redactToolResultContent(event?.content ?? []);
  const entry = {
    schema: "aipi.tool-result-record.v1",
    recorded_at: new Date().toISOString(),
    hook: "tool_result",
    run_id: snapshot.run_id ?? null,
    workflow: snapshot.workflow ?? null,
    step_id: snapshot.step_id ?? null,
    tool_call_id: event?.toolCallId ?? null,
    tool_name: event?.toolName ?? null,
    is_error: Boolean(event?.isError),
    redacted,
    content_excerpt: excerpt,
  };
  await appendRuntimeEvent(projectRoot, TOOL_RESULT_LOG, entry);
  if (snapshot.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "tool-results.jsonl"), entry);
  }
  return redacted ? { content } : undefined;
}

export async function handleBeforeProviderRequest({ event, projectRoot }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const snapshot = await buildRunSnapshot(projectRoot);
  const policy = applyProviderPayloadPolicy(event?.payload, { snapshot });
  const budget = await buildProviderBudgetReport({ projectRoot, usage: providerUsageIdentity(event) });
  const entry = {
    schema: "aipi.provider-event.v1",
    recorded_at: new Date().toISOString(),
    hook: "before_provider_request",
    run_id: snapshot.run_id ?? null,
    workflow: snapshot.workflow ?? null,
    step_id: snapshot.step_id ?? null,
    payload: summarizeProviderPayload(policy.payload),
    policy: {
      modified: policy.modified,
      redacted_secrets: policy.redactedSecrets,
      removed_context_pointers: policy.removedPointers,
      truncated_tool_results: policy.truncatedToolResults,
    },
    budget,
  };
  await appendProviderEvent(projectRoot, snapshot, entry);
  if (budget) await appendProviderBudget(projectRoot, snapshot, budget);
  return policy.modified ? policy.payload : undefined;
}

export async function handleAfterProviderResponse({ event, projectRoot }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const snapshot = await buildRunSnapshot(projectRoot);
  const usage = normalizeProviderUsage(event);
  if (!usage) providerUsageHealthFor(projectRoot).nullResponses += 1;
  const rateLimit = parseUnifiedRateLimitHeaders(event?.headers ?? {});
  if (rateLimit) {
    const state = providerRateLimitState.get(projectRoot) ?? { warned: new Set() };
    state.parsed = rateLimit;
    providerRateLimitState.set(projectRoot, state);
  }
  const pricing = usage ? await loadProviderPricing(projectRoot) : null;
  const estimatedCost = usage && usage.cost_usd == null ? estimateProviderUsageCost(usage, pricing) : null;
  const usageForBudget = usage ? usageWithEstimatedCost(usage, estimatedCost) : null;
  const budget = usageForBudget ? await buildProviderBudgetReport({ projectRoot, usage: usageForBudget }) : null;
  const entry = {
    schema: "aipi.provider-event.v1",
    recorded_at: new Date().toISOString(),
    hook: "after_provider_response",
    run_id: snapshot.run_id ?? null,
    workflow: snapshot.workflow ?? null,
    step_id: snapshot.step_id ?? null,
    status: event?.status ?? null,
    headers: safeProviderHeaders(event?.headers ?? {}),
    rate_limit: rateLimit,
    usage: usageForBudget,
    budget,
  };
  await appendProviderEvent(projectRoot, snapshot, entry);
  if (usage) {
    await appendProviderUsage(projectRoot, snapshot, {
      schema: "aipi.provider-usage.v1",
      recorded_at: entry.recorded_at,
      run_id: snapshot.run_id ?? null,
      workflow: snapshot.workflow ?? null,
      step_id: snapshot.step_id ?? null,
      provider: usage.provider,
      model: usage.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      cost_usd: usage.cost_usd ?? estimatedCost?.cost_usd ?? null,
      cost_source: usage.cost_usd != null ? usage.source : estimatedCost?.source ?? null,
      pricing_ref: estimatedCost?.pricing_ref ?? null,
      pricing_checked_at: estimatedCost?.pricing_checked_at ?? null,
      pricing_source_url: estimatedCost?.pricing_source_url ?? null,
      source: usage.source,
    });
  }
  if (budget) await appendProviderBudget(projectRoot, snapshot, budget);
  return undefined;
}

export function estimateProviderUsageCost(usage, pricing, { now = new Date() } = {}) {
  if (!usage || !pricing?.rates) return null;
  const rate = providerPricingRateForUsage(usage, pricing, { now });
  if (!rate) return null;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);
  const inputRate = numberOrNull(rate.input_per_million_tokens ?? rate.inputPerMillionTokens);
  const outputRate = numberOrNull(rate.output_per_million_tokens ?? rate.outputPerMillionTokens);
  const totalRate = numberOrNull(rate.total_per_million_tokens ?? rate.totalPerMillionTokens);
  let cost = 0;
  if (inputRate != null || outputRate != null) {
    cost += ((inputTokens ?? 0) / 1_000_000) * (inputRate ?? 0);
    cost += ((outputTokens ?? 0) / 1_000_000) * (outputRate ?? 0);
  } else if (totalRate != null) {
    cost += ((totalTokens ?? 0) / 1_000_000) * totalRate;
  } else {
    return null;
  }
  return {
    cost_usd: Number(cost.toFixed(8)),
    source: "aipi_provider_pricing",
    pricing_ref: rate.key,
    pricing_checked_at: rate.checked_at ?? null,
    pricing_source_url: rate.source_url ?? null,
  };
}

export function validateProviderPricingConfig(pricing, { now = new Date(), requireRates = false } = {}) {
  const errors = [];
  const warnings = [];
  const rates = pricing?.rates;
  const entries = rates && typeof rates === "object" && !Array.isArray(rates)
    ? Object.entries(rates)
    : [];
  const freshRates = [];

  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
    return {
      schema: "aipi.provider-pricing-validation.v1",
      valid: false,
      state: "invalid",
      rate_count: 0,
      fresh_rate_count: 0,
      errors: ["provider-pricing must be a JSON object"],
      warnings,
      fresh_rates: [],
    };
  }
  if (pricing.schema !== "aipi.provider-pricing.v1") {
    errors.push("provider-pricing schema must be aipi.provider-pricing.v1");
  }
  if (!rates || typeof rates !== "object" || Array.isArray(rates)) {
    errors.push("provider-pricing rates must be an object");
  }
  if (!entries.length) {
    warnings.push("provider-pricing has no rates; unpriced provider usage remains cost_unknown");
  }
  if (requireRates && !entries.length) {
    errors.push("provider-pricing requires at least one fresh rate for this check");
  }

  for (const [key, rate] of entries) {
    if (!rate || typeof rate !== "object" || Array.isArray(rate)) {
      errors.push(`${key}: rate must be an object`);
      continue;
    }
    const metadata = providerPricingRateMetadata(rate, pricing);
    const explicitMaxAge = rate.max_age_days ?? rate.maxAgeDays ?? pricing.max_age_days ?? pricing.maxAgeDays;
    const metadataErrors = [];
    if (explicitMaxAge != null && numberOrNull(explicitMaxAge) == null) {
      metadataErrors.push(`${key}: max_age_days must be numeric when provided`);
    }
    const rateErrors = providerPricingRateValidationErrors(key, rate, metadata, now);
    errors.push(...metadataErrors, ...rateErrors);
    if (!metadataErrors.length && !rateErrors.length && providerPricingRateFresh(metadata, now)) {
      freshRates.push(key);
    }
  }

  if (requireRates && !freshRates.length) {
    errors.push("provider-pricing has no fresh usable rates");
  }

  return {
    schema: "aipi.provider-pricing-validation.v1",
    valid: errors.length === 0,
    state: entries.length === 0 ? "empty" : freshRates.length === entries.length ? "fresh" : freshRates.length > 0 ? "partial" : "invalid",
    rate_count: entries.length,
    fresh_rate_count: freshRates.length,
    errors,
    warnings,
    fresh_rates: freshRates,
  };
}

export async function buildProviderBudgetReport({ projectRoot, usage = {} } = {}) {
  const budget = await loadProviderBudget(projectRoot);
  if (!budget) return null;
  const scope = providerBudgetScopeForUsage(usage, budget);
  const spentUsd = await providerSpentUsd({ projectRoot, scope });
  const eventCostUsd = numberOrNull(usage.cost_usd);
  const hasTokenUsage = [usage.input_tokens, usage.output_tokens, usage.total_tokens].some((value) => value != null);
  const costUnknown = eventCostUsd == null && hasTokenUsage;
  const projectedUsd = costUnknown ? null : spentUsd + (eventCostUsd ?? 0);
  const maxUsd = numberOrNull(scope.config?.max_usd ?? scope.config?.maxUsd);
  const warnAtRatio = numberOrNull(scope.config?.warn_at_ratio ?? scope.config?.warnAtRatio) ?? 0.8;
  const ratio = maxUsd && maxUsd > 0 && projectedUsd != null ? projectedUsd / maxUsd : null;
  const state =
    costUnknown
      ? "cost_unknown"
      : maxUsd == null
      ? "unlimited"
      : projectedUsd > maxUsd
      ? "over_budget"
      : ratio != null && ratio >= warnAtRatio
      ? "warning"
      : "ok";
  return {
    schema: "aipi.provider-budget.v1",
    state,
    scope: scope.scope,
    scope_ref: scope.key,
    provider: stringOrNull(usage.provider),
    model: stringOrNull(usage.model),
    spent_usd: Number(spentUsd.toFixed(8)),
    event_cost_usd: eventCostUsd == null ? null : Number(eventCostUsd.toFixed(8)),
    projected_usd: projectedUsd == null ? null : Number(projectedUsd.toFixed(8)),
    max_usd: maxUsd,
    warn_at_ratio: warnAtRatio,
    ratio: ratio == null ? null : Number(ratio.toFixed(6)),
    cost_status: costUnknown ? "unknown_no_rate" : "known",
    budget_ref: PROVIDER_BUDGET_REL_PATH,
  };
}

export function normalizeProviderUsage(event = {}) {
  const usage =
    event.usage ??
    event.tokenUsage ??
    event.response?.usage ??
    event.response?.tokenUsage ??
    event.body?.usage ??
    event.body?.tokenUsage ??
    null;
  const inputTokens = numberOrNull(
    usage?.input_tokens ??
      usage?.inputTokens ??
      usage?.prompt_tokens ??
      usage?.promptTokens ??
      usage?.cache_creation_input_tokens ??
      event.input_tokens ??
      event.inputTokens,
  );
  const outputTokens = numberOrNull(
    usage?.output_tokens ??
      usage?.outputTokens ??
      usage?.completion_tokens ??
      usage?.completionTokens ??
      event.output_tokens ??
      event.outputTokens,
  );
  const totalTokens = numberOrNull(
    usage?.total_tokens ??
      usage?.totalTokens ??
      event.total_tokens ??
      event.totalTokens ??
      (inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null),
  );
  const costUsd = numberOrNull(
    usage?.cost_usd ??
      usage?.costUsd ??
      usage?.estimated_cost_usd ??
      usage?.estimatedCostUsd ??
      event.cost_usd ??
      event.costUsd,
  );
  if (inputTokens == null && outputTokens == null && totalTokens == null && costUsd == null) return null;
  return {
    provider: stringOrNull(event.provider ?? event.providerId ?? event.response?.provider ?? event.body?.provider),
    model: stringOrNull(event.model ?? event.response?.model ?? event.body?.model ?? event.payload?.model),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    source: usage ? "provider_usage" : "event_fields",
  };
}

// Pi delivers token usage on the finalized assistant message (message_end), not
// on the after_provider_response HTTP hook — for streaming requests that hook
// carries only status+headers, so normalizeProviderUsage returns null on every
// one of them (field evidence: 6,303/6,303 responses with usage:null while every
// assistant session entry carried a full usage block). Normalize the Pi message
// shape ({input, output, cacheRead, cacheWrite, cost:{total}}) here.
export function normalizePiMessageEndUsage(event = {}) {
  const message = event?.message ?? null;
  if ((message?.role ?? null) !== "assistant") return null;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = numberOrNull(usage.input ?? usage.inputTokens ?? usage.input_tokens);
  const outputTokens = numberOrNull(usage.output ?? usage.outputTokens ?? usage.output_tokens);
  const cacheReadTokens = numberOrNull(usage.cacheRead ?? usage.cache_read_input_tokens ?? usage.cache_read);
  const cacheWriteTokens = numberOrNull(usage.cacheWrite ?? usage.cache_creation_input_tokens ?? usage.cache_write);
  const totalTokens = numberOrNull(
    usage.totalTokens ??
      usage.total_tokens ??
      (inputTokens != null || outputTokens != null
        ? (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
        : null),
  );
  const costUsd = numberOrNull(usage.cost?.total ?? usage.cost_usd ?? usage.costUsd);
  if (inputTokens == null && outputTokens == null && totalTokens == null && costUsd == null) return null;
  return {
    provider: stringOrNull(message.provider ?? event.provider),
    model: stringOrNull(message.model ?? event.model),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    cost_usd: costUsd,
    source: "pi_message_usage",
  };
}

export function parseUnifiedRateLimitHeaders(headers = {}) {
  const lower = {};
  for (const [key, value] of Object.entries(headers ?? {})) lower[key.toLowerCase()] = value;
  // Header values arrive as strings — coerce before the numeric checks.
  const headerNumber = (value) => {
    const numeric = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
    return Number.isFinite(numeric) ? numeric : null;
  };
  const utilization5h = headerNumber(lower["anthropic-ratelimit-unified-5h-utilization"]);
  const utilization7d = headerNumber(lower["anthropic-ratelimit-unified-7d-utilization"]);
  const overageStatus = stringOrNull(lower["anthropic-ratelimit-unified-overage-status"]);
  const overageDisabledReason = stringOrNull(lower["anthropic-ratelimit-unified-overage-disabled-reason"]);
  const unifiedStatus = stringOrNull(lower["anthropic-ratelimit-unified-status"]);
  if (utilization5h == null && utilization7d == null && !overageStatus && !overageDisabledReason && !unifiedStatus) {
    return null;
  }
  return {
    utilization_5h: utilization5h,
    utilization_7d: utilization7d,
    overage_status: overageStatus,
    overage_disabled_reason: overageDisabledReason,
    status: unifiedStatus,
  };
}

const PROVIDER_USAGE_INACTIVE_THRESHOLD = 20;
const RATE_LIMIT_WARN_UTILIZATION = 0.85;
const providerUsageHealth = new Map(); // projectRoot -> { nullResponses, captured, warnedInactive }
const providerRateLimitState = new Map(); // projectRoot -> { parsed, warned: Set }

function providerUsageHealthFor(projectRoot) {
  let health = providerUsageHealth.get(projectRoot);
  if (!health) {
    health = { nullResponses: 0, captured: 0, warnedInactive: false };
    providerUsageHealth.set(projectRoot, health);
  }
  return health;
}

function surfaceRateLimitWarnings({ ctx, projectRoot }) {
  const state = providerRateLimitState.get(projectRoot);
  if (!state?.parsed) return;
  const parsed = state.parsed;
  state.warned ??= new Set();
  if (parsed.overage_disabled_reason === "out_of_credits") {
    if (!state.warned.has("out_of_credits")) {
      state.warned.add("out_of_credits");
      safeNotify(ctx, "AIPI provider quota: overage disabled (out_of_credits) — provider requests may start failing.", "warning");
    }
  } else {
    state.warned.delete("out_of_credits");
  }
  const utilization = Math.max(parsed.utilization_5h ?? 0, parsed.utilization_7d ?? 0);
  if (utilization >= RATE_LIMIT_WARN_UTILIZATION) {
    if (!state.warned.has("utilization")) {
      state.warned.add("utilization");
      const window = (parsed.utilization_5h ?? 0) >= (parsed.utilization_7d ?? 0) ? "5h" : "7d";
      safeNotify(ctx, `AIPI provider quota: rate-limit utilization at ${Math.round(utilization * 100)}% of the ${window} window.`, "warning");
    }
  } else if (utilization < 0.8) {
    state.warned.delete("utilization");
  }
}

export async function recordProviderUsageFromMessageEnd({ event, ctx = null, projectRoot }) {
  if (!(await isAipiInstalled(projectRoot))) return null;
  const health = providerUsageHealthFor(projectRoot);
  const usage = normalizePiMessageEndUsage(event);
  if (!usage) {
    if (!health.warnedInactive && health.captured === 0 && health.nullResponses >= PROVIDER_USAGE_INACTIVE_THRESHOLD) {
      health.warnedInactive = true;
      safeNotify(
        ctx,
        `AIPI usage tracking inactive: ${health.nullResponses} provider responses carried no usage metadata and no assistant message exposed usage — token/cost reporting is off.`,
        "warning",
      );
    }
    return null;
  }
  health.captured += 1;
  const snapshot = await buildRunSnapshot(projectRoot).catch(() => ({ active: false }));
  const pricing = usage.cost_usd == null ? await loadProviderPricing(projectRoot) : null;
  const estimatedCost = usage.cost_usd == null ? estimateProviderUsageCost(usage, pricing) : null;
  await appendProviderUsage(projectRoot, snapshot, {
    schema: "aipi.provider-usage.v1",
    recorded_at: new Date().toISOString(),
    run_id: snapshot?.run_id ?? null,
    workflow: snapshot?.workflow ?? null,
    step_id: snapshot?.step_id ?? null,
    provider: usage.provider,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    cost_usd: usage.cost_usd ?? estimatedCost?.cost_usd ?? null,
    cost_source: usage.cost_usd != null ? usage.source : estimatedCost?.source ?? null,
    pricing_ref: estimatedCost?.pricing_ref ?? null,
    pricing_checked_at: estimatedCost?.pricing_checked_at ?? null,
    pricing_source_url: estimatedCost?.pricing_source_url ?? null,
    source: usage.source,
  });
  const usageForBudget = usageWithEstimatedCost(usage, estimatedCost);
  const budget = await buildProviderBudgetReport({ projectRoot, usage: usageForBudget }).catch(() => null);
  if (budget) await appendProviderBudget(projectRoot, snapshot, budget);
  surfaceRateLimitWarnings({ ctx, projectRoot });
  return usage;
}

export async function buildRunSnapshot(projectRoot) {
  const active = await readActiveRun(projectRoot).catch(() => null);
  if (!active?.state) {
    return { schema: "aipi.run-snapshot.v1", active: false };
  }
  const state = active.state;
  const step = state.steps?.find((candidate) => candidate.id === state.current_step) ?? null;
  return {
    schema: "aipi.run-snapshot.v1",
    active: true,
    run_id: active.runId,
    workflow: state.workflow ?? null,
    status: state.status ?? null,
    current_step: state.current_step ?? null,
    step_id: step?.id ?? state.current_step ?? null,
    stage: step?.stage ?? null,
    contract_path: state.contract_path ?? null,
    run_rel_dir: state.run_rel_dir ?? path.posix.join(".aipi/runtime/runs", active.runId),
  };
}

// When NO run is active, the assistant otherwise has zero awareness of a workflow that just finished — so a
// follow-up like "did you run tests?" gets answered as if nothing happened ("first message in our
// conversation"). This surfaces the most-recent run (terminal included, within a recency window) so the
// assistant can answer about it and read its step artifacts. Returns null if there is no recent run.
export async function buildRecentRunSummary(projectRoot, { maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  try {
    const runsDir = path.join(projectRoot, ".aipi", "runtime", "runs");
    const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
    // Collect every in-window run by state.json mtime (id order and mtime order can disagree, so a stale
    // lexically-newest run must NOT hide a genuinely recent older-id run). stat is cheap; we only read the
    // candidates' state.json, newest-modified first, until one parses.
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{8}T\d{6}Z-/.test(entry.name)) continue;
      const statePath = path.join(runsDir, entry.name, "state.json");
      const stat = await fs.stat(statePath).catch(() => null);
      if (!stat) continue;
      if (maxAgeMs && now() - stat.mtimeMs > maxAgeMs) continue; // skip stale — don't abort the whole scan
      candidates.push({ runId: entry.name, mtimeMs: stat.mtimeMs, statePath });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates) {
      let state;
      try {
        state = JSON.parse(await fs.readFile(candidate.statePath, "utf8"));
      } catch {
        continue; // corrupt/partially-flushed state.json — fall through to the next most-recent run
      }
      return {
        schema: "aipi.recent-run.v1",
        run_id: candidate.runId,
        workflow: state.workflow ?? null,
        status: state.status ?? null,
        steps: (state.steps ?? []).map((entry) => ({ id: entry.id, status: entry.status ?? null, verdict: entry.verdict ?? null })),
        step_visits: state.step_visits ?? {},
        run_rel_dir: state.run_rel_dir ?? path.posix.join(".aipi/runtime/runs", candidate.runId),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function recentRunStatusNote(status) {
  switch (status) {
    case "completed":
      return "a COMPLETED run";
    case "escalated_to_human":
      return "a run that STOPPED for human review";
    case "blocked":
      return "a BLOCKED run awaiting input";
    case "running":
    case "active":
      return "a run still IN PROGRESS";
    case "abandoned":
    case "cancelled":
      return "an ABANDONED run";
    default:
      return `a run with status ${status ?? "unknown"}`;
  }
}

export function renderRecentRunSummary(summary) {
  const glyphFor = (status) =>
    status === "passed" ? "✓" : status === "failed" ? "✗" : status === "skipped" ? "⊘" : status === "pending" ? "○" : "·";
  const stepLine = (summary.steps ?? [])
    .map((step) => {
      const visits = summary.step_visits?.[step.id];
      const count = visits && visits > 1 ? ` (${visits})` : "";
      return `${glyphFor(step.status)} ${step.id}${count}${step.verdict ? ` ${step.verdict}` : ""}`;
    })
    .join("   ");
  return [
    `AIPI most recent run (${recentRunStatusNote(summary.status)} on disk — NOT a fresh, empty conversation):`,
    `- run_id: ${summary.run_id}`,
    `- workflow: ${summary.workflow}`,
    `- status: ${summary.status}`,
    `- steps: ${stepLine || "(none)"}`,
    `- artifacts: read ${summary.run_rel_dir}/steps/<step>/ for detail (e.g. regression_test, fix, review).`,
    "If the user asks what was done, whether tests/regression ran, why it stopped, or to \"check the kanban\",",
    "answer from this summary and the step artifacts. Do NOT claim this is the first message or that nothing was done.",
  ].join("\n");
}

export function pruneAipiContextMessages(messages = [], {
  snapshot = { active: false },
  activeDisciplines = [],
} = {}) {
  const input = Array.isArray(messages) ? messages : [];
  const contextPointerIndexes = [];
  const aipiToolResultIndexes = [];
  for (const [index, message] of input.entries()) {
    if (isAipiContextPointer(message)) contextPointerIndexes.push(index);
    if (isAipiToolResultMessage(message)) aipiToolResultIndexes.push(index);
  }

  const keepPointerIndex = contextPointerIndexes.at(-1) ?? -1;
  const keepToolResultIndexes = new Set(aipiToolResultIndexes.slice(-KEEP_FULL_AIPI_TOOL_RESULTS));
  let removedPointers = 0;
  let truncatedToolResults = 0;
  const output = [];

  for (const [index, message] of input.entries()) {
    if (contextPointerIndexes.includes(index) && index !== keepPointerIndex) {
      removedPointers += 1;
      continue;
    }

    if (aipiToolResultIndexes.includes(index) && !keepToolResultIndexes.has(index)) {
      const truncated = truncateMessageText(message, MAX_CONTEXT_TOOL_RESULT_CHARS);
      if (truncated.modified) {
        truncatedToolResults += 1;
        output.push(truncated.message);
        continue;
      }
    }
    output.push(message);
  }

  let injectedPointer = false;
  if (snapshot.active && keepPointerIndex < 0 && !output.some(isAipiContextPointer)) {
    const pointer = createContextPointerMessage({ snapshot, activeDisciplines });
    insertAfterLastUser(output, pointer);
    injectedPointer = true;
  }

  return {
    messages: output,
    beforeCount: input.length,
    removedPointers,
    truncatedToolResults,
    injectedPointer,
    // Injection is a safety net for "active run but no pointer anywhere" (e.g.
    // a compaction wiped them). It has never fired in the field because
    // before_agent_start always pre-injects a pointer — count candidates so a
    // real dead-path bug is distinguishable from "condition never arises".
    injectionCandidatesEvaluated: snapshot.active && keepPointerIndex < 0 ? 1 : 0,
    modified: removedPointers > 0 || truncatedToolResults > 0 || injectedPointer,
  };
}

export async function writeRunHandoffSnapshot({
  projectRoot,
  hook,
  event = {},
  pi = null,
  now = () => new Date(),
} = {}) {
  if (!(await isAipiInstalled(projectRoot))) return null;
  const snapshot = await buildRunSnapshot(projectRoot);
  await recordLifecycleEvent({ projectRoot, hook, event, snapshot, now });
  if (!snapshot.active) return { snapshot, path: null };

  const relPath = path.posix.join(snapshot.run_rel_dir, "SESSION-HANDOFF.md");
  const absPath = path.join(projectRoot, relPath);
  const content = renderHandoffMarkdown({ snapshot, hook, event, at: now().toISOString() });
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
  const marker = {
    schema: "aipi.session-handoff-marker.v1",
    hook,
    path: relPath,
    ...snapshot,
  };
  safeAppendEntry(pi, "aipi.run.handoff", marker);
  return { snapshot, path: relPath };
}

export function buildAipiCompactionResult({
  snapshot,
  handoffPath = null,
  preparation = {},
} = {}) {
  const firstKeptEntryId = preparation?.firstKeptEntryId ?? null;
  const tokensBefore = Number.isFinite(preparation?.tokensBefore) ? preparation.tokensBefore : 0;
  return {
    summary: renderAipiCompactionSummary({ snapshot, handoffPath, preparation }),
    firstKeptEntryId,
    tokensBefore,
    details: {
      schema: "aipi.compaction-details.v1",
      run_id: snapshot?.run_id ?? null,
      workflow: snapshot?.workflow ?? null,
      step_id: snapshot?.step_id ?? null,
      handoff_path: handoffPath,
      message_count: Array.isArray(preparation?.messagesToSummarize)
        ? preparation.messagesToSummarize.length
        : 0,
      from_extension: "aipi.lifecycle-hooks",
    },
  };
}

export async function recordLifecycleEvent({
  projectRoot,
  hook,
  event = {},
  snapshot = null,
  now = () => new Date(),
} = {}) {
  if (!(await isAipiInstalled(projectRoot))) return null;
  const entry = {
    schema: "aipi.lifecycle-event.v1",
    recorded_at: now().toISOString(),
    hook,
    run_id: snapshot?.run_id ?? null,
    workflow: snapshot?.workflow ?? null,
    step_id: snapshot?.step_id ?? null,
    event,
  };
  await appendRuntimeEvent(projectRoot, LIFECYCLE_LOG, entry);
  if (snapshot?.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "lifecycle.jsonl"), entry);
  }
  return entry;
}

export async function recordRuntimeError({
  projectRoot,
  hook,
  event = {},
  error,
  expected = false,
  now = () => new Date(),
} = {}) {
  if (!(await isAipiInstalled(projectRoot))) return null;
  const snapshot = await buildRunSnapshot(projectRoot).catch(() => ({ active: false }));
  const entry = {
    schema: "aipi.runtime-error.v1",
    recorded_at: now().toISOString(),
    hook,
    run_id: snapshot?.run_id ?? null,
    workflow: snapshot?.workflow ?? null,
    step_id: snapshot?.step_id ?? null,
    expected,
    event: compactEvent(event),
    // Expected policy decisions carry no stack: the readiness code+message are
    // the diagnosis, and the synthetic stack only bloated the log.
    error: serializeRuntimeError(error, { includeStack: !expected }),
  };
  await appendRuntimeEvent(projectRoot, RUNTIME_ERROR_LOG, entry);
  if (snapshot?.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "errors.jsonl"), entry);
  }
  return entry;
}

export function redactToolResultContent(blocks = []) {
  let redacted = false;
  const content = blocks.map((block) => {
    if (!block || block.type !== "text" || typeof block.text !== "string") return block;
    const text = redactSecrets(block.text);
    if (text !== block.text) redacted = true;
    return { ...block, text };
  });
  const excerpt = content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n")
    .slice(0, MAX_EXCERPT_CHARS);
  return { content, redacted, excerpt };
}

export function summarizeProviderPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { kind: typeof payload };
  }
  const value = payload;
  return {
    kind: "object",
    keys: Object.keys(value).sort(),
    model: stringOrNull(value.model),
    max_tokens: numberOrNull(value.max_tokens ?? value.maxTokens),
    message_count: Array.isArray(value.messages) ? value.messages.length : null,
    tool_count: Array.isArray(value.tools) ? value.tools.length : null,
    has_system: Boolean(value.system),
  };
}

export function applyProviderPayloadPolicy(payload, {
  snapshot = { active: false },
} = {}) {
  const redacted = redactProviderPayloadValue(payload);
  let nextPayload = redacted.value;
  let removedPointers = 0;
  let truncatedToolResults = 0;
  let contextModified = false;

  if (nextPayload && typeof nextPayload === "object" && Array.isArray(nextPayload.messages)) {
    const context = pruneAipiContextMessages(nextPayload.messages, {
      snapshot: { ...snapshot, active: false },
    });
    if (context.modified) {
      nextPayload = { ...nextPayload, messages: context.messages };
      contextModified = true;
      removedPointers = context.removedPointers;
      truncatedToolResults = context.truncatedToolResults;
    }
  }

  return {
    payload: nextPayload,
    modified: redacted.modified || contextModified,
    redactedSecrets: redacted.redacted,
    removedPointers,
    truncatedToolResults,
  };
}

export function safeProviderHeaders(headers = {}) {
  const allowed = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalized = key.toLowerCase();
    if (
      normalized === "retry-after" ||
      normalized.startsWith("x-ratelimit-") ||
      normalized.startsWith("anthropic-ratelimit-")
    ) {
      allowed[normalized] = String(value).slice(0, 200);
    }
  }
  return allowed;
}

function renderContextPointer(details) {
  const run = details.run ?? {};
  const activeDisciplines = details.active_disciplines ?? [];
  const lines = [];
  if (run.active) {
    lines.push(
      "AIPI active run context:",
      `- run_id: ${run.run_id}`,
      `- workflow: ${run.workflow}`,
      `- status: ${run.status}`,
      `- current_step: ${run.current_step ?? "none"}`,
      `- stage: ${run.stage ?? "none"}`,
      `- contract_path: ${run.contract_path ?? "none"}`,
    );
  } else {
    lines.push("AIPI project context (no active workflow run — handle this task as the flexible main agent):");
  }
  lines.push(
    `- memory_refs: ${details.memory_refs.join(", ")}`,
    "- Follow the project's conventions and its DEFINITION OF DONE in .aipi/memory/project/procedures.md and project.md — they define what FINISHED means for THIS project (e.g. how to test, open a PR, watch CI, merge). Do not stop early if the project's procedure requires more.",
    "- Code graph (PULL, not auto): use aipi_impact (what a change affects) / aipi_callers / aipi_retrieve when you actually need impact analysis — before a substantive change to find affected files, at review to check the blast radius, before closing to catch regressions in related files. Skip it for trivial replies.",
    "- Autonomous execution: do NOT end a turn with a cadence/checkpoint/permission question ('want me to continue?', 'keep this rhythm?', 'quer que eu siga?'). Continue to the next step. Stop ONLY for a REAL gate — and STRUCTURE it as a blocker, never end as a prose question.",
    "- What a REAL gate is: a destructive/irreversible action, secrets, a production action, a NEW decision OUTSIDE the approved request/plan, or a business-rule question. Scope means work OUTSIDE what was approved — continuing to the approved request's or the plan's OWN next step is NOT a scope gate and needs no permission to start.",
    "- Budget is never a stop reason: running low on tokens/effort, or being unable to fully implement AND test something in a single turn, is NEVER grounds to stop and ask. Make incremental, verifiable progress and report the rung you reached — 'partial' and 'blocked' are legitimate reported outcomes; refusing to start authorized work is not.",
    `- active_disciplines: ${activeDisciplines.map((discipline) => discipline.id).join(", ") || "none"}`,
  );
  if (details.plan?.next_task) {
    const plan = details.plan;
    lines.push(
      `- Active plan (PRE-APPROVED scope): ${plan.pending_count} task(s) already accepted in plan ${plan.plan_id} [cadence: ${plan.execution_cadence}]. ` +
        `The next task ${plan.next_task.task_id} ("${plan.next_task.text}") is authorized work — advancing to it is 'continue to the next step', NOT a new-scope gate. ` +
        "Do not end the turn asking permission to start an already-planned task.",
    );
  }
  if (details.recent_run) {
    lines.push("", renderRecentRunSummary(details.recent_run));
  }
  lines.push("Use these as pointers only; materialize detailed context through AIPI workflow/context tools.");
  lines.push(...renderActiveDisciplineText(activeDisciplines));
  return lines.join("\n");
}

async function readSessionEntries(ctx = {}) {
  const manager = ctx?.sessionManager ?? ctx?.session_manager ?? null;
  if (typeof manager?.getEntries === "function") {
    return await Promise.resolve(manager.getEntries());
  }
  if (typeof manager?.getBranch === "function") {
    return await Promise.resolve(manager.getBranch());
  }
  if (Array.isArray(ctx?.entries)) return ctx.entries;
  return [];
}

function createContextPointerMessage({ snapshot, activeDisciplines = [] }) {
  const details = buildContextPointerDetails({ snapshot, activeDisciplines });
  return {
    role: "custom",
    customType: "aipi.context-pointer",
    content: renderContextPointer(details),
    display: false,
    timestamp: Date.now(),
    details,
  };
}

function buildContextPointerDetails({ snapshot, activeDisciplines = [] }) {
  return {
    schema: "aipi.context-pointer.v1",
    run: snapshot,
    memory_refs: [
      ".aipi/memory/project/business-rules.md",
      ".aipi/memory/project/decisions.md",
      ".aipi/memory/project/project.md",
    ],
    active_disciplines: activeDisciplines,
  };
}

function renderActiveDisciplineText(activeDisciplines) {
  if (!activeDisciplines.length) return [];
  return [
    "",
    "Active discipline instructions:",
    ...activeDisciplines.flatMap((discipline) => [
      "",
      `## ${discipline.id}`,
      `- source: ${discipline.file}`,
      `- status: ${discipline.status}`,
      `- moments: ${discipline.moments.join(", ")}`,
      "",
      discipline.content,
    ]),
  ];
}

async function loadActiveDisciplines({ projectRoot, snapshot, event, ctx, hook }) {
  const catalogText = await fs.readFile(path.join(projectRoot, DISCIPLINE_CATALOG_REL_PATH), "utf8");
  const catalog = parseDisciplineCatalog(catalogText);
  const step = await activeWorkflowStepForRouting(projectRoot, snapshot);
  const agentCatalog = await loadAgentDisciplineCatalog(projectRoot).catch(() => ({ roles: new Map(), roleDisciplines: new Map() }));
  const roles = inferDisciplineRoles({ event, ctx, snapshot, step, agentRoles: agentCatalog.roles });
  const explicitDisciplineIds = disciplineIdsForRoles(roles, agentCatalog.roleDisciplines);
  const byId = new Map();

  for (const activation of catalog.activations) {
    if (!activation.pi_hooks.includes(hook)) continue;
    for (const id of activation.disciplines) {
      const discipline = catalog.disciplines.get(id);
      if (!discipline) continue;
      if (!disciplineAppliesToRoles(discipline, roles) && !explicitDisciplineIds.has(id)) continue;
      const current = byId.get(id) ?? { ...discipline, moments: [] };
      current.moments.push(activation.moment);
      byId.set(id, current);
    }
  }

  const active = [];
  for (const discipline of byId.values()) {
    const relPath = normalizeRelPath(discipline.file);
    const content = await fs.readFile(path.join(projectRoot, relPath), "utf8").catch(() => "");
    active.push({
      id: discipline.id,
      status: discipline.status,
      file: relPath,
      applies_to: discipline.applies_to,
      moments: discipline.moments,
      content: truncateText(content.trim(), MAX_DISCIPLINE_CHARS),
    });
  }
  return active;
}

async function loadAndRecordActiveDisciplines({ projectRoot, snapshot, event, ctx, pi, hook }) {
  if (!snapshot?.active) return [];
  const activeDisciplines = await loadActiveDisciplines({
    projectRoot,
    snapshot,
    event,
    ctx,
    hook,
  }).catch(() => []);
  if (activeDisciplines.length) {
    safeAppendEntry(pi, "aipi.discipline.active", {
      schema: "aipi.discipline-activation.v1",
      hook,
      run_id: snapshot.run_id ?? null,
      workflow: snapshot.workflow ?? null,
      step_id: snapshot.step_id ?? null,
      active_disciplines: activeDisciplines.map((discipline) => discipline.id),
      details: activeDisciplines.map((discipline) => ({
        id: discipline.id,
        status: discipline.status,
        file: discipline.file,
        moments: discipline.moments,
      })),
    });
  }
  return activeDisciplines;
}

function parseDisciplineCatalog(text) {
  const activations = [];
  const disciplines = new Map();
  let section = null;
  let currentActivation = null;
  let currentDiscipline = null;

  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line === "activation:") {
      section = "activation";
      currentActivation = null;
      currentDiscipline = null;
      continue;
    }
    if (line === "disciplines:") {
      section = "disciplines";
      currentActivation = null;
      currentDiscipline = null;
      continue;
    }

    if (section === "activation") {
      const moment = line.match(/^  ([a-z0-9_-]+):$/);
      if (moment) {
        currentActivation = { moment: moment[1], disciplines: [], pi_hooks: [] };
        activations.push(currentActivation);
        continue;
      }
      if (!currentActivation) continue;
      const list = line.match(/^    ([a-z_]+): (\[.*\])$/);
      if (list) currentActivation[list[1]] = parseInlineList(list[2]);
      continue;
    }

    if (section === "disciplines") {
      const id = line.match(/^  - id: ([a-z0-9-]+)$/);
      if (id) {
        currentDiscipline = { id: id[1], status: null, file: null, applies_to: [] };
        disciplines.set(currentDiscipline.id, currentDiscipline);
        continue;
      }
      if (!currentDiscipline) continue;
      const scalar = line.match(/^    ([a-z_]+): (.+)$/);
      if (!scalar) continue;
      const [, key, value] = scalar;
      if (key === "applies_to") currentDiscipline.applies_to = parseInlineList(value);
      else currentDiscipline[key] = value;
    }
  }

  return { activations, disciplines };
}

function disciplineAppliesToRoles(discipline, roles) {
  if (!discipline.applies_to?.length) return true;
  for (const role of discipline.applies_to) {
    if (roles.has(role)) return true;
  }
  return false;
}

async function loadAgentDisciplineCatalog(projectRoot) {
  const text = await fs.readFile(path.join(projectRoot, AGENT_CATALOG_REL_PATH), "utf8");
  const roles = new Map();
  const roleDisciplines = new Map();
  let currentId = null;
  let inRoleDisciplines = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^  role_disciplines:\s*$/.test(line)) {
      inRoleDisciplines = true;
      continue;
    }
    if (inRoleDisciplines && line.trim() && !/^    /.test(line)) {
      inRoleDisciplines = false;
    }
    if (inRoleDisciplines) {
      const roleDisciplinesLine = line.match(/^    ([a-z0-9-]+): (\[.*\])$/);
      if (roleDisciplinesLine) roleDisciplines.set(roleDisciplinesLine[1], parseInlineList(roleDisciplinesLine[2]));
      continue;
    }
    const id = line.match(/^  - id: ([a-z0-9-]+)$/);
    if (id) {
      currentId = id[1];
      continue;
    }
    if (!currentId) continue;
    const role = line.match(/^    role: ([a-z0-9-]+)$/);
    if (role) roles.set(currentId, role[1]);
  }
  return { roles, roleDisciplines };
}

function disciplineIdsForRoles(roles, roleDisciplines = new Map()) {
  const disciplineIds = new Set();
  for (const role of roles) {
    for (const disciplineId of roleDisciplines.get(role) ?? []) disciplineIds.add(disciplineId);
  }
  return disciplineIds;
}

function inferDisciplineRoles({ event, ctx, snapshot, step, agentRoles = new Map() }) {
  const roles = new Set();
  const agentIds = [
    eventAgentId(event, ctx),
    ...(Array.isArray(step?.agents) ? step.agents : []),
  ].filter(Boolean);

  if (!agentIds.length && snapshot?.active) roles.add("orchestrator");
  for (const agentId of agentIds) {
    for (const role of rolesForAgentId(agentId, agentRoles)) roles.add(role);
  }
  for (const role of rolesForStage(snapshot?.stage)) roles.add(role);
  return roles;
}

function rolesForAgentId(agentId, agentRoles = new Map()) {
  const normalized = String(agentId ?? "").toLowerCase();
  const roles = new Set();
  const catalogRole = agentRoles.get(normalized);
  if (catalogRole) roles.add(catalogRole);
  if (normalized.includes("orchestr")) roles.add("orchestrator");
  if (normalized.includes("planning") || normalized.includes("planner") || normalized.includes("intake") || normalized.includes("requirements") || normalized.includes("reasoner")) roles.add("planner");
  if (normalized.includes("researcher")) roles.add("researcher");
  if (normalized.includes("context") || normalized.includes("mapper")) roles.add("context");
  if (normalized.includes("implementer")) roles.add("implementer");
  if (normalized.includes("frontend")) roles.add("frontend");
  if (normalized.includes("test")) roles.add("tester");
  if (normalized.includes("fixer") || normalized.includes("debugger")) roles.add("fixer");
  if (normalized.includes("reviewer") || normalized.includes("review") || normalized.includes("auditor")) roles.add("reviewer");
  if (normalized.includes("verifier") || normalized.includes("test-gate")) roles.add("verifier");
  if (normalized.includes("cicd") || normalized.includes("ops") || normalized.includes("security")) roles.add("ops");
  if (normalized.includes("human-review")) roles.add("human-review");
  if (normalized.includes("business-rule-keeper")) roles.add("business-rule-keeper");
  return roles;
}

function rolesForStage(stage) {
  const normalized = String(stage ?? "").toLowerCase();
  const roles = new Set();
  if (["intake", "requirements", "rule-check", "planning", "implementation-plan"].includes(normalized)) roles.add("planner");
  if (["implementation", "fix"].includes(normalized)) roles.add("implementer");
  if (["tdd", "tests", "local-verification", "final-verification"].includes(normalized)) {
    roles.add("tester");
    roles.add("verifier");
  }
  if (["review", "execution-review", "blast-radius"].includes(normalized)) roles.add("reviewer");
  if (["research", "context"].includes(normalized)) roles.add(normalized);
  if (["deployment-plan", "homolog", "human-review", "prod", "ops"].includes(normalized)) roles.add("ops");
  if (normalized === "human-review") roles.add("human-review");
  if (normalized === "memory-promotion") roles.add("business-rule-keeper");
  return roles;
}

function normalizeRelPath(relPath) {
  return String(relPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function parseInlineList(value) {
  const match = String(value ?? "").match(/\[(.*)\]/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderTreeInstructions(snapshot) {
  return [
    "Preserve AIPI run state in the branch summary.",
    `AIPI run_id=${snapshot.run_id}`,
    `workflow=${snapshot.workflow}`,
    `status=${snapshot.status}`,
    `current_step=${snapshot.current_step ?? "none"}`,
    `stage=${snapshot.stage ?? "none"}`,
    `contract_path=${snapshot.contract_path ?? "none"}`,
  ].join("\n");
}

function renderHandoffMarkdown({ snapshot, hook, event, at }) {
  return `---
schema: aipi.session-handoff.v1
run_id: ${snapshot.run_id}
workflow: ${snapshot.workflow}
hook: ${hook}
recorded_at: ${at}
---

# AIPI Session Handoff

- run_id: ${snapshot.run_id}
- workflow: ${snapshot.workflow}
- status: ${snapshot.status}
- current_step: ${snapshot.current_step ?? "none"}
- stage: ${snapshot.stage ?? "none"}
- contract_path: ${snapshot.contract_path ?? "none"}

## Event

\`\`\`json
${JSON.stringify(event, null, 2)}
\`\`\`
`;
}

function renderAipiCompactionSummary({ snapshot, handoffPath, preparation }) {
  const messages = Array.isArray(preparation?.messagesToSummarize)
    ? preparation.messagesToSummarize
    : [];
  const messageLines = messages.slice(-6).map((message, index) => {
    const role = message?.role ?? message?.type ?? `message-${index + 1}`;
    return `- ${role}: ${messageTextExcerpt(message, 500)}`;
  });
  const fileOps = preparation?.fileOps ? truncateSummaryText(JSON.stringify(preparation.fileOps), 1200) : "none";
  const previous = preparation?.previousSummary
    ? truncateSummaryText(redactSecrets(preparation.previousSummary), 1200)
    : "none";

  return [
    "AIPI compaction summary",
    "schema: aipi.compaction-summary.v1",
    "",
    "Active run:",
    `- run_id: ${snapshot?.run_id ?? "none"}`,
    `- workflow: ${snapshot?.workflow ?? "none"}`,
    `- status: ${snapshot?.status ?? "none"}`,
    `- current_step: ${snapshot?.current_step ?? "none"}`,
    `- stage: ${snapshot?.stage ?? "none"}`,
    `- contract_path: ${snapshot?.contract_path ?? "none"}`,
    `- handoff_path: ${handoffPath ?? "none"}`,
    "",
    "Preserve these invariants:",
    "- The accepted BDD contract and .aipi/memory/project Markdown remain authoritative.",
    "- Do not infer completion without fresh evidence after compaction.",
    "- Restored queued/running subagents are interrupted work and matching workflow steps redispatch them from clean boundaries.",
    "- Memory promotion must continue through approval-gated AIPI tools.",
    "",
    "Compaction boundary:",
    `- first_kept_entry_id: ${preparation?.firstKeptEntryId ?? "none"}`,
    `- tokens_before: ${preparation?.tokensBefore ?? "unknown"}`,
    `- split_turn: ${Boolean(preparation?.isSplitTurn)}`,
    "",
    "Previous summary:",
    previous,
    "",
    "Recent messages before compaction:",
    ...(messageLines.length ? messageLines : ["- none"]),
    "",
    "File operations summary:",
    fileOps,
  ].join("\n");
}

function messageTextExcerpt(message, maxChars) {
  const content = message?.content ?? message?.text ?? message?.message ?? "";
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => typeof part === "string" ? part : part?.text ?? "")
      .filter(Boolean)
      .join(" ");
  } else {
    text = JSON.stringify(content ?? message);
  }
  return truncateSummaryText(redactSecrets(String(text).replace(/\s+/g, " ").trim()), maxChars);
}

// Prompt bodies (user text, agent prompt, full system prompt) must not be
// persisted into runtime jsonl logs — a single blocked turn used to embed the
// entire ~3KB system prompt per hook. Persist char counts instead, mirroring
// the prompt_chars convention of the lifecycle events.
const COMPACT_EVENT_PROMPT_KEYS = new Set(["text", "prompt", "systemPrompt", "system_prompt"]);
const COMPACT_EVENT_MAX_STRING_CHARS = 480;

function compactEvent(event = {}) {
  const result = {};
  for (const [key, value] of Object.entries(event ?? {})) {
    if (key === "signal" || key === "payload" || key === "headers") continue;
    if (typeof value === "string") {
      if (COMPACT_EVENT_PROMPT_KEYS.has(key) || value.length > COMPACT_EVENT_MAX_STRING_CHARS) {
        result[`${key}_chars`] = value.length;
      } else {
        result[key] = value;
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value == null) {
      result[key] = value;
    }
  }
  return result;
}

function serializeRuntimeError(error, { includeStack = true } = {}) {
  return {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error ?? "unknown error"),
    code: error?.code ?? null,
    stack: includeStack && typeof error?.stack === "string" ? redactSecrets(error.stack) : null,
    cause: error?.cause
      ? {
          name: String(error.cause?.name ?? "Error"),
          message: String(error.cause?.message ?? error.cause),
          stack: includeStack && typeof error.cause?.stack === "string" ? redactSecrets(error.cause.stack) : null,
        }
      : null,
  };
}

function isAipiContextPointer(message) {
  return message?.customType === "aipi.context-pointer" ||
    message?.customType === "aipi.recent-run-pointer" ||
    message?.details?.schema === "aipi.context-pointer.v1" ||
    message?.details?.schema === "aipi.recent-run-pointer.v1" ||
    (typeof message?.content === "string" &&
      (message.content.startsWith("AIPI active run context:") || message.content.startsWith("AIPI most recent run")));
}

function isAipiToolResultMessage(message) {
  return message?.role === "toolResult" &&
    (String(message?.toolName ?? "").startsWith("aipi_") ||
      String(message?.details?.schema ?? "").startsWith("aipi."));
}

function truncateMessageText(message, maxChars) {
  let modified = false;
  if (typeof message?.content === "string" && message.content.length > maxChars) {
    modified = true;
    return {
      modified,
      message: {
        ...message,
        content: truncateText(message.content, maxChars),
        details: { ...(message.details ?? {}), aipi_context_truncated: true },
      },
    };
  }
  if (Array.isArray(message?.content)) {
    const content = message.content.map((part) => {
      if (part?.type !== "text" || typeof part.text !== "string" || part.text.length <= maxChars) return part;
      modified = true;
      return { ...part, text: truncateText(part.text, maxChars) };
    });
    if (modified) {
      return {
        modified,
        message: {
          ...message,
          content,
          details: { ...(message.details ?? {}), aipi_context_truncated: true },
        },
      };
    }
  }
  return { modified: false, message };
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[AIPI context pruned ${omitted} chars from an older tool result]`;
}

function truncateSummaryText(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n[AIPI summary pruned ${omitted} chars]`;
}

function insertAfterLastUser(messages, message) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      messages.splice(index + 1, 0, message);
      return;
    }
  }
  messages.push(message);
}

function redactProviderPayloadValue(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    const text = redactSecrets(value);
    return { value: text, modified: text !== value, redacted: text !== value ? 1 : 0 };
  }
  if (!value || typeof value !== "object") {
    return { value, modified: false, redacted: 0 };
  }
  if (seen.has(value)) {
    return { value, modified: false, redacted: 0 };
  }
  seen.add(value);

  if (Array.isArray(value)) {
    let modified = false;
    let redacted = 0;
    const output = value.map((item) => {
      const result = redactProviderPayloadValue(item, seen);
      modified ||= result.modified;
      redacted += result.redacted;
      return result.value;
    });
    return { value: modified ? output : value, modified, redacted };
  }

  let modified = false;
  let redacted = 0;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const result = redactProviderPayloadValue(item, seen);
    modified ||= result.modified;
    redacted += result.redacted;
    output[key] = result.value;
  }
  return { value: modified ? output : value, modified, redacted };
}

async function recordModelRoutingDecision({ projectRoot, routing }) {
  const snapshot = routing.snapshot ?? { active: false };
  const entry = {
    schema: "aipi.model-routing.v1",
    recorded_at: new Date().toISOString(),
    hook: routing.hook,
    status: routing.status,
    run_id: snapshot.run_id ?? null,
    workflow: snapshot.workflow ?? null,
    step_id: routing.step_id ?? snapshot.step_id ?? null,
    agent_id: routing.agent_id ?? null,
    selector: routing.selector ?? null,
    model_class: routing.model_class ?? null,
    model: routing.model_id ?? null,
    thinking_level: routing.thinking_level ?? null,
    source: routing.source ?? null,
    current_model: routing.current_model ?? null,
    preferred_families: routing.preferred_families ?? [],
    family_warning: routing.family_warning ?? null,
    capability_report: routing.capability_report ?? null,
    warning: routing.warning ?? null,
    manual_selection: routing.manual_selection ?? null,
  };
  await appendRuntimeEvent(projectRoot, MODEL_ROUTING_LOG, entry);
  if (snapshot.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "model-routing.jsonl"), entry);
  }
  return entry;
}

// Per-WORKER routing record. The host `model_select` hook (recordModelRoutingDecision) only captures the
// orchestrator turn; spawned workers resolve their model in a forked child, so without this the worker's
// model never reaches model-routing.jsonl and a host-only scan reads "Anthropic-only" even when a reviewer
// ran on a different provider. Mirrors the aipi.model-routing.v1 shape (existing readers stay compatible)
// with hook "worker_spawn" and selector "worker" so it is filterable. cross_family is null when the host
// model is unknown — distinct from false (confirmed same-family), so an off-family run is never silently
// hidden when the host model was never captured.
export async function recordWorkerModelRoute({
  projectRoot,
  runId = null,
  stepId = null,
  agentId = null,
  modelClass = null,
  workerModel = null,
  hostModel = null,
  source = null,
}) {
  const workerFamily = modelProvider(workerModel);
  const hostFamily = modelProvider(hostModel);
  const crossFamily = workerFamily && hostFamily ? workerFamily !== hostFamily : null;
  const entry = {
    schema: "aipi.model-routing.v1",
    recorded_at: new Date().toISOString(),
    hook: "worker_spawn",
    status: crossFamily === true ? "worker_cross_family" : "worker_resolved",
    run_id: runId,
    workflow: null,
    step_id: stepId,
    agent_id: agentId,
    selector: "worker",
    model_class: modelClass,
    model: workerModel,
    thinking_level: null,
    source,
    current_model: hostModel,
    cross_family: crossFamily,
    worker_family: workerFamily,
    host_family: hostFamily,
    preferred_families: [],
    family_warning: null,
    capability_report: null,
    warning: null,
    manual_selection: null,
  };
  await appendRuntimeEvent(projectRoot, MODEL_ROUTING_LOG, entry);
  if (runId) {
    await appendRuntimeEvent(projectRoot, runScopedLog(runId, "model-routing.jsonl"), entry);
  }
  return entry;
}

async function activeWorkflowStepForRouting(projectRoot, snapshot) {
  if (!snapshot?.active || !snapshot.workflow || !snapshot.current_step) return null;
  const active = await readActiveRun(projectRoot).catch(() => null);
  const state = active?.state ?? null;
  if (!state?.current_step) return null;
  const workflowRelPath = state.source_workflow ?? path.join(".aipi", "workflows", `${state.workflow ?? snapshot.workflow}.yaml`);
  try {
    const text = await fs.readFile(path.join(projectRoot, workflowRelPath), "utf8");
    const workflow = parseWorkflowDefinition(text, state.workflow ?? snapshot.workflow);
    return workflow.steps.find((step) => step.id === state.current_step) ?? null;
  } catch {
    return null;
  }
}

function buildLifecycleModelContext(event, ctx) {
  return {
    ...(ctx ?? {}),
    model: normalizeModelRef(currentModelFromEvent(event, ctx)),
    modelRegistry: modelRegistryFromEvent(event, ctx),
  };
}

function currentModelFromEvent(event, ctx) {
  return event?.current_model ??
    event?.currentModel ??
    event?.selected_model ??
    event?.selectedModel ??
    event?.model ??
    event?.payload?.model ??
    ctx?.model ??
    null;
}

function currentThinkingLevelFromEvent(event, ctx) {
  return stringOrNull(
    // The real Pi ThinkingLevelSelectEvent carries the user's chosen level in `event.level`
    // (see @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts ThinkingLevelSelectEvent).
    // Earlier field names below were never populated by the host, so manual selection was lost (ADV-58-2).
    event?.level ??
      event?.selected_thinking_level ??
      event?.selectedThinkingLevel ??
      event?.current_thinking_level ??
      event?.currentThinkingLevel ??
      event?.thinking_level ??
      event?.thinkingLevel ??
      event?.payload?.thinking_level ??
      event?.payload?.thinkingLevel ??
      ctx?.selected_thinking_level ??
      ctx?.selectedThinkingLevel ??
      ctx?.current_thinking_level ??
      ctx?.currentThinkingLevel ??
      ctx?.thinking_level ??
      ctx?.thinkingLevel,
  );
}

function manualLifecycleSelection({ hook, selector, resolution, currentModel, currentModelId, event, ctx } = {}) {
  if (selector?.source !== "active_workflow_step") return null;
  if (event?.aipiApplyModelRoute === true || ctx?.aipiApplyModelRoute === true) return null;
  if (hook === "model_select") {
    if (!currentModelId || currentModelId === describeModel(resolution?.model)) return null;
    return {
      kind: "model",
      status: "manual_model_preserved",
      source: "current_user_selection",
      model: normalizeModelRef(currentModel),
      model_id: currentModelId,
      resolved_model: describeModel(resolution?.model),
      reason: "active workflow step cannot override an explicit user-facing /model selection",
    };
  }
  if (hook === "thinking_level_select") {
    const level = currentThinkingLevelFromEvent(event, ctx);
    if (!level) return null;
    return {
      kind: "thinking_level",
      status: "manual_thinking_preserved",
      source: "current_user_selection",
      thinking_level: level,
      resolved_thinking_level: resolution?.thinking_level ?? null,
      reason: "active workflow step cannot override an explicit user-facing thinking level selection",
    };
  }
  return null;
}

function eventModelClass(event, ctx) {
  return stringOrNull(
    event?.model_class ??
      event?.modelClass ??
      event?.agent_class ??
      event?.agentClass ??
      event?.agent?.model_class ??
      event?.agent?.modelClass ??
      ctx?.model_class ??
      ctx?.modelClass,
  );
}

function eventAgentId(event, ctx) {
  return stringOrNull(
    event?.agent_id ??
      event?.agentId ??
      event?.agent?.id ??
      event?.agent?.agent_id ??
      event?.agent?.agentId ??
      ctx?.agent_id ??
      ctx?.agentId,
  );
}

function modelRoutingWarning({
  modelClass,
  resolvedModelId,
  currentModelId,
  source,
  preferredFamilies,
  familyWarning = null,
  capabilityReport = null,
}) {
  if (resolvedModelId && currentModelId && currentModelId !== resolvedModelId) {
    return {
      code: "AIPI_MODEL_MANUAL_DRIFT",
      severity: "warn",
      message: `AIPI model class "${modelClass}" resolved to "${resolvedModelId}" but the current selection is "${currentModelId}".`,
      model_class: modelClass,
      model_current: currentModelId,
      model_resolved: resolvedModelId,
    };
  }
  if (resolvedModelId && ["missing_registry", "missing_model_capabilities"].includes(capabilityReport?.state)) {
    return {
      code: "AIPI_MODEL_CAPABILITY_UNKNOWN",
      severity: "warn",
      message: `AIPI model class "${modelClass}" resolved to "${resolvedModelId}" but its capability_floor is not proven.`,
      model_class: modelClass,
      model_resolved: resolvedModelId,
      capability_state: capabilityReport.state,
    };
  }
  if (resolvedModelId && capabilityReport?.state === "fail") {
    return {
      code: "AIPI_MODEL_CAPABILITY_FLOOR_UNMET",
      severity: "warn",
      message: `AIPI model class "${modelClass}" resolved to "${resolvedModelId}" but the configured capabilities do not satisfy its floor.`,
      model_class: modelClass,
      model_resolved: resolvedModelId,
      unmet: capabilityReport.unmet ?? [],
      missing: capabilityReport.missing ?? [],
    };
  }
  if (resolvedModelId && familyWarning) return familyWarning;
  if (!resolvedModelId) {
    return {
      code: "AIPI_MODEL_CLASS_UNRESOLVED",
      severity: "warn",
      message: `AIPI model class "${modelClass}" has no configured provider/model for this ${source ?? "route"} route.`,
      model_class: modelClass,
      preferred_families: preferredFamilies ?? [],
    };
  }
  return null;
}

async function safeSetModel(pi, model) {
  if (!model || typeof pi?.setModel !== "function") return { applied: false };
  try {
    await pi.setModel(model);
    return { applied: true };
  } catch (error) {
    return { applied: false, error: String(error?.message ?? error) };
  }
}

async function safeSetThinkingLevel(pi, thinkingLevel) {
  if (!thinkingLevel || typeof pi?.setThinkingLevel !== "function") return { applied: false };
  try {
    await pi.setThinkingLevel(thinkingLevel);
    return { applied: true };
  } catch (error) {
    return { applied: false, error: String(error?.message ?? error) };
  }
}

function modelRegistryFromEvent(event, ctx) {
  const direct = event?.modelRegistry ?? ctx?.modelRegistry ?? null;
  if (typeof direct?.find === "function") return direct;
  const models = [
    ...(Array.isArray(event?.available_models) ? event.available_models : []),
    ...(Array.isArray(event?.availableModels) ? event.availableModels : []),
    ...(Array.isArray(event?.models) ? event.models : []),
    ...(Array.isArray(ctx?.availableModels) ? ctx.availableModels : []),
    ...(Array.isArray(ctx?.models) ? ctx.models : []),
  ];
  if (!models.length) return null;
  return {
    find(provider, model) {
      return models.map(normalizeModelRef).find((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        const candidateProvider = candidate.provider ?? candidate.family ?? null;
        const candidateModel = candidate.id ?? candidate.model ?? candidate.name ?? null;
        return candidateProvider === provider && candidateModel === model;
      }) ?? null;
    },
  };
}

function normalizeModelRef(model) {
  if (typeof model !== "string") return model ?? null;
  const match = model.trim().match(/^([^/]+)\/([^:]+)(?::[a-z]+)?$/i);
  if (!match) return model.trim() || null;
  return { provider: match[1], id: match[2] };
}

async function appendProviderEvent(projectRoot, snapshot, entry) {
  await appendRuntimeEvent(projectRoot, PROVIDER_EVENT_LOG, entry);
  if (snapshot.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "provider-events.jsonl"), entry);
  }
}

async function appendProviderUsage(projectRoot, snapshot, entry) {
  await appendRuntimeEvent(projectRoot, PROVIDER_USAGE_LOG, entry);
  if (snapshot.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "provider-usage.jsonl"), entry);
  }
}

async function appendProviderBudget(projectRoot, snapshot, entry) {
  await appendRuntimeEvent(projectRoot, PROVIDER_BUDGET_LOG, entry);
  if (snapshot.active) {
    await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "provider-budget.jsonl"), entry);
  }
}

async function loadProviderPricing(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, PROVIDER_PRICING_REL_PATH), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== "aipi.provider-pricing.v1" || !parsed?.rates || typeof parsed.rates !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function loadProviderBudget(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, PROVIDER_BUDGET_REL_PATH), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== "aipi.provider-budget.v1") return null;
    if (parsed.enabled === false) return null;
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

function providerBudgetScopeForUsage(usage, budget) {
  const provider = stringOrNull(usage.provider);
  const model = stringOrNull(usage.model);
  const modelKey = provider && model ? `${provider}:${model}` : model;
  if (modelKey && budget.models?.[modelKey]) {
    return { scope: "model", key: modelKey, config: budget.models[modelKey], provider, model };
  }
  if (provider && budget.providers?.[provider]) {
    return { scope: "provider", key: provider, config: budget.providers[provider], provider, model: null };
  }
  return { scope: "default", key: "default", config: budget.default ?? {}, provider: null, model: null };
}

async function providerSpentUsd({ projectRoot, scope }) {
  const entries = await readJsonLines(path.join(projectRoot, PROVIDER_USAGE_LOG));
  let total = 0;
  for (const entry of entries) {
    if (!providerUsageEntryMatchesScope(entry, scope)) continue;
    total += numberOrNull(entry.cost_usd) ?? 0;
  }
  return total;
}

function providerUsageEntryMatchesScope(entry, scope) {
  if (scope.scope === "model") {
    return [entry.provider, entry.model].filter(Boolean).join(":") === scope.key || entry.model === scope.key;
  }
  if (scope.scope === "provider") return entry.provider === scope.key;
  return true;
}

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore corrupt historical telemetry lines */
    }
  }
  return out;
}

function providerUsageIdentity(event = {}) {
  return {
    provider: stringOrNull(event.provider ?? event.providerId ?? event.response?.provider ?? event.body?.provider),
    model: stringOrNull(event.model ?? event.response?.model ?? event.body?.model ?? event.payload?.model),
    cost_usd: null,
  };
}

function providerPricingRateForUsage(usage, pricing, { now = new Date() } = {}) {
  const provider = usage.provider ?? "";
  const model = usage.model ?? "";
  const candidates = [
    provider && model ? `${provider}:${model}` : null,
    model || null,
    provider || null,
    "default",
  ].filter(Boolean);
  for (const key of candidates) {
    const rate = pricing.rates?.[key];
    if (!rate) continue;
    const metadata = providerPricingRateMetadata(rate, pricing);
    if (!providerPricingRateFresh(metadata, now)) continue;
    return { ...rate, ...metadata, key };
  }
  return null;
}

function providerPricingRateMetadata(rate, pricing) {
  return {
    checked_at: rate.checked_at ?? pricing.checked_at ?? null,
    source_url: rate.source_url ?? pricing.source_url ?? null,
    max_age_days: numberOrNull(rate.max_age_days ?? rate.maxAgeDays ?? pricing.max_age_days ?? pricing.maxAgeDays) ?? 30,
  };
}

function providerPricingRateFresh(metadata, now) {
  if (!metadata.source_url || !metadata.checked_at) return false;
  const checkedAt = new Date(metadata.checked_at);
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(checkedAt.getTime()) || !Number.isFinite(current.getTime())) return false;
  if (checkedAt.getTime() > current.getTime()) return false;
  const maxAgeMs = Math.max(0, metadata.max_age_days) * 24 * 60 * 60 * 1000;
  return current.getTime() - checkedAt.getTime() <= maxAgeMs;
}

function providerPricingRateValidationErrors(key, rate, metadata, now) {
  const errors = [];
  const inputRate = numberOrNull(rate.input_per_million_tokens ?? rate.inputPerMillionTokens);
  const outputRate = numberOrNull(rate.output_per_million_tokens ?? rate.outputPerMillionTokens);
  const totalRate = numberOrNull(rate.total_per_million_tokens ?? rate.totalPerMillionTokens);
  const numericRates = [
    ["input_per_million_tokens", inputRate],
    ["output_per_million_tokens", outputRate],
    ["total_per_million_tokens", totalRate],
  ].filter(([, value]) => value != null);

  if (!numericRates.length) {
    errors.push(`${key}: define at least one per-million-token rate`);
  }
  for (const [field, value] of numericRates) {
    if (value < 0) errors.push(`${key}: ${field} must be non-negative`);
  }
  if (!metadata.source_url) {
    errors.push(`${key}: source_url is required at file or rate level`);
  } else if (typeof metadata.source_url !== "string" || !/^https?:\/\//i.test(metadata.source_url)) {
    errors.push(`${key}: source_url must be an http(s) URL`);
  }
  if (!metadata.checked_at) {
    errors.push(`${key}: checked_at is required at file or rate level`);
  } else {
    const checkedAt = new Date(metadata.checked_at);
    const current = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(checkedAt.getTime())) {
      errors.push(`${key}: checked_at must be a valid date`);
    } else if (!Number.isFinite(current.getTime())) {
      errors.push(`${key}: now must be a valid date`);
    } else if (checkedAt.getTime() > current.getTime()) {
      errors.push(`${key}: checked_at cannot be in the future`);
    } else if (!providerPricingRateFresh(metadata, current)) {
      errors.push(`${key}: pricing evidence is stale for max_age_days`);
    }
  }

  return errors;
}

function usageWithEstimatedCost(usage, estimatedCost) {
  if (!estimatedCost || usage.cost_usd != null) return usage;
  return {
    ...usage,
    cost_usd: estimatedCost.cost_usd,
    cost_source: estimatedCost.source,
    pricing_ref: estimatedCost.pricing_ref,
  };
}

async function appendRuntimeEvent(projectRoot, relPath, entry) {
  const absPath = path.join(projectRoot, relPath);
  await appendRotatedJsonlLine(absPath, entry);
}

async function isAipiInstalled(projectRoot) {
  try {
    await fs.access(path.join(projectRoot, ".aipi", "runtime-contract.json"));
    return true;
  } catch {
    return false;
  }
}

function runScopedLog(runId, filename) {
  return path.posix.join(".aipi/runtime/runs", runId, filename);
}

function safeAppendEntry(pi, type, data) {
  try {
    pi?.appendEntry?.(type, data);
  } catch {
    /* best-effort session marker */
  }
}

function safeSetSessionName(pi, name) {
  try {
    pi?.setSessionName?.(name);
  } catch {
    /* best-effort session metadata */
  }
}

function safeNotify(ctx, message, kind) {
  try {
    ctx?.ui?.notify?.(message, kind);
  } catch {
    /* best-effort UI signal */
  }
}

// Render the live worker-activity panel to match Pi's native message styling: thinking traces italic in the
// host's thinkingText color (exactly how AssistantMessageComponent renders them), tool/file ops muted, a dim
// header line. Uses ONLY the Theme.fg/italic helpers the host passes to the setWidget factory, with graceful
// fallback to plain text when a theme/helper is absent (tests, odd hosts).
export function renderActivityLines(payload, theme, width = 80) {
  const fg = (color, text) => (typeof theme?.fg === "function" ? theme.fg(color, text) : text);
  const italic = (text) => (typeof theme?.italic === "function" ? theme.italic(text) : text);
  const maxLen = Math.max(24, Math.min(Number.isFinite(width) ? width : 80, 120) - 2);
  const clip = (value) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
  };
  const tools = Number(payload?.tools ?? 0);
  const header = `${payload?.tag ?? "worker"} · ${tools} tool${tools === 1 ? "" : "s"} · ${payload?.elapsed_s ?? 0}s`;
  const lines = [fg("dim", clip(header))];
  for (const item of payload?.items ?? []) {
    const text = clip(item?.detail);
    if (!text) continue;
    if (item?.kind === "think") lines.push(italic(fg("thinkingText", `  ${text}`)));
    else lines.push(fg("muted", `  ${text}`)); // tool + assistant text
  }
  return lines;
}

export function buildActivityComponent(payload, theme) {
  return {
    render(width) {
      try {
        return renderActivityLines(payload, theme, width);
      } catch {
        return [];
      }
    },
    invalidate() {},
  };
}

// ADV-58-3: bind a cheap, non-blocking progress-notification surface to ctx so the
// executor can stream per-step transitions to the terminal instead of looking frozen.
const PROGRESS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// makeProgressNotifier returns a CALLABLE sink: calling it (notify(message, kind)) keeps the legacy
// one-line behavior every existing caller/test depends on, while attached methods add richer,
// feature-detected host-UI surfaces — a live per-step PLAN checklist (setWidget) and an animated
// status line / spinner (setStatus) — so a long workflow shows step-by-step progress and moving dots
// instead of a single frozen "running…" line. Every host capability is feature-detected; when only
// ctx.ui.notify exists (or it's the CLI), the extra surfaces degrade to no-ops and the notify lines
// remain exactly as before.
export function makeProgressNotifier(ctx, pi = null) {
  if (typeof ctx?.ui?.notify !== "function") return null;
  const ui = ctx.ui;
  // sendMessage lives on the extension (pi); fall back to ctx.sendMessage if a host exposes it there.
  const sendMessage = typeof pi?.sendMessage === "function"
    ? pi.sendMessage.bind(pi)
    : typeof ctx?.sendMessage === "function"
      ? ctx.sendMessage.bind(ctx)
      : null;
  const PLAN_KEY = "aipi.workflow.plan";
  const STATUS_KEY = "aipi.workflow.status";
  const ACTIVITY_KEY = "aipi.workflow.activity";
  let spinnerTimer = null;
  let spinnerFrame = 0;
  let spinnerStartedAt = 0;
  let spinnerLabel = "";
  let spinnerActivity = ""; // live worker sub-activity (tool count + file being read + thinking)

  const sink = (message, kind = "info") => safeNotify(ctx, message, kind);
  sink.notify = sink;
  // Whether this host can render persistent multi-line widgets. The executor uses this to choose the
  // live-worker surface: a scrolling activity WIDGET on a rich host, or one notify line per event on a
  // plain/CLI host (where notify() is the only channel).
  sink.supportsWidgets = typeof ui.setWidget === "function";
  sink.setPlan = (lines) => {
    if (typeof ui.setWidget !== "function") return;
    try {
      ui.setWidget(PLAN_KEY, Array.isArray(lines) && lines.length ? lines : undefined);
    } catch {
      /* progress is best-effort and must never break execution */
    }
  };
  // Live worker activity panel: a persistent, scrolling list of the worker's recent thinking notes and
  // file/graph/tool operations, rendered above the editor like the planner. This is the "watch the agent
  // work" surface — notify() can't be used for it because the host shows notifications transiently. We render
  // via the setWidget COMPONENT-FACTORY form so the panel matches Pi's native look: thinking is italic in the
  // host's thinkingText color, tool/file ops are muted, the header is dim — using the real Theme the host
  // passes in (no pi-tui import; Component is just { render(width), invalidate() }). `payload` is
  // { tag, tools, elapsed_s, items:[{kind:"think"|"tool"|"text", detail}] }.
  sink.setActivity = (payload) => {
    if (typeof ui.setWidget !== "function") return;
    try {
      if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
        ui.setWidget(ACTIVITY_KEY, undefined, { placement: "aboveEditor" });
        return;
      }
      ui.setWidget(ACTIVITY_KEY, (_tui, theme) => buildActivityComponent(payload, theme), { placement: "aboveEditor" });
    } catch {
      /* best-effort */
    }
  };
  sink.setStatus = (text) => {
    if (typeof ui.setStatus !== "function") return;
    try {
      ui.setStatus(STATUS_KEY, text || undefined);
    } catch {
      /* best-effort */
    }
  };
  sink.startSpinner = (label = "") => {
    spinnerLabel = String(label ?? "");
    spinnerActivity = "";
    if (typeof ui.setStatus !== "function") return; // only animate when there is an updatable status line
    sink.stopSpinner();
    spinnerStartedAt = Date.now();
    spinnerFrame = 0;
    const tick = () => {
      const frame = PROGRESS_SPINNER_FRAMES[spinnerFrame % PROGRESS_SPINNER_FRAMES.length];
      spinnerFrame += 1;
      const elapsed = Math.round((Date.now() - spinnerStartedAt) / 1000);
      const activity = spinnerActivity ? ` · ${spinnerActivity}` : "";
      sink.setStatus(`${frame} ${spinnerLabel}${activity} · ${elapsed}s`.trim());
    };
    tick();
    spinnerTimer = setInterval(tick, 120);
    if (typeof spinnerTimer?.unref === "function") spinnerTimer.unref(); // never keep the process alive
  };
  // Live worker sub-activity fed into the running spinner line (e.g. "8 tools · read AdminSidebar.ts").
  // Updated in place by the executor's worker poll loop; rendered by the spinner tick (no extra line spam).
  sink.updateActivity = (text) => {
    spinnerActivity = String(text ?? "").trim();
  };
  // Persistent per-action history in the CONVERSATION (distinct from the transient notify line and the live
  // widget): each worker action is appended as a display message with triggerTurn:false, so it lands in the
  // scrollback without kicking off a turn. Best-effort + feature-detected — degrades to a no-op (the widget /
  // notify line still surfaces the activity) when the host exposes no sendMessage.
  sink.logActivity = (line) => {
    const text = String(line ?? "").replace(/\s+/g, " ").trim();
    if (!text || !sendMessage) return;
    try {
      sendMessage(
        { customType: "aipi-worker-activity", content: text, display: true },
        { triggerTurn: false },
      );
    } catch {
      /* best-effort — the live widget / notify line still surfaces the activity */
    }
  };
  sink.stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerActivity = "";
  };
  sink.clear = () => {
    sink.stopSpinner();
    sink.setStatus(undefined);
    if (typeof ui.setWidget === "function") {
      try {
        ui.setWidget(PLAN_KEY, undefined);
      } catch {
        /* best-effort */
      }
      try {
        ui.setWidget(ACTIVITY_KEY, undefined);
      } catch {
        /* best-effort */
      }
    }
  };
  return sink;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value) {
  return typeof value === "number" ? value : null;
}
