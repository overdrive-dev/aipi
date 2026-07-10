import { readActivePlan } from "./plan-state.js";

// A read-only TUI widget that keeps the ACTIVE AIPI plan visible above the editor, so the plan the system is
// working from is always on screen — not a one-shot notify toast that scrolls away. It PULLS the active plan
// (via readActivePlan) instead of being pushed to, so it reflects a plan created either by /aipi-plan OR by
// the aipi_start_plan tool (whose reduced tool ctx cannot call setWidget). Mounted at session_start, then
// refreshed on turn_end (catches tool/executor-driven changes) and at the end of the /aipi-plan command
// (catches command-driven changes immediately). Terminal-only: guarded on ctx.mode === "tui" so headless /
// RPC / print modes are left untouched.

const PLAN_WIDGET_KEY = "aipi-plan";

const TASK_GLYPH = Object.freeze({
  pending: "•",
  running: "▸",
  passed: "✓",
  skipped: "–",
  blocked: "!",
  failed: "✗",
});

// Pure render: the active-plan object ({ plan, planId } | null) -> the widget's string[] lines. Returns []
// when there is no active plan, which clears the widget. Kept pure so it is unit-testable without a TUI.
export function renderPlanWidgetLines(active) {
  const plan = active?.plan;
  if (!plan) return [];
  const tasks = plan.tasks ?? [];
  const openQuestions = (plan.questions ?? []).filter((question) => !isAnswered(question));
  const done = tasks.filter((task) => task.status === "passed" || task.status === "skipped").length;

  const lines = [
    `AIPI plan ${plan.plan_id} · ${plan.status} · ${done}/${tasks.length} done · ${plan.execution_cadence}`,
  ];
  for (const task of tasks) {
    const glyph = TASK_GLYPH[task.status] ?? "•";
    lines.push(`  ${glyph} ${task.task_id} [${task.workflow}] ${task.text}`);
  }
  if (openQuestions.length) {
    lines.push(`  ? ${openQuestions.length} open question(s) — answer to settle`);
  } else if (plan.status === "settled") {
    lines.push("  ✓ settled — ready to execute");
  }
  return lines;
}

// setWidget is terminal-only; guard so RPC/JSON/print modes (where ctx.ui has no widget surface) are no-ops.
function widgetCapable(ctx) {
  return ctx?.mode === "tui" && typeof ctx?.ui?.setWidget === "function";
}

// Recompute the widget from the current active plan and push it. undefined content clears the widget when no
// plan is active. Never throws: a widget refresh must not be able to break a turn.
export async function refreshPlanWidget(ctx, projectRoot) {
  if (!widgetCapable(ctx)) return;
  try {
    const active = await readActivePlan(projectRoot);
    const lines = renderPlanWidgetLines(active);
    ctx.ui.setWidget(PLAN_WIDGET_KEY, lines.length ? lines : undefined);
  } catch {
    // Leave the last snapshot in place on a transient read error.
  }
}

// Mount the widget at session_start and keep it live on turn_end. The /aipi-plan command calls
// refreshPlanWidget directly for immediate feedback (a slash command does not emit turn_end).
export function registerPlanWidget(pi, { projectRootResolver = () => process.cwd() } = {}) {
  const refresh = async (_event, ctx) => {
    await refreshPlanWidget(ctx, projectRootResolver(ctx));
  };
  pi.on("session_start", refresh);
  pi.on("turn_start", refresh);
  pi.on("turn_end", refresh);
  // Refresh on every tool boundary so the widget tracks task progress live during execution instead of only
  // updating at turn_end (which made it look frozen at "0/N done" while a plan runs).
  pi.on("tool_execution_end", refresh);
}

function isAnswered(question) {
  return typeof question?.answer === "string" && question.answer.trim().length > 0;
}
