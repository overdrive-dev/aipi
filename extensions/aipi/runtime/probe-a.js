import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROBE_NAME = "tool-call-attribution";
const WORKERS = ["worker-a", "worker-b"];

export class ProbeAController {
  #pi;
  #active = null;
  #last = null;

  constructor(pi) {
    this.#pi = pi;
  }

  registerHooks() {
    for (const eventName of [
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "tool_execution_start",
      "tool_call",
      "tool_result",
      "tool_execution_end",
    ]) {
      this.#pi.on?.(eventName, async (event, ctx) => {
        await this.#record({
          scope: "host",
          eventName,
          event,
          ctx,
        });
      });
    }
  }

  async run({ projectRoot, ctx, args = "" } = {}) {
    const options = parseProbeAArgs(args);
    if (options.action === "status") return this.#status(projectRoot);

    const probe = await createProbeRun(projectRoot, {
      dryRun: options.dryRun,
      now: options.now,
      randomBytes: options.randomBytes,
    });
    this.#active = probe;
    this.#last = probe;

    await writeProbeRecord(probe, {
      type: "probe_start",
      probeId: probe.probeId,
      projectRoot,
      docsBasis: [
        "https://pi.dev/docs/latest/extensions#tool_call",
        "https://pi.dev/docs/latest/sdk#createagentsession",
      ],
    });

    if (options.dryRun) {
      const result = buildBlockedResult(probe, "dry-run requested; no worker sessions were started");
      const finalized = await finalizeProbe(probe, result);
      this.#active = null;
      return finalized;
    }

    try {
      const sdk = await loadPiSdk();
      await runSdkWorkers({ sdk, probe, projectRoot, ctx, record: (entry) => writeProbeRecord(probe, entry) });
      const result = analyzeProbeA(probe.records, {
        expectedWorkers: WORKERS,
        probeRelDir: probe.probeRelDir,
      });
      const finalized = await finalizeProbe(probe, result);
      this.#active = null;
      return finalized;
    } catch (error) {
      const result = buildBlockedResult(probe, error.message);
      await writeProbeRecord(probe, {
        type: "probe_error",
        message: error.message,
        stack: error.stack,
      });
      const finalized = await finalizeProbe(probe, result);
      this.#active = null;
      return finalized;
    }
  }

  #status(projectRoot) {
    if (this.#active) {
      return {
        verdict: "RUNNING",
        probeId: this.#active.probeId,
        resultPath: path.join(this.#active.probeRelDir, "PROBE-A-RESULT.md").replaceAll("\\", "/"),
        summary: "Probe A is currently recording host events.",
      };
    }
    if (this.#last) {
      return {
        verdict: "LAST",
        probeId: this.#last.probeId,
        resultPath: path.join(this.#last.probeRelDir, "PROBE-A-RESULT.md").replaceAll("\\", "/"),
        summary: "Last Probe A run is available on disk.",
      };
    }
    return {
      verdict: "NONE",
      probeId: null,
      resultPath: path.join(projectRoot, ".aipi", "runtime", "probes", PROBE_NAME).replaceAll("\\", "/"),
      summary: "No Probe A run has been started in this session.",
    };
  }

  async #record({ scope, eventName, event, ctx }) {
    if (!this.#active) return;
    try {
      await writeProbeRecord(this.#active, {
        type: "pi_event",
        scope,
        eventName,
        event: sanitizeEvent(event),
        identity: extractIdentity(event, ctx),
      });
    } catch {
      // Probe hooks must never break the user's Pi session.
    }
  }
}

