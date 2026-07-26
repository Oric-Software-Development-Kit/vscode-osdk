'use strict';
/*
 * oric-debug-client — shared client for driving the osdk-debug adapter + viz stream.
 *
 * The roadmap's "single shared RSP/viz client": one implementation used by every
 * programmatic peer — the MCP server (oric-mcp-server.cjs) and the scripted playthrough
 * test-runner (../test/playthrough.cjs). Both get the same DAP framing, viz screen/key
 * handling and PNG encoder instead of each rolling their own.
 *
 * Pure Node, no external deps. Everything logs to stderr (callers keep stdout clean).
 */

const cp = require('child_process');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');

// Wire protocol (framing, constants, palette) comes from the one shared definition.
const viz = require('./oric-viz-protocol.cjs');
const { VIZ_PORT_OFFSET, VIZ_MAGIC, SCR_W, SCR_H, SCR_SIZE, PALETTE } = viz;
const ADAPTER = path.join(__dirname, '..', 'debug_adapter.js');

let LOG = m => process.stderr.write('[oric] ' + m + '\n');
function setLog(fn) { LOG = fn || (() => {}); }

// --- Minimal PNG encoder (RGB, filter 0) — no image library needed ----------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
}
function encodePng(width, height, rgb) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    const stride = width * 3;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
// palette-index screen buffer (240x224) → scaled RGB PNG (nearest-neighbour).
function screenToPng(scr, scale) {
    scale = Math.max(1, Math.min(6, scale | 0 || 3));
    const w = SCR_W * scale, h = SCR_H * scale, stride = w * 3;
    const rgb = Buffer.alloc(w * h * 3);
    for (let y = 0; y < SCR_H; y++) for (let x = 0; x < SCR_W; x++) {
        const c = PALETTE[scr[y * SCR_W + x] & 7];
        for (let dy = 0; dy < scale; dy++) { let o = (y * scale + dy) * stride + x * scale * 3; for (let dx = 0; dx < scale; dx++) { rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; o += 3; } }
    }
    return encodePng(w, h, rgb);
}

// --- viz_stream client — sight (latest screen + frame counter) + key uplink --
class VizClient {
    constructor() { this.sock = null; this.buf = Buffer.alloc(0); this.latest = null; this.connected = false; }
    connect(host, port) {
        this.disconnect();
        const sock = net.connect(port, host);
        this.sock = sock;
        sock.on('connect', () => { this.connected = true; LOG('viz connected ' + host + ':' + port); });
        sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
        sock.on('error', e => LOG('viz error: ' + e.message));
        sock.on('close', () => { this.connected = false; });
    }
    disconnect() { if (this.sock) { try { this.sock.destroy(); } catch (_) {} this.sock = null; } this.buf = Buffer.alloc(0); }
    send(bytes) { if (this.sock && !this.sock.destroyed) { try { this.sock.write(Buffer.from(bytes)); } catch (_) {} } }
    // Key uplink frames — built by the shared protocol module (one definition of the opcodes).
    keyDown(id) { this.send(viz.keyFrame(id, 1)); }
    keyUp(id) { this.send(viz.keyFrame(id, 0)); }
    releaseAll() { this.send(viz.releaseAllFrame()); }
    tap(id, hold) { this.send(viz.tapFrame(id, hold)); }   // emulator-owned press/hold/release
    frame() { return this.latest ? this.latest.frame : -1; }
    // Framing/sizing/resync is done once in oric-viz-protocol.nextFrame(); we only decode
    // the fields this client needs (latest screen + counter). v0 has no screen (scrOff < 0).
    _parse() {
        while (true) {
            const r = viz.nextFrame(this.buf);
            this.buf = r.rest;
            if (r.status === 'need') return;
            if (r.status === 'resync') { if (r.reason === 'nomagic') return; continue; }
            if (r.scrOff >= 0) {
                const f = r.frame;
                this.latest = {
                    frame: f.readUInt32LE(4), vidMode: f[9], vidAddr: f.readUInt16LE(10),
                    scr: Buffer.from(f.slice(r.scrOff, r.scrOff + SCR_SIZE)),
                };
            }
        }
    }
}

