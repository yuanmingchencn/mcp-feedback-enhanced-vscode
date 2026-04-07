#!/usr/bin/env node

const { log, output, readStdin, httpGet, findServer, readFeedbackState, writeFeedbackState, readEnforcementConfig } = require('./hook-utils');

const ALLOWLIST_TOOLS = ['interactive_feedback', 'get_system_info', 'mcp-feedback-enhanced'];
const PASSTHROUGH_TOOLS = ['task', 'switchmode', 'read', 'grep', 'glob', 'semanticsearch', 'readlints', 'todowrite', 'askquestion'];

function isAllowlisted(toolName) {
    if (!toolName) return false;
    const lower = toolName.toLowerCase();
    if (ALLOWLIST_TOOLS.some(function (t) { return lower.includes(t.toLowerCase()); })) return true;
    if (PASSTHROUGH_TOOLS.some(function (t) { return lower === t; })) return true;
    return false;
}

var FEEDBACK_REMINDER = '\n\nReminder: use interactive_feedback to respond if needed, or adjust your plan and continue working.';

function fmtAgent(text) {
    return '[User Feedback] The user has submitted new feedback. Read it carefully and adjust your plan accordingly:\n\n"' + text + '"\n\nIf this feedback asks a question, seeks discussion, or needs confirmation, call interactive_feedback to respond. If it is guidance or instructions, adjust your plan and continue working.' + FEEDBACK_REMINDER;
}

function fmtUser(text) {
    return 'Pending comment delivered: "' + text + '"';
}

function updateCounter(toolName) {
    var state = readFeedbackState();
    if (toolName.toLowerCase().includes('interactive_feedback')) {
        state.lastFeedbackAt = Date.now();
        state.toolsSinceFeedback = 0;
    } else {
        state.toolsSinceFeedback = (state.toolsSinceFeedback || 0) + 1;
    }
    state.lastToolAt = Date.now();
    state.lastTool = toolName.toLowerCase();
    writeFeedbackState(state);
    return state;
}

async function main() {
    var input = readStdin();
    if (!input) { output({}); return; }

    var toolName = input.tool_name || '';
    var workspaceRoots = input.workspace_roots || [];

    log('preToolUse: tool=' + toolName);

    if (isAllowlisted(toolName)) {
        log('  preToolUse: allowlisted tool=' + toolName);
        updateCounter(toolName);
        output({});
        return;
    }

    var state = updateCounter(toolName);

    var server = findServer(workspaceRoots);
    var port = server ? server.port : null;
    if (!port) {
        log('  preToolUse: no server found');
        checkEnforcement(state);
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
        checkEnforcement(state);
    } catch (err) {
        log('  preToolUse: HTTP error ' + err.message);
        checkEnforcement(state);
    }
}

function checkEnforcement(state) {
    var cfg = readEnforcementConfig();
    var count = state.toolsSinceFeedback || 0;
    var lastFeedback = state.lastFeedbackAt || 0;
    var minutesSince = lastFeedback ? (Date.now() - lastFeedback) / 60000 : Infinity;

    var needsRefresh = (count > 0 && count >= cfg.maxToolCalls)
        || (lastFeedback && minutesSince >= cfg.maxMinutes);

    if (needsRefresh) {
        log('  preToolUse: rules refresh (count=' + count + ', minutes=' + Math.round(minutesSince) + ')');
        state.toolsSinceFeedback = 0;
        state.lastFeedbackAt = Date.now();
        writeFeedbackState(state);
        output({
            permission: 'deny',
            user_message: 'Rules refresh',
            agent_message: 'Reminder: you appear to have been executing a long task. '
                + 'Please re-read the always-applied rules in your context to make sure you haven\'t overlooked them. '
                + 'Then retry your tool call and continue working.',
        });
        return;
    }

    output({});
}

main();