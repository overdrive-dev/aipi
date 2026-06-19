import fs from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const logPath = process.argv[2] ?? null;

const server = new Server(
  { name: "aipi-fake-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo.tool",
      description: "Echo a message through the fake MCP fixture.",
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", description: "Message to echo." },
          count: { type: "integer", description: "Optional count." },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (logPath) {
    await fs.appendFile(logPath, `${JSON.stringify({
      name: request.params.name,
      arguments: args,
      env: process.env.AIPI_FAKE_MCP_VALUE ?? null,
    })}\n`);
  }
  return {
    content: [{ type: "text", text: `echo:${args.message ?? ""}` }],
    structuredContent: { echoed: args.message ?? null, count: args.count ?? null },
  };
});

await server.connect(new StdioServerTransport());
