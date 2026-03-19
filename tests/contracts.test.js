/**
 * Boundary contract tests that validate messages between component pairs
 * match the Zod schemas. Integration tests start a real WS server, send real
 * messages, and validate responses against schemas.
 *
 * Run with: `npm run compile && node tests/contracts.test.js`
 * Or: `npm test` (pretest runs compile)
 *
 * HOME is overridden to a temp dir before requiring modules so fileStore
 * uses an isolated config directory for test isolation.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
process.env.HOME = tmpHome;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

// Import schemas from compiled output
const schemas = require('../out/messageSchemas');

// Import WS server and fileStore from compiled output
const { FeedbackWSServer } = require('../out/wsServer');
const {
    readConversation,
    writeSession,
    deleteSession,
    writeConversation,
} = require('../out/fileStore');
const http = require('http');

// ─── WebSocket Client Helpers ─────────────────────────────

function createClient(port) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

/** Create client and wait for connection_established (server sends it immediately on connect). */
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
        if (ws.readyState === WebSocket.OPEN) {
            ws.once('close', resolve);
            ws.close();
        } else {
            resolve();
        }
    });
}

function uniqueId(prefix = 'conv') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch {
                    resolve({ status: res.statusCode, data: null });
                }
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
        serverPort = await server.start();
    });

    after(async () => {
        if (server) {
            await server.stop();
        }
    });

    it('session_updated matches SessionUpdatedOutSchema', async () => {
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
        const summary = 'Test summary for feedback';

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
                conversation_id: convId,
                summary,
            }));

            const msg = await sessionUpdatedPromise;
            schemas.SessionUpdatedOutSchema.parse(msg);
            assert.ok(msg.session_info.label, 'label must be non-empty string');
            assert.strictEqual(typeof msg.session_info.label, 'string');
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('conversations_list matches ConversationsListOutSchema', async () => {
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const { ws: mcpWs } = await createClientAndEstablish(serverPort);
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            mcpWs.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await yieldToEventLoop();

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));
            await waitForMessage(webviewWs, 'session_updated');

            const msg = await sendAndWait(webviewWs, { type: 'get_conversations' }, 'conversations_list');
            schemas.ConversationsListOutSchema.parse(msg);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('conversation_loaded matches ConversationLoadedOutSchema', async () => {
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
        const summary = 'Load test summary';

        const { ws: mcpWs } = await createClientAndEstablish(serverPort);
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            mcpWs.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await yieldToEventLoop();

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary,
            }));
            await waitForMessage(webviewWs, 'session_updated');

            const msg = await sendAndWait(webviewWs, {
                type: 'load_conversation',
                conversation_id: convId,
            }, 'conversation_loaded');
            schemas.ConversationLoadedOutSchema.parse(msg);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('feedback_submitted matches FeedbackSubmittedOutSchema', async () => {
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
        const feedbackText = 'User feedback text';

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
                conversation_id: convId,
                summary: 'Summary',
            }));

            await waitForMessage(webviewWs, 'session_updated');
            webviewWs.send(JSON.stringify({
                type: 'feedback_response',
                session_id: sessionId,
                conversation_id: convId,
                feedback: feedbackText,
            }));

            const msg = await feedbackSubmittedPromise;
            schemas.FeedbackSubmittedOutSchema.parse(msg);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('session_ended matches SessionEndedOutSchema', async () => {
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const { ws: mcpWs } = await createClientAndEstablish(serverPort);
        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            mcpWs.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));
            await yieldToEventLoop();

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));
            await waitForMessage(webviewWs, 'session_updated');

            const conv = readConversation(convId);
            assert.ok(conv);
            conv.server_pid = process.pid;
            writeConversation(conv);

            writeSession({
                conversation_id: convId,
                workspace_roots: [],
                model: 'test',
                server_pid: process.pid,
                started_at: Date.now(),
            });

            const sessionEndedPromise = waitForMessage(webviewWs, 'session_ended');
            deleteSession(convId);

            const msg = await sessionEndedPromise;
            schemas.SessionEndedOutSchema.parse(msg);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('pending_delivered matches PendingDeliveredOutSchema', async () => {
        const convId = uniqueId();
        const comments = ['comment for hook'];

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));

            await sendAndWait(webviewWs, {
                type: 'queue-pending',
                conversation_id: convId,
                comments,
            }, 'pending_synced');

            const pendingDeliveredPromise = waitForMessage(webviewWs, 'pending_delivered', 3000);
            await httpGet(serverPort, `/pending/${encodeURIComponent(convId)}?consume=1`);

            const msg = await pendingDeliveredPromise;
            schemas.PendingDeliveredOutSchema.parse(msg);
        } finally {
            await closeClient(webviewWs);
        }
    });

    it('pending_synced matches PendingSyncedOutSchema', async () => {
        const convId = uniqueId();
        const comments = ['synced comment'];

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));

            const msg = await sendAndWait(webviewWs, {
                type: 'queue-pending',
                conversation_id: convId,
                comments,
            }, 'pending_synced');

            schemas.PendingSyncedOutSchema.parse(msg);
        } finally {
            await closeClient(webviewWs);
        }
    });
});

