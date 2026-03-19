/**
 * Manages the lifecycle of feedback requests.
 * Each request is a Promise that resolves when the user responds.
 */

import { WebSocket } from 'ws';

export interface FeedbackResult {
    feedback: string;
    images?: string[];
}

interface PendingFeedback {
    sessionId: string;
    conversationId: string;
    mcpClient: WebSocket;
    resolve: (result: FeedbackResult) => void;
    reject: (error: Error) => void;
    timestamp: number;
}

export class FeedbackManager {
    private pending = new Map<string, PendingFeedback>();

    createRequest(
        sessionId: string,
        conversationId: string,
        mcpClient: WebSocket
    ): Promise<FeedbackResult> {
        return new Promise<FeedbackResult>((resolve, reject) => {
            this.pending.set(sessionId, {
                sessionId,
                conversationId,
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

    resolveByConversation(conversationId: string, result: FeedbackResult): void {
        for (const [sid, req] of this.pending) {
            if (req.conversationId === conversationId) {
                req.resolve(result);
                this.pending.delete(sid);
            }
        }
    }

    getConversationId(sessionId: string): string | undefined {
        return this.pending.get(sessionId)?.conversationId;
    }

    getMcpClient(sessionId: string): WebSocket | undefined {
        return this.pending.get(sessionId)?.mcpClient;
    }

    hasPending(): boolean {
        return this.pending.size > 0;
    }

    rejectAll(error: Error): void {
        for (const [, req] of this.pending) {
            req.reject(error);
        }
        this.pending.clear();
    }

    clear(): void {
        this.pending.clear();
    }
}
