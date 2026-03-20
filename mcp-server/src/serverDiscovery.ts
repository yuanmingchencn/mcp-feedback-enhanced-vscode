import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as crypto from 'node:crypto';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
const SERVERS_DIR = path.join(CONFIG_DIR, 'servers');

export interface ServerData {
    port: number;
    pid: number;
    projectPath: string;
    version: string;
}

function readJSON<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch {
        return null;
    }
}

function listJSONFiles(dir: string): string[] {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => { sock.destroy(); resolve(false); });
        sock.once('timeout', () => { sock.destroy(); resolve(false); });
        sock.connect(port, host);
    });
}

function projectHash(dir: string): string {
    const normalized = path.normalize(dir).replace(/\/+$/, '');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export async function findExtensionServer(projectDirectory?: string): Promise<ServerData | null> {
    if (projectDirectory) {
        const hash = projectHash(projectDirectory);
        const s = readJSON<ServerData>(path.join(SERVERS_DIR, `${hash}.json`));
        if (s && await isPortOpen(s.port)) return s;
    }

    const alive: ServerData[] = [];
    for (const f of listJSONFiles(SERVERS_DIR)) {
        const s = readJSON<ServerData>(path.join(SERVERS_DIR, f));
        if (s && await isPortOpen(s.port)) alive.push(s);
    }
    return alive.length === 1 ? alive[0] : null;
}
