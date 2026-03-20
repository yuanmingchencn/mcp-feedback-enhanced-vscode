/**
 * Centralized file I/O for all persistent state.
 * All paths under ~/.config/mcp-feedback-enhanced/
 *
 * Directory structure:
 *   projects/<hash>.json   - Chat history per project
 *   servers/<hash>.json    - Extension instance registry (keyed by project hash)
 *   logs/
 *
 * Note: Pending messages are stored in-memory and served via HTTP.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type {
    ProjectState,
    ServerInfo,
} from './types';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
const PROJECTS_DIR = path.join(CONFIG_DIR, 'projects');
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

// ─── Project Hash ─────────────────────────────────────────

export function projectHash(workspacePath: string): string {
    const normalized = path.normalize(workspacePath).replace(/\/+$/, '');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ─── Projects ─────────────────────────────────────────────

export function readProject(hash: string): ProjectState | null {
    return safeReadJSON<ProjectState>(path.join(PROJECTS_DIR, `${hash}.json`));
}

export function writeProject(hash: string, data: ProjectState): void {
    safeWriteJSON(path.join(PROJECTS_DIR, `${hash}.json`), data);
}

// ─── Servers (keyed by project hash) ─────────────────────

export function readServerByHash(hash: string): ServerInfo | null {
    return safeReadJSON<ServerInfo>(path.join(SERVERS_DIR, `${hash}.json`));
}

export function writeServer(hash: string, data: ServerInfo): void {
    safeWriteJSON(path.join(SERVERS_DIR, `${hash}.json`), data);
}

export function deleteServerByHash(hash: string): boolean {
    return safeDelete(path.join(SERVERS_DIR, `${hash}.json`));
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
    for (const f of listJSONFiles(SERVERS_DIR)) {
        const info = safeReadJSON<ServerInfo>(path.join(SERVERS_DIR, f));
        if (info && !isProcessAlive(info.pid)) {
            safeDelete(path.join(SERVERS_DIR, f));
            cleaned++;
        }
    }
    return cleaned;
}

export { CONFIG_DIR, PROJECTS_DIR, SERVERS_DIR };