// --- DAP client — spawns debug_adapter.js and speaks the Debug Adapter Protocol
class DapClient extends EventEmitter {
    constructor() {
        super();
        this.child = null; this.buf = Buffer.alloc(0); this.seq = 1; this.pending = new Map();
        this.output = []; this.stopped = false; this.lastStop = null; this.ended = false; this._frameId = null;
    }
    start() {
        this.child = cp.spawn(process.execPath, [ADAPTER], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stdout.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
        this.child.stderr.on('data', d => process.stderr.write('[adapter] ' + d.toString()));
        this.child.on('exit', code => { this.ended = true; this.emit('adapterExit', code); });
    }
    stop() { if (this.child) { try { this.child.kill(); } catch (_) {} this.child = null; } }
    _parse() {
        while (true) {
            const i = this.buf.indexOf('\r\n\r\n');
            if (i < 0) return;
            const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, i).toString('utf8'));
            if (!m) { this.buf = this.buf.slice(i + 4); continue; }
            const len = +m[1], start = i + 4;
            if (this.buf.length < start + len) return;
            let msg; try { msg = JSON.parse(this.buf.slice(start, start + len).toString('utf8')); } catch (_) { msg = null; }
            this.buf = this.buf.slice(start + len);
            if (msg) this._dispatch(msg);
        }
    }
    _dispatch(msg) {
        if (msg.type === 'response') {
            const p = this.pending.get(msg.request_seq);
            if (p) { this.pending.delete(msg.request_seq); msg.success ? p.resolve(msg.body || {}) : p.reject(new Error(msg.message || ('DAP ' + msg.command + ' failed'))); }
        } else if (msg.type === 'event') {
            const b = msg.body || {};
            if (msg.event === 'output') { this.output.push((b.output || '').replace(/\n$/, '')); if (this.output.length > 500) this.output.shift(); }
            else if (msg.event === 'stopped') { this.stopped = true; this._frameId = null; this.lastStop = b; }
            else if (msg.event === 'continued') { this.stopped = false; }
            else if (msg.event === 'terminated' || msg.event === 'exited') { this.ended = true; }
            this.emit('dap:' + msg.event, b);
        }
    }
    request(command, args) {
        return new Promise((resolve, reject) => {
            const seq = this.seq++;
            this.pending.set(seq, { resolve, reject });
            const json = JSON.stringify({ seq, type: 'request', command, arguments: args || {} });
            try { this.child.stdin.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json); }
            catch (e) { this.pending.delete(seq); reject(e); }
            setTimeout(() => { if (this.pending.has(seq)) { this.pending.delete(seq); reject(new Error('DAP timeout: ' + command)); } }, 20000);
        });
    }
    // Optional `filter(body)` — only a matching event resolves; non-matching ones are
    // ignored (the listener stays armed), so e.g. a manual pause doesn't satisfy a wait
    // that's after the value-watch's 'data breakpoint' stop.
    once_event(name, timeoutMs, filter) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { this.off('dap:' + name, h); reject(new Error('timeout waiting for ' + name)); }, timeoutMs || 20000);
            const h = b => { if (filter && !filter(b)) return; clearTimeout(t); this.off('dap:' + name, h); resolve(b); };
            this.on('dap:' + name, h);
        });
    }
    async topFrameId() {
        if (this._frameId != null) return this._frameId;
        const st = await this.request('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
        this._frameId = (st.stackFrames && st.stackFrames[0]) ? st.stackFrames[0].id : null;
        return this._frameId;
    }
}

