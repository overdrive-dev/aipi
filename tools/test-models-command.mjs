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
    classBindings: {},
    budgetNotes: {},
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

  const interactiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-models-command-interactive-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: interactiveRoot });
    const prompts = [];
    const interactiveReport = await runModelsCommand({
      projectRoot: interactiveRoot,
      args: ["setup"],
      ui: {
        async input(question) {
          prompts.push(question);
          if (/^Host model/.test(question)) return "anthropic/claude-opus-4-8";
          if (/^Adversarial model/.test(question)) return "openai-codex/gpt-5.5";
          if (/^Model for context-fast/.test(question)) return "anthropic/claude-haiku-4";
          return "";
        },
      },
      now: () => new Date("2026-06-22T01:00:00.000Z"),
    });
    assert.equal(interactiveReport.state, "ready");
    assert.equal(prompts.some((prompt) => /^Model for context-fast/.test(prompt)), true);
    assert.equal(prompts.some((prompt) => /^Model for code-strong/.test(prompt)), true);
    const interactiveConfig = JSON.parse(await fs.readFile(
      path.join(interactiveRoot, ".aipi", "model-capabilities.json"),
      "utf8",
    ));
    assert.equal(interactiveConfig.classes["orchestrator-heavy"], "anthropic/claude-opus-4-8");
    assert.equal(interactiveConfig.classes["code-strong"], "anthropic/claude-opus-4-8");
    assert.equal(interactiveConfig.classes["adversarial-heavy"], "openai-codex/gpt-5.5");
    assert.equal(interactiveConfig.classes["verifier-fast"], "openai-codex/gpt-5.5");
    assert.equal(interactiveConfig.classes["context-fast"], "anthropic/claude-haiku-4");
    const contextFast = await resolveModelClass({ root: interactiveRoot, modelClass: "context-fast" });
    assert.deepEqual(contextFast.model, { provider: "anthropic", id: "claude-haiku-4" });
  } finally {
    await fs.rm(interactiveRoot, { recursive: true, force: true });
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("AIPI_MODELS_COMMAND_TEST_OK");
