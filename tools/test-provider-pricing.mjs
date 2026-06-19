import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateProviderPricingConfig } from "../extensions/aipi/runtime/lifecycle-hooks.js";
import {
  checkProviderPricingFile,
  parseProviderPricingArgs,
} from "./check-provider-pricing.mjs";

const root = process.cwd();
const now = new Date("2026-06-17T00:00:00.000Z");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-provider-pricing-"));

try {
  assert.deepEqual(parseProviderPricingArgs(["--file", "x", "--strict", "--require-rates", "--json", "--now", "2026-06-17T00:00:00.000Z"]), {
    target: root,
    file: "x",
    json: true,
    strict: true,
    requireRates: true,
    now: "2026-06-17T00:00:00.000Z",
  });

  const emptyTemplate = JSON.parse(await fs.readFile(path.join(root, "templates", ".aipi", "provider-pricing.json"), "utf8"));
  const emptyReport = validateProviderPricingConfig(emptyTemplate, { now });
  assert.equal(emptyReport.valid, true);
  assert.equal(emptyReport.state, "empty");
  assert.equal(emptyReport.fresh_rate_count, 0);
  assert.match(emptyReport.warnings.join("\n"), /cost_unknown/);

  const fresh = {
    schema: "aipi.provider-pricing.v1",
    checked_at: "2026-06-16T00:00:00.000Z",
    source_url: "https://example.com/provider-pricing",
    max_age_days: 30,
    rates: {
      "anthropic:claude-estimated": {
        input_per_million_tokens: 3,
        output_per_million_tokens: 15,
      },
    },
  };
  const freshReport = validateProviderPricingConfig(fresh, { now, requireRates: true });
  assert.equal(freshReport.valid, true);
  assert.equal(freshReport.state, "fresh");
  assert.deepEqual(freshReport.fresh_rates, ["anthropic:claude-estimated"]);

  const staleReport = validateProviderPricingConfig({
    ...fresh,
    checked_at: "2026-01-01T00:00:00.000Z",
  }, { now, requireRates: true });
  assert.equal(staleReport.valid, false);
  assert.match(staleReport.errors.join("\n"), /stale/);

  const missingSourceReport = validateProviderPricingConfig({
    ...fresh,
    source_url: null,
  }, { now, requireRates: true });
  assert.equal(missingSourceReport.valid, false);
  assert.match(missingSourceReport.errors.join("\n"), /source_url is required/);

  const futureReport = validateProviderPricingConfig({
    ...fresh,
    checked_at: "2026-06-18T00:00:00.000Z",
  }, { now, requireRates: true });
  assert.equal(futureReport.valid, false);
  assert.match(futureReport.errors.join("\n"), /checked_at cannot be in the future/);

  const overrideReport = validateProviderPricingConfig({
    ...fresh,
    checked_at: "2026-01-01T00:00:00.000Z",
    rates: {
      "anthropic:claude-estimated": {
        input_per_million_tokens: 3,
        output_per_million_tokens: 15,
        checked_at: "2026-06-16T00:00:00.000Z",
        source_url: "https://example.com/rate-level",
      },
    },
  }, { now, requireRates: true });
  assert.equal(overrideReport.valid, true);
  assert.equal(overrideReport.fresh_rate_count, 1);

  const invalidRateReport = validateProviderPricingConfig({
    ...fresh,
    rates: {
      "anthropic:bad": {
        input_per_million_tokens: -1,
      },
    },
  }, { now, requireRates: true });
  assert.equal(invalidRateReport.valid, false);
  assert.match(invalidRateReport.errors.join("\n"), /non-negative/);

  const fixture = path.join(tempRoot, "provider-pricing.json");
  await fs.writeFile(fixture, `${JSON.stringify(fresh, null, 2)}\n`);
  const fileReport = await checkProviderPricingFile({
    file: fixture,
    requireRates: true,
    now: "2026-06-17T00:00:00.000Z",
  });
  assert.equal(fileReport.valid, true);
  assert.equal(fileReport.fresh_rate_count, 1);

  const templateCli = await runNode([
    "tools/check-provider-pricing.mjs",
    "--file",
    path.join(root, "templates", ".aipi", "provider-pricing.json"),
    "--strict",
    "--json",
    "--now",
    "2026-06-17T00:00:00.000Z",
  ]);
  assert.equal(templateCli.code, 0);
  assert.equal(JSON.parse(templateCli.stdout).state, "empty");

  const requireRatesCli = await runNode([
    "tools/check-provider-pricing.mjs",
    "--file",
    path.join(root, "templates", ".aipi", "provider-pricing.json"),
    "--strict",
    "--require-rates",
    "--json",
    "--now",
    "2026-06-17T00:00:00.000Z",
  ]);
  assert.equal(requireRatesCli.code, 1);
  assert.match(JSON.parse(requireRatesCli.stdout).errors.join("\n"), /requires at least one fresh rate|no fresh usable rates/);

  console.log("AIPI_PROVIDER_PRICING_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
