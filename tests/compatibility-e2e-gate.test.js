/**
 * Phase-0 rewrite gate: black-box compatibility around pending delivery hooks.
 *
 * This test uses the real extension WS server + real hook script process:
 * 1) queue pending through WebSocket
 * 2) run consume-pending hook and assert deny payload
 * 3) run consume-pending again and assert pass-through (consumed)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const WebSocket = require('ws');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-e2e-'));
process.env.HOME = testHome;

const { FeedbackWSServer } = require('../out/wsServer');

const hookPath = path.join(__dirname, '..', 'scripts', 'hooks', 'consume-pending.js');

function createClient(port) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const onMessage = (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'connection_established') {
                ws.off('message', onMessage);
                resolve(ws);
            }
        };
        ws.on('message', onMessage);
        ws.once('error', reject);
    });
}

function waitForMessage(ws, matchType, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${matchType}`)), timeout);
        const handler = (raw) => {
            const data = JSON.parse(raw.toString());
            if (data.type === matchType) {
                clearTimeout(timer);
                ws.off('message', handler);
                resolve(data);
            }
        };
        ws.on('message', handler);
    });
}

function closeClient(ws) {
    return new Promise((resolve) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.once('close', resolve);
            ws.close();
        } else {
            resolve();
        }
    });
}

function runConsumePendingHook(workspaceRoots, toolName = 'Shell') {
    const input = JSON.stringify({
        hook_event_name: 'preToolUse',
        tool_name: toolName,
        workspace_roots: workspaceRoots,
    });

    return new Promise((resolve, reject) => {
        const child = execFile(
            'node',
            [hookPath],
            {
                env: { ...process.env, HOME: testHome },
                timeout: 5000,
            },
            (err, stdout) => {
                if (err) {
                    reject(err instanceof Error ? err : new Error('Hook execution failed'));
                    return;
                }
                try {
                    resolve(JSON.parse(stdout.toString()));
                } catch (parseErr) {
                    reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
                }
            }
        );
        child.stdin.end(input);
    });
}

describe('pending hook black-box compatibility', () => {
    let server;
    let port;
    let webview;
    const workspacePath = '/test/rewrite-phase0';

    after(async () => {
        try { await closeClient(webview); } catch { /* ignore */ }
        try { await server?.stop(); } catch { /* ignore */ }
        try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('denies once when pending exists, then allows after consume', async () => {
        server = new FeedbackWSServer();
        server.setWorkspaces([workspacePath]);
        port = await server.start();
        assert.ok(port > 0);

        webview = await createClient(port);
        webview.send(JSON.stringify({ type: 'register', clientType: 'webview' }));

        const pendingSynced = waitForMessage(webview, 'pending_synced');
        webview.send(JSON.stringify({
            type: 'queue-pending',
            comments: ['Please prioritize compatibility baseline'],
        }));
        await pendingSynced;

        let first = await runConsumePendingHook([workspacePath], 'Shell');
        if (!first.permission) {
            // Some environments resolve server registration via single-server fallback.
            first = await runConsumePendingHook([], 'Shell');
        }
        assert.strictEqual(first.permission, 'deny');
        assert.ok(
            first.agent_message.includes('Please prioritize compatibility baseline'),
            'Expected hook payload to include pending comment text'
        );

        const second = await runConsumePendingHook([workspacePath], 'Shell');
        assert.ok(!second.permission, 'Expected second invocation to pass through after consume');
    });
});
