import assert from "node:assert/strict";
import path from "node:path";
import {
  buildEnvironmentReport,
  formatEnvironmentReport,
  loadEnvironmentRequirements,
  resolveOllamaHost,
  REQUIRED_EMBEDDING_DIMENSIONS,
} from "../extensions/aipi/runtime/environment-doctor.js";

const TARGET = path.join("C:", "fake-project");

function fakeSpawn(table) {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, result] of Object.entries(table)) {
      if (key.startsWith(pattern)) return { status: 0, stdout: "", stderr: "", ...result };
    }
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
  };
}

function fakeFetch(routes) {
  return async (url) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (String(url).includes(pattern)) return handler();
    }
    throw new Error(`fetch refused: ${url}`);
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const healthySpawn = fakeSpawn({
  "git --version": { stdout: "git version 2.49.0\n" },
  "docker info": { stdout: '"27.4.0"\n' },
  "ollama --version": { stdout: "ollama version 0.9.0\n" },
});
const healthyFetch = fakeFetch({
  "/api/tags": () => jsonResponse({ models: [{ name: "bge-m3:latest" }] }),
  "/api/embed": () => jsonResponse({ embeddings: [new Array(REQUIRED_EMBEDDING_DIMENSIONS).fill(0.1)] }),
});
const healthyDeps = {
  targetDir: TARGET,
  env: {},
  platform: "win32",
  homeDir: path.join("C:", "Users", "u"),
  nodeVersion: "24.18.0",
  spawnSyncFn: healthySpawn,
  fetchFn: healthyFetch,
  existsSync: () => false,
  readFileSync: () => { throw new Error("no file"); },
  readdirSync: () => [],
  piProbe: () => ({ ok: true, version: "0.79.8", source: "package-local node_modules" }),
};

// 1. Fully healthy machine with default requirements: everything passes.
{
  const report = await buildEnvironmentReport({ ...healthyDeps });
  assert.equal(report.schema, "aipi.environment-doctor.v1");
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  const ids = report.checks.map((check) => check.id);
  assert.deepEqual(ids, ["env.node", "env.git", "env.pi", "env.docker", "env.ollama.embeddings"], "playwright is off by default");
  assert.ok(formatEnvironmentReport(report).includes("OK"));
  console.log("ok - healthy machine passes with default requirements");
}

// 2. Old Node blocks unconditionally.
{
  const report = await buildEnvironmentReport({ ...healthyDeps, nodeVersion: "20.11.0" });
  const node = report.checks.find((check) => check.id === "env.node");
  assert.equal(node.state, "block");
  assert.equal(report.ok, false);
  console.log("ok - node below 22.19.0 blocks");
}

// 3. Docker: ENOENT vs daemon-down produce distinct evidence; optional => warn, required => block.
{
  const noDockerSpawn = fakeSpawn({
    "git --version": { stdout: "git version 2.49.0\n" },
    "ollama --version": { stdout: "ollama version 0.9.0\n" },
  });
  const optional = await buildEnvironmentReport({ ...healthyDeps, spawnSyncFn: noDockerSpawn });
  const dockerWarn = optional.checks.find((check) => check.id === "env.docker");
  assert.equal(dockerWarn.state, "warn");
  assert.match(dockerWarn.evidence, /not found on PATH/);
  assert.equal(optional.ok, true, "optional docker missing must not block");

  const required = await buildEnvironmentReport({
    ...healthyDeps,
    spawnSyncFn: noDockerSpawn,
    requirements: { docker: "required", playwright: "off", ollama_embeddings: "off" },
  });
  const dockerBlock = required.checks.find((check) => check.id === "env.docker");
  assert.equal(dockerBlock.state, "block");
  assert.equal(required.ok, false);

  const daemonDownSpawn = fakeSpawn({
    "git --version": { stdout: "git version 2.49.0\n" },
    "docker info": { status: 1, stderr: "error during connect: this error may indicate that the docker daemon is not running\n" },
  });
  const daemonDown = await buildEnvironmentReport({
    ...healthyDeps,
    spawnSyncFn: daemonDownSpawn,
    platform: "win32",
    requirements: { docker: "required", playwright: "off", ollama_embeddings: "off" },
  });
  const dockerDown = daemonDown.checks.find((check) => check.id === "env.docker");
  assert.match(dockerDown.evidence, /daemon unreachable/);
  assert.match(dockerDown.next_action, /Docker Desktop|WSL/);
  console.log("ok - docker missing vs daemon-down, optional vs required");
}

