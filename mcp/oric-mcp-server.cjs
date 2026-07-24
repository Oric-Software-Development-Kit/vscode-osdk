#!/usr/bin/env node
/*
 * oric-mcp-server — an MCP server that lets an AI assistant debug Oric code by driving
 * the EXISTING osdk-debug adapter (Approach A), instead of hand-flailing raw GDB RSP.
 *
 * Architecture (two channels to Oricutron, same as VS Code uses):
 *   - DAP over stdio to a spawned `debug_adapter.js` child  → symbol/source-aware
 *     debugging: launch, breakpoints, stepping (C + asm), evaluate, registers, stack.
 *   - viz_stream TCP socket (gdb port + 1), connected directly → SIGHT (screenshot,
 *     the 240x224 screen buffer → PNG) and INPUT (keyboard injection uplink frames).
 *
 * The adapter does all the hard translation already; this server is a thin, LLM-friendly
 * façade over it plus the viz sight/input the adapter doesn't expose.
 *
 * Self-contained: pure Node, no external dependencies (MCP JSON-RPC, DAP framing, viz
 * parsing and a minimal PNG encoder are all inline).
 *
 * Run:   node mcp/oric-mcp-server.cjs
 * Then register it with your MCP client (see mcp/README.md). Convention: point the
 * launch config's `port` at the human's base gdb port + 1 so the agent's own Oricutron
 * doesn't fight a human debug session.
 */

'use strict';

const path = require('path');
const { DapClient, VizClient, screenToPng, VIZ_PORT_OFFSET, ADAPTER, setLog, makeClientOps, attachBridge } = require('./oric-debug-client.cjs');
const { makeApi } = require('./playthrough-core.cjs');

// Everything that is not JSON-RPC MUST go to stderr — stdout is the MCP channel.
function log(...a) { process.stderr.write('[oric-mcp] ' + a.join(' ') + '\n'); }
setLog(m => log(m));   // route the shared client log through ours


// ---------------------------------------------------------------------------
// Session — ties a DAP client + viz client together, tracks breakpoints.
// ---------------------------------------------------------------------------
const session = {
    dap: null, viz: null, t: null, config: null, host: 'localhost', port: null,
    bpByFile: new Map(),        // file -> Map(line -> {condition?})
    watchpoints: new Map(),     // addrHex -> { accessType, condition }
    // Collaborative attach: when set, we're sharing the human's LIVE VS Code session via the
    // bridge (not running our own emulator). `control` tracks who pilots execution.
    bridge: null, attached: false, control: 'human',
};

// Normalise an address argument ("$94" / "0x94" / "94" / 148) to lowercase hex, no prefix.
function normAddr(a) {
    if (typeof a === 'number') return (a & 0xffff).toString(16);
    return String(a).trim().replace(/^\$/, '').replace(/^0x/i, '').toLowerCase();
}

async function launch(config) {
    if (session.dap) await shutdown();
    const cfg = Object.assign({ type: 'oric-debug', request: 'launch', name: 'oric-mcp' }, config);
    if (!cfg.port) throw new Error('config.port is required (use the human base gdb port + 1)');
    session.config = cfg; session.port = cfg.port; session.host = cfg.host || 'localhost';
    session.dap = new DapClient(); session.dap.start();
    await session.dap.request('initialize', {
        clientID: 'oric-mcp', adapterID: 'oric-debug', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
        supportsRunInTerminalRequest: false,
    });
    const launchP = session.dap.request('launch', cfg);
    try { await session.dap.once_event('initialized', 8000); await session.dap.request('configurationDone', {}); } catch (_) { /* some adapters send it late */ }
    await launchP;
    // viz sits at gdb port + 1; give the emulator a beat to open it, then connect.
    session.viz = new VizClient();
    const connectViz = () => session.viz.connect(session.host, session.port + VIZ_PORT_OFFSET);
    connectViz(); setTimeout(() => { if (!session.viz.connected) connectViz(); }, 1500);
    // The reliable control center: the SAME makeApi(ops) the VS Code automation uses — so the
    // MCP's keys go through the emulator TAP queue, warp through the always-live uplink, plus
    // runTo / value-watch waitFor / module awareness. One core, one set of guarantees.
    session.t = makeApi(makeClientOps(session.dap, session.viz), { log: m => log(m) });
    return { launched: true, port: session.port, vizPort: session.port + VIZ_PORT_OFFSET };
}

