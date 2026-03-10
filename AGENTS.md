# AGENTS.md — Learned Patterns

## Workflow

- The parent agent is a coordinator only: it must NOT edit files directly. All implementation work is delegated to sub-agents.
- Always call `interactive_feedback` MCP before ending a turn. The decision to exit is always the user's, never the agent's.
- If a solution is getting increasingly complex, stop and rethink the approach instead of adding more patches.
- If the user cancels an operation, immediately call `interactive_feedback` to check in.
- When `loop_count >= 2` in the stop hook, summarize progress instead of silently exiting.
- Pending user messages should be consumed as fast as possible — add handling in every applicable hook.
- When the user clearly wants to exit, the stop hook should not force another `interactive_feedback` call.

## Architecture

- Extension is a WebSocket hub. MCP server and webview connect as clients.
- MCP server runs via built-in JS bundled in the extension, not via npm/npx.
- Deployment is via VSIX to Open VSX; `mcp.json` is auto-configured by the extension on activation.
- `conversation_id` from Cursor hooks (UUID) is the single routing key across the entire system. Do NOT merge it with `agent_name` or create a combined `effectiveId`. Pass them separately: `conversation_id` for routing, `agent_name`/`label` for display.
- Session files (`sessions/<cursor_uuid>.json`) are written by the `sessionStart` hook. Pending files (`pending/<conversation_id>.json`) are written by the extension.
- Cross-window isolation: active sessions are scoped by `server_pid`; historical conversations are shared across windows in the same workspace.

## Hooks

- The hook script (`check-pending.js`) handles all 6 Cursor hook events in a single file.
- `preToolUse` allowlists `interactive_feedback` so it is never denied.
- `beforeMCPExecution` does NOT allowlist — it denies all MCP tools when pending content exists, so the pending message is delivered first.
- Do NOT intercept `subagentStart` stop events — this causes problems with sub-agent workflows.
- Do NOT have both `preToolUse` and `beforeShellExecution` handle the same pending in a way that races.

## UI/UX

- Agent-facing instructions and raw tool call parameters must never appear in the user-facing panel.
- Queue action replaces the previous pending message, not appends to it.
- Tabs/messages for ended sessions should be greyed out (opacity, grayscale, hidden input).
- Pending delivery should show a visible indicator in the feedback panel.

## Anti-Patterns

- Do NOT manually edit `~/.cursor/mcp.json` — use the extension's auto-configuration.
- Do NOT use npm/npx to start the MCP server.
- Do NOT create fallback/scanning logic when a clean single-ID design would work.
- Do NOT refactor in a way that regresses to older behavior or loses existing features.
