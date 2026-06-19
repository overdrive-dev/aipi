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

  console.log("AIPI_RUN_STATE_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
