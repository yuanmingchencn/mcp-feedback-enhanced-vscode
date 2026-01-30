/**
 * WebSocket Server for MCP Feedback
 * 
 * Extension acts as the server, both Webview and MCP Server connect to it.
 */

import WebSocket, { WebSocketServer } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import Database from 'better-sqlite3';

// Read version from package.json
const packageJson = require('../package.json');
const VERSION = packageJson.version || '0.0.0';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
const SERVERS_DIR = path.join(CONFIG_DIR, 'servers');
const HISTORY_DIR = path.join(CONFIG_DIR, 'history');
const DEFAULT_PORT = 8765;
const MAX_PORT_RANGE = 100;       // Search 100 ports for available one
const MAX_HISTORY_MESSAGES = 100; // Keep last 100 messages per project

// Each Extension instance has its own server file: servers/<pid>.json
function getServerFile(): string {
    return path.join(SERVERS_DIR, `${process.pid}.json`);
}

interface Client {
    ws: WebSocket.WebSocket;
    type: 'webview' | 'mcp-server' | 'unknown';
    projectPath?: string;
    sessionId?: string;
    registeredAt: number;
}

interface HistoryMessage {
    role: 'ai' | 'user';
    content: string;
    timestamp: string;
    images?: string[];
    workspace?: string;      // Current workspace path
    project_directory?: string;  // MCP call's project_directory
}

interface SessionRecord {
    summary: string;
    feedback: string;
    timestamp: string;
    images?: string[];
}

interface PendingFeedback {
    sessionId: string;
    summary: string;
    projectPath: string;
    clientWs: WebSocket.WebSocket;  // Store reference to MCP Server WebSocket
    resolve: (result: any) => void;
    reject: (error: any) => void;
    timeout: NodeJS.Timeout;
}

export class FeedbackWebSocketServer {
    private _wss: WebSocketServer | null = null;
    private _clients: Map<WebSocket.WebSocket, Client> = new Map();
    private _pendingFeedback: Map<string, PendingFeedback> = new Map();
    private _port: number = DEFAULT_PORT;
    private _onStatusChange: (status: string) => void;
    private _onFeedbackRequest: (() => void) | null = null;
    private _heartbeatInterval: NodeJS.Timeout | null = null;
    private _clientLastPong: Map<WebSocket.WebSocket, number> = new Map();  // Track last pong time
    private static readonly HEARTBEAT_INTERVAL = 15000;  // 15 seconds
    private static readonly HEARTBEAT_TIMEOUT = 45000;   // 45 seconds - 3 missed heartbeats

    constructor(onStatusChange?: (status: string) => void) {
        this._onStatusChange = onStatusChange || (() => {});
        this._ensureDirectories();
    }

    /**
     * Register callback for when feedback request comes in (to auto-open panel)
     */
    onFeedbackRequest(callback: () => void): void {
        this._onFeedbackRequest = callback;
    }

    /**
     * Force restart the WebSocket server (for recovery from broken state)
     */
    async restart(): Promise<number> {
        console.log('[MCP Feedback WS] Force restarting server...');
        this._stopInternal();
        
        // Small delay to ensure port is released
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Clean up any stale server files
        this._cleanupStaleServers();
        
        // Restart
        return this.start();
    }

    /**
     * Get server status for diagnostics
     */
    getStatus(): {
        running: boolean;
        port: number;
        clients: { type: string; projectPath?: string }[];
        pendingFeedback: number;
    } {
        return {
            running: this._wss !== null,
            port: this._port,
            clients: Array.from(this._clients.values()).map(c => ({
                type: c.type,
                projectPath: c.projectPath
            })),
            pendingFeedback: this._pendingFeedback.size
        };
    }

    private _ensureDirectories(): void {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        if (!fs.existsSync(SERVERS_DIR)) {
            fs.mkdirSync(SERVERS_DIR, { recursive: true });
        }
        if (!fs.existsSync(HISTORY_DIR)) {
            fs.mkdirSync(HISTORY_DIR, { recursive: true });
        }
        // Clean up stale server files on startup
        this._cleanupStaleServers();
    }

