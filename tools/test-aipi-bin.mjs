import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  aipiExtensionPaths,
  aipiProviderExtensionPaths,
  buildPiArgs,
  classifyAipiInvocation,
  createRawPiSpawnSpec,
  createPiSpawnSpec,
  formatAipiHelp,
  formatAipiVersion,
  pathCommandCandidates,
  piCliJsCandidates,
  pinnedPiSpawnEnv,
  parseAipiMemoryArgs,
  parseAipiModelsArgs,
  parseAipiOnboardArgs,
  parseAipiDiagnoseArgs,
  parseAipiStatusArgs,
  parseAipiWorkflowArgs,
  quoteCmdArg,
  hasAipiMcpConfig,
  readAipiPackageVersion,
  readPiVersion,
  runAipiMemory,
  createCliPromptUi,
  runAipiModels,
  runAipiOnboard,
  runAipiDiagnose,
  runAipiStatus,
  runAipiWorkflow,
} from "../bin/aipi.js";

const packageRoot = path.join("C:", "repo", "aipi");
const expectedAnthropic = path.join(
  packageRoot,
  "extensions",
  "aipi",
  "provider",
  "anthropic-oauth-only.ts",
);
const expectedAipi = path.join(packageRoot, "extensions", "aipi", "index.js");
const expectedMcp = path.join(packageRoot, "extensions", "aipi", "mcp-bridge.js");

assert.deepEqual(
  aipiExtensionPaths({ packageRoot, cwd: path.join("C:", "repo", "project"), existsSync: () => false }),
  [expectedAnthropic, expectedAipi],
);
assert.deepEqual(
  aipiExtensionPaths({
    packageRoot,
    cwd: path.join("C:", "repo", "project"),
    existsSync: (candidate) => candidate === path.join("C:", "repo", "project", ".aipi", "mcp.json"),
  }),
  [expectedAnthropic, expectedMcp, expectedAipi],
);
assert.equal(hasAipiMcpConfig({
  cwd: path.join("C:", "repo", "project"),
  existsSync: (candidate) => candidate.endsWith(path.join(".aipi", "mcp.json")),
}), true);
// Fallback (contract unreadable at a fake packageRoot): only the critical Anthropic default loads.
assert.deepEqual(aipiProviderExtensionPaths({ packageRoot }), ["./extensions/aipi/provider/anthropic-oauth-only.ts"]);

// The shipped contract carries BOTH providers: Anthropic first, then the optional xAI (Grok) wrapper.
const anthropicXaiContract = () => JSON.stringify({
  providerAuth: {
    anthropic: { extensionPath: "./extensions/aipi/provider/anthropic-oauth-only.ts" },
    xai: { extensionPath: "./extensions/aipi/provider/xai-oauth.ts" },
  },
});
assert.deepEqual(aipiProviderExtensionPaths({ packageRoot, readFileSync: anthropicXaiContract }), [
  "./extensions/aipi/provider/anthropic-oauth-only.ts",
  "./extensions/aipi/provider/xai-oauth.ts",
]);

const customProviderContract = () => JSON.stringify({
  providerAuth: {
    custom: {
      extensionPath: "./node_modules/@scope/custom-provider/index.js",
    },
  },
});
assert.deepEqual(aipiProviderExtensionPaths({ packageRoot, readFileSync: customProviderContract }), [
  "./node_modules/@scope/custom-provider/index.js",
]);
assert.deepEqual(aipiExtensionPaths({
  packageRoot,
  readFileSync: customProviderContract,
  cwd: path.join("C:", "repo", "project"),
  existsSync: () => false,
}), [
  path.join(packageRoot, "node_modules", "@scope", "custom-provider", "index.js"),
  expectedAipi,
]);

const userArgs = ["-p", "hello", "--provider", "openai-codex", "--model", "gpt-5.5"];
assert.deepEqual(buildPiArgs(userArgs, {
  packageRoot,
  cwd: path.join("C:", "repo", "project"),
  existsSync: () => false,
}), [
  "--extension",
  expectedAnthropic,
  "--extension",
  expectedAipi,
  ...userArgs,
]);

