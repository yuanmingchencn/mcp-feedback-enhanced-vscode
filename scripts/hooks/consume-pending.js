#!/usr/bin/env node
/**
 * preToolUse hook for MCP Feedback Enhanced.
 *
 * Consumes pending user messages via HTTP from the extension server.
 * If pending exists, denies the tool call and injects the user's feedback.
 * Allowlisted tools (interactive_feedback, read-only) are never blocked.
 */

const { log, output, readStdin, httpGet, findServer } = require('./hook-utils');

const ALLOWLIST_TOOLS = ['interactive_feedback', 'get_system_info', 'mcp-feedback-enhanced'];
const PASSTHROUGH_TOOLS = ['task', 'switchmode', 'read', 'grep', 'glob', 'semanticsearch', 'readlints', 'todowrite', 'askquestion'];

function isAllowlisted(toolName) {
    if (!toolName) return false;
    const lower = toolName.toLowerCase();
    if (ALLOWLIST_TOOLS.some(function (t) { return lower.includes(t.toLowerCase()); })) return true;
    if (PASSTHROUGH_TOOLS.some(function (t) { return lower === t; })) return true;
    return false;
}

var FEEDBACK_REMINDER = '\n\nReminder: You MUST call interactive_feedback before ending your turn. The decision to exit is ALWAYS the user\'s, never yours.';

function fmtAgent(text) {
    return '[User Feedback] The user has submitted new feedback. Read it carefully and adjust your plan accordingly:\n\n"' + text + '"\n\nIf this feedback asks a question, seeks discussion, or needs confirmation, call interactive_feedback to respond. If it is guidance or instructions, adjust your plan and continue working.' + FEEDBACK_REMINDER;
}

function fmtUser(text) {
    return 'Pending comment delivered: "' + text + '"';
}

async function main() {
    var input = readStdin();
    if (!input) { output({}); return; }

    var toolName = input.tool_name || '';
    var workspaceRoots = input.workspace_roots || [];

    log('preToolUse: tool=' + toolName);

    if (isAllowlisted(toolName)) {
        log('  preToolUse: allowlisted tool=' + toolName);
        output({});
        return;
    }

    var server = findServer(workspaceRoots);
    var port = server ? server.port : null;
    if (!port) {
        log('  preToolUse: no server found');
        output({});
        return;
    }

    try {
        var result = await httpGet(port, '/pending?consume=1');
        if (result.status === 200 && result.data) {
            var comments = result.data.comments || [];
            var combined = comments.join('\n\n') || '(image pending)';
            log('  preToolUse: consumed pending comments=' + comments.length);
            output({
                permission: 'deny',
                user_message: fmtUser(combined),
                agent_message: fmtAgent(combined),
            });
            return;
        }
        log('  preToolUse: no pending (status=' + result.status + ')');
        output({});
    } catch (err) {
        log('  preToolUse: HTTP error ' + err.message);
        output({});
    }
}

main();
