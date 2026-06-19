#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aipiStatusKind,
  buildAipiStatusReport,
} from "../extensions/aipi/runtime/provider-auth.js";

const thisFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(thisFile), "..");
const runtimeProcess = globalThis.process;
const MODEL_PRESSURE_BASELINE_REPORT = ".aipi/evals/model-pressure-baseline-results.json";
const MODEL_PRESSURE_VERIFY_REPORT = ".aipi/evals/model-pressure-verify-results.json";
const LIVE_SUBAGENT_SMOKE_REPORT = ".aipi/runtime/smoke/live-subagent-result.json";

if (runtimeProcess?.argv?.[1] && path.resolve(runtimeProcess.argv[1]) === thisFile) {
  const result = await runCredentialedReadiness({
    args: runtimeProcess.argv.slice(2),
    env: runtimeProcess.env,
    stdout: runtimeProcess.stdout,
    stderr: runtimeProcess.stderr,
  });
  if (result.exitCode) runtimeProcess.exitCode = result.exitCode;
}

export async function runCredentialedReadiness({
  args = [],
  env = runtimeProcess?.env ?? {},
  stdout = runtimeProcess?.stdout ?? { write() {} },
  stderr = runtimeProcess?.stderr ?? { write() {} },
  now = () => new Date(),
} = {}) {
  const options = parseCredentialedReadinessArgs(args);
  const targetRoot = path.resolve(options.target ?? process.cwd());
  const steps = [];
  const preflight = await buildAipiStatusReport({
    projectRoot: targetRoot,
    env,
  });
  const credentialedRequested =
    (!options.skipModelPressure && env.AIPI_MODEL_PRESSURE === "1" && env.AIPI_MODEL_PRESSURE_COMMAND?.trim()) ||
    (!options.skipLiveSmoke && env.AIPI_LIVE_SMOKE === "1");
  const preflightBlockers = preflight.readiness?.blockers ?? [];

  if (preflightBlockers.length && credentialedRequested) {
    steps.push({
      id: "preflight.local_blockers",
      state: "blocked",
      reason: `local readiness blockers must pass before credentialed checks: ${preflightBlockers.join(", ")}`,
    });
    const report = buildCredentialedReadinessReport({
      targetRoot,
      options,
      steps,
      status: preflight,
      now,
      preflight,
    });
    writeCredentialedReadinessReport({ report, options, stdout });
    stderr.write("AIPI_CREDENTIALED_READINESS_PREFLIGHT_BLOCKED\n");
    return { report, exitCode: 1 };
  }

  if (!options.skipModelPressure) {
    if (env.AIPI_MODEL_PRESSURE === "1" && env.AIPI_MODEL_PRESSURE_COMMAND?.trim()) {
      steps.push(
        await runModelPressurePhase({
          targetRoot,
          phase: "baseline",
          outputRelPath: MODEL_PRESSURE_BASELINE_REPORT,
          env,
        }),
      );
      if (steps.at(-1).state === "pass") {
        steps.push(
          await runModelPressurePhase({
            targetRoot,
            phase: "verify",
            outputRelPath: MODEL_PRESSURE_VERIFY_REPORT,
            env,
          }),
        );
      }
    } else {
      steps.push({
        id: "model_pressure",
        state: "skipped",
        reason: "set AIPI_MODEL_PRESSURE=1 and AIPI_MODEL_PRESSURE_COMMAND to run baseline+verify",
      });
    }
  }

  if (!options.skipLiveSmoke) {
    if (env.AIPI_LIVE_SMOKE === "1") {
      steps.push(await runLiveSubagentSmoke({ targetRoot, env }));
    } else {
      steps.push({
        id: "live_subagent_smoke",
        state: "skipped",
        reason: "set AIPI_LIVE_SMOKE=1 to run one credentialed worker smoke",
      });
    }
  }

  const status = await buildAipiStatusReport({
    projectRoot: targetRoot,
    env,
  });
  const report = buildCredentialedReadinessReport({ targetRoot, options, steps, status, now, preflight });
  const failed = steps.some((step) => step.state === "fail");
  const skipped = steps.some((step) => step.state === "skipped");
  const strictFailure =
    options.strict && (failed || skipped || status.readiness?.status !== "ready_for_adversarial_review");

  writeCredentialedReadinessReport({ report, options, stdout });

  if (failed || strictFailure) {
    stderr.write(
      strictFailure
        ? "AIPI_CREDENTIALED_READINESS_STRICT_FAIL\n"
        : "AIPI_CREDENTIALED_READINESS_FAIL\n",
    );
    return { report, exitCode: 1 };
  }
  return { report, exitCode: 0 };
}

