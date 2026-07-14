import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createJiti } from "jiti";
import {
  SUBAGENT_EVENT_ENTRY,
  SUBAGENT_STATE_ENTRY,
  SubagentCoordinator,
  aipiAskBridge,
  buildWorkerPrompt,
  buildWorkerTools,
  latestSubagentStateFromEntries,
  parseWorkerStepResult,
  resolveInteractiveSpawnModel,
} from "../extensions/aipi/runtime/subagents.js";
import {
  AIPI_SUBAGENTS_AGENT_NAME,
  AIPI_SUBAGENTS_RUNTIME_ROOT,
  aipiHostModelReadiness,
  assertAipiHostScopedModel,
  assertAipiSupportedHostModel,
  createAipiSubagentsRunner,
  createAipiWorkerAgentConfig,
  projectSubagentsRuntimePaths,
  runAipiForkedSubagent,
  runPiSubagentsLiveSpike,
} from "../extensions/aipi/runtime/pi-subagents.js";
import registerAipiGuardedWriteChild from "../extensions/aipi/runtime/aipi-guarded-write-child.js";
import registerAipiGuardedBashChild from "../extensions/aipi/runtime/aipi-guarded-bash-child.js";
import { OwnedFileRegistry } from "../extensions/aipi/runtime/owned-files.js";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

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
// F2: the worker prompt carries the anti-cadence rule paired with the positive (real gate -> structured) rule.
assert.match(prompt, /do NOT end with a cadence\/checkpoint\/permission question/i);
assert.match(prompt, /STRUCTURED BLOCKED or FAIL/);

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
assert.doesNotThrow(() => assertAipiHostScopedModel("host-default", { requireProvider: true }));
assert.throws(() => assertAipiHostScopedModel(null, { requireProvider: true }), /concrete host model/);
assert.throws(() => assertAipiHostScopedModel(null, { requireModel: true }), /concrete host model/);
assert.doesNotThrow(() => assertAipiHostScopedModel("bedrock/claude-opus-4-8"));
assert.doesNotThrow(() => assertAipiHostScopedModel("deepseek/deepseek-r1"));
assert.doesNotThrow(() => assertAipiHostScopedModel("zai/glm-4.5"));
assert.throws(() => assertAipiHostScopedModel("openai/gpt-5.5", { allowedProvider: "anthropic" }), /only allow host provider anthropic/);
// MODEL-AGNOSTIC by default: any provider (Anthropic, openai-codex, unqualified gpt) is an acceptable host.
assert.doesNotThrow(() => assertAipiSupportedHostModel("anthropic/claude-opus-4-8", { requireProvider: true }));
assert.doesNotThrow(() => assertAipiSupportedHostModel("openai-codex/gpt-5.5", { requireProvider: true }));
assert.doesNotThrow(() => assertAipiSupportedHostModel("gpt-5.5", { requireProvider: true }));
assert.equal(aipiHostModelReadiness("openai-codex/gpt-5.5").ok, true);
assert.equal(aipiHostModelReadiness("openai-codex/gpt-5.5").code, "AIPI_HOST_MODEL_SUPPORTED");
assert.equal(aipiHostModelReadiness("gpt-5.5").code, "AIPI_HOST_MODEL_UNQUALIFIED_ALLOWED");
assert.equal(aipiHostModelReadiness(null, { requireProvider: false }).ok, true);
// Opt-in restriction via AIPI_HOST_PROVIDERS — operator can pin the host to specific providers.
const restrictEnv = { AIPI_HOST_PROVIDERS: "anthropic" };
assert.equal(aipiHostModelReadiness("anthropic/claude-opus-4-8", { env: restrictEnv }).ok, true);
assert.equal(aipiHostModelReadiness("openai-codex/gpt-5.5", { env: restrictEnv }).code, "AIPI_HOST_MODEL_UNSUPPORTED");
assert.match(aipiHostModelReadiness("openai-codex/gpt-5.5", { env: restrictEnv }).message, /AIPI_HOST_PROVIDERS/);
assert.equal(aipiHostModelReadiness("gpt-5.5", { env: restrictEnv }).code, "AIPI_HOST_MODEL_UNSUPPORTED");
// A multi-provider allowlist admits the listed ones.
assert.equal(aipiHostModelReadiness("openai-codex/gpt-5.5", { env: { AIPI_HOST_PROVIDERS: "anthropic, openai-codex" } }).ok, true);

