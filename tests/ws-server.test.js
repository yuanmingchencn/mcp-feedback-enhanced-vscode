/**
 * Integration tests for the WebSocket server (wsServer.ts).
 *
 * Run with: `npm run compile && node tests/ws-server.test.js`
 * Or: `npm test` (pretest runs compile)
 *
 * HOME is overridden to a temp dir before requiring modules so fileStore
 * uses an isolated config directory for test isolation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, after, before } = require('node:test');
const assert = require('node:assert');

// Override HOME before any require of wsServer/fileStore so fileStore uses temp dir
const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-feedback-test-'));
process.env.HOME = testConfigDir;

const WebSocket = require('ws');
const { FeedbackWSServer } = require('../out/wsServer');
const { getPendingDir, readPending, readConversation, listConversations } = require('../out/fileStore');

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
        } else {
            resolve();
        }
    });
}

// ─── Test Setup ───────────────────────────────────────────

let server;
let serverPort;

async function startFreshServer() {
    if (server) {
        await server.stop();
    }
    server = new FeedbackWSServer();
    serverPort = await server.start();
    return serverPort;
}

async function stopServer() {
    if (server) {
        await server.stop();
        server = null;
    }
}

function uniqueId(prefix = 'conv') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Tests ────────────────────────────────────────────────

describe('server lifecycle', () => {
    after(async () => {
        await stopServer();
    });

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
    after(async () => {
        await stopServer();
    });

    it('sends connection_established on connect', async () => {
        await startFreshServer();
        const { ws, message: msg } = await createClientAndEstablish(serverPort);
        try {
            assert.strictEqual(msg.type, 'connection_established');
            assert.strictEqual(msg.port, serverPort);
            assert.ok(msg.version);
        } finally {
            await closeClient(ws);
        }
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
        } finally {
            await closeClient(ws);
        }
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
        } finally {
            await closeClient(ws);
        }
    });
});

describe('feedback flow', () => {
    after(async () => {
        await stopServer();
    });

    it('routes feedback_request from MCP to webview as session_updated', async () => {
        await startFreshServer();
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
        const summary = 'Test summary for feedback';

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
                conversation_id: convId,
                summary,
            }));

            const msg = await sessionUpdated;
            assert.strictEqual(msg.session_info.session_id, sessionId);
            assert.strictEqual(msg.session_info.conversation_id, convId);
            assert.strictEqual(msg.session_info.summary, summary);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('routes feedback_response from webview to MCP as feedback_result', async () => {
        await startFreshServer();
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
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

            const msg = await feedbackResult;
            assert.strictEqual(msg.session_id, sessionId);
            assert.strictEqual(msg.success, true);
            assert.ok(msg.feedback.includes(feedbackText));
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('creates conversation on first feedback_request', async () => {
        await startFreshServer();
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
        const summary = 'New conversation summary';

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
            const conv = readConversation(convId);
            assert.ok(conv);
            assert.strictEqual(conv.conversation_id, convId);
            assert.strictEqual(conv.state, 'waiting');
            assert.strictEqual(conv.messages.length, 1);
            assert.strictEqual(conv.messages[0].role, 'ai');
            assert.strictEqual(conv.messages[0].content, summary);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('adds AI message from summary', async () => {
        await startFreshServer();
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
        const summary = 'AI summary message';

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
            const conv = readConversation(convId);
            assert.ok(conv);
            const aiMsg = conv.messages.find((m) => m.role === 'ai');
            assert.ok(aiMsg);
            assert.strictEqual(aiMsg.content, summary);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('adds user message from feedback response', async () => {
        await startFreshServer();
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
        const userFeedback = 'User reply message';

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
                conversation_id: convId,
                summary: 'Summary',
            }));

            await waitForMessage(webviewWs, 'session_updated');
            webviewWs.send(JSON.stringify({
                type: 'feedback_response',
                session_id: sessionId,
                conversation_id: convId,
                feedback: userFeedback,
            }));

            await feedbackResult;
            const conv = readConversation(convId);
            assert.ok(conv);
            const userMsg = conv.messages.find((m) => m.role === 'user');
            assert.ok(userMsg);
            assert.strictEqual(userMsg.content, userFeedback);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });
});

describe('pending queue', () => {
    after(async () => {
        await stopServer();
    });

    it('writes pending file on queue-pending', async () => {
        await startFreshServer();
        const convId = uniqueId();
        const comments = ['comment one', 'comment two'];

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));

            const pendingSynced = sendAndWait(webviewWs, {
                type: 'queue-pending',
                conversation_id: convId,
                comments,
            }, 'pending_synced');

            await pendingSynced;
            const pending = readPending(convId);
            assert.ok(pending);
            assert.deepStrictEqual(pending.comments, comments);
            assert.strictEqual(pending.conversation_id, convId);
        } finally {
            await closeClient(webviewWs);
        }
    });

    it('broadcasts pending_synced to webviews', async () => {
        await startFreshServer();
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

            assert.strictEqual(msg.type, 'pending_synced');
            assert.strictEqual(msg.conversation_id, convId);
            assert.deepStrictEqual(msg.comments, comments);
        } finally {
            await closeClient(webviewWs);
        }
    });

    it('detects hook consumption and broadcasts pending_delivered', async () => {
        await startFreshServer();
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

            const pendingPath = path.join(getPendingDir(), `${convId}.json`);
            assert.ok(fs.existsSync(pendingPath));

            await new Promise((r) => setTimeout(r, 600));
            const pendingDelivered = waitForMessage(webviewWs, 'pending_delivered', 3000);
            fs.unlinkSync(pendingPath);

            const msg = await pendingDelivered;
            assert.strictEqual(msg.type, 'pending_delivered');
            assert.strictEqual(msg.conversation_id, convId);
            assert.deepStrictEqual(msg.comments, comments);
        } finally {
            await closeClient(webviewWs);
        }
    });

    it('clears pending on empty queue', async () => {
        await startFreshServer();
        const convId = uniqueId();

        const { ws: webviewWs } = await createClientAndEstablish(serverPort);
        try {
            webviewWs.send(JSON.stringify({ type: 'register', clientType: 'webview' }));

            await sendAndWait(webviewWs, {
                type: 'queue-pending',
                conversation_id: convId,
                comments: ['initial'],
            }, 'pending_synced');

            const msg = await sendAndWait(webviewWs, {
                type: 'queue-pending',
                conversation_id: convId,
                comments: [],
            }, 'pending_synced');

            assert.strictEqual(msg.type, 'pending_synced');
            assert.deepStrictEqual(msg.comments, []);
            const pending = readPending(convId);
            assert.strictEqual(pending, null);
        } finally {
            await closeClient(webviewWs);
        }
    });
});

describe('conversation management', () => {
    after(async () => {
        await stopServer();
    });

    it('returns conversations list on get_conversations', async () => {
        await startFreshServer();
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

            const msg = await sendAndWait(webviewWs, {
                type: 'get_conversations',
            }, 'conversations_list');

            assert.strictEqual(msg.type, 'conversations_list');
            assert.ok(Array.isArray(msg.conversations));
            const found = msg.conversations.find((c) => c.conversation_id === convId);
            assert.ok(found);
            assert.strictEqual(found.label, 'Summary');
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('returns conversation data on load_conversation', async () => {
        await startFreshServer();
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

            assert.strictEqual(msg.type, 'conversation_loaded');
            assert.ok(msg.conversation);
            assert.strictEqual(msg.conversation.conversation_id, convId);
            assert.strictEqual(msg.conversation.messages[0].content, summary);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });

    it('archives conversation on close_tab', async () => {
        await startFreshServer();
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

            const tabClosed = waitForMessage(webviewWs, 'tab_closed');
            webviewWs.send(JSON.stringify({
                type: 'close_tab',
                conversation_id: convId,
            }));

            const msg = await tabClosed;
            assert.strictEqual(msg.type, 'tab_closed');
            assert.strictEqual(msg.conversation_id, convId);

            const conv = readConversation(convId);
            assert.ok(conv);
            assert.strictEqual(conv.state, 'archived');

            const listMsg = await sendAndWait(webviewWs, { type: 'get_conversations' }, 'conversations_list');
            const found = listMsg.conversations.find((c) => c.conversation_id === convId);
            assert.strictEqual(found, undefined);
        } finally {
            await closeClient(mcpWs);
            await closeClient(webviewWs);
        }
    });
});

// ─── Cleanup ─────────────────────────────────────────────

after(async () => {
    try {
        fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
});
