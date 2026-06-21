import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  SUBAGENT_EVENT_ENTRY,
  SUBAGENT_STATE_ENTRY,
  SubagentCoordinator,
  buildWorkerPrompt,
  buildWorkerTools,
  latestSubagentStateFromEntries,
  parseWorkerStepResult,
} from "../extensions/aipi/runtime/subagents.js";
import {
  AIPI_SUBAGENTS_AGENT_NAME,
  AIPI_SUBAGENTS_RUNTIME_ROOT,
  assertAipiHostScopedModel,
  createAipiSubagentsRunner,
  projectSubagentsRuntimePaths,
  runAipiForkedSubagent,
  runPiSubagentsLiveSpike,
} from "../extensions/aipi/runtime/pi-subagents.js";
import registerAipiGuardedWriteChild from "../extensions/aipi/runtime/aipi-guarded-write-child.js";
import { OwnedFileRegistry } from "../extensions/aipi/runtime/owned-files.js";

const require = createRequire(import.meta.url);

const stepResult = {
  schema: "aipi.step-result.v1",
  step_id: "review_swarm",
  agent_ids: ["reviewer:fake"],
  verdict: "PASS",
  evidence: [
    {
      rung: "ran",
      source: "forked-pi-subagents-fake",
      ref: "worker prompt",
      result: "structured response emitted",
    },
  ],
  artifacts: [".aipi/runtime/runs/run-1/steps/review_swarm/RESULT.md"],
};

assert.deepEqual(
  parseWorkerStepResult(`prose before\n\`\`\`json\n${JSON.stringify(stepResult)}\n\`\`\``),
  stepResult,
);

const prompt = buildWorkerPrompt({
  agentId: "reviewer:prompt",
  descriptor: {
    agent_id: "reviewer",
    model_class: "code-strong",
    context_packet: "BDD: subscription renewal keeps the current price.",
    owned_files: ["src/renewal.js"],
    artifact_target: ".aipi/runtime/runs/run-1/steps/review_swarm",
  },
});
assert.match(prompt, /AIPI worker id: reviewer:prompt/);
assert.match(prompt, /BDD: subscription renewal keeps the current price/);
assert.match(prompt, /Return only JSON/);

const registry = new OwnedFileRegistry(process.cwd());
registry.allocate("reviewer:tools", ["src/owned.js"]);
const rawWrites = [];
const toolTraceEvents = [];
const { customTools, toolNames } = buildWorkerTools(fakeSdk({ rawWrites }), {
  root: process.cwd(),
  registry,
  agentId: "reviewer:tools",
  trace(event, data) {
    toolTraceEvents.push({ event, data });
  },
});
assert.deepEqual(new Set(toolNames), new Set(["read", "grep", "write"]));

const guardedWrite = customTools.find((tool) => tool.name === "write");
assert.equal(
  (await guardedWrite.execute("blocked", { path: "src/not-owned.js", content: "x" })).isError,
  true,
);
assert.equal(rawWrites.length, 0);
await guardedWrite.execute("ok", { path: "src/owned.js", content: "x" });
assert.deepEqual(rawWrites, [{ path: "src/owned.js", content: "x" }]);
assert.equal(toolTraceEvents.filter((entry) => entry.event === "tool_start" && entry.data.tool_name === "write").length, 2);
assert.equal(toolTraceEvents.filter((entry) => entry.event === "tool_end" && entry.data.tool_name === "write").length, 2);
assert.equal(toolTraceEvents.some((entry) => entry.event === "tool_end" && entry.data.is_error === true), true);

