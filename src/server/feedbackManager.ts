/**
 * FIFO queue of pending feedback requests.
 *
 * On MCP disconnect, sessions stay alive so the panel can respond.
 * On reconnect for the same project, transport is swapped via updateTransport().
 * resolve returns the *current* transport (not the one captured at enqueue time).
 */

import { WebSocket } from 'ws';

export interface FeedbackResult {
    feedback: string;
    images?: string[];
}

export interface ResolvedFeedback extends FeedbackResult {
    transport: WebSocket;
}

interface PendingFeedback {
    mcpClient: WebSocket;
    projectDir?: string;
    resolve: (result: ResolvedFeedback) => void;
    reject: (error: Error) => void;
}

export class FeedbackManager {
    private queue: PendingFeedback[] = [];

    enqueue(mcpClient: WebSocket, projectDir?: string): Promise<ResolvedFeedback> {
        return new Promise<ResolvedFeedback>((resolve, reject) => {
            this.queue.push({ mcpClient, projectDir, resolve, reject });
        });
    }

    resolveFirst(result: FeedbackResult): boolean {
        const entry = this.queue.shift();
        if (!entry) return false;
        entry.resolve({ ...result, transport: entry.mcpClient });
        return true;
    }

    updateTransport(newWs: WebSocket, projectDir?: string): boolean {
        if (!projectDir) return false;
        let updated = false;
        for (const entry of this.queue) {
            if (entry.projectDir && entry.projectDir === projectDir) {
                entry.mcpClient = newWs;
                updated = true;
            }
        }
        return updated;
    }

    hasPending(): boolean {
        return this.queue.length > 0;
    }

    pendingCount(): number {
        return this.queue.length;
    }

    rejectAll(error: Error): void {
        for (const entry of this.queue) {
            entry.reject(error);
        }
        this.queue = [];
    }
}
