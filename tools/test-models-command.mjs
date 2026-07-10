import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  formatModelsCommandResult,
  parseModelsArgs,
  registryModelSpecs,
  registryThinkingLevels,
  runModelsCommand,
  supportedThinkingLevels,
} from "../extensions/aipi/runtime/models-command.js";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  inspectAdversarialFamilyIsolation,
  resolveModelClass,
  resolveStepModel,
} from "../extensions/aipi/runtime/model-router.js";
import { runAipiModels } from "../bin/aipi.js";

// SAFETY: the setup wizard can write the orchestrator (default model) into Pi's settings.json. Point the Pi
// agent dir at a throwaway temp dir for the whole test so no run ever touches the developer's real
// ~/.pi/agent/settings.json. (writeOrchestratorDefault honors PI_CODING_AGENT_DIR.)
process.env.PI_CODING_AGENT_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-models-agent-"));

assert.deepEqual(
  parseModelsArgs([
    "--target",
    "project",
    "--json",
    "setup",
    "--host",
    "openai-codex/gpt-5.5",
    "--adversarial",
    "anthropic/claude-opus-4-8",
  ], { cwd: path.join("C:", "repo") }),
  {
    action: "setup",
    actionExplicit: true,
    target: path.resolve(path.join("C:", "repo"), "project"),
    json: true,
    interactive: true,
    hostModel: "openai-codex/gpt-5.5",
    adversarialModel: "anthropic/claude-opus-4-8",
    verifierModel: null,
    orchestrator: null,
    models: [],
    buckets: { "doer-adversarial": "anthropic/claude-opus-4-8" },
    classBindings: {},
    budgetNotes: {},
  },
);

