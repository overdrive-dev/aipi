import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { runWorkflowCommand } from "../extensions/aipi/runtime/run-state.js";
import { rebuildCodeGraph } from "../extensions/aipi/runtime/aipi-tools.js";
import { writeControllerArtifact } from "../extensions/aipi/runtime/workflow-executor.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-workflow-fixtures-"));
const sourceRoot = path.resolve("templates/.aipi");

const fixtures = [
  {
    workflow: "planning",
    expectedStatus: "completed",
    artifact: "steps/contract/RESULT.md",
  },
  {
    workflow: "feature",
    expectedStatus: "completed",
    artifact: "steps/final_verification/VERIFICATION.md",
  },
  {
    workflow: "bugfix",
    expectedStatus: "completed",
    artifact: "steps/verify/VERIFICATION.md",
  },
  {
    workflow: "research",
    expectedStatus: "completed",
    artifact: "steps/synthesis/RESEARCH-SYNTHESIS.md",
  },
  {
    workflow: "ops",
    expectedStatus: "approval_required",
    artifact: "steps/human_review/HUMAN-REVIEW.md",
  },
];

try {
  for (const fixture of fixtures) {
    const projectRoot = path.join(tempRoot, fixture.workflow);
    await initProject({ sourceRoot, targetRoot: projectRoot });
    await seedFixtureProject(projectRoot, fixture.workflow);
    await forceFastSemanticFallback(projectRoot);
    await rebuildCodeGraph({
      projectRoot,
      embeddingFetch: async () => {
        throw new Error("ollama disabled for deterministic workflow-fixtures test");
      },
    });

    const result = await runWorkflowCommand({
      args: `run ${fixture.workflow}`,
      projectRoot,
      adapter:
        fixture.workflow === "ops"
          ? createOpsApprovalRequiredWorkflowAdapter()
          : createTestPassWorkflowAdapter(),
    });

    assert.equal(result.action, "run");
    assert.equal(result.execution.status, fixture.expectedStatus, `${fixture.workflow} status`);
    assert.equal(result.execution.state.workflow, fixture.workflow);
    assert.equal(result.execution.state.steps[0].status, "passed");
    assert.equal(
      await pathExists(path.join(projectRoot, ".aipi", "runtime", "runs", result.run.runId, fixture.artifact)),
      true,
      `${fixture.workflow} expected artifact ${fixture.artifact}`,
    );

    const manifest = await fs.readFile(
      path.join(projectRoot, ".aipi", "runtime", "runs", result.run.runId, "RUN-MANIFEST.md"),
      "utf8",
    );
    assert.match(manifest, new RegExp(`workflow: ${fixture.workflow}`));
    assert.match(manifest, new RegExp(`status: ${fixture.expectedStatus}`));

    if (fixture.workflow === "ops") {
      assert.equal(
        result.execution.state.policy_decisions.some(
          (decision) => decision.step_id === "human_review" && decision.decision === "HUMAN_REVIEW_REQUIRED",
        ),
        true,
      );
    }
  }

  console.log("AIPI_WORKFLOW_FIXTURES_TEST_OK workflows=planning,feature,bugfix,research,ops");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function seedFixtureProject(projectRoot, workflow) {
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "src", "billing.js"),
    [
      "export function renewSubscription(account) {",
      "  return account.acceptedPrice;",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(projectRoot, "tests", "billing.test.js"),
    "import { renewSubscription } from '../src/billing.js';\nrenewSubscription({ acceptedPrice: 10 });\n",
  );
  await fs.appendFile(
    path.join(projectRoot, ".aipi", "memory", "project", "business-rules.md"),
    [
      "",
      `### BR-FIXTURE-${workflow.toUpperCase()} - Renewal price`,
      "- **domain:** billing",
      "- **statement:** Renewals preserve the accepted subscription price.",
      "- **status:** accepted",
      "",
    ].join("\n"),
  );
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function forceFastSemanticFallback(projectRoot) {
  const configPath = path.join(projectRoot, ".aipi", "semantic-memory.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, ollama_host: "http://127.0.0.1:9" }, null, 2)}\n`,
  );
}

function createOpsApprovalRequiredWorkflowAdapter() {
  const pass = createTestPassWorkflowAdapter();
  return {
    async executeStep(args) {
      const result = await pass.executeStep(args);
      if (args.step.id === "policy_gate") {
        return {
          ...result,
          policy_decision: "ALLOW",
          evidence: [
            ...result.evidence,
            {
              rung: "verified",
              source: "test-pass-adapter",
              ref: "policy_gate",
              result: "test fixture explicitly allowed ops workflow to reach human review",
            },
          ],
        };
      }
      if (args.step.id === "human_review") {
        return {
          ...result,
          policy_decision: "HUMAN_REVIEW_REQUIRED",
          evidence: [
            ...result.evidence,
            {
              rung: "verified",
              source: "test-pass-adapter",
              ref: "human_review",
              result: "test fixture requires explicit human approval before execution",
            },
          ],
        };
      }
      return result;
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
