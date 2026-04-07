import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import type { PostFeedbackContext, PostFeedbackHook } from '../postFeedbackHooks.js';

interface InteractionEntry {
    summary: string;
    feedback: string;
    ts: number;
}

interface ExtractedMemory {
    content: string;
    scope: string;
    category: string;
    tags: string[];
}

interface CompletionConfig {
    apiUrl: string;
    apiKey: string;
    model: string;
}

interface DaemonInfo {
    port: number;
    pid: number;
    startedAt: string;
}

const BUFFER: InteractionEntry[] = [];
const TRIGGER_COUNT = 5;
const NOISE_PATTERNS = /^(ok|okay|yes|no|continue|go ahead|looks good|lgtm|好的?|继续|可以|没问题|行)\s*[.!]?\s*$/i;

const DISTILL_SYSTEM = `You are a memory extraction assistant. Given AI-user interactions (summary = AI work, feedback = user response), extract ONLY noteworthy memories.

Rules:
- Skip trivial: "ok", "continue", "looks good", acknowledgements
- Extract: decisions, preferences, gotchas, patterns, tech stack choices
- Each memory: single self-contained fact
- Scope: "project" for repo-specific, "team" for conventions, "user" for personal prefs
- Category: "decision" | "gotcha" | "techstack" | "preference" | "pattern" | "note"

Return JSON array (may be empty): [{"content":"...","scope":"project","category":"decision","tags":["t1"]}]
Return ONLY the JSON array, no markdown fences.`;

function getConfigDir(): string {
    if (platform() === 'win32') {
        return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'deepmem');
    }
    return join(homedir(), '.deepmem');
}

function loadCompletionConfig(): CompletionConfig | null {
    const configPath = join(getConfigDir(), 'deepmem.yaml');
    if (!existsSync(configPath)) return null;
    const text = readFileSync(configPath, 'utf8');
    const cfg: CompletionConfig = { apiUrl: '', apiKey: '', model: '' };
    const envRe = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
    const expand = (v: string) =>
        v.replace(envRe, (_, name) => process.env[name] ?? '');
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const c = t.indexOf(':');
        if (c === -1) continue;
        const k = t.slice(0, c).trim();
        const v = expand(t.slice(c + 1).trim());
        if (k === 'completion.apiUrl') cfg.apiUrl = v;
        else if (k === 'completion.apiKey') cfg.apiKey = v;
        else if (k === 'completion.model') cfg.model = v;
    }
    return cfg.apiUrl && cfg.model ? cfg : null;
}

async function callCompletion(
    cfg: CompletionConfig,
    userPrompt: string,
): Promise<string> {
    const url = cfg.apiUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: cfg.model,
            messages: [
                { role: 'system', content: DISTILL_SYSTEM },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.2,
            max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Completion ${res.status}`);
    const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    return body.choices?.[0]?.message?.content?.trim() ?? '[]';
}

function parseExtracted(raw: string): ExtractedMemory[] {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
        const arr = JSON.parse(cleaned);
        if (!Array.isArray(arr)) return [];
        const SCOPES = new Set(['user', 'project', 'team']);
        const CATS = new Set(['decision', 'gotcha', 'techstack', 'preference', 'pattern', 'note']);
        return arr.filter(
            (m: unknown): m is ExtractedMemory =>
                typeof m === 'object' &&
                m !== null &&
                typeof (m as ExtractedMemory).content === 'string' &&
                SCOPES.has((m as ExtractedMemory).scope) &&
                CATS.has((m as ExtractedMemory).category),
        );
    } catch {
        return [];
    }
}

function loadDaemonInfo(): DaemonInfo | null {
    const p = join(getConfigDir(), 'daemon.json');
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, 'utf8')) as DaemonInfo;
    } catch {
        return null;
    }
}

let _daemonCache: DaemonInfo | null = null;
let _daemonCacheExpiry = 0;

function getCachedDaemon(): DaemonInfo | null {
    if (Date.now() < _daemonCacheExpiry) return _daemonCache;
    _daemonCache = loadDaemonInfo();
    _daemonCacheExpiry = Date.now() + (_daemonCache ? 60_000 : 300_000);
    return _daemonCache;
}

function invalidateDaemonCache(): void {
    _daemonCacheExpiry = 0;
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function isDeepmemReachable(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(2000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

async function callDeepmemRemember(
    port: number,
    memory: ExtractedMemory,
): Promise<void> {
    const rpc = {
        jsonrpc: '2.0',
        id: `hook-${Date.now()}`,
        method: 'tools/call',
        params: {
            name: 'deepmem_remember',
            arguments: {
                content: memory.content,
                scope: memory.scope,
                tags: memory.tags?.join(', ') ?? '',
            },
        },
    };
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(rpc),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`DeepMem MCP ${res.status}`);
}

async function distillAndStore(entries: InteractionEntry[]): Promise<void> {
    const daemon = getCachedDaemon();
    if (!daemon) {
        console.error('[deepmem-hook] No daemon.json, DeepMem not running');
        return;
    }
    if (!isPidAlive(daemon.pid)) {
        console.error(`[deepmem-hook] daemon.json PID ${daemon.pid} not alive, skipping`);
        invalidateDaemonCache();
        return;
    }
    if (!(await isDeepmemReachable(daemon.port))) {
        console.error(`[deepmem-hook] DeepMem not reachable on port ${daemon.port}, skipping`);
        invalidateDaemonCache();
        return;
    }
    const cfg = loadCompletionConfig();
    if (!cfg) {
        console.error('[deepmem-hook] No completion config (~/.deepmem/deepmem.yaml), skipping distillation');
        return;
    }

    const userPrompt = entries
        .map((e, i) => `--- Interaction ${i + 1} ---\nAI Summary: ${e.summary}\nUser Feedback: ${e.feedback}`)
        .join('\n\n');

    console.error(`[deepmem-hook] Distilling ${entries.length} interactions...`);
    const raw = await callCompletion(cfg, userPrompt);
    const memories = parseExtracted(raw);
    console.error(`[deepmem-hook] Extracted ${memories.length} memories`);

    for (const m of memories) {
        await callDeepmemRemember(daemon.port, m);
    }
    console.error(`[deepmem-hook] Stored ${memories.length} memories via DeepMem HTTP`);
}

export const deepmemHook: PostFeedbackHook = async (ctx: PostFeedbackContext) => {
    if (NOISE_PATTERNS.test(ctx.feedback.trim())) return;
    if (!getCachedDaemon()) return;

    BUFFER.push({ summary: ctx.summary, feedback: ctx.feedback, ts: Date.now() });
    console.error(`[deepmem-hook] Buffered interaction (${BUFFER.length}/${TRIGGER_COUNT})`);

    if (BUFFER.length >= TRIGGER_COUNT) {
        const batch = BUFFER.splice(0);
        try {
            await distillAndStore(batch);
        } catch (err) {
            console.error('[deepmem-hook] Distillation failed:', err instanceof Error ? err.message : err);
        }
    }
};
