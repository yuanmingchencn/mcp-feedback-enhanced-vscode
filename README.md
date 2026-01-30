# MCP Feedback Enhanced - VSCode/Cursor Extension

**Version: 1.0.0**

A native VSCode/Cursor sidebar extension for collecting interactive feedback from AI assistants through the Model Context Protocol (MCP).

## ✨ Features

### Core Features
- **Sidebar Panel** - Dedicated feedback panel in activity bar
- **Bottom Panel** - Alternative panel location in bottom area
- **Editor Tab** - Draggable tab option for flexible positioning
- **Real-time Communication** - WebSocket connection for instant AI ↔ User communication
- **Theme Matching** - Automatically inherits your editor's dark/light theme
- **Markdown Rendering** - AI summaries rendered with full Markdown support

### Feedback Features (Card-Based UI)
- **Card Grouping** - Each AI request + user reply grouped in a card
- **Inline Reply** - Reply directly within each card
- **Multiple Pending** - Handle multiple AI requests at once
- **Quick Replies** - One-click responses: Continue, Good, Fix
- **Reply Tracking** - User replies shown directly under corresponding AI message
- **Image Attachment** - Attach screenshots via paste (Ctrl+V) or drag & drop
- **Session History** - View and search previous feedback sessions

### Multi-Window Support
- **CURSOR_TRACE_ID Matching** - Precise window isolation using Cursor's trace ID
- **Workspace-based Matching** - Fallback to project path matching
- **Project-level History** - Chat history stored per project
- **Auto-cleanup** - Stale server files automatically removed
- **Force Reset** - Manual reset command for recovery

### Browser Fallback
- **Auto-detect** - Automatically detects if extension is not available
- **System Browser** - Opens feedback page in default browser
- **Same UI** - Similar card-based feedback interface
- **Quick Replies** - Continue, Good, Fix, Stop buttons

## 📦 Installation

### From Open VSX (Recommended)

Search for "MCP Feedback Enhanced" in the Extensions marketplace, or install via command line:

```bash
cursor --install-extension yuanmingchencn.mcp-feedback-enhanced-vscode
```

### From VSIX File

