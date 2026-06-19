import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { createAipiLifecycleHandlers } from "../extensions/aipi/runtime/lifecycle-hooks.js";
import { aipiImpact } from "../extensions/aipi/runtime/aipi-tools.js";
import { startWorkflowRun } from "../extensions/aipi/runtime/run-state.js";
import { executeWorkflowRun } from "../extensions/aipi/runtime/workflow-executor.js";
import { validateStepResult } from "../extensions/aipi/runtime/step-result.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-pressure-evals-"));
const sourceRoot = path.resolve("templates/.aipi");
const fixedDate = new Date("2026-06-16T10:00:00.000Z");
let randomCounter = 0;
const fixedRandom = () => Buffer.from((0xbad000 + randomCounter++).toString(16).padStart(6, "0"), "hex");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });
  const handlers = createAipiLifecycleHandlers({ projectRootResolver: () => tempRoot });

  const sourceEditToolCall = await handlers.tool_call({
    type: "tool_call",
    toolName: "write",
    input: {
      path: "src/app.js",
      content: "export const updated = true;",
    },
  }, { cwd: tempRoot });
  assert.equal(sourceEditToolCall, undefined);

  const prodBash = await handlers.user_bash({
    type: "user_bash",
    command: "kubectl apply -f prod.yaml --context production",
    cwd: tempRoot,
  }, { cwd: tempRoot });
  assert.equal(prodBash, undefined);

  const missingArtifactRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  const missingArtifact = await executeWorkflowRun({
    projectRoot: tempRoot,
    runId: missingArtifactRun.runId,
    now: () => fixedDate,
    adapter: {
      async executeStep({ step }) {
        return {
          schema: "aipi.step-result.v1",
          step_id: step.id,
          agent_ids: ["pressure-missing-artifact"],
          verdict: "PASS",
          evidence: [
            {
              rung: "ran",
              source: "pressure-eval",
              ref: "missing-artifact",
              result: "claims pass without required artifacts",
            },
          ],
          artifacts: [],
        };
      },
    },
  });
  assert.equal(missingArtifact.status, "escalated_to_planning");
  assert.match(missingArtifact.state.steps[0].error, /missing required artifacts/);

  const badStepJson = validateStepResult({
    schema: "aipi.step-result.v1",
    step_id: "bad_json",
    agent_ids: [],
    verdict: "PASS",
    evidence: [],
    artifacts: [],
  });
  assert.equal(badStepJson.ok, false);
  assert.equal(badStepJson.gatePassed, false);
  assert.equal(badStepJson.errors.some((error) => /agent_ids/.test(error)), true);

  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "pressure.js"),
    "export function pressureTarget() {\n  return 'pressure';\n}\n",
  );
  await fs.mkdir(path.join(tempRoot, ".aipi", "state"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, ".aipi", "state", "aipi-graph.json"),
    `${JSON.stringify({
      schema: "aipi.code-graph.v1",
      built_at: "2026-01-01T00:00:00.000Z",
      source: "legacy-lexical",
      stale: true,
      files: [],
      symbols: [],
    }, null, 2)}\n`,
  );
  const staleGraph = await aipiImpact({
    projectRoot: tempRoot,
    symbol: "pressureTarget",
  });
  assert.match(staleGraph.graph.source, /^sqlite\+(.+\+)?lexical$/);
  assert.equal(staleGraph.graph.sqlite.path, ".aipi/state/aipi-graph.sqlite");
  assert.equal(staleGraph.refs.some((ref) => ref.path === "src/pressure.js"), true);

  console.log("AIPI_PRESSURE_EVALS_TEST_OK runtime_gates=5");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
