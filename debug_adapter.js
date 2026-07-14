'use strict';

// ================================================================
// Oricutron DAP Debug Adapter
//
// Pure JavaScript — no npm dependencies.
// Communicates with VS Code via DAP (stdin/stdout, Content-Length).
// Communicates with Oricutron via GDB RSP (TCP).
// ================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

// Staleness self-check: capture this adapter file's mtime at process start (the
// version node actually compiled). If the file on disk later becomes newer, the
// running code is stale — you edited debug_adapter.js but this session is still
// running the old process. warnIfStale() surfaces that (a fresh session respawns
// node and reloads the file, so restarting the debug session is the fix).
let ADAPTER_LOADED_MTIME = 0;
try { ADAPTER_LOADED_MTIME = fs.statSync(__filename).mtimeMs; } catch (_) { /* ignore */ }
let staleWarned = false;
function warnIfStale() {
    if (staleWarned) return;
    try {
        const cur = fs.statSync(__filename).mtimeMs;
        if (cur > ADAPTER_LOADED_MTIME) {
            staleWarned = true;
            log('⚠️  STALE ADAPTER: debug_adapter.js on disk (' +
                new Date(cur).toISOString().replace('T', ' ').slice(0, 19) +
                ') is NEWER than the running process (loaded ' +
                new Date(ADAPTER_LOADED_MTIME).toISOString().replace('T', ' ').slice(0, 19) +
                '). Your edits are NOT active — stop and restart the debug session (Shift+F5 then F5).');
        }
    } catch (_) { /* ignore */ }
}

// Canonical key for comparing filesystem paths. Resolve to absolute (normalizes
// separators for the host OS) and fold case ONLY on case-insensitive filesystems
// (Windows, macOS) — on Linux, case is significant, so leaving it restricts the
// extension needlessly. Keeps path matching correct across platforms.
const caseInsensitiveFS = process.platform === 'win32' || process.platform === 'darwin';
const canonPath = p => {
    if (!p) return '';
    const r = path.resolve(p);
    return caseInsensitiveFS ? r.toLowerCase() : r;
};

// Single-source-of-truth address resolver (SPEC-address-resolver.md). Built per
// symbol load; every view that needs "what is at address X" goes through it.
const { buildResolver } = require('./resolver.cjs');
let resolverInstance = null;

// ----------------------------------------------------------------
// DAP protocol I/O  (Content-Length framing over stdin/stdout)
// ----------------------------------------------------------------

let dapBuf = Buffer.alloc(0);
let dapSeq = 1;

process.stdin.resume();
process.stdin.on('data', chunk => {
    dapBuf = Buffer.concat([dapBuf, chunk]);
    parseDap();
});
process.stdin.on('end', () => process.exit(0));

function parseDap() {
    while (true) {
        const idx = dapBuf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const header = dapBuf.slice(0, idx).toString('utf8');
        const m = header.match(/Content-Length:\s*(\d+)/i);
        if (!m) { dapBuf = dapBuf.slice(idx + 4); continue; }
        const len = parseInt(m[1], 10);
        const start = idx + 4;
        if (dapBuf.length < start + len) return;
        const body = dapBuf.slice(start, start + len).toString('utf8');
        dapBuf = dapBuf.slice(start + len);
        try { handleDap(JSON.parse(body)); }
        catch (e) { log('DAP parse error: ' + e.message); }
    }
}

function sendDap(msg) {
    msg.seq = dapSeq++;
    const json = JSON.stringify(msg);
    const out = 'Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json;
    process.stdout.write(out);
}

function respond(req, body, ok, message) {
    sendDap({
        type: 'response',
        request_seq: req.seq,
        command: req.command,
        success: ok !== false,
        message: message,
        body: body || {}
    });
}

function evt(name, body) {
    if (name !== 'output' && name !== 'invalidated' && name !== 'cycleAnnotation') {
        logVerbose('[DAP] → event: ' + name +
            (body && body.reason ? ' reason=' + body.reason : ''));
    }
    sendDap({ type: 'event', event: name, body: body || {} });
    if (name === 'stopped') {
        sendDap({ type: 'event', event: 'invalidated', body: { areas: ['variables'] } });
    }
}

// Log levels: 0 = errors only, 1 = normal (default), 2 = verbose/debug
let logLevel = 1;
let PROFILE = false;          // per-request timing + gdb round-trip counts (toggle: `profile on` in the Debug Console)
let gdbRoundTrips = 0;        // monotonic count of gdb commands issued (each is a TCP round-trip to Oricutron)
const LOG_LEVEL_NAMES = ['Errors', 'Normal', 'Verbose'];

function log(msg) {
    evt('output', { category: 'console', output: msg + '\n' });
}

// Report an error where it CANNOT be missed: the DAP 'important' category (VS Code
// surfaces it prominently in the Debug Console) plus a stderr mirror (captured even
// if the DAP channel is down). Never let an error fail silently. Returns nothing.
function logError(context, err) {
    const detail = err && err.stack ? err.stack : (err && err.message) || String(err);
    const msg = '❌ ERROR [' + context + ']: ' + detail;
    try { evt('output', { category: 'important', output: msg + '\n' }); } catch (_) { /* ignore */ }
    try { process.stderr.write(msg + '\n'); } catch (_) { /* ignore */ }
}

// Last-resort nets: anything that escapes a try/catch still gets reported instead
// of the adapter dying (or hanging) silently.
process.on('uncaughtException',  e => logError('uncaughtException', e));
process.on('unhandledRejection', e => logError('unhandledRejection', e));

function logVerbose(msg) {
    if (logLevel >= 2) log(msg);
}

// Set the verbosity and tell the extension host so the status bar can update.
// `initial` marks the value derived from launch config at session start — the
// host persists explicit (non-initial) changes so they carry across sessions.
function applyLogLevel(lvl, initial) {
    logLevel = lvl;
    evt('oricLogLevel', { level: logLevel, name: LOG_LEVEL_NAMES[logLevel], initial: !!initial });
}

// Session-start banner: extension version + file mtimes, so you can confirm at a
// glance that a reload/respawn actually picked up your edits. The adapter is
// respawned each session (edits live on next session); extension.js only refreshes
// on a window reload — showing both mtimes makes a stale extension.js obvious.
function logSessionBanner() {
    let ver = '?';
    try { ver = require('./package.json').version; } catch (_) { /* ignore */ }
    const stamp = f => {
        try { return fs.statSync(path.join(__dirname, f)).mtime.toISOString().replace('T', ' ').slice(0, 16); }
        catch (_) { return '?'; }
    };
    log('Oric Debug v' + ver + '  ·  adapter ' + stamp('debug_adapter.js') +
        '  ·  extension ' + stamp('extension.js') + '  ·  resolver ' + stamp('resolver.cjs') +
        '  (file mtimes, UTC)');
}

// Full reference for the Debug Console `help` command.
const CONSOLE_HELP = [
    'Oric Debug Console commands',
    '',
    'Registers',
    '  A  X  Y  SP  PC           read a register',
    '  A=$1F   X=10   PC=$C000   write ($ = hex, no $ = decimal)',
    '',
    'Execution',
    '  skip                      skip the current instruction (like Oricutron F12)',
    '  goto $C000                set PC to an address',
    '  goto label                set PC to a symbol',
    '',
    'Memory',
    '  x $C000 [len]             hex dump (len is decimal, default 16)',
    '  m C000,20                 hex dump, GDB-style (addr and len in hex)',
    '  w $C000 $FF               write one byte',
    '',
    'Symbols & expressions',
    '  sym NAME                  show a symbol’s address',
    '  NAME                      evaluate a symbol / C variable',
    '  <expr>                    evaluate via Oricutron (e.g. tmp0+2)',
    '',
    'Display',
    '  hex   dec                 number base for this console',
    '  loglevel [0|1|2]          log verbosity (Errors/Normal/Verbose); no arg = show current',
    '  profile [on|off]          per-request timing + gdb read counts in the log',
    '',
    'Monitor passthrough',
    '  ! <cmd>                   run a raw Oricutron monitor command',
    '',
    '  help   ?                  show this help'
].join('\n');

// ----------------------------------------------------------------
// GDB RSP client  (TCP, $packet#checksum framing)
// ----------------------------------------------------------------

let sock = null;
let rxBuf = '';
let pendingResolve = null;
let pendingCmdType = null;   // first char of pending GDB command (to distinguish responses)
let pendingCmd = null;       // full pending GDB command (some commands reply with a stop packet)

// Commands whose legitimate RESPONSE is a stop packet (T../S..), so a T/S while
// they're pending must resolve the await — NOT be treated as an unsolicited stop.
// (`?` is the initial stop query; `qOricHardReset` replies T05 after resetting.)
function stopReplyIsResponse() {
    return pendingCmdType === '?' || pendingCmd === 'qOricHardReset';
}
let gdbQueue = [];           // queued commands: [{cmd, resolve}]
let disconnecting = false;

// GDB commands sent constantly to service the variables/memory views —
// pure noise in the verbose log. Suppress both the '→' send and the '←'
// response (matched via pendingCmdType). m/M = read/write mem, X = binary write.
const gdbQuietCmds = new Set(['m', 'M', 'X']);

function gdbConnect(host, port) {
    return new Promise((resolve, reject) => {
        const s = net.createConnection({ host: host, port: port }, () => {
            sock = s;
            armedAddrs.clear(); // fresh session: the stub holds no breakpoints yet
            moduleWatchAddr = -1;
            moduleWatchPending = false;
            resolve();
        });
        // Disable Nagle's algorithm. The RSP protocol is a stream of tiny request/ack
        // packets; with Nagle on, each command stalls ~40ms behind the peer's delayed
        // ACK, so every memory read cost ~50ms of pure latency (dominating every stop).
        s.setNoDelay(true);
        s.setEncoding('latin1');
        s.on('data', onGdbData);
        s.on('error', err => {
            if (!sock) { reject(err); return; }
            log('GDB connection error: ' + err.message);
        });
        s.on('close', () => {
            const wasSock = sock;
            sock = null;
            if (pendingResolve) {
                const r = pendingResolve;
                pendingResolve = null;
                pendingCmdType = null;
                pendingCmd = null;
                r(null);
            }
            for (const entry of gdbQueue) entry.resolve(null);
            gdbQueue = [];
            if (wasSock && !disconnecting) {
                evt('terminated');
            }
        });
    });
}

// Quick check whether something is already listening on host:port (a stale
// emulator on our gdb port). Resolves true if a connection is accepted.
function probePort(host, port) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        let done = false;
        const finish = (v) => { if (!done) { done = true; try { s.destroy(); } catch (_) { /* ignore */ } resolve(v); } };
        s.setTimeout(500);
        s.once('connect', () => finish(true));
        s.once('timeout', () => finish(false));
        s.once('error', () => finish(false));
        try { s.connect(port, host); } catch (_) { finish(false); }
    });
}

// Single entry point for launching OSDK batch/command lines. Guarantees the child can
// run regardless of the machine's cmd config or path style — every OSDK spawn (build,
// launch script, config harvest) goes through here so we fix these quirks once (DRY):
//   * bare-name scripts resolve — `cwd` is prepended to PATH (cmd may not search the
//     current directory: NoDefaultCurrentDirectoryInExePath)
//   * `START oricutron.exe` resolves — %OSDK%\Oricutron is on PATH
//   * PUSHD/COPY on %OSDK% work — OSDK and cwd are normalized to backslashes
//   * builds never hang on an error prompt — OSDKBRIEF defaults to NOPAUSE
// `command` is a full command line (e.g. 'osdk_build.bat', or 'call x.bat & set').
// opts: { cwd, env (extra vars, override the defaults), windowsHide }. Returns the child.
function spawnOsdk(command, opts) {
    opts = opts || {};
    const isWin = process.platform === 'win32';
    const bs = (p) => (p || '').replace(/\//g, '\\');
    const cwd = bs(opts.cwd || process.cwd());
    const env = Object.assign({}, process.env, { OSDKBRIEF: 'NOPAUSE' }, opts.env || {});
    if (isWin) {
        const osdkRoot = bs(env.OSDK || '');
        if (osdkRoot) env.OSDK = osdkRoot;                       // backslashes for PUSHD/COPY
        const oriDir = osdkRoot ? osdkRoot + '\\Oricutron' : '';
        env.PATH = cwd + ';' + (oriDir ? oriDir + ';' : '') + (process.env.PATH || '');
        return child_process.spawn('cmd', ['/c', command], { cwd, env, windowsHide: opts.windowsHide !== false });
    }
    return child_process.spawn('sh', ['-c', command], { cwd, env, windowsHide: opts.windowsHide !== false });
}

// Run osdk_config.bat in `cwd` and capture the environment it produces (OSDKADDR,
// OSDKNAME, ...). Executing it is more robust than parsing the .bat, since values may
// be built conditionally. Returns an upper-cased key->value map ({} on failure).
function harvestOsdkConfig(cwd) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') { resolve({}); return; }
        let out = '';
        const child = spawnOsdk('call osdk_config.bat >nul 2>nul & set', { cwd });
        child.stdout.on('data', d => out += d.toString());
        child.on('error', () => resolve({}));
        child.on('close', () => {
            const map = {};
            for (const line of out.split(/\r?\n/)) {
                const m = line.match(/^([^=]+)=(.*)$/);
                if (m) map[m[1].toUpperCase()] = m[2];
            }
            resolve(map);
        });
    });
}

// Kill the process(es) listening on `port` (used when the emulator was started
// detached by a launch script, so we have no child handle). Best-effort.
function killByPort(port) {
    try {
        if (process.platform === 'win32') {
            const out = child_process.execSync('netstat -ano -p tcp', { windowsHide: true }).toString();
            const pids = new Set();
            for (const line of out.split(/\r?\n/)) {
                const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
                if (m && parseInt(m[1], 10) === port) pids.add(m[2]);
            }
            for (const pid of pids)
                try { child_process.execSync('taskkill /pid ' + pid + ' /T /F', { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* gone */ }
        } else {
            const pids = child_process.execSync('lsof -ti tcp:' + port + ' -s tcp:LISTEN', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\s+/).filter(Boolean);
            for (const pid of pids)
                try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch (_) { /* gone */ }
        }
    } catch (_) { /* nothing listening / tool missing */ }
}

function onGdbData(data) {
    rxBuf += data;
    while (rxBuf.length > 0) {
        // Skip ACK / NAK
        if (rxBuf[0] === '+' || rxBuf[0] === '-') {
            rxBuf = rxBuf.substring(1);
            continue;
        }
        // Expect '$'
        if (rxBuf[0] !== '$') {
            rxBuf = rxBuf.substring(1);
            continue;
        }
        // Find '#'
        const hash = rxBuf.indexOf('#', 1);
        if (hash < 0 || hash + 2 >= rxBuf.length) return; // incomplete
        const payload = rxBuf.substring(1, hash);
        rxBuf = rxBuf.substring(hash + 3);
        // ACK
        if (sock) sock.write('+');

        // Suppress noisy mem-read/write responses — but never hide an
        // (unsolicited) stop notification that lands while one is pending.
        const isStopPkt = (payload[0] === 'T' || payload[0] === 'S');
        if (isStopPkt || !gdbQuietCmds.has(pendingCmdType)) {
            if (payload.length <= 80) logVerbose('[GDB] ← ' + payload.substring(0, 60));
            else logVerbose('[GDB] ← (' + payload.length + ' chars)');
        }
        // Route the packet: if we're waiting for a command response,
        // deliver it — UNLESS it's an unsolicited stop notification
        // (T05/S05) while we're waiting for a non-'?' response.
        if (pendingResolve) {
            const isStop = (payload[0] === 'T' || payload[0] === 'S');
            if (isStop && !stopReplyIsResponse()) {
                // Unsolicited stop while waiting for a non-stop command's response
                // (e.g. a breakpoint hit while a memory read was in flight).
                onStopReply(payload);
            } else {
                // The command's response (data, OK, or — for ?/qOricHardReset — a stop packet).
                const r = pendingResolve;
                pendingResolve = null;
                pendingCmdType = null;
                pendingCmd = null;
                r(payload);
                gdbSendNext();
            }
        } else if (payload[0] === 'T' || payload[0] === 'S') {
            // Asynchronous stop notification (e.g. breakpoint hit during 'c')
            onStopReply(payload);
        }
    }
}

function gdbWrite(cmd) {
    if (!sock) { logVerbose('[GDB] write failed: no socket (cmd=' + cmd.substring(0, 20) + ')'); return; }
    let cs = 0;
    for (let i = 0; i < cmd.length; i++) cs = (cs + cmd.charCodeAt(i)) & 0xff;
    if (!gdbQuietCmds.has(cmd[0])) logVerbose('[GDB] → ' + cmd.substring(0, 40));
    sock.write('$' + cmd + '#' + cs.toString(16).padStart(2, '0'));
}

/** Send the next queued GDB command (if any). */
let gdbIdleCallbacks = [];
function gdbSendNext() {
    if (gdbQueue.length === 0) {
        // Queue empty and no pending command — fire idle callbacks
        const cbs = gdbIdleCallbacks;
        gdbIdleCallbacks = [];
        for (const cb of cbs) cb();
        return;
    }
    const { cmd, resolve } = gdbQueue.shift();
    pendingResolve = resolve;
    pendingCmdType = cmd[0];
    pendingCmd = cmd;
    gdbWrite(cmd);
}

/** Run callback when no GDB command is in-flight and queue is empty. */
function whenGdbIdle(cb) {
    if (!pendingResolve && gdbQueue.length === 0) {
        cb();
    } else {
        gdbIdleCallbacks.push(cb);
    }
}

/** Send a GDB command and wait for the response packet.
 *  Commands are serialized: if a command is already in flight,
 *  this one queues behind it. */
function gdbCmd(cmd) {
    gdbRoundTrips++;   // profiling: count every command (each is a TCP round-trip to the emulator)
    return new Promise(resolve => {
        if (!sock) { resolve(null); return; }
        if (pendingResolve) {
            // Another command is in flight — queue this one
            gdbQueue.push({ cmd, resolve });
        } else {
            // Send immediately
            pendingResolve = resolve;
            pendingCmdType = cmd[0];
            pendingCmd = cmd;
            gdbWrite(cmd);
        }
    });
}

// ----------------------------------------------------------------
// Adapter state
// ----------------------------------------------------------------

let symbols    = new Map();   // name  -> address (number)
let addrSym    = new Map();   // address -> name
let addrSource = new Map();   // address -> { file, line } (from symbol defs)
let symSource  = new Map();   // name  -> { file, line } (per-symbol source)
let lineTable  = [];          // [{addr, file, line}] sorted by addr (from #LINES)
let regs       = null;        // { a, x, y, sp, pc, f }
let running    = false;
let config     = {};
let bpId       = 1;
let bps        = new Map();   // id -> { id, addr, name } (function breakpoints)
let ibps       = new Map();   // id -> { id, addr }       (instruction breakpoints)
let zpSymbols  = [];          // [{addr, name, size}] sorted by address (derived from symInfo)
let symInfo    = new Map();   // name -> { name, addr, size, ann, type, group } — single source of truth for per-symbol info
let typeDefs   = new Map();   // structName -> { size, fields: [{name, type, offset, size}] }
let varTypes   = new Map();   // asmName -> { type: 'score_entry[24]', base: 'score_entry', count: 24|1, totalSize: 528 }
let localDefs  = new Map();   // funcAsmName -> [{cname, base:'fp'|'ap', offset, type, baseType, count, size}]
let enumDefs   = new Map();   // enumName -> { size, byValue: Map<number,string>, isFlags: bool }
// Comment-based debug annotations (extension-only, byte-neutral). Parsed from
// header (.h, "// @...") and assembler (.s, "; @...") source. Two association
// levels: by C-struct field, and by symbol name (C globals & asm data labels).
let annByField  = new Map();  // "structName.fieldName" -> { kind:'bool'|'enum'|'bitset', enumName? }
let annBySymbol = new Map();  // symbolName (no leading _) -> { kind, enumName? }
// Union of every module's enum defs. Annotation resolution (@enum/@bitset) must
// work regardless of which module is active (the enum defs are identical across
// modules), including when no module is active yet (resident-only at boot).
let allEnumDefs = new Map();
function resolveEnum(name) { return enumDefs.get(name) || allEnumDefs.get(name); }
// Annotation lookup for a symbol (C global or asm label), tolerant of the leading
// underscore the C compiler / assembler add. One place so every view resolves the
// same way.
function annForSymbol(name) { return name ? annBySymbol.get(name.replace(/^_+/, '')) : undefined; }
// The byte width an annotation pins down, or 0 if it implies none (bool/enum default
// to a single byte at the caller). One place so symbol sizing and value rendering agree.
function annWidth(ann) {
    if (!ann || typeof ann.kind !== 'string') return 0;
    if (ann.kind === 'ptr16') return 2;
    if (ann.kind.indexOf('bcd') === 0) return ann.size || 2;
    if (ann.kind === 'bitset') { const ed = resolveEnum(ann.enumName); return ann.size || (ed ? bitsetBytes(ed) : 0); }
    return 0;
}
// Per-symbol info lookup, tolerant of the leading underscore. Single source of truth
// for a symbol's address, size, annotation and type — every view resolves through it.
function infoForSymbol(name) {
    if (!name) return undefined;
    return symInfo.get(name) || symInfo.get('_' + name) ||
           (name[0] === '_' ? symInfo.get(name.slice(1)) : undefined);
}
// The (type, size, ann) to hand buildTypedVar for a named symbol, from the registry.
// One place so Watch / zero-page / Globals render a symbol identically.
function renderSpec(name) {
    const info = infoForSymbol(name);
    const ann = info ? info.ann : (annForSymbol(name) || null);
    if (info && info.type) return { type: info.type, size: info.size, ann };   // .ctype-typed var
    if (ann) return { type: 'uchar', size: info ? info.size : (annWidth(ann) || 1), ann };
    const size = info ? Math.min(info.size, 2) : 2;                             // plain: word/byte default
    return { type: size >= 2 ? 'uint' : 'uchar', size, ann: null };
}
let varRefs    = new Map();   // variablesReference id -> { addr, typeName, count, offset? }
let nextVarRef = 100;         // next available variablesReference id (1-5 reserved for scopes)
let refByKey   = new Map();   // identity string -> stable variablesReference
// Allocate a variablesReference that stays STABLE across stops for the same logical
// node (keyed by address/type/offset). VS Code tracks tree expansion by reference id,
// so reusing the id lets the Variables/Watch tree keep its expanded/collapsed state
// while stepping instead of collapsing every struct/array on each stop.
function stableRef(key, payload) {
    let ref = refByKey.get(key);
    if (ref === undefined) { ref = nextVarRef++; refByKey.set(key, ref); }
    varRefs.set(ref, payload);
    return ref;
}
let displayHex = true;        // true = hex primary, false = decimal primary
let configDone = false;
let pendingStop = null;       // deferred stopped event body
let srcBps     = new Map();   // file -> [{id, line, source, bindings:[{addr,module,armed}]}] — one binding per owning overlay (shared files span several)
let dataBps    = new Map();   // id -> { addr, accessType, gdbType } (data breakpoints)
let armedAddrs = new Map();   // addr -> refcount of execution breakpoints armed in the stub
let moduleWatchAddr = -1;     // addr of the hidden _osdk_dbg_module write-watch (-1 = none); arms overlays on load
let moduleWatchPending = false; // true between the module-watch stop and the dobp=FALSE step that commits the write
let moduleByteTrusted = false; // false until we KNOW _osdk_dbg_module is meaningful (a write was observed, or we attached to a running program). At cold boot the byte is uninitialized RAM — its value must not be believed.
let resumeMode = 'run';       // 'run' | 'step' — how execution was last resumed (for transparent module switches)
let gotoTargetMap = new Map(); // targetId -> address (for goto/setNextStatement)
let lastCycleAnnotation = null; // { pc, cycles } from last step-over
let launchedProcess = null;     // child_process handle if we launched Oricutron
let sourceLineCache = {};       // filePath -> string[] (lazy-loaded source, 0-based)
let tempStepBp = -1;           // address of temp breakpoint for source-level stepping (-1 = none)
let continueAfterStep = false; // true when single-stepping past a BP before continuing (F5)
let stepInInProgress = false;  // true while a source-level Step Into is single-stepping toward a new source line (descends into callees)
let stepInStartFile = null;    // source file/line where the current Step Into began (compared to detect arrival)
let stepInStartLine = -1;
let stepInBudget = 0;          // instruction-step budget so a step into source-less code can't run away
let turboWarpActive = false;   // true while a "Turbo Run" is warping toward a stop
let turboPrevWarp = false;     // warp state to restore when the turbo run stops
let scriptLaunched = false;    // true when Oricutron was started via a launch script (detached; kill by port)
let initBreakAddr = -1;        // address of the --gdb_break entry breakpoint to drop on connect (-1 = none)
let awaitingEntry = false;     // true after configurationDone continue, until the entry breakpoint is hit

// ----------------------------------------------------------------
// Build staleness check (pure Node.js, cross-platform)
// ----------------------------------------------------------------

function readdirRecursive(dir) {
    let results = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return results; }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            results = results.concat(readdirRecursive(full));
        } else {
            results.push(full);
        }
    }
    return results;
}