const cliJs = path.join("C:", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const candidates = piCliJsCandidates({
  env: {
    AIPI_PI_CLI_JS: cliJs,
    APPDATA: path.join("C:", "Users", "u", "AppData", "Roaming"),
    npm_config_prefix: path.join("C:", "npm-prefix"),
  },
  homeDir: path.join("C:", "Users", "u"),
  platform: "win32",
});
assert.equal(candidates[0], cliJs);
assert.ok(candidates.some((candidate) => candidate.endsWith(path.join("npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"))));

// Standalone install: the package-local pinned Pi is the FIRST candidate after
// the explicit env override — no global Pi install required.
{
  const packageRoot = path.join("C:", "aipi-pkg");
  const localCandidates = piCliJsCandidates({
    env: {
      AIPI_PI_CLI_JS: cliJs,
      npm_config_prefix: path.join("C:", "npm-prefix"),
    },
    homeDir: path.join("C:", "Users", "u"),
    platform: "win32",
    packageRoot,
  });
  assert.equal(localCandidates[0], cliJs, "explicit env override stays first");
  assert.equal(
    localCandidates[1],
    path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    "package-local pinned Pi comes before global prefixes",
  );
  // The resolved cli.js is exported to children as AIPI_PI_CLI_JS so worker
  // runtimes spawn the SAME Pi as the wrapper.
  const localCliJs = localCandidates[1];
  const spec = createRawPiSpawnSpec({
    env: {},
    existsSync: (candidate) => candidate === localCliJs,
    homeDir: path.join("C:", "Users", "u"),
    nodeExecPath: "node.exe",
    platform: "win32",
    userArgs: ["--version"],
    packageRoot,
  });
  assert.equal(spec.command, "node.exe");
  assert.equal(spec.args[0], localCliJs);
  assert.deepEqual(spec.childEnv, { AIPI_PI_CLI_JS: localCliJs });
}

assert.deepEqual(classifyAipiInvocation([]), { kind: "pass-through" });
assert.deepEqual(classifyAipiInvocation(["--version"]), { kind: "aipi-version" });
assert.deepEqual(classifyAipiInvocation(["-v"]), { kind: "aipi-version" });
assert.deepEqual(classifyAipiInvocation(["--help"]), { kind: "aipi-help" });
assert.deepEqual(classifyAipiInvocation(["-h"]), { kind: "aipi-help" });
assert.deepEqual(classifyAipiInvocation(["--pi-version"]), { kind: "raw-pi", args: ["--version"] });
assert.deepEqual(classifyAipiInvocation(["--pi-help"]), { kind: "raw-pi", args: ["--help"] });
assert.deepEqual(classifyAipiInvocation(["status", "--json"]), { kind: "aipi-status", args: ["--json"] });
assert.deepEqual(classifyAipiInvocation(["doctor"]), { kind: "aipi-status", args: [] });
assert.deepEqual(classifyAipiInvocation(["workflow", "list"]), { kind: "aipi-workflow", args: ["list"] });
assert.deepEqual(classifyAipiInvocation(["workflows", "status"]), { kind: "aipi-workflow", args: ["status"] });
assert.deepEqual(classifyAipiInvocation(["profile", "list"]), { kind: "pass-through" });
assert.deepEqual(classifyAipiInvocation(["profiles", "status"]), { kind: "pass-through" });
assert.deepEqual(classifyAipiInvocation(["memory", "refs"]), { kind: "aipi-memory", args: ["refs"] });
assert.deepEqual(classifyAipiInvocation(["memories", "status"]), { kind: "aipi-memory", args: ["status"] });
assert.deepEqual(classifyAipiInvocation(["models", "status"]), { kind: "aipi-models", args: ["status"] });
assert.deepEqual(classifyAipiInvocation(["model", "check"]), { kind: "aipi-models", args: ["check"] });
assert.deepEqual(classifyAipiInvocation(["onboard", "--no-questions"]), { kind: "aipi-onboard", args: ["--no-questions"] });
assert.deepEqual(classifyAipiInvocation(["onboarding"]), { kind: "aipi-onboard", args: [] });
assert.deepEqual(classifyAipiInvocation(["diagnose", "run-1"]), { kind: "aipi-diagnose", args: ["run-1"] });
assert.deepEqual(classifyAipiInvocation(["setup", "--fix"]), { kind: "aipi-setup", args: ["--fix"] });
assert.deepEqual(classifyAipiInvocation(["diagnostics", "--json"]), { kind: "aipi-diagnose", args: ["--json"] });
assert.deepEqual(classifyAipiInvocation(["--", "--version"]), { kind: "pass-through" });
assert.deepEqual(parseAipiStatusArgs(["--target", "project", "--json", "--strict"], { cwd: path.join("C:", "repo") }), {
  target: path.resolve(path.join("C:", "repo"), "project"),
  json: true,
  strict: true,
});
assert.deepEqual(parseAipiWorkflowArgs(["--target", "project", "--json", "list"], { cwd: path.join("C:", "repo") }), {
  target: path.resolve(path.join("C:", "repo"), "project"),
  json: true,
  workflowArgs: ["list"],
});
assert.deepEqual(parseAipiMemoryArgs(["--target", "project", "--json", "query", "billing"], { cwd: path.join("C:", "repo") }), {
  target: path.resolve(path.join("C:", "repo"), "project"),
  json: true,
  memoryArgs: ["query", "billing"],
});
assert.deepEqual(parseAipiModelsArgs(["--target", "project", "--json", "setup", "--host", "openai-codex/gpt-5.5"], { cwd: path.join("C:", "repo") }), {
  target: path.resolve(path.join("C:", "repo"), "project"),
  json: true,
  modelsArgs: ["--target", "project", "setup", "--host", "openai-codex/gpt-5.5"],
});
assert.deepEqual(parseAipiOnboardArgs(["--target", "project", "--json", "--no-questions"], { cwd: path.join("C:", "repo") }), {
  target: path.resolve(path.join("C:", "repo"), "project"),
  json: true,
  noQuestions: true,
  noPullEmbeddings: false,
  rebuildGraph: false,
  onboardArgs: ["--target", "project", "--no-questions"],
});
assert.equal(parseAipiOnboardArgs(["--rebuild-graph"]).rebuildGraph, true);
assert.deepEqual(parseAipiDiagnoseArgs(["--target", "project", "--json", "--share", "run-1"], { cwd: path.join("C:", "repo") }), {
  target: path.resolve(path.join("C:", "repo"), "project"),
  json: true,
  help: false,
  diagnoseArgs: ["--target", "project", "--json", "--share", "run-1"],
});

assert.equal(
  readAipiPackageVersion({
    packageRoot,
    readFileSync: () => JSON.stringify({ version: "0.1.0" }),
  }),
  "0.1.0",
);
assert.equal(formatAipiVersion({ aipiVersion: "0.1.0", piVersion: { ok: true, version: "0.75.5" } }), "aipi 0.1.0 (pi 0.75.5)");
assert.equal(formatAipiVersion({ aipiVersion: "0.1.0", piVersion: { ok: false } }), "aipi 0.1.0 (pi: not found)");
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi 0\.1\.0 - BDD-contract agent harness on Pi/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi with no arguments starts an interactive Pi session/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /\/aipi-init \[--dry-run\] \[--force\] \[--reset-memory\].*\[--no-pull-embeddings\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /\/aipi-onboard \[--target <dir>\] \[--no-questions\] \[--no-pull-embeddings\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /\/aipi-workflow \[list \| status \| start <name> \| run <name> \| execute\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /\/aipi-memory \[status \| refs \| query <terms>\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /\/aipi-models \[setup \| status \| check\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /\/aipi-diagnose \[<run_id>\] \[--share\] \[--json\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /\/aipi-mcp/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /\/aipi-pi-subagents-spike/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /--pi-help/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi status \[--target <dir>\] \[--json\] \[--strict\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi workflow \[--target <dir>\] \[--json\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi memory \[--target <dir>\] \[--json\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi models \[--target <dir>\] \[--json\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi onboard \[--target <dir>\] \[--json\] \[--no-questions\] \[--no-pull-embeddings\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi diagnose \[<run_id>\] \[--target <dir>\] \[--share\] \[--json\]/);
assert.match(formatAipiHelp({ aipiVersion: "0.1.0" }), /aipi update \[--dry-run\]/);

const readme = fs.readFileSync("README.md", "utf8");
const installationDoc = fs.readFileSync(path.join("docs", "installation.md"), "utf8");
const wrapperDoc = fs.readFileSync(path.join("docs", "aipi-cli-wrapper.md"), "utf8");
assert.match(readme, /docs\/installation\.md`\]\(docs\/installation\.md\)/);
assert.match(readme, /aipi\s+# interactive Pi session with AIPI preloaded/);
// Standalone story: Pi ships as a pinned dependency; the docs must NOT tell
// users to globally install Pi as a prerequisite anymore.
assert.doesNotMatch(installationDoc, /npm install -g @earendil-works\/pi-coding-agent/);
assert.match(installationDoc, /no global Pi is required/);
assert.match(installationDoc, /npm link/);
assert.match(installationDoc, /npm install -g \./);
assert.match(installationDoc, /starts an interactive Pi session with the AIPI extensions preloaded/);
assert.match(wrapperDoc, /`aipi` with no arguments starts an interactive Pi session/);

const piVersion = readPiVersion({
  env: { AIPI_PI_CLI_JS: cliJs },
  existsSync: (candidate) => candidate === cliJs,
  nodeExecPath: "node-custom",
  packageRoot,
  platform: "win32",
  spawnSyncFn: (command, args) => {
    assert.equal(command, "node-custom");
    assert.deepEqual(args, [cliJs, "--version"]);
    return { status: 0, stdout: "", stderr: "0.75.5\n" };
  },
});
assert.deepEqual(piVersion, { ok: true, version: "0.75.5", error: null });

const nodeSpec = createPiSpawnSpec({
  env: { AIPI_PI_CLI_JS: cliJs },
  existsSync: (candidate) => candidate === cliJs,
  nodeExecPath: "node-custom",
  packageRoot,
  platform: "win32",
  userArgs: ["--version"],
  cwd: path.join("C:", "repo", "project"),
});
assert.equal(nodeSpec.command, "node-custom");
assert.deepEqual(nodeSpec.args, [
  cliJs,
  "--extension",
  expectedAnthropic,
  "--extension",
  expectedAipi,
  "--version",
]);

const noFlagNodeSpec = createPiSpawnSpec({
  env: { AIPI_PI_CLI_JS: cliJs },
  existsSync: (candidate) => candidate === cliJs,
  nodeExecPath: "node-custom",
  packageRoot,
  platform: "win32",
  userArgs: ["--help"],
  cwd: path.join("C:", "repo", "project"),
});
assert.equal(noFlagNodeSpec.command, "node-custom");
assert.equal(noFlagNodeSpec.args.includes(path.join(packageRoot, "extensions", "aipi", ["pi", "subagents", "embedded"].join("-") + ".js")), false);
assert.equal(noFlagNodeSpec.args.includes(path.join(packageRoot, "node_modules", "pi-subagents", "src", "extension", "index.ts")), false);

const rawNodeSpec = createRawPiSpawnSpec({
  env: { AIPI_PI_CLI_JS: cliJs },
  existsSync: (candidate) => candidate === cliJs,
  nodeExecPath: "node-custom",
  platform: "win32",
  userArgs: ["--help"],
});
assert.equal(rawNodeSpec.command, "node-custom");
assert.deepEqual(rawNodeSpec.args, [cliJs, "--help"]);

const cmdSpec = createPiSpawnSpec({
  env: { AIPI_PI_BIN: path.join("C:", "npm", "pi.cmd") },
  existsSync: () => false,
  packageRoot,
  platform: "win32",
  userArgs: ["-p", "prompt with spaces"],
});
assert.equal(cmdSpec.command, "cmd.exe");
assert.deepEqual(cmdSpec.args.slice(0, 3), ["/d", "/s", "/c"]);
assert.match(cmdSpec.args[3], /pi\.cmd/);
assert.match(cmdSpec.args[3], /prompt with spaces/);

assert.equal(quoteCmdArg('a "quoted" value'), '"a \\"quoted\\" value"');

const pathEnv = { PATH: [path.join("C:", "npm"), path.join("C:", "bin")].join(path.delimiter) };
assert.ok(pathCommandCandidates("pi", { env: pathEnv, platform: "win32" }).some((candidate) => candidate.endsWith("pi.cmd")));

const statusReport = {
  readiness: { status: "ready_for_adversarial_review" },
  project: { root: path.join("C:", "repo", "project") },
};
const formattedStatus = [];
const returnedStatus = await runAipiStatus({
  packageRoot,
  cwd: path.join("C:", "repo"),
  userArgs: ["--target", "project"],
  log: (line) => formattedStatus.push(line),
  statusFns: {
    async buildAipiStatusReport({ projectRoot, root }) {
      assert.equal(projectRoot, path.resolve(path.join("C:", "repo"), "project"));
      assert.equal(root, packageRoot);
      return statusReport;
    },
    formatAipiStatus: () => "AIPI STATUS OK",
    aipiStatusKind: () => "info",
  },
});
assert.equal(returnedStatus, statusReport);
assert.deepEqual(formattedStatus, ["AIPI STATUS OK"]);

const jsonStatus = [];
await runAipiStatus({
  userArgs: ["--json"],
  log: (line) => jsonStatus.push(line),
  statusFns: {
    async buildAipiStatusReport() {
      return statusReport;
    },
    formatAipiStatus: () => "unused",
    aipiStatusKind: () => "info",
  },
});
assert.deepEqual(JSON.parse(jsonStatus[0]), statusReport);

process.exitCode = undefined;
await runAipiStatus({
  userArgs: ["--strict"],
  log: () => {},
  statusFns: {
    async buildAipiStatusReport() {
      return statusReport;
    },
    formatAipiStatus: () => "warning",
    aipiStatusKind: () => "warning",
  },
});
assert.equal(process.exitCode, 1);
process.exitCode = undefined;

const workflowOutput = [];
const workflowResult = { action: "list", workflows: ["bugfix", "feature"] };
const returnedWorkflow = await runAipiWorkflow({
  cwd: path.join("C:", "repo"),
  userArgs: ["--target", "project", "list"],
  log: (line) => workflowOutput.push(line),
  workflowFns: {
    async runWorkflowCommand({ args, projectRoot }) {
      assert.equal(args, "list");
      assert.equal(projectRoot, path.resolve(path.join("C:", "repo"), "project"));
      return workflowResult;
    },
    formatWorkflowCommandResult: () => "AIPI workflows: bugfix, feature",
  },
});
assert.equal(returnedWorkflow, workflowResult);
assert.deepEqual(workflowOutput, ["AIPI workflows: bugfix, feature"]);

const jsonWorkflowOutput = [];
await runAipiWorkflow({
  userArgs: ["--json", "status"],
  log: (line) => jsonWorkflowOutput.push(line),
  workflowFns: {
    async runWorkflowCommand({ args }) {
      assert.equal(args, "status");
      return { action: "status", active: null };
    },
    formatWorkflowCommandResult: () => "unused",
  },
});
assert.deepEqual(JSON.parse(jsonWorkflowOutput[0]), { action: "status", active: null });

// CR-59-3 / ADV-58-3: the CLI workflow surface forwards a `notify` that routes per-step progress
// to STDERR (errorLog) in human mode, keeping STDOUT (log) reserved for the final result.
const progressStdout = [];
const progressStderr = [];
let humanNotifySeen = null;
await runAipiWorkflow({
  userArgs: ["--target", "project", "run", "bugfix"],
  cwd: path.join("C:", "repo"),
  log: (line) => progressStdout.push(line),
  errorLog: (line) => progressStderr.push(line),
  workflowFns: {
    async runWorkflowCommand({ args, notify }) {
      assert.equal(args, "run bugfix");
      assert.equal(typeof notify, "function");
      humanNotifySeen = notify;
      notify("step 1/3 implement: running", "info");
      return { action: "run", run: { runId: "r1", workflow: "bugfix" } };
    },
    formatWorkflowCommandResult: () => "AIPI workflow run: bugfix",
  },
});
assert.equal(typeof humanNotifySeen, "function");
// Progress lands on stderr (prefixed), never on stdout; stdout holds only the final result.
assert.deepEqual(progressStdout, ["AIPI workflow run: bugfix"]);
assert.deepEqual(progressStderr, ["aipi workflow: step 1/3 implement: running"]);

// Under --json the surface SUPPRESSES progress (notify === null) so stdout stays a single clean
// JSON document — `aipi workflow ... --json | jq` must not be corrupted by interleaved progress.
const jsonProgressStdout = [];
const jsonProgressStderr = [];
await runAipiWorkflow({
  userArgs: ["--json", "--target", "project", "run", "bugfix"],
  cwd: path.join("C:", "repo"),
  log: (line) => jsonProgressStdout.push(line),
  errorLog: (line) => jsonProgressStderr.push(line),
  workflowFns: {
    async runWorkflowCommand({ notify }) {
      assert.equal(notify, null);
      return { action: "run", run: { runId: "r2", workflow: "bugfix" } };
    },
    formatWorkflowCommandResult: () => "unused",
  },
});
assert.equal(jsonProgressStderr.length, 0);
assert.deepEqual(JSON.parse(jsonProgressStdout[0]), { action: "run", run: { runId: "r2", workflow: "bugfix" } });

const memoryOutput = [];
const memoryResult = {
  action: "status",
  layers: { project: { status: "available", files: 6, lines: 100 }, user: { status: "missing", files: 0, lines: 0 } },
  code_graph: { status: "missing", path: ".aipi/state/aipi-graph.json" },
};
const returnedMemory = await runAipiMemory({
  cwd: path.join("C:", "repo"),
  userArgs: ["--target", "project", "status"],
  log: (line) => memoryOutput.push(line),
  memoryFns: {
    async runMemoryCommand({ args, projectRoot }) {
      assert.equal(args, "status");
      assert.equal(projectRoot, path.resolve(path.join("C:", "repo"), "project"));
      return memoryResult;
    },
    formatMemoryCommandResult: () => "AIPI memory status: project=available",
  },
});
assert.equal(returnedMemory, memoryResult);
assert.deepEqual(memoryOutput, ["AIPI memory status: project=available"]);

const onboardOutput = [];
const onboardResult = {
  schema: "aipi.project-onboarding.v1",
  action: "onboard",
  memory: { written: ["project.md"], skipped_customized: [] },
};
const returnedOnboard = await runAipiOnboard({
  cwd: path.join("C:", "repo"),
  userArgs: ["--target", "project", "--no-questions", "--no-pull-embeddings"],
  log: (line) => onboardOutput.push(line),
  onboardingFns: {
    async runProjectOnboarding({ projectRoot, askUser, runWorker, pullEmbeddings }) {
      assert.equal(projectRoot, path.resolve(path.join("C:", "repo"), "project"));
      assert.equal(askUser, false);
      assert.equal(runWorker, false);
      assert.equal(pullEmbeddings, false);
      return onboardResult;
    },
    formatOnboardingResult: () => "AIPI onboarding complete",
  },
});
assert.equal(returnedOnboard, onboardResult);
assert.deepEqual(onboardOutput, ["AIPI onboarding complete"]);

const jsonOnboardOutput = [];
await runAipiOnboard({
  userArgs: ["--json", "--no-questions"],
  log: (line) => jsonOnboardOutput.push(line),
  onboardingFns: {
    async runProjectOnboarding() {
      return onboardResult;
    },
    formatOnboardingResult: () => "unused",
  },
});
assert.deepEqual(JSON.parse(jsonOnboardOutput[0]), onboardResult);

const jsonMemoryOutput = [];
await runAipiMemory({
  userArgs: ["--json", "query", "billing"],
  log: (line) => jsonMemoryOutput.push(line),
  memoryFns: {
    async runMemoryCommand({ args }) {
      assert.equal(args, "query billing");
      return { action: "query", query: "billing", refs: [] };
    },
    formatMemoryCommandResult: () => "unused",
  },
});
assert.deepEqual(JSON.parse(jsonMemoryOutput[0]), { action: "query", query: "billing", refs: [] });

const modelsOutput = [];
const modelsResult = {
  schema: "aipi.models-command.v1",
  state: "ready",
  classes: [],
  warnings: [],
  adversarial_family_isolation: { state: "pass" },
};
const returnedModels = await runAipiModels({
  cwd: path.join("C:", "repo"),
  userArgs: ["--target", "project", "setup", "--host", "openai-codex/gpt-5.5", "--adversarial", "anthropic/claude-opus-4-8"],
  log: (line) => modelsOutput.push(line),
  modelsFns: {
    async runModelsCommand({ args, projectRoot }) {
      assert.deepEqual(args, [
        "--target",
        "project",
        "setup",
        "--host",
        "openai-codex/gpt-5.5",
        "--adversarial",
        "anthropic/claude-opus-4-8",
      ]);
      assert.equal(projectRoot, path.resolve(path.join("C:", "repo"), "project"));
      return modelsResult;
    },
    formatModelsCommandResult: () => "AIPI models ready",
  },
});
assert.equal(returnedModels, modelsResult);
assert.deepEqual(modelsOutput, ["AIPI models ready"]);

const jsonModelsOutput = [];
await runAipiModels({
  userArgs: ["--json", "status"],
  log: (line) => jsonModelsOutput.push(line),
  modelsFns: {
    async runModelsCommand({ args }) {
      assert.deepEqual(args, ["status"]);
      return modelsResult;
    },
    formatModelsCommandResult: () => "unused",
  },
});
assert.deepEqual(JSON.parse(jsonModelsOutput[0]), modelsResult);

// CR-60-1: the CLI `aipi effort` surface forwards a prompt UI to runModelsCommand ONLY for an
// interactive, non-JSON invocation (so a bare `aipi effort` opens the setup wizard); --json and
// non-interactive (piped/CI) callers get no UI so they stay status-only and stdout stays machine-safe.
const captureModelsFns = {
  results: [],
  async runModelsCommand({ ui }) {
    captureModelsFns.results.push(ui);
    return { action: "setup", state: "ready" };
  },
  formatModelsCommandResult: () => "AIPI models setup: ready",
};
// Interactive terminal with no injected adapter -> runAipiModels builds + forwards a prompt UI.
await runAipiModels({ userArgs: [], isInteractive: true, log: () => {}, modelsFns: captureModelsFns });
const builtUi = captureModelsFns.results.at(-1);
assert.notEqual(builtUi, null);
assert.equal(typeof builtUi?.input, "function");
// An explicitly injected prompt adapter is forwarded as-is.
const injectedAdapter = { input: async () => "" };
await runAipiModels({ userArgs: [], isInteractive: true, promptAdapter: injectedAdapter, log: () => {}, modelsFns: captureModelsFns });
assert.equal(captureModelsFns.results.at(-1), injectedAdapter);
// --json -> no UI; stdout is the JSON result only.
const jsonUiOut = [];
await runAipiModels({ userArgs: ["--json"], isInteractive: true, log: (line) => jsonUiOut.push(line), modelsFns: captureModelsFns });
assert.equal(captureModelsFns.results.at(-1), null);
assert.deepEqual(JSON.parse(jsonUiOut[0]), { action: "setup", state: "ready" });
// Non-interactive (piped/CI) -> no UI (status-only, never opens the wizard).
await runAipiModels({ userArgs: [], isInteractive: false, log: () => {}, modelsFns: captureModelsFns });
assert.equal(captureModelsFns.results.at(-1), null);

// CR-60-1 regression: the CLI-created prompt UI must actually RETURN the typed answer. The callback
// readline API made rl.question() return undefined (answer-less), which broke the bare-CLI wizard;
// readline/promises awaits and resolves the line.
{
  const promptInput = new PassThrough();
  const promptOutput = new PassThrough();
  const cliUi = createCliPromptUi({ input: promptInput, output: promptOutput });
  const answerPromise = cliUi.input("Doer model");
  promptInput.write("openai-codex/gpt-5.5\n");
  const answer = await answerPromise;
  assert.equal(answer, "openai-codex/gpt-5.5", "createCliPromptUi.input() must resolve to the typed line");
  cliUi.close();
}

const diagnoseOutput = [];
const diagnoseResult = {
  schema: "aipi.diagnose-result.v1",
  report_path: ".aipi/runtime/diagnostics/report.md",
  summary: "failed at review_swarm: provider not registered / model unbound in worker process",
};
const returnedDiagnose = await runAipiDiagnose({
  cwd: path.join("C:", "repo"),
  userArgs: ["--target", "project", "--json", "run-1"],
  log: (line) => diagnoseOutput.push(line),
  diagnoseFns: {
    async runDiagnoseCommand({ args, projectRoot }) {
      assert.equal(args, "--target project --json run-1");
      assert.equal(projectRoot, path.join("C:", "repo"));
      return diagnoseResult;
    },
    formatDiagnoseCommandResult: () => "unused",
  },
});
assert.equal(returnedDiagnose, diagnoseResult);
assert.deepEqual(JSON.parse(diagnoseOutput[0]), diagnoseResult);

const diagnoseHelpOutput = [];
await runAipiDiagnose({
  userArgs: ["--help"],
  log: (line) => diagnoseHelpOutput.push(line),
  diagnoseFns: {
    async runDiagnoseCommand({ args }) {
      assert.equal(args, "--help");
      return { schema: "aipi.diagnose-help.v1", help: true, text: "Usage: aipi diagnose" };
    },
    formatDiagnoseCommandResult: () => "unused",
  },
});
assert.deepEqual(diagnoseHelpOutput, ["Usage: aipi diagnose"]);

// === pinnedPiSpawnEnv: default Pi's version-check OFF (pinned bundle), overridable, childEnv wins ===
{
  // No user setting -> aipi defaults PI_SKIP_VERSION_CHECK on so the "run pi update" banner is suppressed.
  const defaulted = pinnedPiSpawnEnv({ PATH: "/x" }, { AIPI_PI_CLI_JS: "/pi/cli.js" });
  assert.equal(defaulted.PI_SKIP_VERSION_CHECK, "1", "banner suppressed by default on a pinned bundle");
  assert.equal(defaulted.AIPI_PI_CLI_JS, "/pi/cli.js", "childEnv (pinned Pi) still applied");
  assert.equal(defaulted.PATH, "/x", "base env preserved");

  // A user who explicitly set PI_SKIP_VERSION_CHECK keeps control (their value wins, even to re-enable it).
  assert.equal(pinnedPiSpawnEnv({ PI_SKIP_VERSION_CHECK: "" }).PI_SKIP_VERSION_CHECK, "", "user override respected (re-enables the banner)");
  assert.equal(pinnedPiSpawnEnv({ PI_SKIP_VERSION_CHECK: "1" }).PI_SKIP_VERSION_CHECK, "1", "user's explicit skip respected");
  // PI_OFFLINE already disables the check, so aipi does not also inject PI_SKIP_VERSION_CHECK.
  assert.equal(pinnedPiSpawnEnv({ PI_OFFLINE: "1" }).PI_SKIP_VERSION_CHECK, undefined, "PI_OFFLINE left as the sole switch");
  // childEnv overrides everything (the pin must always hold).
  assert.equal(pinnedPiSpawnEnv({ AIPI_PI_CLI_JS: "/old" }, { AIPI_PI_CLI_JS: "/new" }).AIPI_PI_CLI_JS, "/new");
}

console.log("AIPI_BIN_TEST_OK");
