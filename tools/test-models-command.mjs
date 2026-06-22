import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatModelsCommandResult,
  parseModelsArgs,
  runModelsCommand,
} from "../extensions/aipi/runtime/models-command.js";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  inspectAdversarialFamilyIsolation,
  resolveModelClass,
  resolveStepModel,
} from "../extensions/aipi/runtime/model-router.js";

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
    target: path.resolve(path.join("C:", "repo"), "project"),
    json: true,
    interactive: true,
    hostModel: "openai-codex/gpt-5.5",
    adversarialModel: "anthropic/claude-opus-4-8",
    verifierModel: null,
    models: [],
    buckets: { adversarial: "anthropic/claude-opus-4-8" },
    classBindings: {},
    budgetNotes: {},
  },
);

// The 4 bucket flags each parse to options.buckets[bucket].
assert.deepEqual(
  parseModelsArgs([
    "setup",
    "--planner",
    "openai-codex/gpt-5.5:high",
    "--adversarial",
    "anthropic/claude-opus-4-8:high",
    "--doer",
    "openai-codex/gpt-5.5:medium",
    "--mover",
    "anthropic/claude-haiku-4-5:low",
  ], { cwd: path.join("C:", "repo") }).buckets,
  {
    planner: "openai-codex/gpt-5.5:high",
    adversarial: "anthropic/claude-opus-4-8:high",
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

  await assert.rejects(
    () => runModelsCommand({
      projectRoot: root,
      args: ["setup", "--host", "openai-codex/gpt-5.5", "--adversarial", "openai-codex/gpt-5.1"],
    }),
    /adversarial provider\/family to differ/,
  );

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
    // Cross-provider buckets: planner=openai-codex/gpt-5.5:high, adversarial=anthropic/
    // claude-opus-4-8:high, doer=openai-codex/gpt-5.5:medium, mover=anthropic/claude-haiku-4-5:low.
    const bucketAnswers = {
      planner: { model: "openai-codex/gpt-5.5", level: "high" },
      adversarial: { model: "anthropic/claude-opus-4-8", level: "high" },
      doer: { model: "openai-codex/gpt-5.5", level: "medium" },
      mover: { model: "anthropic/claude-haiku-4-5", level: "low" },
    };
    const answerFor = (question) => {
      for (const [bucket, answer] of Object.entries(bucketAnswers)) {
        const head = new RegExp(`^${bucket}`, "i");
        if (head.test(question)) {
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
    // The wizard prompts all 4 BUCKETS (model + thinking level each), not the 8 classes.
    assert.equal(prompts.some((prompt) => /^Planner.*model/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Planner.*thinking level/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Adversarial.*model/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Doer.*model/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Mover.*model/i.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Model for code-strong/.test(prompt)), false);

    // class_thinking is persisted in model-capabilities.json per class.
    const interactiveConfig = JSON.parse(await fs.readFile(
      path.join(interactiveRoot, ".aipi", "model-capabilities.json"),
      "utf8",
    ));
    // Bucket MODEL fans out to its classes.
    assert.equal(interactiveConfig.classes["orchestrator-heavy"], "openai-codex/gpt-5.5"); // planner
    assert.equal(interactiveConfig.classes["planner-heavy"], "openai-codex/gpt-5.5");
    assert.equal(interactiveConfig.classes["research-heavy"], "openai-codex/gpt-5.5");
    assert.equal(interactiveConfig.classes["adversarial-heavy"], "anthropic/claude-opus-4-8");
    assert.equal(interactiveConfig.classes["verifier-fast"], "anthropic/claude-opus-4-8");
    assert.equal(interactiveConfig.classes["code-strong"], "openai-codex/gpt-5.5"); // doer
    assert.equal(interactiveConfig.classes["test-strong"], "openai-codex/gpt-5.5");
    assert.equal(interactiveConfig.classes["context-fast"], "anthropic/claude-haiku-4-5"); // mover
    // Bucket LEVEL fans out to config.class_thinking[<class>].
    assert.equal(interactiveConfig.class_thinking["orchestrator-heavy"], "high");
    assert.equal(interactiveConfig.class_thinking["adversarial-heavy"], "high");
    assert.equal(interactiveConfig.class_thinking["verifier-fast"], "high");
    assert.equal(interactiveConfig.class_thinking["code-strong"], "medium");
    assert.equal(interactiveConfig.class_thinking["context-fast"], "low");

    // The whole point: assert via the REAL resolver that every class resolves to its
    // bucket MODEL and that resolveModelClass(class).thinking_level === the bucket LEVEL.
    // This proves the persisted level is READ by the router, not just written to JSON.
    const expectedByClass = {
      "orchestrator-heavy": { provider: "openai-codex", id: "gpt-5.5", level: "high" },
      "planner-heavy": { provider: "openai-codex", id: "gpt-5.5", level: "high" },
      "research-heavy": { provider: "openai-codex", id: "gpt-5.5", level: "high" },
      "adversarial-heavy": { provider: "anthropic", id: "claude-opus-4-8", level: "high" },
      "verifier-fast": { provider: "anthropic", id: "claude-opus-4-8", level: "high" },
      "code-strong": { provider: "openai-codex", id: "gpt-5.5", level: "medium" },
      "test-strong": { provider: "openai-codex", id: "gpt-5.5", level: "medium" },
      "context-fast": { provider: "anthropic", id: "claude-haiku-4-5", level: "low" },
    };
    for (const [modelClass, expected] of Object.entries(expectedByClass)) {
      const route = await resolveModelClass({ root: interactiveRoot, modelClass });
      // adversarial-heavy/verifier-fast may cross-family-select; assert the bucket level
      // is read for every class, and the model for non-cross-family classes.
      assert.equal(
        route.thinking_level,
        expected.level,
        `${modelClass} thinking_level must be the persisted bucket level (read by router)`,
      );
      if (!["adversarial-heavy", "verifier-fast"].includes(modelClass)) {
        assert.deepEqual(
          route.model,
          { provider: expected.provider, id: expected.id },
          `${modelClass} must resolve to its bucket model`,
        );
      }
    }

    // Cross-provider buckets resolve with no error (planner openai-codex, adversarial anthropic).
    const plannerRoute = await resolveModelClass({ root: interactiveRoot, modelClass: "planner-heavy" });
    assert.deepEqual(plannerRoute.model, { provider: "openai-codex", id: "gpt-5.5" });
    const advRoute = await resolveModelClass({ root: interactiveRoot, modelClass: "adversarial-heavy" });
    assert.equal(advRoute.model.provider, "anthropic");
    assert.equal((await inspectAdversarialFamilyIsolation({ root: interactiveRoot })).state, "pass");
  } finally {
    await fs.rm(interactiveRoot, { recursive: true, force: true });
  }

  // ===================================================================
  // adversarial-shares-family WARNING (soft, not a hard error). The host!=adversarial hard
  // error covers doer==adversarial, so the warning meaningfully fires when the PLANNER
  // bucket shares the adversarial family while the doer differs (so the hard error passes).
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

    // The host!=adversarial HARD error still fires when doer and adversarial share a family.
    await assert.rejects(
      () => runModelsCommand({
        projectRoot: sameFamilyRoot,
        args: ["setup", "--doer", "anthropic/claude-sonnet-4-5", "--adversarial", "anthropic/claude-haiku-4-5"],
      }),
      /adversarial provider\/family to differ/,
    );
  } finally {
    await fs.rm(sameFamilyRoot, { recursive: true, force: true });
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("AIPI_MODELS_COMMAND_TEST_OK");
