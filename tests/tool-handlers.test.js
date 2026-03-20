/**
 * Unit tests for mcp-server tool handler fallback and error semantics.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

async function loadHandlers() {
    return import('../mcp-server/dist/toolHandlers.js');
}

describe('toolHandlers fallback semantics', () => {
    it('uses browser fallback when extension is unavailable', async () => {
        const { createToolCallHandler } = await loadHandlers();

        const handleToolCall = createToolCallHandler({
            findExtensionServer: async () => null,
            connectToExtension: async () => { throw new Error('should not connect'); },
            requestFeedback: async () => ({ feedback: 'n/a' }),
            browserFallback: async () => 'fallback response',
            log: () => {},
        });

        const res = await handleToolCall('interactive_feedback', {
            summary: 'work item',
        });

        assert.strictEqual(res.isError, undefined);
        assert.ok(String(res.content[0].text).includes('fallback response'));
        assert.ok(String(res.content[0].text).includes('Please follow mcp-feedback-enhanced instructions'));
    });

    it('returns structured error when primary and fallback both fail', async () => {
        const { createToolCallHandler } = await loadHandlers();

        const handleToolCall = createToolCallHandler({
            findExtensionServer: async () => { throw new Error('primary discovery failure'); },
            connectToExtension: async () => { throw new Error('should not connect'); },
            requestFeedback: async () => ({ feedback: 'n/a' }),
            browserFallback: async () => { throw new Error('fallback failed'); },
            log: () => {},
        });

        const res = await handleToolCall('interactive_feedback', {
            summary: 'work item',
        });

        assert.strictEqual(res.isError, true);
        assert.ok(String(res.content[0].text).includes('primary discovery failure'));
    });
});
