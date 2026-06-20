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
  buildProviderBudgetReport,
  classifyAipiCodePipeline,
  classifyAipiInputRoute,
  createAipiLifecycleHandlers,
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
  assertWorkflowSuggestion(classifyAipiInputRoute("planejar regra de negocio"), "planning");
  assertWorkflowSuggestion(classifyAipiInputRoute("corrigir bug no login"), "bugfix");
  assertWorkflowSuggestion(classifyAipiInputRoute("pesquisar docs do provider"), "research");
  assertWorkflowSuggestion(classifyAipiInputRoute("deploy em homolog"), "ops");
  assertWorkflowSuggestion(classifyAipiInputRoute("implementar nova tela"), "feature");
  assertWorkflowSuggestion(classifyAipiInputRoute("pequeno ajuste"), "quick");
  assert.equal(classifyAipiInputRoute("review adversarial", { activeRun: started }).workflowArgs, "execute");
  assertWorkflowSuggestion(classifyAipiInputRoute("review adversarial", { activeRun: null }), "planning");
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
  const bugPipeline = classifyAipiCodePipeline("corrigir bug no login");
  assert.equal(bugPipeline.classification, "root_cause_bugfix");
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
  assert.deepEqual(featurePipeline.stages, ["plan", "adversarial_review", "diff_review"]);
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
    const routerHandlers = createAipiLifecycleHandlers({
      pi: { appendEntry(type, data) { routerEntries.push({ type, data }); } },
      projectRootResolver: () => routerRoot,
      workflowCommandRunner: async (input) => {
        routerRunnerCalls.push(input);
        return { action: "unexpected" };
      },
    });
    for (const text of ["deploy no CI", "corrigir bug no login", "pipeline quebrou no deploy"]) {
      const result = await routerHandlers.input(
        { type: "input", text, source: "interactive" },
        { cwd: routerRoot, ui: { notify(message, kind) { routerNotifications.push({ message, kind }); } } },
      );
      assert.deepEqual(result, { action: "continue" });
    }
    assert.equal(routerRunnerCalls.length, 0);
    assert.equal(routerNotifications.length, 3);
    assert.match(routerNotifications[0].message, /\/aipi-workflow run ops/);
    assert.match(routerNotifications[1].message, /\/aipi-workflow run bugfix/);
    const deployTrace = routerEntries.find(
      (entry) => entry.type === "aipi.code_pipeline.trace" && entry.data.classification === "deploy_precheck",
    );
    assert.equal(deployTrace.data.precheck.checks.includes("rollback_readiness"), true);
    assert.equal(deployTrace.data.deploy_confirmation.required, true);
    assert.equal(deployTrace.data.deploy_confirmation.blocks_chat_or_editing, false);
    const bugTrace = routerEntries.find(
      (entry) => entry.type === "aipi.code_pipeline.trace" && entry.data.classification === "root_cause_bugfix",
    );
    assert.equal(bugTrace.data.stages.includes("verify_hypotheses"), true);
    assert.equal(bugTrace.data.root_cause.confirm_before_fix, true);
    await assert.rejects(
      () => fs.access(path.join(routerRoot, ".aipi", "runtime", "runs", "active")),
      /ENOENT/,
    );
    const explicit = await runWorkflowCommand({ args: "run bugfix", projectRoot: routerRoot });
    assert.equal(explicit.action, "run");
    assert.equal((await readActiveRun(routerRoot)).state.workflow, "bugfix");
  } finally {
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
    current_model: { provider: "openai", id: "manual" },
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

async function forceFastSemanticFallback(projectRoot) {
  const configPath = path.join(projectRoot, ".aipi", "semantic-memory.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, ollama_host: "http://127.0.0.1:9" }, null, 2)}\n`,
  );
}
