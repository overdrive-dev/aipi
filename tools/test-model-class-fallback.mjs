// Regression test for the silent model-class fallback bug.
//
// Policy: Hybrid (C). Unbound model_class values use the host session model by
// default and surface that substitution via model_requested / model_resolved /
// model_fallback on status and step_result. allow_fallback:false opts into a
// fail-loud strict path.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAipiLifecycleHandlers } from "../extensions/aipi/runtime/lifecycle-hooks.js";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { SubagentCoordinator, registerSubagentTools } from "../extensions/aipi/runtime/subagents.js";

const KNOWN = ["code-strong", "adversarial-heavy", "context-fast"];
const fallbackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-model-class-fallback-root-"));

const stepResult = {
  schema: "aipi.step-result.v1",
  step_id: "repro",
  agent_ids: ["worker:fake"],
  verdict: "PASS",
  evidence: [
    { rung: "ran", source: "fake-sdk", ref: "worker prompt", result: "structured response emitted" },
  ],
  artifacts: [],
};

function fakeSdk({ createCalls = [] } = {}) {
  return {
    SessionManager: { inMemory: (root) => ({ root, kind: "memory" }) },
    createReadOnlyToolDefinitions: () => [
      { name: "read", execute: async () => ({ content: [{ type: "text", text: "ok" }] }) },
      { name: "grep", execute: async () => ({ content: [{ type: "text", text: "ok" }] }) },
    ],
    createWriteToolDefinition: () => ({
      name: "write",
      execute: async () => ({ content: [{ type: "text", text: "wrote" }] }),
    }),
    async createAgentSession(options) {
      createCalls.push(options);
      let lastAssistantText = "";
      return {
        session: {
          subscribe: () => () => {},
          async prompt(text) {
            const agentId = text.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "unknown";
            lastAssistantText = JSON.stringify({ ...stepResult, agent_ids: [agentId] });
          },
          agent: { async waitForIdle() {} },
          getLastAssistantText: () => lastAssistantText,
          dispose() {},
          async abort() {},
        },
      };
    },
  };
}

function newCoordinator(options = {}) {
  return new SubagentCoordinator(
    { appendEntry() {}, log() {} },
    {
      piSubagentsRunner: fakePiSubagentsRunner({ calls: options.runnerCalls }),
      root: options.root ?? fallbackRoot,
      maxConcurrent: 4,
      knownModelClasses: KNOWN,
      hostModel: options.hostModel ?? "anthropic/claude-host",
    },
  );
}

