#!/usr/bin/env node
/**
 * MCP Feedback Server - TypeScript Implementation
 * 
 * This server provides the interactive_feedback tool that collects
 * user feedback through a VSCode extension sidebar panel.
 * 
 * NEW ARCHITECTURE: MCP Server connects to Extension's WebSocket Server
 * (instead of running its own WebSocket Server)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import * as z from 'zod';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import { createRequire } from 'module';
import { exec } from 'child_process';

// Read version from package.json (ES module compatible)
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const VERSION = packageJson.version || '0.0.0';

// Configuration
const DEBUG = process.env.MCP_FEEDBACK_DEBUG === 'true';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
const SERVERS_DIR = path.join(CONFIG_DIR, 'servers');
const CONNECTION_TIMEOUT_MS = 5000;  // 5 seconds to connect
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds heartbeat
const PORT_CHECK_TIMEOUT_MS = 1000;  // 1 second to check port
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;

interface ServerInfo {
    port: number;
    pid: number;
    parentPid: number;
    workspaces: string[];  // Workspace paths for matching
    cursorTraceId?: string;  // CURSOR_TRACE_ID for window identification
    timestamp: number;
}

// Debug logging
function debug(message: string) {
    if (DEBUG) {
        console.error(`[MCP Feedback] ${message}`);
    }
}

// State
let ws: WebSocket | null = null;
let isConnected = false;
let pendingFeedbackResolvers: Map<string, {
    resolve: (result: any) => void;
    reject: (error: any) => void;
    timeout: NodeJS.Timeout;
}> = new Map();
let cachedAgentName: string | null = null;

/**
 * Check if a port is actually accepting connections
 */
function checkPortConnectivity(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let resolved = false;

        const cleanup = () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
            }
        };

        socket.setTimeout(PORT_CHECK_TIMEOUT_MS);

        socket.on('connect', () => {
            cleanup();
            resolve(true);
        });

        socket.on('error', () => {
            cleanup();
            resolve(false);
        });

        socket.on('timeout', () => {
            cleanup();
            resolve(false);
        });

        socket.connect(port, '127.0.0.1');
    });
}

/**
 * Get all live Extension servers (with port connectivity check)
 */
async function getLiveServersAsync(): Promise<ServerInfo[]> {
    try {
        if (!fs.existsSync(SERVERS_DIR)) {
            debug('Servers directory not found');
            return [];
        }

        const files = fs.readdirSync(SERVERS_DIR);
        const servers: ServerInfo[] = [];

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(SERVERS_DIR, file), 'utf-8'));
                // Verify process is still alive
                try {
                    process.kill(data.pid, 0);

                    // Also check if port is actually responding (fixes stale port bug)
                    const portOk = await checkPortConnectivity(data.port);
                    if (portOk) {
                        servers.push({
                            ...data,
                            workspaces: data.workspaces || []
                        });
                    } else {
                        debug(`Skipping server with unresponsive port: pid=${data.pid}, port=${data.port}`);
                        // Remove stale server file
                        try {
                            fs.unlinkSync(path.join(SERVERS_DIR, file));
                            debug(`Removed stale server file: ${file}`);
                        } catch { /* ignore */ }
                    }
                } catch {
                    debug(`Skipping dead server: pid=${data.pid}`);
                }
            } catch {
                // Skip invalid files
            }
        }

        return servers;
    } catch (e) {
        debug(`Error reading servers: ${e}`);
        return [];
    }
}

/**
 * Get all live Extension servers (sync version for backward compat)
 */
function getLiveServers(): ServerInfo[] {
    try {
        if (!fs.existsSync(SERVERS_DIR)) {
            debug('Servers directory not found');
            return [];
        }

        const files = fs.readdirSync(SERVERS_DIR);
        const servers: ServerInfo[] = [];

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(SERVERS_DIR, file), 'utf-8'));
                // Verify process is still alive
                try {
                    process.kill(data.pid, 0);
                    servers.push({
                        ...data,
                        workspaces: data.workspaces || []  // Handle old format
                    });
                } catch {
                    // Process dead, skip
                    debug(`Skipping dead server: pid=${data.pid}`);
                }
            } catch {
                // Skip invalid files
            }
        }

        return servers;
    } catch (e) {
        debug(`Error reading servers: ${e}`);
        return [];
    }
}

