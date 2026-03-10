#!/usr/bin/env node
/**
 * Cursor Hooks script for MCP Feedback Enhanced.
 *
 * Handles: sessionStart, stop, preToolUse, beforeShellExecution,
 *          beforeMCPExecution, subagentStart
 *
 * Core design: conversation_id is the single source of truth.
 * - sessionStart: register session + inject conversation_id + USAGE RULES via additional_context
 * - All hooks: read pending/<conversation_id>.json, inject if exists
 * - stop: safety net reminder
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const PENDING_DIR = path.join(CONFIG_DIR, 'pending');
const SERVERS_DIR = path.join(CONFIG_DIR, 'servers');

const STOP_LOOP_LIMIT = 3;
const FOLLOW_INSTRUCTIONS =
    'You MUST call the interactive_feedback tool now to check in with the user before ending. ' +
    'Provide a clear summary of what was done and ask for next steps.';

const ALLOWLIST_TOOLS = ['interactive_feedback', 'get_system_info', 'mcp-feedback-enhanced'];

function isAllowlisted(toolName) {
    if (!toolName) return false;
    const lower = toolName.toLowerCase();
    return ALLOWLIST_TOOLS.some(t => lower.includes(t.toLowerCase()));
}

const USAGE_RULES = [
    '[MCP Feedback Enhanced] USAGE RULES:',
    '1. You MUST call interactive_feedback before ending your turn.',
    '2. Only when the user explicitly confirms you can stop should you end. The decision to exit is ALWAYS the user\'s, never yours.',
    '3. If you have completed your task, call interactive_feedback with a summary and ask the user for next steps.',
    '4. Always pass your conversation_id (provided below) when calling interactive_feedback.',
].join('\n');

// ─── Helpers ──────────────────────────────────────────────

function output(obj) {
    log(`  → output: ${JSON.stringify(obj).slice(0, 300)}`);
    process.stdout.write(JSON.stringify(obj));
}

function readJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return null; }
}

function fmtAgent(text) {
    return '[User Feedback] The user has submitted new feedback. Read it carefully and adjust your plan accordingly:\n\n"' + text + '"\n\nIf this feedback asks a question, seeks discussion, or needs confirmation, call interactive_feedback to respond. If it is guidance or instructions, adjust your plan and continue working.';
}

function fmtUser(text) {
    return 'Pending comment delivered: "' + text + '"';
}

// ─── Pending ──────────────────────────────────────────────

function getPending(conversationId) {
    if (!conversationId) return null;
    return readJSON(path.join(PENDING_DIR, `${conversationId}.json`));
}

function hasPendingContent(p) {
    return p && ((p.comments && p.comments.length > 0) || (p.images && p.images.length > 0));
}

function consumePending(conversationId) {
    if (!conversationId) return;
    const filePath = path.join(PENDING_DIR, `${conversationId}.json`);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            log(`  consumed pending: ${conversationId}`);
        }
    } catch (e) {
        log(`  consumePending error: ${e.message}`);
    }
}

// ─── Server Matching ──────────────────────────────────────

function findServerPid(workspaceRoots) {
    try {
        if (!fs.existsSync(SERVERS_DIR)) { log('  findServerPid: no servers dir'); return null; }
        const files = fs.readdirSync(SERVERS_DIR).filter(f => f.endsWith('.json'));
        const servers = [];

        for (const f of files) {
            const s = readJSON(path.join(SERVERS_DIR, f));
            if (!s || !s.pid) continue;
            try { process.kill(s.pid, 0); } catch { continue; }
            servers.push(s);
        }

        if (servers.length === 0) { log('  findServerPid: no alive servers'); return null; }
        if (servers.length === 1) { log(`  findServerPid: single server pid=${servers[0].pid}`); return servers[0].pid; }

        // Priority 1: workspace match (definitive per Cursor window)
        const roots = (workspaceRoots || []).map(r => r.replace(/\/+$/, ''));
        for (const s of servers) {
            const sWs = (s.workspaces || []).map(w => w.replace(/\/+$/, ''));
            if (roots.some(r => sWs.includes(r))) { log(`  findServerPid: workspace match pid=${s.pid}`); return s.pid; }
        }

        // Priority 2: CURSOR_TRACE_ID fallback (not unique per window on macOS)
        const traceId = process.env.CURSOR_TRACE_ID || '';
        if (traceId) {
            for (const s of servers) {
                if (s.cursorTraceId === traceId) { log(`  findServerPid: traceId match pid=${s.pid}`); return s.pid; }
            }
        }

        log(`  findServerPid: fallback to first pid=${servers[0].pid}`);
        return servers[0].pid;
    } catch { return null; }
}

// ─── Main ─────────────────────────────────────────────────

function log(msg) {
    try {
        const logDir = path.join(CONFIG_DIR, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, 'hooks.log');
        // Rotate at ~2MB
        try {
            const stat = fs.statSync(logFile);
            if (stat.size > 2 * 1024 * 1024) {
                try { fs.unlinkSync(logFile + '.old'); } catch {}
                fs.renameSync(logFile, logFile + '.old');
            }
        } catch {}
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
}

function main() {
    let rawInput = '';
    let input;
    try {
        rawInput = fs.readFileSync('/dev/stdin', 'utf-8');
        input = JSON.parse(rawInput);
    } catch (e) {
        log(`PARSE_ERROR: ${e.message} raw=${rawInput.slice(0, 200)}`);
        output({ continue: true });
        return;
    }

    const hook = input.hook_event_name || '';
    const conversationId = input.conversation_id || '';
    const loopCount = input.loop_count || 0;
    const workspaceRoots = input.workspace_roots || [];

    log(`${hook} conv=${conversationId} model=${input.model || ''} tool=${input.tool_name || ''} ws=${JSON.stringify(workspaceRoots)}`);

    // ─── sessionStart ─────────────────────────────────
    if (hook === 'sessionStart') {
        const serverPid = findServerPid(workspaceRoots);
        log(`sessionStart: conv=${conversationId} serverPid=${serverPid} ws=${JSON.stringify(workspaceRoots)}`);
        const envOutput = serverPid ? { MCP_FEEDBACK_SERVER_PID: String(serverPid) } : {};

        if (conversationId && serverPid) {
            try {
                fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                fs.writeFileSync(
                    path.join(SESSIONS_DIR, `${conversationId}.json`),
                    JSON.stringify({
                        conversation_id: conversationId,
                        workspace_roots: workspaceRoots,
                        model: input.model || '',
                        server_pid: serverPid,
                        started_at: Date.now(),
                    })
                );
                log(`  session written: ${conversationId}.json`);
            } catch (e) {
                log(`  session write error: ${e.message}`);
            }
        } else {
            log(`  session NOT written: conv=${conversationId || '(empty)'} pid=${serverPid || '(none)'}`);
        }

        // Build additional_context with conversation_id + USAGE RULES
        const contextParts = [USAGE_RULES];
        if (conversationId) {
            contextParts.push(`\nYour conversation ID: ${conversationId}`);
            contextParts.push(`When calling interactive_feedback, pass conversation_id="${conversationId}" (exact value, do not modify).`);
        }

        // Check for pending
        const pending = getPending(conversationId);
        if (hasPendingContent(pending)) {
            const combined = (pending.comments || []).join('\n\n');
            const imgCount = (pending.images || []).length;
            consumePending(conversationId);
            const parts = [];
            if (combined) parts.push(combined);
            if (imgCount > 0) parts.push(`[${imgCount} image(s) attached — will be delivered via interactive_feedback]`);
            contextParts.push(`\n[Pending User Message]\n${parts.join('\n')}`);
        }

        output({
            continue: true,
            env: envOutput,
            additional_context: contextParts.join('\n'),
        });
        return;
    }

    // ─── stop ─────────────────────────────────────────
    if (hook === 'stop') {
        if (loopCount >= STOP_LOOP_LIMIT) {
            log(`  stop: loop limit reached (${loopCount}), noop`);
            output({});
            return;
        }

        const pending = getPending(conversationId);
        log(`  stop: pending=${hasPendingContent(pending)}`);
        if (hasPendingContent(pending)) {
            const combined = (pending.comments || []).join('\n\n') || '(image pending)';
            consumePending(conversationId);
            output({ followup_message: fmtAgent(combined) });
        } else {
            output({ followup_message: FOLLOW_INSTRUCTIONS });
        }
        return;
    }

    // ─── preToolUse ───────────────────────────────────
    // Never consume: Cursor ignores preToolUse deny for Shell/MCP tools,
    // so pending must survive for beforeShellExecution/beforeMCPExecution.
    if (hook === 'preToolUse') {
        const toolName = input.tool_name || '';
        const pending = getPending(conversationId);
        log(`  preToolUse: tool=${toolName} pending=${hasPendingContent(pending)} allowlisted=${isAllowlisted(toolName)}`);

        if (hasPendingContent(pending) && !isAllowlisted(toolName)) {
            const combined = (pending.comments || []).join('\n\n') || '(image pending)';
            output({ decision: 'deny', reason: fmtAgent(combined) });
            return;
        }

        output({ decision: 'allow' });
        return;
    }

    // ─── beforeShellExecution ─────────────────────────
    // Uses permission + user_message + agent_message. Consumes pending.
    if (hook === 'beforeShellExecution') {
        const pending = getPending(conversationId);
        log(`  beforeShell: pending=${hasPendingContent(pending)}`);
        if (hasPendingContent(pending)) {
            const combined = (pending.comments || []).join('\n\n') || '(image pending)';
            consumePending(conversationId);
            output({
                permission: 'deny',
                user_message: fmtUser(combined),
                agent_message: fmtAgent(combined),
            });
            return;
        }
        output({});
        return;
    }

    if (hook === 'beforeMCPExecution') {
        const mcpTool = input.tool_name || input.mcp_tool_name || '';
        const pending = getPending(conversationId);
        log(`  beforeMCP: tool=${mcpTool} pending=${hasPendingContent(pending)}`);
        if (hasPendingContent(pending)) {
            const combined = (pending.comments || []).join('\n\n') || '(image pending)';
            consumePending(conversationId);
            output({
                permission: 'deny',
                user_message: fmtUser(combined),
                agent_message: fmtAgent(combined),
            });
            return;
        }
        output({});
        return;
    }

    // ─── subagentStart ───────────────────────────────
    // Uses permission/user_message per official docs. Consumes pending.
    if (hook === 'subagentStart') {
        const pending = getPending(conversationId);
        log(`  subagentStart: pending=${hasPendingContent(pending)}`);
        if (hasPendingContent(pending)) {
            const combined = (pending.comments || []).join('\n\n') || '(image pending)';
            consumePending(conversationId);
            output({
                permission: 'deny',
                user_message: fmtUser(combined),
            });
            return;
        }
        output({});
        return;
    }

    // Default: pass through
    output({ continue: true });
}

main();
