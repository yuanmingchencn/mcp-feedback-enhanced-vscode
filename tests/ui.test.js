/**
 * UI rendering tests for the flat model.
 * Tests that command output from PanelState contains correct render targets.
 *
 * Run with: node --test tests/ui.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PanelState } = require('../static/panelState.js');

function hasCmd(cmds, type, pred) {
    const list = Array.isArray(cmds) ? cmds : (cmds.commands || []);
    return list.some(c => c.type === type && (!pred || pred(c)));
}

function hasRender(cmds, target) {
    return hasCmd(cmds, 'render', c => c.targets.includes(target));
}

function hasDom(cmds, action) {
    return hasCmd(cmds, 'dom', c => c.action === action);
}

function hasNotify(cmds) {
    return hasCmd(cmds, 'notify');
}

describe('UI: session_updated renders', () => {
    it('renders messages and input on session_updated', () => {
        const p = new PanelState();
        const cmds = p.handleMessage({
            type: 'session_updated',
            summary: 'Task',
        });
        const list = Array.isArray(cmds) ? cmds : cmds.commands;
        assert.ok(hasRender(list, 'messages'));
        assert.ok(hasRender(list, 'input'));
    });

    it('notifies on new session', () => {
        const p = new PanelState();
        const cmds = p.handleMessage({
            type: 'session_updated',
            summary: 'Task',
        });
        const list = Array.isArray(cmds) ? cmds : cmds.commands;
        assert.ok(hasNotify(list));
    });
});

describe('UI: feedback_submitted renders', () => {
    it('renders messages and input on feedback_submitted', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        const cmds = p.handleMessage({
            type: 'feedback_submitted',
            feedback: 'ok',
        });
        assert.ok(hasRender(cmds, 'messages'));
        assert.ok(hasRender(cmds, 'input'));
        assert.ok(hasDom(cmds, 'save_state'));
    });
});

describe('UI: pending renders', () => {
    it('renders pending section on addToPending', () => {
        const p = new PanelState();
        const cmds = p.addToPending('msg', []);
        assert.ok(hasRender(cmds, 'pending'));
    });

    it('renders pending on clearPending', () => {
        const p = new PanelState();
        p.addToPending('msg', []);
        const cmds = p.clearPending();
        assert.ok(hasRender(cmds, 'pending'));
    });

    it('renders pending on editPending', () => {
        const p = new PanelState();
        p.addToPending('msg', []);
        const cmds = p.editPending(0);
        assert.ok(hasRender(cmds, 'pending'));
    });
});

describe('UI: staged images', () => {
    it('renders staged_images on stageImage', () => {
        const p = new PanelState();
        const cmds = p.stageImage('img');
        assert.ok(hasRender(cmds, 'staged_images'));
    });

    it('renders staged_images on unstageImage', () => {
        const p = new PanelState();
        p.stageImage('img');
        const cmds = p.unstageImage(0);
        assert.ok(hasRender(cmds, 'staged_images'));
    });
});

describe('UI: state_sync renders', () => {
    it('renders messages, pending, and input on state_sync', () => {
        const p = new PanelState();
        const cmds = p.handleMessage({
            type: 'state_sync',
            messages: [{ role: 'ai', content: 'hi', timestamp: '' }],
            pending_comments: [],
            pending_images: [],
            feedback_queue_size: 0,
        });
        assert.ok(hasRender(cmds, 'messages'));
        assert.ok(hasRender(cmds, 'pending'));
        assert.ok(hasRender(cmds, 'input'));
    });
});

describe('UI: button mode', () => {
    it('shows Queue button when idle', () => {
        const p = new PanelState();
        const ui = p.getUIState();
        assert.strictEqual(ui.buttonMode, 'queue');
        assert.strictEqual(ui.inputVisible, true);
    });

    it('shows Send button when waiting', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        const ui = p.getUIState();
        assert.strictEqual(ui.buttonMode, 'send');
    });

    it('shows Queue button when running', () => {
        const p = new PanelState();
        p.messages.push({ role: 'user', content: 'sent', timestamp: '' });
        const ui = p.getUIState();
        assert.strictEqual(ui.buttonMode, 'queue');
        assert.strictEqual(ui.isRunning, true);
    });
});

describe('UI: input always visible', () => {
    it('input is visible in idle state', () => {
        const p = new PanelState();
        assert.strictEqual(p.getUIState().inputVisible, true);
    });

    it('input is visible in waiting state', () => {
        const p = new PanelState();
        p.sessionQueue.push({ summary: '' });
        assert.strictEqual(p.getUIState().inputVisible, true);
    });

    it('input is visible in running state', () => {
        const p = new PanelState();
        p.messages.push({ role: 'user', content: 'x', timestamp: '' });
        assert.strictEqual(p.getUIState().inputVisible, true);
    });
});
