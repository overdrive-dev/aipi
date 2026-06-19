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

const cleanRepoInfo = {
  isGitCheckout: true,
  hasHead: true,
  hasUpstream: true,
  statusOk: true,
  dirty: false,
};
const cleanPlan = buildAipiUpdatePlan({
  packageRoot,
  repoInfo: cleanRepoInfo,
  platform: "linux",
});
assert.deepEqual(cleanPlan.map((step) => step.label), ["pi", "aipi", "aipi-deps"]);
assert.deepEqual(cleanPlan[2].args, ["install", "--prefix", packageRoot]);
assert.ok(!cleanPlan[2].args.includes("--omit=dev"));
// POSIX uses bare `npm`; Windows must use `npm.cmd` (a bare `npm` spawn is ENOENT).
assert.equal(cleanPlan[2].command, "npm");
const winPlan = buildAipiUpdatePlan({
  packageRoot,
  repoInfo: cleanRepoInfo,
  platform: "win32",
});
assert.equal(winPlan[2].command, "npm.cmd");
assert.equal(winPlan[1].command, "git");

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
const gitOnlyRepoProbe = (command, args) => {
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
  return null;
};
await runAipiUpdate({
  packageRoot,
  userArgs: ["--dry-run"],
  env: { AIPI_PI_BIN: "pi" },
  platform: "linux",
  existsSync: (candidate) => candidate.endsWith(".git"),
  log: (message) => logs.push(message),
  errorLog: (message) => logs.push(`ERR ${message}`),
  spawnSyncFn: (command, args) => {
    spawnCalls.push([command, args]);
    const probe = gitOnlyRepoProbe(command, args);
    if (probe) return probe;
    throw new Error(`dry-run executed a mutation command: ${command} ${args.join(" ")}`);
  },
});
assert.equal(spawnCalls.length, 3);
assert.ok(logs.some((message) => message.includes("aipi update [pi] would run: pi update --self")));
assert.ok(logs.some((message) => message.includes("aipi update [aipi] would run: git -C")));
assert.ok(logs.some((message) => message.includes("aipi update [aipi-deps] would run: npm install --prefix")));
assert.ok(logs.includes("aipi update dry-run complete."));

// Regression: a real (non-dry-run) Windows update must spawn npm through cmd.exe
// + npm.cmd, NOT a bare `npm` (which is ENOENT on Windows). git stays unwrapped.
const winSpawns = [];
await runAipiUpdate({
  packageRoot,
  userArgs: [],
  env: { AIPI_PI_BIN: "pi" },
  platform: "win32",
  existsSync: (candidate) => candidate.endsWith(".git"),
  log: () => {},
  errorLog: () => {},
  spawnSyncFn: (command, args) => {
    const probe = gitOnlyRepoProbe(command, args);
    if (probe) return probe;
    winSpawns.push([command, args]);
    return { status: 0, stdout: "", stderr: "" };
  },
});
const winDeps = winSpawns.find(
  (call) => call[0] === "cmd.exe" && call[1].some((arg) => /npm\.cmd/.test(String(arg)) && /--prefix/.test(String(arg))),
);
assert.ok(winDeps, "windows deps step must spawn npm.cmd through cmd.exe (not a bare npm)");
assert.ok(winDeps[1].includes("/c"), "windows npm.cmd must run via cmd.exe /c");
assert.ok(!winSpawns.some((call) => call[0] === "npm"), "must never spawn a bare `npm` on win32 (ENOENT)");
const winGit = winSpawns.find((call) => call[0] === "git" && call[1].includes("pull"));
assert.ok(winGit, "windows git pull stays a direct git.exe spawn (no cmd.exe wrap)");

console.log("AIPI_UPDATE_TEST_OK");
