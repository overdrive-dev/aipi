import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  diagnoseAipiProject,
  formatDiagnoseHelp,
  parseDiagnoseArgs,
  runDiagnoseCommand,
} from "../extensions/aipi/runtime/diagnose.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-diagnose-"));
try {
  await fs.mkdir(path.join(tempRoot, ".aipi", "runtime", "runs"), { recursive: true });
  await writeRunFixture({
    root: tempRoot,
    runId: "20260618T100000Z-blocked",
    state: {
      schema: "aipi.run-state.v1",
      run_id: "20260618T100000Z-blocked",
      workflow: "feature",
      status: "blocked",
      created_at: "2026-06-18T10:00:00.000Z",
      current_step: "business_rule_check",
      blocked_reason: "needs business decision",
      awaiting_user_input: {
        step_id: "business_rule_check",
        question: "Qual regra fiscal devemos aplicar?",
        options: ["Usar regra estadual", "Pedir decisao humana"],
        allow_free_text: true,
      },
      steps: [
        {
          id: "business_rule_check",
          status: "blocked",
          verdict: "BLOCKED",
          error: "needs business decision",
        },
      ],
    },
  });

  await writeRunFixture({
    root: tempRoot,
    runId: "20260618T110000Z-failed",
    state: {
      schema: "aipi.run-state.v1",
      run_id: "20260618T110000Z-failed",
      workflow: "bugfix",
      status: "failed",
      created_at: "2026-06-18T11:00:00.000Z",
      completed_at: "2026-06-18T11:01:00.000Z",
      current_step: "review_swarm",
      blocked_reason: "worker failed",
      steps: [
        {
          id: "review_swarm",
          status: "failed",
          verdict: "FAIL",
          error: "worker:abc123ef finished without assistant text token=sk-testsecret123456789",
          result_path: ".aipi/runtime/runs/20260618T110000Z-failed/steps/review_swarm/RESULT.md",
        },
      ],
      subagents: {
        jobs: [
          {
            agentId: "worker:abc123ef",
            state: "failed",
            error: "worker:abc123ef finished without assistant text token=sk-testsecret123456789",
            toolCallCount: 0,
            model: {
              requested: "context-fast",
              resolved: "anthropic/claude-opus-4-8",
              fallback: false,
              source: "model-capabilities",
            },
          },
        ],
      },
    },
    stepResult: {
      result: {
        schema: "aipi.step-result.v1",
        step_id: "review_swarm",
        agent_ids: ["worker:abc123ef"],
        verdict: "FAIL",
        evidence: [
          {
            rung: "blocked",
            source: "worker",
            ref: "worker:abc123ef",
            result: "finished without assistant text password=hunter2secret",
          },
        ],
        artifacts: [],
      },
      validation: { errors: ["step result did not pass gate"] },
      missing_artifacts: [],
    },
  });

  await fs.writeFile(
    path.join(tempRoot, ".aipi", "runtime", "provider-events.jsonl"),
    `${JSON.stringify({ run_id: "20260618T110000Z-failed", agent_id: "parent", status: 200, authorization: "Bearer secret-token" })}\n`,
  );

  assert.deepEqual(parseDiagnoseArgs(["run-1", "--share", "--json"]), {
    runId: "run-1",
    share: true,
    json: true,
    help: false,
    target: null,
  });
  assert.match(formatDiagnoseHelp(), /aipi diagnose \[<run_id>\]/);

  const result = await diagnoseAipiProject({
    projectRoot: tempRoot,
    statusFn: fakeStatus,
    now: () => new Date("2026-06-18T12:00:00.000Z"),
  });
  assert.equal(result.target.run_id, "20260618T110000Z-failed");
  assert.equal(result.causes[0].id, "worker_no_provider_events");
  assert.match(result.summary, /provider not registered \/ model unbound in worker process/);
  assert.equal(result.provider_events, undefined);
  const reportPath = path.join(tempRoot, result.report_path);
  const report = await fs.readFile(reportPath, "utf8");
  assert.match(report, /provider not registered \/ model unbound in worker process/);
  assert.match(report, /0 provider events/);
  assert.doesNotMatch(report, /sk-testsecret123456789/);
  assert.doesNotMatch(report, /hunter2secret/);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|sk-testsecret123456789|hunter2secret/);

  const blocked = await diagnoseAipiProject({
    projectRoot: tempRoot,
    runId: "20260618T100000Z-blocked",
    statusFn: fakeStatus,
    now: () => new Date("2026-06-18T12:01:00.000Z"),
  });
  assert.equal(blocked.target.reason, "explicit");
  assert.equal(blocked.causes[0].id, "awaiting_user_decision");
  const blockedReport = await fs.readFile(path.join(tempRoot, blocked.report_path), "utf8");
  assert.match(blockedReport, /Qual regra fiscal devemos aplicar\?/);
  assert.match(blockedReport, /Usar regra estadual/);

  const shared = await diagnoseAipiProject({
    projectRoot: tempRoot,
    runId: "20260618T110000Z-failed",
    share: true,
    statusFn: fakeStatus,
    now: () => new Date("2026-06-18T12:02:00.000Z"),
    spawnSyncFn(command, args) {
      if (command === "gh" && args[0] === "--version") return { status: 1, stdout: "", stderr: "gh missing" };
      if (command === "git") return { status: 1, stdout: "", stderr: "no remote" };
      throw new Error(`unexpected command ${command}`);
    },
  });
  assert.equal(shared.share.status, "local_fallback");
  assert.match(shared.share.message, /shared report saved locally at \.aipi\/runtime\/diagnostics\//);
  assert.doesNotMatch(JSON.stringify(shared), /sk-testsecret123456789|hunter2secret/);

  const help = await runDiagnoseCommand({ projectRoot: tempRoot, args: "--help" });
  assert.equal(help.help, true);
  assert.match(help.text, /Usage: aipi diagnose/);

  console.log("AIPI_DIAGNOSE_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function writeRunFixture({ root, runId, state, stepResult = null }) {
  const runDir = path.join(root, ".aipi", "runtime", "runs", runId);
  await fs.mkdir(path.join(runDir, "steps", state.steps[0].id), { recursive: true });
  await fs.writeFile(path.join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  if (stepResult) {
    await fs.writeFile(
      path.join(runDir, "steps", state.steps[0].id, "RESULT.json"),
      `${JSON.stringify(stepResult, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(runDir, "steps", state.steps[0].id, "RESULT.md"),
      `# Result\n\n${JSON.stringify(stepResult.result)}\n`,
    );
  }
}

async function fakeStatus() {
  return {
    schema: "aipi.status-report.v1",
    readiness: {
      status: "blocked",
      blockers: ["provider.anthropic.auth"],
    },
  };
}
