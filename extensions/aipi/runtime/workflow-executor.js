import fs from "node:fs/promises";
import path from "node:path";
import { awaitingUserInputFromStepResult } from "./blocker-input.js";
import { buildStepContext, ContextMaterializationError } from "./context-builder.js";
import { aipiPromoteMemory, detectBusinessRuleDrift } from "./aipi-tools.js";
import { describeModel, resolveStepModel } from "./model-router.js";
import { recordWorkerModelRoute } from "./lifecycle-hooks.js";
import { classifyGateKind, MEMORY_CANDIDATE_SCAN_SCHEMA, validateStepResult } from "./step-result.js";

const terminalActions = new Set([
  "stop",
  "stop_for_user_question",
  "stop_for_human_approval",
  "escalate_to_human",
  "escalate_to_planning",
]);

// FIX 2: tag that identifies the default local-only adapter so the subagent adapter's preflight can
// distinguish it from a custom test/fallback adapter. Only the local adapter blocks agent steps; a
// custom fallback (e.g., a test pass-through) is trusted to handle them itself.
const LOCAL_FALLBACK_TAG = Symbol("aipi.local-fallback");

const PROGRESS_PHASE_LABELS = {
  running: "running…",
  retrying: "retrying…",
  passed: "passed",
  skipped: "skipped",
  blocked: "blocked",
  failed: "failed",
  approval_required: "needs approval",
};

// Glyphs for the live per-step planner checklist surfaced via the progress sink's setPlan().
const PROGRESS_PLAN_GLYPHS = {
  passed: "✓",
  skipped: "⊘",
  blocked: "✗",
  failed: "✗",
  abandoned: "✗",
  cancelled: "✗",
  approval_required: "✗",
  running: "▶",
  retrying: "↻",
  active: "▶",
  pending: "○",
};

const DEFAULT_TRANSIENT_PROVIDER_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  jitterMs: 100,
};

// A step that BLOCKS only because the worker returned a verdict but didn't write its required artifact(s)
// is a MECHANICAL miss (not a real business/destructive gate). Auto-retry the same step this many times
// with a firm "write the files" remediation before falling back to asking the user — so the workflow
// self-resolves the common "0 tools, no artifact" case instead of stopping.
const AUTO_ARTIFACT_RETRIES = 2;