1. Download the latest `.vsix` file from [Releases](https://github.com/yuanmingchencn/mcp-feedback-enhanced-vscode/releases)
2. In Cursor: `Ctrl+Shift+P` → "Extensions: Install from VSIX..."
3. Select the `.vsix` file
4. Reload Window

### From Source

```bash
# Clone and build
git clone https://github.com/yuanmingchencn/mcp-feedback-enhanced-vscode
cd mcp-feedback-enhanced-vscode

# Install dependencies
npm install
cd mcp-server && npm install && cd ..

# Build (uses esbuild for bundling)
npm run esbuild
cd mcp-server && npm run build && cd ..

# Package
npx vsce package --no-dependencies

# Install
cursor --install-extension mcp-feedback-enhanced-vscode-*.vsix
```

## 🚀 Usage

### 1. Configure MCP Server

Add to your `~/.cursor/mcp.json`:

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

> **Note**: The MCP server is published to npm for easy installation via `npx`.

### 2. Open the Feedback Panel

- Click the 💬 icon in the activity bar (left sidebar)
- Or use keyboard shortcut: `Ctrl+Shift+M` / `Cmd+Shift+M`
- Or command palette: "MCP Feedback: Open in Sidebar"

### 3. Workflow

1. AI calls `interactive_feedback` tool
2. Panel shows AI summary and auto-focuses
3. Type your feedback or click quick reply button
4. Press Submit or `Ctrl+Enter`
5. AI receives your feedback and continues

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Cursor Window                           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              VSCode Extension (WS Server)              │ │
│  │                                                         │ │
│  │  extension.ts → wsServer.ts → feedbackViewProvider.ts  │ │
│  │       │              │                │                 │ │
│  │   Activates      WS Hub (8765+)    Loads HTML          │ │
│  │                       │           from file             │ │
│  │                       │                │                 │ │
│  │              ┌────────┴────────┐       │                 │ │
│  │              ▼                 ▼       ▼                 │ │
│  │        ┌──────────┐      ┌──────────────────┐           │ │
│  │        │ MCP Srv  │      │ Webview Panel    │           │ │
│  │        │ (stdio)  │      │ (panel.html)     │           │ │
│  │        └──────────┘      └──────────────────┘           │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

Key Design: State Separation
┌─────────────────────────────────────────────────────────────┐
│ Extension Process (Permanent)         │ Webview (Disposable)│
│  - Session state in wsServer.ts       │  - Pure UI client   │
│  - History in SQLite (history.db)     │  - localStorage     │
│  - Survives UI reloads                │  - Can hot-reload   │
└─────────────────────────────────────────────────────────────┘

Server Matching Strategy (MCP Server → Extension):
1. CURSOR_TRACE_ID (same Cursor window) ← Highest priority
2. Exact workspace match (project_directory in workspaces array)
3. Prefix match (project inside workspace)
4. parentPid match (backward compatibility)
5. Single server fallback
6. Most recent server

Config Files (~/.config/mcp-feedback-enhanced/):
├── servers/           # Window-level (per Extension instance)
│   └── <pid>.json    # { port, pid, workspaces, cursorTraceId, timestamp }
└── history/          # Global history (SQLite database)
    └── history.db    # SQLite: role, content, timestamp, workspace, project_directory
```

## ⌨️ Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `MCP Feedback: Open in Sidebar` | `Ctrl+Shift+M` | Open sidebar panel |
| `MCP Feedback: Open in Editor` | - | Open as editor tab |
| `MCP Feedback: Open in Bottom` | - | Open in bottom panel |
| `MCP Feedback: Reconnect` | - | Reconnect WebSocket |
| `MCP Feedback: Focus Input` | `Ctrl+Shift+F` | Focus input field |
| `MCP Feedback: Force Reset` | - | Restart WebSocket server |
| `MCP Feedback: Show Status` | - | Show server diagnostics |

## 📁 Project Structure

```
mcp-feedback-enhanced-vscode/
├── src/
│   ├── extension.ts            # Extension entry point
│   ├── feedbackViewProvider.ts # Webview provider (loads HTML from file)
│   └── wsServer.ts             # WebSocket server (session hub, SQLite storage)
├── scripts/
│   ├── generate-webview.js     # ← EDIT THIS for UI changes
│   ├── watch-reload.js         # Hot-reload server (port 18799)
│   ├── migrate-history.js      # JSON to SQLite migration
│   └── verify.js               # Compile verification
├── mcp-server/
│   ├── src/
│   │   └── index.ts            # MCP server (stdio, WS client)
│   └── package.json
├── out/                        # Compiled output (gitignored)
│   ├── extension.js            # Bundled extension (esbuild)
│   └── webview/
│       └── panel.html          # Generated webview HTML
├── resources/
│   └── icon.svg                # Extension icon
├── package.json                # Extension manifest
├── DEV_WORKFLOW.md             # Development guide & architecture
├── LICENSE                     # MIT License
└── README.md
```

## 🐛 Troubleshooting

### Panel shows "Disconnected"

This shouldn't happen with the new architecture. The extension hosts its own WebSocket server.

1. Try: `Ctrl+Shift+P` → "Developer: Reload Window"
2. Check Extension Host logs for errors

### MCP Server can't connect

Error: `No MCP Feedback Extension found for project: /path/to/project`

1. Ensure the extension is installed and enabled
2. Open the feedback panel (click the icon in activity bar)
3. Check `~/.config/mcp-feedback-enhanced/servers/` for server files
4. Ensure server file contains your project in `workspaces` array
5. Reload Window and try again

### History not showing

1. History is project-specific - different projects have different history
2. Check `~/.config/mcp-feedback-enhanced/history/` for history files
3. Reload Window to refresh

### Multiple Windows

Each Cursor window runs its own WebSocket server. The MCP server finds the correct Extension by matching `project_directory` against the `workspaces` array in server files.

## 🔧 Development

### Build & Install

```bash
# Quick build and install
npm run esbuild && \
cd mcp-server && npm run build && cd .. && \
npx vsce package --no-dependencies && \
cursor --install-extension mcp-feedback-enhanced-vscode-*.vsix --force
```

### Debug

1. Open this project in Cursor
2. Press `F5` to launch Extension Development Host
3. Set `MCP_FEEDBACK_DEBUG=true` for MCP server debug logs

## 📄 MCP Configuration Example

### Recommended: Use npx (auto-updates)

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

### Alternative: Local installation

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

## 📜 License

MIT License

## 🙏 Acknowledgments

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [VSCode Extension API](https://code.visualstudio.com/api)
