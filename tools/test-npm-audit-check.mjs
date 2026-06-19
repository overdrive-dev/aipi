import assert from "node:assert/strict";
import {
  formatAuditReport,
  parseNpmAuditArgs,
  runNpmAuditReleaseCheck,
} from "./check-npm-audit.mjs";

assert.deepEqual(parseNpmAuditArgs(["--json", "--strict", "--timeout-ms", "5000", "--cache", "C:/tmp/aipi-audit"]), {
  json: true,
  strict: true,
  timeoutMs: 5000,
  cache: "C:/tmp/aipi-audit",
});
assert.throws(() => parseNpmAuditArgs(["--timeout-ms", "0"]), /positive number/);

const passReport = formatAuditReport({
  result: { code: 0, signal: null, stdout: "found 0 vulnerabilities\n", stderr: "" },
  command: "node",
  args: ["npm-cli.js", "audit"],
  timeoutMs: 120000,
});
assert.equal(passReport.schema, "aipi.npm-audit-release-check.v1");
assert.equal(passReport.status, "pass");

const registryReport = formatAuditReport({
  result: {
    code: 1,
    signal: null,
    stdout: "undefined\n",
    stderr: "npm error audit endpoint returned an error\n",
  },
  command: "node",
  args: ["npm-cli.js", "audit"],
  timeoutMs: 120000,
});
assert.equal(registryReport.status, "external_unavailable");
assert.match(registryReport.reason, /registry endpoint unavailable/);

const vulnReport = formatAuditReport({
  result: {
    code: 1,
    signal: null,
    stdout: "1 high severity vulnerability\n",
    stderr: "",
  },
  command: "node",
  args: ["npm-cli.js", "audit"],
  timeoutMs: 120000,
});
assert.equal(vulnReport.status, "fail");

const strictOutput = [];
const strictResult = await runNpmAuditReleaseCheck({
  argv: ["--json", "--strict"],
  env: { TEMP: "C:/tmp" },
  stdout: { write: (chunk) => strictOutput.push(chunk) },
  stderr: { write: () => {} },
  runner: async () => ({
    code: null,
    signal: "timeout",
    stdout: "",
    stderr: "",
  }),
});
assert.equal(strictResult.exitCode, 1);
assert.equal(strictResult.report.status, "external_unavailable");
assert.equal(JSON.parse(strictOutput.join("")).status, "external_unavailable");

console.log("AIPI_NPM_AUDIT_CHECK_TEST_OK");