// Attach to the human's LIVE VS Code session via the bridge (collaborative mode). Unlike
// launch(), this does NOT start an emulator — it shares the one the human is driving, so both
// see the same screen/breakpoints/CPU. Starts observe-only; call oric_request_control to pilot.
async function attach(opts) {
    if (session.dap) await shutdown();
    const a = await attachBridge({ cwd: (opts && opts.cwd) || process.cwd(), host: opts && opts.host, port: opts && opts.port });
    session.bridge = a.bridge; session.dap = a.dap; session.viz = a.viz; session.attached = true;
    session.control = (a.hello && a.hello.control) || 'human';
    // Track control changes the human makes (e.g. clicking "Take control"), and session end.
    a.dap.on('control', p => { session.control = p && p.control ? p.control : 'human'; });
    a.dap.on('ended', () => { session.control = 'human'; });
    session.t = makeApi(makeClientOps(session.dap, session.viz), { log: m => log(m) });
    return { attached: true, session: a.hello && a.hello.session, control: session.control, hasSession: a.hello && a.hello.hasSession };
}

async function setControl(want) {
    if (!session.attached || !session.bridge) throw new Error('not attached to a live session (use oric_attach)');
    const r = await session.bridge.call(want === 'ai' ? 'control.request' : 'control.release', {});
    session.control = (r && r.control) || want;
    return session.control;
}

async function shutdown() {
    if (session.attached) {
        // NEVER terminate the human's session. Just hand control back and disconnect the bridge.
        try { if (session.control === 'ai') await session.bridge.call('control.release', {}); } catch (_) {}
        try { if (session.viz) session.viz.disconnect(); } catch (_) {}
        try { if (session.bridge) session.bridge.close(); } catch (_) {}
    } else {
        try { if (session.dap) await session.dap.request('disconnect', { terminateDebuggee: true }); } catch (_) {}
        if (session.viz) session.viz.disconnect();
        if (session.dap) session.dap.stop();
    }
    session.dap = null; session.viz = null; session.t = null; session.bridge = null; session.attached = false; session.control = 'human';
    session.bpByFile.clear(); session.watchpoints.clear();
    return { shutdown: true };
}

function requireSession() { if (!session.dap) throw new Error('no session — call oric_launch first'); }

// Re-send the full watchpoint set (DAP setDataBreakpoints replaces all). Each address
// is resolved to a dataId via dataBreakpointInfo, then armed with its optional condition.
async function resendWatchpoints() {
    const bps = [];
    for (const [addrHex, o] of session.watchpoints) {
        const info = await session.dap.request('dataBreakpointInfo', { name: '$' + addrHex });
        if (!info.dataId) continue;
        const b = { dataId: info.dataId, accessType: o.accessType || 'write' };
        if (o.condition) b.condition = o.condition;
        bps.push(b);
    }
    const res = await session.dap.request('setDataBreakpoints', { breakpoints: bps });
    return res.breakpoints || [];
}

async function resendBreakpoints(file) {
    const lines = [...(session.bpByFile.get(file) || new Map()).entries()];
    const res = await session.dap.request('setBreakpoints', {
        source: { path: file },
        breakpoints: lines.map(([line, o]) => (o && o.condition ? { line, condition: o.condition } : { line })),
    });
    return res.breakpoints || [];
}

