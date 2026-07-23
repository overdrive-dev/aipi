import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { executeWorkflowRun } from "./workflow-executor.js";
import { formatAwaitingUserInputPrompt } from "./blocker-input.js";

const TERMINAL_ACTIVE_STATUSES = new Set([
  "complete",
  "completed",
  "done",
  "failed",
  "cancelled",
  "canceled",
  "abandoned",
  "escalated_to_human",
  "escalated_to_planning",
]);

const workflowAliases = new Map([
  ["bug", "bugfix"],
  ["bugfix", "bugfix"],
  ["feature", "feature"],
  ["ops", "ops"],
  ["plan", "planning"],
  ["planning", "planning"],
  ["quick", "quick"],
  ["research", "research"],
]);

const workflowChains = new Map([
  ["planning-feature", ["planning", "feature"]],
  ["feature", ["planning", "feature"]],
]);

export function parseWorkflowArgs(args = "") {
  const tokens = String(args)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!tokens.length) return { action: "status" };

  const [first, ...rest] = tokens;
  if (first === "list") return { action: "list" };
  if (first === "status") return { action: "status" };
  if (first === "execute" || first === "continue") return { action: "execute" };
  if (first === "run-chain") {
    const chainToken = rest.shift();
    if (!chainToken) throw new Error("Missing workflow chain name");
    if (rest.length) throw new Error(`Unknown /aipi-workflow option: ${rest[0]}`);
    return { action: "run-chain", chain: resolveWorkflowChain(chainToken) };
  }

  const shouldExecute = first === "run";
  const workflowToken = first === "start" || first === "run" ? rest.shift() : first;
  if (!workflowToken) throw new Error("Missing workflow name");

  const options = {
    action: shouldExecute ? "run" : "start",
    workflow: resolveWorkflowName(workflowToken),
    dryRun: false,
    contractPath: null,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--contract") {
      const value = rest[index + 1];
      if (!value) throw new Error("Missing value after --contract");
      options.contractPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown /aipi-workflow option: ${token}`);
  }

  return options;
}

export async function runWorkflowCommand({
  args = "",
  projectRoot,
  adapter = undefined,
  parentInteractiveToolCallHook = "registered_parent_interactive_tool_call_hook",
  notify = null,
  params = {},
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const command = parseWorkflowArgs(args);

  if (command.action === "list") {
    return { action: "list", workflows: await listWorkflows(projectRoot) };
  }

  if (command.action === "status") {
    return { action: "status", active: await readActiveRun(projectRoot) };
  }

  if (command.action === "execute") {
    const execution = await executeWorkflowRun({ projectRoot, adapter, parentInteractiveToolCallHook, notify });
    const advanced = await advanceWorkflowChain({
      projectRoot,
      execution,
      adapter,
      parentInteractiveToolCallHook,
      notify,
    });
    return {
      action: "execute",
      execution: advanced.execution,
      ...(advanced.chain ? { chain: advanced.chain, phase_executions: advanced.phaseExecutions } : {}),
    };
  }

  if (command.action === "run-chain") {
    return runWorkflowChain({
      chain: command.chain,
      projectRoot,
      adapter,
      parentInteractiveToolCallHook,
      notify,
      params,
    });
  }

  const started = await startWorkflowRun({
    projectRoot,
    workflow: command.workflow,
    contractPath: command.contractPath,
    dryRun: command.dryRun,
    params,
  });

  if (command.action === "run" && !command.dryRun) {
    return {
      action: "run",
      run: started,
      execution: await executeWorkflowRun({ projectRoot, runId: started.runId, adapter, parentInteractiveToolCallHook, notify }),
    };
  }

  return {
    action: "start",
    run: started,
  };
}

export async function runWorkflowChain({
  chain = "planning-feature",
  projectRoot,
  adapter = undefined,
  parentInteractiveToolCallHook = "registered_parent_interactive_tool_call_hook",
  notify = null,
  params = {},
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const root = path.resolve(projectRoot);
  await assertAipiInstalled(root);
  const chainName = resolveWorkflowChain(chain);
  const request = String(params?.request ?? "").trim();
  if (!request) throw new Error(`workflow chain ${chainName} requires a non-empty request`);

  const chainId = `chain-${generateRunId(() => new Date(), (size) => crypto.randomBytes(size))}`;
  let chainState = {
    schema: "aipi.workflow-chain.v1",
    chain_id: chainId,
    chain: chainName,
    request,
    status: "starting",
    active_phase: "planning",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phases: {
      planning: { workflow: "planning", status: "pending", run_id: null },
      feature: { workflow: "feature", status: "pending", run_id: null },
    },
  };
  await persistWorkflowChain(root, chainState);

  try {
    const planningRun = await startWorkflowRun({
      projectRoot: root,
      workflow: "planning",
      params: { ...params, request },
      chainId,
      chainPhase: "planning",
    });
    chainState.phases.planning = {
      workflow: "planning",
      status: "active",
      run_id: planningRun.runId,
      contract_path: planningRun.contractPath,
    };
    chainState.status = "running";
    chainState.updated_at = new Date().toISOString();
    await persistWorkflowChain(root, chainState);

    const planningExecution = await executeWorkflowRun({
      projectRoot: root,
      runId: planningRun.runId,
      adapter,
      parentInteractiveToolCallHook,
      notify,
    });
    const advanced = await advanceWorkflowChain({
      projectRoot: root,
      execution: planningExecution,
      adapter,
      parentInteractiveToolCallHook,
      notify,
    });
    return {
      action: "run-chain",
      chain: advanced.chain,
      run: advanced.run ?? planningRun,
      execution: advanced.execution,
      phase_executions: advanced.phaseExecutions,
    };
  } catch (error) {
    chainState = await readWorkflowChain(root, chainId).catch(() => chainState);
    chainState.status = "failed";
    chainState.error = String(error?.message ?? error);
    chainState.updated_at = new Date().toISOString();
    await persistWorkflowChain(root, chainState).catch(() => null);
    throw error;
  }
}

export async function readWorkflowChain(projectRoot, chainId) {
  if (!projectRoot) throw new Error("projectRoot is required");
  if (!chainId) throw new Error("chainId is required");
  const chainPath = path.join(path.resolve(projectRoot), ".aipi", "runtime", "chains", `${chainId}.json`);
  return JSON.parse(await fs.readFile(chainPath, "utf8"));
}

async function advanceWorkflowChain({
  projectRoot,
  execution,
  adapter,
  parentInteractiveToolCallHook,
  notify,
} = {}) {
  const chainId = execution?.state?.chain_id;
  const phase = execution?.state?.chain_phase;
  if (!chainId || !phase) return { execution, chain: null, phaseExecutions: [execution] };

  const root = path.resolve(projectRoot);
  const chainState = await readWorkflowChain(root, chainId);
  const phaseState = chainState.phases?.[phase];
  if (!phaseState) throw new Error(`workflow chain ${chainId} references unknown phase ${phase}`);
  chainState.phases[phase] = {
    ...phaseState,
    status: execution.status,
    run_id: execution.runId,
    contract_path: execution.state.contract_path ?? phaseState.contract_path ?? null,
    finished_at: execution.state.completed_at ?? new Date().toISOString(),
  };
  chainState.updated_at = new Date().toISOString();

  if (execution.status !== "completed") {
    chainState.status = execution.status === "blocked" ? "blocked" : "failed";
    chainState.active_phase = phase;
    await persistWorkflowChain(root, chainState);
    return {
      execution,
      chain: chainState,
      run: runSummaryFromExecution(execution),
      phaseExecutions: [execution],
    };
  }

  if (phase === "feature") {
    chainState.status = "completed";
    chainState.active_phase = null;
    chainState.completed_at = execution.state.completed_at ?? new Date().toISOString();
    await persistWorkflowChain(root, chainState);
    return {
      execution,
      chain: chainState,
      run: runSummaryFromExecution(execution),
      phaseExecutions: [execution],
    };
  }

  chainState.status = "running";
  chainState.active_phase = "planning";
  await persistWorkflowChain(root, chainState);

  let contractPath;
  let featureRun;
  try {
    contractPath = await assertAcceptedChainContract(root, execution.state.contract_path);
    featureRun = await startWorkflowRun({
      projectRoot: root,
      workflow: "feature",
      contractPath,
      chainId,
      chainPhase: "feature",
      upstreamRunId: execution.runId,
    });
  } catch (error) {
    chainState.status = "failed";
    chainState.active_phase = null;
    chainState.error = String(error?.message ?? error);
    chainState.updated_at = new Date().toISOString();
    await persistWorkflowChain(root, chainState);
    throw error;
  }
  chainState.phases.feature = {
    workflow: "feature",
    status: "active",
    run_id: featureRun.runId,
    contract_path: contractPath,
  };
  chainState.status = "running";
  chainState.active_phase = "feature";
  chainState.updated_at = new Date().toISOString();
  await persistWorkflowChain(root, chainState);

  let featureExecution;
  try {
    featureExecution = await executeWorkflowRun({
      projectRoot: root,
      runId: featureRun.runId,
      adapter,
      parentInteractiveToolCallHook,
      notify,
    });
  } catch (error) {
    chainState.status = "failed";
    chainState.active_phase = "feature";
    chainState.phases.feature.status = "failed";
    chainState.phases.feature.error = String(error?.message ?? error);
    chainState.error = String(error?.message ?? error);
    chainState.updated_at = new Date().toISOString();
    await persistWorkflowChain(root, chainState);
    throw error;
  }
  const completed = await advanceWorkflowChain({
    projectRoot: root,
    execution: featureExecution,
    adapter,
    parentInteractiveToolCallHook,
    notify,
  });
  return {
    ...completed,
    run: featureRun,
    phaseExecutions: [execution, ...(completed.phaseExecutions ?? [featureExecution])],
  };
}

async function assertAcceptedChainContract(root, contractPath) {
  const value = String(contractPath ?? "").trim();
  if (!value) throw new Error("planning completed without a contract path");
  const absRoot = path.resolve(root);
  const absPath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(absRoot, value);
  const rel = path.relative(absRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`planning contract escapes the project root: ${value}`);
  }
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`planning completed without a non-empty accepted contract at ${value}`);
  }
  return rel.replaceAll("\\", "/");
}

async function persistWorkflowChain(root, chainState) {
  const chainDir = path.join(root, ".aipi", "runtime", "chains");
  const target = path.join(chainDir, `${chainState.chain_id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.mkdir(chainDir, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(chainState, null, 2)}\n`);
  await fs.rename(temporary, target);
}

function runSummaryFromExecution(execution) {
  const state = execution?.state ?? {};
  return {
    runId: execution?.runId ?? state.run_id,
    workflow: state.workflow,
    runRelDir: state.run_rel_dir,
    contractPath: state.contract_path,
    state,
  };
}

export async function listWorkflows(projectRoot) {
  const workflowDir = path.join(projectRoot, ".aipi", "workflows");
  const entries = await fs.readdir(workflowDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error("AIPI workflows are not installed; run /aipi-init first");
    }
    throw error;
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => path.basename(entry.name, ".yaml"))
    .sort();
}

export async function startWorkflowRun({
  projectRoot,
  workflow,
  contractPath = null,
  dryRun = false,
  params = {},
  planId = null,
  taskId = null,
  chainId = null,
  chainPhase = null,
  upstreamRunId = null,
  now = () => new Date(),
  randomBytes = (size) => crypto.randomBytes(size),
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const root = path.resolve(projectRoot);
  await assertAipiInstalled(root);

  const workflowName = resolveWorkflowName(workflow);
  const workflowRelPath = path.join(".aipi", "workflows", `${workflowName}.yaml`);
  const workflowAbsPath = path.join(root, workflowRelPath);
  const workflowDefinition = await readWorkflowDefinition(workflowAbsPath, workflowName);
  const createdAt = now().toISOString();
  const runId = generateRunId(now, randomBytes);
  const runRelDir = path.join(".aipi", "runtime", "runs", runId);
  const runDir = path.join(root, runRelDir);
  const resolvedContractPath =
    contractPath ?? path.join(runRelDir, "BDD-CONTRACT.md").replaceAll("\\", "/");

  // Resolve run params: declared workflow defaults (bug: "") <- caller overrides (bug: <task text>)
  // <- run_id bound to the actual run. These render into step prompts via the executor's renderText,
  // so a pasted task actually reaches triage instead of leaving the literal "{{ bug }}".
  const resolvedParams = {
    ...(workflowDefinition.params ?? {}),
    ...(params && typeof params === "object" ? params : {}),
    run_id: runId,
    contract_path: resolvedContractPath,
  };

  const state = {
    schema: "aipi.run-state.v1",
    run_id: runId,
    workflow: workflowName,
    workflow_name: workflowDefinition.name,
    workflow_mode: workflowDefinition.mode,
    status: "active",
    created_at: createdAt,
    source_workflow: workflowRelPath.replaceAll("\\", "/"),
    run_rel_dir: runRelDir.replaceAll("\\", "/"),
    contract_path: resolvedContractPath,
    // When a run is dispatched as part of a multi-task plan, bind it back to its plan + task so the plan
    // executor can map the run's outcome onto the plan task (and the kanban card). Absent for lone runs.
    ...(planId ? { plan_id: planId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    ...(chainId ? { chain_id: chainId } : {}),
    ...(chainPhase ? { chain_phase: chainPhase } : {}),
    ...(upstreamRunId ? { upstream_run_id: upstreamRunId } : {}),
    params: resolvedParams,
    current_step: workflowDefinition.steps[0]?.id ?? null,
    steps: workflowDefinition.steps.map((step) => ({
      id: step.id,
      stage: step.stage,
      status: "pending",
    })),
  };

  // FIX 6: validate required params BEFORE creating the run directory so a missing param fails fast
  // without leaving a partially-created run dir on disk. A param is required when its declared
  // default is the empty string AND it is referenced as {{ key }} in the workflow YAML (meaning it
  // is intentionally a user-supplied value, not an internal binding like run_id).
  validateRequiredWorkflowParams(workflowDefinition.params, workflowDefinition.text, params, workflowName);

  if (!dryRun) {
    await fs.mkdir(path.join(runDir, "steps"), { recursive: true });
    await fs.writeFile(path.join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    await fs.writeFile(path.join(runDir, "RUN-MANIFEST.md"), renderRunManifest(state));
    await fs.writeFile(path.join(root, ".aipi", "runtime", "runs", "active"), `${runId}\n`);
  }

  return {
    runId,
    workflow: workflowName,
    workflowRelPath: workflowRelPath.replaceAll("\\", "/"),
    runRelDir: runRelDir.replaceAll("\\", "/"),
    contractPath: resolvedContractPath,
    dryRun,
    state,
  };
}

export async function readActiveRun(projectRoot, { includeTerminal = false, keepBlockedDecision = false } = {}) {
  const root = path.resolve(projectRoot);
  const activePath = path.join(root, ".aipi", "runtime", "runs", "active");
  const runId = (await fs.readFile(activePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).trim();

  if (!runId) return null;

  const statePath = path.join(root, ".aipi", "runtime", "runs", runId, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (!includeTerminal && isTerminalActiveStatus(state.status)) {
    await clearActiveRun(root, runId);
    return null;
  }
  // CR-59-2 / ADV-58-1: a structurally-dead run that is `blocked` only on the workflow
  // freestyle/retry/cancel META-decision is NOT a terminal status, so the terminal self-clear above
  // misses it — and it would otherwise stay `active` forever, re-trapping the user on every read /
  // fresh session. Auto-detach it centrally here (abandon + clear active) so no one resurrects it.
  // `keepBlockedDecision` is the ONE opt-out: handleInput passes it so its explicit auto-detach path
  // (which also notifies + audits the user) runs instead of this silent central clear.
  if (!includeTerminal && !keepBlockedDecision && isRecoverableBlockedDecision(state)) {
    const at = new Date().toISOString();
    state.status = "abandoned";
    state.awaiting_user_input = null;
    state.current_step = null;
    state.abandoned_at = at;
    state.abandon_reason = state.abandon_reason || "auto-detached stale workflow-blocked decision run";
    state.closed_by = "system_auto_recover";
    state.closed_at = at;
    await persistRunState(root, state);
    await clearActiveRun(root, runId);
    return null;
  }
  return { runId, state };
}

function isRecoverableBlockedDecision(state) {
  return String(state?.status ?? "").toLowerCase() === "blocked" &&
    state?.awaiting_user_input?.kind === "workflow_blocked_decision" &&
    !state?.awaiting_user_input?.answer_recorded_at;
}

export async function clearActiveRun(projectRoot, runId = null) {
  const root = path.resolve(projectRoot);
  const activePath = path.join(root, ".aipi", "runtime", "runs", "active");
  if (runId) {
    const activeRunId = (await fs.readFile(activePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })).trim();
    if (activeRunId && activeRunId !== runId) {
      return { cleared: false, active_run_id: activeRunId, reason: "different_active_run" };
    }
  }
  await fs.rm(activePath, { force: true });
  return { cleared: true, active_run_id: runId ?? null };
}

export async function closeWorkflowRun({
  projectRoot,
  runId = null,
  status = "cancelled",
  reason = "",
  source = "system",
  now = () => new Date(),
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const root = path.resolve(projectRoot);
  const terminalStatus = normalizeCloseStatus(status);
  const active = runId ? await readRun(root, runId) : await readActiveRun(root, { includeTerminal: true });
  if (!active?.runId) throw new Error("No active AIPI run; start a workflow first");

  const at = now().toISOString();
  const state = active.state;
  state.status = terminalStatus;
  state.current_step = null;
  state.awaiting_user_input = null;
  state.blocked_reason = reason || state.blocked_reason || null;
  state.closed_by = source;
  state.closed_at = at;
  if (terminalStatus === "cancelled") {
    state.cancelled_at = at;
    state.cancel_reason = reason || "cancelled by user";
  }
  if (terminalStatus === "abandoned") {
    state.abandoned_at = at;
    state.abandon_reason = reason || "detached from automatic workflow";
  }
  await persistRunState(root, state);
  await clearActiveRun(root, active.runId);
  return { runId: active.runId, status: terminalStatus, state };
}

export async function recordWorkflowUserInput({
  projectRoot,
  runId = null,
  text = "",
  source = "input",
  now = () => new Date(),
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const root = path.resolve(projectRoot);
  const active = runId ? await readRun(root, runId) : await readActiveRun(root);
  if (!active?.runId) throw new Error("No active AIPI run; start a workflow first");

  const state = active.state;
  const recordedAt = now().toISOString();
  const relPath = path.posix.join(".aipi", "runtime", "runs", active.runId, "USER-INPUT.jsonl");
  const record = {
    schema: "aipi.user-input.v1",
    recorded_at: recordedAt,
    run_id: active.runId,
    workflow: state.workflow ?? null,
    step_id: state.awaiting_user_input?.step_id ?? state.current_step ?? null,
    state_status: state.status ?? null,
    source,
    text: truncateUserInput(redactWorkflowUserInput(text), 2000),
  };

  const absPath = path.join(root, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.appendFile(absPath, `${JSON.stringify(record)}\n`);

  state.last_user_input = {
    path: relPath,
    recorded_at: recordedAt,
    step_id: record.step_id,
    source,
    text_excerpt: truncateUserInput(record.text, 240),
  };
  if (state.awaiting_user_input && state.awaiting_user_input.step_id === record.step_id) {
    state.awaiting_user_input.answer_recorded_at = recordedAt;
    state.awaiting_user_input.answer_path = relPath;
  }
  await persistRunState(root, state);

  return { record, relPath };
}

export function formatWorkflowCommandResult(result) {
  if (result.action === "list") {
    return `AIPI workflows: ${result.workflows.join(", ")}`;
  }

  if (result.action === "status") {
    if (!result.active) return "AIPI workflow: no active run.";
    return [
      `AIPI workflow active: ${result.active.runId}`,
      `workflow=${result.active.state.workflow}`,
      `status=${result.active.state.status}`,
      `current_step=${result.active.state.current_step ?? "none"}`,
    ].join("\n");
  }

  if (result.action === "execute") {
    const formatted = formatExecutionResult("executed", result.execution);
    return result.chain
      ? `${formatted}\nchain_id=${result.chain.chain_id}\nchain_status=${result.chain.status}`
      : formatted;
  }

  if (result.action === "run-chain") {
    const phaseRuns = Object.values(result.chain?.phases ?? {})
      .filter((phase) => phase?.run_id)
      .map((phase) => `${phase.workflow}=${phase.run_id}`)
      .join(" ");
    return [
      `AIPI workflow chain ran: ${result.chain?.chain ?? "planning-feature"}`,
      `chain_id=${result.chain?.chain_id ?? "unknown"}`,
      `chain_status=${result.chain?.status ?? result.execution?.status ?? "unknown"}`,
      phaseRuns ? `phase_runs=${phaseRuns}` : null,
      `current_workflow=${result.execution?.state?.workflow ?? "none"}`,
      `current_step=${result.execution?.state?.current_step ?? "none"}`,
    ].filter(Boolean).join("\n") + formatRunOutcomeDetail(result.execution?.state);
  }

  if (result.action === "run") {
    return [
      `AIPI workflow ran: ${result.run.workflow}`,
      `run_id=${result.run.runId}`,
      `run_dir=${result.run.runRelDir}`,
      `status=${result.execution.status}`,
      `current_step=${result.execution.state.current_step ?? "none"}`,
    ].join("\n") + formatRunOutcomeDetail(result.execution.state);
  }

  const run = result.run;
  const mode = run.dryRun ? "dry-run" : "started";
  return [
    `AIPI workflow ${mode}: ${run.workflow}`,
    `run_id=${run.runId}`,
    `run_dir=${run.runRelDir}`,
    `contract_path=${run.contractPath}`,
  ].join("\n");
}

function formatExecutionResult(mode, execution) {
  return [
    `AIPI workflow ${mode}: ${execution.state.workflow}`,
    `run_id=${execution.runId}`,
    `status=${execution.status}`,
    `current_step=${execution.state.current_step ?? "none"}`,
  ].join("\n") + formatRunOutcomeDetail(execution.state);
}

// #11 — a run that ends anything other than `completed` must NOT end silently. Append a step summary, the
// reason it stopped, and the blocker question (with options) so the user always gets a summary + a concrete
// way to proceed instead of a bare `status=escalated_to_human current_step=none`.
function formatRunOutcomeDetail(state) {
  if (!state || state.status === "completed") return "";
  const glyph = (status) =>
    status === "passed" ? "✓" : status === "failed" ? "✗" : status === "skipped" ? "⊘" : status === "running" ? "▶" : "○";
  const lines = [];
  const steps = (state.steps ?? []).map((step) => `${glyph(step.status)} ${step.id}`);
  if (steps.length) lines.push(`steps: ${steps.join("  ")}`);
  if (state.blocked_reason) {
    lines.push(`reason: ${String(state.blocked_reason).replace(/\s+/g, " ").trim().slice(0, 400)}`);
  }
  if (state.awaiting_user_input) {
    lines.push("", formatAwaitingUserInputPrompt(state.awaiting_user_input));
  } else if (state.status === "blocked" || state.status === "escalated_to_human") {
    lines.push("", "Needs your decision to proceed — tell me how to continue, or fix the cause and re-run.");
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

function resolveWorkflowName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const resolved = workflowAliases.get(normalized);
  if (!resolved) {
    throw new Error(`Unknown AIPI workflow: ${value}`);
  }
  return resolved;
}

function resolveWorkflowChain(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!workflowChains.has(normalized)) {
    throw new Error(`Unknown AIPI workflow chain: ${value}`);
  }
  return normalized === "feature" ? "planning-feature" : normalized;
}

async function assertAipiInstalled(projectRoot) {
  const contractPath = path.join(projectRoot, ".aipi", "runtime-contract.json");
  try {
    await fs.access(contractPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("AIPI is not installed in this project; run /aipi-init first");
    }
    throw error;
  }
}

async function readRun(root, runId) {
  const statePath = path.join(root, ".aipi", "runtime", "runs", runId, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  return { runId, state };
}

async function persistRunState(root, state) {
  const runDir = path.join(root, ".aipi", "runtime", "runs", state.run_id);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, "RUN-MANIFEST.md"), renderRunManifest(state));
}

function isTerminalActiveStatus(status) {
  return TERMINAL_ACTIVE_STATUSES.has(String(status ?? "").toLowerCase());
}

function normalizeCloseStatus(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (normalized === "abandoned") return "abandoned";
  throw new Error(`Unsupported AIPI run close status: ${status}`);
}

function redactWorkflowUserInput(text) {
  return String(text ?? "")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "sk-[REDACTED]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "gh_[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?([A-Za-z0-9._/+=-]{8,})["']?/gi, "$1=[REDACTED]");
}

function truncateUserInput(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[AIPI user input pruned ${value.length - maxChars} chars]`;
}

async function readWorkflowDefinition(workflowAbsPath, workflowName) {
  const text = await fs.readFile(workflowAbsPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") throw new Error(`AIPI workflow not found: ${workflowName}`);
    throw error;
  });

  const name = text.match(/^name:\s*([a-z0-9_-]+)$/m)?.[1] ?? workflowName;
  const mode = text.match(/^mode:\s*([a-z0-9_-]+)$/m)?.[1] ?? null;
  const steps = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/^  - id:\s*([a-z0-9_-]+)$/);
    if (id) {
      current = { id: id[1], stage: null };
      steps.push(current);
      continue;
    }
    if (!current) continue;
    const stage = line.match(/^    stage:\s*([a-z0-9_-]+)$/);
    if (stage) current.stage = stage[1];
  }

  if (!steps.length) throw new Error(`AIPI workflow has no steps: ${workflowName}`);
  // Include the raw YAML text so validateRequiredWorkflowParams can scan for {{ key }} references.
  return { name, mode, steps, params: parseWorkflowParams(text), text };
}

