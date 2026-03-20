import * as http from 'node:http';

function probePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = http.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => {
            srv.close(() => resolve(true));
        });
        srv.listen(port, '127.0.0.1');
    });
}

export async function findAvailablePort(start: number, end: number): Promise<number> {
    for (let port = start; port <= end; port++) {
        if (await probePort(port)) return port;
    }
    throw new Error('No available port');
}
