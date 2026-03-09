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
const FOLLOW_INSTRUCTIONS = 'Please follow mcp-feedback-enhanced instructions.';

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

function getPending(conversationId, workspaceRoots) {
    // Direct match first
    if (conversationId) {
        const direct = readJSON(path.join(PENDING_DIR, `${conversationId}.json`));
        if (direct) return direct;
    }

    // Fallback: scan pending files matching workspace/server
    return findAnyPending(workspaceRoots || []);
}

function hasPendingContent(p) {
    return p && ((p.comments && p.comments.length > 0) || (p.images && p.images.length > 0));
}

function findAnyPending(workspaceRoots) {
    try {
        if (!fs.existsSync(PENDING_DIR)) return null;
        const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
        const serverPid = findServerPid(workspaceRoots);
        for (const f of files) {
            const p = readJSON(path.join(PENDING_DIR, f));
            if (!hasPendingContent(p)) continue;
            if (serverPid && p.server_pid === serverPid) return p;
        }
        for (const f of files) {
            const p = readJSON(path.join(PENDING_DIR, f));
            if (hasPendingContent(p)) return p;
        }
    } catch {}
    return null;
}

function consumePending(conversationId) {
    if (!conversationId) return;
    // Direct match
    const filePath = path.join(PENDING_DIR, `${conversationId}.json`);
    try { if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return; } } catch {}

    // Fallback: remove first pending file with any content (text or images)
    try {
        if (!fs.existsSync(PENDING_DIR)) return;
        const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
            const p = readJSON(path.join(PENDING_DIR, f));
            if (hasPendingContent(p)) {
                try { fs.unlinkSync(path.join(PENDING_DIR, f)); } catch {}
                break;
            }
        }
    } catch {}
}

// ─── Server Matching ──────────────────────────────────────

function findServerPid(workspaceRoots) {
    try {
        if (!fs.existsSync(SERVERS_DIR)) return null;
        const files = fs.readdirSync(SERVERS_DIR).filter(f => f.endsWith('.json'));
        const servers = [];

        for (const f of files) {
            const s = readJSON(path.join(SERVERS_DIR, f));
            if (!s || !s.pid) continue;
            // Check if process is alive
            try { process.kill(s.pid, 0); } catch { continue; }
            servers.push(s);
        }

        if (servers.length === 0) return null;
        if (servers.length === 1) return servers[0].pid;

        // Match by workspace
        const roots = (workspaceRoots || []).map(r => r.replace(/\/+$/, ''));
        for (const s of servers) {
            const sWs = (s.workspaces || []).map(w => w.replace(/\/+$/, ''));
            if (roots.some(r => sWs.includes(r))) return s.pid;
        }

        // Match by CURSOR_TRACE_ID
        const traceId = process.env.CURSOR_TRACE_ID || '';
        if (traceId) {
            for (const s of servers) {
                if (s.cursorTraceId === traceId) return s.pid;
            }
        }

        return servers[0].pid;
    } catch { return null; }
}

// ─── Main ─────────────────────────────────────────────────

function main() {
    let input;
    try {
        input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf-8'));
    } catch {
        output({ continue: true });
        return;
    }

    const hook = input.hook_event_name || '';
    const conversationId = input.conversation_id || '';
    const loopCount = input.loop_count || 0;
    const workspaceRoots = input.workspace_roots || [];

    // Debug: log all hook invocations with full input
    try {
        const logDir = path.join(CONFIG_DIR, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'hooks.log'),
            `[${new Date().toISOString()}] ${hook} input=${JSON.stringify(input)}\n`
        );
    } catch {}

    // ─── sessionStart ─────────────────────────────────
    if (hook === 'sessionStart') {
        const serverPid = findServerPid(workspaceRoots);
        const envOutput = serverPid ? { MCP_FEEDBACK_SERVER_PID: String(serverPid) } : {};

        // Register session
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
            } catch {}
        }

        // Build additional_context with conversation_id + USAGE RULES
        const contextParts = [USAGE_RULES];
        if (conversationId) {
            contextParts.push(`\nYour conversation ID: ${conversationId}`);
            contextParts.push(`When calling interactive_feedback, pass conversation_id="${conversationId}" (exact value, do not modify).`);
        }

        // Check for pending
        const pending = getPending(conversationId, workspaceRoots);
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
            output({});
            return;
        }

        const pending = getPending(conversationId, workspaceRoots);
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
    // Uses permission/user_message/agent_message per official docs.
    // Must consume pending here because when preToolUse denies,
    // beforeShellExecution/beforeMCPExecution won't fire.
    if (hook === 'preToolUse') {
        const toolName = input.tool_name || '';
        const pending = getPending(conversationId, workspaceRoots);

        if (hasPendingContent(pending) && !isAllowlisted(toolName)) {
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

    // ─── beforeShellExecution ─────────────────────────
    // Uses permission + user_message + agent_message. Consumes pending.
    if (hook === 'beforeShellExecution') {
        const pending = getPending(conversationId, workspaceRoots);
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
        const pending = getPending(conversationId, workspaceRoots);
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
        const pending = getPending(conversationId, workspaceRoots);
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