// 4. Playwright: package present, browsers missing => fixable; parse trouble degrades, never blocks when optional.
{
  const browsersDir = path.join("C:", "Users", "u", "AppData", "Local", "ms-playwright");
  const withPkgNoBrowsers = await buildEnvironmentReport({
    ...healthyDeps,
    requirements: { docker: "off", playwright: "required", ollama_embeddings: "off" },
    existsSync: (candidate) => candidate === path.join(TARGET, "node_modules", "playwright"),
    readdirSync: () => { throw new Error("missing dir"); },
  });
  const playwright = withPkgNoBrowsers.checks.find((check) => check.id === "env.playwright");
  assert.equal(playwright.state, "block");
  assert.equal(playwright.fix_available, true);
  assert.match(playwright.next_action, /playwright install/);

  const withBrowsers = await buildEnvironmentReport({
    ...healthyDeps,
    requirements: { docker: "off", playwright: "required", ollama_embeddings: "off" },
    existsSync: (candidate) =>
      candidate === path.join(TARGET, "node_modules", "playwright") || candidate === browsersDir,
    readdirSync: (dir) => (dir === browsersDir ? ["chromium-1181"] : []),
  });
  assert.equal(withBrowsers.checks.find((check) => check.id === "env.playwright").state, "pass");
  assert.equal(withBrowsers.ok, true);
  console.log("ok - playwright package/browsers detection with --fix affordance");
}

// 5. Ollama: server down vs model missing vs wrong dimensions.
{
  const requirements = { docker: "off", playwright: "off", ollama_embeddings: "required" };
  const serverDown = await buildEnvironmentReport({
    ...healthyDeps,
    requirements,
    fetchFn: async () => { throw new Error("ECONNREFUSED"); },
  });
  const down = serverDown.checks.find((check) => check.id === "env.ollama.embeddings");
  assert.equal(down.state, "block");
  assert.match(down.evidence, /server at http:\/\/localhost:11434 is unreachable/);
  assert.match(down.next_action, /ollama serve|Ollama app/);

  const modelMissing = await buildEnvironmentReport({
    ...healthyDeps,
    requirements,
    fetchFn: fakeFetch({ "/api/tags": () => jsonResponse({ models: [{ name: "llama3:8b" }] }) }),
  });
  const missing = modelMissing.checks.find((check) => check.id === "env.ollama.embeddings");
  assert.equal(missing.state, "block");
  assert.equal(missing.fix_available, true);
  assert.match(missing.next_action, /ollama pull bge-m3/);

  const wrongDims = await buildEnvironmentReport({
    ...healthyDeps,
    requirements,
    fetchFn: fakeFetch({
      "/api/tags": () => jsonResponse({ models: [{ name: "bge-m3:latest" }] }),
      "/api/embed": () => jsonResponse({ embeddings: [new Array(768).fill(0.1)] }),
    }),
  });
  const dims = wrongDims.checks.find((check) => check.id === "env.ollama.embeddings");
  assert.equal(dims.state, "block");
  assert.match(dims.evidence, /768 dimensions.*requires 1024/);
  console.log("ok - ollama server/model/dimension probes");
}

// 6. Ollama host precedence: AIPI_OLLAMA_HOST > .aipi/semantic-memory.json > OLLAMA_HOST > default.
{
  assert.equal(resolveOllamaHost({ env: {}, readFileSync: () => { throw new Error("none"); } }), "http://localhost:11434");
  assert.equal(
    resolveOllamaHost({ env: { OLLAMA_HOST: "10.0.0.5:11434" }, readFileSync: () => { throw new Error("none"); } }),
    "http://10.0.0.5:11434",
  );
  assert.equal(
    resolveOllamaHost({
      env: { OLLAMA_HOST: "10.0.0.5:11434" },
      readFileSync: () => JSON.stringify({ ollama_host: "http://127.0.0.1:9999" }),
    }),
    "http://127.0.0.1:9999",
  );
  assert.equal(
    resolveOllamaHost({
      env: { AIPI_OLLAMA_HOST: "https://ollama.internal", OLLAMA_HOST: "10.0.0.5:11434" },
      readFileSync: () => JSON.stringify({ ollama_host: "http://127.0.0.1:9999" }),
    }),
    "https://ollama.internal",
  );
  console.log("ok - ollama host precedence");
}

// 7. Requirements loader: file overrides defaults, garbage levels ignored, missing file => defaults.
{
  const loaded = loadEnvironmentRequirements({
    targetDir: TARGET,
    readFileSync: () => JSON.stringify({ docker: "required", playwright: "banana", ollama_embeddings: "off" }),
  });
  assert.deepEqual(loaded.requirements, { docker: "required", playwright: "off", ollama_embeddings: "off" });
  assert.equal(loaded.source, ".aipi/environment.json");
  const defaults = loadEnvironmentRequirements({ targetDir: TARGET, readFileSync: () => { throw new Error("none"); } });
  assert.deepEqual(defaults.requirements, { docker: "optional", playwright: "off", ollama_embeddings: "optional" });
  assert.equal(defaults.source, "defaults");
  console.log("ok - requirements declaration loading");
}

// 8. Pi probe failure blocks with the standalone-install remediation.
{
  const report = await buildEnvironmentReport({
    ...healthyDeps,
    piProbe: () => ({ ok: false, error: "pi not found" }),
    requirements: { docker: "off", playwright: "off", ollama_embeddings: "off" },
  });
  const pi = report.checks.find((check) => check.id === "env.pi");
  assert.equal(pi.state, "block");
  assert.match(pi.next_action, /npm install|AIPI_PI_BIN/);
  console.log("ok - pi probe failure blocks with remediation");
}

console.log("AIPI_ENVIRONMENT_DOCTOR_TEST_OK");
