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

module.exports = {
    DapClient, VizClient, encodePng, screenToPng,
    ADAPTER, VIZ_PORT_OFFSET, VIZ_MAGIC, SCR_W, SCR_H, PALETTE, setLog,
};
