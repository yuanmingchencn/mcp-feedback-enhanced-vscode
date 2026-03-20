/**
 * Integration tests for the WebSocket server (wsHub.ts) — flat model.
 *
 * Run with: `npm run compile && node tests/ws-server.test.js`
 *
 * HOME is overridden to a temp dir before requiring modules so fileStore
 * uses an isolated config directory for test isolation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, after } = require('node:test');
const assert = require('node:assert');

const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-feedback-test-'));
process.env.HOME = testConfigDir;

const WebSocket = require('ws');
const { FeedbackWSServer } = require('../out/wsServer');
const http = require('http');

// ─── Helpers ──────────────────────────────────────────────

function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, data: null }); }
            });
        }).on('error', reject);
    });
}

function createClientAndEstablish(port) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const handler = (raw) => {
            const data = JSON.parse(raw.toString());
            if (data.type === 'connection_established') {
                ws.off('message', handler);
                resolve({ ws, message: data });
            }
        };
        ws.on('message', handler);
        ws.once('error', reject);
    });
}

function sendAndWait(ws, msg, matchType, timeout = 5000) {
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
        ws.send(JSON.stringify(msg));
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

function yieldToEventLoop(ms = 20) {
    return new Promise((r) => setTimeout(r, ms));
}

function closeClient(ws) {
    return new Promise((resolve) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.once('close', resolve);
            ws.close();
        } else { resolve(); }
    });
}

function uniqueId(prefix = 'sess') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Test Setup ───────────────────────────────────────────

let server;
let serverPort;

async function startFreshServer() {
    if (server) await server.stop();
    server = new FeedbackWSServer();
    server.setWorkspaces(['/test/project']);
    serverPort = await server.start();
    return serverPort;
}

async function stopServer() {
    if (server) { await server.stop(); server = null; }
}

// ─── Tests ────────────────────────────────────────────────

describe('server lifecycle', () => {
    after(async () => { await stopServer(); });

    it('starts on a port in the expected range', async () => {
        await startFreshServer();
        assert.ok(serverPort >= 48200 && serverPort <= 48300, `port ${serverPort} should be in 48200-48300`);
    });

    it('stops cleanly', async () => {
        await startFreshServer();
        await stopServer();
        assert.strictEqual(server, null);
    });
});

describe('client registration', () => {
    after(async () => { await stopServer(); });

    it('sends connection_established on connect', async () => {
        await startFreshServer();
        const { ws, message: msg } = await createClientAndEstablish(serverPort);
        try {
            assert.strictEqual(msg.type, 'connection_established');
            assert.strictEqual(msg.port, serverPort);
            assert.ok(msg.version);
        } finally { await closeClient(ws); }
    });

    it('registers webview client', async () => {
        await startFreshServer();
        const { ws } = await createClientAndEstablish(serverPort);
        try {
            ws.send(JSON.stringify({ type: 'register', clientType: 'webview', projectPath: '/test' }));
            await yieldToEventLoop();
            const { webviews, mcpServers } = server.getConnectedClients();
            assert.strictEqual(webviews, 1);
            assert.strictEqual(mcpServers, 0);
        } finally { await closeClient(ws); }
    });

    it('registers mcp-server client', async () => {
        await startFreshServer();
        const { ws } = await createClientAndEstablish(serverPort);
        try {
            ws.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            await yieldToEventLoop();
            const { webviews, mcpServers } = server.getConnectedClients();
            assert.strictEqual(webviews, 0);
            assert.strictEqual(mcpServers, 1);
        } finally { await closeClient(ws); }
    });
});

describe('feedback flow', () => {
    after(async () => { await stopServer(); });

    it('routes feedback_request from MCP to webview as session_updated', async () => {
        await startFreshServer();
        const sessionId = uniqueId();
        const summary = 'Test summary';

        const { ws: mcpWs } = await createClientAndEstablish(serverPort);
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            mcpWs.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await yieldToEventLoop();

            const sessionUpdated = waitForMessage(webviewWs, 'session_updated');
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                summary,
            }));

            const msg = await sessionUpdated;
            assert.strictEqual(msg.session_info.session_id, sessionId);
            assert.strictEqual(msg.session_info.summary, summary);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('routes feedback_response from webview to MCP as feedback_result', async () => {
        await startFreshServer();
        const sessionId = uniqueId();
        const feedbackText = 'User feedback text';

        const { ws: mcpWs } = await createClientAndEstablish(serverPort);
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            mcpWs.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await yieldToEventLoop();

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result');
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                summary: 'Summary',
            }));

            await waitForMessage(webviewWs, 'session_updated');
            webviewWs.send(JSON.stringify({
                type: 'feedback_response',
                session_id: sessionId,
                feedback: feedbackText,
            }));

            const msg = await feedbackResult;
            assert.strictEqual(msg.session_id, sessionId);
            assert.strictEqual(msg.success, true);
            assert.ok(msg.feedback.includes(feedbackText));
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });
});

describe('pending queue', () => {
    after(async () => { await stopServer(); });

    it('stores pending in memory on queue-pending', async () => {
        await startFreshServer();
        const comments = ['comment one', 'comment two'];

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));

            await sendAndWait(webviewWs, {
                type: 'queue-pending',
                comments,
            }, 'pending_synced');

            const pending = await httpGet(serverPort, '/pending');
            assert.strictEqual(pending.status, 200);
            assert.deepStrictEqual(pending.data.comments, comments);
        } finally { await closeClient(webviewWs); }
    });

    it('broadcasts pending_synced to webviews', async () => {
        await startFreshServer();
        const comments = ['synced comment'];

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            const msg = await sendAndWait(webviewWs, {
                type: 'queue-pending',
                comments,
            }, 'pending_synced');

            assert.strictEqual(msg.type, 'pending_synced');
            assert.deepStrictEqual(msg.comments, comments);
        } finally { await closeClient(webviewWs); }
    });

    it('HTTP consume triggers pending_delivered broadcast', async () => {
        await startFreshServer();
        const comments = ['comment for hook'];

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await sendAndWait(webviewWs, {
                type: 'queue-pending',
                comments,
            }, 'pending_synced');

            const pendingDelivered = waitForMessage(webviewWs, 'pending_delivered', 3000);
            const consumeResult = await httpGet(serverPort, '/pending?consume=1');
            assert.strictEqual(consumeResult.status, 200);
            assert.deepStrictEqual(consumeResult.data.comments, comments);

            const msg = await pendingDelivered;
            assert.strictEqual(msg.type, 'pending_delivered');
            assert.deepStrictEqual(msg.comments, comments);
        } finally { await closeClient(webviewWs); }
    });

    it('clears pending on empty queue', async () => {
        await startFreshServer();

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await sendAndWait(webviewWs, { type: 'queue-pending', comments: ['initial'] }, 'pending_synced');
            await sendAndWait(webviewWs, { type: 'queue-pending', comments: [] }, 'pending_synced');

            const pending = await httpGet(serverPort, '/pending');
            assert.strictEqual(pending.status, 404);
        } finally { await closeClient(webviewWs); }
    });
});

describe('state sync', () => {
    after(async () => { await stopServer(); });

    it('returns state on get_state', async () => {
        await startFreshServer();
        const sessionId = uniqueId();

        const { ws: mcpWs } = await createClientAndEstablish(serverPort);
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            mcpWs.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await yieldToEventLoop();

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                summary: 'Summary for state sync',
            }));
            await waitForMessage(webviewWs, 'session_updated');

            const msg = await sendAndWait(webviewWs, { type: 'get_state' }, 'state_sync');
            assert.ok(Array.isArray(msg.messages));
            assert.ok(msg.messages.length >= 1);
            assert.strictEqual(msg.messages[0].role, 'ai');
            assert.ok(Array.isArray(msg.pending_sessions));
            assert.ok(msg.pending_sessions.includes(sessionId));
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });
});

describe('HTTP health', () => {
    after(async () => { await stopServer(); });

    it('returns health check', async () => {
        await startFreshServer();
        const result = await httpGet(serverPort, '/health');
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.data.ok, true);
        assert.strictEqual(result.data.port, serverPort);
    });
});

// ─── Cleanup ─────────────────────────────────────────────

after(async () => {
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