export async function executeWorkflowRun({
  projectRoot,
  runId = null,
  adapter = createLocalWorkflowAdapter(),
  now = () => new Date(),
  parentInteractiveToolCallHook = "registered_parent_interactive_tool_call_hook",
  notify = null,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const root = path.resolve(projectRoot);
  const activeRunId = runId ?? (await readActiveRunId(root));
  if (!activeRunId) throw new Error("No active AIPI run; start a workflow first");

  const runDir = path.join(root, ".aipi", "runtime", "runs", activeRunId);
  const state = JSON.parse(await fs.readFile(path.join(runDir, "state.json"), "utf8"));
  const contract = JSON.parse(await fs.readFile(path.join(root, ".aipi", "runtime-contract.json"), "utf8"));
  const workflowText = await fs.readFile(path.join(root, state.source_workflow), "utf8");
  const workflow = parseWorkflowDefinition(workflowText, state.workflow);
  const stepById = new Map(workflow.steps.map((step, index) => [step.id, { ...step, index }]));
  const runLimits = contract.runLimits ?? {};
  const maxVisits = runLimits.maxTotalStepVisits ?? 40;
  const maxVisitsPerStep = runLimits.maxVisitsPerStep ?? Number.POSITIVE_INFINITY;
  const maxConsecutiveFailures = runLimits.maxConsecutiveFailures ?? Number.POSITIVE_INFINITY;
  const events = [];
  // ADV-58-3: surface per-step progress to the terminal so a long run does not look frozen.
  // Per-step run count = COMPLETED executions IN THIS DISPATCH (each time the step produced a result),
  // plus 1 while the step is actively running. An attempt interrupted by a session restart/resume leaves
  // no result, so it does NOT inflate the count — `triage (1)` stays (1) on resume — while a real gate loop
  // (fix -> verify -> review -> fix) shows (2), (3)…. Unvisited steps show just their name.
  const stepLabel = (stepId, running = false) => {
    const runs = (state.step_runs?.[stepId] ?? 0) + (running ? 1 : 0);
    return runs >= 1 ? `${stepId} (${runs})` : stepId;
  };
  // A planner/checklist: one line per workflow step with a status glyph, re-rendered as the run
  // advances. The active step is shown as running even before it is marked terminal.
  const buildPlanLines = (activeStepId, activePhase) =>
    workflow.steps.map((step) => {
      let status = state.steps?.find((entry) => entry.id === step.id)?.status ?? "pending";
      const running = step.id === activeStepId && activePhase === "running";
      if (running) status = "running";
      const glyph = PROGRESS_PLAN_GLYPHS[status] ?? "○";
      return `${glyph} ${stepLabel(step.id, running)}`;
    });
  const emitProgress = (stepId, phase) => {
    if (typeof notify !== "function") return;
    const verb = PROGRESS_PHASE_LABELS[phase] ?? phase;
    const label = stepLabel(stepId, phase === "running");
    try {
      // Legacy one-line notify — ONLY for a plain CLI/notify-only host. On a widget host the plan checklist
      // (setPlan) + the spinner status line already show the step, so this line is redundant and just clutters
      // the top with a dim "AIPI planning: intake running…" duplicate. Skip it when widgets are available.
      if (notify.supportsWidgets !== true) notify(`AIPI ${state.workflow}: ${label} ${verb}`, "info");
      // Richer, feature-detected surfaces (no-ops when notify is a plain function or the host lacks them).
      notify.setPlan?.(buildPlanLines(stepId, phase));
      if (phase === "running") notify.startSpinner?.(`${state.workflow}: ${label}`);
      else notify.stopSpinner?.();
    } catch {
      /* progress is best-effort and must never break execution */
    }
  };
  const clearProgress = () => {
    try {
      // Prefer the sink's richer clear() (stops spinner + clears the status line AND the planner widget)
      // so a thrown/failed run does not leave the planner stuck showing the failed step as "▶ running".
      if (typeof notify?.clear === "function") {
        notify.clear();
        return;
      }
      notify?.stopSpinner?.();
      notify?.setStatus?.(undefined);
      notify?.setPlan?.([]); // fallback for a sink without clear(): empty the planner widget
    } catch {
      /* best-effort */
    }
  };

  state.status = "running";
  state.execution_mode = state.workflow === "quick" ? "local-quick-slice-v1" : "local-workflow-slice-v1";
  state.policy = {
    controller_gate: "executor_declared_artifact_only",
    controller_write_scope: "declared_step_artifacts_only",
    parent_interactive_tool_call_hook: parentInteractiveToolCallHook,
  };
  state.step_visits ??= {}; // entries (incl. resume re-entries) — used for run limits
  state.step_runs ??= {}; // COMPLETED executions per step in this dispatch — used for the planner label
  state.consecutive_failures ??= 0;
  state.policy_decisions ??= [];
  // FIX 4: gate-failure feedback keyed by target step id; populated when a review step FAILs with
  // a HIGH/CRITICAL finding and loops back to a fix step so the fix step knows what to address.
  state.gate_failure_feedback ??= {};

  // FIX 2b: fail fast before entering the execution loop if the adapter pre-declares it cannot
  // execute some steps. This surfaces the issue at run-start instead of mid-run BLOCKED.
  const preflightBlocked = adapter.preflight?.(workflow.steps) ?? [];
  if (preflightBlocked.length) {
    const ids = preflightBlocked.map((s) => s.id).join(", ");
    throw new Error(
      `adapter preflight: no executable adapter is configured for steps [${ids}]; refusing to start run ${activeRunId}`,
    );
  }

  // try/finally so the progress spinner's setInterval is torn down on EVERY exit — including a thrown
  // buildStepContext / executeStep / persistRunState after a step armed the spinner. Without this the
  // unref'd interval keeps firing setStatus forever in the long-lived interactive TUI for a failed run.
  try {
  while (state.status === "running") {
    const stepId = state.current_step ?? nextPendingStep(state);
    if (!stepId) {
      state.status = "completed";
      break;
    }
    if (totalVisits(state.step_visits) >= maxVisits) {
      exhaustRunLimit(state, contract, `runLimits.maxTotalStepVisits exhausted (${maxVisits})`);
      events.push({ type: "run_limit_exhausted", limit: "maxTotalStepVisits", value: maxVisits });
      break;
    }
    if ((state.step_visits[stepId] ?? 0) >= maxVisitsPerStep) {
      exhaustRunLimit(state, contract, `runLimits.maxVisitsPerStep exhausted for ${stepId} (${maxVisitsPerStep})`);
      events.push({
        type: "run_limit_exhausted",
        limit: "maxVisitsPerStep",
        step_id: stepId,
        value: maxVisitsPerStep,
      });
      break;
    }

    const step = stepById.get(stepId);
    if (!step) throw new Error(`Run state references unknown workflow step ${stepId}`);

    const requirement = firstUnpassedRequirement(step, state);
    if (requirement) {
      const rootBlock = rootRequirementBlock({ requirement, state, stepById });
      const blockedStep = rootBlock.step ?? stepById.get(requirement) ?? step;
      const reason = rootBlock.reason ?? `required step ${requirement} has not passed`;
      const blockedAt = now().toISOString();
      state.status = "blocked";
      state.current_step = blockedStep.id;
      state.blocked_reason = reason;
      state.awaiting_user_input = awaitingUserDecisionForBlockedGate({
        step: blockedStep,
        reason,
        createdAt: blockedAt,
      });
      events.push({ type: "blocked", step_id: blockedStep.id, reason, blocked_dependency: step.id });
      emitProgress(blockedStep.id, "blocked");
      break;
    }

    state.step_visits[step.id] = (state.step_visits[step.id] ?? 0) + 1;
    markStep(state, step.id, { status: "running", started_at: now().toISOString() });
    state.current_step = step.id;
    emitProgress(step.id, "running");
    await persistRunState(root, state);

    let context = null;
    try {
      context = await buildStepContext({ root, state, workflow, step, contract });
    } catch (error) {
      if (!(error instanceof ContextMaterializationError)) throw error;
      const blockedAt = now().toISOString();
      markStep(state, step.id, {
        status: "blocked",
        verdict: "BLOCKED",
        error: error.message,
        finished_at: blockedAt,
      });
      state.status = "blocked";
      state.current_step = step.id;
      state.blocked_reason = error.message;
      state.awaiting_user_input = awaitingUserDecisionForBlockedGate({
        step,
        reason: error.message,
        createdAt: blockedAt,
      });
      events.push({ type: "blocked", step_id: step.id, reason: error.message });
      emitProgress(step.id, "blocked");
      await persistRunState(root, state);
      break;
    }

    const result = await executeStepWithTransientRetries({
      adapter,
      args: { root, state, workflow, step, context, contract, notify },
      retry: transientProviderRetryConfig(contract),
    });
    // The step produced a result (a real, completed execution — transient retries are internal and don't
    // count). This drives the planner's `(n)` label so an interrupted/resumed attempt doesn't inflate it.
    state.step_runs[step.id] = (state.step_runs[step.id] ?? 0) + 1;
    const artifactContents = await readStepArtifactContents({ root, result });
    // shellLess is the TRUSTED descriptor-derived signal (set by the coordinator/fanout aggregator, never by
    // the worker) that relaxes the evidence bar to `written` for a parallel review fanout — see step-result.js.
    const validation = validateStepResult(result, { step, contract, artifactContents, shellLess: result?.aipi_shell_less === true });
    recordPolicyDecision({ state, step, result, validation, now });
    const missingArtifacts = validation.gatePassed
      ? await missingRequiredArtifacts({ root, state, step, result })
      : [];
    const memoryPromotionGate = validation.gatePassed && missingArtifacts.length === 0
      ? await materializeStepMemoryPromotions({ root, state, step, result, now })
      : null;
    // RC2 follow-up: a memory-promotion SKIP ("no durable signal") is backed by an EXECUTOR-authored on-disk
    // aipi.memory-candidate-scan.v1 record — the worker's evidence payload is not trusted (it is never even
    // told to produce it). The skip is BLOCKED only on the unambiguous self-contradiction of carrying durable
    // promotions while claiming none; undrained candidates are surfaced in the record, not hard-blocked.
    const memorySkipGate = validation.gatePassed && missingArtifacts.length === 0
      ? await materializeMemorySkipScanRecord({ root, state, step, result, now })
      : null;
    if (validation.gatePassed && missingArtifacts.length === 0) {
      // RC4: surface (never mutate) business-rule drift introduced by this step. Best-effort + detection-only
      // (no shell exec on the hot path) — a step is NEVER failed because the drift scan failed.
      await materializeBusinessRuleDriftCheck({ root, now });
    }
    await writeStepResult({ root, state, step, result, validation, missingArtifacts });

    if (validation.gatePassed && missingArtifacts.length === 0 && !memoryPromotionGate?.error && !memorySkipGate?.error) {
      const status = result.verdict === "SKIPPED" ? "skipped" : "passed";
      // Materialize controller-owned shared artifacts ONLY now that the AUTHORITATIVE gate has passed (and no
      // required artifact is missing) — not on the worker's self-PASS — so a step the executor BLOCKS never
      // updates a run-root surface. PASS only (a SKIPPED step produced no controller_updates content).
      if (result.verdict === "PASS") {
        await promoteControllerUpdates({ root, plan: controllerUpdateStagingPlan(state, step) });
      }
      markStep(state, step.id, {
        status,
        verdict: result.verdict,
        finished_at: now().toISOString(),
        result_path: resultPathFor(state, step),
        artifacts: result.artifacts,
        skip_condition: result.skip_condition ?? null,
      });
      events.push({ type: status, step_id: step.id, verdict: result.verdict });
      emitProgress(step.id, status);
      state.consecutive_failures = 0;
      // FIX 4c: clear any pending gate-failure feedback for this step now that it has passed —
      // the step addressed the prior review findings, so carry-forward is no longer needed.
      if (state.gate_failure_feedback?.[step.id]) {
        delete state.gate_failure_feedback[step.id];
      }
      if (state.artifact_retries?.[step.id]) {
        delete state.artifact_retries[step.id];
      }
      if (state.awaiting_user_input?.step_id === step.id) state.awaiting_user_input = null;
      state.current_step = nextStepId(workflow, step);
      if (!state.current_step) state.status = "completed";
      await persistRunState(root, state);
      continue;
    }

    const target = missingArtifacts.length || memoryPromotionGate?.error || memorySkipGate?.error
      ? step.gate.on_verdict?.FAIL ?? null
      : branchTarget(step, validation);
    const transientProviderError = transientProviderFailureMessage(result);
    const error = missingArtifacts.length
      ? `missing required artifacts: ${missingArtifacts.join(", ")}`
      : memoryPromotionGate?.error
        ? memoryPromotionGate.error
      : memorySkipGate?.error
        ? memorySkipGate.error
      : transientProviderError
        ? transientProviderError
      : validation.errors.length
        ? validation.errors.join("; ")
        : policyGateMessage(validation, target);
    const failedStatus = gateFailureStatus(result, validation);
    const structuralNoAdapter = isStructuralNoExecutableAdapterBlock(result, error, validation);
    const transientProviderBlock = isTransientProviderFailureBlock(result, validation);
    // FIX 3: detect subagent worker crashes (spawned but did not finish) as an infra block so
    // they don't consume the step-visit budget or count toward consecutive gate failures.
    const workerCrash = isWorkerCrashBlock(result, validation);
    const infraBlock = structuralNoAdapter || transientProviderBlock || workerCrash;
    const finishedAt = now().toISOString();
    // FIX 3d: record failure_class so plan-executor and analytics can distinguish infra noise
    // (no worker signal) from real gate rejections (worker ran but review found issues).
    const failureClass = infraBlock
      ? "infra"
      : failedStatus === "failed"
      ? "gate_rejection"
      : "blocked";
    markStep(state, step.id, {
      status: failedStatus,
      verdict: result?.verdict ?? null,
      error,
      finished_at: finishedAt,
      result_path: resultPathFor(state, step),
      artifacts: result?.artifacts ?? [],
      failure_class: failureClass,
    });
    events.push({ type: failedStatus, step_id: step.id, verdict: validation.verdict, error, target });

    if (infraBlock) {
      // FIX 3c: roll back the step visit consumed above so an infra block doesn't silently eat
      // the per-step retry budget — a worker that never produced a result is not a real attempt.
      state.step_visits[step.id] = Math.max(0, (state.step_visits[step.id] ?? 1) - 1);
      state.status = "blocked";
      state.current_step = step.id;
      state.blocked_reason = error;
      state.awaiting_user_input = awaitingUserDecisionForBlockedGate({
        step,
        result,
        reason: error,
        createdAt: finishedAt,
        infra: true,
      });
      events.push({
        type: transientProviderBlock
          ? "transient_provider_failure"
          : workerCrash
          ? "worker_crash"
          : "structural_no_executable_adapter",
        step_id: step.id,
        reason: error,
      });
      emitProgress(step.id, "blocked");
      await persistRunState(root, state);
      break;
    }

    // Auto-resolve a MECHANICAL missing-artifact block: the worker returned a verdict but never wrote the
    // required file(s) (the "0 tools, no artifact" case). Re-run the SAME step (bounded by
    // AUTO_ARTIFACT_RETRIES) with a firm "write the files" remediation instead of stopping to ask the user;
    // only after the retries are spent does it fall through to the block-and-ask below.
    if (missingArtifacts.length) {
      const attempt = (state.artifact_retries?.[step.id] ?? 0) + 1;
      if (attempt <= AUTO_ARTIFACT_RETRIES) {
        state.artifact_retries ??= {};
        state.artifact_retries[step.id] = attempt;
        state.gate_failure_feedback ??= {};
        state.gate_failure_feedback[step.id] = [artifactWriteRemediation(missingArtifacts)];
        state.current_step = step.id;
        state.awaiting_user_input = null;
        events.push({ type: "artifact_retry", step_id: step.id, attempt, missing: missingArtifacts });
        emitProgress(step.id, "retrying");
        await persistRunState(root, state);
        continue;
      }
    }

    state.consecutive_failures = (state.consecutive_failures ?? 0) + 1;

    if (state.consecutive_failures >= maxConsecutiveFailures) {
      exhaustRunLimit(
        state,
        contract,
        `runLimits.maxConsecutiveFailures exhausted (${maxConsecutiveFailures})`,
      );
      events.push({
        type: "run_limit_exhausted",
        limit: "maxConsecutiveFailures",
        value: maxConsecutiveFailures,
      });
      await persistRunState(root, state);
      break;
    }

    if (target && !terminalActions.has(target)) {
      // FIX 4a: record gate-failure feedback for the target step so it knows which HIGH/CRITICAL
      // review finding it must address on the next visit.
      const failFeedback = await extractReviewGateFailureFeedback({ root, result, step, state, now });
      if (failFeedback) {
        state.gate_failure_feedback ??= {};
        const prevEntries = state.gate_failure_feedback[target] ?? [];
        // FIX 4b: fingerprint-escalate on a repeated identical finding — a fix step that looped back
        // once but still surfaces the exact same HIGH/CRITICAL finding is structurally stuck.
        const fingerprint = (e) => `${e.finding?.artifact ?? ""}|${(e.finding?.preview ?? "").slice(0, 120)}`;
        const newFp = fingerprint(failFeedback);
        if (prevEntries.length >= 1 && newFp && fingerprint(prevEntries[prevEntries.length - 1]) === newFp) {
          exhaustRunLimit(
            state,
            contract,
            `repeated gate finding at ${target}: ${failFeedback.finding?.preview?.slice(0, 120) ?? "unresolved HIGH finding"}`,
          );
          events.push({
            type: "run_limit_exhausted",
            limit: "repeated_gate_finding",
            step_id: target,
            reason: failFeedback.finding?.preview?.slice(0, 120) ?? "unresolved HIGH finding",
          });
          await persistRunState(root, state);
          break;
        }
        state.gate_failure_feedback[target] = [...prevEntries, failFeedback];
      }
      // Surface the failure + loop in the planner: the step renders ✗ and its run-count makes the retry
      // visible, instead of a silently-incrementing `running…` that reads as forward progress.
      emitProgress(step.id, failedStatus);
      state.current_step = target;
      state.awaiting_user_input = null;
      await persistRunState(root, state);
      continue;
    }

    const awaitingUserInput = shouldAskUserOnGateStop({ target, failedStatus });
    const blockedAt = now().toISOString();
    state.status = awaitingUserInput ? "blocked" : terminalStatus(target, failedStatus);
    state.current_step = awaitingUserInput ? step.id : terminalActions.has(target) ? null : step.id;
    state.blocked_reason = error;
    state.awaiting_user_input = awaitingUserInput
      ? awaitingUserDecisionForBlockedGate({
          step,
          result,
          reason: error,
          createdAt: blockedAt,
        })
      : null;
    if (awaitingUserInput || state.status === "blocked") emitProgress(step.id, "blocked");
    await persistRunState(root, state);
  }

  state.completed_at = state.status === "completed" ? now().toISOString() : state.completed_at;
  await persistRunState(root, state);
  if (isTerminalActiveStatus(state.status)) {
    await clearActiveRunPointer(root, activeRunId);
  }
  return { runId: activeRunId, status: state.status, state, events };
  } finally {
    clearProgress(); // stop the spinner + clear the animated status line on every exit, incl. throws
  }
}

export function createLocalWorkflowAdapter() {
  return {
    [LOCAL_FALLBACK_TAG]: true, // FIX 2: marks this as the default local-only adapter (blocks agent steps)
    async executeStep({ state, step, contract }) {
      const skipCondition = localSkipCondition(step);
      const policyDecision = skipCondition ? null : localPolicyDecision(step);
      const verdict = skipCondition ? "SKIPPED" : "BLOCKED";
      const evidence = skipCondition
        ? localSkipEvidence({ state, step, contract, skipCondition })
        : [
            {
              rung: "blocked",
              source: "aipi-local-executor",
              ref: path.join(state.run_rel_dir ?? runRelDir(state), "steps", step.id).replaceAll("\\", "/"),
              result: `no executable adapter is configured for ${step.id}; refusing to self-stamp PASS`,
            },
          ];
      return {
        schema: "aipi.step-result.v1",
        step_id: step.id,
        agent_ids: step.agents.length ? step.agents : ["aipi-local-executor"],
        verdict,
        skip_condition: skipCondition ?? undefined,
        policy_decision: policyDecision ?? undefined,
        evidence,
        artifacts: [],
      };
    },
  };
}

function localSkipEvidence({ state, step, contract, skipCondition }) {
  const required = contract?.skipConditions?.[skipCondition]?.requiresEvidence ?? [];
  const baseRef = path.join(state.run_rel_dir ?? runRelDir(state), "steps", step.id).replaceAll("\\", "/");
  if (!required.length) {
    return [
      {
        rung: "written",
        source: "aipi-local-executor",
        ref: baseRef,
        result: `step skipped through ${skipCondition}`,
      },
    ];
  }
  return required.map((token) => ({
    rung: "written",
    source: "aipi-local-executor",
    ref: `${baseRef}#${token}`,
    result: `skip_condition ${skipCondition} includes required evidence token ${token}`,
    evidence_token: token,
  }));
}

export function createSubagentWorkflowAdapter(coordinator, {
  fallback = createLocalWorkflowAdapter(),
  // `workerStepIds = null` (default) means EVERY step that has agents executes as a real subagent —
  // NOT only the spike step `quick_change`. This is what makes real multi-step workflows
  // (bugfix/feature/planning/…) actually run: previously every step except `quick_change`/`review_swarm`
  // fell through to the local fallback and stamped BLOCKED ("no executable adapter is configured"),
  // trapping the user in an unrunnable workflow.
  //
  // Routing in auto mode (default):
  //   - REVIEW-stage multi-agent step  -> FAN OUT to one subagent per declared review agent, so the
  //     workflow's specialized reviewers (security, blast-radius, complexity, integration, …) ALL run
  //     and produce their declared artifacts — not just the lead agent (ADV-60-1 originally regressed
  //     this for any review step not literally named `review_swarm`).
  //   - any other agent-bearing step   -> single lead worker (agents[0] produces the step's artifacts);
  //     implementation/planning steps intentionally collaborate through one lead, not independent fan-out.
  //   - no-agent step                  -> local fallback (skip-condition / policy-only).
  //
  // Pass an explicit `workerStepIds` array to RESTRICT execution to named steps (legacy spike/tests);
  // in restrict mode the review-stage auto fan-out is disabled and only `fanoutStepIds` fan out.
  workerStepIds = null,
  fanoutStepIds = ["review_swarm"],
  pollIntervalMs = 50,
  collectTimeoutMs = 120_000,
  modelResolver = resolveStepModel,
} = {}) {
  if (!coordinator?.spawn || !coordinator?.collect) {
    throw new Error("createSubagentWorkflowAdapter requires a SubagentCoordinator-like object");
  }
  const workerRestrict = workerStepIds != null;
  const workerSteps = new Set(workerStepIds ?? []);
  const fanoutSteps = new Set(fanoutStepIds ?? []);
  const runFanout = (args) => executeFanoutSubagentStep({ ...args, coordinator, pollIntervalMs, collectTimeoutMs, modelResolver });
  const runWorker = (args) => executeSubagentStep({ ...args, coordinator, pollIntervalMs, collectTimeoutMs, modelResolver });
  const shouldFanout = (step) => {
    const agentCount = step.agents?.length ?? 0;
    if (agentCount <= 1) return false;
    if (fanoutSteps.has(step.id)) return true;
    // Default policy: a multi-agent REVIEW-stage step fans out to its specialized reviewers.
    return !workerRestrict && step.stage === "review";
  };
  return {
    // FIX 2a: report steps the adapter cannot execute BEFORE the run starts. In default auto mode
    // every agent-bearing step is routed to a real subagent so there are no blocked steps. In
    // restrict mode (explicit workerStepIds) only named steps run as workers; any agent-bearing
    // step not in the allow-list and not fanout-eligible falls to the fallback adapter. We only
    // flag those steps as unexecutable when the fallback is the DEFAULT local adapter (which would
    // return BLOCKED for all agent-bearing steps). A custom fallback (e.g., a test pass-through)
    // is trusted to handle those steps and is not flagged.
    preflight(steps) {
      if (!workerRestrict) return []; // auto mode: all agent-bearing steps are handled
      // Non-local fallbacks (custom adapters) handle uncovered steps themselves.
      if (!fallback[LOCAL_FALLBACK_TAG]) return [];
      return (steps ?? []).filter((step) => {
        const agentCount = step.agents?.length ?? 0;
        if (agentCount === 0) return false; // no agents → handled by fallback (skip/policy)
        if (shouldFanout(step)) return false; // review fanout → handled
        if (workerSteps.has(step.id)) return false; // in the explicit allow-list → handled
        return true; // has agents, not in allow-list, not fanout → local fallback would BLOCK it
      });
    },
    async executeStep(args) {
      const agentCount = args.step.agents?.length ?? 0;
      if (shouldFanout(args.step)) return runFanout(args);
      if (agentCount === 0) return fallback.executeStep(args);
      // Restrict mode (explicit workerStepIds): only the named steps run as workers; others fall back.
      if (workerRestrict && !workerSteps.has(args.step.id)) return fallback.executeStep(args);
      return runWorker(args);
    },
    // Resolve a concrete model on a DIFFERENT authed provider than the step's configured model, for a
    // rate-limit retry (see executeStepWithTransientRetries). Returns { model, fromProvider, toProvider } or
    // null when no distinct authed provider is available. Best-effort — never throws.
    async resolveRateLimitFallback(args) {
      if (typeof coordinator.pickFallbackModel !== "function") return null;
      let resolution = null;
      try {
        resolution = await modelResolver({
          root: args.root,
          workflow: args.workflow,
          step: args.step,
          context: args.context,
          contract: args.contract,
        });
      } catch {
        return null;
      }
      const fromProvider = providerOfModelRef(resolution?.model);
      const model = coordinator.pickFallbackModel({ excludeProvider: fromProvider });
      if (!model) return null;
      return { model, fromProvider, toProvider: providerOfModelRef(model) };
    },
  };
}

// Provider name of a model ref ({provider,id} or "provider/id" string), lowercased, or null.
function providerOfModelRef(model) {
  if (!model) return null;
  if (typeof model === "string") {
    const sep = model.indexOf("/");
    return sep > 0 ? model.slice(0, sep).trim().toLowerCase() : null;
  }
  return String(model.provider ?? model.family ?? "").trim().toLowerCase() || null;
}

async function executeFanoutSubagentStep({
  root,
  state,
  workflow,
  step,
  context,
  contract,
  coordinator,
  pollIntervalMs,
  collectTimeoutMs,
  modelResolver,
  notify = null,
  modelOverride = null,
}) {
  const artifacts = step.produces.map((template) => renderTemplate(template, state, step));
  const assignments = assignArtifactsToAgents(step.agents, artifacts);
  const spawned = [];

  for (const [index, agent] of step.agents.entries()) {
    const assignedArtifacts = assignments.get(agent) ?? [];
    const modelResolution = await modelResolver({
      root,
      workflow,
      step: { ...step, agents: [agent] },
      context,
      contract,
    });
    // A rate-limit fallback forces every fanout worker onto a concrete model on a different authed provider.
    const workerModel = modelOverride ?? modelResolution.model ?? undefined;
    const descriptor = {
      agent_id: agent,
      step_id: step.id,
      model_class: modelResolution.model_class,
      model_resolution_source: modelOverride ? "rate-limit-fallback" : modelResolution.source,
      model: workerModel,
      thinking_level: modelResolution.thinking_level,
      result_schema: "aipi.step-result.v1",
      artifact_target: path.join(runRelDir(state), "steps", step.id).replaceAll("\\", "/"),
      expected_artifacts: assignedArtifacts,
      owned_files: assignedArtifacts,
      write_scope: resolveWriteScope(step),
      // Parallel fanout (review) workers get NO shell — a shell bypasses owned-file/controller-path write
      // guards, so giving it to concurrent workers would void write-disjointness. They review by reading.
      allow_shell: false,
      context_packet: JSON.stringify(
        {
          schema: "aipi.worker-context.v1",
          workflow: workflow.name,
          step_id: step.id,
          step_name: step.name ?? null,
          step_prompt: step.prompt ? renderText(step.prompt, state, step) : null,
          run_id: state.run_id,
          contract_path: state.contract_path,
          fanout_index: index,
          fanout_count: step.agents.length,
          expected_artifacts: assignedArtifacts,
          context,
        },
        null,
        2,
      ),
    };
    const dispatched = dispatchSubagent(coordinator, descriptor);
    spawned.push({ catalogAgentId: agent, model: workerModel ?? null, ...dispatched });
    // Log the unique dispatched id (base:uuid), not the catalog base name, so a routing record can be
    // correlated back to its worker session jsonl.
    await recordWorkerRoute({ root, state, step, agentId: dispatched.agent_id ?? agent, descriptor, modelResolution, coordinator });
  }

  const collected = [];
  for (const worker of spawned) {
    const collect = await collectSubagentResult(coordinator, worker.agent_id, {
      pollIntervalMs,
      collectTimeoutMs,
      notify,
      root,
      stepId: step.id,
      model: worker.model,
    });
    if (!collect.ready) {
      return workerOutcomeOrThrow({ step, agentId: worker.agent_id, collect });
    }
    collected.push(collect);
  }

  // TRUSTED shell-less marker for the aggregate, derived from each worker's coordinator-stamped flag (set
  // from the descriptor's allow_shell, never from worker-reported evidence). A fanout of shell-less reviewers
  // can only reach `written`; the executor's gate relaxes to that bar via this flag — not via any evidence
  // source string the workers control.
  const aggregateShellLess = collected.length > 0 && collected.every((item) => item.step_result?.aipi_shell_less === true);

  // Per-worker model provenance, folded up from each worker's coordinator-stamped step_result. A review
  // fanout discards the per-worker step_result (it cherry-picks fields), so without this the cross-family
  // signal — e.g. reviewers on openai-codex/gpt-5.5 while the implementer ran on anthropic/... — never
  // reaches the review RESULT.json. `models` is self-describing (carries its own agent_id), so it stays
  // correct regardless of ordering; `model_cross_family` is the at-a-glance "a reviewer ran off-family" flag.
  const aggregateModels = collected.map((item) => ({
    agent_id: item.agent_id,
    model_resolved: item.step_result?.model_resolved ?? null,
    model_family: item.step_result?.model_family ?? null,
    model_cross_family: item.step_result?.model_cross_family === true,
  }));
  const aggregateModelCrossFamily = aggregateModels.some((entry) => entry.model_cross_family);

  const nonPass = collected.find((item) => item.step_result?.verdict !== "PASS");
  if (nonPass) {
    return {
      schema: "aipi.step-result.v1",
      step_id: step.id,
      agent_ids: collected.map((item) => item.agent_id),
      verdict: nonPass.step_result?.verdict ?? "FAIL",
      evidence: collected.flatMap((item) => item.step_result?.evidence ?? []),
      artifacts: collected.flatMap((item) => item.step_result?.artifacts ?? item.artifacts ?? []),
      aipi_shell_less: aggregateShellLess,
      models: aggregateModels,
      model_cross_family: aggregateModelCrossFamily,
    };
  }

  return {
    schema: "aipi.step-result.v1",
    step_id: step.id,
    agent_ids: collected.map((item) => item.agent_id),
    verdict: "PASS",
    aipi_shell_less: aggregateShellLess,
    models: aggregateModels,
    model_cross_family: aggregateModelCrossFamily,
    evidence: [
      {
        rung: "written",
        source: "aipi-subagent-fanout",
        ref: collected.map((item) => item.agent_id).join(", "),
        result: `collected ${collected.length} worker results for ${step.id}`,
      },
      ...collected.flatMap((item) => item.step_result?.evidence ?? []),
    ],
    artifacts: [...new Set(collected.flatMap((item) => item.step_result?.artifacts ?? item.artifacts ?? []))],
  };
}

async function executeSubagentStep({
  root,
  state,
  workflow,
  step,
  context,
  contract,
  coordinator,
  pollIntervalMs,
  collectTimeoutMs,
  modelResolver,
  notify = null,
  modelOverride = null,
}) {
  const artifacts = step.produces.map((template) => renderTemplate(template, state, step));
  // controller_updates are run-root single-writer surfaces owned by the controller — a worker cannot write
  // them (isControllerOwnedPath blocks the guard). Stage each under steps/<id>/<basename>, a path the worker
  // CAN own and write (and which counts as PASS evidence); the controller promotes the staged content to the
  // run-root path after a PASS. Without this a controller_updates-only step (planning/contract) had no
  // worker-writable evidence -> forced BLOCKED, and intake's RUN-MANIFEST.md was silently never materialized.
  const controllerStaging = controllerUpdateStagingPlan(state, step);
  const expectedArtifacts = [...artifacts, ...controllerStaging.map((entry) => entry.staging)];
  const modelResolution = await modelResolver({ root, workflow, step, context, contract });
  // A rate-limit fallback (see executeStepWithTransientRetries) forces a concrete model on a different authed
  // provider for this retry; it wins over the class-resolved model.
  const workerModel = modelOverride ?? modelResolution.model ?? undefined;
  const descriptor = {
    agent_id: step.agents[0] ?? "aipi-worker",
    step_id: step.id,
    model_class: modelResolution.model_class,
    model_resolution_source: modelOverride ? "rate-limit-fallback" : modelResolution.source,
    model: workerModel,
    thinking_level: modelResolution.thinking_level,
    result_schema: "aipi.step-result.v1",
    artifact_target: path.join(runRelDir(state), "steps", step.id).replaceAll("\\", "/"),
    expected_artifacts: expectedArtifacts,
    owned_files: expectedArtifacts,
    write_scope: resolveWriteScope(step),
    context_packet: JSON.stringify(
      {
        schema: "aipi.worker-context.v1",
        workflow: workflow.name,
        step_id: step.id,
        step_name: step.name ?? null,
        step_prompt: step.prompt ? renderText(step.prompt, state, step) : null,
        run_id: state.run_id,
        contract_path: state.contract_path,
        expected_artifacts: expectedArtifacts,
        controller_updates: controllerStaging.map((entry) => ({ write: entry.staging, promoted_to: entry.target })),
        context,
      },
      null,
      2,
    ),
  };

  // Clear any stale expected outputs (produces + staged controller_updates) from a prior attempt BEFORE
  // dispatch, so a no-op redispatch can't pass (and re-promote) old content on the strength of a pre-existing
  // file — the worker must freshly write its artifacts this run to earn evidence (SE-3).
  await clearExpectedArtifacts({ root, paths: expectedArtifacts });
  const { agent_id: agentId } = dispatchSubagent(coordinator, descriptor);
  await recordWorkerRoute({ root, state, step, agentId: agentId ?? descriptor.agent_id, descriptor, modelResolution, coordinator });
  const collect = await collectSubagentResult(coordinator, agentId, {
    pollIntervalMs,
    collectTimeoutMs,
    notify,
    root,
    stepId: step.id,
    model: workerModel ?? null,
  });
  if (!collect.ready) {
    return workerOutcomeOrThrow({ step, agentId, collect });
  }
  return {
    ...collect.step_result,
    artifacts: collect.step_result?.artifacts?.length ? collect.step_result.artifacts : collect.artifacts ?? [],
  };
  // NOTE: controller_updates are promoted by the main loop AFTER the authoritative gate passes (not here on
  // the worker's self-PASS), so a step the executor ultimately BLOCKS never materializes the run-root surface.
}

// Map each of a step's controller_updates targets to a step-scoped staging path (same basename) the worker
// can own and write. steps/<id>/<file> passes isControllerOwnedPath; the run-root target does not.
export function controllerUpdateStagingPlan(state, step) {
  return (step.controller_updates ?? []).map((template) => {
    const target = renderTemplate(template, state, step);
    const staging = path.join(runRelDir(state), "steps", step.id, path.basename(target)).replaceAll("\\", "/");
    return { staging, target };
  });
}

// Remove a worker step's expected output files (produces + controller_updates staging) BEFORE dispatch, so a
// no-op/lazy redispatch can't pass on the strength of a stale artifact left by a prior attempt. The worker
// re-writes what it actually produces this run; verifyWorkerPassEvidence keys PASS on the artifact existing,
// so clearing makes "exists" mean "freshly written" (SE-3). Confined to paths inside the run dir.
export async function clearExpectedArtifacts({ root, paths }) {
  const runScopedPrefix = ".aipi/runtime/runs/";
  for (const rel of paths ?? []) {
    const normalized = String(rel ?? "").replaceAll("\\", "/");
    if (!normalized.startsWith(runScopedPrefix)) continue; // never delete outside a run's own artifact tree
    try {
      await fs.rm(path.resolve(root, normalized), { force: true });
    } catch {
      /* best-effort: a missing stale artifact is the desired state */
    }
  }
}

// realpath the nearest existing ancestor of a (possibly not-yet-created) path, so symlink/junction
// components are resolved before a containment check. FAILS CLOSED: returns null if no existing ancestor can
// be resolved (the filesystem root always exists, so this only happens on an unreadable/pathological path) —
// the caller treats null as "outside the root" rather than trusting an unresolved lexical path. The walk is
// bounded by the target's own component depth (a path has no more ancestors than components), so a target
// with very many non-existent trailing components can't cause us to stop ABOVE a junction we'd otherwise
// resolve (the earlier fixed 64-cap could return a junction-unresolved lexical path and fail open).
async function realpathExistingAncestor(target) {
  let current = path.resolve(target);
  const maxHops = current.split(/[\\/]/).filter(Boolean).length + 4;
  for (let i = 0; i < maxHops; i += 1) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null; // reached the fs root without resolving -> fail closed
      current = parent;
    }
  }
  return null; // exhausted the bounded walk without resolving -> fail closed
}