    /**
     * Remove server files for dead processes
     */
    private _cleanupStaleServers(): void {
        try {
            const files = fs.readdirSync(SERVERS_DIR);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const pid = parseInt(file.replace('.json', ''));
                if (isNaN(pid)) continue;
                
                // Check if process is alive
                try {
                    process.kill(pid, 0);
                } catch {
                    // Process is dead, remove file
                    const filePath = path.join(SERVERS_DIR, file);
                    fs.unlinkSync(filePath);
                    console.log(`[MCP Feedback WS] Cleaned up stale server file: ${file}`);
                }
            }
        } catch (e) {
            // Ignore errors during cleanup
        }
    }

    /**
     * Start the WebSocket server
     */
    async start(): Promise<number> {
        this._port = await this._findAvailablePort(DEFAULT_PORT);
        
        return new Promise((resolve, reject) => {
            this._wss = new WebSocketServer({ 
                port: this._port, 
                host: '127.0.0.1' 
            });

            this._wss.on('listening', () => {
                console.log(`[MCP Feedback WS] Server listening on port ${this._port}`);
                this._writeServerFile();
                this._onStatusChange('running');
                
                // Start heartbeat monitoring
                this._startHeartbeat();
                
                resolve(this._port);
            });

            this._wss.on('error', (err) => {
                console.error(`[MCP Feedback WS] Server error: ${err}`);
                reject(err);
            });

            this._wss.on('connection', (ws) => {
                this._handleConnection(ws);
            });
        });
    }

    /**
     * Start heartbeat monitoring for dead connections
     */
    private _startHeartbeat(): void {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
        }
        
        this._heartbeatInterval = setInterval(() => {
            const now = Date.now();
            
            this._clients.forEach((client, ws) => {
                // Check if client hasn't responded to ping in timeout period
                const lastPong = this._clientLastPong.get(ws) || client.registeredAt;
                if (now - lastPong > FeedbackWebSocketServer.HEARTBEAT_TIMEOUT) {
                    console.log(`[MCP Feedback WS] Client heartbeat timeout: ${client.type}`);
                    // Force close the connection
                    try {
                        ws.terminate();
                    } catch (e) {
                        // Ignore
                    }
                    this._clients.delete(ws);
                    this._clientLastPong.delete(ws);
                    return;
                }
                
                // Send ping
                if (ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.ping();
                    } catch (e) {
                        // Ignore ping errors
                    }
                }
            });
        }, FeedbackWebSocketServer.HEARTBEAT_INTERVAL);
    }

    /**
     * Stop the WebSocket server
     */
    stop(): void {
        this._stopInternal();
    }

    private _stopInternal(): void {
        if (this._wss) {
            console.log('[MCP Feedback WS] Stopping server...');
            
            // Clear heartbeat interval
            if (this._heartbeatInterval) {
                clearInterval(this._heartbeatInterval);
                this._heartbeatInterval = null;
            }
            
            // Clear all pending feedback timeouts
            this._pendingFeedback.forEach((pending) => {
                clearTimeout(pending.timeout);
            });
            this._pendingFeedback.clear();
            
            // Force close all client connections with error code
            this._clients.forEach((client) => {
                try {
                    client.ws.close(1000, 'Server stopping');
                } catch (e) {
                    // Ignore close errors
                }
            });
            this._clients.clear();

            // Close server
            try {
                this._wss.close();
            } catch (e) {
                console.error('[MCP Feedback WS] Error closing server:', e);
            }
            this._wss = null;

            // Remove server file
            this._removeServerFile();
            
            // Close database connection
            this._closeDb();

            console.log('[MCP Feedback WS] Server stopped');
            this._onStatusChange('stopped');
        }
    }

    /**
     * Get current port
     */
    get port(): number {
        return this._port;
    }

    /**
     * Get connected client counts (used in status messages)
     */
    private getClientCounts(): { webviews: number; mcpServers: number } {
        let webviews = 0;
        let mcpServers = 0;
        this._clients.forEach((client) => {
            if (client.type === 'webview') webviews++;
            if (client.type === 'mcp-server') mcpServers++;
        });
        return { webviews, mcpServers };
    }

    private async _findAvailablePort(basePort: number): Promise<number> {
        for (let p = basePort; p < basePort + MAX_PORT_RANGE; p++) {
            if (await this._isPortAvailable(p)) {
                return p;
            }
        }
        throw new Error(`No available port found in range ${basePort}-${basePort + MAX_PORT_RANGE - 1}`);
    }

    private _isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            server.listen(port, '127.0.0.1');
        });
    }

    private _workspaces: string[] = [];

    /**
     * Set workspace paths (called from extension.ts)
     */
    setWorkspaces(workspaces: string[]): void {
        this._workspaces = workspaces;
        // Update server file with new workspace info
        if (this._wss) {
            this._writeServerFile();
        }
    }

    private _writeServerFile(): void {
        const data = {
            port: this._port,
            pid: process.pid,
            parentPid: process.ppid,  // Keep for backward compatibility
            workspaces: this._workspaces,  // Workspace paths for matching
            cursorTraceId: process.env['CURSOR_TRACE_ID'] || '',  // Unique ID per Cursor window
            timestamp: Date.now()
        };
        const serverFile = getServerFile();
        fs.writeFileSync(serverFile, JSON.stringify(data, null, 2));
        console.log(`[MCP Feedback WS] Wrote server file: ${serverFile}, workspaces: ${this._workspaces.join(', ')}, traceId=${data.cursorTraceId}`);
    }

    private _removeServerFile(): void {
        try {
            const serverFile = getServerFile();
            if (fs.existsSync(serverFile)) {
                fs.unlinkSync(serverFile);
                console.log(`[MCP Feedback WS] Removed server file: ${serverFile}`);
            }
        } catch (e) {
            // Ignore
        }
    }

    private _handleConnection(ws: WebSocket.WebSocket): void {
        const client: Client = {
            ws,
            type: 'unknown',
            registeredAt: Date.now()
        };
        this._clients.set(ws, client);

        console.log(`[MCP Feedback WS] Client connected, total: ${this._clients.size}`);

        // Send welcome message
        this._send(ws, {
            type: 'connection_established',
            message: 'Connected to MCP Feedback Extension Server',
            version: VERSION
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                this._handleMessage(ws, message);
            } catch (e) {
                console.error(`[MCP Feedback WS] Parse error: ${e}`);
            }
        });

        ws.on('close', () => {
            const client = this._clients.get(ws);
            console.log(`[MCP Feedback WS] Client disconnected: ${client?.type || 'unknown'}`);
            
            // Clean up pending feedback for this MCP Server
            if (client?.type === 'mcp-server') {
                const toRemove: string[] = [];
                this._pendingFeedback.forEach((pending, sessionId) => {
                    if (pending.clientWs === ws) {
                        clearTimeout(pending.timeout);
                        toRemove.push(sessionId);
                    }
                });
                toRemove.forEach(id => {
                    this._pendingFeedback.delete(id);
                    console.log(`[MCP Feedback WS] Cleaned up pending feedback: session=${id}`);
                });
            }
            
            this._clients.delete(ws);
        });

        ws.on('error', (err) => {
            console.error(`[MCP Feedback WS] Client error: ${err}`);
        });

        // Handle pong responses for heartbeat
        ws.on('pong', () => {
            this._clientLastPong.set(ws, Date.now());
        });
    }

    private _handleMessage(ws: WebSocket.WebSocket, message: any): void {
        const client = this._clients.get(ws);
        if (!client) return;

        console.log(`[MCP Feedback WS] Message from ${client.type}: ${message.type}`);

        switch (message.type) {
            case 'register':
                // Client registration (webview or mcp-server)
                client.type = message.clientType || 'webview';
                client.projectPath = message.projectPath;
                client.sessionId = message.sessionId;
                console.log(`[MCP Feedback WS] Registered ${client.type}: project=${client.projectPath}`);
                
                // Send history to webview
                if (client.type === 'webview' && client.projectPath) {
                    const messages = this._loadHistory(client.projectPath);
                    const sessions = this._toSessionRecords(messages);
                    this._send(ws, { type: 'history', sessions });
                }
                
                // Notify status
                this._send(ws, { 
                    type: 'status_update', 
                    ...this.getClientCounts() 
                });
                break;

            case 'feedback_request':
                // From MCP Server: request feedback from webview
                this._handleFeedbackRequest(client, message);
                break;

            case 'feedback_response':
                // From Webview: user submitted feedback
                this._handleFeedbackResponse(client, message);
                break;

            case 'get_history':
                if (client.projectPath) {
                    const messages = this._loadHistory(client.projectPath);
                    const sessions = this._toSessionRecords(messages);
                    this._send(ws, { type: 'history', sessions });
                }
                break;

            case 'ping':
            case 'heartbeat':
                // Update last pong time for application-level pings too
                this._clientLastPong.set(ws, Date.now());
                this._send(ws, { type: 'pong' });
                break;
        }
    }

    private _handleFeedbackRequest(client: Client, message: any): void {
        const { session_id, summary, project_directory, timeout, agent_name } = message;
        
        console.log(`[MCP Feedback WS] Feedback request: session=${session_id}, project=${project_directory}, agent=${agent_name || 'default'}`);

        // Notify extension to auto-open panel
        if (this._onFeedbackRequest) {
            this._onFeedbackRequest();
        }

        // Find all webviews for this project (in this window's server)
        // With CURSOR_TRACE_ID matching, MCP server connects to correct window's server
        const webviews = this._findWebviewsForProject(project_directory);

        // Use webview's projectPath as workspace
        const workspace = webviews.length > 0 && webviews[0].projectPath 
            ? webviews[0].projectPath 
            : project_directory;

        // Add AI message to global history with both workspace and project_directory
        this._addToHistory(workspace, {
            role: 'ai',
            content: summary,
            timestamp: new Date().toISOString()
        }, project_directory);
        
        if (webviews.length === 0) {
            // No webview connected - send error back to MCP Server
            this._send(client.ws, {
                type: 'feedback_error',
                session_id,
                error: 'No feedback panel connected. Please open the MCP Feedback panel in Cursor sidebar.'
            });
            return;
        }

        // Broadcast to all webviews in this window (with agent_name for multi-agent UI)
        const sessionMsg = {
            type: 'session_updated',
            session_info: {
                session_id,
                summary,
                project_directory,
                timeout,
                agent_name  // Pass through for multi-agent display
            }
        };
        webviews.forEach(wv => this._send(wv.ws, sessionMsg));
        console.log(`[MCP Feedback WS] Broadcast to ${webviews.length} webview(s)`);

        // Store pending feedback with timeout
        const timeoutMs = (timeout || 600) * 1000;
        const timeoutHandle = setTimeout(() => {
            const pending = this._pendingFeedback.get(session_id);
            if (pending) {
                pending.reject(new Error('Feedback timeout'));
                this._pendingFeedback.delete(session_id);
            }
        }, timeoutMs);

        this._pendingFeedback.set(session_id, {
            sessionId: session_id,
            summary,
            projectPath: project_directory,
            clientWs: client.ws,
            resolve: (result) => {
                // Check if MCP Server connection is still alive
                if (client.ws.readyState === WebSocket.OPEN) {
                    this._send(client.ws, {
                        type: 'feedback_result',
                        session_id,
                        ...result
                    });
                } else {
                    console.log(`[MCP Feedback WS] Cannot send result - MCP Server disconnected: session=${session_id}`);
                    // The MCP Server will timeout on its side
                }
            },
            reject: (error) => {
                // Check if MCP Server connection is still alive
                if (client.ws.readyState === WebSocket.OPEN) {
                    this._send(client.ws, {
                        type: 'feedback_error',
                        session_id,
                        error: error.message
                    });
                } else {
                    console.log(`[MCP Feedback WS] Cannot send error - MCP Server disconnected: session=${session_id}`);
                }
            },
            timeout: timeoutHandle
        });
    }

    private _handleFeedbackResponse(client: Client, message: any): void {
        const { session_id, feedback, images, dismissed } = message;
        
        if (!session_id) {
            console.log(`[MCP Feedback WS] Ignoring feedback response without session_id`);
            return;
        }
        
        console.log(`[MCP Feedback WS] Feedback response: session=${session_id}, dismissed=${!!dismissed}`);

        // Get project_directory from pending feedback (if exists)
        const pending = this._pendingFeedback.get(session_id);
        const projectDirectory = pending?.projectPath;  // This is actually project_directory from MCP call

        // Add user message to history (skip if dismissed)
        const workspace = client.projectPath || '';
        if (workspace && !dismissed) {
            this._addToHistory(workspace, {
                role: 'user',
                content: feedback,
                timestamp: new Date().toISOString(),
                images
            }, projectDirectory);  // Pass project_directory as second param
        }

        // Notify all webviews that feedback was submitted (for multi-panel sync)
        // Also send updated history so all panels stay in sync
        const webviews = this._findWebviewsForProject(workspace);
        const history = this._loadHistory(workspace);
        const sessions = this._toSessionRecords(history);
        webviews.forEach(wv => {
            if (wv.ws !== client.ws) { // Don't send to submitter
                this._send(wv.ws, { type: 'feedback_submitted', session_id });
                this._send(wv.ws, { type: 'history', sessions });
            }
        });

        // Resolve/reject pending feedback (reuse pending from earlier)
        if (pending) {
            clearTimeout(pending.timeout);
            
            if (dismissed) {
                // User dismissed without response - reject
                pending.reject(new Error('User dismissed the feedback request'));
            } else {
                // Normal feedback response
                pending.resolve({
                    feedback,
                    images: images || []
                });
            }
            this._pendingFeedback.delete(session_id);
        } else {
            console.log(`[MCP Feedback WS] No pending feedback for session ${session_id}`);
        }
    }

    /**
     * Find all webviews that match the project (for broadcasting)
     */
    private _findWebviewsForProject(projectPath: string, singleOnly: boolean = false): Client[] {
        const exactMatches: Client[] = [];
        const prefixMatches: Client[] = [];
        
        for (const [, client] of this._clients) {
            if (client.type !== 'webview') continue;
            
            // Exact match (highest priority)
            if (client.projectPath === projectPath) {
                exactMatches.push(client);
                continue;
            }
            
            // Path prefix match
            if (client.projectPath) {
                if (projectPath.startsWith(client.projectPath) || client.projectPath.startsWith(projectPath)) {
                    prefixMatches.push(client);
                }
            }
        }
        
        // Prefer exact matches over prefix matches
        let matches = exactMatches.length > 0 ? exactMatches : prefixMatches;
        
        // Fallback: all webviews if no match
        if (matches.length === 0) {
            for (const [, client] of this._clients) {
                if (client.type === 'webview') {
                    matches.push(client);
                }
            }
            if (matches.length > 0) {
                console.log(`[MCP Feedback WS] Using fallback: ${matches.length} webview(s)`);
            }
        }
        
        // If multiple matches and singleOnly requested, return most recently registered
        if (singleOnly && matches.length > 1) {
            matches.sort((a, b) => b.registeredAt - a.registeredAt);
            console.log(`[MCP Feedback WS] Multiple webviews matched, using most recent (sessionId=${matches[0].sessionId})`);
            return [matches[0]];
        }
        
        return matches;
    }

    private _send(ws: WebSocket.WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    // ============================================================================
    // History management - SQLite storage
    // ============================================================================
    
    private static readonly DB_FILE = path.join(HISTORY_DIR, 'history.db');
    private _db: Database.Database | null = null;

    /**
     * Get or create SQLite database connection
     */
    private _getDb(): Database.Database {
        if (this._db) return this._db;
        
        try {
            this._db = new Database(FeedbackWebSocketServer.DB_FILE);
            
            // Create table if not exists
            this._db.exec(`
                CREATE TABLE IF NOT EXISTS history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    images TEXT,
                    workspace TEXT,
                    project_directory TEXT,
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
                );
                CREATE INDEX IF NOT EXISTS idx_workspace ON history(workspace);
                CREATE INDEX IF NOT EXISTS idx_project_directory ON history(project_directory);
            `);
            
            console.log(`[MCP Feedback WS] SQLite database initialized: ${FeedbackWebSocketServer.DB_FILE}`);
            return this._db;
        } catch (e) {
            console.error(`[MCP Feedback WS] Failed to initialize database: ${e}`);
            throw e;
        }
    }

    /**
     * Close database connection (call on shutdown)
     */
    private _closeDb(): void {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }

    /**
     * Load history filtered by workspace or project
     */
    private _loadHistory(workspace: string): HistoryMessage[] {
        try {
            const db = this._getDb();
            const stmt = db.prepare(`
                SELECT role, content, timestamp, images, workspace, project_directory
                FROM history
                WHERE workspace = ? OR project_directory = ?
                ORDER BY id ASC
                LIMIT ?
            `);
            
            const rows = stmt.all(workspace, workspace, MAX_HISTORY_MESSAGES * 2) as any[];
            
            return rows.map(row => ({
                role: row.role as 'ai' | 'user',
                content: row.content,
                timestamp: row.timestamp,
                images: row.images ? JSON.parse(row.images) : undefined,
                workspace: row.workspace,
                project_directory: row.project_directory
            }));
        } catch (e) {
            console.error(`[MCP Feedback WS] Failed to load history: ${e}`);
            return [];
        }
    }

    /**
     * Convert raw messages to session records for webview display
     */
    private _toSessionRecords(messages: HistoryMessage[]): SessionRecord[] {
        const sessions: SessionRecord[] = [];
        let currentSession: Partial<SessionRecord> = {};
        
        for (const msg of messages) {
            if (msg.role === 'ai') {
                // New AI message = new session
                if (currentSession.summary) {
                    sessions.push(currentSession as SessionRecord);
                }
                currentSession = {
                    summary: msg.content,
                    feedback: '',
                    timestamp: msg.timestamp
                };
            } else if (msg.role === 'user') {
                currentSession.feedback = msg.content;
                currentSession.images = msg.images;
                sessions.push(currentSession as SessionRecord);
                currentSession = {};
            }
        }
        
        // Add incomplete session (AI waiting for response)
        if (currentSession.summary) {
            sessions.push(currentSession as SessionRecord);
        }
        
        return sessions;
    }

    /**
     * Add message to history
     */
    private _addToHistory(workspace: string, message: HistoryMessage, projectDirectory?: string): void {
        try {
            const db = this._getDb();
            const stmt = db.prepare(`
                INSERT INTO history (role, content, timestamp, images, workspace, project_directory)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            stmt.run(
                message.role,
                message.content,
                message.timestamp,
                message.images ? JSON.stringify(message.images) : null,
                workspace,
                projectDirectory || null
            );
            
            // Cleanup old records (keep last N * 3 globally)
            const cleanupStmt = db.prepare(`
                DELETE FROM history
                WHERE id NOT IN (
                    SELECT id FROM history ORDER BY id DESC LIMIT ?
                )
            `);
            cleanupStmt.run(MAX_HISTORY_MESSAGES * 3);
            
        } catch (e) {
            console.error(`[MCP Feedback WS] Failed to add to history: ${e}`);
        }
    }
}
