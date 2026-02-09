#!/usr/bin/env node
/**
 * MCP Feedback Enhanced - Cursor Hook Script
 * 
 * This script is deployed to ~/.config/mcp-feedback-enhanced/hooks/check-pending.js
 * and configured in ~/.cursor/hooks.json to inject pending user comments into
 * the agent's context as fast as possible.
 * 
 * Supported hooks (4 injection points):
 * - stop: Returns followup_message to auto-continue with pending comment
 * - beforeShellExecution: Injects agent_message while allowing the command
 * - beforeMCPExecution: Injects agent_message while allowing the MCP call
 * - preToolUse: Denies current tool with pending comment as reason (fastest injection)
 * 
 * Communication: Reads pending comments from a shared JSON file written by
 * the VSCode extension's WebSocket server.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PENDING_FILE = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced', 'pending.json');
// Track consumed comments to avoid duplicate injection within short window
const CONSUMED_FILE = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced', 'pending-consumed.json');
// Minimum interval between injections for the same workspace (ms)
// For preToolUse, use a longer interval to avoid excessive tool denials
const DEDUP_INTERVAL_MS = 5000;
const DEDUP_INTERVAL_PRETOOL_MS = 30000; // 30s for preToolUse to avoid disruption

/**
 * Read pending comments from the shared file.
 * Returns { workspace: string, comment: string } or null if no pending.
 */
function readPending(workspaceRoots) {
    try {
        if (!fs.existsSync(PENDING_FILE)) return null;

        const raw = fs.readFileSync(PENDING_FILE, 'utf8');
        if (!raw || raw.trim() === '{}') return null;

        const pending = JSON.parse(raw);

        // Match against workspace roots
        for (const ws of (workspaceRoots || [])) {
            // Try exact match
            if (pending[ws] && pending[ws].comment) {
                return { workspace: ws, comment: pending[ws].comment, timestamp: pending[ws].timestamp };
            }
            // Try normalized match (case-insensitive on macOS)
            const normalizedWs = ws.toLowerCase();
            for (const [key, value] of Object.entries(pending)) {
                if (key.toLowerCase() === normalizedWs && value && value.comment) {
                    return { workspace: key, comment: value.comment, timestamp: value.timestamp };
                }
                // Also check if one is a prefix of the other
                if (key.toLowerCase().startsWith(normalizedWs) || normalizedWs.startsWith(key.toLowerCase())) {
                    if (value && value.comment) {
                        return { workspace: key, comment: value.comment, timestamp: value.timestamp };
                    }
                }
            }
        }

        // Fallback: return first available pending comment
        for (const [key, value] of Object.entries(pending)) {
            if (value && value.comment) {
                return { workspace: key, comment: value.comment, timestamp: value.timestamp };
            }
        }

        return null;
    } catch (e) {
        return null;
    }
}

/**
 * Clear consumed pending comment from the file.
 */
function clearPending(workspace) {
    try {
        if (!fs.existsSync(PENDING_FILE)) return;

        const raw = fs.readFileSync(PENDING_FILE, 'utf8');
        const pending = JSON.parse(raw);

        if (pending[workspace]) {
            delete pending[workspace];
            fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
        }
    } catch (e) {
        // Ignore file operation errors
    }
}

/**
 * Check if this comment was already consumed recently (deduplication).
 * Uses different intervals for different hook types.
 * @param {string} workspace - Workspace path
 * @param {number} timestamp - Comment timestamp
 * @param {string} hookEvent - The hook event name (for interval selection)
 * Returns true if we should skip this comment.
 */
