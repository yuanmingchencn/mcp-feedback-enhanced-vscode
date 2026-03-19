#!/usr/bin/env node
/**
 * sessionStart hook for MCP Feedback Enhanced.
 *
 * - Register session file
 * - Inject conversation_id + USAGE RULES via additional_context
 * - Deliver pending messages (via HTTP from extension server)
 */

const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, SESSIONS_DIR, log, output, readStdin, httpGet, findServer } = require('./hook-utils');

const USAGE_RULES = [
    '[MCP Feedback Enhanced] USAGE RULES:',
    '1. You MUST call interactive_feedback before ending your turn.',
    '2. Only when the user explicitly confirms you can stop should you end. The decision to exit is ALWAYS the user\'s, never yours.',
    '3. If you have completed your task, call interactive_feedback with a summary and ask the user for next steps.',
    '4. Always pass your conversation_id (provided below) when calling interactive_feedback.',
].join('\n');

async function main() {
    var input = readStdin();
    if (!input) { output({ continue: true }); return; }

    var hook = input.hook_event_name || '';
    var conversationId = input.conversation_id || '';
    var workspaceRoots = input.workspace_roots || [];

    log(hook + ' conv=' + conversationId + ' model=' + (input.model || '') + ' ws=' + JSON.stringify(workspaceRoots));

    if (hook !== 'sessionStart') {
        output({ continue: true });
        return;
    }

    var server = findServer(workspaceRoots);
    var serverPid = server ? server.pid : null;
    var serverPort = server ? server.port : null;
    log('sessionStart: conv=' + conversationId + ' serverPid=' + (serverPid || 'null') + ' port=' + (serverPort || 'null'));

    var envOutput = serverPid ? { MCP_FEEDBACK_SERVER_PID: String(serverPid) } : {};

    if (conversationId && serverPid) {
        try {
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            fs.writeFileSync(
                path.join(SESSIONS_DIR, conversationId + '.json'),
                JSON.stringify({
                    conversation_id: conversationId,
                    workspace_roots: workspaceRoots,
                    model: input.model || '',
                    server_pid: serverPid,
                    started_at: Date.now(),
                })
            );
            log('  session written: ' + conversationId);
        } catch (e) {
            log('  session write error: ' + e.message);
        }
    }

    var contextParts = [USAGE_RULES];
    if (conversationId) {
        contextParts.push('\nYour conversation ID: ' + conversationId);
        contextParts.push('When calling interactive_feedback, pass conversation_id="' + conversationId + '" (exact value, do not modify).');
    }

    if (conversationId && serverPort) {
        try {
            var result = await httpGet(serverPort, '/pending/' + encodeURIComponent(conversationId) + '?consume=1');
            if (result.status === 200 && result.data) {
                var comments = result.data.comments || [];
                var images = result.data.images || [];
                var parts = [];
                var combined = comments.join('\n\n');
                if (combined) parts.push(combined);
                if (images.length > 0) parts.push('[' + images.length + ' image(s) attached — will be delivered via interactive_feedback]');
                if (parts.length > 0) {
                    contextParts.push('\n[Pending User Message]\n' + parts.join('\n'));
                    log('  sessionStart: consumed pending comments=' + comments.length + ' images=' + images.length);
                }
            }
        } catch (e) {
            log('  sessionStart: HTTP pending error ' + e.message);
        }
    }

    output({
        continue: true,
        env: envOutput,
        additional_context: contextParts.join('\n'),
    });
}

main();
