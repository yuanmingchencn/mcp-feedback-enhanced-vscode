/**
 * WebSocket hub: the central message router.
 *
 * Feedback sessions are keyed by conversation_id (from Cursor),
 * with fallback to project hash or auto-generated key.
 * Sessions survive transport disconnection for reconnection.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import type {
    ConversationMessage,
    WSMessage,
} from '../types';
import {
    writeServer,
    deleteServerByHash,
    projectHash,
    cleanupStaleServers,
} from '../fileStore';
import { FeedbackManager } from './feedbackManager';
import { PendingManager } from './pendingManager';
import { handleHttpRoute } from './httpRoutes';
import { ProjectTimeline } from './projectTimeline';
import { ClientRegistry, type ConnectedClient } from './clientRegistry';
import { FeedbackFlow } from './feedbackFlow';
import { bindClientConnectionHandlers } from './connectionHandlers';
import { findAvailablePort } from './portFinder';
import { dispatchRouteMessage } from './routeAdapter';
import { decodeWsMessage } from './wsMessageCodec';

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

const PORT_RANGE_START = 48200;
const PORT_RANGE_END = 48300;
const HEARTBEAT_INTERVAL = 30_000;
const CLIENT_TIMEOUT = 90_000;
const MESSAGE_CAP = 500;

export class WsHub {
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private port = 0;
    private readonly version: string;
    private readonly clients = new ClientRegistry();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    private readonly feedback: FeedbackManager;
    private readonly pending: PendingManager;
    private readonly timeline: ProjectTimeline;
    private readonly feedbackFlow: FeedbackFlow;

    private workspaces: string[] = [];

    constructor(version = '0.0.0') {
        this.version = version;
        this.feedback = new FeedbackManager();
        this.pending = new PendingManager();
        this.timeline = new ProjectTimeline(MESSAGE_CAP);
        this.feedbackFlow = new FeedbackFlow({
            feedback: this.feedback,
            appendReminder: (feedback) => feedback,
            addMessage: (msg) => this._addMessage(msg),
            broadcastSessionUpdated: (summary) => {
                this._broadcastToWebviews({ type: 'session_updated', summary });
            },
            broadcastFeedbackSubmitted: (feedback) => {
                this._broadcastToWebviews({ type: 'feedback_submitted', feedback });
            },
            clearPending: () => {
                this.pending.clear();
                this._broadcastToWebviews({ type: 'pending_synced', comments: [], images: [] });
            },
            queueAsPending: (feedback, images) => {
                const comments = feedback ? [feedback] : [];
                this.pending.set(comments, images ?? []);
                this._broadcastToWebviews({ type: 'pending_synced', comments, images: images ?? [] });
            },
            sendResult: (ws, result) => {
                this._send(ws, {
                    type: 'feedback_result',
                    feedback: result.feedback,
                    images: result.images,
                });
            },
            sendError: (ws, error) => {
                this._send(ws, {
                    type: 'feedback_error',
                    error: error.message,
                });
            },
            onFeedbackRequested: undefined,
            log: wsLog,
        });

        this.pending.onPendingDelivered((delivery) => {
            this._onPendingDelivered(delivery.comments, delivery.images);
        });
    }

    // ── Public API ──────────────────────────────────────────

    setWorkspaces(workspaces: string[]): void {
        this.workspaces = workspaces;
        this.timeline.setWorkspaces(workspaces);
    }

    onFeedbackRequest(cb: () => void): void {
        this.feedbackFlow.setOnFeedbackRequested(cb);
    }

    onFeedbackResolved(cb: () => void): void {
        this.feedbackFlow.setOnFeedbackResolved(cb);
    }

    getPort(): number {
        return this.port;
    }

    getConnectedClients(): { webviews: number; mcpServers: number } {
        return this.clients.counts();
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
        this.timeline.dispose();

        this.pending.clear();

        this.clients.closeAll();

        this.feedback.rejectAll(new Error('Server shutting down'));

        if (this.wss) { this.wss.close(); this.wss = null; }
        if (this.server) { this.server.close(); this.server = null; }

        for (const ws of this.workspaces) {
            deleteServerByHash(projectHash(ws));
        }
    }

    private _addMessage(msg: ConversationMessage): void {
        this.timeline.addMessage(msg);
    }

    // ── Server Setup ────────────────────────────────────────

    private _findPort(): Promise<number> {
        return findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
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
        const handled = handleHttpRoute(req, res, {
            port: this.port,
            version: this.version,
            pending: this.pending,
            log: wsLog,
        });
        if (handled) return;

        res.setHeader('Content-Type', 'application/json');
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not_found' }));
    }

    private _registerServer(): void {
        for (const ws of this.workspaces) {
            writeServer(projectHash(ws), {
                port: this.port,
                pid: process.pid,
                projectPath: ws,
                version: this.version,
                started_at: Date.now(),
            });
        }
    }

    // ── Connection Handling ─────────────────────────────────

    private _handleConnection(ws: WebSocket): void {
        const client = this.clients.add(ws);

        this._send(ws, { type: 'connection_established', version: this.version, port: this.port });
        bindClientConnectionHandlers(ws, client, {
            onParsedMessage: (raw) => {
                try {
                    this._routeMessage(ws, client, decodeWsMessage(raw));
                } catch (e) {
                    console.error('[MCP Feedback] Parse error:', e);
                }
            },
            onDisconnect: () => {
                this.clients.remove(ws);
            },
        });
    }

    private _routeMessage(ws: WebSocket, client: ConnectedClient, msg: WSMessage): void {
        dispatchRouteMessage(ws, client, msg, {
            onRegister: (clientType) => {
                client.clientType = clientType;
                wsLog(`client registered: type=${client.clientType}`);
            },
            onFeedbackRequest: (mcpWs, req) => this._handleFeedbackRequest(mcpWs, req),
            onFeedbackResponse: (res) => this._handleFeedbackResponse(res),
            onQueuePending: (qp) => this._handleQueuePending(qp),
            onDismiss: () => this._handleDismiss(),
            onGetState: (targetWs) => this._sendState(targetWs),
            sendPong: (targetWs) => this._send(targetWs, { type: 'pong' }),
            onProtocolError: (context) => this._send(ws, {
                type: 'protocol_error',
                error: `Invalid message: ${context}`,
            }),
        });
    }

    // ── Feedback Flow ───────────────────────────────────────

    private _handleFeedbackRequest(mcpWs: WebSocket, req: { summary: string; project_directory?: string }): void {
        this.feedbackFlow.handleFeedbackRequest(mcpWs, req);
    }

    private _handleFeedbackResponse(res: { feedback: string; images?: string[] }): void {
        this.feedbackFlow.handleFeedbackResponse(res);
    }

    private _handleDismiss(): void {
        this.feedbackFlow.handleDismiss();
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
        const combined = comments.join('\n\n') || '';
        this._addMessage({
            role: 'user',
            content: combined,
            timestamp: new Date().toISOString(),
            pending_delivered: true,
            images: images.length > 0 ? images : undefined,
        });

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
            messages: this.timeline.getMessages(),
            pending_comments: entry?.comments ?? [],
            pending_images: entry?.images ?? [],
            feedback_queue_size: this.feedback.pendingCount(),
        });
    }

    // ── Heartbeat ───────────────────────────────────────────

    private _startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.clients.sweepStale(Date.now(), CLIENT_TIMEOUT, () => {});
        }, HEARTBEAT_INTERVAL);
    }

    // ── Transport ───────────────────────────────────────────

    private _send(ws: WebSocket, data: Record<string, unknown>): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    private _broadcastToWebviews(data: Record<string, unknown>): void {
        this.clients.forEachWebview((ws) => this._send(ws, data));
    }
}
