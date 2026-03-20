import { WebSocket } from 'ws';

export function connectToExtension(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Connection timeout'));
        }, 5000);

        ws.once('open', () => {
            clearTimeout(timeout);
            ws.send(JSON.stringify({
                type: 'register',
                clientType: 'mcp-server',
            }));
            resolve(ws);
        });

        ws.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

export function requestFeedback(
    ws: WebSocket,
    summary: string,
    projectDirectory?: string,
): Promise<{ feedback: string; images?: string[] }> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Feedback timeout (24h)'));
        }, 86_400_000);

        const handler = (raw: Buffer | string) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'feedback_result') {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    resolve({ feedback: msg.feedback || '', images: msg.images });
                } else if (msg.type === 'feedback_error') {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    reject(new Error(msg.error || 'Feedback error'));
                }
            } catch {
                // ignore parse errors
            }
        };

        ws.on('message', handler);
        ws.once('close', () => {
            clearTimeout(timeout);
            reject(new Error('Connection closed'));
        });

        ws.send(JSON.stringify({
            type: 'feedback_request',
            summary,
            project_directory: projectDirectory,
        }));
    });
}
