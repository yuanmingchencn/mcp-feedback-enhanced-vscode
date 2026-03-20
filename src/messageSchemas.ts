/**
 * Zod schemas for all WebSocket messages in the MCP Feedback Enhanced system.
 * Flat model — no conversation_id in the protocol.
 */

import { z } from 'zod';

// ─── 1. Incoming to Extension (from MCP Server) ──────────────────────────────

export const RegisterSchema = z.object({
    type: z.literal('register'),
    clientType: z.enum(['mcp-server', 'webview']),
});

export const FeedbackRequestSchema = z.object({
    type: z.literal('feedback_request'),
    session_id: z.string().min(1),
    summary: z.string().min(1),
    project_directory: z.string().optional(),
});

// ─── 2. Incoming to Extension (from Webview) ────────────────────────────────

export const FeedbackResponseSchema = z.object({
    type: z.literal('feedback_response'),
    session_id: z.string().min(1),
    feedback: z.string(),
    images: z.array(z.string()).optional(),
});

export const QueuePendingSchema = z.object({
    type: z.literal('queue-pending'),
    comments: z.array(z.string()),
    images: z.array(z.string()).optional(),
});

export const DismissFeedbackSchema = z.object({
    type: z.literal('dismiss_feedback'),
    session_id: z.string().min(1),
});

export const GetStateSchema = z.object({
    type: z.literal('get_state'),
});

// ─── 3. Outgoing from Extension (to Webview) ───────────────────────────────

export const SessionUpdatedOutSchema = z.object({
    type: z.literal('session_updated'),
    session_info: z.object({
        session_id: z.string().min(1),
        summary: z.string(),
    }),
});

export const FeedbackSubmittedOutSchema = z.object({
    type: z.literal('feedback_submitted'),
    session_id: z.string().min(1),
    feedback: z.string().optional(),
});

export const PendingDeliveredOutSchema = z.object({
    type: z.literal('pending_delivered'),
    comments: z.array(z.string()),
    images: z.array(z.string()).optional(),
});

export const PendingSyncedOutSchema = z.object({
    type: z.literal('pending_synced'),
    comments: z.array(z.string()),
    images: z.array(z.string()).optional(),
});

export const StateSyncOutSchema = z.object({
    type: z.literal('state_sync'),
    messages: z.array(z.object({
        role: z.enum(['ai', 'user', 'system']),
        content: z.string(),
        timestamp: z.string(),
        session_id: z.string().optional(),
        images: z.array(z.string()).optional(),
        pending_delivered: z.boolean().optional(),
    })),
    pending_comments: z.array(z.string()),
    pending_images: z.array(z.string()),
});

// ─── 4. Hook output schemas (for contract tests) ───────────────────────────

export const PreToolUseOutputSchema = z.discriminatedUnion('decision', [
    z.object({ decision: z.literal('allow') }),
    z.object({ decision: z.literal('deny'), reason: z.string().min(1) }),
]);

export const BeforeShellOutputSchema = z.union([
    z.object({}),
    z.object({
        permission: z.literal('deny'),
        user_message: z.string().min(1),
        agent_message: z.string().min(1),
    }),
]);

// ─── 5. Helper function for validation ──────────────────────────────────────

export function validateMessage<T extends z.ZodType>(
    schema: T,
    data: unknown,
    context: string
): z.infer<T> | null {
    const result = schema.safeParse(data);
    if (!result.success) {
        console.warn(
            `[MCP Feedback] Invalid ${context}:`,
            result.error.issues.map((i) => i.message).join(', ')
        );
        return null;
    }
    return result.data;
}
