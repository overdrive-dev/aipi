import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatInitSummary,
  initProject,
  parseInitArgs,
  resolveProjectRoot,
} from "../extensions/aipi/runtime/project-init.js";

const sourceRoot = path.resolve("templates/.aipi");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-init-"));

try {
  assert.deepEqual(parseInitArgs("--dry-run --force --target C:\\repo"), {
    dryRun: true,
    force: true,
    resetMemory: false,
    noOnboard: false,
    targetRoot: "C:\\repo",
  });
  assert.deepEqual(parseInitArgs("--force --reset-memory --no-onboard"), {
    dryRun: false,
    force: true,
    resetMemory: true,
    noOnboard: true,
    targetRoot: null,
  });
  assert.throws(() => parseInitArgs("--reset-memory"), /requires --force/);
  assert.equal(resolveProjectRoot({ project: { root: tempRoot } }), tempRoot);

  const first = await initProject({ sourceRoot, targetRoot: tempRoot });
  assert.equal(first.dryRun, false);
  assert.equal(first.force, false);
  assert.ok(first.copiedFiles > 20);
  assert.equal(first.skippedFiles, 0);
  assert.match(formatInitSummary(first), /AIPI init applied/);

  const targetProjectMemory = path.join(tempRoot, ".aipi", "memory", "project", "project.md");
  const originalProjectMemory = await fs.readFile(targetProjectMemory, "utf8");
  assert.match(originalProjectMemory, /# Project Context/);

  await fs.writeFile(targetProjectMemory, "local project memory\n");
  const second = await initProject({ sourceRoot, targetRoot: tempRoot });
  assert.ok(second.skippedFiles > 20);
  assert.equal(await fs.readFile(targetProjectMemory, "utf8"), "local project memory\n");

  const dryForce = await initProject({
    sourceRoot,
    targetRoot: tempRoot,
    dryRun: true,
    force: true,
  });
  assert.ok(dryForce.overwrittenFiles > 20);
  assert.ok(dryForce.protectedFiles > 0);
  assert.equal(await fs.readFile(targetProjectMemory, "utf8"), "local project memory\n");

  const forced = await initProject({ sourceRoot, targetRoot: tempRoot, force: true });
  assert.ok(forced.overwrittenFiles > 20);
  assert.ok(forced.protectedFiles > 0);
  assert.equal(await fs.readFile(targetProjectMemory, "utf8"), "local project memory\n");
  assert.match(formatInitSummary(forced), /project memory protected/);

  const resetMemory = await initProject({
    sourceRoot,
    targetRoot: tempRoot,
    force: true,
    resetMemory: true,
  });
  assert.ok(resetMemory.overwrittenFiles > forced.overwrittenFiles);
  assert.equal(resetMemory.protectedFiles, 0);
  assert.equal(await fs.readFile(targetProjectMemory, "utf8"), originalProjectMemory);
  assert.match(formatInitSummary(resetMemory), /memory reset enabled/);

  assert.throws(() => parseInitArgs("--unknown"), /Unknown \/aipi-init option/);

  console.log("AIPI_PROJECT_INIT_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
