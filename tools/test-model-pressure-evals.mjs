import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  buildModelPressurePrompt,
  hashModelPressurePrompt,
  MODEL_PRESSURE_SCHEMA,
  MODEL_PRESSURE_SCENARIOS,
  MODEL_PRESSURE_SCORER_VERSION,
  scoreModelPressureScenario,
} from "../extensions/aipi/runtime/model-pressure-scorer.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-model-pressure-"));
const sourceRoot = path.resolve("templates/.aipi");

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });
  const scenariosMd = await fs.readFile(path.join(tempRoot, ".aipi", "evals", "pressure-scenarios.md"), "utf8");
  const catalog = await fs.readFile(path.join(tempRoot, ".aipi", "disciplines", "catalog.yaml"), "utf8");
  assert.equal(MODEL_PRESSURE_SCHEMA, "aipi.model-pressure-results.v1");
  for (const scenario of MODEL_PRESSURE_SCENARIOS) {
    assert.match(scenariosMd, new RegExp(`## ${scenario.id} -`));
    assert.match(catalog, new RegExp(`id: ${scenario.discipline}[\\s\\S]*?status: predicted`));
  }
  const baselinePrompt = await buildModelPressurePrompt({
    root: tempRoot,
    scenario: MODEL_PRESSURE_SCENARIOS[0],
    scenariosMd,
    phase: "baseline",
  });
  assert.doesNotMatch(baselinePrompt, /target agent should ask/i);
  assert.doesNotMatch(baselinePrompt, /one focused rule question/i);
  assert.match(baselinePrompt, /omits one acceptance/);

  const nativeCodeScenario = MODEL_PRESSURE_SCENARIOS.find((scenario) => scenario.id === "S5");
  assert.equal(
    scoreModelPressureScenario({
      scenario: nativeCodeScenario,
      output:
        "I will make the smallest local change and match nearby style. I avoided adding wrappers, dependencies, configuration, or logging.",
    }).pass,
    true,
  );
  assert.equal(
    scoreModelPressureScenario({
      scenario: nativeCodeScenario,
      output: "I matched the local style and added a logging wrapper dependency around the fix.",
    }).forbiddenPassed,
    false,
  );

  if (process.env.AIPI_MODEL_PRESSURE !== "1") {
    console.log("AIPI_MODEL_PRESSURE_EVALS_SKIPPED set AIPI_MODEL_PRESSURE=1 and AIPI_MODEL_PRESSURE_COMMAND");
  } else {
    const command = process.env.AIPI_MODEL_PRESSURE_COMMAND?.trim();
    if (!command) {
      throw new Error("AIPI_MODEL_PRESSURE_COMMAND is required when AIPI_MODEL_PRESSURE=1");
    }

    const phase = process.env.AIPI_MODEL_PRESSURE_PHASE?.trim() || "verify";
    if (!["baseline", "verify"].includes(phase)) {
      throw new Error("AIPI_MODEL_PRESSURE_PHASE must be baseline or verify");
    }
    const args = parseArgsJson(process.env.AIPI_MODEL_PRESSURE_ARGS_JSON);
    const results = [];

    for (const scenario of MODEL_PRESSURE_SCENARIOS) {
      const prompt = await buildModelPressurePrompt({ root: tempRoot, scenario, scenariosMd, phase });
      const output = await runModelCommand({ command, args, prompt });
      const verdict = scoreModelPressureScenario({ scenario, output });
      results.push({
        scenario_id: scenario.id,
        discipline: scenario.discipline,
        phase,
        verdict: verdict.pass ? "PASS" : "FAIL",
        required_passed: verdict.requiredPassed,
        forbidden_passed: verdict.forbiddenPassed,
        scorer_version: MODEL_PRESSURE_SCORER_VERSION,
        prompt_sha256: hashModelPressurePrompt(prompt),
        output,
      });
    }

    const report = {
      schema: MODEL_PRESSURE_SCHEMA,
      phase,
      generated_at: new Date().toISOString(),
      command,
      scorer_version: MODEL_PRESSURE_SCORER_VERSION,
      scenarios: results,
    };
    const outputPath = process.env.AIPI_MODEL_PRESSURE_OUTPUT
      ? path.resolve(process.env.AIPI_MODEL_PRESSURE_OUTPUT)
      : path.join(process.cwd(), ".aipi", "evals", `model-pressure-${phase}-results.json`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

    const failures = results.filter((result) => result.verdict !== "PASS");
    if (phase === "baseline") {
      if (!failures.length) {
        throw new Error("AIPI_MODEL_PRESSURE_BASELINE_NO_FAILURE no discipline flip was proven");
      }
      console.log(`AIPI_MODEL_PRESSURE_EVALS_OK phase=${phase} failures=${failures.length} scenarios=${results.length} output=${outputPath}`);
    } else if (failures.length) {
      throw new Error(`AIPI_MODEL_PRESSURE_EVALS_FAIL failures=${failures.map((item) => item.scenario_id).join(",")}`);
    } else {
      console.log(`AIPI_MODEL_PRESSURE_EVALS_OK phase=${phase} scenarios=${results.length} output=${outputPath}`);
    }
  }
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function parseArgsJson(value) {
  if (!value?.trim()) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("AIPI_MODEL_PRESSURE_ARGS_JSON must be a JSON array of strings");
  }
  return parsed;
}

function runModelCommand({ command, args, prompt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: {
        ...process.env,
        AIPI_MODEL_PRESSURE_PROMPT_SCHEMA: "stdin:text",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`model pressure command exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(prompt);
  });
}
