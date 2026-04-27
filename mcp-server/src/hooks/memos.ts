import type { PostFeedbackContext, PostFeedbackHook } from '../postFeedbackHooks.js';

const MEMOS_API = process.env.MEMOS_API_BASE_URL || 'http://localhost:8000/product';
const MEMOS_USER = process.env.MEMOS_USER_ID || 'cursor-agent';
const NOISE = /^(ok|okay|yes|no|continue|go ahead|looks good|lgtm|好的?|继续|可以|没问题|行)\s*[.!]?\s*$/i;

let _reachable: boolean | null = null;
let _reachableExpiry = 0;

async function isMemosReachable(): Promise<boolean> {
    if (Date.now() < _reachableExpiry && _reachable !== null) return _reachable;
    try {
        const res = await fetch(`${MEMOS_API.replace('/product', '')}/health`, {
            signal: AbortSignal.timeout(2000),
        });
        _reachable = res.ok;
    } catch {
        _reachable = false;
    }
    _reachableExpiry = Date.now() + (_reachable ? 60_000 : 30_000);
    return _reachable;
}

async function addToMemos(content: string, tags: string[]): Promise<void> {
    const res = await fetch(`${MEMOS_API}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            user_id: MEMOS_USER,
            messages: content,
            async_mode: 'async',
            custom_tags: tags,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`MemOS add ${res.status}`);
    const data = (await res.json()) as { code: number; message: string };
    console.error(`[memos-hook] ${data.message}`);
}

export const memosHook: PostFeedbackHook = async (ctx: PostFeedbackContext) => {
    if (NOISE.test(ctx.feedback.trim())) return;
    if (!(await isMemosReachable())) return;

    const content = `FEEDBACK: AI did: ${ctx.summary.slice(0, 500)}\nUser said: ${ctx.feedback.slice(0, 500)}`;
    try {
        await addToMemos(content, ['feedback', 'user-interaction']);
    } catch (err) {
        console.error('[memos-hook]', err instanceof Error ? err.message : err);
    }
};
