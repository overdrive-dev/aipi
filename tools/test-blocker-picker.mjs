import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BLOCKER_FREE_TEXT_OPTION } from "../extensions/aipi/runtime/blocker-input.js";
import { createAipiLifecycleHandlers, handleBlockedRunPicker } from "../extensions/aipi/runtime/lifecycle-hooks.js";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import { readActiveRun, startWorkflowRun } from "../extensions/aipi/runtime/run-state.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-blocker-picker-"));
const sourceRoot = path.resolve("templates/.aipi");
const fixedDate = new Date("2026-06-18T12:00:00.000Z");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });
  const started = await startWorkflowRun({
    projectRoot: tempRoot,
    workflow: "planning",
    params: { request: "plan the blocker-picker fixture epic" },
    now: () => fixedDate,
    randomBytes: () => Buffer.from("b10c43", "hex"),
  });

  const notifications = [];
  const selectCalls = [];
  const inputCalls = [];
  const runnerCalls = [];
  const piEntries = [];
  const pi = {
    appendEntry(type, data) {
      piEntries.push({ type, data });
    },
  };
  const workflowCommandRunner = async ({ args, projectRoot }) => {
    runnerCalls.push({ args, projectRoot });
    const active = await readActiveRun(projectRoot);
    active.state.status = "completed";
    active.state.current_step = null;
    active.state.awaiting_user_input = null;
    return {
      action: "execute",
      execution: {
        runId: active.runId,
        status: "completed",
        state: active.state,
        events: [],
      },
    };
  };
  const handlers = createAipiLifecycleHandlers({
    pi,
    projectRootResolver: () => tempRoot,
    workflowCommandRunner,
  });

  await writeBlockedState(tempRoot, started.runId);
  let selectedValue = "B";
  let typedValue = "Minha resposta livre";
  const ctx = {
    cwd: tempRoot,
    hasUI: true,
    ui: {
      select(question, options) {
        selectCalls.push({ question, options });
        return selectedValue;
      },
      input(question) {
        inputCalls.push(question);
        return typedValue;
      },
      notify(message, kind) {
        notifications.push({ message, kind });
      },
    },
  };

  const plainBlockedResult = await handlers.input({ type: "input", text: "responder blocker", source: "interactive" }, ctx);
  assert.deepEqual(plainBlockedResult, { action: "continue" });
  assert.equal(selectCalls.length, 0);
  assert.match(notifications.at(-1).message, /Qual regra fiscal devemos aplicar\?/);

  const selectedResult = await handleBlockedRunPicker({
    event: { type: "input", text: "responder blocker", source: "interactive" },
    ctx,
    pi,
    projectRoot: tempRoot,
    active: await readActiveRun(tempRoot),
    workflowCommandRunner,
  });
  assert.deepEqual(selectedResult, { action: "handled" });
  assert.equal(selectCalls.length, 1);
  assert.equal(selectCalls[0].question, "Qual regra fiscal devemos aplicar?");
  assert.deepEqual(selectCalls[0].options, ["A", "B", "C", BLOCKER_FREE_TEXT_OPTION]);
  assert.equal(inputCalls.length, 0);
  assert.equal(runnerCalls.at(-1).args, "execute");
  assert.equal((await readUserInputRecords(tempRoot, started.runId)).at(-1).text, "B");

  await writeBlockedState(tempRoot, started.runId);
  selectedValue = BLOCKER_FREE_TEXT_OPTION;
  typedValue = "A regra vale para enterprise anual.";
  const freeTextResult = await handleBlockedRunPicker({
    event: { type: "input", text: "outra resposta", source: "interactive" },
    ctx,
    pi,
    projectRoot: tempRoot,
    active: await readActiveRun(tempRoot),
    workflowCommandRunner,
  });
  assert.deepEqual(freeTextResult, { action: "handled" });
  assert.equal(inputCalls.at(-1), "Qual regra fiscal devemos aplicar?");
  assert.equal((await readUserInputRecords(tempRoot, started.runId)).at(-1).text, typedValue);

  await writeBlockedState(tempRoot, started.runId);
  selectedValue = "Cancelar este run";
  const runnerCallsBeforeCancel = runnerCalls.length;
  const cancelResult = await handleBlockedRunPicker({
    event: { type: "input", text: "cancelar", source: "interactive" },
    ctx,
    pi,
    projectRoot: tempRoot,
    active: await readActiveRun(tempRoot),
    workflowCommandRunner,
  });
  assert.equal(cancelResult.action, "handled");
  assert.equal(cancelResult.run.status, "cancelled");
  assert.equal(runnerCalls.length, runnerCallsBeforeCancel);
  assert.equal(await readActiveRun(tempRoot), null);
  const cancelledState = JSON.parse(await fs.readFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", started.runId, "state.json"),
    "utf8",
  ));
  assert.equal(cancelledState.status, "cancelled");
  assert.equal(cancelledState.awaiting_user_input, null);
  assert.equal(cancelledState.current_step, null);

  await writeBlockedState(tempRoot, started.runId);
  const selectCountBeforeHeadless = selectCalls.length;
  const inputCountBeforeHeadless = (await readUserInputRecords(tempRoot, started.runId)).length;
  const headlessResult = await handlers.input(
    { type: "input", text: "B", source: "headless" },
    {
      cwd: tempRoot,
      hasUI: false,
      ui: {
        select() {
          throw new Error("headless path must not call select");
        },
        notify(message, kind) {
          notifications.push({ message, kind });
        },
      },
    },
  );
  assert.deepEqual(headlessResult, { action: "continue" });
  assert.equal(selectCalls.length, selectCountBeforeHeadless);
  assert.equal((await readUserInputRecords(tempRoot, started.runId)).length, inputCountBeforeHeadless);
  assert.match(notifications.at(-1).message, /Qual regra fiscal devemos aplicar\?/);
  assert.equal(piEntries.some((entry) => entry.data?.input === "blocked_text_prompt"), true);

  // ADV-58-1: a run dead-ended on the freestyle/retry/cancel META-decision must
  // self-recover when the user sends a NEW substantive message instead of selecting an
  // option. Without auto-detach the input is trapped and re-prompts every turn.
  await writeWorkflowBlockedDecisionState(tempRoot, started.runId);
  const fresh = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "runs", started.runId, "state.json"), "utf8");
  assert.equal(JSON.parse(fresh).awaiting_user_input.kind, "workflow_blocked_decision");

  const runnerCallsBeforeDetach = runnerCalls.length;
  const notifyCountBeforeDetach = notifications.length;
  const detachCtx = {
    cwd: tempRoot,
    hasUI: true,
    ui: {
      select() {
        throw new Error("auto-detach must not re-surface the blocker picker");
      },
      input() {
        throw new Error("auto-detach must not prompt for free text");
      },
      notify(message, kind) {
        notifications.push({ message, kind });
      },
    },
  };
  const detachResult = await handlers.input(
    { type: "input", text: "Na verdade, me explique como funciona o cache de sessao.", source: "interactive" },
    detachCtx,
  );
  // The new input was processed as a FRESH turn (not trapped). With routing it resolves
  // to a read-only check / continue; either way it is NOT a re-surfaced blocker prompt.
  assert.notEqual(detachResult, undefined);
  assert.notEqual(detachResult.action, undefined);
  // runs/active is cleared.
  assert.equal(await readActiveRun(tempRoot), null);
  // The run is marked abandoned (detached from the automatic workflow).
  const detachedState = JSON.parse(await fs.readFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", started.runId, "state.json"),
    "utf8",
  ));
  assert.equal(detachedState.status, "abandoned");
  assert.equal(detachedState.awaiting_user_input, null);
  // No re-surfaced awaiting_user_input prompt was shown for the meta-decision.
  const newNotifications = notifications.slice(notifyCountBeforeDetach);
  assert.equal(
    newNotifications.some((note) => /Como voce quer seguir|aguardando decisão|aguardando resposta/.test(note.message)),
    false,
    "auto-detach must not re-surface the meta-decision prompt",
  );
  assert.equal(
    newNotifications.some((note) => /destacou o run bloqueado automaticamente|fora do workflow automatico/.test(note.message)),
    true,
    "auto-detach notifies the user the run was detached",
  );
  // No blocker workflow runner was invoked for the detach (the picker did not execute).
  assert.equal(runnerCalls.length, runnerCallsBeforeDetach);
  assert.equal(
    piEntries.some((entry) => entry.data?.input === "blocked_run_auto_detached"),
    true,
    "auto-detach is audited",
  );

  console.log("AIPI_BLOCKER_PICKER_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function writeBlockedState(projectRoot, runId) {
  const statePath = path.join(projectRoot, ".aipi", "runtime", "runs", runId, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.status = "blocked";
  state.current_step = "business_rule_check";
  state.blocked_reason = "missing business rule answer";
  state.awaiting_user_input = {
    step_id: "business_rule_check",
    reason: "missing business rule answer",
    created_at: fixedDate.toISOString(),
    question: "Qual regra fiscal devemos aplicar?",
    options: ["A", "B", "C"],
    allow_free_text: true,
  };
  for (const step of state.steps) {
    if (step.id === "business_rule_check") {
      step.status = "blocked";
      step.verdict = "BLOCKED_TO_PLANNING";
    } else if (step.status === "blocked") {
      step.status = "pending";
      delete step.verdict;
    }
  }
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await fs.writeFile(path.join(projectRoot, ".aipi", "runtime", "runs", "active"), `${runId}\n`);
}

async function writeWorkflowBlockedDecisionState(projectRoot, runId) {
  const statePath = path.join(projectRoot, ".aipi", "runtime", "runs", runId, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.status = "blocked";
  state.current_step = "load_contract";
  state.blocked_reason = "no executable adapter is configured for load_contract";
  state.awaiting_user_input = {
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
  for (const step of state.steps) {
    if (step.id === "load_contract") {
      step.status = "blocked";
      step.verdict = "BLOCKED";
    } else if (step.status === "blocked") {
      step.status = "pending";
      delete step.verdict;
    }
  }
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await fs.writeFile(path.join(projectRoot, ".aipi", "runtime", "runs", "active"), `${runId}\n`);
}

async function readUserInputRecords(projectRoot, runId) {
  const filePath = path.join(projectRoot, ".aipi", "runtime", "runs", runId, "USER-INPUT.jsonl");
  const text = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