/**
 * Find the best Extension server for a given project path
 * Uses workspace matching as primary strategy
 * Now async to support port connectivity checks
 */
async function findExtensionForProjectAsync(projectPath: string): Promise<ServerInfo | null> {
    const servers = await getLiveServersAsync();
    debug(`Looking for Extension for project: ${projectPath}`);
    debug(`Found ${servers.length} live Extension server(s) with valid ports`);

    if (servers.length === 0) {
        return null;
    }

    // Get MCP server's CURSOR_TRACE_ID (if running in Cursor)
    const myTraceId = process.env['CURSOR_TRACE_ID'] || '';
    debug(`My CURSOR_TRACE_ID: ${myTraceId || '(not set)'}`);

    // Strategy 0: CURSOR_TRACE_ID match (HIGHEST PRIORITY - same Cursor window)
    if (myTraceId) {
        const traceMatches = servers.filter(s => s.cursorTraceId === myTraceId);
        if (traceMatches.length === 1) {
            debug(`✓ Strategy 0: Single CURSOR_TRACE_ID match: port=${traceMatches[0].port}, pid=${traceMatches[0].pid}`);
            return traceMatches[0];
        } else if (traceMatches.length > 1) {
            // Multiple windows share same CURSOR_TRACE_ID - also check workspace
            debug(`  Strategy 0: Multiple CURSOR_TRACE_ID matches (${traceMatches.length}), checking workspace...`);
            const normalizedProject = projectPath.replace(/\/+$/, '');
            const workspaceMatch = traceMatches.find(s =>
                s.workspaces?.some((w: string) => {
                    const normalizedW = w.replace(/\/+$/, '');
                    return normalizedW === normalizedProject || 
                           normalizedProject.startsWith(normalizedW + '/') || 
                           normalizedW.startsWith(normalizedProject + '/');
                })
            );
            if (workspaceMatch) {
                debug(`✓ Strategy 0: CURSOR_TRACE_ID + workspace match: port=${workspaceMatch.port}, pid=${workspaceMatch.pid}`);
                return workspaceMatch;
            }
            // No workspace match among trace matches - fall through to other strategies
            debug(`  Strategy 0: No workspace match among trace ID matches, trying other strategies...`);
        }
    }

    // Strategy 1: Exact workspace match + traceId filter if available
    const workspaceMatches = servers.filter(s => s.workspaces?.includes(projectPath));
    if (workspaceMatches.length === 1) {
        debug(`✓ Exact workspace match (single): port=${workspaceMatches[0].port}`);
        return workspaceMatches[0];
    }
    if (workspaceMatches.length > 1) {
        // Multiple windows have this workspace - take most recent
        const sorted = workspaceMatches.sort((a, b) => b.timestamp - a.timestamp);
        debug(`✓ Exact workspace match (multiple, taking most recent): port=${sorted[0].port}`);
        return sorted[0];
    }

    // Strategy 2: Prefix match (project is inside a workspace)
    for (const server of servers) {
        for (const ws of server.workspaces || []) {
            if (projectPath.startsWith(ws + path.sep) || ws.startsWith(projectPath + path.sep)) {
                debug(`✓ Prefix workspace match: port=${server.port}, workspace=${ws}`);
                return server;
            }
        }
    }

    // Strategy 3: parentPid match (backward compatibility)
    const myParentPid = process.ppid;
    const parentMatch = servers.find(s => s.parentPid === myParentPid);
    if (parentMatch) {
        debug(`✓ parentPid match: port=${parentMatch.port}`);
        return parentMatch;
    }

    // Strategy 4: Single server fallback
    if (servers.length === 1) {
        debug(`✓ Single server fallback: port=${servers[0].port}`);
        return servers[0];
    }

    // Strategy 5: Most recent server
    const sorted = servers.sort((a, b) => b.timestamp - a.timestamp);
    debug(`✓ Using most recent server: port=${sorted[0].port}`);
    debug(`  Available servers:`);
    sorted.forEach(s => {
        debug(`    - pid=${s.pid}, port=${s.port}, traceId=${s.cursorTraceId}, workspaces=${s.workspaces?.join(', ')}`);
    });

    return sorted[0];
}