function checkStale(outputPath, sourceDirs) {
    let outMtime;
    try { outMtime = fs.statSync(outputPath).mtimeMs; }
    catch (e) { return true; } // output missing → stale
    if (!sourceDirs || sourceDirs.length === 0) return false;
    // Never count files under the build-output directory as "sources" — the build
    // writes there, so including it (e.g. sources: ["${workspaceFolder}"]) would make
    // the project perpetually look stale right after a successful build.
    const outDir = canonPath(path.dirname(outputPath)) + path.sep;
    const underOutDir = (p) => canonPath(p).startsWith(outDir);
    for (const dir of sourceDirs) {
        let stat;
        try { stat = fs.statSync(dir); } catch (e) { continue; }
        if (stat.isFile()) {
            if (!underOutDir(dir) && stat.mtimeMs > outMtime) return true;
            continue;
        }
        const files = readdirRecursive(dir);
        for (const f of files) {
            if (underOutDir(f)) continue;
            try {
                if (fs.statSync(f).mtimeMs > outMtime) return true;
            } catch (e) { /* skip unreadable */ }
        }
    }
    return false;
}

// ----------------------------------------------------------------
// Build runner (spawns shell, streams output to DAP console)
// ----------------------------------------------------------------

function runBuild(command, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawnOsdk(command, { cwd, windowsHide: true });
        child.stdout.on('data', d => {
            evt('output', { category: 'stdout', output: d.toString() });
        });
        child.stderr.on('data', d => {
            evt('output', { category: 'stderr', output: d.toString() });
        });
        child.on('error', err => reject(new Error('Build failed to start: ' + err.message)));
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error('Build failed with exit code ' + code));
        });
    });
}

// ----------------------------------------------------------------
// Symbol file loader  (format: "HHHH symbol_name" per line)
// ----------------------------------------------------------------

// ---- Multi-module symbol support ----
// Symbols parse into per-module "buckets" (key 'R' = resident, or a numeric
// module id from #MODULE markers). applyActiveModule() composes resident + one
// active module into the global maps the rest of the adapter uses. A symbol file
// with no #MODULE markers yields a single resident bucket => behaves exactly as
// a single-module file did before this refactor.
let moduleBuckets  = new Map();  // key ('R' | id) -> bucket
let moduleNames    = new Map();  // id(number) -> module name
let moduleFiles    = new Map();  // key -> Set(source file paths in that bucket)
let fileToModules  = new Map();  // normalized file path -> [owning module keys] (a shared source file can be linked into several overlays, at a different address in each)
let activeModuleId = null;       // null = single-module / none selected
let moduleReported = false;      // have we surfaced the active module to the UI yet this session?
let moduleAllFiles = [];         // union of all #FILES paths (for resolveLibrarySources)

function makeSymBucket() {
    return {
        symbols: new Map(), addrSym: new Map(), addrSource: new Map(), symSource: new Map(),
        lineTable: [], typeDefs: new Map(), varTypes: new Map(), localDefs: new Map(),
        enumDefs: new Map()
    };
}

// Compose resident + the given module id into the global symbol maps.
// NOTE: callers that change the composed view at RUNTIME must follow up with
// evt('oricSymbolsChanged', ...) so the host invalidates its symbol cache
// (checkModuleSwitch and the setActiveModule request do; the initial
// loadSymbols call emits once after annotations are parsed).
function applyActiveModule(id) {
    symbols.clear(); addrSym.clear(); addrSource.clear(); symSource.clear();
    typeDefs.clear(); varTypes.clear(); localDefs.clear(); enumDefs.clear();
    lineTable = []; zpSymbols = [];

    const order = [];
    if (moduleBuckets.has('R')) order.push(moduleBuckets.get('R'));
    if (id !== null && moduleBuckets.has(id)) order.push(moduleBuckets.get(id));

    for (const b of order) {
        for (const [n, a] of b.symbols)    symbols.set(n, a);
        for (const [a, n] of b.addrSym) {
            // Same rule as the within-bucket parse: first definition wins, except a
            // real-source symbol overrides an inherited one recorded from linked.s.
            const bSrc = b.addrSource.get(a);
            const prevSrc = addrSource.get(a);
            const overrideArtifact = prevSrc && isBuildArtifact(prevSrc.file) && bSrc && !isBuildArtifact(bSrc.file);
            if (!addrSym.has(a) || overrideArtifact) {
                addrSym.set(a, n);
                if (bSrc) addrSource.set(a, bSrc);
            }
        }
        for (const [a, s] of b.addrSource) if (!addrSource.has(a)) addrSource.set(a, s);
        for (const [n, s] of b.symSource)  symSource.set(n, s);
        for (const [k, v] of b.typeDefs)   typeDefs.set(k, v);
        for (const [k, v] of b.varTypes)   varTypes.set(k, v);
        for (const [k, v] of b.localDefs)  localDefs.set(k, v);
        for (const [k, v] of b.enumDefs)   enumDefs.set(k, v);
        for (const e of b.lineTable)       lineTable.push(e);
    }
    activeModuleId = id;
    if (resolverInstance) resolverInstance.setActiveModule(id); // keep the resolver's composed view in sync

    // Sort + dedupe line table: keep last entry per address (the code-producing line)
    if (lineTable.length > 1) {
        lineTable.sort((a, b) => a.addr - b.addr);
        const deduped = [];
        for (let i = 0; i < lineTable.length; i++) {
            if (i === lineTable.length - 1 || lineTable[i + 1].addr !== lineTable[i].addr) {
                deduped.push(lineTable[i]);
            }
        }
        lineTable = deduped;
    }

    buildSymInfo();

    resolveLibrarySources(moduleAllFiles);
    varRefs.clear(); refByKey.clear(); nextVarRef = 100;
}

// Build the single per-symbol registry (symInfo) and the zero-page view list from it.
// Size priority: explicit .ctype type width > annotation width > address-gap inference.
// Called whenever the composed symbol set changes so every view reads one size.
function buildSymInfo() {
    symInfo.clear();
    const arr = [];
    for (const [name, addr] of symbols) arr.push({ name, addr });
    arr.sort((a, b) => a.addr - b.addr);
    for (let i = 0; i < arr.length; i++) {
        const { name, addr } = arr[i];
        // Gap to the next DISTINCT address (skip same-address aliases), capped for display.
        let ni = i + 1;
        while (ni < arr.length && arr[ni].addr === addr) ni++;
        const next = ni < arr.length ? arr[ni].addr : addr + 2;
        const gap = Math.min(Math.max(next - addr, 1), 8);
        const ann = annForSymbol(name) || null;
        const vt = varTypes.get(name);
        const size = vt ? vt.totalSize : (annWidth(ann) || gap);
        symInfo.set(name, {
            name, addr, size, ann,
            type: vt ? vt.type : null,
            group: addr <= 0xFF ? 'zp' : (addr < 0xC000 ? 'ram' : 'high')
        });
    }
    // Zero-page view list = the master symbol at each zp address, sized from the registry.
    zpSymbols = [];
    for (const [a, n] of addrSym) {
        if (a <= 0xFF) {
            const info = symInfo.get(n);
            zpSymbols.push({ addr: a, name: n, size: info ? info.size : 1 });
        }
    }
    zpSymbols.sort((a, b) => a.addr - b.addr);
}

// Modules for the manual-override UI.
function listModules() {
    const out = [];
    for (const [id, name] of moduleNames) out.push({ id, name, active: id === activeModuleId });
    out.sort((a, b) => a.id - b.id);
    return out;
}

// Read the resident _osdk_dbg_module byte and switch the active module if it
// changed. No-op for single-module projects (no #MODULE sections, or no
// _osdk_dbg_module symbol). Reads are benign (gdb_read_memory uses mon_read).
async function checkModuleSwitch(force) {
    if (moduleNames.size === 0) return;
    // At a normal stop, skip if a command is in flight to avoid queueing behind it
    // (the check re-runs next stop). But the module-load handoff (phase 2) MUST run
    // even then, or the incoming overlay's breakpoints never get armed before resume;
    // `force` lets its read queue behind the in-flight command and resolve after.
    if (pendingResolve && !force) return;
    // At cold boot the module byte is uninitialized RAM (could read as any value,
    // including a valid id like 0). Don't believe it until a write has been observed
    // (moduleWatchPending path) or we attached to an already-running program. Until
    // then, show "(none)" — no overlay is loaded yet.
    if (!moduleByteTrusted) {
        if (!moduleReported) {
            evt('oricActiveModule', { id: null, name: '(none)' });
            moduleReported = true;
        }
        return;
    }
    const addr = symbols.get('_osdk_dbg_module');
    if (addr === undefined) return;
    const bytes = await readMem(addr & 0xffff, 1);
    const val = bytes[0];
    if (moduleNames.has(val) && val !== activeModuleId) {
        applyActiveModule(val);
        await rearmModuleBreakpoints();
        log('Active module -> ' + moduleNames.get(val) + ' (id ' + val + ')');
        evt('oricActiveModule', { id: val, name: moduleNames.get(val) });
        evt('oricSymbolsChanged', { reason: 'module-switch', module: val });
        moduleReported = true;
    } else if (!moduleReported) {
        // First stop of the session: no switch fired, but the UI has never been
        // told the state. Surface it once — including "(none)" when no overlay is
        // loaded yet (byte still $ff) — so the status bar reflects reality from the
        // start rather than staying blank.
        const name = activeModuleId !== null ? moduleNames.get(activeModuleId) : '(none)';
        log('Active module = ' + name + (activeModuleId !== null ? ' (id ' + activeModuleId + ')' : ''));
        evt('oricActiveModule', { id: activeModuleId, name: name });
        moduleReported = true;
    }
}

// Sync source-breakpoint arming to the active module: (re)arm resident + active-
// module breakpoints in the stub, disarm the rest. Called after the active module
// changes so a breakpoint in an overlay only fires while that overlay is loaded.
async function rearmModuleBreakpoints() {
    for (const [, arr] of srcBps) {
        for (const bp of arr) {
            // A source breakpoint has one binding per owning module (shared files
            // span several overlays). Arm the binding whose module is now active or
            // resident; disarm the rest. The bp is verified if ANY binding is armed.
            let changed = false;
            for (const b of bp.bindings) {
                const desired = (b.module === 'R' || b.module === activeModuleId);
                if (desired && !b.armed) { b.armed = await armAddr(b.addr); changed = true; }
                else if (!desired && b.armed) { await disarmAddr(b.addr); b.armed = false; changed = true; }
            }
            if (changed) {
                const verified = bp.bindings.some(b => b.armed);
                evt('breakpoint', { reason: 'changed', breakpoint: verified
                    ? { id: bp.id, verified: true, line: bp.line, source: bp.source }
                    : { id: bp.id, verified: false, line: bp.line, source: bp.source,
                        message: 'Inactive module — binds when its overlay loads' } });
            }
        }
    }
}

function loadSymbols(file) {
    symbols.clear(); addrSym.clear(); addrSource.clear(); symSource.clear();
    lineTable = []; zpSymbols = [];
    typeDefs.clear(); varTypes.clear(); localDefs.clear();
    evalFailCache.clear(); varRefs.clear(); refByKey.clear(); nextVarRef = 100;

    moduleBuckets = new Map(); moduleNames = new Map(); moduleFiles = new Map();
    moduleAllFiles = []; activeModuleId = null; moduleReported = false;
    const resident = makeSymBucket();
    moduleBuckets.set('R', resident); moduleFiles.set('R', new Set());

    try {
        const fileText = fs.readFileSync(file, 'utf8');
        const lines = fileText.split(/\r?\n/);
        let isV2 = false;
        let section = 'sym';    // 'sym', 'files', 'lines', or 'types'
        let fileIndex = [];     // index -> absolute path (from #FILES, per block)
        let cur = resident;     // bucket currently being filled
        let curKey = 'R';

        for (const line of lines) {
            const trimmed = line.trim();

            // Module section marker: "#MODULE <id> <name>" — everything until the
            // next marker belongs to that module. Text before the first marker is resident.
            const mm = trimmed.match(/^#MODULE\s+(\d+)\s+(\S+)/);
            if (mm) {
                const id = parseInt(mm[1], 10);
                moduleNames.set(id, mm[2]);
                if (!moduleBuckets.has(id)) { moduleBuckets.set(id, makeSymBucket()); moduleFiles.set(id, new Set()); }
                cur = moduleBuckets.get(id); curKey = id;
                section = 'sym'; fileIndex = [];
                continue;
            }
            if (trimmed === '#SYM V2')  { isV2 = true; section = 'sym'; continue; }
            if (trimmed === '#FILES')   { section = 'files'; fileIndex = []; continue; }
            if (trimmed === '#LINES')   { section = 'lines'; continue; }
            if (trimmed === '#TYPES')   { section = 'types'; continue; }

            if (section === 'files') {
                // Format: "index filepath"
                const fm = trimmed.match(/^(\d+)\s+(.+)$/);
                if (fm) { fileIndex[parseInt(fm[1], 10)] = fm[2]; moduleAllFiles.push(fm[2]); moduleFiles.get(curKey).add(fm[2]); }
                continue;
            }

            if (section === 'lines') {
                // Format: "HHHH fileIndex:line"
                const lm = trimmed.match(/^([0-9a-fA-F]{4})\s+(\d+):(\d+)$/);
                if (lm) {
                    const fi = parseInt(lm[2], 10);
                    cur.lineTable.push({
                        addr: parseInt(lm[1], 16),
                        file: fileIndex[fi] || ('file#' + fi),
                        line: parseInt(lm[3], 10)
                    });
                }
                continue;
            }

            if (section === 'types') {
                const sm = trimmed.match(/^struct\s+(\S+)\s+(\d+)\s+(.+)$/);
                if (sm) {
                    const name = sm[1];
                    const size = parseInt(sm[2], 10);
                    const fields = [];
                    for (const ft of sm[3].split(/\s+/)) {
                        const parts = ft.split(':');
                        if (parts.length >= 4) {
                            fields.push({ name: parts[0], type: parts[1], offset: parseInt(parts[2], 10), size: parseInt(parts[3], 10) });
                        }
                    }
                    cur.typeDefs.set(name, { size, fields });
                    continue;
                }
                const vm = trimmed.match(/^var\s+(\S+)\s+(\S+)\s+(\d+)$/);
                if (vm) {
                    const asmName = vm[1];
                    const typeStr = vm[2];
                    const totalSize = parseInt(vm[3], 10);
                    const am = typeStr.match(/^(.+)\[(\d+)\]$/);
                    if (am) cur.varTypes.set(asmName, { type: typeStr, base: am[1], count: parseInt(am[2], 10), totalSize });
                    else    cur.varTypes.set(asmName, { type: typeStr, base: typeStr, count: 1, totalSize });
                    continue;
                }
                const em = trimmed.match(/^enum\s+(\S+)\s+(\d+)\s+(.+)$/);
                if (em) {
                    const name = em[1];
                    const size = parseInt(em[2], 10);
                    const byValue = new Map();     // value -> enumerator name
                    let allSingleBit = true, nonZero = 0, seenBits = 0, maxVal = 0;
                    for (const tok of em[3].split(/\s+/)) {
                        const eq = tok.indexOf('=');
                        if (eq < 0) continue;
                        const en = tok.slice(0, eq);
                        const ev = parseInt(tok.slice(eq + 1), 10);
                        if (!Number.isFinite(ev)) continue;
                        if (!byValue.has(ev)) byValue.set(ev, en);  // first name wins on aliases
                        if (ev !== 0) {
                            nonZero++;
                            if (ev > maxVal) maxVal = ev;
                            // single-bit iff exactly one bit set and not previously used
                            if ((ev & (ev - 1)) !== 0 || (seenBits & ev)) allSingleBit = false;
                            seenBits |= ev;
                        }
                    }
                    // Bitmask enum: every nonzero member is a distinct single bit AND the set
                    // reaches at least 4. The >=4 test disambiguates real flags {1,2,4,8}
                    // (which skip 3) from a plain sequential enum {0,1,2} whose small values
                    // happen to be single bits too. A 2-member {1,2} enum stays sequential.
                    const isFlags = nonZero >= 2 && allSingleBit && maxVal >= 4;
                    cur.enumDefs.set(name, { size, byValue, isFlags });
                    continue;
                }
                const lm = trimmed.match(/^local\s+(\S+)\s+(\S+)\s+(fp|ap)\s+(\d+)\s+(\S+)\s+(\d+)$/);
                if (lm) {
                    const func = lm[1];
                    const cname = lm[2];
                    const base = lm[3];
                    const offset = parseInt(lm[4], 10);
                    const typeStr = lm[5];
                    const size = parseInt(lm[6], 10);
                    const am = typeStr.match(/^(.+)\[(\d+)\]$/);
                    const entry = { cname, base, offset, type: typeStr, size, baseType: am ? am[1] : typeStr, count: am ? parseInt(am[2], 10) : 1 };
                    if (!cur.localDefs.has(func)) cur.localDefs.set(func, []);
                    cur.localDefs.get(func).push(entry);
                    continue;
                }
                continue;
            }

            // section === 'sym'
            const m = line.match(/^([0-9a-fA-F]{4})\s+(\S+)/);
            if (m) {
                const a = parseInt(m[1], 16);
                const n = m[2];
                cur.symbols.set(n, a);
                let src = null;
                if (isV2) {
                    const rest = line.substring(m[0].length).trim();
                    const cm = rest.match(/^(.+):(\d+)$/);
                    if (cm) {
                        src = { file: cm[1], line: parseInt(cm[2], 10) };
                        cur.symSource.set(n, src);
                    }
                }
                // addr->name: keep the first definition, but let a real-source symbol
                // override one recorded from a build artifact (linked.s). Inherited
                // symbols reach a module via the linked parent image, so a module's own
                // (real-source) redefinition at the same address correctly shadows the
                // inherited one. Keep addrSource in sync with the winning symbol.
                const prevSrc = cur.addrSource.get(a);
                const overrideArtifact = prevSrc && isBuildArtifact(prevSrc.file) && src && !isBuildArtifact(src.file);
                if (!cur.addrSym.has(a) || overrideArtifact) {
                    cur.addrSym.set(a, n);
                    if (src) cur.addrSource.set(a, src);
                } else if (src && !cur.addrSource.has(a)) {
                    cur.addrSource.set(a, src);
                }
            }
        }

        // Map each source file to ALL modules that own it (module-scoped breakpoints).
        // A file shared across overlays (e.g. printf.s linked into several modules)
        // maps to each, so a breakpoint in it binds in whichever module is active.
        fileToModules = new Map();
        for (const [key, fset] of moduleFiles) {
            for (const f of fset) {
                const k = canonPath(f);
                let list = fileToModules.get(k);
                if (!list) { list = []; fileToModules.set(k, list); }
                if (!list.includes(key)) list.push(key);
            }
        }

        // Default active module: config override, else NONE (resident-only). On boot
        // no overlay is loaded yet, so we don't presume any module is active — the
        // resident _osdk_dbg_module byte (default $ff) drives the switch when a module
        // actually loads and stamps its id. This keeps overlay breakpoints gray and
        // symbol resolution resident-only until an overlay is really in memory.
        let defaultId = null;
        if (moduleNames.size > 0 &&
            typeof config.activeModule === 'number' && moduleNames.has(config.activeModule)) {
            defaultId = config.activeModule;
        }
        // Build the single-source-of-truth resolver from the same file text, sharing
        // getSourceLine so classification reuses the adapter's source cache. Must exist
        // before applyActiveModule so its setActiveModule() hook can fire.
        resolverInstance = buildResolver(fileText, {
            readSourceLine: getSourceLine,
            sourceRoot: config.sourceRoot,
            workspaceFolder: config.workspaceFolder,
        });
        applyActiveModule(defaultId);

        // Parse comment-based debug annotations (@bool/@enum/@bitset) from all
        // header (.h) and assembler (.s) source files referenced by the build.
        parseAnnotations(moduleAllFiles);

        // Union of every module's enum defs, so annotation resolution (@enum/@bitset)
        // works regardless of which module is active — including resident-only at boot.
        allEnumDefs.clear();
        for (const [k, v] of enumDefs) allEnumDefs.set(k, v);
        for (const b of moduleBuckets.values())
            for (const [k, v] of b.enumDefs) if (!allEnumDefs.has(k)) allEnumDefs.set(k, v);

        // Rebuild the symbol registry now that annotations and the enum union are
        // available — the applyActiveModule() above ran before parseAnnotations, so its
        // symInfo had no annotation widths (bcd/bitset) to size symbols with.
        buildSymInfo();

        // Tell the host its symbol cache is stale (spec §6 / Step E) — this is the
        // authoritative "symbols loaded" moment (post-annotations). Runtime module
        // switches emit the same event from their own paths.
        evt('oricSymbolsChanged', { reason: 'load', module: activeModuleId });

        const modNote = moduleNames.size > 0
            ? (' [' + moduleNames.size + ' modules, active=' + (activeModuleId !== null ? moduleNames.get(activeModuleId) : '(none)') + ']') : '';
        log('Loaded ' + symbols.size + ' symbols, ' + lineTable.length + ' line entries, ' +
            typeDefs.size + ' types, ' + varTypes.size + ' typed vars, ' +
            localDefs.size + ' funcs with locals, ' +
            annBySymbol.size + ' annot-symbols, ' + annByField.size + ' annot-fields from ' + file + modNote);
    } catch (e) {
        log('Could not load symbols: ' + e.message);
    }
}

// Scan source and library files to find the original definition of symbols
// whose V2 source info points to a build artifact like linked.s.
function resolveLibrarySources(fileIndex) {
    // Collect symbol names that need resolution: those pointing to build
    // artifacts or with no source info at all.
    const needsResolve = new Map(); // name -> address
    for (const [name, addr] of symbols) {
        const src = symSource.get(name);
        if (!src || isBuildArtifact(src.file)) {
            needsResolve.set(name, addr);
        }
    }
    if (needsResolve.size === 0) return;

    // Gather files to scan:
    // 1. Files from #FILES section (includes library includes)
    // 2. Source files in the workspace
    // 3. OSDK library files (derived from emulator path)
    const filesToScan = new Set();

    // From #FILES (skip build artifacts)
    if (fileIndex) {
        for (const f of fileIndex) {
            if (f && !isBuildArtifact(f)) filesToScan.add(f);
        }
    }

    // Workspace sources
    const wsDir = config.sourceRoot || config.workspaceFolder;
    if (wsDir) {
        try {
            const wsFiles = readdirRecursive(wsDir);
            for (const f of wsFiles) {
                if (/\.(s|asm|inc|h)$/i.test(f)) filesToScan.add(f);
            }
        } catch (_) {}
    }

    // OSDK library: derive from emulator path (e.g. .../Oricutron/Oricutron.exe → .../lib/)
    if (config.emulatorPath) {
        const osdkRoot = path.dirname(path.dirname(config.emulatorPath));
        const libDir = path.join(osdkRoot, 'lib');
        try {
            const libFiles = readdirRecursive(libDir);
            for (const f of libFiles) {
                if (/\.(s|asm|inc|h)$/i.test(f)) filesToScan.add(f);
            }
        } catch (_) {}
    }

    if (filesToScan.size === 0) return;

    // Scan each file for symbol definitions
    for (const filePath of filesToScan) {
        if (needsResolve.size === 0) break;
        let content;
        try { content = fs.readFileSync(filePath, 'utf8'); }
        catch (_) { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            // Match label at start of line: symbolname at column 0 followed by
            // whitespace, colon, =, or a directive (.dsb, .byt, .word, etc.)
            const m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:\s=.]|$)/);
            if (!m) continue;
            const sym = m[1];
            if (!needsResolve.has(sym)) continue;

            const src = { file: filePath, line: i + 1 };
            symSource.set(sym, src);
            const addr = needsResolve.get(sym);
            if (typeof addr === 'number') {
                const existing = addrSource.get(addr);
                if (!existing || isBuildArtifact(existing.file)) {
                    addrSource.set(addr, src);
                }
            }
            needsResolve.delete(sym);
            if (needsResolve.size === 0) return;
        }
    }
    if (needsResolve.size > 0) {
        logVerbose(needsResolve.size + ' symbols still unresolved after library scan');
    }
}

