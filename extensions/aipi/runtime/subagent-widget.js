import { loadSubagentView, projectSubagentsRuntimePaths } from "./pi-subagents.js";

// Inline TUI widget: a live, always-visible list of ACTIVE subagent runs pinned above the editor (the
// grok-build style), so background workers are visible without opening a modal. Complements /aipi-subagents
// (the navigable drill-in overlay) — this is the at-a-glance summary. PULLS the runs from the native run-store
// (loadSubagentRuns over our status.json bridge), so it reflects any worker regardless of who spawned it.
// Terminal-only (ctx.mode === "tui"); hides when nothing is active.

const SUBAGENT_WIDGET_KEY = "aipi-subagents";
const MAX_ROWS = 8;

const STATE_GLYPH = Object.freeze({
  running: "▸",
  queued: "◦",
  complete: "✓",
  failed: "✗",
  paused: "■",
});

// Load the vendored data function once and reuse it (jiti re-evaluates the module per call otherwise).
let cachedLoad = null;
function getLoadSubagentRuns() {
  if (!cachedLoad) cachedLoad = loadSubagentView().loadSubagentRuns;
  return cachedLoad;
}

// Pure: AsyncRunSummary[] -> string[] for the widget. Shows only ACTIVE runs (running/queued); returns []
// when nothing is active, which clears the widget. Kept pure so it is unit-testable without a TUI.
export function renderSubagentWidgetLines(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const active = list.filter((run) => run.state === "running" || run.state === "queued");
  if (!active.length) return [];

  const lines = [`AIPI subagents · ${active.length} running`];
  for (const run of active.slice(0, MAX_ROWS)) {
    const glyph = STATE_GLYPH[run.state] ?? "▸";
    lines.push(`  ${glyph} ${shorten(runLabel(run), 60)}`);
  }
  if (active.length > MAX_ROWS) lines.push(`  … +${active.length - MAX_ROWS} more`);
  return lines;
}

function runLabel(run) {
  const model = run.steps?.[0]?.model;
  const suffix = model ? ` · ${String(model).split("/").pop()}` : "";
  return `${run.id}${suffix}`;
}

function shorten(text, max) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function widgetCapable(ctx) {
  return ctx?.mode === "tui" && typeof ctx?.ui?.setWidget === "function";
}

// Recompute from the live run-store and push. undefined clears the widget when nothing is active. Never throws.
export async function refreshSubagentWidget(ctx, projectRoot) {
  if (!widgetCapable(ctx)) return;
  try {
    const paths = projectSubagentsRuntimePaths(projectRoot);
    const runs = getLoadSubagentRuns()(paths.asyncDir, paths.resultsDir);
    const lines = renderSubagentWidgetLines(runs);
    ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, lines.length ? lines : undefined);
  } catch {
    // Leave the last snapshot on a transient read error.
  }
}

// Refresh on the events that bracket subagent activity: session_start (mount), turn_start/turn_end (a
// background worker's completion triggers a turn), and tool_execution_end (a fan-out dispatch just started
// workers). No detached timer — every refresh happens inside a real event handler with a live ctx.
export function registerSubagentWidget(pi, { projectRootResolver = () => process.cwd() } = {}) {
  const refresh = async (_event, ctx) => {
    await refreshSubagentWidget(ctx, projectRootResolver(ctx));
  };
  pi.on("session_start", refresh);
  pi.on("turn_start", refresh);
  pi.on("turn_end", refresh);
  pi.on("tool_execution_end", refresh);
}
