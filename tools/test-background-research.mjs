import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  MAX_BACKGROUND_RESEARCH,
  registerBackgroundResearchTool,
  resolveResearchRoles,
  runBackgroundResearchJob,
} from "../extensions/aipi/runtime/background-research.js";

// The read-only tool-call budget is a BAKED package default of 80 (no env knob); the worker-gets-80
// assertion below is the coverage.

// --- runBackgroundResearchJob: read-only spawn params + wakes the orchestrator on success (no reviewer) ---
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
  assert.equal(spawned.length, 1, "no reviewer -> single spawn");
  assert.equal(spawned[0].params.allow_shell, false, "read-only: no shell");
  assert.equal(spawned[0].params.write_scope, "artifacts", "never merges to the project");
  assert.equal(spawned[0].params.model, "anthropic/claude-opus-4-8");
  assert.equal(spawned[0].params.id, "r1");
  assert.equal(spawned[0].params.max_tool_calls, 80, "default read-only budget threaded to the worker");
  assert.equal(wakes.length, 1, "wakes the orchestrator exactly once");
  assert.equal(wakes[0].opts.triggerTurn, true, "the wake triggers a turn");
  assert.ok(wakes[0].msg.content.includes("found: explore auth"), "findings are delivered");
  assert.ok(wakes[0].msg.content.includes("UNVERIFIED"), "no-reviewer findings are flagged unverified");
}

// --- with a reviewer: researcher + adversarial reviewer both spawn; wake carries findings AND the review ---
{
  const spawned = [];
  const runner = {
    spawn: async (params) => {
      spawned.push(params);
      return { output: String(params.id).endsWith("-review") ? "VERDICT: corrected\nNOTES: the foo.ts claim was wrong" : `found: ${params.task}` };
    },
  };
  const wakes = [];
  const pi = { sendMessage: async (msg) => { wakes.push(msg); } };

  const result = await runBackgroundResearchJob({
    pi, runner, root: "/x", task: "explore auth", runId: "r1", label: "explore auth",
    model: "anthropic/claude-opus-4-8", thinking: "high",
    reviewer: { model: "xai-auth/grok-4.5", thinking: "high", crossFamily: true },
  });
  assert.equal(result.ok, true);
  assert.equal(spawned.length, 2, "researcher + reviewer both spawn");
  assert.equal(spawned[0].id, "r1");
  assert.equal(spawned[0].thinking_level, "high", "researcher thinking threaded");
  assert.equal(spawned[1].id, "r1-review", "reviewer gets its own run id");
  assert.equal(spawned[1].model, "xai-auth/grok-4.5", "reviewer runs a distinct model");
  assert.equal(spawned[1].allow_shell, false, "reviewer is read-only too");
  assert.ok(spawned[1].task.includes("found: explore auth"), "reviewer is given the researcher findings to verify");
  assert.ok(spawned[1].task.includes("ADVERSARIAL"), "reviewer gets the adversarial critique prompt");
  const content = wakes[0].content;
  assert.ok(content.includes("found: explore auth"), "findings delivered");
  assert.ok(content.includes("Adversarial review") && content.includes("cross-family"), "review attached + independence noted");
  assert.ok(content.includes("VERDICT: corrected"), "reviewer verdict delivered");
  assert.equal(result.review.ok, true);
}

// --- a reviewer failure never fails the job: findings still go up, flagged UNVERIFIED ---
{
  const runner = {
    spawn: async (params) => {
      if (String(params.id).endsWith("-review")) throw new Error("reviewer boom");
      return { output: `found: ${params.task}` };
    },
  };
  const wakes = [];
  const pi = { sendMessage: async (msg) => { wakes.push(msg); } };
  const result = await runBackgroundResearchJob({
    pi, runner, root: "/x", task: "t", runId: "r9", model: "a/b",
    reviewer: { model: "c/d", thinking: null, crossFamily: false },
  });
  assert.equal(result.ok, true, "review failure does not fail the job");
  assert.ok(wakes[0].content.includes("found: t"), "findings still delivered");
  assert.ok(wakes[0].content.includes("FAILED"), "review failure flagged");
  assert.ok(wakes[0].content.includes("UNVERIFIED"));
}

// --- a failing researcher still wakes (with the error) and never rejects ---
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

