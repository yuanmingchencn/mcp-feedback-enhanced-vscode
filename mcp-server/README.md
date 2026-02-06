# MCP Feedback Enhanced Server

The MCP Server component for **MCP Feedback Enhanced**.

It acts as the bridge between your AI Agent (Cursor/Claude) and the VSCode Extension's feedback panel.

## 📦 Usage

You typically don't need to install this manually. The VSCode Extension auto-configures it using `npx`.

### Configuration (Auto-Configured)

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "npx",
      "args": ["-y", "mcp-feedback-enhanced@latest"],
      "timeout": 86400,
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

## 🛠️ Tools

### `interactive_feedback`
Requests user feedback via the sidebar panel.
- `project_directory`: Context matching.
- `summary`: Markdown summary of what the AI needs.
- `timeout`: Default **86400s** (24h).

## 📄 License
MIT
