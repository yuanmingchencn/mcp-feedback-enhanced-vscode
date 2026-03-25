/**
 * Tests for hook scripts (session-start.js, consume-pending.js).
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

describe('consume-pending hook', () => {
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
        const result = runHook('consume-pending.js', {
            hook_event_name: 'preToolUse',
            tool_name: 'Shell',
            workspace_roots: [],
        });
        assert.ok(!result.permission || result.permission !== 'deny');
    });
});

after(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
