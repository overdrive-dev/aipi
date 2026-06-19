import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  buildAipiReadinessReport,
  buildAipiStatusReport,
  formatAipiStatus,
} from "../extensions/aipi/runtime/provider-auth.js";
import { MODEL_PRESSURE_SCORER_VERSION } from "../extensions/aipi/runtime/model-pressure-scorer.js";

const root = process.cwd();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-adversarial-readiness-"));
const ADVERSARIAL_BRIEF_SENTINELS = [
  "`external`/`container` command adapters",
  "deterministic domain aliases",
  "polarity conflicts",
  "automation conflicts",
  "monetary conflicts",
  "threshold direction conflicts",
  "date conflicts",
  "time conflicts",
  "enum value conflicts",
  "boolean state conflicts",
  "cardinality conflicts",
  "historical run",
];
const CLAIM_EVIDENCE_ANCHORS = [
  {
    name: "workflow executor",
    claim: /workflow executor|workflow executor slice|workflows? .*execute|can run through workflow YAML/i,
    evidence: /test:workflow-executor|test:fake-provider-workflows|test:workflow-fixtures|npm run test:workflow-executor/i,
  },
  {
    name: "P3 tools",
    claim: /P3 AIPI tools|memory query|SQLite-backed callers\/impact|approval-gated memory promotion/i,
    evidence: /test:aipi-tools|npm run test:aipi-tools/i,
  },
  {
    name: "permission removal and lifecycle hooks",
    claim: /permission policy|permission profiles|lifecycle hooks|provider telemetry/i,
    evidence: /test:permission-removal|test:lifecycle-hooks|npm run test:permission-removal/i,
  },
  {
    name: "readiness report",
    claim: /readiness report|aipi\.readiness-report\.v1|capability states/i,
    evidence: /test:adversarial-readiness|test:release-fixture|readiness:credentialed/i,
  },
  {
    name: "subagent backend",
    claim: /pi_subagents|subagent backend|owned-file enforcement|worker writes are guarded/i,
    evidence: /test:subagents-real-sdk|test:subagents|Probe A/i,
  },
];

