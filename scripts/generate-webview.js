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
        </div>
        
        <div class="messages" id="messages">
            <div class="welcome" id="welcome">
                <div class="welcome-icon">💬</div>
                <div class="welcome-text">MCP Feedback</div>
                <div class="welcome-hint">Messages will appear here</div>
            </div>
        </div>
        
        <div class="input-area">
            <div class="quick-replies">
                <button class="quick-btn" data-text="Continue">▶️ Continue</button>
                <button class="quick-btn" data-text="Looks good">👍 Good</button>
                <button class="quick-btn" data-text="Please fix">🔧 Fix</button>
                <button class="quick-btn" data-text="Explain more">💡 Explain</button>
                <button class="quick-btn" data-text="Think harder">🧠 Think</button>
                <button class="quick-btn" data-text="You decide">🎯 Decide</button>
                <button class="quick-btn scratch-toggle" id="scratchToggle">📋 Scratch</button>
                <button class="quick-btn auto-reply-toggle" id="autoReplyToggle" title="Toggle Auto Reply">🔄 Auto</button>
            </div>
            <div class="scratch-pad" id="scratchPad" style="display:none;">
                <textarea id="scratchText" placeholder="Save notes, rules, templates here... (auto-saved)"></textarea>
            </div>
            <div class="auto-reply-settings" id="autoReplySettings" style="display:none;">
                <div class="auto-reply-header">
                    <span class="auto-reply-label">🤖 Auto Reply Message:</span>
                </div>
                <textarea id="autoReplyText" placeholder="Enter auto reply message... (e.g., Continue, LGTM, etc.)"></textarea>
            </div>
            <div class="input-row">
                <textarea id="input" placeholder="Type feedback... (Cmd+Enter to send)" rows="3"></textarea>
                <button id="sendBtn" title="Send">➤</button>
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
.auto-reply-toggle.active { 
    background: var(--vscode-terminal-ansiGreen, #4ec9b0);
    color: var(--vscode-editor-background);
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
    
    // DOM
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const messagesDiv = document.getElementById('messages');
    const welcome = document.getElementById('welcome');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const reloadBtn = document.getElementById('reloadBtn');
    
    // Input cache key
    const INPUT_CACHE_KEY = 'mcp-feedback-input-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    // Restore cached input
    try {
        const cached = localStorage.getItem(INPUT_CACHE_KEY);
        if (cached) input.value = cached;
    } catch {}
    
    // Save input on change
    input.addEventListener('input', () => {
        try { localStorage.setItem(INPUT_CACHE_KEY, input.value); } catch {}
    });
    
    // Search state (must be before render() call)
    let searchTerm = '';
    
    // Initialize
    loadHistory();
    render();
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
    
    // Auto-reply settings
    const autoReplyToggle = document.getElementById('autoReplyToggle');
    const autoReplySettings = document.getElementById('autoReplySettings');
    const autoReplyText = document.getElementById('autoReplyText');
    const AUTO_REPLY_ENABLED_KEY = 'mcp-feedback-auto-reply-enabled-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    const AUTO_REPLY_TEXT_KEY = 'mcp-feedback-auto-reply-text-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    // State for auto-reply
    let autoReplyEnabled = false;
    
    // Load saved auto-reply settings
    try {
        const enabledStr = localStorage.getItem(AUTO_REPLY_ENABLED_KEY);
        autoReplyEnabled = enabledStr === 'true';
        const savedText = localStorage.getItem(AUTO_REPLY_TEXT_KEY);
        if (savedText) autoReplyText.value = savedText;
        
        // Update UI based on saved state
        if (autoReplyEnabled) {
            autoReplyToggle.classList.add('active');
            autoReplySettings.style.display = 'block';
        }
    } catch {}
    
    // Toggle auto-reply panel and enable/disable
    autoReplyToggle.addEventListener('click', () => {
        autoReplyEnabled = !autoReplyEnabled;
        autoReplyToggle.classList.toggle('active', autoReplyEnabled);
        autoReplySettings.style.display = autoReplyEnabled ? 'block' : 'none';
        try {
            localStorage.setItem(AUTO_REPLY_ENABLED_KEY, autoReplyEnabled.toString());
        } catch {}
        
        // Focus the text area when enabling
        if (autoReplyEnabled) {
            autoReplyText.focus();
        }
    });
    
    // Save auto-reply text on change
    autoReplyText.addEventListener('input', () => {
        try {
            localStorage.setItem(AUTO_REPLY_TEXT_KEY, autoReplyText.value);
        } catch {}
    });
    
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
        if (text && pendingSessionId) {
            submitFeedback(text);
        }
    });
    
    // Keyboard shortcut
    input.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            const text = input.value.trim();
            if (text && pendingSessionId) {
                submitFeedback(text);
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
                pendingSessionId = info.session_id;
                
                messages.push({
                    role: 'ai',
                    content: info.summary,
                    timestamp: new Date().toISOString(),
                    session_id: info.session_id,
                    pending: true
                });
                
                saveHistory();
                render();
                
                // Request focus (no sound/notification - they block the input)
                vscode.postMessage({ type: 'new-session' });
                
                // Auto-reply if enabled and has text
                if (autoReplyEnabled && autoReplyText.value.trim()) {
                    const replyText = autoReplyText.value.trim();
                    console.log('[MCP Feedback] Auto-reply triggered:', replyText);
                    // Small delay to ensure UI is updated and user can see the AI message
                    setTimeout(() => {
                        if (pendingSessionId) {
                            submitFeedback(replyText);
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
                break;
                
            case 'pong':
            case 'status_update':
                break;
        }
    }
    
    function submitFeedback(text) {
        if (!pendingSessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
        
        messages.push({
            role: 'user',
            content: text,
            timestamp: new Date().toISOString()
        });
        
        const aiMsg = messages.find(m => m.session_id === pendingSessionId && m.pending);
        if (aiMsg) aiMsg.pending = false;
        
        ws.send(JSON.stringify({
            type: 'feedback_response',
            session_id: pendingSessionId,
            feedback: text,
            images: []
        }));
        
        pendingSessionId = null;
        input.value = '';
        try { localStorage.removeItem(INPUT_CACHE_KEY); } catch {}
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
        sendBtn.disabled = !pendingSessionId;
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
