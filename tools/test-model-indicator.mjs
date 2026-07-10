import assert from "node:assert/strict";
import { refreshModelIndicator, renderModelIndicator, registerModelIndicator } from "../extensions/aipi/runtime/model-indicator.js";

// --- pure render: no model -> null (clears the chip) ---
assert.equal(renderModelIndicator(null, "high"), null);
assert.equal(renderModelIndicator(undefined, null), null);

// --- pure render: model + thinking ---
const both = renderModelIndicator("anthropic/claude-fable-5", "high");
assert.ok(both.status.includes("anthropic/claude-fable-5") && both.status.includes("high"), both.status);
assert.equal(both.working, "claude-fable-5 · high", "working row uses the short id + thinking");

// --- pure render: model only (thinking unavailable) still shows the model ---
const modelOnly = renderModelIndicator("xai-auth/grok-4.5", null);
assert.ok(modelOnly.status.includes("xai-auth/grok-4.5"), modelOnly.status);
assert.equal(modelOnly.working, "grok-4.5", "no thinking -> just the short id");

// --- refreshModelIndicator: pushes to BOTH the footer chip and the working row in TUI mode ---
const calls = { status: [], working: [] };
const tuiCtx = {
  mode: "tui",
  model: { provider: "anthropic", id: "claude-fable-5" },
  getThinkingLevel: () => "high",
  ui: {
    setStatus: (key, text) => calls.status.push({ key, text }),
    setWorkingMessage: (message) => calls.working.push(message),
  },
};
refreshModelIndicator(tuiCtx);
assert.equal(calls.status.length, 1, "TUI mode pushes the footer chip");
assert.equal(calls.status[0].key, "aipi-model");
assert.ok(calls.status[0].text.includes("claude-fable-5") && calls.status[0].text.includes("high"));
assert.deepEqual(calls.working, ["claude-fable-5 · high"], "working row set to model + thinking");

// --- no model resolved -> clears the chip (undefined) ---
const cleared = [];
refreshModelIndicator({ mode: "tui", model: undefined, ui: { setStatus: (k, t) => cleared.push(t), setWorkingMessage: () => {} } });
assert.deepEqual(cleared, [undefined], "no model clears the footer chip");

// --- thinking probe is best-effort: a throwing getThinkingLevel still shows the model ---
const resilient = [];
refreshModelIndicator({
  mode: "tui",
  model: { provider: "openai-codex", id: "gpt-5.6" },
  getThinkingLevel: () => { throw new Error("unavailable"); },
  ui: { setStatus: (_k, t) => resilient.push(t), setWorkingMessage: () => {} },
});
assert.ok(resilient[0].includes("openai-codex/gpt-5.6"), resilient[0]);
assert.ok(!resilient[0].includes("·"), "no thinking segment when the probe throws");

// --- non-TUI mode (headless / RPC / json / print) is a no-op ---
const headless = [];
refreshModelIndicator({ mode: "json", model: { provider: "anthropic", id: "x" }, ui: { setStatus: (k, t) => headless.push({ k, t }) } });
assert.equal(headless.length, 0, "non-TUI mode does not touch the footer");

// --- registerModelIndicator subscribes to the model-visibility events, restores working at turn_end ---
const handlers = new Map();
const pi = { on: (event, handler) => handlers.set(event, handler) };
registerModelIndicator(pi);
for (const event of ["session_start", "turn_start", "tool_execution_start", "model_select", "turn_end"]) {
  assert.ok(handlers.has(event), `subscribes to ${event}`);
}
const restore = [];
handlers.get("turn_end")({}, { mode: "tui", ui: { setStatus: () => {}, setWorkingMessage: (m) => restore.push(m) } });
assert.deepEqual(restore, [undefined], "turn_end restores Pi's default working message");

console.log("AIPI_MODEL_INDICATOR_TEST_OK");