const { buildModelCandidates, resolveModelCandidate } = jiti(
  "../extensions/aipi/runtime/vendor/pi-subagents/src/runs/shared/model-fallback.ts",
);
assert.deepEqual(buildModelCandidates(undefined, undefined, undefined), []);
assert.deepEqual(buildModelCandidates(null, [null, undefined], undefined), []);
assert.equal(resolveModelCandidate(undefined, undefined), undefined);
assert.equal(resolveModelCandidate(null, undefined), undefined);
assert.deepEqual(buildModelCandidates("gpt-5.5", undefined, undefined), ["gpt-5.5"]);
assert.deepEqual(
  buildModelCandidates(
    "gpt-5.5",
    [null, "gpt-5.5", "openai-codex/gpt-5.5"],
    [{ provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5" }],
    "openai-codex",
  ),
  ["openai-codex/gpt-5.5"],
);
assert.deepEqual(
  buildModelCandidates("openai-codex/gpt-5.5", [undefined], undefined),
  ["openai-codex/gpt-5.5"],
);

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
  // The production --tools allowlist MUST include "write" (guarded-write extension), "aipi_shell"
  // (guarded-shell extension), and "aipi_ask_orchestrator" (live orchestrator back-channel) so every registered
  // tool survives the child's allowlist filter. This review_swarm worker is artifact-scope (not project), so it
  // gets NO hashline pair — hashline is wired only for code-writing (project-scope) workers. Raw bash/shell/exec
  // stay ABSENT — the worker's only shell is the watchdog-wrapped aipi_shell.
  assert.deepEqual(spawnedTools(spawnedArgs), ["read", "grep", "find", "ls", "write", "aipi_shell", "aipi_ask_orchestrator"]);
  assert.equal(spawnedTools(spawnedArgs).some((tool) => /^(bash|shell|exec|user_bash)$/i.test(tool)), false);
  assert.equal(spawnedArgs.includes("--no-extensions"), true);
  assert.equal(
    spawnedArgs.some((arg) => String(arg).replaceAll("\\", "/").endsWith("extensions/aipi/runtime/aipi-guarded-write-child.js")),
    true,
  );

  const openaiCodexRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-openai-host-"));
  try {
    await runAipiForkedSubagent({
      root: openaiCodexRoot,
      params: {
        id: "openai-host",
        task: "Reply OK.",
        model: "openai-codex/gpt-5.5",
      },
    });
    assert.equal(realRuntimeCalls.length, 2);
    const openaiArgs = realRuntimeCalls[1].args;
    assert.equal(openaiArgs[openaiArgs.indexOf("--model") + 1], "openai-codex/gpt-5.5");
  } finally {
    await fs.rm(openaiCodexRoot, { recursive: true, force: true });
  }

  const unqualifiedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-unqualified-host-"));
  try {
    await runAipiForkedSubagent({
      root: unqualifiedRoot,
      params: {
        id: "unqualified-host",
        task: "Reply OK.",
        model: "gpt-5.5",
      },
    });
    assert.equal(realRuntimeCalls.length, 3);
    const unqualifiedArgs = realRuntimeCalls[2].args;
    assert.equal(unqualifiedArgs[unqualifiedArgs.indexOf("--model") + 1], "gpt-5.5");
  } finally {
    await fs.rm(unqualifiedRoot, { recursive: true, force: true });
  }

  const defaultRunnerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-default-runner-"));
  try {
    await createAipiSubagentsRunner({ root: defaultRunnerRoot }).spawn({
      id: "default-runtime",
      task: "Reply OK.",
      model: "anthropic/claude-opus-4-8",
    });
    assert.equal(realRuntimeCalls.length, 4);
    assert.equal(realRuntimeCalls[3].options.cwd, defaultRunnerRoot);
  } finally {
    await fs.rm(defaultRunnerRoot, { recursive: true, force: true });
  }

  const noModelRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-no-model-"));
  try {
    await assert.rejects(
      () => runAipiForkedSubagent({ root: noModelRoot, params: { id: "no-model", task: "no model" } }),
      /concrete host model/,
    );
    assert.equal(realRuntimeCalls.length, 4);
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
  AIPI_SUBAGENTS_WRITE_SCOPE: process.env.AIPI_SUBAGENTS_WRITE_SCOPE,
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

  // Project write scope (implementation/fix/tdd steps): the worker may apply its fix to ANY
  // project source file it did not pre-declare, while controller-owned state stays blocked.
  process.env.AIPI_SUBAGENTS_WRITE_SCOPE = "project";
  process.env.AIPI_SUBAGENTS_OWNED_FILES = JSON.stringify([
    ".aipi/runtime/runs/run-1/steps/fix/FIXES.md",
  ]);
  const projectScopedTools = [];
  registerAipiGuardedWriteChild({
    registerTool(tool) {
      projectScopedTools.push(tool);
    },
  });
  const projectWrite = projectScopedTools.find((tool) => tool.name === "write");
  assert.ok(projectWrite, "expected guarded child write tool to register under project scope");
  // A source file the worker never declared as owned is now writable.
  await projectWrite.execute("source", {
    path: "frontend/src/lib/gestores-tipo.ts",
    content: "export const ok = true;\n",
  });
  assert.equal(
    await fs.readFile(path.join(guardedChildWriteRoot, "frontend", "src", "lib", "gestores-tipo.ts"), "utf8"),
    "export const ok = true;\n",
  );
  // Its own run-dir step artifact is still writable under project scope.
  await projectWrite.execute("artifact", {
    path: ".aipi/runtime/runs/run-1/steps/fix/FIXES.md",
    content: "# fix\n",
  });
  // Controller-owned memory and non-artifact runtime state remain blocked even under project scope.
  assert.equal(
    (await projectWrite.execute("memory", { path: ".aipi/memory/project/project.md", content: "x" })).isError,
    true,
  );
  assert.equal(
    (await projectWrite.execute("runtime", { path: ".aipi/runtime/runs/run-1/state.json", content: "x" })).isError,
    true,
  );
  // ADV-62-3: .git stays blocked under project scope in the child guarded-write extension too.
  await assert.rejects(
    () => projectWrite.execute("git", { path: ".git/config", content: "x" }),
    /targets \.git/,
  );
  await assert.rejects(
    () => projectWrite.execute("escape", { path: "../outside.js", content: "x" }),
    /escapes project root/,
  );
} finally {
  for (const [key, value] of Object.entries(previousGuardEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(guardedChildWriteRoot, { recursive: true, force: true });
}

// Guarded-bash child (B1): a forked worker's shell. Prove it RUNS a real command through the watchdog and
// returns the output (this is the capability that lets a worker actually verify — run tests/build).
const guardedBashRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-guarded-bash-child-"));
const priorBashEnv = { AIPI_SUBAGENTS_PROJECT_ROOT: process.env.AIPI_SUBAGENTS_PROJECT_ROOT, AIPI_SUBAGENTS_AGENT_ID: process.env.AIPI_SUBAGENTS_AGENT_ID };
try {
  process.env.AIPI_SUBAGENTS_PROJECT_ROOT = guardedBashRoot;
  process.env.AIPI_SUBAGENTS_AGENT_ID = "guarded:bash";
  const bashTools = [];
  registerAipiGuardedBashChild({ registerTool(tool) { bashTools.push(tool); } });
  const bash = bashTools.find((tool) => tool.name === "aipi_shell");
  assert.ok(bash, "guarded-bash child registers the aipi_shell tool (canonical name)");
  // Runs a real command and captures its output.
  const ran = await bash.execute("ok", { command: `node -e "process.stdout.write('GUARDED_BASH_OK')"` });
  assert.notEqual(ran.isError, true);
  assert.match(JSON.stringify(ran), /GUARDED_BASH_OK/);
  // Empty command is refused.
  assert.equal((await bash.execute("empty", { command: "   " })).isError, true);
  // Security: cwd is CONFINED to the project root — `..`, deep traversal, and absolute escapes fail closed.
  assert.equal((await bash.execute("up", { command: "node --version", cwd: ".." })).isError, true);
  assert.equal((await bash.execute("deep", { command: "node --version", cwd: "../../../etc" })).isError, true);
  assert.equal((await bash.execute("abs", { command: "node --version", cwd: "/etc" })).isError, true);
  assert.equal((await bash.execute("sneaky", { command: "node --version", cwd: "sub/../../../outside" })).isError, true);
  // Sibling prefix-collision (root .../X, cwd '../X-evil' -> .../X-evil shares X's string prefix) is rejected
  // by the separator-appended containment check — this is the exact case the guard hardened.
  assert.equal(
    (await bash.execute("sibling", { command: "node --version", cwd: `../${path.basename(guardedBashRoot)}-evil` })).isError,
    true,
  );
  // An in-root relative cwd is allowed.
  await fs.mkdir(path.join(guardedBashRoot, "sub"), { recursive: true });
  assert.notEqual((await bash.execute("sub", { command: "node --version", cwd: "sub" })).isError, true);
} finally {
  for (const [key, value] of Object.entries(priorBashEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(guardedBashRoot, { recursive: true, force: true });
}

// Shell gating (security, fix #2): single-lead workers get aipi_shell; parallel fanout workers
// (allowShell:false, set by executeFanoutSubagentStep) get NO shell — preserving write-disjointness +
// .git/.aipi/memory protection across concurrent workers.
const leadCfg = createAipiWorkerAgentConfig({ allowShell: true });
assert.ok(leadCfg.tools.includes("aipi_shell"), "single-lead worker has the guarded shell");
assert.ok(leadCfg.tools.some((tool) => String(tool).includes("aipi-guarded-bash-child")), "single-lead worker loads the bash extension");
const defaultCfg = createAipiWorkerAgentConfig({});
assert.ok(defaultCfg.tools.includes("aipi_shell"), "shell defaults ON for an unspecified (single-lead) worker");
const fanoutCfg = createAipiWorkerAgentConfig({ allowShell: false });
assert.ok(!fanoutCfg.tools.includes("aipi_shell"), "parallel fanout worker has NO guarded shell");
assert.ok(!fanoutCfg.tools.some((tool) => String(tool).includes("aipi-guarded-bash-child")), "fanout worker does NOT load the bash extension");
assert.ok(fanoutCfg.tools.includes("write"), "fanout worker still has the guarded write");
assert.match(fanoutCfg.systemPrompt, /NO shell/);

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
  /is unsupported; current AIPI supports the forked pi_subagents runtime/,
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
      agent_id: "no-model",
      step_id: "model",
      context_packet: "BDD: worker model scoping is fail-closed.",
      owned_files: ["src/no-model.js"],
    }),
  /concrete host model/,
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

// Model availability fallback: a worker whose resolved model's provider is NOT authed on the host falls
// back to the (authed) host model — so the workflow completes on the default model instead of blocking on an
// unavailable provider (e.g. a configured xai-auth/grok reviewer with the xAI extension not installed) — and
// the fallback is ANNOUNCED. maxConcurrent:0 keeps each job QUEUED so we read the resolution without running.
{
  const fallbackMessages = [];
  const fallbackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-model-fallback-"));
  const fallbackCoordinator = new SubagentCoordinator(
    { appendEntry() {}, log() {}, sendMessage(message) { fallbackMessages.push(message); } },
    {
      root: fallbackRoot,
      maxConcurrent: 0, // never dispatch; we only assert the spawn-time model resolution
      env: {},
      hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
      knownModelClasses: ["adversarial-heavy", "code-strong"],
      piSubagentsRunner: { spawn() {} },
    },
  );
  fallbackCoordinator.setAvailableModels(["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-5"]);

  // (1) an unavailable xai-auth reviewer model falls back to the host model + warns + announces.
  const { agent_id: unavail } = fallbackCoordinator.spawn({
    agent_id: "reviewer",
    model_class: "adversarial-heavy",
    model: { provider: "xai-auth", id: "grok-4.5" },
    step_id: "verify",
  });
  const unavailStatus = fallbackCoordinator.status(unavail);
  assert.equal(unavailStatus.model_resolved, "anthropic/claude-opus-4-8", "unavailable provider falls back to the host model");
  assert.equal(unavailStatus.model_warning?.code, "AIPI_MODEL_UNAVAILABLE_FALLBACK", "the fallback is recorded as a model warning");
  assert.match(unavailStatus.model_warning.message, /grok-4\.5/, "warning names the unavailable model");
  assert.ok(
    fallbackMessages.some((m) => m.customType === "aipi-model-fallback" && /grok-4\.5/.test(m.content) && /claude-opus-4-8/.test(m.content)),
    `a visible fallback announcement is sent; got: ${JSON.stringify(fallbackMessages)}`,
  );

  // (2) an authed provider model is used as configured (no fallback, no announcement).
  fallbackMessages.length = 0;
  const { agent_id: avail } = fallbackCoordinator.spawn({
    agent_id: "coder",
    model_class: "code-strong",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    step_id: "implement",
  });
  const availStatus = fallbackCoordinator.status(avail);
  assert.equal(availStatus.model_resolved, "anthropic/claude-sonnet-5", "an authed model runs as configured");
  assert.equal(availStatus.model_warning, null, "no warning for an available model");
  assert.equal(fallbackMessages.length, 0, "no fallback announcement for an available model");
  await fs.rm(fallbackRoot, { recursive: true, force: true });
}

// Unknown availability (no live registry): the fallback stays DISABLED — a configured model is never
// overridden when we cannot prove its provider is unavailable (setAvailableModels was not called).
{
  const noRegRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-model-noreg-"));
  const noRegCoordinator = new SubagentCoordinator(
    { appendEntry() {}, log() {}, sendMessage() {} },
    {
      root: noRegRoot,
      maxConcurrent: 0,
      env: {},
      hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
      knownModelClasses: ["adversarial-heavy"],
      piSubagentsRunner: { spawn() {} },
    },
  );
  const { agent_id: keep } = noRegCoordinator.spawn({
    agent_id: "reviewer",
    model_class: "adversarial-heavy",
    model: { provider: "xai-auth", id: "grok-4.5" },
    step_id: "verify",
  });
  const keepStatus = noRegCoordinator.status(keep);
  assert.equal(keepStatus.model_resolved, "xai-auth/grok-4.5", "unknown availability never overrides a configured model");
  assert.equal(keepStatus.model_warning, null, "no fallback warning when availability is unknown");
  await fs.rm(noRegRoot, { recursive: true, force: true });
}

// Owned-file conflict regression — the live nora-app `fix (4/7)` block:
// "owned-file conflict for implementer:...: .../steps/fix/FIXES.md, IMPLEMENTATION.md".
const conflictRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-owned-conflict-"));
try {
  const fixFiles = [
    ".aipi/runtime/runs/run-1/steps/fix/FIXES.md",
    ".aipi/runtime/runs/run-1/steps/fix/IMPLEMENTATION.md",
  ];
  const makeFixCoordinator = (entries = []) =>
    new SubagentCoordinator(
      { appendEntry(name, value) { entries.push({ name, value }); } },
      {
        root: conflictRoot,
        maxConcurrent: 1,
        env: {},
        piSubagentsRunner: {
          async spawn(params, options = {}) {
            const aid = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "x";
            for (const f of params.owned_files ?? []) await writeEvidenceFile(options.ctx?.project_root ?? conflictRoot, f, "fix evidence");
            return {
              content: [{ type: "text", text: JSON.stringify({ ...stepResult, step_id: "fix", agent_ids: [aid], artifacts: params.owned_files ?? fixFiles }) }],
              artifacts: params.owned_files ?? fixFiles,
              tool_call_count: 1,
              exit_code: 0,
              run_id: "fix-run",
            };
          },
        },
      },
    );
  const fixDescriptor = () => ({
    agent_id: "implementer",
    model_class: "code-strong",
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    step_id: "fix",
    write_scope: "project",
    owned_files: fixFiles,
  });

  // (A) A worker that reaches DONE (e.g. returned a FAIL verdict) releases its owned files, so the gate's
  // fix->fix loop can re-dispatch the SAME artifacts without an owned-file conflict.
  const fixCoordinator = makeFixCoordinator();
  const { agent_id: fixA } = fixCoordinator.spawn(fixDescriptor());
  await waitFor(() => fixCoordinator.status(fixA).state === "done");
  let fixB;
  assert.doesNotThrow(() => { fixB = fixCoordinator.spawn(fixDescriptor()).agent_id; }, "DONE worker must release its owned files for the next fix attempt");
  await waitFor(() => fixCoordinator.status(fixB).state === "done");
  assert.notEqual(fixA, fixB);

  // (B/C) Resume regression: a restored INTERRUPTED worker's stale allocation must not block re-dispatch.
  // Persisting step_id lets #findInterruptedJob match -> dispatch redispatches and frees the old claim;
  // even if it didn't match, #allocateOrReclaim frees a non-live owner. Either way: no hard conflict.
  const resumeCoordinator = makeFixCoordinator();
  resumeCoordinator.restore({
    jobs: [
      {
        agentId: "implementer:old12345",
        state: "running", // a killed run -> restored as INTERRUPTED
        descriptor: { agent_id: "implementer", step_id: "fix", write_scope: "project", owned_files: fixFiles },
      },
    ],
    ownedFiles: [
      { agentId: "implementer:old12345", files: fixFiles.map((f) => path.join(conflictRoot, f)), projectScope: true },
    ],
  });
  let resumeNew;
  assert.doesNotThrow(() => { resumeNew = resumeCoordinator.dispatch(fixDescriptor()); }, "restored stale fix allocation must not block re-dispatch");
  assert.ok(resumeNew.agent_id && resumeNew.agent_id !== "implementer:old12345");
  await waitFor(() => resumeCoordinator.status(resumeNew.agent_id).state === "done");

  // (C) #allocateOrReclaim frees a NON-LIVE owner directly on spawn (no interrupted-match required).
  const reclaimCoordinator = makeFixCoordinator();
  reclaimCoordinator.restore({
    jobs: [{ agentId: "implementer:done5555", state: "done", descriptor: { agent_id: "implementer", step_id: "fix", owned_files: fixFiles } }],
    ownedFiles: [{ agentId: "implementer:done5555", files: fixFiles.map((f) => path.join(conflictRoot, f)) }],
  });
  let reclaimNew;
  assert.doesNotThrow(() => { reclaimNew = reclaimCoordinator.spawn(fixDescriptor()).agent_id; }, "a terminal owner's stale allocation must be reclaimed on spawn");
  await waitFor(() => reclaimCoordinator.status(reclaimNew).state === "done");

  // (C) A genuinely LIVE concurrent writer still fails loud — reclaim never steals from a RUNNING worker.
  let releaseLive;
  const liveBlock = new Promise((resolve) => { releaseLive = resolve; });
  const liveCoordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root: conflictRoot,
      maxConcurrent: 2,
      env: {},
      piSubagentsRunner: {
        async spawn(params) {
          await liveBlock; // hold the worker in RUNNING until released
          const aid = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "x";
          return {
            content: [{ type: "text", text: JSON.stringify({ ...stepResult, step_id: "fix", agent_ids: [aid], artifacts: params.owned_files }) }],
            artifacts: params.owned_files,
            tool_call_count: 1,
            exit_code: 0,
            run_id: "live-run",
          };
        },
      },
    },
  );
  const { agent_id: liveA } = liveCoordinator.spawn({ ...fixDescriptor(), step_id: "fix", owned_files: ["src/live.js"] });
  await waitFor(() => liveCoordinator.status(liveA).state === "running");
  assert.throws(
    () => liveCoordinator.spawn({ ...fixDescriptor(), step_id: "fix2", owned_files: ["src/live.js"] }),
    /owned-file conflict/,
    "a RUNNING worker's owned file must NOT be reclaimable by a concurrent writer",
  );
  releaseLive();
  await waitFor(() => liveCoordinator.status(liveA).state === "done");
} finally {
  await fs.rm(conflictRoot, { recursive: true, force: true });
}

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

// ── Cross-family model visibility ───────────────────────────────────────────
// A worker that resolves to a DIFFERENT model family than the host (e.g. an
// adversarial reviewer on openai-codex/gpt-5.5 while the host implements on
// anthropic/claude-opus-4-8) must surface that — live (pi.log), durably
// (worker_model_divergent trace), on status(), and stamped on the step result.
// A same-family worker must surface NOTHING (no false positives).
const xfRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-subagents-xfamily-"));
const xfEntries = [];
const xfLogs = [];
const xfCoordinator = new SubagentCoordinator(
  {
    appendEntry(name, value) {
      xfEntries.push({ name, value });
    },
    log(line) {
      xfLogs.push(line);
    },
  },
  {
    root: xfRoot,
    maxConcurrent: 2,
    env: {},
    hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
    knownModelClasses: ["adversarial-heavy", "code-strong"],
    piSubagentsRunner: {
      async spawn(params) {
        const agentId = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? "unknown";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...stepResult, verdict: "FAIL", step_id: "review", agent_ids: [agentId] }),
            },
          ],
          tool_call_count: 1,
        };
      },
    },
  },
);

