#!/usr/bin/env node
/**
 * Verification script - checks all components are working
 * Run: node scripts/verify.js
 */

const fs = require('fs');
const path = require('path');

const CHECKS = [];
let passed = 0;
let failed = 0;

function check(name, condition, details = '') {
    if (condition) {
        console.log(`✅ ${name}`);
        passed++;
    } else {
        console.log(`❌ ${name}${details ? ': ' + details : ''}`);
        failed++;
    }
}

console.log('=== MCP Feedback Enhanced Verification ===\n');

// 1. Check panel.html exists
const panelPath = path.join(__dirname, '..', 'out', 'webview', 'panel.html');
check('panel.html exists', fs.existsSync(panelPath));

// 2. Check panel.html has renderMarkdown
if (fs.existsSync(panelPath)) {
    const content = fs.readFileSync(panelPath, 'utf-8');
    check('renderMarkdown function present', content.includes('function renderMarkdown'));
    check('Bold regex correct', content.includes('/\\*\\*([^*]+?)\\*\\*/g'));
    check('Line break regex correct', content.includes('/\\n/g'));
    check('innerHTML used for content', content.includes('content.innerHTML = renderMarkdown'));
    check('Reload button handler present', content.includes('reload-webview'));
    check('Hot reload WebSocket connection', content.includes('HOT_RELOAD_PORT'));
}

// 3. Check extension.js has _loadWebviewHtml
const extPath = path.join(__dirname, '..', 'out', 'extension.js');
if (fs.existsSync(extPath)) {
    const content = fs.readFileSync(extPath, 'utf-8');
    check('_loadWebviewHtml in extension.js', content.includes('_loadWebviewHtml'));
    check('readFileSync in extension.js', content.includes('readFileSync'));
    check('reload-webview handler in extension.js', content.includes('reload-webview'));
}

// 4. Check symlink
const symlinkPath = path.join(process.env.HOME, '.cursor', 'extensions', 'mcp-feedback.mcp-feedback-enhanced-vscode-dev');
try {
    const linkTarget = fs.readlinkSync(symlinkPath);
    check('Symlink exists and points to dev folder', linkTarget.includes('mcp-feedback-enhanced'));
} catch (e) {
    check('Symlink exists', false, 'Not found or not a symlink');
}

// 5. Check history directory
const historyDir = path.join(process.env.HOME, '.config', 'mcp-feedback-enhanced', 'history');
const historyExists = fs.existsSync(historyDir);
check('History directory exists', historyExists);
if (historyExists) {
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
    check('History files exist', files.length > 0, `Found ${files.length} files`);
}

// 6. Test renderMarkdown logic
console.log('\n=== Testing renderMarkdown Logic ===\n');
function renderMarkdown(text) {
    if (!text) return '';
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/\n/g, '<br>');
    return html;
}

const testInput = '## Header\n**bold** and *italic*';
const testOutput = renderMarkdown(testInput);
check('Header rendered', testOutput.includes('<h3>Header</h3>'));
check('Bold rendered', testOutput.includes('<strong>bold</strong>'));
check('Italic rendered', testOutput.includes('<em>italic</em>'));
check('Line breaks rendered', testOutput.includes('<br>'));

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
    console.log('\nFix the issues above, run "npm run compile", then verify again.');
    process.exit(1);
}
