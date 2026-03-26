/**
 * Compatibility baseline tests for rewrite safety.
 *
 * This suite locks down a few high-risk compatibility contracts so
 * big-bang rewrite work can move fast without accidental protocol drift.
 *
 * Run with: npm run compile && node --test tests/compatibility-baseline.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-baseline-'));
process.env.HOME = tmpHome;

const schemas = require('../out/messageSchemas');

const repoRoot = path.join(__dirname, '..');
const wsHubPath = path.join(repoRoot, 'src', 'server', 'wsHub.ts');
const httpRoutesPath = path.join(repoRoot, 'src', 'server', 'httpRoutes.ts');
const mcpServerPath = path.join(repoRoot, 'mcp-server', 'src', 'index.ts');
const mcpToolHandlersPath = path.join(repoRoot, 'mcp-server', 'src', 'toolHandlers.ts');
const hookPath = path.join(repoRoot, 'scripts', 'hooks', 'consume-pending.js');

describe('protocol schema baseline', () => {
    it('accepts canonical inbound messages', () => {
        schemas.RegisterSchema.parse({ type: 'register', clientType: 'webview' });
        schemas.RegisterSchema.parse({ type: 'register', clientType: 'mcp-server' });
        schemas.FeedbackRequestSchema.parse({ type: 'feedback_request', summary: 'baseline' });
        schemas.FeedbackResponseSchema.parse({ type: 'feedback_response', feedback: 'ok' });
        schemas.QueuePendingSchema.parse({ type: 'queue-pending', comments: ['a', 'b'] });
        schemas.DismissFeedbackSchema.parse({ type: 'dismiss_feedback' });
    });

    it('accepts canonical outbound messages', () => {
        schemas.SessionUpdatedOutSchema.parse({ type: 'session_updated', summary: 'work item' });
        schemas.FeedbackSubmittedOutSchema.parse({ type: 'feedback_submitted', feedback: 'done' });
        schemas.PendingSyncedOutSchema.parse({ type: 'pending_synced', comments: ['x'], images: [] });
        schemas.PendingDeliveredOutSchema.parse({ type: 'pending_delivered', comments: ['x'] });
        schemas.StateSyncOutSchema.parse({
            type: 'state_sync',
            messages: [
                {
                    role: 'ai',
                    content: 'hello',
                    timestamp: '2026-01-01T00:00:00.000Z',
                },
            ],
            pending_comments: [],
            pending_images: [],
            feedback_queue_size: 0,
        });
    });
});

describe('hook output baseline', () => {
    it('accepts preToolUse deny and pass-through shapes', () => {
        schemas.BeforeShellOutputSchema.parse({});
        schemas.BeforeShellOutputSchema.parse({
            permission: 'deny',
            user_message: 'Pending message delivered',
            agent_message: 'Please continue with updated plan',
        });
    });
});

describe('high-risk source contract baseline', () => {
    it('keeps health and pending endpoints in wsHub', () => {
        const wsHubSrc = fs.readFileSync(wsHubPath, 'utf-8');
        const routesSrc = fs.existsSync(httpRoutesPath) ? fs.readFileSync(httpRoutesPath, 'utf-8') : '';
        const merged = `${wsHubSrc}\n${routesSrc}`;

        assert.ok(merged.includes("pathname === '/health'"), 'Expected /health endpoint contract');
        assert.ok(merged.includes("pathname === '/pending'"), 'Expected /pending endpoint contract');
    });

    it('keeps reminder marker available across return paths', () => {
        const mcpSrc = [
            fs.readFileSync(mcpServerPath, 'utf-8'),
            fs.existsSync(mcpToolHandlersPath) ? fs.readFileSync(mcpToolHandlersPath, 'utf-8') : '',
        ].join('\n');
        const hookSrc = fs.readFileSync(hookPath, 'utf-8');

        assert.ok(
            mcpSrc.includes('Please follow mcp-feedback-enhanced instructions'),
            'mcp-server reminder marker missing'
        );
        assert.ok(
            hookSrc.includes('interactive_feedback'),
            'hook reminder marker missing'
        );
    });

    it('keeps reminder append at MCP return boundary', () => {
        const wsHubSrc = fs.readFileSync(wsHubPath, 'utf-8');
        const mcpSrc = [
            fs.readFileSync(mcpServerPath, 'utf-8'),
            fs.existsSync(mcpToolHandlersPath) ? fs.readFileSync(mcpToolHandlersPath, 'utf-8') : '',
        ].join('\n');
        assert.ok(
            !wsHubSrc.includes('Please follow mcp-feedback-enhanced instructions'),
            'wsHub should not append reminder marker in V3 flow'
        );
        assert.ok(
            mcpSrc.includes('FEEDBACK_REMINDER'),
            'mcp-server should own reminder append point'
        );
    });
});

after(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