try {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(packageJson.scripts?.["test:adversarial-readiness"], "node tools/test-adversarial-readiness.mjs");
  assert.equal(packageJson.scripts?.["test:fake-provider-workflows"], "node tools/test-fake-provider-workflows.mjs");
  assert.equal(packageJson.scripts?.["test:workflow-fixtures"], "node tools/test-workflow-fixtures.mjs");
  assert.match(packageJson.scripts?.test ?? "", /npm run test:adversarial-readiness/);
  assert.match(packageJson.scripts?.test ?? "", /npm run test:fake-provider-workflows/);
  assert.match(packageJson.scripts?.test ?? "", /npm run test:workflow-fixtures/);

  const claimCheckedDocs = [
    ["README.md", await read("README.md")],
    ["docs/pre-adversarial-completion-plan.md", await read("docs/pre-adversarial-completion-plan.md")],
    ["docs/adversarial-remediation.md", await read("docs/adversarial-remediation.md")],
    ["docs/release-checklist.md", await read("docs/release-checklist.md")],
  ];
  for (const [rel, text] of claimCheckedDocs) {
    assertNoStaleClaims(text, rel);
    assertClaimEvidenceAnchors(text, rel);
  }
  assert.throws(
    () => assertClaimEvidenceAnchors("The workflow executor can run through workflow YAML.", "fixture"),
    /lacks evidence anchor/,
  );
  assert.doesNotThrow(() =>
    assertClaimEvidenceAnchors(
      "The workflow executor can run through workflow YAML. Evidence: npm run test:workflow-executor.",
      "fixture",
    ),
  );

  const releaseChecklist = claimCheckedDocs.find(([rel]) => rel === "docs/release-checklist.md")[1];
  assert.match(releaseChecklist, /aipi\.readiness-report\.v1/);
  assert.match(releaseChecklist, /model-backed\s+pressure\/live-smoke gaps/);
  assert.match(releaseChecklist, /readiness:credentialed/);

  const preAdversarial = await read("docs/pre-adversarial-completion-plan.md");
  for (const sentinel of ADVERSARIAL_BRIEF_SENTINELS) {
    assert.equal(preAdversarial.includes(sentinel), true, `adversarial brief must include ${sentinel}`);
  }

  const remediation = await read("docs/adversarial-remediation.md");
  assert.match(remediation, /Round 43/);
  assert.match(remediation, /aipi\.readiness-report\.v1/);

  const projectRoot = path.join(tempRoot, "project");
  await initProject({ sourceRoot: path.join(root, "templates", ".aipi"), targetRoot: projectRoot });

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
  await fs.writeFile(
    path.join(projectRoot, ".aipi", "model-capabilities.json"),
    `${JSON.stringify({
      schema: "aipi.model-capabilities.v1",
      classes: {
        "orchestrator-heavy": "anthropic/claude-frontier",
        "planner-heavy": "anthropic/claude-frontier",
        "adversarial-heavy": "anthropic/claude-frontier",
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
    }, null, 2)}\n`,
  );

  const status = await buildAipiStatusReport({
    projectRoot,
    env: { PI_CODING_AGENT_DIR: agentDir },
    homeDir: tempRoot,
  });
  assert.equal(status.readiness.schema, "aipi.readiness-report.v1");
  assert.equal(status.readiness.status, "needs_external_evidence");
  assert.deepEqual(status.readiness.blockers, []);
  assert.deepEqual(status.readiness.external_evidence_needed, [
    "pressure.model_backed",
    "smoke.live_subagent",
  ]);
  assert.equal(status.readiness.checks.some((check) => check.id === "isolation.external_runner"), false);
  const statusText = formatAipiStatus(status);
  assert.match(statusText, /Readiness: needs_external_evidence/);
  assert.match(statusText, /pressure\.model_backed: needs_external_evidence/);
  assert.doesNotMatch(statusText, /SECRET_REFRESH_TOKEN|SECRET_ACCESS_TOKEN/);

  const blocked = await buildAipiStatusReport({
    projectRoot,
    env: { PI_CODING_AGENT_DIR: path.join(tempRoot, "missing-agent") },
    homeDir: tempRoot,
  });
  assert.equal(blocked.readiness.status, "blocked");
  assert.equal(blocked.readiness.blockers.includes("provider.anthropic.auth"), true);

  const readyToRun = buildAipiReadinessReport({
    project: status.project,
    anthropic: status.anthropic,
    capabilities: status.capabilities,
    modelCapabilityFloors: status.modelCapabilityFloors,
    env: {
      AIPI_MODEL_PRESSURE: "1",
      AIPI_MODEL_PRESSURE_COMMAND: "model-runner",
      AIPI_LIVE_SMOKE: "1",
    },
  });
  assert.equal(readyToRun.status, "needs_external_evidence");
  assert.deepEqual(readyToRun.external_evidence_needed, ["pressure.model_backed", "smoke.live_subagent"]);
  assert.equal(readyToRun.blockers.length, 0);
  assert.equal(readyToRun.checks.find((check) => check.id === "pressure.model_backed")?.state, "ready_to_run");
  assert.equal(readyToRun.checks.find((check) => check.id === "smoke.live_subagent")?.state, "ready_to_run");
  assert.equal(readyToRun.checks.some((check) => check.id === "isolation.external_runner"), false);

  const unverifiedReady = buildAipiReadinessReport({
    project: status.project,
    anthropic: status.anthropic,
    capabilities: status.capabilities,
    modelCapabilityFloors: status.modelCapabilityFloors,
    externalEvidence: {
      modelPressure: {
        state: "pass",
        evidence:
          ".aipi/evals/model-pressure-baseline-results.json failures=1; .aipi/evals/model-pressure-verify-results.json verify PASS scenarios=2",
      },
      liveSubagentSmoke: {
        state: "pass",
        evidence: ".aipi/runtime/smoke/live-subagent-result.json PASS agent=implementer:smoke",
      },
    },
    env: {},
  });
  assert.equal(unverifiedReady.status, "needs_external_evidence");
  assert.match(
    unverifiedReady.checks.find((check) => check.id === "pressure.model_backed")?.evidence,
    /unverified model-pressure evidence ignored/,
  );

  const ready = buildAipiReadinessReport({
    project: status.project,
    anthropic: status.anthropic,
    capabilities: status.capabilities,
    modelCapabilityFloors: status.modelCapabilityFloors,
    externalEvidence: {
      modelPressure: {
        state: "pass",
        verified: true,
        evidence:
          `.aipi/evals/model-pressure-baseline-results.json failures=1; .aipi/evals/model-pressure-verify-results.json verify PASS scenarios=2; scorer=${MODEL_PRESSURE_SCORER_VERSION}`,
      },
      liveSubagentSmoke: {
        state: "pass",
        evidence: ".aipi/runtime/smoke/live-subagent-result.json PASS agent=implementer:smoke",
      },
    },
    env: {},
  });
  assert.equal(ready.status, "ready_for_adversarial_review");
  assert.equal(ready.external_evidence_needed.length, 0);
  assert.equal(ready.blockers.length, 0);
  assert.equal(ready.checks.some((check) => check.id === "isolation.external_runner"), false);

  console.log("AIPI_ADVERSARIAL_READINESS_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function read(rel) {
  return fs.readFile(path.join(root, rel), "utf8");
}

function assertNoStaleClaims(text, rel) {
  for (const stale of [
    "requires the deferred",
    "remains deferred",
    "Container/external descriptors are still rejected",
    "is rejected until that backend exists",
    "future container/external backend",
    "container/external backend | Deferred",
    "semantic quality beyond deterministic token/path overlap",
    "generic green status",
  ]) {
    assert.equal(text.includes(stale), false, `${rel} contains stale claim: ${stale}`);
  }
}

function assertClaimEvidenceAnchors(text, rel) {
  for (const anchor of CLAIM_EVIDENCE_ANCHORS) {
    if (anchor.claim.test(text) && !anchor.evidence.test(text)) {
      assert.fail(`${rel} ${anchor.name} claim lacks evidence anchor`);
    }
  }
}
