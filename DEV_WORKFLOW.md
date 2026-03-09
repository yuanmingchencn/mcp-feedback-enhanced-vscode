# MCP Feedback Enhanced - Development Workflow

## Architecture Overview

### System Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Cursor IDE Window                               │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    VSCode Extension Process                       │ │
│  │                                                                   │ │
│  │  extension.ts         → Activates extension, registers providers  │ │
│  │  wsServer.ts          → WebSocket Hub, conversation state         │ │
│  │  feedbackViewProvider → Loads panel.html, handles messages        │ │
│  │  fileStore.ts         → JSON file I/O for state persistence       │ │
│  │  types.ts             → Shared type definitions                   │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                              │                                         │
│                    WebSocket Connections                                │
│          ┌───────────────────┼───────────────────┐                     │
│          ▼                                       ▼                     │
│  ┌───────────────┐                        ┌───────────────┐            │
│  │ Webview Panel │                        │ MCP Server    │            │
│  │ (Bottom)      │                        │ (stdio proc)  │            │
│  │ panel.html    │                        │ mcp-server/   │            │
│  └───────────────┘                        └───────┬───────┘            │
│                                                   │ stdio              │
│                                            ┌──────▼───────┐            │
│                                            │ AI Agent     │            │
│                                            │ (Cursor)     │            │
│                                            └──────────────┘            │
└───────────────────────────────────────────────────────────────────────┘
```

### State Storage

```
~/.config/mcp-feedback-enhanced/
├── conversations/<conversation_id>.json   # Per-session chat history + state
├── pending/<conversation_id>.json         # Queued user messages + images
├── servers/<pid>.json                     # Running extension instances
├── sessions/<conversation_id>.json        # Hook-registered sessions
└── logs/hooks.log                         # Hook debug log
```

### Data Flow

```
AI calls interactive_feedback:
┌──────────┐    ┌───────────────┐    ┌──────────────┐    ┌────────────┐
│ AI Agent │───►│ MCP Server    │───►│ WS Server    │───►│ Webview    │
│          │    │ (stdio→ws)    │    │ (extension)  │    │ (panel)    │
└──────────┘    └───────────────┘    └──────────────┘    └────────────┘

User submits feedback:
┌────────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────┐
│ Webview    │───►│ WS Server    │───►│ MCP Server    │───►│ AI Agent │
│ (panel)    │    │ (extension)  │    │ (stdio)       │    │          │
└────────────┘    └──────────────┘    └───────────────┘    └──────────┘

Pending message injection (via Cursor Hooks):
┌────────────┐  queue-pending  ┌──────────────┐  writes  ┌──────────────────┐
│ Webview    │────────────────►│ WS Server    │────────►│ pending/<id>.json │
└────────────┘                 └──────────────┘          └────────┬─────────┘
                                                                  │ reads
                                                           ┌──────▼──────┐
                                                           │ Cursor Hook │
                                                           │ (deny/block)│
                                                           └──────┬──────┘
                                                                  │ inject
                                                           ┌──────▼──────┐
                                                           │ AI Agent    │
                                                           └─────────────┘
```

### Key Design: Conversation Isolation

Each Cursor agent session has a unique UUID (`conversation_id`). This UUID is:
1. Provided by Cursor in every hook input
2. Injected into the agent's context via `sessionStart` → `additional_context`
3. Passed by the agent when calling `interactive_feedback`
4. Used as the file name for conversations, pending, and sessions

No fallback resolution — if the ID doesn't match, a new conversation is created.

---

## Files Structure

```
mcp-feedback-enhanced/
├── src/
│   ├── extension.ts            # Extension activation, provider registration
│   ├── feedbackViewProvider.ts  # Webview panel management
│   ├── wsServer.ts              # WebSocket server (Hub) + conversation state
│   ├── fileStore.ts             # JSON file I/O helpers
│   └── types.ts                 # Shared TypeScript interfaces
│
├── static/
│   └── panel.html               # Self-contained webview (HTML + CSS + JS)
│
├── scripts/
│   └── hooks/
│       └── check-pending.js     # Cursor Hook for pending injection
│
├── mcp-server/
│   └── src/
│       └── index.ts             # MCP Server (stdio process)
│
├── out/                         # Compiled output
│   ├── extension.js             # Bundled extension (esbuild)
│   └── webview/
│       └── panel.html           # Copied from static/
│
├── DEV_WORKFLOW.md              # This file
├── CHANGELOG.md                 # Version history
└── README.md                    # Main readme
```

---

## Development Loop

### For Webview UI Changes (static/panel.html)

1. Edit `static/panel.html` directly
2. Run: `npm run compile`
3. In Cursor: `Cmd+Shift+P` → "Developer: Reload Window"

### For Extension Core Changes (src/*.ts)

1. Edit TypeScript files
2. Run: `npm run compile`
3. In Cursor: `Cmd+Shift+P` → "Developer: Reload Window"

### For Hook Changes (scripts/hooks/check-pending.js)

1. Edit `scripts/hooks/check-pending.js`
2. Run: `npm run compile` (copies to out/)
3. Changes take effect on next hook trigger (no restart needed)

### For MCP Server Changes (mcp-server/src/*.ts)

1. Edit TypeScript files
2. Run: `cd mcp-server && npm run build`
3. MCP server auto-reconnects on next `interactive_feedback` call

---

## Compile Pipeline

```bash
npm run compile
```

Executes:
```
tsc -p ./                            # 1. Compile TypeScript
    ↓
cp static/panel.html out/webview/    # 2. Copy webview HTML
    ↓
npm run esbuild                      # 3. Bundle extension.ts → out/extension.js
    ↓
npm run verify                       # 4. Verify critical code
```

**Verify Script Checks:**
- `panel.html` contains `{{SERVER_URL}}` placeholder
- `extension.js` contains `retainContextWhenHidden: true`
- `extension.js` references `panel.html`

---

## Key Settings

### retainContextWhenHidden: true

```typescript
webviewOptions: {
    retainContextWhenHidden: true  // Preserve webview state when panel is hidden
}
```

This ensures input drafts, tab state, and WebSocket connection survive panel hide/show cycles.

---

## Testing Checklist

After any change, verify:
- [ ] WebSocket connects (green dot)
- [ ] Chat bubbles render (AI left, user right)
- [ ] Markdown renders (bold, italic, headers, lists)
- [ ] Quick reply buttons work
- [ ] Cmd+Enter sends feedback
- [ ] Images: paste (Cmd+V), drag-drop, file picker
- [ ] Image preview/lightbox on click
- [ ] Pending queue: add, edit, delete, clear all
- [ ] Pending delivery: shows as user bubble with 📤 badge
- [ ] Tab isolation: multiple agent sessions create separate tabs
- [ ] Input draft persists across tab switches
- [ ] Settings panel: distinct floating card style
- [ ] Panel auto-focuses on startup and feedback request