const { agent_id: xfAgent } = xfCoordinator.spawn({
  agent_id: "code-reviewer",
  model_class: "adversarial-heavy",
  model: { provider: "openai-codex", id: "gpt-5.5" },
  step_id: "review",
  context_packet: "BDD: cross-family adversarial review.",
  owned_files: ["src/xf-review.js"],
});
// Live signal fires synchronously at spawn time (before the worker runs).
assert.equal(
  xfLogs.some((line) => /cross-family model: running on openai-codex\/gpt-5\.5 \(openai-codex\)/.test(line)),
  true,
  "cross-family spawn must emit a live pi.log line",
);
// Durable lifecycle trace.
const xfDivergence = xfEntries.find(
  (entry) => entry.name === SUBAGENT_EVENT_ENTRY && entry.value.event === "worker_model_divergent",
);
assert.ok(xfDivergence, "cross-family spawn must emit a worker_model_divergent trace");
assert.equal(xfDivergence.value.worker_family, "openai-codex");
assert.equal(xfDivergence.value.host_family, "anthropic");
assert.equal(xfDivergence.value.model_resolved, "openai-codex/gpt-5.5");
assert.equal(xfDivergence.value.host_model, "anthropic/claude-opus-4-8");
// status() exposes the cross-family flag while the worker is still in flight.
const xfStatus = xfCoordinator.status(xfAgent);
assert.equal(xfStatus.model_cross_family, true);
assert.equal(xfStatus.model_family, "openai-codex");
assert.equal(xfStatus.model_host, "anthropic/claude-opus-4-8");
// The provenance is stamped on the collected step result.
await waitFor(() => xfCoordinator.status(xfAgent).state === "done");
const xfCollect = xfCoordinator.collect(xfAgent);
assert.equal(xfCollect.ready, true);
assert.equal(xfCollect.step_result.model_resolved, "openai-codex/gpt-5.5");
assert.equal(xfCollect.step_result.model_host, "anthropic/claude-opus-4-8");
assert.equal(xfCollect.step_result.model_family, "openai-codex");
assert.equal(xfCollect.step_result.model_cross_family, true);

