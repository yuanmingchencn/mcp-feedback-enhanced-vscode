/**
 * MCP Feedback Enhanced - VSCode Extension
 * 
 * Extension acts as WebSocket Server, both Webview and MCP Server connect to it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeedbackViewProvider } from './feedbackViewProvider';
import { FeedbackWebSocketServer } from './wsServer';

/**
 * Load webview HTML from file (same logic as feedbackViewProvider)
 */
function loadWebviewHtml(extensionPath: string, serverUrl: string, workspacePath: string, sessionId: string): string {
    const htmlPath = path.join(extensionPath, 'out', 'webview', 'panel.html');

    try {
        let html = fs.readFileSync(htmlPath, 'utf-8');
        html = html.replace(/\{\{SERVER_URL\}\}/g, serverUrl);
        html = html.replace(/\{\{PROJECT_PATH\}\}/g, workspacePath);
        html = html.replace(/\{\{SESSION_ID\}\}/g, sessionId);
        return html;
    } catch (e) {
        console.error('[MCP Feedback] Failed to load HTML:', e);
        return `<!DOCTYPE html><html><body><h1>Error loading webview</h1><p>${e}</p><p>Run: npm run compile</p></body></html>`;
    }
}

let feedbackViewProvider: FeedbackViewProvider | undefined;
let feedbackBottomProvider: FeedbackViewProvider | undefined;
let editorPanel: vscode.WebviewPanel | undefined;
let wsServer: FeedbackWebSocketServer | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('MCP Feedback Enhanced extension activating...');

    // Start WebSocket Server first
    wsServer = new FeedbackWebSocketServer((status) => {
        console.log(`[MCP Feedback] WS Server status: ${status}`);
    });

    // Listen for feedback requests from WebSocket server to auto-focus panel
    // Register this BEFORE starting the server to ensure we don't miss any startup requests
    wsServer.onFeedbackRequest(() => {
        vscode.commands.executeCommand('workbench.view.extension.mcp-feedback');
        feedbackViewProvider?.focusInput();
    });

    let serverPort: number;
    try {
        serverPort = await wsServer.start();
        console.log(`[MCP Feedback] WebSocket Server started on port ${serverPort}`);

        // Set workspace paths for MCP Server matching
        const workspaces = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
        wsServer.setWorkspaces(workspaces);

        // Update workspaces when folders change
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                const newWorkspaces = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
                wsServer?.setWorkspaces(newWorkspaces);
            })
        );
    } catch (e) {
        console.error(`[MCP Feedback] Failed to start WebSocket Server: ${e}`);
        vscode.window.showErrorMessage(`MCP Feedback: Failed to start server - ${e}`);
        return; // Cannot continue without server
    }

    // Create and register the feedback view provider (sidebar)
    // Pass the server port so webview knows where to connect
    feedbackViewProvider = new FeedbackViewProvider(context.extensionUri, context, undefined, serverPort);

    // Set up force reset callback
    feedbackViewProvider.onForceReset(async () => {
        if (wsServer) {
            const newPort = await wsServer.restart();
            // Update all providers with new port
            feedbackViewProvider?.updateServerPort(newPort);
            feedbackBottomProvider?.updateServerPort(newPort);
            return newPort;
        }
    });

    // Wire up pending updates to WebSocket server
    feedbackViewProvider.onPendingUpdate((value) => {
        if (wsServer) {
            // Use current workspace as key
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspacePath) {
                wsServer.updatePendingComment(workspacePath, value);
            }
        }
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            FeedbackViewProvider.viewType,
            feedbackViewProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: false  // Force reload to get fresh HTML with replaced placeholders
                }
            }
        )
    );

    // Register bottom panel provider
    feedbackBottomProvider = new FeedbackViewProvider(context.extensionUri, context, 'mcp-feedback.feedbackPanelBottom', serverPort);

    // Set up force reset callback for bottom panel too
    feedbackBottomProvider.onForceReset(async () => {
        if (wsServer) {
            const newPort = await wsServer.restart();
            feedbackViewProvider?.updateServerPort(newPort);
            feedbackBottomProvider?.updateServerPort(newPort);
            return newPort;
        }
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'mcp-feedback.feedbackPanelBottom',
            feedbackBottomProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: false  // Force reload
                }
            }
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('mcp-feedback.openPanel', () => {
            vscode.commands.executeCommand('workbench.view.extension.mcp-feedback');
        }),
        vscode.commands.registerCommand('mcp-feedback.focusInput', () => {
            // Open the panel and focus the input
            vscode.commands.executeCommand('workbench.view.extension.mcp-feedback');
            // Send message to webview to focus input
            feedbackViewProvider?.focusInput();
        })
    );

    // Open in Editor (draggable tab)
    context.subscriptions.push(
        vscode.commands.registerCommand('mcp-feedback.openInEditor', () => {
            openFeedbackInEditor(context);
        })
    );

    // Open in Bottom Panel
    context.subscriptions.push(
        vscode.commands.registerCommand('mcp-feedback.openInBottom', () => {
            // Focus the bottom panel container (panel uses workbench.panel.*)
            vscode.commands.executeCommand('workbench.panel.mcp-feedback-bottom');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mcp-feedback.reconnect', () => {
            if (feedbackViewProvider) {
                feedbackViewProvider.reconnect();
            }
            if (editorPanel) {
                editorPanel.webview.postMessage({ type: 'reconnect' });
            }
            vscode.window.showInformationMessage('MCP Feedback: Reconnecting to server...');
        })
    );

    // Force reset command - completely restarts the WebSocket server
    context.subscriptions.push(
        vscode.commands.registerCommand('mcp-feedback.forceReset', async () => {
            vscode.window.showInformationMessage('MCP Feedback: Force resetting...');

            try {
                if (wsServer) {
                    const newPort = await wsServer.restart();
                    console.log(`[MCP Feedback] Server restarted on port ${newPort}`);

                    // Notify all webviews to reconnect
                    if (feedbackViewProvider) {
                        feedbackViewProvider.reconnect();
                    }
                    if (feedbackBottomProvider) {
                        feedbackBottomProvider.reconnect();
                    }
                    if (editorPanel) {
                        editorPanel.webview.postMessage({ type: 'reconnect' });
                    }

                    vscode.window.showInformationMessage(`MCP Feedback: Reset complete! Server on port ${newPort}`);
                }
            } catch (e) {
                console.error('[MCP Feedback] Force reset failed:', e);
                vscode.window.showErrorMessage(`MCP Feedback: Reset failed - ${e}`);
            }
        })
    );

    // Show status command - for diagnostics
    context.subscriptions.push(
        vscode.commands.registerCommand('mcp-feedback.showStatus', () => {
            if (wsServer) {
                const status = wsServer.getStatus();
                const msg = `MCP Feedback Status:
- Server: ${status.running ? 'Running' : 'Stopped'}
- Port: ${status.port}
- Connected clients: ${status.clients.length}
  ${status.clients.map(c => `  - ${c.type}: ${c.projectPath || 'no project'}`).join('\n')}
- Pending feedback: ${status.pendingFeedback}`;

                vscode.window.showInformationMessage(msg, { modal: true });
            } else {
                vscode.window.showWarningMessage('MCP Feedback: Server not initialized');
            }
        })
    );

    // Auto-open sidebar panel on startup to ensure webview is ready
    // This ensures the panel is initialized before any MCP feedback requests come in
    setTimeout(() => {
        vscode.commands.executeCommand('workbench.view.extension.mcp-feedback');
        console.log('[MCP Feedback] Auto-opened sidebar panel');
    }, 1000);

    console.log('[MCP Feedback] Extension activation complete');

    // Auto-configure MCP server
    ensureMcpConfig();
}