// ─── Webview -> Extension contracts ───────────────────────

describe('Webview -> Extension contracts', () => {
    it('feedback_response matches FeedbackResponseSchema', () => {
        const msg = {
            type: 'feedback_response',
            session_id: 'sess-123',
            conversation_id: 'conv-456',
            feedback: 'User feedback text',
        };
        schemas.FeedbackResponseSchema.parse(msg);
    });

    it('queue-pending matches QueuePendingSchema', () => {
        const msg = {
            type: 'queue-pending',
            conversation_id: 'conv-123',
            comments: ['comment one', 'comment two'],
        };
        schemas.QueuePendingSchema.parse(msg);
    });

    it('register matches RegisterSchema', () => {
        const msg = {
            type: 'register',
            clientType: 'webview',
            projectPath: '/test/project',
        };
        schemas.RegisterSchema.parse(msg);

        const mcpMsg = {
            type: 'register',
            clientType: 'mcp-server',
        };
        schemas.RegisterSchema.parse(mcpMsg);
    });
});

// ─── MCP -> Extension contracts ────────────────────────────

describe('MCP -> Extension contracts', () => {
    it('feedback_request matches FeedbackRequestSchema', () => {
        const msg = {
            type: 'feedback_request',
            session_id: 'sess-123',
            conversation_id: 'conv-456',
            summary: 'Session summary',
        };
        schemas.FeedbackRequestSchema.parse(msg);
    });

    it('feedback_request requires conversation_id', () => {
        assert.throws(
            () => schemas.FeedbackRequestSchema.parse({
                type: 'feedback_request',
                session_id: 'sess-123',
                summary: 'Summary',
            }),
            (err) => err.name === 'ZodError'
        );
    });

    it('feedback_request requires summary', () => {
        assert.throws(
            () => schemas.FeedbackRequestSchema.parse({
                type: 'feedback_request',
                session_id: 'sess-123',
                conversation_id: 'conv-456',
            }),
            (err) => err.name === 'ZodError'
        );
    });
});

// ─── Hook output contracts ─────────────────────────────────

describe('Hook output contracts', () => {
    it('beforeShellExecution pass-through matches BeforeShellOutputSchema', () => {
        const msg = {};
        schemas.BeforeShellOutputSchema.parse(msg);
    });

    it('beforeShellExecution deny matches BeforeShellOutputSchema', () => {
        const msg = {
            permission: 'deny',
            user_message: 'User message',
            agent_message: 'Agent message',
        };
        schemas.BeforeShellOutputSchema.parse(msg);
    });
});

// ─── Schema rejection tests ────────────────────────────────

describe('Schema rejection tests', () => {
    it('session_updated without label is rejected', () => {
        assert.throws(
            () => schemas.SessionUpdatedOutSchema.parse({
                type: 'session_updated',
                session_info: {
                    session_id: 's1',
                    conversation_id: 'c1',
                    summary: 'test',
                },
            }),
            (err) => err.name === 'ZodError'
        );
    });

    it('queue-pending without conversation_id is rejected', () => {
        assert.throws(
            () => schemas.QueuePendingSchema.parse({
                type: 'queue-pending',
                comments: [],
            }),
            (err) => err.name === 'ZodError'
        );
    });
});

// ─── Cleanup ──────────────────────────────────────────────

after(async () => {
    try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
});
