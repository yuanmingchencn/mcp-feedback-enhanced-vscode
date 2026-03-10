#!/usr/bin/env node
/**
 * MCP Feedback Enhanced Server.
 *
 * Tools:
 * - interactive_feedback: Request feedback from user, routed by conversation_id
 * - get_system_info: Return system information
 *
 * Routing: CURSOR_TRACE_ID → server file → port → WebSocket
 * Fallback: conversation_id → session file → server file → port
 * Last resort: browser fallback
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const SERVERS_DIR = path.join(CONFIG_DIR, 'servers');

// ─── File Helpers ─────────────────────────────────────────

interface SessionData {
    conversation_id: string;
    workspace_roots: string[];
    model: string;
    server_pid: number;
    started_at: number;
}

interface ServerData {
    port: number;
    pid: number;
    workspaces: string[];
    cursorTraceId: string;
    version: string;
}

function readJSON<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch { return null; }
}

function listJSONFiles(dir: string): string[] {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch { return []; }
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => { sock.destroy(); resolve(false); });
        sock.once('timeout', () => { sock.destroy(); resolve(false); });
        sock.connect(port, host);
    });
}

// ─── Extension Discovery ─────────────────────────────────

async function findExtensionServer(conversationId?: string): Promise<ServerData | null> {
    // Strategy 1: CURSOR_TRACE_ID → server (most reliable for multi-window)
    const traceId = process.env.CURSOR_TRACE_ID || '';
    if (traceId) {
        for (const f of listJSONFiles(SERVERS_DIR)) {
            const server = readJSON<ServerData>(path.join(SERVERS_DIR, f));
            if (server?.cursorTraceId === traceId && await isPortOpen(server.port)) {
                return server;
            }
        }
    }

    // Strategy 2: conversation_id → session → server
    if (conversationId) {
        const session = readJSON<SessionData>(path.join(SESSIONS_DIR, `${conversationId}.json`));
        if (session?.server_pid) {
            const server = readJSON<ServerData>(path.join(SERVERS_DIR, `${session.server_pid}.json`));
            if (server && await isPortOpen(server.port)) {
                return server;
            }
        }
    }

    // Strategy 3: single server fallback
    const allServers: ServerData[] = [];
    for (const f of listJSONFiles(SERVERS_DIR)) {
        const server = readJSON<ServerData>(path.join(SERVERS_DIR, f));
        if (server && await isPortOpen(server.port)) {
            allServers.push(server);
        }
    }
    if (allServers.length === 1) return allServers[0];

    return null;
}

// ─── WebSocket Communication ──────────────────────────────

function connectToExtension(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Connection timeout'));
        }, 5000);

        ws.once('open', () => {
            clearTimeout(timeout);
            ws.send(JSON.stringify({
                type: 'register',
                clientType: 'mcp-server',
            }));
            resolve(ws);
        });

        ws.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

function requestFeedback(
    ws: WebSocket,
    sessionId: string,
    conversationId: string,
    summary: string,
    projectDirectory?: string,
): Promise<{ feedback: string; images?: string[] }> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Feedback timeout (10 min)'));
        }, 600_000);

        const handler = (raw: Buffer | string) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'feedback_result' && msg.session_id === sessionId) {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    resolve({
                        feedback: msg.feedback || '',
                        images: msg.images,
                    });
                } else if (msg.type === 'feedback_error' && msg.session_id === sessionId) {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    reject(new Error(msg.error || 'Feedback error'));
                }
            } catch { /* ignore parse errors */ }
        };

        ws.on('message', handler);
        ws.once('close', () => {
            clearTimeout(timeout);
            reject(new Error('Connection closed'));
        });

        ws.send(JSON.stringify({
            type: 'feedback_request',
            session_id: sessionId,
            conversation_id: conversationId,
            project_directory: projectDirectory,
            summary,
        }));
    });
}

// ─── Browser Fallback ─────────────────────────────────────

