'use strict';
/*
 * validate.cjs — health-check the Oric MCP server the way a real MCP client would.
 *
 * Spawns `node oric-mcp-server.cjs`, speaks the actual MCP stdio handshake
 * (initialize -> notifications/initialized -> tools/list) over newline-delimited
 * JSON-RPC 2.0, and reports the tools it advertises. Nothing is launched — this proves
 * the MCP layer itself is healthy (the binary starts, speaks MCP, lists its tools). It
 * does NOT start an emulator (that's the playthrough runner's job).
 *
 * Shared by the VS Code "Register MCP Server" command and by CLI/CI:
 *   node mcp/validate.cjs [path-to-server.cjs]
 * Exit 0 = healthy (prints "OK: N tools"), non-zero = failed (prints the reason).
 */

const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SERVER = path.join(__dirname, 'oric-mcp-server.cjs');

// Run the MCP handshake against a freshly spawned server and resolve its tool list.
// Returns { ok, count, tools:[names], protocolVersion, serverInfo, error }.
function validateServer(serverPath = DEFAULT_SERVER, opts = {}) {
    const timeoutMs = opts.timeoutMs || 8000;
    const nodeBin = opts.node || process.execPath;   // reuse the same node
    return new Promise(resolve => {
        let done = false;
        const finish = r => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch (_) {} resolve(r); };

        let child;
        try {
            child = spawn(nodeBin, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            return resolve({ ok: false, error: 'could not spawn server: ' + (e && e.message || e) });
        }

        const timer = setTimeout(() => finish({ ok: false, error: 'timed out after ' + timeoutMs + 'ms waiting for tools/list (stderr: ' + stderr.slice(-400).trim() + ')' }), timeoutMs);

        let stderr = '', inbuf = '';
        child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { stderr += d; });
        child.on('error', e => finish({ ok: false, error: 'spawn error: ' + (e && e.message || e) }));
        child.on('exit', code => { if (!done) finish({ ok: false, error: 'server exited early (code ' + code + '): ' + stderr.slice(-400).trim() }); });

        const send = obj => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) {} };

        // Read newline-delimited JSON-RPC replies; act on id 1 (initialize) then id 2 (tools/list).
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            inbuf += chunk;
            let nl;
            while ((nl = inbuf.indexOf('\n')) >= 0) {
                const line = inbuf.slice(0, nl).trim();
                inbuf = inbuf.slice(nl + 1);
                if (!line) continue;
                let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
                if (msg.id === 1) {
                    if (msg.error) return finish({ ok: false, error: 'initialize failed: ' + JSON.stringify(msg.error) });
                    initResult = msg.result || {};
                    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
                    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
                } else if (msg.id === 2) {
                    if (msg.error) return finish({ ok: false, error: 'tools/list failed: ' + JSON.stringify(msg.error) });
                    const tools = (msg.result && msg.result.tools || []).map(t => t.name);
                    return finish({
                        ok: tools.length > 0,
                        count: tools.length,
                        tools,
                        protocolVersion: initResult.protocolVersion,
                        serverInfo: initResult.serverInfo,
                        error: tools.length ? undefined : 'server advertised 0 tools',
                    });
                }
            }
        });

        let initResult = {};
        send({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'oric-validate', version: '1.0.0' } },
        });
    });
}

module.exports = { validateServer, DEFAULT_SERVER };

if (require.main === module) {
    const serverPath = process.argv[2] || DEFAULT_SERVER;
    validateServer(serverPath).then(r => {
        if (r.ok) {
            process.stdout.write('OK: ' + r.count + ' tools (' + (r.serverInfo && r.serverInfo.name || '?') +
                ' / MCP ' + (r.protocolVersion || '?') + ')\n' + r.tools.join(', ') + '\n');
            process.exit(0);
        }
        process.stderr.write('FAILED: ' + r.error + '\n');
        process.exit(1);
    });
}
