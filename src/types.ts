/**
 * Shared type definitions for MCP Feedback Enhanced.
 * conversation_id is the single source of truth for all per-conversation state.
 */

// Tab / conversation states
export type ConversationState = 'idle' | 'running' | 'waiting' | 'ended' | 'archived';

// Persisted conversation data (conversations/<conversation_id>.json)
export interface ConversationData {
    conversation_id: string;
    model: string;
    workspace_roots: string[];
    started_at: number;
    ended_at: number | null;
    label: string;
    state: ConversationState;
    messages: ConversationMessage[];
    pending_queue: string[];
    server_pid: number | null;
    is_background: boolean;
    active_session_id: string | null;
}

export interface ConversationMessage {
    role: 'ai' | 'user' | 'system';
    content: string;
    timestamp: string;
    session_id?: string;
    images?: string[];
    pending_delivered?: boolean;
}

// Session registration (sessions/<conversation_id>.json), written by hooks
export interface SessionRegistration {
    conversation_id: string;
    workspace_roots: string[];
    model: string;
    server_pid: number;
    started_at: number;
}

// Pending message file (pending/<conversation_id>.json)
export interface PendingData {
    conversation_id: string;
    server_pid: number;
    comments: string[];
    images?: string[];
    timestamp: number;
}

// Server registration (servers/<pid>.json), written by extension
export interface ServerInfo {
    port: number;
    pid: number;
    workspaces: string[];
    cursorTraceId: string;
    version: string;
    started_at: number;
}

// WebSocket message types between extension <-> webview / mcp-server
export interface WSMessage {
    type: string;
    [key: string]: unknown;
}

// Feedback request from MCP server
export interface FeedbackRequest {
    type: 'feedback_request';
    session_id: string;
    conversation_id?: string;
    project_directory?: string;
    summary: string;
}

// Feedback response from webview
export interface FeedbackResponse {
    type: 'feedback_response';
    session_id: string;
    conversation_id?: string;
    feedback: string;
    images?: string[];
}

// Session update sent to webview when feedback is requested
export interface SessionUpdate {
    type: 'session_updated';
    session_info: {
        session_id: string;
        conversation_id: string;
        summary: string;
        model?: string;
    };
}

// Queue pending message from webview
export interface QueuePendingMessage {
    type: 'queue-pending';
    conversation_id: string;
    text: string;
}

// Session registered event (from hook via file watcher)
export interface SessionRegisteredEvent {
    type: 'session_registered';
    session: SessionRegistration;
}
