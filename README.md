# MCP Feedback Enhanced

**Interactive feedback collection for AI assistants in Cursor, with multi-session tab isolation and real-time pending message injection.**

## Features

- **Multi-Session Tabs**: Each Cursor agent conversation gets its own isolated tab — messages, pending queue, and images are fully separated by `conversation_id` (Cursor UUID).
- **Rich Feedback UI**: Bottom panel with chat bubbles (AI left, user right), markdown support, image input (paste/drag-drop/file picker), and quick replies.
- **Cursor Hooks Integration**: Pending user messages are injected into the agent loop in real time via `sessionStart`, `preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `subagentStart`, and `stop` hooks.
- **Pending Queue**: Queue messages and images while the agent is busy — they are delivered at the next hook trigger point with a `📤 pending` badge on the chat bubble.
- **Auto-Configuration**: Automatically sets up `~/.cursor/mcp.json` and `~/.cursor/hooks.json` on activation.
- **Auto-Focus**: Bottom panel activates automatically on extension startup and when the agent requests feedback.
- **Image Support**: Paste (Cmd+V), drag-drop, or file picker for images. Images are displayed in chat, included in pending messages, and passed to the LLM via MCP image responses.
- **Persistent State**: Conversations survive restarts via file-based storage (`~/.config/mcp-feedback-enhanced/`). Input drafts are preserved per tab via `localStorage`.
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
      "command": "npx",
      "args": ["-y", "mcp-feedback-enhanced@latest"],
      "timeout": 86400,
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

### 3. Verify Cursor Hooks
The extension auto-deploys `~/.cursor/hooks.json` with entries for all 6 hook points. This enables real-time pending message injection.

### 4. Usage
1. The AI Agent calls `interactive_feedback` with a `summary` and `conversation_id`.
2. The **MCP Feedback** panel activates automatically at the bottom.
3. Type your feedback, attach images, or click a **Quick Reply**.
4. The AI receives your input and proceeds.

**Pending Messages**: Submit a message anytime via the panel. If the agent is busy, the message is queued and injected at the next hook trigger point (tool call, shell execution, MCP call, or agent stop). Delivered pending messages appear as user bubbles with a `📤 pending` badge.

## Architecture

```
┌───────────────┐     WebSocket     ┌──────────────────┐     stdio     ┌─────────────┐
│  Webview Panel │◄────────────────►│  Extension (Hub)  │◄────────────►│  MCP Server  │
│  (Bottom)      │                  │  wsServer.ts      │              │  mcp-server/ │
└───────────────┘                   └──────────────────┘               └─────────────┘
                                           │
                              writes pending/<conv_id>.json
                                           │
                                    ┌──────▼──────┐
                                    │ Cursor Hooks │ (check-pending.js)
                                    │  sessionStart│ → inject conversation_id + rules
                                    │  preToolUse  │ → deny + inject pending
                                    │  beforeShell │ → block + inject pending
                                    │  beforeMCP   │ → deny + inject pending
                                    │  subagentStart → block + inject pending
                                    │  stop        │ → deliver pending / remind
                                    └─────────────┘
```

### State Storage

```
~/.config/mcp-feedback-enhanced/
├── conversations/<conversation_id>.json   # Chat history, state, labels
├── pending/<conversation_id>.json         # Queued messages + images
├── servers/<pid>.json                     # Running extension instances
└── sessions/<conversation_id>.json        # Hook-registered sessions
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

- **NPM Package**: [`mcp-feedback-enhanced`](https://www.npmjs.com/package/mcp-feedback-enhanced)
- **Repository**: [GitHub](https://github.com/yuanmingchencn/mcp-feedback-enhanced-vscode)

---
*Powered by [Model Context Protocol](https://modelcontextprotocol.io/)*
