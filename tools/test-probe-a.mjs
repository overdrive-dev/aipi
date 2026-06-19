import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeProbeA,
  formatProbeAResult,
  piSdkImportCandidates,
  parseProbeAArgs,
  ProbeAController,
} from "../extensions/aipi/runtime/probe-a.js";

assert.deepEqual(parseProbeAArgs("run --dry-run"), { action: "run", dryRun: true });
assert.deepEqual(parseProbeAArgs("status"), { action: "status", dryRun: false });
assert.throws(() => parseProbeAArgs("--wat"), /Unknown \/aipi-probe-a option/);
const sdkCandidates = piSdkImportCandidates({
  env: { AIPI_PI_SDK_PATH: "C:\\pi\\dist\\index.js", APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
  argv: ["node", "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js"],
  homeDir: "C:\\Users\\u",
});
assert.equal(sdkCandidates[0], "C:\\pi\\dist\\index.js");
assert.ok(
  sdkCandidates.includes(
    "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\index.js",
  ),
);

const probeRelDir = ".aipi/runtime/probes/tool-call-attribution/probe-1";
const hostToolCall = (workerId, sessionId) => ({
  type: "pi_event",
  scope: "host",
  eventName: "tool_call",
  event: {
    toolName: "write",
    input: {
      path: `${probeRelDir}/${workerId}.txt`,
    },
  },
  identity: {
    eventSessionId: sessionId,
  },
});

const pass = analyzeProbeA(
  [hostToolCall("worker-a", "session-a"), hostToolCall("worker-b", "session-b")],
  { probeRelDir },
);
assert.equal(pass.verdict, "PASS");
assert.equal(pass.identityValues.length, 2);
assert.match(formatProbeAResult(pass), /Probe A PASS/);

const partial = analyzeProbeA(
  [hostToolCall("worker-a", "same-session"), hostToolCall("worker-b", "same-session")],
  { probeRelDir },
);
assert.equal(partial.verdict, "PARTIAL");
assert.match(partial.nextAction, /Probe A' wrapped write-tool enforcement/);

const fail = analyzeProbeA([hostToolCall("worker-a", "session-a")], { probeRelDir });
assert.equal(fail.verdict, "FAIL");
assert.match(fail.nextAction, /wrapped write-tool enforcement/);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-probe-a-"));
try {
  const events = [];
  const fakePi = {
    on(eventName, handler) {
      events.push({ eventName, handler });
    },
  };
  const controller = new ProbeAController(fakePi);
  controller.registerHooks();
  assert.ok(events.some((event) => event.eventName === "tool_call"));

  const dryRun = await controller.run({
    projectRoot: tempRoot,
    args: "run --dry-run",
  });
  assert.equal(dryRun.verdict, "BLOCKED");
  assert.match(dryRun.summary, /dry-run requested/);

  const status = await controller.run({ projectRoot: tempRoot, args: "status" });
  assert.equal(status.verdict, "LAST");
  assert.equal(status.probeId, dryRun.probeId);

  console.log("AIPI_PROBE_A_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
