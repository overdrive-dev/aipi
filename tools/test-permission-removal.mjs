import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import aipiExtension from "../extensions/aipi/index.js";
import { classifyAipiInvocation } from "../bin/aipi.js";
import { createAipiLifecycleHandlers } from "../extensions/aipi/runtime/lifecycle-hooks.js";
import { initProject } from "../extensions/aipi/runtime/project-init.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-permission-removal-"));
const removedModuleNames = [["parent", "policy"].join("-"), ["profile", "policy"].join("-")];
const oldDecision = ["APPROVAL", "REQUIRED"].join("_");
const removedTemplate = ["profiles", "json"].join(".");
const removedWrapperCommand = ["aipi", "profile"].join(" ");

try {
  await initProject({ sourceRoot: path.resolve("templates/.aipi"), targetRoot: tempRoot });
  const handlers = createAipiLifecycleHandlers({ projectRootResolver: () => tempRoot });

  assert.equal(
    await handlers.tool_call(
      { type: "tool_call", toolName: "write", input: { path: "src/app.js", content: "export const ok = true;" } },
      { cwd: tempRoot },
    ),
    undefined,
  );
  assert.equal(
    await handlers.user_bash(
      { type: "user_bash", command: "Set-Content src/app.js 'ok'", cwd: tempRoot },
      { cwd: tempRoot },
    ),
    undefined,
  );

  const commands = new Map();
  const hooks = [];
  aipiExtension({
    registerTool() {},
    registerCommand(name, config) {
      commands.set(name, config);
    },
    on(name) {
      hooks.push(name);
    },
  });
  assert.equal(commands.has(removedWrapperCommand.replace(" ", "-")), false);
  assert.deepEqual(classifyAipiInvocation(["profile", "list"]), { kind: "pass-through" });

  for (const rel of [
    path.join("extensions", "aipi", "runtime", `${removedModuleNames[0]}.js`),
    path.join("extensions", "aipi", "runtime", `${removedModuleNames[1]}.js`),
    path.join("templates", ".aipi", removedTemplate),
  ]) {
    assert.equal(await pathExists(path.join(process.cwd(), rel)), false, `${rel} should be removed`);
  }

  const scannedFiles = await listFiles(["extensions", "bin", "templates", "tools"]);
  for (const file of scannedFiles) {
    const text = await fs.readFile(file, "utf8");
    assert.equal(text.includes(removedModuleNames[0]), false, `${file} references removed parent module`);
    assert.equal(text.includes(removedModuleNames[1]), false, `${file} references removed profile module`);
    assert.equal(text.includes(oldDecision), false, `${file} references removed policy decision`);
    assert.equal(text.includes(removedTemplate), false, `${file} references removed profile template`);
    assert.equal(text.includes(removedWrapperCommand), false, `${file} references removed wrapper command`);
  }

  console.log("AIPI_PERMISSION_REMOVAL_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function listFiles(dirs) {
  const out = [];
  for (const dir of dirs) {
    await walk(path.resolve(dir), out);
  }
  return out;
}

async function walk(current, out) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, out);
      continue;
    }
    out.push(fullPath);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
