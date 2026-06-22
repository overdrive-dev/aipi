import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  assertControllerWriteAllowed,
  createLocalWorkflowAdapter,
  createSubagentWorkflowAdapter,
  executeWorkflowRun,
  parseWorkflowDefinition,
  resolveWriteScope,
  writeControllerArtifact,
} from "../extensions/aipi/runtime/workflow-executor.js";
import { SubagentCoordinator } from "../extensions/aipi/runtime/subagents.js";
import {
  formatWorkflowCommandResult,
  recordWorkflowUserInput,
  runWorkflowCommand,
  startWorkflowRun,
} from "../extensions/aipi/runtime/run-state.js";
import { rebuildCodeGraph } from "../extensions/aipi/runtime/aipi-tools.js";

const PROGRESS_TERMINAL_VERBS = { passed: "passed", skipped: "skipped", blocked: "blocked" };

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-workflow-executor-"));
const sourceRoot = path.resolve("templates/.aipi");
const fixedDate = new Date("2026-06-16T12:34:56.789Z");
let randomCounter = 0;
const fixedRandom = () => Buffer.from((0xabc000 + randomCounter++).toString(16).padStart(6, "0"), "hex");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });
  await forceFastSemanticFallback(tempRoot);
  await rebuildCodeGraph({
    projectRoot: tempRoot,
    now: () => new Date("2026-06-20T16:05:00.000Z"),
    embeddingFetch: async () => {
      throw new Error("ollama disabled for deterministic workflow-executor test");
    },
  });

  const quickText = await fs.readFile(path.join(tempRoot, ".aipi", "workflows", "quick.yaml"), "utf8");
  const quick = parseWorkflowDefinition(quickText, "quick");
  assert.equal(quick.steps.length, 5);
  assert.deepEqual(quick.steps.map((step) => step.id), [
    "quick_scope",
    "quick_change",
    "quick_verify",
    "quick_review",
    "quick_memory",
  ]);

  const runResult = await runWorkflowCommand({ args: "run quick", projectRoot: tempRoot });
  assert.equal(runResult.action, "run");
  assert.equal(runResult.execution.status, "blocked");
  assert.match(formatWorkflowCommandResult(runResult), /AIPI workflow ran: quick/);
  assert.deepEqual(
    runResult.execution.state.steps.map((step) => step.status),
    ["blocked", "pending", "pending", "pending", "pending"],
  );

  const runDir = path.join(tempRoot, ".aipi", "runtime", "runs", runResult.run.runId);
  assert.equal(
    await pathExists(path.join(runDir, "steps", "quick_scope", "QUICK-SCOPE.md")),
    false,
  );
  assert.equal(
    await pathExists(path.join(runDir, "steps", "quick_verify", "RESULT.json")),
    false,
  );
  const state = JSON.parse(await fs.readFile(path.join(runDir, "state.json"), "utf8"));
  assert.equal(state.execution_mode, "local-quick-slice-v1");
  assert.equal(state.policy.controller_gate, "executor_declared_artifact_only");
  assert.equal(state.policy.controller_write_scope, "declared_step_artifacts_only");
  assert.equal(state.policy.parent_interactive_tool_call_hook, "registered_parent_interactive_tool_call_hook");
  assert.equal(Object.hasOwn(state.policy, "parent_session_tool_call"), false);
  assert.match(state.steps[0].error, /refusing to self-stamp PASS|step result did not pass gate|not allowed by pass_verdicts/);
  assert.equal(state.current_step, "quick_scope");
  assert.equal(state.consecutive_failures, 0);
  assert.notEqual(state.status, "escalated_to_human");
  assert.equal(state.awaiting_user_input.step_id, "quick_scope");
  assert.match(state.awaiting_user_input.question, /nenhum executor esta configurado|Como voce quer seguir/);
  assert.deepEqual(state.awaiting_user_input.options, [
    "Continuar fora do workflow automatico nesta conversa",
    "Tentar executar este workflow novamente",
    "Cancelar este run",
  ]);
  assert.equal(state.awaiting_user_input.allow_free_text, true);

  const activeExecution = await runWorkflowCommand({ args: "execute", projectRoot: tempRoot });
  assert.equal(activeExecution.action, "execute");
  assert.equal(activeExecution.execution.status, "blocked");
  assert.equal(activeExecution.execution.state.consecutive_failures, 0);
  assert.equal(activeExecution.execution.state.awaiting_user_input.step_id, "quick_scope");

  const restartStarted = await runWorkflowCommand({ args: "start quick", projectRoot: tempRoot });
  assert.equal(restartStarted.action, "start");
  const restartStatus = await runWorkflowCommand({ args: "status", projectRoot: tempRoot });
  assert.equal(restartStatus.active.runId, restartStarted.run.runId);
  assert.equal(restartStatus.active.state.status, "active");
  assert.equal(restartStatus.active.state.current_step, "quick_scope");
  const restartedAdapter = createTestPassWorkflowAdapter();
  const resumedAfterRestart = await runWorkflowCommand({
    args: "continue",
    projectRoot: tempRoot,
    adapter: restartedAdapter,
    parentInteractiveToolCallHook: "registered_parent_interactive_tool_call_hook",
  });
  assert.equal(resumedAfterRestart.action, "execute");
  assert.equal(resumedAfterRestart.execution.runId, restartStarted.run.runId);
  assert.equal(resumedAfterRestart.execution.status, "completed");
  const restartedManifest = await fs.readFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", restartStarted.run.runId, "RUN-MANIFEST.md"),
    "utf8",
  );
  assert.match(restartedManifest, /status: completed/);
  assert.match(formatWorkflowCommandResult(restartStatus), /AIPI workflow active:/);

  const featureRun = await runWorkflowCommand({
    args: "run feature",
    projectRoot: tempRoot,
    adapter: createTestPassWorkflowAdapter(),
  });
  assert.equal(featureRun.action, "run");
  assert.equal(featureRun.execution.status, "completed");
  assert.equal(featureRun.execution.state.execution_mode, "local-workflow-slice-v1");
  assert.deepEqual(
    featureRun.execution.state.steps.map((step) => step.status),
    [
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "skipped",
      "passed",
      "skipped",
      "skipped",
    ],
  );

  await fs.appendFile(
    path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"),
    "\n## Human Notes\n\nManual business-rule context must survive promotion.\n",
  );
  const featureMemoryAdapter = createMemoryPromotionWorkflowAdapter({
    memory_promotion: [
      {
        kind: "decision",
        title: "Feature memory decision",
        content: "Feature workflows promote accepted pricing decisions after final verification.",
        source_ref: "memory://feature/accepted-pricing",
      },
      {
        kind: "business-rule",
        title: "Feature memory business rule",
        content: "- **statement:** Feature workflows persist durable business rules after verification.",
        source_ref: "memory://feature/business-rule",
      },
    ],
  });
  const featureMemoryRun = await runWorkflowCommand({
    args: "run feature",
    projectRoot: tempRoot,
    adapter: featureMemoryAdapter,
  });
  assert.equal(featureMemoryRun.execution.status, "completed");
  assert.equal(
    featureMemoryRun.execution.state.steps.find((step) => step.id === "memory_promotion").status,
    "passed",
  );
  const decisionsText = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "decisions.md"), "utf8");
  assert.match(decisionsText, /memory_promoted: true/);
  assert.match(decisionsText, /Feature workflows promote accepted pricing decisions after final verification\./);
  assert.match(decisionsText, /## Timeline/);
  assert.match(decisionsText, /Promoted decision from memory:\/\/feature\/accepted-pricing via aipi_promote_memory/);
  assert.equal(
    decisionsText.indexOf("Feature workflows promote accepted pricing decisions after final verification.") <
      decisionsText.indexOf("## Timeline"),
    true,
  );
  const businessRulesText = await fs.readFile(
    path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"),
    "utf8",
  );
  assert.match(businessRulesText, /memory_promoted: true/);
  assert.match(businessRulesText, /Feature workflows persist durable business rules after verification\./);
  assert.match(businessRulesText, /Manual business-rule context must survive promotion\./);
  assert.match(businessRulesText, /Promoted business-rule from memory:\/\/feature\/business-rule via aipi_promote_memory/);

  const featureDecisionHash = decisionsText.match(/\*\*promotion-hash:\*\* (sha256:[a-f0-9]+)/)?.[1];
  assert.ok(featureDecisionHash);
  const featureDecisionHashCount = countOccurrences(decisionsText, featureDecisionHash);
  assert.equal(featureDecisionHashCount, 2);
  const featureMemoryRunAgain = await runWorkflowCommand({
    args: "run feature",
    projectRoot: tempRoot,
    adapter: featureMemoryAdapter,
  });
  assert.equal(featureMemoryRunAgain.execution.status, "completed");
  const secondPromotionRecord = JSON.parse(await fs.readFile(
    path.join(
      tempRoot,
      ".aipi",
      "runtime",
      "runs",
      featureMemoryRunAgain.run.runId,
      "steps",
      "memory_promotion",
      "MEMORY-PROMOTION-RESULT.json",
    ),
    "utf8",
  ));
  assert.equal(secondPromotionRecord.promoted, 2);
  assert.equal(secondPromotionRecord.changed, 0);
  const decisionsAfterRepeat = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "decisions.md"), "utf8");
  assert.equal(countOccurrences(decisionsAfterRepeat, featureDecisionHash), featureDecisionHashCount);

  const bugfixMemoryRun = await runWorkflowCommand({
    args: "run bugfix",
    projectRoot: tempRoot,
    adapter: createMemoryPromotionWorkflowAdapter({
      memory_promotion: [
        {
          kind: "knowledge",
          title: "Bugfix root-cause memory",
          content: "Bugfix workflows retain reusable root-cause lessons after adversarial review.",
          source_ref: "memory://bugfix/root-cause",
        },
      ],
    }),
  });
  assert.equal(bugfixMemoryRun.execution.status, "completed");
  assert.equal(
    bugfixMemoryRun.execution.state.steps.find((step) => step.id === "memory_promotion").status,
    "passed",
  );
  const knowledgeText = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "knowledge.md"), "utf8");
  assert.match(knowledgeText, /Bugfix workflows retain reusable root-cause lessons after adversarial review\./);
  assert.match(knowledgeText, /Promoted knowledge from memory:\/\/bugfix\/root-cause via aipi_promote_memory/);

  const emptyMemoryRun = await runWorkflowCommand({
    args: "run quick",
    projectRoot: tempRoot,
    adapter: createMemoryPromotionWorkflowAdapter({ quick_memory: [] }),
  });
  assert.equal(emptyMemoryRun.execution.status, "blocked");
  const emptyMemoryStep = emptyMemoryRun.execution.state.steps.find((step) => step.id === "quick_memory");
  assert.equal(emptyMemoryStep.status, "failed");
  assert.match(emptyMemoryStep.error, /PASS requires memory_promotions/);
  assert.equal(emptyMemoryRun.execution.state.awaiting_user_input.step_id, "quick_memory");
  assert.match(emptyMemoryRun.execution.state.awaiting_user_input.question, /quick_memory/);
  assert.equal(emptyMemoryRun.execution.state.awaiting_user_input.options.length, 3);
  const emptyMemoryRecord = JSON.parse(await fs.readFile(
    path.join(
      tempRoot,
      ".aipi",
      "runtime",
      "runs",
      emptyMemoryRun.run.runId,
      "steps",
      "quick_memory",
      "MEMORY-PROMOTION-RESULT.json",
    ),
    "utf8",
  ));
  assert.equal(emptyMemoryRecord.promoted, 0);
  assert.match(emptyMemoryRecord.errors.join("\n"), /memory_promotions/);

  const opsRunStarted = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "ops",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const opsRun = {
    action: "run",
    execution: await executeWorkflowRun({
      projectRoot: tempRoot,
      runId: opsRunStarted.runId,
      now: () => fixedDate,
      adapter: policyGateFallbackAdapter(),
    }),
  };
  assert.equal(opsRun.action, "run");
  assert.equal(opsRun.execution.status, "approval_required");
  assert.equal(opsRun.execution.state.steps.find((step) => step.id === "policy_gate").status, "approval_required");
  assert.equal(opsRun.execution.state.steps.find((step) => step.id === "human_review").status, "pending");
  assert.equal(
    opsRun.execution.state.policy_decisions.some(
      (decision) => decision.step_id === "policy_gate" && decision.decision === "HUMAN_REVIEW_REQUIRED",
    ),
    true,
  );
  assert.equal(
    opsRun.execution.state.policy_decisions.some(
      (decision) => decision.step_id === "policy_gate" && decision.decision === "ALLOW",
    ),
    false,
  );

  const blockerRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "planning",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  let blockedOnce = false;
  let resumedWithUserInput = false;
  const localAdapter = createTestPassWorkflowAdapter();
  const blockerAdapter = {
    async executeStep(args) {
      if (args.step.id === "business_rule_check" && !blockedOnce) {
        blockedOnce = true;
        return {
          schema: "aipi.step-result.v1",
          step_id: args.step.id,
          agent_ids: ["business-rule-keeper"],
          verdict: "BLOCKED_TO_PLANNING",
          evidence: [
            {
              rung: "blocked",
              source: "test",
              ref: "fixture blocker",
              result: "missing business rule answer",
            },
          ],
          blocker_question: {
            question: "Qual regra fiscal devemos aplicar?",
            options: ["Aprovar fiscal antes da emissao", "Emitir sem aprovacao", "Bloquear emissao"],
            allow_free_text: true,
          },
          artifacts: [],
        };
      }
      if (args.step.id === "business_rule_check") {
        resumedWithUserInput = args.context.user_inputs.refs.some((ref) =>
          ref.text.includes("Cliente enterprise exige aprovacao fiscal"),
        );
      }
      return localAdapter.executeStep(args);
    },
  };
  const blocked = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: blockerRun.runId,
    now: () => fixedDate,
    adapter: blockerAdapter,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.state.current_step, "business_rule_check");
  assert.equal(blocked.state.awaiting_user_input.step_id, "business_rule_check");
  assert.equal(blocked.state.awaiting_user_input.question, "Qual regra fiscal devemos aplicar?");
  assert.deepEqual(blocked.state.awaiting_user_input.options, [
    "Aprovar fiscal antes da emissao",
    "Emitir sem aprovacao",
    "Bloquear emissao",
  ]);
  assert.equal(blocked.state.awaiting_user_input.allow_free_text, true);

  const recordedAnswer = await recordWorkflowUserInput({
    projectRoot: tempRoot,
    runId: blockerRun.runId,
    text: "Cliente enterprise exige aprovacao fiscal antes da emissao.",
    source: "test",
    now: () => fixedDate,
  });
  assert.equal(recordedAnswer.record.step_id, "business_rule_check");
  const resumed = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: blockerRun.runId,
    now: () => fixedDate,
    adapter: blockerAdapter,
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumedWithUserInput, true);
  assert.equal(resumed.state.awaiting_user_input, null);
  const resumedContext = JSON.parse(await fs.readFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", blockerRun.runId, "steps", "business_rule_check", "CONTEXT.json"),
    "utf8",
  ));
  assert.equal(resumedContext.user_inputs.status, "available");
  assert.equal(resumedContext.provenance.some((item) => item.kind === "user_input"), true);

  const subagentRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const runnerCalls = [];
  const rawWrites = [];
  const coordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root: tempRoot,
      maxConcurrent: 1,
      piSubagentsRunner: fakeWorkflowRunner({ calls: runnerCalls, rawWrites, root: tempRoot }),
    },
  );
  const subagentExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: subagentRun.runId,
    now: () => fixedDate,
    adapter: createSubagentWorkflowAdapter(coordinator, {
      fallback: createTestPassWorkflowAdapter(),
      // Restrict to the single worker step under test; the other quick steps PASS via the fallback so
      // this case stays a focused proof of "a worker step dispatches to the coordinator with the
      // resolved model + writes its artifacts". The default (no workerStepIds) running ALL steps as
      // subagents is exercised separately in test-workflow-subagent-default.mjs.
      workerStepIds: ["quick_change"],
      pollIntervalMs: 1,
      collectTimeoutMs: 1_000,
      modelResolver: async () => ({
        model_class: "code-strong",
        model: { provider: "anthropic", id: "claude-test" },
        thinking_level: "medium",
        source: "test",
      }),
    }),
  });
  assert.equal(subagentExecution.status, "completed");
  assert.equal(runnerCalls.length, 1);
  assert.deepEqual(runnerCalls[0].params.model, { provider: "anthropic", id: "claude-test" });
  assert.equal(runnerCalls[0].params.thinking_level, "medium");
  assert.deepEqual(
    rawWrites.map((item) => item.path).sort(),
    [
      `.aipi/runtime/runs/${subagentRun.runId}/steps/quick_change/FIXES.md`,
      `.aipi/runtime/runs/${subagentRun.runId}/steps/quick_change/IMPLEMENTATION.md`,
    ],
  );
  assert.match(
    await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "runs", subagentRun.runId, "steps", "quick_change", "IMPLEMENTATION.md"), "utf8"),
    /fake S0 worker wrote quick_change/,
  );

  const redispatchRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const redispatchRunnerCalls = [];
  const redispatchRawWrites = [];
  const redispatchEntries = [];
  const redispatchArtifacts = [
    `.aipi/runtime/runs/${redispatchRun.runId}/steps/quick_change/IMPLEMENTATION.md`,
    `.aipi/runtime/runs/${redispatchRun.runId}/steps/quick_change/FIXES.md`,
  ];
  const redispatchCoordinator = new SubagentCoordinator(
    {
      appendEntry(name, value) {
        redispatchEntries.push({ name, value });
      },
    },
    {
      root: tempRoot,
      maxConcurrent: 1,
      piSubagentsRunner: fakeWorkflowRunner({ calls: redispatchRunnerCalls, rawWrites: redispatchRawWrites, root: tempRoot }),
    },
  );
  redispatchCoordinator.restore({
    jobs: [
      {
        agentId: "implementer:old",
        state: "running",
        descriptor: {
          agent_id: "implementer",
          step_id: "quick_change",
          owned_files: redispatchArtifacts,
        },
      },
    ],
    ownedFiles: [{ agentId: "implementer:old", files: redispatchArtifacts }],
  });
  const redispatchExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: redispatchRun.runId,
    now: () => fixedDate,
    adapter: createSubagentWorkflowAdapter(redispatchCoordinator, {
      // Restrict to the redispatched worker step under test; other quick steps PASS via the fallback.
      workerStepIds: ["quick_change"],
      fallback: createTestPassWorkflowAdapter(),
      pollIntervalMs: 1,
      collectTimeoutMs: 1_000,
      modelResolver: async () => ({
        model_class: "code-strong",
        model: { provider: "anthropic", id: "claude-test" },
        thinking_level: "medium",
        source: "test",
      }),
    }),
  });
  assert.equal(redispatchExecution.status, "completed");
  assert.equal(redispatchRunnerCalls.length, 1);
  assert.deepEqual(redispatchRawWrites.map((item) => item.path).sort(), redispatchArtifacts.sort());
  assert.equal(
    redispatchEntries.some((entry) => entry.name === "aipi.subagents.event" && entry.value.event === "redispatched"),
    true,
  );

  const fanoutRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const fanoutRunnerCalls = [];
  const fanoutRawWrites = [];
  const fanoutCoordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root: tempRoot,
      maxConcurrent: 2,
      piSubagentsRunner: fakeWorkflowRunner({ calls: fanoutRunnerCalls, rawWrites: fanoutRawWrites, root: tempRoot }),
    },
  );
  const fanoutExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: fanoutRun.runId,
    now: () => fixedDate,
    adapter: createSubagentWorkflowAdapter(fanoutCoordinator, {
      fallback: createTestPassWorkflowAdapter(),
      pollIntervalMs: 1,
      collectTimeoutMs: 1_000,
      workerStepIds: [],
      fanoutStepIds: ["review_swarm"],
      modelResolver: async ({ step }) => ({
        model_class: step.agents[0] === "complexity-reviewer" ? "context-fast" : "adversarial-heavy",
        model: { provider: "anthropic", id: `claude-${step.agents[0]}` },
        thinking_level: "medium",
        source: "test",
      }),
    }),
  });
  assert.equal(fanoutExecution.status, "completed");
  assert.equal(fanoutRunnerCalls.length, 5);
  assert.equal(
    fanoutRawWrites.some((item) => item.path.endsWith("/steps/review_swarm/CODE-REVIEW.md")),
    true,
  );
  assert.equal(
    fanoutRawWrites.some((item) => item.path.endsWith("/steps/review_swarm/SECURITY.md")),
    true,
  );

  // REGRESSION (real-path): with the DEFAULT adapter (no workerStepIds allow-list), EVERY
  // agent-bearing step of a real multi-step workflow must execute as a subagent and the run must
  // COMPLETE. Previously only `quick_change`/`review_swarm` were allow-listed, so steps like
  // quick_scope/quick_verify/quick_review/quick_memory fell through to the local fallback and stamped
  // BLOCKED "no executable adapter is configured" — trapping the user in an unrunnable workflow loop.
  const defaultRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const defaultRunnerCalls = [];
  const defaultRawWrites = [];
  const defaultCoordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root: tempRoot,
      maxConcurrent: 2,
      // Like fakeWorkflowRunner but quick_memory returns the realistic no-signal SKIPPED (its
      // memory-promotion gate rejects a bare PASS that has no memory_promotions). This exercises BOTH
      // fixes end-to-end: every step runs as a subagent (adapter) AND a worker SKIPPED is not collapsed
      // into a spurious BLOCKED by the coordinator (verdict-gate-without-step fix).
      piSubagentsRunner: quickWorkflowRunner({ calls: defaultRunnerCalls, rawWrites: defaultRawWrites, root: tempRoot }),
    },
  );
  const defaultExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: defaultRun.runId,
    now: () => fixedDate,
    // NO workerStepIds / fanoutStepIds override -> production default: all agent-bearing steps run.
    adapter: createSubagentWorkflowAdapter(defaultCoordinator, {
      pollIntervalMs: 1,
      collectTimeoutMs: 1_000,
      modelResolver: async () => ({
        model_class: "code-strong",
        model: { provider: "anthropic", id: "claude-test" },
        thinking_level: "medium",
        source: "test",
      }),
    }),
  });
  // The whole multi-step workflow COMPLETES end-to-end. Before the fix it could never get past the
  // first step (triage/quick_scope) because the local fallback stamped BLOCKED "no executable adapter".
  assert.equal(defaultExecution.status, "completed");
  // Six worker dispatches: the four single-lead steps (quick_scope/quick_change/quick_verify/quick_memory)
  // each dispatch one, and the REVIEW-stage `quick_review` (2 agents) FANS OUT to two — proving the
  // default policy runs declared review agents instead of only the lead (CR-60-2).
  assert.equal(defaultRunnerCalls.length, 6);
  const defaultStepStatus = new Map(defaultExecution.state.steps.map((s) => [s.id, s]));
  for (const stepId of ["quick_scope", "quick_change", "quick_verify", "quick_review"]) {
    assert.equal(defaultStepStatus.get(stepId)?.status, "passed", `step ${stepId} must run + pass as a real subagent`);
  }
  // quick_review fanned out: BOTH declared review artifacts were produced by separate review agents.
  const quickReviewWrites = defaultRawWrites.map((item) => item.path).filter((p) => p.includes("/steps/quick_review/"));
  assert.equal(quickReviewWrites.some((p) => p.endsWith("/CODE-REVIEW.md")), true);
  assert.equal(quickReviewWrites.some((p) => p.endsWith("/COMPLEXITY-REVIEW.md")), true);
  // The worker SKIPPED survived the coordinator and the executor gate (not downgraded to BLOCKED).
  assert.equal(defaultStepStatus.get("quick_memory")?.status, "skipped");
  assert.equal(defaultStepStatus.get("quick_memory")?.verdict, "SKIPPED");
  // No executed step may carry the local-executor "no executable adapter" / self-stamp-refusal evidence.
  for (const stepId of ["quick_scope", "quick_change", "quick_verify", "quick_review", "quick_memory"]) {
    const resultPath = path.join(tempRoot, ".aipi", "runtime", "runs", defaultRun.runId, "steps", stepId, "RESULT.json");
    const resultText = await fs.readFile(resultPath, "utf8").catch(() => "{}");
    assert.doesNotMatch(resultText, /no executable adapter|refusing to self-stamp|aipi-local-executor/);
  }

  // CR-60-2 (real-path): the bugfix `review` step (id: review, stage: review, 4 specialized agents)
  // must FAN OUT under the DEFAULT adapter — even though it is NOT named `review_swarm` — so every
  // declared reviewer runs and produces its artifact, not just the lead code-reviewer.
  const bugfixReviewRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "bugfix",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const bugfixWorkflow = parseWorkflowDefinition(
    await fs.readFile(path.join(tempRoot, ".aipi", "workflows", "bugfix.yaml"), "utf8"),
    "bugfix",
  );
  const bugfixReviewStep = bugfixWorkflow.steps.find((step) => step.id === "review");
  assert.equal(bugfixReviewStep.stage, "review");
  assert.equal(bugfixReviewStep.agents.length, 4);
  const reviewFanoutCalls = [];
  const reviewFanoutWrites = [];
  const reviewFanoutCoordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root: tempRoot,
      maxConcurrent: 4,
      piSubagentsRunner: fakeWorkflowRunner({ calls: reviewFanoutCalls, rawWrites: reviewFanoutWrites, root: tempRoot }),
    },
  );
  const reviewFanoutAdapter = createSubagentWorkflowAdapter(reviewFanoutCoordinator, {
    pollIntervalMs: 1,
    collectTimeoutMs: 1_000,
    modelResolver: async ({ step }) => ({
      model_class: "adversarial-heavy",
      model: { provider: "anthropic", id: `claude-${step.agents[0]}` },
      thinking_level: "medium",
      source: "test",
    }),
  });
  const bugfixReviewResult = await reviewFanoutAdapter.executeStep({
    root: tempRoot,
    state: bugfixReviewRun.state,
    workflow: bugfixWorkflow,
    step: bugfixReviewStep,
    context: {},
    contract: {},
  });
  assert.equal(bugfixReviewResult.verdict, "PASS");
  // All four review agents were spawned (not just the lead), and all four review artifacts produced.
  assert.equal(reviewFanoutCalls.length, 4);
  const reviewArtifactNames = reviewFanoutWrites.map((item) => item.path);
  for (const name of ["CODE-REVIEW.md", "COMPLEXITY-REVIEW.md", "BLAST-RADIUS.md", "SECURITY.md"]) {
    assert.equal(
      reviewArtifactNames.some((p) => p.endsWith(`/steps/review/${name}`)),
      true,
      `bugfix review fan-out must produce ${name}`,
    );
  }

  // bug-param (real-path): a task passed via params.bug must be RENDERED into the worker's prompt so
  // triage has a real defect to triage — the literal "{{ bug }}" placeholder must be gone. Previously
  // params were never plumbed/rendered, so triage blocked on the unrendered "{{ bug }}".
  const bugText = "login button throws TypeError on null user when session expired";
  const bugParamRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "bugfix",
    params: { bug: bugText },
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  assert.equal(bugParamRun.state.params.bug, bugText, "startWorkflowRun must persist caller params.bug");
  const bugParamWorkflow = parseWorkflowDefinition(
    await fs.readFile(path.join(tempRoot, ".aipi", "workflows", "bugfix.yaml"), "utf8"),
    "bugfix",
  );
  const triageStep = bugParamWorkflow.steps.find((step) => step.id === "triage");
  assert.match(triageStep.prompt, /\{\{\s*bug\s*\}\}/, "raw triage prompt should contain the {{ bug }} placeholder");
  const bugParamCalls = [];
  const bugParamCoordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root: tempRoot,
      maxConcurrent: 2,
      piSubagentsRunner: fakeWorkflowRunner({ calls: bugParamCalls, rawWrites: [], root: tempRoot }),
    },
  );
  const bugParamAdapter = createSubagentWorkflowAdapter(bugParamCoordinator, {
    pollIntervalMs: 1,
    collectTimeoutMs: 1_000,
    modelResolver: async () => ({
      model_class: "code-strong",
      model: { provider: "anthropic", id: "claude-test" },
      thinking_level: "medium",
      source: "test",
    }),
  });
  await bugParamAdapter.executeStep({
    root: tempRoot,
    state: bugParamRun.state,
    workflow: bugParamWorkflow,
    step: triageStep,
    context: {},
    contract: {},
  });
  const workerTask = bugParamCalls[0]?.params?.task ?? "";
  assert.doesNotMatch(workerTask, /\{\{\s*bug\s*\}\}/, "rendered worker prompt must not contain the literal {{ bug }}");
  assert.ok(workerTask.includes(bugText), "rendered worker prompt must contain the user's task text");

  // Live worker telemetry (ADV-63 + the real-path fix): a forked worker logs its REAL session jsonl using
  // `{type:"message", message:{content:[{type:"thinking",thinking}, {type:"toolCall",name,arguments}]}}`
  // events. The executor must (a) STREAM each new thinking note + file/graph op into the scrollback as it
  // happens, and (b) fold a one-line summary into the spinner — with the tool count derived from the jsonl,
  // NOT from coordinator.status() (host tool_call hooks observe zero forked-worker calls).
  const teleAgentId = "orchestration-reasoner:tele01";
  const teleSessionDir = path.join(tempRoot, ".aipi", "runtime", "subagents", "sessions", teleAgentId.replaceAll(":", "-"));
  await fs.mkdir(teleSessionDir, { recursive: true });
  const msg = (content) => `${JSON.stringify({ type: "message", message: { role: "assistant", content } })}\n`;
  await fs.writeFile(
    path.join(teleSessionDir, "2026-06-22T19-00-00-000Z_sess.jsonl"),
    msg([{ type: "thinking", thinking: "I need to locate the AdminSidebar component and how it routes gestores.\nSecond line." }]) +
      msg([{ type: "toolCall", id: "t1", name: "ls", arguments: { path: "frontend/app/(app)/(admin)" } }]) +
      msg([{ type: "toolCall", id: "t2", name: "read", arguments: { path: "frontend/src/components/admin/AdminSidebar.tsx" } }]) +
      msg([{ type: "toolCall", id: "t3", name: "aipi_retrieve", arguments: { query: "gestores tipo coordenador" } }]),
  );
  let telePolls = 0;
  const teleCoordinator = {
    spawn: () => ({ agent_id: teleAgentId }),
    // Deliberately misleading host count: the fix must IGNORE this and count the jsonl's 3 toolCalls.
    status: () => ({ tool_call_count: 99, elapsed_ms: 4000 }),
    collect: () => {
      telePolls += 1;
      if (telePolls < 3) return { agent_id: teleAgentId, ready: false, state: "running" };
      return {
        agent_id: teleAgentId,
        ready: true,
        step_result: { schema: "aipi.step-result.v1", step_id: "triage", agent_ids: [teleAgentId], verdict: "PASS", evidence: [{ rung: "ran", source: "w", ref: teleAgentId, result: "ok" }], artifacts: [] },
        artifacts: [],
      };
    },
  };
  const teleStream = [];
  const teleActivity = [];
  const teleSink = (message) => teleStream.push(message);
  teleSink.updateActivity = (text) => teleActivity.push(text);
  const teleAdapter = createSubagentWorkflowAdapter(teleCoordinator, {
    pollIntervalMs: 1,
    collectTimeoutMs: 2_000,
    modelResolver: async () => ({ model_class: "code-strong", model: { provider: "anthropic", id: "x" }, thinking_level: "medium", source: "t" }),
  });
  await teleAdapter.executeStep({ root: tempRoot, state: bugParamRun.state, workflow: bugParamWorkflow, step: triageStep, context: {}, contract: {}, notify: teleSink });
  // (a) Each thinking note + file/graph op is streamed into the scrollback (this is what the user wanted to SEE).
  assert.ok(
    teleStream.some((line) => /💭/.test(line) && /locate the AdminSidebar/.test(line)),
    `worker thinking must stream to the terminal; got: ${JSON.stringify(teleStream)}`,
  );
  assert.ok(
    teleStream.some((line) => /read AdminSidebar\.tsx/.test(line)),
    `file reads must stream to the terminal; got: ${JSON.stringify(teleStream)}`,
  );
  assert.ok(
    teleStream.some((line) => /retrieve "gestores tipo coordenador"/.test(line)),
    `graph/retrieval ops must stream to the terminal; got: ${JSON.stringify(teleStream)}`,
  );
  // A multi-line thinking block is summarized to its first line only (no scrollback flooding).
  assert.ok(!teleStream.some((line) => /Second line/.test(line)), "thinking is summarized to one line");
  // (b) The spinner summary shows the jsonl-derived tool count (3), NOT the misleading host count (99).
  assert.ok(
    teleActivity.some((a) => /\b3 tools\b/.test(a) && /retrieve/.test(a)),
    `spinner summary must show jsonl tool count + latest action; got: ${JSON.stringify(teleActivity)}`,
  );
  assert.ok(!teleActivity.some((a) => /99 tools/.test(a)), "host tool_call_count must be ignored for forked workers");

  // collect-timeout (real-path mechanism): a real agentic worker takes minutes; the 120s spike default
  // timed it out mid-step (BLOCKED "did not finish: timeout") even though it would succeed. Prove the
  // collect timeout governs this: a worker that becomes ready AFTER a short timeout times out, but with
  // a generous timeout (production now uses 20min) the same worker's PASS result is collected.
  const timeoutRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "bugfix",
    params: { bug: "slow worker repro" },
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const timeoutWorkflow = parseWorkflowDefinition(
    await fs.readFile(path.join(tempRoot, ".aipi", "workflows", "bugfix.yaml"), "utf8"),
    "bugfix",
  );
  const timeoutTriageStep = timeoutWorkflow.steps.find((step) => step.id === "triage");
  const makeSlowCoordinator = (readyAfterMs) => {
    let readyAt = null;
    return {
      spawn(descriptor) {
        readyAt = Date.now() + readyAfterMs;
        return { agent_id: descriptor.agent_id };
      },
      collect(agentId) {
        if (readyAt !== null && Date.now() >= readyAt) {
          return {
            agent_id: agentId,
            ready: true,
            step_result: {
              schema: "aipi.step-result.v1",
              step_id: "triage",
              agent_ids: [agentId],
              verdict: "PASS",
              evidence: [{ rung: "ran", source: "slow-worker", ref: agentId, result: "finished after delay" }],
              artifacts: [],
            },
            artifacts: [],
          };
        }
        return { agent_id: agentId, ready: false, state: "running" };
      },
    };
  };
  const runTriageWith = (coordinator, collectTimeoutMs) =>
    createSubagentWorkflowAdapter(coordinator, {
      pollIntervalMs: 5,
      collectTimeoutMs,
      modelResolver: async () => ({ model_class: "code-strong", model: { provider: "anthropic", id: "x" }, thinking_level: "medium", source: "t" }),
    }).executeStep({ root: tempRoot, state: timeoutRun.state, workflow: timeoutWorkflow, step: timeoutTriageStep, context: {}, contract: {} });
  // Too-short timeout: the worker (ready after ~250ms) is abandoned -> BLOCKED "did not finish: timeout"
  // (this is exactly the production bug with the 120s default vs a multi-minute real worker).
  const tooShort = await runTriageWith(makeSlowCoordinator(250), 60);
  assert.equal(tooShort.verdict, "BLOCKED");
  assert.match(JSON.stringify(tooShort.evidence), /did not finish: timeout/);
  // Generous timeout: the same slow worker's PASS result is collected and the step succeeds.
  const generous = await runTriageWith(makeSlowCoordinator(250), 10_000);
  assert.equal(generous.verdict, "PASS");

  // Write scope (real-path): the bugfix `fix` step (stage: implementation) must dispatch a worker
  // with a PROJECT write scope so the worker can apply its fix to actual source files, not just its
  // run-dir artifacts. Analysis/requirements steps stay artifact-scoped.
  assert.equal(resolveWriteScope({ stage: "implementation" }), "project");
  assert.equal(resolveWriteScope({ stage: "fix" }), "project");
  assert.equal(resolveWriteScope({ stage: "tdd" }), "project");
  assert.equal(resolveWriteScope({ stage: "requirements" }), "artifacts");
  assert.equal(resolveWriteScope({ stage: "review" }), "artifacts");
  assert.equal(resolveWriteScope({ stage: "implementation", write_scope: "artifacts" }), "artifacts");
  assert.equal(resolveWriteScope({ stage: "requirements", write_scope: "project" }), "project");

  // ADV-62-4: an explicit `write_scope:` in the workflow YAML must be PARSED onto the step (not ignored),
  // so the advertised override actually works on the real parse path.
  const scopeYaml = parseWorkflowDefinition(
    [
      "name: scopecheck",
      "steps:",
      "  - id: fix",
      "    stage: implementation",
      "    write_scope: artifacts",
      "    agents: [worker]",
      "    produces: []",
      "  - id: note",
      "    stage: requirements",
      "    write_scope: project",
      "    agents: [worker]",
      "    produces: []",
    ].join("\n"),
    "scopecheck",
  );
  assert.equal(scopeYaml.steps[0].write_scope, "artifacts", "YAML write_scope must be parsed onto the step");
  assert.equal(resolveWriteScope(scopeYaml.steps[0]), "artifacts", "implementation step forced to artifacts via YAML");
  assert.equal(resolveWriteScope(scopeYaml.steps[1]), "project", "requirements step opted into project via YAML");
  assert.throws(
    () => parseWorkflowDefinition("name: bad\nsteps:\n  - id: x\n    stage: implementation\n    write_scope: nonsense\n    agents: [w]\n    produces: []\n", "bad"),
    /write_scope must be/,
    "invalid write_scope value is rejected",
  );
  // The parsed override reaches the dispatched descriptor: the artifacts-forced fix step dispatches artifacts.
  const scopeRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "bugfix",
    params: { bug: "scope override repro" },
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const scopeDescriptors = [];
  const scopeCoordinator = {
    spawn(descriptor) {
      scopeDescriptors.push(descriptor);
      return { agent_id: descriptor.agent_id };
    },
    collect: (agentId) => ({
      agent_id: agentId,
      ready: true,
      step_result: { schema: "aipi.step-result.v1", step_id: "fix", agent_ids: [agentId], verdict: "PASS", evidence: [{ rung: "ran", source: "s", ref: agentId, result: "ok" }], artifacts: [] },
      artifacts: [],
    }),
  };
  const scopeAdapter = createSubagentWorkflowAdapter(scopeCoordinator, {
    pollIntervalMs: 1,
    collectTimeoutMs: 2_000,
    modelResolver: async () => ({ model_class: "code-strong", model: { provider: "anthropic", id: "x" }, thinking_level: "medium", source: "t" }),
  });
  await scopeAdapter.executeStep({ root: tempRoot, state: scopeRun.state, workflow: scopeYaml, step: scopeYaml.steps[0], context: {}, contract: {} });
  assert.equal(scopeDescriptors.at(-1)?.write_scope, "artifacts", "YAML write_scope: artifacts must reach the dispatched descriptor");

  const capturedDescriptors = [];
  const captureCoordinator = {
    spawn(descriptor) {
      capturedDescriptors.push(descriptor);
      return { agent_id: descriptor.agent_id };
    },
    collect(agentId) {
      return {
        agent_id: agentId,
        ready: true,
        step_result: {
          schema: "aipi.step-result.v1",
          step_id: capturedDescriptors.at(-1)?.step_id ?? "step",
          agent_ids: [agentId],
          verdict: "PASS",
          evidence: [{ rung: "ran", source: "capture", ref: agentId, result: "ok" }],
          artifacts: [],
        },
        artifacts: [],
      };
    },
  };
  const captureAdapter = createSubagentWorkflowAdapter(captureCoordinator, {
    pollIntervalMs: 1,
    collectTimeoutMs: 2_000,
    modelResolver: async () => ({ model_class: "code-strong", model: { provider: "anthropic", id: "x" }, thinking_level: "medium", source: "t" }),
  });
  const fixStep = timeoutWorkflow.steps.find((step) => step.id === "fix");
  await captureAdapter.executeStep({ root: tempRoot, state: timeoutRun.state, workflow: timeoutWorkflow, step: fixStep, context: {}, contract: {} });
  assert.equal(
    capturedDescriptors.at(-1)?.write_scope,
    "project",
    "bugfix fix step (stage: implementation) must dispatch a worker with project write scope",
  );
  await captureAdapter.executeStep({ root: tempRoot, state: timeoutRun.state, workflow: timeoutWorkflow, step: timeoutTriageStep, context: {}, contract: {} });
  assert.equal(
    capturedDescriptors.at(-1)?.write_scope,
    "artifacts",
    "analysis/requirements steps stay artifact-scoped",
  );

  const contradictoryReviewRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const contradictoryReviewExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: contradictoryReviewRun.runId,
    now: () => fixedDate,
    adapter: createContradictoryReviewPassAdapter(),
  });
  assert.equal(contradictoryReviewExecution.status, "blocked");
  const contradictoryReviewStep = contradictoryReviewExecution.state.steps.find((step) => step.id === "quick_review");
  assert.equal(contradictoryReviewStep.status, "failed");
  assert.match(contradictoryReviewStep.error, /PASS contradicts unresolved CRITICAL finding/);
  assert.equal(contradictoryReviewExecution.state.current_step, "quick_review");

  await patchTransientProviderRetry(tempRoot, {
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterMs: 0,
  });
  const transientSuccessRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const transientSuccessAdapter = transientProviderAdapter({ failuresBeforeSuccess: 2 });
  const transientSuccess = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: transientSuccessRun.runId,
    now: () => fixedDate,
    adapter: transientSuccessAdapter,
  });
  assert.equal(transientSuccess.status, "completed");
  assert.equal(transientSuccess.state.consecutive_failures, 0);
  assert.equal(transientSuccessAdapter.attempts.quick_scope, 3);
  const transientSuccessResult = JSON.parse(await fs.readFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", transientSuccessRun.runId, "steps", "quick_scope", "RESULT.json"),
    "utf8",
  ));
  assert.equal(transientSuccessResult.result.transient_provider_retries.recovered, true);
  assert.equal(transientSuccessResult.result.transient_provider_retries.attempts, 3);

  const transientBlockedRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const transientBlockedAdapter = transientProviderAdapter({ alwaysFail: true });
  const transientBlocked = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: transientBlockedRun.runId,
    now: () => fixedDate,
    adapter: transientBlockedAdapter,
  });
  assert.equal(transientBlocked.status, "blocked");
  assert.equal(transientBlocked.state.current_step, "quick_scope");
  assert.equal(transientBlocked.state.steps.find((step) => step.id === "quick_scope").status, "blocked");
  assert.match(transientBlocked.state.blocked_reason, /transient provider failure after 3 attempts/);
  assert.match(transientBlocked.state.awaiting_user_input.question, /erro transitorio do provider/);
  assert.equal(transientBlocked.state.consecutive_failures, 0);
  assert.equal(transientBlockedAdapter.attempts.quick_scope, 3);

  // WORKER-PATH transient retry (ADV-62-2): the subagent adapter's worker return-path now routes a
  // transient provider failure (an Anthropic overloaded_error/529 surfaced by the worker's own LLM
  // calls) through the transient-retry/backoff loop — previously only inline THROWING adapters retried,
  // and a worker failure hard-blocked the run with a generic "did not finish: failed".
  const overloadEnvelope = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_x"}';
  const flakyWorkerRunner = ({ failFirst = 0, alwaysFail = false, error = overloadEnvelope } = {}) => {
    const calls = [];
    const base = fakeWorkflowRunner({ calls: [], rawWrites: [], root: tempRoot });
    let spawns = 0;
    return {
      spawnCount: () => spawns,
      calls,
      async spawn(params) {
        spawns += 1;
        calls.push(params);
        if (alwaysFail || spawns <= failFirst) throw new Error(error);
        return base.spawn(params);
      },
    };
  };
  const workerAdapterFor = (coordinator) =>
    createSubagentWorkflowAdapter(coordinator, {
      pollIntervalMs: 1,
      collectTimeoutMs: 2_000,
      modelResolver: async () => ({ model_class: "code-strong", model: { provider: "anthropic", id: "x" }, thinking_level: "medium", source: "t" }),
    });
  const coordinatorWith = (runner) =>
    new SubagentCoordinator({ appendEntry() {} }, { root: tempRoot, maxConcurrent: 1, piSubagentsRunner: runner });

  // (a) recovers: the first 2 worker spawns 529, the 3rd succeeds -> quick_scope PASSes via the retry loop.
  const wRetryRun = await startWorkflowRun({ projectRoot: tempRoot, workflow: "quick", now: () => fixedDate, randomBytes: fixedRandom });
  const recoverRunner = flakyWorkerRunner({ failFirst: 2 });
  await executeWorkflowRun({ projectRoot: tempRoot, runId: wRetryRun.runId, now: () => fixedDate, adapter: workerAdapterFor(coordinatorWith(recoverRunner)) });
  const wScope = JSON.parse(await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "runs", wRetryRun.runId, "steps", "quick_scope", "RESULT.json"), "utf8"));
  assert.equal(wScope.result.transient_provider_retries?.recovered, true, "worker transient failure recovers via retry");
  assert.equal(wScope.result.transient_provider_retries?.attempts, 3);

  // (b) always-529: blocks as a TRANSIENT-provider failure (with the retry question), not a generic block.
  const wBlockRun = await startWorkflowRun({ projectRoot: tempRoot, workflow: "quick", now: () => fixedDate, randomBytes: fixedRandom });
  const wBlocked = await executeWorkflowRun({ projectRoot: tempRoot, runId: wBlockRun.runId, now: () => fixedDate, adapter: workerAdapterFor(coordinatorWith(flakyWorkerRunner({ alwaysFail: true }))) });
  assert.equal(wBlocked.status, "blocked");
  assert.match(wBlocked.state.blocked_reason, /transient provider failure after 3 attempts/);
  assert.equal(wBlocked.state.consecutive_failures, 0);

  // (c) a NON-transient worker failure (bad config) is NOT retried — plain block, spawned once.
  const wConfigRun = await startWorkflowRun({ projectRoot: tempRoot, workflow: "quick", now: () => fixedDate, randomBytes: fixedRandom });
  const configRunner = flakyWorkerRunner({ alwaysFail: true, error: "unknown model class for worker" });
  const wConfig = await executeWorkflowRun({ projectRoot: tempRoot, runId: wConfigRun.runId, now: () => fixedDate, adapter: workerAdapterFor(coordinatorWith(configRunner)) });
  assert.equal(wConfig.status, "blocked");
  assert.doesNotMatch(wConfig.state.blocked_reason ?? "", /transient provider failure/);
  assert.equal(configRunner.spawnCount(), 1, "a non-transient worker failure must not be retried");

  const cascadeRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const cascadeStatePath = path.join(tempRoot, ".aipi", "runtime", "runs", cascadeRun.runId, "state.json");
  const cascadeState = JSON.parse(await fs.readFile(cascadeStatePath, "utf8"));
  cascadeState.current_step = "quick_change";
  cascadeState.steps.find((step) => step.id === "quick_scope").status = "blocked";
  cascadeState.steps.find((step) => step.id === "quick_scope").verdict = "BLOCKED";
  cascadeState.steps.find((step) => step.id === "quick_scope").error = "root provider overload at quick_scope";
  await fs.writeFile(cascadeStatePath, `${JSON.stringify(cascadeState, null, 2)}\n`);
  const cascadeBlocked = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: cascadeRun.runId,
    now: () => fixedDate,
    adapter: createTestPassWorkflowAdapter(),
  });
  assert.equal(cascadeBlocked.status, "blocked");
  assert.equal(cascadeBlocked.state.current_step, "quick_scope");
  assert.equal(cascadeBlocked.state.blocked_reason, "root provider overload at quick_scope");
  assert.equal(cascadeBlocked.state.steps.find((step) => step.id === "quick_change").status, "pending");
  assert.equal(/required step quick_scope has not passed/.test(cascadeBlocked.state.blocked_reason), false);

  const started = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const failing = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: started.runId,
    now: () => fixedDate,
    adapter: {
      async executeStep({ step }) {
        return {
          schema: "aipi.step-result.v1",
          step_id: step.id,
          agent_ids: ["missing-artifact-adapter"],
          verdict: "PASS",
          evidence: [
            {
              rung: "ran",
              source: "test",
              ref: "missing artifact adapter",
              result: "returned PASS without writing required artifacts",
            },
          ],
          artifacts: [],
        };
      },
    },
  });
  assert.equal(failing.status, "escalated_to_planning");
  assert.equal(failing.state.steps[0].status, "failed");
  assert.match(failing.state.steps[0].error, /missing required artifacts/);

  const consecutiveFailureRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const consecutiveFailure = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: consecutiveFailureRun.runId,
    now: () => fixedDate,
    adapter: quickChangeLoopFailureAdapter(),
  });
  assert.equal(consecutiveFailure.status, "escalated_to_human");
  assert.equal(consecutiveFailure.state.step_visits.quick_change, 3);
  assert.equal(consecutiveFailure.state.consecutive_failures, 3);
  assert.match(consecutiveFailure.state.blocked_reason, /maxConsecutiveFailures exhausted/);

  await patchRunLimits(tempRoot, {
    maxTotalStepVisits: 40,
    maxVisitsPerStep: 2,
    maxConsecutiveFailures: 99,
    onExhaustion: "escalate_to_human",
  });
  const perStepLimitRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const perStepLimit = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: perStepLimitRun.runId,
    now: () => fixedDate,
    adapter: quickChangeLoopFailureAdapter(),
  });
  assert.equal(perStepLimit.status, "escalated_to_human");
  assert.equal(perStepLimit.state.step_visits.quick_change, 2);
  assert.match(perStepLimit.state.blocked_reason, /maxVisitsPerStep exhausted for quick_change/);

  // ADV-58-3: a running workflow surfaces per-step progress to the terminal.
  const progressRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const progressNotifications = [];
  const progressExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: progressRun.runId,
    now: () => fixedDate,
    adapter: createTestPassWorkflowAdapter(),
    notify: (message, kind) => progressNotifications.push({ message, kind }),
  });
  assert.equal(progressExecution.status, "completed");
  const executedStepTransitions = progressExecution.events.filter((event) =>
    ["passed", "skipped", "blocked"].includes(event.type),
  );
  assert.ok(executedStepTransitions.length >= 1, "executor produced at least one step transition");
  // Every executed step must have a "running…" start notification and a terminal-phase line.
  for (const event of executedStepTransitions) {
    const n = progressExecution.state.steps.findIndex((step) => step.id === event.step_id) + 1;
    assert.ok(
      progressNotifications.some((note) =>
        note.message.includes(`feature: ${event.step_id} (${n}/`) && note.message.includes("running…"),
      ),
      `progress notified running… for ${event.step_id}`,
    );
    assert.ok(
      progressNotifications.some((note) =>
        note.message.includes(`feature: ${event.step_id} (`) &&
        new RegExp(`\\b(${PROGRESS_TERMINAL_VERBS[event.type]})$`).test(note.message),
      ),
      `progress notified ${event.type} for ${event.step_id}`,
    );
  }
  // At least one user-visible progress notification per executed step transition.
  assert.ok(
    progressNotifications.length >= executedStepTransitions.length,
    "at least one progress notification per executed step transition",
  );
  assert.ok(
    progressNotifications.every((note) => note.kind === "info"),
    "progress notifications are info-level and non-blocking",
  );

  // Live planner checklist: a CALLABLE progress sink (function + setPlan/setStatus/spinner methods,
  // like makeProgressNotifier returns) receives a per-step status checklist that updates as the run
  // advances — so the terminal shows a step-by-step planner, not one frozen "running…" line.
  const planRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const sinkCalls = { notify: [], plan: [], status: [], spinner: [], clear: 0 };
  const progressSink = (message, kind) => sinkCalls.notify.push({ message, kind });
  progressSink.setPlan = (lines) => sinkCalls.plan.push(lines);
  progressSink.setStatus = (text) => sinkCalls.status.push(text);
  progressSink.startSpinner = (label) => sinkCalls.spinner.push({ start: label });
  progressSink.stopSpinner = () => sinkCalls.spinner.push({ stop: true });
  progressSink.clear = () => {
    sinkCalls.clear += 1;
  };
  const planExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: planRun.runId,
    now: () => fixedDate,
    adapter: createTestPassWorkflowAdapter(),
    notify: progressSink,
  });
  assert.equal(planExecution.status, "completed");
  // Back-compat: the legacy notify lines are still emitted through the same callable sink.
  assert.ok(sinkCalls.notify.some((note) => note.message.includes("running…")), "sink still gets legacy notify lines");
  // The planner was rendered: at least one plan snapshot with one line per workflow step.
  assert.ok(sinkCalls.plan.length >= 1, "progress sink received planner snapshots");
  const fullPlan = sinkCalls.plan.find((lines) => lines.length === planExecution.state.steps.length);
  assert.ok(fullPlan, "a planner snapshot has one line per workflow step");
  // The final planner snapshot shows every step done (no lingering running/pending glyph) — and the
  // run-end clear() (mirroring the real sink) removes the live widget so it does not linger.
  const lastPlan = sinkCalls.plan.at(-1);
  assert.equal(lastPlan.length, planExecution.state.steps.length);
  assert.ok(lastPlan.every((line) => /^[✓⊘]/.test(line)), "final plan marks every step passed/skipped");
  assert.equal(sinkCalls.clear, 1, "the live progress surfaces are cleared once when the run ends");
  // The spinner was started (for the in-step gap) and stopped.
  assert.ok(sinkCalls.spinner.some((entry) => entry.start), "spinner started for a running step");
  assert.ok(sinkCalls.spinner.some((entry) => entry.stop), "spinner stopped");

  // Regression (ADV-61-3 self-review): a step that THROWS after arming the spinner must still tear it
  // down (clearProgress in the try/finally), or the unref'd setInterval animates the TUI forever for a
  // failed run. Assert the spinner is stopped even though executeWorkflowRun rejects.
  const throwAdapter = {
    async executeStep() {
      throw new Error("boom mid-step");
    },
  };
  // (a) A sink WITH clear() (like the real makeProgressNotifier): clearProgress delegates to it, so the
  // planner widget + status + spinner are ALL torn down (ADV-61-4 — not just the spinner).
  const throwRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const clearSinkCalls = { spinner: [], clear: 0 };
  const clearSink = () => {};
  clearSink.setPlan = () => {};
  clearSink.setStatus = () => {};
  clearSink.startSpinner = () => clearSinkCalls.spinner.push("start");
  clearSink.stopSpinner = () => clearSinkCalls.spinner.push("stop");
  clearSink.clear = () => {
    clearSinkCalls.clear += 1;
  };
  await assert.rejects(
    () => executeWorkflowRun({ projectRoot: tempRoot, runId: throwRun.runId, now: () => fixedDate, adapter: throwAdapter, notify: clearSink }),
    /boom mid-step/,
  );
  assert.ok(clearSinkCalls.spinner.includes("start"), "spinner was armed before the throw");
  assert.equal(clearSinkCalls.clear, 1, "clearProgress invokes the richer clear() (planner+status+spinner) on throw");

  // (b) A sink WITHOUT clear() (only setPlan/setStatus/spinner): the planner is still emptied via a final
  // setPlan([]) and the spinner stopped, so a failed step is not left stuck on "running".
  const fallbackRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const fallbackCalls = { plan: [], spinner: [] };
  const fallbackSink = () => {};
  fallbackSink.setPlan = (lines) => fallbackCalls.plan.push(lines);
  fallbackSink.setStatus = () => {};
  fallbackSink.startSpinner = () => fallbackCalls.spinner.push("start");
  fallbackSink.stopSpinner = () => fallbackCalls.spinner.push("stop");
  await assert.rejects(
    () => executeWorkflowRun({ projectRoot: tempRoot, runId: fallbackRun.runId, now: () => fixedDate, adapter: throwAdapter, notify: fallbackSink }),
    /boom mid-step/,
  );
  assert.ok(fallbackCalls.spinner.includes("stop"), "spinner stopped on throw (no-clear fallback)");
  assert.deepEqual(fallbackCalls.plan.at(-1), [], "planner emptied via a final setPlan([]) on throw (no-clear fallback)");

  const policyStep = quick.steps[0];
  const policyState = {
    run_id: "run-policy",
  };
  assert.equal(
    assertControllerWriteAllowed({
      root: tempRoot,
      state: policyState,
      step: policyStep,
      relPath: ".aipi/runtime/runs/run-policy/steps/quick_scope/QUICK-SCOPE.md",
    }),
    ".aipi/runtime/runs/run-policy/steps/quick_scope/QUICK-SCOPE.md",
  );
  assert.throws(
    () =>
      assertControllerWriteAllowed({
        root: tempRoot,
        state: policyState,
        step: policyStep,
        relPath: ".aipi/memory/project/project.md",
      }),
    /durable-memory write requires memory promotion policy/,
  );
  assert.throws(
    () =>
      assertControllerWriteAllowed({
        root: tempRoot,
        state: policyState,
        step: policyStep,
        relPath: "not-declared.md",
      }),
    /not declared by workflow step/,
  );

  console.log("AIPI_WORKFLOW_EXECUTOR_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(text, token) {
  return String(text).split(token).length - 1;
}

