# MCP Feedback Enhanced - Development Workflow

## Current Setup (Symlink Mode)

The extension is loaded via symlink from your dev folder:
```
~/.cursor/extensions/yuanmingchencn.mcp-feedback-enhanced-vscode-dev 
  -> /path/to/your/mcp-feedback-enhanced
```

---

## Architecture Overview

### System Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Cursor IDE Window                               │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    VSCode Extension Process                       │ │
│  │                                                                   │ │
│  │  ┌─────────────────────────────────────────────────────────────┐ │ │
│  │  │ extension.ts                                                │ │ │
│  │  │  - Activates extension                                      │ │ │
│  │  │  - Starts WebSocket Server                                  │ │ │
│  │  │  - Registers webview providers (sidebar, bottom, editor)    │ │ │
│  │  │  - Registers commands                                       │ │ │
│  │  └─────────────────────────────────────────────────────────────┘ │ │
│  │                              │                                    │ │
│  │                              ▼                                    │ │
│  │  ┌─────────────────────────────────────────────────────────────┐ │ │
│  │  │ wsServer.ts (WebSocket Hub)                                 │ │ │
│  │  │  - Port: 8765-8864 (auto-allocated)                         │ │ │
│  │  │  - Manages clients (webview, mcp-server)                    │ │ │
│  │  │  - Routes feedback requests/responses                       │ │ │
│  │  │  - Maintains session state (_pendingFeedback)               │ │ │
│  │  │  - Persists history (_globalHistoryCache)                   │ │ │
│  │  └───────────────────────────┬─────────────────────────────────┘ │ │
│  │                              │                                    │ │
│  │  ┌───────────────────────────┼───────────────────────────────┐   │ │
│  │  │ feedbackViewProvider.ts   │                               │   │ │
│  │  │  - Loads HTML from file   │                               │   │ │
│  │  │  - Replaces placeholders  │                               │   │ │
│  │  │  - Watches for file change│                               │   │ │
│  │  │  - Handles webview msgs   │                               │   │ │
│  │  └───────────────────────────┼───────────────────────────────┘   │ │
│  └──────────────────────────────┼───────────────────────────────────┘ │
│                                 │                                      │
│                    ┌────────────┴────────────┐                         │
│                    │  WebSocket Connections  │                         │
│                    └────────────┬────────────┘                         │
│          ┌──────────────────────┼──────────────────────┐               │
│          ▼                      ▼                      ▼               │
│  ┌───────────────┐      ┌───────────────┐      ┌───────────────┐      │
│  │ Webview Panel │      │ Webview Panel │      │ MCP Server    │      │
│  │ (Sidebar)     │      │ (Editor Tab)  │      │ (stdio proc)  │      │
│  │               │      │               │      │               │      │
│  │ panel.html    │      │ panel.html    │      │ mcp-server/   │      │
│  │ (generated)   │      │ (generated)   │      │ index.ts      │      │
│  └───────────────┘      └───────────────┘      └───────────────┘      │
│                                                        │               │
│                                                        │ stdio         │
│                                                        ▼               │
│                                                 ┌───────────────┐      │
│                                                 │ AI Agent      │      │
│                                                 │ (Cursor)      │      │
│                                                 └───────────────┘      │
└───────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
AI calls interactive_feedback:
┌──────────┐    ┌───────────────┐    ┌──────────────┐    ┌────────────┐
│ AI Agent │───►│ MCP Server    │───►│ WS Server    │───►│ Webview    │
│          │    │ (stdio)       │    │ (extension)  │    │ (panel)    │
└──────────┘    └───────────────┘    └──────────────┘    └────────────┘

User submits feedback:
┌────────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────┐
│ Webview    │───►│ WS Server    │───►│ MCP Server    │───►│ AI Agent │
│ (panel)    │    │ (extension)  │    │ (stdio)       │    │          │
└────────────┘    └──────────────┘    └───────────────┘    └──────────┘

