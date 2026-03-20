import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { ConnectedClient } from './clientRegistry';

interface ConnectionHandlerDeps {
    onParsedMessage: (raw: RawData) => void;
    onDisconnect: () => void;
}

export function bindClientConnectionHandlers(
    ws: WebSocket,
    client: ConnectedClient,
    deps: ConnectionHandlerDeps
): void {
    let disconnected = false;
    const handleDisconnect = () => {
        if (disconnected) return;
        disconnected = true;
        deps.onDisconnect();
    };

    ws.on('message', (raw) => deps.onParsedMessage(raw));
    ws.on('pong', () => { client.lastPong = Date.now(); });
    ws.on('close', handleDisconnect);
    ws.on('error', handleDisconnect);
}