assert.doesNotThrow(() => assertAipiHostScopedModel("anthropic/claude-opus-4-8"));
assert.doesNotThrow(() => assertAipiHostScopedModel("openai/gpt-5.5"));
assert.doesNotThrow(() => assertAipiHostScopedModel("codex/gpt-5.5-codex"));
assert.throws(() => assertAipiHostScopedModel("host-default", { requireProvider: true }), /provider-qualified host model/);
assert.throws(() => assertAipiHostScopedModel(null, { requireProvider: true }), /provider-qualified host model/);
assert.throws(() => assertAipiHostScopedModel("bedrock/claude-opus-4-8"), /non-host provider/);
assert.throws(() => assertAipiHostScopedModel("deepseek/deepseek-r1"), /non-host provider/);
assert.throws(() => assertAipiHostScopedModel("zai/glm-4.5"), /non-host provider/);
assert.throws(() => assertAipiHostScopedModel("openai/gpt-5.5", { allowedProvider: "anthropic" }), /only allow host provider anthropic/);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-paths-"));
try {
  const paths = projectSubagentsRuntimePaths(tempRoot, "reviewer:fake");
  const expectedRuntime = path.join(tempRoot, AIPI_SUBAGENTS_RUNTIME_ROOT);
  assert.equal(paths.runtimeRoot, expectedRuntime);
  assert.equal(paths.agentDir.startsWith(expectedRuntime), true);
  assert.equal(paths.sessionsDir.startsWith(expectedRuntime), true);
  assert.equal(paths.artifactsDir.startsWith(expectedRuntime), true);
  assert.equal(paths.resultsDir.startsWith(expectedRuntime), true);
  assert.equal(paths.asyncDir.startsWith(expectedRuntime), true);
  assert.equal(paths.runtimeRoot.includes(path.join(os.homedir(), ".pi")), false);
  assert.equal(typeof createAipiSubagentsRunner({ root: tempRoot }).spawn, "function");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;
const realRuntimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-real-runtime-"));
const realRuntimeCalls = [];
try {
  childProcess.spawn = makeSpawnStub(realRuntimeCalls, (call) => {
    writeJsonLine(call.proc.stdout, assistantStopEvent("OK"));
    closeFakeProcess(call.proc, 0, null);
  });
  const forkedResult = await runAipiForkedSubagent({
    root: realRuntimeRoot,
    params: {
      id: "real-runtime",
      task: "Reply OK.",
      model: { provider: "anthropic", id: "claude-opus-4-8" },
      owned_files: ["src/real-runtime.js"],
    },
  });
  assert.equal(realRuntimeCalls.length, 1);
  assert.equal(realRuntimeCalls[0].options.cwd, realRuntimeRoot);
  assertUnder(realRuntimeRoot, forkedResult.aipi_runtime.runtime_root);
  assertUnder(realRuntimeRoot, forkedResult.aipi_runtime.agent_dir);
  assertUnder(realRuntimeRoot, forkedResult.aipi_runtime.session_dir);
  assertUnder(realRuntimeRoot, forkedResult.aipi_runtime.artifacts_dir);
  assert.equal(forkedResult.aipi_runtime.runtime_root.includes(path.join(os.homedir(), ".pi")), false);
  assert.equal(forkedResult.artifacts.length > 0, true);
  for (const artifact of forkedResult.artifacts) {
    assertUnder(realRuntimeRoot, artifact);
    await fs.access(artifact);
  }
  const spawnedArgs = realRuntimeCalls[0].args;
  assert.equal(spawnedArgs.includes("--model"), true);
  assert.equal(spawnedArgs[spawnedArgs.indexOf("--model") + 1], "anthropic/claude-opus-4-8");
  assert.deepEqual(spawnedTools(spawnedArgs), ["read", "grep", "find", "ls"]);
  assert.equal(spawnedTools(spawnedArgs).some((tool) => /^(bash|shell|exec)$/i.test(tool)), false);
  assert.equal(spawnedArgs.includes("--no-extensions"), true);
  assert.equal(
    spawnedArgs.some((arg) => String(arg).replaceAll("\\", "/").endsWith("extensions/aipi/runtime/aipi-guarded-write-child.js")),
    true,
  );

  const defaultRunnerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-default-runner-"));
  try {
    await createAipiSubagentsRunner({ root: defaultRunnerRoot }).spawn({
      id: "default-runtime",
      task: "Reply OK.",
      model: "anthropic/claude-opus-4-8",
    });
    assert.equal(realRuntimeCalls.length, 2);
    assert.equal(realRuntimeCalls[1].options.cwd, defaultRunnerRoot);
  } finally {
    await fs.rm(defaultRunnerRoot, { recursive: true, force: true });
  }

  const noModelRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-no-model-"));
  try {
    await assert.rejects(
      () => runAipiForkedSubagent({ root: noModelRoot, params: { id: "no-model", task: "no model" } }),
      /provider-qualified host model/,
    );
    assert.equal(realRuntimeCalls.length, 2);
  } finally {
    await fs.rm(noModelRoot, { recursive: true, force: true });
  }
} finally {
  childProcess.spawn = originalSpawn;
  await fs.rm(realRuntimeRoot, { recursive: true, force: true });
}

const budgetRuntimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-budget-runtime-"));
const budgetRuntimeCalls = [];
try {
  childProcess.spawn = makeSpawnStub(budgetRuntimeCalls, (call) => {
    writeJsonLine(call.proc.stdout, { type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
    writeJsonLine(call.proc.stdout, { type: "tool_execution_start", toolName: "grep", args: { pattern: "AIPI" } });
  });
  await assert.rejects(
    () => runAipiForkedSubagent({
      root: budgetRuntimeRoot,
      params: {
        id: "budget-runtime",
        task: "Use too many tools.",
        model: "anthropic/claude-opus-4-8",
        max_tool_calls: 1,
      },
    }),
    /maxToolCalls 1 \(observed 2\)/,
  );
  assert.equal(budgetRuntimeCalls.length, 1);
  assert.equal(budgetRuntimeCalls[0].proc.killed, true);
  assert.equal(budgetRuntimeCalls[0].proc.killSignal, "SIGINT");
} finally {
  childProcess.spawn = originalSpawn;
  await fs.rm(budgetRuntimeRoot, { recursive: true, force: true });
}

const guardedChildWriteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-guarded-write-child-"));
const previousGuardEnv = {
  AIPI_SUBAGENTS_PROJECT_ROOT: process.env.AIPI_SUBAGENTS_PROJECT_ROOT,
  AIPI_SUBAGENTS_OWNED_FILES: process.env.AIPI_SUBAGENTS_OWNED_FILES,
  AIPI_SUBAGENTS_AGENT_ID: process.env.AIPI_SUBAGENTS_AGENT_ID,
};
try {
  const registeredTools = [];
  process.env.AIPI_SUBAGENTS_PROJECT_ROOT = guardedChildWriteRoot;
  process.env.AIPI_SUBAGENTS_AGENT_ID = "guarded:child";
  process.env.AIPI_SUBAGENTS_OWNED_FILES = JSON.stringify(["src/owned-child.js", ".aipi/memory/nope.md"]);
  registerAipiGuardedWriteChild({
    registerTool(tool) {
      registeredTools.push(tool);
    },
  });
  const childWrite = registeredTools.find((tool) => tool.name === "write");
  assert.ok(childWrite, "expected guarded child write tool to register");
  assert.equal(
    (await childWrite.execute("blocked", { path: "src/not-owned-child.js", content: "x" })).isError,
    true,
  );
  await assert.rejects(
    () => fs.access(path.join(guardedChildWriteRoot, "src", "not-owned-child.js")),
    /ENOENT/,
  );
  await childWrite.execute("ok", { path: "src/owned-child.js", content: "owned" });
  assert.equal(await fs.readFile(path.join(guardedChildWriteRoot, "src", "owned-child.js"), "utf8"), "owned");
  assert.equal(
    (await childWrite.execute("memory", { path: ".aipi/memory/nope.md", content: "x" })).isError,
    true,
  );
  await assert.rejects(
    () => childWrite.execute("escape", { path: "../outside.js", content: "x" }),
    /escapes project root/,
  );
} finally {
  for (const [key, value] of Object.entries(previousGuardEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(guardedChildWriteRoot, { recursive: true, force: true });
}

const piEntries = [];
const piSubagentsCalls = [];
const coordinatorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-coordinator-"));
const reviewSource = "import { renewSubscription } from './renewal.js';\nexport function reviewRenewal() {\n  return renewSubscription();\n}\n";
const renewalSource = "export function renewSubscription() {\n  return 'price preserved';\n}\n";
await fs.mkdir(path.join(coordinatorRoot, "src"), { recursive: true });
await fs.mkdir(path.join(coordinatorRoot, ".aipi", "state"), { recursive: true });
await fs.writeFile(path.join(coordinatorRoot, "src", "review.js"), reviewSource);
await fs.writeFile(path.join(coordinatorRoot, "src", "renewal.js"), renewalSource);
await fs.writeFile(
  path.join(coordinatorRoot, ".aipi", "state", "aipi-graph.json"),
  `${JSON.stringify({
    schema: "aipi.code-graph.v1",
    built_at: "2026-06-21T00:00:00.000Z",
    source: "sqlite+lexical",
    stale: false,
    files: [
      graphFile("src/review.js", reviewSource),
      graphFile("src/renewal.js", renewalSource),
    ],
    symbols: [
      { path: "src/review.js", name: "reviewRenewal", kind: "function", line: 2 },
      { path: "src/renewal.js", name: "renewSubscription", kind: "function", line: 1 },
    ],
    relationships: [
      {
        source_kind: "file",
        source_ref: "src/review.js",
        relation: "calls",
        target_kind: "symbol",
        target_ref: "renewSubscription",
        evidence: "references symbol defined in src/renewal.js",
      },
      {
        source_kind: "file",
        source_ref: "src/renewal.js",
        relation: "defines",
        target_kind: "symbol",
        target_ref: "renewSubscription",
        evidence: "line 1",
      },
    ],
    run_outcomes: [],
    sqlite: { path: ".aipi/state/aipi-graph.sqlite", status: "unavailable", engine: "node:sqlite" },
    vector: { status: "unavailable", engine: "sqlite-vec", dimensions: 1024, embedding_model: "bge-m3" },
  }, null, 2)}\n`,
);
const coordinator = new SubagentCoordinator(
  {
    appendEntry(name, value) {
      piEntries.push({ name, value });
    },
  },
  {
    root: coordinatorRoot,
    maxConcurrent: 1,
    env: {},
    piSubagentsRunner: {
      async spawn(params, options = {}) {
        piSubagentsCalls.push({ params, options });
        const agentId = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "unknown";
        const evidenceFile = params.owned_files?.[0] ?? "src/review.js";
        await writeEvidenceFile(options.ctx?.project_root ?? coordinatorRoot, evidenceFile, "fake forked evidence");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...stepResult,
                agent_ids: [agentId],
                artifacts: [evidenceFile],
              }),
            },
          ],
          artifacts: [evidenceFile],
          tool_call_count: 2,
          exit_code: 0,
          run_id: "fake-forked-run",
          aipi_runtime: {
            cwd: coordinatorRoot,
            runtime_root: path.join(coordinatorRoot, AIPI_SUBAGENTS_RUNTIME_ROOT),
            agent_dir: path.join(coordinatorRoot, AIPI_SUBAGENTS_RUNTIME_ROOT, "agent"),
            session_dir: path.join(coordinatorRoot, AIPI_SUBAGENTS_RUNTIME_ROOT, "sessions", "fake"),
            artifacts_dir: path.join(coordinatorRoot, AIPI_SUBAGENTS_RUNTIME_ROOT, "artifacts"),
          },
        };
      },
    },
  },
);

