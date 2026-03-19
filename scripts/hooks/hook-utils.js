/**
 * Shared utilities for Cursor hook scripts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const SERVERS_DIR = path.join(CONFIG_DIR, 'servers');

function log(msg) {
    try {
        var logDir = path.join(CONFIG_DIR, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        var logFile = path.join(logDir, 'hooks.log');
        try {
            var stat = fs.statSync(logFile);
            if (stat.size > 2 * 1024 * 1024) {
                try { fs.unlinkSync(logFile + '.old'); } catch (e) {}
                fs.renameSync(logFile, logFile + '.old');
            }
        } catch (e) {}
        fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n');
    } catch (e) {}
}

function output(obj) {
    log('  -> output: ' + JSON.stringify(obj).slice(0, 300));
    process.stdout.write(JSON.stringify(obj));
}

function readJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) { return null; }
}

function readStdin() {
    var rawInput = '';
    try {
        rawInput = fs.readFileSync('/dev/stdin', 'utf-8');
        return JSON.parse(rawInput);
    } catch (e) {
        log('PARSE_ERROR: ' + e.message + ' raw=' + rawInput.slice(0, 200));
        return null;
    }
}

function httpGet(port, urlPath, timeout) {
    return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
            req.destroy();
            reject(new Error('timeout'));
        }, timeout || 2000);

        var req = http.get('http://127.0.0.1:' + port + urlPath, function (res) {
            var body = '';
            res.on('data', function (chunk) { body += chunk; });
            res.on('end', function () {
                clearTimeout(timer);
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: null });
                }
            });
        });
        req.on('error', function (err) {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function getServerPort(serverPid) {
    if (!serverPid) return null;
    var serverFile = path.join(SERVERS_DIR, serverPid + '.json');
    var server = readJSON(serverFile);
    return server ? server.port : null;
}

function findServer(workspaceRoots) {
    try {
        if (!fs.existsSync(SERVERS_DIR)) {
            log('  findServer: no servers dir');
            return null;
        }
        var files = fs.readdirSync(SERVERS_DIR).filter(function (f) { return f.endsWith('.json'); });
        var servers = [];

        for (var i = 0; i < files.length; i++) {
            var s = readJSON(path.join(SERVERS_DIR, files[i]));
            if (!s || !s.pid || !s.port) continue;
            try { process.kill(s.pid, 0); } catch (e) { continue; }
            servers.push(s);
        }

        if (servers.length === 0) {
            log('  findServer: no alive servers');
            return null;
        }
        if (servers.length === 1) {
            log('  findServer: single server pid=' + servers[0].pid + ' port=' + servers[0].port);
            return servers[0];
        }

        var roots = (workspaceRoots || []).map(function (r) { return r.replace(/\/+$/, ''); });
        for (var j = 0; j < servers.length; j++) {
            var sWs = (servers[j].workspaces || []).map(function (w) { return w.replace(/\/+$/, ''); });
            if (roots.some(function (r) { return sWs.includes(r); })) {
                log('  findServer: workspace match pid=' + servers[j].pid);
                return servers[j];
            }
        }

        var traceId = process.env.CURSOR_TRACE_ID || '';
        if (traceId) {
            for (var k = 0; k < servers.length; k++) {
                if (servers[k].cursorTraceId === traceId) {
                    log('  findServer: traceId match pid=' + servers[k].pid);
                    return servers[k];
                }
            }
        }

        log('  findServer: fallback to first pid=' + servers[0].pid);
        return servers[0];
    } catch (e) { return null; }
}

module.exports = {
    CONFIG_DIR,
    SESSIONS_DIR,
    SERVERS_DIR,
    log,
    output,
    readJSON,
    readStdin,
    httpGet,
    getServerPort,
    findServer,
};
