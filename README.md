# MCP Feedback Enhanced

**Interactive feedback collection for AI assistants in VSCode & Cursor.**

Connects your AI Agent (via MCP) to a rich, native sidebar interface for soliciting user feedback, approvals, and corrections — with real-time pending message injection via Cursor Hooks.

## Features

- **Rich Feedback UI**: Dedicated sidebar panel with history, markdown support, and quick replies.
- **Cursor Hooks Integration**: Automatically injects pending user comments into the agent loop in real time via `sessionStart`, `preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `subagentStart`, and `stop` hooks.
- **Pending Queue**: Queue comments while the agent is working — they are injected at the earliest opportunity.
- **Auto-Configuration**: Automatically sets up the MCP server (`~/.cursor/mcp.json`) and Cursor hooks (`~/.cursor/hooks.json`) upon activation.
- **Browser Fallback**: If the panel is unavailable, feedback automatically falls back to a system browser page.
- **Multi-Window Support**: Routes requests to the correct Cursor window based on workspace matching and `CURSOR_TRACE_ID`.
- **Secure & Local**: All data stays on your machine.

## Getting Started

### 1. Install the Extension
Install **MCP Feedback Enhanced** from the VS Code Marketplace or Open VSX.

### 2. Verify MCP Configuration
The extension auto-configures `~/.cursor/mcp.json`:

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

### 3. Verify Cursor Hooks
The extension auto-deploys `~/.cursor/hooks.json` with entries for all supported hook points. This enables real-time pending message injection.

### 4. Usage
1. The AI Agent calls `interactive_feedback` to request input.
2. The **MCP Feedback** panel opens automatically.
3. Type your feedback or click a **Quick Reply**.
4. The AI receives your input and proceeds.

**Pending Comments**: You can submit a comment anytime via the panel. If the agent is busy, the comment is queued and injected at the next hook trigger point (tool call, shell execution, MCP call, or agent stop).

## Architecture

```
┌───────────────┐     WebSocket     ┌──────────────────┐     stdio     ┌─────────────┐
│  Webview Panel │◄────────────────►│  Extension (Hub)  │◄────────────►│  MCP Server  │
└───────────────┘                   └──────────────────┘               └─────────────┘
                                           │
                                    writes pending.json
                                           │
                                    ┌──────▼──────┐
                                    │ Cursor Hooks │ (check-pending.js)
                                    │  sessionStart│ → inject as context
                                    │  preToolUse  │ → deny + inject (R/W/Grep)
                                    │  beforeShell │ → block + inject (Shell)
                                    │  beforeMCP   │ → block + inject (MCP)
                                    │  subagentStart → block + inject
                                    │  stop        │ → deliver pending / remind
                                    └─────────────┘
```

## Troubleshooting

- **"Connecting..."**: Reload the window (`Cmd+R` / `Ctrl+R`).
- **MCP Server Error**: Check `~/.cursor/mcp.json` matches the config above.
- **Hooks Not Working**: Verify `~/.cursor/hooks.json` contains entries with `_source: "mcp-feedback-enhanced"`.
- **Multiple Windows**: The system auto-routes based on workspace path and `CURSOR_TRACE_ID`.

## For Developers

- **NPM Package**: [`mcp-feedback-enhanced`](https://www.npmjs.com/package/mcp-feedback-enhanced)
- **Repository**: [GitHub](https://github.com/yuanmingchencn/mcp-feedback-enhanced-vscode)

---
*Powered by [Model Context Protocol](https://modelcontextprotocol.io/)*