async function browserFallback(summary: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(getBrowserHTML(summary));
            } else if (req.method === 'POST' && req.url === '/feedback') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk; });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                        server.close();
                        resolve(data.feedback || '');
                    } catch {
                        res.writeHead(400);
                        res.end();
                    }
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as net.AddressInfo;
            const url = `http://127.0.0.1:${addr.port}`;
            console.error(`[MCP Feedback] Browser fallback: ${url}`);

            // Open browser
            const { exec } = require('child_process');
            const cmd = process.platform === 'darwin' ? 'open' :
                        process.platform === 'win32' ? 'start' : 'xdg-open';
            exec(`${cmd} "${url}"`);
        });

        setTimeout(() => {
            server.close();
            reject(new Error('Browser fallback timeout (10 min)'));
        }, 600_000);
    });
}

function getBrowserHTML(summary: string): string {
    const escaped = summary.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MCP Feedback</title>
<style>
body{font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;background:#1e1e1e;color:#e0e0e0}
.summary{background:#2d2d2d;padding:16px;border-radius:8px;margin-bottom:20px;white-space:pre-wrap}
textarea{width:100%;height:120px;background:#2d2d2d;color:#e0e0e0;border:1px solid #555;border-radius:6px;padding:10px;font-size:14px;resize:vertical}
button{background:#0078d4;color:white;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;margin-top:10px}
button:hover{background:#106ebe}
</style></head><body>
<h2>MCP Feedback Enhanced</h2>
<div class="summary">${escaped}</div>
<textarea id="fb" placeholder="Your feedback..."></textarea>
<button onclick="send()">Send Feedback</button>
<script>
async function send(){
  const fb=document.getElementById('fb').value;
  if(!fb.trim())return;
  await fetch('/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({feedback:fb})});
  document.body.innerHTML='<h2>Feedback sent! You can close this tab.</h2>';
}
</script></body></html>`;
}

// ─── MCP Server Setup ─────────────────────────────────────

const server = new Server(
    { name: 'mcp-feedback-enhanced', version: '2.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'interactive_feedback',
            description: 'Request interactive feedback from the user. Call this tool to check in with the user, present your progress, and get their input before continuing.',
            inputSchema: {
                type: 'object' as const,
                required: ['summary', 'conversation_id'],
                properties: {
                    summary: {
                        type: 'string',
                        description: 'Summary of what you have done so far.',
                    },
                    conversation_id: {
                        type: 'string',
                        description: 'Your conversation ID, provided at session start. Use the EXACT value given to you. Do NOT fabricate or modify this value.',
                    },
                    project_directory: {
                        type: 'string',
                        description: 'Optional. The project directory path.',
                    },
                },
            },
        },
        {
            name: 'get_system_info',
            description: 'Get system information including OS, architecture, and Node.js version.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'get_system_info') {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    platform: process.platform,
                    arch: process.arch,
                    nodeVersion: process.version,
                    homeDir: os.homedir(),
                    cursorTraceId: process.env.CURSOR_TRACE_ID || '',
                }, null, 2),
            }],
        };
    }

    if (name === 'interactive_feedback') {
        const parsed = z.object({
            summary: z.string(),
            conversation_id: z.string(),
            project_directory: z.string().optional(),
        }).parse(args);

        const { summary, conversation_id, project_directory } = parsed;
        const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        try {
            // Find extension and connect
            const extensionServer = await findExtensionServer(conversation_id);

            if (extensionServer) {
                const ws = await connectToExtension(extensionServer.port);
                try {
                    const result = await requestFeedback(
                        ws, sessionId, conversation_id || '', summary, project_directory
                    );
                    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
                        { type: 'text', text: result.feedback },
                    ];
                    if (result.images) {
                        for (const img of result.images) {
                            content.push({
                                type: 'image',
                                data: img,
                                mimeType: 'image/png',
                            });
                        }
                    }
                    return { content };
                } finally {
                    ws.close();
                }
            }

            // Browser fallback
            console.error('[MCP Feedback] No extension found, using browser fallback');
            const feedback = await browserFallback(summary);
            return {
                content: [{ type: 'text', text: feedback }],
            };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[MCP Feedback] Error:', errMsg);

            // Try browser fallback on error
            try {
                const feedback = await browserFallback(summary);
                return {
                    content: [{ type: 'text', text: feedback }],
                };
            } catch {
                return {
                    content: [{ type: 'text', text: `Error: ${errMsg}. Please try again.` }],
                    isError: true,
                };
            }
        }
    }

    return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
    };
});

// ─── Start ────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP Feedback] Server started');
}

main().catch((err) => {
    console.error('[MCP Feedback] Fatal error:', err);
    process.exit(1);
});
