/**
 * Unit tests for FeedbackFlow semantics.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FeedbackFlow } = require('../out/server/feedbackFlow');
const { FeedbackManager } = require('../out/server/feedbackManager');

function createFlow(overrides) {
    const feedback = new FeedbackManager();
    const logs = [];
    const submitted = [];

    const flow = new FeedbackFlow({
        feedback,
        appendReminder: (s) => `${s} [r]`,
        addMessage: () => {},
        broadcastSessionUpdated: () => {},
        broadcastFeedbackSubmitted: (f) => submitted.push(f || ''),
        clearPending: () => {},
        queueAsPending: () => {},
        sendResult: () => {},
        sendError: () => {},
        onFeedbackRequested: undefined,
        log: (msg) => logs.push(msg),
        ...overrides,
    });

    return { flow, feedback, logs, submitted };
}

describe('FeedbackFlow no-op semantics', () => {
    it('routes to pending queue when no active feedback session', () => {
        const pending = [];
        const { flow, logs, submitted } = createFlow({
            queueAsPending: (fb, imgs) => pending.push({ fb, imgs }),
        });

        flow.handleFeedbackResponse({ feedback: 'hello' });

        assert.strictEqual(submitted.length, 0);
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(pending[0].fb, 'hello');
        assert.ok(logs.some((l) => l.includes('routing to pending queue')));
    });

    it('does not broadcast on dismiss when no pending request', () => {
        const { flow, logs, submitted } = createFlow();

        flow.handleDismiss();

        assert.strictEqual(submitted.length, 0);
        assert.ok(logs.some((l) => l.includes('no pending feedback request')));
    });

    it('resolves feedback round-trip', async () => {
        const results = [];
        const { flow, feedback } = createFlow({
            sendResult: (_ws, r) => results.push(r),
        });

        const fakeWs = { readyState: 1, send: () => {} };
        flow.handleFeedbackRequest(fakeWs, { summary: 'test' });

        flow.handleFeedbackResponse({ feedback: 'reply' });

        await new Promise((r) => setTimeout(r, 10));
        assert.strictEqual(feedback.pendingCount(), 0);
    });

    it('updateTransport swaps ws for same project', () => {
        const feedback = new FeedbackManager();
        const ws1 = { readyState: 1, send: () => {} };
        const ws2 = { readyState: 1, send: () => {} };

        feedback.enqueue(ws1, '/project/a');
        feedback.updateTransport(ws2, '/project/a');

        assert.strictEqual(feedback.pendingCount(), 1);
    });
});
