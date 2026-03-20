import { WebSocket } from 'ws';
import type { WSMessage } from '../types';
import type { ConnectedClient } from './clientRegistry';
import { routeHubMessage } from './messageRouter';

interface HubRouteHandlers {
    onRegister: (clientType: 'webview' | 'mcp-server') => void;
    onFeedbackRequest: (ws: WebSocket, req: { summary: string; project_directory?: string }) => void;
    onFeedbackResponse: (res: { feedback: string; images?: string[] }) => void;
    onQueuePending: (qp: { comments: string[]; images?: string[] }) => void;
    onDismiss: () => void;
    onGetState: (ws: WebSocket) => void;
    sendPong: (ws: WebSocket) => void;
    onProtocolError: (context: string) => void;
}

export function dispatchRouteMessage(
    ws: WebSocket,
    client: ConnectedClient,
    msg: WSMessage,
    handlers: HubRouteHandlers
): void {
    routeHubMessage(ws, client, msg, {
        onRegister: handlers.onRegister,
        onFeedbackRequest: handlers.onFeedbackRequest,
        onFeedbackResponse: handlers.onFeedbackResponse,
        onQueuePending: handlers.onQueuePending,
        onDismiss: handlers.onDismiss,
        onGetState: handlers.onGetState,
        sendPong: handlers.sendPong,
        onProtocolError: handlers.onProtocolError,
    });
}