/**
 * Find the best Extension server (sync version for debug/startup)
 */
function findExtensionForProject(projectPath: string): ServerInfo | null {
    const servers = getLiveServers();
    if (servers.length === 0) return null;

    // Strategy 0: CURSOR_TRACE_ID match (highest priority)
    const myTraceId = process.env['CURSOR_TRACE_ID'] || '';
    if (myTraceId) {
        const traceMatch = servers.find(s => s.cursorTraceId === myTraceId);
        if (traceMatch) return traceMatch;
    }

    // Strategy 1: Exact workspace match
    const workspaceMatches = servers.filter(s => s.workspaces?.includes(projectPath));
    if (workspaceMatches.length >= 1) {
        return workspaceMatches.sort((a, b) => b.timestamp - a.timestamp)[0];
    }

    // Strategy 2: Prefix match
    for (const server of servers) {
        for (const ws of server.workspaces || []) {
            if (projectPath.startsWith(ws + path.sep) || ws.startsWith(projectPath + path.sep)) {
                return server;
            }
        }
    }

    // Strategy 3: parentPid match
    const parentMatch = servers.find(s => s.parentPid === process.ppid);
    if (parentMatch) return parentMatch;

    // Fallbacks
    if (servers.length === 1) return servers[0];
    return servers.sort((a, b) => b.timestamp - a.timestamp)[0];
}

// Track which server we're connected to
let connectedPort: number | null = null;
let lastProjectPath: string = '';

/**
 * Connect to Extension's WebSocket Server for a specific project
 * With retry logic for handling stale connections
 */
async function connectToExtensionWithRetry(projectPath: string, maxRetries: number = MAX_RECONNECT_ATTEMPTS): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await connectToExtension(projectPath);
            return; // Success
        } catch (err: any) {
            lastError = err;
            debug(`Connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);

            if (attempt < maxRetries) {
                // Wait before retry with exponential backoff
                const delay = RECONNECT_DELAY_MS * attempt;
                debug(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError || new Error('Connection failed after retries');
}

/**
 * Connect to Extension's WebSocket Server for a specific project
 */
async function connectToExtension(projectPath: string): Promise<void> {
    // Use async version to check port connectivity
    const server = await findExtensionForProjectAsync(projectPath);

    if (!server) {
        throw new Error(`No MCP Feedback Extension found for project: ${projectPath}. Please ensure the extension is installed and a Cursor window is open with this project.`);
    }

    const url = `ws://127.0.0.1:${server.port}/ws`;

    debug(`Connecting to Extension at ${url} for project ${projectPath}`);

    return new Promise((resolve, reject) => {
        ws = new WebSocket(url);

        ws.on('open', () => {
            debug('Connected to Extension WebSocket Server');
            isConnected = true;
            connectedPort = server.port;
            lastProjectPath = projectPath;

            // Register as MCP Server
            ws?.send(JSON.stringify({
                type: 'register',
                clientType: 'mcp-server',
                pid: process.pid,
                parentPid: process.ppid
            }));

            resolve();
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                handleMessage(message);
            } catch (e) {
                debug(`Parse error: ${e}`);
            }
        });

        ws.on('close', () => {
            debug('Disconnected from Extension');
            const wasConnected = isConnected;
            isConnected = false;
            connectedPort = null;
            ws = null;

            // Reject all pending feedback resolvers to prevent hanging forever
            if (wasConnected && pendingFeedbackResolvers.size > 0) {
                debug(`Connection lost with ${pendingFeedbackResolvers.size} pending requests - rejecting all`);
                const error = new Error('Connection closed unexpectedly');
                for (const [sessionId, resolver] of pendingFeedbackResolvers.entries()) {
                    clearTimeout(resolver.timeout);
                    resolver.reject(error);
                }
                pendingFeedbackResolvers.clear();
            }
        });

        ws.on('error', (err) => {
            debug(`WebSocket error: ${err.message}`);
            if (!isConnected) {
                reject(err);
            }
        });

        // Timeout for initial connection
        setTimeout(() => {
            if (!isConnected) {
                ws?.close();
                ws = null;
                isConnected = false;
                reject(new Error(`Connection timeout to ${url}`));
            }
        }, CONNECTION_TIMEOUT_MS);
    });
}

