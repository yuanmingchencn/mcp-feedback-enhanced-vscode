const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOOK_SCRIPT = path.join(__dirname, '..', 'scripts', 'hooks', 'check-pending.js');

function runHook(input, homeDir, extraEnv = {}) {
    const result = execFileSync('node', [HOOK_SCRIPT], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        env: { ...process.env, HOME: homeDir, ...extraEnv },
        timeout: 5000,
    });
    return JSON.parse(result);
}

function setupConfigDirs(homeDir) {
    const configDir = path.join(homeDir, '.config', 'mcp-feedback-enhanced');
    const dirs = ['sessions', 'pending', 'servers', 'logs', 'conversations'];
    for (const d of dirs) {
        fs.mkdirSync(path.join(configDir, d), { recursive: true });
    }
    return configDir;
}

function writePending(configDir, convId, comments, images) {
    fs.writeFileSync(
        path.join(configDir, 'pending', `${convId}.json`),
        JSON.stringify({ conversation_id: convId, server_pid: 1, comments: comments || [], images: images || [], timestamp: Date.now() })
    );
}

function writeServer(configDir, pid, workspaces, cursorTraceId) {
    fs.writeFileSync(
        path.join(configDir, 'servers', `${pid}.json`),
        JSON.stringify({ port: 48200, pid, workspaces: workspaces || [], cursorTraceId: cursorTraceId || '', version: '2.0.0' })
    );
}

function pendingExists(configDir, convId) {
    return fs.existsSync(path.join(configDir, 'pending', `${convId}.json`));
}

function sessionExists(configDir, convId) {
    return fs.existsSync(path.join(configDir, 'sessions', `${convId}.json`));
}

function spawnAliveProcess() {
    const child = spawn('node', ['-e', 'setInterval(()=>{},1e9)'], { detached: true, stdio: 'ignore' });
    child.unref();
    return child.pid;
}

