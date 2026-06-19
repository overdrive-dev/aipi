import assert from "node:assert/strict";
import { OwnedFileRegistry, classifyToolCall, makeOwnedFileGuard } from "../extensions/aipi/runtime/owned-files.js";

const registry = new OwnedFileRegistry(process.cwd());
registry.allocate("implementer:1", ["src/a.js"]);
const guard = makeOwnedFileGuard(registry, "implementer:1");

assert.equal(guard({ name: "read", input: { path: "src/b.js" } }), undefined);
assert.equal(guard({ name: "write", input: { path: "src/a.js" } }), undefined);

assert.equal(guard({ name: "write", input: { path: "src/b.js" } })?.block, true);
assert.equal(guard({ name: "write", input: {} })?.block, true);
assert.equal(guard({ name: "bash", input: { command: "echo x > src/a.js" } })?.block, true);
assert.equal(guard({ name: "unknown_mutator", input: { path: "src/a.js" } })?.block, true);
assert.match(
  guard({ name: "write", input: { path: ".aipi/memory/project/project.md" } })?.reason,
  /controller-owned AIPI memory\/runtime/,
);
assert.match(
  guard({ name: "write", input: { path: ".aipi/runtime/runs/run-1/state.json" } })?.reason,
  /controller-owned AIPI memory\/runtime/,
);

assert.deepEqual(classifyToolCall({ name: "grep", input: { pattern: "x" } }), { decision: "allow" });
assert.equal(classifyToolCall({ input: {} }).decision, "block");

assert.throws(() => registry.allocate("implementer:2", ["src/a.js"]), /owned-file conflict/);
assert.throws(
  () => registry.allocate("implementer:memory", [".aipi/memory/project/project.md"]),
  /owned-file protected path/,
);
assert.throws(
  () => registry.allocate("implementer:runtime", [".aipi/runtime/runs/run-1/state.json"]),
  /owned-file protected path/,
);
registry.allocate("implementer:step-artifact", [".aipi/runtime/runs/run-1/steps/implement/RESULT.md"]);
const stepArtifactGuard = makeOwnedFileGuard(registry, "implementer:step-artifact");
assert.equal(
  stepArtifactGuard({ name: "write", input: { path: ".aipi/runtime/runs/run-1/steps/implement/RESULT.md" } }),
  undefined,
);

console.log("AIPI_OWNED_FILES_TEST_OK");
