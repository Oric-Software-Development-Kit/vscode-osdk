'use strict';
/*
 * playthrough.cjs — standalone deterministic playthrough regression runner.
 *
 * Spawns its own adapter + emulator and plays a game in WARP, feeding keys and waiting on
 * game STATE (never fixed sleeps), asserting prerequisites at each checkpoint.
 *
 * The step algorithms live in ../mcp/playthrough-core.cjs (makeApi) and are SHARED with the
 * VS Code in-session automation runner — this file is just the "standalone" driver: it binds
 * the shared client (DapClient/VizClient) to the `ops` interface makeApi expects.
 *
 *   node test/playthrough.cjs <config.json>
 *
 * config.json mirrors a VS Code oric-debug launch config (port [= base+1], launchScript|
 * emulatorPath, diskImage, cwd, symbolFile, gdbBreak). Screenshots + report.json land in
 * test/playthrough-out/. Needs the conditional-watchpoint emulator build (qOricWatchCond).
 */

const fs = require('fs');
const path = require('path');
const { DapClient, VizClient, VIZ_PORT_OFFSET } = require('../mcp/oric-debug-client.cjs');
const { makeApi } = require('../mcp/playthrough-core.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => process.stderr.write('[play] ' + m + '\n');

// Bind a DapClient + VizClient to the `ops` interface the shared core drives.
function standaloneOps(dap, viz) {
    let warpOn = false;
    return {
        async continue() { if (dap.stopped) { dap.request('continue', { threadId: 1 }).catch(() => {}); await sleep(5); } },
        async pause() { if (!dap.stopped) { const p = dap.once_event('stopped', 4000); dap.request('pause', { threadId: 1 }).catch(() => {}); try { await p; } catch (_) {} } },
        waitStopped(ms, reason) { return dap.once_event('stopped', ms || 30000, reason ? (b => b && b.reason === reason) : null); },
        isStopped() { return dap.stopped; },
        async readMem(addr, n) { const r = await dap.request('readMemory', { memoryReference: (addr & 0xffff).toString(16), offset: 0, count: n || 1 }); return r && r.data ? Buffer.from(r.data, 'base64') : Buffer.alloc(0); },
        async evaluate(expr) { const fid = await dap.topFrameId(); const r = await dap.request('evaluate', { expression: expr, frameId: fid, context: 'repl' }); return r ? r.result : undefined; },
        sendKey(id, down) { down ? viz.keyDown(id) : viz.keyUp(id); },
        releaseKeys() { viz.releaseAll(); },
        tapKey(id, hold) { viz.tap(id, hold); },   // emulator-owned key tap (reliable, one at a time)
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
        // Value-watch for waitFor: stop when the byte at addr changes to satisfy cond,
        // tested against real committed memory (register/mechanism-agnostic). Halt to arm.
        async armValueWatch(addr, cond) {
            if (!dap.stopped) { const p = dap.once_event('stopped', 4000); dap.request('pause', { threadId: 1 }).catch(() => {}); try { await p; } catch (_) {} }
            const r = await dap.request('oricArmValueWatch', { addr: addr & 0xffff, condition: cond || null });
            if (r && r.error) throw new Error('value-watch: ' + r.error);
        },
        async clearValueWatch(addr) { await dap.request('oricClearValueWatch', { addr: addr & 0xffff }).catch(() => {}); },
        async getModules() { try { return await dap.request('getModules'); } catch (_) { return null; } },
        isUserPaused() { return false; },   // standalone/headless: no interactive user pauses
        async runTo(target, opts = {}) {
            const arg = (typeof target === 'number') ? { addr: target & 0xffff } : { symbol: String(target) };
            arg.warp = opts.warp === true;
            const stopP = dap.once_event('stopped', opts.timeoutMs || 60000);
            stopP.catch(() => {});
            await dap.request('turboRun', arg);
            await stopP;
        },
        async warp(on) { on = !!on; try { const r = await dap.request('setWarp', { on }); warpOn = r && typeof r.warp === 'boolean' ? r.warp : on; } catch (_) { warpOn = on; } },
        // Resolve on the next oricSignal event whose id matches (DapClient re-emits any DAP
        // event as 'dap:<event>'). Fired by a logpoint/watchpoint tagged [signal:<id>].
        waitSignal(id, ms) {
            return new Promise((resolve, reject) => {
                const to = setTimeout(() => { dap.off('dap:oricSignal', h); reject(new Error('timeout waiting for signal "' + id + '"')); }, ms || 60000);
                const h = b => { if (!id || (b && b.id === id)) { clearTimeout(to); dap.off('dap:oricSignal', h); resolve(b); } };
                dap.on('dap:oricSignal', h);
            });
        },
        // Resolve a real name (_gCurrentLocation / e_LOC_LARGE_STAIRCASE) to { addr, value, ... }
        // from the loaded debug tables, so scripts never hardcode addresses/enum values.
        async resolve(name) { try { const r = await dap.request('oricResolve', { name: String(name) }); return r && r.found ? r : null; } catch (_) { return null; } },
    };
}

// Launch a session, build the api, run a script(t), report. opts.dap/opts.viz inject mocks.
async function run(config, scriptFn, opts = {}) {
    const outDir = opts.outDir || path.join(__dirname, 'playthrough-out');
    const dap = opts.dap || new DapClient();
    dap.start();
    await dap.request('initialize', { clientID: 'oric-playthrough', adapterID: 'oric-debug', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    const lp = dap.request('launch', Object.assign({ type: 'oric-debug', request: 'launch', name: 'playthrough' }, config));
    try { await dap.once_event('initialized', 8000); await dap.request('configurationDone', {}); } catch (_) { /* late init */ }
    await lp;
    const viz = opts.viz || new VizClient();
    viz.connect(config.host || 'localhost', config.port + VIZ_PORT_OFFSET);
    for (let i = 0; i < 300 && !viz.latest; i++) await sleep(20);   // await first frame
    log('launched (gdb ' + config.port + ', viz ' + (config.port + VIZ_PORT_OFFSET) + ')');

    const t = makeApi(standaloneOps(dap, viz), { log, outDir });
    try { await scriptFn(t); } catch (e) { t.assert('playthrough completed', false, e && e.message ? e.message : String(e)); }

    const sum = t.summary();
    log('=================================================');
    log('RESULT: ' + sum.pass + '/' + sum.total + ' checks passed' + (sum.allPassed ? '' : '  *** FAILED ***'));
    try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(sum.results, null, 2)); } catch (_) {}
    try { await dap.request('disconnect', { terminateDebuggee: true }); } catch (_) {}
    viz.disconnect(); dap.stop();
    return sum;
}
module.exports = { run, standaloneOps };

// --- Example script (Encounter test build) ----------------------------------
// Adjust CONSTANTS for your build. From MARKET_GLITCH_INVESTIGATION.md: _gCurrentLocation
// is $91; e_LOC_ENTRANCEHALL=23; e_LOC_LARGE_STAIRCASE=26; the test build boots into the
// entrance and "U" climbs the staircase.
const LOC = 0x91, LOC_ENTRANCE = 23, LOC_STAIRCASE = 26, KEY_U = 'u'.charCodeAt(0);

async function exampleScript(t) {
    await t.warp(true);
    await t.waitFor(LOC, 'A == ' + LOC_ENTRANCE, { timeoutMs: 20000 });
    await t.assertMem('boots into entrance ($91 == 23)', LOC, LOC_ENTRANCE);
    t.screenshot('01-entrance');
    await t.press(KEY_U);
    await t.waitFor(LOC, 'A == ' + LOC_STAIRCASE, { timeoutMs: 20000 });
    await t.assertMem('U climbs to staircase ($91 == 26)', LOC, LOC_STAIRCASE);
    t.screenshot('02-staircase');
}

async function main() {
    const cfgPath = process.argv[2];
    if (!cfgPath) {
        process.stderr.write('usage: node test/playthrough.cjs <config.json>  (oric-debug launch config; port = base gdb port + 1)\n');
        process.exit(2);
    }
    const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const sum = await run(config, exampleScript);
    process.exit(sum.allPassed ? 0 : 1);
}
if (require.main === module) main().catch(e => { process.stderr.write('playthrough error: ' + (e && e.stack || e) + '\n'); process.exit(2); });
