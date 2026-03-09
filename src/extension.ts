/**
 * Extension entry point.
 *
 * Responsibilities:
 * - Start WebSocket server
 * - Register sidebar, bottom, and editor webview providers
 * - Deploy Cursor hooks
 * - Auto-configure MCP server in Cursor's mcp.json
 * - Register commands
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeedbackWSServer } from './wsServer';
import { FeedbackViewProvider } from './feedbackViewProvider';

let wsServer: FeedbackWSServer;
let sidebarProvider: FeedbackViewProvider;
let bottomProvider: FeedbackViewProvider;
const disposables: vscode.Disposable[] = [];

function getWorkspaces(): string[] {
    return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
}

function getCursorTraceId(): string {
    return process.env.CURSOR_TRACE_ID || '';
}

function _loadWebviewHtml(extensionPath: string, serverPort: number): string {
    // Try static/panel.html first (source), then out/webview/panel.html (build artifact)
    const candidates = [
        path.join(extensionPath, 'static', 'panel.html'),
        path.join(extensionPath, 'out', 'webview', 'panel.html'),
    ];
    let html = '';
    for (const p of candidates) {
        if (fs.existsSync(p)) { html = fs.readFileSync(p, 'utf-8'); break; }
    }
    if (!html) {
        return '<html><body><h3>Webview not found. Check static/panel.html.</h3></body></html>';
    }
    html = html.replace(/\{\{SERVER_URL\}\}/g, `ws://127.0.0.1:${serverPort}`);
    html = html.replace(/\{\{PROJECT_PATH\}\}/g, getWorkspaces()[0] || '');
    html = html.replace(/\{\{SESSION_ID\}\}/g, `ext_${Date.now()}`);
    return html;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('[MCP Feedback] Activating extension...');

    // Start WebSocket server
    wsServer = new FeedbackWSServer();
    wsServer.setWorkspaces(getWorkspaces());
    wsServer.setCursorTraceId(getCursorTraceId());

    let port: number;
    try {
        port = await wsServer.start();
    } catch (e) {
        vscode.window.showErrorMessage(`MCP Feedback: Failed to start server - ${e}`);
        return;
    }

    // Focus panel when agent requests feedback
    wsServer.onFeedbackRequest(() => {
        vscode.commands.executeCommand('mcp-feedback-v2.feedbackPanel.focus');
    });

    // Create providers
    const getHtml = () => _loadWebviewHtml(context.extensionPath, port);

    sidebarProvider = new FeedbackViewProvider(getHtml, 'sidebar');
    bottomProvider = new FeedbackViewProvider(getHtml, 'bottom');

    // Register force reset callback
    const forceResetCallback = async (): Promise<number> => {
        await wsServer.stop();
        wsServer.setWorkspaces(getWorkspaces());
        wsServer.setCursorTraceId(getCursorTraceId());
        const newPort = await wsServer.start();
        port = newPort;
        sidebarProvider.updateHtmlGetter(() => _loadWebviewHtml(context.extensionPath, newPort));
        bottomProvider.updateHtmlGetter(() => _loadWebviewHtml(context.extensionPath, newPort));
        sidebarProvider.recreate();
        bottomProvider.recreate();
        return newPort;
    };
    sidebarProvider.onForceReset(forceResetCallback);
    bottomProvider.onForceReset(forceResetCallback);

    // Register view providers
    disposables.push(
        vscode.window.registerWebviewViewProvider(
            'mcp-feedback-v2.feedbackPanel',
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: false } }
        ),
        vscode.window.registerWebviewViewProvider(
            'mcp-feedback-v2.feedbackPanelBottom',
            bottomProvider,
            { webviewOptions: { retainContextWhenHidden: false } }
        ),
    );

    // Register commands
    disposables.push(
        vscode.commands.registerCommand('mcp-feedback-v2.openPanel', () => {
            vscode.commands.executeCommand('mcp-feedback-v2.feedbackPanel.focus');
        }),
        vscode.commands.registerCommand('mcp-feedback-v2.focusInput', () => {
            vscode.commands.executeCommand('mcp-feedback-v2.feedbackPanel.focus');
            sidebarProvider.focusInput();
        }),
        vscode.commands.registerCommand('mcp-feedback-v2.openInEditor', () => {
            _openEditorPanel(context, port);
        }),
        vscode.commands.registerCommand('mcp-feedback-v2.openInBottom', () => {
            vscode.commands.executeCommand('mcp-feedback-v2.feedbackPanelBottom.focus');
        }),
        vscode.commands.registerCommand('mcp-feedback-v2.reconnect', () => {
            sidebarProvider.reconnect();
            bottomProvider.reconnect();
        }),
        vscode.commands.registerCommand('mcp-feedback-v2.forceReset', async () => {
            try {
                const newPort = await forceResetCallback();
                vscode.window.showInformationMessage(`MCP Feedback: Reset! Server on port ${newPort}`);
            } catch (e) {
                vscode.window.showErrorMessage(`MCP Feedback: Reset failed - ${e}`);
            }
        }),
        vscode.commands.registerCommand('mcp-feedback-v2.showStatus', () => {
            const clients = wsServer.getConnectedClients();
            vscode.window.showInformationMessage(
                `MCP Feedback Status:\nPort: ${port}\nWebviews: ${clients.webviews}\nMCP Servers: ${clients.mcpServers}\nPending requests: ${wsServer.hasPendingRequests() ? 'Yes' : 'No'}`
            );
        }),
    );

    // Watch workspace changes
    disposables.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            wsServer.setWorkspaces(getWorkspaces());
            wsServer.refreshServerRegistration();
        }),
    );

    // Auto-configure MCP and deploy hooks
    ensureMcpConfig(context.extensionPath);
    deployCursorHooks(context.extensionPath);

    // Auto-open sidebar after short delay
    setTimeout(() => {
        vscode.commands.executeCommand('mcp-feedback-v2.feedbackPanel.focus');
    }, 1000);

    context.subscriptions.push(...disposables);
    console.log(`[MCP Feedback] Activated on port ${port}`);
}

export function deactivate(): void {
    console.log('[MCP Feedback] Deactivating...');
    for (const d of disposables) { d.dispose(); }
    disposables.length = 0;
    wsServer?.stop();
}

// ─── Editor Panel ─────────────────────────────────────────

function _openEditorPanel(context: vscode.ExtensionContext, port: number): void {
    const panel = vscode.window.createWebviewPanel(
        'mcp-feedback-editor',
        'MCP Feedback',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'out'))],
        }
    );
    panel.webview.html = _loadWebviewHtml(context.extensionPath, port);
}

// ─── MCP Auto-Config ──────────────────────────────────────

function ensureMcpConfig(extensionPath: string): void {
    try {
        const mcpConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');
        let config: Record<string, unknown> = {};

        if (fs.existsSync(mcpConfigPath)) {
            config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
        }

        const mcpServers = (config.mcpServers || {}) as Record<string, unknown>;

        // Point to the local build of the v2 MCP server
        const localServerPath = path.join(extensionPath, 'mcp-server', 'dist', 'index.js');
        const expectedCommand = 'node';
        const expectedArgs = [localServerPath];

        const existing = mcpServers['mcp-feedback-v2'] as Record<string, unknown> | undefined;
        if (existing?.command === expectedCommand &&
            JSON.stringify(existing?.args) === JSON.stringify(expectedArgs)) {
            return;
        }

        mcpServers['mcp-feedback-v2'] = {
            command: expectedCommand,
            args: expectedArgs,
        };
        config.mcpServers = mcpServers;

        fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
        fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
        console.log('[MCP Feedback] MCP config updated');
    } catch (e) {
        console.error('[MCP Feedback] Failed to update MCP config:', e);
    }
}

// ─── Cursor Hooks Deployment ──────────────────────────────

function deployCursorHooks(extensionPath: string): void {
    try {
        const sourceHook = path.join(extensionPath, 'scripts', 'hooks', 'check-pending.js');
        if (!fs.existsSync(sourceHook)) {
            console.warn('[MCP Feedback] Hook script not found:', sourceHook);
            return;
        }

        // Copy hook script to config dir
        const targetDir = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced', 'hooks');
        const targetHook = path.join(targetDir, 'check-pending.js');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(sourceHook, targetHook);

        // Update ~/.cursor/hooks.json
        // Cursor format: { version: 1, hooks: { "eventType": [{ command, _source }] } }
        const hooksConfigPath = path.join(os.homedir(), '.cursor', 'hooks.json');
        let hooksConfig: Record<string, unknown> = {};

        if (fs.existsSync(hooksConfigPath)) {
            hooksConfig = JSON.parse(fs.readFileSync(hooksConfigPath, 'utf-8'));
        }

        if (!hooksConfig.version) { hooksConfig.version = 1; }

        const hooks = (hooksConfig.hooks || {}) as Record<string, Array<Record<string, unknown>>>;
        const hookPoints = ['sessionStart', 'stop', 'preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'subagentStart'];
        const hookCommand = `node ${targetHook}`;
        const SOURCE_TAG = 'mcp-feedback-enhanced';

        for (const event of hookPoints) {
            if (!hooks[event]) { hooks[event] = []; }
            // Remove existing entries from us
            hooks[event] = hooks[event].filter(h => h._source !== SOURCE_TAG);
            // Add our entry
            hooks[event].push({
                command: hookCommand,
                _source: SOURCE_TAG,
            });
        }

        hooksConfig.hooks = hooks;
        fs.mkdirSync(path.dirname(hooksConfigPath), { recursive: true });
        fs.writeFileSync(hooksConfigPath, JSON.stringify(hooksConfig, null, 2));
        console.log('[MCP Feedback] Cursor hooks deployed');
    } catch (e) {
        console.error('[MCP Feedback] Failed to deploy hooks:', e);
    }
}
