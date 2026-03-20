import { WebSocket } from 'ws';
import type { WSMessage } from '../types';
import {
    validateMessage,
    FeedbackRequestSchema,
    FeedbackResponseSchema,
    QueuePendingSchema,
    RegisterSchema,
} from '../messageSchemas';

export interface ConnectedClientRef {
    clientType: 'webview' | 'mcp-server' | 'unknown';
    lastPong: number;
}

export interface MessageRouterDeps {
    onRegister: (clientType: 'webview' | 'mcp-server') => void;
    onFeedbackRequest: (ws: WebSocket, req: { summary: string; project_directory?: string }) => void;
    onFeedbackResponse: (res: { feedback: string; images?: string[] }) => void;
    onQueuePending: (qp: { comments: string[]; images?: string[] }) => void;
    onDismiss: () => void;
    onGetState: (ws: WebSocket) => void;
    sendPong: (ws: WebSocket) => void;
    onProtocolError: (context: string) => void;
}

export function routeHubMessage(
    ws: WebSocket,
    client: ConnectedClientRef,
    msg: WSMessage,
    deps: MessageRouterDeps
): void {
    switch (msg.type) {
        case 'register': {
            const reg = validateMessage(RegisterSchema, msg, 'register');
            if (!reg) {
                deps.onProtocolError('register');
                break;
            }
            deps.onRegister(reg.clientType);
            break;
        }
        case 'feedback_request': {
            const req = validateMessage(FeedbackRequestSchema, msg, 'feedback_request');
            if (!req) {
                deps.onProtocolError('feedback_request');
                break;
            }
            deps.onFeedbackRequest(ws, req);
            break;
        }
        case 'feedback_response': {
            const res = validateMessage(FeedbackResponseSchema, msg, 'feedback_response');
            if (!res) {
                deps.onProtocolError('feedback_response');
                break;
            }
            deps.onFeedbackResponse(res);
            break;
        }
        case 'queue-pending': {
            const qp = validateMessage(QueuePendingSchema, msg, 'queue-pending');
            if (!qp) {
                deps.onProtocolError('queue-pending');
                break;
            }
            deps.onQueuePending(qp);
            break;
        }
        case 'dismiss_feedback': {
            deps.onDismiss();
            break;
        }
        case 'get_state': {
            deps.onGetState(ws);
            break;
        }
        case 'ping':
        case 'heartbeat':
            client.lastPong = Date.now();
            deps.sendPong(ws);
            break;
        default:
            deps.onProtocolError('unknown_message_type');
            break;
    }
}
