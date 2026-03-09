# Changelog

All notable changes to this project will be documented in this file.

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
