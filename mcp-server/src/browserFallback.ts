import * as http from 'node:http';
import * as net from 'node:net';

function getBrowserHTML(summary: string): string {
    const escaped = summary
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MCP Feedback</title>
<style>
body{font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;background:#1e1e1e;color:#e0e0e0}
.summary{background:#2d2d2d;padding:16px;border-radius:8px;margin-bottom:20px;white-space:pre-wrap}
textarea{width:100%;height:120px;background:#2d2d2d;color:#e0e0e0;border:1px solid #555;border-radius:6px;padding:10px;font-size:14px;resize:vertical}
button{background:#0078d4;color:white;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;margin-top:10px}
button:hover{background:#106ebe}
</style></head><body>
<h2>MCP Feedback Enhanced</h2>
<div class="summary">${escaped}</div>
<textarea id="fb" placeholder="Your feedback..."></textarea>
<button onclick="send()">Send Feedback</button>
<script>
async function send(){
  const fb=document.getElementById('fb').value;
  if(!fb.trim())return;
  await fetch('/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({feedback:fb})});
  document.body.innerHTML='<h2>Feedback sent! You can close this tab.</h2>';
}
</script></body></html>`;
}

export async function browserFallback(summary: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(getBrowserHTML(summary));
            } else if (req.method === 'POST' && req.url === '/feedback') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk; });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                        server.close();
                        resolve(data.feedback || '');
                    } catch {
                        res.writeHead(400);
                        res.end();
                    }
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as net.AddressInfo;
            const url = `http://127.0.0.1:${addr.port}`;
            console.error(`[MCP Feedback] Browser fallback: ${url}`);

            const { exec } = require('node:child_process');
            const byPlatform: Record<string, string> = {
                darwin: 'open',
                win32: 'start',
            };
            const cmd = byPlatform[process.platform] ?? 'xdg-open';
            exec(`${cmd} "${url}"`);
        });

        setTimeout(() => {
            server.close();
            reject(new Error('Browser fallback timeout (10 min)'));
        }, 600_000);
    });
}