function quickChangeLoopFailureAdapter() {
  const local = createTestPassWorkflowAdapter();
  return {
    async executeStep(args) {
      if (args.step.id !== "quick_change") return local.executeStep(args);
      return {
        schema: "aipi.step-result.v1",
        step_id: args.step.id,
        agent_ids: ["loop-failure-adapter"],
        verdict: "FAIL",
        evidence: [
          {
            rung: "blocked",
            source: "test",
            ref: "quick_change loop",
            result: "forced quick_change failure for runLimits coverage",
          },
        ],
        artifacts: [],
      };
    },
  };
}

function transientProviderAdapter({ failuresBeforeSuccess = 0, alwaysFail = false } = {}) {
  const pass = createTestPassWorkflowAdapter();
  const attempts = {};
  return {
    attempts,
    async executeStep(args) {
      attempts[args.step.id] = (attempts[args.step.id] ?? 0) + 1;
      if (args.step.id === "quick_scope" && (alwaysFail || attempts[args.step.id] <= failuresBeforeSuccess)) {
        const error = new Error("overloaded_error: provider temporarily overloaded");
        error.type = "overloaded_error";
        error.status = 529;
        throw error;
      }
      return pass.executeStep(args);
    },
  };
}

function policyGateFallbackAdapter() {
  const pass = createTestPassWorkflowAdapter();
  const failClosed = createLocalWorkflowAdapter();
  return {
    async executeStep(args) {
      if (args.step.id === "classify_boundary") return pass.executeStep(args);
      return failClosed.executeStep(args);
    },
  };
}

