/**
 * In-memory pending message queue.
 *
 * Pending state lives entirely in the extension process.
 * Hooks consume pending via HTTP endpoints on the WS server.
 * No file I/O, no polling.
 */

export interface PendingDelivery {
    conversationId: string;
    comments: string[];
    images: string[];
}

export interface PendingEntry {
    comments: string[];
    images: string[];
    timestamp: number;
}

export class PendingManager {
    private store = new Map<string, PendingEntry>();
    private onDelivered?: (delivery: PendingDelivery) => void;

    onPendingDelivered(cb: (delivery: PendingDelivery) => void): void {
        this.onDelivered = cb;
    }

    handleQueue(conversationId: string, comments: string[], images: string[]): void {
        const queue = comments.filter(c => c.trim());

        if (queue.length === 0 && images.length === 0) {
            this.store.delete(conversationId);
            return;
        }

        this.store.set(conversationId, {
            comments: queue,
            images: images.length > 0 ? images : [],
            timestamp: Date.now(),
        });
    }

    read(conversationId: string): PendingEntry | null {
        return this.store.get(conversationId) ?? null;
    }

    consume(conversationId: string): PendingEntry | null {
        const entry = this.store.get(conversationId);
        if (!entry) return null;
        this.store.delete(conversationId);

        if (this.onDelivered) {
            this.onDelivered({
                conversationId,
                comments: entry.comments,
                images: entry.images,
            });
        }

        return entry;
    }

    exists(conversationId: string): boolean {
        return this.store.has(conversationId);
    }

    clear(conversationId: string): void {
        this.store.delete(conversationId);
    }

    cleanup(): void {
        this.store.clear();
    }
}
