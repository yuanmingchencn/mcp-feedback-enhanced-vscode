/**
 * In-memory pending message queue (single queue per extension window).
 *
 * Pending state lives entirely in the extension process.
 * Hooks consume pending via HTTP endpoints on the WS server.
 */

export interface PendingDelivery {
    comments: string[];
    images: string[];
}

export interface PendingEntry {
    comments: string[];
    images: string[];
}

export class PendingManager {
    private entry: PendingEntry | null = null;
    private onDelivered?: (delivery: PendingDelivery) => void;

    onPendingDelivered(cb: (delivery: PendingDelivery) => void): void {
        this.onDelivered = cb;
    }

    set(comments: string[], images: string[]): void {
        const queue = comments.filter(c => c.trim());
        if (queue.length === 0 && images.length === 0) {
            this.entry = null;
            return;
        }
        this.entry = {
            comments: queue,
            images: images.length > 0 ? images : [],
        };
    }

    read(): PendingEntry | null {
        return this.entry;
    }

    consume(): PendingEntry | null {
        const entry = this.entry;
        if (!entry) return null;
        this.entry = null;

        if (this.onDelivered) {
            this.onDelivered({
                comments: entry.comments,
                images: entry.images,
            });
        }

        return entry;
    }

    clear(): void {
        this.entry = null;
    }
}
