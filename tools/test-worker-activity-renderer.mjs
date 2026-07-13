// Verifies the titled-card renderer for aipi-worker-activity messages: feature-detection, and that the
// card header is `agent · model` with the action as the body (replacing Pi's default label box).

import assert from "node:assert/strict";
import {
  registerWorkerActivityRenderer,
  buildWorkerActivityCard,
  WORKER_ACTIVITY_CUSTOM_TYPE,
} from "../extensions/aipi/runtime/aipi-worker-activity-renderer.js";

// Fake pi-tui Text + theme so the clean line builder is exercised without a live terminal.
class FakeText {
  constructor(text, x = 0, y = 0) { this.text = text; this.x = x; this.y = y; }
}
const fakeTheme = {
  fg: (key, text) => `<${key}>${text}`,
  bg: (_key, text) => text,
};
const components = { Text: FakeText };

// --- feature detection: no-op on a plain host, registers on a rich host ---
{
  assert.equal(registerWorkerActivityRenderer(undefined), false, "no pi → false");
  assert.equal(registerWorkerActivityRenderer({}), false, "host without registerMessageRenderer → false");

  let captured = null;
  const richPi = { registerMessageRenderer: (type, fn) => { captured = { type, fn }; } };
  assert.equal(registerWorkerActivityRenderer(richPi, { components }), true, "rich host → registers, returns true");
  assert.equal(captured.type, WORKER_ACTIVITY_CUSTOM_TYPE, "registers for the aipi-worker-activity custom type");
  // The registered renderer builds a clean line from the message details.
  const comp = captured.fn(
    { details: { agent: "reviewer", model: "xai-auth/grok-4.5", glyph: "🔧", detail: "grep scrollTo" } },
    { expanded: false },
    fakeTheme,
  );
  assert.equal(typeof comp.text, "string", "renderer returns a Text component");
}

// --- clean line: ▸ marker + agent·model (accent+dim) + glyph + action (muted), NO purple background box ---
{
  const line = buildWorkerActivityCard(
    { details: { agent: "reviewer", model: "xai-auth/grok-4.5", glyph: "🔧", detail: "grep scrollTo" } },
    fakeTheme,
    components,
  ).text;
  assert.match(line, /<dim>▸/, "leads with a dim marker");
  assert.match(line, /<accent>reviewer/, "agent is accent-colored");
  assert.match(line, /<dim> · xai-auth\/grok-4\.5/, "model is a dim suffix after a separator");
  assert.match(line, /🔧/, "shows the action glyph");
  assert.match(line, /<muted>grep scrollTo/, "action detail is muted");
  assert.doesNotMatch(line, /customMessageBg/, "NO heavy purple custom-message background box");
}

// --- degrades gracefully: no details → generic agent + plain content ---
{
  const line = buildWorkerActivityCard({ content: "some plain activity text" }, fakeTheme, components).text;
  assert.match(line, /<accent>worker/, "missing agent falls back to 'worker'");
  assert.match(line, /some plain activity text/, "falls back to the plain content text");
}

// --- no model → just the agent (no dangling separator) ---
{
  const line = buildWorkerActivityCard(
    { details: { agent: "planner", glyph: "💬", detail: "planning" } },
    fakeTheme,
    components,
  ).text;
  assert.match(line, /<accent>planner/, "agent shown");
  assert.doesNotMatch(line, / · /, "no separator when there is no model");
}

console.log("worker-activity-renderer: ok");
