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
  const coordinator = createDoneCoordinator();
  const selectCalls = [];
  const inputCalls = [];
  const progressEvents = [];
  const autoPullFetch = fakeAutoPullEmbeddingFetch();
  const onboarded = await runProjectOnboarding({
    projectRoot: tempRoot,
    ctx: {
      hasUI: true,
      ui: {
        select(question, options) {
          selectCalls.push({ question, options });
          return options[0];
        },
        input(question) {
          inputCalls.push(question);
          return "";
        },
      },
    },
    coordinator,
    hostModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
    askUser: true,
    runWorker: true,
    now: () => new Date("2026-06-19T12:00:00.000Z"),
    onProgress: (event) => {
      progressEvents.push(event);
    },
    graphBuilder: async (input) => {
      graphBuilderCalled = true;
      return rebuildCodeGraph({ ...input, embeddingFetch: autoPullFetch.fetch });
    },
  });

  assert.equal(onboarded.action, "onboard");
  assert.equal(graphBuilderCalled, true);
  assert.equal(onboarded.investigation.mode, "swarm");
  assert.equal(onboarded.investigation.spawned_count > 1, true);
  assert.equal(coordinator.spawned.length > 1, true);
  assert.equal(progressEvents.length > 1, true);
  assert.equal(
    progressEvents.filter((event) => event.phase === "investigation" && event.status === "spawned").length,
    onboarded.investigation.spawned_count,
  );
  assert.equal(
    progressEvents.filter((event) => event.phase === "investigation" && event.worker_id && event.status === "done").length,
    onboarded.investigation.spawned_count,
  );
  assert.equal(selectCalls.length, 0);
  assert.equal(inputCalls.length, 0);
  assert.equal(onboarded.memory.written.includes("project.md"), true);
  assert.equal(onboarded.graph.sqlite_path, ".aipi/state/aipi-graph.sqlite");
  assert.ok(onboarded.graph.file_count > 0);
  assert.equal(onboarded.graph.embedding_model, "bge-m3");
  assert.equal(autoPullFetch.pullCalls, 1);
  assert.equal(autoPullFetch.embedCalls > 0, true);
  assert.equal(onboarded.embedding_pull.status, "success");
  assert.equal(onboarded.semantic_readiness, null);
  assert.equal(onboarded.graph.vector_status, "available");
  assert.equal(progressEvents.some((event) => event.phase === "semantic-pull" && event.status === "running"), true);
  await fs.access(path.join(tempRoot, ".aipi", "state", "aipi-graph.json"));
  assert.match(await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "onboarding", "onboarding.jsonl"), "utf8"), /"embedding_pull":\{"status":"success"|bge-m3/);
  if (onboarded.graph.sqlite_status === "available") {
    await fs.access(path.join(tempRoot, ".aipi", "state", "aipi-graph.sqlite"));
  }

  const seededProjectMemory = await fs.readFile(projectMemoryPath, "utf8");
  assert.doesNotMatch(seededProjectMemory, /Replace this section during/);
  assert.match(seededProjectMemory, /nora-app appears|React Native/);
  assert.match(seededProjectMemory, /React Native/);
  assert.match(seededProjectMemory, /Python/);
  assert.match(seededProjectMemory, /frontend\/|backend\//);
  assert.doesNotMatch(seededProjectMemory, /Which validation command|Which business rules|safe for builder role/);

  const businessRulesMemory = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8");
  assert.match(businessRulesMemory, /Candidate business\/domain context inferred from code/);
  assert.match(businessRulesMemory, /care workflows|patient|clinical|task/);

  const noPullRoot = path.join(tempRoot, "no-pull-repo");
  await writeFixtureRepo(noPullRoot);
  await initProject({ sourceRoot, targetRoot: noPullRoot });
  const noPullFetch = fakeNoPullMissingModelFetch();
  const noPullRun = await runProjectOnboarding({
    projectRoot: noPullRoot,
    askUser: false,
    runWorker: false,
    pullEmbeddings: false,
    graphBuilder: async (input) => rebuildCodeGraph({ ...input, embeddingFetch: noPullFetch.fetch }),
  });
  assert.equal(noPullFetch.pullCalls, 0);
  assert.equal(noPullRun.embedding_pull.status, "skipped");
  assert.match(noPullRun.semantic_readiness.message, /ollama pull bge-m3/);

  const envNoPullRoot = path.join(tempRoot, "env-no-pull-repo");
  await writeFixtureRepo(envNoPullRoot);
  await initProject({ sourceRoot, targetRoot: envNoPullRoot });
  const envNoPullFetch = fakeNoPullMissingModelFetch();
  const envNoPullRun = await runProjectOnboarding({
    projectRoot: envNoPullRoot,
    askUser: false,
    runWorker: false,
    env: { AIPI_PULL_EMBEDDINGS: "0" },
    graphBuilder: async (input) => rebuildCodeGraph({ ...input, embeddingFetch: envNoPullFetch.fetch }),
  });
  assert.equal(envNoPullFetch.pullCalls, 0);
  assert.equal(envNoPullRun.embedding_pull.status, "skipped");

  const unreachableRoot = path.join(tempRoot, "ollama-unreachable-repo");
  await writeFixtureRepo(unreachableRoot);
  await initProject({ sourceRoot, targetRoot: unreachableRoot });
  const unreachableFetch = fakeUnreachableOllamaFetch();
  const unreachableRun = await runProjectOnboarding({
    projectRoot: unreachableRoot,
    askUser: false,
    runWorker: false,
    platform: "win32",
    graphBuilder: async (input) => rebuildCodeGraph({ ...input, embeddingFetch: unreachableFetch.fetch, platform: "win32" }),
  });
  assert.equal(unreachableFetch.pullCalls, 0);
  assert.match(unreachableRun.semantic_readiness.message, /winget install Ollama\.Ollama/);
  assert.match(unreachableRun.semantic_readiness.message, /AIPI will not install system software/);

  const pullFailureRoot = path.join(tempRoot, "pull-failure-repo");
  await writeFixtureRepo(pullFailureRoot);
  await initProject({ sourceRoot, targetRoot: pullFailureRoot });
  const pullFailureFetch = fakePullFailureFetch();
  const pullFailureRun = await runProjectOnboarding({
    projectRoot: pullFailureRoot,
    askUser: false,
    runWorker: false,
    graphBuilder: async (input) => rebuildCodeGraph({ ...input, embeddingFetch: pullFailureFetch.fetch }),
  });
  assert.equal(pullFailureFetch.pullCalls, 1);
  assert.equal(pullFailureRun.embedding_pull.status, "failed");
  assert.match(pullFailureRun.semantic_readiness.message, /Auto-pull failed/);
  assert.match(await fs.readFile(path.join(pullFailureRoot, ".aipi", "runtime", "onboarding", "onboarding.jsonl"), "utf8"), /"embedding_pull":\{"status":"failed"/);

  const emptyRoot = path.join(tempRoot, "empty-repo");
  await fs.mkdir(emptyRoot, { recursive: true });
  await initProject({ sourceRoot, targetRoot: emptyRoot });
  const recommendationCalls = [];
  const recommendationRun = await runProjectOnboarding({
    projectRoot: emptyRoot,
    ctx: {
      hasUI: true,
      ui: {
        select(question, options) {
          recommendationCalls.push({ question, options });
          return options[0];
        },
      },
    },
    askUser: true,
    runWorker: false,
    materializeGraph: false,
  });
  assert.equal(recommendationRun.recommendations.asked.length, 1);
  assert.equal(recommendationCalls.length, 1);
  assert.equal(recommendationCalls[0].options.length, 4);
  assert.equal(recommendationCalls[0].options.at(-1), "Other / free text");

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

function createDoneCoordinator() {
  const jobs = new Map();
  const coordinator = {
    spawned: [],
    spawn(params) {
      const agentId = `${params.agent_id}:${coordinator.spawned.length + 1}`;
      coordinator.spawned.push({ agent_id: agentId, params });
      jobs.set(agentId, params);
      return { agent_id: agentId };
    },
    status(agentId) {
      assert.ok(jobs.has(agentId), `unknown worker ${agentId}`);
      return { state: "done" };
    },
    collect(agentId) {
      const params = jobs.get(agentId);
      return {
        ready: true,
        step_result: { verdict: "PASS" },
        artifacts: params.expected_artifacts ?? [],
      };
    },
  };
  return coordinator;
}

function fakeAutoPullEmbeddingFetch() {
  let modelAvailable = false;
  let pullCalls = 0;
  let embedCalls = 0;
  return {
    get pullCalls() {
      return pullCalls;
    },
    get embedCalls() {
      return embedCalls;
    },
    async fetch(url, options = {}) {
      if (String(url).endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { models: modelAvailable ? [{ name: "bge-m3" }] : [] };
          },
        };
      }
      if (String(url).endsWith("/api/pull")) {
        pullCalls += 1;
        const body = JSON.parse(options.body ?? "{}");
        assert.equal(body.model ?? body.name, "bge-m3");
        modelAvailable = true;
        return pullStreamResponse([
          { status: "pulling manifest" },
          { status: "downloading", total: 100, completed: 40 },
          { status: "success", total: 100, completed: 100 },
        ]);
      }
      if (String(url).endsWith("/api/embed")) {
        embedCalls += 1;
        const body = JSON.parse(options.body ?? "{}");
        assert.equal(body.model, "bge-m3");
        const vector = new Array(1024).fill(0);
        vector[embedCalls % vector.length] = 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return { embeddings: [vector] };
          },
        };
      }
      throw new Error(`unexpected Ollama URL ${url}`);
    },
  };
}

