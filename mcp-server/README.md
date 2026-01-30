# MCP Feedback Enhanced Server

**Version: 1.0.0**

MCP Server component that connects to the VSCode Extension's WebSocket server to collect user feedback.

## Architecture

```
┌─────────────────┐         ┌─────────────────┐
│   Cursor/AI     │  stdio  │   MCP Server    │
│   (AI Client)   │ ←────→  │   (This)        │
└─────────────────┘         └────────┬────────┘
                                     │ WebSocket
                                     ▼
                            ┌─────────────────┐
                            │ VSCode Extension│
                            │   (WS Server)   │
                            └────────┬────────┘
                                     │
                                     ▼
                            ┌─────────────────┐
                            │ Feedback Panel  │
                            │   (Webview)     │
                            └─────────────────┘
```

## How It Works

1. **Extension starts** → Creates WebSocket server → Writes `~/.config/mcp-feedback-enhanced/servers/<pid>.json`
2. **MCP Server starts** → Waits for `interactive_feedback` call
3. **AI calls tool** → MCP Server reads server files → Finds matching Extension by workspace path → Connects
4. **User submits** → Feedback flows back to AI

## Server Discovery

MCP Server finds the correct Extension using priority-based matching:

| Priority | Strategy | Description |
|----------|----------|-------------|
| 1 | **CURSOR_TRACE_ID** | Same Cursor window (environment variable) |
| 2 | **Exact workspace** | `project_directory` in server's `workspaces` array |
| 3 | **Prefix match** | Project is inside a workspace directory |
| 4 | **parentPid** | Same parent process (backward compatibility) |
| 5 | **Single server** | Only one server running |
| 6 | **Most recent** | Last registered server by timestamp |

## Tools

### interactive_feedback

Collect feedback from user through the VSCode sidebar panel.

```typescript
{
  project_directory: string;  // Project path for context & server matching
  summary: string;            // AI summary for user review
  timeout?: number;           // Timeout in seconds (default: 600)
}
```

### get_system_info

Returns system environment information.

## Installation

### Via npx (Recommended)

No installation needed! Just add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "npx",
      "args": ["-y", "mcp-feedback-enhanced@latest"],
      "timeout": 89400,
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

### Via npm (Global install)

```bash
npm install -g mcp-feedback-enhanced
```

Then configure:

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "mcp-feedback-enhanced",
      "timeout": 89400,
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

### Local development

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "MCP_FEEDBACK_DEBUG": "true"
      },
      "timeout": 89400,
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_FEEDBACK_DEBUG` | `false` | Enable debug logging to stderr |

## Debug Mode

Set `MCP_FEEDBACK_DEBUG=true` to see:
- Server discovery process
- WebSocket connection status
- Message flow between components

## Troubleshooting

### "No MCP Feedback Extension found for project"

1. Ensure VSCode extension is installed and activated
2. Open the MCP Feedback panel (click sidebar icon)
3. Check `~/.config/mcp-feedback-enhanced/servers/` for server files
4. Verify your project path is in the `workspaces` array

### Connection timeout

1. Check if Extension's WebSocket server is running (port in server file)
2. Verify no firewall blocking localhost connections
3. Try reloading the Cursor window

## License

MIT
