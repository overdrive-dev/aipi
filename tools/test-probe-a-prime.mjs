import assert from "node:assert/strict";
import {
  wrapWriteToolWithOwnership,
  classifyInProcessEnforcement,
} from "../extensions/aipi/runtime/probe-a-prime.js";
import { OwnedFileRegistry } from "../extensions/aipi/runtime/owned-files.js";

// The wrapper blocks out-of-scope writes BEFORE delegating, and passes in-scope
// writes through to the real tool. Proven with a spy inner execute (no SDK).
const registry = new OwnedFileRegistry("/repo");
registry.allocate("worker-a", ["src/a.txt"]);

const innerCalls = [];
const fakeWriteTool = {
  name: "write",
  parameters: { properties: { path: {}, content: {} } },
  execute: async (_id, params) => {
    innerCalls.push(params.path);
    return { content: [{ type: "text", text: "wrote" }], isError: false };
  },
};
const guarded = wrapWriteToolWithOwnership(fakeWriteTool, { registry, agentId: "worker-a" });

// Out-of-scope: blocked, inner never runs.
const blocked = await guarded.execute("1", { path: "src/b.txt", content: "x" });
assert.equal(blocked.isError, true);
assert.equal(innerCalls.length, 0, "inner must not run on a blocked write");

// Missing path: blocked.
const noPath = await guarded.execute("2", { content: "x" });
assert.equal(noPath.isError, true);

// Controller-owned AIPI memory/runtime paths stay blocked even if a bad caller
// presents them as owned.
const protectedRegistry = {
  owns: () => true,
  isProtectedWritePath: (target) => String(target).startsWith(".aipi/memory/"),
};
const protectedGuarded = wrapWriteToolWithOwnership(fakeWriteTool, { registry: protectedRegistry, agentId: "worker-a" });
const protectedWrite = await protectedGuarded.execute("protected", {
  path: ".aipi/memory/project/project.md",
  content: "x",
});
assert.equal(protectedWrite.isError, true);
assert.match(protectedWrite.content[0].text, /controller-owned AIPI memory\/runtime/);
assert.equal(innerCalls.length, 0, "inner must not run on a protected AIPI memory write");

// In-scope: delegates to the real tool.
const allowed = await guarded.execute("3", { path: "src/a.txt", content: "x" });
assert.equal(allowed.isError, false);
assert.deepEqual(innerCalls, ["src/a.txt"], "inner runs once for an in-scope write");

// Classifier verdicts.
assert.equal(
  classifyInProcessEnforcement({
    hasWriteToolFactory: true,
    blockedOutOfScope: true,
    innerSkippedOnBlock: true,
    allowedInScope: true,
  }).verdict,
  "IN_PROCESS_VIABLE",
);
assert.equal(
  classifyInProcessEnforcement({ hasWriteToolFactory: true, blockedOutOfScope: false }).verdict,
  "IN_PROCESS_NOT_VIABLE",
);
assert.equal(classifyInProcessEnforcement({}).verdict, "IN_PROCESS_NOT_VIABLE");

console.log("AIPI_PROBE_A_PRIME_TEST_OK");