// ----------------------------------------------------------------
// Register helpers
// ----------------------------------------------------------------

// Parse 'g' response: AA XX YY SP PClo PChi FF  (14 hex chars)
function parseRegsG(hex) {
    if (!hex || hex.length < 14) return null;
    return {
        a:  parseInt(hex.substring(0,  2), 16),
        x:  parseInt(hex.substring(2,  4), 16),
        y:  parseInt(hex.substring(4,  6), 16),
        sp: parseInt(hex.substring(6,  8), 16),
        pc: (parseInt(hex.substring(10, 12), 16) << 8) |
             parseInt(hex.substring(8,  10), 16),
        f:  parseInt(hex.substring(12, 14), 16)
    };
}

// Parse stop-reply register annotations:
//   T0500:aa;01:xx;02:yy;03:ss;04:pppp;05:ff;
function parseStopRegs(payload) {
    const r = {};
    const parts = payload.substring(3).split(';');
    for (const p of parts) {
        const c = p.indexOf(':');
        if (c < 0) continue;
        const reg = parseInt(p.substring(0, c), 16);
        const val = p.substring(c + 1);
        switch (reg) {
            case 0: r.a  = parseInt(val, 16); break;
            case 1: r.x  = parseInt(val, 16); break;
            case 2: r.y  = parseInt(val, 16); break;
            case 3: r.sp = parseInt(val, 16); break;
            case 4:
                r.pc = (parseInt(val.substring(2, 4), 16) << 8) |
                        parseInt(val.substring(0, 2), 16);
                break;
            case 5: r.f = parseInt(val, 16); break;
        }
    }
    return r;
}

// ----------------------------------------------------------------
// Asynchronous stop-reply handler
// ----------------------------------------------------------------

async function onStopReply(payload) {
    running = false;
    regs = parseStopRegs(payload);
    // NOTE: do NOT clear varRefs / reset nextVarRef here. Refs are identity-stable
    // (see stableRef) and must persist across stops so VS Code keeps the Variables/
    // Watch tree expanded while stepping. They are only reset on symbol reload /
    // module switch (where the symbol set actually changes).
    clearGdbReadCache();

    // Script-launch entry: we continued through boot/CLOAD and have now hit the
    // --gdb_break at the program entry. Drop that bootstrap breakpoint, then either
    // report the entry stop (stopOnEntry) or continue to the user's breakpoints.
    if (awaitingEntry && regs && regs.pc === initBreakAddr) {
        awaitingEntry = false;
        const bp = initBreakAddr;
        initBreakAddr = -1;
        await gdbCmd('z0,' + bp.toString(16) + ',1');
        if (!config.stopOnEntry) {
            log('Reached entry; running to first breakpoint');
            running = true;
            regs = null;
            gdbWrite('c'); // no 'stopped' event — the entry bp is just a bootstrap
            return;
        }
        log('Stopped at program entry ($' + bp.toString(16) + ')');
        // fall through to emit the stop
    }

    // Module-load watch, phase 2: the dobp=FALSE single step we issued in phase 1
    // has now COMMITTED the write to _osdk_dbg_module, so the byte holds the NEW id.
    // Arm the incoming module and resume — still transparently.
    if (moduleWatchPending) {
        moduleWatchPending = false;
        moduleByteTrusted = true; // a real write to the byte just committed — it's meaningful now
        if (moduleNames.size > 0) await checkModuleSwitch(true); // force: must arm incoming bps before resume, even if a read is in flight
        if (resumeMode === 'run') {
            running = true;
            regs = null;
            gdbWrite('c'); // resume free-run transparently — no 'stopped' event
            return;
        }
        // A step resume that crossed a module load: emit a safe stop after arming.
        onStopReply_emit(null);
        return;
    }

    // Handle continue-past-breakpoint FIRST: single step completed, now issue continue.
    // Must come before tempStepBp cleanup — when both are set (F10 on a line with BP),
    // we need to continue first and clean up the temp BP on the NEXT stop.
    if (continueAfterStep) {
        continueAfterStep = false;
        running = true;
        gdbWrite('c');
        return; // don't emit stopped event — real stop will come through later
    }

    // Source-level Step Into: keep single-stepping until the source line changes (which
    // includes stepping into a callee, whose entry has its own line). Bounded so a step
    // into source-less code can't loop forever — when the budget runs out we stop here.
    if (stepInInProgress) {
        const here = regs ? sourceFor(regs.pc) : null;
        const arrived = here && (here.file !== stepInStartFile || here.line !== stepInStartLine);
        if (!arrived && stepInBudget-- > 0) {
            running = true;
            regs = null;
            gdbWrite('s'); // keep stepping — no 'stopped' event yet
            return;
        }
        stepInInProgress = false; // arrived at a new line (or budget exhausted) — fall through and stop
    }

    const sig = parseInt(payload.substring(1, 3), 16);

    // Parse extended stop-reply fields
    let cyclesDelta = null;
    let watchAddr = null;
    let watchType = null;
    const parts = payload.substring(3).split(';');
    for (const p of parts) {
        if (p.startsWith('OricCycles:')) {
            cyclesDelta = parseInt(p.substring(11), 16);
        } else if (p.startsWith('watch:')) {
            watchAddr = parseInt(p.substring(6), 16);
            watchType = 'write';
        } else if (p.startsWith('rwatch:')) {
            watchAddr = parseInt(p.substring(7), 16);
            watchType = 'read';
        } else if (p.startsWith('awatch:')) {
            watchAddr = parseInt(p.substring(7), 16);
            watchType = 'access';
        }
    }

    // Module-load watch, phase 1: an instruction is ABOUT to write _osdk_dbg_module
    // (the watchpoint stops before the write commits). We can't read the new id yet,
    // and a plain continue would re-run this same write and re-trigger forever. So
    // single-step it: 's' uses dobp=FALSE, which both steps off the watchpoint and
    // commits the write without re-triggering. Phase 2 (above) then reads the new id,
    // arms the incoming module, and resumes — the whole handoff is invisible, so a
    // JSR through a routine that touches the flag never surfaces. Also covers the
    // benign boot-time writes (loader relocation stamping the $ff sentinel): those
    // step through and checkModuleSwitch simply finds no valid module.
    // Handled BEFORE temp-BP cleanup so a Turbo Run's cursor breakpoint survives.
    if (watchType === 'write' && moduleWatchAddr >= 0 && watchAddr === moduleWatchAddr) {
        moduleWatchPending = true;
        running = true;
        regs = null;
        gdbWrite('s'); // dobp=FALSE step: commits the write, no re-trigger
        return;
    }

    // Clean up temp breakpoint from source-level stepping (F10/F11).
    // Ref-counted: if a real breakpoint shares this address it survives.
    if (tempStepBp >= 0) {
        const addr = tempStepBp;
        tempStepBp = -1;
        disarmAddr(addr); // release temp BP asynchronously
    }

    // Handle cycle annotation from step-over
    // The annotation belongs on the JSR instruction line (PC-3), not the return address
    lastCycleAnnotation = null;
    if (cyclesDelta !== null && regs && regs.pc !== undefined) {
        const jsrPc = (regs.pc - 3) & 0xFFFF;
        const src = sourceFor(jsrPc);
        lastCycleAnnotation = {
            pc: jsrPc,
            cycles: cyclesDelta,
            symbol: symbolAt(jsrPc),
            file: src ? src.file : null,
            line: src ? src.line : 0
        };
    }

    // Auto-select the symbol module from the resident _osdk_dbg_module byte
    // (before emitting 'stopped', so VS Code queries stack/vars with the right symbols).
    // Guarded so single-module sessions keep a fully synchronous stop path.
    if (moduleNames.size > 0) await checkModuleSwitch();

    // Sync any by-hand monitor breakpoint edits into VS Code's model.
    await reconcileMonitorBreakpoints();

    onStopReply_emit(watchAddr);
}

// Arm a hidden write-watchpoint on the resident _osdk_dbg_module byte. When an
// overlay module switches during free-run it stamps this byte first (SET_MODULE is
// emitted at each module's entry), so the watch gives us a brief stop to arm the
// incoming module's breakpoints BEFORE its code runs — then we resume transparently
// (see onStopReply). Without it, an overlay's breakpoints would only arm at the next
// unrelated stop and the CPU would run straight past them on first load.
// Internal/hidden: tracked only in moduleWatchAddr, never surfaced to VS Code or
// stored in dataBps, so the user can't delete it by accident. Multi-module only.
async function armModuleWatch() {
    // Clear a previously-armed module watch first. A restart reuses the same socket
    // and resetoric preserves watchpoints, so re-arming without clearing would leak a
    // stub watchpoint slot every restart (16 → the feature dies).
    if (moduleWatchAddr >= 0) {
        await gdbCmd('z2,' + moduleWatchAddr.toString(16) + ',1');
    }
    moduleWatchAddr = -1;
    if (moduleNames.size === 0) { log('Module-load watch: skipped — no #MODULE sections'); return; }
    const addr = symbols.get('_osdk_dbg_module');
    if (addr === undefined) { log('Module-load watch: skipped — _osdk_dbg_module symbol not found'); return; }
    const a = addr & 0xffff;
    const r = await gdbCmd('Z2,' + a.toString(16) + ',1'); // Z2 = write watchpoint
    if (r === 'OK') {
        moduleWatchAddr = a;
        log('Module-load watch armed on _osdk_dbg_module ($' + a.toString(16) + ')');
    } else {
        log('Module-load watch FAILED to arm at $' + a.toString(16) + ' — stub reply: ' + r);
    }
}

// Reconcile the stub's live execution-breakpoint table (shared between the GDB
// stub and Oricutron's own monitor) against what THIS adapter armed. Any address
// the stub has that we didn't arm was set by hand in the monitor → promote it into
// VS Code's model. Any address we armed that the stub no longer has was cleared in
// the monitor → remove it from VS Code. Oricutron is thus just another bp view.
async function reconcileMonitorBreakpoints() {
    const reply = await gdbCmd('qOricBreakpoints');
    // Guard: only act on a stub new enough to answer (reply starts with "bp:").
    // An old stub returns an empty packet — treating that as "no breakpoints"
    // would wrongly wipe the model.
    if (typeof reply !== 'string' || !reply.startsWith('bp:')) return;

    const stubAddrs = new Set();
    const list = reply.slice(3);
    if (list.length) {
        for (const tok of list.split(',')) {
            const a = parseInt(tok, 16);
            if (!isNaN(a)) stubAddrs.add(a & 0xffff);
        }
    }

    const locFor = a => { const s = sourceFor(a); return s ? { address: a, file: s.file, line: s.line } : { address: a }; };
    const added = [];
    for (const a of stubAddrs) if (!armedAddrs.has(a)) added.push(locFor(a));
    const removed = [];
    for (const a of armedAddrs.keys()) if (!stubAddrs.has(a)) removed.push(locFor(a));

    if (added.length || removed.length) evt('oricMonitorBreakpoints', { added, removed });
}

// Emit the stopped event — used by onStopReply and by source-level stepping
function onStopReply_emit(watchAddr) {
    // Turbo Run reached a stop — restore the prior warp state
    if (turboWarpActive) {
        turboWarpActive = false;
        if (!turboPrevWarp) gdbCmd('qOricWarp,0');
    }
    // Determine stop reason
    let reason = 'step';
    let hitIds;

    if (watchAddr !== null && watchAddr !== undefined) {
        reason = 'data breakpoint';
    } else if (regs && regs.pc !== undefined) {
        // Collect EVERY logical breakpoint at this PC across all kinds, so if the
        // same address is covered by more than one breakpoint VS Code lights up all
        // of them (not just the first). Disarmed source bps can't have fired.
        const ids = [];
        for (const [id, bp] of bps)  { if (bp.addr === regs.pc) ids.push(id); }
        for (const [id, bp] of ibps) { if (bp.addr === regs.pc) ids.push(id); }
        for (const [, arr] of srcBps) {
            for (const bp of arr) { if (bp.bindings.some(b => b.addr === regs.pc && b.armed)) ids.push(bp.id); }
        }
        if (ids.length) { reason = 'breakpoint'; hitIds = ids; }
    }

    const body = { reason: reason, threadId: 1, allThreadsStopped: true };
    if (hitIds) body.hitBreakpointIds = hitIds;

    if (configDone) {
        const pc = regs ? regs.pc : -1;
        log('Stop: reason=' + reason + ' pc=$' + (pc >= 0 ? pc.toString(16).toUpperCase().padStart(4, '0') : '?') +
            (hitIds ? ' bp=' + hitIds.join(',') : ''));
        evt('stopped', body);
        // Send cycle annotation as custom event
        if (lastCycleAnnotation) {
            evt('cycleAnnotation', lastCycleAnnotation);
        }
    } else {
        pendingStop = body;
    }
}

// ----------------------------------------------------------------
// 6502 disassembler
// ----------------------------------------------------------------

// Compact opcode table: 'MNEm' = 3-char mnemonic + 1-char mode, or 0 = illegal
// Modes: I=implied A=accumulator #=immediate z=zp x=zp,X y=zp,Y
//        a=absolute X=abs,X Y=abs,Y n=indirect (=izx )=izy r=relative
const OPS = [
'BRKI','ORA(', 0,0, 0,    'ORAz','ASLz', 0, 'PHPI','ORA#','ASLA', 0, 0,    'ORAa','ASLa', 0,
'BPLr','ORA)', 0,0, 0,    'ORAx','ASLx', 0, 'CLCI','ORAY', 0,     0, 0,    'ORAX','ASLX', 0,
'JSRa','AND(', 0,0,'BITz','ANDz','ROLz', 0, 'PLPI','AND#','ROLA', 0,'BITa','ANDa','ROLa', 0,
'BMIr','AND)', 0,0, 0,    'ANDx','ROLx', 0, 'SECI','ANDY', 0,     0, 0,    'ANDX','ROLX', 0,
'RTII','EOR(', 0,0, 0,    'EORz','LSRz', 0, 'PHAI','EOR#','LSRA', 0,'JMPa','EORa','LSRa', 0,
'BVCr','EOR)', 0,0, 0,    'EORx','LSRx', 0, 'CLII','EORY', 0,     0, 0,    'EORX','LSRX', 0,
'RTSI','ADC(', 0,0, 0,    'ADCz','RORz', 0, 'PLAI','ADC#','RORA', 0,'JMPn','ADCa','RORa', 0,
'BVSr','ADC)', 0,0, 0,    'ADCx','RORx', 0, 'SEII','ADCY', 0,     0, 0,    'ADCX','RORX', 0,
 0,    'STA(', 0,0,'STYz','STAz','STXz', 0, 'DEYI', 0,    'TXAI', 0,'STYa','STAa','STXa', 0,
'BCCr','STA)', 0,0,'STYx','STAx','STXy', 0, 'TYAI','STAY','TXSI', 0, 0,    'STAX', 0,     0,
'LDY#','LDA(','LDX#',0,'LDYz','LDAz','LDXz',0,'TAYI','LDA#','TAXI',0,'LDYa','LDAa','LDXa',0,
'BCSr','LDA)', 0,0,'LDYx','LDAx','LDXy', 0, 'CLVI','LDAY','TSXI', 0,'LDYX','LDAX','LDXY', 0,
'CPY#','CMP(', 0,0,'CPYz','CMPz','DECz', 0, 'INYI','CMP#','DEXI', 0,'CPYa','CMPa','DECa', 0,
'BNEr','CMP)', 0,0, 0,    'CMPx','DECx', 0, 'CLDI','CMPY', 0,     0, 0,    'CMPX','DECX', 0,
'CPX#','SBC(', 0,0,'CPXz','SBCz','INCz', 0, 'INXI','SBC#','NOPI', 0,'CPXa','SBCa','INCa', 0,
'BEQr','SBC)', 0,0, 0,    'SBCx','INCx', 0, 'SEDI','SBCY', 0,     0, 0,    'SBCX','INCX', 0,
];

function opSize(mode) {
    if (mode === 'I' || mode === 'A') return 1;
    if (mode === 'a' || mode === 'X' || mode === 'Y' || mode === 'n') return 3;
    return 2;
}

function fmtOp(mode, lo, hi, pc) {
    const h2 = v => v.toString(16).toUpperCase().padStart(2, '0');
    const h4 = v => v.toString(16).toUpperCase().padStart(4, '0');
    // Resolve an address to a symbol name, or fall back to hex
    const s = (addr, w) => symbolAt(addr) || ('$' + (w === 2 ? h2(addr) : h4(addr)));
    switch (mode) {
        case 'I': return '';
        case 'A': return 'A';
        case '#': return '#$' + h2(lo);
        case 'z': return s(lo, 2);
        case 'x': return s(lo, 2) + ',X';
        case 'y': return s(lo, 2) + ',Y';
        case 'a': return s((hi << 8) | lo, 4);
        case 'X': return s((hi << 8) | lo, 4) + ',X';
        case 'Y': return s((hi << 8) | lo, 4) + ',Y';
        case 'n': return '(' + s((hi << 8) | lo, 4) + ')';
        case '(': return '(' + s(lo, 2) + ',X)';
        case ')': return '(' + s(lo, 2) + '),Y';
        case 'r': {
            const target = (pc + 2 + (lo < 128 ? lo : lo - 256)) & 0xFFFF;
            return s(target, 4);
        }
    }
    return '';
}

// ----------------------------------------------------------------
// Call stack walker — decode return addresses from the 6502 page 1 stack
// ----------------------------------------------------------------

// Resolve address to source location — prefers line table (instruction-level),
// falls back to symbol-based addrSource (label-level)
// Lazy-load source file, return line string (1-based) or null.
function getSourceLine(filePath, line) {
    if (!sourceLineCache[filePath]) {
        try {
            sourceLineCache[filePath] = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        } catch (e) {
            sourceLineCache[filePath] = [];
        }
    }
    const lines = sourceLineCache[filePath];
    if (line >= 1 && line <= lines.length) return lines[line - 1];
    return null;
}

// Address -> source {file,line} through the single-source-of-truth resolver (owner-
// reconciled nearest line; absolute paths). Returns null when no plausible line maps to
// `addr`. One authority — no separate lineTable/addrSource walk (see SPEC §6).
function sourceFor(addr) {
    const r = resolverInstance ? resolverInstance.resolve(addr & 0xFFFF) : null;
    return r && r.source ? { file: r.source.file, line: r.source.line } : null;
}

// Symbol sitting EXACTLY at `addr` (the resolver's canonical owner among aliases),
// or null. Operand and instruction labels stay exact-match — nearest-below
// "name+$off" rendering would turn every plain "$hhhh" operand into offset noise.
// One authority: replaces direct addrSym reads (SPEC §7 step 4).
function symbolAt(addr) {
    const r = resolverInstance ? resolverInstance.resolve(addr & 0xFFFF) : null;
    return r && r.symbol && r.symbol.offset === 0 ? r.symbol.name : null;
}