// The bucket flags each parse to options.buckets[bucket]; --adversarial is the legacy alias for doer-adversarial.
assert.deepEqual(
  parseModelsArgs([
    "setup",
    "--planner",
    "openai-codex/gpt-5.5:high",
    "--planner-adversarial",
    "anthropic/claude-sonnet-5:high",
    "--adversarial",
    "anthropic/claude-opus-4-8:high",
    "--doer",
    "openai-codex/gpt-5.5:medium",
    "--doer-adversarial",
    "xai-auth/grok-4.5:high",
    "--mover",
    "anthropic/claude-haiku-4-5:low",
  ], { cwd: path.join("C:", "repo") }).buckets,
  {
    planner: "openai-codex/gpt-5.5:high",
    "planner-adversarial": "anthropic/claude-sonnet-5:high",
    // --adversarial and --doer-adversarial both target doer-adversarial; the later flag wins.
    "doer-adversarial": "xai-auth/grok-4.5:high",
    doer: "openai-codex/gpt-5.5:medium",
    mover: "anthropic/claude-haiku-4-5:low",
  },
);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-models-command-"));
try {
  await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: root });
  const report = await runModelsCommand({
    projectRoot: root,
    args: [
      "setup",
      "--host",
      "openai-codex/gpt-5.5",
      "--adversarial",
      "anthropic/claude-opus-4-8",
      "--verifier",
      "anthropic/claude-verify",
      "--budget-note",
      "context-fast=Use a cheaper summarizer before long high-volume runs.",
    ],
    now: () => new Date("2026-06-22T00:00:00.000Z"),
  });

  assert.equal(report.state, "ready");
  assert.equal(report.host_model, "openai-codex/gpt-5.5");
  assert.equal(report.adversarial_reviewer_model, "anthropic/claude-opus-4-8");
  assert.equal(report.adversarial_reviewer_distinct, true);
  assert.equal(report.adversarial_family_isolation.state, "pass");
  assert.equal(report.capability_floors.state, "pass");
  assert.equal(report.warnings.some((warning) => warning.model_class === "context-fast"), true);
  assert.match(formatModelsCommandResult(report), /AIPI models setup: ready/);

  const config = JSON.parse(await fs.readFile(path.join(root, ".aipi", "model-capabilities.json"), "utf8"));
  assert.equal(config.classes["code-strong"], "openai-codex/gpt-5.5");
  assert.equal(config.classes["context-fast"], "openai-codex/gpt-5.5");
  assert.equal(config.classes["adversarial-heavy"], "anthropic/claude-opus-4-8");
  assert.equal(config.classes["verifier-fast"], "anthropic/claude-verify");
  assert.equal(config.models["openai-codex:gpt-5.5"].capabilities.tool_use, "write_capable");
  assert.equal(config.models["anthropic:claude-opus-4-8"].capabilities.evidence_audit, "supported");

  const budget = JSON.parse(await fs.readFile(path.join(root, ".aipi", "provider-budget.json"), "utf8"));
  assert.equal(budget.class_notes["context-fast"], "Use a cheaper summarizer before long high-volume runs.");

  const codeStrong = await resolveModelClass({ root, modelClass: "code-strong" });
  assert.deepEqual(codeStrong.model, { provider: "openai-codex", id: "gpt-5.5" });
  const reviewer = await resolveStepModel({
    root,
    step: { agents: ["code-reviewer"] },
    ctx: { model: { provider: "openai-codex", id: "gpt-5.5" } },
  });
  assert.deepEqual(reviewer.model, { provider: "anthropic", id: "claude-opus-4-8" });
  assert.equal(reviewer.cross_model_adversarial.distinct_provider, true);
  assert.equal((await inspectAdversarialFamilyIsolation({ root })).state, "pass");

  // Cross-model independence is a RECOMMENDATION, not a hard requirement: a same-family doer/adversarial now
  // WARNS instead of throwing (you must be able to configure effort with a single authed provider).
  const sameProviderRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-effort-sameprov-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: sameProviderRoot });
    const sameProviderReport = await runModelsCommand({
      projectRoot: sameProviderRoot,
      args: ["setup", "--host", "openai-codex/gpt-5.5", "--adversarial", "openai-codex/gpt-5.1"],
    });
    assert.ok(
      (sameProviderReport.warnings ?? []).some((w) => w.code === "AIPI_EFFORT_ADVERSARIAL_SHARES_FAMILY"),
      "same-family adversarial warns instead of throwing",
    );
  } finally {
    await fs.rm(sameProviderRoot, { recursive: true, force: true });
  }

  // ===================================================================
  // REAL-PATH 4-bucket wizard test. Drive runModelsCommand with a stubbed readline/ui
  // choosing, per bucket, a cross-provider model + thinking level. Then assert via the
  // REAL resolvers (resolveModelClass from model-router.js) that each class resolves to
  // its bucket's MODEL *and* its bucket's persisted thinking LEVEL.
  // ===================================================================
  const interactiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-effort-wizard-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: interactiveRoot });
    const prompts = [];
    // 5 buckets: planner=openai-codex/gpt-5.5:high, planner-adversarial=anthropic/opus:high,
    // doer=openai-codex/gpt-5.5:medium, doer-adversarial=anthropic/opus:high, mover=anthropic/haiku:low.
    const bucketAnswers = {
      planner: { model: "openai-codex/gpt-5.5", level: "high" },
      "planner-adversarial": { model: "anthropic/claude-opus-4-8", level: "high" },
      doer: { model: "openai-codex/gpt-5.5", level: "medium" },
      "doer-adversarial": { model: "anthropic/claude-opus-4-8", level: "high" },
      mover: { model: "anthropic/claude-haiku-4-5", level: "low" },
    };
    const answerFor = (question) => {
      // Longest bucket name first so "planner-adversarial" matches before "planner".
      for (const bucket of Object.keys(bucketAnswers).sort((a, b) => b.length - a.length)) {
        if (new RegExp(`^${bucket}`, "i").test(question)) {
          const answer = bucketAnswers[bucket];
          return /thinking level/i.test(question) ? answer.level : answer.model;
        }
      }
      return "";
    };
    const interactiveReport = await runModelsCommand({
      projectRoot: interactiveRoot,
      args: ["setup"],
      ui: {
        async input(question) {
          prompts.push(question);
          return answerFor(question);
        },
      },
      now: () => new Date("2026-06-22T01:00:00.000Z"),
    });
    assert.equal(interactiveReport.state, "ready");
    // The wizard prompts all 5 BUCKETS (model + thinking level each), not the classes.
    assert.equal(prompts.some((prompt) => /^Planner \(.*model/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Planner \(.*thinking level/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Planner-adversarial.*model/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Doer \(.*model/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Doer-adversarial.*model/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Mover.*model/i.test(prompt)), true);

    // class_thinking is persisted in model-capabilities.json per class.
    const interactiveConfig = JSON.parse(await fs.readFile(
      path.join(interactiveRoot, ".aipi", "model-capabilities.json"),
      "utf8",
    ));
    // Bucket MODEL fans out to its classes.
    assert.equal(interactiveConfig.classes["orchestrator-heavy"], "openai-codex/gpt-5.5"); // planner
    assert.equal(interactiveConfig.classes["planner-heavy"], "openai-codex/gpt-5.5");
    assert.equal(interactiveConfig.classes["research-heavy"], "openai-codex/gpt-5.5");
    assert.equal(interactiveConfig.classes["planner-adversarial-heavy"], "anthropic/claude-opus-4-8"); // planner-adversarial
    assert.equal(interactiveConfig.classes["adversarial-heavy"], "anthropic/claude-opus-4-8"); // doer-adversarial
    assert.equal(interactiveConfig.classes["verifier-fast"], "anthropic/claude-opus-4-8");
    assert.equal(interactiveConfig.classes["code-strong"], "openai-codex/gpt-5.5"); // doer
    assert.equal(interactiveConfig.classes["test-strong"], "openai-codex/gpt-5.5");
    assert.equal(interactiveConfig.classes["context-fast"], "anthropic/claude-haiku-4-5"); // mover
    // Bucket LEVEL fans out to config.class_thinking[<class>].
    assert.equal(interactiveConfig.class_thinking["orchestrator-heavy"], "high");
    assert.equal(interactiveConfig.class_thinking["planner-adversarial-heavy"], "high");
    assert.equal(interactiveConfig.class_thinking["adversarial-heavy"], "high");
    assert.equal(interactiveConfig.class_thinking["code-strong"], "medium");
    assert.equal(interactiveConfig.class_thinking["context-fast"], "low");

    // Assert via the REAL resolver that every class resolves to its bucket LEVEL (proves the router reads it).
    const expectedByClass = {
      "orchestrator-heavy": { provider: "openai-codex", id: "gpt-5.5", level: "high" },
      "planner-heavy": { provider: "openai-codex", id: "gpt-5.5", level: "high" },
      "research-heavy": { provider: "openai-codex", id: "gpt-5.5", level: "high" },
      "planner-adversarial-heavy": { provider: "anthropic", id: "claude-opus-4-8", level: "high" },
      "adversarial-heavy": { provider: "anthropic", id: "claude-opus-4-8", level: "high" },
      "verifier-fast": { provider: "anthropic", id: "claude-opus-4-8", level: "high" },
      "code-strong": { provider: "openai-codex", id: "gpt-5.5", level: "medium" },
      "test-strong": { provider: "openai-codex", id: "gpt-5.5", level: "medium" },
      "context-fast": { provider: "anthropic", id: "claude-haiku-4-5", level: "low" },
    };
    for (const [modelClass, expected] of Object.entries(expectedByClass)) {
      const route = await resolveModelClass({ root: interactiveRoot, modelClass });
      assert.equal(
        route.thinking_level,
        expected.level,
        `${modelClass} thinking_level must be the persisted bucket level (read by router)`,
      );
      // The cross-family review classes may re-select a distinct family; only assert the model for the rest.
      if (!["adversarial-heavy", "planner-adversarial-heavy", "verifier-fast"].includes(modelClass)) {
        assert.deepEqual(
          route.model,
          { provider: expected.provider, id: expected.id },
          `${modelClass} must resolve to its bucket model`,
        );
      }
    }

    const plannerRoute = await resolveModelClass({ root: interactiveRoot, modelClass: "planner-heavy" });
    assert.deepEqual(plannerRoute.model, { provider: "openai-codex", id: "gpt-5.5" });
    const advRoute = await resolveModelClass({ root: interactiveRoot, modelClass: "adversarial-heavy" });
    assert.equal(advRoute.model.provider, "anthropic");
    const planAdvRoute = await resolveModelClass({ root: interactiveRoot, modelClass: "planner-adversarial-heavy" });
    assert.equal(planAdvRoute.model.provider, "anthropic", "plan reviewer resolves to its configured family");
    assert.equal((await inspectAdversarialFamilyIsolation({ root: interactiveRoot })).state, "pass");
  } finally {
    await fs.rm(interactiveRoot, { recursive: true, force: true });
  }

  // ===================================================================
  // BARE INVOCATION launches the wizard. `aipi effort` / `/aipi-effort` with NO action and an
  // interactive UI must open the 4-bucket setup wizard (the command's whole purpose) instead of
  // only printing status. Status stays reachable via an explicit `status` action, and --json /
  // non-interactive callers still default to status.
  // ===================================================================
  // Parse: a bare action is NOT explicit; an explicit action token is.
  assert.equal(parseModelsArgs([]).actionExplicit, false);
  assert.equal(parseModelsArgs([]).action, "status");
  assert.equal(parseModelsArgs(["status"]).actionExplicit, true);
  assert.equal(parseModelsArgs(["wizard"]).action, "setup");
  assert.equal(parseModelsArgs(["configure"]).action, "setup");
  assert.throws(() => parseModelsArgs(["i"]), /unknown aipi effort action: i/);

  const bareWizardRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-effort-bare-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: bareWizardRoot });
    const barePrompts = [];
    const bareAnswers = {
      planner: { model: "openai-codex/gpt-5.5", level: "high" },
      adversarial: { model: "anthropic/claude-opus-4-8", level: "high" },
      doer: { model: "openai-codex/gpt-5.5", level: "medium" },
      mover: { model: "anthropic/claude-haiku-4-5", level: "low" },
    };
    const bareAnswerFor = (question) => {
      for (const [bucket, answer] of Object.entries(bareAnswers)) {
        if (new RegExp(`^${bucket}`, "i").test(question)) {
          return /thinking level/i.test(question) ? answer.level : answer.model;
        }
      }
      return "";
    };
    // NO action arg at all + an interactive UI -> the wizard runs and writes the config.
    const bareReport = await runModelsCommand({
      projectRoot: bareWizardRoot,
      args: [],
      ui: {
        async input(question) {
          barePrompts.push(question);
          return bareAnswerFor(question);
        },
      },
      now: () => new Date("2026-06-22T03:30:00.000Z"),
    });
    assert.equal(bareReport.action, "setup", "bare invocation with an interactive UI must run the setup wizard");
    assert.equal(bareReport.state, "ready");
    assert.equal(barePrompts.some((prompt) => /^Planner.*model/i.test(prompt)), true);
    assert.equal(barePrompts.some((prompt) => /^Doer.*model/i.test(prompt)), true);
    const bareConfig = JSON.parse(await fs.readFile(path.join(bareWizardRoot, ".aipi", "model-capabilities.json"), "utf8"));
    assert.equal(bareConfig.classes["code-strong"], "openai-codex/gpt-5.5");

    // --json (machine) callers do NOT get hijacked into the wizard: status is returned and the UI
    // is never prompted.
    const jsonPrompts = [];
    const jsonReport = await runModelsCommand({
      projectRoot: bareWizardRoot,
      args: ["--json"],
      ui: { async input(question) { jsonPrompts.push(question); return ""; } },
      now: () => new Date("2026-06-22T03:31:00.000Z"),
    });
    assert.equal(jsonReport.action, "status");
    assert.equal(jsonPrompts.length, 0);

    // An explicit `status` action is honored even with an interactive UI (no wizard).
    const statusReport = await runModelsCommand({
      projectRoot: bareWizardRoot,
      args: ["status"],
      ui: { async input() { throw new Error("explicit status must not prompt"); } },
      now: () => new Date("2026-06-22T03:32:00.000Z"),
    });
    assert.equal(statusReport.action, "status");
  } finally {
    await fs.rm(bareWizardRoot, { recursive: true, force: true });
  }

  // ===================================================================
  // adversarial-shares-family WARNING (soft — there is NO hard error). Fires for whichever peer bucket
  // (doer and/or planner) shares the adversarial family. The user's choice always stands.
  // ===================================================================
  const sameFamilyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-effort-samefamily-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: sameFamilyRoot });
    const sameFamilyReport = await runModelsCommand({
      projectRoot: sameFamilyRoot,
      args: [
        "setup",
        "--planner",
        "anthropic/claude-opus-4-8:high",
        "--adversarial",
        "anthropic/claude-haiku-4-5:high",
        "--doer",
        "openai-codex/gpt-5.5:medium",
        "--mover",
        "anthropic/claude-haiku-4-5:low",
      ],
      now: () => new Date("2026-06-22T02:00:00.000Z"),
    });
    const sameFamilyWarning = sameFamilyReport.warnings.find(
      (warning) => warning.code === "AIPI_EFFORT_ADVERSARIAL_SHARES_FAMILY" && warning.peer_bucket === "planner",
    );
    assert.ok(sameFamilyWarning, "adversarial==planner-family warning must fire when both are anthropic");
    assert.equal(sameFamilyWarning.severity, "warning");
    assert.match(sameFamilyWarning.message, /cross-model adversarial independence/);

    // Same-family doer==adversarial now WARNS too (was a hard error) — the user's choice stands.
    const doerSameReport = await runModelsCommand({
      projectRoot: sameFamilyRoot,
      args: ["setup", "--doer", "anthropic/claude-sonnet-4-5", "--adversarial", "anthropic/claude-haiku-4-5"],
      now: () => new Date("2026-06-22T02:00:00.000Z"),
    });
    assert.ok(
      doerSameReport.warnings.some(
        (w) => w.code === "AIPI_EFFORT_ADVERSARIAL_SHARES_FAMILY" && w.peer_bucket === "doer",
      ),
      "doer==adversarial family now warns (doer peer) instead of throwing",
    );
  } finally {
    await fs.rm(sameFamilyRoot, { recursive: true, force: true });
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

// ===================================================================
// CR-60-1 end-to-end CLI surface: a bare, interactive `aipi effort` (via runAipiModels) drives the
// REAL terminal prompt UI (createCliPromptUi, NOT an injected adapter) over readline/promises and
// writes the config. This exercises the exact path Codex flagged: the built UI must return answers.
// ===================================================================
const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-effort-cli-"));
try {
  await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: cliRoot });
  const cliInput = new PassThrough();
  const cliOutput = new PassThrough();
  const cliAnswers = {
    planner: { model: "openai-codex/gpt-5.5", level: "high" },
    "planner-adversarial": { model: "anthropic/claude-opus-4-8", level: "high" },
    doer: { model: "openai-codex/gpt-5.5", level: "medium" },
    "doer-adversarial": { model: "anthropic/claude-opus-4-8", level: "high" },
    mover: { model: "anthropic/claude-haiku-4-5", level: "low" },
  };
  // Respond to each wizard prompt as the REAL createCliPromptUi writes it to the output stream (the
  // readline prompt) — order-independent and proves the built UI both writes prompts and reads answers.
  const cliPrompts = [];
  cliOutput.on("data", (chunk) => {
    const question = chunk.toString();
    if (!/model|thinking level/i.test(question)) return;
    cliPrompts.push(question);
    let answer = "";
    // Longest bucket name first so "doer-adversarial" matches before "doer".
    for (const bucket of Object.keys(cliAnswers).sort((a, b) => b.length - a.length)) {
      if (new RegExp(`^${bucket}`, "i").test(question.trim())) {
        const value = cliAnswers[bucket];
        answer = /thinking level/i.test(question) ? value.level : value.model;
        break;
      }
    }
    cliInput.write(`${answer}\n`);
  });
  const cliOut = [];
  // Bare CLI `aipi effort` (classifyAipiInvocation strips the "effort" token) + interactive TTY,
  // driving the real readline-backed prompt UI through injected streams (no promptAdapter).
  const cliResult = await runAipiModels({
    cwd: cliRoot,
    userArgs: ["--target", cliRoot],
    isInteractive: true,
    promptStreams: { input: cliInput, output: cliOutput },
    log: (line) => cliOut.push(line),
  });
  assert.equal(cliResult.action, "setup", "bare interactive CLI `aipi effort` must run the wizard");
  assert.equal(cliResult.state, "ready");
  // The real terminal UI actually emitted the bucket prompts (not a no-op stub).
  assert.equal(cliPrompts.some((prompt) => /^Doer.*model/i.test(prompt.trim())), true);
  const cliConfig = JSON.parse(await fs.readFile(path.join(cliRoot, ".aipi", "model-capabilities.json"), "utf8"));
  // The real terminal UI collected the typed answers and fanned them out to the bucket classes.
  assert.equal(cliConfig.classes["code-strong"], "openai-codex/gpt-5.5"); // doer
  assert.equal(cliConfig.classes["adversarial-heavy"], "anthropic/claude-opus-4-8");
  assert.equal(cliConfig.classes["context-fast"], "anthropic/claude-haiku-4-5"); // mover
  assert.equal(cliConfig.class_thinking["code-strong"], "medium");
  assert.equal(cliConfig.class_thinking["context-fast"], "low");
} finally {
  await fs.rm(cliRoot, { recursive: true, force: true });
}

