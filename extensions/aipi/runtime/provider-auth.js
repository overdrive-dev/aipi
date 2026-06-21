import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimeCapabilityReport, formatCapabilityReport } from "./capabilities.js";
import {
  buildModelPressurePrompt,
  hashModelPressurePrompt,
  MODEL_PRESSURE_SCHEMA,
  MODEL_PRESSURE_SCORER_VERSION,
  modelPressureScenarioById,
  scoreModelPressureScenario,
} from "./model-pressure-scorer.js";
import {
  inspectAdversarialFamilyIsolation,
  inspectModelCapabilityFloors,
  MODEL_CAPABILITIES_REL_PATH,
} from "./model-router.js";

export const ANTHROPIC_AUTH_FILE_NAME = "auth.json";
export const MODEL_PRESSURE_BASELINE_REPORT = ".aipi/evals/model-pressure-baseline-results.json";
export const MODEL_PRESSURE_VERIFY_REPORT = ".aipi/evals/model-pressure-verify-results.json";
export const LIVE_SUBAGENT_SMOKE_REPORT = ".aipi/runtime/smoke/live-subagent-result.json";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FALLBACK_ANTHROPIC_LOGIN_COMMAND = "/login anthropic";

export function resolveAnthropicAuthPath({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const agentDirOverride = env.PI_CODING_AGENT_DIR?.trim() || env.PI_AGENT_DIR?.trim();
  const agentDir = agentDirOverride
    ? expandHome(agentDirOverride, homeDir)
    : path.join(homeDir, ".pi", "agent");
  return path.join(agentDir, ANTHROPIC_AUTH_FILE_NAME);
}

export async function inspectAnthropicAuth({
  root = packageRoot,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const contractState = await loadAnthropicContract(root);
  const sidecarPath = resolveAnthropicAuthPath({ env, homeDir });
  const sidecar = await inspectSidecar(sidecarPath);
  if (!contractState.ok) {
    return {
      providerId: "anthropic",
      package: null,
      expectedVersion: null,
      dependencyVersion: null,
      installedVersion: null,
      dependencyPinned: false,
      installedMatches: false,
      extensionPath: null,
      extensionAbsPath: null,
      extensionExists: false,
      autoloadScope: null,
      blockedAutoloadPath: null,
      loginCommand: FALLBACK_ANTHROPIC_LOGIN_COMMAND,
      sidecarPath,
      sidecarEnvOverride: null,
      sidecar,
      contract_ok: false,
      contract_source: contractState.source,
      contract_error: contractState.reason,
      ready: false,
    };
  }

  const contract = contractState.contract;
  const packageJson = await readJson(path.join(root, "package.json"));
  const installedPackageJson = await readJson(
    path.join(root, "node_modules", "@ersintarhan", "pi-toolkit", "package.json"),
  );
  const extensionAbsPath = path.resolve(root, contract.extensionPath);

  const dependencyVersion = packageJson.data?.dependencies?.[contract.package] ?? null;
  const installedVersion = installedPackageJson.data?.version ?? null;
  const extensionExists = await pathExists(extensionAbsPath);
  const dependencyPinned = dependencyVersion === contract.version;
  const installedMatches = installedVersion === contract.version;

  return {
    providerId: contract.providerId,
    package: contract.package,
    expectedVersion: contract.version,
    dependencyVersion,
    installedVersion,
    dependencyPinned,
    installedMatches,
    extensionPath: contract.extensionPath,
    extensionAbsPath,
    extensionExists,
    autoloadScope: contract.autoloadScope ?? null,
    blockedAutoloadPath: contract.blockedAutoloadPath ?? null,
    loginCommand: contract.loginCommand,
    sidecarPath,
    sidecarEnvOverride: contract.sidecarEnvOverride,
    sidecar,
    contract_ok: true,
    contract_source: contractState.source,
    contract_error: null,
    ready:
      dependencyPinned &&
      installedMatches &&
      extensionExists &&
      sidecar.exists &&
      sidecar.validJson &&
      sidecar.authMaterialPresent,
  };
}

export function formatAnthropicAuthStatus(report) {
  const extensionStatus = report.contract_ok === false
    ? `CHECK runtime contract unavailable: ${report.contract_error}`
    : report.dependencyPinned && report.installedMatches && report.extensionExists
      ? `OK ${report.package}@${report.expectedVersion}`
      : [
          "CHECK",
          `${report.package} expected ${report.expectedVersion}`,
          `dependency=${report.dependencyVersion ?? "missing"}`,
          `installed=${report.installedVersion ?? "missing"}`,
          `extension=${report.extensionExists ? "present" : "missing"}`,
        ].join(" ");

  const sidecarStatus = formatSidecarStatus(report);
  const readiness = report.ready ? "ready" : `not ready; run ${report.loginCommand}`;
  const scopeStatus = report.autoloadScope ? `autoload=${report.autoloadScope}` : null;

  return [
    `Anthropic provider: ${extensionStatus}`,
    scopeStatus ? `Anthropic provider scope: ${scopeStatus}` : null,
    `Anthropic auth file: ${sidecarStatus}`,
    `Anthropic readiness: ${readiness}`,
  ].filter(Boolean).join("\n");
}

export async function inspectProjectInstall(projectRoot) {
  const root = path.resolve(projectRoot);
  const requiredPaths = [
    ".aipi/runtime-contract.json",
    ".aipi/agents/catalog.yaml",
    ".aipi/model-classes.yaml",
    MODEL_CAPABILITIES_REL_PATH,
    ".aipi/workflows/feature.yaml",
    ".aipi/memory/project/project.md",
  ];
  const checks = await Promise.all(
    requiredPaths.map(async (rel) => ({
      path: rel,
      exists: await pathExists(path.join(root, rel)),
    })),
  );

  return {
    root,
    installed: checks.every((check) => check.exists),
    checks,
    missing: checks.filter((check) => !check.exists).map((check) => check.path),
  };
}

export async function buildAipiStatusReport({
  projectRoot,
  root = packageRoot,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const [project, anthropic, contract] = await Promise.all([
    inspectProjectInstall(projectRoot),
    inspectAnthropicAuth({ root, env, homeDir }),
    readJson(path.join(root, "templates", ".aipi", "runtime-contract.json")),
  ]);
  const backend = contract.data?.subagentBackendOptions ?? {};
  const capabilityReport = buildRuntimeCapabilityReport({ contract: contract.data ?? {} });
  const externalEvidence = await inspectAipiExternalEvidence(project.root);
  const modelCapabilityFloors = project.installed
    ? await inspectModelCapabilityFloors({ root: project.root, env }).catch((error) => ({
        schema: "aipi.model-capability-floor-report.v1",
        state: "block",
        config_path: MODEL_CAPABILITIES_REL_PATH,
        total_classes: 0,
        passed: 0,
        failing: 1,
        checks: [],
        error: String(error?.message ?? error),
      }))
    : { state: "block", checks: [], failing: 1, error: "project not installed" };
  const adversarialFamilyIsolation = project.installed
    ? await inspectAdversarialFamilyIsolation({ root: project.root, env }).catch((error) => ({
        schema: "aipi.adversarial-family-isolation.v1",
        state: "warn",
        evidence: `adversarial family isolation could not be inspected: ${String(error?.message ?? error)}`,
      }))
    : { state: "not_applicable", evidence: "project not installed" };
  const readiness = buildAipiReadinessReport({
    project,
    anthropic,
    capabilities: capabilityReport,
    externalEvidence,
    modelCapabilityFloors,
    adversarialFamilyIsolation,
    env,
  });

  return {
    project,
    anthropic,
    capabilities: capabilityReport,
    modelCapabilityFloors,
    adversarialFamilyIsolation,
    readiness,
    subagents: {
      preferredBackend: backend.preferredSpike ?? "unknown",
      spawnWired: true,
      runtimeStatus:
        "worker coverage: default forked pi_subagents spawn, project-scoped runtime paths, host-model restriction, owned-file allocation with guarded child write, budgets, traces, and redispatch; workflow coverage: quick/generic YAML gates, artifacts, run limits, and configured fan-out; P3 and lifecycle hook coverage is scoped in the capability rows above; parent permission policy/profiles were intentionally removed",
      criterionZero: backend.criterionZero ?? "",
    },
  };
}

export function formatAipiStatus(report) {
  const projectStatus = report.project.installed
    ? `installed at ${path.join(report.project.root, ".aipi")}`
    : `not installed; run /aipi-init (${report.project.missing.join(", ")})`;
  const subagentStatus = report.subagents.spawnWired
    ? report.subagents.runtimeStatus
    : "spawn backend not wired";

  return [
    `AIPI project: ${projectStatus}`,
    formatAnthropicAuthStatus(report.anthropic),
    formatCapabilityReport(report.capabilities),
    formatAipiReadiness(report.readiness),
    `Subagents: ${report.subagents.preferredBackend} registered; ${subagentStatus}. ${report.subagents.criterionZero}`,
  ].join("\n");
}

export function aipiStatusKind(report) {
  if (!report.project.installed || !report.anthropic.ready) return "warning";
  if (report.readiness?.status === "blocked") return "warning";
  return "info";
}

function formatSidecarStatus(report) {
  const sidecar = report.sidecar;
  if (!sidecar.exists) return `missing at ${report.sidecarPath}`;
  if (!sidecar.validJson) return `invalid JSON at ${report.sidecarPath}`;
  return [
    `found at ${report.sidecarPath}`,
    `schema=${sidecar.schema}`,
    `anthropic=${sidecar.hasMain ? "yes" : "no"}`,
    `credentials=${sidecar.accountCount}`,
    `oauth=${sidecar.oauthAccountCount}`,
    `api=${sidecar.apiKeyAccountCount}`,
  ].join(" ");
}

function formatModelCapabilityFloorEvidence(report) {
  if (!report) return "model capability floor report unavailable";
  if (report.state === "pass") {
    return `${MODEL_CAPABILITIES_REL_PATH} satisfies ${report.passed}/${report.total_classes} model classes`;
  }
  const failing = Array.isArray(report.checks)
    ? report.checks.filter((check) => check.state !== "pass").slice(0, 4)
    : [];
  const details = failing
    .map((check) => `${check.model_class}:${check.state}`)
    .join(", ");
  return [
    `${MODEL_CAPABILITIES_REL_PATH} does not prove model capability floors`,
    `failing=${report.failing ?? failing.length}`,
    details || report.error || "no checks",
  ].join("; ");
}

export function buildAipiReadinessReport({
  project,
  anthropic,
  capabilities,
  modelCapabilityFloors = null,
  adversarialFamilyIsolation = null,
  externalEvidence = {},
  env = process.env,
} = {}) {
  const modelPressure = externalEvidence.modelPressure ?? { state: "missing" };
  const liveSmoke = externalEvidence.liveSubagentSmoke ?? { state: "missing" };
  const modelPressureVerified = modelPressure.state === "pass" && modelPressure.verified === true;
  const modelPressureRunnable = env.AIPI_MODEL_PRESSURE === "1" && env.AIPI_MODEL_PRESSURE_COMMAND?.trim();
  const liveSmokeRunnable = env.AIPI_LIVE_SMOKE === "1";
  const checks = [
    {
      id: "project.install",
      state: project?.installed ? "pass" : "block",
      evidence: project?.installed ? ".aipi required files present" : `missing: ${(project?.missing ?? []).join(", ")}`,
      next_action: project?.installed ? null : "run /aipi-init in the target repository",
    },
    {
      id: "provider.anthropic.auth",
      state: anthropic?.ready ? "pass" : "block",
      evidence: anthropic?.ready
        ? "pinned provider extension and auth sidecar ready"
        : anthropic?.contract_ok === false
          ? `providerAuth.anthropic unavailable: ${anthropic.contract_error}`
          : "Anthropic auth sidecar not ready",
      next_action: anthropic?.ready
        ? null
        : anthropic?.contract_ok === false
          ? "restore templates/.aipi/runtime-contract.json providerAuth.anthropic"
          : `run ${anthropic?.loginCommand ?? "/login anthropic"}`,
    },
    {
      id: "model.capability_floors",
      state: modelCapabilityFloors?.state === "pass" ? "pass" : "block",
      evidence: formatModelCapabilityFloorEvidence(modelCapabilityFloors),
      next_action:
        modelCapabilityFloors?.state === "pass"
          ? null
          : `populate ${MODEL_CAPABILITIES_REL_PATH} with class-to-model mappings and capabilities that satisfy templates/.aipi/model-classes.yaml`,
    },
    {
      id: "model.adversarial_family_isolation",
      state: adversarialFamilyIsolation?.state === "warn" ? "warn" : "pass",
      evidence: adversarialFamilyIsolation?.evidence ?? "adversarial family isolation report unavailable",
      next_action:
        adversarialFamilyIsolation?.state === "warn"
          ? "configure a second provider/model family, e.g. keep code-strong on one family and adversarial-heavy/verifier-fast on another"
          : null,
    },
    {
      id: "deploy.host_delegated",
      state: "warn",
      evidence:
        "irreversible deploy/prod/migration command blocking is host-delegated: AIPI ops workflow gates planning/review, but the parent-session tool-call permission policy is intentionally absent and not a runtime block",
      next_action:
        "use host approval/sandbox/least-privilege controls for irreversible deploy/prod/migration commands; treat AIPI deployment outputs as advisory unless the host blocks the command",
    },
    {
      id: "pressure.model_backed",
      state:
        modelPressureVerified
          ? "pass"
          : modelPressureRunnable
          ? "ready_to_run"
          : "needs_external_evidence",
      evidence:
        modelPressureVerified
          ? modelPressure.evidence
          : modelPressure.evidence
          ? modelPressure.state === "pass"
            ? `unverified model-pressure evidence ignored: ${modelPressure.evidence}`
            : modelPressure.evidence
          : modelPressureRunnable
          ? "AIPI_MODEL_PRESSURE and command are configured for a credentialed baseline+verify run"
          : "model-backed pressure eval has not been run with credentials in this environment",
      next_action:
        modelPressureVerified
          ? null
          : modelPressureRunnable
          ? "run baseline and verify phases with npm run test:model-pressure-evals"
          : "set AIPI_MODEL_PRESSURE=1 and AIPI_MODEL_PRESSURE_COMMAND, then run baseline and verify phases with npm run test:model-pressure-evals",
    },
    {
      id: "smoke.live_subagent",
      state:
        liveSmoke.state === "pass"
          ? "pass"
          : liveSmokeRunnable
            ? "ready_to_run"
            : "needs_external_evidence",
      evidence:
        liveSmoke.state === "pass"
          ? liveSmoke.evidence
          : liveSmoke.evidence
          ? liveSmoke.evidence
          : liveSmokeRunnable
          ? "AIPI_LIVE_SMOKE is enabled for a credentialed worker run"
          : "live credentialed subagent smoke has not been requested in this environment",
      next_action:
        liveSmoke.state === "pass"
          ? null
        : liveSmokeRunnable
          ? "run npm run smoke:subagent-live"
          : "set AIPI_LIVE_SMOKE=1 and AIPI_LIVE_SMOKE_MODEL=provider/model when outside an interactive session, then run npm run smoke:subagent-live when provider cost is acceptable",
    },
    {
      id: "capability.specification_claims",
      state: capabilities?.states?.specification ? "block" : "pass",
      evidence: `${capabilities?.states?.specification ?? 0} specification-only capabilities reported`,
      next_action: capabilities?.states?.specification ? "downgrade docs or implement missing capability before beta claims" : null,
    },
  ];
  const blockers = checks.filter((check) => check.state === "block");
  const externalEvidenceGaps = checks.filter((check) =>
    ["needs_external_evidence", "ready_to_run"].includes(check.state),
  );
  return {
    schema: "aipi.readiness-report.v1",
    status: blockers.length
      ? "blocked"
      : externalEvidenceGaps.length
        ? "needs_external_evidence"
        : "ready_for_adversarial_review",
    blockers: blockers.map((check) => check.id),
    external_evidence_needed: externalEvidenceGaps.map((check) => check.id),
    checks,
  };
}

export async function inspectAipiExternalEvidence(projectRoot) {
  if (!projectRoot) {
    return {
      modelPressure: { state: "missing", evidence: "project root unavailable" },
      liveSubagentSmoke: { state: "missing", evidence: "project root unavailable" },
    };
  }
  const [modelPressure, liveSubagentSmoke] = await Promise.all([
    inspectModelPressureEvidence(projectRoot),
    inspectLiveSubagentSmokeEvidence(projectRoot),
  ]);
  return { modelPressure, liveSubagentSmoke };
}

async function inspectModelPressureEvidence(projectRoot) {
  const baseline = await readModelPressureReport(projectRoot, MODEL_PRESSURE_BASELINE_REPORT, "baseline");
  if (baseline.state !== "present") return baseline;
  const verify = await readModelPressureReport(projectRoot, MODEL_PRESSURE_VERIFY_REPORT, "verify");
  if (verify.state !== "present") return verify;

  const baselineFailures = baseline.scenarios.filter((scenario) => scenario?.verdict !== "PASS");
  if (!baselineFailures.length) {
    return {
      state: "fail",
      path: MODEL_PRESSURE_BASELINE_REPORT,
      evidence: `${MODEL_PRESSURE_BASELINE_REPORT} has no baseline failures; no discipline flip was proven`,
    };
  }
  const verifyById = new Map(verify.scenarios.map((scenario) => [scenario?.scenario_id, scenario]));
  const missingFlips = baselineFailures.filter((scenario) => verifyById.get(scenario?.scenario_id)?.verdict !== "PASS");
  if (missingFlips.length) {
    return {
      state: "fail",
      path: MODEL_PRESSURE_VERIFY_REPORT,
      evidence: `${MODEL_PRESSURE_VERIFY_REPORT} does not pass baseline-failed scenarios: ${missingFlips.map((item) => item.scenario_id ?? "unknown").join(", ")}`,
    };
  }
  const verifyFailures = verify.scenarios.filter((scenario) => scenario?.verdict !== "PASS");
  if (verifyFailures.length) {
    return {
      state: "fail",
      path: MODEL_PRESSURE_VERIFY_REPORT,
      evidence: `${MODEL_PRESSURE_VERIFY_REPORT} has failing scenarios: ${verifyFailures.map((item) => item.scenario_id ?? "unknown").join(", ")}`,
    };
  }
  return {
    state: "pass",
    verified: true,
    scorer_version: MODEL_PRESSURE_SCORER_VERSION,
    path: MODEL_PRESSURE_VERIFY_REPORT,
    evidence: `${MODEL_PRESSURE_BASELINE_REPORT} failures=${baselineFailures.length}; ${MODEL_PRESSURE_VERIFY_REPORT} verify PASS scenarios=${verify.scenarios.length}; scorer=${MODEL_PRESSURE_SCORER_VERSION}`,
  };
}

async function readModelPressureReport(projectRoot, relPath, phase) {
  const report = await readJson(path.join(projectRoot, relPath));
  if (!report.exists) return { state: "missing", path: relPath, evidence: `${relPath} missing` };
  if (!report.ok) return { state: "invalid", path: relPath, evidence: `${relPath} is not valid JSON` };
  const data = report.data ?? {};
  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
  if (data.schema !== MODEL_PRESSURE_SCHEMA || data.phase !== phase || !scenarios.length) {
    return { state: "invalid", path: relPath, evidence: `${relPath} has invalid schema, phase, or scenarios` };
  }
  if (data.scorer_version !== MODEL_PRESSURE_SCORER_VERSION) {
    return { state: "invalid", path: relPath, evidence: `${relPath} scorer_version is missing or stale` };
  }
  if (typeof data.command !== "string" || !data.command.trim()) {
    return { state: "invalid", path: relPath, evidence: `${relPath} command is missing` };
  }
  const scenariosMd = await fs.readFile(path.join(projectRoot, ".aipi", "evals", "pressure-scenarios.md"), "utf8").catch(() => null);
  if (!scenariosMd) {
    return { state: "invalid", path: relPath, evidence: `${relPath} cannot be verified without .aipi/evals/pressure-scenarios.md` };
  }
  const checked = [];
  const errors = [];
  for (const result of scenarios) {
    const scenario = modelPressureScenarioById(result?.scenario_id);
    if (!scenario) {
      errors.push(`${result?.scenario_id ?? "unknown"} unknown scenario`);
      continue;
    }
    if (result.phase && result.phase !== phase) errors.push(`${scenario.id} phase mismatch`);
    if (result.scorer_version !== MODEL_PRESSURE_SCORER_VERSION) errors.push(`${scenario.id} scorer_version mismatch`);
    if (typeof result.output !== "string" || !result.output.trim()) errors.push(`${scenario.id} output missing`);
    const score = scoreModelPressureScenario({ scenario, output: result.output ?? "" });
    const recomputedVerdict = score.pass ? "PASS" : "FAIL";
    if (result.verdict !== recomputedVerdict) errors.push(`${scenario.id} verdict mismatch`);
    if (result.required_passed !== score.requiredPassed) errors.push(`${scenario.id} required_passed mismatch`);
    if (result.forbidden_passed !== score.forbiddenPassed) errors.push(`${scenario.id} forbidden_passed mismatch`);
    const prompt = await buildModelPressurePrompt({ root: projectRoot, scenario, scenariosMd, phase }).catch(() => null);
    const promptSha256 = prompt ? hashModelPressurePrompt(prompt) : null;
    if (!promptSha256 || result.prompt_sha256 !== promptSha256) errors.push(`${scenario.id} prompt_sha256 mismatch`);
    checked.push({
      ...result,
      verdict: recomputedVerdict,
      required_passed: score.requiredPassed,
      forbidden_passed: score.forbiddenPassed,
      recomputed: true,
    });
  }
  if (errors.length) {
    return {
      state: "invalid",
      path: relPath,
      evidence: `${relPath} failed scorer verification: ${errors.slice(0, 4).join("; ")}`,
    };
  }
  return {
    state: "present",
    path: relPath,
    evidence: `${relPath} ${phase} scenarios=${checked.length}; scorer=${MODEL_PRESSURE_SCORER_VERSION}`,
    scenarios: checked,
    command: data.command,
    scorer_version: data.scorer_version,
  };
}

async function inspectLiveSubagentSmokeEvidence(projectRoot) {
  const relPath = LIVE_SUBAGENT_SMOKE_REPORT;
  const report = await readJson(path.join(projectRoot, relPath));
  if (!report.exists) return { state: "missing", path: relPath, evidence: `${relPath} missing` };
  if (!report.ok) return { state: "invalid", path: relPath, evidence: `${relPath} is not valid JSON` };
  const data = report.data ?? {};
  if (data.schema !== "aipi.live-subagent-smoke.v1") {
    return { state: "invalid", path: relPath, evidence: `${relPath} has invalid schema` };
  }
  if (data.verdict !== "PASS") {
    return { state: "fail", path: relPath, evidence: `${relPath} verdict=${data.verdict ?? "unknown"}` };
  }
  return {
    state: "pass",
    path: relPath,
    evidence: `${relPath} PASS agent=${data.agent_id ?? "unknown"}`,
  };
}

export function formatAipiReadiness(readiness) {
  if (!readiness) return "Readiness: unknown";
  const actionable = readiness.checks
    .filter((check) => check.state !== "pass")
    .map((check) => `- ${check.id}: ${check.state}; ${check.next_action}`)
    .join("\n");
  return [
    `Readiness: ${readiness.status}`,
    actionable || "- all readiness checks are pass/configured",
  ].join("\n");
}

async function loadAnthropicContract(root) {
  const contract = await readJson(path.join(root, "templates", ".aipi", "runtime-contract.json"));
  if (!contract.exists) {
    return {
      ok: false,
      source: "missing_runtime_contract",
      reason: "templates/.aipi/runtime-contract.json is missing",
    };
  }
  if (!contract.ok) {
    return {
      ok: false,
      source: "invalid_runtime_contract",
      reason: "templates/.aipi/runtime-contract.json is not valid JSON",
    };
  }
  const anthropic = contract.data?.providerAuth?.anthropic ?? null;
  if (!anthropic) {
    return {
      ok: false,
      source: "missing_provider_auth",
      reason: "runtime-contract providerAuth.anthropic is missing",
    };
  }
  return { ok: true, source: "runtime-contract", contract: anthropic };
}

async function inspectSidecar(sidecarPath) {
  const parsed = await readJson(sidecarPath);
  if (!parsed.exists) {
    return {
      exists: false,
      validJson: false,
      hasMain: false,
      accountCount: 0,
      oauthAccountCount: 0,
      apiKeyAccountCount: 0,
      authMaterialPresent: false,
      routingMode: null,
      schema: "missing",
    };
  }

  if (!parsed.ok) {
    return {
      exists: true,
      validJson: false,
      hasMain: false,
      accountCount: 0,
      oauthAccountCount: 0,
      apiKeyAccountCount: 0,
      authMaterialPresent: false,
      routingMode: null,
      schema: "invalid-json",
    };
  }

  const credential = parsed.data?.anthropic;
  const hasMain = Boolean(credential);
  const currentSchema = inspectCurrentAnthropicCredential(credential);
  const genericSchema = currentSchema.authMaterialPresent
    ? currentSchema
    : inspectGenericAnthropicCredential(credential);

  return {
    exists: true,
    validJson: true,
    hasMain,
    accountCount: genericSchema.authMaterialPresent ? 1 : 0,
    oauthAccountCount: genericSchema.oauthAccountCount,
    apiKeyAccountCount: genericSchema.apiKeyAccountCount,
    authMaterialPresent: genericSchema.authMaterialPresent,
    routingMode: null,
    schema: genericSchema.schema,
  };
}

function inspectCurrentAnthropicCredential(credential) {
  const oauthAccountCount = credential?.type === "oauth" ? 1 : 0;
  const apiKeyAccountCount = credential?.type === "api_key" ? 1 : 0;
  const authMaterialPresent = Boolean(
    (credential?.type === "oauth" && (credential.access || credential.refresh)) ||
      (credential?.type === "api_key" && credential.key),
  );
  return {
    authMaterialPresent,
    oauthAccountCount: authMaterialPresent ? oauthAccountCount : 0,
    apiKeyAccountCount: authMaterialPresent ? apiKeyAccountCount : 0,
    schema: authMaterialPresent ? "pi-toolkit-current" : "anthropic-current-empty",
  };
}

function inspectGenericAnthropicCredential(credential) {
  const scan = scanAuthMaterial(credential);
  return {
    authMaterialPresent: scan.present,
    oauthAccountCount: scan.oauth ? 1 : 0,
    apiKeyAccountCount: scan.apiKey ? 1 : 0,
    schema: scan.present ? "anthropic-generic-inferred" : "anthropic-missing-material",
  };
}

function scanAuthMaterial(value) {
  if (!value || typeof value !== "object") return { present: false, oauth: false, apiKey: false };
  let present = false;
  let oauth = false;
  let apiKey = false;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (typeof nested === "string" && nested.trim()) {
      if (["access", "refresh", "accesstoken", "refreshtoken", "token"].includes(normalized)) {
        present = true;
        oauth = true;
      }
      if (["key", "apikey"].includes(normalized)) {
        present = true;
        apiKey = true;
      }
    }
    const child = scanAuthMaterial(nested);
    present = present || child.present;
    oauth = oauth || child.oauth;
    apiKey = apiKey || child.apiKey;
  }
  return { present, oauth, apiKey };
}

async function readJson(filePath) {
  try {
    return {
      exists: true,
      ok: true,
      data: JSON.parse(await fs.readFile(filePath, "utf8")),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, ok: false, data: null };
    return { exists: true, ok: false, data: null, error };
  }
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value, homeDir) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir, value.slice(2));
  return path.resolve(value);
}
