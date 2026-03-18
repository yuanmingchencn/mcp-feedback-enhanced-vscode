/**
 * Property-based model tests for panelState.js using fast-check.
 *
 * Run with: node --test tests/panelState.model.test.js
 * Or: npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { PanelState } = require('../static/panelState.js');

// --- Model (simplified state tracker) ---
class SimpleModel {
    constructor() {
        this.tabs = new Map(); // id -> { state, pendingCount, label, hasDraft }
        this.activeTabId = null;
    }
}

// --- Commands ---
class FeedbackRequestCommand {
    constructor(convId) {
        this.convId = convId;
    }
    check(model) {
        // Real system ignores session_updated for ended tabs; model must match
        const existing = model.tabs.get(this.convId);
        if (existing && existing.state === 'ended') return false;
        return true;
    }
    run(model, real) {
        const label = 'Test summary ' + this.convId;
        real.handleMessage({
            type: 'session_updated',
            session_info: {
                session_id: 's_' + Date.now(),
                conversation_id: this.convId,
                summary: label,
                label: label,
            },
        });
        model.tabs.set(this.convId, {
            state: 'waiting',
            pendingCount: 0,
            label: label,
            hasDraft: false,
        });
        model.activeTabId = this.convId;
    }
    toString() {
        return `FeedbackRequest(${this.convId})`;
    }
}

class FeedbackResponseCommand {
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
        tab.state = 'running';
    }
    toString() {
        return 'FeedbackResponse()';
    }
}

class QueuePendingCommand {
    constructor(text) {
        this.text = text;
    }
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && tab.state === 'running';
    }
    run(model, real) {
        real.addToPending(this.text);
        const tab = model.tabs.get(model.activeTabId);
        tab.pendingCount = 1;
    }
    toString() {
        return `QueuePending(${this.text})`;
    }
}

class ClearPendingCommand {
    check(model) {
        if (!model.activeTabId) return false;
        const tab = model.tabs.get(model.activeTabId);
        return tab && tab.pendingCount > 0;
    }
    run(model, real) {
        real.clearPending();
        const tab = model.tabs.get(model.activeTabId);
        tab.pendingCount = 0;
    }
    toString() {
        return 'ClearPending()';
    }
}

class SwitchTabCommand {
    constructor(idx) {
        this.idx = idx;
    }
    check(model) {
        return model.tabs.size > 1;
    }
    run(model, real) {
        const keys = Array.from(model.tabs.keys());
        const target = keys[this.idx % keys.length];
        real.switchTab(target, '');
        model.activeTabId = target;
    }
    toString() {
        return `SwitchTab(${this.idx})`;
    }
}

class SessionEndedCommand {
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
    }
    toString() {
        return 'SessionEnded()';
    }
}

// --- Command arbitraries ---
const convIds = ['conv-1', 'conv-2', 'conv-3'];
const texts = ['hello', 'fix this', 'looks good'];

const allCommands = [
    fc.constantFrom(...convIds).map((id) => new FeedbackRequestCommand(id)),
    fc.constant(new FeedbackResponseCommand()),
    fc.constantFrom(...texts).map((t) => new QueuePendingCommand(t)),
    fc.constant(new ClearPendingCommand()),
    fc.nat({ max: 10 }).map((n) => new SwitchTabCommand(n)),
    fc.constant(new SessionEndedCommand()),
];

const commandArb = fc.commands(allCommands, { maxCommands: 50 });

describe('model-based properties', () => {
    it('Property 1: pending queue length is always 0 or 1', () => {
        fc.assert(
            fc.property(commandArb, (cmds) => {
                const real = new PanelState();
                const model = new SimpleModel();
                const s = () => ({ model, real });
                fc.modelRun(s, cmds);
                for (const [id, tab] of real.tabs) {
                    assert.ok(
                        tab.pendingQueue.length <= 1,
                        `Tab ${id} has ${tab.pendingQueue.length} pending items`
                    );
                }
            }),
            { numRuns: 200 }
        );
    });

    it('Property 2: ended tabs have no pending', () => {
        fc.assert(
            fc.property(commandArb, (cmds) => {
                const real = new PanelState();
                const model = new SimpleModel();
                const s = () => ({ model, real });
                fc.modelRun(s, cmds);
                for (const [id, tab] of real.tabs) {
                    if (tab.state === 'ended') {
                        assert.strictEqual(
                            tab.pendingQueue.length,
                            0,
                            `Tab ${id} ended but has ${tab.pendingQueue.length} pending items`
                        );
                        assert.strictEqual(
                            (tab.pendingImages || []).length,
                            0,
                            `Tab ${id} ended but has pending images`
                        );
                    }
                }
            }),
            { numRuns: 200 }
        );
    });

    it('Property 3: model state matches real state', () => {
        fc.assert(
            fc.property(commandArb, (cmds) => {
                const real = new PanelState();
                const model = new SimpleModel();
                const s = () => ({ model, real });
                fc.modelRun(s, cmds);
                for (const [id, modelTab] of model.tabs) {
                    const realTab = real.tabs.get(id);
                    assert.ok(realTab, `Tab ${id} exists in model but not in real`);
                    assert.strictEqual(
                        realTab.state,
                        modelTab.state,
                        `Tab ${id} state mismatch`
                    );
                }
                assert.strictEqual(
                    real.activeTabId,
                    model.activeTabId,
                    'Active tab mismatch'
                );
            }),
            { numRuns: 200 }
        );
    });

    it('Property 4: label is never a UUID pattern', () => {
        const shortCommandArb = fc.commands(allCommands, { maxCommands: 30 });
        fc.assert(
            fc.property(shortCommandArb, (cmds) => {
                const real = new PanelState();
                const model = new SimpleModel();
                const s = () => ({ model, real });
                fc.modelRun(s, cmds);
                const uuidPattern =
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                for (const [id, tab] of real.tabs) {
                    assert.ok(
                        !uuidPattern.test(tab.label),
                        `Tab ${id} has UUID as label: ${tab.label}`
                    );
                }
            }),
            { numRuns: 200 }
        );
    });

    it('Property 5: getUIState is consistent with tab state', () => {
        const shortCommandArb = fc.commands(allCommands, { maxCommands: 30 });
        fc.assert(
            fc.property(shortCommandArb, (cmds) => {
                const real = new PanelState();
                const model = new SimpleModel();
                const s = () => ({ model, real });
                fc.modelRun(s, cmds);
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
            }),
            { numRuns: 200 }
        );
    });
});
