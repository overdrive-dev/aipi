import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAipiReadinessReport,
  buildAipiStatusReport,
  formatAipiReadiness,
  formatAipiStatus,
  formatAnthropicAuthStatus,
  inspectAnthropicAuth,
  resolveAnthropicAuthPath,
} from "../extensions/aipi/runtime/provider-auth.js";
import {
  buildModelPressurePrompt,
  hashModelPressurePrompt,
  MODEL_PRESSURE_SCHEMA,
  MODEL_PRESSURE_SCENARIOS,
  MODEL_PRESSURE_SCORER_VERSION,
  scoreModelPressureScenario,
} from "../extensions/aipi/runtime/model-pressure-scorer.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-provider-auth-"));

try {
  const agentDir = path.join(tempRoot, "agent-dir");
  const authFile = path.join(agentDir, "auth.json");

  assert.equal(
    resolveAnthropicAuthPath({
      env: { PI_CODING_AGENT_DIR: agentDir },
      homeDir: tempRoot,
    }),
    authFile,
  );
  assert.equal(
    resolveAnthropicAuthPath({
      env: { PI_AGENT_DIR: path.join(tempRoot, "legacy-agent-dir") },
      homeDir: tempRoot,
    }),
    path.join(tempRoot, "legacy-agent-dir", "auth.json"),
  );

  const missing = await inspectAnthropicAuth({
    env: { PI_CODING_AGENT_DIR: path.join(tempRoot, "missing-agent") },
    homeDir: tempRoot,
  });
  assert.equal(missing.ready, false);
  assert.equal(missing.sidecar.exists, false);
  assert.match(formatAnthropicAuthStatus(missing), /run \/login anthropic/);

  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    authFile,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        refresh: "SECRET_REFRESH_TOKEN",
        access: "SECRET_ACCESS_TOKEN",
        expires: Date.now() + 60_000,
      },
    }),
  );

  const ready = await inspectAnthropicAuth({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.sidecar.validJson, true);
  assert.equal(ready.sidecar.hasMain, true);
  assert.equal(ready.sidecar.accountCount, 1);
  assert.equal(ready.sidecar.oauthAccountCount, 1);
  assert.equal(ready.sidecar.apiKeyAccountCount, 0);
  assert.equal(ready.sidecar.schema, "pi-toolkit-current");

  const formatted = formatAnthropicAuthStatus(ready);
  assert.match(formatted, /Anthropic provider: OK @ersintarhan\/pi-toolkit@0\.5\.12/);
  assert.match(formatted, /Anthropic provider scope: autoload=anthropic-oauth-only/);
  assert.match(formatted, /schema=pi-toolkit-current/);
  assert.match(formatted, /credentials=1/);
  assert.doesNotMatch(formatted, /SECRET_REFRESH_TOKEN|SECRET_ACCESS_TOKEN|SECRET_API_KEY/);

  const missingContractRoot = path.join(tempRoot, "missing-contract-package");
  await fs.mkdir(path.join(missingContractRoot, "node_modules", "@ersintarhan", "pi-toolkit"), { recursive: true });
  await fs.mkdir(path.join(missingContractRoot, "extensions", "aipi", "provider"), { recursive: true });
  await fs.writeFile(
    path.join(missingContractRoot, "package.json"),
    JSON.stringify({ dependencies: { "@ersintarhan/pi-toolkit": "0.5.12" } }),
  );
  await fs.writeFile(
    path.join(missingContractRoot, "node_modules", "@ersintarhan", "pi-toolkit", "package.json"),
    JSON.stringify({ version: "0.5.12" }),
  );
  await fs.writeFile(path.join(missingContractRoot, "extensions", "aipi", "provider", "anthropic-oauth-only.ts"), "");
  const missingContract = await inspectAnthropicAuth({
    root: missingContractRoot,
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(missingContract.ready, false);
  assert.equal(missingContract.contract_ok, false);
  assert.equal(missingContract.contract_source, "missing_runtime_contract");
  assert.match(formatAnthropicAuthStatus(missingContract), /runtime contract unavailable/);

  await fs.writeFile(
    authFile,
    JSON.stringify({
      anthropic: {
        accounts: {
          primary: {
            refreshToken: "SECRET_ALT_REFRESH_TOKEN",
          },
        },
      },
    }),
  );
  const inferred = await inspectAnthropicAuth({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(inferred.ready, true);
  assert.equal(inferred.sidecar.schema, "anthropic-generic-inferred");
  assert.equal(inferred.sidecar.oauthAccountCount, 1);
  assert.doesNotMatch(formatAnthropicAuthStatus(inferred), /SECRET_ALT_REFRESH_TOKEN/);

  await fs.writeFile(
    authFile,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        refresh: "SECRET_REFRESH_TOKEN",
        access: "SECRET_ACCESS_TOKEN",
      },
    }),
  );

  const projectRoot = path.join(tempRoot, "project");
  await fs.mkdir(path.join(projectRoot, ".aipi", "agents"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".aipi", "workflows"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".aipi", "memory", "project"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".aipi", "evals"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".aipi", "disciplines"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".aipi", "runtime-contract.json"), "{}");
  await fs.writeFile(path.join(projectRoot, ".aipi", "agents", "catalog.yaml"), "");
  await fs.copyFile(
    path.join(process.cwd(), "templates", ".aipi", "evals", "pressure-scenarios.md"),
    path.join(projectRoot, ".aipi", "evals", "pressure-scenarios.md"),
  );
  for (const discipline of ["contract-first", "scope-discipline"]) {
    await fs.copyFile(
      path.join(process.cwd(), "templates", ".aipi", "disciplines", `${discipline}.md`),
      path.join(projectRoot, ".aipi", "disciplines", `${discipline}.md`),
    );
  }
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "model-classes.yaml"),
    `classes:
  code-strong:
    effort: medium
    preferred_families: [anthropic]
    capability_floor:
      coding: high
      context: medium_high
      tool_use: write_capable
      structured_outputs: required
`,
  );
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "model-capabilities.json"),
    `${JSON.stringify({ schema: "aipi.model-capabilities.v1", classes: {}, models: {} }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(projectRoot, ".aipi", "workflows", "feature.yaml"), "");
  await fs.writeFile(path.join(projectRoot, ".aipi", "memory", "project", "project.md"), "");

  const status = await buildAipiStatusReport({
    projectRoot,
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(status.project.installed, true);
  assert.equal(status.anthropic.ready, true);
  assert.equal(status.readiness.schema, "aipi.readiness-report.v1");
  assert.equal(status.readiness.status, "blocked");
  assert.deepEqual(status.readiness.blockers, ["model.capability_floors"]);
  assert.deepEqual(status.readiness.external_evidence_needed, [
    "pressure.model_backed",
    "smoke.live_subagent",
  ]);
  const statusText = formatAipiStatus(status);
  assert.match(statusText, /Capabilities: verified=/);
  assert.match(statusText, /Readiness: blocked/);
  assert.match(statusText, /model\.capability_floors: block/);
  assert.match(statusText, /pressure\.model_backed: needs_external_evidence/);
  assert.match(statusText, /workflow\.executor\.generic: verified/);
  assert.match(statusText, /aipi\.tool\.surface: verified/);
  assert.match(
    statusText,
    /Subagents: pi_subagents registered; worker coverage: default forked pi_subagents spawn, project-scoped runtime paths, host-model restriction, owned-file allocation with guarded child write, budgets, traces, and redispatch; workflow coverage: quick\/generic YAML gates, artifacts, run limits, and configured fan-out; P3 and lifecycle hook coverage is scoped in the capability rows above; parent permission policy\/profiles were intentionally removed/,
  );
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "model-capabilities.json"),
    `${JSON.stringify({
      schema: "aipi.model-capabilities.v1",
      classes: {
        "code-strong": "anthropic/claude-code",
      },
      models: {
        "anthropic:claude-code": {
          capabilities: {
            coding: "high",
            context: "high",
            tool_use: "write_capable",
            structured_outputs: true,
          },
          evidence: ["unit-test capability fixture"],
        },
      },
    }, null, 2)}\n`,
  );
  const statusWithCapabilities = await buildAipiStatusReport({
    projectRoot,
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(statusWithCapabilities.readiness.status, "needs_external_evidence");
  assert.equal(statusWithCapabilities.readiness.checks.find((check) => check.id === "model.capability_floors").state, "pass");
  const deployHostDelegatedCheck = statusWithCapabilities.readiness.checks.find((check) => check.id === "deploy.host_delegated");
  assert.equal(deployHostDelegatedCheck.state, "warn");
  assert.match(deployHostDelegatedCheck.evidence, /host-delegated/);
  assert.match(formatAipiReadiness(statusWithCapabilities.readiness), /deploy\.host_delegated: warn/);

  await fs.writeFile(
    path.join(projectRoot, ".aipi", "model-classes.yaml"),
    `classes:
  code-strong:
    effort: medium
    preferred_families: [anthropic, openai]
  adversarial-heavy:
    effort: high
    preferred_families: [anthropic, openai]
  verifier-fast:
    effort: low
    preferred_families: [anthropic, openai]
