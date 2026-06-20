import fs from "node:fs/promises";
import path from "node:path";
import { awaitingUserInputFromStepResult } from "./blocker-input.js";
import { buildStepContext, ContextMaterializationError } from "./context-builder.js";
import { aipiPromoteMemory } from "./aipi-tools.js";
import { resolveStepModel } from "./model-router.js";
import { validateStepResult } from "./step-result.js";

const terminalActions = new Set([
  "stop",
  "stop_for_user_question",
  "stop_for_human_approval",
  "escalate_to_human",
  "escalate_to_planning",
]);

export async function executeWorkflowRun({
  projectRoot,
  runId = null,
  adapter = createLocalWorkflowAdapter(),
  now = () => new Date(),
  parentInteractiveToolCallHook = "registered_parent_interactive_tool_call_hook",
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

  state.status = "running";
  state.execution_mode = state.workflow === "quick" ? "local-quick-slice-v1" : "local-workflow-slice-v1";
  state.policy = {
    controller_gate: "executor_declared_artifact_only",
    controller_write_scope: "declared_step_artifacts_only",
    parent_interactive_tool_call_hook: parentInteractiveToolCallHook,
  };
  state.step_visits ??= {};
  state.consecutive_failures ??= 0;
  state.policy_decisions ??= [];

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
      markStep(state, step.id, {
        status: "blocked",
        verdict: "BLOCKED",
        error: `required step ${requirement} has not passed`,
        finished_at: now().toISOString(),
      });
      state.status = "blocked";
      state.current_step = step.id;
      state.awaiting_user_input = null;
      events.push({ type: "blocked", step_id: step.id, reason: `missing requirement ${requirement}` });
      break;
    }

    state.step_visits[step.id] = (state.step_visits[step.id] ?? 0) + 1;
    markStep(state, step.id, { status: "running", started_at: now().toISOString() });
    state.current_step = step.id;
    await persistRunState(root, state);

    let context = null;
    try {
      context = await buildStepContext({ root, state, workflow, step, contract });
    } catch (error) {
      if (!(error instanceof ContextMaterializationError)) throw error;
      markStep(state, step.id, {
        status: "blocked",
        verdict: "BLOCKED",
        error: error.message,
        finished_at: now().toISOString(),
      });
      state.status = "blocked";
      state.current_step = step.id;
      state.blocked_reason = error.message;
      state.awaiting_user_input = null;
      events.push({ type: "blocked", step_id: step.id, reason: error.message });
      await persistRunState(root, state);
      break;
    }

    const result = await adapter.executeStep({ root, state, workflow, step, context, contract });
    const validation = validateStepResult(result, { step, contract });
    recordPolicyDecision({ state, step, result, validation, now });
    const missingArtifacts = validation.gatePassed
      ? await missingRequiredArtifacts({ root, state, step, result })
      : [];
    const memoryPromotionGate = validation.gatePassed && missingArtifacts.length === 0
      ? await materializeStepMemoryPromotions({ root, state, step, result, now })
      : null;
    await writeStepResult({ root, state, step, result, validation, missingArtifacts });

    if (validation.gatePassed && missingArtifacts.length === 0 && !memoryPromotionGate?.error) {
      const status = result.verdict === "SKIPPED" ? "skipped" : "passed";
      markStep(state, step.id, {
        status,
        verdict: result.verdict,
        finished_at: now().toISOString(),
        result_path: resultPathFor(state, step),
        artifacts: result.artifacts,
        skip_condition: result.skip_condition ?? null,
      });
      events.push({ type: status, step_id: step.id, verdict: result.verdict });
      state.consecutive_failures = 0;
      if (state.awaiting_user_input?.step_id === step.id) state.awaiting_user_input = null;
      state.current_step = nextStepId(workflow, step);
      if (!state.current_step) state.status = "completed";
      await persistRunState(root, state);
      continue;
    }

    const target = missingArtifacts.length || memoryPromotionGate?.error
      ? step.gate.on_verdict?.FAIL ?? null
      : branchTarget(step, validation);
    const error = missingArtifacts.length
      ? `missing required artifacts: ${missingArtifacts.join(", ")}`
      : memoryPromotionGate?.error
        ? memoryPromotionGate.error
      : validation.errors.length
        ? validation.errors.join("; ")
        : policyGateMessage(validation, target);
    state.consecutive_failures = (state.consecutive_failures ?? 0) + 1;
    const failedStatus = gateFailureStatus(result, validation);
    markStep(state, step.id, {
      status: failedStatus,
      verdict: result?.verdict ?? null,
      error,
      finished_at: now().toISOString(),
      result_path: resultPathFor(state, step),
      artifacts: result?.artifacts ?? [],
    });
    events.push({ type: failedStatus, step_id: step.id, verdict: validation.verdict, error, target });

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
      state.current_step = target;
      state.awaiting_user_input = null;
      await persistRunState(root, state);
      continue;
    }

    const awaitingUserInput = target === "stop_for_user_question";
    const blockedAt = now().toISOString();
    state.status = terminalStatus(target, failedStatus);
    state.current_step = awaitingUserInput ? step.id : terminalActions.has(target) ? null : step.id;
    state.blocked_reason = error;
    state.awaiting_user_input = awaitingUserInput
      ? awaitingUserInputFromStepResult({
          step,
          result,
          reason: error,
          createdAt: blockedAt,
        })
      : null;
    await persistRunState(root, state);
  }

  state.completed_at = state.status === "completed" ? now().toISOString() : state.completed_at;
  await persistRunState(root, state);
  return { runId: activeRunId, status: state.status, state, events };
}

