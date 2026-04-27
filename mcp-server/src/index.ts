#!/usr/bin/env node
/**
 * MCP Feedback Enhanced Server.
 *
 * Tools:
 * - interactive_feedback: Request feedback from user
 * - get_system_info: Return system information
 *
 * Routing: project_directory → hash lookup in servers/<hash>.json, single server fallback.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildToolDefinitions, handleToolCall } from './toolHandlers.js';
import { registerPostFeedbackHook } from './postFeedbackHooks.js';

import { memosHook } from './hooks/memos.js';
registerPostFeedbackHook(memosHook);

// ─── MCP Server Setup ─────────────────────────────────────

const server = new Server(
    { name: 'mcp-feedback-enhanced', version: '2.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefinitions(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args);
});

// ─── Start ────────────────────────────────────────────────

try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP Feedback] Server started');
} catch (err) {
    console.error('[MCP Feedback] Fatal error:', err);
    process.exit(1);
}
