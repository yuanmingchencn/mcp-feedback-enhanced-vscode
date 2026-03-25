/**
 * Extension entry point.
 *
 * Responsibilities:
 * - Start WebSocket server
 * - Register bottom panel and editor webview providers
 * - Deploy Cursor hooks
 * - Auto-configure MCP server in Cursor's mcp.json
 * - Register commands
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { FeedbackWSServer } from './wsServer';
import { FeedbackViewProvider } from './feedbackViewProvider';

let wsServer: FeedbackWSServer;
let bottomProvider: FeedbackViewProvider;
const disposables: vscode.Disposable[] = [];

const REMINDER_DELAYS = [0, 60_000, 120_000, 300_000];
let reminderTimers: ReturnType<typeof setTimeout>[] = [];

function playSystemSound(): void {
    if (process.platform === 'darwin') {
        exec('afplay /System/Library/Sounds/Funk.aiff');
    }
}

function startFeedbackReminders(): void {
    cancelFeedbackReminders();
    for (const delay of REMINDER_DELAYS) {
        reminderTimers.push(setTimeout(playSystemSound, delay));
    }
}

function cancelFeedbackReminders(): void {
    for (const t of reminderTimers) clearTimeout(t);
    reminderTimers = [];
}

function getWorkspaces(): string[] {
    return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
}

function _loadWebviewHtml(extensionPath: string, serverPort: number): string {
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
    return html;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Avoid console.log during activation — it opens the Output panel and steals focus

    const pkgVersion = (context.extension.packageJSON as { version?: string })?.version ?? '0.0.0';
    wsServer = new FeedbackWSServer(pkgVersion);
    wsServer.setWorkspaces(getWorkspaces());

    let port: number;
    try {
        port = await wsServer.start();
    } catch (e) {
        vscode.window.showErrorMessage(`MCP Feedback: Failed to start server - ${e}`);
        return;
    }

    wsServer.onFeedbackRequest(async () => {
        startFeedbackReminders();
        try {
            await vscode.commands.executeCommand('workbench.view.extension.mcp-feedback-enhanced-bottom');
            await vscode.commands.executeCommand('mcp-feedback-enhanced.feedbackPanelBottom.focus');
        } catch { /* ignore */ }
    });

    wsServer.onFeedbackResolved(() => {
        cancelFeedbackReminders();
    });

    const getHtml = () => _loadWebviewHtml(context.extensionPath, port);
    bottomProvider = new FeedbackViewProvider(getHtml);

    const forceResetCallback = async (): Promise<number> => {
        await wsServer.stop();
        wsServer.setWorkspaces(getWorkspaces());
        const newPort = await wsServer.start();
        port = newPort;
        bottomProvider.updateHtmlGetter(() => _loadWebviewHtml(context.extensionPath, newPort));
        bottomProvider.recreate();
        return newPort;
    };
    bottomProvider.onForceReset(forceResetCallback);

    disposables.push(
        vscode.window.registerWebviewViewProvider(
            'mcp-feedback-enhanced.feedbackPanelBottom',
            bottomProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
    );

    disposables.push(
        vscode.commands.registerCommand('mcp-feedback-enhanced.openInEditor', () => {
            _openEditorPanel(context, port);
        }),
        vscode.commands.registerCommand('mcp-feedback-enhanced.openInBottom', () => {
            vscode.commands.executeCommand('mcp-feedback-enhanced.feedbackPanelBottom.focus');
        }),
        vscode.commands.registerCommand('mcp-feedback-enhanced.reconnect', () => {
            bottomProvider.reconnect();
        }),
        vscode.commands.registerCommand('mcp-feedback-enhanced.forceReset', async () => {
            try {
                const newPort = await forceResetCallback();
                vscode.window.showInformationMessage(`MCP Feedback: Reset! Server on port ${newPort}`);
            } catch (e) {
                vscode.window.showErrorMessage(`MCP Feedback: Reset failed - ${e}`);
            }
        }),
        vscode.commands.registerCommand('mcp-feedback-enhanced.showStatus', () => {
            const clients = wsServer.getConnectedClients();
            vscode.window.showInformationMessage(
                `MCP Feedback Status:\nPort: ${port}\nWebviews: ${clients.webviews}\nMCP Servers: ${clients.mcpServers}\nPending requests: ${wsServer.hasPendingRequests() ? 'Yes' : 'No'}`
            );
        }),
    );

    disposables.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            wsServer.setWorkspaces(getWorkspaces());
            wsServer.refreshServerRegistration();
        }),
    );

    ensureMcpConfig(context.extensionPath);
    deployCursorHooks(context.extensionPath);
    deployCursorRules();
    migratePendingFiles();

    context.subscriptions.push(...disposables);
    // Port info available via showStatus command

    const activatePanel = async () => {
        try {
            await vscode.commands.executeCommand('workbench.view.extension.mcp-feedback-enhanced-bottom');
            await vscode.commands.executeCommand('mcp-feedback-enhanced.feedbackPanelBottom.focus');
        } catch { /* commands may not be ready yet */ }
    };
    for (const delay of [1500, 3000, 5000]) {
        setTimeout(activatePanel, delay);
    }
}

export function deactivate(): void {
    cancelFeedbackReminders();
    for (const d of disposables) { d.dispose(); }
    disposables.length = 0;
    wsServer?.stop();
}

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

