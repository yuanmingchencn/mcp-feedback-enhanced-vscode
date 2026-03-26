/**
 * Shared utilities for Cursor hook scripts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced');
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

function projectHash(dir) {
    var crypto = require('crypto');
    var normalized = path.normalize(dir).replace(/\/+$/, '');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function findServer(workspaceRoots) {
    try {
        if (!fs.existsSync(SERVERS_DIR)) {
            log('  findServer: no servers dir');
            return null;
        }

        var roots = (workspaceRoots || []).map(function (r) { return r.replace(/\/+$/, ''); });
        for (var i = 0; i < roots.length; i++) {
            var hash = projectHash(roots[i]);
            var s = readJSON(path.join(SERVERS_DIR, hash + '.json'));
            if (s && s.pid && s.port) {
                try { process.kill(s.pid, 0); } catch (e) { continue; }
                log('  findServer: hash match pid=' + s.pid + ' port=' + s.port);
                return s;
            }
        }

        // Single server fallback
        var files = fs.readdirSync(SERVERS_DIR).filter(function (f) { return f.endsWith('.json'); });
        var alive = [];
        for (var j = 0; j < files.length; j++) {
            var sv = readJSON(path.join(SERVERS_DIR, files[j]));
            if (!sv || !sv.pid || !sv.port) continue;
            try { process.kill(sv.pid, 0); } catch (e) { continue; }
            alive.push(sv);
        }
        if (alive.length === 1) {
            log('  findServer: single server pid=' + alive[0].pid + ' port=' + alive[0].port);
            return alive[0];
        }

        return null;
    } catch (e) { return null; }
}

var FEEDBACK_STATE_FILE = path.join(CONFIG_DIR, 'feedback-state.json');
var ENFORCEMENT_CONFIG_FILE = path.join(CONFIG_DIR, 'enforcement-config.json');

var DEFAULT_ENFORCEMENT = {
    maxToolCalls: 15,
    maxMinutes: 5,
};

function readFeedbackState() {
    return readJSON(FEEDBACK_STATE_FILE) || {};
}

function writeFeedbackState(state) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(FEEDBACK_STATE_FILE, JSON.stringify(state));
    } catch (e) {
        log('writeFeedbackState error: ' + e.message);
    }
}

function readEnforcementConfig() {
    var cfg = readJSON(ENFORCEMENT_CONFIG_FILE);
    if (!cfg) return DEFAULT_ENFORCEMENT;
    return {
        maxToolCalls: cfg.maxToolCalls || DEFAULT_ENFORCEMENT.maxToolCalls,
        maxMinutes: cfg.maxMinutes || DEFAULT_ENFORCEMENT.maxMinutes,
    };
}

module.exports = {
    CONFIG_DIR,
    SERVERS_DIR,
    FEEDBACK_STATE_FILE,
    ENFORCEMENT_CONFIG_FILE,
    DEFAULT_ENFORCEMENT,
    log,
    output,
    readJSON,
    readStdin,
    httpGet,
    findServer,
    readFeedbackState,
    writeFeedbackState,
    readEnforcementConfig,
};