function createMemoryPromotionWorkflowAdapter(promotionsByStep = {}) {
  const pass = createTestPassWorkflowAdapter();
  return {
    async executeStep(args) {
      const promotions = promotionsByStep[args.step.id];
      if (!promotions) return pass.executeStep(args);

      const artifacts = [];
      for (const template of [...args.step.produces, ...args.step.controller_updates]) {
        const relPath = renderTestTemplate(template, args.state, args.step);
        await writeControllerArtifact({
          root: args.root,
          state: args.state,
          step: args.step,
          relPath,
          content: [
            `# test fixture artifact for ${args.step.id}`,
            "",
            "durable memory promotion candidates emitted by workflow adapter",
            "",
          ].join("\n"),
        });
        artifacts.push(relPath);
      }

      return {
        schema: "aipi.step-result.v1",
        step_id: args.step.id,
        agent_ids: args.step.agents.length ? args.step.agents : ["test-memory-adapter"],
        verdict: "PASS",
        evidence: [
          {
            rung: "verified",
            source: "test-memory-adapter",
            ref: artifacts[0] ?? `.aipi/runtime/runs/${args.state.run_id}/steps/${args.step.id}/MEMORY-PROMOTION.md`,
            result: "durable memory promotion candidates verified",
          },
        ],
        artifacts,
        memory_promotions: promotions,
      };
    },
  };
}