const { agent_id: agentId } = coordinator.spawn({
  agent_id: "reviewer",
  model_class: "code-strong",
  model: { provider: "anthropic", id: "claude-opus-4-8" },
  step_id: "review_swarm",
  context_packet: "BDD: renewal preserves price.",
  owned_files: ["src/review.js"],
});
await waitFor(() => coordinator.status(agentId).state === "done");
const collect = coordinator.collect(agentId);

assert.equal(collect.ready, true);
assert.equal(collect.step_result.schema, "aipi.step-result.v1");
assert.equal(collect.step_result.verdict, "PASS");
assert.equal(collect.step_result.model_resolved, "anthropic/claude-opus-4-8");
assert.equal(coordinator.status(agentId).tool_call_count, 2);
assert.equal(piSubagentsCalls.length, 1);
assert.equal(piSubagentsCalls[0].params.agent, AIPI_SUBAGENTS_AGENT_NAME);
assert.equal(piSubagentsCalls[0].params.async, false);
assert.equal(piSubagentsCalls[0].params.context, "fresh");
assert.deepEqual(piSubagentsCalls[0].params.model, { provider: "anthropic", id: "claude-opus-4-8" });
assert.deepEqual(piSubagentsCalls[0].params.owned_files, ["src/review.js"]);
assert.match(piSubagentsCalls[0].params.task, /AIPI worker id:/);
assert.match(piSubagentsCalls[0].params.task, /AIPI injected context:/);
assert.match(piSubagentsCalls[0].params.task, /memory_refs: \.aipi\/memory\/project\/business-rules\.md/);
assert.match(piSubagentsCalls[0].params.task, /blast_radius_seeds: src\/review\.js/);
assert.match(piSubagentsCalls[0].params.task, /AIPI deterministic retrieval prefetch:/);
assert.match(piSubagentsCalls[0].params.task, /"source": "aipi_retrieve"/);
assert.match(piSubagentsCalls[0].params.task, /"status": "available"/);
assert.match(piSubagentsCalls[0].params.task, /"path": "src\/review\.js"/);
assert.match(piSubagentsCalls[0].params.task, /"relation": "calls"/);
assert.match(piSubagentsCalls[0].params.task, /"target_ref": "renewSubscription"/);
const prefetchPayload = JSON.parse(
  piSubagentsCalls[0].params.task.match(
    /AIPI deterministic retrieval prefetch:\n([\s\S]*?)\nAIPI follow-up hint:/,
  )?.[1] ?? "null",
);
assert.equal(prefetchPayload.source, "aipi_retrieve");
const graphRelationshipKeys = new Set([
  "file|src/review.js|calls|symbol|renewSubscription",
  "file|src/renewal.js|defines|symbol|renewSubscription",
]);
const prefetchRelationshipKeys = prefetchPayload.relationships.map((edge) =>
  [edge.source_kind, edge.source_ref, edge.relation, edge.target_kind, edge.target_ref].join("|"),
);
assert.equal(prefetchRelationshipKeys.includes("file|src/review.js|calls|symbol|renewSubscription"), true);
assert.equal(prefetchRelationshipKeys.every((key) => graphRelationshipKeys.has(key)), true);
assert.equal(
  piEntries.some(
    (entry) =>
      entry.name === SUBAGENT_EVENT_ENTRY &&
      entry.value.event === "worker_context_prefetch" &&
      entry.value.status === "available" &&
      entry.value.relationship_count > 0,
  ),
  true,
);
assert.equal(piSubagentsCalls[0].options.ctx.aipi_backend, "pi_subagents");
assert.equal(piEntries.some((entry) => entry.name === SUBAGENT_STATE_ENTRY), true);
assert.equal(piEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "queued"), true);
assert.equal(piEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "started"), true);
assert.equal(piEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "aipi_forked_subagent_start"), true);
assert.equal(
  piEntries.some(
    (entry) =>
      entry.name === SUBAGENT_EVENT_ENTRY &&
      entry.value.event === "aipi_forked_subagent_end" &&
      entry.value.pi_subagents_run_id === "fake-forked-run",
  ),
  true,
);
assert.equal(piEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "done"), true);
assert.equal(piEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "worker_cleanup"), true);
assert.equal(piEntries.some((entry) => entry.value?.event === "pi_subagents_worker_start"), false);
assert.equal(
  latestPiState(piEntries).jobs[0].harnessHandle.runtime_root.replaceAll("\\", "/").endsWith(AIPI_SUBAGENTS_RUNTIME_ROOT),
  true,
);

