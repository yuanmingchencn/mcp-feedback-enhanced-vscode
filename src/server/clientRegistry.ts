import { WebSocket } from 'ws';

export type ClientType = 'webview' | 'mcp-server' | 'unknown';

export interface ConnectedClient {
    ws: WebSocket;
    clientType: ClientType;
    lastPong: number;
}

export class ClientRegistry {
    private readonly clients = new Map<WebSocket, ConnectedClient>();

    add(ws: WebSocket): ConnectedClient {
        const client: ConnectedClient = {
            ws,
            clientType: 'unknown',
            lastPong: Date.now(),
        };
        this.clients.set(ws, client);
        return client;
    }

    remove(ws: WebSocket): void {
        this.clients.delete(ws);
    }

    setClientType(ws: WebSocket, clientType: Exclude<ClientType, 'unknown'>): void {
        const c = this.clients.get(ws);
        if (c) c.clientType = clientType;
    }

    counts(): { webviews: number; mcpServers: number } {
        let webviews = 0;
        let mcpServers = 0;
        for (const [, c] of this.clients) {
            if (c.clientType === 'webview') webviews++;
            else if (c.clientType === 'mcp-server') mcpServers++;
        }
        return { webviews, mcpServers };
    }

    closeAll(): void {
        for (const [, client] of this.clients) {
            try { client.ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();
    }

    forEachWebview(cb: (ws: WebSocket) => void): void {
        for (const [ws, client] of this.clients) {
            if (client.clientType === 'webview') cb(ws);
        }
    }

    sweepStale(now: number, timeoutMs: number, onStale: (ws: WebSocket) => void): void {
        for (const [ws, client] of this.clients) {
            if (now - client.lastPong > timeoutMs) {
                try { ws.close(); } catch { /* ignore */ }
                this.clients.delete(ws);
                onStale(ws);
                continue;
            }
            try { ws.ping(); } catch { /* ignore */ }
        }
    }
}