// Same-family worker: no divergence signal, no false positive.
const { agent_id: sfAgent } = xfCoordinator.spawn({
  agent_id: "implementer",
  model_class: "code-strong",
  model: { provider: "anthropic", id: "claude-opus-4-8" },
  step_id: "review",
  context_packet: "BDD: same-family implementation.",
  owned_files: ["src/sf-impl.js"],
});
assert.equal(
  xfEntries.some(
    (entry) =>
      entry.name === SUBAGENT_EVENT_ENTRY &&
      entry.value.event === "worker_model_divergent" &&
      String(entry.value.agent_id).startsWith("implementer"),
  ),
  false,
  "same-family spawn must NOT emit a divergence trace",
);
const sfStatus = xfCoordinator.status(sfAgent);
assert.equal(sfStatus.model_cross_family, false);
assert.equal(sfStatus.model_family, "anthropic");
await waitFor(() => xfCoordinator.status(sfAgent).state === "done");
const sfCollect = xfCoordinator.collect(sfAgent);
assert.equal(sfCollect.step_result.model_cross_family, false);
assert.equal(sfCollect.step_result.model_family, "anthropic");
await fs.rm(xfRoot, { recursive: true, force: true });

// ── Vendored pi-spawn honors the wrapper's Pi resolution (AIPI patch tripwire) ──
// bin/aipi.js exports AIPI_PI_CLI_JS for the resolved Pi; the vendored worker
// spawn MUST honor it or host and workers can run different Pi versions. This
// test fails loudly if a pi-subagents re-sync drops the in-place patch
// (documented in extensions/aipi/runtime/vendor/pi-subagents/VENDOR.md).
{
  const { getPiSpawnCommand } = jiti("../extensions/aipi/runtime/vendor/pi-subagents/src/runs/shared/pi-spawn.ts");
  const overriddenCli = getPiSpawnCommand(["--version"], {
    platform: "linux",
    env: { AIPI_PI_CLI_JS: "/opt/aipi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" },
    existsSync: () => true,
    execPath: "/usr/bin/node",
  });
  assert.equal(overriddenCli.command, "/usr/bin/node", "AIPI_PI_CLI_JS override must be honored on non-Windows");
  assert.equal(overriddenCli.args[0], "/opt/aipi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const overriddenBin = getPiSpawnCommand(["--version"], {
    platform: "linux",
    env: { AIPI_PI_BIN: "/usr/local/bin/pi-pinned" },
  });
  assert.equal(overriddenBin.command, "/usr/local/bin/pi-pinned");
  const fallback = getPiSpawnCommand(["--version"], { platform: "linux", env: {} });
  assert.equal(fallback.command, "pi", "no override falls back to PATH pi");
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

