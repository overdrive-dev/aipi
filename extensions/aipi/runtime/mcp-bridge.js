import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "@sinclair/typebox";

export const MCP_CONFIG_REL_PATH = ".aipi/mcp.json";
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10000;

export function registerAipiMcpBridge(pi, {
  projectRootResolver = (ctx) => ctx?.cwd ?? process.cwd(),
  connectTimeoutMs = numberFromEnv(process.env.AIPI_MCP_CONNECT_TIMEOUT_MS) ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  logger = console,
  clientFactory = (serverName) => new Client({
    name: `aipi-mcp-${sanitizeMcpName(serverName)}`,
    version: "0.1.0",
  }, { capabilities: {} }),
  transportFactory = (server) => new StdioClientTransport(server),
} = {}) {
  const bridge = new AipiMcpBridge({
    projectRootResolver,
    connectTimeoutMs,
    logger,
    clientFactory,
    transportFactory,
  });
  bridge.register(pi);
  return bridge;
}

export class AipiMcpBridge {
  constructor({
    projectRootResolver = (ctx) => ctx?.cwd ?? process.cwd(),
    connectTimeoutMs = DEFAULT_MCP_CONNECT_TIMEOUT_MS,
    logger = console,
    clientFactory,
    transportFactory,
  } = {}) {
    this.projectRootResolver = projectRootResolver;
    this.connectTimeoutMs = connectTimeoutMs;
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.transportFactory = transportFactory;
    this.projectRoot = null;
    this.configPath = null;
    this.configExists = false;
    this.configError = null;
    this.servers = new Map();
    this.tools = new Map();
    this.registeredToolNames = new Set();
    this.pi = null;
  }

  register(pi) {
    this.pi = pi;
    pi.on?.("session_start", async (event, ctx) => {
      await this.connectForContext(ctx, event);
      return undefined;
    });
    pi.on?.("session_shutdown", async () => {
      await this.closeAll();
      return undefined;
    });
    pi.registerCommand?.("aipi-mcp", {
      description: "Show configured MCP servers and bridged tool status.",
      handler: async (_args, ctx) => {
        try {
          await this.connectForContext(ctx, { reason: "aipi-mcp" });
          const report = this.status();
          ctx?.ui?.notify?.(formatMcpStatus(report), mcpStatusKind(report));
        } catch (error) {
          ctx?.ui?.notify?.(`AIPI MCP failed: ${error.message}`, "error");
        }
      },
    });
    return this;
  }

  async connectForContext(ctx = {}, event = {}) {
    const projectRoot = path.resolve(this.projectRootResolver(ctx, event) ?? process.cwd());
    if (this.projectRoot === projectRoot && (this.configError || this.servers.size || this.configExists === false)) {
      return this.status();
    }
    await this.closeAll();
    this.projectRoot = projectRoot;
    this.configPath = path.join(projectRoot, MCP_CONFIG_REL_PATH);
    this.configError = null;
    this.configExists = false;
    this.servers = new Map();
    this.tools = new Map();

    const config = await loadMcpConfig({ projectRoot });
    this.configExists = config.exists;
    this.configError = config.error;
    if (!config.exists || config.error) {
      return this.status();
    }

    for (const server of config.servers) {
      await this.connectServer(server);
    }
    return this.status();
  }

  async connectServer(server) {
    const status = {
      name: server.name,
      sanitized_name: sanitizeMcpName(server.name),
      command: server.command ?? null,
      disabled: Boolean(server.disabled),
      connected: false,
      tool_count: 0,
      tools: [],
      last_error: null,
    };
    this.servers.set(server.name, status);

    if (server.disabled) {
      status.last_error = "disabled in .aipi/mcp.json";
      return status;
    }
    if (!server.command) {
      status.last_error = "missing command";
      return status;
    }

    const transport = this.transportFactory({
      command: server.command,
      args: server.args,
      env: mergeServerEnv(server.env),
      cwd: server.cwd ? path.resolve(this.projectRoot, server.cwd) : this.projectRoot,
      stderr: "pipe",
    });
    const stderrLines = [];
    captureStderr(transport.stderr, stderrLines);
    const client = this.clientFactory(server.name);

    try {
      await withTimeout(
        client.connect(transport, { timeout: this.connectTimeoutMs }),
        this.connectTimeoutMs,
        `connect timed out after ${this.connectTimeoutMs}ms`,
      );
      const listed = await withTimeout(
        client.listTools(undefined, { timeout: this.connectTimeoutMs }),
        this.connectTimeoutMs,
        `tools/list timed out after ${this.connectTimeoutMs}ms`,
      );
      status.connected = true;
      status.client = client;
      status.transport = transport;
      for (const tool of listed.tools ?? []) {
        const publicName = this.registerTool(server, status, tool);
        status.tools.push({
          name: tool.name,
          public_name: publicName,
          description: tool.description ?? "",
        });
      }
      status.tool_count = status.tools.length;
      return status;
    } catch (error) {
      status.last_error = compactError(error, stderrLines);
      this.logger?.warn?.(`AIPI MCP server "${server.name}" skipped: ${status.last_error}`);
      await closeClientAndTransport(client, transport);
      return status;
    }
  }

