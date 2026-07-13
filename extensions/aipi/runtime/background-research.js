import { createAipiSubagentsRunner, extractToolText, modelToPiModelId } from "./pi-subagents.js";
import { resolveModelClass, resolveCrossModelAdversarialRoute } from "./model-router.js";

// Background research fan-out. Dispatch READ-ONLY workers (no shell, artifacts-only, never merge) that run
// async and, on completion, WAKE the orchestrator via pi.sendMessage({ triggerTurn: true }) with their
// findings — the same native wake primitive the vendored notify path uses.
//
// Researcher / reviewer roles (NOT the orchestrator's model): the researcher runs on the `research-heavy`
// model class and, before its findings ever reach the orchestrator, an adversarial reviewer on the
// `adversarial-heavy` class cross-checks them. This removes the "100% dependency on the orchestrator model"
// — WHO researches and WHO reviews (model + intelligence) are set in .aipi/model-capabilities.json (per-class
// bindings) + class_thinking + AIPI_MODEL_CLASS_* env, and the reviewer is chosen cross-family from the
// researcher when a distinct family is configured. Findings are delivered as CLAIMS with the review attached
// so the orchestrator never treats a raw finding as verified truth.
//
// Why this is safe for verify == ship: these workers produce INFORMATION, not ship candidates. A
// foreground-gated step always sits between their findings and any merge, so a wrong finding can only inform
// a gated step, never ship. Workers that WRITE/merge the project (write_scope "project") are NOT eligible and
// stay foreground in the coordinator. Because each job goes through the runner, it also writes the native
// status.json and shows up live in /aipi-subagents while it runs.
//
// "Background" here is IN-PROCESS: the child pi worker runs synchronously (runSync), but WE fire the job
// without awaiting it, so the orchestrator turn returns immediately and the job wakes it later.

// A read-only researcher/auditor greps and reads a lot; 30 was too tight and killed real audits mid-run
// ("maxToolCalls 30 (observed 31)"). 80 covers a thorough read-only sweep while the timeout still caps
// wall-clock. Override with AIPI_RESEARCH_MAX_TOOL_CALLS.
const DEFAULT_MAX_TOOL_CALLS = 80;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// Resolve the per-worker read-only tool-call budget: AIPI_RESEARCH_MAX_TOOL_CALLS (positive int) or the default.
export function researchMaxToolCalls(env = process.env) {
  const raw = Number(env?.AIPI_RESEARCH_MAX_TOOL_CALLS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TOOL_CALLS;
}
// A hard cap on concurrent forked workers per call — each task is a full forked pi process.
export const MAX_BACKGROUND_RESEARCH = 6;

// Resolve WHO researches and WHO reviews for this fan-out, once per call. The researcher binds to the
// `research-heavy` class; the reviewer binds to `adversarial-heavy`, chosen cross-family from the researcher
// when a distinct family is configured. Never throws — a project without an installed model-class catalog
// falls back to the host model as researcher and skips review (with a note), so dispatch is never blocked.
export async function resolveResearchRoles({ root, ctx, env = process.env } = {}) {
  const notes = [];
  const hostModel = modelToPiModelId(ctx?.model);
  try {
    const researchRoute = await resolveModelClass({ root, modelClass: "research-heavy", ctx, env });
    const researcherModel = modelToPiModelId(researchRoute.model) ?? hostModel;
    const researcher = { model: researcherModel, thinking: researchRoute.thinking_level ?? null };
    if (!researcherModel) return { researcher, reviewer: null, notes };

    if (!reviewEnabled(env)) {
      notes.push("adversarial review disabled via AIPI_RESEARCH_REVIEW; findings are unverified");
      return { researcher, reviewer: null, notes };
    }

    const advRoute = await resolveModelClass({ root, modelClass: "adversarial-heavy", ctx, env });
    const advThinking = advRoute.thinking_level ?? null;
    const crossRoute = await resolveCrossModelAdversarialRoute({
      root,
      role: "research-reviewer",
      modelClass: "adversarial-heavy",
      implementerModel: researcherModel,
      preferredRoute: advRoute,
      ctx,
      env,
    });
    const reviewerModel = !crossRoute.blocked && crossRoute.model_id
      ? crossRoute.model_id
      : (modelToPiModelId(advRoute.model) ?? null);
    const crossFamily = Boolean(!crossRoute.blocked && crossRoute.distinct_provider);

    // A same-model "review" by the identical model is a poor adversary and just doubles cost — skip it and
    // tell the operator exactly how to enable a real second opinion. Any distinct model (ideally cross-family)
    // runs the review.
    if (!reviewerModel || reviewerModel === researcherModel) {
      notes.push(
        "adversarial reviewer skipped: `adversarial-heavy` resolves to the same model as `research-heavy` — " +
          "bind them to different models (ideally different families) in .aipi/model-capabilities.json to enable review",
      );
      return { researcher, reviewer: null, notes };
    }
    if (!crossFamily) {
      notes.push("adversarial reviewer is a different model but the SAME family as the researcher — configure a distinct family for stronger independence");
    }
    return { researcher, reviewer: { model: reviewerModel, thinking: advThinking, crossFamily }, notes };
  } catch (error) {
    notes.push(`model-class resolution unavailable (${String(error?.message ?? error)}); research runs on the host model, review skipped`);
    return { researcher: { model: hostModel, thinking: null }, reviewer: null, notes };
  }
}

function reviewEnabled(env) {
  const value = String(env?.AIPI_RESEARCH_REVIEW ?? "").trim().toLowerCase();
  return value !== "off" && value !== "false" && value !== "0" && value !== "no";
}

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
  thinking = null,
  reviewer = null,
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
        thinking_level: thinking ?? undefined,
        allow_shell: false, // read-only: no shell
        write_scope: "artifacts", // never merges to the project
        max_tool_calls: maxToolCalls,
        id: runId,
      },
      { signal: timeoutSignal(timeoutMs) },
    );
    const findings = extractToolText(raw).trim() || "(no output)";

    // Adversarial review BEFORE the orchestrator sees the findings: a distinct (ideally cross-family) model
    // verifies the claims against the real code, so a wrong finding is caught here instead of being trusted.
    let review = null;
    if (reviewer?.model) {
      review = await runResearchReview({
        runner: spawnRunner,
        task,
        findings,
        researcherModel: model,
        reviewer,
        reviewRunId: `${runId}-review`,
        maxToolCalls,
        timeoutMs,
      });
    }

    await wakeOrchestrator(pi, formatResearchWake({ displayLabel, model, thinking, findings, reviewer, review }));
    return { runId, ok: true, findings, review };
  } catch (error) {
    const message = String(error?.message ?? error);
    await wakeOrchestrator(pi, `Background research **${displayLabel}** failed: ${message}`);
    return { runId, ok: false, error: message };
  }
}

