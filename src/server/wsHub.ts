/**
 * WebSocket hub: the central message router.
 *
 * Accepts connections from webviews and MCP servers, routes messages
 * to the appropriate manager, and broadcasts state changes.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket, WebSocketServer } from 'ws';
import type {
    FeedbackRequest,
    FeedbackResponse,
    WSMessage,
} from '../types';
import {
    validateMessage,
    FeedbackRequestSchema,
    FeedbackResponseSchema,
    QueuePendingSchema,
    RegisterSchema,
    LoadConversationSchema,
    DismissFeedbackSchema,
    CloseTabSchema,
} from '../messageSchemas';
import {
    writeServer,
    deleteServer,
    readConversation,
    deletePending,
    cleanupStaleServers,
    cleanupStaleSessions,
    cleanupStalePending,
    cleanupLegacyPending,
} from '../fileStore';
import { ConversationStore } from './conversationStore';
import { FeedbackManager } from './feedbackManager';
import { PendingManager } from './pendingManager';
import { SessionWatcher } from './sessionWatcher';

type ValidatedFeedbackRequest = FeedbackRequest & { session_id: string; conversation_id: string };

const LOG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced', 'logs');
function wsLog(msg: string): void {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const logFile = path.join(LOG_DIR, 'extension.log');
        try {
            const stat = fs.statSync(logFile);
            if (stat.size > 2 * 1024 * 1024) {
                try { fs.unlinkSync(logFile + '.old'); } catch { /* ignore */ }
                fs.renameSync(logFile, logFile + '.old');
            }
        } catch { /* ignore */ }
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch { /* ignore */ }
}

const VERSION = '2.0.0';
const PORT_RANGE_START = 48200;
const PORT_RANGE_END = 48300;
const HEARTBEAT_INTERVAL = 30_000;
const CLIENT_TIMEOUT = 90_000;
const FEEDBACK_TIMEOUT_MS = 300_000; // 5 minutes

interface ConnectedClient {
    ws: WebSocket;
    clientType: 'webview' | 'mcp-server' | 'unknown';
    projectPath?: string;
    lastPong: number;
}

const FEEDBACK_REMINDER = '\n\n<!-- Please follow mcp-feedback-enhanced instructions. -->';

export class WsHub {
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private port = 0;
    private clients = new Map<WebSocket, ConnectedClient>();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    private conversations: ConversationStore;
    private feedback: FeedbackManager;
    private pending: PendingManager;
    private sessions: SessionWatcher;

    private workspaces: string[] = [];
    private cursorTraceId = '';
    private onFeedbackRequested?: (conversationId: string) => void;

    constructor() {
        this.conversations = new ConversationStore(process.pid, []);
        this.feedback = new FeedbackManager();
        this.pending = new PendingManager(process.pid);
        this.sessions = new SessionWatcher(process.pid);

        this.pending.onPendingDelivered((delivery) => {
            this._onPendingDelivered(delivery.conversationId, delivery.comments, delivery.images);
        });

        this.sessions.onSessionRegistered((session) => {
            this._onSessionRegistered(session);
        });

        this.sessions.onSessionEnded((conversationId) => {
            this._onSessionEnded(conversationId);
        });
    }

    // ── Public API ──────────────────────────────────────────

    setWorkspaces(workspaces: string[]): void {
        this.workspaces = workspaces;
        this.conversations.setWorkspaces(workspaces);
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

    getConnectedClients(): { webviews: number; mcpServers: number } {
        let webviews = 0, mcpServers = 0;
        for (const [, c] of this.clients) {
            if (c.clientType === 'webview') webviews++;
            else if (c.clientType === 'mcp-server') mcpServers++;
        }
        return { webviews, mcpServers };
    }

    hasPendingRequests(): boolean {
        return this.feedback.hasPending();
    }

    refreshServerRegistration(): void {
        this._registerServer();
    }

    // ── Lifecycle ───────────────────────────────────────────

    async start(): Promise<number> {
        this._cleanup();

        cleanupStaleServers();
        cleanupStaleSessions();
        cleanupStalePending();
        cleanupLegacyPending();

        this.port = await this._findPort();
        await this._startServer();
        this._registerServer();
        this._startHeartbeat();
        this.sessions.start();
        this._scanExistingSessions();

        wsLog(`server started: port=${this.port} pid=${process.pid} ws=${JSON.stringify(this.workspaces)}`);
        return this.port;
    }

    async stop(): Promise<void> {
        this._cleanup();
    }

    private _cleanup(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        this.sessions.stop();
        this.pending.cleanup();

        for (const [, client] of this.clients) {
            try { client.ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();

        this.feedback.rejectAll(new Error('Server shutting down'));

        if (this.wss) { this.wss.close(); this.wss = null; }
        if (this.server) { this.server.close(); this.server = null; }

        deleteServer(process.pid);
    }

    // ── Server Setup ────────────────────────────────────────

    private _findPort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const tryPort = (port: number) => {
                if (port > PORT_RANGE_END) { reject(new Error('No available port')); return; }
                const srv = http.createServer();
                srv.once('error', () => tryPort(port + 1));
                srv.once('listening', () => { srv.close(() => resolve(port)); });
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

    // ── Connection Handling ─────────────────────────────────

    private _handleConnection(ws: WebSocket): void {
        const client: ConnectedClient = {
            ws,
            clientType: 'unknown',
            lastPong: Date.now(),
        };
        this.clients.set(ws, client);

        this._send(ws, { type: 'connection_established', version: VERSION, port: this.port });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString()) as WSMessage;
                this._routeMessage(ws, client, msg);
            } catch (e) {
                console.error('[MCP Feedback] Parse error:', e);
            }
        });

        ws.on('pong', () => { client.lastPong = Date.now(); });
        ws.on('close', () => { this.clients.delete(ws); });
        ws.on('error', () => { this.clients.delete(ws); });
    }