// --- interactive aipi_spawn_agent resolves model_class -> configured model (not host fallback) ---
{
  const modelRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-spawn-model-"));
  await fs.mkdir(path.join(modelRoot, ".aipi"), { recursive: true });
  // A real aipi project always carries both files; resolveModelClass reads the class catalog too.
  await fs.copyFile(
    path.join(process.cwd(), "templates", ".aipi", "model-classes.yaml"),
    path.join(modelRoot, ".aipi", "model-classes.yaml"),
  );
  await fs.writeFile(
    path.join(modelRoot, ".aipi", "model-capabilities.json"),
    JSON.stringify({
      schema: "aipi.model-capabilities.v1",
      classes: { "code-strong": "anthropic/claude-sonnet-5" },
      models: { "anthropic:claude-sonnet-5": { capabilities: { coding: "high", context: "very_high" } } },
    }),
    "utf8",
  );

  // A class bound in model-capabilities.json resolves to that concrete model, even though the
  // session (host) model is different — this is the gap the fix closes.
  const resolved = await resolveInteractiveSpawnModel(
    { agent_id: "coder", model_class: "code-strong" },
    { root: modelRoot, env: {}, ctx: { model: "openai-codex/gpt-5.6-sol" } },
  );
  assert.deepEqual(resolved.model, { provider: "anthropic", id: "claude-sonnet-5" });
  assert.equal(resolved.model_resolution_source, "model-capabilities");

  // An already-concrete model on the spawn params is left untouched.
  const preset = await resolveInteractiveSpawnModel(
    { model_class: "code-strong", model: { provider: "x", id: "y" } },
    { root: modelRoot, env: {} },
  );
  assert.deepEqual(preset.model, { provider: "x", id: "y" });

  // An unbound/unknown class does NOT get a model bound -> the coordinator keeps host-fallback semantics.
  const unbound = await resolveInteractiveSpawnModel(
    { model_class: "totally-unknown" },
    { root: modelRoot, env: {}, ctx: { model: "openai-codex/gpt-5.6-sol" } },
  );
  assert.equal("model" in unbound, false, "unbound class stays on host fallback");

  // A spawn with no model_class at all is a pass-through.
  const classless = await resolveInteractiveSpawnModel(
    { agent_id: "coder" },
    { root: modelRoot, env: {}, ctx: { model: "openai-codex/gpt-5.6-sol" } },
  );
  assert.equal("model" in classless, false);
}