// === registryModelSpecs: a Pi ModelRegistry -> provider/model specs (getAvailable only) ===
{
  const specs = registryModelSpecs({
    getAvailable: () => [
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "xai-auth", model: "grok-4.5" }, // tolerate .model as well as .id
      { provider: "", id: "" }, // incomplete -> dropped
    ],
  });
  assert.deepEqual(specs, ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.6-sol", "xai-auth/grok-4.5"]);
  assert.deepEqual(registryModelSpecs(null), [], "no registry -> empty");
  assert.deepEqual(registryModelSpecs({ getAvailable: () => { throw new Error("boom"); } }), [], "never throws");
}

// === supportedThinkingLevels: derive per-model levels exactly like Pi's getSupportedThinkingLevels ===
{
  // Reasoning model, no thinkingLevelMap -> up to high; xhigh needs an explicit declaration.
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: true }),
    ["off", "minimal", "low", "medium", "high"],
    "custom reasoning model (no map) tops out at high, not xhigh",
  );
  // Explicit xhigh declaration -> xhigh becomes available.
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "x" } }),
    ["off", "minimal", "low", "medium", "high", "xhigh"],
    "explicit xhigh is offered",
  );
  // A level pinned to null is dropped.
  assert.ok(
    !supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null } }).includes("minimal"),
    "a null-mapped level is unsupported",
  );
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"], "non-reasoning model -> off only");
  assert.equal(supportedThinkingLevels(null), null, "unknown model -> null (caller falls back to free-text)");
}