// Controller-side promotion: copy each staged file to its run-root controller_updates target, AFTER the
// authoritative gate has passed. Hardened: (1) symlink-resolved containment on both source and the
// destination's existing ancestor — a junction/symlink planted in the run dir can't redirect the copy outside
// the project root; (2) refuse a symlink destination (write a real file, never through a link); (3) never
// promote an empty/non-file stage onto the load-bearing surface.
export async function promoteControllerUpdates({ root, plan }) {
  const resolvedRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const insideRoot = (p) => p === resolvedRoot || p.startsWith(rootWithSep);
  for (const { staging, target } of plan) {
    try {
      const src = path.resolve(root, staging);
      const dest = path.resolve(root, target);
      const realSrc = await fs.realpath(src).catch(() => null);
      if (!realSrc || !insideRoot(realSrc)) continue;
      const realDestAncestor = await realpathExistingAncestor(path.dirname(dest));
      if (!realDestAncestor || !insideRoot(realDestAncestor)) continue; // fail closed when unresolved
      const srcStat = await fs.stat(realSrc);
      if (!srcStat.isFile() || srcStat.size === 0) continue; // never materialize an empty/non-file surface (SE-2)
      const destLink = await fs.lstat(dest).catch(() => null);
      if (destLink?.isSymbolicLink()) continue; // refuse to write through a symlinked target
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(realSrc, dest);
    } catch {
      /* a missing stage means the PASS lacked real evidence and was already downgraded upstream */
    }
  }
}

