/**
 * Black-box MCP tool contract test via stdio transport.
 *
 * This suite starts mcp-server/dist/index.js as a subprocess and
 * speaks framed JSON-RPC over stdio to validate externally visible
 * tool behavior during rewrite work.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function createMcpProcess() {
    const entry = path.join(__dirname, '..', 'mcp-server', 'dist', 'index.js');
    const child = spawn('node', [entry], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => {
        // keep stderr drained; output is noisy but not needed for assertions
    });
    return child;
}

function createMcpClient(child) {
    let idSeq = 1;
    let buffer = '';
    const pending = new Map();

    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');

        while (true) {
            const nl = buffer.indexOf('\n');
            if (nl === -1) return;
            const body = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!body) continue;

            let msg;
            try {
                msg = JSON.parse(body);
            } catch {
                continue;
            }

            if (typeof msg.id === 'number' && pending.has(msg.id)) {
                const { resolve, reject, timer } = pending.get(msg.id);
                clearTimeout(timer);
                pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
                else resolve(msg.result);
            }
        }
    });

    function sendRequest(method, params, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const id = idSeq++;
            const payload = JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params,
            });
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Timeout waiting for ${method}`));
            }, timeoutMs);

            pending.set(id, { resolve, reject, timer });
            child.stdin.write(payload + '\n');
        });
    }

    async function close() {
        for (const [, p] of pending) clearTimeout(p.timer);
        pending.clear();
        child.kill('SIGTERM');
    }

    return { sendRequest, close };
}

describe('mcp server tool contract', () => {
    it('exposes stable tool surface and get_system_info output', async () => {
        const proc = createMcpProcess();
        const client = createMcpClient(proc);

        try {
            const init = await client.sendRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'compat-test', version: '1.0.0' },
            });
            assert.ok(init.serverInfo);
            assert.strictEqual(init.serverInfo.name, 'mcp-feedback-enhanced');

            const tools = await client.sendRequest('tools/list', {});
            assert.ok(Array.isArray(tools.tools), 'Expected tools array');

            const interactive = tools.tools.find((t) => t.name === 'interactive_feedback');
            const systemInfo = tools.tools.find((t) => t.name === 'get_system_info');

            assert.ok(interactive, 'interactive_feedback tool missing');
            assert.ok(systemInfo, 'get_system_info tool missing');
            assert.deepStrictEqual(interactive.inputSchema.required, ['summary']);
            assert.ok(interactive.inputSchema.properties.project_directory);

            const infoResult = await client.sendRequest('tools/call', {
                name: 'get_system_info',
                arguments: {},
            });
            assert.ok(Array.isArray(infoResult.content));
            assert.strictEqual(infoResult.content[0].type, 'text');

            const infoText = infoResult.content[0].text;
            const parsed = JSON.parse(infoText);
            assert.ok(parsed.platform);
            assert.ok(parsed.nodeVersion);

            const unknown = await client.sendRequest('tools/call', {
                name: 'non_existing_tool',
                arguments: {},
            });
            assert.strictEqual(unknown.isError, true);
            assert.ok(String(unknown.content?.[0]?.text || '').includes('Unknown tool'));

            await assert.rejects(
                () => client.sendRequest('tools/call', {
                    name: 'interactive_feedback',
                    arguments: {},
                }),
                /Required|invalid_type|summary/i
            );
        } finally {
            await client.close();
        }
    });
});
