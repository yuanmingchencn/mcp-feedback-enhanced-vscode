#!/usr/bin/env node
/**
 * Cursor Hook: Check Pending Comments
 *
 * Injects pending user feedback into the agent loop at every actionable hook point.
 * pending.json is a plain-text file (the comment itself). On consume the file is deleted.
 *
 * Hook points (7 total):
 * - sessionStart:           Inject as additional_context + clear.
 * - preToolUse:             Deny non-allowlisted tools (agent sees reason). Never clears
 *                           because Cursor ignores preToolUse deny for Shell/MCP tools.
 * - beforeShellExecution:   Block + clear.
 * - beforeMCPExecution:     Block + clear.
 * - subagentStart:          Block subagent creation + clear.
 * - subagentStop:           Inject as followup_message + clear.
 * - stop:                   Deliver as followup or remind to call interactive_feedback.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
const PENDING_FILE = path.join(CONFIG_DIR, 'pending.json');

const STOP_LOOP_LIMIT = 2;
const ALLOWLIST_TOOLS = ['interactive_feedback', 'get_system_info', 'get_pending_comment'];
const FOLLOW_INSTRUCTIONS =
    'You MUST call the interactive_feedback tool now to check in with the user before ending. ' +
    'Provide a clear summary of what was done and ask for next steps.';

function readInput() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf-8'));
    } catch {
        return {};
    }
}

function output(response) {
    console.log(JSON.stringify(response));
}

function getPending() {
    try {
        if (!fs.existsSync(PENDING_FILE)) return null;
        const text = fs.readFileSync(PENDING_FILE, 'utf-8').trim();
        return text || null;
    } catch {
        return null;
    }
}

function consumePending() {
    try { fs.unlinkSync(PENDING_FILE); } catch { /* best effort */ }
}

function fmtAgent(comment) {
    return '[User Feedback] The user has submitted new feedback. Read it carefully and adjust your plan accordingly:\n\n"' + comment + '"\n\nIf this feedback asks a question, seeks discussion, or needs confirmation, call interactive_feedback to respond. If it is guidance or instructions, adjust your plan and continue working.';
}

function fmtUser(comment) {
    return 'Pending comment delivered: "' + comment + '"';
}

// ---------------------------------------------------------------------------
function main() {
    const input = readInput();
    const hook = input.hook_event_name || 'unknown';
    const loopCount = input.loop_count || 0;
    const toolName = input.tool_name || '';
    const pending = getPending();

    // ---- stop ----
    if (hook === 'stop') {
        if (loopCount >= STOP_LOOP_LIMIT) { output({}); return; }
        if (pending) {
            consumePending();
            output({ followup_message: fmtAgent(pending) });
        } else {
            output({ followup_message: FOLLOW_INSTRUCTIONS });
        }
        return;
    }

    // ---- subagentStop ----
    if (hook === 'subagentStop') {
        if (pending) {
            consumePending();
            output({ followup_message: fmtAgent(pending) });
        } else {
            output({});
        }
        return;
    }

    // No pending -> allow everything
    if (!pending) {
        if (hook === 'preToolUse')                                                output({ decision: 'allow' });
        else if (hook === 'beforeShellExecution' || hook === 'beforeMCPExecution') output({ permission: 'allow' });
        else if (hook === 'sessionStart')                                         output({ continue: true });
        else if (hook === 'subagentStart')                                        output({ decision: 'allow' });
        else                                                                      output({});
        return;
    }

    // ---- sessionStart ----
    if (hook === 'sessionStart') {
        consumePending();
        output({ continue: true, additional_context: fmtAgent(pending) });
        return;
    }

    // ---- preToolUse: deny all, never clear (Cursor ignores deny for Shell/MCP) ----
    if (hook === 'preToolUse') {
        if (ALLOWLIST_TOOLS.includes(toolName)) { output({ decision: 'allow' }); return; }
        output({ decision: 'deny', reason: fmtAgent(pending) });
        return;
    }

    // ---- beforeShellExecution: block + clear ----
    if (hook === 'beforeShellExecution') {
        consumePending();
        output({ permission: 'deny', user_message: fmtUser(pending), agent_message: fmtAgent(pending) });
        return;
    }

    // ---- beforeMCPExecution: block + clear (allow allowlisted tools) ----
    if (hook === 'beforeMCPExecution') {
        if (ALLOWLIST_TOOLS.includes(toolName)) {
            consumePending();
            output({ permission: 'allow', agent_message: fmtAgent(pending) });
            return;
        }
        consumePending();
        output({ permission: 'deny', user_message: fmtUser(pending), agent_message: fmtAgent(pending) });
        return;
    }

    // ---- subagentStart: block subagent creation ----
    if (hook === 'subagentStart') {
        consumePending();
        output({ decision: 'deny', reason: fmtAgent(pending) });
        return;
    }

    output({});
}

main();
