const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const SESSION_HOOK = path.join(__dirname, '..', 'scripts', 'hooks', 'session-start.js');
const CONSUME_HOOK = path.join(__dirname, '..', 'scripts', 'hooks', 'consume-pending.js');
const STOP_HOOK = path.join(__dirname, '..', 'scripts', 'hooks', 'agent-stop.js');

function runHook(script, input, homeDir, extraEnv = {}) {
    const result = execFileSync('node', [script], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        env: { ...process.env, HOME: homeDir, ...extraEnv },
        timeout: 5000,
    });
    return JSON.parse(result);
}

function runHookAsync(script, input, homeDir, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile('node', [script], {
            encoding: 'utf-8',
            env: { ...process.env, HOME: homeDir, ...extraEnv },
            timeout: 5000,
        }, (err, stdout) => {
            if (err) return reject(err);
            try { resolve(JSON.parse(stdout)); }
            catch (e) { reject(new Error(`Parse error: ${e.message}, stdout: ${stdout}`)); }
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

function setupConfigDirs(homeDir) {
    const configDir = path.join(homeDir, '.config', 'mcp-feedback-enhanced');
    const dirs = ['sessions', 'servers', 'logs', 'conversations'];
    for (const d of dirs) {
        fs.mkdirSync(path.join(configDir, d), { recursive: true });
    }
    return configDir;
}

function writeServer(configDir, pid, workspaces, cursorTraceId, port) {
    fs.writeFileSync(
        path.join(configDir, 'servers', `${pid}.json`),
        JSON.stringify({ port: port || 48200, pid, workspaces: workspaces || [], cursorTraceId: cursorTraceId || '', version: '2.0.0' })
    );
}

function sessionExists(configDir, convId) {
    return fs.existsSync(path.join(configDir, 'sessions', `${convId}.json`));
}

function startMockServer(pendingData) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://127.0.0.1`);
            const pendingMatch = url.pathname.match(/^\/pending\/(.+)$/);
            res.setHeader('Content-Type', 'application/json');
            if (pendingMatch) {
                const convId = decodeURIComponent(pendingMatch[1]);
                const entry = pendingData[convId];
                const consume = url.searchParams.get('consume') === '1';
                if (entry) {
                    if (consume) delete pendingData[convId];
                    res.writeHead(200);
                    res.end(JSON.stringify(entry));
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'no_pending' }));
                }
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'not_found' }));
            }
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
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
        const dir = path.join(configDir, 'sessions');
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
    });

    it('returns continue with additional_context containing usage rules', () => {
        const result = runHook(SESSION_HOOK, { hook_event_name: 'sessionStart' }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.ok(result.additional_context);
        assert.ok(result.additional_context.includes('[MCP Feedback Enhanced] USAGE RULES:'));
        assert.ok(result.additional_context.includes('interactive_feedback'));
    });

    it('injects conversation_id instruction when provided', () => {
        const result = runHook(SESSION_HOOK, { hook_event_name: 'sessionStart', conversation_id: 'conv-123' }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.ok(result.additional_context.includes('Your conversation ID: conv-123'));
        assert.ok(result.additional_context.includes('conversation_id="conv-123"'));
    });

    it('writes session file when server is found', () => {
        writeServer(configDir, process.pid, [path.resolve('/workspace')]);
        const result = runHook(SESSION_HOOK, {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-session',
            workspace_roots: [path.resolve('/workspace')],
        }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.ok(sessionExists(configDir, 'conv-session'));
    });

    it('includes env.MCP_FEEDBACK_SERVER_PID when server is found', () => {
        writeServer(configDir, process.pid, [path.resolve('/workspace')]);
        const result = runHook(SESSION_HOOK, {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-env',
            workspace_roots: [path.resolve('/workspace')],
        }, tempDir);
        assert.strictEqual(result.continue, true);
        assert.strictEqual(result.env.MCP_FEEDBACK_SERVER_PID, String(process.pid));
    });

    it('delivers pending content via HTTP in additional_context', async () => {
        const pendingData = { 'conv-pending': { comments: ['User says hello'], images: [] } };
        const { server, port } = await startMockServer(pendingData);
        try {
            writeServer(configDir, process.pid, ['/ws'], '', port);
            const result = await runHookAsync(SESSION_HOOK, {
                hook_event_name: 'sessionStart',
                conversation_id: 'conv-pending',
                workspace_roots: ['/ws'],
            }, tempDir);
            assert.strictEqual(result.continue, true);
            assert.ok(result.additional_context.includes('User says hello'));
            assert.ok(result.additional_context.includes('[Pending User Message]'));
        } finally {
            server.close();
        }
    });

    it('consumes pending via HTTP after delivery', async () => {
        const pendingData = { 'conv-consume': { comments: ['Feedback here'], images: [] } };
        const { server, port } = await startMockServer(pendingData);
        try {
            writeServer(configDir, process.pid, ['/ws'], '', port);
            await runHookAsync(SESSION_HOOK, {
                hook_event_name: 'sessionStart',
                conversation_id: 'conv-consume',
                workspace_roots: ['/ws'],
            }, tempDir);
            assert.strictEqual(pendingData['conv-consume'], undefined);
        } finally {
            server.close();
        }
    });

    it('ignores non-sessionStart events', () => {
        const result = runHook(SESSION_HOOK, { hook_event_name: 'beforeShellExecution', conversation_id: 'conv-x' }, tempDir);
        assert.deepStrictEqual(result, { continue: true });
    });
});

describe('preToolUse (consume-pending)', () => {
    let tempDir;
    let configDir;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        configDir = setupConfigDirs(tempDir);
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('passes through when no server pid', () => {
        const result = runHook(CONSUME_HOOK, {
            hook_event_name: 'preToolUse',
            tool_name: 'Shell',
            conversation_id: 'conv-1',
        }, tempDir);
        assert.deepStrictEqual(result, {});
    });

    it('passes through for allowlisted tools', async () => {
        const pendingData = { 'conv-allow': { comments: ['msg'], images: [] } };
        const { server, port } = await startMockServer(pendingData);
        try {
            writeServer(configDir, process.pid, [], '', port);
            const result = await runHookAsync(CONSUME_HOOK, {
                hook_event_name: 'preToolUse',
                tool_name: 'interactive_feedback',
                conversation_id: 'conv-allow',
            }, tempDir, { MCP_FEEDBACK_SERVER_PID: String(process.pid) });
            assert.deepStrictEqual(result, {});
            assert.ok(pendingData['conv-allow'], 'pending should not be consumed for allowlisted tool');
        } finally {
            server.close();
        }
    });

    it('denies with user feedback when pending exists', async () => {
        const pendingData = { 'conv-deny': { comments: ['Stop using tools'], images: [] } };
        const { server, port } = await startMockServer(pendingData);
        try {
            writeServer(configDir, process.pid, [], '', port);
            const result = await runHookAsync(CONSUME_HOOK, {
                hook_event_name: 'preToolUse',
                tool_name: 'Shell',
                conversation_id: 'conv-deny',
            }, tempDir, { MCP_FEEDBACK_SERVER_PID: String(process.pid) });
            assert.strictEqual(result.permission, 'deny');
            assert.ok(result.agent_message.includes('[User Feedback]'));
            assert.ok(result.agent_message.includes('Stop using tools'));
            assert.strictEqual(pendingData['conv-deny'], undefined);
        } finally {
            server.close();
        }
    });

    it('passes through when no pending', async () => {
        const pendingData = {};
        const { server, port } = await startMockServer(pendingData);
        try {
            writeServer(configDir, process.pid, [], '', port);
            const result = await runHookAsync(CONSUME_HOOK, {
                hook_event_name: 'preToolUse',
                tool_name: 'Shell',
                conversation_id: 'conv-empty',
            }, tempDir, { MCP_FEEDBACK_SERVER_PID: String(process.pid) });
            assert.deepStrictEqual(result, {});
        } finally {
            server.close();
        }
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
        const result = runHook(SESSION_HOOK, {
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
        const result = runHook(SESSION_HOOK, {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-trace',
            workspace_roots: ['/ws/other'],
        }, tempDir, { CURSOR_TRACE_ID: traceId });
        assert.strictEqual(result.env.MCP_FEEDBACK_SERVER_PID, String(extraPid));
    });

    it('falls back to first server when no match', () => {
        writeServer(configDir, process.pid, ['/ws/1']);
        writeServer(configDir, extraPid, ['/ws/2']);
        const result = runHook(SESSION_HOOK, {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-fallback',
            workspace_roots: ['/ws/other'],
        }, tempDir);
        assert.ok([String(process.pid), String(extraPid)].includes(result.env.MCP_FEEDBACK_SERVER_PID));
    });

    it('returns null when no servers', () => {
        const result = runHook(SESSION_HOOK, {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-noserver',
            workspace_roots: ['/any'],
        }, tempDir);
        assert.strictEqual(result.env.MCP_FEEDBACK_SERVER_PID, undefined);
    });
});

describe('stop hook', () => {
    let tempDir, configDir, mockPort, mockServer;

    before((_, done) => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-stop-'));
        configDir = setupConfigDirs(tempDir);
        mockServer = http.createServer((req, res) => {
            if (req.url.includes('/pending/') && !req.url.includes('empty')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ comments: ['pending msg'] }));
            } else {
                res.writeHead(404);
                res.end('');
            }
        });
        mockServer.listen(0, () => {
            mockPort = mockServer.address().port;
            done();
        });
    });

    after((_, done) => {
        mockServer.close(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
            done();
        });
    });

    it('returns followup_message on completed status', () => {
        const result = runHook(STOP_HOOK, {
            status: 'completed',
            loop_count: 0,
        }, tempDir);
        assert.ok(result.followup_message);
        assert.ok(result.followup_message.includes('interactive_feedback'));
    });

    it('returns empty on non-completed status', () => {
        const aborted = runHook(STOP_HOOK, { status: 'aborted', loop_count: 0 }, tempDir);
        assert.deepStrictEqual(aborted, {});
        const errResult = runHook(STOP_HOOK, { status: 'error', loop_count: 0 }, tempDir);
        assert.deepStrictEqual(errResult, {});
    });

    it('mentions pending when server has pending messages', async () => {
        writeServer(configDir, process.pid, ['/ws/proj']);
        const serverFile = path.join(configDir, 'servers', process.pid + '.json');
        const data = JSON.parse(fs.readFileSync(serverFile, 'utf-8'));
        data.port = mockPort;
        fs.writeFileSync(serverFile, JSON.stringify(data));

        const result = await runHookAsync(STOP_HOOK, {
            status: 'completed',
            loop_count: 0,
            conversation_id: 'conv-with-pending',
            workspace_roots: ['/ws/proj'],
        }, tempDir, { MCP_FEEDBACK_SERVER_PID: String(process.pid) });
        assert.ok(result.followup_message.includes('pending'));
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
        runHook(SESSION_HOOK, { hook_event_name: 'sessionStart', conversation_id: 'conv-log' }, tempDir);
        assert.ok(fs.existsSync(logFile));
        const content = fs.readFileSync(logFile, 'utf-8');
        assert.ok(content.includes('sessionStart'));
        assert.ok(content.includes('conv-log'));
    });
});
