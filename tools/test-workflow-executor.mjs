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

async function forceFastSemanticFallback(projectRoot) {
  const configPath = path.join(projectRoot, ".aipi", "semantic-memory.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, ollama_host: "http://127.0.0.1:9" }, null, 2)}\n`,
  );
}