function ensureMcpConfig(extensionPath: string): void {
    try {
        const mcpConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');
        let config: Record<string, unknown> = {};

        if (fs.existsSync(mcpConfigPath)) {
            config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
        }

        const mcpServers = (config.mcpServers || {}) as Record<string, unknown>;
        const localServerPath = path.join(extensionPath, 'mcp-server', 'dist', 'index.js');
        const expectedCommand = 'node';
        const expectedArgs = [localServerPath];

        const existing = mcpServers['mcp-feedback-enhanced'] as Record<string, unknown> | undefined;
        if (existing?.command === expectedCommand &&
            JSON.stringify(existing?.args) === JSON.stringify(expectedArgs)) {
            return;
        }

        mcpServers['mcp-feedback-enhanced'] = {
            command: expectedCommand,
            args: expectedArgs,
        };
        delete mcpServers['mcp-feedback-v2'];
        config.mcpServers = mcpServers;

        fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
        fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
        // MCP config written
    } catch (e) {
        console.error('[MCP Feedback] Failed to update MCP config:', e);
    }
}

function deployCursorHooks(extensionPath: string): void {
    try {
        const hooksSourceDir = path.join(extensionPath, 'scripts', 'hooks');
        const targetDir = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced', 'hooks');
        fs.mkdirSync(targetDir, { recursive: true });

        const hookFiles = ['hook-utils.js', 'consume-pending.js'];
        for (const file of hookFiles) {
            const src = path.join(hooksSourceDir, file);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(targetDir, file));
            }
        }

        for (const old of ['check-pending.js', 'agent-stop.js', 'session-start.js']) {
            try { fs.unlinkSync(path.join(targetDir, old)); } catch { /* already gone */ }
        }

        const preToolUseHook = path.join(targetDir, 'consume-pending.js');
        const hooksConfigPath = path.join(os.homedir(), '.cursor', 'hooks.json');
        let hooksConfig: Record<string, unknown> = {};

        if (fs.existsSync(hooksConfigPath)) {
            hooksConfig = JSON.parse(fs.readFileSync(hooksConfigPath, 'utf-8'));
        }

        if (!hooksConfig.version) { hooksConfig.version = 1; }

        const hooks = (hooksConfig.hooks || {}) as Record<string, Array<Record<string, unknown>>>;
        const SOURCE_TAG = 'mcp-feedback-enhanced';
        const LEGACY_TAGS = ['mcp-feedback-v2'];

        let nodeBin = 'node';
        try {
            const resolved = require('child_process')
                .execSync('which node', { encoding: 'utf-8', timeout: 5000, env: process.env })
                .trim();
            if (resolved) { nodeBin = resolved; }
        } catch { /* keep bare 'node' as fallback */ }
        const hookEntries: Record<string, Record<string, unknown>> = {
            preToolUse: { command: `${nodeBin} ${preToolUseHook}` },
        };

        for (const [event, entry] of Object.entries(hookEntries)) {
            if (!hooks[event]) { hooks[event] = []; }
            hooks[event] = hooks[event].filter(h =>
                h._source !== SOURCE_TAG && !LEGACY_TAGS.includes(h._source as string)
            );
            hooks[event].push({
                ...entry,
                _source: SOURCE_TAG,
            });
        }

        const RETIRED_HOOKS = ['stop', 'sessionStart'];
        for (const event of RETIRED_HOOKS) {
            if (hooks[event]) {
                hooks[event] = hooks[event].filter(h =>
                    h._source !== SOURCE_TAG && !LEGACY_TAGS.includes(h._source as string)
                );
                if (hooks[event].length === 0) { delete hooks[event]; }
            }
        }

        hooksConfig.hooks = hooks;
        fs.mkdirSync(path.dirname(hooksConfigPath), { recursive: true });
        fs.writeFileSync(hooksConfigPath, JSON.stringify(hooksConfig, null, 2));
    } catch (e) {
        console.error('[MCP Feedback] Failed to deploy hooks:', e);
    }
}

const RULES_CONTENT = [
    '---',
    'alwaysApply: true',
    '---',
    '',
    '[MCP Feedback Enhanced] USAGE RULES:',
    '1. You MUST call interactive_feedback before ending your turn.',
    '2. Only when the user explicitly confirms you can stop should you end. The decision to exit is ALWAYS the user\'s, never yours.',
    '3. If you have completed your task, call interactive_feedback with a summary and ask the user for next steps.',
    '',
].join('\n');

function deployCursorRules(): void {
    try {
        const workspaces = getWorkspaces();
        for (const ws of workspaces) {
            const rulesDir = path.join(ws, '.cursor', 'rules');
            const ruleFile = path.join(rulesDir, 'mcp-feedback-enhanced.mdc');

            fs.mkdirSync(rulesDir, { recursive: true });

            let needsWrite = true;
            if (fs.existsSync(ruleFile)) {
                const existing = fs.readFileSync(ruleFile, 'utf-8');
                if (existing === RULES_CONTENT) { needsWrite = false; }
            }

            if (needsWrite) {
                fs.writeFileSync(ruleFile, RULES_CONTENT);
            }
        }
    } catch (e) {
        console.error('[MCP Feedback] Failed to deploy rules:', e);
    }
}

function migratePendingFiles(): void {
    try {
        const pendingDir = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced', 'pending');
        if (!fs.existsSync(pendingDir)) return;
        const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
        if (files.length === 0) {
            fs.rmdirSync(pendingDir);
            return;
        }
        for (const f of files) {
            try { fs.unlinkSync(path.join(pendingDir, f)); } catch { /* ignore */ }
        }
        try { fs.rmdirSync(pendingDir); } catch { /* ignore */ }
    } catch { /* ignore */ }
}
