/**
 * Playwright UI tests for the webview panel (panel.html).
 *
 * Run with: `npm run compile && node tests/ui.test.js`
 * Or: `npm test` (pretest runs compile)
 *
 * First-time setup: run `npx playwright install chromium` to install the browser.
 *
 * Uses node:test (same as ws-server.test.js). HOME is overridden to a temp dir
 * for test isolation. Starts a real FeedbackWSServer, serves a modified panel.html
 * with placeholders replaced, and runs Playwright against it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, after, before } = require('node:test');
const assert = require('node:assert');

// Preserve real HOME for Playwright (it looks for browsers under HOME)
const originalHome = process.env.HOME || os.homedir();
// Override HOME before any require of wsServer/fileStore (use unique dir for UI tests)
const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fb-ui-'));
process.env.HOME = testConfigDir;
// Point Playwright to real home's browser cache so it finds installed browsers
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const cacheDir = process.platform === 'darwin'
        ? path.join(originalHome, 'Library', 'Caches', 'ms-playwright')
        : path.join(originalHome, '.cache', 'ms-playwright');
    process.env.PLAYWRIGHT_BROWSERS_PATH = cacheDir;
}

const WebSocket = require('ws');
const { chromium } = require('@playwright/test');
const { FeedbackWSServer } = require('../out/wsServer');
const { writeSession, deleteSession, getSessionsDir, getPendingDir } = require('../out/fileStore');

// ─── Helpers ──────────────────────────────────────────────

function uniqueId(prefix = 'conv') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createMcpClient(port) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.once('open', () => {
            ws.send(JSON.stringify({ type: 'register', clientType: 'mcp-server' }));
            setTimeout(() => resolve(ws), 100);
        });
        ws.once('error', reject);
    });
}

function createWebviewClient(port) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.once('open', () => {
            ws.send(JSON.stringify({ type: 'register', clientType: 'webview', projectPath: '/test' }));
            setTimeout(() => resolve(ws), 100);
        });
        ws.once('error', reject);
    });
}

function waitForMessage(ws, matchType, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${matchType}`)), timeout);
        ws.on('message', function handler(raw) {
            const data = JSON.parse(raw.toString());
            if (data.type === matchType) {
                clearTimeout(timer);
                ws.off('message', handler);
                resolve(data);
            }
        });
    });
}

function yieldToEventLoop(ms = 50) {
    return new Promise((r) => setTimeout(r, ms));
}

function closeClient(ws) {
    return new Promise((resolve) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.once('close', resolve);
            ws.close();
        } else {
            resolve();
        }
    });
}

async function preparePanelHtml(port, projectPath = '/test-project') {
    const panelPath = path.join(__dirname, '../static/panel.html');
    let html = fs.readFileSync(panelPath, 'utf8');
    html = html.replace('{{SERVER_URL}}', `ws://127.0.0.1:${port}`);
    html = html.replace('{{PROJECT_PATH}}', projectPath);
    html = html.replace('{{SESSION_ID}}', 'test-session-id');

    const tmpPath = path.join(os.tmpdir(), `mcp-feedback-panel-${Date.now()}.html`);
    fs.writeFileSync(tmpPath, html);
    return tmpPath;
}

const VSCODE_API_MOCK = `
    window.acquireVsCodeApi = function() {
        return {
            postMessage: function(msg) {
                window.__vscodeMessages = window.__vscodeMessages || [];
                window.__vscodeMessages.push(msg);
            },
            getState: function() { return null; },
            setState: function() {}
        };
    };
`;

// ─── Test Setup ───────────────────────────────────────────

let server;
let serverPort;
let browser;
let tempHtmlPath;

async function startServer() {
    if (server) await server.stop();
    server = new FeedbackWSServer();
    serverPort = await server.start();
    return serverPort;
}

async function stopServer() {
    if (server) {
        await server.stop();
        server = null;
    }
}

async function setupBrowser() {
    if (browser) await browser.close();
    browser = await chromium.launch({ headless: true });
    return browser;
}

async function createPage(htmlPath) {
    const page = await browser.newPage();
    await page.addInitScript({ content: VSCODE_API_MOCK });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle', timeout: 10000 });
    return page;
}

async function waitForWsConnected(page, timeout = 5000) {
    await page.waitForFunction(
        () => {
            const status = document.querySelector('#statusBar');
            return status && document.body.offsetHeight > 0;
        },
        { timeout }
    );
    await yieldToEventLoop(200);
}

// ─── Tests ────────────────────────────────────────────────

describe('tab management', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('shows empty state initially when no sessions exist', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);
            const emptyState = await page.waitForSelector('.empty-state', { timeout: 5000 });
            assert.ok(emptyState);
            const title = await page.textContent('.empty-state .title');
            assert.ok(title && title.includes('AWAITING SIGNAL'));
        } finally {
            await page.close();
        }
    });

    it('creates tab when feedback_request arrives', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');
        const summary = 'Review my code';

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary,
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            const tabText = await page.textContent('.tab.active');
            assert.ok(tabText && tabText.includes('Review my code'));

            const aiBubble = await page.waitForSelector('.msg-row.ai .message .content', { timeout: 3000 });
            assert.ok(aiBubble);
            const content = await aiBubble.textContent();
            assert.ok(content && content.includes('Review my code'));
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('switches between tabs', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const conv1 = uniqueId();
        const conv2 = uniqueId();

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: conv1,
                summary: 'First tab',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: conv2,
                summary: 'Second tab',
            }));
            await page.waitForSelector('.tab:nth-of-type(2)', { timeout: 5000 });

            const tabs = await page.$$('.tab');
            assert.ok(tabs.length >= 2, `Expected at least 2 tabs, got ${tabs.length}`);

            const firstTab = await page.locator('.tab').filter({ hasText: 'First tab' }).first();
            await firstTab.click();
            await yieldToEventLoop(150);

            const activeTab = await page.$('.tab.active');
            assert.ok(activeTab);
            const text = await activeTab.textContent();
            assert.ok(text && text.includes('First tab'), `Active tab text: ${text}`);
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });
});

describe('message interaction', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('send button enables when text is entered', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const convId = uniqueId();
            const mcpWs = await createMcpClient(serverPort);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: convId,
                summary: 'Ask',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await closeClient(mcpWs);

            const input = await page.$('#input');
            await input.fill('hello');
            await yieldToEventLoop(100);

            const sendBtn = await page.$('#sendBtn');
            const disabled = await sendBtn.getAttribute('disabled');
            assert.strictEqual(disabled, null);
        } finally {
            await page.close();
        }
    });

    it('sends feedback_response on send', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'looks good');
            await page.click('#sendBtn');

            const msg = await feedbackResult;
            assert.strictEqual(msg.type, 'feedback_result');
            assert.ok(msg.feedback && msg.feedback.includes('looks good'));
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('clears input after send', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'my feedback');
            await page.click('#sendBtn');

            await feedbackResult;
            await yieldToEventLoop(200);

            const value = await page.inputValue('#input');
            assert.strictEqual(value.trim(), '');
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });
});

describe('pending queue', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('shows Queue button when tab is in running state', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            await page.fill('#input', 'fix this');
            await yieldToEventLoop(100);

            const sendBtnText = await page.textContent('#sendBtn');
            assert.ok(sendBtnText && sendBtnText.includes('Queue'));
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('queues message and shows badge', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            await page.fill('#input', 'fix this');
            await page.click('#sendBtn');

            await page.waitForSelector('.pending-section.visible', { timeout: 3000 });
            const pendingCount = await page.textContent('#pendingCount');
            assert.strictEqual(pendingCount, '1');
            const pendingText = await page.textContent('.pending-item .text');
            assert.ok(pendingText && pendingText.includes('fix this'));
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });
});

describe('ended tab behavior', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('hides input area when tab session ends', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'ok');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);

            fs.mkdirSync(getSessionsDir(), { recursive: true });
            writeSession({
                conversation_id: convId,
                workspace_roots: ['/test'],
                model: '',
                server_pid: process.pid,
                started_at: Date.now(),
            });
            await yieldToEventLoop(100);
            deleteSession(convId);
            await yieldToEventLoop(600);

            const hasInputHidden = await page.evaluate(() => document.body.classList.contains('input-hidden'));
            assert.strictEqual(hasInputHidden, true);

            const tabEnded = await page.$('.tab.ended, .tab.tab-ended');
            assert.ok(tabEnded);
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });
});

describe('@ autocomplete', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('does NOT show dropdown when typing without @', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const convId = uniqueId();
            const mcpWs = await createMcpClient(serverPort);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: convId,
                summary: 'Summary',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await closeClient(mcpWs);

            await page.fill('#input', 'hello');
            await yieldToEventLoop(200);

            const dropdown = await page.$('.at-dropdown.visible');
            assert.strictEqual(dropdown, null);
        } finally {
            await page.close();
        }
    });

    it('shows dropdown when typing @ followed by text', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const convId = uniqueId();
            const mcpWs = await createMcpClient(serverPort);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: convId,
                summary: 'Summary',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await closeClient(mcpWs);

            await page.fill('#input', '@pan');
            await yieldToEventLoop(200);

            await page.evaluate(() => {
                window.postMessage({
                    type: 'at-results',
                    items: [
                        { label: 'panel.html', detail: 'static/panel.html', insertText: 'static/panel.html', kind: 'file' },
                    ],
                }, '*');
            });
            await yieldToEventLoop(150);

            const dropdown = await page.waitForSelector('.at-dropdown.visible', { timeout: 3000 });
            assert.ok(dropdown);
            const label = await page.textContent('.at-dropdown-item .at-label');
            assert.strictEqual(label, 'panel.html');
        } finally {
            await page.close();
        }
    });

    it('inserts selection on Enter', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const convId = uniqueId();
            const mcpWs = await createMcpClient(serverPort);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: convId,
                summary: 'Summary',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await closeClient(mcpWs);

            await page.fill('#input', '@pan');
            await yieldToEventLoop(200);

            await page.evaluate(() => {
                window.postMessage({
                    type: 'at-results',
                    items: [
                        { label: 'panel.html', detail: 'static/panel.html', insertText: 'static/panel.html', kind: 'file' },
                    ],
                }, '*');
            });
            await yieldToEventLoop(150);

            await page.waitForSelector('.at-dropdown.visible', { timeout: 3000 });
            await page.keyboard.press('ArrowDown');
            await yieldToEventLoop(50);
            await page.keyboard.press('Enter');
            await yieldToEventLoop(100);

            const value = await page.inputValue('#input');
            assert.ok(value.includes('@static/panel.html'));
        } finally {
            await page.close();
        }
    });
});

describe('image support', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('shows attach button', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const attachBtn = await page.$('#attachBtn');
            assert.ok(attachBtn);
            const visible = await attachBtn.isVisible();
            assert.strictEqual(visible, true);
        } finally {
            await page.close();
        }
    });
});

describe('settings toggle', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('opens settings on gear click', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const settingsBtn = await page.$('#settingsBtn');
            assert.ok(settingsBtn);
            await settingsBtn.click();
            await yieldToEventLoop(150);

            const settingsPanel = await page.$('.settings-panel.visible');
            assert.ok(settingsPanel);
        } finally {
            await page.close();
        }
    });
});

// ─── Pending Queue Replace Behavior ──────────────────────

describe('pending queue replace behavior', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('second queued message replaces first', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            await page.fill('#input', 'first message');
            await page.click('#sendBtn');
            await page.waitForSelector('.pending-section.visible', { timeout: 3000 });
            const firstPending = await page.textContent('.pending-item .text');
            assert.ok(firstPending && firstPending.includes('first message'));

            await page.fill('#input', 'second message');
            await page.click('#sendBtn');
            await yieldToEventLoop(150);

            const pendingText = await page.textContent('.pending-item .text');
            assert.ok(pendingText && pendingText.includes('second message'));
            assert.ok(!pendingText.includes('first message'));
            const pendingCount = await page.textContent('#pendingCount');
            assert.strictEqual(pendingCount, '1');
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('edit button moves text to input', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            await page.fill('#input', 'edit me');
            await page.click('#sendBtn');
            await page.waitForSelector('.pending-section.visible', { timeout: 3000 });

            const editBtn = page.locator('.pending-item button[title="Edit"]');
            await editBtn.click();
            await yieldToEventLoop(100);

            const inputValue = await page.inputValue('#input');
            assert.strictEqual(inputValue.trim(), 'edit me');
            const pendingVisible = await page.locator('.pending-section.visible').count();
            assert.strictEqual(pendingVisible, 0);
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('edit and re-queue replaces', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            await page.fill('#input', 'original');
            await page.click('#sendBtn');
            await page.waitForSelector('.pending-section.visible', { timeout: 3000 });

            const editBtn = page.locator('.pending-item button[title="Edit"]');
            await editBtn.click();
            await yieldToEventLoop(100);
            await page.fill('#input', 'modified');
            await page.click('#sendBtn');
            await yieldToEventLoop(150);

            const pendingText = await page.textContent('.pending-item .text');
            assert.ok(pendingText && pendingText.includes('modified'));
            assert.ok(!pendingText.includes('original'));
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('clear button removes all pending', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            await page.fill('#input', 'something');
            await page.click('#sendBtn');
            await page.waitForSelector('.pending-section.visible', { timeout: 3000 });

            await page.locator('#clearPendingBtn').click();
            await yieldToEventLoop(100);

            const pendingVisible = await page.locator('.pending-section.visible').count();
            assert.strictEqual(pendingVisible, 0);
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });
});

// ─── Tab State Transitions ───────────────────────────────

describe('tab state transitions', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('idle → waiting: feedback_request shows input', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId1 = uniqueId('sess');
        const sessionId2 = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId1,
                conversation_id: convId,
                summary: 'Review my code',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await yieldToEventLoop(100);

            fs.mkdirSync(getSessionsDir(), { recursive: true });
            writeSession({
                conversation_id: convId,
                workspace_roots: ['/test'],
                model: '',
                server_pid: process.pid,
                started_at: Date.now(),
            });
            await yieldToEventLoop(100);
            deleteSession(convId);
            await yieldToEventLoop(600);

            const hasInputHiddenBefore = await page.evaluate(() => document.body.classList.contains('input-hidden'));
            assert.strictEqual(hasInputHiddenBefore, true);

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId2,
                conversation_id: convId,
                summary: 'New request',
            }));
            await yieldToEventLoop(200);

            const hasInputHiddenAfter = await page.evaluate(() => document.body.classList.contains('input-hidden'));
            assert.strictEqual(hasInputHiddenAfter, false);
            const sendBtnText = await page.textContent('#sendBtn');
            assert.ok(sendBtnText && sendBtnText.includes('Send'));
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('waiting → running: after feedback_response, input shows Queue mode', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            await page.fill('#input', 'extra text');
            await yieldToEventLoop(100);

            const sendBtnText = await page.textContent('#sendBtn');
            assert.ok(sendBtnText && sendBtnText.includes('Queue'));
            const hasInputHidden = await page.evaluate(() => document.body.classList.contains('input-hidden'));
            assert.strictEqual(hasInputHidden, false);
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('running → waiting: new feedback_request switches back to Send', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult1 = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult1;

            await yieldToEventLoop(200);
            const sessionId2 = uniqueId('sess');
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId2,
                conversation_id: convId,
                summary: 'New request',
            }));
            await yieldToEventLoop(200);

            const sendBtnText = await page.textContent('#sendBtn');
            assert.ok(sendBtnText && sendBtnText.includes('Send'));
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('running → ended: input hidden, messages muted', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'ok');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            fs.mkdirSync(getSessionsDir(), { recursive: true });
            writeSession({
                conversation_id: convId,
                workspace_roots: ['/test'],
                model: '',
                server_pid: process.pid,
                started_at: Date.now(),
            });
            await yieldToEventLoop(100);
            deleteSession(convId);
            await yieldToEventLoop(600);

            const hasInputHidden = await page.evaluate(() => document.body.classList.contains('input-hidden'));
            assert.strictEqual(hasInputHidden, true);
            const tabEnded = await page.$('.tab.tab-ended, .tab.ended');
            assert.ok(tabEnded);
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('waiting → ended: input hidden even if feedback was never sent', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await yieldToEventLoop(100);

            fs.mkdirSync(getSessionsDir(), { recursive: true });
            writeSession({
                conversation_id: convId,
                workspace_roots: ['/test'],
                model: '',
                server_pid: process.pid,
                started_at: Date.now(),
            });
            await yieldToEventLoop(100);
            deleteSession(convId);
            await yieldToEventLoop(600);

            const hasInputHidden = await page.evaluate(() => document.body.classList.contains('input-hidden'));
            assert.strictEqual(hasInputHidden, true);
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });
});

// ─── Multi-Tab State Isolation ────────────────────────────

describe('multi-tab state isolation', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('each tab maintains independent pending queue', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convA = uniqueId();
        const convB = uniqueId();
        const sessionA = uniqueId('sess');
        const sessionB = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResultA = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionA,
                conversation_id: convA,
                summary: 'Tab A',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResultA;

            await yieldToEventLoop(200);
            await page.fill('#input', 'msg A');
            await page.click('#sendBtn');
            await page.waitForSelector('.pending-section.visible', { timeout: 3000 });

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionB,
                conversation_id: convB,
                summary: 'Tab B',
            }));
            await page.waitForSelector('.tab:nth-of-type(2)', { timeout: 5000 });
            await page.locator('.tab').filter({ hasText: 'Tab B' }).first().click();
            await yieldToEventLoop(150);

            const feedbackResultB = waitForMessage(mcpWs, 'feedback_result', 8000);
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResultB;

            await yieldToEventLoop(200);
            await page.fill('#input', 'msg B');
            await page.click('#sendBtn');
            await yieldToEventLoop(150);

            await page.locator('.tab').filter({ hasText: 'Tab A' }).first().click();
            await yieldToEventLoop(150);
            const pendingA = await page.textContent('.pending-item .text');
            assert.ok(pendingA && pendingA.includes('msg A'));

            await page.locator('.tab').filter({ hasText: 'Tab B' }).first().click();
            await yieldToEventLoop(150);
            const pendingB = await page.textContent('.pending-item .text');
            assert.ok(pendingB && pendingB.includes('msg B'));
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('each tab maintains independent input draft', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convA = uniqueId();
        const convB = uniqueId();

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: convA,
                summary: 'Tab A',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: convB,
                summary: 'Tab B',
            }));
            await page.waitForSelector('.tab:nth-of-type(2)', { timeout: 5000 });

            await page.locator('.tab').filter({ hasText: 'Tab A' }).first().click();
            await yieldToEventLoop(100);
            await page.fill('#input', 'draft A');
            await yieldToEventLoop(100);

            await page.locator('.tab').filter({ hasText: 'Tab B' }).first().click();
            await yieldToEventLoop(100);
            await page.fill('#input', 'draft B');
            await yieldToEventLoop(100);

            await page.locator('.tab').filter({ hasText: 'Tab A' }).first().click();
            await yieldToEventLoop(100);
            const inputValue = await page.inputValue('#input');
            assert.strictEqual(inputValue.trim(), 'draft A');
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });

    it('ended tab does not affect other tab input', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convA = uniqueId();
        const convB = uniqueId();
        const sessionA = uniqueId('sess');
        const sessionB = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResultA = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionA,
                conversation_id: convA,
                summary: 'Tab A',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResultA;

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionB,
                conversation_id: convB,
                summary: 'Tab B',
            }));
            await page.waitForSelector('.tab:nth-of-type(2)', { timeout: 5000 });

            fs.mkdirSync(getSessionsDir(), { recursive: true });
            writeSession({
                conversation_id: convB,
                workspace_roots: ['/test'],
                model: '',
                server_pid: process.pid,
                started_at: Date.now(),
            });
            await yieldToEventLoop(100);
            deleteSession(convB);
            await yieldToEventLoop(600);

            await page.locator('.tab').filter({ hasText: 'Tab A' }).first().click();
            await yieldToEventLoop(150);
            const hasInputHidden = await page.evaluate(() => document.body.classList.contains('input-hidden'));
            assert.strictEqual(hasInputHidden, false);
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });
});

// ─── Input Validation ─────────────────────────────────────

describe('input validation', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('send button stays disabled when input is empty', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: convId,
                summary: 'Summary',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await closeClient(mcpWs);

            await page.fill('#input', '');
            await yieldToEventLoop(100);
            const sendBtn = await page.$('#sendBtn');
            const disabled = await sendBtn.getAttribute('disabled');
            assert.ok(disabled !== null);
        } finally {
            await page.close();
        }
    });

    it('whitespace-only input does not enable send', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: uniqueId('sess'),
                conversation_id: convId,
                summary: 'Summary',
            }));
            await page.waitForSelector('.tab', { timeout: 5000 });
            await closeClient(mcpWs);

            await page.fill('#input', '   ');
            await yieldToEventLoop(100);
            const sendBtn = await page.$('#sendBtn');
            const disabled = await sendBtn.getAttribute('disabled');
            assert.ok(disabled !== null);
        } finally {
            await page.close();
        }
    });
});

// ─── Pending Delivery Notification ────────────────────────

describe('pending delivery notification', () => {
    before(async () => {
        await startServer();
        await setupBrowser();
    });

    after(async () => {
        if (browser) await browser.close();
        await stopServer();
        if (tempHtmlPath && fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    });

    it('shows user messages with queued badge when pending is delivered', async () => {
        tempHtmlPath = await preparePanelHtml(serverPort);
        const convId = uniqueId();
        const sessionId = uniqueId('sess');

        const mcpWs = await createMcpClient(serverPort);
        const page = await createPage(tempHtmlPath);
        try {
            await waitForWsConnected(page);

            const feedbackResult = waitForMessage(mcpWs, 'feedback_result', 8000);
            mcpWs.send(JSON.stringify({
                type: 'feedback_request',
                session_id: sessionId,
                conversation_id: convId,
                summary: 'Summary',
            }));

            await page.waitForSelector('.tab', { timeout: 5000 });
            await page.fill('#input', 'response');
            await page.click('#sendBtn');
            await feedbackResult;

            await yieldToEventLoop(200);
            await page.fill('#input', 'queued message');
            await page.click('#sendBtn');
            await page.waitForSelector('.pending-section.visible', { timeout: 3000 });

            const pendingPath = path.join(getPendingDir(), `${convId}.json`);
            await yieldToEventLoop(600);
            assert.ok(fs.existsSync(pendingPath));
            fs.unlinkSync(pendingPath);
            await yieldToEventLoop(800);

            const hintBadge = await page.locator('.msg-row.user .message .hint-badge').last();
            await hintBadge.waitFor({ state: 'visible', timeout: 3000 });
            const badgeText = await hintBadge.textContent();
            assert.strictEqual(badgeText.trim(), 'queued');
        } finally {
            await closeClient(mcpWs);
            await page.close();
        }
    });
});

// ─── Cleanup ─────────────────────────────────────────────

after(async () => {
    try {
        fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
});
