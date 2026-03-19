/**
 * Shared type definitions for MCP Feedback Enhanced.
 * conversation_id is the single identifier for all per-conversation state.
 */

export type ConversationState = 'idle' | 'running' | 'waiting' | 'ended' | 'archived';

export interface ConversationMessage {
    role: 'ai' | 'user' | 'system';
    content: string;
    timestamp: string;
    session_id?: string;
    images?: string[];
    pending_delivered?: boolean;
}

// Persisted in conversations/<conversation_id>.json
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

// Persisted in sessions/<conversation_id>.json (written by hooks)
export interface SessionRegistration {
    conversation_id: string;
    workspace_roots: string[];
    model: string;
    server_pid: number;
    started_at: number;
}

// Persisted in pending/<conversation_id>.json
export interface PendingData {
    conversation_id: string;
    server_pid: number;
    comments: string[];
    images?: string[];
    timestamp: number;
}

// Persisted in servers/<pid>.json (written by extension)
export interface ServerInfo {
    port: number;
    pid: number;
    workspaces: string[];
    cursorTraceId: string;
    version: string;
    started_at: number;
}

// Generic WS message envelope
export interface WSMessage {
    type: string;
    [key: string]: unknown;
}

// MCP server -> extension
export interface FeedbackRequest {
    type: 'feedback_request';
    session_id: string;
    conversation_id: string;
    project_directory?: string;
    label?: string;
    summary: string;
}

// Webview -> extension
export interface FeedbackResponse {
    type: 'feedback_response';
    session_id: string;
    conversation_id?: string;
    feedback: string;
    images?: string[];
}

export interface SessionUpdate {
    type: 'session_updated';
    session_info: {
        session_id: string;
        conversation_id: string;
        summary: string;
        model?: string;
        label?: string;
    };
}