function buildCredentialedReadinessReport({ targetRoot, options, steps, status, now, preflight }) {
  return {
    schema: "aipi.credentialed-readiness.v1",
    generated_at: now().toISOString(),
    target: targetRoot,
    strict: options.strict,
    preflight: {
      readiness: preflight.readiness?.status ?? "unknown",
      blockers: preflight.readiness?.blockers ?? [],
    },
    steps,
    status_kind: aipiStatusKind(status),
    readiness: status.readiness,
  };
}

function writeCredentialedReadinessReport({ report, options, stdout }) {
  if (options.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(formatCredentialedReadinessReport(report));
  }
}

export function parseCredentialedReadinessArgs(args) {
  const options = {
    target: runtimeProcess?.cwd?.() ?? ".",
    json: false,
    strict: false,
    skipModelPressure: false,
    skipLiveSmoke: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--skip-model-pressure") {
      options.skipModelPressure = true;
    } else if (arg === "--skip-live-smoke") {
      options.skipLiveSmoke = true;
    } else if (arg === "--target") {
      const next = args[index + 1];
      if (!next) throw new Error("--target requires a directory");
      options.target = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function formatCredentialedReadinessReport(report) {
  const lines = [
    `AIPI credentialed readiness: ${report.readiness?.status ?? "unknown"}`,
    `Target: ${report.target}`,
    `Preflight: ${report.preflight?.readiness ?? "unknown"}`,
  ];
  if (report.preflight?.blockers?.length) {
    lines.push(`Preflight blockers: ${report.preflight.blockers.join(", ")}`);
  }
  for (const step of report.steps) {
    lines.push(`- ${step.id}: ${step.state}${step.reason ? `; ${step.reason}` : ""}`);
  }
  lines.push(`Status kind: ${report.status_kind}`);
  return `${lines.join("\n")}\n`;
}

async function runModelPressurePhase({ targetRoot, phase, outputRelPath, env }) {
  const outputPath = path.join(targetRoot, outputRelPath);
  const commandEnv = {
    ...env,
    AIPI_MODEL_PRESSURE: "1",
    AIPI_MODEL_PRESSURE_PHASE: phase,
    AIPI_MODEL_PRESSURE_OUTPUT: outputPath,
  };
  const result = await runNodeScript("tools/test-model-pressure-evals.mjs", {
    env: commandEnv,
    timeoutMs: Number(env.AIPI_MODEL_PRESSURE_TIMEOUT_MS ?? 300000),
  });
  return commandStep({
    id: `model_pressure.${phase}`,
    result,
    output: outputRelPath,
  });
}

async function runLiveSubagentSmoke({ targetRoot, env }) {
  const outputPath = path.join(targetRoot, LIVE_SUBAGENT_SMOKE_REPORT);
  const result = await runNodeScript("tools/smoke-live-subagent.mjs", {
    env: {
      ...env,
      AIPI_LIVE_SMOKE: "1",
      AIPI_LIVE_SMOKE_OUTPUT: outputPath,
    },
    timeoutMs: Number(env.AIPI_LIVE_SMOKE_TIMEOUT_MS ?? 240000),
  });
  return commandStep({
    id: "live_subagent_smoke",
    result,
    output: LIVE_SUBAGENT_SMOKE_REPORT,
  });
}

function commandStep({ id, result, output }) {
  return {
    id,
    state: result.code === 0 ? "pass" : "fail",
    code: result.code,
    timed_out: result.timedOut,
    output,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}

function runNodeScript(relPath, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(runtimeProcess?.execPath ?? "node", [path.join(packageRoot, relPath)], {
      cwd: packageRoot,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function tail(text, size = 2000) {
  return text.length > size ? text.slice(-size) : text;
}
