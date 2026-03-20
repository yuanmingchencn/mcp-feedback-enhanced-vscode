/**
 * Shared type definitions for MCP Feedback Enhanced.
 * Flat per-window model — no conversation_id in the protocol.
 */

export type PanelMode = 'idle' | 'running' | 'waiting';

export interface ConversationMessage {
    role: 'ai' | 'user' | 'system';
    content: string;
    timestamp: string;
    session_id?: string;
    images?: string[];
    pending_delivered?: boolean;
}

// Persisted in projects/<hash>.json
export interface ProjectState {
    projectPath: string;
    messages: ConversationMessage[];
    lastActive: number;
}

// Persisted in servers/<hash>.json (written by extension, keyed by project hash)
export interface ServerInfo {
    port: number;
    pid: number;
    projectPath: string;
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
    summary: string;
    label?: string;
    project_directory?: string;
}

// Webview -> extension
export interface FeedbackResponse {
    type: 'feedback_response';
    session_id: string;
    feedback: string;
    images?: string[];
}

export interface SessionUpdate {
    type: 'session_updated';
    session_info: {
        session_id: string;
        summary: string;
        model?: string;
        label?: string;
    };
}
