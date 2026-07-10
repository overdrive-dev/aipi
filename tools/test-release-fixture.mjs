import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-release-fixture-"));
const installedRoot = path.join(tempRoot, "installed-package");
const projectRoot = path.join(tempRoot, "clean-project");

try {
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  await materializePackageFiles({ packageJson, sourceRoot: repoRoot, targetRoot: installedRoot });
  await fs.mkdir(projectRoot, { recursive: true });

  assert.equal(await exists(path.join(installedRoot, "tools")), false, "release package must not ship test tools");
  assert.equal(await exists(path.join(installedRoot, "bin", "aipi.js")), true);
  assert.equal(await exists(path.join(installedRoot, "extensions", "aipi", "index.js")), true);
  assert.equal(await exists(path.join(installedRoot, "extensions", "aipi", ["pi", "subagents", "embedded"].join("-") + ".js")), false);
  assert.equal(await exists(path.join(installedRoot, "extensions", "aipi", "provider", "anthropic-oauth-only.ts")), true);
  assert.equal(await exists(path.join(installedRoot, "extensions", "aipi", "provider", "xai-oauth.ts")), true);
  assert.equal(await exists(path.join(installedRoot, "templates", ".aipi", "runtime-contract.json")), true);
  assert.equal(await exists(path.join(installedRoot, "NOTICE.md")), true);

  const bin = await import(pathToFileURL(path.join(installedRoot, "bin", "aipi.js")).href);
  assert.equal(bin.readAipiPackageVersion({ packageRoot: installedRoot }), packageJson.version);
  assert.deepEqual(
    bin.aipiExtensionPaths({ packageRoot: installedRoot }).map((entry) => path.relative(installedRoot, entry).replaceAll("\\", "/")),
    [
      "extensions/aipi/provider/anthropic-oauth-only.ts",
      "extensions/aipi/provider/xai-oauth.ts",
      "extensions/aipi/index.js",
    ],
  );

  const projectInit = await import(
    pathToFileURL(path.join(installedRoot, "extensions", "aipi", "runtime", "project-init.js")).href
  );
  const summary = await projectInit.initProject({
    sourceRoot: path.join(installedRoot, "templates", ".aipi"),
    targetRoot: projectRoot,
  });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.force, false);
  assert.ok(summary.copiedFiles > 20);

  for (const rel of [
    ".aipi/runtime-contract.json",
    ".aipi/agents/catalog.yaml",
    ".aipi/model-classes.yaml",
    ".aipi/model-capabilities.json",
    ".aipi/workflows/quick.yaml",
    ".aipi/memory/project/README.md",
    ".aipi/protocols/workflow-contract.md",
  ]) {
    assert.equal(await exists(path.join(projectRoot, rel)), true, `fixture project missing ${rel}`);
  }

  const projectMemory = path.join(projectRoot, ".aipi", "memory", "project", "project.md");
  await fs.writeFile(projectMemory, "fixture-local-memory\n");
  const forced = await projectInit.initProject({
    sourceRoot: path.join(installedRoot, "templates", ".aipi"),
    targetRoot: projectRoot,
    force: true,
  });
  assert.ok(forced.protectedFiles > 0);
  assert.equal(await fs.readFile(projectMemory, "utf8"), "fixture-local-memory\n");

  const statusJson = [];
  const statusErrors = [];
  const statusReport = await bin.runAipiStatus({
    packageRoot: installedRoot,
    cwd: tempRoot,
    userArgs: ["--target", projectRoot, "--json"],
    log: (line) => statusJson.push(line),
    errorLog: (line) => statusErrors.push(line),
    homeDir: path.join(tempRoot, "home"),
    env: {},
  });
  assert.equal(statusErrors.length, 0);
  assert.equal(statusJson.length, 1);
  const printedStatus = JSON.parse(statusJson[0]);
  assert.equal(printedStatus.project.installed, true);
  assert.equal(statusReport.readiness.schema, "aipi.readiness-report.v1");
  assert.equal(statusReport.readiness.status, "blocked");
  assert.equal(statusReport.readiness.blockers.includes("provider.anthropic.auth"), true);
  assert.equal(statusReport.readiness.blockers.includes("model.capability_floors"), false);
  assert.equal(statusReport.readiness.external_evidence_needed.includes("pressure.model_backed"), true);
  assert.equal(statusReport.readiness.external_evidence_needed.includes("smoke.live_subagent"), true);

  const oldExitCode = process.exitCode;
  const strictStatusOutput = [];
  try {
    process.exitCode = 0;
    await bin.runAipiStatus({
      packageRoot: installedRoot,
      cwd: tempRoot,
      userArgs: ["--target", projectRoot, "--strict"],
      log: (line) => strictStatusOutput.push(line),
      errorLog: (line) => statusErrors.push(line),
      homeDir: path.join(tempRoot, "home"),
      env: {},
    });
    assert.equal(process.exitCode, 1);
    assert.match(strictStatusOutput.join("\n"), /Readiness: blocked/);
  } finally {
    process.exitCode = oldExitCode;
  }

  console.log("AIPI_RELEASE_FIXTURE_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function materializePackageFiles({ packageJson, sourceRoot, targetRoot }) {
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.copyFile(path.join(sourceRoot, "package.json"), path.join(targetRoot, "package.json"));
  for (const entry of packageJson.files ?? []) {
    if (entry.endsWith("/**")) {
      const relDir = entry.slice(0, -3);
      await fs.cp(path.join(sourceRoot, relDir), path.join(targetRoot, relDir), {
        recursive: true,
        force: true,
      });
      continue;
    }
    const source = path.join(sourceRoot, entry);
    const target = path.join(targetRoot, entry);
    const stat = await fs.stat(source);
    if (stat.isDirectory()) {
      await fs.cp(source, target, { recursive: true, force: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
  }
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
