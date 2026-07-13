import assert from "node:assert/strict";
import path from "node:path";
import {
  aipiReinstallSpec,
  buildAipiUpdatePlan,
  inspectAipiInstall,
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
// `npm ci` keeps the runtime checkout clean (it never rewrites package-lock), so a lock-field
// normalization can't dirty the tree and skip the next `git pull --ff-only`.
assert.deepEqual(cleanPlan[2].args, ["ci", "--prefix", packageRoot]);
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

// Bundled-Pi mode: when Pi resolves from the package-local node_modules (and no
// env override points elsewhere), `pi update --self` is skipped — the lockfile
// (npm ci) owns the Pi version. This also fixes the old bug where a missing Pi
// aborted aipi's own self-update.
const localPiCliJs = path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const localPiPlan = buildAipiUpdatePlan({
  packageRoot,
  repoInfo: cleanRepoInfo,
  platform: "linux",
  env: {},
  existsSync: (candidate) => candidate === localPiCliJs || candidate.endsWith(".git"),
});
assert.equal(localPiPlan[0].label, "pi");
assert.equal(localPiPlan[0].kind, "manual");
assert.match(localPiPlan[0].message, /packaged dependency/);
assert.deepEqual(localPiPlan.map((step) => step.label), ["pi", "aipi", "aipi-deps"]);
// An explicit override keeps the classic self-update path.
const overriddenPiPlan = buildAipiUpdatePlan({
  packageRoot,
  repoInfo: cleanRepoInfo,
  platform: "linux",
  env: { AIPI_PI_CLI_JS: "/elsewhere/cli.js" },
  existsSync: (candidate) => candidate === localPiCliJs || candidate.endsWith(".git"),
});
assert.equal(overriddenPiPlan[0].kind, "pi");
assert.deepEqual(overriddenPiPlan[0].args, ["update", "--self"]);

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
  if (command !== "git" || !Array.isArray(args)) return null;
  const gitArgs = args.slice(2).join(" ");
  if (gitArgs === "rev-parse --verify HEAD") {
    return { status: 0, stdout: "abc123\n", stderr: "" };
  }
  if (gitArgs === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
    return { status: 0, stdout: "origin/main\n", stderr: "" };
  }
  if (gitArgs === "status --porcelain") {
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
assert.ok(logs.some((message) => message.includes("aipi update [aipi-deps] would run: npm ci --prefix")));
assert.ok(logs.includes("aipi update dry-run complete."));

// Regression: a real (non-dry-run) Windows update must run npm.cmd via a shell as a
// single command string, NOT a bare `npm` (ENOENT) and NOT fragile cmd.exe per-arg
// quoting. git stays a direct git.exe spawn.
const winSpawns = [];
let updateSeedCalled = false;
await runAipiUpdate({
  packageRoot,
  userArgs: [],
  env: { AIPI_PI_BIN: "pi" },
  platform: "win32",
  existsSync: (candidate) => candidate.endsWith(".git"),
  log: () => {},
  errorLog: () => {},
  // Stub the model-context-window seed so the test never touches the real ~/.pi/agent/models.json.
  seedFns: {
    seedPiModels: async () => { updateSeedCalled = true; return { ok: true, wrote: false, pending: false, added: [], filled: [] }; },
    formatPiModelsSeedResult: () => "model context-windows: already correct",
  },
  spawnSyncFn: (command, second) => {
    const probe = gitOnlyRepoProbe(command, second);
    if (probe) return probe;
    winSpawns.push([command, second]);
    return { status: 0, stdout: "", stderr: "" };
  },
});
assert.ok(updateSeedCalled, "a real (non-dry-run) aipi update seeds model context-windows");
const winDeps = winSpawns.find(
  (call) => typeof call[0] === "string" && /\bnpm\.cmd\b/.test(call[0]) && /--prefix/.test(call[0]),
);
assert.ok(winDeps, "windows deps step must run npm.cmd via a shell (not a bare npm spawn)");
assert.equal(winDeps[1] && winDeps[1].shell, true, "windows npm.cmd step must use shell:true");
assert.ok(/^npm\.cmd /.test(winDeps[0]), "command line must start with the bare npm.cmd (no broken cmd.exe quoting)");
assert.ok(!winSpawns.some((call) => call[0] === "npm"), "must never spawn a bare `npm` on win32 (ENOENT)");
const winGit = winSpawns.find((call) => call[0] === "git" && Array.isArray(call[1]) && call[1].includes("pull"));
assert.ok(winGit, "windows git pull stays a direct git.exe spawn (no shell)");

// === aipiReinstallSpec: derive an npm reinstall target from package.json (ref stripped -> latest) ===
assert.equal(aipiReinstallSpec({ repository: { url: "git+https://github.com/overdrive-dev/aipi.git" } }), "github:overdrive-dev/aipi");
assert.equal(aipiReinstallSpec({ _from: "@overdrive-dev/aipi@github:someforker/aipi" }), "github:someforker/aipi");
assert.equal(aipiReinstallSpec({ _resolved: "git+https://github.com/overdrive-dev/aipi.git#abc123def" }), "github:overdrive-dev/aipi"); // sha dropped
assert.equal(aipiReinstallSpec({ repository: "github:overdrive-dev/aipi" }), "github:overdrive-dev/aipi");
assert.equal(aipiReinstallSpec({}), null);

// === inspectAipiInstall: git checkout vs npm-global vs npm-local ===
assert.equal(inspectAipiInstall({ packageRoot: path.join("C:", "repo", "aipi"), existsSync: () => true }).kind, "git-checkout");
const globalInstall = inspectAipiInstall({
  packageRoot: path.join("C:", "Users", "perse", "AppData", "Roaming", "npm", "node_modules", "@overdrive-dev", "aipi"),
  existsSync: () => false, // no .git
  readFile: () => JSON.stringify({ repository: { url: "git+https://github.com/overdrive-dev/aipi.git" } }),
  platform: "win32",
});
assert.equal(globalInstall.kind, "npm-global");
assert.equal(globalInstall.global, true);
assert.equal(globalInstall.spec, "github:overdrive-dev/aipi");

// === buildAipiUpdatePlan: an npm-global install REINSTALLS from source (no git-pull/npm-ci skip) ===
const reinstallPlan = buildAipiUpdatePlan({
  packageRoot: path.join("C:", "Users", "perse", "AppData", "Roaming", "npm", "node_modules", "@overdrive-dev", "aipi"),
  existsSync: () => false,
  install: { kind: "npm-global", global: true, spec: "github:overdrive-dev/aipi" },
  platform: "win32",
});
assert.equal(reinstallPlan.length, 2);
assert.equal(reinstallPlan[0].kind, "manual");
assert.match(reinstallPlan[0].message, /pi is bundled with aipi/);
assert.equal(reinstallPlan[1].kind, "exec");
assert.equal(reinstallPlan[1].command, "npm.cmd");
assert.deepEqual(reinstallPlan[1].args, ["install", "-g", "github:overdrive-dev/aipi"]);

// A project-local npm install reinstalls without -g.
const localReinstall = buildAipiUpdatePlan({
  packageRoot: path.join("C:", "proj", "node_modules", "@overdrive-dev", "aipi"),
  existsSync: () => false,
  install: { kind: "npm-local", global: false, spec: "github:overdrive-dev/aipi" },
  platform: "linux",
});
assert.deepEqual(localReinstall[1].args, ["install", "github:overdrive-dev/aipi"]);

// No derivable source -> the improved skip message points at the reinstall command.
const noSpecPlan = buildAipiUpdatePlan({
  packageRoot: path.join("C:", "opt", "node_modules", "@overdrive-dev", "aipi"),
  existsSync: () => false,
  install: { kind: "npm-local", global: false, spec: null },
});
assert.equal(noSpecPlan[1].kind, "manual");
assert.match(noSpecPlan[1].message, /npm install -g github:overdrive-dev\/aipi/);

console.log("AIPI_UPDATE_TEST_OK");
