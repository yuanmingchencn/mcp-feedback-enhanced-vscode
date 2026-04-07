export interface PostFeedbackContext {
    summary: string;
    feedback: string;
}

export type PostFeedbackHook = (ctx: PostFeedbackContext) => Promise<void>;

const hooks: PostFeedbackHook[] = [];

export function registerPostFeedbackHook(hook: PostFeedbackHook): void {
    hooks.push(hook);
}

export function runPostFeedbackHooks(ctx: PostFeedbackContext): void {
    for (const hook of hooks) {
        hook(ctx).catch(() => {});
    }
}
