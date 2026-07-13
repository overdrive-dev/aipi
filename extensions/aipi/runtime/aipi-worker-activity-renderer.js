// Custom TUI renderer for `aipi-worker-activity` messages — a TITLED CARD whose header is the worker
// `agent · model` and whose body is the action, replacing Pi's default `[aipi-worker-activity]` label box.
// Registered from index.js on interactive hosts (feature-detected); on plain/CLI hosts the message falls
// back to its plain `content` text.
//
// The pi-tui component classes are INJECTABLE (default: the real `@earendil-works/pi-tui`) so the card
// builder is unit-testable without a live terminal.

import * as piTui from "@earendil-works/pi-tui";

export const WORKER_ACTIVITY_CUSTOM_TYPE = "aipi-worker-activity";

// Register the renderer if the host supports it. Returns true when registered, false on a plain host.
export function registerWorkerActivityRenderer(pi, { components = piTui } = {}) {
  if (typeof pi?.registerMessageRenderer !== "function") return false;
  pi.registerMessageRenderer(WORKER_ACTIVITY_CUSTOM_TYPE, (message, _state, theme) =>
    buildWorkerActivityCard(message, theme, components),
  );
  return true;
}

// Build a clean, minimal "grok-build" activity line — matching the /aipi-subagents widget's look — INSTEAD of
// Pi's heavy purple `[aipi-worker-activity]` custom-message box:
//
//   ▸ <agent> · <model>   <glyph> <action>
//
// A dim leading marker, the agent in `accent` with a dim `· model` suffix, then the action glyph + the detail
// in `muted`. No background box: the purple `customMessageBg` is exactly what made the default look heavy, so
// the renderer returns a plain indented Text and lets the terminal breathe.
export function buildWorkerActivityCard(message, theme, { Text }) {
  const details = message?.details ?? {};
  const agent = String(details.agent ?? "worker").trim() || "worker";
  const model = details.model ? String(details.model).trim() : null;
  const glyph = details.glyph ? `${details.glyph} ` : "";
  const detail = String(details.detail ?? textOf(message?.content)).trim();
  const head = model
    ? `${theme.fg("accent", agent)}${theme.fg("dim", ` · ${model}`)}`
    : theme.fg("accent", agent);
  const body = detail ? `   ${glyph}${theme.fg("muted", detail)}` : "";
  return new Text(`${theme.fg("dim", "▸")} ${head}${body}`, 1, 0);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
  }
  return "";
}