Pending comment injection (via Cursor Hooks):
┌────────────┐  pending-update  ┌──────────────┐  writes  ┌──────────────┐
│ Webview    │─────────────────►│ WS Server    │────────►│ pending.json │
│ (panel)    │                  │ (extension)  │          │ (~/.config/) │
└────────────┘                  └──────────────┘          └──────┬───────┘
                                                                 │ reads
                                                          ┌──────▼───────┐
                                                          │ Cursor Hooks │
                                                          │ check-       │
                                                          │ pending.js   │
                                                          └──────┬───────┘
                                                                 │ deny/followup
                                                          ┌──────▼───────┐
                                                          │ AI Agent     │
                                                          │ (blocked)    │
                                                          └──────────────┘
```

### Key Design: State Separation

```
┌─────────────────────────────────────────────────────────────────┐
│ Extension Process (Permanent State)                              │
│                                                                  │
│  wsServer.ts:                                                    │
│   - _clients: Map<WebSocket, Client>                            │
│   - _pendingFeedback: Map<sessionId, PendingFeedback>           │
│   - _db: SQLite database connection                             │
│                                                                  │
│  Persistence:                                                    │
│   - ~/.config/mcp-feedback-enhanced/servers/{pid}.json          │
│   - ~/.config/mcp-feedback-enhanced/history/history.db (SQLite) │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                    WebSocket (can reconnect)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Webview (Disposable UI)                                          │
│                                                                  │
│  localStorage (local cache):                                     │
│   - messages: message history                                    │
│   - pendingSessionId: current session                            │
│   - scratchText: scratch pad content                             │
│   - inputCache: input field content                              │
│                                                                  │
│  On Load:                                                        │
│   1. Restore from localStorage                                   │
│   2. Connect to WS Server                                        │
│   3. Send 'register' message                                     │
│   4. Receive 'history' message to sync                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Why File-Based HTML Generation?

### The Problem with Inline HTML

Original approach (webviewContent.ts inline HTML):
```
Modify UI code → Compile TypeScript → Reload Extension Host → Webview recreates
                                            ↓
                              ⚠️ WebSocket Server restarts
                              ⚠️ All pending sessions LOST
                              ⚠️ MCP Server must reconnect
```

### The Solution: File + Hot-Reload

New approach (generate-webview.js → panel.html):
```
Modify generate-webview.js → npm run compile → panel.html updates
                                                      ↓
                                       File watcher detects change
                                                      ↓
                                       _recreateWebview() called
                                                      ↓
                              ✅ Extension Host stays running
                              ✅ WS Server keeps sessions
                              ✅ MCP Server stays connected
                              ✅ UI refreshes with new content
```

### Key Setting: retainContextWhenHidden: false

```typescript
// Forces fresh HTML reload when panel becomes visible
webviewOptions: {
    retainContextWhenHidden: false  // NOT true!
}
```

This ensures `_loadWebviewHtml()` reads the latest file content with placeholder replacement:
- `{{SERVER_URL}}` → `ws://127.0.0.1:8765/ws`
- `{{PROJECT_PATH}}` → `/Users/.../project`
- `{{SESSION_ID}}` → `vscode-session-xxx`

---

## Development Loop

### For Webview UI Changes (scripts/generate-webview.js)

**Option A: Manual Reload**
1. Edit `scripts/generate-webview.js`
2. Run: `npm run compile`
3. In Cursor: Click reload button (🔄) in MCP Feedback panel

**Option B: Hot-Reload (Recommended)**
1. Terminal 1: `npm run dev` (starts hot-reload server on port 18799)
2. Edit `scripts/generate-webview.js`
3. Save → Auto-compiles → Webview auto-reloads

No Cursor restart needed!

### For Extension Core Changes (src/*.ts)

1. Edit TypeScript files
2. Run: `npm run compile`  
3. In Cursor: `Cmd+Shift+P` → "Developer: Reload Window"

### For MCP Server Changes (mcp-server/src/*.ts)

1. Edit TypeScript files
2. Run: `cd mcp-server && npm run build`
3. MCP server auto-reconnects (no Cursor restart needed)

---

## Compile Pipeline

```bash
npm run compile
```

