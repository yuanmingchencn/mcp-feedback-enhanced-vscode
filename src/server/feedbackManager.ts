/**
 * Manages the lifecycle of feedback requests.
 * Each request is a Promise that resolves when the user responds.
 * Keyed by session_id only — no conversation_id.
 */

import { WebSocket } from 'ws';

export interface FeedbackResult {
    feedback: string;
    images?: string[];
}

interface PendingFeedback {
    sessionId: string;
    mcpClient: WebSocket;
    resolve: (result: FeedbackResult) => void;
    reject: (error: Error) => void;
    timestamp: number;
}

export class FeedbackManager {
    private pending = new Map<string, PendingFeedback>();

    createRequest(
        sessionId: string,
        mcpClient: WebSocket
    ): Promise<FeedbackResult> {
        return new Promise<FeedbackResult>((resolve, reject) => {
            this.pending.set(sessionId, {
                sessionId,
                mcpClient,
                resolve,
                reject,
                timestamp: Date.now(),
            });
        });
    }

    resolve(sessionId: string, result: FeedbackResult): boolean {
        const req = this.pending.get(sessionId);
        if (!req) return false;
        req.resolve(result);
        this.pending.delete(sessionId);
        return true;
    }

    rejectByClient(ws: WebSocket): void {
        for (const [sid, req] of this.pending) {
            if (req.mcpClient === ws) {
                req.reject(new Error('MCP client disconnected'));
                this.pending.delete(sid);
            }
        }
    }

    hasPending(): boolean {
        return this.pending.size > 0;
    }

    pendingSessionIds(): string[] {
        return Array.from(this.pending.keys());
    }

    rejectAll(error: Error): void {
        for (const [, req] of this.pending) {
            req.reject(error);
        }
        this.pending.clear();
    }
}
