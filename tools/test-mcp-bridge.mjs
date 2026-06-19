import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatMcpStatus,
  jsonSchemaToTypeBoxParameters,
  loadMcpConfig,
  registerAipiMcpBridge,
  sanitizeMcpName,
} from "../extensions/aipi/runtime/mcp-bridge.js";

function createFakePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = {};
  return {
    tools,
    commands,
    handlers,
    pi: {
      registerTool(tool) {
        assert.equal(typeof tool.name, "string");
        assert.equal(typeof tool.execute, "function");
        tools.set(tool.name, tool);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      on(eventName, handler) {
        handlers[eventName] = handler;
      },
    },
  };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-mcp-"));
const noConfigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-mcp-none-"));
let bridge = null;

try {
  assert.equal(sanitizeMcpName("Linear API!"), "linear_api");
  const parameters = jsonSchemaToTypeBoxParameters({
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string" },
      count: { type: "integer" },
    },
  });
  assert.equal(parameters.type, "object");
  assert.ok(parameters.required.includes("message"));
  assert.ok(!parameters.required.includes("count"));

  await fs.mkdir(path.join(tempRoot, ".aipi"), { recursive: true });
  const callLog = path.join(tempRoot, "mcp-calls.jsonl");
  const fakeServer = path.resolve("tools/fixtures/fake-mcp-server.mjs");
  await fs.writeFile(path.join(tempRoot, ".aipi", "mcp.json"), `${JSON.stringify({
    mcpServers: {
      good: {
        command: process.execPath,
        args: [fakeServer, callLog],
        env: { AIPI_FAKE_MCP_VALUE: "fixture-env" },
      },
      bad: {
        command: process.execPath,
        args: ["-e", "process.stderr.write('bad server fixture\\n'); process.exit(1)"],
      },
    },
  }, null, 2)}\n`);

  const config = await loadMcpConfig({ projectRoot: tempRoot });
  assert.equal(config.exists, true);
  assert.equal(config.error, null);
  assert.equal(config.servers.length, 2);

  const fake = createFakePi();
  const warnings = [];
  bridge = registerAipiMcpBridge(fake.pi, {
    projectRootResolver: () => tempRoot,
    connectTimeoutMs: 2000,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.ok(fake.commands.has("aipi-mcp"));
  await fake.handlers.session_start({ reason: "test" }, { cwd: tempRoot });

  const tool = fake.tools.get("mcp__good__echo_tool");
  assert.ok(tool, "fake MCP tool must be registered with sanitized namespace");
  assert.equal(tool.parameters.type, "object");
  assert.ok(tool.parameters.required.includes("message"));

  const report = bridge.status();
  const good = report.servers.find((server) => server.name === "good");
  const bad = report.servers.find((server) => server.name === "bad");
  assert.equal(good.connected, true);
  assert.equal(good.tool_count, 1);
  assert.equal(bad.connected, false);
  assert.match(bad.last_error, /bad server fixture|closed|timed out|Connection/i);
  assert.ok(warnings.some((line) => line.includes('"bad" skipped')));

  const result = await tool.execute("tool-call-1", { message: "hello", count: 2 }, undefined, undefined, { cwd: tempRoot });
  assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);
  assert.equal(result.details.server, "good");
  assert.equal(result.details.tool, "echo.tool");
  assert.equal(result.details.public_tool, "mcp__good__echo_tool");
  assert.deepEqual(result.details.structured_content, { echoed: "hello", count: 2 });

  const loggedCall = JSON.parse((await fs.readFile(callLog, "utf8")).trim());
  assert.deepEqual(loggedCall, {
    name: "echo.tool",
    arguments: { message: "hello", count: 2 },
    env: "fixture-env",
  });

  const notices = [];
  await fake.commands.get("aipi-mcp").handler("", {
    cwd: tempRoot,
    ui: { notify: (message, kind) => notices.push({ message, kind }) },
  });
  assert.equal(notices[0].kind, "warning");
  assert.match(notices[0].message, /good: connected tools=1/);
  assert.match(notices[0].message, /bad: failed/);
  assert.match(formatMcpStatus(report), /direct HTTP\/SSE OAuth and MCP resources\/prompts are deferred/);

  await fake.handlers.session_shutdown({}, { cwd: tempRoot });
  bridge = null;

  const noConfig = createFakePi();
  const inertBridge = registerAipiMcpBridge(noConfig.pi, {
    projectRootResolver: () => noConfigRoot,
    connectTimeoutMs: 500,
    logger: { warn() {} },
  });
  await noConfig.handlers.session_start({ reason: "test" }, { cwd: noConfigRoot });
  assert.equal(noConfig.tools.size, 0);
  assert.equal(inertBridge.status().configExists, false);
  assert.match(formatMcpStatus(inertBridge.status()), /bridge inactive/);
  await noConfig.handlers.session_shutdown({}, { cwd: noConfigRoot });

  console.log("AIPI_MCP_BRIDGE_TEST_OK");
} finally {
  await bridge?.closeAll?.();
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.rm(noConfigRoot, { recursive: true, force: true });
}
