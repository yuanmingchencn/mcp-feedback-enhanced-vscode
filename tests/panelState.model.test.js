/**
 * Property-based model tests for panelState.js v3 (flat model) using fast-check.
 *
 * Tests invariants that must hold after any sequence of operations.
 *
 * Run with: node --test tests/panelState.model.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { PanelState } = require('../static/panelState.js');

// ── Model (simplified tracker) ──────────────────────────

class SimpleModel {
    constructor() {
        this.pendingCount = 0;
        this.pendingImageCount = 0;
        this.stagedCount = 0;
        this.sessionQueueLen = 0;
        this.messageCount = 0;
    }
}

// ── Commands ────────────────────────────────────────────

class FeedbackRequestCmd {
    constructor(seq) { this.seq = seq; }
    check() { return true; }
    run(model, real) {
        const hadPending = model.pendingCount > 0 || model.pendingImageCount > 0;
        const result = real.handleMessage({
            type: 'session_updated',
            summary: 'Summary ' + this.seq,
        });
        if (hadPending && result && result.autoSubmit) {
            // Auto-submit consumes pending and submits feedback
            real.submitFeedback(result.autoSubmit.text, result.autoSubmit.images || []);
            model.pendingCount = 0;
            model.pendingImageCount = 0;
            model.messageCount += 1;
            model.stagedCount = 0;
        } else {
            model.sessionQueueLen += 1;
        }
    }
    toString() { return `FeedbackRequest(${this.seq})`; }
}

class FeedbackResponseCmd {
    check(model) { return model.sessionQueueLen > 0; }
    run(model, real) {
        real.submitFeedback('test feedback', []);
        model.sessionQueueLen = Math.max(0, model.sessionQueueLen - 1);
        model.stagedCount = 0;
        model.messageCount += 1;
    }
    toString() { return 'FeedbackResponse()'; }
}

class QueuePendingCmd {
    constructor(text) { this.text = text; }
    check(model) { return model.sessionQueueLen === 0; }
    run(model, real) {
        real.addToPending(this.text, []);
        model.pendingCount += 1;
        model.stagedCount = 0;
    }
    toString() { return `QueuePending(${this.text})`; }
}

class QueuePendingWithImageCmd {
    check(model) { return model.sessionQueueLen === 0; }
    run(model, real) {
        real.addToPending('', ['base64img']);
        model.pendingImageCount += 1;
        model.stagedCount = 0;
    }
    toString() { return 'QueuePendingWithImage()'; }
}

class ClearPendingCmd {
    check(model) { return model.pendingCount > 0 || model.pendingImageCount > 0; }
    run(model, real) {
        real.clearPending();
        model.pendingCount = 0;
        model.pendingImageCount = 0;
    }
    toString() { return 'ClearPending()'; }
}

class EditPendingCmd {
    check(model) { return model.pendingCount > 0; }
    run(model, real) {
        real.editPending(0);
        model.pendingCount -= 1;
    }
    toString() { return 'EditPending(0)'; }
}

class RemovePendingCmd {
    check(model) { return model.pendingCount > 0; }
    run(model, real) {
        real.removePending(0);
        model.pendingCount -= 1;
    }
    toString() { return 'RemovePending(0)'; }
}

class StageImageCmd {
    check() { return true; }
    run(model, real) {
        real.stageImage('img_' + Date.now());
        model.stagedCount += 1;
    }
    toString() { return 'StageImage()'; }
}

class UnstageImageCmd {
    check(model) { return model.stagedCount > 0; }
    run(model, real) {
        real.unstageImage(0);
        model.stagedCount -= 1;
    }
    toString() { return 'UnstageImage()'; }
}

class PendingDeliveredCmd {
    check(model) { return model.pendingCount > 0; }
    run(model, real) {
        real.handleMessage({
            type: 'pending_delivered',
            comments: [...real.pendingQueue],
            images: [],
        });
        model.messageCount += 1;
        model.pendingCount = 0;
        model.pendingImageCount = 0;
    }
    toString() { return 'PendingDelivered()'; }
}

// ── Arbitraries ─────────────────────────────────────────

const requestSeqs = [1, 2, 3];
const texts = ['hello', 'fix this', 'looks good'];

const allCommands = [
    fc.constantFrom(...requestSeqs).map((n) => new FeedbackRequestCmd(n)),
    fc.constant(new FeedbackResponseCmd()),
    fc.constantFrom(...texts).map(t => new QueuePendingCmd(t)),
    fc.constant(new QueuePendingWithImageCmd()),
    fc.constant(new ClearPendingCmd()),
    fc.constant(new EditPendingCmd()),
    fc.constant(new RemovePendingCmd()),
    fc.constant(new StageImageCmd()),
    fc.constant(new UnstageImageCmd()),
    fc.constant(new PendingDeliveredCmd()),
];

const commandArb = fc.commands(allCommands, { maxCommands: 50 });

// ── Properties ──────────────────────────────────────────

describe('model-based properties', () => {
    it('P1: pending queue length matches model', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            assert.strictEqual(real.pendingQueue.length, model.pendingCount,
                `real=${real.pendingQueue.length} model=${model.pendingCount}`);
        }), { numRuns: 300 });
    });

    it('P2: staged images count matches model', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            assert.strictEqual(real.stagedImages.length, model.stagedCount,
                `staged real=${real.stagedImages.length} model=${model.stagedCount}`);
        }), { numRuns: 300 });
    });

    it('P3: getUIState is consistent with panel mode', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            const ui = real.getUIState();
            assert.strictEqual(ui.inputVisible, true);
            if (real.sessionQueue.length > 0) {
                assert.strictEqual(ui.buttonMode, 'send');
                assert.strictEqual(ui.isWaiting, true);
            } else {
                assert.strictEqual(ui.buttonMode, 'queue');
            }
        }), { numRuns: 300 });
    });

    it('P4: all handleMessage returns are arrays or objects with commands', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
        }), { numRuns: 300 });
    });

    it('P5: serialize/deserialize preserves essential state', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);

            const data = real.serialize();
            const restored = new PanelState();
            restored.deserialize(data);

            assert.strictEqual(restored.pendingQueue.length, real.pendingQueue.length);
            assert.strictEqual(restored.sessionQueue.length, real.sessionQueue.length);
            assert.strictEqual(restored.stagedImages.length, real.stagedImages.length);
        }), { numRuns: 200 });
    });
});
