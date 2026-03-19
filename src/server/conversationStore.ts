/**
 * Conversation CRUD and state management.
 * Wraps fileStore operations with business logic.
 */

import type { ConversationData, ConversationMessage, SessionRegistration } from '../types';
import {
    readConversation,
    writeConversation,
    listConversations,
    readSession,
} from '../fileStore';

export class ConversationStore {
    private serverPid: number;
    private workspaces: string[];

    constructor(serverPid: number, workspaces: string[]) {
        this.serverPid = serverPid;
        this.workspaces = workspaces;
    }

    setWorkspaces(workspaces: string[]): void {
        this.workspaces = workspaces;
    }

    resolveConversationId(providedId: string): string {
        if (!providedId) return providedId;
        if (readConversation(providedId)) return providedId;
        if (readSession(providedId)) return providedId;
        return providedId;
    }

    ensureConversation(conversationId: string, sessionId: string, summary?: string): void {
        let conv = readConversation(conversationId);
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        let label: string;
        if (summary) {
            label = summary.length > 40 ? summary.slice(0, 40) + '...' : summary;
        } else if (conv?.label) {
            label = conv.label;
        } else {
            const chatNum = this._activeChatCount() + 1;
            label = `#${chatNum} | ${time}`;
        }

        if (!conv) {
            conv = {
                conversation_id: conversationId,
                model: '',
                workspace_roots: this.workspaces,
                started_at: Date.now(),
                ended_at: null,
                label,
                state: 'waiting',
                messages: [],
                pending_queue: [],
                server_pid: this.serverPid,
                is_background: false,
                active_session_id: null,
            };
        }

        conv.state = 'waiting';
        conv.server_pid = this.serverPid;
        conv.active_session_id = sessionId;
        if (summary) {
            conv.label = label;
            conv.messages.push({
                role: 'ai',
                content: summary,
                timestamp: new Date().toISOString(),
            });
        }

        writeConversation(conv);
    }

    addMessage(conversationId: string, message: ConversationMessage): void {
        const conv = readConversation(conversationId);
        if (conv) {
            conv.messages.push(message);
            writeConversation(conv);
        }
    }

    markRunning(conversationId: string): void {
        const conv = readConversation(conversationId);
        if (conv) {
            conv.state = 'running';
            conv.server_pid = this.serverPid;
            conv.active_session_id = null;
            conv.pending_queue = [];
            writeConversation(conv);
        }
    }

    markEnded(conversationId: string): void {
        const conv = readConversation(conversationId);
        if (conv && conv.server_pid === this.serverPid) {
            conv.state = 'ended';
            conv.ended_at = Date.now();
            conv.active_session_id = null;
            writeConversation(conv);
        }
    }

    markArchived(conversationId: string): void {
        const conv = readConversation(conversationId);
        if (conv) {
            conv.state = 'archived';
            conv.ended_at = Date.now();
            conv.active_session_id = null;
            writeConversation(conv);
        }
    }

    updatePendingQueue(conversationId: string, queue: string[]): void {
        const conv = readConversation(conversationId);
        if (conv) {
            conv.pending_queue = queue;
            writeConversation(conv);
        }
    }

    registerSession(session: SessionRegistration): ConversationData | null {
        if (session.server_pid !== this.serverPid) return null;

        let conv = readConversation(session.conversation_id);
        if (!conv) {
            const chatNum = this._activeChatCount() + 1;
            const time = new Date(session.started_at).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', hour12: false,
            });
            conv = {
                conversation_id: session.conversation_id,
                model: session.model,
                workspace_roots: session.workspace_roots,
                started_at: session.started_at,
                ended_at: null,
                label: `#${chatNum} | ${time}`,
                state: 'idle',
                messages: [],
                pending_queue: [],
                server_pid: this.serverPid,
                is_background: false,
                active_session_id: null,
            };
        } else {
            conv.state = conv.state === 'archived' ? 'idle' : conv.state;
            conv.server_pid = this.serverPid;
            conv.ended_at = null;
        }
        writeConversation(conv);
        return conv;
    }

    getRestoredConversations(): ConversationData[] {
        const myRoots = new Set(this.workspaces.map(w => w.replace(/\/+$/, '')));
        return listConversations().filter(c => {
            if (c.server_pid === this.serverPid) return false;
            if (c.state === 'archived') return false;
            if (c.state && c.state !== 'idle' && c.state !== 'ended' &&
                c.server_pid && c.server_pid !== this.serverPid) return false;
            const convRoots = (c.workspace_roots || []).map(r => r.replace(/\/+$/, ''));
            return convRoots.some(r => myRoots.has(r));
        });
    }

    adoptConversation(conv: ConversationData): void {
        conv.server_pid = this.serverPid;
        if (conv.state === 'waiting') {
            conv.state = 'idle';
            conv.active_session_id = null;
        }
        conv.pending_queue = [];
        writeConversation(conv);
    }

    getConversationsList(): ConversationData[] {
        return listConversations().filter(c =>
            c.state !== 'archived' && c.server_pid === this.serverPid
        );
    }

    getConversation(conversationId: string): ConversationData | null {
        return readConversation(conversationId);
    }

    savePendingDelivery(conversationId: string, comments: string[], images: string[]): void {
        const conv = readConversation(conversationId);
        if (!conv) return;

        for (const comment of comments) {
            conv.messages.push({
                role: 'user',
                content: comment,
                timestamp: new Date().toISOString(),
                pending_delivered: true,
            });
        }
        if (comments.length === 0 && images.length > 0) {
            conv.messages.push({
                role: 'user',
                content: '',
                timestamp: new Date().toISOString(),
                pending_delivered: true,
                images,
            });
        } else if (images.length > 0 && conv.messages.length > 0) {
            const last = conv.messages[conv.messages.length - 1];
            if (last.pending_delivered) {
                last.images = images;
            }
        }
        conv.pending_queue = [];
        writeConversation(conv);
    }

    private _activeChatCount(): number {
        return listConversations().filter(
            c => c.server_pid === this.serverPid && c.state !== 'archived'
        ).length;
    }
}