// Surface the per-worker model resolution in model-routing.jsonl (host + run-scoped). The host model_select
// hook only logs the orchestrator turn, so without this a worker that resolved off-family is invisible in the
// log operators scan. Best-effort: a telemetry failure must never block or fail a spawn.
async function recordWorkerRoute({ root, state, step, agentId, descriptor, modelResolution, coordinator }) {
  try {
    await recordWorkerModelRoute({
      projectRoot: root,
      runId: state?.run_id ?? null,
      stepId: step?.id ?? descriptor?.step_id ?? null,
      agentId,
      modelClass: descriptor?.model_class ?? modelResolution?.model_class ?? null,
      workerModel: describeModel(modelResolution?.model ?? descriptor?.model ?? null),
      hostModel: describeModel(coordinator?.getHostModel?.() ?? null),
      source: descriptor?.model_resolution_source ?? modelResolution?.source ?? null,
    });
  } catch {
    /* routing telemetry is best-effort */
  }
}

function dispatchSubagent(coordinator, descriptor) {
  if (typeof coordinator.dispatch === "function") {
    return coordinator.dispatch(descriptor);
  }
  return coordinator.spawn(descriptor);
}

async function collectSubagentResult(coordinator, agentId, {
  pollIntervalMs,
  collectTimeoutMs,
  notify = null,
  root = null,
  stepId = null,
  model = null,
}) {
  const startedAt = Date.now();
  let lastActivityAt = 0;
  // Live worker telemetry: a forked worker runs for minutes; surface what it is actually DOING so the
  // terminal isn't a silent spinner. The worker streams its real session to a jsonl; we tail NEW events
  // and show each thinking note + file/graph/tool action live. Two surfaces, no duplication (per Victor):
  //   - the persistent per-action HISTORY CARDS in the conversation (logActivity) — the "events on top";
  //   - the animated spinner status line (updateActivity) with the live tool count + latest action.
  // The below-editor space is left to the PLAN widget only (setPlan); the old live activity WIDGET
  // (setActivity) is intentionally NOT fed here — it duplicated the cards under the plan. On a plain/CLI
  // host with no cards channel, we fall back to one transient notify line per event. Each activity line is
  // labeled with the worker agent AND its model, so it's clear which model produced the action.
  const canStream = typeof notify === "function" && Boolean(root);
  const feed = canStream ? createWorkerActivityFeed(root, agentId) : null;
  const tag = String(agentId).split(":")[0] || stepId || "worker";
  const modelLabel = describeModel(model);
  const label = modelLabel ? `${tag} · ${modelLabel}` : tag;
  const widgetHost = canStream && notify.supportsWidgets === true;
  const pump = async () => {
    if (!feed) return;
    try {
      const { events, toolCount, latestAction } = await feed.poll();
      for (const event of events) {
        const glyph = event.kind === "think" ? "💭" : event.kind === "text" ? "💬" : "🔧";
        // Plain/CLI host (no widgets/cards): stream each action as a transient notify line — its only
        // per-event surface. On a widget host the persistent cards below cover it, so skip the line.
        if (!widgetHost) notify(`  ↳ ${label} ${glyph} ${event.detail}`, "info");
        // Persistent per-action HISTORY card in the conversation (the transient notify above vanishes;
        // this stays in the scrollback). The feed's byte cursor already yields each action once. `details`
        // drive the titled-card renderer (header = agent · model); `content` is the plain-text fallback.
        if (typeof notify.logActivity === "function") {
          notify.logActivity(`${label} ${glyph} ${event.detail}`, {
            agent: tag,
            model: modelLabel ?? null,
            glyph,
            detail: event.detail,
            kind: event.kind,
          });
        }
      }
      if (typeof notify.updateActivity === "function") {
        const parts = [`${toolCount} tool${toolCount === 1 ? "" : "s"}`];
        if (latestAction) parts.push(latestAction);
        notify.updateActivity(parts.join(" · "));
      }
    } catch {
      /* telemetry is best-effort and must never break the run */
    }
  };
  // The live activity widget is no longer fed; clear any stale panel a prior version may have left.
  const clearLivePanel = () => {
    try { notify?.setActivity?.(undefined); } catch { /* best-effort */ }
  };
  // try/finally so the live activity panel is removed on EVERY exit — including a thrown
  // coordinator.collect() (e.g. "unknown agent" if the job was pruned mid-poll). Otherwise the stale
  // panel would linger until the whole run unwinds. Mirrors executeWorkflowRun's own progress guard.
  try {
    while (Date.now() - startedAt <= collectTimeoutMs) {
      const collect = coordinator.collect(agentId);
      if (collect.ready || ["failed", "cancelled", "interrupted"].includes(collect.state)) {
        await pump(); // flush any final events the worker wrote just before finishing
        return collect;
      }
      if (feed && Date.now() - lastActivityAt >= 1000) {
        lastActivityAt = Date.now();
        await pump();
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return { agent_id: agentId, ready: false, state: "timeout" };
  } finally {
    clearLivePanel(); // the planner shows the step's terminal state; never leave a stale live panel
  }
}

// Forward, cursor-based reader of a forked worker's live session jsonl. Each worker logs
// `{type:"message", message:{role, content:[ {type:"thinking",thinking}, {type:"toolCall",name,arguments} ]}}`
// events (NOT the top-level tool_use/input shape an in-process SDK uses). poll() reads only bytes appended
// since the last call, returns one structured {kind:"tool"|"think", detail} event per new thinking/tool
// block, the running tool count (derived from the jsonl, since host tool_call hooks observe zero
// forked-worker calls), and the latest action for the spinner. Best-effort: never throws; a partial
// trailing line is left for the next poll.
function createWorkerActivityFeed(root, agentId) {
  const dir = path.join(root, ".aipi", "runtime", "subagents", "sessions", String(agentId).replaceAll(":", "-"));
  let file = null;
  let offset = 0;
  let toolCount = 0;
  let streamed = 0;
  const STREAM_CAP = 1000; // runaway backstop, far above any real worker's event count
  return {
    async poll() {
      const out = { events: [], toolCount, latestAction: null };
      try {
        const entries = await fs.readdir(dir).catch(() => []);
        const jsonl = entries.filter((name) => name.endsWith(".jsonl")).sort().at(-1);
        if (!jsonl) return out;
        if (jsonl !== file) {
          file = jsonl;
          offset = 0;
        }
        const filePath = path.join(dir, jsonl);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat || stat.size <= offset) return out;
        const handle = await fs.open(filePath, "r");
        let text;
        try {
          const buf = Buffer.alloc(stat.size - offset);
          await handle.read(buf, 0, buf.length, offset);
          text = buf.toString("utf8");
        } finally {
          await handle.close();
        }
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline === -1) return out; // no complete line appended yet; wait for the rest
        const complete = text.slice(0, lastNewline + 1);
        offset += Buffer.byteLength(complete, "utf8"); // resume after the last whole line next poll
        for (const rawLine of complete.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          const message = event?.message;
          const content = message?.content;
          // A message's content can be a string (not an array) — handle that real shape too.
          const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
          const isAssistant = message?.role === "assistant" || message?.role === undefined;
          for (const part of parts) {
            if (part?.type === "toolCall" || part?.type === "tool_use") {
              toolCount += 1;
              const detail = formatToolActivity(part.name, part.arguments ?? part.input ?? {});
              out.latestAction = detail;
              if (streamed < STREAM_CAP) {
                streamed += 1;
                out.events.push({ kind: "tool", detail });
              }
            } else if (part?.type === "thinking") {
              const summary = summarizeThinking(part.thinking ?? part.text ?? "");
              if (summary) {
                out.latestAction = "thinking…";
                if (streamed < STREAM_CAP) {
                  streamed += 1;
                  out.events.push({ kind: "think", detail: summary });
                }
              }
            } else if (part?.type === "text" && isAssistant) {
              // The worker's spoken narration/answer — show it too (a tools-free, text-only turn would
              // otherwise render a blank live panel). Skip user/toolResult echoes (non-assistant roles).
              const summary = summarizeThinking(part.text ?? "");
              if (summary) {
                out.latestAction = summary;
                if (streamed < STREAM_CAP) {
                  streamed += 1;
                  out.events.push({ kind: "text", detail: summary });
                }
              }
            }
          }
        }
      } catch {
        /* best-effort; leave cursor/count as-is */
      }
      out.toolCount = toolCount;
      return out;
    },
  };
}

