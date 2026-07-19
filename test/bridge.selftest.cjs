'use strict';
/* bridge.selftest — exercises the bridge server's handshake + control gate with fakes. */
const net = require('net');
const assert = require('assert');
const { createBridgeServer } = require('../mcp/bridge-server.cjs');
const { CONTROL, ERR_NO_CONTROL } = require('../mcp/oric-bridge-protocol.cjs');

function client(port) {
    const sock = net.connect(port, '127.0.0.1');
    let inbuf = '', nextId = 1; const pending = new Map();
    sock.setEncoding('utf8');
    sock.on('data', c => { inbuf += c; let nl; while ((nl = inbuf.indexOf('\n')) >= 0) { const l = inbuf.slice(0, nl).trim(); inbuf = inbuf.slice(nl + 1); if (!l) continue; const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
    return {
        call(method, params) { return new Promise(res => { const id = nextId++; pending.set(id, res); sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); },
        end() { sock.end(); },
        ready() { return new Promise(r => sock.on('connect', r)); },
    };
}

async function main() {
    let control = CONTROL.HUMAN;
    const calls = [];
    const deps = {
        customRequest: async (cmd, args) => { calls.push(cmd); return { cmd, args }; },
        hasSession: () => true,
        vizFrame: () => 1234,
        vizScreen: () => 'AAAA',
        vizInput: () => {},
        getState: () => ({ stopped: true, userPaused: false, warp: false, module: 'Game' }),
        getControl: () => control,
        setControl: o => { control = o; },
        sessionName: () => 'test-session',
        log: () => {},
    };
    const srv = createBridgeServer(deps);
    const port = await srv.listen(0);
    const c = client(port); await c.ready();

    const hello = await c.call('bridge.hello', {});
    assert.strictEqual(hello.result.ok, true);
    assert.strictEqual(hello.result.control, CONTROL.HUMAN, 'starts human-controlled');

    // observe ALWAYS allowed, even while the human holds control:
    const rd = await c.call('dap.readMemory', { memoryReference: '400', count: 4 });
    assert.strictEqual(rd.result.cmd, 'readMemory', 'observe allowed under human control');

    // control op DENIED while human holds control:
    const contDenied = await c.call('dap.continue', { threadId: 1 });
    assert.ok(contDenied.error && contDenied.error.message.includes(ERR_NO_CONTROL), 'continue denied under human control');

    // viz.input (AI keys) also denied while human holds control:
    const inDenied = await c.call('viz.input', { b64: 'AQID' });
    assert.ok(inDenied.error && inDenied.error.message.includes(ERR_NO_CONTROL), 'AI input denied under human control');

    // AI takes control -> control ops now allowed:
    const grabbed = await c.call('control.request', {});
    assert.strictEqual(grabbed.result.control, CONTROL.AI);
    const contOk = await c.call('dap.continue', { threadId: 1 });
    assert.strictEqual(contOk.result.cmd, 'continue', 'continue allowed once AI holds control');
    const inOk = await c.call('viz.input', { b64: 'AQID' });
    assert.ok(!inOk.error, 'AI input allowed once AI holds control');

    // Human reclaims -> denied again (simulates the "Take control" button):
    control = CONTROL.HUMAN;
    const contDenied2 = await c.call('dap.continue', { threadId: 1 });
    assert.ok(contDenied2.error, 'continue denied after human reclaims control');

    const st = await c.call('bridge.state', {});
    assert.strictEqual(st.result.module, 'Game');
    assert.strictEqual(st.result.frame, undefined);   // state ≠ viz.frame
    const vf = await c.call('viz.frame', {});
    assert.strictEqual(vf.result.frame, 1234);

    c.end(); srv.close();
    console.log('BRIDGE SELFTEST: PASS');
}
main().catch(e => { console.error('BRIDGE SELFTEST: FAIL', e); process.exit(1); });
