(function (exports) {
    'use strict';

    class TabState {
        constructor(id, label, model, state) {
            this.conversationId = id;
            this.label = label || 'Agent';
            this.model = model || '';
            this.state = state || 'idle';
            this.messages = [];
            this.pendingQueue = [];
            this.pendingSessionId = null;
            this.autoReply = false;
            this.autoReplyText = 'Continue';
            this.inputDraft = '';
            this.pendingImages = [];
        }
    }

    class PanelState {
        constructor() {
            this.tabs = new Map();
            this.activeTabId = null;
        }

        getOrCreateTab(id, label, model, state) {
            if (this.tabs.has(id)) {
                const existing = this.tabs.get(id);
                if (label) existing.label = label;
                if (model) existing.model = model;
                if (state) existing.state = state;
                return existing;
            }
            const tab = new TabState(id, label, model, state);
            this.tabs.set(id, tab);
            return tab;
        }

        switchTab(id, currentInputValue) {
            if (!this.tabs.has(id)) return null;
            const effects = [];
            if (this.activeTabId) {
                const prev = this.tabs.get(this.activeTabId);
                if (prev) prev.inputDraft = currentInputValue || '';
            }
            this.activeTabId = id;
            const tab = this.tabs.get(id);
            effects.push('render_tabs', 'render_messages', 'render_pending', 'update_send_button', 'save_state');
            return { tab, inputDraft: tab.inputDraft || '', effects };
        }

        closeTab(id) {
            this.tabs.delete(id);
            if (this.activeTabId === id) {
                const keys = Array.from(this.tabs.keys());
                this.activeTabId = keys.length > 0 ? keys[keys.length - 1] : null;
            }
            return {
                newActiveTabId: this.activeTabId,
                effects: ['render_tabs', 'render_messages', 'render_pending', 'update_send_button', 'save_state'],
                wsMessages: [{ type: 'close_tab', conversation_id: id }],
            };
        }

        handleMessage(msg) {
            const effects = [];
            const wsMessages = [];

            switch (msg.type) {
                case 'connection_established':
                    break;

                case 'session_registered': {
                    const s = msg.session || {};
                    const conv = msg.conversation || {};
                    const id = s.conversation_id || conv.conversation_id;
                    if (!id) break;
                    this.getOrCreateTab(id, conv.label, conv.model || s.model, conv.state || 'idle');
                    if (conv.messages) {
                        const tab = this.tabs.get(id);
                        if (tab) tab.messages = conv.messages;
                    }
                    if (!this.activeTabId) {
                        this.activeTabId = id;
                        effects.push('switch_tab');
                    }
                    effects.push('render_tabs');
                    break;
                }

                case 'session_ended': {
                    const tab = this.tabs.get(msg.conversation_id);
                    if (tab) {
                        tab.state = 'ended';
                        tab.messages.push({
                            role: 'system',
                            content: '── Session ended ──',
                            timestamp: new Date().toISOString(),
                        });
                        effects.push('render_tabs');
                        if (msg.conversation_id === this.activeTabId) {
                            effects.push('render_messages', 'update_send_button');
                        }
                        effects.push('save_state');
                    }
                    break;
                }

                case 'session_updated': {
                    const info = msg.session_info;
                    if (!info || !info.conversation_id) break;

                    const id = info.conversation_id;
                    const tab = this.getOrCreateTab(id, info.label || null, null, 'waiting');
                    tab.state = 'waiting';
                    tab.pendingSessionId = info.session_id;
                    tab.messages.push({
                        role: 'ai',
                        content: info.summary || '',
                        timestamp: new Date().toISOString(),
                    });

                    this.activeTabId = id;
                    effects.push('switch_tab', 'notify_vscode');

                    if (tab.pendingQueue.length > 0 || (tab.pendingImages && tab.pendingImages.length > 0)) {
                        const combined = tab.pendingQueue.join('\n\n');
                        const hadImages = tab.pendingImages && tab.pendingImages.length > 0;
                        const images = hadImages ? [...(tab.pendingImages || [])] : [];
                        tab.pendingQueue = [];
                        tab.pendingImages = [];
                        effects.push('render_pending');
                        wsMessages.push({ type: 'queue-pending', conversation_id: id, comments: [] });
                        return {
                            effects,
                            wsMessages,
                            autoSubmit: { text: combined || '(image)', restoreImages: hadImages, images },
                        };
                    }

                    if (tab.autoReply && tab.autoReplyText) {
                        return {
                            effects,
                            wsMessages,
                            autoReply: {
                                text: tab.autoReplyText,
                                sessionId: info.session_id,
                                delay: 500,
                            },
                        };
                    }
                    break;
                }

                case 'feedback_submitted': {
                    const tab = this.tabs.get(msg.conversation_id);
                    if (tab) {
                        const last = tab.messages[tab.messages.length - 1];
                        const alreadyHas =
                            last && last.role === 'user' && last.content === msg.feedback;
                        if (msg.feedback && !alreadyHas) {
                            tab.messages.push({
                                role: 'user',
                                content: msg.feedback,
                                timestamp: new Date().toISOString(),
                            });
                        }
                        tab.pendingSessionId = null;
                        tab.state = 'running';
                        effects.push('render_tabs', 'update_send_button');
                        if (msg.conversation_id === this.activeTabId) effects.push('render_messages');
                        effects.push('save_state');
                    }
                    break;
                }

                case 'pending-consumed': {
                    const tab = this.tabs.get(msg.conversation_id);
                    if (tab && tab.pendingQueue.length > 0) {
                        tab.messages.push({
                            role: 'system',
                            content: '⚡ Pending delivered',
                            timestamp: new Date().toISOString(),
                        });
                        tab.pendingQueue = [];
                        if (msg.conversation_id === this.activeTabId) {
                            effects.push('render_messages', 'render_pending');
                        }
                        effects.push('save_state');
                    }
                    break;
                }

                case 'conversations_list': {
                    for (const c of msg.conversations || []) {
                        const tab = this.getOrCreateTab(
                            c.conversation_id,
                            c.label,
                            c.model,
                            c.state
                        );
                        if (c.active_session_id) tab.pendingSessionId = c.active_session_id;
                    }
                    if (!this.activeTabId && this.tabs.size > 0) {
                        this.activeTabId = Array.from(this.tabs.keys())[this.tabs.size - 1];
                    }
                    effects.push('render_tabs');
                    if (this.activeTabId) {
                        wsMessages.push({
                            type: 'load_conversation',
                            conversation_id: this.activeTabId,
                        });
                    }
                    break;
                }

                case 'conversation_loaded': {
                    const conv = msg.conversation;
                    if (!conv) break;
                    const tab = this.getOrCreateTab(
                        conv.conversation_id,
                        conv.label,
                        conv.model,
                        conv.state
                    );
                    tab.messages = conv.messages || [];
                    tab.pendingQueue = conv.pending_queue || [];
                    if (conv.conversation_id === this.activeTabId) {
                        effects.push('render_messages', 'render_pending');
                    }
                    effects.push('save_state');
                    break;
                }

                case 'pending_delivered': {
                    const tab = this.tabs.get(msg.conversation_id);
                    if (tab) {
                        const comments = msg.comments || [];
                        const images = msg.images || [];
                        for (let i = 0; i < comments.length; i++) {
                            const m = {
                                role: 'user',
                                content: comments[i],
                                timestamp: new Date().toISOString(),
                                pending_delivered: true,
                            };
                            if (i === comments.length - 1 && images.length > 0) m.images = images;
                            tab.messages.push(m);
                        }
                        if (comments.length === 0 && images.length > 0) {
                            tab.messages.push({
                                role: 'user',
                                content: '',
                                timestamp: new Date().toISOString(),
                                pending_delivered: true,
                                images,
                            });
                        }
                        tab.pendingQueue = [];
                        tab.pendingImages = [];
                        if (msg.conversation_id === this.activeTabId) {
                            effects.push('render_messages', 'render_pending');
                        }
                        effects.push('save_state');
                    }
                    break;
                }

                case 'tab_closed': {
                    const cid = msg.conversation_id;
                    if (cid && this.tabs.has(cid)) {
                        this.tabs.delete(cid);
                        if (this.activeTabId === cid) {
                            const keys = Array.from(this.tabs.keys());
                            this.activeTabId = keys.length > 0 ? keys[keys.length - 1] : null;
                        }
                        effects.push(
                            'render_tabs',
                            'render_messages',
                            'render_pending',
                            'update_send_button',
                            'save_state'
                        );
                    }
                    break;
                }

                case 'pending_synced': {
                    const tab = this.tabs.get(msg.conversation_id);
                    if (tab) {
                        tab.pendingQueue = msg.comments || [];
                        if (msg.images !== undefined) tab.pendingImages = msg.images;
                        if (msg.conversation_id === this.activeTabId) effects.push('render_pending');
                        effects.push('save_state');
                    }
                    break;
                }

                case 'pong':
                case 'status_update':
                    break;
            }

            return { effects, wsMessages };
        }

        addToPending(text, images) {
            const hasText = text && text.trim();
            const hasImages = images && images.length > 0;
            if (!hasText && !hasImages) return null;

            const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
            if (!tab) return null;

            if (hasText) tab.pendingQueue = [text.trim()];
            if (hasImages) tab.pendingImages = [...images];

            const wsMessages = [
                {
                    type: 'queue-pending',
                    conversation_id: tab.conversationId,
                    comments: tab.pendingQueue,
                    images: tab.pendingImages || [],
                },
            ];

            tab.messages.push({
                role: 'system',
                content:
                    '📤 Queued: ' +
                    (hasText
                        ? text.trim().slice(0, 80) + (text.trim().length > 80 ? '...' : '')
                        : '(images)'),
                timestamp: new Date().toISOString(),
            });

            return {
                effects: ['render_messages', 'render_pending', 'save_state', 'clear_input'],
                wsMessages,
            };
        }

        clearPending() {
            const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
            if (!tab) return null;
            tab.pendingQueue = [];
            tab.pendingImages = [];
            return {
                effects: ['render_pending', 'save_state'],
                wsMessages: [
                    {
                        type: 'queue-pending',
                        conversation_id: tab.conversationId,
                        comments: [],
                        images: [],
                    },
                ],
            };
        }

        editPending(idx) {
            const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
            if (!tab || idx >= tab.pendingQueue.length) return null;
            const text = tab.pendingQueue[idx];
            tab.pendingQueue.splice(idx, 1);
            return {
                text,
                effects: ['render_pending', 'save_state', 'set_input', 'focus_input'],
                wsMessages: [
                    {
                        type: 'queue-pending',
                        conversation_id: tab.conversationId,
                        comments: tab.pendingQueue,
                        images: tab.pendingImages || [],
                    },
                ],
            };
        }

        submitFeedback(text, images) {
            const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
            if (!tab || !tab.pendingSessionId) return null;

            const sessionId = tab.pendingSessionId;
            tab.messages.push({
                role: 'user',
                content: text,
                timestamp: new Date().toISOString(),
                images: images && images.length > 0 ? images : undefined,
            });
            tab.pendingSessionId = null;
            tab.state = 'running';

            const wsMessages = [
                {
                    type: 'feedback_response',
                    session_id: sessionId,
                    conversation_id: tab.conversationId,
                    feedback: text,
                    images: images || [],
                },
            ];

            return {
                effects: ['render_messages', 'save_state', 'clear_input', 'clear_images'],
                wsMessages,
            };
        }

        smartSend(text, images) {
            const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
            if (!tab) return null;
            if (tab.state === 'waiting' && tab.pendingSessionId) {
                return this.submitFeedback(text, images);
            }
            return this.addToPending(text, images);
        }

        getUIState() {
            const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
            const state = tab ? tab.state : 'idle';
            return {
                inputVisible: state === 'waiting' || state === 'running',
                buttonMode: state === 'waiting' ? 'send' : 'queue',
                isEnded: state === 'ended',
                isIdle: state === 'idle',
                tabCount: this.tabs.size,
            };
        }

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
                .replace(/^- (.+)$/gm, '• $1<br>')
                .replace(/\n/g, '<br>');
        }

        static getAtQuery(text, cursorPos) {
            const before = text.slice(0, cursorPos);
            const match = before.match(/@([^\s@]*)$/);
            return match ? { query: match[1], start: match.index, end: cursorPos } : null;
        }

        serialize() {
            return {
                activeTabId: this.activeTabId,
                tabs: Array.from(this.tabs.entries()).map(([id, t]) => ({
                    id,
                    label: t.label,
                    model: t.model,
                    state: t.state,
                    messages: t.messages.slice(-100),
                    pendingQueue: t.pendingQueue,
                    autoReply: t.autoReply,
                    autoReplyText: t.autoReplyText,
                    inputDraft: t.inputDraft || '',
                })),
            };
        }

        deserialize(data) {
            if (!data) return;
            for (const t of data.tabs || []) {
                const tab = new TabState(t.id, t.label, t.model, t.state);
                tab.messages = t.messages || [];
                tab.pendingQueue = t.pendingQueue || [];
                tab.autoReply = t.autoReply || false;
                tab.autoReplyText = t.autoReplyText || 'Continue';
                tab.inputDraft = t.inputDraft || '';
                this.tabs.set(t.id, tab);
            }
            if (data.activeTabId && this.tabs.has(data.activeTabId)) {
                this.activeTabId = data.activeTabId;
            }
        }
    }

    exports.PanelState = PanelState;
    exports.TabState = TabState;
})(
    typeof module !== 'undefined' ? module.exports : (window.PanelStateModule = window.PanelStateModule || {})
);