export function parseProbeAArgs(args = "") {
  const tokens = String(args)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const options = {
    action: "run",
    dryRun: false,
  };

  for (const token of tokens) {
    if (token === "status") {
      options.action = "status";
      continue;
    }
    if (token === "run") {
      options.action = "run";
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown /aipi-probe-a option: ${token}`);
  }

  return options;
}

export function analyzeProbeA(records, { expectedWorkers = WORKERS, probeRelDir = "" } = {}) {
  const hostToolCalls = records.filter(
    (record) => record.type === "pi_event" && record.scope === "host" && record.eventName === "tool_call",
  );
  const hostWorkerMatches = new Map(expectedWorkers.map((workerId) => [workerId, []]));

  for (const record of hostToolCalls) {
    const haystack = JSON.stringify(record.event?.input ?? {});
    for (const workerId of expectedWorkers) {
      if (haystack.includes(workerId) || haystack.includes(`${probeRelDir.replaceAll("\\", "/")}/${workerId}`)) {
        hostWorkerMatches.get(workerId)?.push(record);
      }
    }
  }

  const matchedWorkers = [...hostWorkerMatches.entries()].filter(([, matches]) => matches.length > 0);
  const identityValues = new Set(
    hostToolCalls
      .map((record) => stableIdentityValue(record.identity))
      .filter((value) => value && value !== "unknown"),
  );
  const hasDistinctHostIdentity = identityValues.size >= expectedWorkers.length;
  const childToolEvents = records.filter(
    (record) => record.type === "child_event" && /tool_execution|tool_call|tool_result/.test(record.eventName),
  );

  if (matchedWorkers.length === expectedWorkers.length && hasDistinctHostIdentity) {
    return {
      verdict: "PASS",
      summary: "Host tool_call events covered all probe workers and carried distinct session/worker identity.",
      hostToolCallCount: hostToolCalls.length,
      matchedWorkers: matchedWorkers.map(([workerId]) => workerId),
      identityValues: [...identityValues],
      childToolEventCount: childToolEvents.length,
      nextAction: "Wire owned-file enforcement to aipi-agent-session.",
    };
  }

  if (matchedWorkers.length === expectedWorkers.length) {
    return {
      verdict: "PARTIAL",
      summary: "Host saw probe workers' tool calls, but no distinct stable worker/session identity was detected.",
      hostToolCallCount: hostToolCalls.length,
      matchedWorkers: matchedWorkers.map(([workerId]) => workerId),
      identityValues: [...identityValues],
      childToolEventCount: childToolEvents.length,
      nextAction: "Do not rely on host-hook identity for enforcement; use Probe A' wrapped write-tool enforcement before enabling parallel write workers.",
    };
  }

  return {
    verdict: "FAIL",
    summary: "Host did not observe tool_call events for every spawned probe worker.",
    hostToolCallCount: hostToolCalls.length,
    matchedWorkers: matchedWorkers.map(([workerId]) => workerId),
    identityValues: [...identityValues],
    childToolEventCount: childToolEvents.length,
    nextAction: "Treat host AgentSession hooks as insufficient for owned-file enforcement; use Probe A' wrapped write-tool enforcement and escalate only when a stronger process/worktree/container boundary is required.",
  };
}

export function formatProbeAResult(result) {
  return [
    `Probe A ${result.verdict}: ${result.summary}`,
    result.probeId ? `probe_id=${result.probeId}` : null,
    result.resultPath ? `result=${result.resultPath}` : null,
    result.nextAction ? `next=${result.nextAction}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function createProbeRun(projectRoot, { dryRun = false, now = () => new Date(), randomBytes = (size) => crypto.randomBytes(size) } = {}) {
  const root = path.resolve(projectRoot);
  const probeId = generateProbeId(now, randomBytes);
  const probeRelDir = path.join(".aipi", "runtime", "probes", PROBE_NAME, probeId).replaceAll("\\", "/");
  const probeDir = path.join(root, probeRelDir);
  const eventsPath = path.join(probeDir, "events.jsonl");
  const probe = {
    probeId,
    projectRoot: root,
    probeDir,
    probeRelDir,
    eventsPath,
    dryRun,
    records: [],
  };

  if (!dryRun) await fs.mkdir(probeDir, { recursive: true });
  return probe;
}

async function runSdkWorkers({ sdk, probe, projectRoot, ctx, record }) {
  const { createAgentSession, SessionManager } = sdk;
  if (typeof createAgentSession !== "function") {
    throw new Error("Pi SDK createAgentSession is unavailable in this runtime");
  }

  await fs.mkdir(probe.probeDir, { recursive: true });

  await Promise.all(
    WORKERS.map(async (workerId) => {
      const targetRelPath = path.join(probe.probeRelDir, `${workerId}.txt`).replaceAll("\\", "/");
      const sessionManager = SessionManager?.inMemory?.(projectRoot);
      const createOptions = {
        cwd: projectRoot,
        tools: ["write"],
        ...(sessionManager ? { sessionManager } : {}),
        ...(ctx?.model ? { model: ctx.model } : {}),
      };
      await record({
        type: "worker_start",
        workerId,
        targetRelPath,
        createOptions: {
          cwd: createOptions.cwd,
          tools: createOptions.tools,
          hasSessionManager: Boolean(sessionManager),
          hasModelFromContext: Boolean(ctx?.model),
        },
      });

      const { session } = await createAgentSession(createOptions);
      const unsubscribe = session.subscribe?.((event) => {
        void record({
          type: "child_event",
          workerId,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
          eventName: event?.type ?? "unknown",
          event: sanitizeEvent(event),
        });
      });

      try {
        await session.prompt(buildWorkerPrompt({ workerId, probeId: probe.probeId, targetRelPath }));
        await session.agent?.waitForIdle?.();
      } finally {
        unsubscribe?.();
        session.dispose?.();
      }

      await record({
        type: "worker_end",
        workerId,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
      });
    }),
  );
}

function buildWorkerPrompt({ workerId, probeId, targetRelPath }) {
  return [
    `You are ${workerId} in AIPI Probe A ${probeId}.`,
    "Call the write tool exactly once.",
    `Write this exact file path: ${targetRelPath}`,
    `Write this exact content: AIPI_PROBE_A ${workerId} ${probeId}`,
    `After the write tool returns, answer exactly: done ${workerId}`,
    "Do not call bash. Do not call any other tool.",
  ].join("\n");
}

export async function loadPiSdk() {
  const explicitPath = process.env.AIPI_PI_SDK_PATH?.trim() || process.env.PI_CODING_AGENT_SDK_PATH?.trim();
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    try {
      await fs.access(resolved);
      return await import(pathToFileURL(resolved).href);
    } catch (error) {
      throw new Error(`Explicit Pi SDK import failed at ${resolved}: ${error.message}`);
    }
  }
  try {
    return await import("@earendil-works/pi-coding-agent");
  } catch (error) {
    const directError = error;
    for (const candidate of piSdkImportCandidates()) {
      try {
        await fs.access(candidate);
        return await import(pathToFileURL(candidate).href);
      } catch {
        // Try the next known runtime location.
      }
    }
    throw new Error(
      `Pi SDK import failed: ${directError.message}. Set AIPI_PI_SDK_PATH to the installed @earendil-works/pi-coding-agent/dist/index.js path, or run this probe from a Pi package context that can resolve @earendil-works/pi-coding-agent.`,
    );
  }
}

export function piSdkImportCandidates({
  env = process.env,
  argv = process.argv,
  homeDir = os.homedir(),
} = {}) {
  const candidates = [];
  for (const key of ["AIPI_PI_SDK_PATH", "PI_CODING_AGENT_SDK_PATH"]) {
    if (env[key]?.trim()) candidates.push(path.resolve(env[key].trim()));
  }

  // The aipi wrapper exports AIPI_PI_CLI_JS for the Pi it resolved (the
  // package-local pinned dependency first) — the SDK entry lives beside it.
  if (env.AIPI_PI_CLI_JS?.trim()) {
    candidates.push(path.join(path.dirname(path.resolve(env.AIPI_PI_CLI_JS.trim())), "index.js"));
  }
  // Package-local pinned Pi (standalone install: no global Pi required).
  // This file lives at <packageRoot>/extensions/aipi/runtime/probe-a.js.
  candidates.push(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..",
      "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js",
    ),
  );

  const argvEntrypoint = argv[1] ? path.resolve(argv[1]) : null;
  if (argvEntrypoint?.endsWith(path.join("dist", "cli.js"))) {
    candidates.push(path.join(path.dirname(argvEntrypoint), "index.js"));
  }

  if (env.APPDATA) {
    candidates.push(
      path.join(env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    );
  }
  if (env.NPM_CONFIG_PREFIX) {
    candidates.push(
      path.join(env.NPM_CONFIG_PREFIX, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
      path.join(env.NPM_CONFIG_PREFIX, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    );
  }

  candidates.push(
    path.join(homeDir, ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    path.join("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    path.join("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  );

  return [...new Set(candidates)];
}

async function writeProbeRecord(probe, record) {
  const entry = {
    ts: new Date().toISOString(),
    ...record,
  };
  probe.records.push(entry);
  if (!probe.dryRun) {
    await fs.mkdir(probe.probeDir, { recursive: true });
    await fs.appendFile(probe.eventsPath, `${JSON.stringify(entry)}\n`);
  }
}

async function finalizeProbe(probe, result) {
  const enriched = {
    probeId: probe.probeId,
    resultPath: path.join(probe.probeRelDir, "PROBE-A-RESULT.md").replaceAll("\\", "/"),
    ...result,
  };
  await writeProbeRecord(probe, {
    type: "probe_result",
    result: enriched,
  });
  if (!probe.dryRun) {
    await fs.writeFile(path.join(probe.probeDir, "PROBE-A-RESULT.json"), `${JSON.stringify(enriched, null, 2)}\n`);
    await fs.writeFile(path.join(probe.probeDir, "PROBE-A-RESULT.md"), renderProbeMarkdown(enriched));
  }
  return enriched;
}

function buildBlockedResult(probe, reason) {
  return {
    probeId: probe.probeId,
    resultPath: path.join(probe.probeRelDir, "PROBE-A-RESULT.md").replaceAll("\\", "/"),
    verdict: "BLOCKED",
    summary: reason,
    hostToolCallCount: 0,
    matchedWorkers: [],
    identityValues: [],
    childToolEventCount: 0,
    nextAction: "Run Probe A inside Pi after /aipi-init, /login anthropic, and /aipi-status are ready.",
  };
}

function renderProbeMarkdown(result) {
  return `# AIPI Probe A - Tool Call Attribution

- probe_id: ${result.probeId}
- verdict: ${result.verdict}
- summary: ${result.summary}
- host_tool_call_count: ${result.hostToolCallCount ?? 0}
- child_tool_event_count: ${result.childToolEventCount ?? 0}
- matched_workers: ${(result.matchedWorkers ?? []).join(", ") || "none"}
- identity_values: ${(result.identityValues ?? []).join(", ") || "none"}
- next_action: ${result.nextAction}

## Criterion

PASS means host-level \`tool_call\` events covered all spawned probe workers and
carried distinct, stable worker/session identity. PARTIAL means host hooks saw
the calls but identity was not sufficient. FAIL means host hooks did not observe
every worker's tool calls. BLOCKED means the runtime could not execute the probe.
`;
}

function sanitizeEvent(event) {
  if (!event || typeof event !== "object") return event ?? null;
  const copy = {};
  for (const [key, value] of Object.entries(event)) {
    if (/token|secret|apikey|api_key|authorization|refresh|access/i.test(key)) {
      copy[key] = "[redacted]";
      continue;
    }
    if (key === "content" && typeof value === "string" && value.length > 500) {
      copy[key] = `${value.slice(0, 500)}...[truncated]`;
      continue;
    }
    copy[key] = safeJsonValue(value, 0);
  }
  return copy;
}

function safeJsonValue(value, depth) {
  if (depth > 3) return "[depth-limit]";
  if (typeof value === "function") return "[function]";
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeJsonValue(item, depth + 1));
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, 30)) {
    if (/token|secret|apikey|api_key|authorization|refresh|access/i.test(key)) out[key] = "[redacted]";
    else out[key] = safeJsonValue(child, depth + 1);
  }
  return out;
}

function extractIdentity(event, ctx) {
  return {
    eventSessionId: event?.sessionId ?? event?.session_id ?? null,
    eventSessionFile: event?.sessionFile ?? event?.session_file ?? null,
    eventAgentId: event?.agentId ?? event?.agent_id ?? null,
    eventWorkerId: event?.workerId ?? event?.worker_id ?? null,
    toolCallId: event?.toolCallId ?? null,
    ctxCwd: ctx?.cwd ?? null,
    ctxSessionFile: safeCall(() => ctx?.sessionManager?.getSessionFile?.()) ?? null,
    ctxLeafId: safeCall(() => ctx?.sessionManager?.getLeafId?.()) ?? null,
  };
}

function stableIdentityValue(identity) {
  return (
    identity?.eventWorkerId ??
    identity?.eventAgentId ??
    identity?.eventSessionId ??
    identity?.eventSessionFile ??
    identity?.ctxSessionFile ??
    null
  );
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function generateProbeId(now, randomBytes) {
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