    private _routeMessage(ws: WebSocket, client: ConnectedClient, msg: WSMessage): void {
        switch (msg.type) {
            case 'register': {
                const reg = validateMessage(RegisterSchema, msg, 'register');
                if (!reg) break;
                client.clientType = reg.clientType;
                client.projectPath = reg.projectPath;
                wsLog(`client registered: type=${client.clientType} project=${client.projectPath || ''}`);
                break;
            }
            case 'feedback_request': {
                const req = validateMessage(FeedbackRequestSchema, msg, 'feedback_request');
                if (!req) break;
                this._handleFeedbackRequest(ws, req);
                break;
            }
            case 'feedback_response': {
                const res = validateMessage(FeedbackResponseSchema, msg, 'feedback_response');
                if (!res) break;
                this._handleFeedbackResponse(res);
                break;
            }
            case 'queue-pending': {
                const qp = validateMessage(QueuePendingSchema, msg, 'queue-pending');
                if (!qp) break;
                this._handleQueuePending(qp);
                break;
            }
            case 'get_conversations':
                this._sendConversationsList(ws);
                break;
            case 'load_conversation': {
                const lc = validateMessage(LoadConversationSchema, msg, 'load_conversation');
                if (!lc) break;
                this._sendConversationData(ws, lc.conversation_id);
                break;
            }
            case 'dismiss_feedback': {
                const df = validateMessage(DismissFeedbackSchema, msg, 'dismiss_feedback');
                if (!df) break;
                this._handleDismiss(df.session_id);
                break;
            }
            case 'close_tab': {
                const ct = validateMessage(CloseTabSchema, msg, 'close_tab');
                if (!ct) break;
                this._handleCloseTab(ct.conversation_id);
                break;
            }
            case 'get_sessions':
                this._send(ws, { type: 'sessions_list', sessions: this.sessions.scanExisting() });
                break;
            case 'ping':
            case 'heartbeat':
                client.lastPong = Date.now();
                this._send(ws, { type: 'pong' });
                break;
        }
    }

    // ── Feedback Flow ───────────────────────────────────────