// --- a rate-limited researcher falls back to the DEFAULT model and wakes with the reroute noted ---
{
  const spawned = [];
  const runner = {
    spawn: async (params) => {
      spawned.push(params);
      if (params.model === "openai-codex/gpt-5.5-limited") {
        throw Object.assign(new Error('429 {"error":{"type":"rate_limit_error"}}'), { status: 429 });
      }
      return { output: `found via default: ${params.task}` };
    },
  };
  const wakes = [];
  const pi = { sendMessage: async (msg) => { wakes.push(msg); } };
  const result = await runBackgroundResearchJob({
    pi, runner, root: "/x", task: "explore auth", runId: "rf", label: "explore auth",
    model: "openai-codex/gpt-5.5-limited",
    defaultModel: "anthropic/claude-opus-4-8",
  });
  assert.equal(result.ok, true, "rate limit → falls back to the default model instead of failing");
  assert.equal(result.fallback_from, "openai-codex/gpt-5.5-limited");
  assert.deepEqual(
    spawned.map((p) => p.model),
    ["openai-codex/gpt-5.5-limited", "anthropic/claude-opus-4-8"],
    "retried on the default model",
  );
  assert.equal(spawned[1].id, "rf-fallback", "the fallback run gets its own id");
  assert.ok(wakes[0].content.includes("found via default"), "findings from the fallback model delivered");
  assert.ok(
    /rate-limited/.test(wakes[0].content) && /default model anthropic\/claude-opus-4-8/.test(wakes[0].content),
    "wake notes the reroute",
  );
}

// --- a NON-transient failure does NOT fall back (only rate-limit/transient reroutes) ---
{
  const spawned = [];
  const runner = { spawn: async (params) => { spawned.push(params); throw new Error("TypeError: boom"); } };
  const wakes = [];
  const pi = { sendMessage: async (msg) => { wakes.push(msg); } };
  const result = await runBackgroundResearchJob({
    pi, runner, root: "/x", task: "t", runId: "rn", model: "openai-codex/gpt-5.5", defaultModel: "anthropic/claude-opus-4-8",
  });
  assert.equal(result.ok, false, "a non-transient error is not retried on the default model");
  assert.equal(spawned.length, 1, "no fallback spawn for a non-transient error");
  assert.ok(wakes[0].content.includes("failed"));
}

// --- resolveResearchRoles against the real templates: researcher binds to research-heavy (NOT the orchestrator
//     model); default same-model adversarial-heavy -> review skipped with actionable guidance ---
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-research-roles-"));
  try {
    await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: tmp });
    const roles = await resolveResearchRoles({
      root: tmp,
      ctx: { model: { provider: "anthropic", id: "claude-fable-5" } }, // orchestrator runs fable-5
      env: {},
    });
    assert.equal(roles.researcher.model, "anthropic/claude-opus-4-8", "researcher uses research-heavy, independent of the orchestrator model");
    assert.equal(roles.researcher.thinking, "high", "research-heavy thinking (effort high) resolves");
    assert.equal(roles.reviewer, null, "default templates bind every class to one model -> review skipped");
    assert.ok(roles.notes.some((n) => n.includes("adversarial-heavy")), "note tells the operator how to enable review");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// --- resolveResearchRoles with no installed catalog: falls back to the host model, review skipped, never throws ---
{
  const roles = await resolveResearchRoles({
    root: path.join(os.tmpdir(), "aipi-no-such-project-xyz"),
    ctx: { model: "anthropic/claude-opus-4-8" },
    env: {},
  });
  assert.equal(roles.researcher.model, "anthropic/claude-opus-4-8", "host model is the researcher fallback");
  assert.equal(roles.reviewer, null, "no catalog -> review skipped");
  assert.ok(roles.notes.some((n) => n.includes("unavailable")), "fallback is noted, not silent");
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

  // /proj has no installed catalog -> researcher falls back to the host model, review skipped (single spawn/task).
  const ok = await call({ tasks: ["explore a", "explore b"] }, { model: "anthropic/claude-opus-4-8" });
  assert.equal(ok.ok, true);
  assert.equal(ok.dispatched, 2, "returns immediately with the dispatched count");
  assert.equal(ok.runs.length, 2);
  assert.ok(ok.runs[0].run_id.startsWith("research-"));
  assert.equal(ok.researcher.model, "anthropic/claude-opus-4-8", "reports who researches");
  assert.equal(ok.reviewer, null, "no catalog -> no reviewer");

  const many = Array.from({ length: MAX_BACKGROUND_RESEARCH + 3 }, (_, i) => `task ${i}`);
  const capped = await call({ tasks: many }, { model: "anthropic/claude-opus-4-8" });
  assert.equal(capped.dispatched, MAX_BACKGROUND_RESEARCH, "caps concurrent workers");
  assert.equal(capped.not_dispatched, 3, "reports the overflow — never a silent cap");

  // Let the fire-and-forget jobs settle so they don't leak past the test.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(spawned.length >= 2, "background jobs actually spawned");
}

console.log("AIPI_BACKGROUND_RESEARCH_TEST_OK");