// === registryThinkingLevels: ModelRegistry -> { provider/id: levels[] } (getAvailable only) ===
{
  const map = registryThinkingLevels({
    getAvailable: () => [
      { provider: "anthropic", id: "claude-sonnet-5", reasoning: true }, // custom: max high
      { provider: "xai-auth", model: "grok-4.5", reasoning: true, thinkingLevelMap: { xhigh: "x" } }, // supports xhigh
      { provider: "", id: "" }, // incomplete -> dropped
    ],
  });
  assert.deepEqual(map["anthropic/claude-sonnet-5"], ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(map["xai-auth/grok-4.5"], ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(Object.keys(map).length, 2, "incomplete entries dropped");
  assert.deepEqual(registryThinkingLevels(null), {}, "no registry -> empty map");
  assert.deepEqual(registryThinkingLevels({ getAvailable: () => { throw new Error("boom"); } }), {}, "never throws");
}

// === wizard thinking prompt is CONDITIONAL on the chosen model's supported levels ===
{
  const condRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-effort-thinking-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: condRoot });
    const available = ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.6-sol"];
    const thinkingLevels = {
      "anthropic/claude-opus-4-8": ["off", "minimal", "low", "medium", "high", "xhigh"], // supports xhigh
      "openai-codex/gpt-5.6-sol": ["off", "minimal", "low", "medium", "high"], // max high
    };
    const thinkingSelects = [];
    const ui = {
      async select(title, options) {
        if (/thinking level/i.test(title)) {
          thinkingSelects.push({ title, options });
          return options[0]; // pick the strongest ("<max> (max for ...)")
        }
        if (/adversarial/i.test(title)) return "openai-codex/gpt-5.6-sol"; // cross-provider from the anthropic doer
        return "anthropic/claude-opus-4-8";
      },
      async input() { throw new Error("thinking must use the conditional SELECT, not free-text"); },
    };
    const report = await runModelsCommand({
      projectRoot: condRoot,
      args: ["setup"],
      ui,
      availableModels: available,
      thinkingLevels,
    });
    assert.ok(report, "wizard completed via conditional selects");
    // The opus buckets offered xhigh (opus supports it); the GPT adversarial bucket did NOT (max high).
    const opusPrompt = thinkingSelects.find((s) => /claude-opus-4-8 supports/.test(s.title));
    const gptPrompt = thinkingSelects.find((s) => /gpt-5\.6-sol supports/.test(s.title));
    assert.ok(opusPrompt && opusPrompt.options.some((o) => /^xhigh/.test(o)), "opus offers xhigh");
    assert.ok(gptPrompt && !gptPrompt.options.some((o) => /^xhigh/.test(o)), "gpt-5.6-sol does NOT offer xhigh");
    assert.ok(/^high /.test(gptPrompt.options[0]), "strongest-first: gpt leads with high (its max)");

    // The chosen strongest levels were written into class_thinking.
    const written = JSON.parse(await fs.readFile(path.join(condRoot, ".aipi/model-capabilities.json"), "utf8"));
    assert.equal(written.class_thinking["code-strong"], "xhigh", "doer=opus wrote its max (xhigh)");
    assert.equal(written.class_thinking["adversarial-heavy"], "high", "adversarial=gpt wrote its max (high)");
  } finally {
    await fs.rm(condRoot, { recursive: true, force: true });
  }
}

