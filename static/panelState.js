/**
 * PanelState — the single source of truth for webview UI state.
 *
 * Design:
 *   - Every public method returns an array of Command objects.
 *   - The controller (panel.html) executes commands mechanically: send WS
 *     messages, call render functions, mutate DOM, or notify VS Code.
 *   - No DOM, no WebSocket, no side-effects. 100 % testable in Node.
 *
 * State machine per tab:
 *   idle -> waiting        (session_updated)
 *   waiting -> running     (feedback submitted)
 *   waiting -> ended       (session_ended)
 *   running -> waiting     (session_updated)
 *   running -> ended       (session_ended)
 *   ended is terminal — all incoming events for ended tabs are dropped.
 */

(function (exports) {
    'use strict';

    // ── Command constructors ────────────────────────────────

    function wsSend(message) {
        return { type: 'ws_send', message };
    }

    function render(/* ...targets */) {
        return { type: 'render', targets: Array.from(arguments) };
    }

    function dom(action, value) {
        return { type: 'dom', action, value };
    }

    function notify(message) {
        return { type: 'notify', message };
    }

    // ── TabState ────────────────────────────────────────────

    const VALID_STATES = ['idle', 'waiting', 'running', 'ended'];

    class TabState {
        constructor(id, label, model, state) {
            this.conversationId = id;
            this.label = label || 'Agent';
            this.model = model || '';
            this.state = VALID_STATES.includes(state) ? state : 'idle';
            this.messages = [];
            this.pendingQueue = [];
            this.pendingImages = [];
            this.sessionQueue = [];
            this.autoReply = false;
            this.autoReplyText = 'Continue';
            this.inputDraft = '';
            this.stagedImages = [];
        }

        get isTerminal() {
            return this.state === 'ended';
        }

        get isWaiting() {
            return this.state === 'waiting' && this.sessionQueue.length > 0;
        }

        get pendingSessionId() {
            return this.sessionQueue.length > 0 ? this.sessionQueue[0].sessionId : null;
        }

        get isRunning() {
            return this.state === 'running';
        }

        get isIdle() {
            return this.state === 'idle';
        }

        transitionTo(newState) {
            if (this.isTerminal) return false;
            if (!VALID_STATES.includes(newState)) return false;
            this.state = newState;
            return true;
        }

        addMessage(role, content, extra) {
            const msg = {
                role,
                content: content || '',
                timestamp: new Date().toISOString(),
            };
            if (extra) Object.assign(msg, extra);
            this.messages.push(msg);
            return msg;
        }

        clearPendingQueue() {
            this.pendingQueue = [];
            this.pendingImages = [];
        }
    }

    // ── PanelState ──────────────────────────────────────────

    class PanelState {
        constructor() {
            this.tabs = new Map();
            this.activeTabId = null;
        }

        // ── Tab management ──────────────────────────────────

        getOrCreateTab(id, label, model, state) {
            if (this.tabs.has(id)) {
                const existing = this.tabs.get(id);
                if (label) existing.label = label;
                if (model) existing.model = model;
                if (state && !existing.isTerminal) existing.state = state;
                return existing;
            }
            const tab = new TabState(id, label, model, state);
            this.tabs.set(id, tab);
            return tab;
        }

        _activeTab() {
            return this.activeTabId ? this.tabs.get(this.activeTabId) : null;
        }

        switchTab(id, currentInputValue) {
            if (!this.tabs.has(id)) return [];
            const cmds = [];

            if (this.activeTabId && this.activeTabId !== id) {
                const prev = this.tabs.get(this.activeTabId);
                if (prev) {
                    prev.inputDraft = currentInputValue || '';
                }
            }

            this.activeTabId = id;
            const tab = this.tabs.get(id);

            cmds.push(render('tabs', 'messages', 'pending', 'input', 'images'));
            cmds.push(dom('set_input', tab.inputDraft || ''));
            cmds.push(dom('set_staged_images', tab.stagedImages || []));
            cmds.push(dom('sync_settings'));
            cmds.push(dom('save_state'));
            return cmds;
        }

        closeTab(id) {
            const cmds = [];
            this.tabs.delete(id);

            if (this.activeTabId === id) {
                const keys = Array.from(this.tabs.keys());
                this.activeTabId = keys.length > 0 ? keys[keys.length - 1] : null;
                const newTab = this._activeTab();
                if (newTab) {
                    cmds.push(dom('set_input', newTab.inputDraft || ''));
                    cmds.push(render('images'));
                }
            }

            cmds.push(wsSend({ type: 'close_tab', conversation_id: id }));
            cmds.push(render('tabs', 'messages', 'pending', 'input'));
            cmds.push(dom('save_state'));
            return cmds;
        }

        // ── Message handling (WS -> State -> Commands) ──────

        handleMessage(msg) {
            if (!msg || typeof msg !== 'object' || !msg.type) return [];
            switch (msg.type) {
                case 'connection_established':
                    return [];

                case 'session_registered':
                    return this._onSessionRegistered(msg);

                case 'session_ended':
                    return this._onSessionEnded(msg);

                case 'session_updated':
                    return this._onSessionUpdated(msg);

                case 'feedback_submitted':
                    return this._onFeedbackSubmitted(msg);

                case 'pending_delivered':
                    return this._onPendingDelivered(msg);

                case 'pending-consumed':
                    return this._onPendingConsumed(msg);

                case 'pending_synced':
                    return this._onPendingSynced(msg);

                case 'conversations_list':
                    return this._onConversationsList(msg);

                case 'conversation_loaded':
                    return this._onConversationLoaded(msg);

                case 'tab_closed':
                    return this._onTabClosed(msg);

                case 'pong':
                case 'status_update':
                    return [];

                default:
                    return [];
            }
        }

        _onSessionRegistered(msg) {
            const s = msg.session || {};
            const conv = msg.conversation || {};
            const id = s.conversation_id || conv.conversation_id;
            if (!id) return [];

            const tab = this.getOrCreateTab(id, conv.label, conv.model || s.model, conv.state || 'idle');
            if (conv.messages) tab.messages = conv.messages;

            const cmds = [render('tabs')];
            if (!this.activeTabId) {
                this.activeTabId = id;
                cmds.push(render('messages', 'pending', 'input'));
            }
            return cmds;
        }

        _onSessionEnded(msg) {
            const tab = this.tabs.get(msg.conversation_id);
            if (!tab) return [];

            tab.transitionTo('ended');
            tab.clearPendingQueue();
            tab.sessionQueue = [];
            tab.addMessage('system', '\u2500\u2500 Session ended \u2500\u2500');

            const cmds = [render('tabs'), dom('save_state')];
            if (msg.conversation_id === this.activeTabId) {
                cmds.push(render('messages', 'pending', 'input'));
            }
            return cmds;
        }

        _onSessionUpdated(msg) {
            const info = msg.session_info;
            if (!info || !info.conversation_id) return [];

            const id = info.conversation_id;
            const existing = this.tabs.get(id);
            if (existing && existing.isTerminal) return [];

            const tab = this.getOrCreateTab(id, info.label || null, null, 'waiting');
            tab.state = 'waiting';
            const alreadyQueued = tab.sessionQueue.some(function (s) { return s.sessionId === info.session_id; });
            if (!alreadyQueued) {
                tab.sessionQueue.push({ sessionId: info.session_id, summary: info.summary || '' });
            }
            tab.addMessage('ai', info.summary || '');

            this.activeTabId = id;
            const cmds = [
                render('tabs', 'messages', 'pending', 'input'),
                notify({ type: 'new-session' }),
            ];

            // Auto-submit queued pending
            if (tab.pendingQueue.length > 0 || tab.pendingImages.length > 0) {
                const combined = tab.pendingQueue.join('\n\n');
                const images = tab.pendingImages.length > 0 ? [...tab.pendingImages] : [];
                tab.clearPendingQueue();

                cmds.push(render('pending'));
                cmds.push(wsSend({
                    type: 'queue-pending',
                    conversation_id: id,
                    comments: [],
                    images: [],
                }));

                return {
                    commands: cmds,
                    autoSubmit: {
                        text: combined || '(image)',
                        images,
                    },
                };
            }

            // Auto-reply if enabled
            if (tab.autoReply && tab.autoReplyText) {
                return {
                    commands: cmds,
                    autoReply: {
                        text: tab.autoReplyText,
                        sessionId: info.session_id,
                        delay: 500,
                    },
                };
            }

            return cmds;
        }

        _onFeedbackSubmitted(msg) {
            const tab = this.tabs.get(msg.conversation_id);
            if (!tab) return [];

            const last = tab.messages[tab.messages.length - 1];
            const alreadyHas = last && last.role === 'user' && last.content === msg.feedback;
            if (msg.feedback && !alreadyHas) {
                tab.addMessage('user', msg.feedback);
            }
            if (msg.session_id) {
                tab.sessionQueue = tab.sessionQueue.filter(function (s) { return s.sessionId !== msg.session_id; });
            } else {
                tab.sessionQueue.shift();
            }
            if (tab.sessionQueue.length === 0) {
                tab.transitionTo('running');
            }

            const cmds = [render('tabs'), dom('save_state')];
            if (msg.conversation_id === this.activeTabId) {
                cmds.push(render('messages', 'input'));
            }
            return cmds;
        }

        _onPendingDelivered(msg) {
            const tab = this.tabs.get(msg.conversation_id);
            if (!tab) return [];

            const comments = msg.comments || [];
            const images = msg.images || [];

            for (let i = 0; i < comments.length; i++) {
                const extra = { pending_delivered: true };
                if (i === comments.length - 1 && images.length > 0) {
                    extra.images = images;
                }
                tab.addMessage('user', comments[i], extra);
            }
            if (comments.length === 0 && images.length > 0) {
                tab.addMessage('user', '', { pending_delivered: true, images });
            }

            tab.clearPendingQueue();

            const cmds = [dom('save_state')];
            if (msg.conversation_id === this.activeTabId) {
                cmds.push(render('messages', 'pending'));
            }
            return cmds;
        }

        _onPendingConsumed(msg) {
            const tab = this.tabs.get(msg.conversation_id);
            if (!tab || tab.pendingQueue.length === 0) return [];

            tab.addMessage('system', '\u26A1 Pending delivered');
            tab.clearPendingQueue();

            const cmds = [dom('save_state')];
            if (msg.conversation_id === this.activeTabId) {
                cmds.push(render('messages', 'pending'));
            }
            return cmds;
        }

        _onPendingSynced(msg) {
            const tab = this.tabs.get(msg.conversation_id);
            if (!tab) return [];

            tab.pendingQueue = msg.comments || [];
            if (msg.images !== undefined) tab.pendingImages = msg.images;

            const cmds = [dom('save_state')];
            if (msg.conversation_id === this.activeTabId) {
                cmds.push(render('pending'));
            }
            return cmds;
        }

        _onConversationsList(msg) {
            for (const c of msg.conversations || []) {
                const tab = this.getOrCreateTab(c.conversation_id, c.label, c.model, c.state);
                var sessions = c.pending_sessions || (c.active_session_id ? [c.active_session_id] : []);
                for (var si = 0; si < sessions.length; si++) {
                    var sid = sessions[si];
                    if (!tab.sessionQueue.some(function (s) { return s.sessionId === sid; })) {
                        tab.sessionQueue.push({ sessionId: sid, summary: '' });
                    }
                }
            }

            const cmds = [render('tabs')];
            if (!this.activeTabId && this.tabs.size > 0) {
                this.activeTabId = Array.from(this.tabs.keys())[this.tabs.size - 1];
            }
            if (this.activeTabId) {
                cmds.push(wsSend({
                    type: 'load_conversation',
                    conversation_id: this.activeTabId,
                }));
            }
            return cmds;
        }

        _onConversationLoaded(msg) {
            const conv = msg.conversation;
            if (!conv) return [];

            const tab = this.getOrCreateTab(conv.conversation_id, conv.label, conv.model, conv.state);
            tab.messages = conv.messages || [];
            tab.pendingQueue = conv.pending_queue || [];

            const cmds = [dom('save_state')];
            if (conv.conversation_id === this.activeTabId) {
                cmds.push(render('messages', 'pending'));
            }
            return cmds;
        }

        _onTabClosed(msg) {
            const cid = msg.conversation_id;
            if (!cid || !this.tabs.has(cid)) return [];

            const cmds = [];
            this.tabs.delete(cid);
            if (this.activeTabId === cid) {
                const keys = Array.from(this.tabs.keys());
                this.activeTabId = keys.length > 0 ? keys[keys.length - 1] : null;
                const newTab = this._activeTab();
                if (newTab) {
                    cmds.push(dom('set_input', newTab.inputDraft || ''));
                    cmds.push(render('images'));
                }
            }
            cmds.push(render('tabs', 'messages', 'pending', 'input'));
            cmds.push(dom('save_state'));
            return cmds;
        }

        // ── User actions ────────────────────────────────────

        smartSend(text, images) {
            const tab = this._activeTab();
            if (!tab) return [];
            if (tab.isWaiting) return this.submitFeedback(text, images);
            return this.addToPending(text, images);
        }

        submitFeedback(text, images) {
            const tab = this._activeTab();
            if (!tab || tab.sessionQueue.length === 0) return [];

            const entry = tab.sessionQueue.shift();
            const msgImages = images && images.length > 0 ? images : undefined;
            tab.addMessage('user', text, { images: msgImages });
            tab.stagedImages = [];

            if (tab.sessionQueue.length === 0) {
                tab.transitionTo('running');
            }

            return [
                wsSend({
                    type: 'feedback_response',
                    session_id: entry.sessionId,
                    conversation_id: tab.conversationId,
                    feedback: text,
                    images: images || [],
                }),
                render('tabs', 'messages', 'input'),
                dom('clear_input'),
                dom('clear_staged_images'),
                dom('save_state'),
                notify({ type: 'feedback-submitted' }),
            ];
        }

        addToPending(text, images) {
            const hasText = text && text.trim();
            const hasImages = images && images.length > 0;
            if (!hasText && !hasImages) return [];

            const tab = this._activeTab();
            if (!tab || tab.isTerminal) return [];

            if (hasText) tab.pendingQueue.push(text.trim());
            if (hasImages) tab.pendingImages = [...(tab.pendingImages || []), ...images];
            tab.stagedImages = [];

            return [
                wsSend({
                    type: 'queue-pending',
                    conversation_id: tab.conversationId,
                    comments: tab.pendingQueue,
                    images: tab.pendingImages || [],
                }),
                render('pending'),
                dom('clear_input'),
                dom('clear_staged_images'),
                dom('save_state'),
            ];
        }

        editPending(idx) {
            const tab = this._activeTab();
            if (!tab || idx < 0 || idx >= tab.pendingQueue.length) return [];

            const text = tab.pendingQueue[idx];
            tab.pendingQueue.splice(idx, 1);

            return [
                wsSend({
                    type: 'queue-pending',
                    conversation_id: tab.conversationId,
                    comments: tab.pendingQueue,
                    images: tab.pendingImages || [],
                }),
                render('pending'),
                dom('set_input', text),
                dom('focus_input'),
                dom('save_state'),
            ];
        }

        removePending(idx) {
            const tab = this._activeTab();
            if (!tab || idx < 0 || idx >= tab.pendingQueue.length) return [];

            tab.pendingQueue.splice(idx, 1);

            return [
                wsSend({
                    type: 'queue-pending',
                    conversation_id: tab.conversationId,
                    comments: tab.pendingQueue,
                    images: tab.pendingImages || [],
                }),
                render('pending'),
                dom('save_state'),
            ];
        }

        clearPending() {
            const tab = this._activeTab();
            if (!tab) return [];

            tab.clearPendingQueue();

            return [
                wsSend({
                    type: 'queue-pending',
                    conversation_id: tab.conversationId,
                    comments: [],
                    images: [],
                }),
                render('pending'),
                dom('save_state'),
            ];
        }

        clearPendingImages() {
            const tab = this._activeTab();
            if (!tab || tab.pendingImages.length === 0) return [];

            tab.pendingImages = [];

            return [
                wsSend({
                    type: 'queue-pending',
                    conversation_id: tab.conversationId,
                    comments: tab.pendingQueue,
                    images: [],
                }),
                render('pending'),
                dom('save_state'),
            ];
        }

        // ── Staged images (per-tab, in the input area) ─────

        stageImage(base64) {
            const tab = this._activeTab();
            if (!tab) return [];
            tab.stagedImages.push(base64);
            return [render('staged_images'), dom('update_send_button')];
        }

        unstageImage(idx) {
            const tab = this._activeTab();
            if (!tab || idx < 0 || idx >= tab.stagedImages.length) return [];
            tab.stagedImages.splice(idx, 1);
            return [render('staged_images'), dom('update_send_button')];
        }

        clearStagedImages() {
            const tab = this._activeTab();
            if (!tab) return [];
            tab.stagedImages = [];
            return [render('staged_images')];
        }

        getStagedImages() {
            const tab = this._activeTab();
            return tab ? tab.stagedImages : [];
        }

        // ── Auto-reply ──────────────────────────────────────

        setAutoReply(enabled, text) {
            const tab = this._activeTab();
            if (!tab) return [];
            tab.autoReply = !!enabled;
            if (text !== undefined) tab.autoReplyText = text;
            return [dom('save_state')];
        }

        // ── UI state queries ────────────────────────────────

        getUIState() {
            const tab = this._activeTab();
            const state = tab ? tab.state : 'idle';
            const queueLen = tab ? tab.sessionQueue.length : 0;
            return {
                inputVisible: state === 'waiting' || state === 'running',
                buttonMode: state === 'waiting' ? 'send' : 'queue',
                isEnded: state === 'ended',
                isIdle: state === 'idle' || !tab,
                tabCount: this.tabs.size,
                feedbackQueueSize: queueLen,
            };
        }

        // ── Serialization ───────────────────────────────────

        serialize() {
            return {
                activeTabId: this.activeTabId,
                tabs: Array.from(this.tabs.entries()).map(function (entry) {
                    var id = entry[0], t = entry[1];
                    return {
                        id: id,
                        label: t.label,
                        model: t.model,
                        state: t.state,
                        messages: t.messages.slice(-100),
                        pendingQueue: t.pendingQueue,
                        pendingImages: t.pendingImages,
                        sessionQueue: t.sessionQueue,
                        autoReply: t.autoReply,
                        autoReplyText: t.autoReplyText,
                        inputDraft: t.inputDraft || '',
                        stagedImages: t.stagedImages || [],
                    };
                }),
            };
        }

        deserialize(data) {
            if (!data) return;
            for (const t of data.tabs || []) {
                const tab = new TabState(t.id, t.label, t.model, t.state);
                tab.messages = t.messages || [];
                tab.pendingQueue = t.pendingQueue || [];
                tab.pendingImages = t.pendingImages || [];
                tab.sessionQueue = t.sessionQueue || [];
                tab.autoReply = t.autoReply || false;
                tab.autoReplyText = t.autoReplyText || 'Continue';
                tab.inputDraft = t.inputDraft || '';
                tab.stagedImages = t.stagedImages || [];
                this.tabs.set(t.id, tab);
            }
            if (data.activeTabId && this.tabs.has(data.activeTabId)) {
                this.activeTabId = data.activeTabId;
            }
        }

        // ── Static utilities ────────────────────────────────

        static md(text) {
            if (!text) return '';
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
                .replace(/`([^`]+)`/g, '<code>$1</code>')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g, '<em>$1</em>')
                .replace(/^### (.+)$/gm, '<h4>$1</h4>')
                .replace(/^## (.+)$/gm, '<h3>$1</h3>')
                .replace(/^# (.+)$/gm, '<h2>$1</h2>')
                .replace(/^- (.+)$/gm, '\u2022 $1<br>')
                .replace(/\n/g, '<br>');
        }

        static getAtQuery(text, cursorPos) {
            var before = text.slice(0, cursorPos);
            var match = before.match(/@([^\s@]*)$/);
            return match ? { query: match[1], start: match.index, end: cursorPos } : null;
        }
    }

    // ── Command helpers (exported for tests) ────────────────

    PanelState.cmd = { wsSend, render, dom, notify };

    exports.PanelState = PanelState;
    exports.TabState = TabState;
})(
    typeof module !== 'undefined' ? module.exports : (window.PanelStateModule = window.PanelStateModule || {})
);