describe('sessionStart', () => {
    let tempDir;
    let configDir;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        for (const d of ['sessions', 'pending']) {
            const dir = path.join(configDir, d);
            if (fs.existsSync(dir)) {
                for (const f of fs.readdirSync(dir)) {
                    fs.unlinkSync(path.join(dir, f));
                }
            }
        }
    });

    it('returns continue with additional_context containing usage rules', () => {
        const result = runHook({ hook_event_name: 'sessionStart' }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.ok(result.additional_context);
        assert.ok(result.additional_context.includes('[MCP Feedback Enhanced] USAGE RULES:'));
        assert.ok(result.additional_context.includes('interactive_feedback'));
    });

    it('injects conversation_id instruction when provided', () => {
        const result = runHook({ hook_event_name: 'sessionStart', conversation_id: 'conv-123' }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.ok(result.additional_context.includes('Your conversation ID: conv-123'));
        assert.ok(result.additional_context.includes('conversation_id="conv-123"'));
    });

    it('writes session file when server is found', () => {
        writeServer(configDir, process.pid, [path.resolve('/workspace')]);
        const result = runHook({
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-session',
            workspace_roots: [path.resolve('/workspace')],
        }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.ok(sessionExists(configDir, 'conv-session'));
    });

    it('includes env.MCP_FEEDBACK_SERVER_PID when server is found', () => {
        writeServer(configDir, process.pid, [path.resolve('/workspace')]);
        const result = runHook({
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-env',
            workspace_roots: [path.resolve('/workspace')],
        }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.strictEqual(result.env.MCP_FEEDBACK_SERVER_PID, String(process.pid));
    });

    it('delivers pending content in additional_context', () => {
        writePending(configDir, 'conv-pending', ['User says hello'], []);
        const result = runHook({ hook_event_name: 'sessionStart', conversation_id: 'conv-pending' }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.ok(result.additional_context.includes('User says hello'));
        assert.ok(result.additional_context.includes('[Pending User Message]'));
    });

    it('consumes pending file after delivery', () => {
        writePending(configDir, 'conv-consume', ['Feedback here'], []);
        runHook({ hook_event_name: 'sessionStart', conversation_id: 'conv-consume' }, tempDir);
        assert.strictEqual(pendingExists(configDir, 'conv-consume'), false);
    });
});

describe('stop', () => {
    let tempDir;
    let configDir;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns followup_message with FOLLOW_INSTRUCTIONS when no pending', () => {
        const result = runHook({ hook_event_name: 'stop', conversation_id: 'conv-none' }, tempDir);
        assert.ok(result.followup_message);
        assert.ok(result.followup_message.includes('interactive_feedback'));
        assert.ok(result.followup_message.includes('check in with the user'));
    });

    it('returns followup_message with pending content when pending exists', () => {
        writePending(configDir, 'conv-stop', ['Please fix this'], []);
        const result = runHook({ hook_event_name: 'stop', conversation_id: 'conv-stop' }, tempDir);
        assert.ok(result.followup_message);
        assert.ok(result.followup_message.includes('[User Feedback]'));
        assert.ok(result.followup_message.includes('Please fix this'));
    });

    it('returns empty object when loop_count >= 3', () => {
        const result = runHook({ hook_event_name: 'stop', conversation_id: 'conv-loop', loop_count: 3 }, tempDir);
        assert.deepStrictEqual(result, {});
    });

    it('consumes pending after delivery', () => {
        writePending(configDir, 'conv-stop-consume', ['Stop feedback'], []);
        runHook({ hook_event_name: 'stop', conversation_id: 'conv-stop-consume' }, tempDir);
        assert.strictEqual(pendingExists(configDir, 'conv-stop-consume'), false);
    });
});

describe('preToolUse', () => {
    let tempDir;
    let configDir;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns decision:allow when no pending', () => {
        const result = runHook({
            hook_event_name: 'preToolUse',
            conversation_id: 'conv-allow',
            tool_name: 'run_terminal_cmd',
        }, tempDir);
        assert.strictEqual(result.decision, 'allow');
    });

    it('returns decision:deny with reason when pending exists', () => {
        writePending(configDir, 'conv-deny', ['Stop using tools'], []);
        const result = runHook({
            hook_event_name: 'preToolUse',
            conversation_id: 'conv-deny',
            tool_name: 'run_terminal_cmd',
        }, tempDir);
        assert.strictEqual(result.decision, 'deny');
        assert.ok(result.reason);
        assert.ok(result.reason.includes('Stop using tools'));
    });

    it('does NOT consume pending file', () => {
        writePending(configDir, 'conv-no-consume', ['Do not consume'], []);
        runHook({
            hook_event_name: 'preToolUse',
            conversation_id: 'conv-no-consume',
            tool_name: 'run_terminal_cmd',
        }, tempDir);
        assert.strictEqual(pendingExists(configDir, 'conv-no-consume'), true);
    });

    it('allows allowlisted tools even with pending', () => {
        writePending(configDir, 'conv-allowlist', ['Some feedback'], []);
        const result = runHook({
            hook_event_name: 'preToolUse',
            conversation_id: 'conv-allowlist',
            tool_name: 'get_system_info',
        }, tempDir);
        assert.strictEqual(result.decision, 'allow');
    });

    it('allows interactive_feedback tool', () => {
        writePending(configDir, 'conv-if', ['Feedback'], []);
        const result = runHook({
            hook_event_name: 'preToolUse',
            conversation_id: 'conv-if',
            tool_name: 'interactive_feedback',
        }, tempDir);
        assert.strictEqual(result.decision, 'allow');
    });
});

describe('beforeShellExecution', () => {
    let tempDir;
    let configDir;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('passes through when no pending', () => {
        const result = runHook({ hook_event_name: 'beforeShellExecution', conversation_id: 'conv-none' }, tempDir);
        assert.deepStrictEqual(result, {});
    });

    it('denies with permission/user_message/agent_message when pending', () => {
        writePending(configDir, 'conv-shell', ['No shell please'], []);
        const result = runHook({ hook_event_name: 'beforeShellExecution', conversation_id: 'conv-shell' }, tempDir);
        assert.strictEqual(result.permission, 'deny');
        assert.ok(result.user_message);
        assert.ok(result.user_message.includes('No shell please'));
        assert.ok(result.agent_message);
        assert.ok(result.agent_message.includes('[User Feedback]'));
    });

    it('consumes pending file after deny', () => {
        writePending(configDir, 'conv-shell-consume', ['Shell feedback'], []);
        runHook({ hook_event_name: 'beforeShellExecution', conversation_id: 'conv-shell-consume' }, tempDir);
        assert.strictEqual(pendingExists(configDir, 'conv-shell-consume'), false);
    });
});

