#!/usr/bin/env node
/**
 * sessionStart hook for MCP Feedback Enhanced.
 *
 * - Inject USAGE RULES via additional_context
 * - Deliver pending messages (via HTTP from extension server)
 */

const { log, output, readStdin, httpGet, findServer } = require('./hook-utils');

const USAGE_RULES = [
    '[MCP Feedback Enhanced] USAGE RULES:',
    '1. You MUST call interactive_feedback before ending your turn.',
    '2. Only when the user explicitly confirms you can stop should you end. The decision to exit is ALWAYS the user\'s, never yours.',
    '3. If you have completed your task, call interactive_feedback with a summary and ask the user for next steps.',
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
    var serverPort = server ? server.port : null;
    log('sessionStart: conv=' + conversationId + ' port=' + (serverPort || 'null'));

    var contextParts = [USAGE_RULES];

    // Consume pending messages (global — no conversation_id in URL)
    if (serverPort) {
        try {
            var result = await httpGet(serverPort, '/pending?consume=1');
            if (result.status === 200 && result.data) {
                var comments = result.data.comments || [];
                var images = result.data.images || [];
                var parts = [];
                var combined = comments.join('\n\n');
                if (combined) parts.push(combined);
                if (images.length > 0) parts.push('[' + images.length + ' image(s) attached]');
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
        additional_context: contextParts.join('\n'),
    });
}

main();