  registerTool(server, status, tool) {
    const publicName = uniqueToolName(
      `mcp__${status.sanitized_name}__${sanitizeMcpName(tool.name)}`,
      this.registeredToolNames,
    );
    this.registeredToolNames.add(publicName);
    this.tools.set(publicName, {
      publicName,
      serverName: server.name,
      toolName: tool.name,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      status,
    });

    this.pi?.registerTool?.({
      name: publicName,
      label: tool.title ?? `${server.name}: ${tool.name}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
      parameters: jsonSchemaToTypeBoxParameters(tool.inputSchema),
      execute: async (_toolCallId, params = {}, signal) => {
        const result = await status.client.callTool(
          { name: tool.name, arguments: params ?? {} },
          undefined,
          { signal },
        );
        return {
          content: mapMcpContentToPiContent(result),
          details: {
            schema: "aipi.mcp-tool-result.v1",
            server: server.name,
            tool: tool.name,
            public_tool: publicName,
            is_error: Boolean(result?.isError),
            structured_content: result?.structuredContent ?? null,
            meta: result?._meta ?? null,
          },
        };
      },
    });
    return publicName;
  }

  status() {
    return {
      schema: "aipi.mcp-status.v1",
      projectRoot: this.projectRoot,
      configPath: this.configPath,
      configExists: this.configExists,
      configError: this.configError,
      servers: [...this.servers.values()].map((server) => ({
        name: server.name,
        sanitized_name: server.sanitized_name,
        command: server.command,
        disabled: server.disabled,
        connected: server.connected,
        tool_count: server.tool_count,
        tools: server.tools,
        last_error: server.last_error,
      })),
    };
  }

  async closeAll() {
    const closers = [];
    for (const status of this.servers.values()) {
      if (status.client || status.transport) {
        closers.push(closeClientAndTransport(status.client, status.transport));
      }
      if (status.connected) status.connected = false;
    }
    await Promise.allSettled(closers);
  }
}

export async function loadMcpConfig({ projectRoot } = {}) {
  const configPath = path.join(path.resolve(projectRoot ?? process.cwd()), MCP_CONFIG_REL_PATH);
  let data;
  try {
    data = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, path: configPath, error: null, servers: [] };
    }
    return { exists: true, path: configPath, error: `invalid JSON: ${error.message}`, servers: [] };
  }

  if (!data?.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)) {
    return { exists: true, path: configPath, error: "missing mcpServers object", servers: [] };
  }

  const servers = Object.entries(data.mcpServers).map(([name, value]) => normalizeServerConfig(name, value));
  return { exists: true, path: configPath, error: null, servers };
}

export function formatMcpStatus(report) {
  if (!report?.configExists) {
    return `AIPI MCP: no ${MCP_CONFIG_REL_PATH}; bridge inactive.`;
  }
  if (report.configError) {
    return [
      `AIPI MCP: config error at ${report.configPath}`,
      report.configError,
    ].join("\n");
  }
  if (!report.servers?.length) {
    return `AIPI MCP: ${report.configPath} has no servers.`;
  }
  const lines = [`AIPI MCP: ${report.configPath}`];
  for (const server of report.servers) {
    const state = server.disabled
      ? "disabled"
      : server.connected
        ? `connected tools=${server.tool_count}`
        : "failed";
    const toolNames = server.tools?.length
      ? ` (${server.tools.map((tool) => tool.public_name).join(", ")})`
      : "";
    const error = server.last_error ? `; last_error=${server.last_error}` : "";
    lines.push(`- ${server.name}: ${state}${toolNames}${error}`);
  }
  lines.push("MCP transport scope: stdio tools only; direct HTTP/SSE OAuth and MCP resources/prompts are deferred.");
  return lines.join("\n");
}

export function mcpStatusKind(report) {
  if (!report?.configExists || report.configError) return "warning";
  if ((report.servers ?? []).some((server) => !server.disabled && !server.connected)) return "warning";
  return "info";
}

export function sanitizeMcpName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "unnamed";
}

export function jsonSchemaToTypeBoxParameters(inputSchema = {}) {
  const schema = isObject(inputSchema) ? inputSchema : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const properties = isObject(schema.properties) ? schema.properties : {};
  const converted = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const property = jsonSchemaPropertyToTypeBox(propertySchema);
    converted[name] = required.has(name) ? property : Type.Optional(property);
  }
  return Type.Object(converted, {
    ...schemaOptions(schema),
    additionalProperties: typeof schema.additionalProperties === "boolean"
      ? schema.additionalProperties
      : true,
  });
}

function jsonSchemaPropertyToTypeBox(schema = {}) {
  if (!isObject(schema)) return Type.Unknown();
  const options = schemaOptions(schema);
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return Type.Union(schema.enum.map((value) => Type.Literal(value)), options);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    return Type.Union(schema.anyOf.map((item) => jsonSchemaPropertyToTypeBox(item)), options);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    return Type.Union(schema.oneOf.map((item) => jsonSchemaPropertyToTypeBox(item)), options);
  }

  const type = Array.isArray(schema.type)
    ? schema.type.find((item) => item !== "null") ?? schema.type[0]
    : schema.type;
  switch (type) {
    case "string":
      return Type.String(options);
    case "number":
      return Type.Number(options);
    case "integer":
      return Type.Integer(options);
    case "boolean":
      return Type.Boolean(options);
    case "array":
      return Type.Array(jsonSchemaPropertyToTypeBox(schema.items), options);
    case "object":
      return jsonSchemaToTypeBoxParameters(schema);
    case "null":
      return Type.Null(options);
    default:
      return Type.Unknown(options);
  }
}

function mapMcpContentToPiContent(result = {}) {
  const content = Array.isArray(result?.content) ? result.content : [];
  if (!content.length && result?.structuredContent) {
    return [{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }];
  }
  if (!content.length && Object.hasOwn(result ?? {}, "toolResult")) {
    return [{ type: "text", text: JSON.stringify(result.toolResult, null, 2) }];
  }
  if (!content.length) {
    return [{ type: "text", text: "MCP tool returned no content." }];
  }
  return content.map((part) => {
    if (part?.type === "text") return { type: "text", text: String(part.text ?? "") };
    if (part?.type === "resource") {
      const resource = part.resource ?? {};
      if (typeof resource.text === "string") return { type: "text", text: resource.text };
      return { type: "text", text: `[MCP resource ${resource.uri ?? "unknown"} ${resource.mimeType ?? ""}]`.trim() };
    }
    if (part?.type === "resource_link") {
      return { type: "text", text: `[MCP resource link ${part.name ?? part.uri ?? "unknown"}]` };
    }
    if (part?.type === "image") {
      return { type: "text", text: `[MCP image ${part.mimeType ?? "unknown"} ${String(part.data ?? "").length} base64 chars]` };
    }
    if (part?.type === "audio") {
      return { type: "text", text: `[MCP audio ${part.mimeType ?? "unknown"} ${String(part.data ?? "").length} base64 chars]` };
    }
    return { type: "text", text: JSON.stringify(part, null, 2) };
  });
}

function normalizeServerConfig(name, value) {
  const config = isObject(value) ? value : {};
  return {
    name,
    disabled: config.disabled === true,
    command: typeof config.command === "string" && config.command.trim() ? config.command.trim() : null,
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: isObject(config.env) ? Object.fromEntries(Object.entries(config.env).map(([key, val]) => [key, String(val)])) : {},
    cwd: typeof config.cwd === "string" && config.cwd.trim() ? config.cwd.trim() : null,
  };
}

function mergeServerEnv(env = {}) {
  return {
    ...getDefaultEnvironment(),
    ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
  };
}

function schemaOptions(schema = {}) {
  const options = {};
  for (const key of ["description", "default", "examples", "title", "minimum", "maximum", "minLength", "maxLength", "pattern"]) {
    if (Object.hasOwn(schema, key)) options[key] = schema[key];
  }
  return options;
}

function uniqueToolName(baseName, existing) {
  let candidate = baseName;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function captureStderr(stream, lines) {
  if (!stream?.on) return;
  stream.on("data", (chunk) => {
    const text = String(chunk ?? "").trim();
    if (text) lines.push(text);
    if (lines.length > 20) lines.splice(0, lines.length - 20);
  });
}

function compactError(error, stderrLines = []) {
  const message = String(error?.message ?? error);
  const stderr = stderrLines.join("\n").trim();
  if (!stderr) return message;
  return `${message}; stderr=${stderr.slice(0, 1000)}`;
}

async function closeClientAndTransport(client, transport) {
  try {
    await client?.close?.();
  } catch {
    /* best-effort MCP cleanup */
  }
  try {
    await transport?.close?.();
  } catch {
    /* best-effort MCP cleanup */
  }
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function numberFromEnv(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
