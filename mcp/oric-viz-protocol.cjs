'use strict';
/*
 * oric-viz-protocol — the ONE JS definition of Oricutron's viz_stream wire protocol.
 *
 * The emulator's viz_stream.c is the far-socket authority; this mirrors it so every JS
 * peer frames, sizes and resyncs frames identically instead of each rolling its own:
 *   - the extension's live viz socket (extension.js) — feeds the Screen View / heatmap,
 *   - the shared VizClient (oric-debug-client.cjs) — used by the MCP server + playthrough.
 * Change the wire format in viz_stream.c → change it HERE once. (Key-injection ids live in
 * the sibling oric-keys.cjs; this module owns the framing + screen/heat layout + uplink.)
 */

// The viz server listens at gdb_port + VIZ_PORT_OFFSET (viz_init in viz_stream.c), so the
// two ports sit adjacent and a free-port scan can require the neighbour free too.
const VIZ_PORT_OFFSET = 1;
const VIZ_MAGIC = 0x4349564f;                 // "OVIC" little-endian — frame header[0..3]

// Screen: 8-colour palette-index buffer, 240x224.
const SCR_W = 240, SCR_H = 224, SCR_SIZE = SCR_W * SCR_H;   // 53760
const PALETTE = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];

// Frame block sizes (bytes). Header = 16 bytes. The "screen block" (present from v1) is the
// screen buffer + the 4 video base regs + the two live video-RAM windows.
const VIZ_VIDBASES = 8, VIZ_VIDRAM_MAIN = 8000, VIZ_VIDRAM_BOTTOM = 120;
const SCREEN_BLOCK = SCR_SIZE + VIZ_VIDBASES + VIZ_VIDRAM_MAIN + VIZ_VIDRAM_BOTTOM;
const V0_SIZE = 16 + 65536 * 3;               // v0: header + 3 full heat arrays (read/write/ula)
const V1_SIZE = V0_SIZE + SCREEN_BLOCK;        // v1: v0 + screen block

// Keyboard/input uplink frames (client -> emulator), decoded by viz_process_input in
// viz_stream.c: [op][len][payload]. KEY payload = [keyid, down]; RELEASE_ALL has none.
const UPLINK_KEY = 0x01, UPLINK_RELEASE_ALL = 0x02;
function keyFrame(id, down) { return [UPLINK_KEY, 0x02, id & 0xff, down ? 1 : 0]; }
function releaseAllFrame() { return [UPLINK_RELEASE_ALL, 0x00]; }

// Pull the next complete frame from an accumulated RX buffer. This centralises the fiddly
// part — magic resync + per-version sizing — so callers never re-derive byte offsets. Each
// caller decodes only the fields it needs from `frame` (base64 for webviews, Buffer for
// Node; that formatting stays local). Returns exactly one of:
//   { status: 'need',   rest }                                   not enough bytes yet
//   { status: 'resync', rest, skipped, reason }                  bad/again — realign & retry
//                        reason: 'realign' (magic found ahead) | 'nomagic' (none yet, waiting)
//                                | 'corrupt' (v2 run-count desync)
//   { status: 'frame',  frame, rest, version, scrOff, ranges }   one whole frame
//                        scrOff = screen-block offset (-1 for v0, which has no screen);
//                        ranges = the three v2 heat run-list [start,end) byte ranges ([] pre-v2)
function nextFrame(buf) {
    if (buf.length < 16) return { status: 'need', rest: buf };
    if (buf.readUInt32LE(0) !== VIZ_MAGIC) {
        let found = -1;
        for (let i = 1; i + 4 <= buf.length; i++) { if (buf.readUInt32LE(i) === VIZ_MAGIC) { found = i; break; } }
        if (found < 0) return { status: 'resync', rest: buf.slice(Math.max(0, buf.length - 3)), skipped: buf.length - 3, reason: 'nomagic' };
        return { status: 'resync', rest: buf.slice(found), skipped: found, reason: 'realign' };
    }
    const version = buf.readUInt16LE(14);
    if (version >= 2) {
        // Variable length: three count-prefixed heat run-lists, then the screen block.
        let hoff = 16;
        const ranges = [];
        for (let a = 0; a < 3; a++) {
            if (buf.length < hoff + 2) return { status: 'need', rest: buf };
            const nRuns = buf.readUInt16LE(hoff);
            if (nRuns > 32768) return { status: 'resync', rest: buf.slice(1), skipped: 1, reason: 'corrupt' }; // > producer max => desync
            const bytes = 2 + nRuns * 4;
            if (buf.length < hoff + bytes) return { status: 'need', rest: buf };
            ranges.push([hoff, hoff + bytes]);
            hoff += bytes;
        }
        const frameSize = hoff + SCREEN_BLOCK;
        if (buf.length < frameSize) return { status: 'need', rest: buf };
        return { status: 'frame', frame: buf.slice(0, frameSize), rest: buf.slice(frameSize), version, scrOff: hoff, ranges };
    }
    // Legacy v0/v1: fixed size, full heat arrays.
    const frameSize = version >= 1 ? V1_SIZE : V0_SIZE;
    if (buf.length < frameSize) return { status: 'need', rest: buf };
    return { status: 'frame', frame: buf.slice(0, frameSize), rest: buf.slice(frameSize), version, scrOff: version >= 1 ? V0_SIZE : -1, ranges: [] };
}

module.exports = {
    VIZ_PORT_OFFSET, VIZ_MAGIC, SCR_W, SCR_H, SCR_SIZE, PALETTE,
    VIZ_VIDBASES, VIZ_VIDRAM_MAIN, VIZ_VIDRAM_BOTTOM, SCREEN_BLOCK, V0_SIZE, V1_SIZE,
    UPLINK_KEY, UPLINK_RELEASE_ALL, keyFrame, releaseAllFrame, nextFrame,
};
