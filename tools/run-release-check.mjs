import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runMemoryDoctor, verifyMemory } from "../extensions/aipi/runtime/memory-doctor.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_AUDIT_TIMEOUT_MS = 120_000;

export function parseReleaseCheckArgs(argv = []) {
  const options = {
    json: false,
    strict: false,
    skipTest: false,
    skipAudit: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    auditTimeoutMs: DEFAULT_AUDIT_TIMEOUT_MS,
    cacheRoot: null,
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
    if (arg === "--skip-test") {
      options.skipTest = true;
      continue;
    }
    if (arg === "--skip-audit") {
      options.skipAudit = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = positiveNumberArg(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--audit-timeout-ms") {
      options.auditTimeoutMs = positiveNumberArg(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--cache-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("release check --cache-root requires a directory");
      options.cacheRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown release check option: ${arg}`);
  }
  return options;
}

export async function runReleaseCheck({
  argv = [],
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  runner = runCommand,
  memoryVerifier = defaultMemoryVerifier,
} = {}) {
  let options;
  try {
    options = parseReleaseCheckArgs(argv);
  } catch (error) {
    stderr.write(`AIPI_RELEASE_CHECK_ERROR ${error.message}\n`);
    return { exitCode: 2, report: null };
  }

  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const cacheRoot = options.cacheRoot ?? env.AIPI_RELEASE_CACHE_ROOT ?? path.join(env.TEMP ?? env.TMP ?? os.tmpdir(), "aipi-release-check-cache");
  const checks = [];

  if (options.skipTest) {
    checks.push(skippedCheck("npm_test", "skipped by --skip-test"));
  } else {
    checks.push(await commandCheck({
      id: "npm_test",
      command: process.execPath,
      args: [npmCli, "test"],
      cwd,
      env,
      timeoutMs: options.timeoutMs,
      runner,
    }));
  }

  checks.push(await commandCheck({
    id: "npm_pack_dry_run",
    command: process.execPath,
    args: [
      npmCli,
      "pack",
      "--dry-run",
      "--json",
      "--cache",
      path.join(cacheRoot, "pack"),
    ],
    cwd,
    env,
    timeoutMs: options.timeoutMs,
    runner,
    parse: parsePackOutput,
  }));

  if (options.skipAudit) {
    checks.push(skippedCheck("npm_audit", "skipped by --skip-audit"));
  } else {
    checks.push(await commandCheck({
      id: "npm_audit",
      command: process.execPath,
      args: [
        npmCli,
        "run",
        "release:audit",
        "--",
        "--json",
        "--timeout-ms",
        String(options.auditTimeoutMs),
        "--cache",
        path.join(cacheRoot, "audit"),
      ],
      cwd,
      env,
      timeoutMs: options.auditTimeoutMs + 15_000,
      runner,
      parse: parseAuditOutput,
      allowExternalUnavailable: true,
    }));
  }

  // In-process memory-subsystem gate (P3-audit). Fail-safe: a verify that cannot complete is a FAILURE, not a
  // silent pass. On a project with no durable memory (e.g. the engine repo) it is a clean pass.
  checks.push(await memoryVerifyCheck({ cwd, strict: options.strict, verifier: memoryVerifier }));

  const report = buildReleaseReport({ checks });
  stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReleaseReport(report)}\n`);
  if (options.strict && report.status !== "pass") return { exitCode: 1, report };
  return { exitCode: report.status === "fail" ? 1 : 0, report };
}

export function buildReleaseReport({ checks }) {
  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "external_unavailable")
      ? "external_unavailable"
      : checks.some((check) => check.status === "skipped")
        ? "incomplete"
        : "pass";
  return {
    schema: "aipi.release-check.v1",
    status,
    checks,
  };
}

export function formatReleaseReport(report) {
  return [
    `AIPI release check: ${report.status}`,
    ...report.checks.map((check) => `- ${check.id}: ${check.status}${check.reason ? ` (${check.reason})` : ""}`),
  ].join("\n");
}

async function commandCheck({
  id,
  command,
  args,
  cwd,
  env,
  timeoutMs,
  runner,
  parse = null,
  allowExternalUnavailable = false,
}) {
  const result = await runner({ command, args, cwd, env, timeoutMs });
  const parsed = parse ? parse(result) : {};
  const timedOut = result.signal === "timeout";
  const status = parsed.status
    ?? (result.code === 0 ? "pass" : timedOut || allowExternalUnavailable ? "external_unavailable" : "fail");
  return {
    id,
    status,
    reason: parsed.reason ?? (status === "pass" ? "command completed successfully" : timedOut ? "command timed out" : "command failed"),
    command: [command, ...args],
    exit_code: result.code,
    signal: result.signal ?? null,
    detail: parsed.detail ?? null,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}

function parsePackOutput(result) {
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const first = Array.isArray(parsed) ? parsed[0] : null;
    return {
      status: "pass",
      reason: "npm pack dry-run completed",
      detail: first
        ? {
            name: first.name,
            version: first.version,
            filename: first.filename,
            entry_count: first.entryCount,
            unpacked_size: first.unpackedSize,
          }
        : null,
    };
  } catch {
    return {
      status: "fail",
      reason: "npm pack dry-run did not emit parseable JSON",
    };
  }
}

function parseAuditOutput(result) {
  const match = String(result.stdout ?? "").match(/\{\s*"schema"\s*:\s*"aipi\.npm-audit-release-check\.v1"[\s\S]*\}\s*$/);
  if (!match) return null;
  try {
    const report = JSON.parse(match[0]);
    return {
      status: report.status,
      reason: report.reason,
      detail: {
        schema: report.schema,
        status: report.status,
        exit_code: report.exit_code,
        signal: report.signal,
      },
    };
  } catch {
    return null;
  }
}

async function defaultMemoryVerifier({ cwd, strict }) {
  const doctor = await runMemoryDoctor({ projectRoot: cwd });
  return verifyMemory(doctor, { strict });
}

async function memoryVerifyCheck({ cwd, strict, verifier }) {
  try {
    const verify = await verifier({ cwd, strict });
    return {
      id: "memory_verify",
      status: verify.ok ? "pass" : "fail",
      reason: verify.ok
        ? `memory subsystem healthy (rules=${verify.counts.rules}, open_drifts=${verify.counts.open_drifts})`
        : `memory verify failed: ${verify.errors} error, ${verify.warnings} warn`,
      command: ["memory", "verify", strict ? "--strict" : "--lenient"],
      exit_code: verify.ok ? 0 : 1,
      signal: null,
      detail: { schema: verify.schema, ok: verify.ok, strict: verify.strict, counts: verify.counts, problems: verify.problems },
      stdout_tail: "",
      stderr_tail: "",
    };
  } catch (error) {
    return {
      id: "memory_verify",
      status: "fail",
      reason: `memory verify could not complete: ${String(error?.message ?? error)}`,
      command: ["memory", "verify"],
      exit_code: null,
      signal: "verify_error",
      detail: null,
      stdout_tail: "",
      stderr_tail: "",
    };
  }
}

function skippedCheck(id, reason) {
  return {
    id,
    status: "skipped",
    reason,
    command: [],
    exit_code: null,
    signal: null,
    detail: null,
    stdout_tail: "",
    stderr_tail: "",
  };
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

function positiveNumberArg(argv, index, flag) {
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`release check ${flag} requires a positive number`);
  return value;
}

function tail(value, limit = 4000) {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(-limit) : text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runReleaseCheck({ argv: process.argv.slice(2) });
  process.exitCode = result.exitCode;
}
