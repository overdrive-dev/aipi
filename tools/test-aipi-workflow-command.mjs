import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import aipiExtension from "../extensions/aipi/index.js";
import { makeProgressNotifier } from "../extensions/aipi/runtime/lifecycle-hooks.js";
import { initProject } from "../extensions/aipi/runtime/project-init.js";

// CR-59-3 / ADV-58-3: prove the EXPLICIT /aipi-workflow Pi command handler (not only the
// auto-dispatch lifecycle path) forwards a `notify` so a long `run`/`execute` surfaces per-step
// progress to ctx.ui.notify instead of running as a silent "hung vs processing" black box.

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-workflow-cmd-"));

try {
  await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: tempRoot });

  const commands = new Map();
  const captured = {};
  const fakePi = {
    registerTool() {},
    registerCommand(name, config) {
      commands.set(name, config);
    },
    on() {},
  };

  aipiExtension(fakePi, {
    async workflowCommandRunner(input) {
      captured.input = input;
      // Simulate the executor emitting per-step progress through the wired notifier.
      input.notify?.("step 1/3 implement: running", "info");
      input.notify?.("step 2/3 verify: running", "info");
      return {
        action: "run",
        run: { runId: "r1", workflow: "bugfix" },
        execution: { runId: "r1", status: "blocked", state: { status: "blocked", current_step: "implement" } },
      };
    },
  });

  const workflowCommand = commands.get("aipi-workflow");
  assert.ok(workflowCommand, "extension registers the aipi-workflow command");

  const notes = [];
  const ctx = {
    cwd: tempRoot,
    ui: {
      notify(message, kind) {
        notes.push({ message, kind });
      },
    },
  };

  await workflowCommand.handler("run bugfix", ctx);

  // The handler forwarded a real notifier function...
  assert.equal(typeof captured.input.notify, "function");
  assert.equal(captured.input.args, "run bugfix");
  // ...and per-step progress reached the user-facing notify BEFORE the final result line.
  assert.deepEqual(
    notes.filter((note) => /step \d\/\d/.test(note.message)).map((note) => note.message),
    ["step 1/3 implement: running", "step 2/3 verify: running"],
  );
  // The final formatted result is still surfaced last.
  assert.equal(notes.at(-1).kind, "info");
  assert.doesNotMatch(notes.at(-1).message, /step \d\/\d/);

  // Guard: the notifier the handler wires is makeProgressNotifier(ctx), which yields null when the
  // ctx has no usable ui.notify — so the forwarded `notify` is null (not a crashing call) on
  // headless/no-UI surfaces rather than throwing inside the executor.
  assert.equal(makeProgressNotifier({}), null);
  assert.equal(makeProgressNotifier({ ui: {} }), null);
  assert.equal(typeof makeProgressNotifier(ctx), "function");

  // The REAL makeProgressNotifier sink drives the host UI when it supports the richer surfaces:
  // setPlan -> ctx.ui.setWidget, setStatus/spinner -> ctx.ui.setStatus, clear -> setWidget(undefined).
  const uiCalls = { notify: [], widget: [], status: [] };
  const richSink = makeProgressNotifier({
    ui: {
      notify: (message, kind) => uiCalls.notify.push({ message, kind }),
      setWidget: (key, content) => uiCalls.widget.push({ key, content }),
      setStatus: (key, text) => uiCalls.status.push({ key, text }),
    },
  });
  richSink("hello", "info");
  assert.deepEqual(uiCalls.notify.at(-1), { message: "hello", kind: "info" });
  richSink.setPlan(["○ 1/2 triage", "○ 2/2 fix"]);
  assert.deepEqual(uiCalls.widget.at(-1).content, ["○ 1/2 triage", "○ 2/2 fix"]);
  richSink.startSpinner("bugfix: triage");
  assert.ok(uiCalls.status.some((call) => /bugfix: triage/.test(call.text ?? "")), "spinner writes an animated status line");
  richSink.clear();
  richSink.stopSpinner();
  assert.equal(uiCalls.widget.at(-1).content, undefined, "clear removes the planner widget");
  assert.equal(uiCalls.status.at(-1).text, undefined, "clear removes the status line");

  // A notify-only host (no setWidget/setStatus): the richer methods are safe no-ops, notify still works.
  const plainCalls = [];
  const plainSink = makeProgressNotifier({ ui: { notify: (m, k) => plainCalls.push({ m, k }) } });
  plainSink.setPlan(["x"]);
  plainSink.startSpinner("y");
  plainSink.stopSpinner();
  plainSink.clear();
  plainSink("line", "info");
  assert.deepEqual(plainCalls.at(-1), { m: "line", k: "info" });

  console.log("AIPI_WORKFLOW_COMMAND_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
