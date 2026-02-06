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
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ws://127.0.0.1:* ws://localhost:*;">
    <title>MCP Feedback</title>
    <style>
${getStyles()}
    </style>
</head>
<body>
    <div class="container">
        <div class="status-bar">
            <span class="status-dot" id="statusDot"></span>
            <span class="status-text" id="statusText">Connecting...</span>
            <input type="text" class="search-input" id="searchInput" placeholder="Search..." style="display:none;">
            <span class="version">v${VERSION}</span>
            <button class="status-btn" id="searchBtn" title="Search messages">🔍</button>
            <button class="status-btn" id="reloadBtn" title="Reload Panel">🔄</button>
            <button class="status-btn" id="historyBtn" title="Session History">📋</button>
            <button class="status-btn scratch-toggle" id="scratchToggle" title="Scratch Pad">📋</button>
            <button class="status-btn settings-toggle" id="settingsToggle" title="Settings">⚙️</button>
        </div>
        
        <div class="tab-bar" id="tabBar">
            <div class="tab-bar-scroll" id="tabBarScroll"></div>
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
            <div class="scratch-pad" id="scratchPad" style="display:none;">
                <textarea id="scratchText" placeholder="Save notes, rules, templates here... (auto-saved)"></textarea>
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
                <div class="pending-header">Pending comment</div>
                <div class="pending-content-row">
                    <span class="pending-text" id="pendingText"></span>
                    <div class="pending-actions">
                        <button id="editPendingBtn" title="Edit">✎</button>
                        <button id="cancelPendingBtn" title="Cancel">✕</button>
                    </div>
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

.scratch-toggle.active { background: var(--vscode-button-background); }
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

.scratch-pad {
    margin-bottom: 8px;
}

