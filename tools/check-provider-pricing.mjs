#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateProviderPricingConfig } from "../extensions/aipi/runtime/lifecycle-hooks.js";

export function parseProviderPricingArgs(argv = []) {
  const out = {
    target: process.cwd(),
    file: null,
    json: false,
    strict: false,
    requireRates: false,
    now: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") out.target = argv[++index];
    else if (arg === "--file") out.file = argv[++index];
    else if (arg === "--json") out.json = true;
    else if (arg === "--strict") out.strict = true;
    else if (arg === "--require-rates") out.requireRates = true;
    else if (arg === "--now") out.now = argv[++index];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

export async function checkProviderPricingFile({
  target = process.cwd(),
  file = null,
  requireRates = false,
  now = null,
} = {}) {
  const filePath = path.resolve(file ?? path.join(target, ".aipi", "provider-pricing.json"));
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      path: filePath,
      ...validateProviderPricingConfig(parsed, {
        now: now ? new Date(now) : new Date(),
        requireRates,
      }),
    };
  } catch (error) {
    return {
      schema: "aipi.provider-pricing-validation.v1",
      path: filePath,
      valid: false,
      state: "invalid",
      rate_count: 0,
      fresh_rate_count: 0,
      fresh_rates: [],
      errors: [`provider-pricing read failed: ${error.message}`],
      warnings: [],
    };
  }
}

export function formatProviderPricingReport(report) {
  const lines = [
    `provider-pricing: ${report.valid ? "ok" : "failed"}`,
    `path: ${report.path}`,
    `state: ${report.state}`,
    `rates: ${report.fresh_rate_count}/${report.rate_count} fresh`,
  ];
  for (const warning of report.warnings ?? []) lines.push(`warning: ${warning}`);
  for (const error of report.errors ?? []) lines.push(`error: ${error}`);
  return `${lines.join("\n")}\n`;
}

export async function runProviderPricingCheck({
  args = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let options;
  try {
    options = parseProviderPricingArgs(args);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write([
      "Usage: node tools/check-provider-pricing.mjs [--target <dir> | --file <json>] [--strict] [--require-rates] [--json] [--now <iso>]",
      "",
      "Validates .aipi/provider-pricing.json freshness and source metadata.",
      "Empty rates are allowed unless --require-rates is set; unpriced provider usage remains cost_unknown.",
      "",
    ].join("\n"));
    return 0;
  }
  const report = await checkProviderPricingFile(options);
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(formatProviderPricingReport(report));
  return options.strict && !report.valid ? 1 : 0;
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? fileURLToPath(pathToFileURL(path.resolve(process.argv[1]))) : null;
if (invokedFile === thisFile) {
  process.exitCode = await runProviderPricingCheck();
}
