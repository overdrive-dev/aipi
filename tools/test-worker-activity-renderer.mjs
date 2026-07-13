// Verifies the titled-card renderer for aipi-worker-activity messages: feature-detection, and that the
// card header is `agent · model` with the action as the body (replacing Pi's default label box).

import assert from "node:assert/strict";
import {
  registerWorkerActivityRenderer,
  buildWorkerActivityCard,
  WORKER_ACTIVITY_CUSTOM_TYPE,
} from "../extensions/aipi/runtime/aipi-worker-activity-renderer.js";

// Fake pi-tui components + theme so the card builder is exercised without a live terminal.
class FakeText {
  constructor(text) { this.text = text; }
}
class FakeBox {
  constructor(...args) { this.args = args; this.children = []; }
  addChild(child) { this.children.push(child); }
}
const fakeTheme = {
  fg: (key, text) => `<${key}>${text}`,
  bg: (_key, text) => text,
};
const components = { Box: FakeBox, Text: FakeText };

// --- feature detection: no-op on a plain host, registers on a rich host ---
{
  assert.equal(registerWorkerActivityRenderer(undefined), false, "no pi → false");
  assert.equal(registerWorkerActivityRenderer({}), false, "host without registerMessageRenderer → false");

  let captured = null;
  const richPi = { registerMessageRenderer: (type, fn) => { captured = { type, fn }; } };
  assert.equal(registerWorkerActivityRenderer(richPi, { components }), true, "rich host → registers, returns true");
  assert.equal(captured.type, WORKER_ACTIVITY_CUSTOM_TYPE, "registers for the aipi-worker-activity custom type");
  // The registered renderer builds a card from the message details.
  const comp = captured.fn(
    { details: { agent: "reviewer", model: "xai-auth/grok-4.5", glyph: "🔧", detail: "grep scrollTo" } },
    { expanded: false },
    fakeTheme,
  );
  assert.equal(comp.children.length, 2, "card has a header line and a body line");
}

// --- titled card: header = agent · model (accent + dim), body = glyph + action ---
{
  const card = buildWorkerActivityCard(
    { details: { agent: "reviewer", model: "xai-auth/grok-4.5", glyph: "🔧", detail: "grep scrollTo" } },
    fakeTheme,
    components,
  );
  const [header, body] = card.children.map((c) => c.text);
  assert.match(header, /<accent>reviewer/, "agent is the accent-colored title");
  assert.match(header, /<dim> · xai-auth\/grok-4\.5/, "model is the dim subtitle after a separator");
  assert.match(body, /🔧/, "body leads with the action glyph");
  assert.match(body, /<customMessageText>grep scrollTo/, "body carries the action detail");
  // The box is styled with the host's customMessageBg (stays consistent with Pi's custom messages).
  assert.equal(typeof card.args[2], "function", "box takes a background styler");
}

// --- degrades gracefully: no details → header falls back to a generic agent, body uses plain content ---
{
  const card = buildWorkerActivityCard({ content: "some plain activity text" }, fakeTheme, components);
  const [header, body] = card.children.map((c) => c.text);
  assert.match(header, /<accent>worker/, "missing agent falls back to 'worker'");
  assert.match(body, /some plain activity text/, "body falls back to the plain content text");
}

// --- no model → header is just the agent (no dangling separator) ---
{
  const card = buildWorkerActivityCard(
    { details: { agent: "planner", glyph: "💬", detail: "planning" } },
    fakeTheme,
    components,
  );
  const header = card.children[0].text;
  assert.match(header, /<accent>planner/, "agent shown");
  assert.doesNotMatch(header, /·/, "no separator when there is no model");
}

console.log("worker-activity-renderer: ok");
