# Cross-Window Data Leak Audit

**Date:** 2025-03-10  
**Bug:** In multi-window Cursor setup, messages from one window appear in another window.

---

## Executive Summary

| Path | Scoped? | Risk |
|------|---------|------|
| 1. Conversation Store | Shared storage, filtered on read | Medium |
| 2. Session Scanning (restore) | **NO** – workspace match too broad | **HIGH – ROOT CAUSE** |
| 3. `session_updated` broadcast | Yes | Low |
| 4. Webview registration | Yes | Low |
| 5. Pending queue | Yes (after fix) | Low |
| 6. State restore on activation | **NO** – same as #2 | **HIGH** |

---

## `server_pid` and `process.pid` Clarification

| Term | Meaning | Set By |
|------|---------|--------|
| `server_pid` (in files) | Extension host process PID | Extension (`process.pid`) or Hook (`findServerPid()`) |
| `process.pid` (in wsServer) | This extension instance's PID | Node.js runtime |
| `this.serverPid` | **Does not exist** in codebase | N/A |

**Answer:** `server_pid` in pending/session/conversation files = **extension's PID** (the extension host process for that Cursor window). Comparing `data.server_pid === process.pid` is correct: we only process data we wrote.

---

## 1. Conversation Store

| Item | Details |
|------|---------|
| **File path** | `~/.config/mcp-feedback-enhanced/conversations/<conversation_id>.json` |
| **Storage** | Shared – all windows use same directory |
| **Scoping field** | `server_pid` (extension PID) |
| **File** | `fileStore.ts` – `readConversation`, `writeConversation`, `listConversations` |

**Scoping on read:**
- `_sendConversationsList` (wsServer.ts:773–787): filters `c.server_pid === process.pid` ✓
- `_sendConversationData` (wsServer.ts:789–794): **no filter** – but conversation_id comes from filtered list, so OK in practice
- `_ensureConversation`, `_addMessage`: no filter – they operate on conversation_id provided by MCP (which is scoped to this window)

**Verdict:** Properly scoped on list; individual load is safe because IDs come from filtered list.

---

## 2. Session Scanning (`_scanExistingSessions`)

| Item | Details |
|------|---------|
| **File** | `wsServer.ts` |
| **Function** | `_scanExistingSessions` |
| **Lines** | 436–478 |

**Logic:**
1. **Sessions:** `listSessions().filter(s => s.server_pid === process.pid)` ✓
2. **Restored conversations:**
   ```ts
   listConversations().filter(c => {
     if (c.server_pid === process.pid) return false;  // already handled
     if (c.state === 'archived') return false;
     const convRoots = (c.workspace_roots || []).map(r => r.replace(/\/+$/, ''));
     return convRoots.some(r => myRoots.has(r));  // WORKSPACE MATCH
   });
   ```

**BUG:** Workspace match is too broad. If Window A and Window B both have `/Users/me/project` open:
- Window A creates conv123 (server_pid=pidA)
- Window B starts, runs `_scanExistingSessions`
- conv123 has workspace_roots including `/Users/me/project`
- Window B's `myRoots` includes `/Users/me/project`
- **conv123 is restored into Window B** and broadcast to Window B's webview
- Window B's webview shows conv123 (messages from Window A)

