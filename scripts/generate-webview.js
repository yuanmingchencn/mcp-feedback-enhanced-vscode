#!/usr/bin/env node
/**
 * Generate webview HTML file from webviewContentV2.ts
 * This script is run during compilation to create out/webview/panel.html
 * 
 * Usage:
 *   node scripts/generate-webview.js           # Development build (with hot-reload)
 *   node scripts/generate-webview.js --prod    # Production build (no hot-reload)
 */

const fs = require('fs');
const path = require('path');

// Check for production mode
const isProduction = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';

// Read the compiled JS to extract the HTML
// Note: This is a workaround - we generate HTML with placeholders
const packageJson = require('../package.json');
const VERSION = packageJson.version || '0.0.0';

if (isProduction) {
    console.log('[generate-webview] Production mode - hot-reload disabled');
}

// Generate the HTML directly (copy the logic from webviewContentV2.ts)
function generateHTML() {
    return `<!DOCTYPE html>
<html lang="en">
</head>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ws://127.0.0.1:* ws://localhost:*;">
    <title>MCP Feedback</title>
    <style>
${getStyles()}
    </style>
    <script>
        window.onerror = function(msg, url, line, col, error) {
            const statusText = document.getElementById('statusText');
            if (statusText) {
                statusText.textContent = 'Err: ' + msg;
                statusText.style.color = '#ff6b6b';
            }
            // Also try to send to console
            return false;
        };
    </script>
<body>
    <div class="container">
        <div class="status-bar">
            <span class="status-dot" id="statusDot"></span>
            <span class="status-text" id="statusText">Connecting...</span>
            <input type="text" class="search-input" id="searchInput" placeholder="Search..." style="display:none;">
            <span class="version">v${VERSION}</span>
            <button class="status-btn" id="searchBtn" title="Search messages">🔍</button>
            <button class="status-btn settings-toggle" id="settingsToggle" title="Settings">⚙️</button>
        </div>
        
        <div class="messages" id="messages">
            <div class="welcome" id="welcome">
                <div class="welcome-icon">💬</div>
                <div class="welcome-text">MCP Feedback</div>
                <div class="welcome-hint">Messages will appear here</div>
            </div>
        </div>
        
        <div class="input-area">
            <div class="quick-replies" id="quickRepliesContainer">
                <!-- Quick replies populated dynamically -->
            </div>
            
            <div class="settings-container" id="settingsContainer" style="display:none;">
                <div class="settings-section">
                    <div class="settings-section-header">
                        <input type="checkbox" id="autoReplyCheckbox">
                        <span class="settings-section-label">🔄 Auto Reply</span>
                    </div>
                    <div class="settings-section-content" id="autoReplyContent">
                        <textarea id="autoReplyText" placeholder="Enter auto reply message... (e.g., Continue, LGTM, etc.)"></textarea>
                    </div>
                </div>
                <div class="settings-section">
                    <div class="settings-section-header">
                        <span class="settings-section-label">📜 Rules (enabled rules appended to feedback)</span>
                    </div>
                    <div class="settings-section-content">
                        <div class="rules-list" id="rulesList"></div>
                        <div class="rules-add">
                            <input type="text" id="newRuleInput" placeholder="Add new rule...">
                            <button id="addRuleBtn">+</button>
                        </div>
                    </div>
                </div>
                <div class="settings-section">
                    <div class="settings-section-header">
                        <span class="settings-section-label">⚡ Quick Replies</span>
                    </div>
                    <div class="settings-section-content">
                        <div class="quick-replies-list" id="quickRepliesList"></div>
                        <div class="rules-add">
                            <input type="text" id="newQuickReplyInput" placeholder="Add quick reply text...">
                            <button id="addQuickReplyBtn">+</button>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="pending-section" id="pendingSection" style="display:none;">
                <div class="pending-header">
                    <span>Pending Queue</span>
                    <button class="clear-pending-btn" id="clearPendingBtn" title="Clear all">✕</button>
                </div>
                <div class="pending-list" id="pendingList">
                    <!-- Pending items populated dynamically -->
                </div>
            </div>
            <div class="input-row">
                <textarea id="input" placeholder="Type feedback... (Cmd+Enter to send)" rows="3"></textarea>
                <button id="sendBtn" title="Send (or queue if no AI request)">➤</button>
            </div>
        </div>
    </div>
    
    <script>
${getScript()}
    </script>
</body>
</html>`;
}

