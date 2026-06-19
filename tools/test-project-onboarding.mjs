import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  maybeRunPostInitOnboarding,
  runProjectOnboarding,
} from "../extensions/aipi/runtime/onboarding.js";
import { rebuildCodeGraph } from "../extensions/aipi/runtime/aipi-tools.js";

const sourceRoot = path.resolve("templates/.aipi");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-project-onboarding-"));

try {
  await writeFixtureRepo(tempRoot);
  await initProject({ sourceRoot, targetRoot: tempRoot });

  const projectMemoryPath = path.join(tempRoot, ".aipi", "memory", "project", "project.md");
  const originalProjectMemory = await fs.readFile(projectMemoryPath, "utf8");
  assert.match(originalProjectMemory, /seeded by `\/aipi-init`/i);

  let graphBuilderCalled = false;
  const onboarded = await runProjectOnboarding({
    projectRoot: tempRoot,
    answers: {
      purpose: "Nora App coordinates mobile care workflows.",
      domain: "patients, appointments, clinical tasks",
      validation: "npm test; pytest",
    },
    askUser: false,
    runWorker: false,
    now: () => new Date("2026-06-19T12:00:00.000Z"),
    graphBuilder: async (input) => {
      graphBuilderCalled = true;
      return rebuildCodeGraph(input);
    },
  });

  assert.equal(onboarded.action, "onboard");
  assert.equal(graphBuilderCalled, true);
  assert.equal(onboarded.memory.written.includes("project.md"), true);
  assert.equal(onboarded.graph.sqlite_path, ".aipi/state/aipi-graph.sqlite");
  assert.ok(onboarded.graph.file_count > 0);
  await fs.access(path.join(tempRoot, ".aipi", "state", "aipi-graph.json"));
  if (onboarded.graph.sqlite_status === "available") {
    await fs.access(path.join(tempRoot, ".aipi", "state", "aipi-graph.sqlite"));
  }

  const seededProjectMemory = await fs.readFile(projectMemoryPath, "utf8");
  assert.doesNotMatch(seededProjectMemory, /Replace this section during/);
  assert.match(seededProjectMemory, /Nora App coordinates mobile care workflows/);
  assert.match(seededProjectMemory, /React Native/);
  assert.match(seededProjectMemory, /Python/);
  assert.match(seededProjectMemory, /frontend\/|backend\//);

  const customized = `${seededProjectMemory}\n<!-- user-customized -->\n`;
  await fs.writeFile(projectMemoryPath, customized);
  const rerun = await runProjectOnboarding({
    projectRoot: tempRoot,
    answers: { purpose: "replacement should not clobber" },
    askUser: false,
    runWorker: false,
    materializeGraph: false,
  });
  assert.equal(rerun.memory.skipped_customized.includes("project.md"), true);
  assert.equal(await fs.readFile(projectMemoryPath, "utf8"), customized);

  const spawnCalls = [];
  const notifications = [];
  const skippedHeadless = await maybeRunPostInitOnboarding({
    projectRoot: tempRoot,
    ctx: {
      hasUI: false,
      ui: {
        notify(message) {
          notifications.push(message);
        },
      },
    },
    coordinator: {
      spawn(params) {
        spawnCalls.push(params);
      },
    },
  });
  assert.equal(skippedHeadless.action, "skipped");
  assert.equal(skippedHeadless.reason, "non_interactive");
  assert.match(skippedHeadless.message, /\/aipi-onboard/);
  assert.equal(spawnCalls.length, 0);

  const skippedNoModel = await maybeRunPostInitOnboarding({
    projectRoot: tempRoot,
    ctx: {
      hasUI: true,
      ui: { input: async () => "", notify() {} },
    },
    coordinator: {
      spawn(params) {
        spawnCalls.push(params);
      },
    },
  });
  assert.equal(skippedNoModel.action, "skipped");
  assert.equal(skippedNoModel.reason, "no_host_model");
  assert.equal(spawnCalls.length, 0);

  console.log("AIPI_PROJECT_ONBOARDING_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function writeFixtureRepo(root) {
  await fs.mkdir(path.join(root, "frontend", "src"), { recursive: true });
  await fs.mkdir(path.join(root, "backend"), { recursive: true });
  await fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "nora-app",
      scripts: {
        start: "expo start",
        test: "jest",
        build: "expo export",
      },
      dependencies: {
        expo: "^50.0.0",
        "react-native": "^0.74.0",
      },
      devDependencies: {
        jest: "^29.0.0",
        typescript: "^5.0.0",
      },
    }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(root, "frontend", "src", "App.tsx"), "export default function App() { return null; }\n");
  await fs.writeFile(path.join(root, "backend", "app.py"), "def health():\n    return {'ok': True}\n");
  await fs.writeFile(path.join(root, "backend", "requirements.txt"), "fastapi\npytest\n");
  await fs.writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  await fs.writeFile(path.join(root, "Dockerfile"), "FROM python:3.12-slim\n");
}
