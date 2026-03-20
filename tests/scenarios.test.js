/**
 * End-to-end scenario tests for the flat model.
 *
 * Run with: node --test tests/scenarios.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PanelState } = require('../static/panelState.js');

function getWsSend(cmds, msgType) {
    const list = Array.isArray(cmds) ? cmds : (cmds.commands || []);
    return list.find(c => c.type === 'ws_send' && c.message.type === msgType);
}

describe('scenario: complete feedback loop', () => {
    it('idle -> queue pending -> session arrives -> auto-submit -> running', () => {
        const p = new PanelState();
        assert.strictEqual(p.panelMode, 'idle');

        p.addToPending('fix the bug please', []);
        assert.deepStrictEqual(p.pendingQueue, ['fix the bug please']);
        assert.strictEqual(p.panelMode, 'idle');

        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Task completed',
        });

        assert.ok(result.autoSubmit, 'should auto-submit pending');
        assert.strictEqual(result.autoSubmit.text, 'fix the bug please');
        assert.strictEqual(p.pendingQueue.length, 0);
    });

    it('waiting -> submit feedback -> running -> new session -> waiting', () => {
        const p = new PanelState();

        p.handleMessage({
            type: 'session_updated',
            summary: 'First task',
        });
        assert.strictEqual(p.panelMode, 'waiting');

        p.submitFeedback('looks good', []);
        assert.strictEqual(p.panelMode, 'running');

        p.handleMessage({
            type: 'session_updated',
            summary: 'Second task',
        });
        assert.strictEqual(p.panelMode, 'waiting');
        assert.strictEqual(p.hasWaitingSession, true);
    });
});

describe('scenario: multiple pending then session', () => {
    it('queues 3 messages, session arrives, all combined in autoSubmit', () => {
        const p = new PanelState();
        p.addToPending('first point', []);
        p.addToPending('second point', []);
        p.addToPending('third point', []);

        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Ready',
        });

        assert.ok(result.autoSubmit);
        assert.ok(result.autoSubmit.text.includes('first point'));
        assert.ok(result.autoSubmit.text.includes('second point'));
        assert.ok(result.autoSubmit.text.includes('third point'));
        assert.strictEqual(p.pendingQueue.length, 0);
    });
});

describe('scenario: pending with images', () => {
    it('queues text + images, session arrives, auto-submits both', () => {
        const p = new PanelState();
        p.addToPending('see this screenshot', ['img_base64']);

        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Ready',
        });

        assert.ok(result.autoSubmit);
        assert.ok(result.autoSubmit.text.includes('see this screenshot'));
        assert.deepStrictEqual(result.autoSubmit.images, ['img_base64']);
    });
});

describe('scenario: auto-reply', () => {
    it('auto-replies when enabled and no pending', () => {
        const p = new PanelState();
        p.autoReply = true;
        p.autoReplyText = 'Continue';

        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Done',
        });

        assert.ok(result.autoReply);
        assert.strictEqual(result.autoReply.text, 'Continue');
        assert.strictEqual(result.autoReply.delay, 500);
    });

    it('pending takes priority over auto-reply', () => {
        const p = new PanelState();
        p.autoReply = true;
        p.autoReplyText = 'Continue';
        p.addToPending('urgent fix', []);

        const result = p.handleMessage({
            type: 'session_updated',
            summary: 'Done',
        });

        assert.ok(result.autoSubmit);
        assert.ok(!result.autoReply);
    });
});

describe('scenario: FIFO feedback queue', () => {
    it('3 sessions arrive, user responds to each in order', () => {
        const p = new PanelState();

        p.handleMessage({ type: 'session_updated', summary: 'A' });
        p.handleMessage({ type: 'session_updated', summary: 'B' });
        p.handleMessage({ type: 'session_updated', summary: 'C' });

        assert.strictEqual(p.sessionQueue.length, 3);
        assert.strictEqual(p.hasWaitingSession, true);
        assert.strictEqual(p.sessionQueue[0].summary, 'A');

        const cmds1 = p.submitFeedback('reply A', []);
        const ws1 = getWsSend(cmds1, 'feedback_response');
        assert.strictEqual(ws1.message.feedback, 'reply A');
        assert.strictEqual(p.sessionQueue[0].summary, 'B');

        const cmds2 = p.submitFeedback('reply B', []);
        const ws2 = getWsSend(cmds2, 'feedback_response');
        assert.strictEqual(ws2.message.feedback, 'reply B');
        assert.strictEqual(p.sessionQueue[0].summary, 'C');

        const cmds3 = p.submitFeedback('reply C', []);
        const ws3 = getWsSend(cmds3, 'feedback_response');
        assert.strictEqual(ws3.message.feedback, 'reply C');
        assert.strictEqual(p.sessionQueue.length, 0);
    });
});

describe('scenario: state_sync restores', () => {
    it('restores messages and pending from server', () => {
        const p = new PanelState();
        p.handleMessage({
            type: 'state_sync',
            messages: [
                { role: 'ai', content: 'Hello', timestamp: '2025-01-01' },
                { role: 'user', content: 'Fix bugs', timestamp: '2025-01-01' },
            ],
            pending_comments: ['pending message'],
            pending_images: [],
            feedback_queue_size: 1,
        });

        assert.strictEqual(p.messages.length, 2);
        assert.deepStrictEqual(p.pendingQueue, ['pending message']);
        assert.strictEqual(p.sessionQueue.length, 1);
        assert.strictEqual(p.panelMode, 'waiting');
    });
});

describe('scenario: serialize/deserialize round trip', () => {
    it('preserves full state across serialization', () => {
        const p = new PanelState();
        p.handleMessage({ type: 'session_updated', summary: 'Task' });
        p.submitFeedback('done', []);
        p.addToPending('next request', []);
        p.stageImage('img1');
        p.autoReply = true;
        p.autoReplyText = 'Go';

        const data = p.serialize();
        const p2 = new PanelState();
        p2.deserialize(data);

        assert.strictEqual(p2.messages.length, p.messages.length);
        assert.deepStrictEqual(p2.pendingQueue, ['next request']);
        assert.deepStrictEqual(p2.stagedImages, ['img1']);
        assert.strictEqual(p2.autoReply, true);
        assert.strictEqual(p2.autoReplyText, 'Go');
    });
});
