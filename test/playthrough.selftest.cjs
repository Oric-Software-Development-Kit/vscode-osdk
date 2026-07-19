'use strict';
// Mock-driven self-test of the shared playthrough core + standalone driver — proves the
// control flow (launch, waitFor arm+wait, runFrames, press/type, assertMem, screenshot,
// report) with NO emulator. Run: node test/playthrough.selftest.cjs   (exit 0 = pass)
const fs = require('fs'), path = require('path'), { EventEmitter } = require('events');
const { run } = require('./playthrough.cjs');

class MockDap extends EventEmitter {
    constructor(viz) { super(); this.stopped = true; this.mem = {}; this.child = {}; this.viz = viz; this.pendingSignal = null; }
    start() {} stop() {}
    async topFrameId() { return 1; }
    once_event(name) { return new Promise(res => this.once('dap:' + name, res)); }
    request(cmd, args) {
        return new Promise(res => {
            if (cmd === 'launch') { setTimeout(() => this.emit('dap:initialized', {}), 3); return res({}); }
            if (cmd === 'dataBreakpointInfo') return res({ dataId: String(args.name || '').replace(/^\$/, ''), description: args.name });
            if (cmd === 'oricArmValueWatch') return res({ armed: true, error: null });
            if (cmd === 'oricClearValueWatch') return res({});
            if (cmd === 'getModules') return res({ modules: [{ id: 0, name: 'Splash' }, { id: 2, name: 'Game' }], active: 2 });
            if (cmd === 'setWarp') return res({ warp: !!args.on });
            if (cmd === 'turboRun') { setTimeout(() => { this.stopped = true; this.emit('dap:stopped', { reason: 'step' }); }, 5); return res({}); }
            if (cmd === 'oricResolve') { const map = { _gCurrentLocation: { addr: 0x91 }, e_LOC_ENTRANCEHALL: { value: 23 }, e_LOC_LARGE_STAIRCASE: { value: 26 } }; const e = map[args.name]; return res(e ? Object.assign({ found: true, name: args.name, addr: null, value: null }, e) : { found: false }); }
            if (cmd === 'readMemory') { const a = parseInt(args.memoryReference, 16); return res({ data: Buffer.from([this.mem[a] || 0]).toString('base64') }); }
            if (cmd === 'evaluate') return res({ result: 'ok' });
            if (cmd === 'stackTrace') return res({ stackFrames: [{ id: 1 }] });
            if (cmd === 'continue') { this.stopped = false; this.viz.latest.frame += 100; if (this.pendingSignal) { const s = this.pendingSignal; this.pendingSignal = null; setTimeout(() => this.emit('dap:oricSignal', { id: s }), 4); } setTimeout(() => { this.stopped = true; this.emit('dap:stopped', { reason: 'data breakpoint' }); }, 8); return res({}); }
            if (cmd === 'pause') { setTimeout(() => { this.stopped = true; this.emit('dap:stopped', { reason: 'pause' }); }, 4); return res({}); }
            return res({});
        });
    }
}
class MockViz {
    constructor() { this.latest = { frame: 1, vidMode: 0, vidAddr: 0xa000, scr: Buffer.alloc(240 * 224) }; this.connected = true; }
    connect() {} disconnect() {} keyDown() {} keyUp() {} releaseAll() {} tap() {}
    frame() { return this.latest.frame; }
}
const say = m => process.stderr.write(m + '\n');

(async () => {
    const viz = new MockViz();
    const dap = new MockDap(viz);
    const outDir = path.join(__dirname, 'playthrough-out-selftest');
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    for (let i = 0; i < 224; i++) viz.latest.scr[i * 240 + (i % 240)] = 2;   // a diagonal so PNGs aren't blank

    // The script sets the mock's memory to simulate the game advancing state.
    const script = async (t) => {
        await t.warp(true);
        t.assert('active module resolves', (await t.module()) === 'Game');
        dap.mem[0x91] = 23;
        // Single boolean expression — the watched var is derived from the expression:
        await t.waitFor('_gCurrentLocation == e_LOC_ENTRANCEHALL', { timeoutMs: 3000 });
        await t.assertMem('entrance', '_gCurrentLocation', 'e_LOC_ENTRANCEHALL');
        t.screenshot('01-entrance');
        await t.press('u'.charCodeAt(0));
        dap.mem[0x91] = 26;
        // Variable + expected value form (all names resolved live, no magic numbers):
        await t.waitFor('_gCurrentLocation', 'e_LOC_LARGE_STAIRCASE', { timeoutMs: 3000 });
        await t.assertMem('staircase', '_gCurrentLocation', 'e_LOC_LARGE_STAIRCASE');
        t.screenshot('02-staircase');
        await t.type('go\n');
        // Signal checkpoint: a logpoint tagged [signal:ready] would fire this.
        dap.pendingSignal = 'ready';
        await t.waitSignal('ready', { timeoutMs: 3000 });
        t.assert('received signal "ready"', true);
    };

    const sum = await run({ port: 9999 }, script, { dap, viz, outDir });

    const png1 = fs.existsSync(path.join(outDir, '01-entrance.png'));
    const png2 = fs.existsSync(path.join(outDir, '02-staircase.png'));
    const report = fs.existsSync(path.join(outDir, 'report.json'));
    say('checks=' + sum.total + ' all-passed=' + sum.allPassed + '  png1=' + png1 + ' png2=' + png2 + ' report=' + report);
    const pass = sum.allPassed && sum.total === 4 && png1 && png2 && report;
    say(pass ? 'SELFTEST: PASS' : 'SELFTEST: FAIL');
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    process.exitCode = pass ? 0 : 1;
})().catch(e => { say('selftest error: ' + (e && e.stack || e)); process.exitCode = 2; });
