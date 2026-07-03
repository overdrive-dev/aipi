import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAipiStatusReport } from "./provider-auth.js";
import { redactSecrets } from "./redact.js";

const FAILURE_STATUSES = new Set(["failed", "blocked", "approval_required", "escalated_to_human", "escalated_to_planning"]);

export function parseDiagnoseArgs(args = "") {
  const tokens = Array.isArray(args) ? [...args] : String(args).trim().split(/\s+/).filter(Boolean);
  const options = { runId: null, share: false, json: false, help: false, target: null };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--share") {
      options.share = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--target") {
      const target = tokens[index + 1];
      if (!target) throw new Error("aipi diagnose --target requires a directory");
      options.target = target;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) throw new Error(`unknown aipi diagnose option: ${token}`);
    if (options.runId) throw new Error(`unexpected aipi diagnose argument: ${token}`);
    options.runId = token;
  }
  return options;
}

export function formatDiagnoseHelp() {
  return [
    "Usage: aipi diagnose [<run_id>] [--target <dir>] [--share] [--json]",
    "",
    "Explain the most recent failed/blocked AIPI run, or a specific run id.",
    "Writes a redacted markdown report under .aipi/runtime/diagnostics/.",
    "",
    "Options:",
    "  --target <dir>  Project root to inspect",
    "  --share         Open a GitHub issue when gh and a remote are available",
    "  --json          Print the structured diagnostic result",
    "  --help, -h      Show this help",
  ].join("\n");
}