`,
  );
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "model-capabilities.json"),
    `${JSON.stringify({
      schema: "aipi.model-capabilities.v1",
      classes: {
        "code-strong": "anthropic/claude-code",
        "adversarial-heavy": "anthropic/claude-review",
        "verifier-fast": "anthropic/claude-verify",
      },
      models: {
        "anthropic:claude-code": { capabilities: {}, evidence: ["unit-test"] },
        "anthropic:claude-review": { capabilities: {}, evidence: ["unit-test"] },
        "anthropic:claude-verify": { capabilities: {}, evidence: ["unit-test"] },
      },
    }, null, 2)}\n`,
  );
  const sameFamilyStatus = await buildAipiStatusReport({
    projectRoot,
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(sameFamilyStatus.adversarialFamilyIsolation.state, "warn");
  assert.equal(
    sameFamilyStatus.readiness.checks.find((check) => check.id === "model.adversarial_family_isolation").state,
    "warn",
  );
  assert.match(
    sameFamilyStatus.readiness.checks.find((check) => check.id === "model.adversarial_family_isolation").evidence,
    /same-family-as-implementation/,
  );
  assert.equal(sameFamilyStatus.readiness.status, "needs_external_evidence");
  assert.match(formatAipiReadiness(sameFamilyStatus.readiness), /model\.adversarial_family_isolation: warn/);

  await fs.mkdir(path.join(projectRoot, ".aipi", "evals"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "evals", "model-pressure-verify-results.json"),
    JSON.stringify(
      await modelPressureReport(projectRoot, "verify", {
        S1: "ask one focused clarifying question",
        S2: "separate report out of scope",
      }),
    ),
  );
  await fs.mkdir(path.join(projectRoot, ".aipi", "runtime", "smoke"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "runtime", "smoke", "live-subagent-result.json"),
    JSON.stringify({
      schema: "aipi.live-subagent-smoke.v1",
      verdict: "PASS",
      agent_id: "implementer:smoke",
    }),
  );
  const verifyOnlyStatus = await buildAipiStatusReport({
    projectRoot,
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(verifyOnlyStatus.readiness.status, "needs_external_evidence");
  assert.deepEqual(verifyOnlyStatus.readiness.external_evidence_needed, ["pressure.model_backed"]);
  assert.match(
    verifyOnlyStatus.readiness.checks.find((check) => check.id === "pressure.model_backed").evidence,
    /model-pressure-baseline-results\.json missing/,
  );
  assert.match(
    verifyOnlyStatus.readiness.checks.find((check) => check.id === "smoke.live_subagent").evidence,
    /PASS agent=implementer:smoke/,
  );
  const forgedBaseline = await modelPressureReport(projectRoot, "baseline", {
    S1: "ask one focused clarifying question",
    S2: "separate report out of scope",
  });
  forgedBaseline.scenarios[0].verdict = "FAIL";
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "evals", "model-pressure-baseline-results.json"),
    JSON.stringify(forgedBaseline),
  );
  const forgedStatus = await buildAipiStatusReport({
    projectRoot,
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(forgedStatus.readiness.status, "needs_external_evidence");
  assert.match(
    forgedStatus.readiness.checks.find((check) => check.id === "pressure.model_backed").evidence,
    /verdict mismatch/,
  );
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "evals", "model-pressure-baseline-results.json"),
    JSON.stringify(
      await modelPressureReport(projectRoot, "baseline", {
        S1: "assume the default behavior is fixed",
        S2: "separate report out of scope",
      }),
    ),
  );
  const evidencedStatus = await buildAipiStatusReport({
    projectRoot,
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(evidencedStatus.readiness.status, "ready_for_adversarial_review");
  assert.deepEqual(evidencedStatus.readiness.external_evidence_needed, []);
  assert.match(
    evidencedStatus.readiness.checks.find((check) => check.id === "pressure.model_backed").evidence,
    /failures=1; .*verify PASS scenarios=2/,
  );
  assert.match(
    evidencedStatus.readiness.checks.find((check) => check.id === "smoke.live_subagent").evidence,
    /PASS agent=implementer:smoke/,
  );
  const readyToRun = buildAipiReadinessReport({
    project: status.project,
    anthropic: status.anthropic,
    capabilities: status.capabilities,
    modelCapabilityFloors: statusWithCapabilities.modelCapabilityFloors,
    env: {
      AIPI_MODEL_PRESSURE: "1",
      AIPI_MODEL_PRESSURE_COMMAND: "model-runner",
      AIPI_LIVE_SMOKE: "1",
    },
  });
  assert.equal(readyToRun.status, "needs_external_evidence");
  assert.deepEqual(readyToRun.external_evidence_needed, ["pressure.model_backed", "smoke.live_subagent"]);
  assert.equal(readyToRun.checks.find((check) => check.id === "pressure.model_backed").state, "ready_to_run");
  assert.equal(readyToRun.checks.find((check) => check.id === "smoke.live_subagent").state, "ready_to_run");
  assert.equal(readyToRun.checks.some((check) => check.id === "isolation.external_runner"), false);
  assert.match(formatAipiReadiness(readyToRun), /needs_external_evidence/);

  await fs.writeFile(authFile, "{not-json");
  const invalid = await inspectAnthropicAuth({
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(invalid.ready, false);
  assert.equal(invalid.sidecar.validJson, false);

  console.log("AIPI_PROVIDER_AUTH_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function modelPressureReport(projectRoot, phase, outputsByScenario) {
  const scenariosMd = await fs.readFile(path.join(projectRoot, ".aipi", "evals", "pressure-scenarios.md"), "utf8");
  const scenarios = [];
  for (const [scenarioId, output] of Object.entries(outputsByScenario)) {
    const scenario = MODEL_PRESSURE_SCENARIOS.find((candidate) => candidate.id === scenarioId);
    const prompt = await buildModelPressurePrompt({ root: projectRoot, scenario, scenariosMd, phase });
    const score = scoreModelPressureScenario({ scenario, output });
    scenarios.push({
      scenario_id: scenario.id,
      discipline: scenario.discipline,
      phase,
      verdict: score.pass ? "PASS" : "FAIL",
      required_passed: score.requiredPassed,
      forbidden_passed: score.forbiddenPassed,
      scorer_version: MODEL_PRESSURE_SCORER_VERSION,
      prompt_sha256: hashModelPressurePrompt(prompt),
      output,
    });
  }
  return {
    schema: MODEL_PRESSURE_SCHEMA,
    phase,
    generated_at: "2026-06-18T00:00:00.000Z",
    command: "unit-test-model-runner",
    scorer_version: MODEL_PRESSURE_SCORER_VERSION,
    scenarios,
  };
}
