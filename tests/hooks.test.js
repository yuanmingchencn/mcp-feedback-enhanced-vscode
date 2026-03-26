/**
 * Tests for hook scripts (consume-pending.js).
 *
 * Run with: node --test tests/hooks.test.js
 *
 * HOME is overridden to a temp dir for test isolation.
 * No server is started — tests validate hook output format and source contracts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
process.env.HOME = tmpHome;

const hookDir = path.join(__dirname, '..', 'scripts', 'hooks');

function runHook(scriptName, input) {
    const scriptPath = path.join(hookDir, scriptName);
    const result = execFileSync('node', [scriptPath], {
        input: JSON.stringify(input),
        env: { ...process.env, HOME: tmpHome },
        timeout: 5000,
    });
    return JSON.parse(result.toString());
}

function readState() {
    const f = path.join(tmpHome, '.config', 'mcp-feedback-enhanced', 'feedback-state.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {};
}

function writeState(state) {
    const dir = path.join(tmpHome, '.config', 'mcp-feedback-enhanced');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'feedback-state.json'), JSON.stringify(state));
}

describe('consume-pending hook', () => {
    it('allows allowlisted tools', () => {
        const result = runHook('consume-pending.js', {
            tool_name: 'interactive_feedback',
            workspace_roots: ['/test/workspace'],
        });
        assert.ok(!result.permission);
    });

    it('allows passthrough tools', () => {
        const result = runHook('consume-pending.js', {
            tool_name: 'read',
            workspace_roots: ['/test/workspace'],
        });
        assert.ok(!result.permission);
    });

    it('pending URL uses global path (no conversation_id in path)', () => {
        const hookSrc = fs.readFileSync(path.join(hookDir, 'consume-pending.js'), 'utf-8');
        assert.ok(hookSrc.includes("/pending?consume=1'"), 'Should use global /pending URL');
    });

    it('does not require conversation_id to run', () => {
        const result = runHook('consume-pending.js', {
            tool_name: 'Shell',
            workspace_roots: [],
        });
        assert.ok(!result.permission || result.permission !== 'deny');
    });

    it('tracks tool call count in state', () => {
        writeState({});
        runHook('consume-pending.js', { tool_name: 'Shell', workspace_roots: [] });
        const state = readState();
        assert.equal(state.toolsSinceFeedback, 1);
    });

    it('resets counter for interactive_feedback', () => {
        writeState({ toolsSinceFeedback: 5 });
        runHook('consume-pending.js', { tool_name: 'interactive_feedback', workspace_roots: [] });
        const state = readState();
        assert.equal(state.toolsSinceFeedback, 0);
        assert.ok(state.lastFeedbackAt > 0);
    });
});

describe('feedback enforcement', () => {
    it('denies after exceeding maxToolCalls (default 15)', () => {
        writeState({ toolsSinceFeedback: 14 });
        const result = runHook('consume-pending.js', { tool_name: 'Shell', workspace_roots: [] });
        assert.equal(result.permission, 'deny');
        assert.ok(result.agent_message.includes('re-read'));
    });

    it('allows when under maxToolCalls', () => {
        writeState({ toolsSinceFeedback: 5 });
        const result = runHook('consume-pending.js', { tool_name: 'Shell', workspace_roots: [] });
        assert.ok(!result.permission);
    });

    it('resets counter after enforcement deny (one-shot)', () => {
        writeState({ toolsSinceFeedback: 14 });
        runHook('consume-pending.js', { tool_name: 'Shell', workspace_roots: [] });
        const state = readState();
        assert.equal(state.toolsSinceFeedback, 0);

        const retry = runHook('consume-pending.js', { tool_name: 'Shell', workspace_roots: [] });
        assert.ok(!retry.permission);
    });

    it('denies after time threshold exceeded', () => {
        writeState({
            toolsSinceFeedback: 0,
            lastFeedbackAt: Date.now() - 600000,
        });
        const result = runHook('consume-pending.js', { tool_name: 'Shell', workspace_roots: [] });
        assert.equal(result.permission, 'deny');
        assert.ok(result.agent_message.includes('re-read'));
    });

    it('respects custom config', () => {
        const configDir = path.join(tmpHome, '.config', 'mcp-feedback-enhanced');
        fs.writeFileSync(path.join(configDir, 'enforcement-config.json'), JSON.stringify({ maxToolCalls: 3 }));
        writeState({ toolsSinceFeedback: 2 });

        const result = runHook('consume-pending.js', { tool_name: 'Shell', workspace_roots: [] });
        assert.equal(result.permission, 'deny');

        fs.unlinkSync(path.join(configDir, 'enforcement-config.json'));
    });
});

after(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
