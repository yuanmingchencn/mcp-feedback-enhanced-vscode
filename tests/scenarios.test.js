/**
 * Full protocol scenario tests.
 *
 * Simulates MCP <-> WsHub <-> Webview over real WebSocket connections.
 * The webview side feeds incoming WS messages through PanelState and
 * executes ws_send commands back — exactly like panel.html does.
 *
 * Run: npm run compile && node --test tests/scenarios.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, after, before } = require('node:test');
const assert = require('node:assert');

const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-scenario-'));
process.env.HOME = testConfigDir;

const WebSocket = require('ws');
const { FeedbackWSServer } = require('../out/wsServer');
const { readConversation } = require('../out/fileStore');
const http = require('http');
const { PanelState } = require('../static/panelState');

// ── Helpers ─────────────────────────────────────────────

let idSeq = 0;
function uid(prefix = 'conv') {
    return `${prefix}-${Date.now()}-${++idSeq}`;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function httpGet(urlPort, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${urlPort}${urlPath}`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, data: null }); }
            });
        }).on('error', reject);
    });
}

// ── SimulatedMcp ────────────────────────────────────────

class SimulatedMcp {
    constructor() { this.ws = null; this._inbox = []; this._waiters = []; }

    async connect(port) {
        this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
        this.ws.on('message', (raw) => this._onMsg(JSON.parse(raw.toString())));
        await new Promise((ok, fail) => { this.ws.once('open', ok); this.ws.once('error', fail); });
        await this.waitFor('connection_established');
        this.ws.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
        await sleep(30);
    }

    _onMsg(msg) {
        const w = this._waiters.find((w) => w.match(msg));
        if (w) { this._waiters.splice(this._waiters.indexOf(w), 1); w.resolve(msg); }
        else { this._inbox.push(msg); }
    }

    send(msg) { this.ws.send(JSON.stringify(msg)); }

    waitFor(type, timeout = 5000) {
        const i = this._inbox.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(this._inbox.splice(i, 1)[0]);
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`MCP: timeout ${type}`)), timeout);
            this._waiters.push({ match: (m) => m.type === type, resolve: (m) => { clearTimeout(t); resolve(m); } });
        });
    }

    feedback(sessId, convId, summary) {
        this.send({ type: 'feedback_request', session_id: sessId, conversation_id: convId, summary });
    }

    async close() {
        if (this.ws?.readyState === WebSocket.OPEN) await new Promise((r) => { this.ws.once('close', r); this.ws.close(); });
    }
}

// ── SimulatedWebview ────────────────────────────────────

class SimulatedWebview {
    constructor() { this.ws = null; this.state = new PanelState(); this._inbox = []; this._waiters = []; this.sent = []; }

    async connect(port) {
        this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
        this.ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type !== 'connection_established') {
                const cmds = this.state.handleMessage(msg);
                this._exec(cmds);
            }
            this._deliver(msg);
        });
        await new Promise((ok, fail) => { this.ws.once('open', ok); this.ws.once('error', fail); });
        await this.waitFor('connection_established');
        this.ws.send(JSON.stringify({ type: 'register', clientType: 'webview', projectPath: '/test' }));
        await sleep(30);
    }

    _exec(result) {
        if (!result) return;
        const cmds = Array.isArray(result) ? result : result.commands;
        if (!cmds) return;

        for (const c of cmds) {
            if (c.type === 'ws_send') {
                this.sent.push(c.message);
                this.ws.send(JSON.stringify(c.message));
            }
        }

        if (result.autoSubmit) {
            const { text, images } = result.autoSubmit;
            this._exec(this.state.submitFeedback(text, images || []));
        }
        if (result.autoReply) {
            const { text } = result.autoReply;
            this._exec(this.state.submitFeedback(text, []));
        }
    }

    _deliver(msg) {
        const w = this._waiters.find((w) => w.match(msg));
        if (w) { this._waiters.splice(this._waiters.indexOf(w), 1); w.resolve(msg); }
        else { this._inbox.push(msg); }
    }

    send(msg) { this.ws.send(JSON.stringify(msg)); }

    waitFor(type, timeout = 5000) {
        const i = this._inbox.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(this._inbox.splice(i, 1)[0]);
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`WV: timeout ${type}`)), timeout);
            this._waiters.push({ match: (m) => m.type === type, resolve: (m) => { clearTimeout(t); resolve(m); } });
        });
    }

    exec(result) { this._exec(result); return result; }
    tab(id) { return this.state.tabs.get(id); }

    async close() {
        if (this.ws?.readyState === WebSocket.OPEN) await new Promise((r) => { this.ws.once('close', r); this.ws.close(); });
    }
}

// ── Server lifecycle ────────────────────────────────────

let server, port;
async function start() { server = new FeedbackWSServer(); port = await server.start(); }
async function stop() { if (server) { await server.stop(); server = null; } }

// ── Tests ───────────────────────────────────────────────

describe('scenario: full feedback round-trip', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('MCP request -> PanelState -> feedback_result', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s, c] = [uid('s'), uid()];
        mcp.feedback(s, c, 'Deploy?');
        await wv.waitFor('session_updated');

        const tab = wv.tab(c);
        assert.ok(tab);
        assert.strictEqual(tab.state, 'waiting');
        assert.strictEqual(tab.messages[0].role, 'ai');

        const rP = mcp.waitFor('feedback_result');
        wv.exec(wv.state.smartSend('Approved!', []));

        const r = await rP;
        assert.strictEqual(r.success, true);
        assert.ok(r.feedback.includes('Approved!'));
        assert.strictEqual(tab.state, 'running');
    });
});

describe('scenario: feedback with images', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('images included in feedback_result', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s, c] = [uid('s'), uid()];
        mcp.feedback(s, c, 'Screenshot?');
        await wv.waitFor('session_updated');

        const img = 'data:image/png;base64,iVBOR';
        const rP = mcp.waitFor('feedback_result');
        wv.exec(wv.state.smartSend('See image', [img]));

        const r = await rP;
        assert.ok(r.feedback.includes('See image'));
        assert.deepStrictEqual(r.images, [img]);
    });
});

describe('scenario: dismiss feedback', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('dismiss resolves MCP with dismissed text', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s, c] = [uid('s'), uid()];
        mcp.feedback(s, c, 'Waiting');
        await wv.waitFor('session_updated');

        const rP = mcp.waitFor('feedback_result');
        wv.send({ type: 'dismiss_feedback', session_id: s });
        const r = await rP;
        assert.ok(r.feedback.includes('Dismissed'));
    });
});

describe('scenario: pending after session_start', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('queue pending in running state, auto-submit on next round', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s1, c] = [uid('s'), uid()];
        mcp.feedback(s1, c, 'Round 1');
        await wv.waitFor('session_updated');

        let rP = mcp.waitFor('feedback_result');
        wv.exec(wv.state.smartSend('Reply 1', []));
        await rP;

        const tab = wv.tab(c);
        assert.strictEqual(tab.state, 'running');

        wv.exec(wv.state.addToPending('Pending A', []));
        await wv.waitFor('pending_synced');
        wv.exec(wv.state.addToPending('Pending B', []));
        await wv.waitFor('pending_synced');
        assert.deepStrictEqual(tab.pendingQueue, ['Pending A', 'Pending B']);

        const pending = await httpGet(port, `/pending/${encodeURIComponent(c)}`);
        assert.strictEqual(pending.status, 200);
        assert.deepStrictEqual(pending.data.comments, ['Pending A', 'Pending B']);

        const s2 = uid('s');
        rP = mcp.waitFor('feedback_result');
        mcp.feedback(s2, c, 'Round 2');
        await wv.waitFor('session_updated');

        // Auto-submit fires from _onSessionUpdated because pendingQueue is non-empty
        const r2 = await rP;
        assert.ok(r2.feedback.includes('Pending A'));
        assert.ok(r2.feedback.includes('Pending B'));
    });
});

describe('scenario: pending CRUD', () => {
    let mcp, wv;
    before(start);
    after(async () => { await stop(); });

    async function setup() {
        if (mcp) await mcp.close();
        if (wv) await wv.close();
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);
        const [s, c] = [uid('s'), uid()];
        mcp.feedback(s, c, 'T');
        await wv.waitFor('session_updated');
        const rP = mcp.waitFor('feedback_result');
        wv.exec(wv.state.smartSend('OK', []));
        await rP;
        return c;
    }

    it('append preserves order', async () => {
        const c = await setup();
        wv.exec(wv.state.addToPending('A', []));
        await wv.waitFor('pending_synced');
        wv.exec(wv.state.addToPending('B', []));
        await wv.waitFor('pending_synced');
        wv.exec(wv.state.addToPending('C', []));
        await wv.waitFor('pending_synced');
        assert.deepStrictEqual(wv.tab(c).pendingQueue, ['A', 'B', 'C']);
    });

    it('edit removes item and sets input draft', async () => {
        const c = await setup();
        wv.exec(wv.state.addToPending('X', []));
        await wv.waitFor('pending_synced');
        wv.exec(wv.state.addToPending('Y', []));
        await wv.waitFor('pending_synced');
        wv.exec(wv.state.addToPending('Z', []));
        await wv.waitFor('pending_synced');

        const cmds = wv.state.editPending(1);
        wv.exec(cmds);
        await wv.waitFor('pending_synced');
        assert.deepStrictEqual(wv.tab(c).pendingQueue, ['X', 'Z']);
        const si = cmds.find((c) => c.type === 'dom' && c.action === 'set_input');
        assert.strictEqual(si.value, 'Y');
    });

    it('remove single item keeps others', async () => {
        const c = await setup();
        wv.exec(wv.state.addToPending('Keep', []));
        await wv.waitFor('pending_synced');
        wv.exec(wv.state.addToPending('Del', []));
        await wv.waitFor('pending_synced');
        wv.exec(wv.state.addToPending('Keep2', []));
        await wv.waitFor('pending_synced');

        wv.exec(wv.state.removePending(1));
        await wv.waitFor('pending_synced');
        assert.deepStrictEqual(wv.tab(c).pendingQueue, ['Keep', 'Keep2']);
    });

    it('clear all empties queue and clears in-memory pending', async () => {
        const c = await setup();
        wv.exec(wv.state.addToPending('A', []));
        await wv.waitFor('pending_synced');
        wv.exec(wv.state.addToPending('B', []));
        await wv.waitFor('pending_synced');

        wv.exec(wv.state.clearPending());
        await wv.waitFor('pending_synced');

        assert.deepStrictEqual(wv.tab(c).pendingQueue, []);
        const pending = await httpGet(port, `/pending/${encodeURIComponent(c)}`);
        assert.strictEqual(pending.status, 404);
    });
});

describe('scenario: pending with images', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('staged images travel with pending to in-memory store', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s, c] = [uid('s'), uid()];
        mcp.feedback(s, c, 'T');
        await wv.waitFor('session_updated');
        const rP = mcp.waitFor('feedback_result');
        wv.exec(wv.state.smartSend('OK', []));
        await rP;

        const img = 'data:image/png;base64,ABC';
        wv.exec(wv.state.stageImage(img));
        const staged = [...wv.tab(c).stagedImages];
        wv.exec(wv.state.addToPending('With img', staged));
        await wv.waitFor('pending_synced');

        const p = await httpGet(port, `/pending/${encodeURIComponent(c)}`);
        assert.strictEqual(p.status, 200);
        assert.deepStrictEqual(p.data.comments, ['With img']);
        assert.ok(Array.isArray(p.data.images));
        assert.strictEqual(p.data.images.length, 1);
        assert.strictEqual(p.data.images[0], img);
    });
});

describe('scenario: HTTP consume delivers pending', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('HTTP consume triggers pending_delivered broadcast', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s, c] = [uid('s'), uid()];
        mcp.feedback(s, c, 'T');
        await wv.waitFor('session_updated');
        const rP = mcp.waitFor('feedback_result');
        wv.exec(wv.state.smartSend('OK', []));
        await rP;

        wv.exec(wv.state.addToPending('Hook me', []));
        await wv.waitFor('pending_synced');
        await sleep(50);

        const dP = wv.waitFor('pending_delivered', 3000);
        const consumeResult = await httpGet(port, `/pending/${encodeURIComponent(c)}?consume=1`);
        assert.strictEqual(consumeResult.status, 200);
        assert.deepStrictEqual(consumeResult.data.comments, ['Hook me']);

        const msg = await dP;
        assert.strictEqual(msg.conversation_id, c);
        assert.deepStrictEqual(msg.comments, ['Hook me']);
    });
});

describe('scenario: restart on old session', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('deserialized tab works with new feedback round', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s1, c] = [uid('s'), uid()];
        mcp.feedback(s1, c, 'R1');
        await wv.waitFor('session_updated');
        let rP = mcp.waitFor('feedback_result');
        wv.exec(wv.state.smartSend('Reply 1', []));
        await rP;

        const snap = wv.state.serialize();

        const wv2 = new SimulatedWebview();
        await wv2.connect(port);
        wv2.state.deserialize(snap);

        const tab = wv2.tab(c);
        assert.ok(tab);
        assert.strictEqual(tab.state, 'running');

        const s2 = uid('s');
        rP = mcp.waitFor('feedback_result');
        mcp.feedback(s2, c, 'R2');
        await wv2.waitFor('session_updated');
        assert.strictEqual(tab.state, 'waiting');

        wv2.exec(wv2.state.smartSend('Reply 2', []));
        const r = await rP;
        assert.ok(r.feedback.includes('Reply 2'));

        await wv2.close();
    });
});

describe('scenario: multi-round conversation', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('3 rounds on same conversation', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);
        const c = uid();

        for (let i = 1; i <= 3; i++) {
            const s = uid('s');
            const rP = mcp.waitFor('feedback_result');
            mcp.feedback(s, c, `Round ${i}`);
            await wv.waitFor('session_updated');
            wv.exec(wv.state.smartSend(`Reply ${i}`, []));
            const r = await rP;
            assert.ok(r.feedback.includes(`Reply ${i}`));
        }

        assert.strictEqual(wv.tab(c).messages.length, 6);
        assert.strictEqual(readConversation(c).messages.length, 6);
    });
});

describe('scenario: close tab', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('archives conversation and cleans pending', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s, c] = [uid('s'), uid()];
        mcp.feedback(s, c, 'Close me');
        await wv.waitFor('session_updated');
        const rP = mcp.waitFor('feedback_result');
        wv.exec(wv.state.smartSend('OK', []));
        await rP;

        wv.exec(wv.state.addToPending('Orphan', []));
        await wv.waitFor('pending_synced');
        await sleep(50);

        const closedP = wv.waitFor('tab_closed');
        wv.exec(wv.state.closeTab(c));
        await closedP;

        assert.strictEqual(readConversation(c).state, 'archived');
        const pending = await httpGet(port, `/pending/${encodeURIComponent(c)}`);
        assert.strictEqual(pending.status, 404);
    });
});

describe('scenario: get_sessions', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('returns sessions list', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const msg = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), 5000);
            const h = (raw) => {
                const d = JSON.parse(raw.toString());
                if (d.type === 'sessions_list') { clearTimeout(t); wv.ws.off('message', h); resolve(d); }
            };
            wv.ws.on('message', h);
            wv.send({ type: 'get_sessions' });
        });
        assert.ok(Array.isArray(msg.sessions));
    });
});

describe('scenario: FSM guards', () => {
    let mcp, wv;
    before(start);
    after(async () => { await mcp?.close(); await wv?.close(); await stop(); });

    it('ended tab ignores session_updated', async () => {
        mcp = new SimulatedMcp(); wv = new SimulatedWebview();
        await mcp.connect(port); await wv.connect(port);

        const [s, c] = [uid('s'), uid()];
        mcp.feedback(s, c, 'End me');
        await wv.waitFor('session_updated');

        wv.state.handleMessage({ type: 'session_ended', conversation_id: c });
        assert.strictEqual(wv.tab(c).state, 'ended');

        wv.state.handleMessage({
            type: 'session_updated',
            session_info: { session_id: uid('s'), conversation_id: c, summary: 'Ghost' },
        });
        assert.strictEqual(wv.tab(c).state, 'ended');
    });
});

// ── Cleanup ─────────────────────────────────────────────

after(async () => {
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch { /* */ }
});