// FIX 6: throw before creating the run directory when a required param is missing or empty.
// A param is "required" when its declared default is the empty string AND the YAML text contains
// at least one {{ key }} reference (meaning it is genuinely user-supplied, not a system binding).
function validateRequiredWorkflowParams(declaredParams, workflowText, suppliedParams, workflowName) {
  const supplied = suppliedParams && typeof suppliedParams === "object" ? suppliedParams : {};
  for (const [key, defaultValue] of Object.entries(declaredParams ?? {})) {
    if (defaultValue !== "") continue; // non-empty default → not required
    // System-bound params that the executor always resolves need no caller value.
    if (key === "run_id" || key === "contract_path") continue;
    // Only require the param if it is actually referenced in step prompts / names via {{ key }}.
    const templateRef = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`);
    if (!templateRef.test(String(workflowText ?? ""))) continue;
    const value = supplied[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new Error(
        `workflow ${workflowName} requires param "${key}" — start the run with a non-empty ${key} description`,
      );
    }
  }
}

// Parse a workflow's top-level `params:` block into { key: defaultValue }. Declared defaults (e.g.
// bug: "") seed the run's params so a caller-supplied value (the user's pasted task) overrides them,
// and any {{ key }} in step prompts that has no value renders empty instead of leaking the literal.
function parseWorkflowParams(text) {
  const params = {};
  let inParams = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^params:\s*$/.test(line)) {
      inParams = true;
      continue;
    }
    if (!inParams) continue;
    if (line.trim() === "") continue;
    const match = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      params[match[1]] = value;
      continue;
    }
    if (/^\S/.test(line)) break; // dedent to the next top-level key ends the params block
  }
  return params;
}

function generateRunId(now, randomBytes) {
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
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

## Steps

${state.steps.map((step) => `- ${step.id}: ${step.status}`).join("\n")}
`;
}