function truncateActivity(value, max) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function baseName(value) {
  if (value !== null && typeof value === "object") return ""; // never render "[object Object]"
  const s = String(value ?? "").replaceAll("\\", "/");
  return s.split("/").filter(Boolean).pop() || s;
}

// Turn a worker tool call into a short, human "what it's doing" line: file reads/greps/listings and the
// aipi_* graph/memory/retrieval tools the user specifically wanted to see ("files/graph + thinking").
function formatToolActivity(name, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  // Cover the path keys the real worker/producer actually emits (resolveCurrentPath uses
  // path/file/filename/target/cwd) plus a few defensive aliases, so `ls {cwd}` / `read {filename}` render.
  const p = a.path ?? a.file ?? a.filename ?? a.target ?? a.cwd ?? a.dir ?? a.file_path ?? a.filePath;
  switch (name) {
    case "read":
    case "open":
      return `read ${p ? baseName(p) : ""}`.trim();
    case "ls":
      return `ls ${truncateActivity(p ?? "", 60)}`.trim();
    case "grep":
      return `grep ${a.pattern ? `"${truncateActivity(a.pattern, 48)}"` : p ? baseName(p) : ""}`.trim();
    case "find":
      return `find ${truncateActivity(a.pattern ?? a.query ?? p ?? "", 48)}`.trim();
    case "write":
      return `write ${p ? baseName(p) : ""}`.trim();
    case "aipi_retrieve":
      return `retrieve "${truncateActivity(a.query ?? a.q ?? "", 48)}"`;
    case "aipi_rule_lookup":
      return `rule lookup "${truncateActivity(a.query ?? a.rule ?? "", 48)}"`;
    case "aipi_rule_gap":
      return `rule gap "${truncateActivity(a.query ?? "", 48)}"`;
    case "aipi_memory_query":
      return `memory "${truncateActivity(a.query ?? "", 48)}"`;
    case "aipi_callers":
      return `callers ${truncateActivity(a.symbol ?? a.name ?? p ?? "", 48)}`.trim();
    case "aipi_impact":
      return `impact ${truncateActivity(a.symbol ?? a.name ?? p ?? "", 48)}`.trim();
    default: {
      const first = p ?? a.query ?? a.pattern ?? a.symbol ?? a.name ?? Object.values(a)[0];
      return `${name}${first ? ` ${truncateActivity(baseName(first), 50)}` : ""}`.trim();
    }
  }
}

function summarizeThinking(text) {
  const first = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? truncateActivity(first, 150) : null;
}

function blockedStepResult({ step, agentId, reason }) {
  return {
    schema: "aipi.step-result.v1",
    step_id: step.id,
    agent_ids: [agentId],
    verdict: "BLOCKED",
    evidence: [
      {
        rung: "blocked",
        source: "aipi-subagent-workflow-adapter",
        ref: agentId,
        result: reason,
      },
    ],
    artifacts: [],
  };
}

// When a worker did not finish, a TRANSIENT provider failure (e.g. an Anthropic overloaded_error/529 or
// a 429 rate-limit that the worker's own LLM calls hit) is THROWN so executeStepWithTransientRetries
// retries the step with backoff — a single 529 burst then self-heals instead of hard-blocking the whole
// run. A STRUCTURAL failure (bad config, invalid schema, unknown model class, …) returns a plain block
// (fail-loud, no retry). The classification probe carries ONLY collect.state + collect.error so a config
// error can't accidentally look transient.
function workerOutcomeOrThrow({ step, agentId, collect }) {
  const detail = collect?.error ?? collect?.abort_reason ?? null;
  const reason = `worker ${agentId} did not finish: ${collect?.state ?? "unknown"}${detail ? ` (${detail})` : ""}`;
  // Only the worker's reported error (a real provider error envelope) classifies as transient — NOT the
  // collect STATE. A bare collect "timeout" means the worker ran past the 20-min ceiling (structural —
  // retrying would just burn another 20 min), so it blocks; a provider overloaded_error/429 in the
  // worker error retries with backoff.
  if (detail && isTransientProviderError({ message: String(detail) })) {
    throw new Error(reason);
  }
  return blockedStepResult({ step, agentId, reason });
}

export function assertControllerWriteAllowed({ root, state, step, relPath, internal = false }) {
  const normalized = normalizeRelPath(relPath);
  const abs = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error(`controller write escapes project root: ${relPath}`);
  }
  if (normalized.startsWith(".aipi/memory/")) {
    throw new Error(`controller durable-memory write requires memory promotion policy: ${relPath}`);
  }
  if (internal) return normalized;

  const allowed = new Set([...step.produces, ...step.controller_updates].map((item) => renderTemplate(item, state, step)));
  if (!allowed.has(normalized)) {
    throw new Error(`controller write not declared by workflow step ${step.id}: ${relPath}`);
  }
  return normalized;
}

export async function writeControllerArtifact({ root, state, step, relPath, content, internal = false }) {
  const normalized = assertControllerWriteAllowed({ root, state, step, relPath, internal });
  const abs = path.join(root, normalized);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return normalized;
}

export function parseWorkflowDefinition(text, workflowName = "workflow") {
  const workflow = {
    name: text.match(/^name:\s*([a-z0-9_-]+)$/m)?.[1] ?? workflowName,
    mode: text.match(/^mode:\s*([a-z0-9_-]+)$/m)?.[1] ?? null,
    steps: [],
  };
  let current = null;
  let section = null;
  let gateSubsection = null;

  for (const line of text.split(/\r?\n/)) {
    const step = line.match(/^  - id:\s*([a-z0-9_-]+)$/);
    if (step) {
      current = {
        id: step[1],
        name: null,
        prompt: null,
        stage: null,
        agents: [],
        requires: [],
        context_from: [],
        produces: [],
        controller_updates: [],
        gate: {
          on_verdict: {},
          on_policy_decision: {},
        },
      };
      workflow.steps.push(current);
      section = null;
      gateSubsection = null;
      continue;
    }
    if (!current) continue;

    const keyValue = line.match(/^    ([a-z_]+): (.+)$/);
    if (keyValue) {
      const [, key, value] = keyValue;
      section = null;
      gateSubsection = null;
      if (key === "stage") current.stage = value;
      if (key === "name") current.name = value;
      if (key === "prompt") {
        current.prompt = value === ">" || value === "|" ? "" : value;
        if (value === ">" || value === "|") section = "prompt";
      }
      if (key === "agents") current.agents = parseInlineList(value);
      if (key === "requires") current.requires = parseInlineList(value);
      if (key === "context_from") current.context_from = parseInlineList(value);
      if (key === "write_scope") {
        const scope = value.trim();
        if (scope !== "project" && scope !== "artifacts") {
          throw new Error(
            `workflow ${workflowName} step ${current.id}: write_scope must be "project" or "artifacts", got "${scope}"`,
          );
        }
        current.write_scope = scope;
      }
      continue;
    }

    const sectionStart = line.match(/^    ([a-z_]+):\s*$/);
    if (sectionStart) {
      section = sectionStart[1];
      gateSubsection = null;
      continue;
    }

    const listItem = line.match(/^      - (.+)$/);
    if (listItem && section) {
      if (section === "produces") current.produces.push(listItem[1]);
      if (section === "controller_updates") current.controller_updates.push(listItem[1]);
      continue;
    }

    if (section === "prompt" && /^      /.test(line)) {
      current.prompt = `${current.prompt ? `${current.prompt}\n` : ""}${line.trim()}`;
      continue;
    }

    if (section === "gate") {
      const gateList = line.match(/^      ([a-z_]+): (\[.*\])$/);
      if (gateList) {
        current.gate[gateList[1]] = parseInlineList(gateList[2]);
        gateSubsection = null;
        continue;
      }

      const gateScalar = line.match(/^      ([a-z_]+): ([^\s].*)$/);
      if (gateScalar) {
        const [, key, value] = gateScalar;
        if (value === "true") current.gate[key] = true;
        else if (value === "false") current.gate[key] = false;
        else if (/^\d+$/.test(value)) current.gate[key] = Number(value);
        else current.gate[key] = value;
        gateSubsection = null;
        continue;
      }

      const gateSection = line.match(/^      ([a-z_]+):\s*$/);
      if (gateSection) {
        gateSubsection = gateSection[1];
        current.gate[gateSubsection] ??= {};
        continue;
      }

      const nested = line.match(/^        ([A-Z_]+|[a-z_]+): ([a-zA-Z0-9_-]+)$/);
      if (nested && gateSubsection) current.gate[gateSubsection][nested[1]] = nested[2];
    }
  }

  if (!workflow.steps.length) throw new Error(`AIPI workflow has no steps: ${workflowName}`);
  return workflow;
}

async function writeStepResult({ root, state, step, result, validation, missingArtifacts }) {
  const resultJsonRel = path.join(runRelDir(state), "steps", step.id, "RESULT.json").replaceAll("\\", "/");
  const resultMdRel = resultPathFor(state, step);
  await writeControllerArtifact({
    root,
    state,
    step,
    relPath: resultJsonRel,
    internal: true,
    content: `${JSON.stringify({ result, validation, missing_artifacts: missingArtifacts }, null, 2)}\n`,
  });
  await writeControllerArtifact({
    root,
    state,
    step,
    relPath: resultMdRel,
    internal: true,
    content: renderStepResultMarkdown({ step, result, validation, missingArtifacts }),
  });
}

