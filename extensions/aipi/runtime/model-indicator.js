import { modelToPiModelId } from "./pi-subagents.js";

// Foreground model indicator. The write / edit / read tool-call boxes are rendered by Pi core and CANNOT be
// decorated by an extension — the `tool_call` event only allows block/mutate of the call, not a re-render of
// its box (ToolCallEventResult = { block, reason }). So we surface the CURRENT SESSION model + intelligence
// (thinking level) on the two foreground surfaces an extension CAN write: the footer status chip
// (ctx.ui.setStatus — always visible) and the streaming "Working…" row (ctx.ui.setWorkingMessage — shown
// directly under the action boxes while it writes/edits). This answers "which model is doing this write?" for
// the main stream; background/parallel workers are covered by the /aipi-subagents widget. Terminal-only
// (ctx.mode === "tui"); headless / RPC / print are no-ops.

const STATUS_KEY = "aipi-model";

// Pure: (modelId, thinking) -> { status, working } | null. modelId is a "provider/id" string (or null when no
// model is resolved, which clears the chip). Kept pure so it is unit-testable without a TUI.
export function renderModelIndicator(modelId, thinking) {
  if (!modelId) return null;
  const shortId = String(modelId).split("/").pop();
  const think = thinking ? String(thinking) : null;
  return {
    // Footer chip: full provider/id so the family is unambiguous.
    status: think ? `⚙ ${modelId} · ${think}` : `⚙ ${modelId}`,
    // Working row: short id (the family is obvious from the chip) so it stays compact next to the spinner.
    working: think ? `${shortId} · ${think}` : shortId,
  };
}

function widgetCapable(ctx) {
  return ctx?.mode === "tui" && typeof ctx?.ui?.setStatus === "function";
}

// Best-effort thinking level: it is not declared on the plain event ctx (ExtensionContext), so probe
// defensively and fall back to just the model when it is unavailable — the model is the primary ask.
function currentThinking(ctx) {
  try {
    if (typeof ctx?.getThinkingLevel === "function") return ctx.getThinkingLevel();
  } catch {
    // ignore — thinking is a bonus, never a blocker.
  }
  return null;
}

// Recompute from ctx.model and push to the footer + the streaming working row. Never throws: a status refresh
// must not be able to break a turn.
export function refreshModelIndicator(ctx) {
  if (!widgetCapable(ctx)) return;
  try {
    const indicator = renderModelIndicator(modelToPiModelId(ctx.model), currentThinking(ctx));
    if (!indicator) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, indicator.status);
    if (typeof ctx.ui.setWorkingMessage === "function") ctx.ui.setWorkingMessage(indicator.working);
  } catch {
    // Leave the last chip in place on a transient error.
  }
}

// Restore Pi's default working message at turn_end (idle has no working row; the footer chip persists). Keeps
// the model on the streaming row only while actually streaming, so it never goes stale.
function restoreWorking(ctx) {
  if (!widgetCapable(ctx)) return;
  try {
    if (typeof ctx.ui.setWorkingMessage === "function") ctx.ui.setWorkingMessage();
  } catch {
    // ignore
  }
}

// Mount the chip at session_start and keep it live: turn_start / tool_execution_start (re-apply the working
// message in case Pi reset it), model_select (the user switched models via /model). turn_end restores the
// default working message.
export function registerModelIndicator(pi) {
  pi.on("session_start", (_event, ctx) => refreshModelIndicator(ctx));
  pi.on("turn_start", (_event, ctx) => refreshModelIndicator(ctx));
  pi.on("tool_execution_start", (_event, ctx) => refreshModelIndicator(ctx));
  pi.on("model_select", (_event, ctx) => refreshModelIndicator(ctx));
  pi.on("turn_end", (_event, ctx) => restoreWorking(ctx));
}