**Fix:** Add `cursorTraceId` to `ConversationData` and filter restore by `c.cursorTraceId === this.cursorTraceId`. Fallback: if `cursorTraceId` empty, do not restore from other PIDs (only restore our own by pid, which won't work after restart – acceptable).

---

## 3. `session_updated` Broadcasting

| Item | Details |
|------|---------|
| **File** | `wsServer.ts` |
| **Function** | `_handleFeedbackRequest` → `_broadcastToWebviews` |
| **Lines** | 318–327 |

**Flow:**
1. MCP sends `feedback_request` over WebSocket
2. MCP connects via `findExtensionServer()` → `CURSOR_TRACE_ID` match (mcp-server/src/index.ts:76–82)
3. So only the correct extension receives the request
4. `_broadcastToWebviews` sends to clients connected to **this** server only

**Verdict:** Properly scoped. Each extension only receives requests from MCPs that connected to it.

---

## 4. Webview Registration (`register` handler)

| Item | Details |
|------|---------|
| **File** | `wsServer.ts` |
| **Lines** | 248–252 |

**When webview registers:** Only sets `clientType` and `projectPath`. No data sent on registration.

**Data flow:** Webview requests data via `get_sessions`, `get_conversations`, `load_conversation` – all filtered by `server_pid === process.pid` (except load which gets ID from filtered list).

**Verdict:** Properly scoped.

---

## 5. Pending Queue (`queue-pending` handler)

| Item | Details |
|------|---------|
| **File** | `wsServer.ts` |
| **Function** | `_handleQueuePending`, `_watchPendingFile` |
| **Lines** | 413–434, 382–438 |

**Write:** `writePending({ conversation_id, server_pid: process.pid, ... })` ✓

**Watcher:** When file disappears, checks `lastKnownServerPid !== process.pid` → skip (lines 523–525) ✓

**Verdict:** Properly scoped after fix.

---

## 6. State Restore on Extension Activation

| Item | Details |
|------|---------|
| **File** | `wsServer.ts` |
| **Flow** | `start()` → `_scanExistingSessions()` |

Same as Path #2. The restore logic in `_scanExistingSessions` is the problem.

---

## 7. Sessions Directory Watcher

| Item | Details |
|------|---------|
| **File** | `wsServer.ts` |
| **Function** | `_watchSessionsDir`, `_onSessionRegistered` |
| **Lines** | 442–448, 438–441, 638–641 |

**Flow:** All extensions watch the same `sessions/` directory. When a file appears:
- `_onSessionRegistered(session)` checks `session.server_pid !== process.pid` → skip ✓

**Verdict:** Properly scoped. Each extension ignores sessions for other servers.

---

## 8. `_sendConversationData` – No Explicit Filter

| Item | Details |
|------|---------|
| **File** | `wsServer.ts` |
| **Lines** | 789–794 |

```ts
private _sendConversationData(ws: WebSocket, conversationId: string): void {
  const conv = readConversation(conversationId);
  if (conv) {
    this._send(ws, { type: 'conversation_loaded', conversation: conv });
  }
}
```

**Risk:** No `conv.server_pid === process.pid` check. If a webview ever sent a `load_conversation` with another window's conversation_id, we'd return it.

**Mitigation:** In practice, conversation_id comes from `get_conversations` which is filtered. So the webview only receives IDs for our conversations. But if restore (#2) leaks a conversation, that conversation gets a new `server_pid` (we overwrite it), so it would then be in our list. The leak is via restore, not via this function.

**Recommendation:** Add `conv.server_pid === process.pid` check for defense in depth.

---

## 9. `_resolveConversationId` – No Filter

| Item | Details |
|------|---------|
| **File** | `wsServer.ts` |
| **Lines** | 503–511 |

**Flow:** MCP sends `conversation_id`. We call `readConversation(providedId)` and `readSession(providedId)` – no filter. If the ID exists in another window's conversation, we'd find it. Then `_ensureConversation` would overwrite it with our `server_pid`.

**Risk:** If MCP ever sent a conversation_id from another window (e.g. shared state), we'd "steal" that conversation. MCP is scoped by CURSOR_TRACE_ID, so this is unlikely. Low priority.

---

## 10. Hook `findServerPid` – Fallback

| Item | Details |
|------|---------|
| **File** | `scripts/hooks/check-pending.js` |
| **Lines** | 89–124 |

**Priority 1:** `CURSOR_TRACE_ID` match ✓  
**Priority 2:** Workspace match – could pick wrong server if same workspace in multiple windows  
**Priority 3:** First server – wrong when multiple windows

**Risk:** When `CURSOR_TRACE_ID` is empty or missing, hook could write session with wrong `server_pid`, causing session to be picked up by wrong extension's watcher. But `_onSessionRegistered` filters by `server_pid`, so the wrong extension would receive it but then... actually no – it would skip. So the session would never be processed by the right extension. Different failure mode. For the leak case, we need the restore to be fixed.

---

## Complete Matrix of Cross-Window Data Paths

| # | Path | File:Function | Lines | Scoped? | Fix |
|---|------|--------------|-------|---------|-----|
| 1 | Conversation store | fileStore.ts | 110–127 | Filtered on list | N/A |
| 2 | **Restore in _scanExistingSessions** | wsServer.ts:_scanExistingSessions | 444–476 | **NO** | Add cursorTraceId filter |
| 3 | session_updated broadcast | wsServer.ts:_handleFeedbackRequest | 318–327 | Yes | N/A |
| 4 | Webview register | wsServer.ts:_handleMessage | 248–252 | Yes | N/A |
| 5 | queue-pending | wsServer.ts:_handleQueuePending | 413–434 | Yes | N/A |
| 6 | Pending watcher | wsServer.ts:_watchPendingFile | 382–438 | Yes | N/A |
| 7 | Sessions watcher | wsServer.ts:_watchSessionsDir | 442–448 | Yes | N/A |
| 8 | _onSessionRegistered | wsServer.ts:_onSessionRegistered | 638–641 | Yes | N/A |
| 9 | _sendConversationsList | wsServer.ts:_sendConversationsList | 773–787 | Yes | N/A |
| 10 | _sendConversationData | wsServer.ts:_sendConversationData | 789–794 | Partial | Add server_pid check |
| 11 | _ensureConversation | wsServer.ts:_ensureConversation | 512–553 | Yes | N/A |
| 12 | _onSessionEnded | wsServer.ts:_onSessionEnded | 680–693 | Yes | N/A |

---

## Recommended Fixes

### Fix 1: Restore by cursorTraceId (primary)

1. Add `cursorTraceId?: string` to `ConversationData` in `types.ts`
2. In `_ensureConversation` and `_onSessionRegistered`, set `conv.cursorTraceId = this.cursorTraceId`
3. In `_scanExistingSessions` restore filter, add:
   ```ts
   if (this.cursorTraceId && c.cursorTraceId && c.cursorTraceId !== this.cursorTraceId) return false;
   ```
4. If `cursorTraceId` is empty, optionally skip restore entirely for other-PID conversations to avoid workspace-only match.

### Fix 2: Defense in depth – _sendConversationData

```ts
if (conv && conv.server_pid === process.pid) {
  this._send(ws, { type: 'conversation_loaded', conversation: conv });
}
```

### Fix 3: Ensure new conversations get cursorTraceId

When creating conversations in `_ensureConversation` and `_onSessionRegistered`, always set `cursorTraceId: this.cursorTraceId`.