function memoryDriftCheckEnabled(env = process.env) {
  const value = String(env?.AIPI_MEMORY_DRIFT_CHECK ?? "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

// RC4 hook: after a step passes the authoritative gate, scan for business rules whose governed code this run
// changed (impacted-files ∩ git-changed) and QUEUE a drift report. Detection-only by default — the executable
// verify anchor is NOT run here (no arbitrary shell on the hot path); a human runs it via /aipi-memory
// reconcile. Fully best-effort: any failure (no rules, not a git repo, parse error) returns null silently.
async function materializeBusinessRuleDriftCheck({ root, now }) {
  if (!memoryDriftCheckEnabled()) return null;
  try {
    return await detectBusinessRuleDrift({ root, now });
  } catch {
    return null;
  }
}

// Count undrained, still-pending memory candidates. The `.json` sidecar IS the structured candidate (legacy
// candidates are `.md`-only and not promotable), so the file-type check is the structured gate. Best-effort: an
// unreadable candidate is left for `/aipi-memory doctor` to flag and is not counted here (must never crash).
async function countUndrainedCandidates(root) {
  const dir = path.join(root, ".aipi", "runtime", "memory-candidates");
  const names = await fs.readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let count = 0;
  for (const name of names) {
    // FIX 5: legacy memory-candidates written by older engine versions may have only a .md file with
    // no companion .json sidecar. Count them as pending candidates so the scan record reflects reality
    // and the user is prompted to promote or discard them via /aipi-memory.
    if (name.endsWith(".md")) {
      const jsonSidecar = `${name.slice(0, -3)}.json`;
      if (!names.includes(jsonSidecar)) count += 1;
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const candidate = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      if ((candidate.status ?? "candidate") === "candidate") count += 1;
    } catch {
      // unreadable candidate — doctor/verify surfaces it; do not count or crash here
    }
  }
  return count;
}

// FIX 4: Extract the first unresolved HIGH/CRITICAL finding from a review-stage step's artifacts.
// Remediation entry (same shape as a review gate-failure finding, so context-builder forwards it as
// gate_failure_remediation) telling the re-run worker to actually WRITE the artifacts it skipped.
function artifactWriteRemediation(missingArtifacts) {
  const list = (Array.isArray(missingArtifacts) ? missingArtifacts : []).filter(Boolean);
  return {
    finding: {
      severity: "HIGH",
      artifact: list[0] ?? "",
      preview:
        `You returned a verdict but did NOT create the required artifact file(s): ${list.join(", ")}. ` +
        "This run auto-retries you: you MUST call the write tool to CREATE each of those files (with real, " +
        "complete content) BEFORE returning your verdict. The gate checks the files exist on disk — a verdict " +
        "without the files written is an automatic failure, not a pass.",
    },
  };
}

// Returns a feedback entry suitable for state.gate_failure_feedback[targetStepId], or null if no
// actionable finding can be identified. Pure read — does not modify any files or state.
async function extractReviewGateFailureFeedback({ root, result, step, state, now }) {
  if (!Array.isArray(result?.artifacts) || !result.artifacts.length) return null;
  // Only review-stage artifacts carry structured findings; skip implementation/memory/etc.
  const reviewArtifactPattern =
    /(?:^|[/\\])(?:CODE-REVIEW|SECURITY|DEV-REVIEW|HUMAN-REVIEW|COMPLEXITY-REVIEW|INTEGRATION|BLAST-RADIUS|PLAN-REVIEW)(?:\.[A-Za-z0-9_-]*)?\.[A-Za-z]+$/i;
  const highSeverityLinePattern =
    /\b(?:CRITICAL|HIGH|BLOCKER|P0|P1)\b\s*(?:[:\]-]|finding|issue|risk|vulnerability|bug)/i;
  const resolvedContextPattern =
    /\b(?:resolved|fixed|mitigated|closed|not\s+applicable|none|no)\b.*\b(?:CRITICAL|HIGH|BLOCKER|P0|P1)\b|\b(?:CRITICAL|HIGH|BLOCKER|P0|P1)\b.*\b(?:resolved|fixed|mitigated|closed|none|0)\b/i;
  for (const artifact of result.artifacts) {
    if (!reviewArtifactPattern.test(String(artifact ?? ""))) continue;
    let content;
    try {
      content = await fs.readFile(path.join(root, artifact), "utf8");
    } catch {
      continue; // artifact not yet written or unreadable — skip silently
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!highSeverityLinePattern.test(line)) continue;
      const severityMatch = line.match(/\b(CRITICAL|HIGH|BLOCKER|P0|P1)\b/i);
      if (!severityMatch) continue;
      // Look at a small surrounding window to detect "resolved/fixed" context.
      const window = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join(" ");
      if (resolvedContextPattern.test(window)) continue;
      return {
        from_step: step.id,
        visit: state.step_visits?.[step.id] ?? 1,
        finding: {
          artifact,
          preview: line.trim().slice(0, 180),
          severity: severityMatch[1].toUpperCase(),
        },
        recorded_at: now().toISOString(),
      };
    }
  }
  return null;
}

// RC2 follow-up: when a memory-promotion step SKIPS with no_durable_memory_signal, the EXECUTOR authors and
// persists the authoritative aipi.memory-candidate-scan.v1 record on disk (engine-owned, not the worker's
// forgeable payload), recording what it independently observed. It BLOCKS only on the unambiguous
// self-contradiction — a SKIP that also carries durable promotions. Undrained candidates are recorded +
// surfaced (verdict: candidates_pending) but NOT hard-blocked, because candidates are not run-scoped: a hard
// block would stop every workflow on stale cross-run candidates. Draining pressure stays with the human
// (/aipi-memory promote|discard) and project-level doctor/verify. Fully best-effort: any fs failure -> allow.
export async function materializeMemorySkipScanRecord({ root, state, step, result, now }) {
  if (!isMemoryPromotionStep(step) || result?.verdict !== "SKIPPED" || result?.skip_condition !== "no_durable_memory_signal") {
    return null;
  }
  try {
    const promotions = Array.isArray(result.memory_promotions) ? result.memory_promotions : [];
    const undrained = await countUndrainedCandidates(root);
    const createdAt = now().toISOString();
    const verdict = promotions.length ? "contradicted" : undrained ? "candidates_pending" : "no_signal";
    const recordRel = path.join(runRelDir(state), "steps", step.id, "MEMORY-CANDIDATE-SCAN.json").replaceAll("\\", "/");
    await writeControllerArtifact({
      root,
      state,
      step,
      relPath: recordRel,
      internal: true,
      content: `${JSON.stringify({
        schema: MEMORY_CANDIDATE_SCAN_SCHEMA,
        run_id: state.run_id,
        step_id: step.id,
        created_at: createdAt,
        source: "aipi-workflow-executor",
        scanned: ".aipi/runtime/memory-candidates",
        undrained_candidate_count: undrained,
        promotions_in_skip: promotions.length,
        verdict,
      }, null, 2)}\n`,
    });
    if (!Array.isArray(result.artifacts)) result.artifacts = [];
    if (!result.artifacts.includes(recordRel)) result.artifacts.push(recordRel);
    result.memory_candidate_scan = { schema: MEMORY_CANDIDATE_SCAN_SCHEMA, ref: recordRel, undrained_candidate_count: undrained, verdict };
    if (promotions.length) {
      return {
        error: `memory-promotion SKIPPED with no_durable_memory_signal but carries ${promotions.length} memory_promotions — return PASS to promote them or drop them from the skip`,
        record: recordRel,
      };
    }
    return { error: null, record: recordRel, undrained };
  } catch {
    return null; // best-effort: a scan-record failure NEVER blocks the run
  }
}

async function materializeStepMemoryPromotions({ root, state, step, result, now }) {
  if (!isMemoryPromotionStep(step) || result?.verdict === "SKIPPED") return null;
  if (result?.verdict !== "PASS") return null;

  const promotions = Array.isArray(result.memory_promotions) ? result.memory_promotions : [];
  const createdAt = now().toISOString();
  const approvalRel = path.join(
    ".aipi",
    "runtime",
    "approvals",
    "approved",
    `${safeArtifactName(state.run_id)}-${safeArtifactName(step.id)}-memory-promotion.json`,
  ).replaceAll("\\", "/");
  const resultRel = path.join(
    runRelDir(state),
    "steps",
    step.id,
    "MEMORY-PROMOTION-RESULT.json",
  ).replaceAll("\\", "/");

  const outputs = [];
  const errors = [];
  if (!promotions.length) {
    // FIX 1: Coerce PASS-with-no-promotions to SKIPPED rather than blocking the run.
    // A worker that returns PASS without memory_promotions has no durable signal — auto-coerce to
    // SKIPPED/no_durable_memory_signal so the run completes instead of trapping in a gate error
    // that is semantically just a skip. SKIPPED is already in pass_verdicts for memory_promotion
    // in all workflow YAMLs, so the run will complete normally.
    result.verdict = "SKIPPED";
    result.skip_condition = "no_durable_memory_signal";
    const coercionRecord = {
      schema: "aipi.memory-promotion-result.v1",
      run_id: state.run_id,
      step_id: step.id,
      result_ref: resultRel,
      created_at: createdAt,
      status: "coerced_to_skipped",
      coerced_from: "PASS",
      coerce_reason:
        "memory-promotion PASS returned no memory_promotions; executor auto-coerced to SKIPPED/no_durable_memory_signal",
      promoted: 0,
      changed: 0,
      errors: [],
      promotions: [],
    };
    await writeControllerArtifact({
      root,
      state,
      step,
      relPath: resultRel,
      internal: true,
      content: `${JSON.stringify(coercionRecord, null, 2)}\n`,
    });
    result.memory_promotion_result = {
      schema: coercionRecord.schema,
      status: "coerced_to_skipped",
      result_ref: resultRel,
      promoted: 0,
      changed: 0,
      errors: [],
    };
    if (!Array.isArray(result.artifacts)) result.artifacts = [];
    if (!result.artifacts.includes(resultRel)) result.artifacts.push(resultRel);
    return null; // no gate error — the coerced SKIPPED will be handled by the pass branch
  } else {
    await writeControllerArtifact({
      root,
      state,
      step,
      relPath: approvalRel,
      internal: true,
      content: `${JSON.stringify({
        schema: "aipi.memory-promotion-approval.v1",
        decision: "APPROVED",
        source: "aipi-workflow-executor",
        run_id: state.run_id,
        step_id: step.id,
        created_at: createdAt,
      }, null, 2)}\n`,
    });

    for (const [index, candidate] of promotions.entries()) {
      const normalized = normalizeMemoryPromotion(candidate, { result, state, step });
      if (!normalized.ok) {
        errors.push(`memory_promotions[${index}]: ${normalized.error}`);
        outputs.push({ index, status: "rejected", error: normalized.error });
        continue;
      }

      try {
        const toolResult = await aipiPromoteMemory({
          projectRoot: root,
          kind: normalized.value.kind,
          title: normalized.value.title,
          content: normalized.value.content,
          source_ref: normalized.value.source_ref,
          user_memory: normalized.value.user_memory,
          approval_ref: approvalRel,
          run_id: state.run_id,
          now,
        });
        outputs.push({ index, input: normalized.value, result: toolResult });
        if (toolResult.status !== "promoted") {
          errors.push(`memory_promotions[${index}]: aipi_promote_memory returned ${toolResult.status}`);
        }
      } catch (error) {
        errors.push(`memory_promotions[${index}]: ${error.message}`);
        outputs.push({ index, input: normalized.value, status: "error", error: error.message });
      }
    }
  }

  const promotedCount = outputs.filter((item) => item.result?.status === "promoted").length;
  const changedCount = outputs.filter((item) => item.result?.status === "promoted" && item.result.changed).length;
  if (promotions.length && promotedCount === 0) {
    errors.push("memory-promotion PASS produced no durable promotions through aipi_promote_memory");
  }

  const record = {
    schema: "aipi.memory-promotion-result.v1",
    run_id: state.run_id,
    step_id: step.id,
    approval_ref: approvalRel,
    result_ref: resultRel,
    created_at: createdAt,
    promoted: promotedCount,
    changed: changedCount,
    errors,
    promotions: outputs,
  };
  await writeControllerArtifact({
    root,
    state,
    step,
    relPath: resultRel,
    internal: true,
    content: `${JSON.stringify(record, null, 2)}\n`,
  });

  result.memory_promotion_result = {
    schema: record.schema,
    status: errors.length ? "failed" : "promoted",
    approval_ref: approvalRel,
    result_ref: resultRel,
    promoted: promotedCount,
    changed: changedCount,
    errors,
  };
  if (!Array.isArray(result.artifacts)) result.artifacts = [];
  if (!result.artifacts.includes(resultRel)) result.artifacts.push(resultRel);

  return {
    error: errors.length ? `memory promotion gate failed: ${errors.join("; ")}` : null,
    record,
    resultRel,
  };
}