// A compact one-line "where are we" summary from the top frame.
async function whereString() {
    if (!session.dap.stopped) return session.dap.ended ? 'ended' : 'running';
    try {
        const st = await session.dap.request('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
        const f = st.stackFrames && st.stackFrames[0];
        if (!f) return 'stopped';
        const loc = f.source && f.source.path ? (path.basename(f.source.path) + ':' + f.line) : '';
        const reason = session.dap.lastStop && session.dap.lastStop.reason ? session.dap.lastStop.reason : 'stop';
        return 'stopped (' + reason + ') at ' + f.name + (loc ? '  ' + loc : '');
    } catch (e) { return 'stopped'; }
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------
const T = (text) => ({ content: [{ type: 'text', text }] });

// Tools that DRIVE execution / mutate breakpoints / send keys — gated on holding control when
// attached to the human's live session. Everything else is observation and always allowed.
const CONTROL_TOOLS = new Set([
    'oric_continue', 'oric_pause', 'oric_step_over', 'oric_step_into', 'oric_step_out',
    'oric_step_back', 'oric_reverse', 'oric_set_breakpoint', 'oric_clear_breakpoints',
    'oric_watch_memory', 'oric_clear_watchpoints', 'oric_send_keys', 'oric_press',
    'oric_warp', 'oric_wait_for', 'oric_run_to', 'oric_run_frames', 'oric_wait_module',
    'oric_restore_snapshot', 'oric_save_snapshot',
]);

const TOOLS = {
    oric_launch: {
        description: 'Build (if stale) and launch Oricutron under the debugger, then connect. `config` mirrors a VS Code oric-debug launch config: { port, emulatorPath|launchScript, diskImage?, symbolFile?, cwd?, gdbBreak?, emulatorArgs?, build? }. IMPORTANT: set `port` to the human base gdb port + 1 so this agent runs its own emulator.',
        schema: { type: 'object', properties: { config: { type: 'object' } }, required: ['config'] },
        run: async a => { const r = await launch(a.config || {}); return T('Launched. gdb ' + r.port + ', viz ' + r.vizPort + '. ' + await whereString()); },
    },
    oric_shutdown: {
        description: 'End the session. If launched, terminates the emulator; if ATTACHED (collaborative), just detaches — the human\'s session keeps running.',
        schema: { type: 'object', properties: {} },
        run: async () => { await shutdown(); return T('Shut down.'); },
    },
    oric_attach: {
        description: 'COLLABORATIVE mode: attach to the human\'s LIVE VS Code debug session instead of launching your own emulator, so you both share ONE screen / breakpoints / CPU. Requires the human to have started "Oric: AI Collaboration — Start/Stop Bridge" in VS Code (found automatically via .oric-bridge.json in `cwd`). You start OBSERVE-ONLY (screenshots, reads, backtrace, evaluate) — the human keeps control until you call oric_request_control. Their keyboard into the game always works.',
        schema: { type: 'object', properties: { cwd: { type: 'string', description: 'project root holding .oric-bridge.json (default: server cwd)' }, host: { type: 'string' }, port: { type: 'number', description: 'override discovery' } } },
        run: async a => {
            const r = await attach(a || {});
            return T('Attached to the live VS Code session (' + (r.session || 'oric-debug') + ')' + (r.hasSession ? '' : ' — NOTE: no oric-debug session is active yet; the human should press F5') +
                '. Control: ' + r.control + ' (you are observe-only until you call oric_request_control). ' + (r.hasSession ? await whereString() : ''));
        },
    },
    oric_request_control: {
        description: 'Ask to pilot execution (pause/continue/step/breakpoints/keys) in the shared session. Sets the Screen View indicator to "AI piloting"; the human can reclaim any time by clicking "Take control". Only meaningful when attached.',
        schema: { type: 'object', properties: {} },
        run: async () => { const c = await setControl('ai'); return T('Control: ' + c + (c === 'ai' ? '. You are now piloting — the human can take it back any time.' : ' (the human still holds control).')); },
    },
    oric_release_control: {
        description: 'Hand debug control back to the human (you stay attached and can still observe).',
        schema: { type: 'object', properties: {} },
        run: async () => { const c = await setControl('human'); return T('Control handed back — now: ' + c + '.'); },
    },
    oric_status: {
        description: 'Current run state: running / stopped (with reason + top frame + source location) / ended.',
        schema: { type: 'object', properties: {} },
        run: async () => { requireSession(); return T(await whereString()); },
    },
    oric_continue:      cmd('continue',        b => ({ threadId: 1 }), 'Resume execution.'),
    oric_pause:         cmd('pause',           () => ({ threadId: 1 }), 'Halt the running emulator.'),
    oric_step_over:     cmd('next',            () => ({ threadId: 1 }), 'Step over one source line / instruction.'),
    oric_step_into:     cmd('stepIn',          () => ({ threadId: 1 }), 'Step into a call.'),
    oric_step_out:      cmd('stepOut',         () => ({ threadId: 1 }), 'Run until the current function returns.'),
    oric_step_back:     cmd('stepBack',        () => ({ threadId: 1 }), 'Reverse one step (time-travel history).'),
    oric_reverse:       cmd('reverseContinue', () => ({ threadId: 1 }), 'Run backwards to the previous stop.'),

    oric_list_snapshots: {
        description: 'List saved machine-state snapshots (name + save time), newest first. Observe-only — works whether or not you hold control.',
        schema: { type: 'object', properties: {} },
        run: async () => {
            requireSession();
            const r = await session.dap.request('listSnapshots', {});
            const list = (r && r.snapshots) || [];
            return T(list.length ? ('Snapshots:\n' + list.map(s => '• ' + s.name).join('\n')) : 'No snapshots saved.');
        },
    },
    oric_restore_snapshot: {
        description: 'Restore (reload) a saved snapshot by name, rewinding the whole machine to that state, then stop. Requires control — during a collaborative session the human\'s snapshot controls are locked while you pilot, so restoring is your job.',
        schema: { type: 'object', properties: { name: { type: 'string', description: 'snapshot name (see oric_list_snapshots)' } }, required: ['name'] },
        run: async a => {
            requireSession();
            await session.dap.request('restoreSnapshot', { name: a.name });
            return T('Restored snapshot "' + a.name + '". ' + await whereString());
        },
    },
    oric_save_snapshot: {
        description: 'Save the current machine state as a named snapshot (checkpoint you can roll back to with oric_restore_snapshot). Requires control.',
        schema: { type: 'object', properties: { name: { type: 'string', description: 'name for the snapshot' } }, required: ['name'] },
        run: async a => {
            requireSession();
            const r = await session.dap.request('saveSnapshot', { name: a.name });
            return T('Saved snapshot "' + ((r && r.name) || a.name) + '".');
        },
    },

    oric_set_breakpoint: {
        description: 'Set a source breakpoint at file:line, with an optional native condition expression (e.g. "X == 30" or "e->hp < 0"). Returns whether it bound (verified).',
        schema: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, condition: { type: 'string' } }, required: ['file', 'line'] },
        run: async a => {
            requireSession();
            // ATTACHED: go through VS Code's OWN breakpoint model so it lands in the human's panel
            // (and VS Code syncs the adapter) — not the MCP's private set behind VS Code's back.
            if (session.attached) {
                await session.bridge.call('bp.set', { file: a.file, line: a.line, condition: a.condition || null });
                return T('Breakpoint ' + a.file + ':' + a.line + (a.condition ? ' if ' + a.condition : '') + ' added to the shared panel (binds when its module is loaded).');
            }
            if (!session.bpByFile.has(a.file)) session.bpByFile.set(a.file, new Map());
            session.bpByFile.get(a.file).set(a.line, a.condition ? { condition: a.condition } : {});
            const bps = await resendBreakpoints(a.file);
            const mine = bps.find(b => b.line === a.line) || bps[bps.length - 1];
            return T('Breakpoint ' + a.file + ':' + a.line + (a.condition ? ' if ' + a.condition : '') + ' — ' + (mine && mine.verified ? 'bound' : 'NOT bound (unverified)'));
        },
    },
    oric_clear_breakpoints: {
        description: 'Clear breakpoints in one file (pass `file`) or ALL breakpoints (omit it). In collaborative mode this clears the human\'s VS Code Breakpoints panel too, not just this session\'s.',
        schema: { type: 'object', properties: { file: { type: 'string' } } },
        run: async a => {
            requireSession();
            if (session.attached) {
                const r = await session.bridge.call('bp.clearAll', a.file ? { file: a.file } : {});
                return T('Cleared ' + (a.file ? a.file : 'ALL breakpoints') + ' from the shared VS Code panel (' + ((r && r.removed) || 0) + ' removed).');
            }
            const files = a.file ? [a.file] : [...session.bpByFile.keys()];
            for (const f of files) { session.bpByFile.set(f, new Map()); await resendBreakpoints(f); session.bpByFile.delete(f); }
            return T('Cleared ' + (a.file ? a.file : 'all files') + '.');
        },
    },
    oric_list_breakpoints: {
        description: 'List breakpoints. In collaborative mode this is the human\'s VS Code panel (the ones you both see); standalone it\'s the ones this session set.',
        schema: { type: 'object', properties: {} },
        run: async () => {
            requireSession();
            if (session.attached) {
                const r = await session.bridge.call('bp.list', {});
                const out = (r && r.breakpoints || []).map(b => path.basename(b.file) + ':' + b.line + (b.condition ? '  if ' + b.condition : '') + (b.enabled ? '' : '  (disabled)'));
                return T(out.length ? out.join('\n') : '(none)');
            }
            const out = [];
            for (const [f, m] of session.bpByFile) for (const [line, o] of m) out.push(path.basename(f) + ':' + line + (o.condition ? '  if ' + o.condition : ''));
            return T(out.length ? out.join('\n') : '(none)');
        },
    },
    oric_watch_memory: {
        description: 'Arm a memory watchpoint at an address with an optional NATIVE condition — the emulator runs full-speed and only halts on a matching access. Perfect for a rare intermittent: e.g. watch write $0094 with condition "A == $10 && *$91 != 0" to stop exactly when the market image id is about to be written while not at the market. For a WRITE watch the condition sees the value about to be stored in A. accessType: write (default) | read | readWrite.',
        schema: { type: 'object', properties: { address: { type: 'string' }, accessType: { type: 'string' }, condition: { type: 'string' } }, required: ['address'] },
        run: async a => {
            requireSession();
            const addrHex = normAddr(a.address);
            session.watchpoints.set(addrHex, { accessType: a.accessType || 'write', condition: a.condition || null });
            const bps = await resendWatchpoints();
            const bad = bps.filter(b => !b.verified).map(b => b.message).filter(Boolean);
            return T('Watch ' + (a.accessType || 'write') + ' $' + addrHex + (a.condition ? ' if ' + a.condition : '') +
                ' — ' + (bad.length ? 'PROBLEM: ' + bad.join('; ') : 'armed (full-speed until it fires)'));
        },
    },
    oric_clear_watchpoints: {
        description: 'Remove all memory watchpoints.',
        schema: { type: 'object', properties: {} },
        run: async () => { requireSession(); session.watchpoints.clear(); await session.dap.request('setDataBreakpoints', { breakpoints: [] }); return T('Cleared watchpoints.'); },
    },
    oric_read_memory: {
        description: 'Read raw bytes at an address (hex like "$94"/"0x94"/"94"). Returns space-separated hex bytes.',
        schema: { type: 'object', properties: { address: { type: 'string' }, count: { type: 'number' } }, required: ['address'] },
        run: async a => {
            requireSession();
            const addrHex = normAddr(a.address);
            const res = await session.dap.request('readMemory', { memoryReference: addrHex, offset: 0, count: a.count || 1 });
            const bytes = res.data ? Buffer.from(res.data, 'base64') : Buffer.alloc(0);
            const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
            return T('$' + addrHex + ': ' + (hex || '(no data)'));
        },
    },
    oric_evaluate: {
        description: 'Evaluate an expression in the stopped context — symbols, registers (A X Y SP PC + flags), memory, and C-style (TYPE)EXPR casts all resolve. Returns the formatted value.',
        schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
        run: async a => {
            requireSession();
            const frameId = await session.dap.topFrameId();
            const r = await session.dap.request('evaluate', { expression: a.expression, frameId, context: 'repl' });
            return T(a.expression + ' = ' + (r.result != null ? r.result : '(no result)'));
        },
    },
    oric_registers: {
        description: 'Read the 6502 registers and flags at the current stop.',
        schema: { type: 'object', properties: {} },
        run: async () => {
            requireSession();
            const frameId = await session.dap.topFrameId();
            const scopes = await session.dap.request('scopes', { frameId });
            const reg = (scopes.scopes || []).find(s => /reg/i.test(s.name)) || (scopes.scopes || [])[0];
            if (!reg) return T('(no register scope)');
            const vars = await session.dap.request('variables', { variablesReference: reg.variablesReference });
            return T((vars.variables || []).map(v => v.name + '=' + v.value).join('  '));
        },
    },
    oric_backtrace: {
        description: 'Call stack at the current stop (symbol + source line per frame).',
        schema: { type: 'object', properties: { levels: { type: 'number' } } },
        run: async a => {
            requireSession();
            const st = await session.dap.request('stackTrace', { threadId: 1, startFrame: 0, levels: a.levels || 16 });
            const out = (st.stackFrames || []).map((f, i) => '#' + i + ' ' + f.name + (f.source && f.source.path ? '  ' + path.basename(f.source.path) + ':' + f.line : ''));
            return T(out.length ? out.join('\n') : '(no stack)');
        },
    },
    oric_get_output: {
        description: 'Recent debug-console output, including logpoint / trace lines the program has printed.',
        schema: { type: 'object', properties: { maxLines: { type: 'number' } } },
        run: async a => { requireSession(); const n = a.maxLines || 50; const o = session.dap.output.slice(-n); return T(o.length ? o.join('\n') : '(no output)'); },
    },
    oric_screenshot: {
        description: 'Capture the current Oric screen as a PNG so you can SEE what the program is displaying. `scale` (1-6, default 3) enlarges for legibility.',
        schema: { type: 'object', properties: { scale: { type: 'number' } } },
        run: async a => {
            requireSession();
            const L = session.viz && session.viz.latest;
            if (!L || !L.scr) return { content: [{ type: 'text', text: 'No screen frame yet (viz not connected or no frame received). Is the emulator running? In attach mode, give the bridge a moment after oric_attach.' }], isError: true };
            const png = screenToPng(L.scr, a.scale || 3);
            const mode = ((L.vidMode || 0) & 4) ? 'HIRES' : 'TEXT';
            const vid = (L.vidAddr != null ? L.vidAddr : 0).toString(16);
            return { content: [
                { type: 'text', text: 'Oric screen — frame ' + (L.frame != null ? L.frame : '?') + ', ' + mode + ', vid $' + vid },
                { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            ] };
        },
    },
    oric_send_keys: {
        description: 'Type text into the Oric RELIABLY. Each key is played by the emulator itself — pressed and held a guaranteed number of keyboard scans, one at a time — so keystrokes are not dropped regardless of speed/warp (unlike naive injection). "\\n" (or "\\r") sends Return. The machine runs while typing.',
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        run: async a => { requireSession(); await session.t.type(String(a.text)); return T('Typed ' + JSON.stringify(String(a.text)) + '.'); },
    },
    oric_press: {
        description: 'Press one key reliably (emulator-held tap). `key` is a letter ("a"), a NAME ("RETURN"/"ESC"/"UP"/"DOWN"/"LEFT"/"RIGHT"/"SPACE"/"CTRL"/"SHIFT"/"TAB"/"KEY_RETURN"), or a numeric code. Use for attract-mode skips / menus.',
        schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        run: async a => { requireSession(); await session.t.press(a.key); return T('Pressed ' + a.key + '.'); },
    },
    oric_warp: {
        description: 'Set fast-forward (turbo) on/off. Applies IMMEDIATELY even while running (goes through the always-live control channel, not the halted-only debug stub). Speeds up long waits.',
        schema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
        run: async a => { requireSession(); await session.t.warp(!!a.on); return T('Warp ' + (a.on ? 'ON' : 'off') + '.'); },
    },
    oric_wait_for: {
        description: 'Run full-speed until a VARIABLE HOLDS A VALUE, then stop — the reliable "wait until" primitive. `expr` uses the game\'s real names, e.g. "_gCurrentLocation == e_LOC_MARKETPLACE" or "gGameOverCondition != 0". It fires no matter HOW the byte was written (STA/INC/DMA/…), and the timeout is measured in emulated frames. Returns when the condition holds.',
        schema: { type: 'object', properties: { expr: { type: 'string' }, timeoutFrames: { type: 'number' } }, required: ['expr'] },
        run: async a => { requireSession(); await session.t.waitFor(a.expr, a.timeoutFrames ? { timeoutFrames: a.timeoutFrames } : undefined); return T('Condition held: ' + a.expr + '. ' + await whereString()); },
    },
    oric_run_to: {
        description: 'Run (one-shot "run to here") until the CPU reaches `target` — a symbol name (e.g. "_AskInput", "_InputCheckKey") or a $hex address — then stop there. Deterministic sync on the program reaching a point.',
        schema: { type: 'object', properties: { target: { type: 'string' }, warp: { type: 'boolean' } }, required: ['target'] },
        run: async a => { requireSession(); await session.t.runTo(a.target, { warp: !!a.warp }); return T('Reached ' + a.target + '. ' + await whereString()); },
    },
    oric_run_frames: {
        description: 'Let N emulated frames pass while running (~50 = one second at 50 Hz), then stop. Use to let an animation/message play out.',
        schema: { type: 'object', properties: { frames: { type: 'number' } }, required: ['frames'] },
        run: async a => { requireSession(); const n = await session.t.runFrames(a.frames || 50); return T('Ran ' + n + ' frames. ' + await whereString()); },
    },
    oric_module: {
        description: 'The active OSDK overlay module name (e.g. Splash/Intro/Game/…), or "(none)". Lets you branch on where the machine is (entry point).',
        schema: { type: 'object', properties: {} },
        run: async () => { requireSession(); return T('module: ' + (await session.t.module() || '(none)')); },
    },
    oric_wait_module: {
        description: 'Run until the given overlay module is active (e.g. "Game"), then stop.',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        run: async a => { requireSession(); await session.t.waitModule(a.name); return T('module: ' + (await session.t.module() || '(none)')); },
    },
    oric_wait_signal: {
        description: 'Run full-speed until a logpoint/watchpoint tagged [signal:<id>] fires, then stop. The checkpoint lives in the code (a breakpoint), not here.',
        schema: { type: 'object', properties: { id: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['id'] },
        run: async a => { requireSession(); await session.t.waitSignal(a.id, { timeoutMs: a.timeoutMs }); return T('Signal "' + a.id + '" fired. ' + await whereString()); },
    },
};

// Build a simple step/continue command tool.
function cmd(dapCommand, argsFn, description) {
    return {
        description,
        schema: { type: 'object', properties: {} },
        run: async () => {
            requireSession();
            await session.dap.request(dapCommand, argsFn());
            // Stepping/continue resolve fast; give a stop a brief chance to land for a useful summary.
            await new Promise(r => setTimeout(r, 120));
            return T(await whereString());
        },
    };
}

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------
const PROTOCOL_VERSION = '2024-11-05';
let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    inbuf += chunk;
    let nl;
    while ((nl = inbuf.indexOf('\n')) >= 0) {
        const line = inbuf.slice(0, nl).trim();
        inbuf = inbuf.slice(nl + 1);
        if (line) handleRpc(line);
    }
});
process.stdin.on('end', () => { shutdown().finally(() => process.exit(0)); });

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleRpc(line) {
    let msg; try { msg = JSON.parse(line); } catch (_) { return; }
    const { id, method, params } = msg;
    try {
        if (method === 'initialize') {
            reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'oric-mcp-server', version: '0.1.0' } });
        } else if (method === 'notifications/initialized' || method === 'initialized') {
            /* notification, no reply */
        } else if (method === 'ping') {
            reply(id, {});
        } else if (method === 'tools/list') {
            reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) });
        } else if (method === 'tools/call') {
            const name = params && params.name;
            const t = TOOLS[name];
            if (!t) return replyError(id, -32602, 'unknown tool: ' + name);
            // Collaborative control gate: while ATTACHED and the human holds control, control-class
            // tools (drive execution / set breakpoints / send keys) are refused with a clear hint
            // rather than silently no-op'ing. Observation tools always run. (No gate when we launched
            // our own emulator — there's no human sharing it.)
            if (session.attached && session.control !== 'ai' && CONTROL_TOOLS.has(name)) {
                return reply(id, { content: [{ type: 'text', text: 'The human holds debug control, so "' + name + '" is blocked. Call oric_request_control to pilot (they can take it back any time). You can still observe: screenshot, read memory/registers, backtrace, evaluate.' }], isError: true });
            }
            try { const res = await t.run(params.arguments || {}); reply(id, res); }
            catch (e) { reply(id, { content: [{ type: 'text', text: 'ERROR: ' + (e && e.message ? e.message : String(e)) }], isError: true }); }
        } else if (id != null) {
            replyError(id, -32601, 'method not found: ' + method);
        }
    } catch (e) {
        if (id != null) replyError(id, -32603, e && e.message ? e.message : String(e));
    }
}

log('ready (adapter: ' + ADAPTER + '). Waiting for MCP client on stdio.');
