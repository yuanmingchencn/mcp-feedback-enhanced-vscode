/**
 * WebSocket hub: the central message router.
 *
 * Flat per-window model — no conversation_id routing.
 * One project = one message timeline = one pending queue.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket, WebSocketServer } from 'ws';
import type {
    FeedbackRequest,
    FeedbackResponse,
    ConversationMessage,
    ProjectState,
    WSMessage,
} from '../types';
import {
    validateMessage,
    FeedbackRequestSchema,
    FeedbackResponseSchema,
    QueuePendingSchema,
    RegisterSchema,
    DismissFeedbackSchema,
    GetStateSchema,
} from '../messageSchemas';
import {
    writeServer,
    deleteServerByHash,
    readProject,
    writeProject,
    projectHash,
    cleanupStaleServers,
} from '../fileStore';
import { FeedbackManager } from './feedbackManager';
import { PendingManager } from './pendingManager';

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

const VERSION = '2.1.0';
const PORT_RANGE_START = 48200;
const PORT_RANGE_END = 48300;
const HEARTBEAT_INTERVAL = 30_000;
const CLIENT_TIMEOUT = 90_000;
const MESSAGE_CAP = 500;

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
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    private feedback: FeedbackManager;
    private pending: PendingManager;

    private workspaces: string[] = [];
    private onFeedbackRequested?: () => void;

    private messages: ConversationMessage[] = [];
    private projHash = '';

    constructor() {
        this.feedback = new FeedbackManager();
        this.pending = new PendingManager();

        this.pending.onPendingDelivered((delivery) => {
            this._onPendingDelivered(delivery.comments, delivery.images);
        });
    }

    // ── Public API ──────────────────────────────────────────

    setWorkspaces(workspaces: string[]): void {
        this.workspaces = workspaces;
        if (workspaces.length > 0) {
            this.projHash = projectHash(workspaces[0]);
        }
    }

    onFeedbackRequest(cb: () => void): void {
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

        this._loadProject();
        this.port = await this._findPort();
        await this._startServer();
        this._registerServer();
        this._startHeartbeat();

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
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        this.pending.clear();

        for (const [, client] of this.clients) {
            try { client.ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();

        this.feedback.rejectAll(new Error('Server shutting down'));

        if (this.wss) { this.wss.close(); this.wss = null; }
        if (this.server) { this.server.close(); this.server = null; }

        for (const ws of this.workspaces) {
            deleteServerByHash(projectHash(ws));
        }
    }

    // ── Project Persistence ─────────────────────────────────

    private _loadProject(): void {
        if (!this.projHash) return;
        const proj = readProject(this.projHash);
        if (proj) {
            this.messages = proj.messages.slice(-MESSAGE_CAP);
        }
    }

    private _saveProjectDebounced(): void {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this._saveProjectNow();
        }, 1000);
    }

    private _saveProjectNow(): void {
        if (!this.projHash || this.workspaces.length === 0) return;
        const state: ProjectState = {
            projectPath: this.workspaces[0],
            messages: this.messages.slice(-MESSAGE_CAP),
            lastActive: Date.now(),
        };
        writeProject(this.projHash, state);
    }

    private _addMessage(msg: ConversationMessage): void {
        this.messages.push(msg);
        if (this.messages.length > MESSAGE_CAP) {
            this.messages = this.messages.slice(-MESSAGE_CAP);
        }
        this._saveProjectDebounced();
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
            this.server = http.createServer((req, res) => this._handleHttpRequest(req, res));
            this.wss = new WebSocketServer({ server: this.server });
            this.wss.on('connection', (ws) => this._handleConnection(ws));
            this.server.listen(this.port, '127.0.0.1', () => resolve());
        });
    }

    private _handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
        const pathname = url.pathname;

        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET' && pathname === '/health') {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, port: this.port, pid: process.pid, version: VERSION }));
            return;
        }

        if (req.method === 'GET' && pathname === '/pending') {
            const consume = url.searchParams.get('consume') === '1';
            const entry = consume ? this.pending.consume() : this.pending.read();
            if (entry) {
                if (consume) wsLog(`HTTP consume pending: comments=${entry.comments.length}`);
                res.writeHead(200);
                res.end(JSON.stringify({ comments: entry.comments, images: entry.images }));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'no_pending' }));
            }
            return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not_found' }));
    }

    private _registerServer(): void {
        for (const ws of this.workspaces) {
            writeServer(projectHash(ws), {
                port: this.port,
                pid: process.pid,
                projectPath: ws,
                version: VERSION,
                started_at: Date.now(),
            });
        }
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
        ws.on('close', () => {
            this.clients.delete(ws);
            this.feedback.rejectByClient(ws);
        });
        ws.on('error', () => {
            this.clients.delete(ws);
            this.feedback.rejectByClient(ws);
        });
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
                this._handleFeedbackRequest(ws, req as FeedbackRequest & { session_id: string });
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
            case 'dismiss_feedback': {
                const df = validateMessage(DismissFeedbackSchema, msg, 'dismiss_feedback');
                if (!df) break;
                this._handleDismiss(df.session_id);
                break;
            }
            case 'get_state': {
                this._sendState(ws);
                break;
            }
            case 'ping':
            case 'heartbeat':
                client.lastPong = Date.now();
                this._send(ws, { type: 'pong' });
                break;
        }
    }

    // ── Feedback Flow ───────────────────────────────────────

    private _handleFeedbackRequest(mcpWs: WebSocket, req: FeedbackRequest & { session_id: string }): void {
        wsLog(`feedbackRequest: session=${req.session_id} summary=${req.summary.slice(0, 60)}`);
        const sessionId = req.session_id;

        const label = req.label || req.summary.slice(0, 60);

        this._addMessage({
            role: 'ai',
            content: req.summary,
            timestamp: new Date().toISOString(),
            session_id: sessionId,
        });

        const promise = this.feedback.createRequest(sessionId, mcpWs);

        this._broadcastToWebviews({
            type: 'session_updated',
            session_info: {
                session_id: sessionId,
                summary: req.summary,
                label,
            },
        });

        if (this.onFeedbackRequested) {
            this.onFeedbackRequested();
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
        wsLog(`feedbackResponse: session=${res.session_id} feedback=${res.feedback.slice(0, 60)}`);

        this._addMessage({
            role: 'user',
            content: res.feedback,
            timestamp: new Date().toISOString(),
            session_id: res.session_id,
            images: res.images,
        });

        this.pending.clear();

        const feedbackWithReminder = res.feedback + FEEDBACK_REMINDER;
        this.feedback.resolve(res.session_id, {
            feedback: feedbackWithReminder,
            images: res.images ?? undefined,
        });

        this._broadcastToWebviews({
            type: 'feedback_submitted',
            session_id: res.session_id,
            feedback: res.feedback,
        });
    }

    private _handleDismiss(sessionId: string): void {
        this.feedback.resolve(sessionId, { feedback: '[Dismissed by user]' });

        this._broadcastToWebviews({
            type: 'feedback_submitted',
            session_id: sessionId,
        });
    }

    // ── Pending Queue ───────────────────────────────────────

    private _handleQueuePending(qp: { comments: string[]; images?: string[] }): void {
        wsLog(`queuePending: comments=${qp.comments.length} images=${(qp.images ?? []).length}`);
        const comments = qp.comments.filter(c => c.trim());
        const images = qp.images ?? [];

        this.pending.set(comments, images);

        this._broadcastToWebviews({
            type: 'pending_synced',
            comments,
            images,
        });
    }

    // ── Pending Delivery (from HTTP consume) ─────────────────

    private _onPendingDelivered(comments: string[], images: string[]): void {
        for (const comment of comments) {
            this._addMessage({
                role: 'user',
                content: comment,
                timestamp: new Date().toISOString(),
                pending_delivered: true,
            });
        }
        if (comments.length === 0 && images.length > 0) {
            this._addMessage({
                role: 'user',
                content: '',
                timestamp: new Date().toISOString(),
                pending_delivered: true,
                images,
            });
        } else if (images.length > 0 && this.messages.length > 0) {
            const last = this.messages[this.messages.length - 1];
            if (last.pending_delivered) {
                last.images = images;
            }
        }

        this._broadcastToWebviews({
            type: 'pending_delivered',
            comments,
            images,
        });
    }

    // ── State Sync ──────────────────────────────────────────

    private _sendState(ws: WebSocket): void {
        const entry = this.pending.read();
        this._send(ws, {
            type: 'state_sync',
            messages: this.messages,
            pending_comments: entry?.comments ?? [],
            pending_images: entry?.images ?? [],
            pending_sessions: this.feedback.pendingSessionIds(),
        });
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
