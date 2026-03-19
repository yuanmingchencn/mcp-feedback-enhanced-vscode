/**
 * Backward-compatible re-export.
 * extension.ts and tests import FeedbackWSServer from here.
 */

// Re-export WsHub as FeedbackWSServer for backward compatibility
export { WsHub as FeedbackWSServer } from './server/wsHub';

// Also export sub-modules for direct access
export { ConversationStore } from './server/conversationStore';
export { FeedbackManager } from './server/feedbackManager';
export { PendingManager } from './server/pendingManager';
export { SessionWatcher } from './server/sessionWatcher';
