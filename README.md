# MCP Feedback Enhanced

**Interactive feedback collection for AI assistants in Cursor, with real-time pending message injection and feedback enforcement.**

## Features

- **Rich Feedback UI**: Bottom panel with chat bubbles (AI left, user right), markdown support, image input (paste/drag-drop/file picker), and quick replies.
- **Cursor Hooks Integration**: Pending user messages are injected into the agent loop in real time via `preToolUse` hooks, using HTTP-based delivery from the extension's in-memory store.
- **Feedback Enforcement**: Periodically re-injects rules into the agent's context to prevent them from being overlooked during long sessions.
- **Pending Queue**: Queue messages and images while the agent is busy — they are delivered at the next tool call via the `preToolUse` hook. Delivered pending messages appear as user bubbles with a `📤 pending` badge.
- **Auto-Configuration**: Automatically sets up `~/.cursor/mcp.json`, `~/.cursor/hooks.json`, and `~/.cursor/rules/mcp-feedback-enhanced.mdc` on activation.
- **Auto-Focus**: Bottom panel activates automatically on extension startup and when the agent requests feedback.
- **Image Support**: Paste (Cmd+V), drag-drop, or file picker for images. Images are displayed in chat, included in pending messages, and passed to the LLM via MCP image responses.
- **Secure & Local**: All data stays on your machine.

## Getting Started

### 1. Install the Extension
Install **MCP Feedback Enhanced** from [Open VSX](https://open-vsx.org/extension/atome/mcp-feedback-enhanced) or build from source.

### 2. Verify Configuration
The extension auto-configures on activation:
- `~/.cursor/mcp.json` — MCP server registration
- `~/.cursor/hooks.json` — `preToolUse` hook (pending message delivery + rules refresh)
- `~/.cursor/rules/mcp-feedback-enhanced.mdc` — always-applied rule for `interactive_feedback` usage

### 3. Usage
1. The AI Agent calls `interactive_feedback` with a `summary`.
2. The **MCP Feedback** panel activates automatically at the bottom.
3. Type your feedback, attach images, or click a **Quick Reply**.
4. The AI receives your input and proceeds.

**Pending Messages**: Submit a message anytime via the panel. If the agent is busy, the message is queued and injected at the next tool call via the `preToolUse` hook.

## Feedback Enforcement

Agents sometimes forget to call `interactive_feedback` before ending their turn. This wastes user requests (the user must type a new message instead of responding for free via the MCP panel).

Enforcement triggers:
- **Count-based**: After `maxToolCalls` (default: 15) tool calls without `interactive_feedback`
- **Time-based**: After `maxMinutes` (default: 5) minutes without `interactive_feedback`

When triggered, the hook denies one tool call and silently re-injects rules into the agent's context. Counter resets after — the retry passes through immediately.

Override defaults via `~/.config/mcp-feedback-enhanced/enforcement-config.json` (`maxToolCalls`, `maxMinutes`).

## Architecture

```
┌───────────────┐     WebSocket     ┌──────────────────┐     stdio     ┌─────────────┐
│  Webview Panel │◄────────────────►│  Extension (Hub)  │◄────────────►│  MCP Server  │
│  (Bottom)      │                  │  wsHub.ts         │              │  mcp-server/ │
└───────────────┘                   └──────────────────┘               └─────────────┘
                                      │ HTTP endpoints │
                                      │ /pending       │
                                      │ /health        │
                                      └───────┬────────┘
                                              │ HTTP GET
                                       ┌──────▼──────┐
                                       │ Cursor Hooks │
                                       │  consume-pending.js │ → pending + rules refresh
                                       │  hook-utils.js      │ → shared utilities
                                       └─────────────┘
```

### State Storage

```
~/.config/mcp-feedback-enhanced/
├── servers/<hash>.json              # Running extension instances
├── feedback-state.json              # Tool call counter for enforcement
├── enforcement-config.json          # Optional enforcement config overrides
└── logs/hooks.log                   # Hook debug log
```

## Troubleshooting

- **"Connecting..."**: Reload the window (`Cmd+R` / `Ctrl+R`).
- **MCP Server Error**: Check `~/.cursor/mcp.json` is configured correctly.
- **Hooks Not Working**: Verify `~/.cursor/hooks.json` contains entries with `_source: "mcp-feedback-enhanced"`.
- **Panel Not Focusing**: Use Command Palette → "MCP Feedback".

## For Developers

- **Install**: [Open VSX](https://open-vsx.org/extension/atome/mcp-feedback-enhanced) or install via VSIX
- **Repository**: [GitHub](https://github.com/yuanmingchencn/mcp-feedback-enhanced-vscode)

---
*Powered by [Model Context Protocol](https://modelcontextprotocol.io/)*