// Bind a DapClient + VizClient to the `ops` interface makeApi (playthrough-core) drives.
// This is the SINGLE programmatic driver binding — shared by the standalone playthrough
// runner AND the MCP server, so both get the exact same reliable primitives (emulator-owned
// key taps, value-watch waitFor, runTo, module awareness, warp via the always-live uplink).
const _sleep = ms => new Promise(r => setTimeout(r, ms));
function makeClientOps(dap, viz) {
    return {
        async continue() { if (dap.stopped) { dap.request('continue', { threadId: 1 }).catch(() => {}); await _sleep(5); } },
        async pause() { if (!dap.stopped) { const p = dap.once_event('stopped', 4000); dap.request('pause', { threadId: 1 }).catch(() => {}); try { await p; } catch (_) {} } },
        waitStopped(ms, reason) { return dap.once_event('stopped', ms || 30000, reason ? (b => b && b.reason === reason) : null); },
        isStopped() { return dap.stopped; },
        async readMem(addr, n) { const r = await dap.request('readMemory', { memoryReference: (addr & 0xffff).toString(16), offset: 0, count: n || 1 }); return r && r.data ? Buffer.from(r.data, 'base64') : Buffer.alloc(0); },
        async evaluate(expr) { const fid = await dap.topFrameId(); const r = await dap.request('evaluate', { expression: expr, frameId: fid, context: 'repl' }); return r ? r.result : undefined; },
        sendKey(id, down) { down ? viz.keyDown(id) : viz.keyUp(id); },
        releaseKeys() { viz.releaseAll(); },
        tapKey(id, hold) { viz.tap(id, hold); },
        vizFrame() { return viz.frame(); },
        vizScreen() { return viz.latest ? viz.latest.scr : null; },
        async setWatch(addr, access, cond) {
            const info = await dap.request('dataBreakpointInfo', { name: '$' + (addr & 0xffff).toString(16) });
            if (!info || !info.dataId) throw new Error('cannot watch $' + (addr & 0xffff).toString(16));
            const bp = { dataId: info.dataId, accessType: access || 'write' };
            if (cond) bp.condition = cond;
            await dap.request('setDataBreakpoints', { breakpoints: [bp] });
        },
        async clearWatch() { await dap.request('setDataBreakpoints', { breakpoints: [] }); },
        async armValueWatch(addr, cond) {
            if (!dap.stopped) { const p = dap.once_event('stopped', 4000); dap.request('pause', { threadId: 1 }).catch(() => {}); try { await p; } catch (_) {} }
            const r = await dap.request('oricArmValueWatch', { addr: addr & 0xffff, condition: cond || null });
            if (r && r.error) throw new Error('value-watch: ' + r.error);
        },
        async clearValueWatch(addr) { await dap.request('oricClearValueWatch', { addr: addr & 0xffff }).catch(() => {}); },
        async getModules() { try { return await dap.request('getModules'); } catch (_) { return null; } },
        isUserPaused() { return false; },   // programmatic driver: no interactive user pauses
        async runTo(target, opts = {}) {
            const arg = (typeof target === 'number') ? { addr: target & 0xffff } : { symbol: String(target) };
            arg.warp = opts.warp === true;
            const stopP = dap.once_event('stopped', opts.timeoutMs || 60000);
            stopP.catch(() => {});
            await dap.request('turboRun', arg);
            await stopP;
        },
        async warp(on) { on = !!on; try { const r = await dap.request('setWarp', { on }); return r; } catch (_) { return null; } },
        waitSignal(id, ms) {
            return new Promise((resolve, reject) => {
                const to = setTimeout(() => { dap.off('dap:oricSignal', h); reject(new Error('timeout waiting for signal "' + id + '"')); }, ms || 60000);
                const h = b => { if (!id || (b && b.id === id)) { clearTimeout(to); dap.off('dap:oricSignal', h); resolve(b); } };
                dap.on('dap:oricSignal', h);
            });
        },
        async resolve(name) { try { const r = await dap.request('oricResolve', { name: String(name) }); return r && r.found ? r : null; } catch (_) { return null; } },
    };
}

// --- Collaborative bridge client -------------------------------------------------------------
// Attach to the extension-hosted bridge (bridge-server.cjs) and present the SAME DapClient /
// VizClient surfaces that makeClientOps + the MCP tools expect — but backed by the LIVE VS Code
// session. So the AI and the human share one screen / breakpoints / CPU, and every existing tool
// runs unchanged. See oric-bridge-protocol.cjs for the wire format.
const bridgeProto = require('./oric-bridge-protocol.cjs');