Executes:
```
tsc -p ./                            # 1. Compile TypeScript
    ↓
node scripts/generate-webview.js     # 2. Generate out/webview/panel.html
    ↓
npm run esbuild                      # 3. Bundle extension.ts → out/extension.js
    ↓
npm run verify                       # 4. Verify critical code exists
```

**Verify Script Checks:**
- `panel.html` contains `{{SERVER_URL}}` placeholder
- `extension.js` contains `retainContextWhenHidden: false`
- `extension.js` contains `_loadWebviewHtml` function

---

## Hot-Reload Mechanism (Two Layers)

### Layer 1: File Watcher (feedbackViewProvider.ts)

```typescript
private _watchWebviewFile(): void {
    this._fileWatcher = fs.watch(htmlPath, (eventType) => {
        if (eventType === 'change') {
            this._recreateWebview();  // Reload HTML
        }
    });
}
```

### Layer 2: Hot-Reload WebSocket Server (watch-reload.js)

```
┌──────────────────┐     ws://127.0.0.1:18799     ┌─────────────┐
│ watch-reload.js  │ ◄──────────────────────────► │ Webview     │
│ (Port 18799)     │                              │ panel.html  │
└────────┬─────────┘                              └──────┬──────┘
         │                                               │
         │ Detects panel.html change                     │
         │                                               │
         └─── broadcast {type:'reload'} ──────────────► │
                                                        │
                             vscode.postMessage({type:'reload-webview'})
                                                        │
                                     Extension reloads webview
```

---

## Files Structure

```
mcp-feedback-enhanced/
├── src/
│   ├── extension.ts            # Extension activation
│   ├── feedbackViewProvider.ts # Webview panel management  
│   └── wsServer.ts             # WebSocket server (HUB) + SQLite storage
│
├── scripts/
│   ├── generate-webview.js     # Webview HTML generator ← EDIT THIS
│   ├── watch-reload.js         # Hot reload server
│   ├── verify.js               # Verify compiled output
│   ├── migrate-history.js      # JSON to SQLite migration
│   ├── rollback.js             # Rollback utility
│   └── hooks/
│       └── check-pending.js    # Cursor Hook for pending injection
│
├── mcp-server/
│   └── src/
│       └── index.ts            # MCP Server (stdio process)
│
├── out/                        # Compiled output
│   ├── extension.js            # Bundled extension (esbuild)
│   └── webview/
│       └── panel.html          # Generated webview HTML
│
├── docs/
│   └── archive/                # Archived/outdated docs
│
├── DEV_WORKFLOW.md             # This file
└── README.md                   # Main readme
```

---

## Multi-Window Matching

MCP Server finds the correct Extension using priority-based matching:

| Priority | Strategy | Description |
|----------|----------|-------------|
| 1 | CURSOR_TRACE_ID | Same Cursor window (environment variable) |
| 2 | Exact workspace | project_directory in server's workspaces array |
| 3 | Prefix match | Project is inside a workspace directory |
| 4 | parentPid | Same parent process (legacy) |
| 5 | Single server | Only one server running |
| 6 | Most recent | Last registered server by timestamp |

---

## Testing Checklist

After any change, verify:
- [ ] Markdown renders (bold, italic, headers, lists)
- [ ] History shows AI messages
- [ ] WebSocket connects (green dot)
- [ ] Reload button (🔄) works
- [ ] Quick reply buttons work
- [ ] Cmd+Enter sends feedback
- [ ] Panel auto-focuses on new AI message

---

## Troubleshooting

### Markdown not rendering
- Check: `out/webview/panel.html` has `renderMarkdown` function
- Test: Run `npm run compile`, then reload panel

### History not showing
- Check: WebSocket connected (green dot)
- Check: `~/.config/mcp-feedback-enhanced/history/global.json` exists

### Reload button not working
- Check: `feedbackViewProvider.ts` handles `reload-webview` message
- Run: `npm run compile` then Reload Window

### Hot-reload not working
- Ensure `npm run dev` is running
- Check port 18799 is not blocked
- Look for errors in `generate-webview.js`

### Sessions lost after UI change
- Verify using file-based approach (not inline HTML)
- Check `retainContextWhenHidden: false` in compiled code
- Confirm `_loadWebviewHtml` function exists
