import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  buildStepContext,
  ContextMaterializationError,
} from "../extensions/aipi/runtime/context-builder.js";
import { rebuildCodeGraph } from "../extensions/aipi/runtime/aipi-tools.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-context-builder-"));
const sourceRoot = path.resolve("templates/.aipi");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });
  await forceFastSemanticFallback(tempRoot);
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "billing.js"),
    [
      "// Apply billing renewal change Use billing renewal business rules. implementation implementer",
      "export function renewBillingAccount(account) {",
      "  return account.renewalPrice;",
      "}",
      "",
    ].join("\n"),
  );
  const runId = "run-context";
  const runRelDir = `.aipi/runtime/runs/${runId}`;
  await fs.mkdir(path.join(tempRoot, runRelDir, "steps", "scope"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, runRelDir, "BDD-CONTRACT.md"), "# BDD\n\nGiven renewal pricing is accepted.\n");
  await fs.writeFile(
    path.join(tempRoot, runRelDir, "steps", "scope", "SCOPE.md"),
    "# Scope\n\nRenewal pricing touches billing only.\n",
  );
  await fs.writeFile(
    path.join(tempRoot, runRelDir, "steps", "scope", "RESULT.json"),
    `${JSON.stringify({
      result: {
        verdict: "PASS",
        policy_decision: null,
      },
      validation: {
        gatePassed: true,
      },
      missing_artifacts: [],
    })}\n`,
  );
  await fs.appendFile(
    path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"),
    "\n## Billing renewal\n\nRenewal pricing must keep the accepted customer price.\n",
  );
  await rebuildCodeGraph({
    projectRoot: tempRoot,
    now: () => new Date("2026-06-20T16:00:00.000Z"),
    embeddingFetch: async () => {
      throw new Error("ollama disabled for deterministic context-builder test");
    },
  });

  const state = {
    run_id: runId,
    workflow: "quick",
    contract_path: `${runRelDir}/BDD-CONTRACT.md`,
    steps: [
      {
        id: "scope",
        status: "passed",
        verdict: "PASS",
        artifacts: [`${runRelDir}/steps/scope/SCOPE.md`],
      },
      {
        id: "change",
        status: "pending",
      },
    ],
  };
  const step = {
    id: "change",
    stage: "implementation",
    name: "Apply billing renewal change",
    prompt: "Use billing renewal business rules.",
    agents: ["implementer"],
    context_from: ["scope"],
  };

  const context = await buildStepContext({
    root: tempRoot,
    state,
    workflow: { name: "aipi-quick" },
    step,
    contract: {
      contextMaterialization: {
        maxArtifactsPerStep: 2,
        maxExcerptLinesPerArtifact: 10,
      },
    },
  });

  assert.equal(context.schema, "aipi.context-packet.v1");
  assert.equal(context.prior_steps[0].step_id, "scope");
  assert.match(context.prior_steps[0].artifacts[0].excerpt, /Renewal pricing touches billing/);
  assert.equal(context.memory.refs.some((ref) => ref.path.endsWith("business-rules.md")), true);
  assert.equal(context.blast_radius.source, "aipi_impact");
  assert.equal(Array.isArray(context.blast_radius.refs), true);
  assert.equal(context.blast_radius.refs.length > 0, true);
  assert.equal(context.blast_radius.refs.some((ref) => ref.path === "src/billing.js"), true);
  assert.equal(context.provenance.some((item) => item.kind === "blast_radius" && item.ref === "src/billing.js"), true);
  assert.equal(context.provenance.some((item) => item.kind === "artifact"), true);
  assert.equal(
    await pathExists(path.join(tempRoot, runRelDir, "steps", "change", "CONTEXT.json")),
    true,
  );

  const brokenState = {
    ...state,
    steps: [
      {
        id: "scope",
        status: "passed",
        verdict: "PASS",
        artifacts: [`${runRelDir}/steps/scope/MISSING.md`],
      },
      {
        id: "change",
        status: "pending",
      },
    ],
  };

  await assert.rejects(
    () =>
      buildStepContext({
        root: tempRoot,
        state: brokenState,
        workflow: { name: "aipi-quick" },
        step,
        contract: {},
      }),
    ContextMaterializationError,
  );

  console.log("AIPI_CONTEXT_BUILDER_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
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
