/**
 * Tests for hook scripts (session-start.js, consume-pending.js).
 *
 * Run with: node --test tests/hooks.test.js
 *
 * HOME is overridden to a temp dir for test isolation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
process.env.HOME = tmpHome;

const { FeedbackWSServer } = require('../out/wsServer');

const hookDir = path.join(__dirname, '..', 'scripts', 'hooks');

function runHook(scriptName, input, extraEnv) {
    const scriptPath = path.join(hookDir, scriptName);
    const result = execFileSync('node', [scriptPath], {
        input: JSON.stringify(input),
        env: { ...process.env, HOME: tmpHome, ...extraEnv },
        timeout: 5000,
    });
    return JSON.parse(result.toString());
}

let server;
let serverPort;

describe('session-start hook', () => {
    before(async () => {
        server = new FeedbackWSServer();
        server.setWorkspaces(['/test/workspace']);
        serverPort = await server.start();
    });

    after(async () => { if (server) await server.stop(); });

    it('returns continue: true for sessionStart event', () => {
        const result = runHook('session-start.js', {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-test',
            workspace_roots: ['/test/workspace'],
            model: 'gpt-4',
        });
        assert.strictEqual(result.continue, true);
    });

    it('includes USAGE RULES in additional_context', () => {
        const result = runHook('session-start.js', {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-test',
            workspace_roots: ['/test/workspace'],
        });
        assert.ok(result.additional_context);
        assert.ok(result.additional_context.includes('USAGE RULES'));
        assert.ok(result.additional_context.includes('interactive_feedback'));
    });

    it('does not include conversation_id injection', () => {
        const result = runHook('session-start.js', {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-test',
            workspace_roots: ['/test/workspace'],
        });
        assert.ok(!result.additional_context.includes('Your conversation ID'));
        assert.ok(!result.additional_context.includes('pass conversation_id'));
    });

    it('does not set MCP_FEEDBACK_SERVER_PID env', () => {
        const result = runHook('session-start.js', {
            hook_event_name: 'sessionStart',
            conversation_id: 'conv-test',
            workspace_roots: ['/test/workspace'],
        });
        assert.ok(!result.env || !result.env.MCP_FEEDBACK_SERVER_PID);
    });

    it('pending URL uses global path (no conversation_id in path)', () => {
        // Verify hook code doesn't include conversation_id in HTTP URL
        const hookSrc = fs.readFileSync(path.join(hookDir, 'session-start.js'), 'utf-8');
        assert.ok(hookSrc.includes("/pending?consume=1'"), 'Should use global /pending URL');
        assert.ok(!hookSrc.includes('/pending/' + 'encodeURIComponent'), 'Should NOT have conversation_id in URL');
    });

    it('passes through non-sessionStart events', () => {
        const result = runHook('session-start.js', {
            hook_event_name: 'stop',
            conversation_id: 'conv-test',
        });
        assert.strictEqual(result.continue, true);
        assert.ok(!result.additional_context);
    });
});

describe('consume-pending hook', () => {
    before(async () => {
        if (server) { await server.stop(); server = null; }
        server = new FeedbackWSServer();
        server.setWorkspaces(['/test/workspace']);
        serverPort = await server.start();
    });

    after(async () => { if (server) { await server.stop(); server = null; } });

    it('allows allowlisted tools', () => {
        const result = runHook('consume-pending.js', {
            hook_event_name: 'preToolUse',
            tool_name: 'interactive_feedback',
            workspace_roots: ['/test/workspace'],
        });
        assert.ok(!result.permission);
    });

    it('allows passthrough tools', () => {
        const result = runHook('consume-pending.js', {
            hook_event_name: 'preToolUse',
            tool_name: 'read',
            workspace_roots: ['/test/workspace'],
        });
        assert.ok(!result.permission);
    });

    it('pending URL uses global path (no conversation_id in path)', () => {
        const hookSrc = fs.readFileSync(path.join(hookDir, 'consume-pending.js'), 'utf-8');
        assert.ok(hookSrc.includes("/pending?consume=1'"), 'Should use global /pending URL');
        assert.ok(!hookSrc.includes('/pending/' + 'encodeURIComponent'), 'Should NOT have conversation_id in URL');
    });

    it('does not require conversation_id to run', () => {
        // No conversation_id guard anymore
        const result = runHook('consume-pending.js', {
            hook_event_name: 'preToolUse',
            tool_name: 'Shell',
            workspace_roots: [],
        });
        // Should pass through (no server found = no pending = allow)
        assert.ok(!result.permission || result.permission !== 'deny');
    });
});

// ─── Cleanup ──────────────────────────────────────────────

after(async () => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
