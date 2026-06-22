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
import { aipiImpact } from "./aipi-tools.js";
import { aipiHostModelReadiness } from "./pi-subagents.js";

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
    session_shutdown: async (event, ctx) => recordLifecycleEvent({
      projectRoot: rootFor(ctx, event),
      hook: "session_shutdown",
      event: compactEvent(event),
    }),
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
    message_end: async (event, ctx) =>
      handleEndDisciplineAudit({ event, ctx, pi, projectRoot: rootFor(ctx, event), hook: "message_end" }),
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

export async function handleSessionStart({ event, ctx, pi, projectRoot, coordinator = null }) {
  const snapshot = await buildRunSnapshot(projectRoot);
  const hostModel = await captureCoordinatorHostModel({
    coordinator,
    event,
    ctx,
    source: "session_start",
  });
  const subagents = await restoreSubagentCoordinatorFromSession({ coordinator, ctx, pi });
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

export async function restoreSubagentCoordinatorFromSession({ coordinator = null, ctx = {}, pi = null } = {}) {
  if (!coordinator?.restore) {
    return { restored: false, reason: "no coordinator" };
  }

  const entries = await readSessionEntries(ctx);
  const state = latestSubagentStateFromEntries(entries);
  if (!state) {
    return { restored: false, reason: "no state" };
  }

  try {
    const summary = coordinator.restore(state);
    const entry = {
      schema: "aipi.subagents.restore.v1",
      restored_at: new Date().toISOString(),
      ...(summary ?? { restored: false, reason: "empty summary" }),
    };
    safeAppendEntry(pi, "aipi.subagents.restore", entry);
    return entry;
  } catch (error) {
    const entry = {
      schema: "aipi.subagents.restore.v1",
      restored_at: new Date().toISOString(),
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
  let route = classifyAipiInputRoute(event?.text ?? "", { activeRun: active, codePipeline });
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
    await recordCodePipelineTrace({ projectRoot, pi, activeRun: active, pipeline: codePipeline }).catch(() => null);
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
      notify: makeProgressNotifier(ctx),
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
    const selected = await ctx.ui.select(question, choices);

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
      notify: makeProgressNotifier(ctx),
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

export function classifyAipiInputRoute(text, { activeRun = null, codePipeline = null, projectRoot = null } = {}) {
  const original = String(text ?? "").trim();
  if (!original || original.startsWith("/") || original.startsWith("@")) return null;
  const normalized = normalizeInputText(original);

  if (/\b(aipi|workflow|run)\b.*\b(status|estado)\b|\b(status|estado)\b.*\b(aipi|workflow|run)\b/.test(normalized)) {
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
  if (continuableRun && pipeline.substantive && pipeline.classification !== "trivial_or_mechanical") {
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

  const autoWorkflow = autoDispatchWorkflowForPipeline(pipeline);
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

  const workflow = workflowForInput(normalized);
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
  if (readiness.ok) return null;

  const runSnapshot = snapshot ?? await buildRunSnapshot(projectRoot).catch(() => ({ active: false }));
  const diagnosticError = new Error(readiness.message);
  diagnosticError.name = "AipiUnsupportedHostError";
  diagnosticError.code = readiness.code;
  diagnosticError.readiness = readiness;
  const errorEntry = await recordRuntimeError({
    projectRoot,
    hook,
    event: {
      ...compactEvent(event),
      unsupported_host_model: readiness.model_id,
      unsupported_host_provider: readiness.provider,
    },
    error: diagnosticError,
  }).catch(() => null);

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
    runtime_error_ref: errorEntry?.recorded_at ?? null,
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

function auditEndDisciplineEvent({ event, hook, activeDisciplines = [] } = {}) {
  const text = extractUserFacingText(event);
  const claims = claimEvidenceFindings(text);
  const outcome = outcomeFirstFinding(text);
  const checks = [
    {
      id: "finish-turn",
      state: "recorded",
      evidence: activeDisciplines.some((discipline) => discipline.id === "finish-turn")
        ? "finish-turn discipline activated for end-of-turn hook"
        : "finish-turn discipline not active for inferred role/stage",
    },
    {
      id: "outcome-first",
      state: outcome ? "warn" : "pass",
      evidence: outcome ?? "first sentence is outcome-oriented or no user-facing text was present",
    },
    {
      id: "claim-evidence",
      state: claims.length ? "warn" : "pass",
      evidence: claims.length
        ? `unsupported claim(s): ${claims.map((claim) => claim.term).join(", ")}`
        : "no unsupported fixed/passed/safe/done claim without an evidence rung",
    },
  ];
  const state = hook === "message_end" && claims.length ? "warn" : "pass";
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

function extractUserFacingText(event = {}) {
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
    if (text) return text;
  }
  return "";
}

function flattenText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join("\n");
  if (typeof value === "object") {
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

// A real agentic worker (reads the codebase, reasons, writes several artifacts) routinely takes
// minutes — far longer than the 120s spike-era default. With the short default the executor gave up
// and stamped the step BLOCKED ("worker did not finish: timeout") while the worker was still working
// and about to write its artifacts, so NO real workflow step could ever complete. The collect loop
// returns as soon as the worker is ready, so a generous ceiling only bounds a genuinely hung worker.
const AIPI_WORKFLOW_WORKER_COLLECT_TIMEOUT_MS = 20 * 60_000; // 20 minutes

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

export async function handleBeforeAgentStart({ event, ctx, pi, projectRoot, coordinator = null }) {
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
  if (!snapshot.active) return undefined;

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
    memory_refs: [
      ".aipi/memory/project/business-rules.md",
      ".aipi/memory/project/decisions.md",
      ".aipi/memory/project/project.md",
    ],
    blast_radius: await buildBlastRadiusPointer({
      projectRoot,
      query: [event?.prompt, snapshot.current_step, snapshot.stage].filter(Boolean).join(" "),
    }),
    active_disciplines: activeDisciplines,
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

  const entry = {
    schema: "aipi.context-event.v1",
    recorded_at: new Date().toISOString(),
    hook: "context",
    run_id: snapshot.run_id ?? null,
    workflow: snapshot.workflow ?? null,
    step_id: snapshot.step_id ?? null,
    removed_context_pointers: result.removedPointers,
    truncated_tool_results: result.truncatedToolResults,
    injected_context_pointer: result.injectedPointer,
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

export async function handleEndDisciplineAudit({ event, ctx, pi, projectRoot, hook }) {
  if (!(await isAipiInstalled(projectRoot))) return undefined;
  const snapshot = await buildRunSnapshot(projectRoot);
  const activeDisciplines = await loadAndRecordActiveDisciplines({ projectRoot, snapshot, event, ctx, pi, hook });
  const audit = auditEndDisciplineEvent({ event, hook, activeDisciplines });
  const entry = {
    schema: "aipi.end-discipline-audit.v1",
    audited_at: new Date().toISOString(),
    hook,
    run_id: snapshot.run_id ?? null,
    workflow: snapshot.workflow ?? null,
    step_id: snapshot.step_id ?? null,
    active_disciplines: activeDisciplines.map((discipline) => discipline.id),
    ...audit,
  };
  safeAppendEntry(pi, "aipi.discipline.end_audit", entry);
  await appendRuntimeEvent(projectRoot, DISCIPLINE_AUDIT_LOG, entry);
  if (snapshot.active) await appendRuntimeEvent(projectRoot, runScopedLog(snapshot.run_id, "discipline-audit.jsonl"), entry);
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
    event: compactEvent(event),
    error: serializeRuntimeError(error),
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
  const run = details.run;
  const activeDisciplines = details.active_disciplines ?? [];
  return [
    "AIPI active run context:",
    `- run_id: ${run.run_id}`,
    `- workflow: ${run.workflow}`,
    `- status: ${run.status}`,
    `- current_step: ${run.current_step ?? "none"}`,
    `- stage: ${run.stage ?? "none"}`,
    `- contract_path: ${run.contract_path ?? "none"}`,
    `- memory_refs: ${details.memory_refs.join(", ")}`,
    `- blast_radius: ${renderBlastRadiusSummary(details.blast_radius)}`,
    `- active_disciplines: ${activeDisciplines.map((discipline) => discipline.id).join(", ") || "none"}`,
    "Use these as pointers only; materialize detailed context through AIPI workflow/context tools.",
    ...renderActiveDisciplineText(activeDisciplines),
  ].join("\n");
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
    blast_radius: { status: "not_materialized", refs: [], relationships: [] },
    active_disciplines: activeDisciplines,
  };
}

async function buildBlastRadiusPointer({ projectRoot, query }) {
  if (!query?.trim()) return { status: "skipped", refs: [], relationships: [] };
  try {
    const impact = await aipiImpact({ projectRoot, query, limit: 4 });
    return {
      status: "available",
      graph: impact.graph,
      refs: (impact.refs ?? []).map((ref) => ({
        path: ref.path,
        line: ref.line ?? null,
        source: ref.source ?? null,
      })),
      relationships: (impact.relationships ?? []).map((edge) => ({
        relation: edge.relation,
        source_ref: edge.source_ref,
        target_ref: edge.target_ref,
      })),
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: String(error?.message ?? error),
      refs: [],
      relationships: [],
    };
  }
}

function renderBlastRadiusSummary(blastRadius = {}) {
  if (!blastRadius || blastRadius.status === "not_materialized") return "not_materialized";
  const refs = (blastRadius.refs ?? []).map((ref) => `${ref.path}${ref.line ? `:${ref.line}` : ""}`);
  const relationships = (blastRadius.relationships ?? []).map((edge) => `${edge.relation}:${edge.source_ref}->${edge.target_ref}`);
  return [blastRadius.status, ...refs, ...relationships].filter(Boolean).slice(0, 6).join(", ") || blastRadius.status || "unknown";
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

function compactEvent(event = {}) {
  const result = {};
  for (const [key, value] of Object.entries(event ?? {})) {
    if (key === "signal" || key === "payload" || key === "headers") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) {
      result[key] = value;
    }
  }
  return result;
}

function serializeRuntimeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error ?? "unknown error"),
    code: error?.code ?? null,
    stack: typeof error?.stack === "string" ? redactSecrets(error.stack) : null,
    cause: error?.cause
      ? {
          name: String(error.cause?.name ?? "Error"),
          message: String(error.cause?.message ?? error.cause),
          stack: typeof error.cause?.stack === "string" ? redactSecrets(error.cause.stack) : null,
        }
      : null,
  };
}

function isAipiContextPointer(message) {
  return message?.customType === "aipi.context-pointer" ||
    message?.details?.schema === "aipi.context-pointer.v1" ||
    (typeof message?.content === "string" && message.content.startsWith("AIPI active run context:"));
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
  const omitted = Math.max(0, text.length - maxChars);
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

function redactSecrets(text) {
  return String(text)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "sk-[REDACTED]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "gh_[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?([A-Za-z0-9._/+=-]{8,})["']?/gi, "$1=[REDACTED]");
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
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.appendFile(absPath, `${JSON.stringify(entry)}\n`);
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
export function makeProgressNotifier(ctx) {
  if (typeof ctx?.ui?.notify !== "function") return null;
  const ui = ctx.ui;
  const PLAN_KEY = "aipi.workflow.plan";
  const STATUS_KEY = "aipi.workflow.status";
  let spinnerTimer = null;
  let spinnerFrame = 0;
  let spinnerStartedAt = 0;
  let spinnerLabel = "";

  const sink = (message, kind = "info") => safeNotify(ctx, message, kind);
  sink.notify = sink;
  sink.setPlan = (lines) => {
    if (typeof ui.setWidget !== "function") return;
    try {
      ui.setWidget(PLAN_KEY, Array.isArray(lines) && lines.length ? lines : undefined);
    } catch {
      /* progress is best-effort and must never break execution */
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
    if (typeof ui.setStatus !== "function") return; // only animate when there is an updatable status line
    sink.stopSpinner();
    spinnerStartedAt = Date.now();
    spinnerFrame = 0;
    const tick = () => {
      const frame = PROGRESS_SPINNER_FRAMES[spinnerFrame % PROGRESS_SPINNER_FRAMES.length];
      spinnerFrame += 1;
      const elapsed = Math.round((Date.now() - spinnerStartedAt) / 1000);
      sink.setStatus(`${frame} ${spinnerLabel} ${elapsed}s`.trim());
    };
    tick();
    spinnerTimer = setInterval(tick, 120);
    if (typeof spinnerTimer?.unref === "function") spinnerTimer.unref(); // never keep the process alive
  };
  sink.stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
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
