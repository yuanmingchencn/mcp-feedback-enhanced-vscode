/**
 * Unit tests for panelState.js (pure state machine).
 *
 * Run with: node --test tests/panelState.test.js
 * Or: npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PanelState, TabState } = require('../static/panelState.js');

describe('PanelState', () => {
    it('creates empty state', () => {
        const p = new PanelState();
        assert.strictEqual(p.tabs.size, 0);
        assert.strictEqual(p.activeTabId, null);
    });

    it('getOrCreateTab creates and returns tab', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'Agent', '', 'idle');
        assert.ok(t instanceof TabState);
        assert.strictEqual(t.conversationId, 'c1');
        assert.strictEqual(t.label, 'Agent');
        assert.strictEqual(t.state, 'idle');
        assert.strictEqual(p.tabs.size, 1);
    });

    it('getOrCreateTab updates existing tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Old', '', 'idle');
        const t = p.getOrCreateTab('c1', 'New', 'gpt-4', 'running');
        assert.strictEqual(t.label, 'New');
        assert.strictEqual(t.model, 'gpt-4');
        assert.strictEqual(t.state, 'running');
        assert.strictEqual(p.tabs.size, 1);
    });

    it('switchTab returns inputDraft and effects', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle').inputDraft = 'draft1';
        p.getOrCreateTab('c2', 'B', '', 'idle').inputDraft = 'draft2';
        const r = p.switchTab('c1', '');
        assert.ok(r);
        assert.strictEqual(r.inputDraft, 'draft1');
        assert.ok(r.effects.includes('render_tabs'));
        assert.ok(r.effects.includes('save_state'));
    });

    it('switchTab saves current input to previous tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c1';
        p.switchTab('c2', 'typed text');
        assert.strictEqual(p.tabs.get('c1').inputDraft, 'typed text');
    });

    it('closeTab returns wsMessages and newActiveTabId', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c2';
        const r = p.closeTab('c2');
        assert.strictEqual(r.newActiveTabId, 'c1');
        assert.strictEqual(r.wsMessages.length, 1);
        assert.strictEqual(r.wsMessages[0].type, 'close_tab');
        assert.strictEqual(r.wsMessages[0].conversation_id, 'c2');
    });

    it('handleMessage session_registered creates tab', () => {
        const p = new PanelState();
        const r = p.handleMessage({
            type: 'session_registered',
            session: { conversation_id: 'c1' },
            conversation: { label: 'Test', model: 'gpt-4' },
        });
        assert.ok(p.tabs.has('c1'));
        assert.strictEqual(p.tabs.get('c1').label, 'Test');
        assert.ok(r.effects.includes('render_tabs'));
    });

    it('handleMessage session_updated returns autoSubmit when pending', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        t.pendingQueue = ['hello'];
        t.pendingImages = [];
        const r = p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi' },
        });
        assert.ok(r.autoSubmit);
        assert.strictEqual(r.autoSubmit.text, 'hello');
        assert.strictEqual(t.pendingQueue.length, 0);
    });

    it('handleMessage session_updated returns autoReply when enabled', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        t.autoReply = true;
        t.autoReplyText = 'Continue';
        const r = p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi' },
        });
        assert.ok(r.autoReply);
        assert.strictEqual(r.autoReply.text, 'Continue');
        assert.strictEqual(r.autoReply.sessionId, 's1');
    });

    it('addToPending replaces queue and returns effects', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const r = p.addToPending('hello', []);
        assert.ok(r);
        assert.strictEqual(p.tabs.get('c1').pendingQueue[0], 'hello');
        assert.ok(r.effects.includes('clear_input'));
        assert.strictEqual(r.wsMessages[0].type, 'queue-pending');
    });

    it('submitFeedback returns wsMessages with session_id', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.pendingSessionId = 's1';
        p.activeTabId = 'c1';
        const r = p.submitFeedback('ok', []);
        assert.ok(r);
        assert.strictEqual(r.wsMessages[0].session_id, 's1');
        assert.strictEqual(r.wsMessages[0].type, 'feedback_response');
        assert.strictEqual(t.pendingSessionId, null);
        assert.strictEqual(t.state, 'running');
    });

    it('smartSend submits when waiting, queues otherwise', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const r1 = p.smartSend('hi', []);
        assert.strictEqual(r1.wsMessages[0].type, 'queue-pending');

        const t = p.tabs.get('c1');
        t.state = 'waiting';
        t.pendingSessionId = 's1';
        const r2 = p.smartSend('ok', []);
        assert.strictEqual(r2.wsMessages[0].type, 'feedback_response');
    });

    it('serialize/deserialize round-trip', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const data = p.serialize();
        const p2 = new PanelState();
        p2.deserialize(data);
        assert.strictEqual(p2.tabs.size, 1);
        assert.strictEqual(p2.activeTabId, 'c1');
        assert.strictEqual(p2.tabs.get('c1').label, 'A');
    });

    it('PanelState.md escapes HTML', () => {
        assert.ok(PanelState.md('<script>').includes('&lt;'));
        assert.ok(PanelState.md('**bold**').includes('<strong>'));
    });

    it('PanelState.getAtQuery extracts @query', () => {
        const r = PanelState.getAtQuery('hello @foo bar', 10);
        assert.ok(r);
        assert.strictEqual(r.query, 'foo');
        assert.strictEqual(r.start, 6);
    });
});
