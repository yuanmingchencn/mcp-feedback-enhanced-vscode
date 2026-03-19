/**
 * Unit tests for panelState.js v2 (command-based state machine).
 *
 * Run with: node --test tests/panelState.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PanelState, TabState } = require('../static/panelState.js');

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

// ── TabState ────────────────────────────────────────────

describe('TabState', () => {
    it('creates with defaults', () => {
        const t = new TabState('c1', null, null, null);
        assert.strictEqual(t.conversationId, 'c1');
        assert.strictEqual(t.label, 'Agent');
        assert.strictEqual(t.state, 'idle');
        assert.strictEqual(t.isIdle, true);
        assert.strictEqual(t.isTerminal, false);
        assert.deepStrictEqual(t.stagedImages, []);
        assert.deepStrictEqual(t.pendingImages, []);
    });

    it('rejects invalid state', () => {
        const t = new TabState('c1', 'A', '', 'bogus');
        assert.strictEqual(t.state, 'idle');
    });

    it('transitionTo works for valid transitions', () => {
        const t = new TabState('c1', 'A', '', 'idle');
        assert.strictEqual(t.transitionTo('waiting'), true);
        assert.strictEqual(t.state, 'waiting');
    });

    it('transitionTo blocked when ended', () => {
        const t = new TabState('c1', 'A', '', 'ended');
        assert.strictEqual(t.transitionTo('waiting'), false);
        assert.strictEqual(t.state, 'ended');
    });

    it('addMessage appends with timestamp', () => {
        const t = new TabState('c1', 'A', '', 'idle');
        t.addMessage('user', 'hello');
        assert.strictEqual(t.messages.length, 1);
        assert.strictEqual(t.messages[0].role, 'user');
        assert.strictEqual(t.messages[0].content, 'hello');
        assert.ok(t.messages[0].timestamp);
    });

    it('addMessage merges extra fields', () => {
        const t = new TabState('c1', 'A', '', 'idle');
        t.addMessage('user', 'hi', { pending_delivered: true, images: ['img'] });
        assert.strictEqual(t.messages[0].pending_delivered, true);
        assert.deepStrictEqual(t.messages[0].images, ['img']);
    });

    it('clearPendingQueue clears both queue and images', () => {
        const t = new TabState('c1', 'A', '', 'idle');
        t.pendingQueue = ['a', 'b'];
        t.pendingImages = ['img1'];
        t.clearPendingQueue();
        assert.deepStrictEqual(t.pendingQueue, []);
        assert.deepStrictEqual(t.pendingImages, []);
    });
});

// ── PanelState basics ───────────────────────────────────

describe('PanelState basics', () => {
    it('starts empty', () => {
        const p = new PanelState();
        assert.strictEqual(p.tabs.size, 0);
        assert.strictEqual(p.activeTabId, null);
    });

    it('getOrCreateTab creates new tab', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'Label', 'gpt-4', 'idle');
        assert.ok(t instanceof TabState);
        assert.strictEqual(t.label, 'Label');
        assert.strictEqual(t.model, 'gpt-4');
        assert.strictEqual(p.tabs.size, 1);
    });

    it('getOrCreateTab updates existing', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Old', '', 'idle');
        const t = p.getOrCreateTab('c1', 'New', 'gpt-4', 'running');
        assert.strictEqual(t.label, 'New');
        assert.strictEqual(t.model, 'gpt-4');
        assert.strictEqual(t.state, 'running');
        assert.strictEqual(p.tabs.size, 1);
    });

    it('getOrCreateTab preserves label if new is null', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Keep', '', 'idle');
        const t = p.getOrCreateTab('c1', null, 'gpt-4', 'running');
        assert.strictEqual(t.label, 'Keep');
    });

    it('getOrCreateTab does not overwrite ended state', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'ended');
        p.getOrCreateTab('c1', 'B', '', 'waiting');
        assert.strictEqual(t.state, 'ended');
    });

    it('getUIState for idle', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, false);
        assert.strictEqual(ui.isIdle, true);
    });

    it('getUIState for waiting', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'waiting');
        p.activeTabId = 'c1';
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, true);
        assert.strictEqual(ui.buttonMode, 'send');
    });

    it('getUIState for running', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, true);
        assert.strictEqual(ui.buttonMode, 'queue');
    });

    it('getUIState for ended', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'ended');
        p.activeTabId = 'c1';
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, false);
        assert.strictEqual(ui.isEnded, true);
    });
});

// ── Tab switching ───────────────────────────────────────

describe('switchTab', () => {
    it('saves draft to previous tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c1';
        p.switchTab('c2', 'typed in c1');
        assert.strictEqual(p.tabs.get('c1').inputDraft, 'typed in c1');
    });

    it('restores draft of new tab via dom command', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle').inputDraft = 'draft A';
        p.getOrCreateTab('c2', 'B', '', 'idle').inputDraft = 'draft B';
        p.activeTabId = 'c1';
        const cmds = p.switchTab('c2', '');
        const setInput = getCmd(cmds, 'dom', c => c.action === 'set_input');
        assert.ok(setInput);
        assert.strictEqual(setInput.value, 'draft B');
    });

    it('preserves staged images per-tab across switches', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c1';
        p.stageImage('img1');
        p.switchTab('c2', '');
        p.stageImage('img2');
        p.switchTab('c1', '');
        assert.deepStrictEqual(p.tabs.get('c1').stagedImages, ['img1']);
        assert.deepStrictEqual(p.tabs.get('c2').stagedImages, ['img2']);
    });

    it('returns empty for nonexistent tab', () => {
        const p = new PanelState();
        const cmds = p.switchTab('nope', '');
        assert.deepStrictEqual(cmds, []);
    });

    it('emits render commands', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c1';
        const cmds = p.switchTab('c2', '');
        assert.ok(hasRender(cmds, 'tabs'));
        assert.ok(hasRender(cmds, 'messages'));
        assert.ok(hasDom(cmds, 'save_state'));
    });
});

// ── closeTab ────────────────────────────────────────────

describe('closeTab', () => {
    it('removes tab and sends ws message', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c2';
        const cmds = p.closeTab('c2');
        assert.strictEqual(p.tabs.size, 1);
        assert.strictEqual(p.activeTabId, 'c1');
        const ws = getWsSend(cmds, 'close_tab');
        assert.ok(ws);
        assert.strictEqual(ws.message.conversation_id, 'c2');
    });

    it('sets activeTabId to null when last tab closed', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.closeTab('c1');
        assert.strictEqual(p.activeTabId, null);
    });

    it('switches to previous tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.getOrCreateTab('c3', 'C', '', 'idle');
        p.activeTabId = 'c2';
        p.closeTab('c2');
        assert.strictEqual(p.activeTabId, 'c3');
    });
});

// ── State transitions via messages ──────────────────────

describe('state transitions', () => {
    it('idle -> waiting via session_updated', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi' },
        });
        assert.strictEqual(p.tabs.get('c1').state, 'waiting');
        assert.strictEqual(p.tabs.get('c1').pendingSessionId, 's1');
    });

    it('waiting -> running via feedback_submitted', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.sessionQueue.push({ sessionId: 's1', summary: '' });
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'feedback_submitted',
            conversation_id: 'c1',
            session_id: 's1',
            feedback: 'ok',
        });
        assert.strictEqual(t.state, 'running');
        assert.strictEqual(t.pendingSessionId, null);
    });

    it('running -> waiting via new session_updated', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's2', summary: 'Next' },
        });
        assert.strictEqual(t.state, 'waiting');
        assert.strictEqual(t.pendingSessionId, 's2');
    });

    it('running -> ended via session_ended', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.handleMessage({ type: 'session_ended', conversation_id: 'c1' });
        assert.strictEqual(t.state, 'ended');
    });

    it('waiting -> ended via session_ended', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.sessionQueue.push({ sessionId: 's1', summary: '' });
        p.activeTabId = 'c1';
        p.handleMessage({ type: 'session_ended', conversation_id: 'c1' });
        assert.strictEqual(t.state, 'ended');
        assert.strictEqual(t.pendingSessionId, null);
    });

    it('ended tab ignores session_updated (FSM guard)', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'ended');
        p.activeTabId = 'c1';
        const cmds = p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'New' },
        });
        assert.strictEqual(t.state, 'ended');
        assert.deepStrictEqual(cmds, []);
    });

    it('full lifecycle: idle -> waiting -> running -> waiting -> running -> ended', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';

        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's1', summary: 'First' } });
        assert.strictEqual(t.state, 'waiting');

        p.handleMessage({ type: 'feedback_submitted', conversation_id: 'c1', feedback: 'a' });
        assert.strictEqual(t.state, 'running');

        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's2', summary: 'Second' } });
        assert.strictEqual(t.state, 'waiting');

        p.handleMessage({ type: 'feedback_submitted', conversation_id: 'c1', feedback: 'b' });
        assert.strictEqual(t.state, 'running');

        p.handleMessage({ type: 'session_ended', conversation_id: 'c1' });
        assert.strictEqual(t.state, 'ended');
        assert.strictEqual(t.messages.filter(m => m.role === 'user').length, 2);
    });
});

// ── smartSend / submitFeedback / addToPending ───────────

describe('smartSend', () => {
    it('submits feedback when waiting', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.sessionQueue.push({ sessionId: 's1', summary: '' });
        p.activeTabId = 'c1';
        const cmds = p.smartSend('ok', []);
        const ws = getWsSend(cmds, 'feedback_response');
        assert.ok(ws);
        assert.strictEqual(ws.message.feedback, 'ok');
        assert.strictEqual(t.state, 'running');
    });

    it('queues pending when running', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        const cmds = p.smartSend('queued', []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.ok(ws);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['queued']);
    });

    it('queues pending when idle', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const cmds = p.smartSend('hi', []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.ok(ws);
    });

    it('returns empty for ended tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'ended');
        p.activeTabId = 'c1';
        const cmds = p.smartSend('hi', []);
        assert.deepStrictEqual(cmds, []);
    });

    it('returns empty for empty text and no images', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        const cmds = p.smartSend('', []);
        assert.deepStrictEqual(cmds, []);
    });
});

describe('submitFeedback', () => {
    it('sends feedback_response with images', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.sessionQueue.push({ sessionId: 's1', summary: '' });
        p.activeTabId = 'c1';
        const cmds = p.submitFeedback('ok', ['img1']);
        const ws = getWsSend(cmds, 'feedback_response');
        assert.deepStrictEqual(ws.message.images, ['img1']);
        assert.ok(hasDom(cmds, 'clear_input'));
        assert.ok(hasDom(cmds, 'clear_staged_images'));
    });

    it('transitions to running and clears sessionId', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.sessionQueue.push({ sessionId: 's1', summary: '' });
        p.activeTabId = 'c1';
        p.submitFeedback('ok', []);
        assert.strictEqual(t.state, 'running');
        assert.strictEqual(t.pendingSessionId, null);
    });

    it('adds user message to tab', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.sessionQueue.push({ sessionId: 's1', summary: '' });
        p.activeTabId = 'c1';
        p.submitFeedback('my feedback', []);
        const userMsg = t.messages.find(m => m.role === 'user');
        assert.ok(userMsg);
        assert.strictEqual(userMsg.content, 'my feedback');
    });

    it('returns empty if sessionQueue is empty', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'waiting');
        p.activeTabId = 'c1';
        const cmds = p.submitFeedback('ok', []);
        assert.deepStrictEqual(cmds, []);
    });

    it('clears staged images after submit', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.sessionQueue.push({ sessionId: 's1', summary: '' });
        t.stagedImages = ['img1'];
        p.activeTabId = 'c1';
        p.submitFeedback('ok', []);
        assert.deepStrictEqual(t.stagedImages, []);
    });
});

describe('addToPending', () => {
    it('appends text to queue', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('first', []);
        p.addToPending('second', []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['first', 'second']);
    });

    it('appends images to pendingImages', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('', ['img1']);
        p.addToPending('', ['img2']);
        assert.deepStrictEqual(p.tabs.get('c1').pendingImages, ['img1', 'img2']);
    });

    it('sends ws message with full queue', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('first', []);
        const cmds = p.addToPending('second', []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, ['first', 'second']);
    });

    it('clears input after adding', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        const cmds = p.addToPending('text', []);
        assert.ok(hasDom(cmds, 'clear_input'));
        assert.ok(hasDom(cmds, 'clear_staged_images'));
    });

    it('clears staged images after adding to pending', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'running');
        t.stagedImages = ['img1'];
        p.activeTabId = 'c1';
        p.addToPending('text', ['img1']);
        assert.deepStrictEqual(t.stagedImages, []);
    });
});

// ── Pending queue management ────────────────────────────

describe('pending queue', () => {
    it('editPending removes item and sets input', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('hello', []);
        const cmds = p.editPending(0);
        assert.strictEqual(p.tabs.get('c1').pendingQueue.length, 0);
        const setInput = getCmd(cmds, 'dom', c => c.action === 'set_input');
        assert.ok(setInput);
        assert.strictEqual(setInput.value, 'hello');
        assert.ok(hasDom(cmds, 'focus_input'));
    });

    it('removePending removes item without setting input', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('a', []);
        p.addToPending('b', []);
        const cmds = p.removePending(0);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['b']);
        assert.ok(!hasDom(cmds, 'set_input'));
    });

    it('clearPending empties queue and sends ws message', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('a', ['img']);
        const cmds = p.clearPending();
        assert.strictEqual(p.tabs.get('c1').pendingQueue.length, 0);
        assert.strictEqual(p.tabs.get('c1').pendingImages.length, 0);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, []);
        assert.deepStrictEqual(ws.message.images, []);
    });

    it('clearPendingImages clears only images and syncs to server', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('text', ['img1', 'img2']);
        const cmds = p.clearPendingImages();
        assert.strictEqual(p.tabs.get('c1').pendingImages.length, 0);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['text']);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, ['text']);
        assert.deepStrictEqual(ws.message.images, []);
    });

    it('pending_delivered clears queue and adds messages', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'running');
        t.pendingQueue = ['queued'];
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'pending_delivered',
            conversation_id: 'c1',
            comments: ['delivered'],
            images: [],
        });
        assert.strictEqual(t.pendingQueue.length, 0);
        assert.ok(t.messages.some(m => m.content === 'delivered' && m.pending_delivered));
    });

    it('pending-consumed clears queue and adds system message', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'running');
        t.pendingQueue = ['pending'];
        p.activeTabId = 'c1';
        p.handleMessage({ type: 'pending-consumed', conversation_id: 'c1' });
        assert.strictEqual(t.pendingQueue.length, 0);
        assert.ok(t.messages.some(m => m.role === 'system'));
    });
});

// ── Staged images (per-tab) ────────────────────────────

describe('staged images', () => {
    it('stageImage adds to active tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.stageImage('img1');
        assert.deepStrictEqual(p.tabs.get('c1').stagedImages, ['img1']);
    });

    it('unstageImage removes by index', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.stageImage('a');
        p.stageImage('b');
        p.unstageImage(0);
        assert.deepStrictEqual(p.tabs.get('c1').stagedImages, ['b']);
    });

    it('clearStagedImages empties', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.stageImage('a');
        p.clearStagedImages();
        assert.deepStrictEqual(p.tabs.get('c1').stagedImages, []);
    });

    it('staged images are per-tab (independent)', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c1';
        p.stageImage('img1');
        p.activeTabId = 'c2';
        p.stageImage('img2');
        assert.deepStrictEqual(p.tabs.get('c1').stagedImages, ['img1']);
        assert.deepStrictEqual(p.tabs.get('c2').stagedImages, ['img2']);
    });

    it('getStagedImages returns active tab images', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.stageImage('x');
        assert.deepStrictEqual(p.getStagedImages(), ['x']);
    });
});

// ── Auto-submit on session_updated with pending ─────────

describe('auto-submit', () => {
    it('returns autoSubmit when pending queue exists', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        t.pendingQueue = ['hello'];
        t.pendingImages = [];
        p.activeTabId = 'c1';
        const result = p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi' },
        });
        assert.ok(result.autoSubmit);
        assert.strictEqual(result.autoSubmit.text, 'hello');
        assert.strictEqual(t.pendingQueue.length, 0);
    });

    it('returns autoSubmit with images', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        t.pendingQueue = [];
        t.pendingImages = ['img1'];
        p.activeTabId = 'c1';
        const result = p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi' },
        });
        assert.ok(result.autoSubmit);
        assert.strictEqual(result.autoSubmit.text, '(image)');
        assert.deepStrictEqual(result.autoSubmit.images, ['img1']);
    });

    it('returns autoReply when enabled and no pending', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        t.autoReply = true;
        t.autoReplyText = 'Continue';
        const result = p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi' },
        });
        assert.ok(result.autoReply);
        assert.strictEqual(result.autoReply.text, 'Continue');
        assert.strictEqual(result.autoReply.sessionId, 's1');
    });
});

// ── conversations_list and conversation_loaded ──────────

describe('conversations_list', () => {
    it('creates tabs for each conversation', () => {
        const p = new PanelState();
        p.handleMessage({
            type: 'conversations_list',
            conversations: [
                { conversation_id: 'c1', label: 'L1', model: 'm1', state: 'idle' },
                { conversation_id: 'c2', label: 'L2', model: 'm2', state: 'waiting' },
            ],
        });
        assert.strictEqual(p.tabs.size, 2);
        assert.strictEqual(p.tabs.get('c1').label, 'L1');
        assert.strictEqual(p.tabs.get('c2').label, 'L2');
    });

    it('sets activeTabId to last if none set', () => {
        const p = new PanelState();
        p.handleMessage({
            type: 'conversations_list',
            conversations: [
                { conversation_id: 'c1', label: 'L1', model: '', state: 'idle' },
                { conversation_id: 'c2', label: 'L2', model: '', state: 'idle' },
            ],
        });
        assert.strictEqual(p.activeTabId, 'c2');
    });

    it('sends load_conversation for active tab', () => {
        const p = new PanelState();
        const cmds = p.handleMessage({
            type: 'conversations_list',
            conversations: [{ conversation_id: 'c1', label: 'L', model: '', state: 'idle' }],
        });
        const ws = getWsSend(cmds, 'load_conversation');
        assert.ok(ws);
        assert.strictEqual(ws.message.conversation_id, 'c1');
    });
});

describe('conversation_loaded', () => {
    it('populates messages', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'conversation_loaded',
            conversation: {
                conversation_id: 'c1',
                label: 'A',
                model: '',
                state: 'idle',
                messages: [{ role: 'user', content: 'loaded' }],
                pending_queue: [],
            },
        });
        assert.strictEqual(p.tabs.get('c1').messages.length, 1);
        assert.strictEqual(p.tabs.get('c1').messages[0].content, 'loaded');
    });
});

// ── Serialization ───────────────────────────────────────

describe('serialization', () => {
    it('round-trip preserves state', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'waiting');
        p.activeTabId = 'c2';
        p.tabs.get('c1').stagedImages = ['img1'];

        const data = p.serialize();
        const p2 = new PanelState();
        p2.deserialize(data);

        assert.strictEqual(p2.tabs.size, 2);
        assert.strictEqual(p2.activeTabId, 'c2');
        assert.strictEqual(p2.tabs.get('c1').label, 'A');
        assert.deepStrictEqual(p2.tabs.get('c1').stagedImages, ['img1']);
    });

    it('limits messages to 100', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        for (let i = 0; i < 150; i++) {
            t.messages.push({ role: 'user', content: `msg${i}`, timestamp: '' });
        }
        const data = p.serialize();
        assert.strictEqual(data.tabs[0].messages.length, 100);
    });

    it('includes pendingImages and stagedImages', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        t.pendingImages = ['p1'];
        t.stagedImages = ['s1'];
        const data = p.serialize();
        assert.deepStrictEqual(data.tabs[0].pendingImages, ['p1']);
        assert.deepStrictEqual(data.tabs[0].stagedImages, ['s1']);
    });

    it('deserialize with null is safe', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.deserialize(null);
        assert.strictEqual(p.tabs.size, 1);
    });
});

// ── tab_closed from server ──────────────────────────────

describe('tab_closed', () => {
    it('removes tab and updates active', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c2';
        p.handleMessage({ type: 'tab_closed', conversation_id: 'c2' });
        assert.strictEqual(p.tabs.size, 1);
        assert.strictEqual(p.activeTabId, 'c1');
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

// ── Independent pending queues per tab ──────────────────

describe('multi-tab isolation', () => {
    it('pending queues are independent', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.getOrCreateTab('c2', 'B', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('p1', []);
        p.activeTabId = 'c2';
        p.addToPending('p2', []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['p1']);
        assert.deepStrictEqual(p.tabs.get('c2').pendingQueue, ['p2']);
    });

    it('session_ended on one tab does not affect other', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.getOrCreateTab('c2', 'B', '', 'running');
        p.activeTabId = 'c1';
        p.handleMessage({ type: 'session_ended', conversation_id: 'c2' });
        assert.strictEqual(p.tabs.get('c1').state, 'running');
        assert.strictEqual(p.tabs.get('c2').state, 'ended');
    });
});

// ── setAutoReply ────────────────────────────────────────

describe('setAutoReply', () => {
    it('sets auto-reply on active tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.setAutoReply(true, 'Go');
        assert.strictEqual(p.tabs.get('c1').autoReply, true);
        assert.strictEqual(p.tabs.get('c1').autoReplyText, 'Go');
    });

    it('returns save_state command', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const cmds = p.setAutoReply(true);
        assert.ok(hasDom(cmds, 'save_state'));
    });
});

// ── Integration scenarios (user-reported) ───────────────

describe('scenario: pending after session_start', () => {
    it('can queue pending immediately after session_updated', () => {
        const p = new PanelState();
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi', label: 'Chat' },
        });
        assert.strictEqual(p.tabs.get('c1').state, 'waiting');
        const cmds = p.addToPending('pending msg', []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['pending msg']);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.ok(ws);
        assert.deepStrictEqual(ws.message.comments, ['pending msg']);
    });

    it('can queue pending on idle tab before any session', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Chat', '', 'idle');
        p.activeTabId = 'c1';
        const cmds = p.addToPending('pre-queue', []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['pre-queue']);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.ok(ws);
    });

    it('queued pending auto-submits when next session arrives', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Chat', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('pre-queued', []);

        const result = p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Next' },
        });

        assert.ok(result.autoSubmit);
        assert.strictEqual(result.autoSubmit.text, 'pre-queued');
        assert.strictEqual(p.tabs.get('c1').pendingQueue.length, 0);
    });
});

describe('scenario: restart on old session', () => {
    it('deserialize old session + new session_updated works', () => {
        const p = new PanelState();
        p.deserialize({
            activeTabId: 'c1',
            tabs: [{
                id: 'c1', label: 'Old Chat', model: '', state: 'running',
                messages: [{ role: 'ai', content: 'old msg', timestamp: '' }],
                pendingQueue: [], pendingImages: [],
                autoReply: false, autoReplyText: 'Continue',
                inputDraft: '', stagedImages: [],
            }],
        });

        assert.strictEqual(p.tabs.get('c1').state, 'running');

        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's-new', summary: 'New question' },
        });

        assert.strictEqual(p.tabs.get('c1').state, 'waiting');
        assert.strictEqual(p.tabs.get('c1').pendingSessionId, 's-new');
        assert.ok(p.tabs.get('c1').messages.length > 1);
    });

    it('new pending on restored session sends correctly', () => {
        const p = new PanelState();
        p.deserialize({
            activeTabId: 'c1',
            tabs: [{
                id: 'c1', label: 'Old Chat', model: '', state: 'idle',
                messages: [], pendingQueue: [], pendingImages: [],
                autoReply: false, autoReplyText: 'Continue',
                inputDraft: '', stagedImages: [],
            }],
        });

        const cmds = p.addToPending('new pending on old session', []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['new pending on old session']);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.ok(ws);
        assert.strictEqual(ws.message.conversation_id, 'c1');
    });
});

describe('scenario: pending queue CRUD', () => {
    function setupWithPending() {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Chat', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('first', []);
        p.addToPending('second', []);
        p.addToPending('third', []);
        return p;
    }

    it('append preserves order', () => {
        const p = setupWithPending();
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['first', 'second', 'third']);
    });

    it('edit removes item and sets input, keeps others', () => {
        const p = setupWithPending();
        const cmds = p.editPending(1);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['first', 'third']);
        const setInput = getCmd(cmds, 'dom', c => c.action === 'set_input');
        assert.strictEqual(setInput.value, 'second');
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, ['first', 'third']);
    });

    it('remove single item keeps others', () => {
        const p = setupWithPending();
        const cmds = p.removePending(0);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['second', 'third']);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, ['second', 'third']);
    });

    it('clear all empties entire queue', () => {
        const p = setupWithPending();
        const cmds = p.clearPending();
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, []);
    });

    it('remove last item hides pending section', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Chat', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('only', []);
        const cmds = p.removePending(0);
        assert.strictEqual(p.tabs.get('c1').pendingQueue.length, 0);
        assert.ok(hasRender(cmds, 'pending'));
    });

    it('edit out-of-range returns empty', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Chat', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('one', []);
        const cmds = p.editPending(5);
        assert.deepStrictEqual(cmds, []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['one']);
    });

    it('remove out-of-range returns empty', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Chat', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('one', []);
        const cmds = p.removePending(5);
        assert.deepStrictEqual(cmds, []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['one']);
    });

    it('pending with images: append and clear', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Chat', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('text', ['img1']);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['text']);
        assert.deepStrictEqual(p.tabs.get('c1').pendingImages, ['img1']);
        p.addToPending('', ['img2']);
        assert.deepStrictEqual(p.tabs.get('c1').pendingImages, ['img1', 'img2']);
        p.clearPending();
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingImages, []);
    });

    it('ws sync message always contains full queue state', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Chat', '', 'running');
        p.activeTabId = 'c1';
        p.addToPending('a', []);
        p.addToPending('b', []);
        const cmds = p.addToPending('c', []);
        const ws = getWsSend(cmds, 'queue-pending');
        assert.deepStrictEqual(ws.message.comments, ['a', 'b', 'c']);
    });
});

// ── Multiple concurrent feedback requests ───────────────

describe('multiple feedback queue (FIFO)', () => {
    it('queues multiple session_updated and responds in order', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';

        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's1', summary: 'First' } });
        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's2', summary: 'Second' } });
        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's3', summary: 'Third' } });

        const t = p.tabs.get('c1');
        assert.strictEqual(t.sessionQueue.length, 3);
        assert.strictEqual(t.pendingSessionId, 's1');

        const cmds1 = p.submitFeedback('reply1', []);
        const ws1 = getWsSend(cmds1, 'feedback_response');
        assert.strictEqual(ws1.message.session_id, 's1');
        assert.strictEqual(t.state, 'waiting');
        assert.strictEqual(t.sessionQueue.length, 2);
        assert.strictEqual(t.pendingSessionId, 's2');

        const cmds2 = p.submitFeedback('reply2', []);
        const ws2 = getWsSend(cmds2, 'feedback_response');
        assert.strictEqual(ws2.message.session_id, 's2');
        assert.strictEqual(t.state, 'waiting');
        assert.strictEqual(t.sessionQueue.length, 1);

        const cmds3 = p.submitFeedback('reply3', []);
        const ws3 = getWsSend(cmds3, 'feedback_response');
        assert.strictEqual(ws3.message.session_id, 's3');
        assert.strictEqual(t.state, 'running');
        assert.strictEqual(t.sessionQueue.length, 0);
    });

    it('does not duplicate sessions in queue', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';

        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi' } });
        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi again' } });

        assert.strictEqual(p.tabs.get('c1').sessionQueue.length, 1);
    });

    it('feedback_submitted removes specific session from queue', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';

        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's1', summary: 'A' } });
        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's2', summary: 'B' } });

        p.handleMessage({ type: 'feedback_submitted', conversation_id: 'c1', session_id: 's1', feedback: 'ok' });
        const t = p.tabs.get('c1');
        assert.strictEqual(t.sessionQueue.length, 1);
        assert.strictEqual(t.pendingSessionId, 's2');
        assert.strictEqual(t.state, 'waiting');
    });

    it('getUIState reports feedbackQueueSize', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';

        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's1', summary: 'A' } });
        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's2', summary: 'B' } });

        const ui = p.getUIState();
        assert.strictEqual(ui.feedbackQueueSize, 2);
    });

    it('session_ended clears entire queue', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';

        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's1', summary: 'A' } });
        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's2', summary: 'B' } });
        p.handleMessage({ type: 'session_ended', conversation_id: 'c1' });

        assert.strictEqual(p.tabs.get('c1').sessionQueue.length, 0);
        assert.strictEqual(p.tabs.get('c1').state, 'ended');
    });

    it('serialization preserves sessionQueue', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';

        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's1', summary: 'A' } });
        p.handleMessage({ type: 'session_updated', session_info: { conversation_id: 'c1', session_id: 's2', summary: 'B' } });

        const data = p.serialize();
        const p2 = new PanelState();
        p2.deserialize(data);

        assert.strictEqual(p2.tabs.get('c1').sessionQueue.length, 2);
        assert.strictEqual(p2.tabs.get('c1').pendingSessionId, 's1');
    });
});

// ── Command type verification ───────────────────────────

describe('command types', () => {
    it('all returned items are valid command objects', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.sessionQueue.push({ sessionId: 's1', summary: '' });
        p.activeTabId = 'c1';

        const allCmds = [
            ...p.submitFeedback('ok', ['img']),
            ...p.switchTab('c1', ''),
            ...p.closeTab('c1'),
        ];

        for (const cmd of allCmds) {
            assert.ok(cmd.type, `Command missing type: ${JSON.stringify(cmd)}`);
            assert.ok(['ws_send', 'render', 'dom', 'notify'].includes(cmd.type),
                `Unknown command type: ${cmd.type}`);
        }
    });
});