function isRecentlyConsumed(workspace, timestamp, hookEvent) {
    try {
        if (!fs.existsSync(CONSUMED_FILE)) return false;

        const raw = fs.readFileSync(CONSUMED_FILE, 'utf8');
        const consumed = JSON.parse(raw);

        // Use hook-specific key to allow different dedup per hook type
        const key = `${workspace}::${hookEvent || 'default'}`;

        if (consumed[key]) {
            // Same timestamp = same comment, check if consumed recently
            if (consumed[key].timestamp === timestamp) {
                const elapsed = Date.now() - consumed[key].consumedAt;
                // preToolUse uses longer interval to avoid excessive denials
                const interval = (hookEvent === 'preToolUse') ? DEDUP_INTERVAL_PRETOOL_MS : DEDUP_INTERVAL_MS;
                return elapsed < interval;
            }
        }
        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Mark a comment as consumed for a specific hook event.
 */
function markConsumed(workspace, timestamp, hookEvent) {
    try {
        let consumed = {};
        if (fs.existsSync(CONSUMED_FILE)) {
            try {
                consumed = JSON.parse(fs.readFileSync(CONSUMED_FILE, 'utf8'));
            } catch (e) {
                consumed = {};
            }
        }

        const key = `${workspace}::${hookEvent || 'default'}`;
        consumed[key] = {
            timestamp: timestamp,
            consumedAt: Date.now()
        };

        fs.writeFileSync(CONSUMED_FILE, JSON.stringify(consumed, null, 2));
    } catch (e) {
        // Ignore
    }
}

/**
 * Format the pending comment message.
 * Unified format for all hooks: direct and concise.
 */
function formatMessage(comment) {
    return `请先停下来当前的操作来思考：${comment}`;
}

/**
 * Build an updated_input for preToolUse that REPLACES the original tool input
 * with the pending comment message. The original operation is NOT preserved.
 * For Shell: replace command with echo of the pending message
 * For other tools: return null (no safe modification possible)
 */
function buildUpdatedInput(toolName, toolInput, comment) {
    if (!toolInput) return null;

    if (toolName === 'Shell' && toolInput.command) {
        // REPLACE original command entirely - agent must stop and think
        const escapedComment = comment.replace(/'/g, "'\\''");
        return {
            ...toolInput,
            command: `echo '请先停下来当前的操作来思考：${escapedComment}'`
        };
    }

    // For Read, Write, Grep, LS, Delete, etc. - no safe way to replace
    return null;
}

// Main: Read stdin, process hook, output response
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    try {
        const hookInput = JSON.parse(input);
        const hookEvent = hookInput.hook_event_name;
        const workspaceRoots = hookInput.workspace_roots || [];

        // Check for pending comments
        const pending = readPending(workspaceRoots);
        let response = {};

        if (hookEvent === 'stop') {
            // stop hook: Use followup_message to auto-continue (PRIMARY mechanism)
            if (pending && !isRecentlyConsumed(pending.workspace, pending.timestamp, 'stop')) {
                response = {
                    followup_message: formatMessage(pending.comment)
                };
                // Clear the pending and mark as consumed
                clearPending(pending.workspace);
                markConsumed(pending.workspace, pending.timestamp, 'stop');
            }
        } else if (hookEvent === 'preToolUse') {
            // preToolUse: Non-disruptive injection via updated_input
            // For Shell: prepend echo of pending to stderr
            // For other tools: allow unchanged (rely on other hooks for injection)
            if (pending && !isRecentlyConsumed(pending.workspace, pending.timestamp, 'preToolUse')) {
                const toolName = hookInput.tool_name || 'unknown';
                const toolInput = hookInput.tool_input;
                const updatedInput = buildUpdatedInput(toolName, toolInput, pending.comment);

                if (updatedInput) {
                    // We can embed the pending in the tool input
                    response = {
                        decision: 'allow',
                        updated_input: updatedInput
                    };
                    markConsumed(pending.workspace, pending.timestamp, 'preToolUse');
                    // Also mark for beforeShellExecution to avoid double-injection
                    if (toolName === 'Shell') {
                        markConsumed(pending.workspace, pending.timestamp, 'beforeShellExecution');
                    }
                } else {
                    // Can't safely modify this tool's input - just allow
                    // Other hooks (beforeShell, beforeMCP, stop) will handle injection
                    response = {
                        decision: 'allow'
                    };
                }
            } else {
                response = {
                    decision: 'allow'
                };
            }
        } else if (hookEvent === 'beforeShellExecution') {
            // beforeShellExecution: Block command and force agent to think about pending
            if (pending && !isRecentlyConsumed(pending.workspace, pending.timestamp, 'beforeShellExecution')) {
                response = {
                    permission: 'deny',
                    agent_message: formatMessage(pending.comment)
                };
                markConsumed(pending.workspace, pending.timestamp, 'beforeShellExecution');
            } else {
                response = {
                    permission: 'allow'
                };
            }
        } else if (hookEvent === 'beforeMCPExecution') {
            // Get the MCP tool name from hook input
            const mcpToolName = hookInput.mcp_tool_name || '';

            // Whitelist: Always allow interactive_feedback to pass through
            // Rationale: It's the primary communication channel - blocking it would prevent
            // AI from asking questions when user has pending input, causing confusion.
            // CRITICAL: Inject pending comment as agent_message AND clear it to prevent re-interception
            if (mcpToolName === 'interactive_feedback') {
                if (pending && !isRecentlyConsumed(pending.workspace, pending.timestamp, 'beforeMCPExecution')) {
                    // Inject the pending comment so LLM definitely receives it
                    response = {
                        permission: 'allow',
                        agent_message: formatMessage(pending.comment)
                    };
                    // Clear pending to prevent re-interception on next call
                    clearPending(pending.workspace);
                    markConsumed(pending.workspace, pending.timestamp, 'beforeMCPExecution');
                } else {
                    // No pending or already consumed - just allow
                    response = {
                        permission: 'allow'
                    };
                }
            }
            // beforeMCPExecution: Block other MCP calls and force agent to think about pending
            else if (pending && !isRecentlyConsumed(pending.workspace, pending.timestamp, 'beforeMCPExecution')) {
                response = {
                    permission: 'deny',
                    agent_message: formatMessage(pending.comment)
                };
                markConsumed(pending.workspace, pending.timestamp, 'beforeMCPExecution');
            } else {
                response = {
                    permission: 'allow'
                };
            }
        } else {
            // Unknown hook type - pass through
            response = {};
        }

        process.stdout.write(JSON.stringify(response) + '\n');
    } catch (e) {
        // On any error, output empty response (fail-open for stop/beforeShell)
        // Note: beforeMCPExecution uses fail-closed, so empty {} may block MCP calls
        // To be safe, output permission: allow for before* hooks
        process.stderr.write(`[mcp-feedback hook] Error: ${e}\n`);
        process.stdout.write('{"decision":"allow","permission":"allow"}\n');
    }
});