// === wizard SELECTS from the real available models (native ctx.ui.select) instead of typing ===
{
  const selectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-effort-select-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: selectRoot });
    // The host's auth'd models — includes a brand-new one (grok-4.5) to prove it is OFFERED for selection.
    const available = [
      "anthropic/claude-opus-4-8",
      "openai-codex/gpt-5.5",
      "anthropic/claude-haiku-4-5",
      "xai-auth/grok-4.5",
    ];
    const offered = [];
    const ui = {
      async select(title, options) {
        offered.push({ title, options });
        if (/adversarial/i.test(title)) return "openai-codex/gpt-5.5"; // cross-provider from the anthropic doer
        if (/mover/i.test(title)) return "anthropic/claude-haiku-4-5";
        return "anthropic/claude-opus-4-8"; // planner + doer
      },
      async input() { return "high"; }, // thinking level per bucket
    };
    const report = await runModelsCommand({
      projectRoot: selectRoot,
      args: ["setup"],
      availableModels: available,
      ui,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    assert.equal(report.state, "ready");
    // The picker was offered the REAL available models — the whole point (grok-4.5 was never configured).
    assert.ok(offered.some((call) => call.options.includes("xai-auth/grok-4.5")), "available models offered in the selector");
    // …with a manual-entry escape hatch for a model not yet in the list.
    assert.ok(
      offered.some((call) => call.options.some((opt) => /type a provider\/model manually/.test(opt))),
      "manual-entry option present",
    );
    // The selection flowed through to the persisted topology.
    const cfg = JSON.parse(await fs.readFile(path.join(selectRoot, ".aipi", "model-capabilities.json"), "utf8"));
    assert.equal(cfg.classes["code-strong"], "anthropic/claude-opus-4-8"); // doer
    assert.equal(cfg.classes["adversarial-heavy"], "openai-codex/gpt-5.5"); // adversarial (cross-provider)
    assert.equal(cfg.classes["context-fast"], "anthropic/claude-haiku-4-5"); // mover
  } finally {
    await fs.rm(selectRoot, { recursive: true, force: true });
  }
}