function createContradictoryReviewPassAdapter() {
  const pass = createTestPassWorkflowAdapter();
  return {
    async executeStep(args) {
      if (args.step.id !== "quick_review") return pass.executeStep(args);
      const artifacts = [];
      for (const template of args.step.produces) {
        const relPath = renderTestTemplate(template, args.state, args.step);
        const isCodeReview = relPath.endsWith("/CODE-REVIEW.md");
        await writeControllerArtifact({
          root: args.root,
          state: args.state,
          step: args.step,
          relPath,
          content: isCodeReview
            ? "## Findings\n\nCRITICAL: SQL injection reaches the changed code path.\n"
            : "## Findings\n\nNo complexity blockers.\n",
        });
        artifacts.push(relPath);
      }
      return {
        schema: "aipi.step-result.v1",
        step_id: args.step.id,
        agent_ids: args.step.agents,
        verdict: "PASS",
        evidence: [
          {
            rung: "ran",
            source: "test-review-adapter",
            ref: artifacts.join(", "),
            result: "review_artifacts produced",
          },
        ],
        artifacts,
      };
    },
  };
}

function createTestPassWorkflowAdapter() {
  return {
    async executeStep({ root, state, step, context, contract }) {
      const skipCondition = testSkipCondition(step);
      if (skipCondition) {
        return {
          schema: "aipi.step-result.v1",
          step_id: step.id,
          agent_ids: step.agents.length ? step.agents : ["test-pass-adapter"],
          verdict: "SKIPPED",
          skip_condition: skipCondition,
          evidence: testSkipEvidence({ step, contract, skipCondition }),
          artifacts: [],
        };
      }

      const artifacts = [];
      for (const template of [...step.produces, ...step.controller_updates]) {
        const relPath = renderTestTemplate(template, state, step);
        await writeControllerArtifact({
          root,
          state,
          step,
          relPath,
          content: [
            `# test fixture artifact for ${step.id}`,
            "",
            `workflow: ${state.workflow}`,
            `artifact: ${relPath}`,
            `contract_path: ${context.contract_path}`,
            "",
          ].join("\n"),
        });
        artifacts.push(relPath);
      }
      return {
        schema: "aipi.step-result.v1",
        step_id: step.id,
        agent_ids: step.agents.length ? step.agents : ["test-pass-adapter"],
        verdict: "PASS",
        evidence: [
          {
            rung: step.gate?.require_evidence_rung ?? "ran",
            source: "test-pass-adapter",
            ref: artifacts.join(", ") || step.id,
            result: `test fixture wrote ${artifacts.length} artifacts for ${step.id}`,
          },
        ],
        artifacts,
      };
    },
  };
}

