/**
 * Unit tests for panelState.js v3 (flat model, no tabs).
 *
 * Run with: node --test tests/panelState.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PanelState } = require('../static/panelState.js');

// ── Helpers ─────────────────────────────────────────────

function hasCmd(cmds, type, pred) {
    const list = Array.isArray(cmds) ? cmds : (cmds.commands || []);
    return list.some(c => c.type === type && (!pred || pred(c)));
}

function getCmd(cmds, type, pred) {
    const list = Array.isArray(cmds) ? cmds : (cmds.commands || []);
    return list.find(c => c.type === type && (!pred || pred(c)));
}

function hasRender(cmds, target) {
    return hasCmd(cmds, 'render', c => c.targets.includes(target));
}

function getWsSend(cmds, msgType) {
    return getCmd(cmds, 'ws_send', c => c.message.type === msgType);
}

function hasDom(cmds, action) {
    return hasCmd(cmds, 'dom', c => c.action === action);
}

// ── PanelState basics ───────────────────────────────────

describe('PanelState basics', () => {
    it('starts empty', () => {
        const p = new PanelState();
        assert.strictEqual(p.messages.length, 0);
        assert.strictEqual(p.sessionQueue.length, 0);
        assert.strictEqual(p.pendingQueue.length, 0);
        assert.strictEqual(p.panelMode, 'idle');
        assert.strictEqual(p.hasWaitingSession, false);
    });

    it('getUIState for idle', () => {
        const p = new PanelState();
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, true);
        assert.strictEqual(ui.isIdle, true);
        assert.strictEqual(ui.buttonMode, 'queue');
    });

    it('getUIState for waiting', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, true);
        assert.strictEqual(ui.buttonMode, 'send');
        assert.strictEqual(ui.isWaiting, true);
    });

    it('getUIState for running', () => {
        const p = new PanelState();
        p.messages.push({ role: 'user', content: 'sent', timestamp: '' });
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, true);
        assert.strictEqual(ui.buttonMode, 'queue');
        assert.strictEqual(ui.isRunning, true);
    });
});

// ── State transitions via messages ──────────────────────

describe('state transitions', () => {
    it('idle -> waiting via session_updated', () => {
        const p = new PanelState();
        p.handleMessage({
            type: 'session_updated',
            summary: 'Hi',
        });
        assert.strictEqual(p.panelMode, 'waiting');
        assert.strictEqual(p.hasWaitingSession, true);
        assert.strictEqual(p.sessionQueue[0].summary, 'Hi');
    });

    it('waiting -> running via feedback_submitted', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        p.handleMessage({
            type: 'feedback_submitted',
            feedback: 'ok',
        });
        assert.strictEqual(p.sessionQueue.length, 0);
    });

    it('running -> waiting via new session_updated', () => {
        const p = new PanelState();
        p.messages.push({ role: 'user', content: 'sent', timestamp: '' });
        assert.strictEqual(p.panelMode, 'running');
        p.handleMessage({
            type: 'session_updated',
            summary: 'Next',
        });
        assert.strictEqual(p.panelMode, 'waiting');
        assert.strictEqual(p.sessionQueue[0].summary, 'Next');
    });

    it('full lifecycle: idle -> waiting -> running -> waiting -> idle', () => {
        const p = new PanelState();
        assert.strictEqual(p.panelMode, 'idle');

        p.handleMessage({ type: 'session_updated', summary: 'First' });
        assert.strictEqual(p.panelMode, 'waiting');

        p.submitFeedback('reply1', []);
        assert.strictEqual(p.panelMode, 'running');

        p.handleMessage({ type: 'session_updated', summary: 'Second' });
        assert.strictEqual(p.panelMode, 'waiting');

        p.submitFeedback('reply2', []);
        assert.strictEqual(p.panelMode, 'running');
    });
});

// ── smartSend / submitFeedback / addToPending ───────────

describe('smartSend', () => {
    it('submits feedback when waiting', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        const cmds = p.smartSend('ok', []);
        const ws = getWsSend(cmds, 'feedback_response');
        assert.ok(ws);
        assert.strictEqual(ws.message.feedback, 'ok');
    });

    it('queues pending when running', () => {
        const p = new PanelState();
        p.messages.push({ role: 'user', content: 'sent', timestamp: '' });
        const cmds = p.smartSend('queued', []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.ok(ws);
        assert.deepStrictEqual(p.pendingQueue, ['queued']);
    });

    it('queues pending when idle', () => {
        const p = new PanelState();
        const cmds = p.smartSend('hi', []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.ok(ws);
    });

    it('returns empty for empty text and no images', () => {
        const p = new PanelState();
        const cmds = p.smartSend('', []);
        assert.deepStrictEqual(cmds, []);
    });
});

describe('submitFeedback', () => {
    it('sends feedback_response with images', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        const cmds = p.submitFeedback('ok', ['img1']);
        const ws = getWsSend(cmds, 'feedback_response');
        assert.deepStrictEqual(ws.message.images, ['img1']);
        assert.ok(hasDom(cmds, 'clear_input'));
        assert.ok(hasDom(cmds, 'clear_staged_images'));
    });

    it('transitions and clears sessionQueue', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        p.submitFeedback('ok', []);
        assert.strictEqual(p.sessionQueue.length, 0);
    });

    it('adds user message', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        p.submitFeedback('my feedback', []);
        const userMsg = p.messages.find(m => m.role === 'user');
        assert.ok(userMsg);
        assert.strictEqual(userMsg.content, 'my feedback');
    });

    it('returns empty if sessionQueue is empty', () => {
        const p = new PanelState();
        const cmds = p.submitFeedback('ok', []);
        assert.deepStrictEqual(cmds, []);
    });

    it('clears staged images after submit', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        p.stagedImages = ['img1'];
        p.submitFeedback('ok', []);
        assert.deepStrictEqual(p.stagedImages, []);
    });
});

describe('addToPending', () => {
    it('appends text to queue', () => {
        const p = new PanelState();
        p.addToPending('first', []);
        p.addToPending('second', []);
        assert.deepStrictEqual(p.pendingQueue, ['first', 'second']);
    });

    it('appends images to pendingImages', () => {
        const p = new PanelState();
        p.addToPending('', ['img1']);
        p.addToPending('', ['img2']);
        assert.deepStrictEqual(p.pendingImages, ['img1', 'img2']);
    });

    it('sends ws message with full queue', () => {
        const p = new PanelState();
        p.addToPending('first', []);
        const cmds = p.addToPending('second', []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, ['first', 'second']);
    });

    it('clears input after adding', () => {
        const p = new PanelState();
        const cmds = p.addToPending('text', []);
        assert.ok(hasDom(cmds, 'clear_input'));
        assert.ok(hasDom(cmds, 'clear_staged_images'));
    });

    it('clears staged images after adding to pending', () => {
        const p = new PanelState();
        p.stagedImages = ['img1'];
        p.addToPending('text', ['img1']);
        assert.deepStrictEqual(p.stagedImages, []);
    });
});

// ── Pending queue management ────────────────────────────

describe('pending queue', () => {
    it('editPending removes item and sets input', () => {
        const p = new PanelState();
        p.addToPending('hello', []);
        const cmds = p.editPending(0);
        assert.strictEqual(p.pendingQueue.length, 0);
        const setInput = getCmd(cmds, 'dom', c => c.action === 'set_input');
        assert.ok(setInput);
        assert.strictEqual(setInput.value, 'hello');
        assert.ok(hasDom(cmds, 'focus_input'));
    });

    it('removePending removes item without setting input', () => {
        const p = new PanelState();
        p.addToPending('a', []);
        p.addToPending('b', []);
        const cmds = p.removePending(0);
        assert.deepStrictEqual(p.pendingQueue, ['b']);
        assert.ok(!hasDom(cmds, 'set_input'));
    });

    it('clearPending empties queue and sends ws message', () => {
        const p = new PanelState();
        p.addToPending('a', ['img']);
        const cmds = p.clearPending();
        assert.strictEqual(p.pendingQueue.length, 0);
        assert.strictEqual(p.pendingImages.length, 0);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, []);
        assert.deepStrictEqual(ws.message.images, []);
    });

    it('clearPendingImages clears only images and syncs to server', () => {
        const p = new PanelState();
        p.addToPending('text', ['img1', 'img2']);
        const cmds = p.clearPendingImages();
        assert.strictEqual(p.pendingImages.length, 0);
        assert.deepStrictEqual(p.pendingQueue, ['text']);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, ['text']);
        assert.deepStrictEqual(ws.message.images, []);
    });

    it('pending_delivered clears queue and adds messages', () => {
        const p = new PanelState();
        p.pendingQueue = ['queued'];
        p.handleMessage({
            type: 'pending_delivered',
            comments: ['delivered'],
            images: [],
        });
        assert.strictEqual(p.pendingQueue.length, 0);
        assert.ok(p.messages.some(m => m.content === 'delivered' && m.pending_delivered));
    });

    it('pending_synced updates queue', () => {
        const p = new PanelState();
        p.handleMessage({
            type: 'pending_synced',
            comments: ['synced'],
            images: ['img'],
        });
        assert.deepStrictEqual(p.pendingQueue, ['synced']);
        assert.deepStrictEqual(p.pendingImages, ['img']);
    });
});

// ── Staged images ──────────────────────────────────────

describe('staged images', () => {
    it('stageImage adds to array', () => {
        const p = new PanelState();
        p.stageImage('img1');
        assert.deepStrictEqual(p.stagedImages, ['img1']);
    });

    it('unstageImage removes by index', () => {
        const p = new PanelState();
        p.stageImage('a');
        p.stageImage('b');
        p.unstageImage(0);
        assert.deepStrictEqual(p.stagedImages, ['b']);
    });

    it('clearStagedImages empties', () => {
        const p = new PanelState();
        p.stageImage('a');
        p.clearStagedImages();
        assert.deepStrictEqual(p.stagedImages, []);
    });

    it('getStagedImages returns current images', () => {
        const p = new PanelState();
        p.stageImage('x');
        assert.deepStrictEqual(p.getStagedImages(), ['x']);
    });
});

// ── Auto-submit on session_updated with pending ─────────

describe('auto-submit', () => {
    it('returns autoSubmit when pending queue exists', () => {
        const p = new PanelState();
        p.pendingQueue = ['hello'];
        p.pendingImages = [];
        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Hi',
        });
        assert.ok(result.autoSubmit);
        assert.strictEqual(result.autoSubmit.text, 'hello');
        assert.strictEqual(p.pendingQueue.length, 0);
    });

    it('returns autoSubmit with images', () => {
        const p = new PanelState();
        p.pendingQueue = [];
        p.pendingImages = ['img1'];
        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Hi',
        });
        assert.ok(result.autoSubmit);
        assert.strictEqual(result.autoSubmit.text, '(image)');
        assert.deepStrictEqual(result.autoSubmit.images, ['img1']);
    });

    it('returns autoReply when enabled and no pending', () => {
        const p = new PanelState();
        p.autoReply = true;
        p.autoReplyText = 'Continue';
        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Hi',
        });
        assert.ok(result.autoReply);
        assert.strictEqual(result.autoReply.text, 'Continue');
        assert.strictEqual(result.autoReply.delay, 500);
    });
});

// ── state_sync ──────────────────────────────────────────

describe('state_sync', () => {
    it('populates messages and pending', () => {
        const p = new PanelState();
        p.handleMessage({
            type: 'state_sync',
            messages: [{ role: 'ai', content: 'hello', timestamp: '2025-01-01T00:00:00Z' }],
            pending_comments: ['queued'],
            pending_images: [],
            feedback_queue_size: 1,
        });
        assert.strictEqual(p.messages.length, 1);
        assert.strictEqual(p.messages[0].content, 'hello');
        assert.deepStrictEqual(p.pendingQueue, ['queued']);
        assert.strictEqual(p.sessionQueue.length, 1);
        assert.deepStrictEqual(p.sessionQueue[0], { summary: '' });
    });
});

// ── Serialization ───────────────────────────────────────

describe('serialization', () => {
    it('round-trip preserves state', () => {
        const p = new PanelState();
        p.messages = [{ role: 'ai', content: 'hi', timestamp: '' }];
        p.sessionQueue = [{ summary: '' }];
        p.pendingQueue = ['pending'];
        p.stagedImages = ['img'];

        const data = p.serialize();
        const p2 = new PanelState();
        p2.deserialize(data);

        assert.strictEqual(p2.messages.length, 1);
        assert.strictEqual(p2.sessionQueue.length, 1);
        assert.deepStrictEqual(p2.pendingQueue, ['pending']);
        assert.deepStrictEqual(p2.stagedImages, ['img']);
    });

    it('limits messages to 500', () => {
        const p = new PanelState();
        for (let i = 0; i < 600; i++) {
            p.messages.push({ role: 'user', content: `msg${i}`, timestamp: '' });
        }
        const data = p.serialize();
        assert.strictEqual(data.messages.length, 500);
    });

    it('deserialize with null is safe', () => {
        const p = new PanelState();
        p.messages = [{ role: 'ai', content: 'keep', timestamp: '' }];
        p.deserialize(null);
        assert.strictEqual(p.messages.length, 1);
    });
});

// ── setAutoReply ────────────────────────────────────────

describe('setAutoReply', () => {
    it('sets auto-reply flags', () => {
        const p = new PanelState();
        p.setAutoReply(true, 'Go');
        assert.strictEqual(p.autoReply, true);
        assert.strictEqual(p.autoReplyText, 'Go');
    });

    it('returns save_state command', () => {
        const p = new PanelState();
        const cmds = p.setAutoReply(true);
        assert.ok(hasDom(cmds, 'save_state'));
    });
});

// ── connection_established ──────────────────────────────

describe('connection_established', () => {
    it('sends get_state on connection', () => {
        const p = new PanelState();
        const cmds = p.handleMessage({ type: 'connection_established', version: '2.1.0' });
        const ws = getWsSend(cmds, 'get_state');
        assert.ok(ws);
    });
});

// ── Multiple concurrent feedback requests ───────────────

describe('multiple feedback queue (FIFO)', () => {
    it('queues multiple session_updated and responds in order', () => {
        const p = new PanelState();
        p.handleMessage({ type: 'session_updated', summary: 'First' });
        p.handleMessage({ type: 'session_updated', summary: 'Second' });
        p.handleMessage({ type: 'session_updated', summary: 'Third' });

        assert.strictEqual(p.sessionQueue.length, 3);
        assert.strictEqual(p.sessionQueue[0].summary, 'First');
        assert.strictEqual(p.hasWaitingSession, true);

        const cmds1 = p.submitFeedback('reply1', []);
        const ws1 = getWsSend(cmds1, 'feedback_response');
        assert.strictEqual(ws1.message.feedback, 'reply1');
        assert.strictEqual(p.sessionQueue.length, 2);
        assert.strictEqual(p.sessionQueue[0].summary, 'Second');

        const cmds2 = p.submitFeedback('reply2', []);
        const ws2 = getWsSend(cmds2, 'feedback_response');
        assert.strictEqual(ws2.message.feedback, 'reply2');
        assert.strictEqual(p.sessionQueue.length, 1);

        const cmds3 = p.submitFeedback('reply3', []);
        const ws3 = getWsSend(cmds3, 'feedback_response');
        assert.strictEqual(ws3.message.feedback, 'reply3');
        assert.strictEqual(p.sessionQueue.length, 0);
    });

    it('each session_updated appends a queue slot (no id-based dedup)', () => {
        const p = new PanelState();
        p.handleMessage({ type: 'session_updated', summary: 'Hi' });
        p.handleMessage({ type: 'session_updated', summary: 'Hi again' });
        assert.strictEqual(p.sessionQueue.length, 2);
        assert.strictEqual(p.sessionQueue[0].summary, 'Hi');
        assert.strictEqual(p.sessionQueue[1].summary, 'Hi again');
    });

    it('feedback_submitted shifts front of session queue', () => {
        const p = new PanelState();
        p.handleMessage({ type: 'session_updated', summary: 'A' });
        p.handleMessage({ type: 'session_updated', summary: 'B' });
        p.handleMessage({ type: 'feedback_submitted', feedback: 'ok' });
        assert.strictEqual(p.sessionQueue.length, 1);
        assert.strictEqual(p.sessionQueue[0].summary, 'B');
    });

    it('getUIState reports feedbackQueueSize', () => {
        const p = new PanelState();
        p.handleMessage({ type: 'session_updated', summary: 'A' });
        p.handleMessage({ type: 'session_updated', summary: 'B' });
        const ui = p.getUIState();
        assert.strictEqual(ui.feedbackQueueSize, 2);
    });
});

// ── Pending queue CRUD scenarios ────────────────────────

describe('scenario: pending queue CRUD', () => {
    function setupWithPending() {
        const p = new PanelState();
        p.addToPending('first', []);
        p.addToPending('second', []);
        p.addToPending('third', []);
        return p;
    }

    it('append preserves order', () => {
        const p = setupWithPending();
        assert.deepStrictEqual(p.pendingQueue, ['first', 'second', 'third']);
    });

    it('edit removes item and sets input, keeps others', () => {
        const p = setupWithPending();
        const cmds = p.editPending(1);
        assert.deepStrictEqual(p.pendingQueue, ['first', 'third']);
        const setInput = getCmd(cmds, 'dom', c => c.action === 'set_input');
        assert.strictEqual(setInput.value, 'second');
    });

    it('remove single item keeps others', () => {
        const p = setupWithPending();
        const cmds = p.removePending(0);
        assert.deepStrictEqual(p.pendingQueue, ['second', 'third']);
    });

    it('clear all empties entire queue', () => {
        const p = setupWithPending();
        p.clearPending();
        assert.deepStrictEqual(p.pendingQueue, []);
    });

    it('edit out-of-range returns empty', () => {
        const p = new PanelState();
        p.addToPending('one', []);
        const cmds = p.editPending(5);
        assert.deepStrictEqual(cmds, []);
        assert.deepStrictEqual(p.pendingQueue, ['one']);
    });

    it('remove out-of-range returns empty', () => {
        const p = new PanelState();
        p.addToPending('one', []);
        const cmds = p.removePending(5);
        assert.deepStrictEqual(cmds, []);
        assert.deepStrictEqual(p.pendingQueue, ['one']);
    });

    it('ws sync message always contains full queue state', () => {
        const p = new PanelState();
        p.addToPending('a', []);
        p.addToPending('b', []);
        const cmds = p.addToPending('c', []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, ['a', 'b', 'c']);
    });
});

// ── Scenario: pending before session ────────────────────

describe('scenario: pending before session', () => {
    it('can queue pending before any session arrives', () => {
        const p = new PanelState();
        const cmds = p.addToPending('pre-queue', []);
        assert.deepStrictEqual(p.pendingQueue, ['pre-queue']);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.ok(ws);
    });

    it('queued pending auto-submits when session arrives', () => {
        const p = new PanelState();
        p.addToPending('pre-queued', []);
        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Next',
        });
        assert.ok(result.autoSubmit);
        assert.strictEqual(result.autoSubmit.text, 'pre-queued');
        assert.strictEqual(p.pendingQueue.length, 0);
    });
});

// ── Static helpers ──────────────────────────────────────

describe('static methods', () => {
    it('md escapes HTML', () => {
        assert.ok(PanelState.md('<script>').includes('&lt;'));
        assert.ok(PanelState.md('**bold**').includes('<strong>'));
    });

    it('getAtQuery extracts @query', () => {
        const r = PanelState.getAtQuery('hello @foo bar', 10);
        assert.ok(r);
        assert.strictEqual(r.query, 'foo');
    });

    it('getAtQuery returns null when no @', () => {
        assert.strictEqual(PanelState.getAtQuery('hello', 5), null);
    });
});

// ── Command type verification ───────────────────────────

describe('command types', () => {
    it('all returned items are valid command objects', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        const allCmds = p.submitFeedback('ok', ['img']);
        for (const cmd of allCmds) {
            assert.ok(cmd.type, `Command missing type: ${JSON.stringify(cmd)}`);
            assert.ok(['ws_send', 'render', 'dom', 'notify'].includes(cmd.type),
                `Unknown command type: ${cmd.type}`);
        }
    });
});
