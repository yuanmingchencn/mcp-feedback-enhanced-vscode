/**
 * Watches the sessions/ directory for hook-created session registrations
 * and session deletions (end of conversation).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionRegistration } from '../types';
import { readSession, listSessions, getSessionsDir } from '../fileStore';

export class SessionWatcher {
    private serverPid: number;
    private watcher: fs.FSWatcher | null = null;
    private onRegistered?: (session: SessionRegistration) => void;
    private onEnded?: (conversationId: string) => void;

    constructor(serverPid: number) {
        this.serverPid = serverPid;
    }

    onSessionRegistered(cb: (session: SessionRegistration) => void): void {
        this.onRegistered = cb;
    }

    onSessionEnded(cb: (conversationId: string) => void): void {
        this.onEnded = cb;
    }

    start(): void {
        const dir = getSessionsDir();
        try {
            this.watcher = fs.watch(dir, (_eventType, filename) => {
                if (!filename?.endsWith('.json')) return;
                const conversationId = filename.replace('.json', '');
                const filePath = path.join(dir, filename);

                const handleResult = (session: SessionRegistration | null) => {
                    if (session) {
                        if (this.onRegistered) this.onRegistered(session);
                    } else if (!fs.existsSync(filePath)) {
                        if (this.onEnded) this.onEnded(conversationId);
                    }
                };

                let session = readSession(conversationId);
                if (!session && fs.existsSync(filePath)) {
                    setTimeout(() => {
                        session = readSession(conversationId);
                        handleResult(session ?? null);
                    }, 100);
                } else {
                    handleResult(session);
                }
            });
        } catch (e) {
            console.error('[MCP Feedback] Failed to watch sessions dir:', e);
        }
    }

    scanExisting(): SessionRegistration[] {
        return listSessions().filter(s => s.server_pid === this.serverPid);
    }

    stop(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }
}
