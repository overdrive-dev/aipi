import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OwnedFileRegistry } from "../extensions/aipi/runtime/owned-files.js";
import { loadPiSdk } from "../extensions/aipi/runtime/probe-a.js";
import { buildWorkerTools, createWorkerProviderOptions } from "../extensions/aipi/runtime/subagents.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-real-sdk-toolset-"));

try {
  const sdk = await loadPiSdk();
  assert.equal(typeof sdk.createAgentSession, "function", "Pi SDK must expose createAgentSession");

  const registry = new OwnedFileRegistry(tempRoot);
  const agentId = "worker-real-sdk";
  registry.allocate(agentId, ["owned.txt"]);

  const { customTools, toolNames } = buildWorkerTools(sdk, {
    root: tempRoot,
    registry,
    agentId,
  });
  const expectedTools = ["find", "grep", "ls", "read", "write"];
  assert.deepEqual([...toolNames].sort(), expectedTools);

  const sessionManager = sdk.SessionManager?.inMemory?.(tempRoot);
  const providerOptions = await createWorkerProviderOptions(sdk, { cwd: tempRoot });
  assert.ok(providerOptions.authStorage, "worker session must include AuthStorage");
  assert.ok(providerOptions.modelRegistry, "worker session must include ModelRegistry");
  assert.ok(providerOptions.resourceLoader, "worker session must include provider ResourceLoader");
  const { session } = await sdk.createAgentSession({
    cwd: tempRoot,
    noTools: "all",
    tools: toolNames,
    customTools,
    ...providerOptions,
    ...(sessionManager ? { sessionManager } : {}),
  });

  try {
    const activeTools = normalizeToolList(session.getAllTools?.()).map((tool) => tool.name).sort();
    assert.deepEqual(activeTools, expectedTools);
    assert.equal(activeTools.includes("bash"), false);
    assert.equal(activeTools.includes("edit"), false);

    const guardedWrite =
      session.getToolDefinition?.("write") ??
      normalizeToolList(session.getAllTools?.()).find((tool) => tool.name === "write");
    assert.ok(guardedWrite, "worker session must resolve the guarded custom write tool");
    assert.equal(typeof guardedWrite.execute, "function", "guarded write tool must be executable");

    const blocked = await guardedWrite.execute("blocked", {
      path: "not-owned.txt",
      content: "blocked",
    });
    assert.equal(blocked?.isError, true);
    assert.equal(await pathExists(path.join(tempRoot, "not-owned.txt")), false);

    const allowed = await guardedWrite.execute("allowed", {
      path: "owned.txt",
      content: "ok",
    });
    assert.notEqual(allowed?.isError, true);
    assert.equal(await fs.readFile(path.join(tempRoot, "owned.txt"), "utf8"), "ok");
  } finally {
    await Promise.resolve(session.dispose?.());
  }

  console.log(`AIPI_SUBAGENTS_REAL_SDK_TOOLSET_TEST_OK tools=${expectedTools.join(",")}`);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function normalizeToolList(tools) {
  if (!tools) return [];
  if (Array.isArray(tools)) return tools;
  if (tools instanceof Map) return [...tools.values()];
  return Object.values(tools);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