// Find the function containing `pc` by looking for the largest symbol address <= pc
// that appears as a key in localDefs. Returns the function's asm name or null.
function currentFunction(pc) {
    // A function's code runs from its entry up to the next C-linkage symbol. C symbols
    // (functions and globals) are '_'-prefixed; compiler-generated intermediate labels
    // (Lmain132, skip, ...) are not, so bounding by the next '_' symbol gives the
    // function's real extent. Without this upper bound, a pc inside a locals-less
    // function (e.g. main, whose ints are register-allocated) was wrongly attributed to
    // the preceding function-with-locals, showing that function's locals.
    const endOf = (a) => {
        let e = 0x10000;
        for (const [nm, na] of symbols)
            if (typeof na === 'number' && nm[0] === '_' && na > a && na < e) e = na;
        return e;
    };
    let bestName = null, bestAddr = -1;
    for (const [funcName] of localDefs) {
        const addr = symbols.get(funcName);
        if (typeof addr === 'number' && addr <= pc && pc < endOf(addr) && addr > bestAddr) {
            bestAddr = addr;
            bestName = funcName;
        }
    }
    return bestName;
}

// Per-stop GDB read cache — prevents duplicate memory reads within the same stop cycle.
// Cleared each time we receive a stop notification (T05/S05).
let gdbReadCache = new Map();

// qOricEval failure cache — symbols that returned E02 (not found) are cached
// so we don't re-query Oricutron for the same expression on every step.
// Cleared when symbols are reloaded.
let evalFailCache = new Set();

function clearGdbReadCache() {
    gdbReadCache.clear();
}

// Read memory from the emulator. Returns a Uint8Array of `len` bytes starting at `addr`.
async function readMem(addr, len) {
    if (len <= 0) return new Uint8Array(0);
    const cacheKey = addr + ':' + len;
    const cached = gdbReadCache.get(cacheKey);
    if (cached) return cached;
    const hexLen = len.toString(16);
    const hexAddr = addr.toString(16);
    const reply = await gdbCmd('m' + hexAddr + ',' + hexLen);
    if (!reply || reply[0] === 'E') return new Uint8Array(len); // zeros on error
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len && i * 2 + 1 < reply.length; i++) {
        bytes[i] = parseInt(reply.substring(i * 2, i * 2 + 2), 16);
    }
    gdbReadCache.set(cacheKey, bytes);
    return bytes;
}

// Numeric part shared by enum display: "$hex|dec|%binary" (no char glyph — an
// enum byte is a code/flag word, not text).
function enumNumeric(v, size) {
    if (size >= 2)
        return '$' + v.toString(16).toUpperCase().padStart(4, '0') + '|' + v + '|%' + v.toString(2).padStart(16, '0');
    return '$' + v.toString(16).toUpperCase().padStart(2, '0') + '|' + v + '|%' + v.toString(2).padStart(8, '0');
}

// Format an enum-typed value symbolically. Sequential enums map value->name;
// bitmask enums (def.isFlags, detected at parse time) decompose the set bits
// into "A|B|C". The raw number is always shown too.
function formatEnum(def, mem, offset, size) {
    const v = size >= 2 ? ((mem[offset] || 0) | ((mem[offset + 1] || 0) << 8)) : (mem[offset] || 0);
    const num = enumNumeric(v, size);
    if (def.isFlags) {
        if (v === 0) return (def.byValue.get(0) || '0') + ' (' + num + ')';
        const names = [];
        let remaining = v;
        for (let bit = 1; bit <= 0x8000 && remaining; bit <<= 1) {
            if (v & bit) {
                names.push(def.byValue.get(bit) || ('bit$' + bit.toString(16).toUpperCase()));
                remaining &= ~bit;
            }
        }
        return names.join('|') + ' (' + num + ')';
    }
    // Sequential enum: single value lookup. Unknown value -> just the number.
    return def.byValue.has(v) ? def.byValue.get(v) + ' (' + num + ')' : num;
}

// Format a scalar value from raw bytes for display
function formatScalar(typeName, mem, offset, size) {
    const ed = resolveEnum(typeName);   // case-sensitive: enum tags before lowercasing
    if (ed) return formatEnum(ed, mem, offset, size);
    const t = typeName.toLowerCase();
    const isSigned = (t === 'char' || t === 'schar' || t === 'int' || t === 'short' || t === 'sint' || t === 'sshort');
    // Uniform "hex|dec|%binary" form, matching the disassembly annotations.
    if (size === 1) {
        const v = mem[offset] || 0;
        const sv = (isSigned && v > 127) ? v - 256 : v;
        // Show the ASCII glyph for any displayable byte value, whatever the type.
        const ch = (v >= 32 && v < 127) ? " '" + String.fromCharCode(v) + "'" : '';
        return '$' + v.toString(16).toUpperCase().padStart(2, '0') + '|' + (isSigned ? sv : v) + '|%' + v.toString(2).padStart(8, '0') + ch;
    } else if (size === 2) {
        const w = (mem[offset] || 0) | ((mem[offset + 1] || 0) << 8);
        const sv = (isSigned && w > 32767) ? w - 65536 : w;
        return '$' + w.toString(16).toUpperCase().padStart(4, '0') + '|' + (isSigned ? sv : w) + '|%' + w.toString(2).padStart(16, '0');
    }
    // Larger types: raw hex bytes.
    let hex = '';
    for (let i = 0; i < size && (offset + i) < mem.length; i++)
        hex += (mem[offset + i] || 0).toString(16).toUpperCase().padStart(2, '0') + ' ';
    return hex.trim();
}

// Format a char/uchar byte array as a quoted ASCII string preview.
// Non-printable bytes shown as dots.  Returns null if all zeros (empty).
function formatCharArray(mem, offset, len) {
    let allZero = true;
    let str = '';
    for (let i = 0; i < len && (offset + i) < mem.length; i++) {
        const b = mem[offset + i] || 0;
        if (b !== 0) allZero = false;
        if (b === 0) break;           // null terminator — stop
        str += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
    }
    if (allZero) return '""';
    return '"' + str + '"';
}

// Check whether a type name is a char/uchar scalar (for string preview)
function isCharType(typeName) {
    const t = typeName.toLowerCase();
    return t === 'char' || t === 'uchar' || t === 'schar' || t === 'unsigned char' || t === 'signed char';
}

// Show a brief preview of a struct's first few fields
function formatStructPreview(def, mem, offset) {
    const parts = [];
    for (let i = 0; i < Math.min(def.fields.length, 3); i++) {
        const f = def.fields[i];
        if (f.size <= 2 && !f.type.match(/\[/)) {
            const val = formatScalar(f.type, mem, offset + f.offset, f.size);
            parts.push(f.name + '=' + val.split(' ')[0]); // just the hex part
        }
    }
    return parts.length > 0 ? '{' + parts.join(', ') + '}' : '{...}';
}

// Number of bytes a bitset over `ed` spans (highest enumerator value determines it).
function bitsetBytes(ed) {
    let max = 0;
    for (const k of ed.byValue.keys()) if (k > max) max = k;
    return (max >> 3) + 1;
}

// Parse comment-based debug annotations from all source files (.h uses "// @...",
// .s uses "; @..."). Rebuilds annByField (C struct members) and annBySymbol
// (C globals & asm data labels). Directives: @bool, @enum <E>, @bitset <E>.
function parseAnnotations(files) {
  annByField.clear();
  annBySymbol.clear();
  try {
    const ANN = /@(bool|enum|bitset|ptr16|bcd(?:-[bl]e)?)\b\s*(\w+)?/;   // matched within the comment portion
    const seen = new Set();
    // Struct-field annotations (@bool/@enum/@bitset/@bcd on C struct members) live in
    // headers, but #FILES lists only compilation units (.c/.s) — no .h. Pull in sibling
    // .h files from each source directory so header struct annotations are parsed too.
    const allFiles = [...files];
    const dirs = new Set();
    for (const f of files) { try { dirs.add(path.dirname(f)); } catch (e) { /* skip */ } }
    for (const d of dirs) {
        let entries; try { entries = fs.readdirSync(d); } catch (e) { continue; }
        for (const e of entries) if (/\.h$/i.test(e)) allFiles.push(path.join(d, e));
    }
    for (const f of allFiles) {
        let key; try { key = canonPath(f); } catch (e) { key = String(f); }
        if (seen.has(key)) continue;
        seen.add(key);
        let lines;
        try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); }
        catch (e) { continue; }
        const isAsm = /\.(s|asm)$/i.test(f);
        let inStruct = false, structName = null, pending = [];
        for (const line of lines) {
            // Enter a C struct/union body (name may be trailing on the '}' line).
            if (!isAsm && !inStruct && /\b(typedef\s+)?(struct|union)\b/.test(line)
                && !/;/.test(line.replace(/\/\/.*$/, ''))) {
                inStruct = true; pending = [];
                const nm = line.match(/(?:struct|union)\s+([A-Za-z_]\w*)\s*\{/);
                structName = nm ? nm[1] : null;
            }
            // Split code from comment. C comment = "//"; asm also allows ";".
            let ci = line.indexOf('//');
            if (isAsm) {
                const s = line.indexOf(';');
                if (s >= 0 && (ci < 0 || s < ci)) ci = s;
            }
            const code = ci >= 0 ? line.slice(0, ci) : line;
            const comment = ci >= 0 ? line.slice(ci) : '';
            const m = comment.match(ANN);
            if (m) {
                const directive = { kind: m[1], enumName: m[2] || null };
                // @bcd[-be|-le] carries an optional byte width (e.g. "@bcd-be 3");
                // the trailing token is a count, not an enum name. Multi-byte BCD
                // fields can't be sized reliably from symbol-address gaps (an
                // inherited symbol may sit inside the field), so the width is
                // self-described here and defaults to 2.
                if (m[1].indexOf('bcd') === 0) {
                    directive.enumName = null;
                    if (m[2] && /^\d+$/.test(m[2])) directive.size = parseInt(m[2], 10);
                }
                let name = null;
                if (isAsm) {
                    const t = code.match(/^\s*([A-Za-z_.][\w.]*)/);
                    name = t ? t[1] : null;
                } else {
                    const c = code.replace(/[=;].*$/, '').replace(/\[.*$/, '');
                    const ids = c.match(/[A-Za-z_]\w*/g);
                    name = ids ? ids[ids.length - 1] : null;
                }
                if (name) {
                    if (!isAsm && inStruct) pending.push({ field: name, directive });
                    else annBySymbol.set(name.replace(/^_+/, ''), directive);
                }
            }
            // Close a C struct: flush buffered field annotations under its name.
            if (!isAsm && inStruct && /\}/.test(line)) {
                const nm = line.match(/\}\s*([A-Za-z_]\w*)\s*;/);
                if (nm) structName = nm[1];
                if (structName) for (const p of pending) annByField.set(structName + '.' + p.field, p.directive);
                inStruct = false; structName = null; pending = [];
            }
        }
    }
  } catch (e) {
    logError('parseAnnotations', e);
  }
}

// Shared @ptr16 value rendering: the 16-bit word at `baseAddr` and what it points
// to right now (target symbol if known, else the byte there). Used by both the
// Watch/scope views (formatAnnotated) and the disassembly operand annotator, so
// the two stay in one format.
async function ptr16Str(baseAddr) {
    const w = await readMem(baseAddr & 0xFFFF, 2);
    const word = w[0] | (w[1] << 8);
    let s = '$' + word.toString(16).toUpperCase().padStart(4, '0');
    const tgt = symbolAt(word);
    if (tgt) s += ' →' + tgt;
    else { const b = await readMem(word, 1); s += ' →$' + (b[0] || 0).toString(16).toUpperCase().padStart(2, '0'); }
    return s;
}

// Render a value using a comment annotation (@bool/@enum/@bitset/@ptr16/@bcd).
// Returns { value, ref? } or null. bitset returns an expandable ref (children = set bits).
async function formatAnnotated(ann, addr, size) {
    if (ann.kind === 'ptr16') {
        return { value: await ptr16Str(addr), type: 'ptr16' };
    }
    if (ann.kind === 'bcd' || ann.kind === 'bcd-be' || ann.kind === 'bcd-le') {
        // Packed BCD: two decimal digits per byte, concatenated most-significant-first
        // -> the human-readable number. Byte order: @bcd-be / @bcd (default) = MSB at
        // the lowest address; @bcd-le = LSB at the lowest address. A nibble outside 0-9
        // (invalid BCD) shows as its hex letter so it stands out. Raw bytes shown in
        // address order for reference.
        // Width: the annotation's own count wins; otherwise at least 2 bytes, since
        // the size handed in (from symbol-gap inference / Watch) is unreliable here.
        const sz = ann.size || Math.max(size || 0, 2);
        const mem = await readMem(addr, sz);
        const le = ann.kind === 'bcd-le';
        let digits = '', raw = '';
        for (let k = 0; k < sz; k++) {
            const b = mem[le ? (sz - 1 - k) : k] || 0;
            digits += (b >> 4).toString(16) + (b & 0x0f).toString(16);
        }
        for (let i = 0; i < sz; i++) raw += (i ? ' $' : '$') + (mem[i] || 0).toString(16).toUpperCase().padStart(2, '0');
        return { value: digits + '  (' + raw + ')', type: ann.kind };
    }
    if (ann.kind === 'bool') {
        const v = (await readMem(addr, 1))[0] || 0;
        return { value: (v ? 'true' : 'false') + '  ($' + v.toString(16).toUpperCase().padStart(2, '0') + '|' + v + ')', type: 'bool' };
    }
    if (ann.kind === 'enum') {
        const ed = resolveEnum(ann.enumName);
        const sz = size || 1;
        const mem = await readMem(addr, sz);
        return { value: ed ? formatEnum(ed, mem, 0, sz) : formatScalar('uchar', mem, 0, sz), type: ann.enumName || 'enum' };
    }
    if (ann.kind === 'bitset') {
        const ed = resolveEnum(ann.enumName);
        const sz = size || (ed ? bitsetBytes(ed) : 1);
        const mem = await readMem(addr, sz);
        let count = 0;
        for (let p = 0; p < sz * 8; p++) if (mem[p >> 3] & (1 << (p & 7))) count++;
        const ref = stableRef('bit:' + (addr & 0xFFFF) + ':' + ann.enumName + ':' + sz,
                              { kind: 'bitset', addr: addr & 0xFFFF, size: sz, enumName: ann.enumName });
        return { value: '{' + count + ' set}', ref, type: ann.enumName || 'bitset' };
    }
    return null;
}

// ============================================================================
// THE single render path for "a named value at an address". EVERY view MUST go
// through here — Globals, Locals, Zero-page, Watch/evaluate, struct-field and
// array-element expansion, and any future scope ("auto", etc.). Do NOT format a
// variable's value inline in a handler: that path drift is what silently broke
// annotations in the Watch window. Handles scalars, enums, structs, arrays,
// pointer-to-struct, and comment annotations (@bool/@enum/@bitset via `ann`).
// Look up `ann` with annForSymbol(name) for symbols or annByField for fields;
// resolve enums with resolveEnum() so it works regardless of the active module.
// (Registers/Flags are CPU state, not memory-typed values — they legitimately
// render separately.) See CORE-CONCEPTS.md → "One render path".
// ============================================================================
async function buildTypedVar(name, addr, fullType, size, ann) {
    addr &= 0xFFFF;
    const hAddr = '$' + addr.toString(16).toUpperCase().padStart(4, '0');
    // Comment annotation (@bool/@enum/@bitset) overrides the default rendering.
    if (ann) {
        const a = await formatAnnotated(ann, addr, size);
        // Show the detected type token (e.g. "bcd-be", "bool", the enum name) the same
        // way the scalar path shows fullType, so annotated values read consistently.
        if (a) {
            const t = a.type ? '  ' + a.type : '';
            return { name, value: a.value + t + '  @ ' + hAddr, variablesReference: a.ref || 0 };
        }
    }
    // Pointer (`*T`): value is the pointed-to address; expandable to that struct.
    if (fullType[0] === '*') {
        const pointed = fullType.slice(1);
        const m = await readMem(addr, 2);
        const target = (m[0] | (m[1] << 8)) & 0xFFFF;
        const tHex = '$' + target.toString(16).toUpperCase().padStart(4, '0');
        if (typeDefs.has(pointed) && target !== 0) {
            const ref = stableRef('ptr:' + target + ':' + pointed,
                                  { addr: target, typeName: pointed, count: 1 });
            return { name, value: fullType + ' → ' + tHex + '  @ ' + hAddr, variablesReference: ref };
        }
        return { name, value: fullType + ' = ' + tHex + '  @ ' + hAddr, variablesReference: 0 };
    }
    const am = fullType.match(/^(.+)\[(\d+)\]$/);
    const base = am ? am[1] : fullType;
    const count = am ? parseInt(am[2], 10) : 1;
    if (typeDefs.has(base) || count > 1) {
        const ref = stableRef('st:' + addr + ':' + base + ':' + count,
                              { addr, typeName: base, count, totalSize: size });
        let val = fullType + '  @ ' + hAddr;
        if (count > 1 && isCharType(base)) {
            const mem = await readMem(addr, size);
            val = formatCharArray(mem, 0, count) + '  ' + fullType + '  @ ' + hAddr;
        }
        return { name, value: val, variablesReference: ref };
    }
    const mem = await readMem(addr, size);
    return { name, value: formatScalar(base, mem, 0, size) + '  ' + fullType + '  @ ' + hAddr, variablesReference: 0 };
}

// Check if a file path looks like a build artifact (linked.s, etc.)
function isBuildArtifact(filePath) {
    const base = path.basename(filePath).toLowerCase();
    return base === 'linked.s' || base === 'linked.asm';
}

// Address of the next different source line after `pc` (source-level
// step-over's temp-bp target) — thin wrapper over the resolver's inverse
// mapping (§5.6). Returns -1 when the file ends (caller falls back to
// instruction stepping).
function findNextSourceLineAddr(pc, file, line) {
    return resolverInstance ? resolverInstance.nextLineAddr(pc, file, line) : -1;
}

// Arm an execution breakpoint (Z0) in the stub, ref-counted so that N logical
// breakpoints (source/function/instruction/temp) sharing one address arm exactly
// one Z0. Returns true if the address is armed after the call. See armedAddrs.
async function armAddr(addr) {
    const n = armedAddrs.get(addr) || 0;
    armedAddrs.set(addr, n + 1);
    if (n === 0) {
        const r = await gdbCmd('Z0,' + addr.toString(16) + ',1');
        if (r !== 'OK') { armedAddrs.delete(addr); return false; } // roll back on failure
    }
    return true;
}

// Release one reference to an execution breakpoint; sends z0 only when the last
// logical breakpoint at that address goes away.
async function disarmAddr(addr) {
    const n = armedAddrs.get(addr) || 0;
    if (n <= 1) {
        armedAddrs.delete(addr);
        if (n >= 1) await gdbCmd('z0,' + addr.toString(16) + ',1');
    } else {
        armedAddrs.set(addr, n - 1);
    }
}

// Check if any user-set breakpoint is armed (live in the stub) at this address.
// Disarmed source breakpoints (inactive overlay module) don't count.
function isBreakpointAt(addr) {
    for (const [, bp] of bps)  { if (bp.addr === addr) return true; }
    for (const [, bp] of ibps) { if (bp.addr === addr) return true; }
    for (const [, arr] of srcBps) { for (const bp of arr) { for (const b of bp.bindings) if (b.addr === addr && b.armed) return true; } }
    return false;
}

// Resolve a source file+line to an address in the ACTIVE composed view —
// thin wrapper over the resolver's inverse mapping (§5.6). Breakpoint binding
// passes the resolver's module restriction instead (see setBreakpoints).
function resolveSrcLineAddr(file, reqLine) {
    const r = resolverInstance ? resolverInstance.addrForLine(file, reqLine) : null;
    return r ? r.addr : -1;
}

// Is the line mapped at `addr` executable code? Movement actions (run-to /
// jump / turbo) on a DATA line are traps: the breakpoint never hits, or the
// PC lands inside storage. C/H lines always count as code — a C statement is
// not a 6502 mnemonic and C emits many instructions per line, so both the
// source-text and run-delta classifiers misread them (same special case as
// resolve()'s nearest-symbol gate).
function executableLine(addr, file) {
    if (!resolverInstance) return true; // no resolver: don't block
    if (/\.[ch]$/i.test(file || '')) return true;
    return resolverInstance.resolve(addr & 0xFFFF).kind === 'code';
}

// Arm a Turbo Run: optional one-shot breakpoint at addr, then enable warp,
// remembering the prior warp state so onStopReply_emit can restore it.
// warp=false arms only the one-shot breakpoint (plain run-to-address at normal
// speed — the disassembly panel's "Run to Here") on the SAME path, so target
// handling can't drift between the two.
async function armTurbo(addr, warp = true) {
    resumeMode = 'run';
    if (addr >= 0) {
        // Ref-counted: safe even if a real breakpoint already sits here — cleanup
        // decrements without removing the user's breakpoint.
        await armAddr(addr);
        tempStepBp = addr;
    }
    if (!warp) return;
    const prev = await gdbCmd('qOricWarp');
    turboPrevWarp = (prev === '1');
    await gdbCmd('qOricWarp,1');
    turboWarpActive = true;
}

// Resolve address to nearest symbol label
// Address -> display label through the single resolver: exact symbol name, else nearest
// symbol "name+$off", else "$hhhh". One authority (no separate addrSym walk); the resolver's
// owner rule keeps this consistent with the call stack / disassembly / annotations.
function labelFor(addr) {
    addr &= 0xFFFF;
    const r = resolverInstance ? resolverInstance.resolve(addr) : null;
    if (r && r.symbol)
        return r.symbol.offset ? r.symbol.name + '+$' + r.symbol.offset.toString(16).toUpperCase() : r.symbol.name;
    return '$' + addr.toString(16).toUpperCase().padStart(4, '0');
}

