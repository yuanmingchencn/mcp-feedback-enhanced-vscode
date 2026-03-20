import * as http from 'node:http';
import { PendingManager } from './pendingManager';

export interface HttpRoutesDeps {
    port: number;
    version: string;
    pending: PendingManager;
    log: (msg: string) => void;
}

export function handleHttpRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: HttpRoutesDeps
): boolean {
    const url = new URL(req.url || '/', `http://127.0.0.1:${deps.port}`);
    const pathname = url.pathname;

    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && pathname === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            port: deps.port,
            pid: process.pid,
            version: deps.version,
        }));
        return true;
    }

    if (req.method === 'GET' && pathname === '/pending') {
        const consume = url.searchParams.get('consume') === '1';
        const entry = consume ? deps.pending.consume() : deps.pending.read();
        if (entry) {
            if (consume) deps.log(`HTTP consume pending: comments=${entry.comments.length}`);
            res.writeHead(200);
            res.end(JSON.stringify({ comments: entry.comments, images: entry.images }));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'no_pending' }));
        }
        return true;
    }

    return false;
}