class BridgeClient extends EventEmitter {
    constructor() { super(); this.sock = null; this.buf = ''; this.seq = 1; this.pending = new Map(); this.connected = false; }
    connect(host, port) {
        return new Promise((resolve, reject) => {
            const sock = net.connect(port, host); this.sock = sock; sock.setEncoding('utf8');
            sock.on('connect', () => { this.connected = true; LOG('bridge connected ' + host + ':' + port); resolve(); });
            sock.on('error', e => { if (!this.connected) reject(e); else LOG('bridge error: ' + e.message); });
            sock.on('close', () => { this.connected = false; this.emit('event', { event: 'closed' }); });
            sock.on('data', c => this._onData(c));
        });
    }
    _onData(chunk) {
        this.buf += chunk; let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            let m; try { m = JSON.parse(line); } catch (_) { continue; }
            if (m.method === 'event') { this.emit('event', m.params || {}); continue; }
            if (m.id != null && this.pending.has(m.id)) {
                const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
                if (m.error) reject(Object.assign(new Error(m.error.message || 'bridge error'), { code: m.error.code, bridge: true }));
                else resolve(m.result);
            }
        }
    }
    call(method, params) {
        return new Promise((resolve, reject) => {
            if (!this.connected) return reject(new Error('bridge not connected'));
            const id = this.seq++; this.pending.set(id, { resolve, reject });
            try { this.sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'); } catch (e) { reject(e); }
        });
    }
    close() { if (this.sock) { try { this.sock.destroy(); } catch (_) {} this.sock = null; } this.connected = false; }
}

// DapClient look-alike backed by the bridge (request/once_event/stopped/lastStop/topFrameId/output).
class BridgeDapShim extends EventEmitter {
    constructor(bridge) {
        super(); this.bridge = bridge; this.stopped = false; this.ended = false; this.lastStop = null; this.output = []; this._frameId = null;
        bridge.on('event', p => this._onEvent(p));
    }
    _onEvent(p) {
        switch (p && p.event) {
            // Any of these is proof of a LIVE session, so they clear a stale `ended` left by a
            // PREVIOUS session (the shim outlives sessions: nothing else reset the flag, so a new
            // session inherited "ended" and status lied — see DOGFOODING #22).
            case 'stopped': this.ended = false; this.stopped = true; this.lastStop = p; this._frameId = null; this.emit('stopped', p); break;
            case 'continued': this.ended = false; this.stopped = false; this._frameId = null; this.emit('continued', p); break;
            case 'started': this.ended = false; this.stopped = !!(p && p.stopped); this._frameId = null; this.emit('started', p); break;
            case 'signal': this.emit('dap:oricSignal', p); break;
            case 'output': this.output.push(p.text || ''); if (this.output.length > 500) this.output.shift(); break;
            case 'ended': this.ended = true; this.emit('ended', p); break;
            case 'control': this.emit('control', p); break;
            case 'closed': this.ended = true; this.emit('closed', p); break;
        }
    }
    start() {} stop() { this.bridge.close(); }
    request(cmd, args) { return this.bridge.call('dap', { cmd, args: args || {} }); }
    customRequest(cmd, args) { return this.request(cmd, args); }
    once_event(name, ms, filter) {
        return new Promise((resolve, reject) => {
            const to = setTimeout(() => { this.off(name, h); reject(new Error('timeout waiting for ' + name)); }, ms || 30000);
            const h = b => { if (filter && !filter(b)) return; clearTimeout(to); this.off(name, h); resolve(b); };
            this.on(name, h);
        });
    }
    async topFrameId() {
        if (this._frameId != null) return this._frameId;
        try { const st = await this.request('stackTrace', { threadId: 1, startFrame: 0, levels: 1 }); this._frameId = st && st.stackFrames && st.stackFrames[0] ? st.stackFrames[0].id : null; }
        catch (_) { this._frameId = null; }
        return this._frameId;
    }
}