/**
 * Ensure connected to the right Extension for this project
 * With automatic reconnection and retry
 */
async function ensureConnectedForProject(projectPath: string): Promise<void> {
    // Use async version to check port connectivity
    const server = await findExtensionForProjectAsync(projectPath);
    if (!server) {
        throw new Error(`No MCP Feedback Extension found for project: ${projectPath}. Please open the project in Cursor with the MCP Feedback extension installed.`);
    }

    // If already connected to the right server and connection is open, reuse
    if (isConnected && ws?.readyState === WebSocket.OPEN && connectedPort === server.port) {
        return;
    }

    // Close existing connection if any
    if (ws) {
        debug('Closing existing connection for reconnect');
        ws.close();
        ws = null;
        isConnected = false;
        connectedPort = null;
    }

    // Connect with retry logic
    await connectToExtensionWithRetry(projectPath);
}

/**
 * Handle messages from Extension
 */
function handleMessage(message: any) {
    debug(`Received: ${message.type}`);

    switch (message.type) {
        case 'connection_established':
            debug(`Connected to Extension v${message.version}`);
            break;

        case 'feedback_result':
            // User submitted feedback
            const resolver = pendingFeedbackResolvers.get(message.session_id);
            if (resolver) {
                clearTimeout(resolver.timeout);
                resolver.resolve({
                    feedback: message.feedback,
                    images: message.images || []
                });
                pendingFeedbackResolvers.delete(message.session_id);
            }
            break;

        case 'feedback_error':
            // Error getting feedback
            const errorResolver = pendingFeedbackResolvers.get(message.session_id);
            if (errorResolver) {
                clearTimeout(errorResolver.timeout);
                errorResolver.reject(new Error(message.error));
                pendingFeedbackResolvers.delete(message.session_id);
            }
            break;

        case 'pong':
            // Heartbeat response
            break;

        case 'pending_comment_result':
            // Result for get_pending_comment
            const pendingResolver = pendingFeedbackResolvers.get(message.request_id);
            if (pendingResolver) {
                clearTimeout(pendingResolver.timeout);
                pendingResolver.resolve(message.comment || '');
                pendingFeedbackResolvers.delete(message.request_id);
            }
            break;
    }
}

/**
 * Request feedback from user via Extension
 * Falls back to browser if extension is not available
 */
