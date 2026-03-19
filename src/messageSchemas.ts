/**
 * Zod schemas for all WebSocket messages in the MCP Feedback Enhanced system.
 * Used for runtime validation of incoming/outgoing messages.
 */

import { z } from 'zod';

// ─── 1. Incoming to Extension (from MCP Server) ──────────────────────────────

export const RegisterSchema = z.object({
    type: z.literal('register'),
    clientType: z.enum(['mcp-server', 'webview']),
    projectPath: z.string().optional(),
});

export const FeedbackRequestSchema = z.object({
    type: z.literal('feedback_request'),
    session_id: z.string().min(1),
    conversation_id: z.string().min(1),
    summary: z.string().min(1),
    label: z.string().optional(),
    project_directory: z.string().optional(),
});

// ─── 2. Incoming to Extension (from Webview) ────────────────────────────────

export const FeedbackResponseSchema = z.object({
    type: z.literal('feedback_response'),
    session_id: z.string().min(1),
    conversation_id: z.string().optional(),
    feedback: z.string(),
    images: z.array(z.string()).optional(),
});

export const QueuePendingSchema = z.object({
    type: z.literal('queue-pending'),
    conversation_id: z.string().min(1),
    comments: z.array(z.string()),
    images: z.array(z.string()).optional(),
});

export const LoadConversationSchema = z.object({
    type: z.literal('load_conversation'),
    conversation_id: z.string().min(1),
});

export const CloseTabSchema = z.object({
    type: z.literal('close_tab'),
    conversation_id: z.string().min(1),
});

export const DismissFeedbackSchema = z.object({
    type: z.literal('dismiss_feedback'),
    session_id: z.string().min(1),
});

// ─── 3. Outgoing from Extension (to Webview) ───────────────────────────────

export const SessionUpdatedOutSchema = z.object({
    type: z.literal('session_updated'),
    session_info: z.object({
        session_id: z.string().min(1),
        conversation_id: z.string().min(1),
        summary: z.string(),
        model: z.string().optional(),
        label: z.string().min(1), // REQUIRED - never UUID
    }),
});

export const SessionEndedOutSchema = z.object({
    type: z.literal('session_ended'),
    conversation_id: z.string().min(1),
});

export const ConversationsListOutSchema = z.object({
    type: z.literal('conversations_list'),
    conversations: z.array(
        z.object({
            conversation_id: z.string().min(1),
            label: z.string(),
            model: z.string(),
            state: z.enum(['idle', 'running', 'waiting', 'ended', 'archived']),
            active_session_id: z.string().nullable(),
        })
    ),
});

export const ConversationLoadedOutSchema = z.object({
    type: z.literal('conversation_loaded'),
    conversation: z.object({
        conversation_id: z.string().min(1),
        label: z.string(),
        model: z.string(),
        state: z.enum(['idle', 'running', 'waiting', 'ended', 'archived']),
        messages: z.array(
            z.object({
                role: z.enum(['ai', 'user', 'system']),
                content: z.string(),
                timestamp: z.string(),
                session_id: z.string().optional(),
                images: z.array(z.string()).optional(),
                pending_delivered: z.boolean().optional(),
            })
        ),
        pending_queue: z.array(z.string()),
    }),
});

export const PendingDeliveredOutSchema = z.object({
    type: z.literal('pending_delivered'),
    conversation_id: z.string().min(1),
    comments: z.array(z.string()),
    images: z.array(z.string()).optional(),
});

export const PendingSyncedOutSchema = z.object({
    type: z.literal('pending_synced'),
    conversation_id: z.string().min(1),
    comments: z.array(z.string()),
    images: z.array(z.string()).optional(),
});

export const FeedbackSubmittedOutSchema = z.object({
    type: z.literal('feedback_submitted'),
    conversation_id: z.string().min(1),
    feedback: z.string(),
});

export const SessionRegisteredOutSchema = z.object({
    type: z.literal('session_registered'),
    session: z.object({
        conversation_id: z.string().min(1),
        model: z.string().optional(),
    }),
    conversation: z
        .object({
            conversation_id: z.string().min(1),
            label: z.string(),
            model: z.string(),
            state: z.enum(['idle', 'running', 'waiting', 'ended', 'archived']),
            messages: z.array(z.any()).optional(),
        })
        .optional(),
});

export const TabClosedOutSchema = z.object({
    type: z.literal('tab_closed'),
    conversation_id: z.string().min(1),
});

// ─── 4. Simple messages ────────────────────────────────────────────────────

export const PingSchema = z.object({ type: z.literal('ping') });
export const PongSchema = z.object({ type: z.literal('pong') });
export const HeartbeatSchema = z.object({ type: z.literal('heartbeat') });
export const GetConversationsSchema = z.object({
    type: z.literal('get_conversations'),
});
export const GetSessionsSchema = z.object({ type: z.literal('get_sessions') });

// ─── 5. Hook schemas ───────────────────────────────────────────────────────

export const HookInputSchema = z.object({
    hook_event_name: z.enum([
        'sessionStart',
        'stop',
        'preToolUse',
        'beforeShellExecution',
        'beforeMCPExecution',
        'subagentStart',
    ]),
    conversation_id: z.string().optional(),
    model: z.string().optional(),
    tool_name: z.string().optional(),
    workspace_roots: z.array(z.string()).optional(),
    loop_count: z.number().optional(),
});

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

// ─── 6. Discriminated union for incoming messages ───────────────────────────

export const IncomingMessageSchema = z.discriminatedUnion('type', [
    RegisterSchema,
    FeedbackRequestSchema,
    FeedbackResponseSchema,
    QueuePendingSchema,
    LoadConversationSchema,
    CloseTabSchema,
    DismissFeedbackSchema,
    PingSchema,
    HeartbeatSchema,
    GetConversationsSchema,
    GetSessionsSchema,
]);

// ─── 7. Helper function for validation ──────────────────────────────────────

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

// generatePanelValidators removed — panel.html now uses PanelState.handleMessage() directly.
