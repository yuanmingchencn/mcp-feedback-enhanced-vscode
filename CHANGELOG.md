# Changelog

All notable changes to this project will be documented in this file.

## [1.2.4] - 2026-02-10

### Removed
- **Removed Cursor Hooks integration** to simplify the extension architecture
- Deleted `scripts/hooks/check-pending.js` and related deployment logic
- Removed automatic `~/.cursor/hooks.json` configuration

### Rationale
- Hooks added complexity and potential for conflicts with other extensions
- MCP Resource-based pending comment access is sufficient for most use cases
- Reduces maintenance burden and potential bugs

### Retained
- Pending comment tracking via WebSocket and file-based storage
- MCP Resource `get_pending_comment` for programmatic access
- All other features (WebSocket architecture, multi-window support, etc.)

## [1.2.3] - 2026-02-09

### Changed
- **Removed `beforeShellExecution` hook** to reduce interception overhead
- Now using 3 hook points instead of 4: `stop`, `preToolUse`, `beforeMCPExecution`
- Shell commands are no longer intercepted by hooks (preToolUse handles Shell via command modification)

### Rationale
- `beforeShellExecution` was redundant with `preToolUse` which already modifies Shell commands
- Reduces hook overhead and potential for over-blocking
- Maintains full coverage with remaining 3 hooks

## [1.2.2] - 2026-02-09

### Fixed
- **Critical**: Fixed MCP hook recursion issue where `interactive_feedback` calls were being blocked by pending comments, causing potential infinite loops
- Hook now whitelists `interactive_feedback` tool to always allow it through
- Pending comments are now properly injected as `agent_message` when `interactive_feedback` is called, ensuring LLM receives them
- Added deduplication protection to prevent double-injection if other hooks already fired
- Pending comments are automatically cleared after injection to prevent re-interception

### Technical Details
- Modified `scripts/hooks/check-pending.js` to handle `interactive_feedback` specially in `beforeMCPExecution` hook
- When `interactive_feedback` is called with a pending comment:
  1. Tool is allowed to execute (not blocked)
  2. Pending comment is injected via `agent_message`
  3. Pending is cleared to prevent loops
  4. Dedup marker is set to prevent re-injection

## [1.2.1] - Previous Release

### Added
- Initial hook system implementation
- Pending comment queue
- Multi-window support improvements

## [1.2.0] - Previous Release

### Added
- WebSocket-based architecture
- Auto-configuration for MCP server
- Cursor hooks integration
