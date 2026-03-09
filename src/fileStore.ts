/**
 * Centralized file I/O for all persistent state.
 * All paths under ~/.config/mcp-feedback-enhanced/
 *
 * Directory structure:
 *   sessions/<conversation_id>.json   - Hook-created session registrations
 *   pending/<conversation_id>.json    - Pending messages per conversation
 *   conversations/<conversation_id>.json - Persisted tab state
 *   servers/<pid>.json                - Extension instance registry
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
    SessionRegistration,
    PendingData,
    ConversationData,
    ServerInfo,
} from './types';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-v2');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const PENDING_DIR = path.join(CONFIG_DIR, 'pending');
const CONVERSATIONS_DIR = path.join(CONFIG_DIR, 'conversations');
const SERVERS_DIR = path.join(CONFIG_DIR, 'servers');

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

function safeReadJSON<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) { return null; }
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch {
        return null;
    }
}

function safeWriteJSON(filePath: string, data: unknown): void {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function safeDelete(filePath: string): boolean {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
    } catch { /* ignore */ }
    return false;
}

function listJSONFiles(dir: string): string[] {
    try {
        if (!fs.existsSync(dir)) { return []; }
        return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
        return [];
    }
}

// ─── Sessions ────────────────────────────────────────────

export function readSession(conversationId: string): SessionRegistration | null {
    return safeReadJSON<SessionRegistration>(path.join(SESSIONS_DIR, `${conversationId}.json`));
}

export function writeSession(data: SessionRegistration): void {
    safeWriteJSON(path.join(SESSIONS_DIR, `${data.conversation_id}.json`), data);
}

export function deleteSession(conversationId: string): boolean {
    return safeDelete(path.join(SESSIONS_DIR, `${conversationId}.json`));
}

export function listSessions(): SessionRegistration[] {
    return listJSONFiles(SESSIONS_DIR)
        .map(f => safeReadJSON<SessionRegistration>(path.join(SESSIONS_DIR, f)))
        .filter((s): s is SessionRegistration => s !== null);
}

export function getSessionsDir(): string {
    ensureDir(SESSIONS_DIR);
    return SESSIONS_DIR;
}

// ─── Pending ─────────────────────────────────────────────

export function readPending(conversationId: string): PendingData | null {
    return safeReadJSON<PendingData>(path.join(PENDING_DIR, `${conversationId}.json`));
}

export function writePending(data: PendingData): void {
    safeWriteJSON(path.join(PENDING_DIR, `${data.conversation_id}.json`), data);
}

export function deletePending(conversationId: string): boolean {
    return safeDelete(path.join(PENDING_DIR, `${conversationId}.json`));
}

export function getPendingDir(): string {
    ensureDir(PENDING_DIR);
    return PENDING_DIR;
}

// ─── Conversations (persisted tab state) ─────────────────

export function readConversation(conversationId: string): ConversationData | null {
    return safeReadJSON<ConversationData>(path.join(CONVERSATIONS_DIR, `${conversationId}.json`));
}

export function writeConversation(data: ConversationData): void {
    safeWriteJSON(path.join(CONVERSATIONS_DIR, `${data.conversation_id}.json`), data);
}

export function deleteConversation(conversationId: string): boolean {
    return safeDelete(path.join(CONVERSATIONS_DIR, `${conversationId}.json`));
}

export function listConversations(): ConversationData[] {
    return listJSONFiles(CONVERSATIONS_DIR)
        .map(f => safeReadJSON<ConversationData>(path.join(CONVERSATIONS_DIR, f)))
        .filter((c): c is ConversationData => c !== null);
}

// ─── Servers ─────────────────────────────────────────────

export function readServer(pid: number): ServerInfo | null {
    return safeReadJSON<ServerInfo>(path.join(SERVERS_DIR, `${pid}.json`));
}

export function writeServer(data: ServerInfo): void {
    safeWriteJSON(path.join(SERVERS_DIR, `${data.pid}.json`), data);
}

export function deleteServer(pid: number): boolean {
    return safeDelete(path.join(SERVERS_DIR, `${pid}.json`));
}

export function listServers(): ServerInfo[] {
    return listJSONFiles(SERVERS_DIR)
        .map(f => safeReadJSON<ServerInfo>(path.join(SERVERS_DIR, f)))
        .filter((s): s is ServerInfo => s !== null);
}

// ─── Cleanup Utilities ───────────────────────────────────

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function cleanupStaleServers(): number {
    let cleaned = 0;
    for (const server of listServers()) {
        if (!isProcessAlive(server.pid)) {
            deleteServer(server.pid);
            cleaned++;
        }
    }
    return cleaned;
}

export function cleanupStaleSessions(): number {
    let cleaned = 0;
    const liveServerPids = new Set(listServers().filter(s => isProcessAlive(s.pid)).map(s => s.pid));
    for (const session of listSessions()) {
        if (session.server_pid && !liveServerPids.has(session.server_pid)) {
            deleteSession(session.conversation_id);
            cleaned++;
        }
    }
    return cleaned;
}

export function cleanupStalePending(): number {
    let cleaned = 0;
    for (const file of listJSONFiles(PENDING_DIR)) {
        const pending = safeReadJSON<PendingData>(path.join(PENDING_DIR, file));
        if (pending?.server_pid && !isProcessAlive(pending.server_pid)) {
            safeDelete(path.join(PENDING_DIR, file));
            cleaned++;
        }
    }
    return cleaned;
}

export function cleanupLegacyPending(): void {
    safeDelete(path.join(CONFIG_DIR, 'pending.json'));
}

export { CONFIG_DIR, SESSIONS_DIR, PENDING_DIR, CONVERSATIONS_DIR, SERVERS_DIR };
