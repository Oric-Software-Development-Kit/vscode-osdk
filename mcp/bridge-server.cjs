'use strict';
/*
 * bridge-server — the extension-hosted endpoint that lets an external MCP client share the
 * LIVE VS Code debug session (see oric-bridge-protocol.cjs for the why + the wire format).
 *
 * Transport/VS-Code-agnostic on purpose: createBridgeServer(deps) takes injected functions so
 * it can be unit-tested with fakes (bridge-selftest.cjs) and so extension.js stays lean. The
 * extension wires `deps` to the real session.customRequest + viz state + control state.
 */

const net = require('net');
const { CONTROL, ERR_NO_CONTROL, classify } = require('./oric-bridge-protocol.cjs');

/*
 * deps:
 *   customRequest(cmd, args) -> Promise           proxy to session.customRequest (or throw if no session)
 *   hasSession() -> bool
 *   vizFrame() -> number
 *   vizScreen() -> base64 string | null
 *   vizInput(buf: Buffer) -> void                 send raw uplink bytes to the emulator
 *   getState() -> { stopped, userPaused, warp, module }
 *   getControl() -> 'human' | 'ai'
 *   setControl(owner) -> void                     flips ownership; extension updates UI + should broadcast
 *   sessionName() -> string
 *   log(msg) -> void
 */
function createBridgeServer(deps) {
    const clients = new Set();
    let server = null;

    function sendTo(sock, obj) { try { sock.write(JSON.stringify(obj) + '\n'); } catch (_) {} }
    function reply(sock, id, result) { if (id != null) sendTo(sock, { jsonrpc: '2.0', id, result }); }
    function replyErr(sock, id, code, message) { if (id != null) sendTo(sock, { jsonrpc: '2.0', id, error: { code, message } }); }

    // Push an event to every connected client (stopped/continued/output/signal/control/ended).
    function broadcast(event, extra) {
        const msg = { jsonrpc: '2.0', method: 'event', params: Object.assign({ event }, extra || {}) };
        for (const s of clients) sendTo(s, msg);
    }

    async function handle(sock, msg) {
        const { id, method, params } = msg;
        try {
            if (method === 'bridge.hello') {
                return reply(sock, id, { ok: true, control: deps.getControl(), session: deps.sessionName(), hasSession: deps.hasSession() });
            }
            if (method === 'bridge.state' || method === 'state') {
                return reply(sock, id, Object.assign({ control: deps.getControl() }, deps.getState()));
            }
            if (method === 'control.request') {
                deps.setControl(CONTROL.AI);            // AI announces it is piloting (human can reclaim any time)
                return reply(sock, id, { control: deps.getControl() });
            }
            if (method === 'control.release') {
                deps.setControl(CONTROL.HUMAN);
                return reply(sock, id, { control: deps.getControl() });
            }
            if (method === 'viz.frame') return reply(sock, id, { frame: deps.vizFrame() });
            if (method === 'viz.screen') {
                const meta = deps.vizMeta ? deps.vizMeta() : {};
                return reply(sock, id, Object.assign({ scr: deps.vizScreen() }, meta));   // { scr, frame, vidMode, vidAddr }
            }
            if (method === 'viz.input') {
                // INPUT is a control action (the AI is driving keys). The human's own keyboard
                // goes through the Screen View webview, NOT here, so it is never gated.
                if (deps.getControl() !== CONTROL.AI) return replyErr(sock, id, 1, ERR_NO_CONTROL + ': the human holds control (AI input blocked)');
                if (params && params.b64) deps.vizInput(Buffer.from(params.b64, 'base64'));
                return reply(sock, id, {});
            }
            // dap.<cmd> {args}  OR  dap {cmd,args}  -> session.customRequest, gated by op class.
            if (method === 'dap' || method.indexOf('dap.') === 0) {
                const cmd = method === 'dap' ? (params && params.cmd) : method.slice(4);
                const args = method === 'dap' ? (params && params.args) : params;
                if (!cmd) return replyErr(sock, id, -32602, 'dap: missing command');
                if (classify(cmd) === 'control' && deps.getControl() !== CONTROL.AI)
                    return replyErr(sock, id, 1, ERR_NO_CONTROL + ": the human holds control (can't '" + cmd + "' — ask them, or wait for them to hand it back)");
                if (!deps.hasSession()) return replyErr(sock, id, 2, 'NO_SESSION: no active oric-debug session');
                const r = await deps.customRequest(cmd, args || {});
                return reply(sock, id, r == null ? null : r);
            }
            return replyErr(sock, id, -32601, 'method not found: ' + method);
        } catch (e) {
            return replyErr(sock, id, -32603, e && e.message ? e.message : String(e));
        }
    }

    function onConnection(sock) {
        clients.add(sock);
        deps.log('bridge: client connected (' + clients.size + ')');
        let inbuf = '';
        sock.setEncoding('utf8');
        sock.on('data', chunk => {
            inbuf += chunk;
            let nl;
            while ((nl = inbuf.indexOf('\n')) >= 0) {
                const line = inbuf.slice(0, nl).trim(); inbuf = inbuf.slice(nl + 1);
                if (!line) continue;
                let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
                handle(sock, msg);
            }
        });
        const drop = () => { clients.delete(sock); deps.log('bridge: client disconnected (' + clients.size + ')'); };
        sock.on('close', drop); sock.on('error', drop);
    }

    return {
        // Listen on `port` (0 = ephemeral). Resolves to the actual port.
        listen(port) {
            return new Promise((resolve, reject) => {
                server = net.createServer(onConnection);
                server.on('error', reject);
                server.listen(port || 0, '127.0.0.1', () => resolve(server.address().port));
            });
        },
        close() {
            for (const s of clients) { try { s.destroy(); } catch (_) {} }
            clients.clear();
            if (server) { try { server.close(); } catch (_) {} server = null; }
        },
        broadcast,
        get clientCount() { return clients.size; },
    };
}

module.exports = { createBridgeServer };