// Run ONE adversarial reviewer over a researcher's findings. Read-only, fresh context, distinct model. Never
// rejects: a review failure is reported (findings then go up UNVERIFIED) rather than stranding the job.
async function runResearchReview({ runner, task, findings, researcherModel, reviewer, reviewRunId, maxToolCalls, timeoutMs }) {
  try {
    const raw = await runner.spawn(
      {
        agent: "aipi-worker",
        task: buildReviewPrompt({ task, findings, researcherModel }),
        async: false,
        context: "fresh",
        model: reviewer.model,
        thinking_level: reviewer.thinking ?? undefined,
        allow_shell: false,
        write_scope: "artifacts",
        max_tool_calls: maxToolCalls,
        id: reviewRunId,
      },
      { signal: timeoutSignal(timeoutMs) },
    );
    return { ok: true, text: extractToolText(raw).trim() || "(no review output)" };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// The adversarial-critique prompt: verify the researcher's claims against the actual code, do not trust them.
function buildReviewPrompt({ task, findings, researcherModel }) {
  return [
    "You are an ADVERSARIAL reviewer of a background research finding. Do NOT trust the finding — your job is",
    "to verify it against the ACTUAL code in this repository (read-only) and catch anything wrong.",
    "",
    "RESEARCH TASK:",
    task,
    "",
    `RESEARCHER FINDINGS (from model ${researcherModel}) — treat every claim as UNVERIFIED until you check it:`,
    findings,
    "",
    "Do this:",
    "1. Check each concrete claim (file paths, symbols, line refs, described behavior) against the real code.",
    "2. Flag anything unsupported, wrong, outdated, or hallucinated — cite the file:line you actually read.",
    "3. Return exactly:",
    "   VERDICT: confirmed | corrected | refuted",
    "   CORRECTED FINDINGS: the accurate version (fix or drop wrong claims; keep what holds up)",
    "   NOTES: what you disputed and why, with the paths you verified against",
    "Be concise and specific. Ground every correction in a file you read.",
  ].join("\n");
}

// Build the wake message: findings are always framed as CLAIMS, with the adversarial review attached so the
// orchestrator weights them instead of trusting a raw finding.
function formatResearchWake({ displayLabel, model, thinking, findings, reviewer, review }) {
  const researcherTag = [model, thinking].filter(Boolean).join(" · ") || String(model ?? "?");
  const lines = [
    `Background research **${displayLabel}** complete.`,
    "",
    `Researcher (${researcherTag}) findings — treat as CLAIMS, not verified truth:`,
    "",
    findings,
    "",
  ];
  if (reviewer?.model && review) {
    const reviewerTag = [reviewer.model, reviewer.thinking].filter(Boolean).join(" · ") || String(reviewer.model);
    const independence = reviewer.crossFamily ? "cross-family" : "same-family";
    if (review.ok) {
      lines.push(`Adversarial review (${reviewerTag}, ${independence}) — use this to weight the findings above:`, "", review.text);
    } else {
      lines.push(`Adversarial review (${reviewerTag}) FAILED (${review.error}); the findings are UNVERIFIED — verify before relying on them.`);
    }
  } else {
    lines.push("No adversarial review ran; the findings are UNVERIFIED. Bind `adversarial-heavy` to a distinct model/family in .aipi/model-capabilities.json to enable review.");
  }
  return lines.join("\n");
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
      "Fan out READ-ONLY research/exploration tasks (understand code, find where X lives, investigate an area) to background workers. Each worker researches on the `research-heavy` model, then an ADVERSARIAL reviewer on `adversarial-heavy` (cross-family when configured) verifies the findings before they wake you — so findings arrive with a review, never as trusted truth. Returns immediately so you can keep working. Use ONLY for read/investigate work — these workers cannot write, run shell, or merge. For code you will SHIP, use a normal foreground step so the verify gate runs.",
    promptSnippet: "aipi_background_research - fan out read-only research (research-heavy) with an adversarial reviewer (adversarial-heavy) before findings reach you.",
    promptGuidelines: [
      "When you have several INDEPENDENT read-only questions to investigate (e.g. explore N modules, locate N call sites), call aipi_background_research with one task per question — the workers run in parallel and wake you with reviewed findings instead of blocking you.",
      "Do NOT use aipi_background_research for anything that writes or ships code; that must run foreground so the evidence gate applies. Findings arrive with an adversarial review attached — weight them by that review; still treat them as INPUT to a foreground-gated step, not a verified result.",
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
        const tasks = normalizeTasks(params?.tasks);
        if (!tasks.length) return toolJson({ ok: false, error: "aipi_background_research needs at least one task" });

        // Resolve WHO researches (research-heavy) and WHO reviews (adversarial-heavy, cross-family) once.
        const roles = await resolveResearchRoles({ root, ctx });
        if (!roles.researcher.model) return toolJson({ ok: false, error: "no researcher model available to dispatch background research" });

        const runner = runnerFactory ? runnerFactory({ root }) : createAipiSubagentsRunner({ root });
        const maxToolCalls = researchMaxToolCalls(process.env);
        const accepted = tasks.slice(0, MAX_BACKGROUND_RESEARCH);
        const dropped = tasks.slice(MAX_BACKGROUND_RESEARCH);
        const runs = accepted.map((task, index) => {
          const label = truncateLabel(task);
          // A task-derived id so the /aipi-subagents widget shows readable labels (not an opaque timestamp).
          const runId = `research-${slugify(task)}-${index + 1}`;
          // Fire-and-forget: the tool returns now; the job researches, reviews, then wakes the orchestrator.
          void runBackgroundResearchJob({
            pi,
            runner,
            root,
            task,
            runId,
            label,
            model: roles.researcher.model,
            thinking: roles.researcher.thinking,
            reviewer: roles.reviewer,
            maxToolCalls,
          });
          return { run_id: runId, task: label };
        });
        return toolJson({
          ok: true,
          dispatched: runs.length,
          runs,
          // Show WHO researches and WHO reviews so the orchestrator (and operator) can see the model topology.
          researcher: roles.researcher,
          reviewer: roles.reviewer
            ? { model: roles.reviewer.model, thinking: roles.reviewer.thinking, cross_family: roles.reviewer.crossFamily }
            : null,
          ...(roles.notes.length ? { notes: roles.notes } : {}),
          // Never a silent cap: report the overflow so the model can call again for the rest.
          ...(dropped.length
            ? { not_dispatched: dropped.length, cap_note: `Over the ${MAX_BACKGROUND_RESEARCH}-task limit; call again for the remaining ${dropped.length}.` }
            : {}),
          note: roles.reviewer
            ? "Running in the background. Each worker researches, then an adversarial reviewer cross-checks it before waking you with reviewed findings; watch them in /aipi-subagents."
            : "Running in the background. Each worker wakes you with its findings when it finishes; watch them in /aipi-subagents.",
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
