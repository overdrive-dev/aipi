# AIPI MCP Bridge

AIPI can expose tools from configured MCP servers to Pi through a bridge
extension. Pi does not include MCP by default, so the `aipi` wrapper loads this
bridge only when the target project has `.aipi/mcp.json`.

## Configuration

`/aipi-init` scaffolds `.aipi/mcp.json` with the familiar Claude/Cursor shape:

```json
{
  "mcpServers": {
    "linear": {
      "disabled": true,
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      "env": {}
    }
  }
}
```

Set `disabled` to `false` or remove it for servers you want AIPI to start. The
bridge supports stdio MCP servers first: `command`, `args`, optional `env`, and
optional `cwd`. Server tools are registered in Pi as
`mcp__<server>__<tool>`, with names sanitized to letters, numbers, `_`, and `-`.

## Linear

Linear is supported through `mcp-remote`, which handles the browser OAuth flow
and caches the token outside this repo.

1. Run `/aipi-init` in the target project.
2. Edit `.aipi/mcp.json` and enable the Linear server:

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
    }
  }
}
```

3. Start `aipi` from that project.
4. Complete the first-run `mcp-remote` browser login when it opens.
5. Run `/aipi-mcp`. Linear should show as connected with its discovered tool
   count, and Linear tools will be available as `mcp__linear__...`.

## Scope

This round implements MCP tools over stdio. Direct Streamable HTTP/SSE OAuth
transport is deferred; use `mcp-remote` for remote OAuth servers. MCP resources and prompts are also deferred.

MCP connection is best-effort. If one server fails to start or handshake, AIPI
logs that server's last error, skips it, and continues registering tools from
other servers. All MCP transports are closed on Pi `session_shutdown`.