assert.throws(
  () =>
    coordinator.spawn({
      agent_id: "rpc",
      step_id: "old_backend",
      context_packet: "BDD: old backends are gone.",
      owned_files: ["src/rpc.js"],
      isolation: ["rpc", "worker", "process"].join("_"),
    }),
  /supports only the forked pi_subagents runtime/,
);
assert.throws(
  () =>
    coordinator.spawn({
      agent_id: "cwd",
      step_id: "cwd",
      context_packet: "BDD: worker cwd is project root.",
      owned_files: ["src/cwd.js"],
      cwd: "tmp/worker",
    }),
  /project root; per-worker cwd is unsupported/,
);
assert.throws(
  () =>
    coordinator.spawn({
      agent_id: "bedrock",
      step_id: "model",
      context_packet: "BDD: non-host providers are blocked.",
      owned_files: ["src/bedrock.js"],
      model: { provider: "bedrock", id: "claude-opus-4-8" },
    }),
  /non-host provider/,
);
assert.throws(
  () =>
    coordinator.spawn({
      agent_id: "no-model",
      step_id: "model",
      context_packet: "BDD: worker model scoping is fail-closed.",
      owned_files: ["src/no-model.js"],
    }),
  /provider-qualified host model/,
);

const cleanup = coordinator.cleanup();
assert.equal(cleanup.schema, "aipi.subagents.cleanup.v1");
assert.equal(cleanup.removed_agents, 1);
assert.deepEqual(cleanup.removed.map((entry) => entry.agent_id), [agentId]);
assert.equal(cleanup.retained_agents, 0);
assert.equal(cleanup.durable_memory_deleted, false);
assert.throws(() => coordinator.status(agentId), /unknown agent/);
assert.equal(piEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "cleanup"), true);
await fs.rm(coordinatorRoot, { recursive: true, force: true });

const weakEvidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-weak-pass-"));
try {
  const weakEvidenceCoordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root: weakEvidenceRoot,
      maxConcurrent: 1,
      piSubagentsRunner: {
        async spawn(params) {
          const agentId = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "unknown";
          return {
            content: [{ type: "text", text: JSON.stringify({ ...stepResult, agent_ids: [agentId], artifacts: [] }) }],
            artifacts: [],
            tool_call_count: 0,
            exit_code: 0,
          };
        },
      },
    },
  );
  const { agent_id: weakAgentId } = weakEvidenceCoordinator.spawn({
    agent_id: "weak-pass",
    step_id: "review_swarm",
    context_packet: "BDD: weak self-stamped PASS is downgraded.",
    owned_files: ["src/weak-pass.js"],
    model: { provider: "anthropic", id: "claude-opus-4-8" },
  });
  await waitFor(() => weakEvidenceCoordinator.status(weakAgentId).state === "done");
  const weakCollect = weakEvidenceCoordinator.collect(weakAgentId);
  assert.equal(weakCollect.ready, true);
  assert.equal(weakCollect.step_result.verdict, "BLOCKED");
  assert.equal(weakCollect.step_result.aipi_verdict_downgraded, true);
  assert.match(weakCollect.step_result.aipi_verdict_downgrade_reason, /no named artifact/);
} finally {
  await fs.rm(weakEvidenceRoot, { recursive: true, force: true });
}

