import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  formatWorkflowCommandResult,
  parseWorkflowArgs,
  readActiveRun,
  recordWorkflowUserInput,
  runWorkflowCommand,
  startWorkflowRun,
} from "../extensions/aipi/runtime/run-state.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-run-state-"));
const sourceRoot = path.resolve("templates/.aipi");
const fixedDate = new Date("2026-06-16T12:34:56.789Z");
const fixedRandom = () => Buffer.from("abcdef", "hex");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });

  assert.deepEqual(parseWorkflowArgs("feature --dry-run --contract rules.md"), {
    action: "start",
    workflow: "feature",
    dryRun: true,
    contractPath: "rules.md",
  });
  assert.deepEqual(parseWorkflowArgs("start bug"), {
    action: "start",
    workflow: "bugfix",
    dryRun: false,
    contractPath: null,
  });
  assert.deepEqual(parseWorkflowArgs("run quick"), {
    action: "run",
    workflow: "quick",
    dryRun: false,
    contractPath: null,
  });
  assert.deepEqual(parseWorkflowArgs("execute"), {
    action: "execute",
  });
  assert.throws(() => parseWorkflowArgs("unknown"), /Unknown AIPI workflow/);

  const list = await runWorkflowCommand({ args: "list", projectRoot: tempRoot });
  assert.equal(list.action, "list");
  assert.deepEqual(list.workflows, ["bugfix", "feature", "ops", "planning", "quick", "research"]);
  assert.match(formatWorkflowCommandResult(list), /feature/);

  const emptyStatus = await runWorkflowCommand({ args: "status", projectRoot: tempRoot });
  assert.equal(emptyStatus.active, null);

  const dryRun = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "quick",
    dryRun: true,
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  assert.equal(dryRun.runId, "20260616T123456Z-abcdef");
  assert.equal(await readActiveRun(tempRoot), null);

  const started = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "feature",
    contractPath: ".aipi/runtime/runs/custom/BDD-CONTRACT.md",
    now: () => fixedDate,
    randomBytes: fixedRandom,
  });
  assert.equal(started.runId, "20260616T123456Z-abcdef");
  assert.equal(started.state.current_step, "load_contract");
  assert.equal(started.state.steps.length, 10);

  const runDir = path.join(tempRoot, ".aipi", "runtime", "runs", started.runId);
  assert.match(await fs.readFile(path.join(runDir, "RUN-MANIFEST.md"), "utf8"), /schema: aipi.run-manifest.v1/);
  const state = JSON.parse(await fs.readFile(path.join(runDir, "state.json"), "utf8"));
  assert.equal(state.workflow, "feature");
  assert.equal(state.contract_path, ".aipi/runtime/runs/custom/BDD-CONTRACT.md");
  assert.equal(await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "runs", "active"), "utf8"), `${started.runId}\n`);

  const active = await readActiveRun(tempRoot);
  assert.equal(active.runId, started.runId);
  assert.equal(active.state.workflow, "feature");
  assert.match(formatWorkflowCommandResult({ action: "status", active }), /current_step=load_contract/);

  const userInput = await recordWorkflowUserInput({
    projectRoot: tempRoot,
    text: "api_key=SECRETSECRET12345\nCliente enterprise exige aprovacao fiscal.",
    source: "test",
    now: () => fixedDate,
  });
  assert.equal(userInput.record.step_id, "load_contract");
  assert.doesNotMatch(userInput.record.text, /SECRETSECRET12345/);
  assert.match(userInput.record.text, /Cliente enterprise/);
  const inputLog = await fs.readFile(path.join(tempRoot, userInput.relPath), "utf8");
  assert.match(inputLog, /aipi.user-input.v1/);
  assert.doesNotMatch(inputLog, /SECRETSECRET12345/);
  const updatedActive = await readActiveRun(tempRoot);
  assert.equal(updatedActive.state.last_user_input.path, userInput.relPath);

  const statePath = path.join(runDir, "state.json");
  const terminalState = JSON.parse(await fs.readFile(statePath, "utf8"));
  terminalState.status = "escalated_to_human";
  terminalState.current_step = null;
  terminalState.awaiting_user_input = null;
  await fs.writeFile(statePath, `${JSON.stringify(terminalState, null, 2)}\n`);
  assert.equal(await readActiveRun(tempRoot), null);
  await assert.rejects(
    () => fs.readFile(path.join(tempRoot, ".aipi", "runtime", "runs", "active"), "utf8"),
    /ENOENT/,
  );

  // CR-59-2 / ADV-58-1: a structurally-dead run blocked only on the workflow freestyle/retry/cancel
  // META-decision (status:blocked, awaiting_user_input.kind:workflow_blocked_decision) is NOT a
  // terminal status, so the terminal self-clear above misses it. readActiveRun must centrally
  // self-recover it so it cannot remain active across sessions or be seen by other hooks.
  const activePath = path.join(tempRoot, ".aipi", "runtime", "runs", "active");
  const decisionState = JSON.parse(await fs.readFile(statePath, "utf8"));
  decisionState.status = "blocked";
  decisionState.current_step = "load_contract";
  decisionState.blocked_reason = "no executable adapter is configured for load_contract";
  decisionState.awaiting_user_input = {
    step_id: "load_contract",
    reason: "no executable adapter is configured for load_contract",
    created_at: fixedDate.toISOString(),
    question: "AIPI parou em load_contract: o gate nao passou. Como voce quer seguir?",
    options: [
      "Continuar fora do workflow automatico nesta conversa",
      "Tentar executar este workflow novamente",
      "Cancelar este run",
    ],
    allow_free_text: true,
    kind: "workflow_blocked_decision",
  };
  delete decisionState.abandoned_at;
  delete decisionState.abandon_reason;
  delete decisionState.closed_by;
  delete decisionState.closed_at;
  await fs.writeFile(statePath, `${JSON.stringify(decisionState, null, 2)}\n`);
  await fs.writeFile(activePath, `${started.runId}\n`);

  // keepBlockedDecision opt-out: handleInput still sees the run to run its explicit notify+audit
  // auto-detach (the central silent recovery must NOT fire on this path).
  const keptDecision = await readActiveRun(tempRoot, { keepBlockedDecision: true });
  assert.equal(keptDecision.runId, started.runId);
  assert.equal(keptDecision.state.status, "blocked");
  assert.equal(keptDecision.state.awaiting_user_input.kind, "workflow_blocked_decision");
  // Re-arm the active pointer the keep-read intentionally left in place, then prove the default
  // read self-recovers: returns null, clears runs/active, and records the detach on state.json.
  await fs.writeFile(activePath, `${started.runId}\n`);
  assert.equal(await readActiveRun(tempRoot), null);
  await assert.rejects(
    () => fs.readFile(activePath, "utf8"),
    /ENOENT/,
  );
  const recoveredState = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(recoveredState.status, "abandoned");
  assert.equal(recoveredState.awaiting_user_input, null);
  assert.equal(recoveredState.current_step, null);
  assert.equal(recoveredState.closed_by, "system_auto_recover");
  assert.match(recoveredState.abandon_reason, /auto-detached stale workflow-blocked decision run/);
  assert.equal(typeof recoveredState.abandoned_at, "string");

  console.log("AIPI_RUN_STATE_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