function renderTestTemplate(template, state, step) {
  return String(template)
    .replaceAll("{{ run_id }}", state.run_id)
    .replaceAll("{{ step_id }}", step.id)
    .replaceAll("\\", "/");
}

function testSkipCondition(step) {
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

function testSkipEvidence({ step, contract, skipCondition }) {
  const required = contract?.skipConditions?.[skipCondition]?.requiresEvidence ?? [];
  if (!required.length) {
    return [
      {
        rung: "written",
        source: "test-pass-adapter",
        ref: step.id,
        result: `test fixture skipped ${step.id} through ${skipCondition}`,
      },
    ];
  }
  return required.map((token) => ({
    rung: "written",
    source: "test-pass-adapter",
    ref: `${step.id}#${token}`,
    result: `test fixture skip evidence ${token} for ${skipCondition}`,
    evidence_token: token,
  }));
}

// Like fakeWorkflowRunner, but quick_memory returns the realistic no-signal SKIPPED (its
// memory-promotion gate rejects a bare PASS with no memory_promotions). Lets the "default adapter runs
// every step as a subagent" regression complete the whole quick workflow end-to-end.
function quickWorkflowRunner({ calls = [], rawWrites = [], root } = {}) {
  return {
    async spawn(params) {
      calls.push({ params });
      const text = params.task ?? "";
      const agentId = text.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "worker";
      const stepId = text.match(/"step_id": "([^"]+)"/)?.[1] ?? "quick_change";
      const artifacts = expectedArtifactsFromPrompt(text);
      for (const artifact of artifacts) {
        const content = `# fake S0 worker wrote ${stepId}\n\nartifact: ${artifact}\n`;
        rawWrites.push({ path: artifact, content });
        const target = path.join(root, artifact);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
      const skip = stepId === "quick_memory";
      const stepResult = skip
        ? {
            schema: "aipi.step-result.v1",
            step_id: stepId,
            agent_ids: [agentId],
            verdict: "SKIPPED",
            skip_condition: "no_durable_memory_signal",
            evidence: [
              {
                rung: "written",
                source: "fake-s0-worker",
                ref: artifacts.join(", "),
                result: "no durable memory signal",
                evidence_token: "memory_candidate_scan",
              },
            ],
            artifacts,
          }
        : {
            schema: "aipi.step-result.v1",
            step_id: stepId,
            agent_ids: [agentId],
            verdict: "PASS",
            evidence: [
              {
                rung: "ran",
                source: "fake-s0-worker",
                ref: artifacts.join(", "),
                result: "worker wrote all owned artifacts",
              },
            ],
            artifacts,
          };
      return {
        content: [{ type: "text", text: JSON.stringify(stepResult) }],
        tool_call_count: artifacts.length,
        run_id: "fake-workflow-run",
      };
    },
  };
}

function fakeWorkflowRunner({ calls = [], rawWrites = [], root } = {}) {
  return {
    async spawn(params) {
      calls.push({ params });
      const text = params.task ?? "";
      const agentId = text.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "unknown";
      const stepId = text.match(/"step_id": "([^"]+)"/)?.[1] ?? "quick_change";
      const artifacts = expectedArtifactsFromPrompt(text);
      for (const artifact of artifacts) {
        const content = `# fake S0 worker wrote ${stepId}\n\nartifact: ${artifact}\n`;
        rawWrites.push({ path: artifact, content });
        const target = path.join(root, artifact);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              schema: "aipi.step-result.v1",
              step_id: stepId,
              agent_ids: [agentId],
              verdict: "PASS",
              evidence: [
                {
                  rung: "ran",
                  source: "fake-s0-worker",
                  ref: artifacts.join(", "),
                  result: "worker wrote all owned artifacts",
                },
              ],
              artifacts,
            }),
          },
        ],
        tool_call_count: artifacts.length,
        run_id: "fake-workflow-run",
      };
    },
  };
}

