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
const { DapClient, VizClient, screenToPng, VIZ_PORT_OFFSET, ADAPTER, setLog } = require('./oric-debug-client.cjs');

// Everything that is not JSON-RPC MUST go to stderr — stdout is the MCP channel.
function log(...a) { process.stderr.write('[oric-mcp] ' + a.join(' ') + '\n'); }
setLog(m => log(m));   // route the shared client log through ours


// ---------------------------------------------------------------------------
// Session — ties a DAP client + viz client together, tracks breakpoints.
// ---------------------------------------------------------------------------
const session = {
    dap: null, viz: null, config: null, host: 'localhost', port: null,
    bpByFile: new Map(),        // file -> Map(line -> {condition?})
    watchpoints: new Map(),     // addrHex -> { accessType, condition }
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
    return { launched: true, port: session.port, vizPort: session.port + VIZ_PORT_OFFSET };
}

async function shutdown() {
    try { if (session.dap) await session.dap.request('disconnect', { terminateDebuggee: true }); } catch (_) {}
    if (session.viz) session.viz.disconnect();
    if (session.dap) session.dap.stop();
    session.dap = null; session.viz = null; session.bpByFile.clear(); session.watchpoints.clear();
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

const TOOLS = {
    oric_launch: {
        description: 'Build (if stale) and launch Oricutron under the debugger, then connect. `config` mirrors a VS Code oric-debug launch config: { port, emulatorPath|launchScript, diskImage?, symbolFile?, cwd?, gdbBreak?, emulatorArgs?, build? }. IMPORTANT: set `port` to the human base gdb port + 1 so this agent runs its own emulator.',
        schema: { type: 'object', properties: { config: { type: 'object' } }, required: ['config'] },
        run: async a => { const r = await launch(a.config || {}); return T('Launched. gdb ' + r.port + ', viz ' + r.vizPort + '. ' + await whereString()); },
    },
    oric_shutdown: {
        description: 'Terminate the emulator and debug session.',
        schema: { type: 'object', properties: {} },
        run: async () => { await shutdown(); return T('Shut down.'); },
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

    oric_set_breakpoint: {
        description: 'Set a source breakpoint at file:line, with an optional native condition expression (e.g. "X == 30" or "e->hp < 0"). Returns whether it bound (verified).',
        schema: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, condition: { type: 'string' } }, required: ['file', 'line'] },
        run: async a => {
            requireSession();
            if (!session.bpByFile.has(a.file)) session.bpByFile.set(a.file, new Map());
            session.bpByFile.get(a.file).set(a.line, a.condition ? { condition: a.condition } : {});
            const bps = await resendBreakpoints(a.file);
            const mine = bps.find(b => b.line === a.line) || bps[bps.length - 1];
            return T('Breakpoint ' + a.file + ':' + a.line + (a.condition ? ' if ' + a.condition : '') + ' — ' + (mine && mine.verified ? 'bound' : 'NOT bound (unverified)'));
        },
    },
    oric_clear_breakpoints: {
        description: 'Clear breakpoints in one file (pass `file`) or all files (omit it).',
        schema: { type: 'object', properties: { file: { type: 'string' } } },
        run: async a => {
            requireSession();
            const files = a.file ? [a.file] : [...session.bpByFile.keys()];
            for (const f of files) { session.bpByFile.set(f, new Map()); await resendBreakpoints(f); session.bpByFile.delete(f); }
            return T('Cleared ' + (a.file ? a.file : 'all files') + '.');
        },
    },
    oric_list_breakpoints: {
        description: 'List the breakpoints this session has set.',
        schema: { type: 'object', properties: {} },
        run: async () => {
            requireSession();
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
            if (!session.viz || !session.viz.latest) return { content: [{ type: 'text', text: 'No screen frame yet (viz not connected or no frame received). Is the emulator running?' }], isError: true };
            const png = screenToPng(session.viz.latest.scr, a.scale || 3);
            const mode = (session.viz.latest.vidMode & 4) ? 'HIRES' : 'TEXT';
            return { content: [
                { type: 'text', text: 'Oric screen — frame ' + session.viz.latest.frame + ', ' + mode + ', vid $' + session.viz.latest.vidAddr.toString(16) },
                { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            ] };
        },
    },
    oric_send_keys: {
        description: 'Type into the Oric (keyboard injection over the viz uplink, via the AY matrix). Printable ASCII is sent as-is; "\\n" sends Return. The machine must be RUNNING to consume keys.',
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        run: async a => {
            requireSession();
            if (!session.viz) return { content: [{ type: 'text', text: 'viz not connected' }], isError: true };
            const s = String(a.text);
            for (const ch of s) {
                let code = ch.charCodeAt(0);
                if (ch === '\n' || ch === '\r') code = 0x0d;         // Return (best-effort)
                if (code > 0xff) continue;
                session.viz.send([0x01, 0x02, code & 0xff, 1]);      // KEY down
                session.viz.send([0x01, 0x02, code & 0xff, 0]);      // KEY up
            }
            session.viz.send([0x02, 0x00]);                          // RELEASE_ALL
            return T('Sent ' + s.length + ' key(s).');
        },
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
            const t = TOOLS[params && params.name];
            if (!t) return replyError(id, -32602, 'unknown tool: ' + (params && params.name));
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