describe('beforeMCPExecution', () => {
    let tempDir;
    let configDir;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('passes through when no pending', () => {
        const result = runHook({ hook_event_name: 'beforeMCPExecution', conversation_id: 'conv-none' }, tempDir);
        assert.deepStrictEqual(result, {});
    });

    it('denies with permission/user_message/agent_message when pending', () => {
        writePending(configDir, 'conv-mcp', ['No MCP please'], []);
        const result = runHook({ hook_event_name: 'beforeMCPExecution', conversation_id: 'conv-mcp' }, tempDir);
        assert.strictEqual(result.permission, 'deny');
        assert.ok(result.user_message);
        assert.ok(result.user_message.includes('No MCP please'));
        assert.ok(result.agent_message);
        assert.ok(result.agent_message.includes('[User Feedback]'));
    });

    it('consumes pending file after deny', () => {
        writePending(configDir, 'conv-mcp-consume', ['MCP feedback'], []);
        runHook({ hook_event_name: 'beforeMCPExecution', conversation_id: 'conv-mcp-consume' }, tempDir);
        assert.strictEqual(pendingExists(configDir, 'conv-mcp-consume'), false);
    });
});

describe('subagentStart', () => {
    let tempDir;
    let configDir;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('passes through when no pending', () => {
        const result = runHook({ hook_event_name: 'subagentStart', conversation_id: 'conv-none' }, tempDir);
        assert.deepStrictEqual(result, {});
    });

    it('allows through even when pending (passthrough)', () => {
        writePending(configDir, 'conv-sub', ['No subagent'], []);
        const result = runHook({ hook_event_name: 'subagentStart', conversation_id: 'conv-sub' }, tempDir);
        assert.strictEqual(result.permission, undefined);
        assert.ok(pendingExists(configDir, 'conv-sub'));
    });
});

describe('server matching', () => {
    let tempDir;
    let configDir;
    let extraPid;
    let extraProcess;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
        extraProcess = spawn('node', ['-e', 'setInterval(()=>{},1e9)'], { detached: true, stdio: 'ignore' });
        extraProcess.unref();
        extraPid = extraProcess.pid;
    });

    after(() => {
        try { process.kill(extraPid, 'SIGKILL'); } catch {}
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        const serversDir = path.join(configDir, 'servers');
        if (fs.existsSync(serversDir)) {
            for (const f of fs.readdirSync(serversDir)) {
                fs.unlinkSync(path.join(serversDir, f));
            }
        }
    });

    it('matches by workspace when multiple servers exist', () => {
        const wsA = '/workspace/a';
        const wsB = '/workspace/b';
        writeServer(configDir, process.pid, [wsA]);
        writeServer(configDir, extraPid, [wsB]);
        const result = runHook({
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-ws',
            workspace_roots: [wsB],
        }, tempDir);
        assert.strictEqual(result.env.MCP_FEEDBACK_SERVER_PID, String(extraPid));
    });

    it('matches by CURSOR_TRACE_ID when no workspace match', () => {
        const traceId = 'trace-xyz-123';
        writeServer(configDir, process.pid, ['/ws/p1'], 'trace-other');
        writeServer(configDir, extraPid, ['/ws/p2'], traceId);
        const result = runHook({
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-trace',
            workspace_roots: ['/ws/other'],
        }, tempDir, { CURSOR_TRACE_ID: traceId });
        assert.strictEqual(result.env.MCP_FEEDBACK_SERVER_PID, String(extraPid));
    });

    it('falls back to first server when no match', () => {
        writeServer(configDir, process.pid, ['/ws/1']);
        writeServer(configDir, extraPid, ['/ws/2']);
        const result = runHook({
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-fallback',
            workspace_roots: ['/ws/other'],
        }, tempDir);
        assert.ok([String(process.pid), String(extraPid)].includes(result.env.MCP_FEEDBACK_SERVER_PID));
    });

    it('returns null when no servers', () => {
        const result = runHook({
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-noserver',
            workspace_roots: ['/any'],
        }, tempDir);
        assert.strictEqual(result.env.MCP_FEEDBACK_SERVER_PID, undefined);
    });
});

describe('logging', () => {
    let tempDir;
    let configDir;
    let logFile;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
        logFile = path.join(configDir, 'logs', 'hooks.log');
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('creates hooks.log with entries', () => {
        runHook({ hook_event_name: 'sessionStart', conversation_id: 'conv-log' }, tempDir);
        assert.ok(fs.existsSync(logFile));
        const content = fs.readFileSync(logFile, 'utf-8');
        assert.ok(content.includes('sessionStart'));
        assert.ok(content.includes('conv-log'));
    });
});
