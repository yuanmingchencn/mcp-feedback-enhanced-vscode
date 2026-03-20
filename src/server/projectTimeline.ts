import type { ConversationMessage, ProjectState } from '../types';
import { projectHash, readProject, writeProject } from '../fileStore';

export class ProjectTimeline {
    private readonly messageCap: number;
    private readonly saveDelayMs: number;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private messages: ConversationMessage[] = [];
    private workspaces: string[] = [];
    private projHash = '';

    constructor(messageCap: number, saveDelayMs = 1000) {
        this.messageCap = messageCap;
        this.saveDelayMs = saveDelayMs;
    }

    setWorkspaces(workspaces: string[]): void {
        this.workspaces = workspaces;
        this.projHash = workspaces.length > 0 ? projectHash(workspaces[0]) : '';
        this.loadFromDisk();
    }

    addMessage(msg: ConversationMessage): void {
        this.messages.push(msg);
        if (this.messages.length > this.messageCap) {
            this.messages = this.messages.slice(-this.messageCap);
        }
        this.saveDebounced();
    }

    getMessages(): ConversationMessage[] {
        return this.messages;
    }

    dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }

    private loadFromDisk(): void {
        if (!this.projHash) {
            this.messages = [];
            return;
        }
        const proj = readProject(this.projHash);
        this.messages = proj ? proj.messages.slice(-this.messageCap) : [];
    }

    private saveDebounced(): void {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.saveNow();
        }, this.saveDelayMs);
    }

    private saveNow(): void {
        if (!this.projHash || this.workspaces.length === 0) return;
        const state: ProjectState = {
            projectPath: this.workspaces[0],
            messages: this.messages.slice(-this.messageCap),
            lastActive: Date.now(),
        };
        writeProject(this.projHash, state);
    }
}