// === orchestrator (default model) written to Pi settings.json (merge) + seeds the doer ===
{
  const orchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-orch-"));
  const orchAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-orch-agent-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: orchRoot });
    // Existing settings.json to prove the write MERGES (other keys preserved).
    await fs.writeFile(path.join(orchAgentDir, "settings.json"), JSON.stringify({ theme: "dark", enabledModels: ["a/b"] }));

    const orchReport = await runModelsCommand({
      projectRoot: orchRoot,
      args: ["setup", "--orchestrator", "anthropic/claude-opus-4-8:high", "--adversarial", "openai-codex/gpt-5.6-sol:high"],
      agentDir: orchAgentDir,
      now: () => new Date("2026-06-22T03:00:00.000Z"),
    });
    assert.ok(orchReport.orchestrator, "report surfaces the orchestrator");
    assert.equal(orchReport.orchestrator.model, "anthropic/claude-opus-4-8");
    assert.equal(orchReport.orchestrator.thinking_level, "high");

    const settings = JSON.parse(await fs.readFile(path.join(orchAgentDir, "settings.json"), "utf8"));
    assert.equal(settings.defaultProvider, "anthropic");
    assert.equal(settings.defaultModel, "claude-opus-4-8");
    assert.equal(settings.defaultThinkingLevel, "high");
    assert.equal(settings.theme, "dark", "merge preserves existing settings");
    assert.deepEqual(settings.enabledModels, ["a/b"], "merge preserves existing settings");

    // No --doer given -> the doer defaulted to the orchestrator.
    const orchConfig = JSON.parse(await fs.readFile(path.join(orchRoot, ".aipi", "model-capabilities.json"), "utf8"));
    assert.equal(orchConfig.classes["code-strong"], "anthropic/claude-opus-4-8", "doer defaults to the orchestrator");
  } finally {
    await fs.rm(orchRoot, { recursive: true, force: true });
    await fs.rm(orchAgentDir, { recursive: true, force: true });
  }
}

