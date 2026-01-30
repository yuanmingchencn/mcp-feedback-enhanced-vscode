const fs = require('fs');
const path = require('path');

const VERSION = require('../package.json').version;

const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ws://127.0.0.1:* ws://localhost:*;">
    <style>
        body { font-family: sans-serif; padding: 20px; color: #ccc; background: #1e1e1e; }
        .status { padding: 10px; margin: 10px 0; border-radius: 4px; }
        .connecting { background: #553; }
        .connected { background: #353; }
        .error { background: #533; }
        #log { font-family: monospace; font-size: 12px; white-space: pre-wrap; background: #111; padding: 10px; max-height: 300px; overflow: auto; }
        input { width: 100%; padding: 8px; margin: 10px 0; }
        button { padding: 8px 16px; }
    </style>
</head>
<body>
    <h2>MCP Feedback v${VERSION} - Minimal Test</h2>
    <div id="status" class="status connecting">Status: Connecting...</div>
    <div>SERVER_URL: <code id="urlDisplay"></code></div>
    <div>PROJECT_PATH: <code id="pathDisplay"></code></div>
    <div id="log"></div>
    <input id="input" placeholder="Type message...">
    <button id="sendBtn">Send</button>
    
    <script>
    const SERVER_URL = '{{SERVER_URL}}';
    const PROJECT_PATH = '{{PROJECT_PATH}}';
    const SESSION_ID = '{{SESSION_ID}}';
    
    document.getElementById('urlDisplay').textContent = SERVER_URL;
    document.getElementById('pathDisplay').textContent = PROJECT_PATH;
    
    const statusEl = document.getElementById('status');
    const logEl = document.getElementById('log');
    
    function log(msg) {
        const time = new Date().toLocaleTimeString();
        logEl.textContent += time + ' ' + msg + '\\n';
        logEl.scrollTop = logEl.scrollHeight;
        console.log('[Test]', msg);
    }
    
    log('Starting...');
    log('SERVER_URL = ' + SERVER_URL);
    
    if (SERVER_URL.includes('{{')) {
        statusEl.textContent = 'ERROR: SERVER_URL not replaced!';
        statusEl.className = 'status error';
        log('ERROR: Placeholder not replaced!');
    } else {
        try {
            log('Connecting to ' + SERVER_URL);
            const ws = new WebSocket(SERVER_URL);
            
            ws.onopen = () => {
                log('Connected!');
                statusEl.textContent = 'Connected to ' + SERVER_URL;
                statusEl.className = 'status connected';
                ws.send(JSON.stringify({
                    type: 'register',
                    clientType: 'webview',
                    projectPath: PROJECT_PATH,
                    sessionId: SESSION_ID
                }));
            };
            
            ws.onmessage = (e) => {
                log('Received: ' + e.data.substring(0, 100));
            };
            
            ws.onerror = (e) => {
                log('Error: ' + JSON.stringify(e));
                statusEl.textContent = 'Error connecting';
                statusEl.className = 'status error';
            };
            
            ws.onclose = () => {
                log('Disconnected');
                statusEl.textContent = 'Disconnected';
                statusEl.className = 'status connecting';
            };
        } catch (e) {
            log('Exception: ' + e.message);
            statusEl.textContent = 'Exception: ' + e.message;
            statusEl.className = 'status error';
        }
    }
    </script>
</body>
</html>`;

const outDir = path.join(__dirname, '..', 'out', 'webview');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'panel-test.html'), html);
console.log('Generated: panel-test.html');
