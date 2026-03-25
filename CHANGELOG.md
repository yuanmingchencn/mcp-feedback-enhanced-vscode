# Changelog

All notable changes to this project will be documented in this file.

## [2.3.3] - 2026-03-25

### Subagent Exclusion

- Added rule 4: subagents (dispatched via Task tool) are explicitly told NOT to call `interactive_feedback`. Only the parent agent should call it.
- Fixes browser fallback spam when subagents try to call `interactive_feedback` and fall back to opening browser windows.

## [2.3.2] - 2026-03-25

### User-Level Rules Deployment

- Rules file (`mcp-feedback-enhanced.mdc`) is now deployed to `~/.cursor/rules/` (user-level) instead of per-workspace `.cursor/rules/`. This avoids polluting each project's git-tracked directory.
- Old workspace-level rule files are automatically cleaned up on activation.

## [2.3.1] - 2026-03-25

### Feedback Error Notification

- Show a Cursor warning notification (`vscode.window.showWarningMessage`) when a feedback session fails internally (e.g., enqueue rejected, server shutting down).
- Improved MCP server error logging: logs browser fallback failures separately.

## [2.3.0] - 2026-03-25

### Migrate USAGE RULES from Hook to Cursor Rules

Replaced the `sessionStart` hook with a native `.cursor/rules/mcp-feedback-enhanced.mdc` file for injecting USAGE RULES. This is more reliable because Cursor rules are system-level directives that persist through context compression, whereas hook-injected `additional_context` was a one-shot injection vulnerable to being lost.

### Added
- **`deployCursorRules()`**: Writes an `alwaysApply: true` `.mdc` rule file to each workspace's `.cursor/rules/` directory on activation.

### Changed
- **Hook count reduced from 2 to 1**: Only `preToolUse` (`consume-pending.js`) remains active. `sessionStart` hook is retired.
- **USAGE RULES delivery**: Moved from `sessionStart` hook `additional_context` to `.cursor/rules/mcp-feedback-enhanced.mdc`.

### Removed
- **`session-start.js` hook**: No longer needed — rules are now delivered via `.mdc` file.
- **`sessionStart` hook registration**: Removed from `hooks.json` config and added to `RETIRED_HOOKS` for automatic cleanup.

## [2.1.4] - 2026-03-19

### HTTP-Based Pending System & Hook Refactor

Complete replacement of file-based pending message system with HTTP endpoints and in-memory storage. Hooks refactored into modular scripts with shared utilities.

### Added
- **HTTP Endpoints**: `GET /pending/:id` and `GET /health` on the existing WebSocket server for pending message retrieval.
- **preToolUse Hook** (`consume-pending.js`): Dedicated hook that intercepts tool calls to deliver queued pending messages mid-conversation. Supports allowlisted/passthrough tools.
- **Shared Hook Utilities** (`hook-utils.js`): Extracted common functions (`log`, `output`, `readStdin`, `httpGet`, `getServerPort`, `findServer`) to reduce duplication across hook scripts.
- **Feedback Reminder**: All `interactive_feedback` responses and pending deliveries now include a trailing reminder to call `interactive_feedback` before ending.
- **Server Discovery Fallback**: `preToolUse` hook falls back to workspace-based server discovery when `MCP_FEEDBACK_SERVER_PID` is stale or missing.
- **Legacy Cleanup**: Extension auto-migrates old `pending/` directory and removes retired hook entries (`stop`, `check-pending.js`) on activation.

### Changed
- **Pending Storage**: Moved from file-based (`pending/<id>.json`) to in-memory `Map<string, PendingEntry>` — eliminates file I/O, polling, and race conditions.
- **Pending Delivery**: Hooks now consume pending via `HTTP GET /pending/:id?consume=1` instead of file reads and deletes.
- **Hook Architecture**: Split monolithic `check-pending.js` into `session-start.js` (sessionStart only) + `consume-pending.js` (preToolUse only) + `hook-utils.js` (shared).
- **Hook Registration**: Uses object format for per-hook options (e.g., `loop_limit`). Retired hooks are auto-cleaned from `hooks.json`.
- **Active Hooks**: Reduced from 6 to 2 — `sessionStart` and `preToolUse`. Removed `beforeShellExecution`, `beforeMCPExecution`, `subagentStart`, and `stop` (redundant with `preToolUse`).

### Removed
- **File-based pending**: `readPending`, `writePending`, `deletePending`, `getPendingDir`, `cleanupStalePending`, `cleanupLegacyPending` from `fileStore.ts`.
- **`PendingData` type**: No longer needed (in-memory entries use `PendingEntry`).
- **`stop` hook**: `followup_message` creates an infinite agent loop — removed entirely.
- **`check-pending.js`**: Replaced by `session-start.js` + `consume-pending.js`.

