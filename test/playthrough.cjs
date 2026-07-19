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
const { DapClient, VizClient, VIZ_PORT_OFFSET, makeClientOps } = require('../mcp/oric-debug-client.cjs');
const { makeApi } = require('../mcp/playthrough-core.cjs');

const log = m => process.stderr.write('[play] ' + m + '\n');

// The DapClient+VizClient → `ops` binding is shared with the MCP server (makeClientOps).
const standaloneOps = makeClientOps;

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