const timeoutEntries = [];
const timeoutCoordinator = new SubagentCoordinator(
  {
    appendEntry(name, value) {
      timeoutEntries.push({ name, value });
    },
  },
  {
    root: process.cwd(),
    maxConcurrent: 1,
    hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
    piSubagentsRunner: {
      async spawn(_params, options = {}) {
        await new Promise((resolve, reject) => {
          options.signal?.addEventListener?.("abort", () => reject(new Error("aborted")), { once: true });
          setTimeout(resolve, 50);
        });
        return { content: [{ type: "text", text: JSON.stringify(stepResult) }], tool_call_count: 0 };
      },
    },
  },
);
const { agent_id: timeoutAgentId } = timeoutCoordinator.spawn({
  agent_id: "slow",
  step_id: "review_swarm",
  context_packet: "BDD: timeout path.",
  owned_files: ["src/slow.js"],
  budget: { timeout_ms: 1 },
});
await waitFor(() => timeoutCoordinator.status(timeoutAgentId).state === "cancelled");
assert.equal(timeoutCoordinator.status(timeoutAgentId).abort_reason, "budget_timeout");
assert.match(timeoutCoordinator.status(timeoutAgentId).error, /budget timeout|aborted/);
assert.equal(timeoutCoordinator.collect(timeoutAgentId).ready, false);
assert.equal(timeoutEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "budget_timeout"), true);
assert.equal(timeoutEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "cancelled"), true);

const toolBudgetEntries = [];
const toolBudgetCoordinator = new SubagentCoordinator(
  {
    appendEntry(name, value) {
      toolBudgetEntries.push({ name, value });
    },
  },
  {
    root: process.cwd(),
    maxConcurrent: 1,
    hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
    piSubagentsRunner: {
      async spawn() {
        return { content: [{ type: "text", text: JSON.stringify(stepResult) }], tool_call_count: 3 };
      },
    },
  },
);
const { agent_id: toolBudgetAgentId } = toolBudgetCoordinator.spawn({
  agent_id: "tool-budget",
  step_id: "review_swarm",
  context_packet: "BDD: tool budget path.",
  owned_files: ["src/tool-budget.js"],
  budget: { max_tool_calls: 1 },
});
await waitFor(() => toolBudgetCoordinator.status(toolBudgetAgentId).state === "failed");
assert.equal(toolBudgetCoordinator.status(toolBudgetAgentId).abort_reason, "budget_max_tool_calls");
assert.equal(toolBudgetCoordinator.status(toolBudgetAgentId).tool_call_count, 3);
assert.equal(toolBudgetCoordinator.collect(toolBudgetAgentId).ready, false);
assert.equal(
  toolBudgetEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "budget_limit_exceeded"),
  true,
);

