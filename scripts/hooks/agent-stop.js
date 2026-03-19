#!/usr/bin/env node
/**
 * stop hook for MCP Feedback Enhanced.
 *
 * When the agent completes, reminds it to call interactive_feedback
 * instead of silently exiting. The user decides when to stop.
 */

const { log, output, readStdin, httpGet, findServer } = require('./hook-utils');

async function main() {
    var input = readStdin();
    if (!input) { output({}); return; }

    var status = input.status || '';
    var loopCount = input.loop_count || 0;
    var conversationId = input.conversation_id || '';
    var serverPid = process.env.MCP_FEEDBACK_SERVER_PID || '';
    var workspaceRoots = input.workspace_roots || [];

    log('stop: status=' + status + ' loop=' + loopCount + ' conv=' + conversationId);

    if (status !== 'completed') {
        log('  stop: status=' + status + ', no followup');
        output({});
        return;
    }

    var port = serverPid ? (function () {
        var { getServerPort } = require('./hook-utils');
        return getServerPort(serverPid);
    })() : null;
    if (!port) {
        var server = findServer(workspaceRoots);
        port = server ? server.port : null;
    }

    var hasPending = false;
    if (port && conversationId) {
        try {
            var result = await httpGet(port, '/pending/' + encodeURIComponent(conversationId));
            hasPending = result.status === 200;
        } catch (e) {
            log('  stop: pending check error ' + e.message);
        }
    }

    var msg = 'You MUST call interactive_feedback with a summary of what you have done before ending. The user has not confirmed you can stop. Do NOT end without calling interactive_feedback.';
    if (hasPending) {
        msg = 'There are pending user messages waiting for you. You MUST call interactive_feedback to check in with the user before ending.';
    }

    log('  stop: followup (loop=' + loopCount + ')');
    output({ followup_message: msg });
}

main();