console.log("subagents interactive-spawn model resolution: ok");

// --- live worker<->orchestrator ask/answer channel ---
{
  const askEntries = [];
  const askCoordinator = new SubagentCoordinator(
    { appendEntry(name, value) { askEntries.push({ name, value }); } },
    {
      root: process.cwd(),
      maxConcurrent: 1,
      hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
      piSubagentsRunner: {
        // A worker that hits ambiguity, asks the orchestrator via the in-process bridge (exactly what the
        // aipi_ask_orchestrator child tool does), blocks on the answer, then finishes.
        async spawn(params) {
          const agentId = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? params.id ?? "ask";
          const answer = await aipiAskBridge().ask(agentId, "which price wins on renewal?");
          return {
            content: [{ type: "text", text: JSON.stringify({ ...stepResult, agent_ids: [agentId], notes: answer }) }],
            tool_call_count: 0,
          };
        },
      },
    },
  );
  const { agent_id: askAgentId } = askCoordinator.spawn({
    agent_id: "ask",
    step_id: "review_swarm",
    context_packet: "BDD: ask path.",
    owned_files: ["src/ask.js"],
  });
  // Worker starts, asks, and blocks -> status surfaces the pending question.
  await waitFor(() => askCoordinator.status(askAgentId).awaiting_answer === true);
  const pending = askCoordinator.status(askAgentId);
  assert.equal(pending.pending_question, "which price wins on renewal?");
  assert.equal(pending.awaiting_answer, true);
  assert.equal(pending.state, "running", "worker stays running while blocked on the orchestrator");
  // collect() surfaces the pending question too, so the orchestrator's natural "is it done?" loop catches
  // it without a separate status poll.
  const blockedCollect = askCoordinator.collect(askAgentId);
  assert.equal(blockedCollect.ready, false);
  assert.equal(blockedCollect.pending_question, "which price wins on renewal?");
  assert.equal(blockedCollect.awaiting_answer, true);
  // Orchestrator answers -> worker unblocks and completes with the answer threaded in.
  const ans = askCoordinator.answer(askAgentId, "keep the current price");
  assert.equal(ans.accepted, true);
  assert.equal(ans.answered_question, "which price wins on renewal?");
  await waitFor(() => askCoordinator.status(askAgentId).state === "done");
  assert.equal(askCoordinator.status(askAgentId).awaiting_answer, false);
  assert.equal(askCoordinator.status(askAgentId).pending_question, null);
  // Both sides traced.
  assert.equal(askEntries.some((entry) => entry.value?.event === "worker_ask"), true);
  assert.equal(askEntries.some((entry) => entry.value?.event === "worker_answer"), true);
  // Answering with nothing pending is a rejected no-op, not a throw.
  const late = askCoordinator.answer(askAgentId, "too late");
  assert.equal(late.accepted, false);
}

