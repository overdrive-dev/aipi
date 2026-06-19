import assert from "node:assert/strict";
import path from "node:path";
import {
  buildAipiUpdatePlan,
  inspectAipiRepo,
  parseAipiUpdateArgs,
  runAipiUpdate,
} from "../bin/aipi.js";

const packageRoot = path.join("C:", "repo", "aipi");

assert.deepEqual(parseAipiUpdateArgs([]), { dryRun: false });
assert.deepEqual(parseAipiUpdateArgs(["--dry-run"]), { dryRun: true });
assert.throws(() => parseAipiUpdateArgs(["--force"]), /unknown aipi update option: --force/);

const noGitPlan = buildAipiUpdatePlan({
  packageRoot,
  existsSync: () => false,
});
assert.deepEqual(noGitPlan[0].args, ["update", "--self"]);
assert.equal(noGitPlan[1].kind, "manual");
assert.match(noGitPlan[1].message, /not a git checkout/);

const noHeadPlan = buildAipiUpdatePlan({
  packageRoot,
  repoInfo: {
    isGitCheckout: true,
    hasHead: false,
  },
});
assert.equal(noHeadPlan.length, 2);
assert.match(noHeadPlan[1].message, /no commits/);

const noUpstreamPlan = buildAipiUpdatePlan({
  packageRoot,
  repoInfo: {
    isGitCheckout: true,
    hasHead: true,
    hasUpstream: false,
  },
});
assert.equal(noUpstreamPlan.length, 2);
assert.match(noUpstreamPlan[1].message, /no upstream remote/);

const dirtyPlan = buildAipiUpdatePlan({
  packageRoot,
  repoInfo: {
    isGitCheckout: true,
    hasHead: true,
    hasUpstream: true,
    statusOk: true,
    dirty: true,
  },
});
assert.equal(dirtyPlan.length, 2);
assert.match(dirtyPlan[1].message, /local changes/);

const cleanPlan = buildAipiUpdatePlan({
  packageRoot,
  repoInfo: {
    isGitCheckout: true,
    hasHead: true,
    hasUpstream: true,
    statusOk: true,
    dirty: false,
  },
});
assert.deepEqual(cleanPlan.map((step) => step.label), ["pi", "aipi", "aipi-deps"]);
assert.deepEqual(cleanPlan[2].args, ["install", "--prefix", packageRoot]);
assert.ok(!cleanPlan[2].args.includes("--omit=dev"));

const inspectedDirtyRepo = inspectAipiRepo({
  packageRoot,
  existsSync: (candidate) => candidate.endsWith(".git"),
  spawnSyncFn: (_command, args) => {
    const gitArgs = args.slice(2);
    if (gitArgs.join(" ") === "rev-parse --verify HEAD") {
      return { status: 0, stdout: "abc123\n", stderr: "" };
    }
    if (gitArgs.join(" ") === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
      return { status: 1, stdout: "", stderr: "fatal: no upstream configured\n" };
    }
    if (gitArgs.join(" ") === "status --porcelain") {
      return { status: 0, stdout: "?? README.md\n", stderr: "" };
    }
    throw new Error(`unexpected git args: ${gitArgs.join(" ")}`);
  },
});
assert.equal(inspectedDirtyRepo.isGitCheckout, true);
assert.equal(inspectedDirtyRepo.hasHead, true);
assert.equal(inspectedDirtyRepo.hasUpstream, false);
assert.equal(inspectedDirtyRepo.dirty, true);

const logs = [];
const spawnCalls = [];
await runAipiUpdate({
  packageRoot,
  userArgs: ["--dry-run"],
  env: { AIPI_PI_BIN: "pi" },
  existsSync: (candidate) => candidate.endsWith(".git"),
  log: (message) => logs.push(message),
  errorLog: (message) => logs.push(`ERR ${message}`),
  spawnSyncFn: (command, args) => {
    spawnCalls.push([command, args]);
    const gitArgs = args.slice(2);
    if (command === "git" && gitArgs.join(" ") === "rev-parse --verify HEAD") {
      return { status: 0, stdout: "abc123\n", stderr: "" };
    }
    if (command === "git" && gitArgs.join(" ") === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
      return { status: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (command === "git" && gitArgs.join(" ") === "status --porcelain") {
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`dry-run executed a mutation command: ${command} ${args.join(" ")}`);
  },
});
assert.equal(spawnCalls.length, 3);
assert.ok(logs.some((message) => message.includes("aipi update [pi] would run: pi update --self")));
assert.ok(logs.some((message) => message.includes("aipi update [aipi] would run: git -C")));
assert.ok(logs.some((message) => message.includes("aipi update [aipi-deps] would run: npm install --prefix")));
assert.ok(logs.includes("aipi update dry-run complete."));

console.log("AIPI_UPDATE_TEST_OK");