function getStyles() {
    return `
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-sideBar-background));
    height: 100vh;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.25);
    box-sizing: border-box;
}

.container {
    display: flex;
    flex-direction: column;
    height: 100%;
}

/* Status Bar */
.status-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--vscode-statusBar-background, #007acc);
    color: var(--vscode-statusBar-foreground, #fff);
    font-size: 11px;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f44;
}

.status-dot.connected { background: #4c4; }
.status-dot.connecting { background: #fc0; animation: pulse 1s infinite; }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.search-input {
    flex: 1;
    max-width: 150px;
    padding: 2px 6px;
    border: 1px solid var(--vscode-input-border, #333);
    border-radius: 3px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 11px;
}

.version {
    margin-left: auto;
    opacity: 0.6;
    font-size: 10px;
}

.status-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 4px;
    opacity: 0.8;
}

.status-btn:hover {
    background: rgba(255,255,255,0.2);
    opacity: 1;
}

/* Messages */
.messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 70%, black 5%);
}

.welcome {
    text-align: center;
    padding: 40px 20px;
    opacity: 0.6;
}

.welcome-icon { font-size: 32px; margin-bottom: 8px; }
.welcome-text { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
.welcome-hint { font-size: 12px; }

.message {
    display: flex;
    gap: 10px;
    margin-bottom: 16px;
    max-width: 85%;
}

/* AI messages on left */
.message.ai {
    margin-right: auto;
    flex-direction: row;
}

/* User messages on right */
.message.user {
    margin-left: auto;
    flex-direction: row-reverse;
}

.message-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
}

.message.ai .message-avatar {
    background: var(--vscode-terminal-ansiBlue, #569cd6);
}

.message.user .message-avatar {
    background: var(--vscode-terminal-ansiGreen, #4ec9b0);
}

.message-body {
    flex: 1;
    min-width: 0;
}

.message-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
}

/* User header aligned right */
.message.user .message-header {
    flex-direction: row-reverse;
}

.message-name {
    font-weight: 600;
    font-size: 12px;
}

.message.ai .message-name { color: var(--vscode-terminal-ansiBlue, #569cd6); }
.message.user .message-name { color: var(--vscode-terminal-ansiGreen, #4ec9b0); }

.message-time {
    font-size: 10px;
    opacity: 0.6;
}

.message-content {
    padding: 10px 12px;
    border-radius: 8px;
    word-break: break-word;
    line-height: 1.5;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}

.message.ai .message-content {
    background: var(--vscode-editor-background);
    border-left: 3px solid var(--vscode-terminal-ansiBlue, #569cd6);
}

.message.user .message-content {
    background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 15%, var(--vscode-editor-background));
    border-right: 3px solid var(--vscode-terminal-ansiGreen, #4ec9b0);
    text-align: left;
}

.message.pending {
    border-left: 3px solid var(--vscode-terminal-ansiYellow, #fc0);
    animation: pendingPulse 2s infinite;
}

@keyframes pendingPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.8; }
}

/* Input Area */
.input-area {
    padding: 8px 12px 12px;
    border-top: 1px solid var(--vscode-widget-border, #333);
    background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-sideBar-background));
    position: relative;
    z-index: 100;
    box-shadow: 0 -2px 8px rgba(0,0,0,0.2);
}

.quick-replies {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
    flex-wrap: wrap;
}

.settings-toggle.active {
    background: var(--vscode-terminal-ansiYellow, #dcdcaa);
    color: var(--vscode-editor-background);
}

/* Settings Container */
.settings-container {
    margin-bottom: 8px;
    padding: 8px;
    border: 1px solid var(--vscode-terminal-ansiYellow, #dcdcaa);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-terminal-ansiYellow) 5%, var(--vscode-editor-background));
}

.settings-section {
    margin-bottom: 8px;
}

.settings-section:last-child {
    margin-bottom: 0;
}

.settings-section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
}

.settings-section-header input[type="checkbox"] {
    cursor: pointer;
}

.settings-section-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
}

.settings-section-content {
    padding-left: 4px;
}

.settings-section-content textarea {
    width: 100%;
    min-height: 40px;
    max-height: 80px;
    resize: vertical;
    padding: 6px 8px;
    border: 1px solid var(--vscode-input-border, #333);
    border-radius: 4px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 12px;
}

/* Rules List */
.rules-list {
    max-height: 150px;
    overflow-y: auto;
    margin-bottom: 6px;
}

.rule-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    margin-bottom: 4px;
    background: var(--vscode-input-background);
    border-radius: 4px;
    font-size: 12px;
}

.rule-item input[type="checkbox"] {
    cursor: pointer;
}

.rule-item .rule-text {
    flex: 1;
    word-break: break-word;
}

.rule-item .rule-text.disabled {
    opacity: 0.5;
    text-decoration: line-through;
}

.rule-item .rule-actions {
    display: flex;
    gap: 4px;
}

.rule-item .rule-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    border-radius: 3px;
    opacity: 0.7;
}

.rule-item .rule-btn:hover {
    opacity: 1;
    background: rgba(255,255,255,0.1);
}

.rules-add {
    display: flex;
    gap: 6px;
}

.rules-add input {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border, #333);
    border-radius: 4px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 12px;
}

.rules-add button {
    padding: 4px 10px;
    background: var(--vscode-terminal-ansiMagenta, #c586c0);
    color: var(--vscode-editor-background);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
}

.quick-btn {
    padding: 4px 10px;
    font-size: 11px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 12px;
    cursor: pointer;
}

.quick-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.input-row {
    display: flex;
    gap: 8px;
}

#input {
    flex: 1;
    padding: 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #333);
    border-radius: 6px;
    box-shadow: inset 0 1px 4px rgba(0,0,0,0.2);
    font-family: inherit;
    font-size: inherit;
    resize: none;
}

#input:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
}

#sendBtn {
    padding: 8px 16px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 6px;
    box-shadow: inset 0 1px 4px rgba(0,0,0,0.2);
    cursor: pointer;
    font-size: 16px;
}

/* Pending Comment Section */
.pending-section {
    margin-bottom: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--vscode-terminal-ansiYellow) 10%, var(--vscode-editor-background));
    border: 1px solid var(--vscode-terminal-ansiYellow, #dcdcaa);
    border-radius: 6px;
}

.pending-header {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    margin-bottom: 4px;
}

.pending-content-row {
    display: flex;
    gap: 8px;
    align-items: center;
}

.pending-text {
    flex: 1;
    font-size: 12px;
    color: var(--vscode-foreground);
    word-break: break-word;
}

.pending-actions {
    display: flex;
    gap: 4px;
}

.pending-actions button {
    padding: 4px 8px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-input-border, #333);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    opacity: 0.7;
}

.pending-actions button:hover {
    opacity: 1;
    background: var(--vscode-button-secondaryHoverBackground);
}



#sendBtn:hover {
    background: var(--vscode-button-hoverBackground);
}

#sendBtn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

`;
}

function getScript() {
    const scriptPath = path.join(__dirname, 'webview-script.js');
    if (!fs.existsSync(scriptPath)) {
        throw new Error('Missing webview-script.js at ' + scriptPath);
    }
    let code = fs.readFileSync(scriptPath, 'utf8');
    code = code.replace(/__HOT_RELOAD_ENABLED__/g, String(!isProduction));
    return code;
}

// Main
const outDir = path.join(__dirname, '..', 'out', 'webview');
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

const html = generateHTML();
const outPath = path.join(outDir, 'panel.html');
fs.writeFileSync(outPath, html);
console.log('Generated:', outPath);