export async function runDiagnoseCommand({
  args = "",
  projectRoot,
  statusFn = buildAipiStatusReport,
  spawnSyncFn = spawnSync,
  env = process.env,
  now = () => new Date(),
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const options = parseDiagnoseArgs(args);
  if (options.help) {
    return {
      schema: "aipi.diagnose-help.v1",
      help: true,
      text: formatDiagnoseHelp(),
    };
  }
  return diagnoseAipiProject({
    projectRoot: options.target ? path.resolve(projectRoot, options.target) : projectRoot,
    runId: options.runId,
    share: options.share,
    statusFn,
    spawnSyncFn,
    env,
    now,
  });
}

export async function diagnoseAipiProject({
  projectRoot,
  runId = null,
  share = false,
  statusFn = buildAipiStatusReport,
  spawnSyncFn = spawnSync,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const root = path.resolve(projectRoot);
  const target = await resolveDiagnoseTarget({ root, runId });
  const evidence = await collectDiagnoseEvidence({ root, target, statusFn });
  const causes = rankLikelyCauses(evidence);
  const summary = summarizeDiagnostic({ evidence, causes });
  const report = renderDiagnoseMarkdown({ root, target, evidence, causes, summary });
  const reportPath = await writeDiagnoseReport({ root, target, report, now });
  const reportRelPath = path.relative(root, reportPath).replaceAll("\\", "/");
  const shareResult = share
    ? shareDiagnoseReport({ root, report, summary, spawnSyncFn, env })
    : { attempted: false, status: "skipped", message: null };
  if (shareResult.status === "local_fallback") {
    shareResult.message = `shared report saved locally at ${reportRelPath}; run gh auth / add a remote to file an issue`;
  }

  return redactJson({
    schema: "aipi.diagnose-result.v1",
    target,
    summary,
    report_path: reportRelPath,
    causes,
    evidence,
    share: shareResult,
  });
}

export function formatDiagnoseCommandResult(result) {
  if (result?.help) return result.text;
  const lines = [
    `AIPI diagnose report: ${result.report_path}`,
    `Summary: ${result.summary}`,
  ];
  if (result.share?.attempted) lines.push(result.share.message);
  return lines.filter(Boolean).join("\n");
}

export async function resolveDiagnoseTarget({ root, runId = null } = {}) {
  const runsDir = path.join(root, ".aipi", "runtime", "runs");
  if (runId) {
    const state = await readJsonFile(path.join(runsDir, runId, "state.json"));
    if (!state) throw new Error(`AIPI run not found: ${runId}`);
    return {
      type: "run",
      run_id: runId,
      run_dir: path.join(runsDir, runId),
      state,
      reason: "explicit",
    };
  }

  const candidates = [];
  for (const entry of await readDirSafe(runsDir)) {
    if (!entry.isDirectory()) continue;
    const state = await readJsonFile(path.join(runsDir, entry.name, "state.json"));
    if (!state) continue;
    const failedWorker = latestFailedWorker(state);
    if (FAILURE_STATUSES.has(state.status) || failedWorker) {
      candidates.push({
        type: "run",
        run_id: state.run_id ?? entry.name,
        run_dir: path.join(runsDir, entry.name),
        state,
        failed_worker: failedWorker,
        reason: FAILURE_STATUSES.has(state.status) ? "run_status" : "worker_status",
        time: Date.parse(state.completed_at ?? state.updated_at ?? state.created_at ?? "") || 0,
      });
    }
  }

  candidates.sort((a, b) => b.time - a.time || String(b.run_id).localeCompare(String(a.run_id)));
  if (candidates[0]) return candidates[0];
  throw new Error("No failed or blocked AIPI run found under .aipi/runtime/runs");
}

export async function collectDiagnoseEvidence({ root, target, statusFn = buildAipiStatusReport } = {}) {
  const runId = target.run_id;
  const state = target.state ?? {};
  const runDir = target.run_dir;
  const stepResults = await collectStepResults(runDir, state);
  const providerEvents = await collectJsonlFromPaths([
    path.join(root, ".aipi", "runtime", "provider-events.jsonl"),
    path.join(runDir, "provider-events.jsonl"),
  ]);
  const modelRouting = await collectJsonlFromPaths([
    path.join(root, ".aipi", "runtime", "model-routing.jsonl"),
    path.join(runDir, "model-routing.jsonl"),
  ]);
  const lifecycleEvents = await collectJsonlFromPaths([
    path.join(root, ".aipi", "runtime", "lifecycle.jsonl"),
    path.join(runDir, "lifecycle.jsonl"),
  ]);
  const subagent = collectSubagentSignals({ state, lifecycleEvents, stepResults });
  const correlatedProviderEvents = correlateProviderEvents({ providerEvents, runId, subagent });
  const readiness = await safeStatusReport({ root, statusFn });

  return redactJson({
    run: summarizeRunState(state),
    awaiting_user_input: state.awaiting_user_input ?? null,
    steps: stepResults,
    subagent,
    provider_events: {
      total: correlatedProviderEvents.length,
      entries: correlatedProviderEvents.slice(-20),
      zero_for_workers: subagent.workers
        .filter((worker) => worker.agent_id && !correlatedProviderEvents.some((event) => eventMatchesWorker(event, worker.agent_id)))
        .map((worker) => worker.agent_id),
    },
    model_routing: modelRouting.filter((entry) => entry.run_id === runId || !entry.run_id).slice(-20),
    lifecycle_events: lifecycleEvents.filter((entry) => entry.run_id === runId || !entry.run_id).slice(-20),
    readiness,
  });
}

export function rankLikelyCauses(evidence) {
  const causes = CAUSE_RULES
    .map((rule) => rule(evidence))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);
  if (causes.length) return causes;
  return [{
    id: "unknown_failure",
    cause: "The run failed or blocked, but no specific known diagnostic pattern matched.",
    fix: "Open the generated report and inspect the step errors, provider events, model routing, and readiness checks.",
    confidence: 0.25,
  }];
}

export function renderDiagnoseMarkdown({ root, target, evidence, causes, summary }) {
  const top = causes[0];
  return redactSecrets([
    `# AIPI Diagnostic Report - ${target.run_id}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## What happened",
    "",
    ...whatHappenedLines(evidence),
    "",
    "## Likely cause(s)",
    "",
    ...causes.map((cause, index) => `${index + 1}. **${cause.cause}** (${percent(cause.confidence)} confidence) - ${cause.fix}`),
    "",
    "## Try this",
    "",
    `- ${top.fix}`,
    "- Re-run `aipi diagnose --json` if another agent needs structured evidence.",
    "- Re-run `/aipi-status` after applying the suggested fix.",
    "",
    "## Evidence",
    "",
    `- project_root: ${path.relative(root, root) || "."}`,
    `- run_id: ${target.run_id}`,
    `- run_status: ${evidence.run.status ?? "unknown"}`,
    `- current_step: ${evidence.run.current_step ?? "none"}`,
    `- blocked_reason: ${evidence.run.blocked_reason ?? "none"}`,
    `- step_results: ${evidence.steps.map((step) => `${step.step_id}:${step.status ?? step.verdict ?? "unknown"}`).join(", ") || "none"}`,
    `- workers: ${evidence.subagent.workers.map((worker) => `${worker.agent_id}:${worker.state ?? "unknown"}:${worker.error ?? "no-error"}`).join("; ") || "none"}`,
    `- provider_events_for_target: ${evidence.provider_events.total}`,
    `- zero_provider_events_for_workers: ${evidence.provider_events.zero_for_workers.join(", ") || "none"}`,
    `- readiness_status: ${evidence.readiness?.status ?? evidence.readiness?.readiness?.status ?? "unknown"}`,
  ].join("\n"));
}

async function writeDiagnoseReport({ root, target, report, now }) {
  const dir = path.join(root, ".aipi", "runtime", "diagnostics");
  await fs.mkdir(dir, { recursive: true });
  const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeRunId = safeFilePart(target.run_id);
  const reportPath = path.join(dir, `${stamp}-${safeRunId}.md`);
  await fs.writeFile(reportPath, report);
  return reportPath;
}

export function shareDiagnoseReport({ root, report, summary, spawnSyncFn = spawnSync, env = process.env } = {}) {
  const hasGh = spawnSyncFn("gh", ["--version"], { encoding: "utf8", env });
  const remote = spawnSyncFn("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", env });
  if (hasGh.error || hasGh.status !== 0 || remote.error || remote.status !== 0 || !String(remote.stdout ?? "").trim()) {
    return {
      attempted: true,
      status: "local_fallback",
      message: "shared report saved locally at report path; run gh auth / add a remote to file an issue",
    };
  }
  const created = spawnSyncFn("gh", [
    "issue",
    "create",
    "--title",
    summary.slice(0, 180),
    "--body",
    report,
    "--label",
    "aipi-diagnose",
  ], { encoding: "utf8", env, cwd: root });
  if (created.error || created.status !== 0) {
    return {
      attempted: true,
      status: "local_fallback",
      message: "shared report saved locally at report path; gh issue create failed",
      error: redactSecrets(created.error?.message ?? created.stderr ?? created.stdout ?? "unknown gh error"),
    };
  }
  return {
    attempted: true,
    status: "shared",
    message: `shared report as GitHub issue: ${String(created.stdout ?? "").trim()}`,
  };
}

function summarizeDiagnostic({ evidence, causes }) {
  const top = causes[0];
  const status = evidence.run.status ?? "unknown";
  const step = evidence.run.current_step ?? evidence.steps.find((item) => FAILURE_STATUSES.has(item.status))?.step_id ?? "unknown step";
  return `${status} at ${step}: ${top.cause}`;
}

function whatHappenedLines(evidence) {
  const lines = [
    `- Run status is \`${evidence.run.status ?? "unknown"}\`; current step is \`${evidence.run.current_step ?? "none"}\`.`,
  ];
  if (evidence.run.blocked_reason) lines.push(`- Blocked reason: ${evidence.run.blocked_reason}.`);
  if (evidence.awaiting_user_input?.question) {
    lines.push(`- The run is waiting for a user decision: ${evidence.awaiting_user_input.question}`);
    if (evidence.awaiting_user_input.options?.length) {
      lines.push(`- Options: ${evidence.awaiting_user_input.options.join("; ")}.`);
    }
  }
  for (const worker of evidence.subagent.workers.slice(0, 5)) {
    lines.push(
      `- Worker \`${worker.agent_id}\` is \`${worker.state ?? "unknown"}\` with ${worker.tool_call_count ?? 0} tool calls` +
        `${worker.error ? ` and error: ${worker.error}` : ""}.`,
    );
  }
  if (evidence.provider_events.zero_for_workers.length) {
    lines.push(`- 0 provider events were found for worker(s): ${evidence.provider_events.zero_for_workers.join(", ")}.`);
  } else {
    lines.push(`- Provider events correlated to the target: ${evidence.provider_events.total}.`);
  }
  return lines;
}

const CAUSE_RULES = [
  (evidence) => {
    const worker = evidence.subagent.workers.find((item) =>
      /finished without assistant text/i.test(item.error ?? "") &&
      evidence.provider_events.zero_for_workers.includes(item.agent_id)
    );
    if (!worker) return null;
    return {
      id: "worker_no_provider_events",
      cause: "provider not registered / model unbound in worker process",
      fix: "Restart AIPI with the updated worker provider wiring; if this persists, inspect the worker ResourceLoader/AuthStorage path and provider-events.jsonl for that worker id.",
      confidence: 0.95,
      signals: [`worker=${worker.agent_id}`, "finished without assistant text", "0 provider events"],
    };
  },
  (evidence) => {
    const unresolved = evidence.subagent.workers.find((item) =>
      item.model_resolved === "host-default" ||
      item.model_warning?.code === "AIPI_MODEL_CLASS_UNRESOLVED" ||
      /AIPI_MODEL_CLASS_UNRESOLVED/.test(JSON.stringify(item.model_warning ?? ""))
    );
    if (!unresolved) return null;
    return {
      id: "model_class_unresolved",
      cause: "model class has no concrete binding",
      fix: "Bind the model class in .aipi/model-capabilities.json or set AIPI_MODEL_CLASS_<CLASS>; use allow_fallback:false when you want a loud failure.",
      confidence: 0.9,
      signals: [`worker=${unresolved.agent_id}`, `model_resolved=${unresolved.model_resolved ?? "unknown"}`],
    };
  },
  (evidence) => {
    if (!evidence.awaiting_user_input?.question) return null;
    return {
      id: "awaiting_user_decision",
      cause: "the workflow is blocked waiting for a user decision",
      fix: `Answer the pending question: ${evidence.awaiting_user_input.question}`,
      confidence: 0.92,
      signals: evidence.awaiting_user_input.options ?? [],
    };
  },
  (evidence) => {
    const authEvent = evidence.provider_events.entries.find((entry) =>
      String(entry.status ?? entry.status_code ?? entry.response_status ?? "").startsWith("401") ||
      /401|unauthori[sz]ed|auth/i.test(JSON.stringify(entry.error ?? entry.message ?? ""))
    );
    if (!authEvent) return null;
    return {
      id: "provider_auth_error",
      cause: "provider credential/authentication failed",
      fix: "Run `/login anthropic` or the provider-specific login, then rerun `/aipi-status` and the workflow.",
      confidence: 0.88,
      signals: ["provider event reported auth failure"],
    };
  },
  (evidence) => {
    const blockers = evidence.readiness?.readiness?.blockers ?? evidence.readiness?.blockers ?? [];
    const authBlocked = blockers.some((item) => /provider|auth/i.test(item));
    if (!authBlocked) return null;
    return {
      id: "readiness_provider_auth",
      cause: "AIPI readiness says provider/auth is not ready",
      fix: "Run `/aipi-status`, follow its provider auth next action, then run `/login anthropic` if needed.",
      confidence: 0.78,
      signals: blockers,
    };
  },
  (evidence) => {
    const policy = [
      ...(evidence.run.policy_decisions ?? []),
      ...evidence.steps.flatMap((step) => step.policy_decision ? [step.policy_decision] : []),
    ].find((item) => /BLOCK|HUMAN_REVIEW_REQUIRED|source_write|secret|destructive/i.test(JSON.stringify(item)));
    if (!policy) return null;
    return {
      id: "policy_gate",
      cause: "a runtime policy gate blocked the workflow",
      fix: "Review the policy decision in the report evidence and either change the request, provide human approval, or route to the required planning/review step.",
      confidence: 0.75,
      signals: [policy],
    };
  },
];

async function collectStepResults(runDir, state) {
  const stepsDir = path.join(runDir, "steps");
  const results = [];
  for (const step of state.steps ?? []) {
    const resultJson = await readJsonFile(path.join(stepsDir, step.id, "RESULT.json"));
    const mdPath = path.join(stepsDir, step.id, "RESULT.md");
    const md = await readTextFile(mdPath);
    results.push(redactJson({
      step_id: step.id,
      status: step.status ?? null,
      verdict: step.verdict ?? resultJson?.result?.verdict ?? null,
      error: step.error ?? null,
      result_path: step.result_path ?? null,
      policy_decision: resultJson?.result?.policy_decision ?? null,
      evidence: resultJson?.result?.evidence ?? [],
      validation_errors: resultJson?.validation?.errors ?? [],
      missing_artifacts: resultJson?.missing_artifacts ?? [],
      markdown_excerpt: md ? redactSecrets(md.slice(0, 1200)) : null,
    }));
  }
  return results;
}

function collectSubagentSignals({ state, lifecycleEvents, stepResults }) {
  const workers = [];
  for (const snapshot of collectSubagentSnapshots(state, lifecycleEvents)) {
    for (const job of snapshot.jobs ?? []) workers.push(normalizeWorker(job));
  }
  for (const step of stepResults) {
    for (const evidence of step.evidence ?? []) {
      const ref = String(evidence.ref ?? evidence.result ?? "");
      const workerId = ref.match(/([a-z0-9_-]+:[a-f0-9]{4,}|[a-z0-9_-]+:[a-z0-9_-]+)/i)?.[1];
      if (workerId && !workers.some((worker) => worker.agent_id === workerId)) {
        workers.push({ agent_id: workerId, state: step.status, error: step.error, tool_call_count: null });
      }
    }
  }
  return {
    workers: dedupeWorkers(workers),
  };
}

function collectSubagentSnapshots(state, lifecycleEvents) {
  const snapshots = [];
  if (state.subagents?.jobs) snapshots.push(state.subagents);
  if (state.subagent_state?.jobs) snapshots.push(state.subagent_state);
  for (const entry of lifecycleEvents) {
    const value = entry.value ?? entry.event ?? entry.data ?? entry;
    if (value?.jobs) snapshots.push(value);
    if (value?.name === "aipi.subagents.state" && value?.value?.jobs) snapshots.push(value.value);
  }
  return snapshots;
}

function normalizeWorker(job = {}) {
  const model = job.model ?? job.modelResolution ?? {};
  return redactJson({
    agent_id: job.agentId ?? job.agent_id ?? null,
    state: job.state ?? null,
    error: job.error ?? null,
    abort_reason: job.abortReason ?? job.abort_reason ?? null,
    tool_call_count: job.toolCallCount ?? job.tool_call_count ?? 0,
    started_at: job.startedAt ?? job.started_at ?? null,
    finished_at: job.finishedAt ?? job.finished_at ?? null,
    prompt_started_at: job.promptStartedAt ?? job.prompt_started_at ?? null,
    prompt_ended_at: job.promptEndedAt ?? job.prompt_ended_at ?? null,
    model_requested: model.requested ?? job.model_requested ?? null,
    model_resolved: model.resolved ?? job.model_resolved ?? null,
    model_fallback: model.fallback ?? job.model_fallback ?? null,
    model_source: model.source ?? job.model_source ?? null,
    model_warning: model.warning ?? job.model_warning ?? null,
  });
}

function dedupeWorkers(workers) {
  const byId = new Map();
  for (const worker of workers.filter((item) => item.agent_id)) byId.set(worker.agent_id, { ...byId.get(worker.agent_id), ...worker });
  return [...byId.values()];
}

function correlateProviderEvents({ providerEvents, runId, subagent }) {
  const workerIds = new Set(subagent.workers.map((worker) => worker.agent_id).filter(Boolean));
  return providerEvents.filter((entry) =>
    entry.run_id === runId ||
    [...workerIds].some((workerId) => eventMatchesWorker(entry, workerId)) ||
    (!entry.run_id && workerIds.size === 0)
  );
}

function eventMatchesWorker(entry, workerId) {
  if (!workerId) return false;
  const haystack = JSON.stringify(entry);
  return haystack.includes(workerId);
}

function summarizeRunState(state) {
  return redactJson({
    run_id: state.run_id ?? null,
    workflow: state.workflow ?? null,
    status: state.status ?? null,
    current_step: state.current_step ?? null,
    created_at: state.created_at ?? null,
    completed_at: state.completed_at ?? null,
    blocked_reason: state.blocked_reason ?? null,
    policy_decisions: state.policy_decisions ?? [],
  });
}

function latestFailedWorker(state) {
  const jobs = state.subagents?.jobs ?? state.subagent_state?.jobs ?? [];
  return jobs.find((job) => ["failed", "blocked", "cancelled"].includes(job.state));
}

async function safeStatusReport({ root, statusFn }) {
  try {
    return await statusFn({ projectRoot: root, root });
  } catch (error) {
    return { status: "unavailable", error: redactSecrets(error.message) };
  }
}

async function collectJsonlFromPaths(paths) {
  const out = [];
  const seen = new Set();
  for (const filePath of paths) {
    const text = await readTextFile(filePath);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const key = JSON.stringify(parsed);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(redactJson(parsed));
        }
      } catch {
        out.push({ parse_error: true, line: redactSecrets(line.slice(0, 500)), path: filePath });
      }
    }
  }
  return out;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function redactJson(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactJson);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|apikey|api_key|authorization|refresh|access|password/i.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redactJson(child);
    }
  }
  return out;
}

export { redactSecrets };

function percent(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

function safeFilePart(value) {
  return String(value ?? "run").replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80) || "run";
}