// VizClient look-alike backed by the bridge — polls the live frame/screen and routes key uplink
// through viz.input (which the bridge gates on the AI holding control).
class BridgeVizShim {
    constructor(bridge) { this.bridge = bridge; this.latest = null; this.connected = true; this._tick = 0; this._iv = setInterval(() => this._poll(), 120); if (this._iv.unref) this._iv.unref(); }
    async _poll() {
        try {
            const f = await this.bridge.call('viz.frame');
            const frame = f ? f.frame : (this.latest ? this.latest.frame : -1);
            // Frame counter every tick (cheap); the screen + its meta (vidMode/vidAddr) every 3rd,
            // carrying the last-known meta forward so `latest` is always fully populated (a partial
            // object was what crashed oric_screenshot's vidAddr.toString()).
            if ((this._tick++ % 3) === 0) {
                const s = await this.bridge.call('viz.screen');
                this.latest = {
                    frame,
                    vidMode: s && s.vidMode != null ? s.vidMode : (this.latest ? this.latest.vidMode : 0),
                    vidAddr: s && s.vidAddr != null ? s.vidAddr : (this.latest ? this.latest.vidAddr : 0),
                    scr: s && s.scr ? Buffer.from(s.scr, 'base64') : (this.latest ? this.latest.scr : null),
                };
            } else if (this.latest) {
                this.latest = Object.assign({}, this.latest, { frame });
            }
        } catch (_) {}
    }
    connect() {} disconnect() { if (this._iv) clearInterval(this._iv); this._iv = null; }
    send(bytes) { this.bridge.call('viz.input', { b64: Buffer.from(bytes).toString('base64') }).catch(() => {}); }
    keyDown(id) { this.send(viz.keyFrame(id, 1)); }
    keyUp(id) { this.send(viz.keyFrame(id, 0)); }
    releaseAll() { this.send(viz.releaseAllFrame()); }
    tap(id, hold) { this.send(viz.tapFrame(id, hold)); }
    frame() { return this.latest ? this.latest.frame : -1; }
}

// Find the bridge the extension advertised (.oric-bridge.json at the project root).
function readBridgeDiscovery(cwd) {
    try { const j = JSON.parse(require('fs').readFileSync(require('path').join(cwd || process.cwd(), bridgeProto.DISCOVERY_FILE), 'utf8')); return { host: j.host || '127.0.0.1', port: j.port }; }
    catch (_) { return null; }
}
// Attach: connect + return { bridge, dap, viz } shims + the hello/state. Does NOT grab control
// (the human holds it until the AI explicitly requests it).
async function attachBridge(opts = {}) {
    let host = opts.host, port = opts.port;
    if (!port) {
        const d = readBridgeDiscovery(opts.cwd);
        if (!d) throw new Error('no live session bridge found — in VS Code run "Oric: AI Collaboration — Start/Stop Bridge" (no ' + bridgeProto.DISCOVERY_FILE + ' under ' + (opts.cwd || process.cwd()) + ')');
        host = d.host; port = d.port;
    }
    const bridge = new BridgeClient();
    await bridge.connect(host || '127.0.0.1', port);
    const hello = await bridge.call('bridge.hello', {});
    const dap = new BridgeDapShim(bridge);
    // Seed the console buffer with output produced before we attached (symbol-load notes, early
    // logpoints) — an agent that starts the session itself would otherwise always see nothing.
    if (hello && Array.isArray(hello.outputBacklog) && hello.outputBacklog.length)
        dap.output.push(...hello.outputBacklog.slice(-500));
    const state = await bridge.call('bridge.state', {}).catch(() => null);
    if (state) dap.stopped = !!state.stopped;
    const vizShim = new BridgeVizShim(bridge);
    return { bridge, dap, viz: vizShim, hello, state };
}

module.exports = {
    DapClient, VizClient, encodePng, screenToPng, makeClientOps,
    BridgeClient, BridgeDapShim, BridgeVizShim, attachBridge, readBridgeDiscovery,
    ADAPTER, VIZ_PORT_OFFSET, VIZ_MAGIC, SCR_W, SCR_H, PALETTE, setLog,
};