.scratch-pad textarea {
    width: 100%;
    min-height: 60px;
    max-height: 150px;
    resize: vertical;
    padding: 8px;
    border: 1px solid var(--vscode-input-border, #333);
    border-radius: 4px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 12px;
}

.auto-reply-settings {
    margin-bottom: 8px;
    padding: 8px;
    border: 1px solid var(--vscode-terminal-ansiGreen, #4ec9b0);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 10%, var(--vscode-editor-background));
}

.auto-reply-header {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
}

.auto-reply-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-terminal-ansiGreen, #4ec9b0);
}

.auto-reply-settings textarea {
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

/* Tab Bar */
.tab-bar {
    display: flex;
    align-items: center;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    min-height: 35px;
    overflow: hidden;
}

.tab-bar-scroll {
    display: flex;
    overflow-x: auto;
    flex: 1;
    scrollbar-width: none;
    -ms-overflow-style: none;
}

.tab-bar-scroll::-webkit-scrollbar {
    display: none;
}

.tab-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
    border-right: 1px solid color-mix(in srgb, var(--vscode-panel-border, #444) 50%, transparent);
    color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground));
    background: transparent;
    transition: all 0.1s ease;
    position: relative;
    max-width: 160px;
}

.tab-item:hover {
    background: var(--vscode-tab-hoverBackground, rgba(255,255,255,0.05));
    color: var(--vscode-tab-hoverForeground, var(--vscode-foreground));
}

.tab-item.active {
    color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
    background: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
    border-bottom: 2px solid var(--vscode-focusBorder, #007fd4);
}

.tab-item-title {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
}

.tab-item-indicator {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vscode-statusBarItem-warningBackground, #f0ad4e);
    flex-shrink: 0;
    animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

.tab-item-close {
    opacity: 0;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
}

.tab-item:hover .tab-item-close {
    opacity: 0.7;
}

.tab-item-close:hover {
    opacity: 1 !important;
    color: var(--vscode-errorForeground, #f44);
}

.tab-item-unread {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-notificationsInfoIcon-foreground, #3794ff);
    flex-shrink: 0;
}

.tab-bar-empty {
    padding: 8px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    font-style: italic;
}

/* Historical session indicator */
.session-ended-banner {
    text-align: center;
    padding: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-panel-border) 10%);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
}
`;
}

function getScript() {
    return `
(function() {
    // Config - will be replaced at runtime
    const SERVER_URL = '{{SERVER_URL}}';
    const PROJECT_PATH = '{{PROJECT_PATH}}';
    const SESSION_ID = '{{SESSION_ID}}';
    const HOT_RELOAD_ENABLED = ${!isProduction};
    const HOT_RELOAD_PORT = 18799;
    const STORAGE_KEY = 'mcp-feedback-v2-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-40);
    
    // Acquire VS Code API once at startup
    const vscode = acquireVsCodeApi();
    
    // State
    let ws = null;
    let hotReloadWs = null;
    let messages = [];
    let pendingSessionId = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    
    // Tab management
    let tabs = []; // [{agent_name, pendingSessionId, hasUnread, lastTimestamp}]
    let activeTabAgent = null; // agent_name of the currently displayed tab
    
    // DOM
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const messagesDiv = document.getElementById('messages');
    const welcome = document.getElementById('welcome');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const reloadBtn = document.getElementById('reloadBtn');
    const tabBar = document.getElementById('tabBar');
    const tabBarScroll = document.getElementById('tabBarScroll');
    const historyBtn = document.getElementById('historyBtn');

    const pendingSection = document.getElementById('pendingSection');
    const pendingText = document.getElementById('pendingText');
    const editPendingBtn = document.getElementById('editPendingBtn');
    const cancelPendingBtn = document.getElementById('cancelPendingBtn');
    
    // Pending comment state
    let pendingComment = '';
    const PENDING_CACHE_KEY = 'mcp-feedback-pending-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    // Input cache key
    const INPUT_CACHE_KEY = 'mcp-feedback-input-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    // Restore cached input and pending comment
    try {
        const cached = localStorage.getItem(INPUT_CACHE_KEY);
        if (cached) input.value = cached;
        const pendingCached = localStorage.getItem(PENDING_CACHE_KEY);
        if (pendingCached) {
            pendingComment = pendingCached;
            updatePendingUI();
        }
    } catch {}
    
    // Save input on change
    input.addEventListener('input', () => {
        try { localStorage.setItem(INPUT_CACHE_KEY, input.value); } catch {}
    });
    
    // Update pending UI
    // Update pending UI
    function updatePendingUI() {
        if (pendingComment) {
            pendingSection.style.display = 'block';
            pendingText.textContent = pendingComment;
        } else {
            pendingSection.style.display = 'none';
            pendingText.textContent = '';
        }
        
        // Sync to extension host (for MCP Resource)
        vscode.postMessage({
            type: 'pending-update',
            value: pendingComment || ''
        });
    }
    

    
    // Edit pending - move back to input
    editPendingBtn.addEventListener('click', () => {
        if (pendingComment) {
            input.value = pendingComment;
            pendingComment = '';
            try {
                localStorage.removeItem(PENDING_CACHE_KEY);
                localStorage.setItem(INPUT_CACHE_KEY, input.value);
            } catch {}
            updatePendingUI();
            input.focus();
        }
    });
    
    // Cancel pending
    cancelPendingBtn.addEventListener('click', () => {
        pendingComment = '';
        try { localStorage.removeItem(PENDING_CACHE_KEY); } catch {}
        updatePendingUI();
    });
    
    // Search state (must be before render() call)
    let searchTerm = '';
    
    // Initialize
    loadHistory();
    // Restore tab state from localStorage
    loadTabState();
    renderTabBar();
    
    // Load messages for the active tab if any
    if (activeTabAgent) {
        const cached = loadCachedMessages(activeTabAgent);
        if (cached && cached.length > 0) {
            messages = cached;
            render();
        }
    }
    
    connect();
    if (HOT_RELOAD_ENABLED) connectHotReload();
    
    // Search functionality
    const searchBtn = document.getElementById('searchBtn');
    const searchInput = document.getElementById('searchInput');
    let searchVisible = false;
    
    searchBtn.addEventListener('click', () => {
        searchVisible = !searchVisible;
        searchInput.style.display = searchVisible ? 'block' : 'none';
        if (searchVisible) {
            searchInput.focus();
        } else {
            searchInput.value = '';
            searchTerm = '';
            render();  // Re-render without filter
        }
    });
    
    searchInput.addEventListener('input', () => {
        searchTerm = searchInput.value.toLowerCase();
        render();
    });
    
    // Reload button - request extension to reload webview content
    reloadBtn.addEventListener('click', () => {
        console.log('[MCP Feedback] Manual reload requested');
        // Try extension reload first
        vscode.postMessage({ type: 'reload-webview' });
        // Fallback: force page reload after 500ms if still visible
        setTimeout(() => {
            // Re-init by reconnecting WebSocket
            if (ws) {
                ws.close();
                ws = null;
            }
            connect();
        }, 500);
    });
    
    // History button click handler
    historyBtn.addEventListener('click', () => {
        // Refresh sessions list from server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get_sessions' }));
        }
    });
    
    // Scratch pad toggle and persistence
    const scratchToggle = document.getElementById('scratchToggle');
    const scratchPad = document.getElementById('scratchPad');
    const scratchText = document.getElementById('scratchText');
    const SCRATCH_KEY = 'mcp-feedback-scratch-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    // Load saved scratch content
    try {
        const saved = localStorage.getItem(SCRATCH_KEY);
        if (saved) scratchText.value = saved;
    } catch {}
    
    scratchToggle.addEventListener('click', () => {
        const isHidden = scratchPad.style.display === 'none';
        scratchPad.style.display = isHidden ? 'block' : 'none';
        scratchToggle.classList.toggle('active', isHidden);
    });
    
    scratchText.addEventListener('input', () => {
        try {
            localStorage.setItem(SCRATCH_KEY, scratchText.value);
        } catch {}
    });
    
    // ============================================
    // Settings Container (Auto-Reply + Rules)
    // ============================================
    const settingsToggle = document.getElementById('settingsToggle');
    const settingsContainer = document.getElementById('settingsContainer');
    const autoReplyCheckbox = document.getElementById('autoReplyCheckbox');
    const autoReplyText = document.getElementById('autoReplyText');
    const rulesList = document.getElementById('rulesList');
    const newRuleInput = document.getElementById('newRuleInput');
    const addRuleBtn = document.getElementById('addRuleBtn');
    
    const AUTO_REPLY_ENABLED_KEY = 'mcp-feedback-auto-reply-enabled-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    const AUTO_REPLY_TEXT_KEY = 'mcp-feedback-auto-reply-text-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    const RULES_KEY = 'mcp-feedback-rules-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    // State
    let autoReplyEnabled = false;
    let rules = [];
    
    // Load saved settings
    try {
        const enabledStr = localStorage.getItem(AUTO_REPLY_ENABLED_KEY);
        autoReplyEnabled = enabledStr === 'true';
        const savedText = localStorage.getItem(AUTO_REPLY_TEXT_KEY);
        if (savedText) autoReplyText.value = savedText;
        
        // Update UI based on saved state
        autoReplyCheckbox.checked = autoReplyEnabled;
    } catch {}
    
    // Load saved rules
    function loadRules() {
        try {
            const saved = localStorage.getItem(RULES_KEY);
            if (saved) rules = JSON.parse(saved);
        } catch {}
        // Sync initial state
        try {
            const enabledRules = rules.filter(r => r.enabled).map(r => r.content);
            vscode.postMessage({ type: 'rules-update', rules: enabledRules });
        } catch (e) {
            console.error('[MCP Feedback] Failed to sync rules:', e);
        }
    }
    
    function saveRules() {
        try {
            localStorage.setItem(RULES_KEY, JSON.stringify(rules));
        } catch {}
        // Sync update
        try {
            const enabledRules = rules.filter(r => r.enabled).map(r => r.content);
            vscode.postMessage({ type: 'rules-update', rules: enabledRules });
        } catch (e) {
            console.error('[MCP Feedback] Failed to sync rules:', e);
        }
    }
    
    // Toggle settings panel
    settingsToggle.addEventListener('click', () => {
        const isHidden = settingsContainer.style.display === 'none';
        settingsContainer.style.display = isHidden ? 'block' : 'none';
        settingsToggle.classList.toggle('active', isHidden);
        if (isHidden) {
            renderRules();
            renderQuickRepliesSettings();
        }
    });
    
    // ============================================
    // Quick Replies Management
    // ============================================
    const quickRepliesContainer = document.getElementById('quickRepliesContainer');
    const quickRepliesList = document.getElementById('quickRepliesList');
    const newQuickReplyInput = document.getElementById('newQuickReplyInput');
    const addQuickReplyBtn = document.getElementById('addQuickReplyBtn');
    const QUICK_REPLIES_KEY = 'mcp-feedback-quick-replies-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    // Default quick replies
    const DEFAULT_QUICK_REPLIES = [
        { id: '1', text: 'Continue', emoji: '\\u25b6\\ufe0f' },
        { id: '2', text: 'Looks good', emoji: '\\ud83d\\udc4d' },
        { id: '3', text: 'Please fix', emoji: '\\ud83d\\udd27' }
    ];
    
    let quickReplies = [];
    
    // Load quick replies
    function loadQuickReplies() {
        try {
            const saved = localStorage.getItem(QUICK_REPLIES_KEY);
            if (saved) {
                quickReplies = JSON.parse(saved);
            } else {
                quickReplies = [...DEFAULT_QUICK_REPLIES];
            }
        } catch {
            quickReplies = [...DEFAULT_QUICK_REPLIES];
        }
    }
    
    function saveQuickReplies() {
        try {
            localStorage.setItem(QUICK_REPLIES_KEY, JSON.stringify(quickReplies));
        } catch {}
    }
    
    // Render ALL quick replies in toolbar
    function renderQuickRepliesToolbar() {
        // Remove existing quick reply buttons
        const existingBtns = quickRepliesContainer.querySelectorAll('.quick-reply-btn');
        existingBtns.forEach(btn => btn.remove());
        
        // Add ALL quick replies
        quickReplies.forEach(qr => {
            const btn = document.createElement('button');
            btn.className = 'quick-btn quick-reply-btn';
            btn.textContent = qr.text;
            btn.title = qr.text;
            btn.addEventListener('click', () => {
                if (pendingSessionId) {
                    submitFeedback(qr.text);
                } else {
                    input.value = qr.text;
                    input.focus();
                }
            });
            quickRepliesContainer.appendChild(btn);
        });
    }
    
    // Render quick replies in settings
    function renderQuickRepliesSettings() {
        quickRepliesList.innerHTML = '';
        if (quickReplies.length === 0) {
            quickRepliesList.innerHTML = '<div style="opacity:0.5;font-size:11px;padding:4px;">No quick replies. Add one below.</div>';
            return;
        }
        
        quickReplies.forEach((qr, idx) => {
            const item = document.createElement('div');
            item.className = 'rule-item';
            
            // Text
            const textSpan = document.createElement('span');
            textSpan.className = 'rule-text';
            textSpan.textContent = qr.text;
            textSpan.title = 'Double-click to edit';
            textSpan.addEventListener('dblclick', () => {
                const newText = prompt('Edit quick reply:', qr.text);
                if (newText !== null && newText.trim()) {
                    quickReplies[idx].text = newText.trim();
                    saveQuickReplies();
                    renderQuickRepliesToolbar();
                    renderQuickRepliesSettings();
                }
            });
            item.appendChild(textSpan);
            
            // Actions
            const actions = document.createElement('div');
            actions.className = 'rule-actions';
            
            // Move up
            if (idx > 0) {
                const upBtn = document.createElement('button');
                upBtn.className = 'rule-btn';
                upBtn.textContent = '\\u2191';
                upBtn.title = 'Move up';
                upBtn.addEventListener('click', () => {
                    [quickReplies[idx - 1], quickReplies[idx]] = [quickReplies[idx], quickReplies[idx - 1]];
                    saveQuickReplies();
                    renderQuickRepliesToolbar();
                    renderQuickRepliesSettings();
                });
                actions.appendChild(upBtn);
            }
            
            // Move down
            if (idx < quickReplies.length - 1) {
                const downBtn = document.createElement('button');
                downBtn.className = 'rule-btn';
                downBtn.textContent = '\\u2193';
                downBtn.title = 'Move down';
                downBtn.addEventListener('click', () => {
                    [quickReplies[idx], quickReplies[idx + 1]] = [quickReplies[idx + 1], quickReplies[idx]];
                    saveQuickReplies();
                    renderQuickRepliesToolbar();
                    renderQuickRepliesSettings();
                });
                actions.appendChild(downBtn);
            }
            
            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'rule-btn';
            deleteBtn.textContent = '\\ud83d\\uddd1\\ufe0f';
            deleteBtn.title = 'Delete';
            deleteBtn.addEventListener('click', () => {
                quickReplies.splice(idx, 1);
                saveQuickReplies();
                renderQuickRepliesToolbar();
                renderQuickRepliesSettings();
            });
            actions.appendChild(deleteBtn);
            
            item.appendChild(actions);
            quickRepliesList.appendChild(item);
        });
    }
    
    // Add new quick reply
    function addQuickReply() {
        const text = newQuickReplyInput.value.trim();
        if (!text) return;
        
        quickReplies.push({
            id: Date.now().toString(),
            text: text
        });
        saveQuickReplies();
        renderQuickRepliesToolbar();
        renderQuickRepliesSettings();
        newQuickReplyInput.value = '';
    }
    
    addQuickReplyBtn.addEventListener('click', addQuickReply);
    newQuickReplyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addQuickReply();
        }
    });
    
    // Initialize quick replies
    loadQuickReplies();
    renderQuickRepliesToolbar();
    
    // Auto-reply checkbox
    autoReplyCheckbox.addEventListener('change', () => {
        autoReplyEnabled = autoReplyCheckbox.checked;
        try {
            localStorage.setItem(AUTO_REPLY_ENABLED_KEY, autoReplyEnabled.toString());
        } catch {}
    });
    
    // Save auto-reply text on change
    autoReplyText.addEventListener('input', () => {
        try {
            localStorage.setItem(AUTO_REPLY_TEXT_KEY, autoReplyText.value);
        } catch {}
    });
    
    // Render rules list
    function renderRules() {
        rulesList.innerHTML = '';
        if (rules.length === 0) {
            rulesList.innerHTML = '<div style="opacity:0.5;font-size:11px;padding:4px;">No rules yet. Add one below.</div>';
            return;
        }
        
        rules.forEach((rule, idx) => {
            const item = document.createElement('div');
            item.className = 'rule-item';
            
            // Checkbox
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = rule.enabled;
            checkbox.title = rule.enabled ? 'Disable rule' : 'Enable rule';
            checkbox.addEventListener('change', () => {
                rules[idx].enabled = checkbox.checked;
                saveRules();
                renderRules();
            });
            item.appendChild(checkbox);
            
            // Text
            const textSpan = document.createElement('span');
            textSpan.className = 'rule-text' + (rule.enabled ? '' : ' disabled');
            textSpan.textContent = rule.content;
            textSpan.title = 'Double-click to edit';
            textSpan.addEventListener('dblclick', () => {
                const newContent = prompt('Edit rule:', rule.content);
                if (newContent !== null && newContent.trim()) {
                    rules[idx].content = newContent.trim();
                    saveRules();
                    renderRules();
                }
            });
            item.appendChild(textSpan);
            
            // Actions
            const actions = document.createElement('div');
            actions.className = 'rule-actions';
            
            // Edit button
            const editBtn = document.createElement('button');
            editBtn.className = 'rule-btn';
            editBtn.textContent = '\u270f\ufe0f';
            editBtn.title = 'Edit';
            editBtn.addEventListener('click', () => {
                const newContent = prompt('Edit rule:', rule.content);
                if (newContent !== null && newContent.trim()) {
                    rules[idx].content = newContent.trim();
                    saveRules();
                    renderRules();
                }
            });
            actions.appendChild(editBtn);
            
            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'rule-btn';
            deleteBtn.textContent = '\ud83d\uddd1\ufe0f';
            deleteBtn.title = 'Delete';
            deleteBtn.addEventListener('click', () => {
                rules.splice(idx, 1);
                saveRules();
                renderRules();
            });
            actions.appendChild(deleteBtn);
            
            item.appendChild(actions);
            rulesList.appendChild(item);
        });
    }
    
    // Add new rule
    function addRule() {
        const content = newRuleInput.value.trim();
        if (!content) return;
        
        rules.push({
            id: Date.now().toString(),
            content: content,
            enabled: true
        });
        saveRules();
        renderRules();
        newRuleInput.value = '';
    }
    
    addRuleBtn.addEventListener('click', addRule);
    newRuleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addRule();
        }
    });
    
    // Load rules on startup
    loadRules();
    
    // ============================================
    // Tab Management Functions
    // ============================================
    function findTab(agentName) {
        return tabs.find(t => t.agent_name === agentName);
    }
    
    function ensureTab(agentName, opts = {}) {
        let tab = findTab(agentName);
        if (!tab) {
            tab = {
                agent_name: agentName,
                pendingSessionId: opts.pendingSessionId || null,
                hasUnread: opts.hasUnread || false,
                lastTimestamp: opts.lastTimestamp || new Date().toISOString()
            };
            tabs.push(tab);
        }
        if (opts.pendingSessionId !== undefined) tab.pendingSessionId = opts.pendingSessionId;
        if (opts.lastTimestamp) tab.lastTimestamp = opts.lastTimestamp;
        if (opts.hasUnread !== undefined) tab.hasUnread = opts.hasUnread;
        return tab;
    }
    
    function switchTab(agentName) {
        // Save current messages to cache before switching
        if (activeTabAgent) {
            saveCachedMessages(activeTabAgent, messages);
        }
        
        activeTabAgent = agentName;
        const tab = findTab(agentName);
        if (tab) {
            tab.hasUnread = false;
            pendingSessionId = tab.pendingSessionId;
        } else {
            pendingSessionId = null;
        }
        
        // Try loading from cache first
        const cached = loadCachedMessages(agentName);
        if (cached && cached.length > 0) {
            messages = cached;
            render();
            renderTabBar();
        } else {
            messages = [];
            render();
            renderTabBar();
        }
        
        // Also request fresh data from server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'load_session', agent_name: agentName }));
        }
        
        // Update input area visibility
        updateInputVisibility();
        saveTabState();
    }
    
    function closeTab(agentName) {
        tabs = tabs.filter(t => t.agent_name !== agentName);
        clearCachedMessages(agentName);
        
        if (activeTabAgent === agentName) {
            // Switch to another tab
            if (tabs.length > 0) {
                // Prefer an active tab, then most recent
                const activeTab = tabs.find(t => t.pendingSessionId) || tabs[0];
                switchTab(activeTab.agent_name);
            } else {
                activeTabAgent = null;
                messages = [];
                pendingSessionId = null;
                render();
            }
        }
        renderTabBar();
        saveTabState();
    }
    
    function updateInputVisibility() {
        const inputArea = document.querySelector('.input-area');
        const tab = findTab(activeTabAgent);
        if (tab && tab.pendingSessionId) {
            inputArea.style.display = '';
            sendBtn.disabled = false;
        } else if (activeTabAgent) {
            // Historical session - show input area but disable send until new request
            inputArea.style.display = '';
            sendBtn.disabled = !pendingSessionId;
        } else {
            inputArea.style.display = '';
            sendBtn.disabled = true;
        }
    }
    
    function renderTabBar() {
        if (!tabBarScroll) return;
        
        if (tabs.length === 0) {
            tabBarScroll.innerHTML = '<div class="tab-bar-empty">No conversations yet</div>';
            return;
        }
        
        tabBarScroll.innerHTML = '';
        
        // Sort: active (pending) tabs first, then by lastTimestamp descending
        const sorted = [...tabs].sort((a, b) => {
            if (a.pendingSessionId && !b.pendingSessionId) return -1;
            if (!a.pendingSessionId && b.pendingSessionId) return 1;
            return (b.lastTimestamp || '').localeCompare(a.lastTimestamp || '');
        });
        
        for (const tab of sorted) {
            const item = document.createElement('div');
            item.className = 'tab-item' + (tab.agent_name === activeTabAgent ? ' active' : '');
            
            // Title
            const title = document.createElement('span');
            title.className = 'tab-item-title';
            title.textContent = tab.agent_name || 'Agent';
            title.title = tab.agent_name || 'Agent';
            item.appendChild(title);
            
            // Pending indicator
            if (tab.pendingSessionId) {
                const indicator = document.createElement('span');
                indicator.className = 'tab-item-indicator';
                indicator.title = 'Waiting for response';
                item.appendChild(indicator);
            } else if (tab.hasUnread) {
                const unread = document.createElement('span');
                unread.className = 'tab-item-unread';
                item.appendChild(unread);
            }
            
            // Close button (only for tabs without pending sessions)
            if (!tab.pendingSessionId) {
                const close = document.createElement('span');
                close.className = 'tab-item-close';
                close.textContent = '×';
                close.title = 'Close';
                close.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeTab(tab.agent_name);
                });
                item.appendChild(close);
            }
            
            item.addEventListener('click', () => {
                if (activeTabAgent !== tab.agent_name) {
                    switchTab(tab.agent_name);
                }
            });
            
            tabBarScroll.appendChild(item);
        }
        
        // Scroll active tab into view
        const activeEl = tabBarScroll.querySelector('.tab-item.active');
        if (activeEl) {
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }
    
    // Per-tab message caching
    const TAB_CACHE_PREFIX = 'mcp-tab-msgs-';
    
    function saveCachedMessages(agentName, msgs) {
        try {
            const key = TAB_CACHE_PREFIX + agentName.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
            localStorage.setItem(key, JSON.stringify(msgs.slice(-50)));
        } catch (e) {}
    }
    
    function loadCachedMessages(agentName) {
        try {
            const key = TAB_CACHE_PREFIX + agentName.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
            const stored = localStorage.getItem(key);
            return stored ? JSON.parse(stored) : [];
        } catch (e) { return []; }
    }
    
    function clearCachedMessages(agentName) {
        try {
            const key = TAB_CACHE_PREFIX + agentName.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
            localStorage.removeItem(key);
        } catch (e) {}
    }
    
    // Tab state persistence
    const TAB_STATE_KEY = 'mcp-feedback-tabs-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    function saveTabState() {
        try {
            const state = {
                tabs: tabs.map(t => ({
                    agent_name: t.agent_name,
                    lastTimestamp: t.lastTimestamp,
                    pendingSessionId: t.pendingSessionId || null,
                    hasUnread: t.hasUnread || false
                })),
                activeTabAgent: activeTabAgent
            };
            localStorage.setItem(TAB_STATE_KEY, JSON.stringify(state));
        } catch (e) {}
    }
    
    function loadTabState() {
        try {
            const stored = localStorage.getItem(TAB_STATE_KEY);
            if (stored) {
                const state = JSON.parse(stored);
                if (state.tabs) {
                    for (const t of state.tabs) {
                        ensureTab(t.agent_name, {
                            lastTimestamp: t.lastTimestamp,
                            pendingSessionId: t.pendingSessionId || null,
                            hasUnread: t.hasUnread || false
                        });
                    }
                }
                if (state.activeTabAgent) {
                    activeTabAgent = state.activeTabAgent;
                }
            }
        } catch (e) {}
    }
    
    // Hot-reload WebSocket connection
    function connectHotReload() {
        try {
            hotReloadWs = new WebSocket('ws://127.0.0.1:' + HOT_RELOAD_PORT);
            hotReloadWs.onopen = () => {
                console.log('[MCP Feedback] Hot-reload connected');
            };
            hotReloadWs.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.type === 'reload') {
                        console.log('[MCP Feedback] Hot-reload triggered');
                        vscode.postMessage({ type: 'reload-webview' });
                    }
                } catch (err) {}
            };
            hotReloadWs.onclose = () => {
                // Silently retry after 5s
                setTimeout(connectHotReload, 5000);
            };
            hotReloadWs.onerror = () => {};
        } catch (e) {}
    }
    
    // Quick reply buttons
    document.querySelectorAll('.quick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (pendingSessionId) {
                submitFeedback(btn.dataset.text);
            }
        });
    });
    
    // Send button
    sendBtn.addEventListener('click', () => {
        const text = input.value.trim();
        if (text) {
            if (pendingSessionId) {
                submitFeedback(text);
            } else {
                // Queue info pending if not sending
                pendingComment = text;
                input.value = '';
                try {
                    localStorage.setItem(PENDING_CACHE_KEY, pendingComment);
                    localStorage.removeItem(INPUT_CACHE_KEY);
                } catch {}
                updatePendingUI();
            }
        }
    });
    
    // Keyboard shortcut
    input.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            const text = input.value.trim();
            if (text) {
                if (e.shiftKey || !pendingSessionId) {
                    // Cmd+Shift+Enter OR Cmd+Enter (when no session) = Queue
                    pendingComment = text;
                    input.value = '';
                    try {
                        localStorage.setItem(PENDING_CACHE_KEY, pendingComment);
                        localStorage.removeItem(INPUT_CACHE_KEY);
                    } catch {}
                    updatePendingUI();
                } else {
                    // Cmd+Enter = Send (if session pending)
                    submitFeedback(text);
                }
            }
        }
    });
    
    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;
        
        updateStatus('connecting', 'Connecting...');
        
        try {
            ws = new WebSocket(SERVER_URL);
            
            ws.onopen = () => {
                console.log('[MCP Feedback] Connected to', SERVER_URL);
                reconnectAttempts = 0;
                // Extract port from URL and show in status
                const portMatch = SERVER_URL.match(/:(\\d+)/);
                const port = portMatch ? portMatch[1] : '?';
                updateStatus('connected', 'Connected :' + port);
                
                ws.send(JSON.stringify({
                    type: 'register',
                    clientType: 'webview',
                    projectPath: PROJECT_PATH,
                    sessionId: SESSION_ID
                }));
                
                // Request sessions list to populate tabs
                ws.send(JSON.stringify({ type: 'get_sessions' }));
            };
            
            ws.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    handleMessage(msg);
                } catch (err) {
                    console.error('[MCP Feedback] Parse error:', err);
                }
            };
            
            ws.onclose = () => {
                console.log('[MCP Feedback] Disconnected');
                updateStatus('disconnected', 'Disconnected');
                scheduleReconnect();
            };
            
            ws.onerror = (err) => {
                console.error('[MCP Feedback] WebSocket error:', err);
            };
            
        } catch (err) {
            console.error('[MCP Feedback] Connect error:', err);
            scheduleReconnect();
        }
    }
    
    function scheduleReconnect() {
        if (reconnectAttempts >= maxReconnectAttempts) {
            updateStatus('error', 'Connection failed');
            return;
        }
        
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
        setTimeout(connect, delay);
    }
    
    function handleMessage(msg) {
        console.log('[MCP Feedback] Received:', msg.type);
        
        switch (msg.type) {
            case 'connection_established':
                console.log('[MCP Feedback] Server version:', msg.version);
                break;
                
            case 'session_updated':
                const info = msg.session_info;
                const agentName = info.agent_name || 'Agent';
                
                // Ensure tab exists for this agent
                const updatedTab = ensureTab(agentName, {
                    pendingSessionId: info.session_id,
                    lastTimestamp: new Date().toISOString()
                });
                
                if (activeTabAgent === agentName) {
                    // Current tab - add message directly
                    pendingSessionId = info.session_id;
                    messages.push({
                        role: 'ai',
                        content: info.summary,
                        timestamp: new Date().toISOString(),
                        session_id: info.session_id,
                        agent_name: agentName,
                        pending: true
                    });
                    saveHistory();
                    render();
                    updateInputVisibility();
                } else {
                    // Different tab - mark as unread, cache the message
                    updatedTab.hasUnread = true;
                    const cachedMsgs = loadCachedMessages(agentName);
                    cachedMsgs.push({
                        role: 'ai',
                        content: info.summary,
                        timestamp: new Date().toISOString(),
                        session_id: info.session_id,
                        agent_name: agentName,
                        pending: true
                    });
                    saveCachedMessages(agentName, cachedMsgs);
                    
                    // Auto-switch to the new request tab
                    switchTab(agentName);
                }
                
                renderTabBar();
                saveTabState();
                
                // Request focus
                vscode.postMessage({ type: 'new-session' });
                
                // Auto-reply if enabled and has text
                if (autoReplyEnabled && autoReplyText.value.trim()) {
                    const replyText = autoReplyText.value.trim();
                    setTimeout(() => {
                        if (pendingSessionId) {
                            submitFeedback(replyText);
                        }
                    }, 500);
                } else if (pendingComment) {
                    const textToSend = pendingComment;
                    setTimeout(() => {
                        if (pendingSessionId) {
                            submitFeedback(textToSend);
                            pendingComment = '';
                            try { localStorage.removeItem(PENDING_CACHE_KEY); } catch {}
                            updatePendingUI();
                        }
                    }, 500);
                }
                break;
                
            case 'feedback_submitted':
                if (msg.session_id === pendingSessionId) {
                    const m = messages.find(m => m.session_id === msg.session_id && m.pending);
                    if (m) m.pending = false;
                    pendingSessionId = null;
                    saveHistory();
                    render();
                    
                    // Update tab state
                    const submittedTab = findTab(activeTabAgent);
                    if (submittedTab && submittedTab.pendingSessionId === msg.session_id) {
                        submittedTab.pendingSessionId = null;
                    }
                    renderTabBar();
                    updateInputVisibility();
                    saveTabState();
                }
                break;
                
            case 'history':
                console.log('[MCP Feedback] Received history:', msg.sessions ? msg.sessions.length : 0, 'sessions');
                if (msg.sessions && msg.sessions.length > 0) {
                    messages = [];
                    for (const s of msg.sessions) {
                        messages.push({
                            role: 'ai',
                            content: s.summary,
                            timestamp: s.timestamp,
                            pending: !s.feedback
                        });
                        if (s.feedback) {
                            messages.push({
                                role: 'user',
                                content: s.feedback,
                                timestamp: s.timestamp
                            });
                        }
                    }
                    console.log('[MCP Feedback] Converted to', messages.length, 'messages');
                    const lastAi = messages.filter(m => m.role === 'ai').pop();
                    if (lastAi && lastAi.pending) {
                        pendingSessionId = lastAi.session_id || 'unknown';
                    }
                    saveHistory();
                    render();
                    console.log('[MCP Feedback] Rendered', messages.length, 'messages');
                }
                // Associate messages with active tab
                if (activeTabAgent) {
                    saveCachedMessages(activeTabAgent, messages);
                    // Restore pending session state from tab
                    const tab = findTab(activeTabAgent);
                    if (tab && tab.pendingSessionId) {
                        pendingSessionId = tab.pendingSessionId;
                    }
                }
                updateInputVisibility();
                renderTabBar();
                break;
                
            case 'sessions_list':
                const serverSessions = msg.sessions || [];
                for (const s of serverSessions) {
                    ensureTab(s.agent_name, {
                        lastTimestamp: s.last_timestamp
                    });
                }
                renderTabBar();
                
                // If no active tab, switch to the most recent one
                if (!activeTabAgent && tabs.length > 0) {
                    const mostRecent = tabs.reduce((a, b) => 
                        (a.lastTimestamp || '') > (b.lastTimestamp || '') ? a : b
                    );
                    switchTab(mostRecent.agent_name);
                }
                saveTabState();
                break;
                
            case 'session_loaded':
                if (msg.agent_name === activeTabAgent) {
                    messages = [];
                    if (msg.messages && msg.messages.length > 0) {
                        for (const m of msg.messages) {
                            messages.push({
                                role: m.role,
                                content: m.content,
                                timestamp: m.timestamp,
                                images: m.images,
                                agent_name: m.agent_name,
                                pending: false
                            });
                        }
                    } else if (msg.sessions && msg.sessions.length > 0) {
                        for (const s of msg.sessions) {
                            messages.push({ role: 'ai', content: s.summary, timestamp: s.timestamp, pending: false });
                            if (s.feedback) {
                                messages.push({ role: 'user', content: s.feedback, timestamp: s.timestamp, images: s.images, pending: false });
                            }
                        }
                    }
                    
                    // Check if there's a pending session for this tab
                    const loadedTab = findTab(activeTabAgent);
                    if (loadedTab && loadedTab.pendingSessionId) {
                        pendingSessionId = loadedTab.pendingSessionId;
                        // Mark the last AI message as pending if session is active
                        const lastAi = messages.filter(m => m.role === 'ai').pop();
                        if (lastAi) lastAi.pending = true;
                    }
                    
                    saveCachedMessages(activeTabAgent, messages);
                    render();
                    updateInputVisibility();
                }
                break;
                
            case 'pong':
            case 'status_update':
                break;
        }
    }
    
    function submitFeedback(text) {
        if (!pendingSessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
        
        // Append enabled rules as Hidden HTML Comment (Visible to LLM, Hidden in UI)
        const enabledRules = rules.filter(r => r.enabled);
        let feedbackText = text;
        
        if (enabledRules.length > 0) {
            const rulesText = enabledRules.map((r, i) => (i + 1) + '. ' + r.content).join('\n');
            feedbackText = text + '\n\n<!--\n[SYSTEM RULES - HIDDEN FROM CHAT HISTORY]\n请始终遵守以下rules:\n' + rulesText + '\n-->';
        }
        
        messages.push({
            role: 'user',
            content: text, // Only show pure user text in the panel history
            timestamp: new Date().toISOString()
        });
        
        const aiMsg = messages.find(m => m.session_id === pendingSessionId && m.pending);
        if (aiMsg) aiMsg.pending = false;
        
        ws.send(JSON.stringify({
            type: 'feedback_response',
            session_id: pendingSessionId,
            feedback: feedbackText,
            images: []
        }));
        
        pendingSessionId = null;
        input.value = '';
        try { localStorage.removeItem(INPUT_CACHE_KEY); } catch {}
        
        // Update tab state after submission
        const currentTab = findTab(activeTabAgent);
        if (currentTab) {
            currentTab.pendingSessionId = null;
        }
        renderTabBar();
        updateInputVisibility();
        saveTabState();
        saveCachedMessages(activeTabAgent, messages);
        saveHistory();
        render();
    }
    
    function updateStatus(state, text) {
        statusDot.className = 'status-dot ' + state;
        statusText.textContent = text;
    }
    
    function renderMarkdown(text) {
        if (!text) return '';
        
        // Escape HTML first
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        // Code blocks first (triple backticks) - preserve content
        html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(m, code) {
            return '<pre style="background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px;overflow-x:auto;margin:8px 0;white-space:pre-wrap;font-family:monospace">' + code.trim() + '</pre>';
        });
        
        // Inline code (single backticks)
        html = html.replace(/\`([^\`]+)\`/g, '<code style="background:var(--vscode-textCodeBlock-background);padding:2px 4px;border-radius:3px;font-family:monospace">$1</code>');
        
        // Headers (must be at start of line)
        html = html.replace(/^### (.+)$/gm, '<h4 style="font-size:13px;font-weight:600;margin:12px 0 6px;color:var(--vscode-foreground)">$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3 style="font-size:14px;font-weight:600;margin:14px 0 8px;color:var(--vscode-foreground)">$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2 style="font-size:16px;font-weight:600;margin:16px 0 10px;color:var(--vscode-foreground)">$1</h2>');
        
        // Bold - match **text** (non-greedy)
        html = html.replace(/\\*\\*([^*]+?)\\*\\*/g, '<strong>$1</strong>');
        
        // Italic - match *text* (non-greedy, not starting with *)
        html = html.replace(/(?<!\\*)\\*([^*]+?)\\*(?!\\*)/g, '<em>$1</em>');
        
        // Lists - unordered
        html = html.replace(/^- (.+)$/gm, '<div style="margin:4px 0;padding-left:16px">\\u2022 $1</div>');
        
        // Lists - ordered  
        html = html.replace(/^(\\d+)\\. (.+)$/gm, '<div style="margin:4px 0;padding-left:16px">$1. $2</div>');
        
        // Line breaks - convert double newlines to paragraph, single to <br>
        html = html.replace(/\\n\\n/g, '</p><p style="margin:8px 0">');
        html = html.replace(/\\n/g, '<br>');
        
        // Wrap in paragraph if we added paragraph tags
        if (html.includes('</p>')) {
            html = '<p style="margin:8px 0">' + html + '</p>';
        }
        
        return html;
    }
    
    function render() {
        welcome.style.display = messages.length === 0 ? 'block' : 'none';
        
        const existingMsgs = messagesDiv.querySelectorAll('.message');
        existingMsgs.forEach(el => el.remove());
        
        // Filter messages by search term
        const filteredMsgs = searchTerm 
            ? messages.filter(m => m.content && m.content.toLowerCase().includes(searchTerm))
            : messages;
        
        for (const msg of filteredMsgs) {
            const div = document.createElement('div');
            div.className = 'message ' + msg.role + (msg.pending ? ' pending' : '');
            
            const avatar = document.createElement('div');
            avatar.className = 'message-avatar';
            avatar.textContent = msg.role === 'ai' ? '🤖' : '👤';
            div.appendChild(avatar);
            
            const body = document.createElement('div');
            body.className = 'message-body';
            
            const header = document.createElement('div');
            header.className = 'message-header';
            
            const name = document.createElement('span');
            name.className = 'message-name';
            name.textContent = msg.role === 'ai' ? 'AI' : 'You';
            header.appendChild(name);
            
            if (msg.timestamp) {
                const time = document.createElement('span');
                time.className = 'message-time';
                time.textContent = formatTime(msg.timestamp);
                header.appendChild(time);
            }
            body.appendChild(header);
            
            const content = document.createElement('div');
            content.className = 'message-content';
            content.innerHTML = renderMarkdown(msg.content);
            body.appendChild(content);
            
            // Render images if present
            if (msg.images && msg.images.length > 0) {
                const imagesDiv = document.createElement('div');
                imagesDiv.className = 'message-images';
                imagesDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;';
                for (const imgSrc of msg.images) {
                    const img = document.createElement('img');
                    img.src = imgSrc;
                    img.style.cssText = 'max-width:200px;max-height:150px;border-radius:4px;cursor:pointer;';
                    img.title = 'Click to view full size';
                    img.onclick = () => window.open(imgSrc, '_blank');
                    imagesDiv.appendChild(img);
                }
                body.appendChild(imagesDiv);
            }
            
            div.appendChild(body);
            messagesDiv.appendChild(div);
        }
        
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        updateInputVisibility();
    }
    
    function formatTime(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
            return '';
        }
    }
    
    function loadHistory() {
        // Legacy support - load from old storage key if no active tab
        if (!activeTabAgent) {
            try {
                const stored = localStorage.getItem(STORAGE_KEY);
                if (stored) {
                    messages = JSON.parse(stored);
                    const lastAi = messages.filter(m => m.role === 'ai').pop();
                    if (lastAi && lastAi.pending) {
                        pendingSessionId = lastAi.session_id || null;
                    }
                }
            } catch (e) {
                console.error('[MCP Feedback] Load history error:', e);
            }
        }
    }
    
    function saveHistory() {
        try {
            const toSave = messages.slice(-50);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
        } catch (e) {
            console.error('[MCP Feedback] Save history error:', e);
        }
    }
    
    // Heartbeat
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
    
    // Handle messages from extension
    window.addEventListener('message', (e) => {
        const msg = e.data;
        switch (msg.type) {
            case 'reconnect':
                if (ws) ws.close();
                connect();
                break;
            case 'focus-input':
                input.focus();
                break;
        }
    });
    
    // Initialize
    loadQuickReplies();
    loadRules();
    loadHistory();
    connect();
})();
`;
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
