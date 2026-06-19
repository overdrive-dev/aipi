import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateModelCapabilityFloor,
  inspectModelCapabilityFloors,
  parseAgentClasses,
  parseModelClasses,
  resolveCrossModelAdversarialRoute,
  resolveModelClass,
  resolveStepModel,
} from "../extensions/aipi/runtime/model-router.js";

const agentCatalog = `
agents:
  - id: implementer
    class: code-strong
  - id: code-reviewer
    class: adversarial-heavy
`;

const modelClasses = `
classes:
  code-strong:
    effort: medium
    preferred_families: [openai, anthropic, zai]
  adversarial-heavy:
    effort: high
    preferred_families: [anthropic, openai, zai]
`;

const agents = parseAgentClasses(agentCatalog);
assert.equal(agents.get("implementer").class, "code-strong");
const classes = parseModelClasses(modelClasses);
assert.equal(classes.get("adversarial-heavy").effort, "high");
assert.deepEqual(classes.get("adversarial-heavy").capability_floor, undefined);
assert.deepEqual(classes.get("code-strong").preferred_families, ["openai", "anthropic", "zai"]);

const floors = parseModelClasses(`
classes:
  planner-heavy:
    effort: high
    capability_floor:
      reasoning: high
      context: high
      tool_use: required
      structured_outputs: required
`);
assert.deepEqual(floors.get("planner-heavy").capability_floor, {
  reasoning: "high",
  context: "high",
  tool_use: "required",
  structured_outputs: "required",
});
assert.equal(
  evaluateModelCapabilityFloor({
    modelClass: "planner-heavy",
    model: { provider: "anthropic", id: "claude-planner" },
    classMeta: floors.get("planner-heavy"),
    registry: {
      valid: true,
      models: {
        "anthropic:claude-planner": {
          capabilities: {
            reasoning: "high",
            context: "very_high",
            tool_use: "write_capable",
            structured_outputs: true,
          },
          evidence: ["unit-test"],
        },
      },
    },
  }).state,
  "pass",
);
assert.equal(
  evaluateModelCapabilityFloor({
    modelClass: "planner-heavy",
    model: { provider: "anthropic", id: "claude-small" },
    classMeta: floors.get("planner-heavy"),
    registry: {
      valid: true,
      models: {
        "anthropic:claude-small": {
          capabilities: { reasoning: "medium", context: "medium", tool_use: "read_only" },
        },
      },
    },
  }).state,
  "fail",
);
assert.equal(
  evaluateModelCapabilityFloor({
    modelClass: "research-heavy",
    model: { provider: "anthropic", id: "claude-research" },
    classMeta: {
      capability_floor: {
        structured_outputs: "required",
        web: "required_when_current_facts_matter",
        citations: "required",
        evidence_audit: "required",
      },
    },
    registry: {
      valid: true,
      models: {
        "anthropic:claude-research": {
          capabilities: {
            structured_outputs: "yes",
            web: "available",
            citations: "high",
            evidence_audit: true,
          },
          evidence: ["unit-test"],
        },
      },
    },
  }).state,
  "pass",
);
assert.deepEqual(
  evaluateModelCapabilityFloor({
    modelClass: "research-heavy",
    model: { provider: "anthropic", id: "claude-no-citations" },
    classMeta: { capability_floor: { citations: "required" } },
    registry: {
      valid: true,
      models: {
        "anthropic:claude-no-citations": {
          capabilities: { citations: "unsupported" },
        },
      },
    },
  }).unmet,
  [{ capability: "citations", expected: "required", actual: "unsupported" }],
);

const templateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-template-model-router-"));
try {
  await fs.mkdir(path.join(templateRoot, ".aipi"), { recursive: true });
  await fs.copyFile("templates/.aipi/model-classes.yaml", path.join(templateRoot, ".aipi", "model-classes.yaml"));
  await fs.copyFile(
    "templates/.aipi/model-capabilities.json",
    path.join(templateRoot, ".aipi", "model-capabilities.json"),
  );
  const contextFastRoute = await resolveModelClass({ root: templateRoot, modelClass: "context-fast", ctx: {} });
  assert.equal(contextFastRoute.source, "model-capabilities");
  assert.deepEqual(contextFastRoute.model, { provider: "anthropic", id: "claude-opus-4-8" });
  assert.equal(contextFastRoute.capability_report.state, "pass");
  assert.equal(contextFastRoute.capability_report.model, "anthropic/claude-opus-4-8");
  const templateFloorReport = await inspectModelCapabilityFloors({ root: templateRoot });
  assert.equal(templateFloorReport.state, "pass");
  assert.equal(templateFloorReport.failing, 0);
} finally {
  await fs.rm(templateRoot, { recursive: true, force: true });
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-model-router-"));
try {
  await fs.mkdir(path.join(tempRoot, ".aipi", "agents"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, ".aipi", "agents", "catalog.yaml"), agentCatalog);
  await fs.writeFile(path.join(tempRoot, ".aipi", "model-classes.yaml"), modelClasses);
  await fs.writeFile(
    path.join(tempRoot, ".aipi", "model-capabilities.json"),
    `${JSON.stringify({
      schema: "aipi.model-capabilities.v1",
      classes: {
        "code-strong": "anthropic/claude-test",
        "adversarial-heavy": "anthropic/claude-review",
      },
      models: {
        "anthropic:claude-test": {
          capabilities: {},
          evidence: ["unit-test"],
        },
        "anthropic:claude-review": {
          capabilities: {},
          evidence: ["unit-test"],
        },
      },
    }, null, 2)}\n`,
  );

  const configuredRoute = await resolveStepModel({
    root: tempRoot,
    step: { agents: ["implementer"] },
    ctx: { model: { provider: "openai", id: "gpt-test" } },
  });
  assert.equal(configuredRoute.model_class, "code-strong");
  assert.equal(configuredRoute.source, "model-capabilities");
  assert.deepEqual(configuredRoute.model, { provider: "anthropic", id: "claude-test" });
  assert.equal(configuredRoute.thinking_level, "medium");

  const envResolved = await resolveStepModel({
    root: tempRoot,
    step: { agents: ["implementer"] },
    env: { AIPI_MODEL_CLASS_CODE_STRONG: "anthropic/claude-test:high" },
    ctx: {
      model: { provider: "other", id: "ignored" },
      modelRegistry: {
        find(provider, model) {
          return { provider, id: model };
        },
      },
    },
  });
  assert.equal(envResolved.source, "env");
  assert.deepEqual(envResolved.model, { provider: "anthropic", id: "claude-test" });
  assert.equal(envResolved.thinking_level, "high");

  const envResolvedWithoutRegistry = await resolveStepModel({
    root: tempRoot,
    step: { agents: ["implementer"] },
    env: { AIPI_MODEL_CLASS_CODE_STRONG: "openai/gpt-env-only:high" },
    ctx: {
      model: { provider: "other", id: "ignored" },
    },
  });
  assert.equal(envResolvedWithoutRegistry.source, "env");
  assert.deepEqual(envResolvedWithoutRegistry.model, { provider: "openai", id: "gpt-env-only" });
  assert.equal(envResolvedWithoutRegistry.thinking_level, "high");

  const crossModelReviewer = await resolveCrossModelAdversarialRoute({
    root: tempRoot,
    role: "code-reviewer",
    implementerModel: { provider: "openai", id: "gpt-5.5" },
    ctx: {
      modelCapabilities: {
        valid: true,
        classes: {
          "code-strong": "openai/gpt-5.5",
          "adversarial-heavy": "anthropic/claude-review",
        },
        models: {
          "openai:gpt-5.5": { capabilities: {}, evidence: ["unit-test"] },
          "anthropic:claude-review": { capabilities: {}, evidence: ["unit-test"] },
        },
      },
    },
  });
  assert.equal(crossModelReviewer.blocked, false);
  assert.equal(crossModelReviewer.provider, "anthropic");
  assert.equal(crossModelReviewer.distinct_provider, true);

  const crossModelBlocked = await resolveCrossModelAdversarialRoute({
    root: tempRoot,
    role: "contrarian",
    implementerModel: { provider: "openai", id: "gpt-5.5" },
    ctx: {
      modelCapabilities: {
        valid: true,
        classes: {
          "adversarial-heavy": "bedrock/claude-review",
        },
        models: {
          "bedrock:claude-review": { capabilities: {}, evidence: ["unit-test"] },
          "zai:glm-review": { capabilities: {}, evidence: ["unit-test"] },
        },
      },
    },
  });
  assert.equal(crossModelBlocked.blocked, true);
  assert.equal(crossModelBlocked.rejected.some((item) => item.reason === "provider_out_of_scope"), true);

  const envFamilyMismatch = await resolveStepModel({
    root: tempRoot,
    step: { agents: ["implementer"] },
    env: { AIPI_MODEL_CLASS_CODE_STRONG: "local/local-code:high" },
    ctx: {
      modelRegistry: {
        find(provider, model) {
          return { provider, id: model };
        },
      },
    },
  });
  assert.equal(envFamilyMismatch.source, "env");
  assert.equal(envFamilyMismatch.family_warning.code, "AIPI_MODEL_PREFERRED_FAMILY_MISMATCH");
  assert.equal(envFamilyMismatch.family_warning.provider, "local");

  const floorReport = await inspectModelCapabilityFloors({ root: tempRoot });
  assert.equal(floorReport.state, "pass");

  await fs.writeFile(
    path.join(tempRoot, ".aipi", "model-capabilities.json"),
    `${JSON.stringify({
      schema: "aipi.model-capabilities.v1",
      classes: {
        "code-strong": "local/local-code",
      },
      models: {
        "local:local-code": {
          capabilities: {},
          evidence: ["unit-test"],
        },
      },
    }, null, 2)}\n`,
  );
  const configuredFamilyMismatch = await resolveStepModel({
    root: tempRoot,
    step: { agents: ["implementer"] },
  });
  assert.equal(configuredFamilyMismatch.source, "model-capabilities");
  assert.equal(configuredFamilyMismatch.family_warning.code, "AIPI_MODEL_PREFERRED_FAMILY_MISMATCH");
  assert.equal(configuredFamilyMismatch.family_warning.provider, "local");

  await fs.writeFile(
    path.join(tempRoot, ".aipi", "model-capabilities.json"),
    `${JSON.stringify({
      schema: "aipi.model-capabilities.v1",
      classes: {},
      models: {},
    }, null, 2)}\n`,
  );

  const currentSession = await resolveStepModel({
    root: tempRoot,
    step: { agents: ["implementer"] },
    ctx: { model: { provider: "openai", id: "gpt-test" } },
  });
  assert.equal(currentSession.model_class, "code-strong");
  assert.equal(currentSession.source, "current-session");
  assert.deepEqual(currentSession.model, { provider: "openai", id: "gpt-test" });
  assert.equal(currentSession.thinking_level, "medium");

  const currentFamilyMismatch = await resolveStepModel({
    root: tempRoot,
    step: { agents: ["code-reviewer"] },
    ctx: { model: { provider: "local", id: "not-preferred" } },
  });
  assert.equal(currentFamilyMismatch.model_class, "adversarial-heavy");
  assert.equal(currentFamilyMismatch.source, "current-session");
  assert.deepEqual(currentFamilyMismatch.model, { provider: "local", id: "not-preferred" });
  assert.equal(currentFamilyMismatch.family_warning.code, "AIPI_MODEL_PREFERRED_FAMILY_MISMATCH");
  assert.equal(currentFamilyMismatch.thinking_level, "high");

  console.log("AIPI_MODEL_ROUTER_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
