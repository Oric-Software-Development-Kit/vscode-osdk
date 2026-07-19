'use strict';
// Unit test for the shared viz wire-protocol framing (mcp/oric-viz-protocol.cjs) — the one
// place that sizes/resyncs frames for BOTH the extension's live socket and VizClient. No
// emulator: it synthesises v1/v2 frames and checks nextFrame's framing, versioning, screen
// offset, magic resync, partial-buffer waiting and back-to-back frames. Exit 0 = pass.
const P = require('../mcp/oric-viz-protocol.cjs');
const say = m => process.stderr.write(m + '\n');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; say('  FAIL ' + m); } else say('  ok   ' + m); };

function hdr(buf, frameCounter, version) {
    buf.writeUInt32LE(P.VIZ_MAGIC, 0);
    buf.writeUInt32LE(frameCounter, 4);
    buf[8] = 0; buf[9] = 1; buf.writeUInt16LE(0xa000, 10); buf.writeUInt16LE(0xb400, 12);
    buf.writeUInt16LE(version, 14);
}
function fillScreen(buf, off) { for (let i = 0; i < P.SCR_SIZE; i++) buf[off + i] = i & 7; }

// --- v1 frame ---------------------------------------------------------------
const v1 = Buffer.alloc(P.V1_SIZE); hdr(v1, 42, 1); fillScreen(v1, P.V0_SIZE);
let r = P.nextFrame(v1);
ok(r.status === 'frame', 'v1: a whole frame is returned (' + r.status + ')');
ok(r.version === 1, 'v1: version 1');
ok(r.scrOff === P.V0_SIZE, 'v1: screen offset = V0_SIZE (' + r.scrOff + ')');
ok(r.frame.readUInt32LE(4) === 42, 'v1: frameCounter reads back');
ok(r.frame[r.scrOff + 100] === (100 & 7), 'v1: screen byte reads back at scrOff');
ok(r.rest.length === 0, 'v1: buffer fully consumed');

// --- partial buffer waits ---------------------------------------------------
r = P.nextFrame(v1.slice(0, P.V1_SIZE - 10));
ok(r.status === 'need', 'partial v1 -> need');
ok(r.rest.length === P.V1_SIZE - 10, 'need: buffer preserved for more data');

// --- magic resync (garbage prefix) ------------------------------------------
r = P.nextFrame(Buffer.concat([Buffer.from([1, 2, 3, 4, 5]), v1]));
ok(r.status === 'resync' && r.reason === 'realign', 'garbage prefix -> resync/realign');
ok(r.skipped === 5, 'resync: skipped 5 garbage bytes');
ok(r.rest.readUInt32LE(0) === P.VIZ_MAGIC, 'resync: rest realigned to magic');

// --- under a header's worth of bytes just waits -----------------------------
r = P.nextFrame(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
ok(r.status === 'need', 'sub-16-byte buffer -> need (cannot judge magic yet)');

// --- a full header of junk with no magic: trims to last 3, waits ------------
r = P.nextFrame(Buffer.alloc(20, 0xab));
ok(r.status === 'resync' && r.reason === 'nomagic', 'no-magic junk (>=16B) -> resync/nomagic');
ok(r.rest.length === 3, 'nomagic: trims to last 3 bytes');

// --- two frames back to back ------------------------------------------------
let buf = Buffer.concat([v1, v1]);
r = P.nextFrame(buf); ok(r.status === 'frame' && r.rest.length === P.V1_SIZE, 'two frames: first pulled, one remains');
r = P.nextFrame(r.rest); ok(r.status === 'frame' && r.rest.length === 0, 'two frames: second pulled, buffer empty');

// --- v2 frame (nRuns = 0 for all three run-lists) ---------------------------
const v2size = 16 + 3 * 2 + P.SCREEN_BLOCK;
const v2 = Buffer.alloc(v2size); hdr(v2, 7, 2);
v2.writeUInt16LE(0, 16); v2.writeUInt16LE(0, 18); v2.writeUInt16LE(0, 20);
fillScreen(v2, 22);
r = P.nextFrame(v2);
ok(r.status === 'frame' && r.version === 2, 'v2: whole frame, version 2');
ok(r.scrOff === 22, 'v2: screen offset after 3 empty run-lists (' + r.scrOff + ')');
ok(r.ranges.length === 3 && r.ranges[0][0] === 16 && r.ranges[2][1] === 22, 'v2: three run-list ranges');
ok(r.frame[r.scrOff + 100] === (100 & 7), 'v2: screen byte reads back at scrOff');

// --- v2 corrupt run count -> resync/corrupt ---------------------------------
const bad = Buffer.alloc(64); hdr(bad, 0, 2); bad.writeUInt16LE(40000, 16);
r = P.nextFrame(bad);
ok(r.status === 'resync' && r.reason === 'corrupt', 'v2 absurd run count -> resync/corrupt');

say(fails === 0 ? 'VIZ-PROTOCOL SELFTEST: PASS' : 'VIZ-PROTOCOL SELFTEST: FAIL (' + fails + ')');
process.exitCode = fails === 0 ? 0 : 1;