## [2.1.2] - 2026-03-18

### Session Queue & Hook Cleanup

- **Session Queue**: Concurrent feedback requests are queued per conversation instead of rejecting duplicates.
- **Disabled Hooks**: Removed `stop`, `preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, and `subagentStart` hook handlers from `check-pending.js` (redundant with new architecture).
- **Test Cleanup**: Removed tests for disabled hooks (`stop`, `preToolUse`, `subagentStart`).

## [2.0.0] - 2026-03-09

### Full Rewrite — Multi-Session Architecture

Complete rewrite from scratch with `conversation_id` (Cursor UUID) as the single source of truth for all state isolation.

### Added
- **Multi-Session Tabs**: Each Cursor agent conversation gets its own isolated tab with independent chat history, pending queue, and images.
- **Chat Bubble UI**: Messages displayed in left/right bubble format (AI left, user right) with futuristic styling, gradients, and glow effects.
- **Image Input**: Paste (Cmd+V), drag-drop, and file picker support. Images displayed in chat, included in pending messages, and returned to the LLM via MCP image responses.
- **Image Lightbox**: Click any image in chat for a full-size preview overlay.
- **Pending Delivered as User Bubbles**: Pending messages delivered by hooks are displayed as user message bubbles with a `📤 pending` hint badge, preserving images.
- **Auto-Focus**: Bottom panel automatically activates on extension startup and when the agent requests feedback, with multi-retry logic.
- **Quick Replies**: Styled quick reply buttons with gradient hover effects.
- **Settings Panel**: Floating card with distinct styling (rounded corners, shadow, purple gradient header), separate from the message list.
- **Input Draft Persistence**: Typed text preserved per tab across switches and restarts via debounced localStorage saves.
- **Conversation Persistence**: Conversations survive extension/Cursor restarts via file-based storage in `~/.config/mcp-feedback-enhanced/`.
- **IME Composition Handling**: Proper handling of IME input (CJK, etc.) — Enter during composition doesn't send.
- **Cross-Panel Sync**: Tab close, pending queue changes, and user replies broadcast to all connected webview panels.

### Changed
- **Architecture**: Replaced PID-based routing with `conversation_id`-based isolation. Extension acts as WebSocket hub; MCP server and webviews connect as clients.
- **Webview**: Single self-contained `static/panel.html` with inline CSS/JS (no generated HTML).
- **Hooks**: All 6 hook points use direct `conversation_id` matching for pending lookup — no fallback scanning. `beforeMCPExecution` unconditionally denies all tools when pending exists.
- **`retainContextWhenHidden: true`**: Webview state preserved when panel is hidden (previously `false`).
- **Removed console.log**: All console output removed from extension startup/deactivation paths to prevent Output panel stealing focus.

### Removed
- Sidebar panel (bottom panel only).
- SQLite/history.db storage (replaced with JSON files).
- `generate-webview.js` HTML generator (replaced with static `panel.html`).
- Fallback/scan logic in hooks (`getPending`, `consumePending` — direct match only).
- Browser fallback mode.

### Fixed
- **Deadlock Bug**: `consumePending` fallback only checked `comments`, not `images`. Image-only pending files were never deleted, causing infinite tool blocking.
- **Cross-Session Contamination**: `_resolveConversationId` no longer guesses — only matches existing conversation/session files.
- **Tab Labels**: Use incremental chat numbers (`#1 | HH:MM`) initially, updated to agent's summary when available.
- **Hook Output Fields**: Aligned with official Cursor API (`permission` instead of `decision`, etc.).

### Hook Design (6 points)
- `sessionStart`: Inject `conversation_id` + USAGE RULES via `additional_context`.
- `preToolUse`: Deny non-allowlisted tools + inject pending as `user_message`.
- `beforeShellExecution`: Block + inject pending.
- `beforeMCPExecution`: Unconditionally deny all MCP tools when pending exists.
- `subagentStart`: Block subagent creation + inject pending.
- `stop`: Deliver pending as `followup_message` or remind to call `interactive_feedback`.

## [1.2.23] - 2026-03-04

### Fixed
- **Removed `subagentStop` hook**: Its `followup_message` was disrupting the parent agent's normal processing of subagent results.

## [1.2.15] - 2026-03-03

### Re-added
- **Cursor Hooks integration** re-implemented with simplified architecture.

### Fixed
- **Critical path mismatch**: Hook was reading from wrong path.
- **Race condition**: `preToolUse` deny was overridden by `beforeShellExecution` allow for Shell tools.

## [1.2.5] - 2026-02-10

### Removed
- **Removed Cursor Hooks integration** to simplify the extension architecture.

## [1.2.0] - Previous Releases

### Added
- WebSocket-based architecture.
- Auto-configuration for MCP server.
- Initial Cursor hooks integration.
