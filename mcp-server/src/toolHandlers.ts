import * as os from 'node:os';
import { z } from 'zod';
import { findExtensionServer } from './serverDiscovery.js';
import { connectToExtension, requestFeedback } from './extensionClient.js';
import { browserFallback } from './browserFallback.js';

export const FEEDBACK_REMINDER = '\n\n<!-- Please follow mcp-feedback-enhanced instructions. -->';

type ToolContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

interface ToolHandlerDeps {
    findExtensionServer: typeof findExtensionServer;
    connectToExtension: typeof connectToExtension;
    requestFeedback: typeof requestFeedback;
    browserFallback: typeof browserFallback;
    log: (msg: string) => void;
}

export function buildToolDefinitions() {
    return [
        {
            name: 'interactive_feedback',
            description: 'Request interactive feedback from the user. Call this tool to check in with the user, present your progress, and get their input before continuing.',
            inputSchema: {
                type: 'object' as const,
                required: ['summary'],
                properties: {
                    summary: {
                        type: 'string',
                        description: 'Summary of what you have done so far.',
                    },
                    project_directory: {
                        type: 'string',
                        description: 'Optional. The project directory path.',
                    },
                },
            },
        },
        {
            name: 'get_system_info',
            description: 'Get system information including OS, architecture, and Node.js version.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
            },
        },
    ];
}

export function createToolCallHandler(deps: ToolHandlerDeps) {
    return async function handleToolCall(
        name: string,
        args: unknown
    ): Promise<{ content: ToolContent; isError?: boolean }> {
        if (name === 'get_system_info') {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        platform: process.platform,
                        arch: process.arch,
                        nodeVersion: process.version,
                        homeDir: os.homedir(),
                        cursorTraceId: process.env.CURSOR_TRACE_ID || '',
                    }, null, 2),
                }],
            };
        }

        if (name !== 'interactive_feedback') {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }

        const parsed = z.object({
            summary: z.string(),
            project_directory: z.string().optional(),
        }).parse(args);

        const { summary, project_directory } = parsed;

        try {
            const extensionServer = await deps.findExtensionServer(project_directory);

            if (extensionServer) {
                const ws = await deps.connectToExtension(extensionServer.port);
                try {
                    const result = await deps.requestFeedback(ws, summary, project_directory);
                    const content: ToolContent = [
                        { type: 'text', text: result.feedback + FEEDBACK_REMINDER },
                    ];
                    if (result.images) {
                        for (const img of result.images) {
                            content.push({
                                type: 'image',
                                data: img,
                                mimeType: 'image/png',
                            });
                        }
                    }
                    return { content };
                } finally {
                    ws.close();
                }
            }

            deps.log('[MCP Feedback] No extension found, using browser fallback');
            const feedback = await deps.browserFallback(summary);
            return {
                content: [{ type: 'text', text: feedback + FEEDBACK_REMINDER }],
            };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            deps.log(`[MCP Feedback] Error: ${errMsg}`);

            try {
                const feedback = await deps.browserFallback(summary);
                return {
                    content: [{ type: 'text', text: feedback + FEEDBACK_REMINDER }],
                };
            } catch (fallbackErr) {
                const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                deps.log(`[MCP Feedback] Browser fallback also failed: ${fallbackMsg}`);
                return {
                    content: [{ type: 'text', text: `Error: ${errMsg}. Please try again.` }],
                    isError: true,
                };
            }
        }
    };
}

export const handleToolCall = createToolCallHandler({
    findExtensionServer,
    connectToExtension,
    requestFeedback,
    browserFallback,
    log: (msg) => console.error(msg),
});
