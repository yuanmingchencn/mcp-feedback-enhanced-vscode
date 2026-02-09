(function() {
    // ============================================
    // Configuration
    // ============================================
    const SERVER_URL = '{{SERVER_URL}}';
    const PROJECT_PATH = '{{PROJECT_PATH}}';
    const SESSION_ID = '{{SESSION_ID}}';
    const HOT_RELOAD_ENABLED = __HOT_RELOAD_ENABLED__;
    const HOT_RELOAD_PORT = 18799;
    const STORAGE_KEY = 'mcp-feedback-v2-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-40);
    
    // Acquire VS Code API once at startup
    const vscode = acquireVsCodeApi();
    
    // ============================================
    // State
    // ============================================
    let ws = null;
    let hotReloadWs = null;
    let messages = [];
    let pendingSessionId = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    let searchTerm = '';
    let searchVisible = false;
    let heartbeatId = null;
    let autoReplyTimeoutId = null;
    
    // ============================================
    // DOM Elements
    // ============================================
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const messagesDiv = document.getElementById('messages');
    const welcome = document.getElementById('welcome');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const tabBar = document.getElementById('tabBar');
    const searchBtn = document.getElementById('searchBtn');
    const searchInput = document.getElementById('searchInput');
    
    // Pending Queue DOM
    const pendingSection = document.getElementById('pendingSection');
    const pendingList = document.getElementById('pendingList');
    const clearPendingBtn = document.getElementById('clearPendingBtn');
    
    // Settings DOM
    const settingsToggle = document.getElementById('settingsToggle');
    const settingsContainer = document.getElementById('settingsContainer');
    const autoReplyCheckbox = document.getElementById('autoReplyCheckbox');
    const autoReplyText = document.getElementById('autoReplyText');
    const rulesList = document.getElementById('rulesList');
    const newRuleInput = document.getElementById('newRuleInput');
    const addRuleBtn = document.getElementById('addRuleBtn');
    
    // Quick Replies DOM
    const quickRepliesContainer = document.getElementById('quickRepliesContainer');
    const quickRepliesList = document.getElementById('quickRepliesList');
    const newQuickReplyInput = document.getElementById('newQuickReplyInput');
    const addQuickReplyBtn = document.getElementById('addQuickReplyBtn');
    
    // ============================================
    // Hide Tab Bar
    // ============================================
    if (tabBar) {
        tabBar.style.display = 'none';
    }
    
    // ============================================
    // Pending Comments Queue
    // ============================================
    let pendingComments = [];
    const PENDING_CACHE_KEY = 'mcp-feedback-pending-queue-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    const INPUT_CACHE_KEY = 'mcp-feedback-input-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    // Restore cached content
    try {
        const cachedInput = localStorage.getItem(INPUT_CACHE_KEY);
        if (cachedInput) input.value = cachedInput;
        
        const cachedPending = localStorage.getItem(PENDING_CACHE_KEY);
        if (cachedPending) {
            pendingComments = JSON.parse(cachedPending);
            if (!Array.isArray(pendingComments)) pendingComments = [];
            updatePendingUI();
        }
    } catch {}
    
    // Save input on change
    input.addEventListener('input', () => {
        try { localStorage.setItem(INPUT_CACHE_KEY, input.value); } catch {}
        updateSendButtonState();
    });
    
    function savePendingComments() {
        try {
            if (pendingComments.length > 0) {
                localStorage.setItem(PENDING_CACHE_KEY, JSON.stringify(pendingComments));
            } else {
                localStorage.removeItem(PENDING_CACHE_KEY);
            }
        } catch {}
        updatePendingUI();
        updateSendButtonState();
    }
    
    function addToQueue(text) {
        if (!text || !text.trim()) return;
        pendingComments.push(text.trim());
        savePendingComments();
        input.value = '';
        try { localStorage.removeItem(INPUT_CACHE_KEY); } catch {}
        updateSendButtonState();
    }
    
    function updatePendingUI() {
        if (pendingComments.length > 0) {
            pendingSection.style.display = 'block';
            pendingList.innerHTML = '';
            
            pendingComments.forEach((comment, idx) => {
                const item = document.createElement('div');
                item.className = 'pending-content-row';
                item.style.marginBottom = '4px';
                
                const text = document.createElement('span');
                text.className = 'pending-text';
                text.textContent = comment;
                item.appendChild(text);
                
                const actions = document.createElement('div');
                actions.className = 'pending-actions';
                
                // Edit
                const editBtn = document.createElement('button');
                editBtn.textContent = '✎';
                editBtn.title = 'Edit';
                editBtn.onclick = () => {
                    input.value = comment;
                    pendingComments.splice(idx, 1);
                    savePendingComments();
                    input.focus();
                };
                actions.appendChild(editBtn);
                
                // Delete
                const delBtn = document.createElement('button');
                delBtn.textContent = '✕';
                delBtn.title = 'Remove';
                delBtn.onclick = () => {
                    pendingComments.splice(idx, 1);
                    savePendingComments();
                };
                actions.appendChild(delBtn);
                
                item.appendChild(actions);
                pendingList.appendChild(item);
            });
            
        } else {
            pendingSection.style.display = 'none';
            pendingList.innerHTML = '';
        }
        
        // Sync to extension host (for MCP Resource)
        const combined = pendingComments.join('\n\n');
        vscode.postMessage({
            type: 'pending-update',
            value: combined
        });
    }
    
    clearPendingBtn.addEventListener('click', () => {
        if (confirm('Clear all pending comments?')) {
            pendingComments = [];
            savePendingComments();
        }
    });
    
    function updateSendButtonState() {
        const hasInput = input.value.trim().length > 0;
        const hasPending = pendingComments.length > 0;
        
        if (pendingSessionId) {
            sendBtn.disabled = !(hasInput || hasPending);
            sendBtn.title = (hasInput || hasPending) ? 'Send Feedback' : 'Type feedback...';
        } else {
            sendBtn.disabled = !hasInput;
            sendBtn.title = hasInput ? 'Add to Queue' : 'Type to queue...';
        }
    }
    
    // ============================================
    // Search Functionality
    // ============================================
    searchBtn.addEventListener('click', () => {
        searchVisible = !searchVisible;
        searchInput.style.display = searchVisible ? 'block' : 'none';
        if (searchVisible) {
            searchInput.focus();
        } else {
            searchTerm = '';
            searchInput.value = '';
            render();
        }
    });
    
    searchInput.addEventListener('input', () => {
        searchTerm = searchInput.value.toLowerCase();
        render();
    });
    
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchVisible = false;
            searchInput.style.display = 'none';
            searchTerm = '';
            searchInput.value = '';
            render();
        }
    });
    
    // ============================================
    // Settings (Auto-Reply + Rules)
    // ============================================
    const AUTO_REPLY_ENABLED_KEY = 'mcp-feedback-auto-reply-enabled-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    const AUTO_REPLY_TEXT_KEY = 'mcp-feedback-auto-reply-text-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    const RULES_KEY = 'mcp-feedback-rules-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    let autoReplyEnabled = false;
    let rules = [];
    
    // Load saved settings
    try {
        const enabledStr = localStorage.getItem(AUTO_REPLY_ENABLED_KEY);
        autoReplyEnabled = enabledStr === 'true';
        const savedText = localStorage.getItem(AUTO_REPLY_TEXT_KEY);
        if (savedText) autoReplyText.value = savedText;
        autoReplyCheckbox.checked = autoReplyEnabled;
    } catch {}
    
    function loadRules() {
        try {
            const saved = localStorage.getItem(RULES_KEY);
            if (saved) rules = JSON.parse(saved);
        } catch {}
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
        try {
            const enabledRules = rules.filter(r => r.enabled).map(r => r.content);
            vscode.postMessage({ type: 'rules-update', rules: enabledRules });
        } catch (e) {
            console.error('[MCP Feedback] Failed to sync rules:', e);
        }
    }
    
    settingsToggle.addEventListener('click', () => {
        const isHidden = settingsContainer.style.display === 'none';
        settingsContainer.style.display = isHidden ? 'block' : 'none';
        settingsToggle.classList.toggle('active', isHidden);
        if (isHidden) {
            renderRules();
            renderQuickRepliesSettings();
        }
    });
    
    autoReplyCheckbox.addEventListener('change', () => {
        autoReplyEnabled = autoReplyCheckbox.checked;
        if (!autoReplyEnabled && autoReplyTimeoutId) {
            clearTimeout(autoReplyTimeoutId);
            autoReplyTimeoutId = null;
        }
        try {
            localStorage.setItem(AUTO_REPLY_ENABLED_KEY, autoReplyEnabled.toString());
        } catch {}
    });
    
    autoReplyText.addEventListener('input', () => {
        try {
            localStorage.setItem(AUTO_REPLY_TEXT_KEY, autoReplyText.value);
        } catch {}
    });
    
    function renderRules() {
        rulesList.innerHTML = '';
        if (rules.length === 0) {
            rulesList.innerHTML = '<div style="opacity:0.5;font-size:11px;padding:4px;">No rules yet. Add one below.</div>';
            return;
        }
        
        rules.forEach((rule, idx) => {
            const item = document.createElement('div');
            item.className = 'rule-item';
            
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
            
            const actions = document.createElement('div');
            actions.className = 'rule-actions';
            
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
    
    // ============================================
    // Quick Replies Management
    // ============================================
    const QUICK_REPLIES_KEY = 'mcp-feedback-quick-replies-' + PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-').slice(-30);
    
    const DEFAULT_QUICK_REPLIES = [
        { id: '1', text: 'Continue', emoji: '\u25b6\ufe0f' },
        { id: '2', text: 'Looks good', emoji: '\ud83d\udc4d' },
        { id: '3', text: 'Please fix', emoji: '\ud83d\udd27' }
    ];
    
    let quickReplies = [];
    
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
    
    function renderQuickRepliesToolbar() {
        const existingBtns = quickRepliesContainer.querySelectorAll('.quick-reply-btn');
        existingBtns.forEach(btn => btn.remove());
        
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
    
    function renderQuickRepliesSettings() {
        quickRepliesList.innerHTML = '';
        if (quickReplies.length === 0) {
            quickRepliesList.innerHTML = '<div style="opacity:0.5;font-size:11px;padding:4px;">No quick replies. Add one below.</div>';
            return;
        }
        
        quickReplies.forEach((qr, idx) => {
            const item = document.createElement('div');
            item.className = 'rule-item';
            
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
            
            const actions = document.createElement('div');
            actions.className = 'rule-actions';
            
            if (idx > 0) {
                const upBtn = document.createElement('button');
                upBtn.className = 'rule-btn';
                upBtn.textContent = '\u2191';
                upBtn.title = 'Move up';
                upBtn.addEventListener('click', () => {
                    [quickReplies[idx - 1], quickReplies[idx]] = [quickReplies[idx], quickReplies[idx - 1]];
                    saveQuickReplies();
                    renderQuickRepliesToolbar();
                    renderQuickRepliesSettings();
                });
                actions.appendChild(upBtn);
            }
            
            if (idx < quickReplies.length - 1) {
                const downBtn = document.createElement('button');
                downBtn.className = 'rule-btn';
                downBtn.textContent = '\u2193';
                downBtn.title = 'Move down';
                downBtn.addEventListener('click', () => {
                    [quickReplies[idx], quickReplies[idx + 1]] = [quickReplies[idx + 1], quickReplies[idx]];
                    saveQuickReplies();
                    renderQuickRepliesToolbar();
                    renderQuickRepliesSettings();
                });
                actions.appendChild(downBtn);
            }
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'rule-btn';
            deleteBtn.textContent = '\ud83d\uddd1\ufe0f';
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
    
    // ============================================
    // WebSocket Connection
    // ============================================
    let connectionUrl = SERVER_URL;
    let fallbackAttempted = false;
    
    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;
        
        const host = connectionUrl.includes('127.0.0.1') ? '127.0.0.1' : 'localhost';
        updateStatus('connecting', 'Connecting to ' + host + '...');
        
        try {
            ws = new WebSocket(connectionUrl);
            
            ws.onopen = () => {
                console.log('[MCP Feedback] Connected to', connectionUrl);
                reconnectAttempts = 0;
                fallbackAttempted = false;
                
                const portMatch = connectionUrl.match(/:(\d+)/);
                const port = portMatch ? portMatch[1] : '?';
                updateStatus('connected', 'Connected :' + port);
                
                ws.send(JSON.stringify({
                    type: 'register',
                    clientType: 'webview',
                    projectPath: PROJECT_PATH,
                    sessionId: SESSION_ID
                }));
                
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
            
            ws.onclose = (e) => {
                console.log('[MCP Feedback] Disconnected', e.code, e.reason);
                updateStatus('disconnected', 'Disconnected (' + e.code + ')');
                if (heartbeatId) {
                    clearInterval(heartbeatId);
                    heartbeatId = null;
                }
                scheduleReconnect();
            };
            
            ws.onerror = (err) => {
                console.error('[MCP Feedback] WebSocket error:', err);
                if (!fallbackAttempted && reconnectAttempts === 0) {
                    console.log('[MCP Feedback] Connection failed, trying fallback host...');
                    fallbackAttempted = true;
                    if (connectionUrl.includes('127.0.0.1')) {
                        connectionUrl = connectionUrl.replace('127.0.0.1', 'localhost');
                    } else {
                        connectionUrl = connectionUrl.replace('localhost', '127.0.0.1');
                    }
                    ws = null;
                    connect();
                    return;
                }
                
                updateStatus('error', 'Conn Err: ' + (typeof err === 'object' ? 'Failed' : err));
            };
            
        } catch (err) {
            console.error('[MCP Feedback] Connect error:', err);
            updateStatus('error', 'Init Err: ' + err.message);
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
    
    // ============================================
    // Message Handling
    // ============================================
    function handleMessage(msg) {
        console.log('[MCP Feedback] Received:', msg.type);
        
        switch (msg.type) {
            case 'connection_established':
                console.log('[MCP Feedback] Server version:', msg.version);
                break;
                
            case 'session_updated': {
                const info = msg.session_info;
                const agentName = info.agent_name || 'Agent';
                
                // Update pending session ID
                pendingSessionId = info.session_id;
                
                // Check for existing message with same session_id (prevents duplicates on reconnection)
                const existingIdx = messages.findIndex(m => m.session_id === info.session_id && m.role === 'ai');
                if (existingIdx >= 0) {
                    // Update existing message instead of adding duplicate
                    messages[existingIdx].content = info.summary;
                    messages[existingIdx].agent_name = agentName;
                    messages[existingIdx].pending = true;
                } else {
                    // Add new AI message
                    messages.push({
                        role: 'ai',
                        content: info.summary,
                        timestamp: new Date().toISOString(),
                        session_id: info.session_id,
                        agent_name: agentName,
                        pending: true
                    });
                }
                
                saveHistory();
                render();
                updateSendButtonState();
                
                // Request focus
                vscode.postMessage({ type: 'new-session' });
                
                // Auto-send pending comments if available
                if (pendingComments.length > 0) {
                    const combined = pendingComments.join('\n\n');
                    if (submitFeedback(combined)) {
                        pendingComments = [];
                        savePendingComments();
                    }
                } else if (autoReplyEnabled && autoReplyText.value.trim()) {
                    // Auto-reply if enabled
                    const replyText = autoReplyText.value.trim();
                    const targetSessionId = pendingSessionId;
                    if (autoReplyTimeoutId) clearTimeout(autoReplyTimeoutId);
                    autoReplyTimeoutId = setTimeout(() => {
                        autoReplyTimeoutId = null;
                        if (pendingSessionId === targetSessionId && autoReplyEnabled) {
                            submitFeedback(replyText);
                        }
                    }, 500);
                }
                break;
            }
                
            case 'feedback_submitted':
                if (msg.session_id === pendingSessionId) {
                    const m = messages.find(m => m.session_id === msg.session_id && m.pending);
                    if (m) m.pending = false;
                    pendingSessionId = null;
                    saveHistory();
                    render();
                    updateSendButtonState();
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
                            session_id: s.session_id,
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
                        pendingSessionId = lastAi.session_id || null;
                    }
                    saveHistory();
                    render();
                    updateSendButtonState();
                    console.log('[MCP Feedback] Rendered', messages.length, 'messages');
                }
                break;
                
            case 'sessions_list':
                // No tab management - just log
                console.log('[MCP Feedback] Sessions list:', msg.sessions ? msg.sessions.length : 0, 'sessions');
                break;
                
            case 'session_loaded': {
                messages = [];
                if (msg.messages && msg.messages.length > 0) {
                    for (const m of msg.messages) {
                        messages.push({
                            role: m.role,
                            content: m.content,
                            timestamp: m.timestamp,
                            images: m.images,
                            agent_name: m.agent_name,
                            session_id: m.session_id,
                            pending: false
                        });
                    }
                } else if (msg.sessions && msg.sessions.length > 0) {
                    for (const s of msg.sessions) {
                        messages.push({
                            role: 'ai',
                            content: s.summary,
                            timestamp: s.timestamp,
                            session_id: s.session_id,
                            pending: false
                        });
                        if (s.feedback) {
                            messages.push({
                                role: 'user',
                                content: s.feedback,
                                timestamp: s.timestamp,
                                images: s.images,
                                pending: false
                            });
                        }
                    }
                }
                
                const lastAiMsg = messages.filter(m => m.role === 'ai').pop();
                if (lastAiMsg && msg.session_id && lastAiMsg.session_id === msg.session_id) {
                    pendingSessionId = msg.session_id;
                    lastAiMsg.pending = true;
                }
                
                saveHistory();
                render();
                updateSendButtonState();
                break;
            }
                
            case 'pong':
            case 'status_update':
                break;
                
            default:
                console.log('[MCP Feedback] Unknown message type:', msg.type);
                break;
        }
    }
    
    // ============================================
    // Feedback Submission
    // ============================================
    function submitFeedback(text) {
        if (!pendingSessionId || !ws || ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        
        // Append enabled rules as Hidden HTML Comment
        const enabledRules = rules.filter(r => r.enabled);
        let feedbackText = text;
        
        if (enabledRules.length > 0) {
            const rulesText = enabledRules.map((r, i) => (i + 1) + '. ' + r.content.replace(/-->/g, '--&gt;')).join('\n');
            feedbackText = text + '\n\n<!--\n[SYSTEM RULES - HIDDEN FROM CHAT HISTORY]\n请始终遵守以下rules:\n' + rulesText + '\n-->';
        }
        
        // Try to send via WebSocket
        try {
            ws.send(JSON.stringify({
                type: 'feedback_response',
                session_id: pendingSessionId,
                feedback: feedbackText,
                images: []
            }));
        } catch (e) {
            console.error('[MCP Feedback] Send failed:', e);
            // Don't clear state since send failed
            return false;
        }
        
        // Only update state after successful send
        messages.push({
            role: 'user',
            content: text,
            timestamp: new Date().toISOString()
        });
        
        const aiMsg = messages.find(m => m.session_id === pendingSessionId && m.pending);
        if (aiMsg) aiMsg.pending = false;
        
        pendingSessionId = null;
        input.value = '';
        try { localStorage.removeItem(INPUT_CACHE_KEY); } catch {}
        
        saveHistory();
        render();
        updateSendButtonState();
        
        return true;
    }
    
    // ============================================
    // Send Button and Input Handling
    // ============================================
    sendBtn.addEventListener('click', () => {
        const text = input.value.trim();
        
        if (pendingSessionId) {
            const parts = [...pendingComments];
            if (text) parts.push(text);
            
            if (parts.length > 0) {
                const combined = parts.join('\n\n');
                submitFeedback(combined);
                
                input.value = '';
                pendingComments = [];
                savePendingComments();
                try { localStorage.removeItem(INPUT_CACHE_KEY); } catch {}
            }
        } else {
            if (text) {
                addToQueue(text);
            }
        }
    });
    
    input.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            const text = input.value.trim();
            
            if (e.shiftKey) {
                if (text) addToQueue(text);
            } else {
                if (pendingSessionId) {
                    const parts = [...pendingComments];
                    if (text) parts.push(text);
                    
                    if (parts.length > 0) {
                        const combined = parts.join('\n\n');
                        submitFeedback(combined);
                        
                        input.value = '';
                        pendingComments = [];
                        savePendingComments();
                        try { localStorage.removeItem(INPUT_CACHE_KEY); } catch {}
                    }
                } else {
                    if (text) addToQueue(text);
                }
            }
        }
    });
    
    // ============================================
    // Rendering
    // ============================================
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
        html = html.replace(/```([\s\S]*?)```/g, function(m, code) {
            return '<pre style="background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px;overflow-x:auto;margin:8px 0;white-space:pre-wrap;font-family:monospace">' + code.trim() + '</pre>';
        });
        
        // Inline code (single backticks)
        html = html.replace(/`([^`]+)`/g, '<code style="background:var(--vscode-textCodeBlock-background);padding:2px 4px;border-radius:3px;font-family:monospace">$1</code>');
        
        // Headers (must be at start of line)
        html = html.replace(/^### (.+)$/gm, '<h4 style="font-size:13px;font-weight:600;margin:12px 0 6px;color:var(--vscode-foreground)">$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3 style="font-size:14px;font-weight:600;margin:14px 0 8px;color:var(--vscode-foreground)">$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2 style="font-size:16px;font-weight:600;margin:16px 0 10px;color:var(--vscode-foreground)">$1</h2>');
        
        // Bold - match **text** (non-greedy)
        html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
        
        // Italic - match *text* (non-greedy, not starting with *)
        html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
        
        // Lists - unordered
        html = html.replace(/^- (.+)$/gm, '<div style="margin:4px 0;padding-left:16px">\u2022 $1</div>');
        
        // Lists - ordered
        html = html.replace(/^(\d+)\. (.+)$/gm, '<div style="margin:4px 0;padding-left:16px">$1. $2</div>');
        
        // Line breaks - convert double newlines to paragraph, single to <br>
        html = html.replace(/\n\n/g, '</p><p style="margin:8px 0">');
        html = html.replace(/\n/g, '<br>');
        
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
        updateSendButtonState();
    }
    
    function formatTime(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
            return '';
        }
    }
    
    // ============================================
    // History Management
    // ============================================
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
    
    // ============================================
    // Hot Reload (Development)
    // ============================================
    function connectHotReload() {
        if (!HOT_RELOAD_ENABLED) return;
        
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
                setTimeout(connectHotReload, 5000);
            };
            hotReloadWs.onerror = () => {};
        } catch (e) {}
    }
    
    // ============================================
    // Heartbeat
    // ============================================
    heartbeatId = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
    
    // ============================================
    // Extension Message Handling
    // ============================================
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
    
    // ============================================
    // Initialization
    // ============================================
    loadQuickReplies();
    loadRules();
    loadHistory();
    renderQuickRepliesToolbar();
    render();
    connect();
    if (HOT_RELOAD_ENABLED) {
        connectHotReload();
    }
})();