function fakePiSubagentsRunner({ calls = [] } = {}) {
  return {
    async spawn(params, options = {}) {
      calls.push({ params });
      const root = options.ctx?.project_root ?? fallbackRoot;
      const agentId = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "unknown";
      const evidenceFile = params.owned_files?.[0] ?? ".aipi/runtime/subagents/model-class-evidence.md";
      await writeEvidenceFile(root, evidenceFile, "fake model-class evidence");
      return {
        content: [{ type: "text", text: JSON.stringify({ ...stepResult, agent_ids: [agentId], artifacts: [evidenceFile] }) }],
        artifacts: [evidenceFile],
        tool_call_count: 0,
        exit_code: 0,
        run_id: "fake-model-class-run",
      };
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// --- Test 1: explicit strict mode rejects an unknown model_class. ---
{
  const coordinator = newCoordinator();
  let threw = null;
  try {
    coordinator.spawn({
      agent_id: "reviewer",
      model_class: "gpt 5.5",
      allow_fallback: false,
      owned_files: ["src/a.js"],
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "spawn with unknown model_class must throw when allow_fallback:false");
  assert.equal(threw.code, "AIPI_UNKNOWN_MODEL_CLASS");
  // No side effects: the rejected spawn must not have allocated its owned file. If it had,
  // this second spawn for the same file would throw on overlap.
  let secondThrew = null;
  try {
    coordinator.spawn({ agent_id: "reviewer", model_class: "code-strong", owned_files: ["src/a.js"] });
  } catch (err) {
    secondThrew = err;
  }
  assert.equal(secondThrew, null, "rejected spawn must not leak an owned-file allocation");
  console.log("OK strict-reject: AIPI_UNKNOWN_MODEL_CLASS raised, no allocation leak");
}

// --- Test 2: default fallback passes the real host model into the worker session. ---
{
  const runnerCalls = [];
  const coordinator = newCoordinator({ hostModel: "anthropic/claude-host", runnerCalls });
  const { agent_id } = coordinator.spawn({
    agent_id: "reviewer",
    model_class: "gpt 5.5",
    owned_files: ["src/b.js"],
  });
  const live = coordinator.status(agent_id);
  assert.equal(live.model_requested, "gpt 5.5");
  assert.equal(live.model_resolved, "anthropic/claude-host");
  assert.equal(live.model_fallback, true);
  assert.equal(live.model_warning?.code, "AIPI_MODEL_CLASS_FALLBACK");

  await waitFor(() => coordinator.status(agent_id).state === "done");
  const collected = coordinator.collect(agent_id);
  assert.equal(collected.ready, true);
  assert.equal(collected.step_result.verdict, "PASS");
  assert.equal(collected.step_result.model_requested, "gpt 5.5");
  assert.equal(collected.step_result.model_resolved, "anthropic/claude-host");
  assert.equal(collected.step_result.model_fallback, true);
  assert.match(collected.step_result.model_warning, /not in the catalog/);
  assert.equal(runnerCalls[0].params.model, "anthropic/claude-host");
  console.log("OK host-fallback: forked runner received the real host model");
}

// --- Test 3: non-Anthropic host fallback runs normally and never falls into TypeError. ---
{
  const runnerCalls = [];
  const coordinator = newCoordinator({ hostModel: "openai-codex/gpt-5.5", runnerCalls });
  const { agent_id } = coordinator.spawn({
    agent_id: "reviewer",
    model_class: "code-strong",
    owned_files: ["src/non-anthropic-host.js"],
  });
  const live = coordinator.status(agent_id);
  assert.equal(live.model_resolved, "openai-codex/gpt-5.5");
  assert.equal(live.model_fallback, true);
  await waitFor(() => coordinator.status(agent_id).state === "done");
  assert.equal(runnerCalls[0].params.model, "openai-codex/gpt-5.5");
  const collected = coordinator.collect(agent_id);
  assert.equal(collected.step_result.model_resolved, "openai-codex/gpt-5.5");
  assert.doesNotMatch(collected.step_result.model_warning ?? "", /Cannot read properties of undefined/);

  const unqualifiedCalls = [];
  const unqualifiedCoordinator = newCoordinator({ hostModel: "gpt-5.5", runnerCalls: unqualifiedCalls });
  const { agent_id: unqualifiedAgentId } = unqualifiedCoordinator.spawn({
    agent_id: "reviewer",
    model_class: "code-strong",
    owned_files: ["src/unqualified-host.js"],
  });
  await waitFor(() => unqualifiedCoordinator.status(unqualifiedAgentId).state === "done");
  assert.equal(unqualifiedCalls[0].params.model, "gpt-5.5");
  assert.equal(unqualifiedCoordinator.collect(unqualifiedAgentId).step_result.model_resolved, "gpt-5.5");
  console.log("OK provider-agnostic-host: openai-codex host fallback runs normally");
}

// --- Test 3: the public aipi_spawn_agent tool threads ctx.model into spawn. ---
{
  const runnerCalls = [];
  const tools = new Map();
  const pi = {
    appendEntry() {},
    log() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  const coordinator = new SubagentCoordinator(pi, {
    piSubagentsRunner: fakePiSubagentsRunner({ calls: runnerCalls }),
    root: fallbackRoot,
    maxConcurrent: 4,
    knownModelClasses: KNOWN,
  });
  registerSubagentTools(pi, coordinator);
  const spawnTool = tools.get("aipi_spawn_agent");
  assert.ok(spawnTool, "aipi_spawn_agent should be registered");
  const result = await spawnTool.execute(
    "tool-call",
    {
      agent_id: "reviewer",
      model_class: "code-strong",
      owned_files: ["src/tool-host-model.js"],
    },
    null,
    null,
    { model: "anthropic/ctx-host" },
  );
  const agentId = JSON.parse(result.content[0].text).agent_id;
  await waitFor(() => coordinator.status(agentId).state === "done");
  assert.equal(runnerCalls[0].params.model, "anthropic/ctx-host");
  const collected = coordinator.collect(agentId);
  assert.equal(collected.step_result.model_resolved, "anthropic/ctx-host");
  assert.equal(collected.step_result.model_fallback, true);
  console.log("OK tool-ctx-host-model: aipi_spawn_agent forwarded ctx.model to the worker");
}

// --- Test 4: real model_select captures host model, then spawn uses it without ctx.model. ---
{
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-model-select-host-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: tempRoot });
    const runnerCalls = [];
    const appliedModels = [];
    const entries = [];
    const coordinator = new SubagentCoordinator(
      {
        appendEntry(name, value) {
          entries.push({ name, value });
        },
        log() {},
      },
      {
        piSubagentsRunner: fakePiSubagentsRunner({ calls: runnerCalls }),
        root: tempRoot,
        maxConcurrent: 4,
      },
    );
    const handlers = createAipiLifecycleHandlers({
      pi: {
        appendEntry(name, value) {
          entries.push({ name, value });
        },
        setModel(model) {
          appliedModels.push(model);
        },
      },
      projectRootResolver: () => tempRoot,
      coordinator,
    });

    await handlers.model_select(
      {
        type: "model_select",
        model_class: "code-strong",
        env: { AIPI_MODEL_CLASS_CODE_STRONG: "anthropic/claude-captured" },
      },
      {
        cwd: tempRoot,
        modelRegistry: {
          find(provider, model) {
            return { provider, id: model };
          },
        },
        modelCapabilities: {
          valid: true,
          models: {
            "anthropic:claude-captured": {
              capabilities: {
                coding: "high",
                context: "medium_high",
                tool_use: "write_capable",
                structured_outputs: "supported",
              },
              evidence: ["test fixture"],
            },
          },
        },
        ui: { notify() {} },
      },
    );
    assert.deepEqual(appliedModels[0], { provider: "anthropic", id: "claude-captured" });
    assert.deepEqual(coordinator.getHostModel(), { provider: "anthropic", id: "claude-captured" });

    const { agent_id: agentId } = coordinator.spawn({
      agent_id: "reviewer",
      model_class: "code-strong",
      owned_files: ["src/model-select-host.js"],
    });
    await waitFor(() => coordinator.status(agentId).state === "done");
    assert.deepEqual(runnerCalls.at(-1).params.model, { provider: "anthropic", id: "claude-captured" });
    const collected = coordinator.collect(agentId);
    assert.equal(collected.step_result.model_resolved, "anthropic/claude-captured");
    assert.equal(collected.step_result.model_fallback, true);
    console.log("OK model-select-capture: model_select captured host model for later worker spawn");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

// --- Test 5: defensive model capture handles event.model.id and ctx.getModel shapes. ---
{
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-model-field-capture-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: tempRoot });
    const coordinator = new SubagentCoordinator(
      { appendEntry() {}, log() {} },
      { sdk: fakeSdk(), root: tempRoot, maxConcurrent: 4 },
    );
    const handlers = createAipiLifecycleHandlers({
      pi: { appendEntry() {} },
      projectRootResolver: () => tempRoot,
      coordinator,
    });

    await handlers.model_select(
      { type: "model_select", model: { id: "claude-event-id" } },
      { cwd: tempRoot, ui: { notify() {} } },
    );
    assert.equal(coordinator.getHostModel(), "claude-event-id");

    await handlers.model_select(
      { type: "model_select" },
      {
        cwd: tempRoot,
        getModel() {
          return "anthropic/claude-from-getter";
        },
        ui: { notify() {} },
      },
    );
    assert.deepEqual(coordinator.getHostModel(), { provider: "anthropic", id: "claude-from-getter" });
    console.log("OK defensive-capture: model_select captures event.model.id and ctx.getModel");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

// --- Test 6: explicit strict mode rejects a recognized but unbound model_class. ---
{
  const coordinator = newCoordinator({ hostModel: "anthropic/claude-host" });
  let threw = null;
  try {
    coordinator.spawn({
      agent_id: "reviewer",
      model_class: "code-strong",
      allow_fallback: false,
      owned_files: ["src/c.js"],
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "known but unbound model_class must throw when allow_fallback:false");
  assert.equal(threw.code, "AIPI_MODEL_CLASS_UNRESOLVED");
  console.log("OK strict-unresolved: AIPI_MODEL_CLASS_UNRESOLVED raised");
}

// --- Test 7: a recognized class with no binding uses the host model and says so. ---
{
  const runnerCalls = [];
  const coordinator = newCoordinator({ hostModel: "anthropic/claude-host", runnerCalls });
  const { agent_id } = coordinator.spawn({
    agent_id: "reviewer",
    model_class: "code-strong",
    owned_files: ["src/c.js"],
  });
  const live = coordinator.status(agent_id);
  assert.equal(live.model_warning?.code, "AIPI_MODEL_CLASS_UNRESOLVED");
  assert.equal(live.model_resolved, "anthropic/claude-host");
  assert.equal(live.model_fallback, true);
  assert.match(live.model_warning.message, /running on host model "anthropic\/claude-host"/);
  await waitFor(() => coordinator.status(agent_id).state === "done");
  const collected = coordinator.collect(agent_id);
  assert.equal(collected.step_result.model_requested, "code-strong");
  assert.equal(collected.step_result.model_resolved, "anthropic/claude-host");
  assert.equal(collected.step_result.model_fallback, true);
  assert.equal(runnerCalls[0].params.model, "anthropic/claude-host");
  console.log("OK known-unresolved: code-strong ran on host model, surfaced as fallback");
}

// --- Test 8: an upstream-resolved concrete model is reported, no warning. ---
{
  const coordinator = newCoordinator();
  const { agent_id } = coordinator.spawn({
    agent_id: "implementer",
    model_class: "code-strong",
    model: { provider: "anthropic", id: "claude-test" },
    model_resolution_source: "env",
    owned_files: ["src/d.js"],
  });
  const live = coordinator.status(agent_id);
  assert.equal(live.model_requested, "code-strong");
  assert.equal(live.model_resolved, "anthropic/claude-test");
  assert.equal(live.model_fallback, false);
  assert.equal(live.model_warning, null);
  assert.equal(live.model_source, "env");
  console.log("OK resolved: concrete model reported as model_resolved, no warning");
}

await fs.rm(fallbackRoot, { recursive: true, force: true });
console.log("AIPI_MODEL_CLASS_FALLBACK_TEST_OK");

async function writeEvidenceFile(root, relPath, content) {
  const target = path.join(root, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}
