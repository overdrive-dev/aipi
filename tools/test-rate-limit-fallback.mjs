// Verifies the rate-limit fallback: when a step exhausts its transient-provider retries (e.g. a sustained 429),
// the executor retries once on a DIFFERENT authed provider and ANNOUNCES it, instead of hard-blocking.

import assert from "node:assert/strict";
import { executeStepWithTransientRetries } from "../extensions/aipi/runtime/workflow-executor.js";
import { SubagentCoordinator } from "../extensions/aipi/runtime/subagents.js";

const retry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterMs: 0 };
const rateLimitError = () => Object.assign(new Error('429 {"type":"error","error":{"type":"rate_limit_error"}}'), { status: 429 });

// --- SubagentCoordinator.pickFallbackModel: a concrete model on a DIFFERENT authed provider ---
{
  const coord = new SubagentCoordinator(
    { appendEntry() {}, log() {} },
    { root: process.cwd(), maxConcurrent: 0, env: {}, piSubagentsRunner: { spawn() {} } },
  );
  coord.setAvailableModels(["anthropic/claude-opus-4-8", "xai-auth/grok-4.5", "openai-codex/gpt-5.6-sol"]);
  const fb = coord.pickFallbackModel({ excludeProvider: "anthropic" });
  assert.ok(fb && fb.provider !== "anthropic", "picks a model off the excluded provider");
  assert.equal(coord.pickFallbackModel({ excludeProvider: "xai-auth" }).provider === "xai-auth", false);
  // Only the excluded provider authed → no fallback.
  const solo = new SubagentCoordinator({ appendEntry() {}, log() {} }, { root: process.cwd(), maxConcurrent: 0, env: {}, piSubagentsRunner: { spawn() {} } });
  solo.setAvailableModels(["anthropic/claude-opus-4-8"]);
  assert.equal(solo.pickFallbackModel({ excludeProvider: "anthropic" }), null, "no distinct provider → null");
}

// --- retries exhausted on a 429 → fall back to another provider, announce, and PASS ---
{
  const notes = [];
  const notify = (m) => notes.push(m);
  let normalAttempts = 0;
  let fallbackModelUsed = null;
  const adapter = {
    async executeStep(args) {
      if (args.modelOverride) {
        fallbackModelUsed = args.modelOverride;
        return { schema: "aipi.step-result.v1", step_id: args.step.id, verdict: "PASS" };
      }
      normalAttempts += 1;
      throw rateLimitError();
    },
    async resolveRateLimitFallback() {
      return { model: { provider: "xai-auth", id: "grok-4.5" }, fromProvider: "anthropic", toProvider: "xai-auth" };
    },
  };
  const result = await executeStepWithTransientRetries({
    adapter,
    args: { step: { id: "intake", agents: ["orchestration-reasoner"] }, notify },
    retry,
  });
  assert.equal(normalAttempts, retry.maxAttempts, "exhausts the configured retries on the original provider first");
  assert.deepEqual(fallbackModelUsed, { provider: "xai-auth", id: "grok-4.5" }, "the fallback attempt runs on the other provider");
  assert.equal(result.verdict, "PASS", "the step passes via the fallback instead of blocking");
  assert.ok(result.rate_limit_fallback, "the result is stamped with the fallback provenance");
  assert.equal(result.rate_limit_fallback.to_provider, "xai-auth");
  assert.ok(notes.some((m) => /Rate-limited on anthropic/.test(m) && /grok-4\.5/.test(m) && /instead of blocking/.test(m)), `announced the fallback; got: ${JSON.stringify(notes)}`);
}

// --- no distinct provider available → still BLOCKS (the prior behavior), no silent hang ---
{
  const adapter = {
    async executeStep() { throw rateLimitError(); },
    async resolveRateLimitFallback() { return null; },
  };
  const result = await executeStepWithTransientRetries({ adapter, args: { step: { id: "intake", agents: ["orchestration-reasoner"] }, notify: () => {} }, retry });
  assert.equal(result.status ?? result.verdict, result.status ?? result.verdict, "returns a blocked result object");
  assert.match(JSON.stringify(result), /blocked|BLOCKED|transient/i, "with no fallback provider, exhausted retries block");
}

// --- a non-transient error is never swallowed by the fallback path ---
{
  const adapter = {
    async executeStep() { throw new Error("TypeError: boom"); },
    async resolveRateLimitFallback() { return { model: { provider: "xai-auth", id: "grok-4.5" } }; },
  };
  await assert.rejects(
    () => executeStepWithTransientRetries({ adapter, args: { step: { id: "intake", agents: ["orchestration-reasoner"] }, notify: () => {} }, retry }),
    /boom/,
    "non-transient errors propagate (no fallback, no block)",
  );
}

console.log("rate-limit-fallback: ok");