// === zero-flag: doer falls back to the authed host model; NO settings write without an explicit orchestrator ===
{
  const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-hostdoer-"));
  const hostAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-hostdoer-agent-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: hostRoot });
    const report = await runModelsCommand({
      projectRoot: hostRoot,
      args: ["setup"], // no flags, no ui -> wizard skipped
      hostModel: { provider: "anthropic", id: "claude-opus-4-8" },
      availableModels: ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.6-sol"],
      agentDir: hostAgentDir,
      now: () => new Date("2026-06-22T04:00:00.000Z"),
    });
    const cfg = JSON.parse(await fs.readFile(path.join(hostRoot, ".aipi", "model-capabilities.json"), "utf8"));
    assert.equal(cfg.classes["code-strong"], "anthropic/claude-opus-4-8", "doer defaults to the authed host model");
    assert.equal(cfg.classes["adversarial-heavy"], "openai-codex/gpt-5.6-sol", "adversarial prefers a distinct authed family");
    assert.equal(report.orchestrator, null, "no orchestrator write without an explicit choice");
    let wrote = true;
    try { await fs.access(path.join(hostAgentDir, "settings.json")); } catch { wrote = false; }
    assert.equal(wrote, false, "settings.json untouched when the orchestrator is not explicitly set");
  } finally {
    await fs.rm(hostRoot, { recursive: true, force: true });
    await fs.rm(hostAgentDir, { recursive: true, force: true });
  }
}

console.log("AIPI_MODELS_COMMAND_TEST_OK");