async function requestFeedback(
    projectDirectory: string,
    summary: string,
    timeout: number,
    agentName?: string
): Promise<{ feedback: string; images: Array<{ name?: string; data: string }> }> {

    // Try to connect to extension first
    try {
        await ensureConnectedForProject(projectDirectory);
    } catch (e) {
        // Extension not available, fall back to browser
        debug(`Extension not available, falling back to browser: ${(e as Error).message}`);
        return requestFeedbackViaBrowser(projectDirectory, summary, timeout);
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    // Auto-generate agent_name from summary if not provided
    let effectiveAgentName = agentName;
    if (!effectiveAgentName || effectiveAgentName === 'Agent') {
        if (cachedAgentName) {
            effectiveAgentName = cachedAgentName;
        } else {
            // Generate from summary: take first meaningful line, limit to 50 chars
            const firstLine = summary.split('\n').find(l => l.trim().length > 0) || summary;
            const cleaned = firstLine.replace(/^[#*\->\s]+/, '').trim();
            effectiveAgentName = cleaned.length > 50 ? cleaned.substring(0, 47) + '...' : cleaned;
            if (!effectiveAgentName) effectiveAgentName = 'Agent';
            cachedAgentName = effectiveAgentName;
        }
    } else {
        // Cache the explicitly provided name
        cachedAgentName = effectiveAgentName;
    }

    return new Promise((resolve, reject) => {
        // Set timeout
        const timeoutHandle = setTimeout(() => {
            pendingFeedbackResolvers.delete(sessionId);
            reject(new Error(`Feedback timeout after ${timeout} seconds`));
        }, timeout * 1000);

        // Store resolver
        pendingFeedbackResolvers.set(sessionId, {
            resolve,
            reject,
            timeout: timeoutHandle
        });

        // Send request to Extension
        ws?.send(JSON.stringify({
            type: 'feedback_request',
            session_id: sessionId,
            project_directory: projectDirectory,
            summary,
            timeout,
            agent_name: effectiveAgentName  // For multi-agent display
        }));

        debug(`Feedback request sent: session=${sessionId}, agent=${effectiveAgentName || 'default'}`);
    });
}

// ============================================================================
// Pending Comment Resource Logic
// ============================================================================

/**
 * Get pending comment from Extension
 */
async function getPendingComment(projectDirectory: string): Promise<string> {
    try {
        await ensureConnectedForProject(projectDirectory);
    } catch (e) {
        debug(`Extension not available for pending comment: ${(e as Error).message}`);
        return '';
    }

    // Generate request ID
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    return new Promise((resolve) => {
        // Set timeout - resolve empty if timeout
        const timeoutHandle = setTimeout(() => {
            const resolver = pendingFeedbackResolvers.get(requestId);
            if (resolver) {
                pendingFeedbackResolvers.delete(requestId);
                debug(`Pending comment timeout: ${requestId}`);
                resolve('');
            }
        }, 1000); // 1s timeout for resource read is enough

        // Store resolver
        pendingFeedbackResolvers.set(requestId, {
            resolve: (result) => resolve(result),
            reject: () => resolve(''), // Should not happen for this type
            timeout: timeoutHandle
        });

        // Send request
        ws?.send(JSON.stringify({
            type: 'get_pending_comment',
            request_id: requestId,
            project_directory: projectDirectory
        }));
    });
}

// ============================================================================
// Browser Fallback
// ============================================================================

/**
 * Open system default browser
 */
function openBrowser(url: string): void {
    const platform = os.platform();
    let cmd: string;

    if (platform === 'darwin') {
        cmd = `open "${url}"`;
    } else if (platform === 'win32') {
        cmd = `start "" "${url}"`;
    } else {
        cmd = `xdg-open "${url}"`;
    }

    exec(cmd, (error) => {
        if (error) {
            debug(`Failed to open browser: ${error.message}`);
        }
    });
}

/**
 * Generate HTML page for browser feedback
 */
function generateBrowserHtml(summary: string, port: number): string {
    const escapedSummary = summary
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '<br>');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP Feedback</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1e1e1e;
            color: #d4d4d4;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            max-width: 800px;
            width: 100%;
            background: #252526;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: #007acc;
            padding: 16px 24px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .header h1 {
            font-size: 18px;
            font-weight: 600;
            color: white;
        }
        .header .icon { font-size: 24px; }
        .content { padding: 24px; }
        .ai-message {
            background: #2d2d2d;
            border: 1px solid #3c3c3c;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 20px;
            max-height: 400px;
            overflow-y: auto;
            line-height: 1.6;
        }
        .label {
            font-size: 12px;
            color: #888;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .quick-btns {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        .quick-btn {
            padding: 8px 16px;
            background: transparent;
            border: 1px solid #3c3c3c;
            color: #d4d4d4;
            border-radius: 20px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
        }
        .quick-btn:hover {
            background: #3c3c3c;
            border-color: #569cd6;
        }
        textarea {
            width: 100%;
            min-height: 120px;
            padding: 12px;
            background: #2d2d2d;
            border: 1px solid #3c3c3c;
            border-radius: 8px;
            color: #d4d4d4;
            font-size: 14px;
            font-family: inherit;
            resize: vertical;
            margin-bottom: 16px;
        }
        textarea:focus {
            outline: none;
            border-color: #007acc;
        }
        .submit-btn {
            width: 100%;
            padding: 14px;
            background: #007acc;
            border: none;
            border-radius: 8px;
            color: white;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
        }
        .submit-btn:hover { background: #0098ff; }
        .submit-btn:disabled {
            background: #3c3c3c;
            cursor: not-allowed;
        }
        .success {
            text-align: center;
            padding: 40px;
        }
        .success .icon { font-size: 48px; margin-bottom: 16px; }
        .success h2 { color: #4ec9b0; margin-bottom: 8px; }
        .success p { color: #888; }
    </style>
</head>
<body>
    <div class="container" id="feedbackForm">
        <div class="header">
            <span class="icon">💬</span>
            <h1>MCP Feedback</h1>
        </div>
        <div class="content">
            <div class="label">🤖 AI Summary</div>
            <div class="ai-message">${escapedSummary}</div>
            
            <div class="label">💬 Your Feedback</div>
            <div class="quick-btns">
                <button class="quick-btn" onclick="setFeedback('Continue')">▶️ Continue</button>
                <button class="quick-btn" onclick="setFeedback('Looks good')">👍 Good</button>
                <button class="quick-btn" onclick="setFeedback('Please fix it')">🔧 Fix</button>
                <button class="quick-btn" onclick="setFeedback('Stop')">⏹️ Stop</button>
            </div>
            <textarea id="feedback" placeholder="Type your feedback here..."></textarea>
            <button class="submit-btn" id="submitBtn" onclick="submitFeedback()">Send Feedback</button>
        </div>
    </div>
    
    <div class="container" id="successMsg" style="display: none;">
        <div class="success">
            <div class="icon">✅</div>
            <h2>Feedback Sent!</h2>
            <p>You can close this window now.</p>
        </div>
    </div>
    
    <script>
        function setFeedback(text) {
            document.getElementById('feedback').value = text;
        }
        
        async function submitFeedback() {
            const feedback = document.getElementById('feedback').value.trim();
            if (!feedback) {
                alert('Please enter your feedback');
                return;
            }
            
            const btn = document.getElementById('submitBtn');
            btn.disabled = true;
            btn.textContent = 'Sending...';
            
            try {
                const response = await fetch('/submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ feedback })
                });
                
                if (response.ok) {
                    document.getElementById('feedbackForm').style.display = 'none';
                    document.getElementById('successMsg').style.display = 'block';
                } else {
                    throw new Error('Submit failed');
                }
            } catch (e) {
                btn.disabled = false;
                btn.textContent = 'Send Feedback';
                alert('Failed to send feedback. Please try again.');
            }
        }
    </script>
</body>
</html>`;
}

/**
 * Request feedback via browser (fallback when extension not available)
 */
async function requestFeedbackViaBrowser(
    projectDirectory: string,
    summary: string,
    timeout: number
): Promise<{ feedback: string; images: Array<{ name?: string; data: string }> }> {
    return new Promise((resolve, reject) => {
        // Find available port
        const server = http.createServer();

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to start HTTP server'));
                return;
            }

            const port = address.port;
            debug(`Browser feedback server started on port ${port}`);

            let feedbackReceived = false;

            // Handle requests
            server.on('request', (req, res) => {
                if (req.method === 'GET' && req.url === '/') {
                    // Serve HTML page
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(generateBrowserHtml(summary, port));
                } else if (req.method === 'POST' && req.url === '/submit') {
                    // Handle feedback submission
                    let body = '';
                    req.on('data', chunk => body += chunk);
                    req.on('end', () => {
                        try {
                            const data = JSON.parse(body);
                            feedbackReceived = true;

                            // Clear timeout since feedback was received successfully
                            clearTimeout(timeoutHandle);

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true }));

                            // Close server and resolve
                            setTimeout(() => {
                                server.close();
                                resolve({
                                    feedback: data.feedback || '',
                                    images: []
                                });
                            }, 1000);
                        } catch (e) {
                            res.writeHead(400);
                            res.end('Invalid request');
                        }
                    });
                } else {
                    res.writeHead(404);
                    res.end('Not found');
                }
            });

            // Open browser
            const url = `http://127.0.0.1:${port}`;
            debug(`Opening browser: ${url}`);
            openBrowser(url);

            // Timeout
            const timeoutHandle = setTimeout(() => {
                if (!feedbackReceived) {
                    server.close();
                    reject(new Error(`Browser feedback timeout after ${timeout} seconds`));
                }
            }, timeout * 1000);

            server.on('close', () => {
                clearTimeout(timeoutHandle);
            });
        });

        server.on('error', (err) => {
            reject(new Error(`Failed to start browser feedback server: ${err.message}`));
        });
    });
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new McpServer({
    name: 'mcp-feedback-enhanced',
    version: VERSION
});

// Register the interactive_feedback tool
server.tool(
    'interactive_feedback',
    'Collect feedback from user through VSCode extension panel. The feedback panel will display the AI summary and wait for user input.',
    {
        project_directory: z.string().describe('The project directory path for context'),
        summary: z.string().describe('Summary of AI work completed for user review'),
        timeout: z.number().optional().default(86400).describe('Timeout in seconds (default: 86400 = 24 hours)'),
        agent_name: z.string().optional().describe('Unique identifier for this agent/chat session. You MUST provide this parameter with your current conversation/chat title or a short descriptive name of the task (e.g. "Chat 1", "Pre-credit Implementation", "Bug Fix #123"). If not provided, defaults to "Agent" and all messages will appear in the same tab. Providing a unique name allows multiple agents to have separate conversation tabs.')
    },
    async ({ project_directory, summary, timeout, agent_name }) => {
        debug(`interactive_feedback called: project=${project_directory}, agent=${agent_name || 'default'}`);

        const effectiveTimeout = timeout || 86400;
        let result: { feedback: string; images: Array<{ name?: string; data: string }> };

        try {
            result = await requestFeedback(project_directory, summary, effectiveTimeout, agent_name);
        } catch (error: any) {
            // Panel feedback failed (connection lost, timeout, etc.)
            // Always fall back to browser to avoid wasting the session
            debug(`Panel feedback failed: ${error.message}, falling back to browser`);
            try {
                result = await requestFeedbackViaBrowser(project_directory, summary, effectiveTimeout);
            } catch (browserError: any) {
                // Both panel and browser failed - only then return error
                debug(`Browser fallback also failed: ${browserError.message}`);
                return {
                    content: [{ type: 'text', text: `Error: Both panel and browser feedback failed. Panel: ${error.message}. Browser: ${browserError.message}` }],
                    isError: true
                };
            }
        }

        // Build content array with text and images
        const content: any[] = [{ type: 'text', text: `User Feedback:\n${result.feedback}` }];

        // Add images as MCP image content items
        if (result.images && result.images.length > 0) {
            debug(`Processing ${result.images.length} image(s)`);
            for (const img of result.images) {
                if (img && img.data) {
                    content.push({
                        type: 'image',
                        data: img.data,
                        mimeType: 'image/png'
                    });
                    debug(`Added image: ${img.name || 'unnamed'}`);
                }
            }
        }

        return { content };
    }
);

// Register get_system_info tool
server.tool(
    'get_system_info',
    'Get system environment information',
    {},
    async () => {
        const info = {
            platform: os.platform(),
            hostname: os.hostname(),
            user: os.userInfo().username,
            homeDir: os.homedir(),
            nodeVersion: process.version,
            pid: process.pid,
            parentPid: process.ppid,
            extensionConnected: isConnected
        };

        return {
            content: [{ type: 'text', text: JSON.stringify(info, null, 2) }]
        };
    }
);

// Register pending comment resource
server.resource(
    'pending',
    'feedback://pending',
    async (uri) => {
        // Determine project directory (use CWD as approximation)
        const projectDir = process.cwd();
        debug(`Reading resource feedback://pending for project: ${projectDir}`);

        try {
            const comment = await getPendingComment(projectDir);
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/plain',
                    text: comment || 'No pending comment.'
                }]
            };
        } catch (e) {
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/plain',
                    text: `Error fetching pending comment: ${(e as Error).message}`
                }],
                isError: true // isError might not be in ReadResourceResult type definition for some SDKs, but often supported
            };
        }
    }
);

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    debug('MCP Feedback Server starting...');
    debug(`PID: ${process.pid}, Parent PID: ${process.ppid}`);
    debug(`Version: ${VERSION}`);

    // Log environment for debugging
    if (DEBUG) {
        console.error('[MCP Feedback] Environment:');
        Object.keys(process.env).filter(k =>
            k.includes('CURSOR') || k.includes('VSCODE') || k.includes('MCP')
        ).forEach(k => console.error(`  ${k}=${process.env[k]}`));

        // Show available servers
        const servers = getLiveServers();
        console.error(`[MCP Feedback] Available servers: ${servers.length}`);
        servers.forEach(s => {
            console.error(`  - port=${s.port}, workspaces=${s.workspaces?.join(', ')}`);
        });
    }

    // Don't connect at startup - we'll connect on demand when interactive_feedback is called
    // This allows us to use project_directory for server matching

    // Start MCP server on stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);

    debug('MCP Server running on stdio, will connect to Extension on first feedback request');

    // Heartbeat to keep connection alive
    setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, HEARTBEAT_INTERVAL_MS);
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
