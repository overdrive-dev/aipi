import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { readActiveRun, runWorkflowCommand, startWorkflowRun } from "../extensions/aipi/runtime/run-state.js";
import { rebuildCodeGraph } from "../extensions/aipi/runtime/aipi-tools.js";
import { SUBAGENT_STATE_ENTRY } from "../extensions/aipi/runtime/subagents.js";
import {
  applyProviderPayloadPolicy,
  blastRadiusBudgetMs,
  buildBlastRadiusPointer,
  buildProviderBudgetReport,
  buildRecentRunSummary,
  classifyAipiCodePipeline,
  classifyAipiInputRoute,
  createAipiLifecycleHandlers,
  formatStallStatus,
  getStallHeartbeat,
  handleBeforeAgentStart,
  looksLikeAipiProject,
  renderRecentRunSummary,
  StallHeartbeat,
  updateStallHeartbeat,
  estimateProviderUsageCost,
  normalizeProviderUsage,
  pruneAipiContextMessages,
  redactToolResultContent,
  safeProviderHeaders,
  summarizeProviderPayload,
} from "../extensions/aipi/runtime/lifecycle-hooks.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-lifecycle-hooks-"));
const sourceRoot = path.resolve("templates/.aipi");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });
  await forceFastSemanticFallback(tempRoot);
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "billing.js"),
    [
      "// continue billing renewal implementation load_contract planning",
      "export function renewBillingAccount(account) {",
      "  return account.renewalPrice;",
      "}",
      "",
    ].join("\n"),
  );
  await rebuildCodeGraph({
    projectRoot: tempRoot,
    embeddingFetch: async () => {
      throw new Error("ollama disabled for deterministic lifecycle-hooks test");
    },
  });
  const started = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    now: () => new Date("2026-06-16T12:00:00.000Z"),
    randomBytes: () => Buffer.from("112233", "hex"),
  });

  const entries = [];
  const sessionNames = [];
  const modelSelections = [];
  const thinkingSelections = [];
  const notifications = [];
  const persistedSubagentState = {
    jobs: [
      {
        agentId: "reviewer:resume",
        state: "running",
        descriptor: { agent_id: "reviewer", owned_files: ["src/review.js"] },
        model: null,
      },
    ],
    ownedFiles: [{ agentId: "reviewer:resume", files: ["src/review.js"] }],
  };
  const restoreCalls = [];
  const coordinator = {
    restore(state) {
      restoreCalls.push(state);
      return {
        restored: true,
        restored_jobs: 1,
        interrupted_jobs: 1,
        states: { interrupted: 1 },
        owned_file_allocations: 1,
      };
    },
  };
  const pi = {
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    setSessionName(name) {
      sessionNames.push(name);
    },
    setModel(model) {
      modelSelections.push(model);
    },
    setThinkingLevel(level) {
      thinkingSelections.push(level);
    },
  };
  const ctx = {
    cwd: tempRoot,
    modelRegistry: {
      find(provider, model) {
        return { provider, id: model };
      },
    },
    modelCapabilities: {
      valid: true,
      models: {
        "anthropic:claude-planner": {
          capabilities: {
            reasoning: "high",
            context: "high",
            tool_use: "required",
            structured_outputs: "supported",
          },
          evidence: ["test fixture"],
        },
      },
    },
    hasUI: true,
    ui: {
      notify(message, kind) {
        notifications.push({ message, kind });
      },
    },
    sessionManager: {
      getEntries() {
        return [
          {
            type: "custom",
            customType: SUBAGENT_STATE_ENTRY,
            data: persistedSubagentState,
          },
        ];
      },
    },
  };
  const handlers = createAipiLifecycleHandlers({ pi, projectRootResolver: () => tempRoot, coordinator });

  assert.equal(classifyAipiInputRoute("/aipi-workflow status", { activeRun: started }), null);
  assert.equal(classifyAipiInputRoute("pode seguir", { activeRun: started }).workflowArgs, "execute");
  assert.equal(classifyAipiInputRoute("ok continua", { activeRun: started }).workflowArgs, "execute");
  assert.equal(classifyAipiInputRoute("pode seguir", { activeRun: null }), null);
  assert.equal(classifyAipiInputRoute("continuar de onde parou depois da atualizacao", { activeRun: null }), null);
  assert.equal(classifyAipiInputRoute("continue the test fix wave", { activeRun: null }), null);
  // Flexible-agent DEFAULT: keyword tasks do NOT auto-dispatch or suggest a workflow — they fall through
  // to null so the full-tool main agent handles them (no pipeline hijack).
  assert.equal(classifyAipiInputRoute("planejar regra de negocio"), null);
  assert.equal(classifyAipiInputRoute("corrigir bug no login"), null);
  assert.equal(classifyAipiInputRoute("pesquisar docs do provider"), null);
  assert.equal(classifyAipiInputRoute("implementar nova tela"), null);
  assert.equal(classifyAipiInputRoute("pequeno ajuste"), null);
  assert.equal(classifyAipiInputRoute("review adversarial", { activeRun: null }), null);
  // Opt-in (AIPI_AUTO_DISPATCH=1 / autoDispatchEnabled:true) restores keyword auto-dispatch + suggestions.
  assertWorkflowSuggestion(classifyAipiInputRoute("planejar regra de negocio", { autoDispatchEnabled: true }), "planning");
  assertWorkflowDispatch(classifyAipiInputRoute("corrigir bug no login", { autoDispatchEnabled: true }), "bugfix", "root_cause_bugfix");
  assertWorkflowSuggestion(classifyAipiInputRoute("pesquisar docs do provider", { autoDispatchEnabled: true }), "research");
  assertWorkflowSuggestion(classifyAipiInputRoute("deploy em homolog", { autoDispatchEnabled: true }), "ops");
  assertWorkflowDispatch(classifyAipiInputRoute("implementar nova tela", { autoDispatchEnabled: true }), "planning", "substantive_code_work");
  assertWorkflowSuggestion(classifyAipiInputRoute("pequeno ajuste", { autoDispatchEnabled: true }), "quick");
  // Explicit continue/review of an ACTIVE run is NOT auto-dispatch — still works without the flag.
  assert.equal(classifyAipiInputRoute("review adversarial", { activeRun: started }).workflowArgs, "execute");
  assertWorkflowSuggestion(classifyAipiInputRoute("review adversarial", { activeRun: null, autoDispatchEnabled: true }), "planning");
  // #6: substantive input into an ACTIVE run does NOT auto-continue the workflow with auto-dispatch off
  // (stays the user's turn / flexible agent); with the flag on, it continues the active run.
  assert.equal(classifyAipiInputRoute("corrigir bug no login", { activeRun: started }), null);
  assert.equal(
    classifyAipiInputRoute("corrigir bug no login", { activeRun: started, autoDispatchEnabled: true }).intent,
    "continue_active_workflow",
  );
  assert.equal(
    classifyAipiInputRoute("Sim, essa regra vale para enterprise", {
      activeRun: {
        runId: "blocked-run",
        state: { status: "blocked", awaiting_user_input: { step_id: "business_rule_check" } },
      },
    }),
    null,
  );
  assert.equal(classifyAipiInputRoute("me explica isso"), null);
  const leftoverTestsQuestion = classifyAipiInputRoute("sobrou algum teste?");
  assert.equal(leftoverTestsQuestion.intent, "check_inline");
  assert.equal(leftoverTestsQuestion.answerInline, true);
  assert.equal(leftoverTestsQuestion.autoDispatch, false);
  assert.equal(classifyAipiCodePipeline("sobrou algum teste?").classification, "read_only_check");
  assert.equal(classifyAipiInputRoute("qual api chama login?").intent, "check_inline");
  assert.equal(classifyAipiInputRoute("quem chama a funcao renewSubscription?").intent, "check_inline");
  assert.equal(classifyAipiInputRoute("can you fix bug no login?"), null); // off by default
  assertWorkflowDispatch(classifyAipiInputRoute("can you fix bug no login?", { autoDispatchEnabled: true }), "bugfix", "root_cause_bugfix");
  const bugPipeline = classifyAipiCodePipeline("corrigir bug no login");
  assert.equal(bugPipeline.classification, "root_cause_bugfix");
  assert.equal(bugPipeline.default_action, "auto_dispatch_workflow");
  assert.equal(bugPipeline.dispatch_workflow, "bugfix");
  assert.deepEqual(bugPipeline.stages, [
    "reproduce",
    "root_cause_hypotheses",
    "verify_hypotheses",
    "confirm_root_cause",
    "fix_plan",
    "implement_fix",
    "regression_verify",
    "cross_model_review",
  ]);
  assert.equal(bugPipeline.root_cause.confirm_before_fix, true);
  assert.equal(bugPipeline.adversarial_review.target, "diagnosis");
  assert.equal(bugPipeline.cross_model_review.reviewer_distinct_from_implementer, true);
  const featurePipeline = classifyAipiCodePipeline("implementar nova tela");
  assert.equal(featurePipeline.classification, "substantive_code_work");
  assert.equal(featurePipeline.workflow, "planning");
  assert.equal(featurePipeline.default_action, "auto_dispatch_workflow");
  assert.equal(featurePipeline.dispatch_workflow, "planning");
  assert.deepEqual(featurePipeline.stages, ["plan", "adversarial_review", "diff_review"]);
  assert.equal(
    classifyAipiCodePipeline("corrigir bug no login", { activeRun: started }).default_action,
    "continue_active_workflow",
  );
  const deployDefaultPipeline = classifyAipiCodePipeline("deploy em prod");
  assert.equal(deployDefaultPipeline.classification, "deploy_precheck");
  assert.deepEqual(deployDefaultPipeline.precheck.checks, [
    "environment_boundary",
    "risk_blast_radius",
    "rollback_readiness",
    "evidence",
  ]);
  assert.equal(deployDefaultPipeline.deploy_confirmation.required, true);
  assert.equal(deployDefaultPipeline.deploy_confirmation.gate, "confirm_before_execute");
  assert.equal(deployDefaultPipeline.deploy_confirmation.blocks_chat_or_editing, false);
  const explicitAutoDeployPipeline = classifyAipiCodePipeline("auto-deploy em homolog depois dos prechecks");
  assert.equal(explicitAutoDeployPipeline.deploy_confirmation.required, false);
  assert.equal(explicitAutoDeployPipeline.auto_deploy.enabled, true);
  assert.equal(explicitAutoDeployPipeline.auto_deploy.reason, "explicit_user_instruction");
  assert.equal(explicitAutoDeployPipeline.precheck.required, true);
  await fs.appendFile(
    path.join(tempRoot, ".aipi", "memory", "project", "deployment.md"),
    "\n## Autodeploy policy\nAuto-deploy is allowed for homolog after prechecks pass and rollback is ready.\n",
  );
  const projectPolicyDeployPipeline = classifyAipiCodePipeline("deploy em homolog", { projectRoot: tempRoot });
  assert.equal(projectPolicyDeployPipeline.deploy_confirmation.required, false);
  assert.equal(projectPolicyDeployPipeline.auto_deploy.enabled, true);
  assert.equal(projectPolicyDeployPipeline.auto_deploy.reason, "project_memory_autodeploy_policy");
  assert.equal(projectPolicyDeployPipeline.precheck.required, true);
  assert.equal(classifyAipiCodePipeline("skip aipi pipeline e apenas responda").classification, "bypass");
  assert.equal(classifyAipiCodePipeline("pequeno ajuste de texto").classification, "trivial_or_mechanical");

  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(restoreCalls.length, 1);
  assert.deepEqual(restoreCalls[0], persistedSubagentState);
  assert.equal(entries.some((entry) => entry.type === "aipi.subagents.restore"), true);
  assert.equal(entries.some((entry) => entry.type === "aipi.run.session"), true);
  assert.match(sessionNames[0], /AIPI feature/);

  const runtimeErrorEntries = [];
  const runtimeErrorHandlers = createAipiLifecycleHandlers({
    pi: { appendEntry(type, data) { runtimeErrorEntries.push({ type, data }); } },
    projectRootResolver: () => tempRoot,
    coordinator: {
      setHostModel() {
        throw new Error("host capture stack marker");
      },
    },
  });
  await assert.rejects(
    () => runtimeErrorHandlers.session_start(
      { type: "session_start", reason: "runtime-error-test" },
      { ...ctx, model: { provider: "anthropic", id: "claude-error" } },
    ),
    /host capture stack marker/,
  );
  const runtimeErrorLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "errors.jsonl"), "utf8");
  assert.match(runtimeErrorLog, /"hook":"session_start"/);
  assert.match(runtimeErrorLog, /host capture stack marker/);
  assert.match(runtimeErrorLog, /"stack":"Error: host capture stack marker/);
  assert.equal(runtimeErrorEntries.some((entry) => entry.type === "aipi.runtime.error"), true);

  const beforeAgent = await handlers.before_agent_start({
    type: "before_agent_start",
    prompt: "continue billing renewal implementation",
  }, ctx);
  assert.equal(beforeAgent.message.customType, "aipi.context-pointer");
  assert.equal(beforeAgent.message.display, false);
  assert.match(beforeAgent.message.content, new RegExp(started.runId));
  assert.match(beforeAgent.message.content, /active_disciplines: context-thrift, contract-first/);
  assert.match(beforeAgent.message.content, /blast_radius:/);
  assert.match(beforeAgent.message.content, /src\/billing\.js/);
  assert.equal(beforeAgent.message.details.blast_radius.refs.length > 0, true);
  assert.equal(
    beforeAgent.message.details.blast_radius.refs.some((ref) => ref.path === "src/billing.js"),
    true,
  );
  assert.match(beforeAgent.message.content, /# context-thrift/);
  assert.match(beforeAgent.message.content, /# contract-first/);
  assert.deepEqual(
    beforeAgent.message.details.active_disciplines.map((discipline) => discipline.id),
    ["context-thrift", "contract-first"],
  );
  assert.equal(entries.some((entry) => entry.type === "aipi.context.pointer"), true);
  assert.equal(
    entries.some(
      (entry) =>
        entry.type === "aipi.discipline.active" &&
        entry.data.hook === "before_agent_start" &&
        entry.data.active_disciplines.includes("contract-first"),
    ),
    true,
  );

  const routedStatus = await handlers.input({ type: "input", text: "status do aipi", source: "interactive" }, ctx);
  assert.deepEqual(routedStatus, { action: "handled" });
  assert.equal(entries.some((entry) => entry.type === "aipi.input.route"), true);
  assert.match(notifications.at(-1).message, /AIPI workflow active/);
  assert.equal(
    (await handlers.input({ type: "input", text: "/aipi-workflow status", source: "interactive" }, ctx)).action,
    "continue",
  );

  const routerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-router-suggest-"));
  // This block exercises the OPT-IN auto-dispatch path (AIPI_AUTO_DISPATCH=1); the flexible default (off)
  // is covered by the classifyAipiInputRoute unit assertions above.
  const priorAutoDispatch = process.env.AIPI_AUTO_DISPATCH;
  process.env.AIPI_AUTO_DISPATCH = "1";
  try {
    await initProject({ sourceRoot, targetRoot: routerRoot });
    await forceFastSemanticFallback(routerRoot);
    await rebuildCodeGraph({
      projectRoot: routerRoot,
      embeddingFetch: async () => {
        throw new Error("ollama disabled for deterministic lifecycle-hooks router test");
      },
    });
    const routerRunnerCalls = [];
    const routerNotifications = [];
    const routerEntries = [];
    const routerUserInputs = [];
    const routerAdapterProofs = [];
    const routerCoordinator = {
      spawn(descriptor) {
        const agentId = `${descriptor.agent_id}:router-proof-${routerAdapterProofs.length + 1}`;
        routerAdapterProofs.push({ agentId, descriptor });
        return { agent_id: agentId };
      },
      collect(agentId) {
        return {
          ready: true,
          state: "done",
          agent_id: agentId,
          step_result: {
            schema: "aipi.step-result.v1",
            step_id: "quick_change",
            agent_ids: [agentId],
            verdict: "PASS",
            evidence: [{ rung: "ran", source: "router-real-adapter-proof", ref: agentId, result: "adapter executed" }],
            artifacts: [],
          },
        };
      },
    };
    const routerHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { routerEntries.push({ type, data }); } },
      projectRootResolver: () => routerRoot,
      coordinator: routerCoordinator,
      workflowCommandRunner: async (input) => {
        routerRunnerCalls.push(input);
        if (input.args.startsWith("run ")) {
          assert.equal(typeof input.adapter?.executeStep, "function");
          const adapterResult = await input.adapter.executeStep({
            root: input.projectRoot,
            state: {
              run_id: "router-adapter-proof",
              run_rel_dir: ".aipi/runtime/runs/router-adapter-proof",
              contract_path: ".aipi/runtime/runs/router-adapter-proof/BDD-CONTRACT.md",
            },
            workflow: { name: "quick" },
            step: {
              id: "quick_change",
              name: "Quick change",
              prompt: "prove adapter execution",
              agents: ["implementer"],
              produces: [],
              controller_updates: [],
              gate: {},
            },
            context: {},
            contract: {},
          });
          assert.equal(adapterResult.verdict, "PASS");
        }
        if (input.args === "execute") {
          const active = await readActiveRun(input.projectRoot);
          return { action: "execute", execution: { runId: active.runId, status: active.state.status, state: active.state } };
        }
        const workflow = input.args.replace(/^run\s+/, "");
        const runId = `fake-${workflow}-${routerRunnerCalls.length}`;
        return {
          action: "run",
          run: {
            runId,
            workflow,
            runRelDir: `.aipi/runtime/runs/${runId}`,
            contractPath: `.aipi/runtime/runs/${runId}/BDD-CONTRACT.md`,
          },
          execution: {
            runId,
            status: "blocked",
            state: { workflow, status: "blocked", current_step: "intake" },
          },
        };
      },
      userInputRecorder: async (input) => {
        routerUserInputs.push(input);
        return { record: input, relPath: "USER-INPUT.jsonl" };
      },
    });
    const routerCtx = { cwd: routerRoot, ui: { notify(message, kind) { routerNotifications.push({ message, kind }); } } };

    const checkBeforeRunnerCalls = routerRunnerCalls.length;
    const checkResult = await routerHandlers.input({ type: "input", text: "sobrou algum teste?", source: "interactive" }, routerCtx);
    assert.equal(checkResult.action, "continue");
    assert.equal(checkResult.message.customType, "aipi.read-only-check");
    assert.equal(checkResult.message.display, false);
    assert.match(checkResult.message.content, /aipi_retrieve/);
    assert.equal(routerRunnerCalls.length, checkBeforeRunnerCalls);
    const checkEntry = routerEntries.find((entry) => entry.type === "aipi.input.route" && entry.data.input === "check_inline");
    assert.equal(checkEntry.data.answer_inline, true);
    assert.equal(checkEntry.data.read_only, true);
    assert.equal(checkEntry.data.auto_dispatch, false);

    const unsupportedHostRunnerCalls = [];
    const unsupportedHostNotifications = [];
    const unsupportedHostEntries = [];
    const unsupportedHostHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { unsupportedHostEntries.push({ type, data }); } },
      projectRootResolver: () => routerRoot,
      coordinator: routerCoordinator,
      workflowCommandRunner: async (input) => {
        unsupportedHostRunnerCalls.push(input);
        return {
          action: "run",
          run: {
            runId: "host-openai-codex",
            workflow: "bugfix",
            runRelDir: ".aipi/runtime/runs/host-openai-codex",
            contractPath: ".aipi/runtime/runs/host-openai-codex/BDD-CONTRACT.md",
          },
          execution: {
            runId: "host-openai-codex",
            status: "blocked",
            state: { workflow: "bugfix", status: "blocked", current_step: "intake" },
          },
        };
      },
      userInputRecorder: async () => ({ relPath: "USER-INPUT.jsonl" }),
    });
    const unsupportedHostCtx = {
      cwd: routerRoot,
      model: "openai-codex/gpt-5.5",
      ui: { notify(message, kind) { unsupportedHostNotifications.push({ message, kind }); } },
    };
    assert.deepEqual(
      await unsupportedHostHandlers.input(
        { type: "input", text: "corrigir bug no login", source: "interactive" },
        unsupportedHostCtx,
      ),
      {
        action: "blocked",
        blocked: true,
        block_reason: "AIPI_HOST_MODEL_UNSUPPORTED",
        readiness: {
          ok: false,
          code: "AIPI_HOST_MODEL_UNSUPPORTED",
          model_id: "openai-codex/gpt-5.5",
          provider: "openai-codex",
          message: "AIPI host model is unavailable to the AIPI orchestrator turn. Current host model: openai-codex/gpt-5.5. Host provider openai-codex is not supported for the orchestrator turn; use it as the adversarial reviewer or set the host to a supported Anthropic model.",
        },
        message: {
          customType: "aipi.unsupported-host",
          display: true,
          content: "AIPI host model is unavailable to the AIPI orchestrator turn. Current host model: openai-codex/gpt-5.5. Host provider openai-codex is not supported for the orchestrator turn; use it as the adversarial reviewer or set the host to a supported Anthropic model.",
          details: {
            schema: "aipi.unsupported-host-block.v1",
            recorded_at: unsupportedHostEntries.at(-1)?.data?.recorded_at,
            hook: "input",
            run_id: null,
            workflow: null,
            step_id: null,
            host_model: "openai-codex/gpt-5.5",
            host_provider: "openai-codex",
            code: "AIPI_HOST_MODEL_UNSUPPORTED",
            message: "AIPI host model is unavailable to the AIPI orchestrator turn. Current host model: openai-codex/gpt-5.5. Host provider openai-codex is not supported for the orchestrator turn; use it as the adversarial reviewer or set the host to a supported Anthropic model.",
            runtime_error_recorded: true,
            runtime_error_ref: unsupportedHostEntries.at(-1)?.data?.runtime_error_ref,
            pipeline_classification: "root_cause_bugfix",
          },
        },
      },
    );
    assert.equal(unsupportedHostRunnerCalls.length, 0);
    assert.equal(unsupportedHostNotifications.at(-1)?.kind, "error");
    assert.match(unsupportedHostNotifications.at(-1)?.message ?? "", /not supported for the orchestrator turn/);
    assert.doesNotMatch(unsupportedHostNotifications.at(-1)?.message ?? "", /Cannot read properties of undefined/);
    const unsupportedHostEntry = unsupportedHostEntries.find((entry) => entry.type === "aipi.host.unsupported");
    assert.equal(unsupportedHostEntry.data.host_provider, "openai-codex");
    assert.equal(unsupportedHostEntry.data.hook, "input");
    assert.equal(unsupportedHostEntry.data.runtime_error_recorded, true);
    const unsupportedBeforeAgent = await unsupportedHostHandlers.before_agent_start(
      { type: "before_agent_start", prompt: "test" },
      unsupportedHostCtx,
    );
    assert.equal(unsupportedBeforeAgent.action, "blocked");
    assert.equal(unsupportedBeforeAgent.block_reason, "AIPI_HOST_MODEL_UNSUPPORTED");
    assert.equal(unsupportedBeforeAgent.message.customType, "aipi.unsupported-host");
    const unsupportedHostErrorLog = await fs.readFile(path.join(routerRoot, ".aipi", "runtime", "errors.jsonl"), "utf8");
    assert.match(unsupportedHostErrorLog, /"hook":"input"/);
    assert.match(unsupportedHostErrorLog, /"hook":"before_agent_start"/);
    assert.match(unsupportedHostErrorLog, /AipiUnsupportedHostError/);
    assert.match(unsupportedHostErrorLog, /"stack":"AipiUnsupportedHostError: AIPI host model is unavailable/);

    assert.deepEqual(
      await routerHandlers.input({ type: "input", text: "deploy no CI", source: "interactive" }, routerCtx),
      { action: "continue" },
    );
    assert.deepEqual(
      await routerHandlers.input({ type: "input", text: "corrigir bug no login", source: "interactive" }, routerCtx),
      { action: "handled" },
    );
    assert.deepEqual(
      await routerHandlers.input({ type: "input", text: "implementar nova tela", source: "interactive" }, routerCtx),
      { action: "handled" },
    );
    assert.deepEqual(
      await routerHandlers.input({ type: "input", text: "skip aipi pipeline e corrigir bug", source: "interactive" }, routerCtx),
      { action: "continue" },
    );
    assert.deepEqual(
      await routerHandlers.input({ type: "input", text: "pequeno ajuste de texto", source: "interactive" }, routerCtx),
      { action: "continue" },
    );

    assert.equal(routerRunnerCalls.length, 2);
    assert.equal(routerRunnerCalls[0].args, "run bugfix");
    assert.equal(routerRunnerCalls[1].args, "run planning");
    assert.equal(routerAdapterProofs.length, 2);
    assert.equal(routerAdapterProofs.every((proof) => proof.descriptor.step_id === "quick_change"), true);
    assert.equal(routerUserInputs.length, 2);
    assert.equal(routerUserInputs[0].runId, "fake-bugfix-1");
    assert.equal(routerUserInputs[1].runId, "fake-planning-2");
    assert.match(routerNotifications[0].message, /\/aipi-workflow run ops/);
    assert.match(routerNotifications[1].message, /AIPI workflow ran: bugfix/);
    assert.match(routerNotifications[2].message, /AIPI workflow ran: planning/);
    assert.match(routerNotifications.at(-1).message, /\/aipi-workflow run quick/);
    const deployTrace = routerEntries.find(
      (entry) => entry.type === "aipi.code_pipeline.trace" && entry.data.classification === "deploy_precheck",
    );
    assert.equal(deployTrace.data.precheck.checks.includes("rollback_readiness"), true);
    assert.equal(deployTrace.data.deploy_confirmation.required, true);
    assert.equal(deployTrace.data.deploy_confirmation.blocks_chat_or_editing, false);
    const bugTrace = routerEntries.find(
      (entry) => entry.type === "aipi.code_pipeline.trace" && entry.data.classification === "root_cause_bugfix",
    );
    assert.equal(bugTrace.data.default_action, "auto_dispatch_workflow");
    assert.equal(bugTrace.data.dispatch.workflow, "bugfix");
    assert.equal(bugTrace.data.dispatch.workflow_args, "run bugfix");
    assert.equal(bugTrace.data.dispatch.run_id, "fake-bugfix-1");
    assert.equal(bugTrace.data.stages.includes("verify_hypotheses"), true);
    assert.equal(bugTrace.data.root_cause.confirm_before_fix, true);
    const featureTrace = routerEntries.find(
      (entry) => entry.type === "aipi.code_pipeline.trace" && entry.data.classification === "substantive_code_work",
    );
    assert.equal(featureTrace.data.default_action, "auto_dispatch_workflow");
    assert.equal(featureTrace.data.workflow, "planning");
    assert.equal(featureTrace.data.dispatch.workflow, "planning");
    assert.equal(featureTrace.data.dispatch.run_id, "fake-planning-2");
    const skipTrace = routerEntries.find(
      (entry) => entry.type === "aipi.code_pipeline.trace" && entry.data.reason === "explicit_skip_phrase",
    );
    assert.equal(skipTrace.data.dispatch, null);

    const vetoRunnerCalls = [];
    const vetoClassifierCalls = [];
    const vetoEntries = [];
    const vetoHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { vetoEntries.push({ type, data }); } },
      projectRootResolver: () => routerRoot,
      coordinator: routerCoordinator,
      intentClassifier: async (input) => {
        vetoClassifierCalls.push(input);
        if (input.text === "api login") return { verdict: "question", reason: "ambiguous API question" };
        return { verdict: "workflow", reason: "mutation request" };
      },
      workflowCommandRunner: async (input) => {
        vetoRunnerCalls.push(input);
        if (input.args.startsWith("run ")) {
          assert.equal(typeof input.adapter?.executeStep, "function");
          await input.adapter.executeStep({
            root: input.projectRoot,
            state: {
              run_id: "router-veto-proof",
              run_rel_dir: ".aipi/runtime/runs/router-veto-proof",
              contract_path: ".aipi/runtime/runs/router-veto-proof/BDD-CONTRACT.md",
            },
            workflow: { name: "quick" },
            step: {
              id: "quick_change",
              name: "Quick change",
              prompt: "prove adapter execution",
              agents: ["implementer"],
              produces: [],
              controller_updates: [],
              gate: {},
            },
            context: {},
            contract: {},
          });
        }
        return {
          action: "run",
          run: { runId: `veto-${vetoRunnerCalls.length}`, workflow: input.args.replace(/^run\s+/, "") },
          execution: { runId: `veto-${vetoRunnerCalls.length}`, status: "blocked", state: { status: "blocked" } },
        };
      },
      userInputRecorder: async () => ({ relPath: "USER-INPUT.jsonl" }),
    });
    assert.deepEqual(
      await vetoHandlers.input({ type: "input", text: "api login", source: "interactive" }, routerCtx),
      { action: "continue" },
    );
    assert.equal(vetoRunnerCalls.length, 0);
    assert.equal(vetoClassifierCalls.length, 1);
    assert.equal(vetoClassifierCalls[0].ctx.aipiDisableRouting, true);
    const vetoEntry = vetoEntries.find((entry) => entry.type === "aipi.input.route" && entry.data.input === "auto_dispatch_vetoed");
    assert.equal(vetoEntry.data.classifier_source, "llm-veto");
    assert.equal(vetoEntry.data.classifier_verdict, "question");

    assert.deepEqual(
      await vetoHandlers.input({ type: "input", text: "corrigir bug no login", source: "interactive" }, routerCtx),
      { action: "handled" },
    );
    assert.equal(vetoRunnerCalls.at(-1).args, "run bugfix");
    const allowedEntry = vetoEntries.find((entry) => entry.type === "aipi.input.route" && entry.data.workflow_args === "run bugfix");
    assert.equal(allowedEntry.data.classifier_source, "llm-veto");
    assert.equal(allowedEntry.data.classifier_verdict, "workflow");

    const fallbackRunnerCalls = [];
    const fallbackEntries = [];
    const fallbackHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { fallbackEntries.push({ type, data }); } },
      projectRootResolver: () => routerRoot,
      coordinator: routerCoordinator,
      intentClassifier: async () => {
        throw new Error("classifier auth unavailable");
      },
      workflowCommandRunner: async (input) => {
        fallbackRunnerCalls.push(input);
        return {
          action: "run",
          run: { runId: `fallback-${fallbackRunnerCalls.length}`, workflow: input.args.replace(/^run\s+/, "") },
          execution: { runId: `fallback-${fallbackRunnerCalls.length}`, status: "blocked", state: { status: "blocked" } },
        };
      },
      userInputRecorder: async () => ({ relPath: "USER-INPUT.jsonl" }),
    });
    assert.deepEqual(
      await fallbackHandlers.input({ type: "input", text: "corrigir bug no login", source: "interactive" }, routerCtx),
      { action: "handled" },
    );
    assert.equal(fallbackRunnerCalls.at(-1).args, "run bugfix");
    // bug-param plumbing (real drop point): the user's task text is forwarded to the workflow command
    // as params.bug (bugfix's primary free-text param) so the run actually has a defect to triage.
    assert.deepEqual(fallbackRunnerCalls.at(-1).params, { bug: "corrigir bug no login" });
    const fallbackEntry = fallbackEntries.find((entry) => entry.type === "aipi.input.route" && entry.data.workflow_args === "run bugfix");
    assert.equal(fallbackEntry.data.classifier_source, "regex-fallback");
    assert.match(fallbackEntry.data.classifier_reason, /classifier auth unavailable/);

    const timeoutEntries = [];
    const timeoutRunnerCalls = [];
    const timeoutHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { timeoutEntries.push({ type, data }); } },
      projectRootResolver: () => routerRoot,
      coordinator: routerCoordinator,
      intentClassifierTimeoutMs: 1,
      intentClassifier: () => new Promise(() => {}),
      workflowCommandRunner: async (input) => {
        timeoutRunnerCalls.push(input);
        return {
          action: "run",
          run: { runId: `timeout-${timeoutRunnerCalls.length}`, workflow: input.args.replace(/^run\s+/, "") },
          execution: { runId: `timeout-${timeoutRunnerCalls.length}`, status: "blocked", state: { status: "blocked" } },
        };
      },
      userInputRecorder: async () => ({ relPath: "USER-INPUT.jsonl" }),
    });
    assert.deepEqual(
      await timeoutHandlers.input({ type: "input", text: "implementar nova tela", source: "interactive" }, routerCtx),
      { action: "handled" },
    );
    assert.equal(timeoutRunnerCalls.at(-1).args, "run planning");
    const timeoutEntry = timeoutEntries.find((entry) => entry.type === "aipi.input.route" && entry.data.workflow_args === "run planning");
    assert.equal(timeoutEntry.data.classifier_source, "regex-fallback");
    assert.match(timeoutEntry.data.classifier_reason, /intent_classifier_timeout/);

    const noAdapterRunnerCalls = [];
    const noAdapterNotifications = [];
    const noAdapterEntries = [];
    const noAdapterHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { noAdapterEntries.push({ type, data }); } },
      projectRootResolver: () => routerRoot,
      workflowCommandRunner: async (input) => {
        noAdapterRunnerCalls.push(input);
        throw new Error("no-adapter fallback must not invoke the workflow runner");
      },
      userInputRecorder: async (input) => ({ record: input, relPath: "USER-INPUT.jsonl" }),
    });
    const noAdapterCtx = {
      cwd: routerRoot,
      ui: { notify(message, kind) { noAdapterNotifications.push({ message, kind }); } },
    };
    assert.deepEqual(
      await noAdapterHandlers.input({ type: "input", text: "corrigir bug no login", source: "interactive" }, noAdapterCtx),
      { action: "continue" },
    );
    assert.equal(noAdapterRunnerCalls.length, 0);
    assert.match(noAdapterNotifications.at(-1).message, /\/aipi-workflow run bugfix/);
    assert.equal(
      noAdapterEntries.some(
        (entry) =>
          entry.type === "aipi.input.route" &&
          entry.data.reason === "no_executable_adapter" &&
          entry.data.auto_dispatch === false,
      ),
      true,
    );
    assert.deepEqual(
      await noAdapterHandlers.input({
        type: "input",
        text: "continuar de onde parou depois da atualizacao",
        source: "interactive",
      }, noAdapterCtx),
      { action: "continue" },
    );
    assert.equal(noAdapterRunnerCalls.length, 0);
    assert.deepEqual(
      await noAdapterHandlers.input({
        type: "input",
        text: "continue the test fix wave",
        source: "interactive",
      }, noAdapterCtx),
      { action: "continue" },
    );
    assert.equal(noAdapterRunnerCalls.length, 0);

    const partialCoordinatorHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { noAdapterEntries.push({ type, data }); } },
      projectRootResolver: () => routerRoot,
      coordinator: { spawn() {} },
      workflowCommandRunner: async (input) => {
        noAdapterRunnerCalls.push(input);
        throw new Error("partial coordinator must not invoke the workflow runner");
      },
    });
    assert.deepEqual(
      await partialCoordinatorHandlers.input({ type: "input", text: "corrigir bug no login", source: "interactive" }, noAdapterCtx),
      { action: "continue" },
    );
    assert.equal(noAdapterRunnerCalls.length, 0);

    const activeForContinuation = await startWorkflowRun({
      projectRoot: routerRoot,
      workflow: "feature",
      now: () => new Date("2026-06-16T13:00:00.000Z"),
      randomBytes: () => Buffer.from("445566", "hex"),
    });
    assert.deepEqual(
      await routerHandlers.input({ type: "input", text: "corrigir outro bug", source: "interactive" }, routerCtx),
      { action: "handled" },
    );
    assert.equal(routerRunnerCalls.at(-1).args, "execute");
    assert.equal((await readActiveRun(routerRoot)).runId, activeForContinuation.runId);

    const explicit = await runWorkflowCommand({ args: "run bugfix", projectRoot: routerRoot });
    assert.equal(explicit.action, "run");
    // routerRoot has no executable adapter, so `run bugfix` dead-ends on the workflow
    // freestyle/retry/cancel meta-decision (status:blocked, kind:workflow_blocked_decision).
    // Inspect with keepBlockedDecision to confirm the explicit command set the active run to
    // bugfix WITHOUT triggering CR-59-2 central recovery (the same "look, don't auto-detach"
    // path handleInput uses to run its explicit notify+audit detach).
    const activeAfterExplicit = await readActiveRun(routerRoot, { keepBlockedDecision: true });
    assert.equal(activeAfterExplicit.state.workflow, "bugfix");
    // A plain default read self-recovers the structurally-dead meta-decision run (CR-59-2): it
    // clears runs/active and persists the run as abandoned, so no later hook re-traps the user.
    assert.equal(await readActiveRun(routerRoot), null);
  } finally {
    if (priorAutoDispatch === undefined) delete process.env.AIPI_AUTO_DISPATCH;
    else process.env.AIPI_AUTO_DISPATCH = priorAutoDispatch;
    await fs.rm(routerRoot, { recursive: true, force: true });
  }

  const injectedContext = await handlers.context({
    type: "context",
    messages: [{ role: "user", content: "continue" }],
  }, ctx);
  assert.equal(injectedContext.messages.length, 2);
  assert.equal(injectedContext.messages[1].customType, "aipi.context-pointer");
  assert.match(injectedContext.messages[1].content, new RegExp(started.runId));
  assert.match(injectedContext.messages[1].content, /active_disciplines: context-thrift/);
  assert.match(injectedContext.messages[1].content, /# context-thrift/);

  assert.equal(
    await handlers.tool_call({ type: "tool_call", toolName: "write", input: { path: "src/example.js" } }, ctx),
    undefined,
  );
  assert.equal(
    entries.some(
      (entry) =>
        entry.type === "aipi.discipline.active" &&
        entry.data.hook === "tool_call" &&
        entry.data.active_disciplines.includes("prove-it") &&
        entry.data.active_disciplines.includes("contract-first"),
    ),
    true,
  );
  assert.equal(typeof handlers.agent_end, "function");
  assert.equal(typeof handlers.turn_end, "function");
  assert.equal(typeof handlers.message_end, "function");
  assert.equal(
    await handlers.agent_end({ type: "agent_end", text: "Evidence: ran `npm test` -> passed." }, ctx),
    undefined,
  );
  assert.equal(
    await handlers.turn_end({ type: "turn_end", text: "Done. Evidence: ran `npm test` -> passed." }, ctx),
    undefined,
  );
  const unsupportedMessageEnd = await invokeMessageEndWithHostContract(handlers.message_end, {
    type: "message_end",
    message: { role: "assistant", content: "Fixed and safe to deploy." },
  }, ctx);
  assert.equal(unsupportedMessageEnd, undefined);
  assert.equal(
    await invokeMessageEndWithHostContract(handlers.message_end, {
      type: "message_end",
      message: { role: "assistant", content: "Fixed. Evidence: ran `npm test` -> passed." },
    }, ctx),
    undefined,
  );
  // B2: an unsupported "fixed/safe" claim SURFACES a visible warning at message_end (anti-self-deception
  // finish gate); the evidence-backed claim above does not add one.
  assert.ok(
    notifications.some((note) => note.kind === "warning" && /evidence rung/i.test(note.message ?? "")),
    "B2: unsupported claim at message_end surfaces a visible warning",
  );
  assert.equal(
    entries.some(
      (entry) =>
        entry.type === "aipi.discipline.active" &&
        entry.data.hook === "message_end" &&
        entry.data.active_disciplines.includes("prove-it"),
    ),
    true,
  );
  assert.equal(
    entries.some(
      (entry) =>
        entry.type === "aipi.discipline.end_audit" &&
        entry.data.hook === "message_end" &&
        entry.data.state === "warn" &&
        entry.data.reason === "AIPI_MESSAGE_END_CLAIM_EVIDENCE_REQUIRED" &&
        entry.data.unsupported_claims.some((claim) => claim.term === "fixed"),
    ),
    true,
  );
  const disciplineAuditLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "discipline-audit.jsonl"), "utf8");
  assert.match(disciplineAuditLog, /AIPI_MESSAGE_END_CLAIM_EVIDENCE_REQUIRED/);

  const longA = "A".repeat(1300);
  const longB = "B".repeat(1300);
  const longC = "C".repeat(1300);
  const prunedContext = await handlers.context({
    type: "context",
    messages: [
      { role: "custom", customType: "aipi.context-pointer", content: "old pointer", display: false },
      { role: "toolResult", toolName: "aipi_memory_query", content: longA, details: {} },
      { role: "toolResult", toolName: "aipi_rule_lookup", content: [{ type: "text", text: longB }], details: {} },
      { role: "toolResult", toolName: "aipi_impact", content: longC, details: {} },
      { role: "custom", customType: "aipi.context-pointer", content: "new pointer", display: false },
    ],
  }, ctx);
  assert.equal(prunedContext.messages.filter((message) => message.customType === "aipi.context-pointer").length, 1);
  assert.match(prunedContext.messages[0].content, /AIPI context pruned 100 chars/);
  assert.equal(prunedContext.messages[1].content[0].text, longB);
  assert.equal(prunedContext.messages[2].content, longC);
  const contextLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "context-events.jsonl"), "utf8");
  assert.match(contextLog, /"removed_context_pointers":1/);
  assert.match(contextLog, /"truncated_tool_results":1/);

  assert.equal(pruneAipiContextMessages([{ role: "user", content: "no active" }]).modified, false);

  const modelRoute = await handlers.model_select({
    type: "model_select",
    model_class: "planner-heavy",
    current_model: { provider: "anthropic", id: "manual" },
    env: { AIPI_MODEL_CLASS_PLANNER_HEAVY: "anthropic/claude-planner:high" },
  }, ctx);
  assert.equal(modelRoute.model_class, "planner-heavy");
  assert.deepEqual(modelRoute.model, { provider: "anthropic", id: "claude-planner" });
  assert.equal(modelRoute.thinking_level, "high");
  assert.equal(modelRoute.warning.code, "AIPI_MODEL_MANUAL_DRIFT");
  assert.deepEqual(modelSelections.at(-1), { provider: "anthropic", id: "claude-planner" });
  assert.equal(thinkingSelections.at(-1), "high");

  const modelSelectionCount = modelSelections.length;
  const blockedModelRoute = await handlers.model_select({
    type: "model_select",
    model_class: "planner-heavy",
    env: { AIPI_MODEL_CLASS_PLANNER_HEAVY: "anthropic/unproven-planner:high" },
  }, {
    ...ctx,
    modelCapabilities: { valid: true, models: {} },
  });
  assert.equal(blockedModelRoute.blocked, true);
  assert.equal(blockedModelRoute.status, "blocked_capability_floor");
  assert.equal(blockedModelRoute.warning.severity, "error");
  assert.equal(blockedModelRoute.warning.code, "AIPI_MODEL_CAPABILITY_UNPROVEN");
  assert.equal(modelSelections.length, modelSelectionCount);
  assert.equal(notifications.at(-1).kind, "error");

  const manualModelSelectionCount = modelSelections.length;
  // ADV-58-2: real Pi ModelSelectEvent shape (model/previousModel/source), not synthetic current_model.
  const manualModelRoute = await handlers.model_select({
    type: "model_select",
    model: { provider: "anthropic", id: "manual" },
    previousModel: { provider: "anthropic", id: "claude-opus-4-8" },
    source: "set",
    env: { AIPI_MODEL_CLASS_PLANNER_HEAVY: "anthropic/claude-planner:high" },
  }, ctx);
  assert.equal(manualModelRoute, undefined);
  assert.equal(modelSelections.length, manualModelSelectionCount);

  const unsupportedManualModelRoute = await handlers.model_select({
    type: "model_select",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    previousModel: { provider: "anthropic", id: "claude-opus-4-8" },
    source: "set",
  }, ctx);
  assert.equal(unsupportedManualModelRoute.blocked, true);
  assert.equal(unsupportedManualModelRoute.status, "unsupported_host_model");
  assert.equal(unsupportedManualModelRoute.block_reason, "AIPI_HOST_MODEL_UNSUPPORTED");
  assert.equal(modelSelections.length, manualModelSelectionCount);

  const manualThinkingSelectionCount = thinkingSelections.length;
  // ADV-58-2: use the REAL Pi ThinkingLevelSelectEvent shape (level/previousLevel), not a synthetic
  // selected_thinking_level field the host never sends — proves the manual level is actually preserved.
  const manualThinkingRoute = await handlers.thinking_level_select({
    type: "thinking_level_select",
    level: "medium",
    previousLevel: "low",
    env: { AIPI_THINKING_PLANNER_HEAVY: "low" },
  }, ctx);
  assert.equal(manualThinkingRoute, undefined);
  assert.equal(thinkingSelections.length, manualThinkingSelectionCount);

  const activeThinkingRoute = await handlers.thinking_level_select({ type: "thinking_level_select" }, ctx);
  assert.equal(activeThinkingRoute.model_class, "planner-heavy");
  assert.equal(activeThinkingRoute.thinking_level, "high");
  assert.equal(activeThinkingRoute.warning.code, "AIPI_MODEL_CLASS_UNRESOLVED");

  const reviewerThinkingRoute = await handlers.thinking_level_select({
    type: "thinking_level_select",
    agent_id: "code-reviewer",
    env: { AIPI_THINKING_ADVERSARIAL_HEAVY: "xhigh" },
  }, ctx);
  assert.equal(reviewerThinkingRoute.model_class, "adversarial-heavy");
  assert.equal(reviewerThinkingRoute.thinking_level, "xhigh");
  assert.equal(thinkingSelections.at(-1), "xhigh");
  const modelRoutingLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "model-routing.jsonl"), "utf8");
  assert.match(modelRoutingLog, /"hook":"model_select"/);
  assert.match(modelRoutingLog, /"hook":"thinking_level_select"/);
  assert.match(modelRoutingLog, /AIPI_MODEL_MANUAL_DRIFT/);
  assert.match(modelRoutingLog, /manual_model_preserved/);
  assert.match(modelRoutingLog, /manual_thinking_preserved/);
  assert.match(modelRoutingLog, /needs_configured_model/);
  const runModelRoutingLog = await fs.readFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", started.runId, "model-routing.jsonl"),
    "utf8",
  );
  assert.match(runModelRoutingLog, /"workflow":"feature"/);

  const compactResult = await handlers.session_before_compact({
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-1",
      tokensBefore: 123,
      previousSummary: "previous",
      messagesToSummarize: [{ role: "user", content: "keep BDD contract visible" }],
      fileOps: { modified: ["src/example.js"] },
    },
  }, ctx);
  assert.equal(compactResult.compaction.firstKeptEntryId, "entry-1");
  assert.equal(compactResult.compaction.tokensBefore, 123);
  assert.equal(compactResult.compaction.details.schema, "aipi.compaction-details.v1");
  assert.match(compactResult.compaction.summary, /AIPI compaction summary/);
  assert.match(compactResult.compaction.summary, /keep BDD contract visible/);
  const handoffPath = path.join(tempRoot, ".aipi", "runtime", "runs", started.runId, "SESSION-HANDOFF.md");
  assert.match(await fs.readFile(handoffPath, "utf8"), /schema: aipi\.session-handoff\.v1/);

  const treeResult = await handlers.session_before_tree({
    type: "session_before_tree",
    preparation: {
      targetId: "target",
      oldLeafId: "old",
      commonAncestorId: "root",
      userWantsSummary: true,
    },
  }, ctx);
  assert.match(treeResult.customInstructions, /Preserve AIPI run state/);
  assert.equal(treeResult.label, "AIPI feature");

  assert.equal(
    await handlers.session_before_switch({ type: "session_before_switch", reason: "resume" }, ctx),
    undefined,
  );
  assert.equal(
    await handlers.session_before_fork({ type: "session_before_fork", entryId: "entry-1", position: "at" }, ctx),
    undefined,
  );

  const sourceWriteUserBash = await handlers.user_bash({
    type: "user_bash",
    command: "Set-Content src/example.js 'updated'",
    cwd: tempRoot,
    excludeFromContext: false,
  }, ctx);
  assert.equal(sourceWriteUserBash, undefined);
  assert.equal(
    entries.some(
      (entry) =>
        entry.type === "aipi.discipline.active" &&
        entry.data.hook === "user_bash" &&
        entry.data.active_disciplines.includes("prove-it"),
    ),
    true,
  );

  const deployUserBash = await handlers.user_bash({
    type: "user_bash",
    command: "vercel deploy --prod",
    cwd: tempRoot,
    excludeFromContext: false,
  }, ctx);
  assert.equal(deployUserBash, undefined);

  const redacted = await handlers.tool_result({
    type: "tool_result",
    toolCallId: "tool-1",
    toolName: "bash",
    input: { command: "env" },
    content: [{ type: "text", text: "api_key=SECRETSECRET12345\nok" }],
    isError: false,
  }, ctx);
  assert.equal(redacted.content[0].text.includes("SECRETSECRET12345"), false);
  const toolLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "tool-results.jsonl"), "utf8");
  assert.doesNotMatch(toolLog, /SECRETSECRET12345/);

  const beforeProvider = await handlers.before_provider_request({
    type: "before_provider_request",
    payload: {
      model: "model-x",
      max_tokens: 100,
      messages: [{ role: "user", content: "secret" }],
      tools: [{ name: "write" }],
    },
  }, ctx);
  assert.equal(beforeProvider, undefined);

  const mutatedProvider = await handlers.before_provider_request({
    type: "before_provider_request",
    payload: {
      model: "model-x",
      messages: [
        { role: "custom", customType: "aipi.context-pointer", content: "old pointer", display: false },
        { role: "user", content: "token=SECRETSECRET12345" },
        { role: "custom", customType: "aipi.context-pointer", content: "new pointer", display: false },
      ],
    },
  }, ctx);
  assert.equal(mutatedProvider.messages.length, 2);
  assert.equal(mutatedProvider.messages.filter((message) => message.customType === "aipi.context-pointer").length, 1);
  assert.doesNotMatch(JSON.stringify(mutatedProvider), /SECRETSECRET12345/);

  await fs.writeFile(
    path.join(tempRoot, ".aipi", "provider-pricing.json"),
    `${JSON.stringify({
      schema: "aipi.provider-pricing.v1",
      currency: "USD",
      checked_at: "2026-06-16T00:00:00.000Z",
      source_url: "https://example.com/provider-pricing",
      max_age_days: 3650,
      rates: {
        "anthropic:claude-estimated": {
          input_per_million_tokens: 3,
          output_per_million_tokens: 15,
        },
      },
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(tempRoot, ".aipi", "provider-budget.json"),
    `${JSON.stringify({
      schema: "aipi.provider-budget.v1",
      enabled: true,
      default: {
        max_usd: 0.1,
        warn_at_ratio: 0.8,
      },
      models: {
        "anthropic:claude-estimated": {
          max_usd: 0.03,
          warn_at_ratio: 0.8,
        },
      },
    }, null, 2)}\n`,
  );

  await handlers.after_provider_response({
    type: "after_provider_response",
    provider: "anthropic",
    model: "claude-sonnet",
    status: 429,
    headers: {
      "retry-after": "10",
      authorization: "Bearer SECRET",
      "x-ratelimit-remaining": "0",
    },
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cost_usd: 0.0042,
    },
  }, ctx);
  const providerLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "provider-events.jsonl"), "utf8");
  assert.match(providerLog, /before_provider_request/);
  assert.match(providerLog, /after_provider_response/);
  assert.match(providerLog, /"input_tokens":120/);
  assert.doesNotMatch(providerLog, /Bearer SECRET|\"secret\"/);
  const providerUsageLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "provider-usage.jsonl"), "utf8");
  assert.match(providerUsageLog, /"schema":"aipi.provider-usage.v1"/);
  assert.match(providerUsageLog, /"input_tokens":120/);
  assert.match(providerUsageLog, /"output_tokens":30/);
  assert.match(providerUsageLog, /"total_tokens":150/);
  assert.match(providerUsageLog, /"cost_usd":0.0042/);
  assert.match(providerUsageLog, /"cost_source":"provider_usage"/);
  await handlers.after_provider_response({
    type: "after_provider_response",
    provider: "anthropic",
    model: "claude-estimated",
    status: 200,
    usage: {
      input_tokens: 1000,
      output_tokens: 2000,
    },
  }, ctx);
  const estimatedProviderUsageLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "provider-usage.jsonl"), "utf8");
  assert.match(estimatedProviderUsageLog, /"model":"claude-estimated"/);
  assert.match(estimatedProviderUsageLog, /"cost_usd":0.033/);
  assert.match(estimatedProviderUsageLog, /"cost_source":"aipi_provider_pricing"/);
  assert.match(estimatedProviderUsageLog, /"pricing_ref":"anthropic:claude-estimated"/);
  assert.match(estimatedProviderUsageLog, /"pricing_checked_at":"2026-06-16T00:00:00.000Z"/);
  assert.match(estimatedProviderUsageLog, /"pricing_source_url":"https:\/\/example.com\/provider-pricing"/);
  const providerBudgetLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "provider-budget.jsonl"), "utf8");
  assert.match(providerBudgetLog, /"schema":"aipi.provider-budget.v1"/);
  assert.match(providerBudgetLog, /"state":"ok"/);
  assert.match(providerBudgetLog, /"state":"over_budget"/);
  assert.match(providerBudgetLog, /"scope_ref":"anthropic:claude-estimated"/);
  assert.match(providerBudgetLog, /"projected_usd":0.033/);
  await handlers.after_provider_response({
    type: "after_provider_response",
    provider: "zai",
    model: "glm-unpriced",
    status: 200,
    usage: {
      input_tokens: 500,
      output_tokens: 250,
    },
  }, ctx);
  const unknownCostBudgetLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "provider-budget.jsonl"), "utf8");
  assert.match(unknownCostBudgetLog, /"state":"cost_unknown"/);
  assert.match(unknownCostBudgetLog, /"cost_status":"unknown_no_rate"/);
  assert.match(unknownCostBudgetLog, /"event_cost_usd":null/);
  assert.match(unknownCostBudgetLog, /"projected_usd":null/);
  const runProviderUsageLog = await fs.readFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", started.runId, "provider-usage.jsonl"),
    "utf8",
  );
  assert.match(runProviderUsageLog, /"workflow":"feature"/);
  const runProviderBudgetLog = await fs.readFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", started.runId, "provider-budget.jsonl"),
    "utf8",
  );
  assert.match(runProviderBudgetLog, /"over_budget"/);

  assert.equal(redactToolResultContent([{ type: "text", text: "password=SUPERSECRET" }]).redacted, true);
  const directPayloadPolicy = applyProviderPayloadPolicy({
    messages: [{ role: "user", content: "api_key=SECRETSECRET12345" }],
  });
  assert.equal(directPayloadPolicy.modified, true);
  assert.equal(directPayloadPolicy.redactedSecrets, 1);
  assert.deepEqual(safeProviderHeaders({ authorization: "x", "retry-after": "1" }), { "retry-after": "1" });
  assert.deepEqual(summarizeProviderPayload({ model: "m", messages: [1, 2], tools: [1] }), {
    kind: "object",
    keys: ["messages", "model", "tools"],
    model: "m",
    max_tokens: null,
    message_count: 2,
    tool_count: 1,
    has_system: false,
  });
  assert.deepEqual(
    normalizeProviderUsage({
      model: "m",
      tokenUsage: { promptTokens: 7, completionTokens: 5 },
    }),
    {
      provider: null,
      model: "m",
      input_tokens: 7,
      output_tokens: 5,
      total_tokens: 12,
      cost_usd: null,
      source: "provider_usage",
    },
  );
  assert.deepEqual(
    estimateProviderUsageCost(
      { provider: "anthropic", model: "claude-estimated", input_tokens: 1000, output_tokens: 2000, total_tokens: 3000 },
      {
        checked_at: "2026-06-16T00:00:00.000Z",
        source_url: "https://example.com/provider-pricing",
        max_age_days: 30,
        rates: {
          "anthropic:claude-estimated": {
            input_per_million_tokens: 3,
            output_per_million_tokens: 15,
          },
        },
      },
      { now: new Date("2026-06-17T00:00:00.000Z") },
    ),
    {
      cost_usd: 0.033,
      source: "aipi_provider_pricing",
      pricing_ref: "anthropic:claude-estimated",
      pricing_checked_at: "2026-06-16T00:00:00.000Z",
      pricing_source_url: "https://example.com/provider-pricing",
    },
  );
  assert.equal(
    estimateProviderUsageCost(
      { provider: "anthropic", model: "claude-estimated", input_tokens: 1000, output_tokens: 2000, total_tokens: 3000 },
      {
        rates: {
          "anthropic:claude-estimated": {
            input_per_million_tokens: 3,
            output_per_million_tokens: 15,
          },
        },
      },
    ),
    null,
  );
  assert.equal(
    estimateProviderUsageCost(
      { provider: "anthropic", model: "claude-estimated", input_tokens: 1000, output_tokens: 2000, total_tokens: 3000 },
      {
        checked_at: "2026-01-01T00:00:00.000Z",
        source_url: "https://example.com/provider-pricing",
        max_age_days: 30,
        rates: {
          "anthropic:claude-estimated": {
            input_per_million_tokens: 3,
            output_per_million_tokens: 15,
          },
        },
      },
      { now: new Date("2026-06-17T00:00:00.000Z") },
    ),
    null,
  );
  const budgetReport = await buildProviderBudgetReport({
    projectRoot: tempRoot,
    usage: { provider: "anthropic", model: "claude-estimated" },
  });
  assert.equal(budgetReport.state, "over_budget");
  assert.equal(budgetReport.scope_ref, "anthropic:claude-estimated");
  assert.equal(normalizeProviderUsage({ status: 200 }), null);

  // Recent-run awareness: after a run goes terminal (no active pointer), the assistant must still be able
  // to answer "did you run tests / check the kanban" instead of acting like the conversation just started.
  const recentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-recent-run-"));
  try {
    const runId = "20260622T200133Z-260314";
    const runDir = path.join(recentRoot, ".aipi", "runtime", "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(recentRoot, ".aipi", "runtime-contract.json"), "{}"); // mark AIPI-installed
    await fs.writeFile(
      path.join(runDir, "state.json"),
      JSON.stringify({
        workflow: "bugfix",
        status: "escalated_to_human",
        step_visits: { triage: 1, regression_test: 1, fix: 4, verify: 3, review: 3 },
        steps: [
          { id: "triage", status: "passed", verdict: "PASS" },
          { id: "regression_test", status: "passed", verdict: "PASS" },
          { id: "fix", status: "passed", verdict: "PASS" },
          { id: "review", status: "failed", verdict: "FAIL" },
          { id: "memory_promotion", status: "pending" },
        ],
      }),
    );
    const recent = await buildRecentRunSummary(recentRoot);
    assert.ok(recent, "buildRecentRunSummary finds the most recent terminal run");
    assert.equal(recent.run_id, runId);
    assert.equal(recent.status, "escalated_to_human");
    assert.ok(recent.steps.some((s) => s.id === "regression_test" && s.status === "passed"), "tests step is captured");
    const rendered = renderRecentRunSummary(recent);
    assert.match(rendered, /regression_test/);
    assert.match(rendered, /escalated_to_human/);
    assert.match(rendered, /✗ review/);
    assert.match(rendered, /fix \(4\)/, "loop count is shown in the recent-run summary");
    assert.match(rendered, /Do NOT claim this is the first message/);
    // Integration (#7/#10): in the flexible flow (no active run) handleBeforeAgentStart injects a project
    // guidance context-pointer — project instructions + the project's Definition of Done — AND folds in the
    // recent-run summary so the agent can answer follow-ups.
    const hbas = await handleBeforeAgentStart({
      event: { type: "before_agent_start", prompt: "did you run tests?" },
      ctx: { model: { provider: "anthropic", id: "claude-opus-4-8" }, ui: { notify() {} } },
      pi: { appendEntry() {} },
      projectRoot: recentRoot,
      coordinator: { setHostModel() {}, getHostModel: () => null },
    });
    assert.ok(hbas?.message, "handleBeforeAgentStart returns a guidance pointer in the flexible flow");
    assert.equal(hbas.message.customType, "aipi.context-pointer");
    assert.equal(hbas.message.display, false);
    // #10: the agent is pointed to the project's procedures / Definition of Done (generic, not hardcoded).
    assert.match(hbas.message.content, /procedures\.md/);
    assert.match(hbas.message.content, /DEFINITION OF DONE/);
    // The recent run is folded in so the agent can answer follow-ups.
    assert.match(hbas.message.content, /regression_test/);
    assert.match(hbas.message.content, /Do NOT claim this is the first message/);
    // Status-aware: an escalated run is NOT mislabeled "completed".
    assert.doesNotMatch(hbas.message.content, /a COMPLETED run/);
    assert.match(hbas.message.content, /STOPPED for human review/);
    // Even with NO recent run, the flexible flow still injects the project guidance (so the agent always
    // knows the project's conventions + Definition of Done).
    const noRunRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-flex-guidance-"));
    await fs.mkdir(path.join(noRunRoot, ".aipi"), { recursive: true });
    await fs.writeFile(path.join(noRunRoot, ".aipi", "runtime-contract.json"), "{}"); // AIPI-installed
    const hbas2 = await handleBeforeAgentStart({
      event: { type: "before_agent_start", prompt: "fix the gestores navigation bug please" },
      ctx: { model: { provider: "anthropic", id: "claude-opus-4-8" }, ui: { notify() {} } },
      pi: { appendEntry() {} },
      projectRoot: noRunRoot,
      coordinator: { setHostModel() {}, getHostModel: () => null },
    });
    assert.equal(hbas2?.message?.customType, "aipi.context-pointer", "guidance is injected even with no recent run");
    assert.match(hbas2.message.content, /DEFINITION OF DONE/);
    assert.match(hbas2.message.content, /procedures\.md/);
    await fs.rm(noRunRoot, { recursive: true, force: true });
    // #4: a NON-AIPI project (no .aipi/runtime-contract.json) gets NOTHING — no pointer to nonexistent files.
    const nonAipiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-non-installed-"));
    const hbasNon = await handleBeforeAgentStart({
      event: { type: "before_agent_start", prompt: "fix something" },
      ctx: { model: { provider: "anthropic", id: "claude-opus-4-8" }, ui: { notify() {} } },
      pi: { appendEntry() {} },
      projectRoot: nonAipiRoot,
      coordinator: { setHostModel() {}, getHostModel: () => null },
    });
    assert.equal(hbasNon, undefined, "#4: a non-AIPI project gets no guidance pointer");
    await fs.rm(nonAipiRoot, { recursive: true, force: true });
    // A run older than the recency window is not surfaced.
    const aged = await buildRecentRunSummary(recentRoot, { maxAgeMs: 1, now: () => Date.now() + 10_000 });
    assert.equal(aged, null, "a stale run beyond the recency window is not surfaced");
    // No runs at all -> null.
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-no-run-"));
    assert.equal(await buildRecentRunSummary(emptyRoot), null);
    await fs.rm(emptyRoot, { recursive: true, force: true });
  } finally {
    await fs.rm(recentRoot, { recursive: true, force: true });
  }

  // P1 — the before_agent_start blast-radius probe is time-boxed and never blocks the agent on a slow graph
  // op. A slow impactFn past the budget yields a "deferred" pointer (agent starts now); a fast one yields
  // refs. The probe also opts out of building (buildIfMissing:false) so it can never abandon a write.
  {
    assert.equal(blastRadiusBudgetMs({ AIPI_BLAST_RADIUS_BUDGET_MS: "1500" }), 1500);
    assert.equal(blastRadiusBudgetMs({}), 2500, "default budget");
    assert.equal(blastRadiusBudgetMs({ AIPI_BLAST_RADIUS_BUDGET_MS: "garbage" }), 2500, "bad value -> default");
    // A huge value is clamped to the 32-bit setTimeout ceiling, not passed through (which would clamp to 1ms
    // and invert the budget — always "deferred").
    assert.equal(blastRadiusBudgetMs({ AIPI_BLAST_RADIUS_BUDGET_MS: "99999999999" }), 2 ** 31 - 1, "huge value clamped to 2^31-1");

    let sawBuildOptOut = null;
    const slowImpact = ({ buildIfMissing }) => {
      sawBuildOptOut = buildIfMissing;
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ graph: {}, refs: [{ path: "x.js" }], relationships: [] }), 200);
        if (typeof t?.unref === "function") t.unref();
      });
    };
    const deferred = await buildBlastRadiusPointer({
      projectRoot: tempRoot,
      query: "some query string",
      env: { AIPI_BLAST_RADIUS_BUDGET_MS: "20" },
      impactFn: slowImpact,
    });
    assert.equal(deferred.status, "deferred", "slow graph op past budget -> deferred, agent starts now");
    assert.equal(sawBuildOptOut, false, "probe must pass buildIfMissing:false so it never triggers a build");
    assert.deepEqual(deferred.refs, []);

    const fast = await buildBlastRadiusPointer({
      projectRoot: tempRoot,
      query: "some query string",
      env: { AIPI_BLAST_RADIUS_BUDGET_MS: "5000" },
      impactFn: () => Promise.resolve({ graph: { files: 1 }, refs: [{ path: "src/a.js", line: 3 }], relationships: [{ relation: "calls", source_ref: "a", target_ref: "b" }] }),
    });
    assert.equal(fast.status, "available");
    assert.equal(fast.refs[0].path, "src/a.js");
    assert.equal(fast.relationships[0].relation, "calls");

    // An empty query is skipped without touching the graph at all.
    const skipped = await buildBlastRadiusPointer({ projectRoot: tempRoot, query: "   " });
    assert.equal(skipped.status, "skipped");
  }

  // P2 — the finish-audit warning is high-precision: it fires only on a genuine COMPLETION claim with no
  // evidence, NOT on investigative narration that merely contains a claim-ish word, and at most once/turn.
  {
    const auditNotes = [];
    const auditEntries = [];
    const auditHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { auditEntries.push({ type, data }); } },
      projectRootResolver: () => tempRoot,
      coordinator: { setHostModel() {}, getHostModel: () => null },
    });
    const auditCtx = { ui: { notify: (message, kind) => auditNotes.push({ message, kind }) } };
    const msgEnd = (content) => invokeMessageEndWithHostContract(
      auditHandlers.message_end,
      { type: "message_end", message: { role: "assistant", content } },
      auditCtx,
    );
    const warnings = () => auditNotes.filter((n) => n.kind === "warning" && /evidence rung/i.test(n.message ?? ""));

    // Start a fresh turn so the per-project finish-audit dedupe (module state, possibly set by an earlier
    // block on the same root) is cleared.
    await auditHandlers.before_agent_start({ type: "before_agent_start", prompt: "start the audit-block turn" }, auditCtx);

    // Investigative narration that mentions how code behaves must NOT warn (the spam the user hit).
    await msgEnd("I'm tracing the save flow; clicking Salvar fails to save. The modal handler funciona quando o user está ativo. Vou localizar o código.");
    assert.equal(warnings().length, 0, "investigative message with a stray claim word does not warn");

    // A genuine unsupported completion claim DOES warn — once.
    await msgEnd("Corrigi o handler do save e está tudo resolvido.");
    assert.equal(warnings().length, 1, "an unsupported completion claim surfaces exactly one warning");

    // Dedupe: a second completion claim in the SAME turn does not double the warning.
    await msgEnd("Pronto, implementei e agora funciona.");
    assert.equal(warnings().length, 1, "the finish-audit warning is deduped to once per turn");

    // A new turn (before_agent_start) resets the dedupe so the next unsupported claim can surface again.
    await auditHandlers.before_agent_start({ type: "before_agent_start", prompt: "next task please" }, auditCtx);
    await msgEnd("Corrigido e funcionando.");
    assert.equal(warnings().length, 2, "a fresh turn re-arms the finish-audit warning");

    // An evidence-backed completion claim never warns.
    const before = warnings().length;
    await msgEnd("Corrigi o bug. Evidence: ran `npm test` -> passed.");
    assert.equal(warnings().length, before, "an evidence-backed completion claim does not warn");

    // CG-1: a real completion claim that ends with a courtesy question / "next" clause still warns (the
    // investigative exclusion is scoped to the LEAD sentence, not the whole message).
    await auditHandlers.before_agent_start({ type: "before_agent_start", prompt: "cg1 turn" }, auditCtx);
    let n = warnings().length;
    await msgEnd("Corrigi o save e tudo passou. Quer que eu rode o lint também?");
    assert.equal(warnings().length, n + 1, "CG-1: completion claim + trailing courtesy question still warns");

    await auditHandlers.before_agent_start({ type: "before_agent_start", prompt: "cg1b turn" }, auditCtx);
    n = warnings().length;
    await msgEnd("Fixed the parser and all tests pass now. Maybe I should also update docs.");
    assert.equal(warnings().length, n + 1, "CG-1: leading claim is not silenced by a later 'maybe'");

    // CG-3: PT done-participles/phrasings that are claim terms now also trip the completion gate.
    await auditHandlers.before_agent_start({ type: "before_agent_start", prompt: "cg3 turn" }, auditCtx);
    n = warnings().length;
    await msgEnd("Concluído. O comportamento esperado foi restaurado.");
    assert.equal(warnings().length, n + 1, "CG-3: 'concluído/restaurado' completion claim warns");

    // CG-2: descriptive / historical narration does NOT warn (no fresh completion).
    await auditHandlers.before_agent_start({ type: "before_agent_start", prompt: "cg2 turn" }, auditCtx);
    n = warnings().length;
    await msgEnd("The flow works like this: the controller calls save, which is already implemented.");
    await msgEnd("Esse código foi corrigido na PR anterior, mas o bug voltou.");
    assert.equal(warnings().length, n, "CG-2: descriptive/historical narration does not warn");
  }

  // Stall heartbeat — make a silent/hung turn VISIBLE (a model send can hang before it's even dispatched, so
  // nothing logs and the host shows a mute "working…"). The formatter is pure; the state machine is driven
  // with a controlled clock + a fake setStatus sink.
  {
    const soft = 45_000;
    const hard = 150_000;
    // formatter: below soft -> null; above soft -> idle line; pending model -> waiting-on-model wording; above hard -> escalated.
    assert.equal(formatStallStatus({ idleMs: 10_000, softMs: soft, hardMs: hard }), null, "within the soft window: no status");
    assert.match(formatStallStatus({ idleMs: 60_000, softMs: soft, hardMs: hard }), /sem atividade.*há 60s/);
    assert.match(formatStallStatus({ idleMs: 60_000, pendingModelMs: 60_000, softMs: soft, hardMs: hard }), /esperando resposta do modelo.*há 60s/);
    assert.doesNotMatch(formatStallStatus({ idleMs: 60_000, softMs: soft, hardMs: hard }), /Esc para cancelar/);
    assert.match(formatStallStatus({ idleMs: 200_000, softMs: soft, hardMs: hard }), /Esc para cancelar e reenviar/);
    // UI-1: a LONG but healthy model response (request in flight, past the hard threshold) must NOT tell the
    // user to cancel — it's a normal slow generation, not a hang. Only a pre-send idle escalates to "Esc".
    assert.doesNotMatch(formatStallStatus({ idleMs: 200_000, pendingModelMs: 200_000, softMs: soft, hardMs: hard }), /Esc para cancelar/, "UI-1: a long model response never says to cancel");
    assert.match(formatStallStatus({ idleMs: 200_000, pendingModelMs: 200_000, softMs: soft, hardMs: hard }), /esperando resposta do modelo há 200s/);
    // UI-3: a sub-floor threshold env value is ignored in favor of the default (won't spam every pause).
    assert.equal(formatStallStatus({ idleMs: 3_000, softMs: 45_000, hardMs: 150_000 }), null);

    const statusCalls = [];
    const hbCtx = { ui: { setStatus: (key, text) => statusCalls.push({ key, text }) } };
    const hb = new StallHeartbeat({ env: { AIPI_STALL_SOFT_MS: "45000", AIPI_STALL_HARD_MS: "150000" } });
    let clock = 1_000_000;
    hb.arm(hbCtx, clock);

    hb.tick(clock + 10_000); // idle 10s -> within soft, nothing surfaced
    assert.equal(statusCalls.length, 0, "no status within the soft window");

    hb.tick(clock + 60_000); // idle 60s -> surfaces "sem atividade"
    assert.equal(statusCalls.length, 1);
    assert.match(statusCalls[0].text, /sem atividade.*há 60s/);
    assert.equal(statusCalls[0].key, "aipi.stall.heartbeat");

    hb.tick(clock + 200_000); // idle 200s -> escalated wording
    assert.match(statusCalls.at(-1).text, /Esc para cancelar e reenviar/);

    // A model request is sent (touch + pending), then the response hangs -> waiting-on-model wording.
    hb.modelRequestStarted(clock + 210_000);
    hb.tick(clock + 270_000); // 60s since the request, no response
    assert.match(statusCalls.at(-1).text, /esperando resposta do modelo/);

    // Activity resumes -> the stall status is cleared (text undefined).
    const beforeTouch = statusCalls.length;
    hb.touch(clock + 271_000);
    assert.ok(statusCalls.length > beforeTouch && statusCalls.at(-1).text === undefined, "touch clears a surfaced stall status");

    // Disarm clears and stops; a tick after disarm does nothing.
    hb.modelResponded(clock + 272_000);
    hb.disarm();
    const afterDisarm = statusCalls.length;
    hb.tick(clock + 999_000);
    assert.equal(statusCalls.length, afterDisarm, "no status updates after disarm");

    // Headless ctx (no setStatus) -> arm is a no-op, never throws.
    const headless = new StallHeartbeat();
    headless.arm({ ui: {} }, clock);
    headless.tick(clock + 200_000);
    headless.disarm();

    // FF-1: turn_end is fired per agent-loop turn (many per prompt), so updateStallHeartbeat must route it to
    // TOUCH, not disarm — only agent_end ends the prompt. Drive the real hook routing and inspect armed state.
    const ffCtx = { ui: { setStatus: () => {} } };
    updateStallHeartbeat({ hook: "before_agent_start", ctx: ffCtx, projectRoot: tempRoot });
    const hbRoot = getStallHeartbeat(tempRoot);
    assert.equal(hbRoot.armed, true, "armed on before_agent_start");
    updateStallHeartbeat({ hook: "turn_end", ctx: ffCtx, projectRoot: tempRoot });
    assert.equal(hbRoot.armed, true, "FF-1: turn_end keeps the heartbeat armed (it is mid-loop, not end-of-prompt)");
    updateStallHeartbeat({ hook: "message_end", ctx: ffCtx, projectRoot: tempRoot });
    assert.equal(hbRoot.armed, true, "message_end keeps it armed too");
    updateStallHeartbeat({ hook: "agent_end", ctx: ffCtx, projectRoot: tempRoot });
    assert.equal(hbRoot.armed, false, "agent_end ends the prompt and disarms");

    // RS-3: the heartbeat gate keys on an installed AIPI project (tempRoot was init'd); a bare dir is not one.
    assert.equal(looksLikeAipiProject(tempRoot), true);
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-not-a-project-"));
    try {
      assert.equal(looksLikeAipiProject(bareDir), false, "RS-3: a non-AIPI project is not gated in");
      // updateStallHeartbeat on a non-AIPI root is a no-op (never arms / never throws).
      updateStallHeartbeat({ hook: "before_agent_start", ctx: ffCtx, projectRoot: bareDir });
    } finally {
      await fs.rm(bareDir, { recursive: true, force: true });
    }
  }

  console.log("AIPI_LIFECYCLE_HOOKS_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function assertWorkflowSuggestion(route, workflow) {
  assert.equal(route.intent, "suggest_workflow");
  assert.equal(route.workflowSuggestion, workflow);
  assert.equal(route.suggestedCommand, `/aipi-workflow run ${workflow}`);
  assert.equal(Object.hasOwn(route, "workflowArgs"), false);
}

function assertWorkflowDispatch(route, workflow, classification) {
  assert.equal(route.intent, "auto_dispatch_workflow");
  assert.equal(route.workflowSuggestion, workflow);
  assert.equal(route.workflowArgs, `run ${workflow}`);
  assert.equal(route.autoDispatch, true);
  assert.equal(route.recordInputAfterDispatch, true);
  assert.equal(route.pipelineClassification, classification);
  assert.equal(Object.hasOwn(route, "suggestedCommand"), false);
}

async function invokeMessageEndWithHostContract(handler, event, ctx) {
  const result = await handler(event, ctx);
  if (result === undefined) return undefined;
  const role = event?.message?.role;
  const returnedMessage = result?.message ?? result;
  assert.equal(
    returnedMessage?.role,
    role,
    "message_end handlers must return undefined or a message with the same role",
  );
  return result;
}

async function forceFastSemanticFallback(projectRoot) {
  const configPath = path.join(projectRoot, ".aipi", "semantic-memory.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, ollama_host: "http://127.0.0.1:9" }, null, 2)}\n`,
  );
}
