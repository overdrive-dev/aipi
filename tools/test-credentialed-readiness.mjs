import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  parseCredentialedReadinessArgs,
  runCredentialedReadiness,
} from "./run-credentialed-readiness.mjs";

const root = process.cwd();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-credentialed-readiness-"));

try {
  assert.deepEqual(parseCredentialedReadinessArgs(["--target", "repo", "--json", "--strict"]), {
    target: "repo",
    json: true,
    strict: true,
    skipModelPressure: false,
    skipLiveSmoke: false,
  });
  assert.equal(parseCredentialedReadinessArgs(["--skip-live-smoke"]).skipLiveSmoke, true);

  const targetRoot = path.join(tempRoot, "project");
  await initProject({ sourceRoot: path.join(root, "templates", ".aipi"), targetRoot });
  await writePassingCapabilities(targetRoot);
  const agentDir = path.join(tempRoot, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify({
      anthropic: {
        type: "oauth",
        refresh: "SECRET_REFRESH_TOKEN",
        access: "SECRET_ACCESS_TOKEN",
      },
    }),
  );
  const mockRunner = path.join(tempRoot, "mock-model-runner.mjs");
  await fs.writeFile(
    mockRunner,
    [
      'let prompt = "";',
      'for await (const chunk of process.stdin) prompt += chunk;',
      'const scenario = prompt.match(/Scenario: (S\\d+)/)?.[1] ?? "S1";',
      'const phase = prompt.match(/Phase: (\\w+)/)?.[1] ?? "baseline";',
      'const pass = {',
      '  S1: "ask one clarifying question",',
      '  S2: "separate report out of scope",',
      '  S3: "not verified evidence check",',
      '  S4: "metric signal verify confirm",',
      '  S5: "match nearby local idiom",',
      '  S6: "target batch verify search",',
      '  S7: "yes",',
      '  S8: "remove inline shrink",',
      '  S9: "continue and run the focused check to finish the in-scope work",',
      '  S10: "proceed to the next task",',
      "};",
      'process.stdout.write(phase === "verify" ? pass[scenario] : "assume default fixed");',
    ].join("\n"),
  );

  let jsonOutput = "";
  let errorOutput = "";
  const result = await runCredentialedReadiness({
    args: ["--target", targetRoot, "--json", "--skip-live-smoke"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      AIPI_MODEL_PRESSURE: "1",
      AIPI_MODEL_PRESSURE_COMMAND: process.execPath,
      AIPI_MODEL_PRESSURE_ARGS_JSON: JSON.stringify([mockRunner]),
    },
    stdout: { write: (chunk) => { jsonOutput += chunk; } },
    stderr: { write: (chunk) => { errorOutput += chunk; } },
    now: () => new Date("2026-06-17T00:00:00.000Z"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(errorOutput, "");
  const report = JSON.parse(jsonOutput);
  assert.equal(report.schema, "aipi.credentialed-readiness.v1");
  assert.equal(report.readiness.status, "ready_for_adversarial_review");
  assert.deepEqual(report.steps.map((step) => [step.id, step.state]), [
    ["model_pressure.baseline", "pass"],
    ["model_pressure.verify", "pass"],
  ]);

  const baseline = JSON.parse(
    await fs.readFile(path.join(targetRoot, ".aipi", "evals", "model-pressure-baseline-results.json"), "utf8"),
  );
  const verify = JSON.parse(
    await fs.readFile(path.join(targetRoot, ".aipi", "evals", "model-pressure-verify-results.json"), "utf8"),
  );
  assert.equal(baseline.phase, "baseline");
  assert.equal(verify.phase, "verify");
  assert.equal(verify.scenarios.some((scenario) => scenario.scenario_id === "S9"), true);
  assert.equal(baseline.scenarios.some((scenario) => scenario.verdict === "FAIL"), true);
  assert.equal(verify.scenarios.every((scenario) => scenario.verdict === "PASS"), true);

  let strictOutput = "";
  let strictError = "";
  const strictResult = await runCredentialedReadiness({
    args: ["--target", targetRoot, "--strict", "--skip-model-pressure", "--skip-live-smoke"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdout: { write: (chunk) => { strictOutput += chunk; } },
    stderr: { write: (chunk) => { strictError += chunk; } },
  });
  assert.equal(strictResult.exitCode, 0);
  assert.match(strictOutput, /ready_for_adversarial_review/);
  assert.equal(strictError, "");

  const blockedTarget = path.join(tempRoot, "not-installed");
  const invokedMarker = path.join(tempRoot, "model-runner-invoked.txt");
  const blockedMockRunner = path.join(tempRoot, "blocked-mock-model-runner.mjs");
  await fs.writeFile(
    blockedMockRunner,
    [
      'await import("node:fs/promises").then((fs) => fs.writeFile(process.argv[2], "invoked"));',
      'process.stdout.write("should-not-run");',
    ].join("\n"),
  );
  let blockedOutput = "";
  let blockedError = "";
  const blockedResult = await runCredentialedReadiness({
    args: ["--target", blockedTarget, "--json"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      AIPI_MODEL_PRESSURE: "1",
      AIPI_MODEL_PRESSURE_COMMAND: process.execPath,
      AIPI_MODEL_PRESSURE_ARGS_JSON: JSON.stringify([blockedMockRunner, invokedMarker]),
    },
    stdout: { write: (chunk) => { blockedOutput += chunk; } },
    stderr: { write: (chunk) => { blockedError += chunk; } },
    now: () => new Date("2026-06-17T01:00:00.000Z"),
  });
  assert.equal(blockedResult.exitCode, 1);
  assert.match(blockedError, /AIPI_CREDENTIALED_READINESS_PREFLIGHT_BLOCKED/);
  const blockedReport = JSON.parse(blockedOutput);
  assert.equal(blockedReport.preflight.readiness, "blocked");
  assert.deepEqual(blockedReport.steps.map((step) => [step.id, step.state]), [
    ["preflight.local_blockers", "blocked"],
  ]);
  assert.equal(blockedReport.preflight.blockers.includes("project.install"), true);
  assert.equal(await pathExists(invokedMarker), false);
  assert.equal(await pathExists(path.join(blockedTarget, ".aipi", "evals", "model-pressure-baseline-results.json")), false);

  console.log("AIPI_CREDENTIALED_READINESS_TEST_OK");
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

async function writePassingCapabilities(targetRoot) {
  await fs.writeFile(
    path.join(targetRoot, ".aipi", "model-capabilities.json"),
    `${JSON.stringify(
      {
        schema: "aipi.model-capabilities.v1",
        classes: {
          "orchestrator-heavy": "anthropic/claude-frontier",
          "planner-heavy": "anthropic/claude-frontier",
          "adversarial-heavy": "anthropic/claude-frontier",
          "planner-adversarial-heavy": "anthropic/claude-frontier",
          "research-heavy": "anthropic/claude-frontier",
          "code-strong": "anthropic/claude-frontier",
          "test-strong": "anthropic/claude-frontier",
          "context-fast": "anthropic/claude-frontier",
          "verifier-fast": "anthropic/claude-frontier",
        },
        models: {
          "anthropic:claude-frontier": {
            capabilities: {
              reasoning: "frontier",
              context: "very_high",
              tool_use: "write_capable",
              structured_outputs: true,
              web: "available",
              citations: true,
              coding: "high",
              summarization: "high",
              evidence_audit: true,
            },
            evidence: ["unit-test capability fixture"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.mkdir(path.join(targetRoot, ".aipi", "runtime", "smoke"), { recursive: true });
  await fs.writeFile(
    path.join(targetRoot, ".aipi", "runtime", "smoke", "live-subagent-result.json"),
    `${JSON.stringify(
      {
        schema: "aipi.live-subagent-smoke.v1",
        verdict: "PASS",
        agent_id: "implementer:fixture",
      },
      null,
      2,
    )}\n`,
  );
}
