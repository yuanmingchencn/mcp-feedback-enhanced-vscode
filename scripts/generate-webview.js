#!/usr/bin/env node
/**
 * Copies static/panel.html to out/webview/panel.html with panelState.js inlined.
 * The placeholder `/* PANELSTATE_PLACEHOLDER *​/` in panel.html is replaced
 * with the contents of static/panelState.js.
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
    const placeholder = '/* PANELSTATE_PLACEHOLDER */';
    if (html.includes(placeholder)) {
        html = html.replace(placeholder, stateJs);
        console.log('[generate-webview] Inlined panelState.js into panel.html via placeholder');
    } else {
        html = html.replace('<script>', '<script>\n// -- panelState.js (inlined) --\n' + stateJs + '\n// -- end panelState.js --\n');
        console.log('[generate-webview] Inlined panelState.js into panel.html (fallback)');
    }
}

fs.writeFileSync(dest, html, 'utf8');
console.log('[generate-webview] Generated out/webview/panel.html');
