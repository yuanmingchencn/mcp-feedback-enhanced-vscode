/**
 * PanelState — the single source of truth for webview UI state.
 *
 * Design:
 *   - Every public method returns an array of Command objects.
 *   - The controller (panel.html) executes commands mechanically: send WS
 *     messages, call render functions, mutate DOM, or notify VS Code.
 *   - No DOM, no WebSocket, no side-effects. 100 % testable in Node.
 *
 * Flat model: one message timeline, one pending queue, one session queue (FIFO).
 *
 * State machine (panel level):
 *   idle -> waiting        (session_updated)
 *   waiting -> running     (feedback submitted, queue empty)
 *   waiting -> waiting     (feedback submitted, queue still has items)
 *   running -> waiting     (session_updated)
 *   running -> idle        (no more sessions)
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

    // ── PanelState ──────────────────────────────────────────

    class PanelState {
        constructor() {
            this.messages = [];
            this.sessionQueue = [];
            this.pendingQueue = [];
            this.pendingImages = [];
            this.autoReply = false;
            this.autoReplyText = 'Continue';
            this.inputDraft = '';
            this.stagedImages = [];
        }

        get panelMode() {
            if (this.sessionQueue.length > 0) return 'waiting';
            if (this.messages.length > 0) {
                var last = this.messages[this.messages.length - 1];
                if (last.role === 'user' && !last.pending_delivered) return 'running';
            }
            return 'idle';
        }

        get pendingSessionId() {
            return this.sessionQueue.length > 0 ? this.sessionQueue[0].sessionId : null;
        }

        // ── Message handling (WS -> State -> Commands) ──────

        handleMessage(msg) {
            if (!msg || typeof msg !== 'object' || !msg.type) return [];
            switch (msg.type) {
                case 'connection_established':
                    return [wsSend({ type: 'get_state' })];

                case 'state_sync':
                    return this._onStateSync(msg);

                case 'session_updated':
                    return this._onSessionUpdated(msg);

                case 'feedback_submitted':
                    return this._onFeedbackSubmitted(msg);

                case 'pending_delivered':
                    return this._onPendingDelivered(msg);

                case 'pending_synced':
                    return this._onPendingSynced(msg);

                case 'pong':
                case 'status_update':
                    return [];

                default:
                    return [];
            }
        }

        _onStateSync(msg) {
            this.messages = msg.messages || [];
            this.pendingQueue = msg.pending_comments || [];
            this.pendingImages = msg.pending_images || [];

            var pendingSessions = msg.pending_sessions || [];
            for (var i = 0; i < pendingSessions.length; i++) {
                var sid = pendingSessions[i];
                if (!this.sessionQueue.some(function (s) { return s.sessionId === sid; })) {
                    this.sessionQueue.push({ sessionId: sid, summary: '' });
                }
            }

            return [
                render('messages', 'pending', 'input'),
                dom('save_state'),
            ];
        }

        _onSessionUpdated(msg) {
            var info = msg.session_info;
            if (!info || !info.session_id) return [];

            var alreadyQueued = this.sessionQueue.some(function (s) { return s.sessionId === info.session_id; });
            if (!alreadyQueued) {
                this.sessionQueue.push({ sessionId: info.session_id, summary: info.summary || '' });
            }

            var cmds = [
                render('messages', 'pending', 'input'),
                notify({ type: 'new-session' }),
            ];

            if (this.pendingQueue.length > 0 || this.pendingImages.length > 0) {
                var combined = this.pendingQueue.join('\n\n');
                var images = this.pendingImages.length > 0 ? [].concat(this.pendingImages) : [];
                this.pendingQueue = [];
                this.pendingImages = [];

                cmds.push(render('pending'));
                cmds.push(wsSend({
                    type: 'queue-pending',
                    comments: [],
                    images: [],
                }));

                return {
                    commands: cmds,
                    autoSubmit: {
                        text: combined || '(image)',
                        images: images,
                    },
                };
            }

            if (this.autoReply && this.autoReplyText) {
                return {
                    commands: cmds,
                    autoReply: {
                        text: this.autoReplyText,
                        sessionId: info.session_id,
                        delay: 500,
                    },
                };
            }

            return cmds;
        }

        _onFeedbackSubmitted(msg) {
            if (msg.feedback) {
                var last = this.messages[this.messages.length - 1];
                var alreadyHas = last && last.role === 'user' && last.content === msg.feedback;
                if (!alreadyHas) {
                    this.messages.push({
                        role: 'user',
                        content: msg.feedback,
                        timestamp: new Date().toISOString(),
                    });
                }
            }

            if (msg.session_id) {
                this.sessionQueue = this.sessionQueue.filter(function (s) { return s.sessionId !== msg.session_id; });
            } else {
                this.sessionQueue.shift();
            }

            return [
                render('messages', 'input'),
                dom('save_state'),
            ];
        }

        _onPendingDelivered(msg) {
            var comments = msg.comments || [];
            var images = msg.images || [];

            for (var i = 0; i < comments.length; i++) {
                var extra = { pending_delivered: true };
                if (i === comments.length - 1 && images.length > 0) {
                    extra.images = images;
                }
                this.messages.push({
                    role: 'user',
                    content: comments[i],
                    timestamp: new Date().toISOString(),
                    pending_delivered: true,
                    images: (i === comments.length - 1 && images.length > 0) ? images : undefined,
                });
            }
            if (comments.length === 0 && images.length > 0) {
                this.messages.push({
                    role: 'user',
                    content: '',
                    timestamp: new Date().toISOString(),
                    pending_delivered: true,
                    images: images,
                });
            }

            this.pendingQueue = [];
            this.pendingImages = [];

            return [
                render('messages', 'pending'),
                dom('save_state'),
            ];
        }

        _onPendingSynced(msg) {
            this.pendingQueue = msg.comments || [];
            if (msg.images !== undefined) this.pendingImages = msg.images;

            return [
                render('pending'),
                dom('save_state'),
            ];
        }

        // ── User actions ────────────────────────────────────

        smartSend(text, images) {
            if (this.panelMode === 'waiting') return this.submitFeedback(text, images);
            return this.addToPending(text, images);
        }

        submitFeedback(text, images) {
            if (this.sessionQueue.length === 0) return [];

            var entry = this.sessionQueue.shift();
            var msgImages = images && images.length > 0 ? images : undefined;
            this.messages.push({
                role: 'user',
                content: text || '',
                timestamp: new Date().toISOString(),
                images: msgImages,
            });
            this.stagedImages = [];

            return [
                wsSend({
                    type: 'feedback_response',
                    session_id: entry.sessionId,
                    feedback: text || '',
                    images: images || [],
                }),
                render('messages', 'input'),
                dom('clear_input'),
                dom('clear_staged_images'),
                dom('save_state'),
                notify({ type: 'feedback-submitted' }),
            ];
        }

        addToPending(text, images) {
            var hasText = text && text.trim();
            var hasImages = images && images.length > 0;
            if (!hasText && !hasImages) return [];

            if (hasText) this.pendingQueue.push(text.trim());
            if (hasImages) this.pendingImages = [].concat(this.pendingImages || [], images);
            this.stagedImages = [];

            return [
                wsSend({
                    type: 'queue-pending',
                    comments: this.pendingQueue,
                    images: this.pendingImages || [],
                }),
                render('pending'),
                dom('clear_input'),
                dom('clear_staged_images'),
                dom('save_state'),
            ];
        }

        editPending(idx) {
            if (idx < 0 || idx >= this.pendingQueue.length) return [];

            var text = this.pendingQueue[idx];
            this.pendingQueue.splice(idx, 1);

            return [
                wsSend({
                    type: 'queue-pending',
                    comments: this.pendingQueue,
                    images: this.pendingImages || [],
                }),
                render('pending'),
                dom('set_input', text),
                dom('focus_input'),
                dom('save_state'),
            ];
        }

        removePending(idx) {
            if (idx < 0 || idx >= this.pendingQueue.length) return [];

            this.pendingQueue.splice(idx, 1);

            return [
                wsSend({
                    type: 'queue-pending',
                    comments: this.pendingQueue,
                    images: this.pendingImages || [],
                }),
                render('pending'),
                dom('save_state'),
            ];
        }

        clearPending() {
            this.pendingQueue = [];
            this.pendingImages = [];

            return [
                wsSend({
                    type: 'queue-pending',
                    comments: [],
                    images: [],
                }),
                render('pending'),
                dom('save_state'),
            ];
        }

        clearPendingImages() {
            if (this.pendingImages.length === 0) return [];

            this.pendingImages = [];

            return [
                wsSend({
                    type: 'queue-pending',
                    comments: this.pendingQueue,
                    images: [],
                }),
                render('pending'),
                dom('save_state'),
            ];
        }

        // ── Staged images (in the input area) ───────────────

        stageImage(base64) {
            this.stagedImages.push(base64);
            return [render('staged_images'), dom('update_send_button')];
        }

        unstageImage(idx) {
            if (idx < 0 || idx >= this.stagedImages.length) return [];
            this.stagedImages.splice(idx, 1);
            return [render('staged_images'), dom('update_send_button')];
        }

        clearStagedImages() {
            this.stagedImages = [];
            return [render('staged_images')];
        }

        getStagedImages() {
            return this.stagedImages;
        }

        // ── Auto-reply ──────────────────────────────────────

        setAutoReply(enabled, text) {
            this.autoReply = !!enabled;
            if (text !== undefined) this.autoReplyText = text;
            return [dom('save_state')];
        }

        // ── UI state queries ────────────────────────────────

        getUIState() {
            var mode = this.panelMode;
            return {
                inputVisible: true,
                buttonMode: mode === 'waiting' ? 'send' : 'queue',
                isIdle: mode === 'idle',
                isWaiting: mode === 'waiting',
                isRunning: mode === 'running',
                feedbackQueueSize: this.sessionQueue.length,
            };
        }

        // ── Serialization ───────────────────────────────────

        serialize() {
            return {
                messages: this.messages.slice(-500),
                sessionQueue: this.sessionQueue,
                pendingQueue: this.pendingQueue,
                pendingImages: this.pendingImages,
                autoReply: this.autoReply,
                autoReplyText: this.autoReplyText,
                inputDraft: this.inputDraft || '',
                stagedImages: this.stagedImages || [],
            };
        }

        deserialize(data) {
            if (!data) return;
            this.messages = data.messages || [];
            this.sessionQueue = data.sessionQueue || [];
            this.pendingQueue = data.pendingQueue || [];
            this.pendingImages = data.pendingImages || [];
            this.autoReply = data.autoReply || false;
            this.autoReplyText = data.autoReplyText || 'Continue';
            this.inputDraft = data.inputDraft || '';
            this.stagedImages = data.stagedImages || [];
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
})(
    typeof module !== 'undefined' ? module.exports : (window.PanelStateModule = window.PanelStateModule || {})
);