// --- ask/answer edge cases: unknown agent, cancel rejects the pending question ---
{
  await assert.rejects(aipiAskBridge().ask("nonexistent:agent", "hi?"), /no live AIPI coordinator/);

  const cancelEntries = [];
  const cancelCoordinator = new SubagentCoordinator(
    { appendEntry(name, value) { cancelEntries.push({ name, value }); } },
    {
      root: process.cwd(),
      maxConcurrent: 1,
      hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
      piSubagentsRunner: {
        async spawn(params) {
          const agentId = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? params.id ?? "cancelask";
          // Blocks forever on the orchestrator; cancel must reject the pending question so this rejects.
          try {
            await aipiAskBridge().ask(agentId, "blocking question");
            return { content: [{ type: "text", text: JSON.stringify({ ...stepResult, agent_ids: [agentId] }) }], tool_call_count: 0 };
          } catch (error) {
            throw new Error(`ask rejected: ${error.message}`);
          }
        },
      },
    },
  );
  const { agent_id: cancelAgentId } = cancelCoordinator.spawn({
    agent_id: "cancelask",
    step_id: "review_swarm",
    context_packet: "BDD: cancel path.",
    owned_files: ["src/cancelask.js"],
  });
  await waitFor(() => cancelCoordinator.status(cancelAgentId).awaiting_answer === true);
  cancelCoordinator.cancel(cancelAgentId);
  // Cancel cleared the pending question immediately.
  assert.equal(cancelCoordinator.status(cancelAgentId).awaiting_answer, false);
  assert.equal(cancelCoordinator.status(cancelAgentId).pending_question, null);
}

