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

    // --- Tab state transitions ---
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
        t.pendingSessionId = 's1';
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'feedback_submitted',
            conversation_id: 'c1',
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
        assert.ok(t.messages.some((m) => m.content === '── Session ended ──'));
    });

    it('waiting -> ended via session_ended while waiting', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.pendingSessionId = 's1';
        p.activeTabId = 'c1';
        p.handleMessage({ type: 'session_ended', conversation_id: 'c1' });
        assert.strictEqual(t.state, 'ended');
    });

    it('ended stays ended on session_updated', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'ended');
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'New' },
        });
        assert.strictEqual(t.state, 'ended');
    });

    it('multiple state transitions in sequence', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi' },
        });
        assert.strictEqual(t.state, 'waiting');
        p.handleMessage({ type: 'feedback_submitted', conversation_id: 'c1', feedback: 'ok' });
        assert.strictEqual(t.state, 'running');
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's2', summary: 'Again' },
        });
        assert.strictEqual(t.state, 'waiting');
        p.handleMessage({ type: 'session_ended', conversation_id: 'c1' });
        assert.strictEqual(t.state, 'ended');
    });

    it('full lifecycle: idle -> waiting -> running -> waiting -> running -> ended', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'First' },
        });
        p.handleMessage({ type: 'feedback_submitted', conversation_id: 'c1', feedback: 'a' });
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's2', summary: 'Second' },
        });
        p.handleMessage({ type: 'feedback_submitted', conversation_id: 'c1', feedback: 'b' });
        p.handleMessage({ type: 'session_ended', conversation_id: 'c1' });
        assert.strictEqual(t.state, 'ended');
        assert.strictEqual(t.messages.filter((m) => m.role === 'user').length, 2);
    });

    // --- Pending queue ---
    it('second addToPending replaces first (pendingQueue = [second])', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.addToPending('first', []);
        p.addToPending('second', []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['second']);
    });

    it('editPending returns correct text and empties queue', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.addToPending('hello world', []);
        const r = p.editPending(0);
        assert.ok(r);
        assert.strictEqual(r.text, 'hello world');
        assert.strictEqual(p.tabs.get('c1').pendingQueue.length, 0);
    });

    it('editPending followed by addToPending (edit + re-queue)', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.addToPending('original', []);
        const edit = p.editPending(0);
        assert.strictEqual(edit.text, 'original');
        p.addToPending('edited text', []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['edited text']);
    });

    it('clearPending empties queue and sends WS message', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        p.addToPending('pending', []);
        const r = p.clearPending();
        assert.ok(r);
        assert.strictEqual(p.tabs.get('c1').pendingQueue.length, 0);
        assert.strictEqual(p.tabs.get('c1').pendingImages.length, 0);
        assert.strictEqual(r.wsMessages[0].type, 'queue-pending');
        assert.deepStrictEqual(r.wsMessages[0].comments, []);
    });

    it('addToPending with images only (no text)', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const images = [{ data: 'base64...', mime: 'image/png' }];
        const r = p.addToPending('', images);
        assert.ok(r);
        assert.strictEqual(p.tabs.get('c1').pendingQueue.length, 0);
        assert.strictEqual(p.tabs.get('c1').pendingImages.length, 1);
        assert.strictEqual(r.wsMessages[0].images.length, 1);
    });

    it('addToPending with both text and images', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const images = [{ data: 'x', mime: 'image/png' }];
        const r = p.addToPending('text', images);
        assert.ok(r);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['text']);
        assert.strictEqual(p.tabs.get('c1').pendingImages.length, 1);
        assert.strictEqual(r.wsMessages[0].comments[0], 'text');
        assert.strictEqual(r.wsMessages[0].images.length, 1);
    });

    it('pending_delivered clears queue and adds messages', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        t.pendingQueue = ['queued'];
        t.pendingImages = [];
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'pending_delivered',
            conversation_id: 'c1',
            comments: ['delivered'],
            images: [],
        });
        assert.strictEqual(t.pendingQueue.length, 0);
        assert.strictEqual(t.pendingImages.length, 0);
        assert.ok(t.messages.some((m) => m.content === 'delivered' && m.pending_delivered));
    });

    it('pending-consumed clears queue and adds system message', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        t.pendingQueue = ['pending'];
        p.activeTabId = 'c1';
        p.handleMessage({ type: 'pending-consumed', conversation_id: 'c1' });
        assert.strictEqual(t.pendingQueue.length, 0);
        assert.ok(t.messages.some((m) => m.role === 'system' && m.content.includes('Pending delivered')));
    });

    // --- Tab label ---
    it('session_updated with explicit label uses that label', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Old', '', 'idle');
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Hi', label: 'New Label' },
        });
        assert.strictEqual(p.tabs.get('c1').label, 'New Label');
    });

    it('session_updated without label keeps existing or defaults to Agent', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Existing', '', 'idle');
        p.activeTabId = 'c1';
        p.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c1', session_id: 's1', summary: 'Summary text here' },
        });
        assert.strictEqual(p.tabs.get('c1').label, 'Existing');
        const p2 = new PanelState();
        p2.handleMessage({
            type: 'session_updated',
            session_info: { conversation_id: 'c2', session_id: 's2', summary: 'No label' },
        });
        assert.strictEqual(p2.tabs.get('c2').label, 'Agent');
    });

    it('label is never the conversation_id UUID', () => {
        const p = new PanelState();
        const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        p.getOrCreateTab(uuid, 'Agent', '', 'idle');
        assert.notStrictEqual(p.tabs.get(uuid).label, uuid);
        assert.strictEqual(p.tabs.get(uuid).label, 'Agent');
    });

    it('getOrCreateTab preserves existing label if new label is null', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Keep Me', '', 'idle');
        const t = p.getOrCreateTab('c1', null, 'gpt-4', 'running');
        assert.strictEqual(t.label, 'Keep Me');
    });

    it('getOrCreateTab updates label if new label provided', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'Old', '', 'idle');
        const t = p.getOrCreateTab('c1', 'New', '', 'idle');
        assert.strictEqual(t.label, 'New');
    });

    // --- Multi-tab ---
    it('switchTab preserves input draft of previous tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c1';
        p.switchTab('c2', 'typed in c1');
        assert.strictEqual(p.tabs.get('c1').inputDraft, 'typed in c1');
    });

    it('switchTab restores input draft of new tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle').inputDraft = 'draft A';
        p.getOrCreateTab('c2', 'B', '', 'idle').inputDraft = 'draft B';
        p.activeTabId = 'c1';
        const r = p.switchTab('c2', '');
        assert.strictEqual(r.inputDraft, 'draft B');
    });

    it('independent pending queues per tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.activeTabId = 'c1';
        p.addToPending('pending1', []);
        p.activeTabId = 'c2';
        p.addToPending('pending2', []);
        assert.deepStrictEqual(p.tabs.get('c1').pendingQueue, ['pending1']);
        assert.deepStrictEqual(p.tabs.get('c2').pendingQueue, ['pending2']);
    });

    it('closeTab switches to last remaining tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'idle');
        p.getOrCreateTab('c3', 'C', '', 'idle');
        p.activeTabId = 'c2';
        const r = p.closeTab('c2');
        assert.strictEqual(r.newActiveTabId, 'c3');
        assert.strictEqual(p.activeTabId, 'c3');
    });

    it('closeTab on last tab sets activeTabId to null', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const r = p.closeTab('c1');
        assert.strictEqual(r.newActiveTabId, null);
        assert.strictEqual(p.activeTabId, null);
    });

    // --- Input visibility via getUIState ---
    it('getUIState idle: inputVisible=false, isIdle=true', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, false);
        assert.strictEqual(ui.isIdle, true);
    });

    it('getUIState waiting: inputVisible=true, buttonMode=send', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'waiting');
        p.activeTabId = 'c1';
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, true);
        assert.strictEqual(ui.buttonMode, 'send');
    });

    it('getUIState running: inputVisible=true, buttonMode=queue', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, true);
        assert.strictEqual(ui.buttonMode, 'queue');
    });

    it('getUIState ended: inputVisible=false, isEnded=true', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'ended');
        p.activeTabId = 'c1';
        const ui = p.getUIState();
        assert.strictEqual(ui.inputVisible, false);
        assert.strictEqual(ui.isEnded, true);
    });

    // --- smartSend ---
    it('smartSend in waiting state calls submitFeedback', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'waiting');
        t.pendingSessionId = 's1';
        p.activeTabId = 'c1';
        const r = p.smartSend('feedback', []);
        assert.strictEqual(r.wsMessages[0].type, 'feedback_response');
        assert.strictEqual(t.state, 'running');
    });

    it('smartSend in running state calls addToPending', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'running');
        p.activeTabId = 'c1';
        const r = p.smartSend('queued', []);
        assert.strictEqual(r.wsMessages[0].type, 'queue-pending');
        assert.strictEqual(p.tabs.get('c1').pendingQueue[0], 'queued');
    });

    it('smartSend in idle state returns addToPending result (queues)', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.activeTabId = 'c1';
        const r = p.smartSend('hi', []);
        assert.ok(r);
        assert.strictEqual(r.wsMessages[0].type, 'queue-pending');
    });

    // --- Serialization ---
    it('serialize round-trip preserves tabs and active tab', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.getOrCreateTab('c2', 'B', '', 'waiting');
        p.activeTabId = 'c2';
        const data = p.serialize();
        const p2 = new PanelState();
        p2.deserialize(data);
        assert.strictEqual(p2.tabs.size, 2);
        assert.strictEqual(p2.activeTabId, 'c2');
        assert.strictEqual(p2.tabs.get('c1').label, 'A');
        assert.strictEqual(p2.tabs.get('c2').label, 'B');
    });

    it('serialize limits messages to 100', () => {
        const p = new PanelState();
        const t = p.getOrCreateTab('c1', 'A', '', 'idle');
        for (let i = 0; i < 150; i++) {
            t.messages.push({ role: 'user', content: `msg${i}`, timestamp: '' });
        }
        const data = p.serialize();
        assert.strictEqual(data.tabs[0].messages.length, 100);
    });

    it('deserialize with empty data is safe', () => {
        const p = new PanelState();
        p.getOrCreateTab('c1', 'A', '', 'idle');
        p.deserialize(null);
        assert.strictEqual(p.tabs.size, 1);
        p.deserialize({});
        assert.strictEqual(p.tabs.size, 1);
    });

    // --- Static methods ---
    it('md() escapes HTML', () => {
        assert.ok(PanelState.md('<script>alert(1)</script>').includes('&lt;'));
        assert.ok(PanelState.md('<div>').includes('&gt;'));
    });

    it('md() handles code blocks, bold, italic, headers', () => {
        const out = PanelState.md('**bold** *italic* `code`');
        assert.ok(out.includes('<strong>bold</strong>'));
        assert.ok(out.includes('<em>italic</em>'));
        assert.ok(out.includes('<code>code</code>'));
        const h = PanelState.md('# Header\n## Sub');
        assert.ok(h.includes('<h2>'));
        assert.ok(h.includes('<h3>'));
    });

    it('getAtQuery extracts @-query', () => {
        const r = PanelState.getAtQuery('type @foo here', 9);
        assert.ok(r);
        assert.strictEqual(r.query, 'foo');
        assert.strictEqual(r.start, 5);
        assert.strictEqual(r.end, 9);
    });

    it('getAtQuery returns null when no @', () => {
        const r = PanelState.getAtQuery('hello world', 11);
        assert.strictEqual(r, null);
    });

    // --- conversations_list + conversation_loaded ---
    it('conversations_list creates tabs for each conversation', () => {
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

    it('conversations_list sets activeTabId if none was set', () => {
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

    it('conversation_loaded populates tab messages', () => {
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
