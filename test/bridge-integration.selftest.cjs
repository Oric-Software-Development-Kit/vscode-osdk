'use strict';
/* bridge-integration.selftest — drives the MCP attach client (attachBridge + shims + makeClientOps)
 * against a real bridge server with fake session/viz, so both halves are exercised end to end
 * without VS Code or an emulator. */
const assert = require('assert');
const { createBridgeServer } = require('../mcp/bridge-server.cjs');
const { attachBridge, makeClientOps } = require('../mcp/oric-debug-client.cjs');
const { makeApi } = require('../mcp/playthrough-core.cjs');
const { CONTROL } = require('../mcp/oric-bridge-protocol.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    let control = CONTROL.HUMAN;
    const seen = [];
    // Fake live session: readMemory returns bytes; continue is a control op; stackTrace gives a frame.
    const srv = createBridgeServer({
        customRequest: async (cmd, args) => {
            seen.push(cmd);
            if (cmd === 'readMemory') return { data: Buffer.from([0x1a, 0x2b]).toString('base64') };
            if (cmd === 'stackTrace') return { stackFrames: [{ id: 7, name: 'main' }] };
            if (cmd === 'evaluate') return { result: '42' };
            return { ok: true, cmd, args };
        },
        hasSession: () => true,
        vizFrame: () => 500,
        vizScreen: () => Buffer.alloc(8, 9).toString('base64'),
        vizMeta: () => ({ frame: 500, vidMode: 4, vidAddr: 0xa000 }),
        vizInput: () => {},
        getState: () => ({ stopped: true, userPaused: false, warp: false, module: 'Game' }),
        getControl: () => control, setControl: o => { control = o; },
        sessionName: () => 'live', log: () => {},
    });
    const port = await srv.listen(0);

    const a = await attachBridge({ host: '127.0.0.1', port });
    assert.strictEqual(a.hello.control, CONTROL.HUMAN);
    assert.strictEqual(a.dap.stopped, true, 'seeded stopped from bridge.state');

    // Observation through the DAP shim works while the human holds control:
    const mem = await a.dap.request('readMemory', { memoryReference: '400', count: 2 });
    assert.strictEqual(Buffer.from(mem.data, 'base64')[1], 0x2b);
    const fid = await a.dap.topFrameId();
    assert.strictEqual(fid, 7);

    // The viz shim polls the live frame/screen:
    await sleep(200);
    assert.strictEqual(a.viz.frame(), 500, 'viz frame polled');
    assert.ok(a.viz.latest && a.viz.latest.scr && a.viz.latest.scr.length === 8, 'viz screen polled');
    // Regression: latest must carry vidMode/vidAddr, else oric_screenshot's vidAddr.toString() crashes.
    assert.strictEqual(a.viz.latest.vidMode, 4, 'vidMode forwarded');
    assert.strictEqual(a.viz.latest.vidAddr, 0xa000, 'vidAddr forwarded');
    assert.doesNotThrow(() => (a.viz.latest.vidAddr).toString(16), 'vidAddr is a number (screenshot-safe)');

    // Control op DENIED while human holds control (bridge rejects; shim surfaces the error):
    let denied = false;
    try { await a.dap.request('continue', { threadId: 1 }); } catch (e) { denied = /NO_CONTROL/.test(e.message); }
    assert.ok(denied, 'continue rejected while human controls');

    // Request control -> now allowed:
    const rc = await a.bridge.call('control.request', {});
    assert.strictEqual(rc.control, CONTROL.AI);
    const cont = await a.dap.request('continue', { threadId: 1 });
    assert.ok(cont.ok, 'continue allowed once AI holds control');

    // makeClientOps binds cleanly and drives real ops through the shims:
    const t = makeApi(makeClientOps(a.dap, a.viz), { log: () => {} });
    const b = await t.read(0x400, 2);
    assert.strictEqual(b[0], 0x1a, 't.read via bridge');
    assert.strictEqual(await t.eval('_x'), '42', 't.eval via bridge');

    a.viz.disconnect(); a.bridge.close(); srv.close();
    console.log('BRIDGE INTEGRATION SELFTEST: PASS');
}
main().catch(e => { console.error('BRIDGE INTEGRATION SELFTEST: FAIL', e); process.exit(1); });
