/**
 * Feedback View Provider
 * 
 * Manages the Webview sidebar panel for collecting user feedback.
 * Now with hot-reload: reads HTML from disk and watches for changes.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class FeedbackViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mcp-feedback.feedbackPanel';

    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    private _viewType: string;
    private _serverPort: number;
    private _disposables: vscode.Disposable[] = [];
    private _onForceReset: (() => Promise<number | void>) | null = null;
    private _onPendingUpdate: ((value: string) => void) | null = null;
    private _onRulesUpdate: ((rules: string[]) => void) | null = null;

    private _fileWatcher: fs.FSWatcher | null = null;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext, viewType: string | undefined, serverPort: number) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._viewType = viewType || FeedbackViewProvider.viewType;
        this._serverPort = serverPort;

        this._watchWorkspaceChanges();
        this._watchWebviewFile();
    }

    /**
     * Set callback for pending comment updates
     */
    onPendingUpdate(callback: (value: string) => void): void {
        this._onPendingUpdate = callback;
    }

    /**
     * Set callback for active rules updates
     */
    onRulesUpdate(callback: (rules: string[]) => void): void {
        this._onRulesUpdate = callback;
    }

    /**
     * Watch webview HTML file for hot-reload
     */
    private _watchWebviewFile(): void {
        if (this._fileWatcher) {
            this._fileWatcher.close();
            this._fileWatcher = null;
        }
        const htmlPath = this._getWebviewHtmlPath();
        if (!fs.existsSync(htmlPath)) {
            console.log(`[MCP Feedback] Webview HTML not found: ${htmlPath}`);
            return;
        }

        try {
            this._fileWatcher = fs.watch(htmlPath, (eventType) => {
                if (eventType === 'change') {
                    console.log('[MCP Feedback] Webview HTML changed, reloading...');
                    this._recreateWebview();
                }
            });
            console.log(`[MCP Feedback] Watching: ${htmlPath}`);
        } catch (e) {
            console.error('[MCP Feedback] Failed to watch file:', e);
        }
    }

    /**
     * Get path to webview HTML file
     */
    private _getWebviewHtmlPath(): string {
        return path.join(this._extensionUri.fsPath, 'out', 'webview', 'panel.html');
    }

    /**
     * Load webview HTML from file with placeholder replacement
     */
    private _loadWebviewHtml(serverUrl: string, workspacePath: string, sessionId: string): string {
        const htmlPath = this._getWebviewHtmlPath();

        try {
            let html = fs.readFileSync(htmlPath, 'utf-8');

            // Replace placeholders
            html = html.replace(/\{\{SERVER_URL\}\}/g, serverUrl);
            html = html.replace(/\{\{PROJECT_PATH\}\}/g, workspacePath);
            html = html.replace(/\{\{SESSION_ID\}\}/g, sessionId);

            return html;
        } catch (e) {
            console.error('[MCP Feedback] Failed to load HTML:', e);
            // Fallback to inline error message
            const errorMsg = String(e).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<!DOCTYPE html><html><body><h1>Error loading webview</h1><p>${errorMsg}</p><p>Run: npm run compile</p></body></html>`;
        }
    }

    /**
     * Set callback for force reset
     */
    onForceReset(callback: () => Promise<number | void>): void {
        this._onForceReset = callback;
    }

    /**
     * Update server port (after reset)
     */
    updateServerPort(port: number): void {
        this._serverPort = port;
        this._recreateWebview();
    }

    /**
     * Watch for workspace folder changes and recreate webview
     */
    private _watchWorkspaceChanges(): void {
        const disposable = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
            console.log(`[MCP Feedback] Workspace changed: +${e.added.length} -${e.removed.length}`);
            if (this._view) {
                this._recreateWebview();
            }
        });
        this._disposables.push(disposable);
    }

    /**
     * Recreate webview content with current workspace
     */
    private _recreateWebview(): void {
        if (!this._view) return;

        const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const serverUrl = `ws://127.0.0.1:${this._serverPort}/ws`;
        const sessionId = vscode.env.sessionId;

        console.log(`[MCP Feedback] Recreating webview: workspace=${workspaceDir}, port=${this._serverPort}`);

        this._view.webview.html = this._loadWebviewHtml(serverUrl, workspaceDir, sessionId);
    }

    public dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];

        if (this._fileWatcher) {
            this._fileWatcher.close();
            this._fileWatcher = null;
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void | Thenable<void> {
        console.log(`[MCP Feedback] resolveWebviewView: ${this._viewType}, port=${this._serverPort}`);
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const serverUrl = `ws://127.0.0.1:${this._serverPort}/ws`;
        const sessionId = vscode.env.sessionId;

        console.log(`[MCP Feedback] Webview connecting to ${serverUrl}`);

        webviewView.webview.html = this._loadWebviewHtml(serverUrl, workspaceDir, sessionId);

        // Reload when panel becomes visible (backup hot-reload mechanism)
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                console.log('[MCP Feedback] Panel became visible, reloading...');
                this._recreateWebview();
            }
        });

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(
            this._handleWebviewMessage.bind(this),
            undefined,
            this._context.subscriptions
        );
    }

    private _handleWebviewMessage(message: any): void {
        switch (message.type) {
            case 'feedback-submitted':
                // Use status bar message with 1.5s auto-dismiss
                vscode.window.setStatusBarMessage('✅ Feedback submitted!', 1500);
                break;

            case 'error':
                vscode.window.showErrorMessage(`MCP Feedback Error: ${message.message}`);
                break;

            case 'info':
                vscode.window.showInformationMessage(`MCP Feedback: ${message.message}`);
                break;

            case 'log':
                console.log(`[MCP Feedback Webview] ${message.message}`);
                break;

            case 'connection-status':
                // Update status bar or other UI elements
                console.log(`Connection status: ${message.status}`);
                break;

            case 'reload-webview':
                console.log('[MCP Feedback] Reload webview requested');
                this._recreateWebview();
                break;

            case 'request-config':
                // Refresh the webview with current config
                this._recreateWebview();
                break;

            case 'new-session':
                // Auto-focus the panel when AI requests feedback
                console.log('[MCP Feedback] New session detected, focusing panel...');
                this._focusPanel();
                break;

            case 'force-reset':
                // Handle force reset request from webview
                console.log('[MCP Feedback] Force reset requested from webview');
                if (this._onForceReset) {
                    this._onForceReset().then((newPort) => {
                        if (typeof newPort === 'number') {
                            this._serverPort = newPort;
                            this._recreateWebview();
                            vscode.window.showInformationMessage(`MCP Feedback: Reset complete! Server on port ${newPort}`);
                        }
                    }).catch((e) => {
                        vscode.window.showErrorMessage(`MCP Feedback: Reset failed - ${e}`);
                    });
                } else {
                    // Fallback: just execute the command
                    vscode.commands.executeCommand('mcp-feedback.forceReset');
                }
                break;

            case 'open-in-editor':
                // Open feedback panel in editor for more space
                console.log('[MCP Feedback] Opening in editor panel');
                vscode.commands.executeCommand('mcp-feedback.openInEditor');
                break;

            case 'pending-update':
                // Sync pending comment to extension host
                if (this._onPendingUpdate) {
                    this._onPendingUpdate(message.value);
                }
                break;

            case 'rules-update':
                // Sync active rules to extension host
                if (this._onRulesUpdate) {
                    this._onRulesUpdate(message.rules);
                }
                break;

            case 'suggest-expand':
                // Multiple pending requests - suggest opening in larger panel
                vscode.window.showInformationMessage(
                    'Multiple agents waiting for feedback. Open in larger panel?',
                    'Open in Editor',
                    'Keep in Sidebar'
                ).then(choice => {
                    if (choice === 'Open in Editor') {
                        vscode.commands.executeCommand('mcp-feedback.openInEditor');
                    }
                });
                break;
        }
    }

    /**
     * Focus the input field in the webview
     */
    public focusInput(): void {
        this._focusPanel();
        if (this._view) {
            this._view.webview.postMessage({ type: 'focus-input' });
        }
    }

    /**
     * Focus the feedback panel and bring it to front
     */
    private _focusPanel(): void {
        // Reveal the correct panel based on view type
        if (this._viewType === 'mcp-feedback.feedbackPanelBottom') {
            // Bottom panel uses workbench.panel.*
            vscode.commands.executeCommand('workbench.panel.mcp-feedback-bottom');
        } else {
            // Sidebar uses workbench.view.extension.*
            vscode.commands.executeCommand('workbench.view.extension.mcp-feedback');
        }

        // Show the view
        if (this._view) {
            this._view.show(true); // preserveFocus = true initially
            // Then focus the webview input
            setTimeout(() => {
                if (this._view) {
                    this._view.webview.postMessage({ type: 'focus-input' });
                }
            }, 100);
        }
    }

    /**
     * Reconnect to the MCP server
     */
    public reconnect(): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'reconnect'
            });
        }
    }

}
