# MCP Feedback Enhanced

**Interactive feedback collection for AI assistants in VSCode & Cursor.**

Connects your AI Agent (via MCP) to a rich, native sidebar interface for soliciting user feedback, approvals, and corrections.

## ✨ Features

- **💬 Rich Feedback UI**: Dedicated sidebar panel with history, markdown support, and quick replies.
- **🛠️ Robust Connection**: Auto-reconnects with fallback strategies (localhost/127.0.0.1) and clear status indicators.
- **📥 Pending Queue**: Queue multiple feedback items even when no session is active.
- **🔄 Auto-Configuration**: Automatically sets up the MCP server in `~/.cursor/mcp.json` upon installation.
- **🧠 Hidden Rules**: Active rules are injected into the AI context invisibly, keeping your chat clean.
- **⚡ Real-time**: WebSocket-based communication for instant interaction.
- **🔒 Secure & Local**: All data and history are stored locally on your machine.
- **🔌 Multi-Window Support**: Works perfectly with multiple Cursor windows and projects.

## 🚀 Getting Started

### 1. Install the Extension
Install **MCP Feedback Enhanced** from the VS Code Marketplace or Open VSX.

### 2. Verify MCP Configuration
The extension attempts to auto-configure your `~/.cursor/mcp.json`. It should look like this:

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

> **Note**: The timeout is set to **24 hours** (86400s) to allow long-running sessions without interruption.

### 3. Usage
When your AI Agent (using the `interactive_feedback` tool) requests input:
1. The **MCP Feedback** panel will automatically open/focus.
2. Review the AI's summary/request.
3. Type your feedback or click a **Quick Reply** (Continue, Good, Fix).
4. The AI receives your input immediately and proceeds.

## ⚙️ Settings & Customization

- **Hidden Rules**: Add rules in the "Settings" tab of the panel. These are sent to the AI with every request but remain hidden from the chat UI.
- **Auto-Reply**: Configure automatic responses for specific scenarios.
- **History**: View past feedback sessions in the History tab.

## 🔧 Troubleshooting

- **"Connecting..."**: Ensure the extension is active. Try reloading the window (`Cmd+R` / `Ctrl+R`).
- **MCP Server Error**: Verify `mcp.json` configuration matches the snippet above.
- **Multiple Windows**: The system automatically routes requests to the correct window based on the project path.

## 📦 For Developers

- **NPM Package**: [`mcp-feedback-enhanced`](https://www.npmjs.com/package/mcp-feedback-enhanced)
- **Repo**: [GitHub](https://github.com/yuanmingchencn/mcp-feedback-enhanced-vscode)

---
*Powered by [Model Context Protocol](https://modelcontextprotocol.io/)*
