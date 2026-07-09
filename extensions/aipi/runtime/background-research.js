import { createAipiSubagentsRunner, extractToolText, modelToPiModelId } from "./pi-subagents.js";

// Background research fan-out. Dispatch READ-ONLY workers (no shell, artifacts-only, never merge) that run
// async and, on completion, WAKE the orchestrator via pi.sendMessage({ triggerTurn: true }) with their
// findings — the same native wake primitive the vendored notify path uses.
//
// Why this is safe for verify == ship: these workers produce INFORMATION, not ship candidates. A
// foreground-gated step always sits between their findings and any merge, so a wrong finding can only inform
// a gated step, never ship. Workers that WRITE/merge the project (write_scope "project") are NOT eligible and
// stay foreground in the coordinator. Because each job goes through the runner, it also writes the native
// status.json and shows up live in /aipi-subagents while it runs.
//
// "Background" here is IN-PROCESS: the child pi worker runs synchronously (runSync), but WE fire the job
// without awaiting it, so the orchestrator turn returns immediately and the job wakes it later.

const DEFAULT_MAX_TOOL_CALLS = 30;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
// A hard cap on concurrent forked workers per call — each task is a full forked pi process.
export const MAX_BACKGROUND_RESEARCH = 6;

// Run ONE background research worker to completion, then wake the orchestrator with its result. NEVER rejects:
// a failure also wakes the orchestrator (with the error) so a dropped worker can't silently strand the turn.
export async function runBackgroundResearchJob({
  pi,
  runner,
  root,
  task,
  runId,
  label,
  model,
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const spawnRunner = runner ?? createAipiSubagentsRunner({ root });
  const displayLabel = label || runId;
  try {
    const raw = await spawnRunner.spawn(
      {
        agent: "aipi-worker",
        task,
        async: false, // the CHILD runs synchronously; the JOB is backgrounded by not awaiting this call
        context: "fresh",
        model,
        allow_shell: false, // read-only: no shell
        write_scope: "artifacts", // never merges to the project
        max_tool_calls: maxToolCalls,
        id: runId,
      },
      { signal: timeoutSignal(timeoutMs) },
    );
    const findings = extractToolText(raw).trim() || "(no output)";
    await wakeOrchestrator(pi, `Background research **${displayLabel}** finished:\n\n${findings}`);
    return { runId, ok: true, findings };
  } catch (error) {
    const message = String(error?.message ?? error);
    await wakeOrchestrator(pi, `Background research **${displayLabel}** failed: ${message}`);
    return { runId, ok: false, error: message };
  }
}

// The native wake: inject the finding as a message AND trigger a turn so an idle orchestrator picks it up.
async function wakeOrchestrator(pi, content) {
  try {
    await pi.sendMessage(
      { customType: "aipi-background-research", content, display: true },
      { triggerTurn: true },
    );
  } catch {
    // If the wake channel is unavailable the run is still recorded via the runner's status.json (/aipi-subagents).
  }
}

// Register the model-callable tool. The orchestrator calls it to fan out read-only research; it returns
// IMMEDIATELY with the dispatched run ids, and each worker wakes the orchestrator when it finishes.
export function registerBackgroundResearchTool(pi, { projectRootResolver = () => process.cwd(), runnerFactory = null } = {}) {
  pi.registerTool({
    name: "aipi_background_research",
    description:
      "Fan out READ-ONLY research/exploration tasks (understand code, find where X lives, investigate an area) to background workers. Returns immediately; each worker wakes you with its findings when done, so you can keep working meanwhile. Use ONLY for read/investigate work — these workers cannot write, run shell, or merge. For code you will SHIP, use a normal foreground step so the verify gate runs.",
    promptSnippet: "aipi_background_research - fan out read-only research tasks to background workers that wake you with findings.",
    promptGuidelines: [
      "When you have several INDEPENDENT read-only questions to investigate (e.g. explore N modules, locate N call sites), call aipi_background_research with one task per question — the workers run in parallel and wake you with findings instead of blocking you.",
      "Do NOT use aipi_background_research for anything that writes or ships code; that must run foreground so the evidence gate applies. Treat returned findings as INPUT to a foreground-gated step, not as a verified result.",
    ],
    parameters: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Independent read-only research tasks — one focused investigation per item.",
        },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const root = projectRootResolver(ctx);
        const model = modelToPiModelId(ctx?.model);
        if (!model) return toolJson({ ok: false, error: "no host model available to dispatch background research" });
        const tasks = normalizeTasks(params?.tasks);
        if (!tasks.length) return toolJson({ ok: false, error: "aipi_background_research needs at least one task" });

        const runner = runnerFactory ? runnerFactory({ root }) : createAipiSubagentsRunner({ root });
        const accepted = tasks.slice(0, MAX_BACKGROUND_RESEARCH);
        const dropped = tasks.slice(MAX_BACKGROUND_RESEARCH);
        const runs = accepted.map((task, index) => {
          const label = truncateLabel(task);
          // A task-derived id so the /aipi-subagents widget shows readable labels (not an opaque timestamp).
          const runId = `research-${slugify(task)}-${index + 1}`;
          // Fire-and-forget: the tool returns now; the job wakes the orchestrator on completion.
          void runBackgroundResearchJob({ pi, runner, root, task, runId, label, model });
          return { run_id: runId, task: label };
        });
        return toolJson({
          ok: true,
          dispatched: runs.length,
          runs,
          // Never a silent cap: report the overflow so the model can call again for the rest.
          ...(dropped.length
            ? { not_dispatched: dropped.length, cap_note: `Over the ${MAX_BACKGROUND_RESEARCH}-task limit; call again for the remaining ${dropped.length}.` }
            : {}),
          note: "Running in the background. Each worker wakes you with its findings when it finishes; watch them in /aipi-subagents.",
        });
      } catch (error) {
        return toolJson({ ok: false, error: String(error?.message ?? error) });
      }
    },
  });
}

function normalizeTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : tasks != null ? [tasks] : [];
  return list.map((task) => String(task ?? "").trim()).filter(Boolean);
}

function truncateLabel(task) {
  const oneLine = String(task ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

function slugify(task) {
  return String(task ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

function timeoutSignal(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  try {
    return AbortSignal.timeout(n);
  } catch {
    return undefined;
  }
}

function toolJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