async function missingRequiredArtifacts({ root, state, step, result }) {
  if (result.verdict === "SKIPPED") return [];
  const missing = [];
  for (const template of step.produces) {
    const relPath = renderTemplate(template, state, step);
    try {
      await fs.access(path.join(root, relPath));
    } catch (error) {
      if (error.code === "ENOENT") missing.push(relPath);
      else throw error;
    }
  }
  return missing;
}

export async function executeStepWithTransientRetries({ adapter, args, retry } = {}) {
  const maxAttempts = retry.maxAttempts;
  const events = [];
  const stampRetries = (result, attempt) => {
    if (events.length && result && typeof result === "object") {
      result.transient_provider_retries = {
        schema: "aipi.transient-provider-retries.v1",
        recovered: true,
        attempts: attempt,
        events,
      };
    }
    return result;
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return stampRetries(await adapter.executeStep(args), attempt);
    } catch (error) {
      if (!isTransientProviderError(error)) throw error;
      const summary = transientProviderErrorSummary(error);
      if (attempt >= maxAttempts) {
        // Retries on the configured provider are exhausted (e.g. a sustained 429 account rate limit). Instead
        // of hard-blocking the whole workflow, fall back ONCE to a concrete model on a DIFFERENT authed
        // provider — and announce it, so a rate-limited step keeps the run moving on another family.
        const fallback = typeof adapter.resolveRateLimitFallback === "function"
          ? await adapter.resolveRateLimitFallback(args).catch(() => null)
          : null;
        if (fallback?.model) {
          announceRateLimitFallback(args?.notify, { step: args.step, fallback });
          events.push({
            attempt,
            error: summary,
            fallback: { from: fallback.fromProvider ?? null, to: fallback.toProvider ?? null, model: describeModel(fallback.model) },
          });
          try {
            const result = await adapter.executeStep({ ...args, modelOverride: fallback.model });
            if (result && typeof result === "object") {
              result.rate_limit_fallback = {
                schema: "aipi.rate-limit-fallback.v1",
                from_provider: fallback.fromProvider ?? null,
                to_provider: fallback.toProvider ?? null,
                model: describeModel(fallback.model),
                after_attempts: attempt,
              };
            }
            return stampRetries(result, attempt + 1);
          } catch (fallbackError) {
            if (!isTransientProviderError(fallbackError)) throw fallbackError;
            // The fallback provider is ALSO transient-failing — block with the fallback error.
            return transientProviderBlockedResult({ step: args.step, error: fallbackError, attempts: attempt + 1, events });
          }
        }
        return transientProviderBlockedResult({ step: args.step, error, attempts: attempt, events });
      }
      const delayMs = transientProviderRetryDelayMs({ retry, attempt });
      events.push({
        attempt,
        error: summary,
        delay_ms: delayMs,
      });
      await sleep(delayMs);
    }
  }
  return transientProviderBlockedResult({ step: args.step, error: new Error("transient provider retry exhausted"), attempts: maxAttempts, events });
}

// Announce a rate-limit fallback so the user sees the workflow rerouting to another family instead of just
// stalling. Best-effort + feature-detected across the progress-sink surfaces.
function announceRateLimitFallback(notify, { step, fallback }) {
  const message =
    `⚠ Rate-limited on ${fallback.fromProvider ?? "the provider"} — retrying step "${step?.id ?? "?"}" on ` +
    `${describeModel(fallback.model)} (${fallback.toProvider ?? "?"}) instead of blocking.`;
  try {
    if (typeof notify === "function") notify(message, "warn");
    if (typeof notify?.logActivity === "function") notify.logActivity(message);
  } catch {
    /* best-effort */
  }
}

function transientProviderRetryConfig(contract = {}) {
  const configured = contract.transientProviderRetry ?? contract.providerRetry ?? {};
  return {
    maxAttempts: positiveInt(configured.maxAttempts ?? configured.attempts, DEFAULT_TRANSIENT_PROVIDER_RETRY.maxAttempts),
    baseDelayMs: positiveInt(configured.baseDelayMs ?? configured.base_delay_ms, DEFAULT_TRANSIENT_PROVIDER_RETRY.baseDelayMs),
    maxDelayMs: positiveInt(configured.maxDelayMs ?? configured.max_delay_ms, DEFAULT_TRANSIENT_PROVIDER_RETRY.maxDelayMs),
    jitterMs: nonNegativeInt(configured.jitterMs ?? configured.jitter_ms, DEFAULT_TRANSIENT_PROVIDER_RETRY.jitterMs),
  };
}

function transientProviderRetryDelayMs({ retry, attempt }) {
  const exponential = retry.baseDelayMs * (2 ** Math.max(0, attempt - 1));
  const bounded = Math.min(retry.maxDelayMs, exponential);
  const jitter = retry.jitterMs ? Math.floor(Math.random() * (retry.jitterMs + 1)) : 0;
  return bounded + jitter;
}

function isTransientProviderError(error) {
  const text = [
    error?.type,
    error?.code,
    error?.status,
    error?.statusCode,
    error?.name,
    error?.message,
    error?.cause?.message,
  ].filter(Boolean).join(" ").toLowerCase();
  return /\b(overloaded_error|rate_limit_error|rate.?limit|too many requests|timeout|timed out|etimedout|econnreset|network)\b/.test(text) ||
    /\b(429|529|503|504)\b/.test(text);
}

function transientProviderErrorSummary(error) {
  return String(error?.message ?? error?.code ?? error?.type ?? error ?? "transient provider error").slice(0, 240);
}

function transientProviderBlockedResult({ step, error, attempts, events }) {
  const summary = transientProviderErrorSummary(error);
  return {
    schema: "aipi.step-result.v1",
    step_id: step.id,
    agent_ids: step.agents.length ? step.agents : ["aipi-provider-retry"],
    verdict: "BLOCKED",
    evidence: [
      {
        rung: "blocked",
        source: "aipi-provider-retry",
        ref: "transient-provider",
        result: `transient provider failure after ${attempts} attempts: ${summary}`,
      },
    ],
    artifacts: [],
    blocker_question: {
      question: `AIPI encontrou erro transitorio do provider em ${step.id} apos ${attempts} tentativas. Como voce quer seguir?`,
      options: [
        "Tentar executar este workflow novamente",
        "Continuar fora do workflow automatico nesta conversa",
        "Cancelar este run",
      ],
      allow_free_text: true,
    },
    transient_provider_failure: {
      schema: "aipi.transient-provider-failure.v1",
      attempts,
      error: summary,
      events,
    },
  };
}

function transientProviderFailureMessage(result) {
  if (!result?.transient_provider_failure) return null;
  const failure = result.transient_provider_failure;
  return `transient provider failure after ${failure.attempts} attempts: ${failure.error}`;
}

async function readStepArtifactContents({ root, result }) {
  if (!Array.isArray(result?.artifacts) || result.verdict !== "PASS") return {};
  const out = {};
  for (const artifact of result.artifacts) {
    if (typeof artifact !== "string" || !artifact.trim()) continue;
    const relPath = normalizeRelPath(artifact);
    try {
      out[relPath] = await fs.readFile(path.join(root, relPath), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    }
  }
  return out;
}

function renderLocalArtifact({ state, step, context, relPath }) {
  return [
    `# ${step.id}`,
    "",
    `run_id: ${state.run_id}`,
    `workflow: ${state.workflow}`,
    `stage: ${step.stage}`,
    `artifact: ${relPath}`,
    "",
    "## Context",
    "",
    `- contract_path: ${context.contract_path}`,
    `- prior_steps: ${context.prior_steps.map((item) => item.step_id).join(", ") || "none"}`,
    "",
    "## Outcome",
    "",
    "Deterministic workflow executor produced this artifact as runtime evidence.",
    "",
    "## Prompt",
    "",
    step.prompt ? renderText(step.prompt, state, step) : "(no prompt)",
    "",
    "## Provenance",
    "",
    ...(context.provenance ?? []).map((item) => `- ${item.kind}: ${item.ref ?? item.source_step ?? "unknown"}`),
    "",
  ].join("\n");
}

function renderStepResultMarkdown({ step, result, validation, missingArtifacts }) {
  return [
    `# Step Result: ${step.id}`,
    "",
    `- verdict: ${result?.verdict ?? "none"}`,
    `- gate_passed: ${validation.gatePassed ? "yes" : "no"}`,
    `- missing_artifacts: ${missingArtifacts.length ? missingArtifacts.join(", ") : "none"}`,
    "",
    "## Evidence",
    "",
    ...(result?.evidence ?? []).map((item) => `- ${item.rung} ${item.source} ${item.ref}: ${item.result}`),
    "",
    ...(result?.memory_promotion_result
      ? [
          "## Memory Promotion",
          "",
          `- status: ${result.memory_promotion_result.status}`,
          `- promoted: ${result.memory_promotion_result.promoted}`,
          `- changed: ${result.memory_promotion_result.changed}`,
          `- result_ref: ${result.memory_promotion_result.result_ref}`,
          "",
        ]
      : []),
    // Render the memory-skip scan so a "no durable signal" skip is VISIBLE (not silently accepted), and so
    // candidates_pending nudges the human to drain — otherwise "surface, don't block" surfaces nothing.
    ...(result?.memory_candidate_scan
      ? [
          "## Memory Candidate Scan",
          "",
          `- verdict: ${result.memory_candidate_scan.verdict}`,
          `- undrained_candidate_count: ${result.memory_candidate_scan.undrained_candidate_count}`,
          `- record: ${result.memory_candidate_scan.ref}`,
          ...(result.memory_candidate_scan.verdict === "candidates_pending"
            ? [`- next: ${result.memory_candidate_scan.undrained_candidate_count} undrained candidate(s) — reconcile with /aipi-memory promote <id> or discard <id>`]
            : []),
          "",
        ]
      : []),
  ].join("\n");
}

function isMemoryPromotionStep(step) {
  return step?.stage === "memory-promotion" || step?.id === "memory_promotion" || step?.id === "quick_memory";
}

function normalizeMemoryPromotion(candidate, { result, state, step }) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, error: "entry must be an object" };
  }
  const kind = String(candidate.kind ?? candidate.type ?? "").trim();
  const content = String(candidate.content ?? "").trim();
  if (!kind) return { ok: false, error: "kind is required" };
  if (!content) return { ok: false, error: "content is required" };
  return {
    ok: true,
    value: {
      kind,
      title: String(candidate.title ?? "").trim(),
      content,
      source_ref: String(candidate.source_ref ?? firstEvidenceRef(result) ?? resultPathFor(state, step)).trim(),
      user_memory: Boolean(candidate.user_memory),
    },
  };
}

function firstEvidenceRef(result) {
  return (result?.evidence ?? []).find((item) => item?.ref)?.ref ?? null;
}

function safeArtifactName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "item";
}

