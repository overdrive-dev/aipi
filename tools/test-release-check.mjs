import assert from "node:assert/strict";
import {
  buildReleaseReport,
  parseReleaseCheckArgs,
  runReleaseCheck,
} from "./run-release-check.mjs";

assert.deepEqual(parseReleaseCheckArgs(["--json", "--strict", "--timeout-ms", "5000", "--audit-timeout-ms", "3000", "--cache-root", "C:/tmp/aipi-release"]), {
  json: true,
  strict: true,
  skipTest: false,
  skipAudit: false,
  timeoutMs: 5000,
  auditTimeoutMs: 3000,
  cacheRoot: "C:/tmp/aipi-release",
});
assert.equal(parseReleaseCheckArgs(["--skip-test", "--skip-audit"]).skipTest, true);
assert.throws(() => parseReleaseCheckArgs(["--timeout-ms", "0"]), /positive number/);

const aggregate = buildReleaseReport({
  checks: [
    { id: "npm_test", status: "pass" },
    { id: "npm_pack_dry_run", status: "pass" },
    { id: "npm_audit", status: "external_unavailable" },
  ],
});
assert.equal(aggregate.schema, "aipi.release-check.v1");
assert.equal(aggregate.status, "external_unavailable");

const seen = [];
const stdout = [];
const result = await runReleaseCheck({
  argv: ["--json", "--strict", "--timeout-ms", "1000", "--audit-timeout-ms", "1000", "--cache-root", "C:/tmp/aipi-release"],
  env: { TEMP: "C:/tmp" },
  stdout: { write: (chunk) => stdout.push(chunk) },
  stderr: { write: () => {} },
  runner: async ({ args }) => {
    seen.push(args.join(" "));
    if (args.includes("test")) return { code: 0, signal: null, stdout: "tests ok", stderr: "" };
    if (args.includes("pack")) {
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify([{ name: "aipi-templates", version: "0.1.0", filename: "aipi-templates-0.1.0.tgz", entryCount: 84, unpackedSize: 1234 }]),
        stderr: "",
      };
    }
    if (args.includes("release:audit")) {
      return {
        code: 1,
        signal: null,
        stdout: JSON.stringify({
          schema: "aipi.npm-audit-release-check.v1",
          status: "external_unavailable",
          reason: "npm audit registry endpoint unavailable",
          exit_code: 1,
          signal: null,
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  },
});
assert.equal(result.exitCode, 1);
assert.equal(result.report.status, "external_unavailable");
assert.equal(result.report.checks.find((check) => check.id === "npm_pack_dry_run").detail.entry_count, 84);
assert.equal(JSON.parse(stdout.join("")).schema, "aipi.release-check.v1");
assert.equal(seen.some((entry) => entry.includes("npm-cli.js test")), true);
assert.equal(seen.some((entry) => entry.includes("pack --dry-run --json")), true);
assert.equal(seen.some((entry) => entry.includes("run release:audit")), true);

const skippedOutput = [];
const skipped = await runReleaseCheck({
  argv: ["--json", "--skip-test", "--skip-audit"],
  stdout: { write: (chunk) => skippedOutput.push(chunk) },
  stderr: { write: () => {} },
  runner: async ({ args }) => {
    assert.equal(args.includes("pack"), true);
    return {
      code: 0,
      signal: null,
      stdout: JSON.stringify([{ name: "aipi-templates", entryCount: 84 }]),
      stderr: "",
    };
  },
});
assert.equal(skipped.exitCode, 0);
assert.equal(JSON.parse(skippedOutput.join("")).status, "incomplete");

console.log("AIPI_RELEASE_CHECK_TEST_OK");
