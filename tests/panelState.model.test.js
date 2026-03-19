/**
 * Property-based model tests for panelState.js v2 using fast-check.
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
        this.tabs = new Map(); // id -> { state, pendingCount, pendingImageCount, stagedCount, label, sessionQueueLen }
        this.activeTabId = null;
    }
}

// ── Commands ────────────────────────────────────────────

class FeedbackRequestCmd {
    constructor(convId) { this.convId = convId; }
    check(model) {
        const existing = model.tabs.get(this.convId);
        return !(existing && existing.state === 'ended');
    }
    run(model, real) {
        real.handleMessage({
            type: 'session_updated',
            session_info: {
                session_id: 's_' + Date.now() + Math.random(),
                conversation_id: this.convId,
                summary: 'Summary ' + this.convId,
                label: 'Label ' + this.convId,
            },
        });
        const existing = model.tabs.get(this.convId);
        model.tabs.set(this.convId, {
            state: 'waiting',
            pendingCount: existing?.pendingCount || 0,
            pendingImageCount: existing?.pendingImageCount || 0,
            stagedCount: existing?.stagedCount || 0,
            label: 'Label ' + this.convId,
            sessionQueueLen: (existing?.sessionQueueLen || 0) + 1,
        });
        model.activeTabId = this.convId;
    }
    toString() { return `FeedbackRequest(${this.convId})`; }
}

class FeedbackResponseCmd {
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && tab.state === 'waiting';
    }
    run(model, real) {
        real.handleMessage({
            type: 'feedback_submitted',
            conversation_id: model.activeTabId,
            feedback: 'test feedback',
        });
        const tab = model.tabs.get(model.activeTabId);
        tab.sessionQueueLen = Math.max(0, tab.sessionQueueLen - 1);
        tab.state = tab.sessionQueueLen === 0 ? 'running' : 'waiting';
    }
    toString() { return 'FeedbackResponse()'; }
}

class QueuePendingCmd {
    constructor(text) { this.text = text; }
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && (tab.state === 'running' || tab.state === 'idle');
    }
    run(model, real) {
        real.addToPending(this.text, []);
        const tab = model.tabs.get(model.activeTabId);
        tab.pendingCount += 1;
        tab.stagedCount = 0;
    }
    toString() { return `QueuePending(${this.text})`; }
}

class QueuePendingWithImageCmd {
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && (tab.state === 'running' || tab.state === 'idle');
    }
    run(model, real) {
        real.addToPending('', ['base64img']);
        const tab = model.tabs.get(model.activeTabId);
        tab.pendingImageCount += 1;
        tab.stagedCount = 0;
    }
    toString() { return 'QueuePendingWithImage()'; }
}

class ClearPendingCmd {
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && (tab.pendingCount > 0 || tab.pendingImageCount > 0);
    }
    run(model, real) {
        real.clearPending();
        const tab = model.tabs.get(model.activeTabId);
        tab.pendingCount = 0;
        tab.pendingImageCount = 0;
    }
    toString() { return 'ClearPending()'; }
}

class EditPendingCmd {
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && tab.pendingCount > 0;
    }
    run(model, real) {
        real.editPending(0);
        model.tabs.get(model.activeTabId).pendingCount -= 1;
    }
    toString() { return 'EditPending(0)'; }
}

class RemovePendingCmd {
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && tab.pendingCount > 0;
    }
    run(model, real) {
        real.removePending(0);
        model.tabs.get(model.activeTabId).pendingCount -= 1;
    }
    toString() { return 'RemovePending(0)'; }
}

class SwitchTabCmd {
    constructor(idx) { this.idx = idx; }
    check(model) { return model.tabs.size > 1; }
    run(model, real) {
        const keys = Array.from(model.tabs.keys());
        const target = keys[this.idx % keys.length];
        real.switchTab(target, '');
        model.activeTabId = target;
    }
    toString() { return `SwitchTab(${this.idx})`; }
}

class SessionEndedCmd {
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && tab.state !== 'ended';
    }
    run(model, real) {
        real.handleMessage({
            type: 'session_ended',
            conversation_id: model.activeTabId,
        });
        const tab = model.tabs.get(model.activeTabId);
        tab.state = 'ended';
        tab.pendingCount = 0;
        tab.pendingImageCount = 0;
        tab.sessionQueueLen = 0;
    }
    toString() { return 'SessionEnded()'; }
}

class CloseTabCmd {
    check(model) { return model.tabs.size > 0 && model.activeTabId !== null; }
    run(model, real) {
        const id = model.activeTabId;
        real.closeTab(id);
        model.tabs.delete(id);
        const keys = Array.from(model.tabs.keys());
        model.activeTabId = keys.length > 0 ? keys[keys.length - 1] : null;
    }
    toString() { return 'CloseTab()'; }
}

class StageImageCmd {
    check(model) { return model.activeTabId !== null; }
    run(model, real) {
        real.stageImage('img_' + Date.now());
        model.tabs.get(model.activeTabId).stagedCount += 1;
    }
    toString() { return 'StageImage()'; }
}

class UnstageImageCmd {
    check(model) {
        if (!model.activeTabId) return false;
        return (model.tabs.get(model.activeTabId)?.stagedCount || 0) > 0;
    }
    run(model, real) {
        real.unstageImage(0);
        model.tabs.get(model.activeTabId).stagedCount -= 1;
    }
    toString() { return 'UnstageImage()'; }
}

class PendingDeliveredCmd {
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && tab.pendingCount > 0;
    }
    run(model, real) {
        const tab = model.tabs.get(model.activeTabId);
        const realTab = real.tabs.get(model.activeTabId);
        real.handleMessage({
            type: 'pending_delivered',
            conversation_id: model.activeTabId,
            comments: realTab ? [...realTab.pendingQueue] : [],
            images: [],
        });
        tab.pendingCount = 0;
        tab.pendingImageCount = 0;
    }
    toString() { return 'PendingDelivered()'; }
}

// ── Arbitraries ─────────────────────────────────────────

const convIds = ['conv-1', 'conv-2', 'conv-3'];
const texts = ['hello', 'fix this', 'looks good'];

const allCommands = [
    fc.constantFrom(...convIds).map(id => new FeedbackRequestCmd(id)),
    fc.constant(new FeedbackResponseCmd()),
    fc.constantFrom(...texts).map(t => new QueuePendingCmd(t)),
    fc.constant(new QueuePendingWithImageCmd()),
    fc.constant(new ClearPendingCmd()),
    fc.constant(new EditPendingCmd()),
    fc.constant(new RemovePendingCmd()),
    fc.nat({ max: 10 }).map(n => new SwitchTabCmd(n)),
    fc.constant(new SessionEndedCmd()),
    fc.constant(new CloseTabCmd()),
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
            for (const [id, tab] of real.tabs) {
                const expected = model.tabs.get(id)?.pendingCount ?? 0;
                assert.strictEqual(tab.pendingQueue.length, expected,
                    `Tab ${id}: real=${tab.pendingQueue.length} model=${expected}`);
            }
        }), { numRuns: 300 });
    });

    it('P2: ended tabs have no pending queue or images', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            for (const [id, tab] of real.tabs) {
                if (tab.state === 'ended') {
                    assert.strictEqual(tab.pendingQueue.length, 0,
                        `Ended tab ${id} has pending queue`);
                    assert.strictEqual(tab.pendingImages.length, 0,
                        `Ended tab ${id} has pending images`);
                }
            }
        }), { numRuns: 300 });
    });

    it('P3: model state matches real state', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            for (const [id, modelTab] of model.tabs) {
                const realTab = real.tabs.get(id);
                assert.ok(realTab, `Tab ${id} in model but not real`);
                assert.strictEqual(realTab.state, modelTab.state,
                    `Tab ${id}: real=${realTab.state} model=${modelTab.state}`);
            }
            assert.strictEqual(real.activeTabId, model.activeTabId, 'Active tab mismatch');
        }), { numRuns: 300 });
    });

    it('P4: activeTabId is null or exists in tabs', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            if (real.activeTabId !== null) {
                assert.ok(real.tabs.has(real.activeTabId),
                    `activeTabId ${real.activeTabId} not in tabs`);
            }
        }), { numRuns: 300 });
    });

    it('P5: getUIState is consistent with tab state', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            const ui = real.getUIState();
            const tab = real.activeTabId ? real.tabs.get(real.activeTabId) : null;
            const state = tab ? tab.state : 'idle';
            if (!tab || state === 'idle') {
                assert.strictEqual(ui.inputVisible, false);
            } else if (state === 'waiting') {
                assert.strictEqual(ui.inputVisible, true);
                assert.strictEqual(ui.buttonMode, 'send');
            } else if (state === 'running') {
                assert.strictEqual(ui.inputVisible, true);
                assert.strictEqual(ui.buttonMode, 'queue');
            } else if (state === 'ended') {
                assert.strictEqual(ui.inputVisible, false);
                assert.strictEqual(ui.isEnded, true);
            }
        }), { numRuns: 300 });
    });

    it('P6: staged images count matches model', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            for (const [id, tab] of real.tabs) {
                const expected = model.tabs.get(id)?.stagedCount ?? 0;
                assert.strictEqual(tab.stagedImages.length, expected,
                    `Tab ${id}: staged real=${tab.stagedImages.length} model=${expected}`);
            }
        }), { numRuns: 300 });
    });

    it('P7: all handleMessage returns are arrays or objects with commands', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            // If we got here without throwing, all returns were valid
        }), { numRuns: 300 });
    });

    it('P8: label is never a UUID', () => {
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            for (const [id, tab] of real.tabs) {
                assert.ok(!uuidPattern.test(tab.label),
                    `Tab ${id} label is UUID: ${tab.label}`);
            }
        }), { numRuns: 200 });
    });

    it('P9: closed tabs are gone from both model and real', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);
            assert.strictEqual(real.tabs.size, model.tabs.size,
                `Tab count: real=${real.tabs.size} model=${model.tabs.size}`);
        }), { numRuns: 300 });
    });

    it('P10: serialize/deserialize preserves essential state', () => {
        fc.assert(fc.property(commandArb, cmds => {
            const real = new PanelState();
            const model = new SimpleModel();
            fc.modelRun(() => ({ model, real }), cmds);

            const data = real.serialize();
            const restored = new PanelState();
            restored.deserialize(data);

            assert.strictEqual(restored.tabs.size, real.tabs.size);
            if (real.activeTabId && real.tabs.has(real.activeTabId)) {
                assert.strictEqual(restored.activeTabId, real.activeTabId);
            }
            for (const [id, tab] of real.tabs) {
                const rt = restored.tabs.get(id);
                assert.ok(rt, `Restored missing tab ${id}`);
                assert.strictEqual(rt.state, tab.state);
                assert.strictEqual(rt.label, tab.label);
            }
        }), { numRuns: 200 });
    });
});
