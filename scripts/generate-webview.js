#!/usr/bin/env node
/**
 * Copies static/panel.html to out/webview/panel.html for packaging.
 * The HTML file is a single self-contained file with inline CSS and JS.
 */

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'static', 'panel.html');
const outDir = path.join(__dirname, '..', 'out', 'webview');
const dest = path.join(outDir, 'panel.html');

if (!fs.existsSync(src)) {
    console.error('[generate-webview] static/panel.html not found!');
    process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('[generate-webview] Copied static/panel.html → out/webview/panel.html');