const steerEntries = [];
const steerCoordinator = new SubagentCoordinator(
  {
    appendEntry(name, value) {
      steerEntries.push({ name, value });
    },
  },
  {
    root: process.cwd(),
    maxConcurrent: 1,
    hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
    piSubagentsRunner: {
      async spawn() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { content: [{ type: "text", text: JSON.stringify(stepResult) }], tool_call_count: 0 };
      },
    },
  },
);
const { agent_id: steerAgentId } = steerCoordinator.spawn({
  agent_id: "steer",
  step_id: "review_swarm",
  context_packet: "BDD: steering path.",
  owned_files: ["src/steer.js"],
});
await waitFor(() => steerCoordinator.status(steerAgentId).state === "running");
const steerResult = steerCoordinator.steer(steerAgentId, "narrow scope");
assert.equal(steerResult.accepted, false);
assert.match(steerResult.reason, /steering is disabled/);
assert.equal(steerEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "steer"), true);
await waitFor(() => steerCoordinator.status(steerAgentId).state === "done");

const restoredEntries = [];
const restoredCoordinator = new SubagentCoordinator(
  {
    appendEntry(name, value) {
      restoredEntries.push({ name, value });
    },
  },
  {
    root: process.cwd(),
    maxConcurrent: 1,
    hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
    piSubagentsRunner: {
      async spawn(params) {
        const agentId = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "unknown";
        return {
          content: [{ type: "text", text: JSON.stringify({ ...stepResult, agent_ids: [agentId] }) }],
          tool_call_count: 0,
        };
      },
    },
  },
);
const restoreState = {
  jobs: [
    {
      agentId: "running:restore",
      state: "running",
      descriptor: { agent_id: "running", step_id: "restore_step", owned_files: ["src/running.js"] },
      model: null,
      lastSummary: "worker active",
    },
    {
      agentId: "queued:restore",
      state: "queued",
      descriptor: { agent_id: "queued", step_id: "restore_step", owned_files: ["src/queued.js"] },
      model: null,
    },
    {
      agentId: "done:restore",
      state: "done",
      descriptor: { agent_id: "done", step_id: "restore_step", owned_files: ["src/done.js"] },
      model: { requested: "code-strong", resolved: "anthropic/claude-opus-4-8", fallback: false, source: "test" },
      result: { stepResult, artifacts: stepResult.artifacts },
      lastSummary: "PASS",
    },
  ],
  ownedFiles: [
    { agentId: "running:restore", files: ["src/running.js"] },
    { agentId: "queued:restore", files: ["src/queued.js"] },
    { agentId: "done:restore", files: ["src/done.js"] },
  ],
};
const restoredSummary = restoredCoordinator.restore(restoreState);
assert.equal(restoredSummary.restored, true);
assert.equal(restoredSummary.restored_jobs, 3);
assert.equal(restoredSummary.interrupted_jobs, 2);
assert.deepEqual(restoredSummary.states, { interrupted: 2, done: 1 });
assert.equal(restoredCoordinator.status("running:restore").state, "interrupted");
assert.equal(restoredCoordinator.status("queued:restore").state, "interrupted");
assert.equal(restoredCoordinator.collect("running:restore").ready, false);
assert.equal(restoredCoordinator.collect("done:restore").ready, true);
assert.equal(restoredCoordinator.collect("done:restore").step_result.verdict, "PASS");
assert.equal(restoredEntries.some((entry) => entry.name === SUBAGENT_STATE_ENTRY), true);
const redispatched = restoredCoordinator.dispatch({
  agent_id: "running",
  step_id: "restore_step",
  context_packet: "BDD: redispatch from interrupted state.",
  owned_files: ["src/running.js"],
});
assert.equal(redispatched.redispatched, true);
assert.equal(redispatched.redispatched_from, "running:restore");
assert.equal(restoredCoordinator.status("running:restore").state, "redispatched");
await waitFor(() => restoredCoordinator.status(redispatched.agent_id).state === "done");
assert.equal(restoredCoordinator.collect(redispatched.agent_id).ready, true);
assert.equal(
  restoredEntries.some((entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "redispatched"),
  true,
);

assert.deepEqual(
  latestSubagentStateFromEntries([
    { type: "custom", customType: SUBAGENT_STATE_ENTRY, data: { marker: "old" } },
    { type: "custom", customType: "other", data: { marker: "ignored" } },
    { type: SUBAGENT_STATE_ENTRY, data: { marker: "new" } },
  ]),
  { marker: "new" },
);

const piSubagentsSpikeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-pi-subagents-spike-"));
try {
  const providerEventLog = path.join(piSubagentsSpikeRoot, ".aipi", "runtime", "provider-events.jsonl");
  const liveSpike = await runPiSubagentsLiveSpike({
    projectRoot: piSubagentsSpikeRoot,
    providerEventLog,
    runner: {
      async spawn(params) {
        assert.equal(params.agent, AIPI_SUBAGENTS_AGENT_NAME);
        assert.equal(params.task, "Reply with the single word OK.");
        await fs.mkdir(path.dirname(providerEventLog), { recursive: true });
        await fs.appendFile(
          providerEventLog,
          `${JSON.stringify({ schema: "aipi.provider-event.v1", source: "forked-pi-subagents-fake" })}\n`,
        );
        return { content: [{ type: "text", text: "OK" }] };
      },
    },
  });
  assert.equal(liveSpike.schema, "aipi.pi-subagents-spike.v1");
  assert.equal(liveSpike.assistant_text_ok, true);
  assert.equal(liveSpike.provider_event_observed, true);
  assert.equal(liveSpike.provider_event_delta, 1);
  assert.equal(liveSpike.go_no_go, "GO_CANDIDATE");
} finally {
  await fs.rm(piSubagentsSpikeRoot, { recursive: true, force: true });
}

console.log("AIPI_SUBAGENTS_TEST_OK");

function latestPiState(entries) {
  const state = [...entries].reverse().find((entry) => entry.name === SUBAGENT_STATE_ENTRY);
  assert.ok(state, "expected a persisted subagent state entry");
  return state.value;
}

function fakeSdk({ rawWrites = [] } = {}) {
  return {
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
      ];
    },
    createWriteToolDefinition() {
      return {
        name: "write",
        execute: async (_toolCallId, params) => {
          rawWrites.push({ path: params.path, content: params.content });
          return { content: [{ type: "text", text: `wrote ${params.path}` }] };
        },
      };
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeEvidenceFile(root, relPath, content) {
  const target = path.join(root, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

function graphFile(relPath, content) {
  return {
    path: relPath,
    line_count: content.split(/\r?\n/).length,
    size: Buffer.byteLength(content, "utf8"),
    hash: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

function makeSpawnStub(calls, handler) {
  return (command, args = [], options = {}) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.pid = 4242 + calls.length;
    proc.killed = false;
    proc.killSignal = null;
    proc.kill = (signal = "SIGTERM") => {
      proc.killed = true;
      proc.killSignal = signal;
      queueMicrotask(() => closeFakeProcess(proc, 1, signal));
      return true;
    };
    const call = { command, args, options, proc };
    calls.push(call);
    queueMicrotask(() => handler(call));
    return proc;
  };
}

function closeFakeProcess(proc, code = 0, signal = null) {
  if (proc.closed) return;
  proc.closed = true;
  proc.stdout.end();
  proc.stderr.end();
  proc.emit("exit", code, signal);
  proc.emit("close", code, signal);
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function assistantStopEvent(text, model = "anthropic/claude-opus-4-8") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 1, output: 1 },
      model,
      stopReason: "stop",
    },
  };
}

function spawnedTools(args) {
  const index = args.indexOf("--tools");
  return index >= 0 ? String(args[index + 1] ?? "").split(",").filter(Boolean) : [];
}

function assertUnder(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  assert.equal(rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)), true);
}
