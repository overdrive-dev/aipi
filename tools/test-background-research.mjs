import assert from "node:assert/strict";
import {
  MAX_BACKGROUND_RESEARCH,
  registerBackgroundResearchTool,
  runBackgroundResearchJob,
} from "../extensions/aipi/runtime/background-research.js";

// --- runBackgroundResearchJob: read-only spawn params + wakes the orchestrator on success ---
{
  const spawned = [];
  const runner = {
    spawn: async (params, opts) => {
      spawned.push({ params, opts });
      return { output: `found: ${params.task}` };
    },
  };
  const wakes = [];
  const pi = { sendMessage: async (msg, opts) => { wakes.push({ msg, opts }); } };

  const result = await runBackgroundResearchJob({
    pi, runner, root: "/x", task: "explore auth", runId: "r1", label: "explore auth", model: "anthropic/claude-opus-4-8",
  });
  assert.equal(result.ok, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].params.allow_shell, false, "read-only: no shell");
  assert.equal(spawned[0].params.write_scope, "artifacts", "never merges to the project");
  assert.equal(spawned[0].params.model, "anthropic/claude-opus-4-8");
  assert.equal(spawned[0].params.id, "r1");
  assert.equal(wakes.length, 1, "wakes the orchestrator exactly once");
  assert.equal(wakes[0].opts.triggerTurn, true, "the wake triggers a turn");
  assert.ok(wakes[0].msg.content.includes("found: explore auth"), "findings are delivered");
}

// --- a failing worker still wakes (with the error) and never rejects ---
{
  const runner = { spawn: async () => { throw new Error("boom"); } };
  const wakes = [];
  const pi = { sendMessage: async (msg, opts) => { wakes.push({ msg, opts }); } };

  const result = await runBackgroundResearchJob({ pi, runner, root: "/x", task: "t", runId: "r2", model: "anthropic/claude-opus-4-8" });
  assert.equal(result.ok, false);
  assert.equal(wakes.length, 1, "a failure still wakes the orchestrator");
  assert.equal(wakes[0].opts.triggerTurn, true);
  assert.ok(wakes[0].msg.content.includes("failed"));
}

// --- registerBackgroundResearchTool: returns immediately; guards on model + tasks; caps overflow ---
{
  const tools = new Map();
  const spawned = [];
  const pi = {
    registerTool: (def) => tools.set(def.name, def),
    sendMessage: async () => {},
  };
  const runnerFactory = () => ({ spawn: async (params) => { spawned.push(params); return { output: "ok" }; } });
  registerBackgroundResearchTool(pi, { projectRootResolver: () => "/proj", runnerFactory });

  const tool = tools.get("aipi_background_research");
  assert.ok(tool, "tool registered");
  assert.ok((tool.promptGuidelines ?? []).length >= 1, "carries the model nudge");

  const call = (params, ctx) => tool.execute("id", params, null, null, ctx).then((r) => JSON.parse(r.content[0].text));

  assert.equal((await call({ tasks: ["a"] }, { model: null })).ok, false, "no host model -> ok:false");
  assert.equal((await call({ tasks: [] }, { model: "anthropic/claude-opus-4-8" })).ok, false, "empty tasks -> ok:false");

  const ok = await call({ tasks: ["explore a", "explore b"] }, { model: "anthropic/claude-opus-4-8" });
  assert.equal(ok.ok, true);
  assert.equal(ok.dispatched, 2, "returns immediately with the dispatched count");
  assert.equal(ok.runs.length, 2);
  assert.ok(ok.runs[0].run_id.startsWith("research-"));

  const many = Array.from({ length: MAX_BACKGROUND_RESEARCH + 3 }, (_, i) => `task ${i}`);
  const capped = await call({ tasks: many }, { model: "anthropic/claude-opus-4-8" });
  assert.equal(capped.dispatched, MAX_BACKGROUND_RESEARCH, "caps concurrent workers");
  assert.equal(capped.not_dispatched, 3, "reports the overflow — never a silent cap");

  // Let the fire-and-forget jobs settle so they don't leak past the test.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(spawned.length >= 2, "background jobs actually spawned");
}

console.log("AIPI_BACKGROUND_RESEARCH_TEST_OK");
