/**
 * Webview view provider for sidebar, bottom panel, and editor tabs.
 *
 * Responsibilities:
 * - Resolve webview with generated HTML
 * - Handle messages from webview (feedback, pending, navigation)
 * - Hot-reload in dev mode
 * - Panel focus and input focus
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type HtmlGetter = () => string;

export class FeedbackViewProvider implements vscode.WebviewViewProvider {
    private _view: vscode.WebviewView | null = null;
    private _getHtml: HtmlGetter;
    private _location: 'sidebar' | 'bottom';
    private _forceResetCallback?: () => Promise<number>;
    private _fileWatcher?: fs.FSWatcher;

    constructor(getHtml: HtmlGetter, location: 'sidebar' | 'bottom') {
        this._getHtml = getHtml;
        this._location = location;
    }

    updateHtmlGetter(getHtml: HtmlGetter): void {
        this._getHtml = getHtml;
    }

    onForceReset(callback: () => Promise<number>): void {
        this._forceResetCallback = callback;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
        };

        webviewView.webview.html = this._getHtml();
        this._setupMessageHandler(webviewView);
        this._setupHotReload(webviewView);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                webviewView.webview.html = this._getHtml();
            }
        });

        webviewView.onDidDispose(() => {
            this._view = null;
            this._stopHotReload();
        });
    }

    recreate(): void {
        if (this._view) {
            this._view.webview.html = this._getHtml();
        }
    }

    focusInput(): void {
        if (this._view) {
            this._view.webview.postMessage({ type: 'focus-input' });
        }
    }

    reconnect(): void {
        if (this._view) {
            this._view.webview.postMessage({ type: 'reconnect' });
        }
    }

    private _setupMessageHandler(view: vscode.WebviewView): void {
        view.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
            switch (message.type) {
                case 'feedback-submitted':
                    vscode.window.setStatusBarMessage('Feedback submitted!', 1500);
                    break;

                case 'error':
                    vscode.window.showErrorMessage(`MCP Feedback: ${message.message}`);
                    break;

                case 'info':
                    vscode.window.showInformationMessage(`MCP Feedback: ${message.message}`);
                    break;

                case 'new-session':
                    this._focusPanel();
                    break;

                case 'force-reset':
                    if (this._forceResetCallback) {
                        this._forceResetCallback().then((newPort) => {
                            vscode.window.showInformationMessage(`MCP Feedback: Reset! Port ${newPort}`);
                        }).catch((e) => {
                            vscode.window.showErrorMessage(`MCP Feedback: Reset failed - ${e}`);
                        });
                    }
                    break;

                case 'open-in-editor':
                    vscode.commands.executeCommand('mcp-feedback-v2.openInEditor');
                    break;

                case 'reload-webview':
                    this.recreate();
                    break;

                case 'log':
                    console.log(`[MCP Feedback Webview] ${message.message}`);
                    break;
            }
        });
    }

    private _focusPanel(): void {
        if (this._location === 'sidebar') {
            vscode.commands.executeCommand('mcp-feedback-v2.feedbackPanel.focus');
        } else {
            vscode.commands.executeCommand('mcp-feedback-v2.feedbackPanelBottom.focus');
        }
    }

    // Hot-reload: watch panel.html for changes in dev mode
    private _setupHotReload(view: vscode.WebviewView): void {
        if (process.env.NODE_ENV === 'production') { return; }

        try {
            const htmlDir = path.join(__dirname, 'webview');
            if (!fs.existsSync(htmlDir)) { return; }

            this._fileWatcher = fs.watch(htmlDir, () => {
                if (view.visible) {
                    view.webview.html = this._getHtml();
                }
            });
        } catch { /* dev-only, ignore errors */ }
    }

    private _stopHotReload(): void {
        if (this._fileWatcher) {
            this._fileWatcher.close();
            this._fileWatcher = undefined;
        }
    }
}
