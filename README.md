# MCP Feedback Enhanced

**Interactive feedback collection for AI assistants in Cursor, with multi-session tab isolation and real-time pending message injection.**

## Features

- **Multi-Session Tabs**: Each Cursor agent conversation gets its own isolated tab — messages, pending queue, and images are fully separated by `conversation_id` (Cursor UUID).
- **Rich Feedback UI**: Bottom panel with chat bubbles (AI left, user right), markdown support, image input (paste/drag-drop/file picker), and quick replies.
- **Cursor Hooks Integration**: Pending user messages are injected into the agent loop in real time via `sessionStart` and `preToolUse` hooks, using HTTP-based delivery from the extension's in-memory store.
- **Pending Queue**: Queue messages and images while the agent is busy — they are delivered at the next tool call via the `preToolUse` hook. Delivered pending messages appear as user bubbles with a `📤 pending` badge.
- **Auto-Configuration**: Automatically sets up `~/.cursor/mcp.json` and `~/.cursor/hooks.json` on activation.
- **Auto-Focus**: Bottom panel activates automatically on extension startup and when the agent requests feedback.
- **Image Support**: Paste (Cmd+V), drag-drop, or file picker for images. Images are displayed in chat, included in pending messages, and passed to the LLM via MCP image responses.
- **Persistent State**: Conversations survive restarts via file-based storage (`~/.config/mcp-feedback-enhanced/`). Pending messages are held in-memory and restored from conversation state. Input drafts are preserved per tab via `localStorage`.
- **Secure & Local**: All data stays on your machine.

## Getting Started

### 1. Install the Extension
Install **MCP Feedback Enhanced** from the VS Code Marketplace or build from source.

### 2. Verify MCP Configuration
The extension auto-configures `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "node",
      "args": ["~/.vscode/extensions/mcp-feedback.mcp-feedback-enhanced-2.0.8/mcp-server/dist/index.js"],
      "timeout": 86400,
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

The MCP server is bundled with the extension; the path above uses the VS Code extension directory (use your installed version in place of `2.0.8` if different).

### 3. Verify Cursor Hooks
The extension auto-deploys `~/.cursor/hooks.json` with `sessionStart` and `preToolUse` hooks. This enables real-time pending message injection via HTTP.

### 4. Usage
1. The AI Agent calls `interactive_feedback` with a `summary` and `conversation_id`.
2. The **MCP Feedback** panel activates automatically at the bottom.
3. Type your feedback, attach images, or click a **Quick Reply**.
4. The AI receives your input and proceeds.

**Pending Messages**: Submit a message anytime via the panel. If the agent is busy, the message is queued in-memory and injected at the next tool call via the `preToolUse` hook. Delivered pending messages appear as user bubbles with a `📤 pending` badge.

## Architecture

```
┌───────────────┐     WebSocket     ┌──────────────────┐     stdio     ┌─────────────┐
│  Webview Panel │◄────────────────►│  Extension (Hub)  │◄────────────►│  MCP Server  │
│  (Bottom)      │                  │  wsHub.ts         │              │  mcp-server/ │
└───────────────┘                   └──────────────────┘               └─────────────┘
                                      │ HTTP endpoints │
                                      │ /pending/:id   │
                                      │ /health        │
                                      └───────┬────────┘
                                              │ HTTP GET
                                       ┌──────▼──────┐
                                       │ Cursor Hooks │
                                       │  session-start.js │ → inject conv_id + rules
                                       │  consume-pending.js│ → deny + inject pending
                                       │  hook-utils.js     │ → shared utilities
                                       └─────────────┘
```

### State Storage

```
~/.config/mcp-feedback-enhanced/
├── conversations/<conversation_id>.json   # Chat history, state, labels
├── servers/<pid>.json                     # Running extension instances
├── sessions/<conversation_id>.json        # Hook-registered sessions
└── logs/hooks.log                         # Hook debug log

In-memory (extension process):
└── pendingManager: Map<conversation_id, PendingEntry>  # Queued messages + images
```

### Conversation Isolation

Each Cursor agent session has a unique UUID. The `sessionStart` hook injects this UUID into the agent's context via `additional_context`, instructing the LLM to pass it when calling `interactive_feedback`. This ensures:

- Each agent conversation maps to a separate tab in the panel
- Pending messages are matched by exact `conversation_id` (no fallback guessing)
- Multiple concurrent agent sessions work independently

## Troubleshooting

- **"Connecting..."**: Reload the window (`Cmd+R` / `Ctrl+R`).
- **MCP Server Error**: Check `~/.cursor/mcp.json` matches the config above.
- **Hooks Not Working**: Verify `~/.cursor/hooks.json` contains entries with `_source: "mcp-feedback-enhanced"`.
- **Panel Not Focusing**: The extension retries focus at 1.5s, 3s, 5s after startup. If panel is hidden, use Command Palette → "MCP Feedback".
- **Multiple Tabs for Same Session**: Ensure the LLM passes the correct `conversation_id` (injected by `sessionStart`).

## For Developers

- **Install**: [Open VSX](https://open-vsx.org/extension/atome/mcp-feedback-enhanced) or install via VSIX
- **Repository**: [GitHub](https://github.com/yuanmingchencn/mcp-feedback-enhanced-vscode)

---
*Powered by [Model Context Protocol](https://modelcontextprotocol.io/)*