export function createLocalWorkflowAdapter() {
  return {
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
  workerStepIds = ["quick_change"],
  fanoutStepIds = ["review_swarm"],
  pollIntervalMs = 50,
  collectTimeoutMs = 120_000,
  modelResolver = resolveStepModel,
} = {}) {
  if (!coordinator?.spawn || !coordinator?.collect) {
    throw new Error("createSubagentWorkflowAdapter requires a SubagentCoordinator-like object");
  }
  const workerSteps = new Set(workerStepIds);
  const fanoutSteps = new Set(fanoutStepIds);
  return {
    async executeStep(args) {
      if (fanoutSteps.has(args.step.id) && args.step.agents.length > 1) {
        return executeFanoutSubagentStep({
          ...args,
          coordinator,
          pollIntervalMs,
          collectTimeoutMs,
          modelResolver,
        });
      }
      if (!workerSteps.has(args.step.id)) return fallback.executeStep(args);
      return executeSubagentStep({
        ...args,
        coordinator,
        pollIntervalMs,
        collectTimeoutMs,
        modelResolver,
      });
    },
  };
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
    const descriptor = {
      agent_id: agent,
      step_id: step.id,
      model_class: modelResolution.model_class,
      model_resolution_source: modelResolution.source,
      model: modelResolution.model ?? undefined,
      thinking_level: modelResolution.thinking_level,
      result_schema: "aipi.step-result.v1",
      artifact_target: path.join(runRelDir(state), "steps", step.id).replaceAll("\\", "/"),
      expected_artifacts: assignedArtifacts,
      owned_files: assignedArtifacts,
      context_packet: JSON.stringify(
        {
          schema: "aipi.worker-context.v1",
          workflow: workflow.name,
          step_id: step.id,
          step_name: step.name ?? null,
          step_prompt: step.prompt ?? null,
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
    spawned.push({ catalogAgentId: agent, ...dispatchSubagent(coordinator, descriptor) });
  }

  const collected = [];
  for (const worker of spawned) {
    const collect = await collectSubagentResult(coordinator, worker.agent_id, {
      pollIntervalMs,
      collectTimeoutMs,
    });
    if (!collect.ready) {
      return blockedStepResult({
        step,
        agentId: worker.agent_id,
        reason: `fan-out worker ${worker.agent_id} did not finish: ${collect.state ?? "unknown"}`,
      });
    }
    collected.push(collect);
  }

  const nonPass = collected.find((item) => item.step_result?.verdict !== "PASS");
  if (nonPass) {
    return {
      schema: "aipi.step-result.v1",
      step_id: step.id,
      agent_ids: collected.map((item) => item.agent_id),
      verdict: nonPass.step_result?.verdict ?? "FAIL",
      evidence: collected.flatMap((item) => item.step_result?.evidence ?? []),
      artifacts: collected.flatMap((item) => item.step_result?.artifacts ?? item.artifacts ?? []),
    };
  }

  return {
    schema: "aipi.step-result.v1",
    step_id: step.id,
    agent_ids: collected.map((item) => item.agent_id),
    verdict: "PASS",
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
}) {
  const artifacts = step.produces.map((template) => renderTemplate(template, state, step));
  const modelResolution = await modelResolver({ root, workflow, step, context, contract });
  const descriptor = {
    agent_id: step.agents[0] ?? "aipi-worker",
    step_id: step.id,
    model_class: modelResolution.model_class,
    model_resolution_source: modelResolution.source,
    model: modelResolution.model ?? undefined,
    thinking_level: modelResolution.thinking_level,
    result_schema: "aipi.step-result.v1",
    artifact_target: path.join(runRelDir(state), "steps", step.id).replaceAll("\\", "/"),
    expected_artifacts: artifacts,
    owned_files: artifacts,
    context_packet: JSON.stringify(
      {
        schema: "aipi.worker-context.v1",
        workflow: workflow.name,
        step_id: step.id,
        step_name: step.name ?? null,
        step_prompt: step.prompt ?? null,
        run_id: state.run_id,
        contract_path: state.contract_path,
        expected_artifacts: artifacts,
        context,
      },
      null,
      2,
    ),
  };

  const { agent_id: agentId } = dispatchSubagent(coordinator, descriptor);
  const collect = await collectSubagentResult(coordinator, agentId, {
    pollIntervalMs,
    collectTimeoutMs,
  });
  if (!collect.ready) {
    return blockedStepResult({
      step,
      agentId,
      reason: `worker ${agentId} did not finish: ${collect.state ?? "unknown"}`,
    });
  }
  return {
    ...collect.step_result,
    artifacts: collect.step_result?.artifacts?.length ? collect.step_result.artifacts : collect.artifacts ?? [],
  };
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
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= collectTimeoutMs) {
    const collect = coordinator.collect(agentId);
    if (collect.ready || ["failed", "cancelled", "interrupted"].includes(collect.state)) return collect;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { agent_id: agentId, ready: false, state: "timeout" };
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
    errors.push("memory-promotion PASS requires memory_promotions; return SKIPPED with no_durable_memory_signal when there is no durable fact");
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
    step.prompt ?? "(no prompt)",
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