/**
 * Ensure MCP server is configured in ~/.cursor/mcp.json
 * Uses npx to always resolve the latest version from npm - no path issues on upgrades.
 */
async function ensureMcpConfig(): Promise<void> {
    try {
        const mcpConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');

        let config: any = { mcpServers: {} };

        // Read existing config
        if (fs.existsSync(mcpConfigPath)) {
            try {
                const content = fs.readFileSync(mcpConfigPath, 'utf-8');
                config = JSON.parse(content);
                if (!config.mcpServers) {
                    config.mcpServers = {};
                }
            } catch (e) {
                console.error('[MCP Feedback] Failed to parse mcp.json:', e);
                return;
            }
        }

        // Check if already configured with npx approach
        if (config.mcpServers['mcp-feedback-enhanced']) {
            const current = config.mcpServers['mcp-feedback-enhanced'];
            if (current.command === 'npx' && current.args?.[1]?.startsWith('mcp-feedback-enhanced@')) {
                console.log('[MCP Feedback] MCP server already configured (npx)');
                return;
            }
            // Migrate from old local-path approach to npx
            console.log('[MCP Feedback] Migrating MCP config to npx approach');
        }

        // Use npx - always resolves latest version, no path issues
        config.mcpServers['mcp-feedback-enhanced'] = {
            command: 'npx',
            args: ['-y', 'mcp-feedback-enhanced@latest'],
            timeout: 86400,
            autoApprove: ['interactive_feedback']
        };

        // Ensure .cursor directory exists
        const cursorDir = path.join(os.homedir(), '.cursor');
        if (!fs.existsSync(cursorDir)) {
            fs.mkdirSync(cursorDir, { recursive: true });
        }

        fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 4), 'utf-8');

        console.log('[MCP Feedback] Auto-configured MCP server in ~/.cursor/mcp.json (npx)');
        vscode.window.showInformationMessage('MCP Feedback Enhanced: MCP server auto-configured ✓');

    } catch (e) {
        console.error('[MCP Feedback] Failed to auto-configure MCP:', e);
    }
}

