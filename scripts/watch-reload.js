#!/usr/bin/env node
/**
 * Hot-reload watcher for webview development
 * 
 * Usage:
 *   node scripts/watch-reload.js
 * 
 * This script:
 * 1. Starts a WebSocket server on port 18799
 * 2. Watches out/webview/panel.html for changes
 * 3. Broadcasts 'reload' to all connected webviews
 * 
 * The webview connects to this server and reloads when instructed.
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 18799;
const WATCH_PATH = path.join(__dirname, '..', 'out', 'webview', 'panel.html');

const wss = new WebSocket.Server({ port: PORT });
const clients = new Set();

console.log(`[Hot-Reload] Server started on ws://127.0.0.1:${PORT}`);
console.log(`[Hot-Reload] Watching: ${WATCH_PATH}`);

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[Hot-Reload] Client connected (total: ${clients.size})`);
    
    ws.on('close', () => {
        clients.delete(ws);
        console.log(`[Hot-Reload] Client disconnected (total: ${clients.size})`);
    });
    
    ws.on('error', (err) => {
        console.error('[Hot-Reload] WebSocket error:', err.message);
        clients.delete(ws);
    });
});

function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    }
}

// Watch for file changes
let debounceTimer = null;
fs.watch(WATCH_PATH, (eventType) => {
    if (eventType === 'change') {
        // Debounce rapid changes
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            console.log(`[Hot-Reload] File changed, broadcasting reload to ${clients.size} clients`);
            broadcast({ type: 'reload' });
        }, 300);
    }
});

// Also watch TypeScript source for auto-compile
const srcPath = path.join(__dirname, '..', 'src');
const scriptsPath = path.join(__dirname);

function watchDir(dir, name) {
    try {
        fs.watch(dir, { recursive: true }, (eventType, filename) => {
            if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    console.log(`[Hot-Reload] ${name} changed: ${filename}`);
                    console.log('[Hot-Reload] Running npm run compile...');
                    exec('npm run compile', { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
                        if (err) {
                            console.error('[Hot-Reload] Compile error:', stderr || err.message);
                        } else {
                            console.log('[Hot-Reload] Compiled successfully');
                            // panel.html watcher will handle the reload
                        }
                    });
                }, 500);
            }
        });
        console.log(`[Hot-Reload] Watching ${name}: ${dir}`);
    } catch (e) {
        console.warn(`[Hot-Reload] Cannot watch ${name}:`, e.message);
    }
}

watchDir(scriptsPath, 'scripts');

console.log('\n[Hot-Reload] Ready! Make changes to scripts/generate-webview.js');
console.log('[Hot-Reload] Press Ctrl+C to stop\n');
