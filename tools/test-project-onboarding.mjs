import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  inventoryRepository,
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
  const domainRulesSpawn = coordinator.spawned.find((item) => item.params.step_id === "project_onboarding_domain-rules");
  assert.ok(domainRulesSpawn);
  assert.match(domainRulesSpawn.params.context_packet, /validation guards/);
  assert.match(domainRulesSpawn.params.context_packet, /CANDIDATE: <specific rule statement> \| source_ref:/);
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
  assert.match(seededProjectMemory, /onboarding_seeded: true/);
  assert.match(seededProjectMemory, /onboarding_schema_version: 2/);
  assert.match(seededProjectMemory, /nora-app appears|React Native/);
  assert.match(seededProjectMemory, /React Native/);
  assert.match(seededProjectMemory, /Python/);
  assert.match(seededProjectMemory, /frontend\/|backend\//);
  assert.doesNotMatch(seededProjectMemory, /Which validation command|Which business rules|safe for builder role/);

  const businessRulesMemory = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8");
  assert.match(businessRulesMemory, /Candidate business\/domain context inferred from code/);
  assert.match(businessRulesMemory, /care workflows|patient|clinical|task/);

  const docHeavyRoot = path.join(tempRoot, "doc-heavy-monorepo");
  await writeDocHeavyMonorepo(docHeavyRoot);
  const docHeavyInventory = await inventoryRepository(docHeavyRoot);
  assert.equal(docHeavyInventory.file_count > 430, true);
  assert.deepEqual(
    docHeavyInventory.package_manifests.map((manifest) => manifest.path).sort(),
    ["frontend/package.json", "package.json"],
  );
  assert.deepEqual(
    docHeavyInventory.python.pyprojects.sort(),
    ["backend/pyproject.toml", "pyproject.toml"],
  );
  assert.equal(docHeavyInventory.stack.includes("React Native"), true);
  assert.equal(docHeavyInventory.stack.includes("Python"), true);
  assert.equal(docHeavyInventory.stack.includes("frontend/backend monorepo"), true);
  assert.equal(docHeavyInventory.entry_points.includes("frontend/src/App.tsx"), true);
  assert.equal(docHeavyInventory.commands.some((command) => /frontend\/package\.json: npm run start/.test(command)), true);
  const markdownCount = docHeavyInventory.languages.find((item) => item.language === "Markdown")?.count ?? 0;
  const typescriptCount = docHeavyInventory.languages
    .filter((item) => /TypeScript|React Native/.test(item.language))
    .reduce((sum, item) => sum + item.count, 0);
  const pythonCount = docHeavyInventory.languages.find((item) => item.language === "Python")?.count ?? 0;
  assert.equal(markdownCount < 50, true);
  assert.equal(typescriptCount >= 12, true);
  assert.equal(pythonCount >= 10, true);

  // has_code robustness: an operational repo in a language beyond the original 11 extensions, or one detected
  // only via its dependency manifest, must NOT be falsely flagged empty (the false-"empty repository" bug).
  const goRoot = path.join(tempRoot, "go-service");
  await fs.mkdir(path.join(goRoot, "cmd"), { recursive: true });
  await fs.writeFile(path.join(goRoot, "go.mod"), "module example.com/svc\n\ngo 1.22\n");
  await fs.writeFile(path.join(goRoot, "cmd", "main.go"), "package main\nfunc main() {}\n");
  assert.equal((await inventoryRepository(goRoot)).has_code, true, "a Go service is not empty");

  const kotlinRoot = path.join(tempRoot, "kotlin-app");
  await fs.mkdir(kotlinRoot, { recursive: true });
  await fs.writeFile(path.join(kotlinRoot, "App.kt"), "fun main() {}\n");
  assert.equal((await inventoryRepository(kotlinRoot)).has_code, true, "a Kotlin file counts as code");

  const manifestOnlyRoot = path.join(tempRoot, "manifest-only");
  await fs.mkdir(manifestOnlyRoot, { recursive: true });
  await fs.writeFile(path.join(manifestOnlyRoot, "Cargo.toml"), "[package]\nname = \"x\"\n");
  await fs.writeFile(path.join(manifestOnlyRoot, "notes.txt"), "hello\n");
  assert.equal((await inventoryRepository(manifestOnlyRoot)).has_code, true, "a project manifest means not-empty");

  const emptyDocsRoot = path.join(tempRoot, "empty-docs");
  await fs.mkdir(emptyDocsRoot, { recursive: true });
  await fs.writeFile(path.join(emptyDocsRoot, "README.md"), "# hi\n");
  assert.equal((await inventoryRepository(emptyDocsRoot)).has_code, false, "a docs-only repo is still empty");

  const freeTextRoot = path.join(tempRoot, "free-text-repo");
  await writeFixtureRepo(freeTextRoot);
  await initProject({ sourceRoot, targetRoot: freeTextRoot });
  await runProjectOnboarding({
    projectRoot: freeTextRoot,
    answers: {
      domain: "verificar no codigo, sao muitas. o principal e a gestao relatorios, troca de plantao, etc funcionar",
    },
    askUser: false,
    runWorker: false,
    materializeGraph: false,
  });
  const freeTextBusinessRules = await fs.readFile(path.join(freeTextRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8");
  const freeTextGlossary = await fs.readFile(path.join(freeTextRoot, ".aipi", "memory", "project", "glossary.md"), "utf8");
  assert.doesNotMatch(freeTextBusinessRules, /etc funcionar|sao muitas\. o principal/i);
  assert.doesNotMatch(freeTextGlossary, /etc funcionar|sao muitas\. o principal/i);

  const concreteRuleRoot = path.join(tempRoot, "concrete-rule-repo");
  await writeConcreteRuleRepo(concreteRuleRoot);
  await initProject({ sourceRoot, targetRoot: concreteRuleRoot });
  await runProjectOnboarding({
    projectRoot: concreteRuleRoot,
    askUser: false,
    runWorker: false,
    materializeGraph: false,
  });
  const concreteRuleMemory = await fs.readFile(path.join(concreteRuleRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8");
  assert.match(concreteRuleMemory, /Concrete candidate business rules were inferred from source evidence/);
  assert.match(concreteRuleMemory, /CANDIDATE: price must be at least 0\. source_ref: backend\/services\/pricing\.py:2/);
  assert.doesNotMatch(concreteRuleMemory, /Changes touching .* should preserve behavior inferred from related models, services, and tests/);
  assert.doesNotMatch(concreteRuleMemory, /\*\*status:\*\* accepted|status:\s*accepted/i);
  const concreteCandidateLines = concreteRuleMemory
    .split(/\r?\n/)
    .filter((line) => line.includes("CANDIDATE:"));
  assert.equal(concreteCandidateLines.length >= 1, true);
  assert.equal(concreteCandidateLines.every((line) => /source_ref:\s*\S+/.test(line)), true);

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

  await fs.writeFile(
    projectMemoryPath,
    [
      "---",
      "type: project",
      "owner: project",
      "status: draft",
      "last_reviewed: -",
      "---",
      "",
      "# Project Context",
      "",
      "## Current truth",
      "",
      "Old inventory says this is Python only.",
      "",
      "## Open questions",
      "",
      "- Which commands exist?",
      "",
      "## Timeline",
      "",
      "- 2026-06-19: Seeded by /aipi-onboard.",
      "",
    ].join("\n"),
  );
  const refreshedAutoSeed = await runProjectOnboarding({
    projectRoot: tempRoot,
    answers: { purpose: "Refreshed inventory should replace stale auto-seeded memory." },
    askUser: false,
    runWorker: false,
    materializeGraph: false,
    now: () => new Date("2026-06-20T08:00:00.000Z"),
  });
  assert.equal(refreshedAutoSeed.memory.written.includes("project.md"), true);
  const refreshedProjectMemory = await fs.readFile(projectMemoryPath, "utf8");
  assert.match(refreshedProjectMemory, /Refreshed inventory should replace stale auto-seeded memory/);
  assert.match(refreshedProjectMemory, /onboarding_schema_version: 2/);
  assert.doesNotMatch(refreshedProjectMemory, /Old inventory says this is Python only|Open questions/);

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

async function writeConcreteRuleRepo(root) {
  await fs.mkdir(path.join(root, "backend", "services"), { recursive: true });
  await fs.writeFile(
    path.join(root, "backend", "services", "pricing.py"),
    [
      "def create_invoice(price):",
      "    if price < 0:",
      "        raise ValueError('price must be non-negative')",
      "    return {'price': price}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "pricing-service", scripts: { test: "pytest" } }, null, 2)}\n`,
  );
}

async function writeDocHeavyMonorepo(root) {
  await fs.mkdir(path.join(root, ".aihaus", "milestones"), { recursive: true });
  for (let index = 0; index < 420; index += 1) {
    await fs.writeFile(path.join(root, ".aihaus", "milestones", `story-${index}.md`), `# Story ${index}\n`);
  }
  await fs.mkdir(path.join(root, "frontend", "src", "screens"), { recursive: true });
  await fs.mkdir(path.join(root, "backend", "app", "services"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "workspace-root", scripts: { test: "npm --prefix frontend test" } }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(root, "frontend", "package.json"),
    `${JSON.stringify({
      name: "nora-frontend",
      scripts: { start: "expo start", test: "jest", typecheck: "tsc --noEmit" },
      dependencies: { expo: "^50.0.0", "react-native": "^0.74.0" },
      devDependencies: { typescript: "^5.0.0" },
    }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"workspace-root\"\n");
  await fs.writeFile(path.join(root, "backend", "pyproject.toml"), "[project]\nname = \"nora-backend\"\n");
  await fs.writeFile(path.join(root, "frontend", "src", "App.tsx"), "export default function App() { return null; }\n");
  for (let index = 0; index < 12; index += 1) {
    await fs.writeFile(path.join(root, "frontend", "src", "screens", `Screen${index}.tsx`), `export const Screen${index} = () => null;\n`);
  }
  for (let index = 0; index < 10; index += 1) {
    await fs.writeFile(path.join(root, "backend", "app", "services", `service_${index}.py`), `def handler_${index}():\n    return True\n`);
  }
}
