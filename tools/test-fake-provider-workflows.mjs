import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  createSubagentWorkflowAdapter,
  executeWorkflowRun,
  writeControllerArtifact,
} from "../extensions/aipi/runtime/workflow-executor.js";
import { startWorkflowRun } from "../extensions/aipi/runtime/run-state.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-fake-provider-workflows-"));
const sourceRoot = path.resolve("templates/.aipi");
const fixedDate = new Date("2026-06-17T03:00:00.000Z");
let randomCounter = 0;
const fixedRandom = () => Buffer.from((0xdef000 + randomCounter++).toString(16).padStart(6, "0"), "hex");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  const branchRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const branchTrace = [];
  let localVerificationFailures = 0;
  const local = createTestPassWorkflowAdapter();
  const branchExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: branchRun.runId,
    now: () => fixedDate,
    adapter: {
      async executeStep(args) {
        branchTrace.push(args.step.id);
        if (args.step.id === "local_verification" && localVerificationFailures < 1) {
          localVerificationFailures += 1;
          return {
            schema: "aipi.step-result.v1",
            step_id: args.step.id,
            agent_ids: ["fake-provider-verifier"],
            verdict: "FAIL",
            evidence: [
              {
                rung: "ran",
                source: "fake-provider",
                ref: "local_verification",
                result: "forced one failing verification to prove FAIL branches back to implement",
              },
            ],
            artifacts: [],
          };
        }
        return local.executeStep(args);
      },
    },
  });
  assert.equal(branchExecution.status, "completed");
  assert.equal(branchExecution.state.step_visits.implement, 2);
  assert.equal(branchExecution.state.step_visits.local_verification, 2);
  assert.equal(
    branchExecution.events.some(
      (event) => event.type === "failed" && event.step_id === "local_verification" && event.target === "implement",
    ),
    true,
  );
  assert.deepEqual(
    branchTrace.filter((stepId) => ["implement", "local_verification"].includes(stepId)),
    ["implement", "local_verification", "implement", "local_verification"],
  );

  const fanoutRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const fakeFanout = createFakeProviderCoordinator(tempRoot);
  const fanoutExecution = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: fanoutRun.runId,
    now: () => fixedDate,
    adapter: createSubagentWorkflowAdapter(fakeFanout, {
      fallback: createTestPassWorkflowAdapter(),
      workerStepIds: [],
      fanoutStepIds: ["review_swarm"],
      pollIntervalMs: 1,
      collectTimeoutMs: 1_000,
      modelResolver: async ({ step }) => ({
        model_class: step.agents[0] === "complexity-reviewer" ? "context-fast" : "adversarial-heavy",
        model: { provider: "fake-provider", id: `fake-${step.agents[0]}` },
        thinking_level: "medium",
        source: "test:fake-provider-workflows",
      }),
    }),
  });
  assert.equal(fanoutExecution.status, "completed");
  assert.equal(fakeFanout.spawned.length, 5);
  assert.deepEqual(
    fakeFanout.spawned.map((item) => item.descriptor.agent_id),
    ["code-reviewer", "complexity-reviewer", "integration-checker", "security-auditor", "blast-radius"],
  );
  assert.equal(
    fakeFanout.spawned.every((item) => item.descriptor.model?.provider === "fake-provider"),
    true,
  );
  const ownedFiles = fakeFanout.spawned.flatMap((item) => item.descriptor.owned_files ?? []);
  assert.equal(new Set(ownedFiles).size, 5);
  assert.equal(ownedFiles.every((file) => file.includes(`/steps/review_swarm/`)), true);

  const resultPath = path.join(
    tempRoot,
    ".aipi",
    "runtime",
    "runs",
    fanoutRun.runId,
    "steps",
    "review_swarm",
    "RESULT.md",
  );
  const resultText = await fs.readFile(resultPath, "utf8");
  assert.match(resultText, /collected 5 worker results for review_swarm/);
  assert.equal(
    fakeFanout.writes.some((item) => item.path.endsWith("/steps/review_swarm/SECURITY.md")),
    true,
  );

  console.log("AIPI_FAKE_PROVIDER_WORKFLOWS_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
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
        const relPath = String(template)
          .replaceAll("{{ run_id }}", state.run_id)
          .replaceAll("{{ step_id }}", step.id)
          .replaceAll("\\", "/");
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

function createFakeProviderCoordinator(root) {
  let counter = 0;
  const jobs = new Map();
  const spawned = [];
  const writes = [];
  return {
    spawned,
    writes,
    spawn(descriptor) {
      const agentId = `${descriptor.agent_id}:fake-${counter++}`;
      const artifacts = descriptor.owned_files ?? descriptor.expected_artifacts ?? [];
      for (const artifact of artifacts) {
        writes.push({ agent_id: agentId, path: artifact });
        const target = path.join(root, artifact);
        fsSync.mkdirSync(path.dirname(target), { recursive: true });
        fsSync.writeFileSync(target, `# fake-provider ${descriptor.agent_id}\n\nartifact: ${artifact}\n`);
      }
      const result = {
        agent_id: agentId,
        state: "done",
        ready: true,
        artifacts,
        step_result: {
          schema: "aipi.step-result.v1",
          step_id: descriptor.step_id,
          agent_ids: [agentId],
          verdict: "PASS",
          evidence: [
            {
              rung: "ran",
              source: "fake-provider",
              ref: agentId,
              result: `fake provider wrote ${artifacts.length} artifacts`,
            },
          ],
          artifacts,
        },
      };
      spawned.push({ agent_id: agentId, descriptor });
      jobs.set(agentId, result);
      return { agent_id: agentId };
    },
    collect(agentId) {
      return jobs.get(agentId) ?? { agent_id: agentId, state: "failed", ready: false };
    },
  };
}
