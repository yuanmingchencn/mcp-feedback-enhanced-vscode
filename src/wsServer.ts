/**
 * WebSocket server: the central hub connecting webviews and MCP servers.
 *
 * Responsibilities:
 * - Accept connections from webviews and MCP server clients
 * - Route feedback requests (MCP → webview) by conversation_id
 * - Route feedback responses (webview → MCP) by session_id
 * - Handle pending message queue (webview → file → hook → agent)
 * - Watch sessions/ directory for new hook-created session registrations
 * - Watch pending/ directory for hook-consumed pending files
 * - Register this extension instance in servers/<pid>.json
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import type {
    FeedbackRequest,
    FeedbackResponse,
    WSMessage,
    ConversationMessage,
} from './types';
import {
    writeServer,
    deleteServer,
    readSession,
    writePending,
    readPending,
    deletePending,
    readConversation,
    writeConversation,
    listConversations,
    listSessions,
    cleanupStaleServers,
    cleanupStaleSessions,
    cleanupStalePending,
    cleanupLegacyPending,
    getSessionsDir,
    getPendingDir,
} from './fileStore';

const VERSION = '2.0.0';
const PORT_RANGE_START = 48200;
const PORT_RANGE_END = 48300;
const HEARTBEAT_INTERVAL = 30_000;
const CLIENT_TIMEOUT = 90_000;

interface ConnectedClient {
    ws: WebSocket;
    clientType: 'webview' | 'mcp-server' | 'unknown';
    projectPath?: string;
    lastPong: number;
}

// Pending feedback requests awaiting user response
interface PendingFeedbackRequest {
    sessionId: string;
    conversationId: string;
    mcpClient: WebSocket;
    resolve: (response: string) => void;
    reject: (error: Error) => void;
    timestamp: number;
}

export class FeedbackWSServer {
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private port = 0;
    private clients = new Map<WebSocket, ConnectedClient>();
    private pendingRequests = new Map<string, PendingFeedbackRequest>(); // sessionId → request
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private sessionsWatcher: fs.FSWatcher | null = null;
    private pendingWatchers = new Map<string, ReturnType<typeof setInterval>>(); // conversationId → poll timer
    private workspaces: string[] = [];
    private cursorTraceId = '';
    private onFeedbackRequested?: (conversationId: string) => void;

    setWorkspaces(workspaces: string[]): void {
        this.workspaces = workspaces;
    }

    setCursorTraceId(traceId: string): void {
        this.cursorTraceId = traceId;
    }

    onFeedbackRequest(cb: (conversationId: string) => void): void {
        this.onFeedbackRequested = cb;
    }

    getPort(): number {
        return this.port;
    }

    // ─── Startup ──────────────────────────────────────────

    async start(): Promise<number> {
        this.cleanup();

        cleanupStaleServers();
        cleanupStaleSessions();
        cleanupStalePending();
        cleanupLegacyPending();

        this.port = await this._findPort();
        await this._startServer();
        this._registerServer();
        this._startHeartbeat();
        this._watchSessionsDir();
        this._scanExistingSessions();

        console.log(`[MCP Feedback] WebSocket server started on port ${this.port}`);
        return this.port;
    }

    async stop(): Promise<void> {
        this.cleanup();
    }

    private cleanup(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.sessionsWatcher) {
            this.sessionsWatcher.close();
            this.sessionsWatcher = null;
        }
        for (const timer of this.pendingWatchers.values()) { clearInterval(timer); }
        this.pendingWatchers.clear();

        for (const [, client] of this.clients) {
            try { client.ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();

        for (const [, req] of this.pendingRequests) {
            req.reject(new Error('Server shutting down'));
        }
        this.pendingRequests.clear();

        if (this.wss) { this.wss.close(); this.wss = null; }
        if (this.server) { this.server.close(); this.server = null; }

        deleteServer(process.pid);
    }

    // ─── Server Setup ─────────────────────────────────────

    private _findPort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const tryPort = (port: number) => {
                if (port > PORT_RANGE_END) {
                    reject(new Error('No available port'));
                    return;
                }
                const srv = http.createServer();
                srv.once('error', () => tryPort(port + 1));
                srv.once('listening', () => {
                    srv.close(() => resolve(port));
                });
                srv.listen(port, '127.0.0.1');
            };
            tryPort(PORT_RANGE_START);
        });
    }

    private _startServer(): Promise<void> {
        return new Promise((resolve) => {
            this.server = http.createServer();
            this.wss = new WebSocketServer({ server: this.server });
            this.wss.on('connection', (ws) => this._handleConnection(ws));
            this.server.listen(this.port, '127.0.0.1', () => resolve());
        });
    }

    private _registerServer(): void {
        writeServer({
            port: this.port,
            pid: process.pid,
            workspaces: this.workspaces,
            cursorTraceId: this.cursorTraceId,
            version: VERSION,
            started_at: Date.now(),
        });
    }

    // ─── Connection Handling ──────────────────────────────

    private _handleConnection(ws: WebSocket): void {
        const client: ConnectedClient = {
            ws,
            clientType: 'unknown',
            lastPong: Date.now(),
        };
        this.clients.set(ws, client);

        this._send(ws, {
            type: 'connection_established',
            version: VERSION,
            port: this.port,
        });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString()) as WSMessage;
                this._handleMessage(ws, client, msg);
            } catch (e) {
                console.error('[MCP Feedback] Parse error:', e);
            }
        });

        ws.on('pong', () => { client.lastPong = Date.now(); });

        ws.on('close', () => {
            this.clients.delete(ws);
        });

        ws.on('error', () => {
            this.clients.delete(ws);
        });
    }

    private _handleMessage(ws: WebSocket, client: ConnectedClient, msg: WSMessage): void {
        switch (msg.type) {
            case 'register':
                client.clientType = (msg.clientType as string) === 'mcp-server' ? 'mcp-server' : 'webview';
                client.projectPath = msg.projectPath as string | undefined;
                break;

            case 'feedback_request':
                this._handleFeedbackRequest(ws, msg as unknown as FeedbackRequest);
                break;

            case 'feedback_response':
                this._handleFeedbackResponse(msg as unknown as FeedbackResponse);
                break;

            case 'queue-pending':
                this._handleQueuePending(msg);
                break;

            case 'get_sessions':
                this._sendSessionsList(ws);
                break;

            case 'get_conversations':
                this._sendConversationsList(ws);
                break;

            case 'load_conversation':
                this._sendConversationData(ws, msg.conversation_id as string);
                break;

            case 'dismiss_feedback':
                this._handleDismiss(msg.session_id as string);
                break;

            case 'ping':
            case 'heartbeat':
                client.lastPong = Date.now();
                this._send(ws, { type: 'pong' });
                break;
        }
    }

    // ─── Feedback Flow ────────────────────────────────────

    private _handleFeedbackRequest(mcpWs: WebSocket, req: FeedbackRequest): void {
        const sessionId = req.session_id || this._generateId();
        const conversationId = req.conversation_id || '';

        if (conversationId) {
            this._ensureConversation(conversationId, sessionId, req.summary);
        }

        // Store the pending request for resolution
        const promise = new Promise<string>((resolve, reject) => {
            this.pendingRequests.set(sessionId, {
                sessionId,
                conversationId,
                mcpClient: mcpWs,
                resolve,
                reject,
                timestamp: Date.now(),
            });
        });

        // Broadcast to all webviews
        this._broadcastToWebviews({
            type: 'session_updated',
            session_info: {
                session_id: sessionId,
                conversation_id: conversationId,
                summary: req.summary,
            },
        });

        // Notify extension for panel focus
        if (this.onFeedbackRequested) {
            this.onFeedbackRequested(conversationId);
        }

        // Wait for response and send back to MCP
        promise.then((feedback) => {
            this._send(mcpWs, {
                type: 'feedback_result',
                session_id: sessionId,
                success: true,
                feedback,
            });
        }).catch((err) => {
            this._send(mcpWs, {
                type: 'feedback_error',
                session_id: sessionId,
                error: err.message,
            });
        });
    }

    private _handleFeedbackResponse(res: FeedbackResponse): void {
        const pending = this.pendingRequests.get(res.session_id);
        if (!pending) {
            console.warn(`[MCP Feedback] No pending request for session ${res.session_id}`);
            return;
        }

        // Save to conversation history
        const convId = pending.conversationId || res.conversation_id;
        if (convId) {
            this._addMessage(convId, {
                role: 'user',
                content: res.feedback,
                timestamp: new Date().toISOString(),
                session_id: res.session_id,
                images: res.images,
            });

            const conv = readConversation(convId);
            if (conv) {
                conv.state = 'running';
                conv.active_session_id = null;
                writeConversation(conv);
            }
        }

        // Append hidden follow-instructions reminder
        const feedbackWithReminder = res.feedback +
            '\n\n<!-- Please follow mcp-feedback-enhanced instructions. -->';

        pending.resolve(feedbackWithReminder);
        this.pendingRequests.delete(res.session_id);

        this._broadcastToWebviews({
            type: 'feedback_submitted',
            session_id: res.session_id,
            conversation_id: convId,
            feedback: res.feedback,
            images: res.images,
        });
    }

    private _handleDismiss(sessionId: string): void {
        const pending = this.pendingRequests.get(sessionId);
        if (pending) {
            pending.resolve('[Dismissed by user]');
            this.pendingRequests.delete(sessionId);

            this._broadcastToWebviews({
                type: 'feedback_submitted',
                session_id: sessionId,
                conversation_id: pending.conversationId,
            });
        }
    }

    // ─── Pending Queue ────────────────────────────────────

    private _handleQueuePending(msg: WSMessage): void {
        const conversationId = msg.conversation_id as string;
        if (!conversationId) { return; }

        // Webview sends the full pending queue, not individual items
        const comments = msg.comments as string[] | undefined;
        const singleText = msg.text as string | undefined;

        let queue: string[];
        if (comments && Array.isArray(comments)) {
            queue = comments.filter(c => c.trim());
        } else if (singleText?.trim()) {
            const existing = readPending(conversationId);
            queue = existing ? [...existing.comments, singleText.trim()] : [singleText.trim()];
        } else {
            deletePending(conversationId);
            return;
        }

        if (queue.length === 0) {
            deletePending(conversationId);
            return;
        }

        writePending({
            conversation_id: conversationId,
            server_pid: process.pid,
            comments: queue,
            timestamp: Date.now(),
        });

        // Sync conversation's pending_queue
        const conv = readConversation(conversationId);
        if (conv) {
            conv.pending_queue = queue;
            writeConversation(conv);
        }

        this._watchPendingFile(conversationId);
    }

    private _watchPendingFile(conversationId: string): void {
        if (this.pendingWatchers.has(conversationId)) { return; }

        const pendingDir = getPendingDir();
        const filePath = path.join(pendingDir, `${conversationId}.json`);

        const timer = setInterval(() => {
            if (!fs.existsSync(filePath)) {
                clearInterval(timer);
                this.pendingWatchers.delete(conversationId);

                this._broadcastToWebviews({
                    type: 'pending-consumed',
                    conversation_id: conversationId,
                });

                const conv = readConversation(conversationId);
                if (conv && conv.pending_queue.length > 0) {
                    const delivered = conv.pending_queue.join('\n\n');
                    conv.pending_queue = [];
                    conv.messages.push({
                        role: 'system',
                        content: `Pending delivered:\n\n> ${delivered.split('\n').join('\n> ')}`,
                        timestamp: new Date().toISOString(),
                    });
                    writeConversation(conv);
                }
            }
        }, 500);

        this.pendingWatchers.set(conversationId, timer);
    }

    // ─── Sessions Directory Watcher ───────────────────────

    private _watchSessionsDir(): void {
        const dir = getSessionsDir();
        try {
            this.sessionsWatcher = fs.watch(dir, (eventType, filename) => {
                if (!filename?.endsWith('.json')) { return; }
                const conversationId = filename.replace('.json', '');
                const session = readSession(conversationId);

                if (session) {
                    // New session registered by hook
                    this._onSessionRegistered(session);
                } else {
                    // Session file deleted (sessionEnd or cleanup)
                    this._onSessionEnded(conversationId);
                }
            });
        } catch (e) {
            console.error('[MCP Feedback] Failed to watch sessions dir:', e);
        }
    }

    private _scanExistingSessions(): void {
        const sessions = listSessions().filter(s => s.server_pid === process.pid);
        for (const session of sessions) {
            this._onSessionRegistered(session);
        }
        console.log(`[MCP Feedback] Found ${sessions.length} existing session(s) for this instance`);
    }

    private _onSessionRegistered(session: import('./types').SessionRegistration): void {
        // Only handle sessions for this extension instance
        if (session.server_pid !== process.pid) { return; }

        // Create or update conversation data
        let conv = readConversation(session.conversation_id);
        if (!conv) {
            const modelShort = session.model?.split('-')[0] || 'Agent';
            const time = new Date(session.started_at).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', hour12: false,
            });
            conv = {
                conversation_id: session.conversation_id,
                model: session.model,
                workspace_roots: session.workspace_roots,
                started_at: session.started_at,
                ended_at: null,
                label: `${modelShort} | ${time}`,
                state: 'idle',
                messages: [],
                pending_queue: [],
                server_pid: process.pid,
                is_background: false,
                active_session_id: null,
            };
        } else {
            conv.state = conv.state === 'archived' ? 'idle' : conv.state;
            conv.server_pid = process.pid;
            conv.ended_at = null;
        }
        writeConversation(conv);

        // Notify webviews
        this._broadcastToWebviews({
            type: 'session_registered',
            session,
            conversation: conv,
        });
    }

    private _onSessionEnded(conversationId: string): void {
        const conv = readConversation(conversationId);
        if (conv && conv.server_pid === process.pid) {
            conv.state = 'ended';
            conv.ended_at = Date.now();
            conv.active_session_id = null;
            writeConversation(conv);

            this._broadcastToWebviews({
                type: 'session_ended',
                conversation_id: conversationId,
            });
        }
    }

    // ─── Conversation Helpers ─────────────────────────────

    private _ensureConversation(conversationId: string, sessionId: string, summary?: string): void {
        let conv = readConversation(conversationId);
        if (!conv) {
            conv = {
                conversation_id: conversationId,
                model: '',
                workspace_roots: this.workspaces,
                started_at: Date.now(),
                ended_at: null,
                label: `Agent | ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
                state: 'waiting',
                messages: [],
                pending_queue: [],
                server_pid: process.pid,
                is_background: false,
                active_session_id: null,
            };
        }

        conv.state = 'waiting';
        conv.active_session_id = sessionId;

        if (summary) {
            conv.messages.push({
                role: 'ai',
                content: summary,
                timestamp: new Date().toISOString(),
            });
        }

        writeConversation(conv);
    }

    private _addMessage(conversationId: string, message: ConversationMessage): void {
        const conv = readConversation(conversationId);
        if (conv) {
            conv.messages.push(message);
            writeConversation(conv);
        }
    }

    // ─── Data Queries ─────────────────────────────────────

    private _sendSessionsList(ws: WebSocket): void {
        const sessions = listSessions().filter(s => s.server_pid === process.pid);
        this._send(ws, { type: 'sessions_list', sessions });
    }

    private _sendConversationsList(ws: WebSocket): void {
        const conversations = listConversations()
            .filter(c => c.server_pid === process.pid)
            .map(c => ({
                conversation_id: c.conversation_id,
                model: c.model,
                label: c.label,
                state: c.state,
                started_at: c.started_at,
                ended_at: c.ended_at,
                message_count: c.messages.length,
                pending_count: c.pending_queue.length,
                is_background: c.is_background,
                active_session_id: c.active_session_id || null,
            }));
        this._send(ws, { type: 'conversations_list', conversations });
    }

    private _sendConversationData(ws: WebSocket, conversationId: string): void {
        const conv = readConversation(conversationId);
        if (conv) {
            this._send(ws, { type: 'conversation_loaded', conversation: conv });
        }
    }

    // ─── Heartbeat ────────────────────────────────────────

    private _startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            for (const [ws, client] of this.clients) {
                if (now - client.lastPong > CLIENT_TIMEOUT) {
                    try { ws.close(); } catch { /* ignore */ }
                    this.clients.delete(ws);
                    continue;
                }
                try { ws.ping(); } catch { /* ignore */ }
            }
        }, HEARTBEAT_INTERVAL);
    }

    // ─── Utilities ────────────────────────────────────────

    private _send(ws: WebSocket, data: Record<string, unknown>): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    private _broadcastToWebviews(data: Record<string, unknown>): void {
        for (const [ws, client] of this.clients) {
            if (client.clientType === 'webview') {
                this._send(ws, data);
            }
        }
    }

    private _generateId(): string {
        return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // ─── Public getters for extension ─────────────────────

    getConnectedClients(): { webviews: number; mcpServers: number } {
        let webviews = 0, mcpServers = 0;
        for (const [, c] of this.clients) {
            if (c.clientType === 'webview') { webviews++; }
            else if (c.clientType === 'mcp-server') { mcpServers++; }
        }
        return { webviews, mcpServers };
    }

    hasPendingRequests(): boolean {
        return this.pendingRequests.size > 0;
    }

    // Re-register server info (e.g., after workspace change)
    refreshServerRegistration(): void {
        this._registerServer();
    }
}