console.log("subagents ask/answer channel: ok");

// --- BLOCKER regression: an UNANSWERED question expires so the worker degrades and FINISHES (no hang,
//     no leaked worker slot). This is the escape for the workflow path where nobody calls aipi_answer_agent.
//     The ask timeout is a BAKED default (120s); tests set it short via the constructor option, not env. ---
{
  const timeoutCoordinator = new SubagentCoordinator(
    { appendEntry() {} },
    {
      root: process.cwd(),
      maxConcurrent: 1,
      hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
      workerAskTimeoutMs: 40, // expire fast for the test (constructor option, not env)
      piSubagentsRunner: {
        async spawn(params) {
          const agentId = params.task.match(/AIPI worker id: ([^\n]+)/)?.[1] ?? params.id ?? "toask";
          let degraded = false;
          try {
            await aipiAskBridge().ask(agentId, "nobody will answer this");
          } catch {
            degraded = true; // the question expired -> the worker proceeds on best judgment
          }
          return { content: [{ type: "text", text: JSON.stringify({ ...stepResult, agent_ids: [agentId], degraded }) }], tool_call_count: 0 };
        },
      },
    },
  );
  const { agent_id: toAskId } = timeoutCoordinator.spawn({
    agent_id: "toask", step_id: "review_swarm", context_packet: "x", owned_files: ["src/toask.js"],
  });
  // No one answers; the question expires and the worker COMPLETES rather than hanging forever.
  await waitFor(() => timeoutCoordinator.status(toAskId).state === "done");
  assert.equal(timeoutCoordinator.status(toAskId).awaiting_answer, false, "expired question cleared");
  assert.equal(timeoutCoordinator.status(toAskId).pending_question, null);
}

// --- budget-aware worker prompt: warns the worker to deliver before the tool-call limit ---
{
  const withBudget = createAipiWorkerAgentConfig({ maxToolCalls: 80 });
  assert.ok(/budget/i.test(withBudget.systemPrompt), "prompt mentions the tool-call budget");
  assert.ok(withBudget.systemPrompt.includes("80"), "prompt states the concrete budget");
  assert.ok(/DISCARDS/.test(withBudget.systemPrompt), "prompt warns that exceeding it discards the work");
  const noBudget = createAipiWorkerAgentConfig({});
  assert.ok(/budget/i.test(noBudget.systemPrompt), "generic budget warning present even without a number");
}

console.log("subagents ask-timeout + budget-aware prompt: ok");