    private _createFeedbackRequestWithTimeout(
        sessionId: string,
        conversationId: string,
        mcpWs: WebSocket
    ): Promise<import('./feedbackManager').FeedbackResult> {
        let timeoutId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error('Feedback request timed out')),
                FEEDBACK_TIMEOUT_MS
            );
        });
        return Promise.race([
            this.feedback.createRequest(sessionId, conversationId, mcpWs),
            timeoutPromise,
        ]).finally(() => clearTimeout(timeoutId));
    }

    private _handleFeedbackRequest(mcpWs: WebSocket, req: ValidatedFeedbackRequest): void {
        wsLog(`feedbackRequest: session=${req.session_id} conv=${req.conversation_id} summary=${req.summary.slice(0, 60)}`);
        const sessionId = req.session_id;
        const conversationId = this.conversations.resolveConversationId(req.conversation_id);

        if (conversationId) {
            this.conversations.ensureConversation(conversationId, sessionId, req.summary);
        }

        const promise = this.feedback.createRequest(sessionId, conversationId, mcpWs);

        const conv = this.conversations.getConversation(conversationId);
        const label = req.label || conv?.label || req.summary.slice(0, 60);

        this._broadcastToWebviews({
            type: 'session_updated',
            session_info: {
                session_id: sessionId,
                conversation_id: conversationId,
                summary: req.summary,
                label,
            },
        });

        if (this.onFeedbackRequested) {
            this.onFeedbackRequested(conversationId);
        }

        promise.then((result) => {
            this._send(mcpWs, {
                type: 'feedback_result',
                session_id: sessionId,
                success: true,
                feedback: result.feedback,
                images: result.images,
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
        const convId = this.feedback.getConversationId(res.session_id) || res.conversation_id;
        wsLog(`feedbackResponse: session=${res.session_id} conv=${convId} feedback=${res.feedback.slice(0, 60)}`);

        if (convId) {
            this.conversations.addMessage(convId, {
                role: 'user',
                content: res.feedback,
                timestamp: new Date().toISOString(),
                session_id: res.session_id,
                images: res.images,
            });
            this.conversations.markRunning(convId);
            this.pending.cancelWatch(convId);
            deletePending(convId);
        }

        const feedbackWithReminder = res.feedback + FEEDBACK_REMINDER;
        this.feedback.resolve(res.session_id, {
            feedback: feedbackWithReminder,
            images: res.images ?? undefined,
        });

        this._broadcastToWebviews({
            type: 'feedback_submitted',
            session_id: res.session_id,
            conversation_id: convId,
            feedback: res.feedback,
            images: res.images,
        });
    }

    private _handleDismiss(sessionId: string): void {
        const convId = this.feedback.getConversationId(sessionId);
        this.feedback.resolve(sessionId, { feedback: '[Dismissed by user]' });

        this._broadcastToWebviews({
            type: 'feedback_submitted',
            session_id: sessionId,
            conversation_id: convId,
        });
    }

    // ── Pending Queue ───────────────────────────────────────

    private _handleQueuePending(qp: { conversation_id: string; comments: string[]; images?: string[] }): void {
        wsLog(`queuePending: conv=${qp.conversation_id} comments=${qp.comments.length} images=${(qp.images ?? []).length}`);
        const conversationId = qp.conversation_id;
        const comments = qp.comments.filter(c => c.trim());
        const images = qp.images ?? [];

        this.pending.handleQueue(conversationId, comments, images);
        this.conversations.updatePendingQueue(conversationId, comments);

        this._broadcastToWebviews({
            type: 'pending_synced',
            conversation_id: conversationId,
            comments,
            images,
        });
    }

    private _handleCloseTab(conversationId: string): void {
        if (!conversationId) return;
        this.conversations.markArchived(conversationId);
        this.pending.cancelWatch(conversationId);
        deletePending(conversationId);
        this.feedback.resolveByConversation(conversationId, { feedback: '[Tab closed by user]' });

        this._broadcastToWebviews({
            type: 'tab_closed',
            conversation_id: conversationId,
        });
    }

    // ── Pending Delivery (from file watcher) ────────────────

    private _onPendingDelivered(conversationId: string, comments: string[], images: string[]): void {
        const conv = this.conversations.getConversation(conversationId);
        const deliveredComments = comments.length > 0 ? comments : (conv ? [...conv.pending_queue] : []);

        this.conversations.savePendingDelivery(conversationId, deliveredComments, images);

        this._broadcastToWebviews({
            type: 'pending_delivered',
            conversation_id: conversationId,
            comments: deliveredComments,
            images,
        });
    }

    // ── Session Events ──────────────────────────────────────

    private _onSessionRegistered(session: import('../types').SessionRegistration): void {
        wsLog(`sessionRegistered: conv=${session.conversation_id} pid=${session.server_pid} myPid=${process.pid}`);
        const conv = this.conversations.registerSession(session);
        if (!conv) return;

        this._broadcastToWebviews({
            type: 'session_registered',
            session,
            conversation: conv,
        });
    }

    private _onSessionEnded(conversationId: string): void {
        this.conversations.markEnded(conversationId);

        this._broadcastToWebviews({
            type: 'session_ended',
            conversation_id: conversationId,
        });
    }

    private _scanExistingSessions(): void {
        const sessions = this.sessions.scanExisting();
        for (const session of sessions) {
            this._onSessionRegistered(session);
        }

        const restoredConvs = this.conversations.getRestoredConversations();
        for (const conv of restoredConvs) {
            this.conversations.adoptConversation(conv);

            this._broadcastToWebviews({
                type: 'session_registered',
                session: {
                    conversation_id: conv.conversation_id,
                    workspace_roots: conv.workspace_roots,
                    model: conv.model,
                    server_pid: process.pid,
                    started_at: conv.started_at,
                },
                conversation: conv,
            });
        }
    }

    // ── Data Queries ────────────────────────────────────────

    private _sendConversationsList(ws: WebSocket): void {
        const conversations = this.conversations.getConversationsList().map(c => ({
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
        const conv = this.conversations.getConversation(conversationId);
        if (conv) {
            this._send(ws, { type: 'conversation_loaded', conversation: conv });
        }
    }

    // ── Heartbeat ───────────────────────────────────────────

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

    // ── Transport ───────────────────────────────────────────

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
}