function parseInlineList(value) {
  const match = value.match(/\[(.*)\]/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderTemplate(template, state, step) {
  return normalizeRelPath(
    String(template)
      .replaceAll("{{ run_id }}", state.run_id)
      .replaceAll("{{ step_id }}", step.id),
  );
}

// renderText substitutes {{ key }} placeholders from the run's resolved params (plus run_id/step_id)
// into FREE TEXT (step prompts) — WITHOUT path normalization, so multi-line/free-text values like the
// user's bug description are not mangled. An unknown placeholder renders to empty string (never left
// as a literal "{{ bug }}", matching the declared default of bug:""). This is what carries a pasted
// task into the worker so triage actually has a defect to triage instead of blocking on "{{ bug }}".
function renderText(template, state, step = null) {
  const values = { run_id: state?.run_id, step_id: step?.id, ...(state?.params ?? {}) };
  return String(template ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

// Stages whose job is to MODIFY the project (apply a fix, write a real failing/regression
// test, implement code). Their workers get a project-write scope so they can edit/create the
// actual source files the change requires, instead of being trapped writing only their own
// run-dir artifacts. Analysis/review/planning stages stay artifact-scoped. A step may override
// with an explicit `write_scope: project|artifacts`.
const CODE_WRITING_STAGES = new Set(["implementation", "fix", "tdd"]);

export function resolveWriteScope(step) {
  const explicit = step?.write_scope;
  if (explicit === "project" || explicit === "artifacts") return explicit;
  return CODE_WRITING_STAGES.has(step?.stage) ? "project" : "artifacts";
}

function normalizeRelPath(relPath) {
  const normalized = String(relPath).replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (path.isAbsolute(normalized)) return normalized;
  return path.normalize(normalized).replaceAll("\\", "/");
}

function runRelDir(state) {
  return path.join(".aipi", "runtime", "runs", state.run_id).replaceAll("\\", "/");
}

function resultPathFor(state, step) {
  return path.join(runRelDir(state), "steps", step.id, "RESULT.md").replaceAll("\\", "/");
}

function markStep(state, stepId, patch) {
  const entry = state.steps.find((step) => step.id === stepId);
  if (!entry) throw new Error(`Run state missing step ${stepId}`);
  Object.assign(entry, patch);
}

function nextPendingStep(state) {
  return state.steps.find((step) => step.status === "pending")?.id ?? null;
}

function nextStepId(workflow, step) {
  return workflow.steps[step.index + 1]?.id ?? null;
}

function firstUnpassedRequirement(step, state) {
  for (const requirement of step.requires) {
    const entry = state.steps.find((candidate) => candidate.id === requirement);
    if (!entry || !["passed", "skipped"].includes(entry.status)) return requirement;
  }
  return null;
}

function rootRequirementBlock({ requirement, state, stepById }) {
  const visited = new Set();
  let currentId = requirement;
  let fallbackReason = `required step ${requirement} has not passed`;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const entry = state.steps.find((candidate) => candidate.id === currentId);
    const step = stepById.get(currentId);
    if (!entry) return { step, reason: fallbackReason };
    if (entry.error) return { step, reason: entry.error, entry };
    if (entry.status === "blocked" || entry.status === "failed" || entry.status === "approval_required") {
      return { step, reason: `${currentId} is ${entry.status}`, entry };
    }
    const nested = step ? firstUnpassedRequirement(step, state) : null;
    if (!nested) return { step, reason: fallbackReason, entry };
    fallbackReason = `required step ${nested} has not passed`;
    currentId = nested;
  }
  return { step: stepById.get(requirement), reason: fallbackReason };
}

function branchTarget(step, validation) {
  if (validation.policyDecision) return step.gate.on_policy_decision?.[validation.policyDecision] ?? null;
  return step.gate.on_verdict?.[validation.verdict] ?? null;
}

function recordPolicyDecision({ state, step, result, validation, now }) {
  const decision = validation.policyDecision ?? result?.policy_decision ?? null;
  if (!decision) return;
  state.policy_decisions.push({
    step_id: step.id,
    decision,
    gate_passed: validation.gatePassed,
    target: branchTarget(step, validation),
    recorded_at: now().toISOString(),
    evidence: (result?.evidence ?? []).map((item) => ({
      rung: item.rung,
      source: item.source,
      ref: item.ref,
    })),
  });
}

function policyGateMessage(validation, target) {
  if (validation.policyDecision) {
    return `policy decision ${validation.policyDecision} did not pass gate${target ? `; target=${target}` : ""}`;
  }
  return "step result did not pass gate";
}

function gateFailureStatus(result, validation) {
  if (validation.policyDecision === "HUMAN_REVIEW_REQUIRED") return "approval_required";
  if (validation.policyDecision === "BLOCK") return "blocked";
  if (result?.verdict === "BLOCKED" || result?.verdict === "BLOCKED_TO_PLANNING") return "blocked";
  return "failed";
}

function isStructuralNoExecutableAdapterBlock(result, error = "", validation = {}) {
  if (validation?.policyDecision) return false;
  if (result?.verdict !== "BLOCKED") return false;
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  return evidence.some((item) =>
    item?.source === "aipi-local-executor" &&
      /no executable adapter|refusing to self-stamp/i.test(`${item?.result ?? ""}\n${error}`),
  );
}

function isTransientProviderFailureBlock(result, validation = {}) {
  if (validation?.policyDecision) return false;
  return result?.verdict === "BLOCKED" && Boolean(result?.transient_provider_failure);
}

// FIX 3: a worker crash is a subagent that was spawned (so it's not "no adapter") but terminated
// without writing a valid result. Detected by the subagent adapter's "did not finish:" evidence item.
function isWorkerCrashBlock(result, validation = {}) {
  if (validation?.policyDecision) return false;
  if (result?.verdict !== "BLOCKED") return false;
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  return evidence.some((item) =>
    item?.source === "aipi-subagent-workflow-adapter" &&
      /did not finish:/i.test(String(item?.result ?? "")),
  );
}

function shouldAskUserOnGateStop({ target, failedStatus } = {}) {
  if (target === "stop_for_user_question") return true;
  if (target === "stop" || !target) return ["blocked", "failed"].includes(failedStatus);
  return false;
}

function awaitingUserDecisionForBlockedGate({ step, result = null, reason = "", createdAt, infra = false } = {}) {
  const hasQuestion = Boolean(
    result?.blocker_question ||
      result?.awaiting_user_input ||
      result?.user_question ||
      result?.question,
  );
  const resolvedResult = hasQuestion
    ? result
    : {
        ...(result ?? {}),
        blocker_question: defaultBlockedGateQuestion({ step, reason, result }),
      };
  const awaiting = awaitingUserInputFromStepResult({
    step,
    result: resolvedResult,
    reason,
    createdAt,
  });
  // ADV-58-1: tag the freestyle/retry/cancel META-decision so it can self-recover.
  // This is the run-level "how do you want to proceed" picker (default blocked gate or
  // transient-provider block), NOT a real business blocker_question. We detect it by the
  // options matching the workflow meta set so a substantive new message can auto-detach
  // instead of trapping the user.
  if (isWorkflowBlockedDecisionOptions(awaiting.options)) {
    awaiting.kind = WORKFLOW_BLOCKED_DECISION_KIND;
  }
  // gate_kind FLOOR: deterministic authority for this stop. `infra` is asserted by the no-adapter/transient
  // sink (work did NOT run -> never auto-continue); courtesy is reserved for a fabricated low-risk Sink-B
  // stop the worker never raised. The optional stop-classifier may only downgrade courtesy -> continue.
  const questionText =
    resolvedResult?.blocker_question?.question ??
    result?.awaiting_user_input?.question ??
    result?.question ??
    "";
  awaiting.gate_kind = classifyGateKind({ reason, question: questionText, step, hasRealWorkerQuestion: hasQuestion, infra });
  return awaiting;
}

export const WORKFLOW_BLOCKED_DECISION_KIND = "workflow_blocked_decision";

const WORKFLOW_BLOCKED_DECISION_OPTION_TOKENS = [
  "continuar fora do workflow automatico",
  "tentar executar este workflow novamente",
  "cancelar este run",
];

export function isWorkflowBlockedDecisionOptions(options) {
  if (!Array.isArray(options) || options.length < 2) return false;
  const normalized = options.map((option) =>
    String(option ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim(),
  );
  const matched = WORKFLOW_BLOCKED_DECISION_OPTION_TOKENS.filter((token) =>
    normalized.some((option) => option.includes(token)),
  );
  // Require at least the continue-freestyle and one of retry/cancel to be present so a
  // genuine business blocker that happens to reuse one phrase is not misclassified.
  return matched.length >= 2 &&
    normalized.some((option) => option.includes("continuar fora do workflow automatico"));
}

function defaultBlockedGateQuestion({ step, reason = "", result = null } = {}) {
  const stepId = step?.id ?? "current step";
  // Check both the reason string and the result's evidence items for no-adapter signals so the
  // detection works regardless of how `error` was assembled (the adapter message may be in evidence).
  const evidenceText = Array.isArray(result?.evidence)
    ? result.evidence.map((e) => String(e?.result ?? "")).join("\n")
    : "";
  const noAdapter = /no executable adapter|refusing to self-stamp/i.test(`${reason}\n${evidenceText}`);
  return {
    question: noAdapter
      ? `AIPI nao conseguiu executar ${stepId} automaticamente porque nenhum executor esta configurado. Como voce quer seguir?`
      : `AIPI parou em ${stepId}: ${reason || "o gate nao passou"}. Como voce quer seguir?`,
    // FIX 2c: when there is no executable adapter the retry option is meaningless (the adapter
    // configuration won't change mid-session), so only offer the freestyle/cancel pair. The full
    // three-option set is kept for transient/gate failures where a retry can actually succeed.
    options: noAdapter
      ? [
          "Continuar fora do workflow automatico nesta conversa",
          "Cancelar este run",
        ]
      : [
          "Continuar fora do workflow automatico nesta conversa",
          "Tentar executar este workflow novamente",
          "Cancelar este run",
        ],
    allow_free_text: true,
  };
}

function localPolicyDecision(step) {
  if (step.gate?.approval_decisions?.includes("HUMAN_REVIEW_REQUIRED")) return "HUMAN_REVIEW_REQUIRED";
  if (step.gate?.block_decisions?.includes("BLOCK")) return "BLOCK";
  return null;
}

function localSkipCondition(step) {
  if (step.gate?.allow_skip !== true || !step.gate?.skip_requires) return null;
  const deterministicNoSignalSkips = new Set([
    "no_actionable_findings",
    "no_deployment_surface",
    "no_durable_memory_signal",
    "no_external_research_needed",
    "no_external_unknowns",
    "no_internal_context",
    "not_homolog_or_no_ui_flow",
  ]);
  return deterministicNoSignalSkips.has(step.gate.skip_requires) ? step.gate.skip_requires : null;
}

function assignArtifactsToAgents(agents, artifacts) {
  const assignments = new Map(agents.map((agent) => [agent, []]));
  if (!agents.length) return assignments;
  for (const [index, artifact] of artifacts.entries()) {
    assignments.get(agents[index % agents.length]).push(artifact);
  }
  return assignments;
}

function terminalStatus(target, failedStatus) {
  if (target === "escalate_to_planning") return "escalated_to_planning";
  if (target === "escalate_to_human") return "escalated_to_human";
  if (target === "stop_for_user_question") return "blocked";
  if (target === "stop_for_human_approval") return "approval_required";
  if (target === "stop") return failedStatus;
  return failedStatus;
}

function sleep(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function exhaustRunLimit(state, contract, reason) {
  const action = contract.runLimits?.onExhaustion ?? "escalate_to_human";
  state.status = terminalStatus(action, "blocked");
  state.current_step = null;
  state.blocked_reason = reason;
}

function totalVisits(visits) {
  return Object.values(visits ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
}

async function readActiveRunId(root) {
  return (await fs.readFile(path.join(root, ".aipi", "runtime", "runs", "active"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).trim();
}

async function clearActiveRunPointer(root, runId) {
  const activePath = path.join(root, ".aipi", "runtime", "runs", "active");
  const activeRunId = (await fs.readFile(activePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).trim();
  if (!activeRunId || activeRunId !== runId) return;
  await fs.rm(activePath, { force: true });
}

function isTerminalActiveStatus(status) {
  return ["completed", "failed", "cancelled", "canceled", "abandoned", "escalated_to_human", "escalated_to_planning"]
    .includes(String(status ?? "").toLowerCase());
}

async function persistRunState(root, state) {
  const runDir = path.join(root, ".aipi", "runtime", "runs", state.run_id);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, "RUN-MANIFEST.md"), renderRunManifest(state));
}

function renderRunManifest(state) {
  return `---
schema: aipi.run-manifest.v1
run_id: ${state.run_id}
workflow: ${state.workflow}
status: ${state.status}
created_at: ${state.created_at}
source_workflow: ${state.source_workflow}
contract_path: ${state.contract_path}
current_step: ${state.current_step ?? ""}
---

# AIPI Run ${state.run_id}

- workflow: ${state.workflow}
- status: ${state.status}
- current_step: ${state.current_step ?? "none"}
- source_workflow: ${state.source_workflow}
- contract_path: ${state.contract_path}
- execution_mode: ${state.execution_mode ?? "not_started"}

## Steps

${state.steps.map((step) => `- ${step.id}: ${step.status}${step.verdict ? ` (${step.verdict})` : ""}`).join("\n")}
`;
}
