import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 120_000;

export function parseNpmAuditArgs(argv = []) {
  const options = {
    json: false,
    strict: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cache: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("release audit --timeout-ms requires a positive number");
      options.timeoutMs = value;
      index += 1;
      continue;
    }
    if (arg === "--cache") {
      const value = argv[index + 1];
      if (!value) throw new Error("release audit --cache requires a directory");
      options.cache = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown release audit option: ${arg}`);
  }
  return options;
}

export async function runNpmAuditReleaseCheck({
  argv = [],
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  runner = runCommand,
} = {}) {
  let options;
  try {
    options = parseNpmAuditArgs(argv);
  } catch (error) {
    stderr.write(`AIPI_NPM_AUDIT_CHECK_ERROR ${error.message}\n`);
    return { exitCode: 2, report: null };
  }

  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const cache = options.cache ?? env.AIPI_NPM_AUDIT_CACHE ?? path.join(env.TEMP ?? env.TMP ?? cwd, "aipi-npm-audit-cache");
  const command = process.execPath;
  const args = [
    npmCli,
    "audit",
    "--omit=dev",
    "--legacy-peer-deps",
    "--cache",
    cache,
  ];
  const result = await runner({ command, args, cwd, env, timeoutMs: options.timeoutMs });
  const report = formatAuditReport({ result, command, args, timeoutMs: options.timeoutMs });
  stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatAuditReportText(report)}\n`);
  if (options.strict && report.status !== "pass") return { exitCode: 1, report };
  return { exitCode: report.status === "fail" ? 1 : 0, report };
}

export function formatAuditReport({ result, command, args, timeoutMs }) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const endpointUnavailable = /audit endpoint returned an error|request to .*npm.*audit.*failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|registry/i.test(output);
  const timedOut = result.signal === "timeout";
  const status = result.code === 0
    ? "pass"
    : (timedOut || endpointUnavailable ? "external_unavailable" : "fail");
  return {
    schema: "aipi.npm-audit-release-check.v1",
    status,
    command: [command, ...args],
    timeout_ms: timeoutMs,
    exit_code: result.code,
    signal: result.signal ?? null,
    reason: status === "pass"
      ? "npm audit completed successfully"
      : status === "external_unavailable"
        ? (timedOut ? "npm audit timed out" : "npm audit registry endpoint unavailable")
        : "npm audit reported vulnerabilities or command failure",
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}

export function formatAuditReportText(report) {
  return [
    `AIPI npm audit release check: ${report.status}`,
    `Reason: ${report.reason}`,
    `Command: ${report.command.join(" ")}`,
  ].join("\n");
}

async function runCommand({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, signal: "spawn_error", stdout: "", stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ code: null, signal: "timeout", stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, signal: "spawn_error", stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function tail(value, limit = 4000) {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(-limit) : text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runNpmAuditReleaseCheck({ argv: process.argv.slice(2) });
  process.exitCode = result.exitCode;
}
