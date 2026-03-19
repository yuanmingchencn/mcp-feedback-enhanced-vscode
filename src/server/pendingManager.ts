/**
 * Manages pending message queue files and watches for hook consumption.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    writePending,
    readPending,
    deletePending,
    getPendingDir,
} from '../fileStore';

export interface PendingDelivery {
    conversationId: string;
    comments: string[];
    images: string[];
}

export class PendingManager {
    private serverPid: number;
    private watchers = new Map<string, ReturnType<typeof setInterval>>();
    private onDelivered?: (delivery: PendingDelivery) => void;

    constructor(serverPid: number) {
        this.serverPid = serverPid;
    }

    onPendingDelivered(cb: (delivery: PendingDelivery) => void): void {
        this.onDelivered = cb;
    }

    handleQueue(conversationId: string, comments: string[], images: string[]): void {
        const queue = comments.filter(c => c.trim());

        if (queue.length === 0 && images.length === 0) {
            deletePending(conversationId);
            return;
        }

        writePending({
            conversation_id: conversationId,
            server_pid: this.serverPid,
            comments: queue,
            images: images.length > 0 ? images : undefined,
            timestamp: Date.now(),
        });

        this._watchFile(conversationId);
    }

    cancelWatch(conversationId: string): void {
        const timer = this.watchers.get(conversationId);
        if (timer) {
            clearInterval(timer);
            this.watchers.delete(conversationId);
        }
    }

    cleanup(): void {
        for (const timer of this.watchers.values()) {
            clearInterval(timer);
        }
        this.watchers.clear();
    }

    private _watchFile(conversationId: string): void {
        if (this.watchers.has(conversationId)) return;

        const pendingDir = getPendingDir();
        const filePath = path.join(pendingDir, `${conversationId}.json`);

        let lastKnownComments: string[] = [];
        let lastKnownImages: string[] = [];
        let lastKnownServerPid: number | null = null;

        const timer = setInterval(() => {
            try {
                const data = readPending(conversationId);
                if (data) {
                    if (data.comments?.length) lastKnownComments = data.comments;
                    if (data.images?.length) lastKnownImages = data.images;
                    lastKnownServerPid = data?.server_pid ?? null;
                }
            } catch { /* ignore read errors */ }

            if (!fs.existsSync(filePath)) {
                clearInterval(timer);
                this.watchers.delete(conversationId);

                if (lastKnownServerPid !== null && lastKnownServerPid !== this.serverPid) {
                    return;
                }

                if (this.onDelivered) {
                    this.onDelivered({
                        conversationId,
                        comments: lastKnownComments,
                        images: lastKnownImages,
                    });
                }
            }
        }, 500);

        this.watchers.set(conversationId, timer);
    }
}
