import assert from "node:assert/strict";
import {
  OwnedFileRegistry,
  classifyToolCall,
  isControllerOwnedPath,
  makeOwnedFileGuard,
  wrapWriteToolWithOwnership,
} from "../extensions/aipi/runtime/owned-files.js";

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

// Project-write scope: a code-writing (implementation/fix/tdd) worker may write ANY project
// source file it never pre-declared, while controller-owned state stays blocked.
const scoped = new OwnedFileRegistry(process.cwd());
scoped.allocate("fixer:1", [".aipi/runtime/runs/run-1/steps/fix/FIXES.md"]);
scoped.grantProjectScope("fixer:1");
assert.equal(scoped.hasProjectScope("fixer:1"), true);
const fixerGuard = makeOwnedFileGuard(scoped, "fixer:1");
// Undeclared source file is writable under project scope.
assert.equal(fixerGuard({ name: "write", input: { path: "frontend/src/lib/gestores-tipo.ts" } }), undefined);
assert.equal(fixerGuard({ name: "write", input: { path: "src/brand-new.js" } }), undefined);
// Its own run-dir artifact is still writable.
assert.equal(fixerGuard({ name: "write", input: { path: ".aipi/runtime/runs/run-1/steps/fix/FIXES.md" } }), undefined);
// Controller-owned memory/runtime stays blocked even with project scope.
assert.match(
  fixerGuard({ name: "write", input: { path: ".aipi/memory/project/project.md" } })?.reason,
  /controller-owned AIPI memory\/runtime/,
);
assert.match(
  fixerGuard({ name: "write", input: { path: ".aipi/runtime/runs/run-1/state.json" } })?.reason,
  /controller-owned AIPI memory\/runtime/,
);
// A worker WITHOUT project scope still can't write an undeclared source file.
assert.equal(scoped.owns("fixer:1", "frontend/src/lib/gestores-tipo.ts"), true);
assert.equal(registry.owns("implementer:step-artifact", "frontend/src/lib/gestores-tipo.ts"), false);
// Releasing the worker drops its project scope.
scoped.release("fixer:1");
assert.equal(scoped.hasProjectScope("fixer:1"), false);
assert.equal(scoped.owns("fixer:1", "frontend/src/lib/gestores-tipo.ts"), false);

// ADV-62-3: .git is centrally protected — a project-scoped worker is fail-closed against .git writes
// across EVERY shared guard surface (not just the child extension's private normalizer).
assert.equal(isControllerOwnedPath(".git/config"), true);
assert.equal(isControllerOwnedPath(".git"), true);
const gitScoped = new OwnedFileRegistry(process.cwd());
gitScoped.grantProjectScope("fixer:git");
assert.equal(gitScoped.owns("fixer:git", ".git/config"), false);
assert.equal(gitScoped.isProtectedWritePath(".git/config"), true);
assert.throws(() => gitScoped.allocate("fixer:git2", [".git/config"]), /owned-file protected path/);
const gitGuard = makeOwnedFileGuard(gitScoped, "fixer:git");
assert.match(gitGuard({ name: "write", input: { path: ".git/config" } })?.reason, /controller-owned/);
// wrapWriteToolWithOwnership must refuse .git before delegating to the underlying write.
let innerRan = false;
const wrapped = wrapWriteToolWithOwnership(
  { name: "write", execute: async () => { innerRan = true; return { content: [{ type: "text", text: "wrote" }] }; } },
  { registry: gitScoped, agentId: "fixer:git" },
);
const wrappedResult = await wrapped.execute("c1", { path: ".git/config" });
assert.equal(wrappedResult.isError, true);
assert.equal(innerRan, false, "wrapped write must not delegate to the inner write for .git");
// ...but a real source file under project scope still delegates.
const wrappedOk = await wrapped.execute("c2", { path: "frontend/src/app.ts" });
assert.equal(innerRan, true);
assert.match(wrappedOk.content?.[0]?.text ?? "", /wrote/);

// snapshot/restore round-trips the project-scope grant.
const snapSource = new OwnedFileRegistry(process.cwd());
snapSource.allocate("fixer:2", [".aipi/runtime/runs/run-2/steps/fix/FIXES.md"]);
snapSource.grantProjectScope("fixer:2");
const restored = new OwnedFileRegistry(process.cwd());
restored.restore(snapSource.snapshot());
assert.equal(restored.hasProjectScope("fixer:2"), true);
assert.equal(restored.owns("fixer:2", "src/anything.js"), true);

console.log("AIPI_OWNED_FILES_TEST_OK");