/**
 * Open feedback panel in editor area (draggable tab)
 */
function openFeedbackInEditor(context: vscode.ExtensionContext) {
    // If already exists, reveal it
    if (editorPanel) {
        editorPanel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    // Get server URL - use the Extension's WS server port
    if (!wsServer) {
        vscode.window.showErrorMessage('MCP Feedback: Server not started');
        return;
    }
    const serverUrl = `ws://127.0.0.1:${wsServer.port}/ws`;

    // Create webview panel
    editorPanel = vscode.window.createWebviewPanel(
        'mcp-feedback.editorPanel',
        '💬 MCP Feedback',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [context.extensionUri]
        }
    );

    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const sessionId = vscode.env.sessionId;
    editorPanel.webview.html = loadWebviewHtml(context.extensionUri.fsPath, serverUrl, workspaceDir, sessionId);

    // Handle messages
    editorPanel.webview.onDidReceiveMessage((message) => {
        switch (message.type) {
            case 'feedback-submitted':
                vscode.window.setStatusBarMessage('✅ Feedback submitted!', 1500);
                break;
            case 'error':
                vscode.window.showErrorMessage(`MCP Feedback: ${message.message}`);
                break;
            case 'new-session':
                editorPanel?.reveal(vscode.ViewColumn.Beside);
                break;
        }
    }, undefined, context.subscriptions);

    // Clean up on close
    editorPanel.onDidDispose(() => {
        editorPanel = undefined;
    }, undefined, context.subscriptions);
}



export function deactivate() {
    console.log('MCP Feedback Enhanced extension deactivating...');

    // Dispose providers
    feedbackViewProvider?.dispose();
    feedbackBottomProvider?.dispose();
    feedbackViewProvider = undefined;
    feedbackBottomProvider = undefined;

    // Stop WebSocket Server
    if (wsServer) {
        wsServer.stop();
        wsServer = undefined;
    }

    // Clean up editor panel
    editorPanel?.dispose();
    editorPanel = undefined;

    console.log('MCP Feedback Enhanced extension deactivated');
}

