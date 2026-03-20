/**
 * Boundary contract tests — validate WS messages against Zod schemas.
 *
 * Run with: `npm run compile && node tests/contracts.test.js`
 *
 * HOME is overridden to a temp dir for test isolation.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
process.env.HOME = tmpHome;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const http = require('http');

const schemas = require('../out/messageSchemas');
const { FeedbackWSServer } = require('../out/wsServer');

// ─── Helpers ──────────────────────────────────────────────

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

function waitForMessage(ws, matchType, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${matchType}`)), timeout);
        ws.on('message', function handler(raw) {
            const data = JSON.parse(raw.toString());
            if (data.type === matchType) {
                clearTimeout(timer);
                ws.off('message', handler);
                resolve(data);
            }
        });
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

function yieldToEventLoop(ms = 20) {
    return new Promise((r) => setTimeout(r, ms));
}

function closeClient(ws) {
    return new Promise((resolve) => {
        if (ws.readyState === WebSocket.OPEN) { ws.once('close', resolve); ws.close(); }
        else { resolve(); }
    });
}

function uniqueId(prefix = 'sess') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

// ─── Extension -> Webview contracts ────────────────────────

describe('Extension -> Webview contracts', () => {
    let server;
    let serverPort;

    before(async () => {
        server = new FeedbackWSServer();
        server.setWorkspaces(['/test/project']);
        serverPort = await server.start();
    });

    after(async () => { if (server) await server.stop(); });

    it('session_updated matches SessionUpdatedOutSchema', async () => {
        const sessionId = uniqueId();
        const summary = 'Test summary';

        const { ws: mcpWs } = await createClientAndEstablish(serverPort);
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            mcpWs.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await yieldToEventLoop();

            const sessionUpdatedPromise = waitForMessage(webviewWs, 'session_updated');
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                summary,
            }));

            const msg = await sessionUpdatedPromise;
            schemas.SessionUpdatedOutSchema.parse(msg);
            assert.ok(msg.session_info.session_id, 'session_id must be present');
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('feedback_submitted matches FeedbackSubmittedOutSchema', async () => {
        const sessionId = uniqueId();

        const { ws: mcpWs } = await createClientAndEstablish(serverPort);
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            mcpWs.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await yieldToEventLoop();

            const feedbackSubmittedPromise = waitForMessage(webviewWs, 'feedback_submitted');
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                summary: 'Summary',
            }));
            await waitForMessage(webviewWs, 'session_updated');

            webviewWs.send(JSON.stringify({
                type: 'feedback_response',
                session_id: sessionId,
                feedback: 'User feedback',
            }));

            const msg = await feedbackSubmittedPromise;
            schemas.FeedbackSubmittedOutSchema.parse(msg);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('pending_delivered matches PendingDeliveredOutSchema', async () => {
        const comments = ['comment for hook'];

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await sendAndWait(webviewWs, { type: 'queue-pending', comments }, 'pending_synced');

            const pendingDeliveredPromise = waitForMessage(webviewWs, 'pending_delivered', 3000);
            await httpGet(serverPort, '/pending?consume=1');

            const msg = await pendingDeliveredPromise;
            schemas.PendingDeliveredOutSchema.parse(msg);
        } finally { await closeClient(webviewWs); }
    });

    it('pending_synced matches PendingSyncedOutSchema', async () => {
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            const msg = await sendAndWait(webviewWs, {
                type: 'queue-pending',
                comments: ['synced'],
            }, 'pending_synced');
            schemas.PendingSyncedOutSchema.parse(msg);
        } finally { await closeClient(webviewWs); }
    });
});

// ─── Webview -> Extension contracts ───────────────────────

describe('Webview -> Extension contracts', () => {
    it('feedback_response matches FeedbackResponseSchema', () => {
        schemas.FeedbackResponseSchema.parse({
            type: 'feedback_response',
            session_id: 'sess-123',
            feedback: 'User feedback text',
        });
    });

    it('queue-pending matches QueuePendingSchema', () => {
        schemas.QueuePendingSchema.parse({
            type: 'queue-pending',
            comments: ['comment one', 'comment two'],
        });
    });

    it('register matches RegisterSchema', () => {
        schemas.RegisterSchema.parse({ type: 'register', clientType: 'webview' });
        schemas.RegisterSchema.parse({ type: 'register', clientType: 'mcp-server' });
    });
});

// ─── MCP -> Extension contracts ────────────────────────────

describe('MCP -> Extension contracts', () => {
    it('feedback_request matches FeedbackRequestSchema', () => {
        schemas.FeedbackRequestSchema.parse({
            type: 'feedback_request',
            session_id: 'sess-123',
            summary: 'Session summary',
        });
    });

    it('feedback_request requires summary', () => {
        assert.throws(
            () => schemas.FeedbackRequestSchema.parse({
                type: 'feedback_request',
                session_id: 'sess-123',
            }),
            (err) => err.name === 'ZodError'
        );
    });
});

// ─── Hook output contracts ─────────────────────────────────

describe('Hook output contracts', () => {
    it('beforeShellExecution pass-through matches BeforeShellOutputSchema', () => {
        schemas.BeforeShellOutputSchema.parse({});
    });

    it('beforeShellExecution deny matches BeforeShellOutputSchema', () => {
        schemas.BeforeShellOutputSchema.parse({
            permission: 'deny',
            user_message: 'User message',
            agent_message: 'Agent message',
        });
    });
});

// ─── Schema rejection tests ────────────────────────────────

describe('Schema rejection tests', () => {
    it('session_updated without session_id is rejected', () => {
        assert.throws(
            () => schemas.SessionUpdatedOutSchema.parse({
                type: 'session_updated',
                session_info: { summary: 'test' },
            }),
            (err) => err.name === 'ZodError'
        );
    });

    it('queue-pending without comments is rejected', () => {
        assert.throws(
            () => schemas.QueuePendingSchema.parse({ type: 'queue-pending' }),
            (err) => err.name === 'ZodError'
        );
    });
});

// ─── Cleanup ──────────────────────────────────────────────

after(async () => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