// Walk the hardware stack (page 1) and identify JSR return addresses.
// JSR pushes (PC+2) onto the stack (the last byte of the JSR instruction),
// so the return address is (stack word) + 1.
// Uses a single GDB read for the stack, then verifies candidates in bulk.
async function buildCallStack() {
    if (!regs || regs.sp === undefined) return [];

    const sp = regs.sp;
    const stackSize = 0xFF - sp;
    if (stackSize < 2) return [];

    // Read stack bytes — uses readMem (which has per-stop dedup cache)
    const stackAddr = 0x0100 + sp + 1;
    const readSize = Math.min(stackSize, 64);
    const stk = await readMem(stackAddr, readSize);

    // Collect all candidate JSR addresses for bulk verification
    const candidates = [];
    for (let pos = 0; pos + 1 < stk.length && candidates.length < 16; pos++) {
        const lo = stk[pos];
        const hi = stk[pos + 1];
        const retAddr = (((hi << 8) | lo) + 1) & 0xFFFF;
        if (retAddr > 0x01FF && retAddr < 0xFFF0) {
            candidates.push({ pos: pos, retAddr: retAddr, jsrAddr: (retAddr - 3) & 0xFFFF });
        }
    }
    if (candidates.length === 0) return [];

    // Find contiguous range covering all JSR verification addresses,
    // then read them in a single GDB command
    const minAddr = Math.min(...candidates.map(c => c.jsrAddr));
    const maxAddr = Math.max(...candidates.map(c => c.jsrAddr));
    const rangeSize = maxAddr - minAddr + 1;

    let verifyMem = null;
    if (rangeSize <= 4096) {
        // Reasonable range — read in one shot (uses readMem for dedup cache)
        verifyMem = await readMem(minAddr, rangeSize);
    }

    // Greedy scan using bulk-fetched verification data
    const frames = [];
    let pos = 0;
    while (pos + 1 < stk.length && frames.length < 16) {
        const lo = stk[pos];
        const hi = stk[pos + 1];
        const retAddr = (((hi << 8) | lo) + 1) & 0xFFFF;
        const jsrAddr = (retAddr - 3) & 0xFFFF;

        if (retAddr > 0x01FF && retAddr < 0xFFF0) {
            const opcode = verifyMem ? verifyMem[jsrAddr - minAddr] : undefined;
            if (opcode === 0x20 || !verifyMem) {
                frames.push(retAddr);
                pos += 2;
                continue;
            }
        }
        pos += 1; // skip single byte (PHA/PHP or non-JSR)
    }

    return frames;
}

// ----------------------------------------------------------------
// Virtual disassembly sources — for frames with no source mapping
// ----------------------------------------------------------------

const DISASM_CONTEXT = 100;     // instructions before/after PC in the cached window
let disasmRefCounter = 100000;  // sourceReference counter (high to avoid clash)
const disasmRefMap = new Map(); // sourceReference → target address (fallback for non-cached frames)

// Cached disassembly window — reused across steps to avoid tab flicker.
// When the PC stays within the window, the same sourceReference is reused
// and VS Code just scrolls to the right line (no re-fetch, no tab change).
let disasmCache = null;         // { ref, content, lineForAddr: Map<addr,line>, startAddr, endAddr }

async function buildDisasmCache(centerAddr) {
    const startAddr = Math.max(0, centerAddr - DISASM_CONTEXT * 3);
    const totalBytes = (DISASM_CONTEXT * 2 + 20) * 3;
    const readAddr = startAddr & 0xFFFF;
    const readLen = Math.min(totalBytes, 0xFFFF - readAddr + 1);
    const reply = await gdbCmd('m' + readAddr.toString(16) + ',' + readLen.toString(16));
    if (!reply || reply[0] === 'E') { disasmCache = null; return; }

    const mem = [];
    for (let i = 0; i < reply.length; i += 2)
        mem.push(parseInt(reply.substring(i, i + 2), 16));

    // Decode instructions
    const insts = [];
    let off = 0;
    while (off < mem.length) {
        const a = (readAddr + off) & 0xFFFF;
        const op = mem[off];
        const entry = OPS[op];
        if (entry) {
            const mne = entry.substring(0, 3);
            const mode = entry[3];
            const sz = opSize(mode);
            const lo = off + 1 < mem.length ? mem[off + 1] : 0;
            const hi = off + 2 < mem.length ? mem[off + 2] : 0;
            const operand = fmtOp(mode, lo, hi, a);
            let bytes = '';
            for (let j = 0; j < sz && off + j < mem.length; j++)
                bytes += mem[off + j].toString(16).toUpperCase().padStart(2, '0') + ' ';
            insts.push({ addr: a, bytes: bytes.trimEnd(), text: mne + (operand ? ' ' + operand : ''), sym: symbolAt(a) });
            off += sz;
        } else {
            const bh = mem[off].toString(16).toUpperCase().padStart(2, '0');
            insts.push({ addr: a, bytes: bh, text: '.byte $' + bh });
            off += 1;
        }
    }

    // Find instruction at centerAddr and extract window
    let pivotIdx = 0;
    for (let i = 0; i < insts.length; i++) {
        if (insts[i].addr >= centerAddr) { pivotIdx = i; break; }
    }
    const si = Math.max(0, pivotIdx - DISASM_CONTEXT);
    const ei = Math.min(insts.length, pivotIdx + DISASM_CONTEXT + 1);
    const window = insts.slice(si, ei);

    // Build content and address→line map, interleaving C source context
    const lines = [];
    const lineForAddr = new Map();
    let lineNum = 1; // 1-based
    let lastCContext = null; // track current C source context
    for (const inst of window) {
        const ah = inst.addr.toString(16).toUpperCase().padStart(4, '0');
        // Check for C source context change (from line table)
        const srcInfo = sourceFor(inst.addr);
        if (srcInfo && /\.[cC]$/i.test(srcInfo.file)) {
            const cKey = srcInfo.file + ':' + srcInfo.line;
            if (cKey !== lastCContext) {
                lastCContext = cKey;
                // sourceFor() paths come from the resolver, already absolute (§9)
                const cText = getSourceLine(srcInfo.file, srcInfo.line);
                const cLabel = path.basename(srcInfo.file) + ':' + srcInfo.line;
                const comment = cText != null
                    ? '; --- ' + cLabel + ': ' + cText.trim() + ' ---'
                    : '; --- ' + cLabel + ' ---';
                lines.push(comment);
                lineNum++;
            }
        }
        if (inst.sym) { lines.push(inst.sym + ':'); lineNum++; }
        lineForAddr.set(inst.addr, lineNum);
        lines.push(ah + '  ' + inst.bytes.padEnd(9) + ' ' + inst.text);
        lineNum++;
    }

    const ref = ++disasmRefCounter;
    disasmRefMap.set(ref, centerAddr);  // register for fallback in source() handler
    disasmCache = {
        ref,
        content: lines.join('\n') + '\n',
        lineForAddr,
        startAddr: window[0].addr,
        endAddr: window[window.length - 1].addr
    };
}

// ----------------------------------------------------------------
// DAP request dispatcher
// ----------------------------------------------------------------

// DAP commands that are sent automatically by VS Code on every stop — suppress from verbose log
const dapQuietCmds = new Set(['threads', 'scopes', 'variables', 'stackTrace']);

function handleDap(msg) {
    if (msg.type !== 'request') return;
    if (!dapQuietCmds.has(msg.command)) logVerbose('[DAP] ← ' + msg.command);
    const h = handlers[msg.command];
    if (h) {
        const t0 = PROFILE ? Date.now() : 0;
        const rt0 = PROFILE ? gdbRoundTrips : 0;
        Promise.resolve(h(msg)).then(() => {
            if (PROFILE) {
                const dt = Date.now() - t0, rt = gdbRoundTrips - rt0;
                if (dt >= 2 || rt > 0) log('[profile] ' + msg.command + ': ' + dt + 'ms, ' + rt + ' gdb reads');
            }
        }).catch(e => {
            log('Handler error (' + msg.command + '): ' + e.message);
            respond(msg, {}, false, 'Internal error: ' + e.message);
        });
    } else {
        respond(msg, {}, false, 'Unsupported: ' + msg.command);
    }
}

// ----------------------------------------------------------------
// DAP request handlers
// ----------------------------------------------------------------