function fakeNoPullMissingModelFetch() {
  let pullCalls = 0;
  return {
    get pullCalls() {
      return pullCalls;
    },
    async fetch(url) {
      if (String(url).endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { models: [] };
          },
        };
      }
      if (String(url).endsWith("/api/pull")) {
        pullCalls += 1;
        throw new Error("pull should not be called");
      }
      throw new Error(`unexpected Ollama URL ${url}`);
    },
  };
}

function fakeUnreachableOllamaFetch() {
  let pullCalls = 0;
  return {
    get pullCalls() {
      return pullCalls;
    },
    async fetch(url) {
      if (String(url).endsWith("/api/pull")) pullCalls += 1;
      throw new Error("connect ECONNREFUSED");
    },
  };
}

function fakePullFailureFetch() {
  let pullCalls = 0;
  return {
    get pullCalls() {
      return pullCalls;
    },
    async fetch(url) {
      if (String(url).endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { models: [] };
          },
        };
      }
      if (String(url).endsWith("/api/pull")) {
        pullCalls += 1;
        return pullStreamResponse([{ status: "pulling manifest" }, { error: "disk full" }]);
      }
      throw new Error(`unexpected Ollama URL ${url}`);
    },
  };
}

function pullStreamResponse(events) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => encoder.encode(`${JSON.stringify(event)}\n`));
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          },
        };
      },
    },
  };
}

function fakeMissingModelFetch() {
  return async (url) => {
    assert.match(String(url), /\/api\/tags$/);
    return {
      ok: true,
      status: 200,
      async json() {
        return { models: [] };
      },
    };
  };
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
  await fs.writeFile(path.join(root, "backend", "patients.py"), "class PatientCarePlan:\n    pass\n");
  await fs.writeFile(path.join(root, "backend", "appointments.py"), "def schedule_clinical_task():\n    return True\n");
  await fs.writeFile(path.join(root, "backend", "requirements.txt"), "fastapi\npytest\n");
  await fs.writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  await fs.writeFile(path.join(root, "Dockerfile"), "FROM python:3.12-slim\n");
}
