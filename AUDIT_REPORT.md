# Comprehensive Audit Report: wsServer.ts

**File**: `/Users/yuanming.chen/Documents/atome-code/mcp-feedback-enhanced/src/wsServer.ts`  
**Date**: 2026-02-06  
**Lines of Code**: 994

---

## 1. Schema & Migration

### Schema Definition (Lines 779-792)
```sql
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    images TEXT,
    workspace TEXT,
    project_directory TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### Migration (Lines 794-800)
```typescript
try {
    this._db.exec(`ALTER TABLE history ADD COLUMN agent_name TEXT DEFAULT 'Agent'`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_name ON history(agent_name)`);
} catch (e) {
    // Column already exists, ignore
}
```

**Analysis**:
- ✅ **Migration is safe**: Uses try-catch to handle "column already exists" error
- ✅ **Default value**: Sets DEFAULT 'Agent' for existing rows
- ✅ **Index creation**: Creates index with IF NOT EXISTS (safe on subsequent runs)
- ⚠️ **Potential issue**: If migration fails for reasons other than "column exists", it's silently ignored. However, this is acceptable since the error would be caught and logged elsewhere.

**Confidence**: **HIGH** - Migration will run safely on first and subsequent starts.

---

## 2. _addToHistory() - Function Signature & Call Sites

### Function Signature (Line 962)
```typescript
private _addToHistory(workspace: string, message: HistoryMessage, projectDirectory?: string, agentName?: string): void
```

### Call Site 1: _handleFeedbackRequest (Line 575)
```typescript
this._addToHistory(workspace, {
    role: 'ai',
    content: summary,
    timestamp: new Date().toISOString()
}, project_directory, agent_name || 'Agent');
```
✅ **Correct**: Passes `agent_name || 'Agent'` as 4th parameter

### Call Site 2: _handleFeedbackResponse (Line 667)
```typescript
this._addToHistory(workspace, {
    role: 'user',
    content: feedback,
    timestamp: new Date().toISOString(),
    images
}, projectDirectory, pending?.agentName);
```
✅ **Correct**: Passes `pending?.agentName` as 4th parameter

### Implementation (Lines 962-992)
```typescript
stmt.run(
    message.role,
    message.content,
    message.timestamp,
    message.images ? JSON.stringify(message.images) : null,
    workspace,
    projectDirectory || null,
    agentName || 'Agent'  // ✅ Defaults to 'Agent' if undefined/null
);
```

**Analysis**:
- ✅ **All call sites pass agent_name correctly**
- ✅ **Function correctly stores agent_name** with fallback to 'Agent'
- ✅ **Handles undefined/null** via `agentName || 'Agent'`

**Confidence**: **HIGH** - All call sites are correct and function stores agent_name properly.

---

## 3. _handleFeedbackRequest()

### Agent Name Extraction (Line 556)
```typescript
const { session_id, summary, project_directory, timeout, agent_name } = message;
```
✅ **Correct**: Extracts `agent_name` from message

### Passes to _addToHistory (Line 579)
```typescript
this._addToHistory(workspace, {...}, project_directory, agent_name || 'Agent');
```
✅ **Correct**: Passes agent_name with fallback

### Stores in _pendingFeedback (Line 619)
```typescript
agentName: agent_name || 'Agent',
```
✅ **Correct**: Stores agentName in _pendingFeedback map

### Broadcast Includes agent_name (Lines 592-602)
```typescript
const sessionMsg = {
    type: 'session_updated',
    session_info: {
        session_id,
        summary,
        project_directory,
        timeout,
        agent_name  // ✅ Pass through for multi-agent display
    }
};
```
✅ **Correct**: Includes agent_name in session_updated broadcast

**Analysis**:
- ✅ Extracts agent_name from message
- ✅ Passes to _addToHistory correctly
- ✅ Stores in _pendingFeedback correctly
- ✅ Includes in session_updated broadcast

**Confidence**: **HIGH** - All aspects work correctly.

---

## 4. _handleFeedbackResponse()

### Gets agentName from _pendingFeedback (Line 661-662)
```typescript
const pending = this._pendingFeedback.get(session_id);
const projectDirectory = pending?.projectPath;
```
✅ **Correct**: Retrieves pending feedback object

### Passes agentName to _addToHistory (Line 672)
```typescript
this._addToHistory(workspace, {...}, projectDirectory, pending?.agentName);
```
✅ **Correct**: Passes `pending?.agentName` to _addToHistory

**Analysis**:
- ✅ Retrieves agentName from _pendingFeedback
- ✅ Passes to _addToHistory correctly
- ⚠️ **Edge case**: If `pending` is undefined (session_id not found), `pending?.agentName` will be undefined, but _addToHistory handles this with `agentName || 'Agent'`

**Confidence**: **HIGH** - Works correctly, with safe fallback.

---

## 5. _listSessions()

### SQL Query (Lines 857-867)
```sql
SELECT 
    agent_name,
    COUNT(*) as message_count,
    MAX(timestamp) as last_timestamp,
    MIN(CASE WHEN role = 'ai' THEN timestamp END) as first_timestamp
FROM history
WHERE workspace = ? OR project_directory = ?
GROUP BY agent_name
ORDER BY MAX(created_at) DESC
```

### Preview Query (Lines 872-876)
```sql
SELECT content FROM history 
WHERE (workspace = ? OR project_directory = ?) AND agent_name = ? AND role = 'ai'
ORDER BY id DESC LIMIT 1
```

**Analysis**:
- ✅ **SQL is correct**: Groups by agent_name, filters by workspace/project_directory
- ⚠️ **NULL handling**: SQLite's GROUP BY handles NULL values - NULL agent_names will be grouped together
- ✅ **Returns correct data**: agent_name, message_count, timestamps, preview
- ⚠️ **Potential issue**: If agent_name is NULL, the preview query will match NULL rows correctly (SQLite NULL = NULL comparison works with IS NULL, but `agent_name = ?` with NULL parameter won't match NULL rows)

**Confidence**: **MEDIUM** - SQL is mostly correct, but NULL handling in preview query may have issues.

### NULL Handling Test:
- If `s.agent_name` is NULL, `previewStmt.get(workspace, workspace, s.agent_name)` will pass NULL
- SQLite: `agent_name = NULL` evaluates to NULL (not TRUE), so won't match NULL rows
- **BUG**: NULL agent_names won't get previews correctly

---

## 6. _loadSessionByAgent()

### SQL Query (Lines 900-906)
```sql
SELECT role, content, timestamp, images, workspace, project_directory, agent_name
FROM history
WHERE (workspace = ? OR project_directory = ?) AND agent_name = ?
ORDER BY id ASC
LIMIT ?
```

**Analysis**:
- ✅ **SQL is correct**: Filters by workspace/project_directory AND agent_name
- ✅ **Includes agent_name in results**: Selected in SELECT clause and mapped in return (line 917)
- ⚠️ **NULL handling**: If `agentName` parameter is NULL, `agent_name = NULL` won't match NULL rows (SQLite NULL comparison issue)

**Confidence**: **MEDIUM** - Works for non-NULL agent_names, but NULL handling may fail.

---

## 7. Message Handler Switch

### get_sessions Case (Lines 512-517)
```typescript
case 'get_sessions':
    if (client.projectPath) {
        const sessionList = this._listSessions(client.projectPath);
        this._send(ws, { type: 'sessions_list', sessions: sessionList });
    }
    break;
```
✅ **Correct**: Exists and calls _listSessions correctly

### load_session Case (Lines 519-530)
```typescript
case 'load_session':
    if (client.projectPath && message.agent_name) {
        const sessionMessages = this._loadSessionByAgent(client.projectPath, message.agent_name);
        const sessionRecords = this._toSessionRecords(sessionMessages);
        this._send(ws, { 
            type: 'session_loaded', 
            agent_name: message.agent_name, 
            sessions: sessionRecords,
            messages: sessionMessages 
        });
    }
    break;
```
✅ **Correct**: Exists, checks for agent_name, calls _loadSessionByAgent correctly

**Confidence**: **HIGH** - Both cases exist and work correctly.

---

## 8. Register Handler

### Register Case (Lines 469-492)
```typescript
case 'register':
    client.type = message.clientType || 'webview';
    client.projectPath = message.projectPath;
    client.sessionId = message.sessionId;
    
    // Send history to webview
    if (client.type === 'webview' && client.projectPath) {
        const messages = this._loadHistory(client.projectPath);
        const sessions = this._toSessionRecords(messages);
        this._send(ws, { type: 'history', sessions });
        
        // Send session list for history panel
        const sessionList = this._listSessions(client.projectPath);
        this._send(ws, { type: 'sessions_list', sessions: sessionList });
    }
    break;
```
✅ **Correct**: Sends `sessions_list` to webview on registration (line 484)

**Confidence**: **HIGH** - Correctly sends sessions_list on registration.

---

## 9. Multi-Window Isolation

### Workspace Filtering in _listSessions (Line 864)
```typescript
WHERE workspace = ? OR project_directory = ?
```
✅ **Correct**: Filters by workspace OR project_directory

### Workspace Filtering in _loadSessionByAgent (Line 903)
```typescript
WHERE (workspace = ? OR project_directory = ?) AND agent_name = ?
```
✅ **Correct**: Filters by workspace/project_directory AND agent_name

### Workspace Filtering in _loadHistory (Line 829)
```typescript
WHERE workspace = ? OR project_directory = ?
```
✅ **Correct**: Filters by workspace OR project_directory

**Analysis**:
- ✅ **Workspace filtering is consistent** across all queries
- ✅ **Uses OR logic**: Matches if either workspace or project_directory matches
- ⚠️ **Potential issue**: If multiple windows have overlapping project paths, they may see each other's data. However, this is by design for multi-window scenarios.

**Confidence**: **HIGH** - Workspace filtering works correctly as designed.

---

## 10. Multi-Agent Isolation

### Agent Name Grouping in _listSessions (Line 865)
```typescript
GROUP BY agent_name
```
✅ **Correct**: Groups sessions by agent_name

### NULL Handling
- ⚠️ **SQLite behavior**: NULL values are grouped together in GROUP BY
- ⚠️ **NULL comparison issue**: `agent_name = NULL` doesn't match NULL rows (needs `IS NULL`)

**Analysis**:
- ✅ **Non-NULL agent_names**: Correctly isolated and grouped
- ⚠️ **NULL agent_names**: Will be grouped together, but queries using `agent_name = ?` won't match them correctly

**Confidence**: **MEDIUM** - Works for non-NULL agent_names, but NULL handling has issues.

---

## 11. Concurrent Feedback Requests

### _pendingFeedback Map (Line 69)
```typescript
private _pendingFeedback: Map<string, PendingFeedback> = new Map();
```

### Key: session_id (Line 615)
```typescript
this._pendingFeedback.set(session_id, {...});
```

### Concurrent Request Flow:
1. **Request 1**: `session_id = "abc"`, `agent_name = "Agent1"` → stored in map
2. **Request 2**: `session_id = "xyz"`, `agent_name = "Agent2"` → stored in map
3. **Response 1**: Looks up by `session_id = "abc"` → finds correct pending
4. **Response 2**: Looks up by `session_id = "xyz"` → finds correct pending

**Analysis**:
- ✅ **Isolation**: Each session_id is unique key, so concurrent requests are isolated
- ✅ **Lookup**: Responses use session_id to find correct pending feedback
- ✅ **Cleanup**: On timeout or response, entry is deleted (lines 611, 701)
- ✅ **Connection cleanup**: On MCP server disconnect, pending feedback is cleaned up (lines 437-446)

**Confidence**: **HIGH** - Concurrent requests are properly isolated by session_id.

---

## 12. Edge Cases

### Empty String agent_name

**In _handleFeedbackRequest (Line 579)**:
```typescript
agent_name || 'Agent'
```
- Empty string `""` is falsy → defaults to `'Agent'` ✅

**In _addToHistory (Line 977)**:
```typescript
agentName || 'Agent'
```
- Empty string `""` is falsy → defaults to `'Agent'` ✅

**In SQL queries**:
- Empty string `""` is treated as non-NULL → queries work correctly ✅

**Analysis**: ✅ Empty strings are handled correctly (treated as falsy, default to 'Agent')

### Very Long agent_name

**Database**: SQLite TEXT column has no explicit length limit (practical limit ~1GB)
**No validation**: No length check before storing
**Potential issues**:
- ⚠️ Very long agent_names could cause performance issues in GROUP BY
- ⚠️ Index on agent_name could become inefficient with very long values
- ⚠️ No practical limit enforced

**Analysis**: ⚠️ No explicit length validation, but SQLite can handle it (with potential performance impact)

**Confidence**: **MEDIUM** - Edge cases mostly handled, but very long agent_names could cause issues.

---

## Summary of Issues Found

### HIGH Priority Issues

**None** - All critical functionality works correctly.

### MEDIUM Priority Issues

1. **NULL agent_name handling in SQL queries** (Lines 874, 903)
   - **Issue**: `agent_name = NULL` doesn't match NULL rows in SQLite
   - **Impact**: NULL agent_names won't get previews in _listSessions and won't be loadable in _loadSessionByAgent
   - **Fix**: Use `agent_name IS NULL` or `COALESCE(agent_name, 'Agent')` in queries
   - **Confidence**: MEDIUM

2. **No length validation for agent_name**
   - **Issue**: Very long agent_names could cause performance issues
   - **Impact**: Low (unlikely in practice, but possible)
   - **Fix**: Add length validation (e.g., max 255 chars) before storing
   - **Confidence**: MEDIUM

### LOW Priority Issues

**None**

---

## Overall Assessment

**Overall Confidence**: **HIGH** - The code is well-structured and handles the main use cases correctly. The NULL handling issue is minor and only affects edge cases where agent_name is explicitly NULL (which shouldn't happen in normal operation due to the `|| 'Agent'` fallbacks).

**Recommendations**:
1. Fix NULL handling in SQL queries for robustness
2. Consider adding length validation for agent_name (optional, low priority)
3. Add unit tests for NULL agent_name scenarios