const handlers = {

    // -- Lifecycle ------------------------------------------------

    initialize(req) {
        respond(req, {
            supportsConfigurationDoneRequest: true,
            supportsFunctionBreakpoints: true,
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            // Off on purpose: this extension provides its own "Oric Disassembly"
            // webview (via the custom disassembleRange request). Advertising the
            // standard disassemble capability makes VS Code auto-open ITS built-in
            // Disassembly view whenever execution stops at a source-less address
            // (e.g. ROM/BASIC), which duplicates our panel and is intrusive.
            supportsDisassembleRequest: false,
            supportsSteppingGranularity: true,
            supportsInstructionBreakpoints: true,
            supportsEvaluateForHovers: false,
            supportsStepBack: false,
            supportsSetVariable: true,
            supportsRestartFrame: false,
            supportsGotoTargetsRequest: true,
            supportsStepInTargetsRequest: false,
            supportsCompletionsRequest: false,
            supportsModulesRequest: false,
            supportsInvalidatedEvent: true,
            supportsDataBreakpoints: true,
            supportsRestartRequest: true
        });
        // Note: 'initialized' event is deferred to launch/attach handler
        // so breakpoints & configurationDone arrive after GDB is connected.
    },

    async attach(req) {
        config = req.arguments || {};
        logSessionBanner();
        moduleByteTrusted = true; // attaching to a running program — the module byte is already valid
        if (config.logLevel !== undefined) logLevel = config.logLevel;
        applyLogLevel(logLevel, true); // reflect the initial level in the status bar (don't re-persist)
        const host = config.host || 'localhost';
        const port = config.port || 6502;
        const retries = config.connectRetries || 10;
        const retryDelay = config.connectRetryDelay || 1000;

        if (config.symbolFile) loadSymbols(config.symbolFile);

        // Retry loop — gives Oricutron time to start when using preLaunchTask
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await gdbConnect(host, port);
                log('Connected to Oricutron at ' + host + ':' + port);

                const reply = await gdbCmd('?');
                log('GDB ? reply: ' + (reply || '(null)'));
                if (reply) {
                    regs = parseStopRegs(reply);
                    log('Parsed regs: PC=$' + (regs.pc !== undefined ? regs.pc.toString(16).toUpperCase().padStart(4, '0') : '??') +
                        ' A=$' + (regs.a !== undefined ? regs.a.toString(16).toUpperCase().padStart(2, '0') : '??'));
                }

                respond(req);
                evt('initialized');
                return;
            } catch (e) {
                lastErr = e;
                if (attempt < retries) {
                    if (attempt === 0)
                        log('Waiting for Oricutron on ' + host + ':' + port + '...');
                    await new Promise(r => setTimeout(r, retryDelay));
                }
            }
        }
        respond(req, {}, false, 'Could not connect to ' + host + ':' + port +
            ' after ' + retries + ' retries — is Oricutron running with --gdb_port?');
    },

    async launch(req) {
        config = req.arguments || {};
        logSessionBanner();
        moduleByteTrusted = false; // fresh boot — don't believe the module byte until the loader stamps it
        if (config.logLevel !== undefined) logLevel = config.logLevel;
        applyLogLevel(logLevel, true); // reflect the initial level in the status bar (don't re-persist)
        const port = config.port || 6502;

        if (config.symbolFile) loadSymbols(config.symbolFile);

        // --- Step 1: Build if stale ---
        if (config.build) {
            const buildOutput = config.build.output;
            const sourceDirs  = config.build.sources;
            const buildCmd    = config.build.command;
            const buildCwd    = config.build.cwd;

            if (buildOutput && buildCmd) {
                const stale = checkStale(buildOutput, sourceDirs);
                if (stale) {
                    log('Build is stale, running ' + buildCmd + '...');
                    try {
                        await runBuild(buildCmd, buildCwd);
                        log('Build succeeded.');
                    } catch (e) {
                        respond(req, {}, false, e.message);
                        return;
                    }
                } else {
                    log('Build is up to date.');
                }
            }
        }

        // --- Step 2a: Launch via OSDK script (preferred) ---
        // Run the project's execute script (e.g. osdk_execute.bat), which launches
        // Oricutron the OSDK way — auto-CLOAD, correct cwd, tape+symbols copied. We
        // inject the gdb port and the entry breakpoint via the environment, so nothing
        // needs to live in osdk_config.bat. Oricutron is started detached (START), so
        // it's tracked by port (killByPort) rather than a child handle.
        if (config.launchScript) {
            const scriptCwd = config.cwd || (config.build && config.build.cwd) || process.cwd();

            // Entry breakpoint: explicit gdbBreak wins; otherwise OSDKADDR harvested
            // from osdk_config.bat. Armed via --gdb_break so the emulator halts at the
            // program entry and waits for us regardless of connect timing.
            const osdkEnv = await harvestOsdkConfig(scriptCwd);
            let entry = (config.gdbBreak || osdkEnv.OSDKADDR || '').toString().trim().replace(/^\$/, '').replace(/^0x/i, '');
            initBreakAddr = /^[0-9a-fA-F]+$/.test(entry) ? parseInt(entry, 16) & 0xffff : -1;
            if (initBreakAddr < 0)
                log('No entry address (OSDKADDR/gdbBreak) — launching without an initial breakpoint; may miss the entry.');

            if (await probePort(config.host || 'localhost', port)) {
                respond(req, {}, false, 'gdb port ' + port + ' is already in use — another debug ' +
                    'session/emulator is likely running. Close it and retry.');
                return;
            }

            const launchEnv = { OSDKGDBPORT: String(port) };
            if (initBreakAddr >= 0) launchEnv.OSDKGDBBREAK = initBreakAddr.toString(16);

            log('Launching via ' + config.launchScript + ' (cwd ' + scriptCwd + ', gdb port ' + port +
                (initBreakAddr >= 0 ? ', entry $' + initBreakAddr.toString(16) : '') + ')');
            // spawnOsdk handles PATH (cwd + Oricutron dir), %OSDK% backslashes, NOPAUSE.
            // The script uses START to detach Oricutron, so it returns promptly; its exit
            // is NOT the emulator terminating, so don't wire 'terminated' to it.
            const runner = spawnOsdk(config.launchScript, { cwd: scriptCwd, env: launchEnv });
            if (runner.stdout) runner.stdout.on('data', d => evt('output', { category: 'stdout', output: d.toString() }));
            if (runner.stderr) runner.stderr.on('data', d => evt('output', { category: 'stderr', output: d.toString() }));
            runner.on('error', err => log('Launch script failed to start: ' + err.message));
            scriptLaunched = true;
        }
        // --- Step 2b: Launch Oricutron directly ---
        else if (config.emulatorPath) {
            // VS Code sends noDebug inside arguments for Ctrl+F5
            const isNoDebug = config.noDebug || false;
            // Guard: if something already listens on the gdb port, a stale emulator
            // owns it. Spawning another would fail to bind and we'd silently attach to
            // the OLD emulator (fresh symbols vs stale code). Refuse with guidance.
            if (!isNoDebug && await probePort(config.host || 'localhost', port)) {
                respond(req, {}, false, 'gdb port ' + port + ' is already in use — another Oricutron/debug ' +
                    'session is likely running on it. Close it (or change "port" in launch.json) and retry.');
                return;
            }
            const emuArgs = isNoDebug
                ? [config.diskImage, '-s', 'symbols', ...(config.emulatorArgs || [])]
                : [config.diskImage, '--gdb_port', String(port), '-s', 'symbols', ...(config.emulatorArgs || [])];
            const emuCwd = config.emulatorCwd || path.dirname(config.emulatorPath);

            log('Launching: ' + config.emulatorPath + ' ' + emuArgs.join(' '));
            log('Cwd: ' + emuCwd);

            launchedProcess = child_process.spawn(config.emulatorPath, emuArgs, {
                cwd: emuCwd,
                detached: false,
                windowsHide: false
            });
            launchedProcess.on('error', err => {
                log('Emulator failed to start: ' + err.message);
                evt('terminated');
            });
            launchedProcess.on('close', (code) => {
                launchedProcess = null;
                if (!disconnecting) {
                    log('Emulator exited (code ' + code + ')');
                    evt('terminated');
                }
            });
            // Pipe emulator output to debug console
            if (launchedProcess.stdout)
                launchedProcess.stdout.on('data', d => evt('output', { category: 'stdout', output: d.toString() }));
            if (launchedProcess.stderr)
                launchedProcess.stderr.on('data', d => evt('output', { category: 'stderr', output: d.toString() }));
        }

        // --- Ctrl+F5 (noDebug): launched, no GDB connection ---
        if (config.noDebug) {
            respond(req);
            evt('initialized');
            return;
        }

        // --- Step 3: Connect GDB (same retry logic as attach) ---
        const host = config.host || 'localhost';
        const retries = config.connectRetries || 10;
        const retryDelay = config.connectRetryDelay || 1000;

        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await gdbConnect(host, port);
                log('Connected to Oricutron at ' + host + ':' + port);
                const reply = await gdbCmd('?');
                if (reply) {
                    regs = parseStopRegs(reply);
                }
                respond(req);
                evt('initialized');
                return;
            } catch (e) {
                lastErr = e;
                if (attempt < retries) {
                    if (attempt === 0)
                        log('Waiting for Oricutron on ' + host + ':' + port + '...');
                    await new Promise(r => setTimeout(r, retryDelay));
                }
            }
        }
        // Total connect failure: kill the emulator we spawned so it doesn't linger and
        // own the port for the next launch (which would then attach to this stale one).
        if (launchedProcess) {
            try { launchedProcess.kill(); } catch (_) { /* ignore */ }
            launchedProcess = null;
        }
        respond(req, {}, false, 'Could not connect to ' + host + ':' + port +
            ' after ' + retries + ' retries — is Oricutron running?');
    },

    configurationDone(req) {
        configDone = true;
        respond(req);

        // Arm the hidden module-load watch before any free-run so overlay switches
        // are caught from the very first run. Queued ahead of the continue below
        // (whenGdbIdle waits for the Z2 to complete first).
        armModuleWatch();

        // Script-launch: on connect we're paused at boot (pause-on-connect), NOT yet at
        // the entry. Continue so the emulator runs through the auto-CLOAD and hits the
        // --gdb_break at the program entry; onStopReply then drops that breakpoint and
        // applies stopOnEntry (user breakpoints were already armed in setBreakpoints).
        if (scriptLaunched && initBreakAddr >= 0) {
            awaitingEntry = true;
            whenGdbIdle(() => { log('Running to program entry ($' + initBreakAddr.toString(16) + ')'); running = true; gdbWrite('c'); });
            return;
        }

        // Turbo Run To on launch: warp through startup to a target symbol
        if (config.turboRunTo) {
            const taddr = symbols.has(config.turboRunTo) ? symbols.get(config.turboRunTo) : -1;
            if (taddr >= 0) {
                log('configurationDone: turbo run to ' + config.turboRunTo + ' ($' + taddr.toString(16) + ')');
                pendingStop = null;
                armTurbo(taddr).then(() => whenGdbIdle(() => { running = true; gdbWrite('c'); }));
                return;
            }
            log('configurationDone: turboRunTo "' + config.turboRunTo + '" not in symbols; normal start');
        }

        function doContinue() {
            log('Free-run: sending GDB continue');
            running = true;
            gdbWrite('c');
        }

        if (pendingStop) {
            if (config.stopOnAttach === false) {
                log('configurationDone: free-run (had pendingStop)');
                pendingStop = null;
                whenGdbIdle(doContinue);
            } else {
                log('configurationDone: stop on attach (had pendingStop)');
                evt('stopped', pendingStop);
                pendingStop = null;
            }
        } else if (config.stopOnAttach !== false) {
            log('configurationDone: stop on attach (entry)');
            evt('stopped', { reason: 'entry', threadId: 1, allThreadsStopped: true });
        } else {
            log('configurationDone: free-run (no pendingStop)');
            whenGdbIdle(doContinue);
        }
    },

    async restart(req) {
        const args = req.arguments || {};
        // Merge restart arguments into config (VS Code re-sends the launch config)
        if (args.configuration) Object.assign(config, args.configuration);

        log('Restarting debug session...');

        // --- Step 1: Build if stale ---
        if (config.build) {
            const buildOutput = config.build.output;
            const sourceDirs  = config.build.sources;
            const buildCmd    = config.build.command;
            const buildCwd    = config.build.cwd;

            if (buildOutput && buildCmd) {
                const stale = checkStale(buildOutput, sourceDirs);
                if (stale) {
                    log('Build is stale, running ' + buildCmd + '...');
                    try {
                        await runBuild(buildCmd, buildCwd);
                        log('Build succeeded.');
                    } catch (e) {
                        respond(req, {}, false, 'Rebuild failed: ' + e.message);
                        return;
                    }
                } else {
                    log('Build is up to date.');
                }
            }
        }

        // --- Step 2: Reload symbols ---
        if (config.symbolFile) {
            loadSymbols(config.symbolFile);
        }

        // --- Step 3: Hard reset Oricutron (reloads disk + resets CPU, pauses) ---
        configDone = false;
        pendingStop = null;
        running = false;
        // Fresh boot: don't trust the resident module byte until the loader re-stamps
        // it (loadSymbols already reset activeModuleId/moduleReported). Matches launch().
        moduleByteTrusted = false;

        const reply = await gdbCmd('qOricHardReset');
        if (reply) {
            regs = parseStopRegs(reply);
            log('Hard reset complete, PC=$' + (regs.pc !== undefined ? regs.pc.toString(16).toUpperCase().padStart(4, '0') : '??'));
        }

        respond(req);

        // Send initialized so VS Code re-sends breakpoints, then configurationDone
        evt('initialized');
    },

    async disconnect(req) {
        disconnecting = true;
        if (sock) {
            gdbWrite('D'); // detach — don't wait for reply
            sock.destroy();
            sock = null;
        }
        // Kill emulator if we launched it
        if (launchedProcess) {
            try {
                if (process.platform === 'win32') {
                    // Tree-kill on Windows to catch child processes
                    child_process.execSync('taskkill /pid ' + launchedProcess.pid + ' /T /F',
                        { windowsHide: true, stdio: 'ignore' });
                } else {
                    launchedProcess.kill('SIGTERM');
                }
            } catch (e) { /* already exited */ }
            launchedProcess = null;
        }
        // Script-launched Oricutron is detached (START), so there's no child handle —
        // kill whatever now owns the gdb port instead.
        if (scriptLaunched) {
            killByPort(config.port || 6502);
            scriptLaunched = false;
        }
        respond(req);
        evt('terminated');
        setTimeout(() => process.exit(0), 200);
    },

    // -- Threads / Stack ------------------------------------------

    threads(req) {
        respond(req, { threads: [{ id: 1, name: '6502 CPU' }] });
    },

    async stackTrace(req) {
        if (!regs) {
            const r = await gdbCmd('g');
            regs = parseRegsG(r);
        }
        const pc = regs ? regs.pc : 0;

        // Pre-generate disassembly cache if the PC has no source and is
        // outside the current cached window (or no cache exists yet).
        if (!sourceFor(pc)) {
            if (!disasmCache || pc < disasmCache.startAddr || pc > disasmCache.endAddr) {
                await buildDisasmCache(pc);
            }
        }

        // Build a stack frame with optional source location from V2 symbols
        function makeFrame(id, addr) {
            // Single-source-of-truth resolver: name AND source come from ONE owner,
            // so the call stack can't disagree with the disassembly view (DOGFOODING #1).
            const R = resolverInstance ? resolverInstance.resolve(addr) : null;
            const name = R
                ? (R.symbol
                    ? (R.symbol.offset ? R.symbol.name + '+$' + R.symbol.offset.toString(16).toUpperCase() : R.symbol.name)
                    : '$' + addr.toString(16).toUpperCase().padStart(4, '0'))
                : labelFor(addr);
            const frame = {
                id: id,
                name: name,
                line: 0,
                column: 0,
                instructionPointerReference: '0x' + addr.toString(16).padStart(4, '0')
            };
            if (R && R.source) {
                frame.source = { name: path.basename(R.source.file), path: R.source.file };
                frame.line = R.source.line;
            } else if (disasmCache && disasmCache.lineForAddr.has(addr)) {
                // Address is within the cached disassembly window — reuse
                // the same sourceReference so VS Code just scrolls, no tab refresh.
                frame.source = { name: 'Disassembly', sourceReference: disasmCache.ref };
                frame.line = disasmCache.lineForAddr.get(addr);
            } else {
                // Fallback for call stack frames outside the cache window
                const ref = ++disasmRefCounter;
                disasmRefMap.set(ref, addr);
                frame.source = {
                    name: 'Disassembly @ $' + addr.toString(16).toUpperCase().padStart(4, '0'),
                    sourceReference: ref
                };
                frame.line = DISASM_CONTEXT + 1;
            }
            return frame;
        }

        // Frame 0: current PC
        const topFrame = makeFrame(0, pc);
        // If the top frame only has a virtual disassembly source (no real file),
        // strip it so VS Code doesn't auto-open a "Disassembly" text tab.
        // The custom Oric Disassembly webview panel handles this instead.
        if (topFrame.source && topFrame.source.sourceReference && !topFrame.source.path) {
            delete topFrame.source;
            topFrame.line = 0;
        }
        const stackFrames = [topFrame];

        // Walk the hardware stack to find JSR return addresses
        const returnAddrs = await buildCallStack();
        for (let i = 0; i < returnAddrs.length; i++) {
            stackFrames.push(makeFrame(i + 1, returnAddrs[i]));
        }

        respond(req, {
            stackFrames: stackFrames,
            totalFrames: stackFrames.length
        });
    },

    // -- Scopes / Variables ---------------------------------------

    scopes(req) {
        warnIfStale();
        const scopes = [
            { name: 'Registers', variablesReference: 1, expensive: false, presentationHint: 'registers' },
            { name: 'Flags',     variablesReference: 2, expensive: false },
        ];
        if (zpSymbols.length > 0) {
            scopes.push({ name: 'Zero Page', variablesReference: 3, expensive: false });
        }
        if (varTypes.size > 0) {
            // expensive:false so VS Code keeps the scope's expanded/collapsed state
            // across stops instead of re-collapsing it every step. (VS Code treats an
            // "expensive" scope as not-worth-keeping-open.) Values are only re-read
            // while the scope is actually expanded, so the user controls the cost.
            scopes.push({ name: 'Globals', variablesReference: 4, expensive: false });
        }
        if (localDefs.size > 0) {
            scopes.push({ name: 'Locals', variablesReference: 5, expensive: false, presentationHint: 'locals' });
        }
        respond(req, { scopes: scopes });
    },

    async variables(req) {
        const ref = req.arguments.variablesReference;
        if (!regs) {
            const r = await gdbCmd('g');
            regs = parseRegsG(r);
        }
        if (!regs) { respond(req, { variables: [] }); return; }

        if (ref === 1) {
            // A/X/Y hold data → full "hex|dec|%binary['char']" form (formatScalar takes a
            // byte array). SP/PC are addresses → hex + decimal only (binary/glyph of an
            // address is noise; decimal helps offset math).
            respond(req, { variables: [
                { name: 'A',  value: formatScalar('uchar', [regs.a], 0, 1), variablesReference: 0 },
                { name: 'X',  value: formatScalar('uchar', [regs.x], 0, 1), variablesReference: 0 },
                { name: 'Y',  value: formatScalar('uchar', [regs.y], 0, 1), variablesReference: 0 },
                { name: 'SP', value: '$' + regs.sp.toString(16).toUpperCase().padStart(2, '0') + '|' + regs.sp, variablesReference: 0 },
                { name: 'PC', value: '$' + regs.pc.toString(16).toUpperCase().padStart(4, '0') + '|' + regs.pc, memoryReference: '0x' + regs.pc.toString(16).padStart(4, '0'), variablesReference: 0 }
            ]});
        } else if (ref === 2) {
            const f = regs.f;
            respond(req, { variables: [
                { name: 'N (Negative)',  value: (f & 0x80) ? '1' : '0', variablesReference: 0 },
                { name: 'V (Overflow)',  value: (f & 0x40) ? '1' : '0', variablesReference: 0 },
                { name: 'B (Break)',     value: (f & 0x10) ? '1' : '0', variablesReference: 0 },
                { name: 'D (Decimal)',   value: (f & 0x08) ? '1' : '0', variablesReference: 0 },
                { name: 'I (Interrupt)', value: (f & 0x04) ? '1' : '0', variablesReference: 0 },
                { name: 'Z (Zero)',      value: (f & 0x02) ? '1' : '0', variablesReference: 0 },
                { name: 'C (Carry)',     value: (f & 0x01) ? '1' : '0', variablesReference: 0 }
            ]});
        } else if (ref === 3) {
            // Zero page variables — same render path as every other view (annotations,
            // enum types, etc. all apply), just with a zero-page-address-prefixed label.
            if (zpSymbols.length === 0) { respond(req, { variables: [] }); return; }
            const vars = [];
            for (const s of zpSymbols) {
                const a = s.addr;
                const hAddr = '$' + a.toString(16).toUpperCase().padStart(2, '0');
                const spec = renderSpec(s.name);
                const v = await buildTypedVar(s.name, a, spec.type, spec.size, spec.ann);
                v.name = hAddr + ' ' + s.name;
                vars.push(v);
            }
            respond(req, { variables: vars });
        } else if (ref === 4) {
            // Globals — typed variables from #TYPES section
            const vars = [];
            const shown = new Set();
            for (const [asmName, vt] of varTypes) {
                const addr = symbols.get(asmName);
                if (typeof addr !== 'number') continue;
                shown.add(asmName);
                vars.push(await buildTypedVar(asmName, addr, vt.type, vt.totalSize, annForSymbol(asmName)));
            }
            // Annotated symbols with no .ctype var (e.g. assembler .dsb globals):
            // surface them so a "; @bitset achievement" on an asm label shows too.
            for (const [cName, ann] of annBySymbol) {
                let asmName = '_' + cName, addr = symbols.get(asmName);
                if (typeof addr !== 'number') { asmName = cName; addr = symbols.get(asmName); }
                if (typeof addr !== 'number' || shown.has(asmName)) continue;
                shown.add(asmName);
                const spec = renderSpec(asmName);
                vars.push(await buildTypedVar(asmName, addr, spec.type, spec.size, spec.ann));
            }
            respond(req, { variables: vars });
        } else if (ref === 5) {
            // Locals — variables local to the current function
            const vars = [];
            if (regs) {
                const func = currentFunction(regs.pc);
                const locals = func ? localDefs.get(func) : null;
                if (locals && locals.length > 0) {
                    // Read fp and ap ZP pointers
                    const fpAddr = symbols.get('fp');
                    const apAddr = symbols.get('ap');
                    let fpVal = 0, apVal = 0;
                    if (typeof fpAddr === 'number') {
                        const m = await readMem(fpAddr, 2);
                        fpVal = m[0] | (m[1] << 8);
                    }
                    if (typeof apAddr === 'number') {
                        const m = await readMem(apAddr, 2);
                        apVal = m[0] | (m[1] << 8);
                    }
                    for (const loc of locals) {
                        const baseVal = loc.base === 'ap' ? apVal : fpVal;
                        const addr = (baseVal + loc.offset) & 0xFFFF;
                        vars.push(await buildTypedVar(loc.cname, addr, loc.type, loc.size, annForSymbol(loc.cname)));
                    }
                }
            }
            respond(req, { variables: vars });
        } else if (varRefs.has(ref)) {
            // Expand a typed variable (struct fields, array elements, or a bitset)
            const info = varRefs.get(ref);
            // @bitset expansion: one child per set bit, named by the enum member.
            if (info.kind === 'bitset') {
                const ed = resolveEnum(info.enumName);
                const mem = await readMem(info.addr, info.size);
                const vars = [];
                for (let p = 0; p < info.size * 8; p++) {
                    if (mem[p >> 3] & (1 << (p & 7))) {
                        const nm = (ed && ed.byValue.get(p)) || ('bit ' + p);
                        vars.push({ name: nm, value: 'set  (bit ' + p + ')', variablesReference: 0 });
                    }
                }
                if (vars.length === 0) vars.push({ name: '(none set)', value: '', variablesReference: 0 });
                respond(req, { variables: vars }); return;
            }
            const def = typeDefs.get(info.typeName);
            const vars = [];

            if (info.count > 1 && def) {
                // Array of structs — show indexed elements
                const totalBytes = info.count * def.size;
                const mem = await readMem(info.addr + (info.offset || 0), totalBytes);
                for (let i = 0; i < info.count; i++) {
                    const elemAddr = info.addr + (info.offset || 0) + i * def.size;
                    const hAddr = '$' + elemAddr.toString(16).toUpperCase().padStart(4, '0');
                    const childOffset = (info.offset || 0) + i * def.size;
                    const childRef = stableRef('st:' + info.addr + ':' + info.typeName + ':1:' + childOffset,
                                               { addr: info.addr, typeName: info.typeName, count: 1, offset: childOffset });
                    // Show first field as preview
                    const preview = formatStructPreview(def, mem, i * def.size);
                    vars.push({
                        name: '[' + i + ']',
                        value: preview + '  @ ' + hAddr,
                        variablesReference: childRef
                    });
                }
            } else if (info.count > 1) {
                // Array of scalars
                const elemSize = Math.max(1, Math.floor((info.totalSize || info.count) / info.count));
                const totalBytes = info.count * elemSize;
                const mem = await readMem(info.addr + (info.offset || 0), totalBytes);
                // For char/uchar arrays, show a string preview as first entry
                if (isCharType(info.typeName) && elemSize === 1) {
                    const preview = formatCharArray(mem, 0, info.count);
                    vars.push({ name: '[string]', value: preview, variablesReference: 0 });
                }
                for (let i = 0; i < info.count; i++) {
                    const elemAddr = info.addr + (info.offset || 0) + i * elemSize;
                    const hAddr = '$' + elemAddr.toString(16).toUpperCase().padStart(4, '0');
                    vars.push({
                        name: '[' + i + ']',
                        value: formatScalar(info.typeName, mem, i * elemSize, elemSize) + '  @ ' + hAddr,
                        variablesReference: 0
                    });
                }
            } else if (def) {
                // Single struct — show fields. buildTypedVar handles nested struct,
                // array, pointer-to-struct, and scalar fields uniformly.
                for (const f of def.fields) {
                    const fieldAddr = (info.addr + (info.offset || 0) + f.offset) & 0xFFFF;
                    const ann = annByField.get(info.typeName + '.' + f.name);
                    vars.push(await buildTypedVar(f.name, fieldAddr, f.type, f.size, ann));
                }
            } else {
                respond(req, { variables: [] }); return;
            }
            respond(req, { variables: vars });
        } else {
            respond(req, { variables: [] });
        }
    },

    async setVariable(req) {
        const args = req.arguments;
        const ref = args.variablesReference;
        const name = args.name;
        const rawVal = args.value.trim();

        // Parse value: accept "$XX", "0xXX", or plain decimal
        let val;
        if (rawVal.startsWith('$') || rawVal.startsWith('0x') || rawVal.startsWith('0X')) {
            val = parseInt(rawVal.replace(/^\$/, ''), 16);
        } else {
            val = parseInt(rawVal, 10);
        }
        if (isNaN(val)) { respond(req, {}, false, 'Invalid value: ' + rawVal); return; }

        const h2 = v => (v & 0xFF).toString(16).padStart(2, '0');
        const h4 = v => '$' + v.toString(16).toUpperCase().padStart(4, '0');

        if (ref === 1) {
            // CPU registers
            const regMap = { A: 0, X: 1, Y: 2, SP: 3, PC: 4 };
            const regNum = regMap[name];
            if (regNum === undefined) { respond(req, {}, false, 'Unknown register'); return; }
            let hexVal;
            if (regNum === 4) {
                // PC is 2 bytes little-endian
                hexVal = h2(val & 0xFF) + h2((val >> 8) & 0xFF);
            } else {
                hexVal = h2(val);
            }
            const r = await gdbCmd('P' + regNum.toString(16) + '=' + hexVal);
            if (r !== 'OK') { respond(req, {}, false, 'Write failed'); return; }
            // Refresh registers
            const g = await gdbCmd('g');
            regs = parseRegsG(g);
            const display = (regNum === 4)
                ? h4(regs.pc)
                : '$' + regs[name.toLowerCase()].toString(16).toUpperCase().padStart(2, '0') +
                  ' (' + regs[name.toLowerCase()] + ')';
            respond(req, { value: display });
            if (regNum === 4) evt('stopped', { reason: 'step', threadId: 1, allThreadsStopped: true });
        } else if (ref === 2) {
            // Flags — set individual flag bits
            const flagBits = { 'N (Negative)': 0x80, 'V (Overflow)': 0x40, 'B (Break)': 0x10,
                'D (Decimal)': 0x08, 'I (Interrupt)': 0x04, 'Z (Zero)': 0x02, 'C (Carry)': 0x01 };
            const bit = flagBits[name];
            if (!bit) { respond(req, {}, false, 'Unknown flag'); return; }
            if (!regs) { const g = await gdbCmd('g'); regs = parseRegsG(g); }
            const newF = val ? (regs.f | bit) : (regs.f & ~bit);
            const r = await gdbCmd('P5=' + h2(newF));
            if (r !== 'OK') { respond(req, {}, false, 'Write failed'); return; }
            regs.f = newF;
            respond(req, { value: val ? '1' : '0' });
        } else {
            respond(req, {}, false, 'Cannot set this variable');
        }
    },

    // -- Goto (set next statement / move PC) ----------------------

    gotoTargets(req) {
        const args = req.arguments;
        let addr = -1, targetLine = 0;
        const srcPath = args.source && args.source.path;
        if (srcPath && /^0x[0-9A-Fa-f]+$/.test(srcPath.trim())) {
            // Disassembly view: the source path IS the address ("0xABCD")
            addr = parseInt(srcPath, 16) & 0xFFFF;
        } else if (srcPath) {
            // Real source file: file+line -> address via the resolver's inverse
            // mapping (the same snapping rule breakpoints use). The old code
            // hex-parsed the PATH here, so "D:\..." became $000D and goto
            // refused it. The snapped line is reported so callers (skip-line)
            // can detect a backward snap.
            const snap = resolverInstance ? resolverInstance.addrForLine(srcPath, args.line || 0) : null;
            // Refuse DATA lines (a .dsb/.byt with a #LINES entry): jumping the
            // PC into storage crashes; the empty target list reads as "no code".
            if (snap && executableLine(snap.addr, srcPath)) { addr = snap.addr; if (snap.line > 0) targetLine = snap.line; }
        } else if (args.line) {
            addr = args.line & 0xFFFF; // no path: some views encode the address in `line`
        }
        if (addr < 0) { respond(req, { targets: [] }); return; }

        const id = bpId++;  // unique target ID
        gotoTargetMap.set(id, addr);
        respond(req, {
            targets: [{
                id: id,
                label: labelFor(addr),
                line: targetLine,
                column: 0,
                instructionPointerReference: '0x' + addr.toString(16).padStart(4, '0')
            }]
        });
    },

    async goto(req) {
        const targetId = req.arguments.targetId;
        const addr = gotoTargetMap.get(targetId);
        if (addr === undefined) {
            respond(req, {}, false, 'Unknown goto target');
            return;
        }
        gotoTargetMap.delete(targetId);
        // Safety check: refuse to jump to dubious addresses
        if (addr < 0x0400) {
            const region = addr < 0x0100 ? 'zero page' : (addr < 0x0200 ? 'stack' : (addr < 0x0300 ? 'page 2' : 'I/O page'));
            respond(req, {}, false, 'Refused: $' + addr.toString(16).toUpperCase().padStart(4, '0') + ' is in ' + region + ' — not executable code');
            return;
        }
        // Set PC via GDB P4= command (little-endian)
        const pcLo = (addr & 0xFF).toString(16).padStart(2, '0');
        const pcHi = ((addr >> 8) & 0xFF).toString(16).padStart(2, '0');
        const r = await gdbCmd('P4=' + pcLo + pcHi);
        if (r !== 'OK') { respond(req, {}, false, 'Failed to set PC'); return; }
        const g = await gdbCmd('g');
        regs = parseRegsG(g);
        respond(req);
        evt('stopped', { reason: 'goto', threadId: 1, allThreadsStopped: true });
    },

    // -- Execution control ----------------------------------------

    async continue(req) {
        resumeMode = 'run';
        // If PC is sitting on a breakpoint, single-step past it first,
        // then continue via the continueAfterStep flag in onStopReply
        if (regs && regs.pc !== undefined) {
            const pc = regs.pc;
            if (isBreakpointAt(pc)) {
                continueAfterStep = true;
                regs = null;
                respond(req, { allThreadsContinued: true });
                running = true;
                gdbWrite('s'); // step past BP; onStopReply will issue 'c'
                evt('continued', { threadId: 1, allThreadsContinued: true });
                return;
            }
        }
        regs = null;
        respond(req, { allThreadsContinued: true });
        running = true;
        gdbWrite('c');
        evt('continued', { threadId: 1, allThreadsContinued: true });
    },

    async next(req) {
        resumeMode = 'step';
        const granularity = (req.arguments && req.arguments.granularity) || 'statement';
        logVerbose('next: granularity=' + granularity);
        const src = regs ? sourceFor(regs.pc) : null;
        // Source-level step-over: set temp breakpoint on next C line, then continue
        if (granularity === 'statement' && src && /\.[cC]$/i.test(src.file)) {
            const nextAddr = findNextSourceLineAddr(regs.pc, src.file, src.line);
            if (nextAddr >= 0) {
                await armAddr(nextAddr); // ref-counted; released on the next stop
                tempStepBp = nextAddr;
                // If PC is on a breakpoint, step past it first (onStopReply will 'c')
                const onBp = isBreakpointAt(regs.pc);
                regs = null;
                respond(req);
                running = true;
                if (onBp) {
                    continueAfterStep = true;
                    gdbWrite('s'); // step past BP; onStopReply issues 'c'
                } else {
                    gdbWrite('c');
                }
                evt('continued', { threadId: 1, allThreadsContinued: true });
                return;
            }
            // Fallback: no next line found, do normal step-over
        }
        regs = null;
        respond(req);
        running = true;
        gdbWrite('N');
    },

    async stepIn(req) {
        resumeMode = 'step';
        const granularity = (req.arguments && req.arguments.granularity) || 'statement';
        const src = regs ? sourceFor(regs.pc) : null;
        // Source-level Step Into: single-step at the instruction level until we reach a
        // source line different from this one. A `jsr` steps INTO its target, whose entry
        // maps to the callee's own source line — so we descend into called functions
        // (puts/printf/AsmTick, ...) instead of stepping over them. If the line has no
        // call, we simply arrive at the next line in the same function. The budget bounds
        // a descent into source-less code (e.g. ROM) so it can't run away. onStopReply
        // drives the loop and emits the stop when the line changes (or the budget runs out).
        if (granularity === 'statement' && src && /\.[cC]$/i.test(src.file)) {
            stepInInProgress = true;
            stepInStartFile = src.file;
            stepInStartLine = src.line;
            stepInBudget = 1000;
            regs = null;
            respond(req);
            running = true;
            gdbWrite('s');
            return;
        }
        regs = null;
        respond(req);
        running = true;
        gdbWrite('s');
    },

    stepOut(req) {
        resumeMode = 'step';
        regs = null;
        respond(req);
        running = true;
        gdbWrite('O');
    },

    pause(req) {
        respond(req);
        if (sock) sock.write('\x03');
    },

    // -- Breakpoints ----------------------------------------------

    async setBreakpoints(req) {
        const args = req.arguments;
        const srcPath = args.source && args.source.path ? args.source.path : '';
        // Key srcBps by the normalized path so a re-cased/non-canonical path for the
        // same file can't leave a stale bucket (and stale armed Z0s) behind.
        const norm = canonPath(srcPath);

        // Remove previous source breakpoints for this file (disarm every live binding).
        const prev = srcBps.get(norm) || [];
        for (const bp of prev) {
            for (const b of bp.bindings) if (b.armed) await disarmAddr(b.addr);
        }
        srcBps.set(norm, []);

        // A source file can be linked into several overlays (shared code like
        // printf.s), at a different address in each. Resolve the line in EACH owning
        // module so the breakpoint binds wherever the file lives; arm the binding for
        // the currently active/resident module, keep the rest pending for a switch.
        const owners = fileToModules.get(norm) || ['R'];
        const activeInFile = owners.includes('R') || owners.includes(activeModuleId);

        const result = [];
        const newBps = [];

        for (const sbp of (args.breakpoints || [])) {
            const reqLine = sbp.line;
            const bindings = [];
            let dispLine = -1;

            for (const mod of owners) {
                // Resolve within EACH owning module's own lines (a shared file
                // sits at a different address per overlay) — the same snapping
                // rule goto/turbo use, via the resolver's module restriction.
                const snap = resolverInstance ? resolverInstance.addrForLine(srcPath, reqLine, mod) : null;
                if (snap) {
                    bindings.push({ addr: snap.addr, module: mod, armed: false });
                    if (dispLine < 0 || mod === activeModuleId) dispLine = snap.line; // prefer the active module's snapped line
                }
            }

            const id = bpId++;
            if (!bindings.length) {
                result.push({ id, verified: false, message: 'No code at this line' });
                continue;
            }
            // Arm bindings for the active/resident module now; others arm on switch
            // (rearmModuleBreakpoints). armAddr is ref-counted so overlap is safe.
            let anyArmed = false, anyFail = false;
            for (const b of bindings) {
                if (b.module === 'R' || b.module === activeModuleId) {
                    b.armed = await armAddr(b.addr);
                    if (b.armed) anyArmed = true; else anyFail = true;
                }
            }
            const message = anyFail ? 'Failed to set breakpoint'
                : (!activeInFile ? 'Inactive module (' + owners.map(m => moduleNames.get(m) || m).join('/') + ') — binds when it loads' : undefined);
            newBps.push({ id, line: dispLine, source: args.source, bindings });
            result.push({ id, verified: anyArmed, line: dispLine, source: args.source, message });
        }
        srcBps.set(norm, newBps);
        respond(req, { breakpoints: result });
    },

    async setFunctionBreakpoints(req) {
        // Clear all existing function breakpoints from the stub
        for (const [, bp] of bps) {
            await disarmAddr(bp.addr);
        }
        bps.clear();

        // Set new ones by resolving symbol names to addresses
        const result = [];
        for (const fbp of (req.arguments.breakpoints || [])) {
            const name = fbp.name;
            const addr = symbols.get(name);
            if (addr !== undefined) {
                const ok = await armAddr(addr);
                const id = bpId++;
                bps.set(id, { id: id, addr: addr, name: name });
                result.push({
                    id: id,
                    verified: ok,
                    message: ok ? undefined : 'Failed to set breakpoint'
                });
            } else {
                result.push({
                    id: bpId++,
                    verified: false,
                    message: 'Symbol not found: ' + name
                });
            }
        }
        respond(req, { breakpoints: result });
    },

    setExceptionBreakpoints(req) {
        respond(req);
    },

    async setInstructionBreakpoints(req) {
        // Clear existing instruction breakpoints
        for (const [, bp] of ibps) {
            await disarmAddr(bp.addr);
        }
        ibps.clear();

        const result = [];
        for (const ibp of (req.arguments.breakpoints || [])) {
            const addr = (parseInt(ibp.instructionReference, 16) + (ibp.offset || 0)) & 0xFFFF;
            const ok = await armAddr(addr);
            const id = bpId++;
            if (ok) ibps.set(id, { id: id, addr: addr });
            result.push({
                id: id,
                verified: ok,
                instructionReference: '0x' + addr.toString(16).padStart(4, '0'),
                message: ok ? undefined : 'Failed to set breakpoint'
            });
        }
        respond(req, { breakpoints: result });
    },

    // -- Memory / Disassembly -------------------------------------

    async readMemory(req) {
        const args = req.arguments;
        const addr = (parseInt(args.memoryReference, 16) + (args.offset || 0)) & 0xFFFF;
        const count = Math.min(args.count, 0xFFFF - addr + 1);
        const reply = await gdbCmd('m' + addr.toString(16) + ',' + count.toString(16));
        if (!reply || reply[0] === 'E') {
            respond(req, { address: '0x' + addr.toString(16).padStart(4, '0'), data: '' });
            return;
        }
        const buf = Buffer.alloc(reply.length / 2);
        for (let i = 0; i < reply.length; i += 2)
            buf[i / 2] = parseInt(reply.substring(i, i + 2), 16);
        respond(req, {
            address: '0x' + addr.toString(16).padStart(4, '0'),
            data: buf.toString('base64')
        });
    },

    async writeMemory(req) {
        const args = req.arguments;
        const addr = (parseInt(args.memoryReference, 16) + (args.offset || 0)) & 0xFFFF;
        const buf = Buffer.from(args.data, 'base64');
        let hex = '';
        for (const b of buf) hex += b.toString(16).padStart(2, '0');
        const reply = await gdbCmd('M' + addr.toString(16) + ',' + buf.length.toString(16) + ':' + hex);
        respond(req, { bytesWritten: reply === 'OK' ? buf.length : 0 });
    },

    // -- Virtual disassembly source ---------------------------------

    async source(req) {
        const ref = req.arguments.sourceReference;

        // Check cached disassembly window first (most common path)
        if (disasmCache && disasmCache.ref === ref) {
            respond(req, { content: disasmCache.content, mimeType: 'text/x-asm' });
            return;
        }

        // Fallback: generate on-the-fly for non-cached frames (call stack entries)
        const addr = disasmRefMap.get(ref);
        if (addr === undefined) {
            respond(req, { content: '; Source not available\n' });
            return;
        }

        await buildDisasmCache(addr);
        if (disasmCache) {
            respond(req, { content: disasmCache.content, mimeType: 'text/x-asm' });
        } else {
            respond(req, { content: '; Failed to disassemble at $' + addr.toString(16).toUpperCase().padStart(4, '0') + '\n' });
        }
    },

    // -- Disassemble (native DAP) ------------------------------------

    async disassemble(req) {
        const args = req.arguments;
        const baseAddr = (parseInt(args.memoryReference, 16) + (args.offset || 0)) & 0xFFFF;
        const instrOff = args.instructionOffset || 0;
        const count = args.instructionCount;

        // Back up for negative offsets (max 3 bytes per 6502 instruction)
        let startAddr = baseAddr;
        if (instrOff < 0) startAddr = Math.max(0, baseAddr + instrOff * 3);

        // Read enough bytes: (count + |instrOff|) instructions * 3 bytes max each
        const need = (count + Math.abs(instrOff)) * 3;
        const readAddr = startAddr & 0xFFFF;
        const reply = await gdbCmd('m' + readAddr.toString(16) + ',' + Math.min(need, 0xFFFF - readAddr + 1).toString(16));
        if (!reply || reply[0] === 'E') {
            respond(req, { instructions: [] });
            return;
        }

        const mem = [];
        for (let i = 0; i < reply.length; i += 2)
            mem.push(parseInt(reply.substring(i, i + 2), 16));

        // Decode instructions
        const all = [];
        let off = 0;
        while (off < mem.length && all.length < count + Math.abs(instrOff) + 16) {
            const a = (readAddr + off) & 0xFFFF;
            const op = mem[off];
            const entry = OPS[op];
            if (entry) {
                const mne = entry.substring(0, 3);
                const mode = entry[3];
                const sz = opSize(mode);
                const lo = off + 1 < mem.length ? mem[off + 1] : 0;
                const hi = off + 2 < mem.length ? mem[off + 2] : 0;
                const operand = fmtOp(mode, lo, hi, a);
                let opBytes = '';
                for (let j = 0; j < sz && off + j < mem.length; j++)
                    opBytes += mem[off + j].toString(16).toUpperCase().padStart(2, '0') + ' ';
                const instr = {
                    address: '0x' + a.toString(16).padStart(4, '0'),
                    instructionBytes: opBytes.trim(),
                    instruction: mne + (operand ? ' ' + operand : '')
                };
                const sym = symbolAt(a);
                if (sym) instr.symbol = sym;
                // Attach source location for C files only — VS Code's built-in
                // disassembly view interleaves source from location/line, which is
                // redundant for assembly (the disassembly IS the assembly source).
                const instrSrc = sourceFor(a);
                if (instrSrc && /\.[cC]$/i.test(instrSrc.file)) {
                    // sourceFor() paths come from the resolver, already absolute (§9)
                    instr.location = { name: path.basename(instrSrc.file), path: instrSrc.file };
                    instr.line = instrSrc.line;
                }
                all.push(instr);
                off += sz;
            } else {
                all.push({
                    address: '0x' + a.toString(16).padStart(4, '0'),
                    instructionBytes: mem[off].toString(16).toUpperCase().padStart(2, '0'),
                    instruction: '.byte $' + mem[off].toString(16).toUpperCase().padStart(2, '0')
                });
                off += 1;
            }
        }

        // Find the instruction at/after baseAddr and apply instrOff
        let pivot = 0;
        if (instrOff < 0) {
            for (let i = 0; i < all.length; i++) {
                if (parseInt(all[i].address, 16) >= baseAddr) { pivot = i; break; }
            }
            pivot = Math.max(0, pivot + instrOff);
        }

        respond(req, { instructions: all.slice(pivot, pivot + count) });
    },

    // -- Debug console (evaluate) ---------------------------------

    async evaluate(req) {
        const expr = (req.arguments.expression || '').trim();
        let m;

        // Help:  help  |  ?  |  h
        if (/^(help|\?|h)$/i.test(expr)) {
            respond(req, { result: CONSOLE_HELP, variablesReference: 0 });
            return;
        }

        // Log verbosity:  loglevel        (show current)
        //                 loglevel 0|1|2  (set)
        if ((m = expr.match(/^loglevel(?:\s+([0-2]))?$/i))) {
            if (m[1] !== undefined) applyLogLevel(parseInt(m[1], 10));
            respond(req, {
                result: 'Log level: ' + logLevel + ' (' + LOG_LEVEL_NAMES[logLevel] + ')',
                variablesReference: 0
            });
            return;
        }

        // Profiling:  profile         (show state)
        //             profile on|off  (per-request timing + gdb read counts in the log)
        if ((m = expr.match(/^profile(?:\s+(on|off))?$/i))) {
            if (m[1] !== undefined) { PROFILE = m[1].toLowerCase() === 'on'; if (PROFILE) gdbRoundTrips = 0; }
            respond(req, {
                result: 'Profiling: ' + (PROFILE ? 'ON — each request logs "<cmd>: <ms>ms, <n> gdb reads"' : 'off'),
                variablesReference: 0
            });
            return;
        }

        // Skip instruction (like Oricutron's F12):  skip
        if (expr.toLowerCase() === 'skip') {
            if (!regs) { respond(req, {}, false, 'No register state'); return; }
            const pc = regs.pc;
            const opReply = await gdbCmd('m' + pc.toString(16) + ',1');
            if (!opReply || opReply[0] === 'E') { respond(req, {}, false, 'Cannot read opcode'); return; }
            const opcode = parseInt(opReply.substring(0, 2), 16);
            const entry = OPS[opcode];
            const sz = entry ? opSize(entry[3]) : 1;
            const newPc = (pc + sz) & 0xFFFF;
            const pcLo = (newPc & 0xFF).toString(16).padStart(2, '0');
            const pcHi = ((newPc >> 8) & 0xFF).toString(16).padStart(2, '0');
            await gdbCmd('P4=' + pcLo + pcHi);
            const r = await gdbCmd('g');
            regs = parseRegsG(r);
            respond(req, {
                result: 'Skipped to ' + labelFor(newPc) + ' ($' + newPc.toString(16).toUpperCase().padStart(4, '0') + ')',
                variablesReference: 0
            });
            evt('stopped', { reason: 'step', threadId: 1, allThreadsStopped: true });
            return;
        }

        // Memory read:  x $ADDR [LEN]  or  m ADDR,LEN
        if ((m = expr.match(/^[xm]\s+\$?([0-9a-fA-F]{1,4})(?:[,\s]+(\d+))?$/i))) {
            const addr = parseInt(m[1], 16);
            const len  = parseInt(m[2] || '16', 10);
            const r = await gdbCmd('m' + addr.toString(16) + ',' + len.toString(16));
            if (r && r[0] !== 'E') {
                let out = '$' + addr.toString(16).toUpperCase().padStart(4, '0') + ':';
                for (let i = 0; i < r.length; i += 2) {
                    if (i > 0 && i % 32 === 0) out += '\n' + ' '.repeat(6);
                    out += ' ' + r.substring(i, i + 2).toUpperCase();
                }
                respond(req, { result: out, variablesReference: 0 });
            } else {
                respond(req, {}, false, 'Memory read failed');
            }
            return;
        }

        // Memory write:  w $ADDR $VAL
        if ((m = expr.match(/^w\s+\$?([0-9a-fA-F]{1,4})\s+\$?([0-9a-fA-F]{1,2})$/i))) {
            const addr = parseInt(m[1], 16);
            const val  = parseInt(m[2], 16);
            const r = await gdbCmd('M' + addr.toString(16) + ',1:' + val.toString(16).padStart(2, '0'));
            respond(req, {
                result: r === 'OK' ? 'OK' : 'Write failed',
                variablesReference: 0
            });
            return;
        }

        // Symbol lookup:  sym NAME
        if ((m = expr.match(/^sym\s+(\S+)$/i))) {
            const a = symbols.get(m[1]);
            if (a !== undefined) {
                respond(req, {
                    result: m[1] + ' = $' + a.toString(16).toUpperCase().padStart(4, '0'),
                    variablesReference: 0
                });
            } else {
                respond(req, { result: 'Symbol not found: ' + m[1], variablesReference: 0 });
            }
            return;
        }

        // Register write:  A=$xx  X=$xx  Y=$xx  SP=$xx  PC=$xxxx  ($ prefix required for hex)
        //                  A=65   X=10  (no $ = decimal)
        if ((m = expr.match(/^(A|X|Y|SP|PC)\s*=\s*(\$[0-9a-fA-F]{1,4}|\d+)$/i))) {
            const rname = m[1].toUpperCase();
            const raw = m[2];
            const val = raw.startsWith('$') ? parseInt(raw.substring(1), 16) : parseInt(raw, 10);
            const regNums = { A: 0, X: 1, Y: 2, SP: 3, PC: 4 };
            const rn = regNums[rname];
            let payload;
            if (rname === 'PC') {
                payload = (val & 0xFF).toString(16).padStart(2, '0') + ((val >> 8) & 0xFF).toString(16).padStart(2, '0');
            } else {
                payload = (val & 0xFF).toString(16).padStart(2, '0');
            }
            const r = await gdbCmd('P' + rn + '=' + payload);
            if (r === 'OK') {
                const g = await gdbCmd('g');
                regs = parseRegsG(g);
                const w = rname === 'PC' ? 4 : 2;
                respond(req, {
                    result: rname + ' = $' + (val & (w === 4 ? 0xFFFF : 0xFF)).toString(16).toUpperCase().padStart(w, '0') + ' (' + val + ')',
                    variablesReference: 0
                });
                evt('stopped', { reason: 'pause', threadId: 1, allThreadsStopped: true });
            } else {
                respond(req, {}, false, 'Failed to set ' + rname);
            }
            return;
        }

        // Register read:  A, X, Y, SP, PC
        if (regs) {
            const u = expr.toUpperCase();
            const vals = { A: regs.a, X: regs.x, Y: regs.y, SP: regs.sp, PC: regs.pc };
            if (u in vals) {
                const v = vals[u];
                const w = u === 'PC' ? 4 : 2;
                respond(req, {
                    result: '$' + v.toString(16).toUpperCase().padStart(w, '0') + ' (' + v + ')',
                    variablesReference: 0
                });
                return;
            }
        }

        // Goto (set PC):  goto $ADDR  or  goto symbolName
        if ((m = expr.match(/^goto\s+\$?([0-9a-fA-F]{1,4})$/i))) {
            const addr = parseInt(m[1], 16) & 0xFFFF;
            const pcLo = (addr & 0xFF).toString(16).padStart(2, '0');
            const pcHi = ((addr >> 8) & 0xFF).toString(16).padStart(2, '0');
            await gdbCmd('P4=' + pcLo + pcHi);
            const r = await gdbCmd('g');
            regs = parseRegsG(r);
            respond(req, {
                result: 'PC = ' + labelFor(addr) + ' ($' + addr.toString(16).toUpperCase().padStart(4, '0') + ')',
                variablesReference: 0
            });
            evt('stopped', { reason: 'goto', threadId: 1, allThreadsStopped: true });
            return;
        }
        if ((m = expr.match(/^goto\s+(\S+)$/i))) {
            const symAddr = symbols.get(m[1]);
            if (symAddr === undefined) { respond(req, {}, false, 'Symbol not found: ' + m[1]); return; }
            const pcLo = (symAddr & 0xFF).toString(16).padStart(2, '0');
            const pcHi = ((symAddr >> 8) & 0xFF).toString(16).padStart(2, '0');
            await gdbCmd('P4=' + pcLo + pcHi);
            const r = await gdbCmd('g');
            regs = parseRegsG(r);
            respond(req, {
                result: 'PC = ' + m[1] + ' ($' + symAddr.toString(16).toUpperCase().padStart(4, '0') + ')',
                variablesReference: 0
            });
            evt('stopped', { reason: 'goto', threadId: 1, allThreadsStopped: true });
            return;
        }

        // Try as bare symbol name (also try with _ prefix for C variables)
        let symName = expr;
        let a = symbols.get(symName);
        if (a === undefined && !symName.startsWith('_')) {
            symName = '_' + expr;
            a = symbols.get(symName);
        }
        if (a !== undefined) {
            // Watch/hover render goes through the SAME path as every scope view
            // (buildTypedVar) with the SAME (type,size,ann) the registry hands every
            // other view (renderSpec), so annotations, enum types, structs, arrays and
            // pointers all behave identically.
            const spec = renderSpec(symName);
            const v = await buildTypedVar(symName, a, spec.type, spec.size, spec.ann);
            respond(req, {
                result: v.value,
                variablesReference: v.variablesReference,
                memoryReference: '0x' + a.toString(16)
            });
            return;
        }

        // Forward to Oricutron monitor via qOricCmd:  ! <command>
        if (expr.startsWith('!')) {
            const monCmd = expr.substring(1).trim();
            if (!monCmd) { respond(req, {}, false, 'Usage: ! <monitor command>  (e.g. ! = tmp0+2)'); return; }
            const hexCmd = Buffer.from(monCmd, 'utf8').toString('hex');
            const r = await gdbCmd('qOricCmd,' + hexCmd);
            if (r && r.length > 0) {
                // Decode hex-encoded output
                let text = '';
                for (let i = 0; i < r.length; i += 2)
                    text += String.fromCharCode(parseInt(r.substring(i, i + 2), 16));
                respond(req, { result: text, variablesReference: 0 });
            } else {
                respond(req, { result: '(no output)', variablesReference: 0 });
            }
            return;
        }

        // Try qOricEval as fallback for watch expressions.
        // Skip expressions known to fail (cached from previous E02 responses).
        if (!evalFailCache.has(expr)) {
            const hexExpr = Buffer.from(expr, 'utf8').toString('hex');
            const evalReply = await gdbCmd('qOricEval,' + hexExpr);
            if (evalReply && evalReply.startsWith('V')) {
                const val = parseInt(evalReply.substring(1), 16);
                respond(req, {
                    result: '$' + val.toString(16).toUpperCase().padStart(4, '0') + ' (' + val + ')',
                    variablesReference: 0,
                    memoryReference: '0x' + val.toString(16)
                });
                return;
            }
            // Cache the failure so we don't re-query on every step
            evalFailCache.add(expr);
        }

        // Display format toggle: hex / dec
        if (expr === 'hex' || expr === 'dec') {
            displayHex = (expr === 'hex');
            respond(req, { result: 'Display format: ' + (displayHex ? 'hexadecimal' : 'decimal'), variablesReference: 0 });
            evt('stopped', { reason: 'pause', threadId: 1, allThreadsStopped: true });
            return;
        }

        // Unrecognized — point at the full reference
        respond(req, {}, false,
            "Unrecognized: '" + expr + "'.  Type  help  for the list of console commands.");
    },

    // -- Custom requests (called from extension.js) -------------------

    async readCpuExtra(req) {
        const reply = await gdbCmd('qOricCpuExtra');
        if (!reply || reply.length < 4) {
            respond(req, { extra: null });
            return;
        }
        // Parse L:LLHH;C:LLHHLLHH;F:LLHHLLHH;R:LLHH;N:LLHH;T:LLHH;I:LLHH (little-endian hex)
        const result = {};
        const sections = reply.split(';');
        for (const sec of sections) {
            const colon = sec.indexOf(':');
            if (colon < 0) continue;
            const key = sec.substring(0, colon);
            const hex = sec.substring(colon + 1);
            // Decode little-endian hex bytes into a number
            let val = 0;
            for (let i = 0; i < hex.length; i += 2)
                val |= parseInt(hex.substring(i, i + 2), 16) << (i * 4);
            result[key] = val;
        }
        respond(req, { extra: result });
    },

    async readPeripherals(req) {
        const reply = await gdbCmd('qOricPeripherals');
        log('readPeripherals GDB reply: ' + (reply ? reply.substring(0, 80) : '(null)'));
        if (!reply || reply.length < 4) {
            respond(req, { peripherals: null });
            return;
        }
        // Parse response: V:hex;A:hex;F:hex;M:hex
        const result = {};
        const sections = reply.split(';');
        for (const sec of sections) {
            const colon = sec.indexOf(':');
            if (colon < 0) continue;
            const key = sec.substring(0, colon);
            const hex = sec.substring(colon + 1);
            const bytes = [];
            for (let i = 0; i < hex.length; i += 2)
                bytes.push(parseInt(hex.substring(i, i + 2), 16));
            result[key] = bytes;
        }
        respond(req, { peripherals: result });
    },

    async evaluateMemory(req) {
        const rawExpr = req.arguments.expression || '';
        const count = req.arguments.count || 128;
        // Resolve symbol NAMES against the extension's module-composed table (from
        // config.symbolFile + the active overlay), NOT Oricutron's separate flat
        // `-s symbols` file that mon_eval would otherwise use — which is module-unaware
        // and can be stale/missing/from another project. Substitute each known symbol
        // with its hex address so qOricEval only does the arithmetic/deref; unknown
        // tokens (CPU registers X/Y, literals) pass through to mon_eval. Keeps the
        // memory panel consistent with hover/call-stack/symbol-browser across switches.
        // Lookbehind (?<![$\w]) so we only match standalone identifiers: a token right
        // after '$' is a hex literal (e.g. $ACCA), and one glued to a word char is part
        // of a larger token — neither should be rewritten even if it names a symbol.
        const expr = rawExpr.replace(/(?<![$\w])[A-Za-z_.][\w.]*/g, (tok) => {
            if (symbols.has(tok)) return '$' + (symbols.get(tok) & 0xffff).toString(16);
            const alt = tok.startsWith('_') ? tok : '_' + tok; // C symbols carry a leading _
            if (symbols.has(alt)) return '$' + (symbols.get(alt) & 0xffff).toString(16);
            return tok;
        });
        const hexExpr = Buffer.from(expr, 'utf8').toString('hex');
        const evalReply = await gdbCmd('qOricEval,' + hexExpr);
        if (!evalReply || !evalReply.startsWith('V')) {
            respond(req, { error: 'Invalid expression: ' + rawExpr });
            return;
        }
        const addr = parseInt(evalReply.substring(1), 16);
        // Read memory
        const memReply = await gdbCmd('m' + addr.toString(16) + ',' + count.toString(16));
        respond(req, { address: addr, data: memReply || '', expression: rawExpr });
    },

    logToConsole(req) {
        const text = (req.arguments && req.arguments.text) || '';
        log(text);
        respond(req, {});
    },

    // -- Log verbosity (custom request from the status bar) ------------
    setLogLevel(req) {
        const lvl = req.arguments ? req.arguments.level : undefined;
        if (typeof lvl === 'number' && lvl >= 0 && lvl <= 2) {
            applyLogLevel(lvl);
            respond(req, { level: logLevel, name: LOG_LEVEL_NAMES[logLevel] });
        } else {
            respond(req, {}, false, 'level must be 0 (Errors), 1 (Normal), or 2 (Verbose)');
        }
    },

    // -- Skip instruction (custom request) ----------------------------

    async skip(req) {
        if (!regs) { respond(req, {}, false, 'No register state'); return; }
        gdbWrite('K');
        // K sends a stop reply — route through normal stop handling
        respond(req, { result: 'skip sent' });
    },

    // -- Warp speed toggle (custom request) ---------------------------

    async toggleWarp(req) {
        const reply = await gdbCmd('qOricWarp');
        if (reply === null) { respond(req, {}, false, 'Not connected'); return; }
        const current = reply === '1';
        const newState = !current;
        const setReply = await gdbCmd('qOricWarp,' + (newState ? '1' : '0'));
        respond(req, { warp: newState });
    },

    // -- Turbo Run Until (custom request) -----------------------------
    // Run at warp speed to a target (symbol, file+line, or addr), or just
    // warp-continue to the next breakpoint; warp is restored when we stop.
    async turboRun(req) {
        const a = (req && req.arguments) || {};
        let addr = -1;
        if (typeof a.addr === 'number') addr = a.addr & 0xffff;
        else if (a.symbol && symbols.has(a.symbol)) addr = symbols.get(a.symbol);
        else if (a.file && typeof a.line === 'number') {
            addr = resolveSrcLineAddr(a.file, a.line);
            if (addr >= 0 && !executableLine(addr, a.file)) {
                respond(req, {}, false, 'Target line is data, not executable code'); return;
            }
        }
        if ((a.symbol || a.file) && addr < 0) { respond(req, {}, false, 'Turbo target not found'); return; }
        await armTurbo(addr, a.warp !== false); // warp:false = run-to-target at normal speed
        return handlers.continue(req); // responds + issues continue (handles PC-on-BP)
    },

    // -- Multi-module symbol selection (custom requests) --------------
    getModules(req) {
        respond(req, { modules: listModules(), active: activeModuleId });
    },

    async setActiveModule(req) {
        const id = req.arguments ? req.arguments.id : undefined;
        if (id === null) { applyActiveModule(null); }
        else if (moduleNames.has(id)) { applyActiveModule(id); }
        else { respond(req, {}, false, 'Unknown module id ' + id); return; }
        await rearmModuleBreakpoints();
        respond(req, { active: activeModuleId, name: (activeModuleId !== null ? moduleNames.get(activeModuleId) : null) });
        evt('oricSymbolsChanged', { reason: 'module-switch', module: activeModuleId });
        // Re-emit a stop so VS Code re-queries stack/scopes/variables with the new symbols.
        if (!running) evt('stopped', { reason: 'module switch', threadId: 1, allThreadsStopped: true });
    },

    // -- Line info (custom request): what does file:line map to? ------
    // The host's line actions use it to hide run/jump/turbo on DATA lines.
    // Pure table lookup, no emulator I/O.
    lineInfo(req) {
        const a = req.arguments || {};
        const snap = (resolverInstance && a.file && typeof a.line === 'number')
            ? resolverInstance.addrForLine(a.file, a.line) : null;
        if (!snap) { respond(req, { addr: -1, executable: false }); return; }
        respond(req, { addr: snap.addr, line: snap.line, executable: executableLine(snap.addr, a.file) });
    },

    // -- Reset cycle counter (custom request) -------------------------

    async resetCycles(req) {
        const reply = await gdbCmd('qOricResetCycles');
        respond(req, { result: reply === 'OK' ? 'Cycles reset' : 'Failed' });
    },

    // -- Read all symbols with current values (custom request) ---------

    async readAllSymbols(req) {
        if (symbols.size === 0) {
            respond(req, { symbols: [] });
            return;
        }

        // Build sorted list of all symbols with addresses and sizes — sizes and groups
        // come straight from the single symbol registry (symInfo), so the browser shows
        // the same size every other view uses.
        const allAddrs = [];
        for (const [name, addr] of symbols) {
            const info = symInfo.get(name);
            allAddrs.push({ name, addr,
                            size: info ? info.size : 1,
                            group: info ? info.group : (addr <= 0xFF ? 'zp' : (addr < 0xC000 ? 'ram' : 'high')) });
        }
        allAddrs.sort((a, b) => a.addr - b.addr);

        // Collect unique 256-byte pages that need reading
        const pages = new Set();
        for (const s of allAddrs) {
            const page = s.addr >> 8;
            const endPage = (s.addr + s.size - 1) >> 8;
            pages.add(page);
            if (endPage !== page) pages.add(endPage);
        }

        // Group contiguous pages into ranges for batch reading
        const pageArr = Array.from(pages).sort((a, b) => a - b);
        const ranges = [];
        // Cap each range at 15 pages (3840 bytes). The stub clamps a single `m` reply
        // to (GDB_PKT_SIZE-5)/2 = 4093 bytes; a larger request comes back truncated and
        // the fill loop below would silently leave the tail pages as zeros — shown as
        // real values in the Symbols view. 15 pages stays safely under the clamp.
        for (let i = 0; i < pageArr.length; ) {
            const start = pageArr[i];
            let end = start;
            while (i + 1 < pageArr.length && pageArr[i + 1] === end + 1 && (end - start + 1) < 15) {
                end = pageArr[++i];
            }
            ranges.push({ start, count: end - start + 1 });
            i++;
        }

        // Batch-read each contiguous range (one GDB read per range instead of per page)
        const mem = new Map(); // page -> Uint8Array(256)
        for (const range of ranges) {
            const baseAddr = range.start << 8;
            const byteLen = Math.min(range.count * 256, 0x10000 - baseAddr);
            const reply = await gdbCmd('m' + baseAddr.toString(16) + ',' + byteLen.toString(16));
            if (reply && reply[0] !== 'E') {
                for (let p = 0; p < range.count; p++) {
                    const pageData = new Uint8Array(256);
                    const hexOff = p * 512;
                    for (let i = 0; i < 512 && hexOff + i < reply.length; i += 2)
                        pageData[i >> 1] = parseInt(reply.substring(hexOff + i, hexOff + i + 2), 16);
                    mem.set(range.start + p, pageData);
                }
            }
        }

        // Merge symbols at the same address (aliases)
        const merged = [];
        for (let i = 0; i < allAddrs.length; ) {
            const s = allAddrs[i];
            const names = [s.name];
            // Group size = the largest among aliases at this address. An annotated
            // symbol (e.g. @bcd, size 2) may share its address with an inherited
            // 1-byte symbol; the wider, annotation-derived size is the correct one.
            let maxSize = s.size;
            let j = i + 1;
            while (j < allAddrs.length && allAddrs[j].addr === s.addr) {
                names.push(allAddrs[j].name);
                if (allAddrs[j].size > maxSize) maxSize = allAddrs[j].size;
                j++;
            }
            merged.push({ names, addr: s.addr, size: maxSize, group: s.group });
            i = j;
        }

        // Build result with values
        const result = [];
        for (const s of merged) {
            const value = [];
            for (let i = 0; i < s.size; i++) {
                const a = s.addr + i;
                const page = a >> 8;
                const off = a & 0xFF;
                const pageData = mem.get(page);
                value.push(pageData ? pageData[off] : 0);
            }
            // Canonical owner first — the resolver's stage-3b pick, i.e. the SAME
            // name the call stack and disassembly show at this address — then
            // aliases sorted by name length.
            const rec = resolverInstance ? resolverInstance.resolve(s.addr) : null;
            const master = rec && rec.symbol ? rec.symbol.name : null;
            if (master && s.names.includes(master)) {
                s.names = [master, ...s.names.filter(n => n !== master).sort((a, b) => a.length - b.length)];
            } else {
                s.names.sort((a, b) => a.length - b.length);
            }
            // Per-name navigation targets, all off the one resolver record:
            // the owner gets the record's source (winning exact line, else its
            // decl); each alias gets its own #SYM decl (aliases[].source), with
            // declOf() as the fallback for names the record doesn't carry.
            const aliasSrc = new Map();
            if (rec && rec.symbol) for (const al of rec.symbol.aliases) if (al.source) aliasSrc.set(al.name, al.source);
            const nameSources = {};
            for (const n of s.names) {
                const src = (n === master && rec.source) ? rec.source
                    : aliasSrc.get(n) || (resolverInstance ? resolverInstance.declOf(n) : null);
                if (src) nameSources[n] = { file: src.file, line: src.line };
            }
            const src = rec && rec.source ? rec.source : null;
            const vt = varTypes.get(s.names[0]);
            // Annotated value rendered through the SAME path as Watch (formatAnnotated),
            // so a @bcd/@enum/@bool/@bitset symbol shows the decoded value + type token
            // instead of the browser's raw little-endian byte read.
            let display = null;
            const mAnn = annForSymbol(s.names[0]);
            if (mAnn) {
                const fa = await formatAnnotated(mAnn, s.addr, s.size);
                if (fa) display = fa.value + (fa.type ? '  ' + fa.type : '');
            }
            result.push({ name: s.names[0], aliases: s.names.slice(1),
                          addr: s.addr, size: vt ? vt.totalSize : s.size, value, group: s.group,
                          display,
                          source: src ? { file: src.file, line: src.line } : null,
                          nameSources,
                          typeInfo: vt ? { type: vt.type, base: vt.base, count: vt.count,
                                          fields: typeDefs.has(vt.base) ? typeDefs.get(vt.base).fields : null } : null });
        }

        respond(req, { symbols: result });
    },

    // -- Data breakpoints (watchpoints) -------------------------------

    dataBreakpointInfo(req) {
        const args = req.arguments;
        const name = args.name || '';
        const ref = args.variablesReference;

        // Try to resolve to an address
        let addr = -1;
        let description = name;

        // Check if it's a hex address like "$xx" or "0xxx"
        const hexMatch = name.match(/^\$([0-9a-fA-F]{1,4})/);
        if (hexMatch) {
            addr = parseInt(hexMatch[1], 16);
        } else {
            // Try zero-page variable name (strip address prefix like "$00 name")
            const zpMatch = name.match(/^\$[0-9a-fA-F]{2}\s+(.+)/);
            const symName = zpMatch ? zpMatch[1] : name;
            const symAddr = symbols.get(symName);
            if (symAddr !== undefined) {
                addr = symAddr;
                description = symName + ' ($' + addr.toString(16).toUpperCase().padStart(4, '0') + ')';
            }
        }

        if (addr >= 0) {
            respond(req, {
                dataId: addr.toString(16).padStart(4, '0'),
                description: description,
                accessTypes: ['read', 'write', 'readWrite']
            });
        } else {
            respond(req, { dataId: null, description: 'Cannot watch: ' + name });
        }
    },

    async setDataBreakpoints(req) {
        // Clear all existing data breakpoints
        for (const [, bp] of dataBps) {
            await gdbCmd('z' + bp.gdbType + ',' + bp.addr.toString(16) + ',1');
        }
        dataBps.clear();

        const result = [];
        for (const dbp of (req.arguments.breakpoints || [])) {
            const addr = parseInt(dbp.dataId, 16);
            const access = dbp.accessType || 'write';
            // Map DAP accessType to GDB Z type: write=Z2, read=Z3, readWrite=Z4
            let gdbType;
            switch (access) {
                case 'read':      gdbType = '3'; break;
                case 'readWrite': gdbType = '4'; break;
                default:          gdbType = '2'; break; // write
            }
            const r = await gdbCmd('Z' + gdbType + ',' + addr.toString(16) + ',1');
            const id = bpId++;
            const ok = r === 'OK';
            if (ok) dataBps.set(id, { id, addr, accessType: access, gdbType });
            result.push({
                id: id,
                verified: ok,
                message: ok ? undefined : 'Failed to set watchpoint'
            });
        }
        respond(req, { breakpoints: result });
    },

    // -- Resolve current instruction operands (custom request) --------

    async resolveInstruction(req) {
        if (!regs) { respond(req, { annotation: '', pc: 0 }); return; }
        const pc = regs.pc;
        // Read 3 bytes at PC (uses readMem for per-stop dedup cache)
        const pcBytes = await readMem(pc, 3);
        const opcode = pcBytes[0];
        const lo = pcBytes[1];
        const hi = pcBytes[2];
        const op = OPS[opcode];
        if (!op) { respond(req, { annotation: '', pc }); return; }
        const mne = op.substring(0, 3);
        const mode = op[3];

        const h2 = v => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
        const h4 = v => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
        const sym = addr => symbolAt(addr);
        // An address operand as "label|$hhhh" (or just "$hhhh" when unnamed). The '|'
        // reads as "same location, shown another way" — consistent with the value
        // notation below. `wide` picks 16-bit ($hhhh) vs zero-page ($hh) formatting.
        const symAddr = (addr, wide) => {
            const hex = wide ? '$' + h4(addr) : h2(addr);
            const s = sym(addr);
            return s ? s + '|' + hex : hex;
        };
        // Byte value: reuse the shared scalar formatter so it matches every other view
        // (hex | decimal | binary | 'char' glyph for printable bytes) instead of a
        // parallel format that drifted (it was missing the ASCII glyph).
        const fmtVal = v => formatScalar('uchar', [v & 0xFF], 0, 1);

        // Helper to read 1 byte from memory (uses readMem for dedup cache)
        async function readByte(addr) {
            const m = await readMem(addr & 0xFFFF, 1);
            return m[0];
        }
        // Helper to read 2 bytes (little-endian word) from memory
        async function readWord(addr) {
            const m = await readMem(addr & 0xFFFF, 2);
            return m[0] | (m[1] << 8);
        }

        // Source-aware annotation on a "name+off" operand. A local alias equated to a
        // zp scratch (e.g. "sourcePtr = tmp0 ; @ptr16") doesn't reach the symbol table,
        // and a multi-byte value (e.g. "current_score_bcd ; @bcd-be") touched one byte
        // at a time reads as a lone byte -- so read the intent from the SOURCE line at
        // this PC and render the whole annotated value at its base, not the single byte.
        let annHint = null;
        {
            const s = sourceFor(pc);   // PC -> source line via lineTable (works for any instruction, not just symbol addresses)
            const srcLine = s ? getSourceLine(s.file, s.line) : null;
            const mo = srcLine && srcLine.match(/([A-Za-z_][\w.]*)\s*\+\s*(\d+)/);
            if (mo) {
                const ann = annForSymbol(mo[1]);
                if (ann && (ann.kind === 'ptr16' || ann.kind.indexOf('bcd') === 0))
                    annHint = { name: mo[1], off: parseInt(mo[2], 10), ann };
            }
        }
        // Render an annHint at its base address: "(alias|canon|$base[+off])=value type".
        // ptr16 shows the whole word (identical for +0/+1); bcd shows the full number and
        // marks which byte this instruction touches via +off.
        const annHintStr = async (base, wide) => {
            const canon = sym(base);
            const addrTok = wide ? '$' + h4(base) : h2(base);
            const label = annHint.name + (canon && canon !== annHint.name ? '|' + canon : '') + '|' + addrTok;
            if (annHint.ann.kind === 'ptr16') return '(' + label + ')=' + await ptr16Str(base);
            const a = await formatAnnotated(annHint.ann, base, annWidth(annHint.ann) || 2);
            return '(' + label + '+' + annHint.off + ')=' + a.value + (a.type ? '  ' + a.type : '');
        };

        let annotation = '';
        try {
            switch (mode) {
                case '#': { // immediate
                    annotation = '#' + fmtVal(lo);
                    break;
                }
                case 'z': { // zero page
                    if (annHint) {
                        annotation = await annHintStr((lo - annHint.off) & 0xFF, false);
                        break;
                    }
                    const val = await readByte(lo);
                    annotation = '(' + symAddr(lo, false) + ')=' + fmtVal(val);
                    break;
                }
                case 'x': { // zp,X
                    const ea = (lo + regs.x) & 0xFF;
                    const val = await readByte(ea);
                    annotation = '(' + symAddr(lo, false) + '+X:' + h2(regs.x) + '=' + h2(ea) + ')=' + fmtVal(val);
                    break;
                }
                case 'y': { // zp,Y
                    const ea = (lo + regs.y) & 0xFF;
                    const val = await readByte(ea);
                    annotation = '(' + symAddr(lo, false) + '+Y:' + h2(regs.y) + '=' + h2(ea) + ')=' + fmtVal(val);
                    break;
                }
                case 'a': { // absolute
                    const addr = (hi << 8) | lo;
                    // JSR/JMP don't need value annotation
                    if (mne === 'JSR' || mne === 'JMP') {
                        if (sym(addr)) annotation = symAddr(addr, true);
                    } else if (annHint) {
                        annotation = await annHintStr((addr - annHint.off) & 0xFFFF, true);
                    } else {
                        const val = await readByte(addr);
                        annotation = '(' + symAddr(addr, true) + ')=' + fmtVal(val);
                    }
                    break;
                }
                case 'X': { // abs,X
                    const base = (hi << 8) | lo;
                    const ea = (base + regs.x) & 0xFFFF;
                    const val = await readByte(ea);
                    annotation = '$' + h4(base) + '+X:' + h2(regs.x) + '=$' + h4(ea) + ' =' + fmtVal(val);
                    break;
                }
                case 'Y': { // abs,Y
                    const base = (hi << 8) | lo;
                    const ea = (base + regs.y) & 0xFFFF;
                    const val = await readByte(ea);
                    annotation = '$' + h4(base) + '+Y:' + h2(regs.y) + '=$' + h4(ea) + ' =' + fmtVal(val);
                    break;
                }
                case '(': { // (zp,X) indirect X
                    const ptr = (lo + regs.x) & 0xFF;
                    const ea = await readWord(ptr);
                    const val = await readByte(ea);
                    annotation = '(' + symAddr(lo, false) + '+X:' + h2(regs.x) + '=' + h2(ptr) + ')=$' + h4(ea) + ' =' + fmtVal(val);
                    break;
                }
                case ')': { // (zp),Y indirect Y
                    const ptr = await readWord(lo);
                    const ea = (ptr + regs.y) & 0xFFFF;
                    const val = await readByte(ea);
                    annotation = '(*(' + symAddr(lo, false) + ')=$' + h4(ptr) + '+Y:' + h2(regs.y) + ')=$' + h4(ea) + ' =' + fmtVal(val);
                    break;
                }
                case 'n': { // indirect (JMP only)
                    const addr = (hi << 8) | lo;
                    const target = await readWord(addr);
                    annotation = '($' + h4(addr) + ')=$' + h4(target);
                    break;
                }
                case 'r': { // relative (branches)
                    const offset = lo < 128 ? lo : lo - 256;
                    const target = (pc + 2 + offset) & 0xFFFF;
                    // Determine branch taken/not-taken from flags
                    const f = regs.f;
                    let taken = false;
                    switch (opcode) {
                        case 0x10: taken = !(f & 0x80); break; // BPL: N=0
                        case 0x30: taken = !!(f & 0x80); break; // BMI: N=1
                        case 0x50: taken = !(f & 0x40); break; // BVC: V=0
                        case 0x70: taken = !!(f & 0x40); break; // BVS: V=1
                        case 0x90: taken = !(f & 0x01); break; // BCC: C=0
                        case 0xB0: taken = !!(f & 0x01); break; // BCS: C=1
                        case 0xD0: taken = !(f & 0x02); break; // BNE: Z=0
                        case 0xF0: taken = !!(f & 0x02); break; // BEQ: Z=1
                    }
                    annotation = symAddr(target, true) + (taken ? ' [taken]' : ' [not taken]');
                    break;
                }
                // I (implied), A (accumulator): no memory operand
                default:
                    break;
            }
        } catch (_) { /* annotation stays empty */ }

        const src = sourceFor(pc);
        respond(req, {
            annotation,
            pc,
            file: src ? src.file : null,
            line: src ? src.line : 0
        });
    },

    // -- Disassemble a range of memory (custom request) ---------------

    async disassembleRange(req) {
        const args = req.arguments || {};
        const pc = regs ? regs.pc : 0;
        const count = args.count || 64;
        const before = args.before || 24;

        // Determine center address
        let center = (typeof args.address === 'number') ? args.address : pc;

        // We need to read enough bytes before the center to decode `before` instructions.
        // Worst case: 3 bytes per 6502 instruction, so read 3*before bytes before center.
        const preBytes = before * 3;
        const startAddr = Math.max(0, center - preBytes);
        const totalBytes = Math.min(preBytes + count * 3, 0x10000 - startAddr);

        const reply = await gdbCmd('m' + startAddr.toString(16) + ',' + totalBytes.toString(16));
        if (!reply || reply[0] === 'E') {
            respond(req, { instructions: [], pc, breakpoints: [] });
            return;
        }

        // Parse hex into byte array
        const mem = new Uint8Array(totalBytes);
        for (let i = 0; i < reply.length && i / 2 < totalBytes; i += 2)
            mem[i / 2] = parseInt(reply.substring(i, i + 2), 16);

        // Disassemble all bytes from startAddr
        const allInsns = [];
        let addr = startAddr;
        while (addr < startAddr + totalBytes) {
            const off = addr - startAddr;
            const opcode = mem[off];
            const entry = OPS[opcode];
            if (!entry) {
                // Illegal opcode — emit as data byte
                allInsns.push({ address: addr, bytes: [opcode], mnemonic: '???', operand: '$' + opcode.toString(16).toUpperCase().padStart(2, '0'), label: symbolAt(addr) });
                addr++;
                continue;
            }
            const mnem = entry.substring(0, 3);
            const mode = entry[3];
            const size = opSize(mode);
            if (off + size > totalBytes) break; // not enough bytes
            const lo = size > 1 ? mem[off + 1] : 0;
            const hi = size > 2 ? mem[off + 2] : 0;
            const bytesArr = [];
            for (let b = 0; b < size; b++) bytesArr.push(mem[off + b]);
            const operand = fmtOp(mode, lo, hi, addr);
            allInsns.push({ address: addr, bytes: bytesArr, mnemonic: mnem, operand, label: symbolAt(addr) });
            addr += size;
        }

        // Find the instruction at or closest-before center
        let centerIdx = 0;
        for (let i = 0; i < allInsns.length; i++) {
            if (allInsns[i].address <= center) centerIdx = i;
            else break;
        }

        // Extract window: `before` instructions before center, then enough to fill `count`
        const windowStart = Math.max(0, centerIdx - before);
        const windowEnd = Math.min(allInsns.length, windowStart + count);
        const instructions = allInsns.slice(windowStart, windowEnd);

        // Collect breakpoint addresses, split by whether they're live in the stub.
        // Armed → solid dot; pending (resolved but disarmed, e.g. inactive overlay
        // module) → hollow dot. Function/instruction bps are always armed.
        const bpAddrs = [];
        const pendingAddrs = [];
        for (const [, bp] of bps) bpAddrs.push(bp.addr);
        for (const [, bp] of ibps) bpAddrs.push(bp.addr);
        for (const [, fileBps] of srcBps) {
            for (const bp of fileBps) for (const b of bp.bindings) (b.armed ? bpAddrs : pendingAddrs).push(b.addr);
        }

        respond(req, { instructions, pc, breakpoints: bpAddrs, pendingBreakpoints: pendingAddrs });
    },

    // -- Get last cycle annotation (custom request) -------------------

    getCycleAnnotation(req) {
        respond(req, { annotation: lastCycleAnnotation });
    },

    // -- Map an address to its source location (custom request) -------
    // Used by the disassembly view so a gutter toggle can create a real
    // SourceBreakpoint in VS Code's model rather than a view-local one.
    locationForAddress(req) {
        const addr = req.arguments && req.arguments.address;
        if (typeof addr !== 'number') { respond(req, { location: null }); return; }
        const src = sourceFor(addr & 0xffff);
        respond(req, { location: src ? { file: src.file, line: src.line } : null });
    }
};