function fakeWorkflowSdk({ createCalls = [], rawWrites = [] } = {}) {
  return {
    SessionManager: {
      inMemory(root) {
        return { root, kind: "memory" };
      },
    },
    createReadOnlyToolDefinitions() {
      return [
        {
          name: "read",
          execute: async () => ({ content: [{ type: "text", text: "read ok" }] }),
        },
        {
          name: "grep",
          execute: async () => ({ content: [{ type: "text", text: "grep ok" }] }),
        },
        {
          name: "find",
          execute: async () => ({ content: [{ type: "text", text: "find ok" }] }),
        },
        {
          name: "ls",
          execute: async () => ({ content: [{ type: "text", text: "ls ok" }] }),
        },
      ];
    },
    createWriteToolDefinition(root) {
      return {
        name: "write",
        execute: async (_toolCallId, params) => {
          rawWrites.push({ path: params.path, content: params.content });
          const target = path.join(root, params.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, params.content);
          return { content: [{ type: "text", text: `wrote ${params.path}` }] };
        },
      };
    },
    async createAgentSession(options) {
      createCalls.push(options);
      let lastAssistantText = "";
      return {
        session: {
          subscribe() {
            return () => {};
          },
          async prompt(text) {
            const agentId = text.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "unknown";
            const stepId = text.match(/"step_id": "([^"]+)"/)?.[1] ?? "quick_change";
            const artifacts = expectedArtifactsFromPrompt(text);
            const writeTool = options.customTools.find((tool) => tool.name === "write");
            for (const artifact of artifacts) {
              await writeTool.execute("fake", {
                path: artifact,
                content: `# fake S0 worker wrote ${stepId}\n\nartifact: ${artifact}\n`,
              });
            }
            lastAssistantText = JSON.stringify({
              schema: "aipi.step-result.v1",
              step_id: stepId,
              agent_ids: [agentId],
              verdict: "PASS",
              evidence: [
                {
                  rung: "ran",
                  source: "fake-s0-worker",
                  ref: artifacts.join(", "),
                  result: "worker wrote all owned artifacts",
                },
              ],
              artifacts,
            });
          },
          agent: {
            async waitForIdle() {},
          },
          getLastAssistantText() {
            return lastAssistantText;
          },
          dispose() {},
          async abort() {},
        },
      };
    },
  };
}

function expectedArtifactsFromPrompt(text) {
  const section = text.split("Expected artifacts:")[1]?.split("\n\n")[0] ?? "";
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^- (.+)$/)?.[1])
    .filter(Boolean);
}

async function patchRunLimits(projectRoot, runLimits) {
  const contractPath = path.join(projectRoot, ".aipi", "runtime-contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  contract.runLimits = runLimits;
  await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
}

async function patchTransientProviderRetry(projectRoot, transientProviderRetry) {
  const contractPath = path.join(projectRoot, ".aipi", "runtime-contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  contract.transientProviderRetry = transientProviderRetry;
  await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
}

async function forceFastSemanticFallback(projectRoot) {
  const configPath = path.join(projectRoot, ".aipi", "semantic-memory.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, ollama_host: "http://127.0.0.1:9" }, null, 2)}\n`,
  );
}
