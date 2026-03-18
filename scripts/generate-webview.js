#!/usr/bin/env node
/**
 * Copies static/panel.html to out/webview/panel.html for packaging.
 * The HTML file is a single self-contained file with inline CSS and JS.
 */

const fs = require('fs');
const path = require('path');

const htmlSrc = path.join(__dirname, '..', 'static', 'panel.html');
const stateSrc = path.join(__dirname, '..', 'static', 'panelState.js');
const outDir = path.join(__dirname, '..', 'out', 'webview');
const dest = path.join(outDir, 'panel.html');

if (!fs.existsSync(htmlSrc)) {
    console.error('[generate-webview] static/panel.html not found!');
    process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

let html = fs.readFileSync(htmlSrc, 'utf8');

if (fs.existsSync(stateSrc)) {
    const stateJs = fs.readFileSync(stateSrc, 'utf8');
    html = html.replace('<script>', '<script>\n// -- panelState.js (inlined) --\n' + stateJs + '\n// -- end panelState.js --\n');
    console.log('[generate-webview] Inlined panelState.js into panel.html');
}

fs.writeFileSync(dest, html, 'utf8');
console.log('[generate-webview] Generated out/webview/panel.html');
