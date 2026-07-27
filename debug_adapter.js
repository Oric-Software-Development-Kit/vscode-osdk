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
const crypto = require('crypto');
const child_process = require('child_process');
const os = require('os');

// Staleness self-check: capture this adapter file's mtime at process start (the
// version node actually compiled). If the file on disk later becomes newer, the
// running code is stale — you edited debug_adapter.js but this session is still
// running the old process. warnIfStale() surfaces that (a fresh session respawns
// node and reloads the file, so restarting the debug session is the fix).
let ADAPTER_LOADED_MTIME = 0;
try { ADAPTER_LOADED_MTIME = fs.statSync(__filename).mtimeMs; } catch (_) { /* ignore */ }
let staleWarned = false;
function warnIfStale() {
    // Dev-only aid (opt-in): warns when you've edited debug_adapter.js but the session
    // is still running the old process. Off by default so a shipped end user never sees it;
    // set OSDK_ADAPTER_STALE_CHECK=1 in the debug launch env to re-enable during development.
    if (!process.env.OSDK_ADAPTER_STALE_CHECK) return;
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

// ROM symbols (Oricutron's romsyms, e.g. basic11b.sym) — a SEPARATE tier from the
// build symbols, fetched from the emulator via qOricRomSyms. ROM is all code with
// no source and sparse symbols, so it's resolved nearest-at-or-below with no
// distance cap, deliberately kept out of the delicate build-symbol resolver.
let romSymbols = [];       // sorted [{addr, name}]
let romSymAddrs = [];      // parallel sorted addr array (binary search)

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
// VS Code closes our stdin on a window reload / extension-host shutdown — which skips
// the graceful DAP `disconnect`, so we must kill the emulator here or it orphans. Same
// for termination signals and any other exit. `killLaunchedEmulator` is idempotent, and
// the `exit` handler is the last-resort net (sync taskkill still runs during exit).
let exitCleanupDone = false;
function cleanupAndExit(code) {
    if (!exitCleanupDone) { exitCleanupDone = true; try { killLaunchedEmulator(); } catch (_) { /* ignore */ } }
    process.exit(code || 0);
}
process.stdin.on('end', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('SIGINT',  () => cleanupAndExit(0));
process.on('SIGHUP',  () => cleanupAndExit(0));
process.on('exit', () => { if (!exitCleanupDone) { exitCleanupDone = true; try { killLaunchedEmulator(); } catch (_) { /* ignore */ } } });

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
    '  A  X  Y  SP  PC           read a register (decoded via its type tag when tracked)',
    '  A=$1F   X=10   PC=$C000   write ($ = hex, no $ = decimal)',
    '  tag a location_id          tag a register with an enum type by hand',
    '  tag  /  untag [a|x|y]      list tracked tags / clear one or all',
    '',
    'Execution',
    '  skip                      skip the current instruction (like Oricutron F12)',
    '  goto $C000                set PC to an address',
    '  goto label                set PC to a symbol',
    '',
    'Memory',
    '  x $C000 [len]             hex dump ($ = hex, no $ = decimal; len is decimal, default 16)',
    '  m C000,20                 hex dump, GDB-style (addr and len always hex)',
    '  w $C000 $FF               write one byte ($ = hex, no $ = decimal)',
    '',
    'Symbols & expressions',
    '  sym NAME                  show a symbol’s address',
    '  NAME                      evaluate a symbol / C variable',
    '  (TYPE)EXPR                view EXPR as TYPE: (uchar*)tmp0, (int)$C000,',
    '                            (uchar[8])buffer, (save_game_file)ptr — also in Watch',
    '  reparse                   re-read @annotations from source (no rebuild, no lost state)',
    '  <expr>                    evaluate via Oricutron (e.g. tmp0+2)',
    '',
    'Display',
    '  hex   dec                 number base for this console',
    '  bin [on|off]              show/hide the %binary column in decoded values',
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
// (`?` is the initial stop query; `qOricHardReset` and `qOricLoadSnapshot` reply
// T05 after resetting/restoring. qOricLoadSnapshot carries a hex-path arg, so
// match by prefix.)
function stopReplyIsResponse() {
    return pendingCmdType === '?' || pendingCmd === 'qOricHardReset' ||
           (pendingCmd !== null && pendingCmd.indexOf('qOricLoadSnapshot,') === 0) ||
           (pendingCmd !== null && pendingCmd.indexOf('qOricHistBack,') === 0) ||
           (pendingCmd !== null && pendingCmd.indexOf('qOricHistForward,') === 0);
}
let gdbQueue = [];           // queued commands: [{cmd, resolve}]
let disconnecting = false;
let emuPid = null;           // pid of the emulator we're attached to (for logging + alive checks)

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
            stopMonitorBpPoll();
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
                // Distinguish a dropped socket (emulator alive) from a dead emulator.
                const alive = pidAlive(emuPid);
                log('GDB socket closed — emulator (pid ' + (emuPid || '?') + ') is ' + (alive ? 'STILL RUNNING (socket dropped, not a crash)' : 'gone (exited)'));
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

// PID(s) listening on `port` — the emulator is detached (script launch), so we
// find it by port. Also used to log which process we attached to and to tell a
// dropped socket from a dead emulator.
function pidsOnPort(port) {
    try {
        if (process.platform === 'win32') {
            const out = child_process.execSync('netstat -ano -p tcp', { windowsHide: true }).toString();
            const pids = new Set();
            for (const line of out.split(/\r?\n/)) {
                const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
                if (m && parseInt(m[1], 10) === port) pids.add(m[2]);
            }
            return [...pids];
        }
        return child_process.execSync('lsof -ti tcp:' + port + ' -s tcp:LISTEN', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\s+/).filter(Boolean);
    } catch (_) { return []; }
}

// Is a pid still running? Distinguishes "socket dropped, emulator alive" from
// "emulator exited" on a disconnect.
function pidAlive(pid) {
    if (!pid) return false;
    try {
        if (process.platform === 'win32') {
            const out = child_process.execSync('tasklist /FI "PID eq ' + pid + '" /NH', { windowsHide: true }).toString();
            return new RegExp('\\b' + pid + '\\b').test(out);
        }
        process.kill(parseInt(pid, 10), 0);
        return true;
    } catch (_) { return false; }
}

// Kill the process(es) listening on `port` (used when the emulator was started
// detached by a launch script, so we have no child handle). Best-effort.
function killByPort(port) {
    for (const pid of pidsOnPort(port)) {
        try {
            if (process.platform === 'win32') child_process.execSync('taskkill /pid ' + pid + ' /T /F', { windowsHide: true, stdio: 'ignore' });
            else process.kill(parseInt(pid, 10), 'SIGTERM');
        } catch (_) { /* gone */ }
    }
}

// Synchronously kill the Oricutron we launched — the direct child handle if we have
// one, or (for a script/detached launch) whatever now owns the gdb port. Shared by the
// disconnect handler AND the process-exit safety nets below, so a window reload or any
// other abrupt shutdown that skips `disconnect` can't leave an orphaned emulator.
function killLaunchedEmulator() {
    if (launchedProcess) {
        try {
            if (process.platform === 'win32')
                child_process.execSync('taskkill /pid ' + launchedProcess.pid + ' /T /F', { windowsHide: true, stdio: 'ignore' });
            else
                launchedProcess.kill('SIGTERM');
        } catch (_) { /* already exited */ }
        launchedProcess = null;
    }
    if (scriptLaunched) {
        killByPort((config && config.port) || 6502);
        scriptLaunched = false;
    }
    clearEmuPidFile();   // we killed it cleanly — no orphan for the next session to reclaim
}

// Is `pid` an Oricutron process? Used so we only auto-reclaim OUR own stale emulator on
// the gdb port — never some unrelated service that happens to be listening there.
function isOricutronPid(pid) {
    try {
        if (process.platform === 'win32') {
            const out = child_process.execSync('tasklist /FI "PID eq ' + pid + '" /NH /FO CSV', { windowsHide: true }).toString();
            return /oricutron/i.test(out);
        }
        const out = child_process.execSync('ps -p ' + pid + ' -o comm=', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        return /oricutron/i.test(out);
    } catch (_) { return false; }
}

// Force-kill a pid (whole tree on Windows). Best-effort.
function killPid(pid) {
    try {
        if (process.platform === 'win32') child_process.execSync('taskkill /pid ' + pid + ' /T /F', { windowsHide: true, stdio: 'ignore' });
        else process.kill(parseInt(pid, 10), 'SIGTERM');
    } catch (_) { /* already gone */ }
}

// --- Orphan reclaim across sessions (the robust fix) --------------------------
// On Windows a VS Code window reload hard-terminates the adapter (TerminateProcess),
// so NONE of our cleanup runs — and the orphaned Oricutron stops listening on its gdb
// port once its debugger drops, so it can't be found by port either. So we persist the
// emulator's exact pid to a small file keyed by PROJECT, and the next launch kills that
// pid directly (verifying it's still an Oricutron, in case the OS reused the pid).
function emuPidFile() {
    const key = (config.cwd || config.diskImage || config.emulatorPath || 'oric').toLowerCase();
    const h = crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
    return path.join(os.tmpdir(), 'oricutron-dbg-' + h + '.pid');
}
function writeEmuPidFile(pid) {
    if (!pid) return;
    try { fs.writeFileSync(emuPidFile(), String(pid)); } catch (_) { /* non-fatal */ }
}
function clearEmuPidFile() {
    try { fs.unlinkSync(emuPidFile()); } catch (_) { /* already gone */ }
}
// Kill the emulator left behind by a previous session of THIS project (if any).
function reclaimOrphanEmulator() {
    let pid = null;
    try { pid = parseInt(fs.readFileSync(emuPidFile(), 'utf8').trim(), 10); } catch (_) { return; }
    // isOricutronPid is true only if `pid` is a LIVE Oricutron right now — so it both
    // confirms the orphan is still alive and guards against the pid having been reused by
    // an unrelated process (we must never kill something that isn't our emulator).
    if (pid && pid !== (emuPid || 0) && isOricutronPid(pid)) {
        log('Killing orphaned Oricutron (pid ' + pid + ') left by a previous debug session.');
        killPid(pid);
    }
    clearEmuPidFile();
}

// If a stale Oricutron is still listening on our gdb port (e.g. a previous session that
// didn't shut down cleanly), kill it so we can bind a fresh one — rather than refusing or
// silently attaching to stale code. Returns { foreign, free }: `foreign` true if a
// NON-Oricutron owns the port (caller should refuse rather than kill something unrelated);
// `free` true once the port is confirmed released (we poll — the OS frees the listen
// socket a beat after the process dies).
async function reclaimStaleEmulator(port, host) {
    const pids = pidsOnPort(port);
    if (!pids.length) return { foreign: false, free: true };
    let foreign = false;
    for (const pid of pids) {
        if (isOricutronPid(pid)) {
            log('Reclaiming stale Oricutron (pid ' + pid + ') on gdb port ' + port + ' from a previous session.');
            try {
                if (process.platform === 'win32') child_process.execSync('taskkill /pid ' + pid + ' /T /F', { windowsHide: true, stdio: 'ignore' });
                else process.kill(parseInt(pid, 10), 'SIGTERM');
            } catch (_) { /* gone */ }
        } else {
            foreign = true;
        }
    }
    if (foreign) return { foreign: true, free: false };
    // Wait for the listen socket to be released (up to ~1s).
    for (let i = 0; i < 10; i++) {
        if (!(await probePort(host || 'localhost', port))) return { foreign: false, free: true };
        await new Promise(r => setTimeout(r, 100));
    }
    return { foreign: false, free: false };
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
    // Stamp resume kind for register-tag tracking: a bare single step ('s'),
    // Oricutron step-over ('N'), continue ('c') or step-out ('O').
    if (cmd === 's' || cmd === 'N' || cmd === 'c' || cmd === 'O') lastResumeKind = cmd;
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
let filesWithLines = new Set();   // canonPath of every file that has >=1 #LINES entry
                              // (used to warn when a .c breakpoint can't bind because the
                              // project was built without -g1: a workspace .c file absent
                              // from this set has no source-line info)
let regs       = null;        // { a, x, y, sp, pc, f }
let running    = false;
let bpPollTimer = null;       // interval that reconciles monitor-set breakpoints while stopped
let bpPollBusy = false;       // guards against overlapping reconciles
let config     = {};
let bpId       = 1;
let bps        = new Map();   // id -> { id, addr, name } (function breakpoints)
let ibps       = new Map();   // id -> { id, addr }       (instruction breakpoints)
let addrBps    = new Map();   // addr -> { addr }  ADAPTER-OWNED address breakpoints for
                              // no-source / ROM code (e.g. $238, Char2Scr). Armed directly
                              // via Z0, NOT through VS Code's InstructionBreakpoint model
                              // (which it won't even arm for programmatic bps). Shown as dots
                              // in the Oric Disassembly and in the Oric Breakpoints panel.
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
// @params grammar for byte-stream commands: "enumName.MEMBER" -> [typeToken, ...].
// Each token is a param type (an enum name, byte, word, str255) or the special
// "end" token = stop the linear preview after this command (terminators, jumps).
let paramsByEnumMember = new Map();
// Enum defs recovered from the header scan (typedef enum bodies). Fallback for
// pure-asm projects (e.g. Nova) whose build has no C compilation unit — xa only
// registers enumerators as defines and emits no #TYPES enum records. Same shape
// as enumDefs entries; consulted LAST by resolveEnum so compiler-emitted records
// always win. Values must be literal (decimal/hex) or implicit sequential — an
// enum with a computed member is dropped rather than guessed at.
// name -> { size, byValue, isFlags }.
let headerEnumDefs = new Map();
let annBySymbol = new Map();  // symbolName (no leading _) -> { kind, enumName? }
// Union of every module's enum defs. Annotation resolution (@enum/@bitset) must
// work regardless of which module is active (the enum defs are identical across
// modules), including when no module is active yet (resident-only at boot).
let allEnumDefs = new Map();
// One lookup for enum defs by annotation/type name. A '|' chain
// ('@enum word_id|item_id' on union holders like gWordBuffer) resolves to the
// first member that DEFINES the value when one is given (Encounter keeps the
// ranges disjoint: items < 128, words >= 128), else the first member that
// exists (existence checks, sizing).
function resolveEnum(name, value) {
    if (name && name.indexOf('|') >= 0) {
        let first = null;
        for (const part of name.split('|')) {
            const ed = enumDefs.get(part) || allEnumDefs.get(part) || headerEnumDefs.get(part);
            if (!ed) continue;
            if (value !== undefined && ed.byValue.has(value)) return ed;
            if (!first) first = ed;
        }
        return first;
    }
    return enumDefs.get(name) || allEnumDefs.get(name) || headerEnumDefs.get(name);
}
// Annotation lookup for a symbol (C global or asm label), tolerant of the leading
// underscore the C compiler / assembler add. One place so every view resolves the
// same way.
function annForSymbol(name) { return name ? annBySymbol.get(name.replace(/^_+/, '')) : undefined; }
// The byte width an annotation pins down, or 0 if it implies none (bool/enum default
// to a single byte at the caller). One place so symbol sizing and value rendering agree.
function annWidth(ann) {
    if (!ann || typeof ann.kind !== 'string') return 0;
    if (ann.kind === 'ptr16' || ann.kind === 'strptr') return 2;
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
// Per-session set of files for which we've already emitted the "no C line info"
// warning, so a flapping/re-sent setBreakpoints doesn't spam the console.
let warnedNoCLineInfo = new Set();
// One-shot-per-PC guard for the symbol/binary mismatch warning (multi-overlay or
// link-layout bugs where the loaded code doesn't match the symbols at an address).
let warnedMismatchPCs = new Set();
let dataBps    = new Map();   // id -> { addr, accessType, gdbType } (plain DAP data breakpoints)
// Extension-owned WATCHPOINT EVENTS (access-triggered breakpoints with exec-bp parity:
// module scope, condition, and log/[save]/[stop] actions). The extension owns the list
// (persists it, re-sends via oricSetWatchpoints on session start / edits); the adapter
// arms the ones whose module is active and runs their actions when they fire.
let watchEvents = [];         // { id, addr, size, access, module, condition, logMessage, enabled, armed }
let armedAddrs = new Map();   // addr -> refcount of execution breakpoints armed in the stub
let bpLock     = Promise.resolve();  // serialization gate for breakpoint / arm-state mutations
// Run an arm-state mutation serialized behind bpLock. VS Code bursts many
// setBreakpoints on a bulk enable/disable, and a module switch can overlap a
// breakpoint edit; running them concurrently interleaves armedAddrs/srcBps/
// bindings and leaves breakpoints armed nondeterministically. Callers must NOT
// already hold the lock — every locked function reaches only the atomic
// armAddr/disarmAddr/gdbCmd leaves (audited), so this never nests or deadlocks.
function withBpLock(fn) {
    const prev = bpLock;
    let release;
    bpLock = new Promise(r => { release = r; });
    return prev.then(fn).finally(release);
}
let moduleWatchAddr = -1;     // addr of the hidden _osdk_dbg_module write-watch (-1 = none); arms overlays on load
let moduleWatchPending = false; // true between the module-watch stop and the dobp=FALSE step that commits the write
let moduleByteTrusted = false; // false until we KNOW _osdk_dbg_module is meaningful (a write was observed, or we attached to a running program). At cold boot the byte is uninitialized RAM — its value must not be believed.
let resumeMode = 'run';       // 'run' | 'step' — how execution was last resumed (for transparent module switches)
let gotoTargetMap = new Map(); // targetId -> address (for goto/setNextStatement)
let lastCycleAnnotation = null; // { pc, cycles } from last step-over/step-out
// Absolute cpu.cycles / frame counters + starting PC captured just before a step
// resumed (read via qOricCpuExtra). The stop handler subtracts to get the elapsed
// cycles and attributes the annotation to stepStartPc (the line stepped over) —
// works on every step path, no OricCycles: dependence, no pc-3 JSR guess.
let stepCyclesBefore = null;
let stepStartPc = null;
// true for run-type resumes (run-to-cursor / continue / turbo): attribute the
// annotation to the DESTINATION line we land on (where the user is looking) when it
// resolves to source, else the start line. Steps keep start attribution (the line executed).
let stepPreferDest = false;
let launchedProcess = null;     // child_process handle if we launched Oricutron
let sourceLineCache = {};       // filePath -> string[] (lazy-loaded source, 0-based)
let tempStepBp = -1;           // address of temp breakpoint for source-level stepping (-1 = none)
let continueAfterStep = false; // true when single-stepping past a BP before continuing (F5)
let stoppedOnWatch = false;    // true when the last stop was a data-watchpoint ACCESS: continue must
                               // step off the accessing instruction first, else 'c' re-fires on it (F5 stuck)
let stepInInProgress = false;  // true while a source-level Step Into is single-stepping toward a new source line (descends into callees)
let stepInStartFile = null;    // source file/line where the current Step Into began (compared to detect arrival)
let stepInStartLine = -1;
let stepInBudget = 0;          // instruction-step budget so a step into source-less code can't run away
// Source-level Step Over (F10): single-step to the next source line, stepping OVER JSRs
// (run to their return) rather than descending. Follows real execution, so it's immune to
// -O1 basic-block reordering that breaks any "next line = next address" prediction.
let stepOverInProgress = false;
let stepOverStartFile = null;
let stepOverStartLine = -1;
let stepOverStartSp = -1;       // hw SP at start: sp > start = returned from this fn; sp < start = inside a call
let stepOverBudget = 0;
let turboWarpActive = false;   // true while a "Turbo Run" is warping toward a stop
let turboPrevWarp = false;     // warp state to restore when the turbo run stops
let scriptLaunched = false;    // true when Oricutron was started via a launch script (detached; kill by port)
let initBreakAddr = -1;        // address of the --gdb_break entry breakpoint to drop on connect (-1 = none)
let entryAddr = -1;            // preserved entry address (initBreakAddr is cleared once hit; restart re-arms from this)
let awaitingEntry = false;     // true after configurationDone continue, until the entry breakpoint is hit
let baselineReady = false;     // a "__baseline" snapshot was captured at the entry (enables instant restart)
let restartViaSnapshot = false;// set by restart() when it loaded the baseline; configurationDone then just stops at entry
// Time-travel history (reverse debugging). The ring of machine states lives IN
// Oricutron's RAM (see the qOricHist* stub commands) — the adapter just pushes a
// state at each stop and asks the emulator to step back. Enabled when the launch
// config's "historyBudgetMB" > 0 (that budget bounds the emulator's ring).
let histEnabled = false;
let histBudgetKB = 0;          // ring budget in KB, sent to the emulator

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

// Build staleness check. Pure fs, cross-platform, no shell/bat parsing.
//
// `sourceDirs` entries are literal files or directories (typically under
// ${workspaceFolder}). `opts.extensions` (if set) restricts the walk to those
// suffixes, and `opts.exclude` drops any path containing a listed segment
// (e.g. [".git","build","node_modules"]). Both are optional.
//
// Never count files under the build-output directory as "sources" — the build
// writes there, so including it (e.g. sources: ["${workspaceFolder}"]) would make
// the project perpetually look stale right after a successful build.
function checkStale(outputPath, sourceDirs, opts) {
    let outMtime;
    try { outMtime = fs.statSync(outputPath).mtimeMs; }
    catch (e) { return true; } // output missing → stale
    if (!sourceDirs || sourceDirs.length === 0) return false;

    opts = opts || {};
    const exts = opts.extensions && opts.extensions.length
        ? new Set(opts.extensions.map(e => e.toLowerCase().replace(/^\./, '')))
        : null;
    const excludeSegs = new Set((opts.exclude || []).map(s => canonPath(s)));
    const newerThan = (f) => {
        try { return fs.statSync(f).mtimeMs > outMtime; } catch (_) { return false; }
    };
    const wanted = (f) => {
        // drop excluded paths (any path segment in the exclude list)
        if (excludeSegs.size) {
            const segs = canonPath(f).split(/[\\/]/);
            for (const s of segs) if (excludeSegs.has(s)) return false;
        }
        if (!exts) return true;
        const m = f.match(/\.([^.\\/]+)$/);
        return !!m && exts.has(m[1].toLowerCase());
    };

    const outDir = canonPath(path.dirname(outputPath)) + path.sep;
    const underOutDir = (p) => canonPath(p).startsWith(outDir);

    for (const entry of sourceDirs) {
        // Each entry is a literal file or directory (typically under
        // ${workspaceFolder}). extensions/exclude filter the directory WALK below,
        // NOT a literal file the user listed explicitly — so adding osdk_config.bat
        // (or a .sh) to sources works even when extensions is set to source suffixes
        // only. Explicit user choices aren't second-guessed by the filters.
        let stat;
        try { stat = fs.statSync(entry); } catch (e) { continue; }
        if (stat.isFile()) {
            if (!underOutDir(entry) && stat.mtimeMs > outMtime) return true;
            continue;
        }
        for (const f of readdirRecursive(entry)) {
            if (underOutDir(f) || !wanted(f)) continue;
            if (newerThan(f)) return true;
        }
    }
    return false;
}

// Resolve the build target artifact path. Cross-platform, build-driven (no
// .bat/makefile parsing — the build is the source of truth). Precedence:
//   1. explicit hint (config.diskImage / config.build.output), if it exists
//   2. newest *.dsk under buildDir   (disk projects; a tap2dsk .tap is only an
//      intermediate, so .dsk wins when both exist)
//   3. newest *.tap under buildDir   (pure-tape projects)
//   4. null  — caller treats as "no known output yet" (first launch → stale →
//      build runs → re-scan finds what was produced)
function resolveBuildArtifact(hint, buildDir) {
    if (hint) {
        try { if (fs.statSync(hint).isFile()) return hint; } catch (_) { /* fall through */ }
    }
    if (!buildDir) return hint || null;
    const pickNewest = (ext) => {
        let best = null, bestMtime = -1;
        try {
            for (const f of readdirRecursive(buildDir)) {
                if (!f.toLowerCase().endsWith('.' + ext)) continue;
                let m;
                try { m = fs.statSync(f).mtimeMs; } catch (_) { continue; }
                if (m > bestMtime) { bestMtime = m; best = f; }
            }
        } catch (_) { /* build dir missing/unreadable */ }
        return best;
    };
    return pickNewest('dsk') || pickNewest('tap') || hint || null;
}

// The media path to pass to Oricutron when launching it directly (emulatorPath
// path, not the launchScript/OSDK path). Rule: an explicit diskImage wins; else
// the auto-detected target only if it's a .dsk. A .tap is NEVER passed here —
// tape loading is handled by the launchScript path (auto-CLOAD), and handing a
// .tap to Oricutron as a media arg would be wrong. Returns undefined when no
// disk media applies (tape projects, or nothing detected yet).
function resolvedDiskMedia() {
    if (config.diskImage) return config.diskImage;
    if (resolvedTarget && /\.dsk$/i.test(resolvedTarget)) return resolvedTarget;
    return undefined;
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
    filesWithLines = new Set();
    warnedMismatchPCs = new Set();   // new module view → re-check PCs against its symbols

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
        for (const [n, s] of b.symSource)  setSymSource(symSource, n, s);
        for (const [k, v] of b.typeDefs)   typeDefs.set(k, v);
        for (const [k, v] of b.varTypes)   varTypes.set(k, v);
        for (const [k, v] of b.localDefs)  localDefs.set(k, v);
        for (const [k, v] of b.enumDefs)   enumDefs.set(k, v);
        for (const e of b.lineTable)       { lineTable.push(e); filesWithLines.add(canonPath(e.file)); }
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

// Re-read comment annotations (@bool/@enum/@ptr16/@bcd/@str/…) from the source
// files WITHOUT reloading the symbol table — no rebuild, no lost debugger state.
// Annotations live purely in source comments; parseAnnotations reads them fresh
// from disk, so editing/adding one and reparsing makes it live immediately.
// (Symbol addresses, line tables and struct/enum type defs come from the built
// symbol file — those DO need a rebuild + session restart to change.)
// Hash of the disk image the emulator is actually running (captured at launch).
// A rebuild that leaves this UNCHANGED is byte-identical: the running binary
// still matches, so the symbol file can be re-parsed in place (new enum members,
// etc.) WITHOUT relaunching. A changed hash means the emulator holds a stale
// binary — reloading symbols would mismatch, so we refuse and ask for a restart.
let launchArtifactPath = null;
let launchArtifactHash = null;
// Resolved build target for the current session: explicit output/diskImage if
// set, else auto-detected from build/ (newest .dsk, else newest .tap). Shared
// between launch and restart so both build-if-stale and the launch consumers
// (Oricutron media arg, snapshot hashing) agree on one path.
let resolvedTarget = null;
function hashFile(p) {
    try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
    catch (e) { return null; }
}

// --- Snapshots (SPEC-snapshot-lifecycle.md) -----------------------------------
// Snapshots live in a PROJECT subfolder (never the Oricutron folder). The DIRECTORY is the
// single source of truth: each *.snapshot file is a self-contained, restorable machine state
// (RAM + disk). There is NO manifest and NO auto-invalidation — a build/disk change never
// removes them, copying a file in makes it appear, and the save time is the file's mtime.
function snapshotDir() {
    const base = config.cwd || (config.build && config.build.cwd) || process.cwd();
    return path.join(base, '.oric-snapshots');
}
function snapshotFile(name) { return path.join(snapshotDir(), name + '.snapshot'); }
// Tell the extension's snapshot panel to refresh (a DAP custom event).
function snapshotsChanged() { try { evt('oricSnapshotsChanged', {}); } catch (e) { /* ignore */ } }
// Save a snapshot to the project folder. The FILE is the record — there is no manifest.
// Shared by the saveSnapshot request and the [save] logpoint token. Returns { name } or { error }.
async function doSaveSnapshot(rawName) {
    const name = String(rawName || 'snap').replace(/[^\w.-]/g, '_').slice(0, 64) || 'snap';
    try { fs.mkdirSync(snapshotDir(), { recursive: true }); } catch (e) { /* ignore */ }
    const r = await gdbCmd('qOricSaveSnapshot,' + Buffer.from(snapshotFile(name), 'utf8').toString('hex'));
    if (typeof r === 'string' && r.indexOf('E snapshot') === 0) return { error: r.slice(2).trim() };
    log('Snapshot saved: ' + name);
    snapshotsChanged();
    return { name };
}
// The reserved baseline snapshot: captured once at the program entry (loaded, before
// the first continue) so Restart can reload it instantly instead of rebooting +
// re-loading the tape. Hidden from the user's snapshot list.
const BASELINE = '__baseline';
async function captureBaseline() {
    try { fs.mkdirSync(snapshotDir(), { recursive: true }); } catch (e) { /* ignore */ }
    const r = await gdbCmd('qOricSaveSnapshot,' + Buffer.from(snapshotFile(BASELINE), 'utf8').toString('hex'));
    if (typeof r === 'string' && r.indexOf('E snapshot') === 0) { baselineReady = false; log('Baseline snapshot failed: ' + r.slice(2).trim()); return; }
    baselineReady = true;
    log('Captured restart baseline snapshot at the entry');
}

// NOTE: there is deliberately NO "discard all snapshots" primitive. User snapshots are
// self-contained and must never be bulk-deleted by an automatic path (staleness, rebuild,
// launch). The only snapshot removals are: invalidateBaseline (the internal baseline only)
// and the single, explicit user "delete this snapshot" command. See SPEC-snapshot-lifecycle.md.

// Invalidate ONLY the restart baseline (the build-specific entry state). User snapshots are
// self-contained files and are NEVER auto-deleted. The next launch re-captures the baseline.
function invalidateBaseline() {
    try { fs.unlinkSync(snapshotFile(BASELINE)); } catch (e) { /* already gone */ }
    baselineReady = false;
}

// Re-parse the symbol FILE in place (new enum members / types / symbols from a
// rebuild) without relaunching the emulator — but ONLY when the disk image is
// byte-identical to launch (see launchArtifactHash). Returns a result object.
function reloadSymbols(force) {
    if (!config || !config.symbolFile) return { reloaded: false, reason: 'no symbol file configured' };
    if (launchArtifactPath && launchArtifactHash && !force) {
        const now = hashFile(launchArtifactPath);
        if (now && now !== launchArtifactHash)
            return { reloaded: false, changed: true, reason: 'disk image changed since launch — the emulator is running the old binary; restart the debug session to load the new build (or force to reload symbols anyway)' };
    }
    const prevActive = activeModuleId;
    loadSymbols(config.symbolFile);            // re-reads #SYM/#TYPES/#LINES + annotations; emits oricSymbolsChanged
    if (prevActive !== null && moduleNames.has(prevActive)) applyActiveModule(prevActive);
    return { reloaded: true, symbols: symbols.size };
}

function reparseAnnotations() {
    sourceLineCache = {};              // drop cached source text so CODE-LINE @enum edits reload
    parseAnnotations(moduleAllFiles);
    buildSymInfo();                    // annotation widths (bcd/bitset) re-applied
    evt('oricSymbolsChanged', { reason: 'reparse', module: activeModuleId });
    return annBySymbol.size + annByField.size;
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
        log('Active module -> ' + moduleNames.get(val) + ' (id ' + val + ')' +
            (force ? ' [early: module-load watch]' : ' [late: detected at a stop]'));
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

// Human-readable module label for a bucket id: the module's NAME when known, 'resident' for
// 'R', '(none)' for null — never a bare internal index (an id like "0" means nothing to a
// caller when the module is called "Splash").
function moduleLabel(id) {
    if (id === 'R') return 'resident';
    if (id === null || id === undefined) return '(none)';
    return moduleNames.get(id) || String(id);
}

// Message for a source breakpoint that failed to bind. Returns the actionable
// -g1 hint when the cause is a workspace .c file with no line info (project built
// without -g1), else the generic "No code at this line". Shared by setBreakpoints
// and revalidateBreakpointsAfterSymbolLoad so both surfaces stay identical.
// `emitWarn` (default true) also fires the one-shot 'important' console warning.
function unboundBpMessage(srcPath, norm, emitWarn) {
    if (emitWarn === undefined) emitWarn = true;
    let msg = 'No code at this line';
    const wfRaw = config.workspaceFolder || config.cwd || (config.build && config.build.cwd);
    const wf = wfRaw ? canonPath(wfRaw) : '';
    const underWs = wf && (norm === wf || norm.startsWith(wf + path.sep));
    // filesWithLines is the ACTIVE view only; a C file belonging to an inactive overlay has
    // line info that simply isn't composed in right now. Claiming "-g1 missing" for it would be
    // a false alarm, so check every module bucket before blaming the build.
    let hasLinesAnywhere = filesWithLines.has(norm);
    if (!hasLinesAnywhere) {
        for (const [, b] of moduleBuckets) {
            if (b.lineTable.some(e => canonPath(e.file) === norm)) { hasLinesAnywhere = true; break; }
        }
    }
    if (resolverInstance && /\.c$/i.test(srcPath) && underWs
        && !hasLinesAnywhere) {
        msg = 'No source-line info for this C file — rebuild with -g1 '
            + '(set OSDKDEBUG=-g1 in osdk_config.bat) so C breakpoints '
            + 'can bind. Assembly (.s) breakpoints are unaffected.';
        if (emitWarn && !warnedNoCLineInfo.has(norm)) {
            warnedNoCLineInfo.add(norm);
            const fn = srcPath.split(/[\\/]/).pop();
            evt('output', { category: 'important', output:
                '⚠ Breakpoints in ' + fn + " won't bind: the project was built "
                + 'without -g1, so no C source-line info is present. Add '
                + 'SET OSDKDEBUG=-g1 to osdk_config.bat and rebuild. '
                + '(Assembly breakpoints are unaffected.)\n' });
        }
    }
    return msg;
}

// Sync source-breakpoint arming to the active module: (re)arm resident + active-
// module breakpoints in the stub, disarm the rest. Called after the active module
// changes so a breakpoint in an overlay only fires while that overlay is loaded.
async function rearmModuleBreakpoints() {
  // Serialized with setBreakpoints (and itself): a module switch overlapping a
  // breakpoint edit would otherwise interleave this srcBps walk with srcBps.set
  // and double-flip binding.armed / armedAddrs. Callers (checkModuleSwitch,
  // setActiveModule) stay UNLOCKED so this never nests. It's still awaited before
  // the resume in onStopReply, so a brief queue behind a burst is safe.
  return withBpLock(async () => {
    for (const [, arr] of srcBps) {
        for (const bp of arr) {
            // A breakpoint with NO bindings was never resolved — typically one restored
            // from a previous session: VS Code re-sends it at session start, before the
            // symbols (and so fileToModules) exist, and it does not re-send later. Without
            // re-resolving here it stays dead for the whole session even once its overlay
            // becomes resident, which is exactly the "saved breakpoints are dead on arrival"
            // trap (and it contradicted the "binds when its module loads" promise).
            if (!bp.bindings.length) {
                const srcPath = (bp.source && bp.source.path) ? bp.source.path : '';
                const norm = canonPath(srcPath);
                for (const mod of (fileToModules.get(norm) || ['R'])) {
                    const snap = resolverInstance ? resolverInstance.addrForLine(srcPath, bp.line, mod) : null;
                    if (snap) bp.bindings.push({ addr: snap.addr, module: mod, armed: false });
                }
            }
            // A source breakpoint has one binding per owning module (shared files
            // span several overlays). Arm the binding whose module is now active or
            // resident; disarm the rest. The bp is verified if ANY binding is armed.
            let changed = false;
            for (const b of bp.bindings) {
                const desired = (b.module === 'R' || b.module === activeModuleId);
                if (desired && !b.armed) { b.armed = await armAddr(b.addr); if (b.armed) await sendCond(b.addr, bp.condExpr, bp.hitTarget); changed = true; }
                else if (!desired && b.armed) { await disarmAddr(b.addr); b.armed = false; changed = true; }
            }
            if (changed) {
                const armedB = bp.bindings.find(b => b.armed);
                const verified = !!armedB;
                const dispB = armedB || bp.bindings[0];
                const hex = '$' + (dispB.addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
                const lbl = labelFor(dispB.addr);
                const where = (lbl === hex ? hex : lbl + ' (' + hex + ')');
                evt('breakpoint', { reason: 'changed', breakpoint: verified
                    ? { id: bp.id, verified: true, line: bp.line, source: bp.source, message: where }
                    : { id: bp.id, verified: false, line: bp.line, source: bp.source,
                        message: where + ' — inactive module, binds when its overlay loads' } });
            }
        }
    }
    // Watchpoint events follow the same module gating: arm when their module becomes
    // active, disarm when it's swapped out. (Resident / ANY-scope watches stay armed.)
    for (const ev of watchEvents) {
        const want = watchDesired(ev);
        if (want && !ev.armed) await armWatch(ev);
        else if (!want && ev.armed) await disarmWatch(ev);
    }
  });
}

// Re-resolve every source breakpoint against the freshly-loaded symbols and
// emit 'breakpoint' events with the new verified/message state. This is the fix
// for stale srcBps bindings: without it, a rebuild that removes line info for a
// .c file (e.g. toggling off -g1) leaves the old bindings armed and the UI shows
// verified breakpoints that can never fire. VS Code does not re-send
// setBreakpoints on a fresh F5 launch for unchanged breakpoints, so the DA must
// self-heal here. Mirrors rearmModuleBreakpoints' locking/event shape but, rather
// than reusing frozen b.addr, calls addrForLine again. Called after loadSymbols
// in both launch and restart. (Idempotent: re-resolving a still-valid bp against
// the same symbols yields the same address.)
async function revalidateBreakpointsAfterSymbolLoad() {
    return withBpLock(async () => {
        for (const [, arr] of srcBps) {
            for (const bp of arr) {
                const srcPath = (bp.source && bp.source.path) ? bp.source.path : '';
                const norm = canonPath(srcPath);
                const owners = fileToModules.get(norm) || ['R'];

                // Re-resolve each owning module against the new symbols.
                const newBindings = [];
                for (const mod of owners) {
                    const snap = resolverInstance ? resolverInstance.addrForLine(srcPath, bp.line, mod) : null;
                    if (snap) {
                        newBindings.push({ addr: snap.addr, module: mod, armed: false });
                    }
                }

                // Disarm any old binding whose address is no longer present (the
                // symbol mapping changed or vanished). armAddr is ref-counted, so
                // addresses that survive (re-resolved identically) are unaffected.
                const liveAddrs = new Set(newBindings.map(b => b.addr));
                for (const b of bp.bindings) {
                    if (b.armed && !liveAddrs.has(b.addr)) { await disarmAddr(b.addr); b.armed = false; }
                }

                if (!newBindings.length) {
                    // No longer binds — report unverified with the actionable message.
                    bp.bindings = [];
                    evt('breakpoint', { reason: 'changed', breakpoint:
                        { id: bp.id, verified: false, line: bp.line, source: bp.source,
                          message: unboundBpMessage(srcPath, norm) } });
                    continue;
                }

                // Bindings resolved. CARRY OVER the armed state for any address that survived:
                // armAddr is REF-COUNTED, so arming an already-armed address again pushes its
                // count to 2 for ONE logical breakpoint — and then a single disarm (a user/agent
                // clearing it) only drops it to 1, leaving the Z0 live in the emulator. That is a
                // "cleared" breakpoint that still fires, and it re-registers on the next hit.
                // (The old code discarded the armed flags with the old binding objects and re-armed
                // unconditionally, which is precisely how the count drifted.)
                for (const nb of newBindings) {
                    const old = bp.bindings.find(b => b.addr === nb.addr && b.module === nb.module);
                    if (old && old.armed) nb.armed = true;
                }
                bp.bindings = newBindings;
                let anyArmed = false;
                for (const b of bp.bindings) {
                    const desired = (b.module === 'R' || b.module === activeModuleId);
                    if (desired) {
                        if (!b.armed) {
                            b.armed = await armAddr(b.addr);
                            if (b.armed) await sendCond(b.addr, bp.condExpr, bp.hitTarget);
                        }
                        if (b.armed) anyArmed = true;
                    } else if (b.armed) {
                        await disarmAddr(b.addr);   // module no longer active → release the ref
                        b.armed = false;
                    }
                }
                const dispBind = bp.bindings.find(b => b.module === 'R' || b.module === activeModuleId) || bp.bindings[0];
                const hex = '$' + (dispBind.addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
                const lbl = labelFor(dispBind.addr);
                const where = (lbl === hex ? hex : lbl + ' (' + hex + ')');
                evt('breakpoint', { reason: 'changed', breakpoint:
                    { id: bp.id, verified: anyArmed, line: bp.line, source: bp.source, message: where } });
            }
        }
    });
}

function loadSymbols(file) {
    symbols.clear(); addrSym.clear(); addrSource.clear(); symSource.clear();
    lineTable = []; zpSymbols = [];
    filesWithLines = new Set();
    warnedNoCLineInfo = new Set();   // new symbol load → re-allow the -g1 warning per file
    warnedMismatchPCs = new Set();   // and re-allow the symbol/binary mismatch warning
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
                    const fpath = fileIndex[fi] || ('file#' + fi);
                    cur.lineTable.push({
                        addr: parseInt(lm[1], 16),
                        file: fpath,
                        line: parseInt(lm[3], 10)
                    });
                    filesWithLines.add(canonPath(fpath));
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
                        setSymSource(cur.symSource, n, src);
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
        // Split line entries by source language: .c entries only exist when the
        // project was compiled with -g1; if that count is 0, C-source breakpoints
        // can't bind (the file has no line info). Surfacing the split here makes a
        // missing -g1 visible at load time, before any breakpoint is set.
        let cLines = 0;
        for (const e of lineTable) if (/\.c$/i.test(e.file)) cLines++;
        const nonCLines = lineTable.length - cLines;
        // lineTable is the COMPOSED view (resident + active module only). In a multi-module
        // overlay project the C files usually live in the overlays, so "0 .c here" is normal
        // while no overlay is active — blaming -g1 then is plain wrong (it sent a dogfooding
        // session hunting a non-existent build problem). Only suggest -g1 when NO module has
        // any .c line entry; otherwise say where the C lines actually are.
        let cLinesAnywhere = 0;
        const cModules = [];
        for (const [mid, b] of moduleBuckets) {
            let n = 0;
            for (const e of b.lineTable) if (/\.c$/i.test(e.file)) n++;
            if (n > 0) { cLinesAnywhere += n; cModules.push((mid === 'R' ? 'resident' : (moduleNames.get(mid) || mid)) + ':' + n); }
        }
        const lineNote = cLines > 0
            ? (lineTable.length + ' line entries')
            : (cLinesAnywhere > 0
                ? (lineTable.length + ' line entries in the active view (all assembly); ' + cLinesAnywhere +
                   ' C line entries exist in other modules [' + cModules.join(', ') + '] — C breakpoints bind once that module is resident')
                : (lineTable.length + ' line entries (0 from .c anywhere — rebuild with -g1 to enable C breakpoints; ' + nonCLines + ' from assembly)'));
        log('Loaded ' + symbols.size + ' symbols, ' + lineNote + ', ' +
            typeDefs.size + ' types, ' + varTypes.size + ' typed vars, ' +
            localDefs.size + ' funcs with locals, ' +
            annBySymbol.size + ' annot-symbols, ' + annByField.size + ' annot-fields from ' + file + modNote);
    } catch (e) {
        log('Could not load symbols: ' + e.message);
    }
}

// Source-file extensions we scan for symbol definitions (workspace + OSDK lib).
const SOURCE_EXT_RE = /\.(s|asm|inc|h)$/i;
// Recursively add every source file under `dir` to `set`. Best-effort: a missing or
// unreadable directory is logged at verbose level, not silently swallowed.
function scanSourcesInto(dir, set) {
    if (!dir) return;
    try {
        for (const f of readdirRecursive(dir)) if (SOURCE_EXT_RE.test(f)) set.add(f);
    } catch (e) {
        logVerbose('source scan skipped for ' + dir + ': ' + e.message);
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
    scanSourcesInto(config.sourceRoot || config.workspaceFolder, filesToScan);

    // OSDK library: derive from emulator path (e.g. .../Oricutron/Oricutron.exe → .../lib/)
    if (config.emulatorPath) {
        const osdkRoot = path.dirname(path.dirname(config.emulatorPath));
        scanSourcesInto(path.join(osdkRoot, 'lib'), filesToScan);
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
            setSymSource(symSource, sym, src);
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
    if (typeof payload !== 'string' || payload.length < 3) return r;  // dropped connection → null reply; caller sees empty regs, not a crash
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

// Read Oricutron's extra CPU/machine state via the qOricCpuExtra query. The reply
// is  L:<lastpc 2B>;C:<cycles 4B>;F:<frames 4B>;R:<raster 2B>;N:..;T:..;I:..  with
// every value little-endian, 2 hex chars/byte. C: is the 32-bit ABSOLUTE, monotonic
// cpu.cycles counter (NOT a delta); F: is the 32-bit video-frame counter. Returns
// { cycles, frames } or null (old stub with no qOricCpuExtra, or an error reply) so
// callers degrade to "no annotation" rather than crashing. See DESIGN-cycle-counting.md.
async function readCpuExtra() {
    let r;
    try { r = await gdbCmd('qOricCpuExtra'); } catch (e) { return null; }
    if (!r || r.indexOf('C:') < 0) return null;
    const out = {};
    for (const part of r.split(';')) {
        const c = part.indexOf(':');
        if (c < 0) continue;
        const tag = part.substring(0, c), hex = part.substring(c + 1);
        if (tag !== 'C' && tag !== 'F') continue;
        let v = 0;
        // little-endian; multiply (not <<) so the top byte can't go negative past bit 31
        for (let i = 0; i + 1 < hex.length; i += 2) v += parseInt(hex.substr(i, 2), 16) * Math.pow(256, i / 2);
        if (tag === 'C') out.cycles = v >>> 0; else out.frames = v >>> 0;
    }
    return (out.cycles !== undefined) ? out : null;
}

// Capture the absolute cycle/frame counters + PC while stopped, just before a step
// resumes. Called at the top of the step-over / step-out handlers so the annotation
// works regardless of which resume command follows. Clears the snapshot if the stub
// can't answer qOricCpuExtra (→ the stop handler skips the annotation).
async function snapshotStepStart(preferDest) {
    const pcNow = regs ? regs.pc : null;
    const ex = await readCpuExtra();
    if (ex) { stepStartPc = pcNow; stepCyclesBefore = ex.cycles; stepPreferDest = !!preferDest; }
    else    { stepStartPc = null;  stepCyclesBefore = null; stepPreferDest = false; }
}

// ----------------------------------------------------------------
// Register type tags — "close the type-matching loop when tracing asm"
// (user feature 2026-07-15). A/X/Y can carry an enum tag so the Registers
// view, watches and console decode them (A=$04 → e_LOC_MAINSTREET). Tags are
// inferred while single-stepping and propagate through transfers:
//   - LDA/LDX/LDY from a symbol the registry can decode → dest inherits it;
//     a line annotation (`lda (ptr),y  ; @enum location_id`) wins over
//     inference and covers indirect/indexed fetches.
//   - TAX/TAY/TXA/TYA copy the tag between registers.
//   - A load with no known type, PLA, or a value-transforming op on A
//     (ADC/SBC/AND/ORA/EOR, accumulator shifts) CLEARS the tag (user rule:
//     flush when the value changed without an annotation). INC/DEC-style
//     register bumps KEEP it — iterating over ids is the common idiom.
//   - Free-running (continue / step-out / stepping over a JSR) clears all:
//     the executed path is unknown.
// `tag a location_id` / `untag a` manage tags by hand from the console.
// ----------------------------------------------------------------
let regTags = { a: null, x: null, y: null };  // reg -> { enumName, source } | null
let lastStopPc = -1;        // pc of the previous stop = the instruction a single step executed
let lastResumeKind = null;  // 's' | 'N' | 'c' | 'O' — stamped by gdbWrite, read per stop

function clearRegTags() { regTags.a = regTags.x = regTags.y = null; }

// Decoded display for a tagged register's current value, or null.
function regTagStr(reg) {
    const tag = regTags[reg];
    if (!tag || !regs) return null;
    const v = regs[reg] || 0;
    const def = resolveEnum(tag.enumName, v & 0xFF);
    if (!def) return null; // enum not in the active view anymore
    return formatEnum(def, [v & 0xFF], 0, 1) + '  ' + tag.enumName;
}

// For a struct accessed as (ptr),y: which field does the Y offset land in, and
// — when that field is an array — which element? Returns { field, base,
// isArray, elemSize, index, within } or null. THE one place that maps a Y
// offset to a struct field/element, shared by the disassembly annotation and
// the register-tag inference so the two always agree (DRY). `base` is the
// element/scalar type (array brackets stripped); `within` is the byte offset
// into the field; `index` is the array element index.
function fieldAtOffset(structName, y) {
    if (!structName || !typeDefs.has(structName)) return null;
    const f = typeDefs.get(structName).fields.find(f2 => y >= f2.offset && y < f2.offset + f2.size);
    if (!f) return null;
    const am = f.type.match(/^(.+)\[(\d+)\]$/);
    const count = am ? parseInt(am[2], 10) : 1;
    const elemSize = am ? (Math.floor(f.size / count) || 1) : f.size;
    const within = y - f.offset;
    return { field: f, base: am ? am[1] : f.type, isArray: !!am, elemSize, within,
             index: elemSize > 0 ? Math.floor(within / elemSize) : 0 };
}

// Which local/parameter of `func` a (fp),y / (ap),y access lands in: the C frame
// pointer holds the frame base, so Y IS the frame offset. `basePtr` is 'fp' or
// 'ap'. Mirrors fieldAtOffset but for a stack frame — returns { local, within,
// isArray, base (element/scalar type), elemSize, index } or null.
function localAtFrameOffset(func, basePtr, off) {
    const locals = func ? localDefs.get(func) : null;
    if (!locals) return null;
    const l = locals.find(x => x.base === basePtr && off >= x.offset && off < x.offset + x.size);
    if (!l) return null;
    const am = l.type.match(/^(.+)\[(\d+)\]$/);
    const count = am ? parseInt(am[2], 10) : 1;
    const elemSize = am ? (Math.floor(l.size / count) || 1) : l.size;
    const within = off - l.offset;
    return { local: l, within, isArray: !!am, base: am ? am[1] : l.type,
             elemSize, index: elemSize > 0 ? Math.floor(within / elemSize) : 0 };
}

// The `@enum <E>` type named on the source CODE LINE at `pc`, or null. Explicit
// intent for the value an instruction fetches (covers indexed/indirect reads the
// operand's own type can't cover). One place, so the register tag and the inline
// annotation read the same line annotation. Read live via getSourceLine (whose
// cache reparse clears), so edits go live on save.
function lineEnumOf(pc) {
    const s = sourceFor(pc);
    const text = s ? getSourceLine(s.file, s.line) : null;
    const lm = text && text.match(/@enum\b\s*([\w|]+)?/);
    return (lm && lm[1] && resolveEnum(lm[1])) ? lm[1] : null;
}

// The type directives on the source CODE LINE at `pc`, for the inline annotation.
// A line may carry several, combined in one annotation:
//   @enum <E>   the fetched byte decoded as enum <E>
//   @word       the 16-bit LE word at the read address, + the symbol it targets
//   @stream <E> that word treated as a stream pointer -> first command
// e.g. "; @word @stream script_command" shows "$7875 →end_girl_following = COMMAND_END".
// Read live via getSourceLine (cache cleared by reparse). Only @enum can tag a
// register (a byte); @word/@stream are 16-bit reads for the annotation only.
function lineDirectivesOf(pc) {
    const s = sourceFor(pc);
    const text = s ? getSourceLine(s.file, s.line) : null;
    if (!text) return [];
    const dirs = [];
    let m = text.match(/@enum\b\s*([\w|]+)?/);
    if (m && m[1] && resolveEnum(m[1])) dirs.push({ kind: 'enum', enumName: m[1] });
    m = text.match(/@stream\b\s*([\w|]+)?/);
    if (m && m[1] && resolveEnum(m[1])) dirs.push({ kind: 'stream', enumName: m[1] });
    if (/@word\b/.test(text)) dirs.push({ kind: 'word' });
    return dirs;
}

// Reverse lookup: the enum type that declares a member NAME (first match), or
// null. Enums are stored value->name, so we scan. Used to tag a register loaded
// with an enum constant as an immediate (lda #FLAG_END_STREAM): the disassembly
// only sees the literal value, so the name comes from the SOURCE operand token.
function enumOfMember(name) {
    for (const src of [enumDefs, allEnumDefs]) {
        for (const [ename, def] of src) {
            if (!def.byValue) continue;
            for (const mname of def.byValue.values()) {
                if (mname === name) return ename;
            }
        }
    }
    return null;
}

// Reverse lookup: the numeric value of an enum MEMBER name (first match), or
// undefined. Lets a condition compare against an enum constant (KIND_DRAGON).
function enumMemberValue(name) {
    for (const src of [enumDefs, allEnumDefs]) {
        for (const [, def] of src) {
            if (!def.byValue) continue;
            for (const [val, mname] of def.byValue) if (mname === name) return val;
        }
    }
    return undefined;
}

// The enum a NAMED immediate operand belongs to (lda #FLAG_END_STREAM), read
// from the SOURCE token at pc, or null. The disassembly only sees the literal
// byte, so the type comes from the token. Shared by the register tagger and the
// instruction annotation so both decode the immediate identically (DRY).
function immediateTokenEnum(pc) {
    const s = sourceFor(pc);
    const text = s ? getSourceLine(s.file, s.line) : null;
    const mo = text && text.match(/#\s*([A-Za-z_]\w*)/);
    if (!mo) return null;
    const en = enumOfMember(mo[1]);
    return en ? { enumName: en, member: mo[1] } : null;
}

// The enum tag a load instruction confers, or null. Line annotation first
// (explicit intent, covers indirect fetches like the byte-stream readers),
// else a named immediate's enum, else registry inference from a direct-address
// operand's symbol.
function tagForLoad(prevPc, mode, lo, hi) {
    const le = lineEnumOf(prevPc);
    if (le) return { enumName: le, source: 'line' };
    if (mode === '#') {
        const t = immediateTokenEnum(prevPc);
        return t ? { enumName: t.enumName, source: t.member } : null;
    }
    let operand = -1;
    if (mode === 'z') operand = lo;
    else if (mode === 'a') operand = (hi << 8) | lo;
    if (operand >= 0) {
        const name = symbolAt(operand);
        if (name) {
            const spec = renderSpec(name);
            if (spec.ann && spec.ann.kind === 'enum' && resolveEnum(spec.ann.enumName))
                return { enumName: spec.ann.enumName, source: name };
            if (spec.type && resolveEnum(spec.type))
                return { enumName: spec.type, source: name };
        }
    }
    // (ptr),y through a @ptr16 <struct> pointer: the FIELD at the Y offset
    // gives the type — lda (_gStreamItemPtr),y with Y=+4 tags A item_flags, and
    // an array field like directions[6] tags A with the ELEMENT type
    // (location_id). Y is unchanged by the load itself, so the current value
    // is the one used.
    if (mode === ')' && regs) {
        const pname = symbolAt(lo);
        const pann = pname ? annForSymbol(pname) : null;
        // @stream pointer read at Y=0 = the OPCODE byte (the pointer points at the
        // current command) → tag the register with the stream's command enum.
        // Param bytes are read at Y>=1 (or via other pointers), so they don't tag.
        if (pann && pann.kind === 'stream' && regs.y === 0 && resolveEnum(pann.enumName))
            return { enumName: pann.enumName, source: pname + '→opcode' };
        if (pann && pann.kind === 'ptr16' && pann.enumName) {
            const info = fieldAtOffset(pann.enumName, regs.y);
            if (info && info.elemSize === 1 && resolveEnum(info.base))
                return { enumName: info.base, source: pname + '→' + info.field.name + (info.isArray ? '[' + info.index + ']' : '') };
        }
    }
    return null;
}

// Run once per hardware stop: decode the instruction the previous resume
// executed and update the tags. Only a single-step ('s', or 'N' on a non-JSR)
// gives path knowledge; anything else clears. Takes SNAPSHOTTED (kind, prevPc)
// — onStopReply captures them synchronously and updates lastStopPc BEFORE this
// suspends on the memory read, so a second stop arriving mid-decode (async
// re-entry) still sees coherent state; the serialized gdb queue keeps the
// decode applications in stop order.
async function applyRegTagTracking(kind, prevPc) {
    if (!kind) return;                                     // PC edits (goto/skip) don't touch registers
    if (kind === 'c' || kind === 'O') { clearRegTags(); return; }
    if (prevPc < 0) return;
    const bytes = await readMem(prevPc, 3);
    const entry = OPS[bytes[0]];
    if (!entry) { clearRegTags(); return; }
    const mne = entry.substring(0, 3), mode = entry[3];
    if (kind === 'N' && mne === 'JSR') { clearRegTags(); return; } // stepped over a call: path unknown
    switch (mne) {
        case 'LDA': regTags.a = tagForLoad(prevPc, mode, bytes[1], bytes[2]); break;
        case 'LDX': regTags.x = tagForLoad(prevPc, mode, bytes[1], bytes[2]); break;
        case 'LDY': regTags.y = tagForLoad(prevPc, mode, bytes[1], bytes[2]); break;
        case 'TAX': regTags.x = regTags.a; break;
        case 'TAY': regTags.y = regTags.a; break;
        case 'TXA': regTags.a = regTags.x; break;
        case 'TYA': regTags.a = regTags.y; break;
        case 'TSX': regTags.x = null; break;
        case 'PLA': regTags.a = null; break;               // no shadow stack (yet)
        case 'ADC': case 'SBC': case 'AND': case 'ORA': case 'EOR':
            regTags.a = null; break;                       // value transformed
        case 'ASL': case 'LSR': case 'ROL': case 'ROR':
            if (mode === 'A') regTags.a = null; break;     // accumulator shift
        // INX/DEX/INY/DEY deliberately KEEP tags (id iteration); everything
        // else leaves registers untouched.
    }
}

// ----------------------------------------------------------------
// Asynchronous stop-reply handler
// ----------------------------------------------------------------

// Evaluate one logpoint sub-expression to a compact display string. Covers the
// common cases — a register (decoded via its tag), a symbol (fully typed via the
// one render path), or a $hex address (the byte there). Unknown -> "?".
async function evalLogExpr(expr) {
    expr = expr.trim();
    if (!expr) return '';
    const rm = expr.match(/^(a|x|y|sp|pc)$/i);
    if (rm && regs) {
        const rn = rm[1].toLowerCase();
        if (rn === 'sp' || rn === 'pc') return '$' + ((regs[rn] || 0) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
        return regTagStr(rn) || formatScalar('uchar', [regs[rn] || 0], 0, 1);
    }
    // Bare global symbol: keep the annotation-aware render (@bcd/@ptr16/@bool…).
    if (/^[A-Za-z_]\w*$/.test(expr)) {
        let addr = symbols.get(expr);
        if (addr === undefined && !expr.startsWith('_')) addr = symbols.get('_' + expr);
        if (addr !== undefined) {
            const spec = renderSpec(expr);
            const v = await buildTypedVar(expr, addr & 0xFFFF, spec.type, spec.size, spec.ann, { omitAddr: true });
            return v.value;
        }
    }
    // C variable access — locals, members, subscripts, enum-decoded — through the
    // SAME evaluator as Watch, so {g_entities[i].hp} in a log message reads exactly
    // like the watched expression instead of "?".
    if (regs && /^[A-Za-z_]/.test(expr)) {
        try {
            const func = currentFunction(regs.pc);
            const locals = func ? localDefs.get(func) : null;
            const fpA = symbols.get('fp'), apA = symbols.get('ap');
            let fpVal = 0, apVal = 0;
            if (typeof fpA === 'number') { const mm = await readMem(fpA, 2); fpVal = (mm[0] || 0) | ((mm[1] || 0) << 8); }
            if (typeof apA === 'number') { const mm = await readMem(apA, 2); apVal = (mm[0] || 0) | ((mm[1] || 0) << 8); }
            const lv = await evalAccess(expr, locals, fpVal, apVal);
            if (lv) { const v = await buildTypedVar(expr, lv.addr, lv.type, lv.size, undefined, { omitAddr: true }); return v.value; }
        } catch (e) { return '[' + (e && e.message ? e.message : 'err') + ']'; }
    }
    const hm = expr.match(/^\$([0-9a-fA-F]{1,4})$/);
    if (hm) { const b = await readMem(parseInt(hm[1], 16), 1); return '$' + (b[0] || 0).toString(16).toUpperCase().padStart(2, '0'); }
    return '?';
}

// Interpolate a VS Code logpoint message: literal text with {expr} placeholders.
// {{ and }} are literal braces (DAP convention).
async function interpolateLog(msg) {
    let out = '', i = 0;
    while (i < msg.length) {
        const c = msg[i];
        if (c === '{' && msg[i + 1] === '{') { out += '{'; i += 2; continue; }
        if (c === '}' && msg[i + 1] === '}') { out += '}'; i += 2; continue; }
        if (c === '{') {
            const end = msg.indexOf('}', i + 1);
            if (end < 0) { out += msg.slice(i); break; }
            out += await evalLogExpr(msg.slice(i + 1, end));
            i = end + 1;
            continue;
        }
        out += c; i++;
    }
    return out;
}

// Source breakpoints (logpoints) armed at `pc` that carry a logMessage.
function logpointsAt(pc) {
    const out = [];
    for (const [, arr] of srcBps)
        for (const bp of arr)
            if (bp.logMessage && bp.bindings.some(b => b.addr === pc && b.armed)) out.push(bp);
    return out;
}

// Is there a NON-logpoint (stopping) breakpoint at `pc`? A logpoint auto-resumes
// only when nothing here would otherwise stop.
function stoppingBpAt(pc) {
    for (const [, b] of bps)  if (b.addr === pc) return true;
    for (const [, b] of ibps) if (b.addr === pc) return true;
    if (addrBps.has(pc) && addrBps.get(pc).enabled) return true;
    for (const [, arr] of srcBps)
        for (const bp of arr)
            if (!bp.logMessage && bp.bindings.some(b => b.addr === pc && b.armed)) return true;
    return false;
}

async function onStopReply(payload) {
    running = false;
    stoppedOnWatch = false;   // re-evaluated below; set true only if a watch causes this stop
    regs = parseStopRegs(payload);
    // Register tag tracking — BEFORE any early return so internal step loops
    // (source-level step-into, module-watch commits) keep the chain coherent.
    // Snapshot + advance lastStopPc SYNCHRONOUSLY, then decode: onStopReply can
    // re-enter while the decode awaits its memory read.
    {
        const tagKind = lastResumeKind;
        lastResumeKind = null;
        const tagPrevPc = lastStopPc;
        if (regs && regs.pc !== undefined) lastStopPc = regs.pc;
        await applyRegTagTracking(tagKind, tagPrevPc);
    }
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
        // Program is loaded and sitting at the entry (bootstrap bp just dropped, user
        // breakpoints armed): the ideal baseline for an instant Restart.
        await captureBaseline();
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

    // Source-level Step Over (F10) loop: keep single-stepping (JSRs stepped over above)
    // until we land on a different source line at the SAME call depth, or we return from
    // the function we started in. sp > start = returned; sp < start = inside a call we
    // haven't returned from yet (don't stop there). Runs AFTER the temp-BP cleanup so a
    // JSR step-over's return BP is released before the next move.
    if (stepOverInProgress) {
        const here = regs ? sourceFor(regs.pc) : null;
        const sp = (regs && regs.sp !== undefined) ? regs.sp : -1;
        const returned = stepOverStartSp >= 0 && sp >= 0 && sp > stepOverStartSp;
        const sameDepth = stepOverStartSp < 0 || sp < 0 || sp === stepOverStartSp;
        const arrived = sameDepth && here && here.file === stepOverStartFile && here.line !== stepOverStartLine;
        if (!returned && !arrived && stepOverBudget-- > 0) {
            await stepOverMove();
            return;
        }
        stepOverInProgress = false;
        // fall through to the normal stop (cycle annotation + stopped event)
    }

    // Cycle-count annotation. Prefer the qOricCpuExtra before/after delta captured
    // around the step (see readCpuExtra + the next/stepOut snapshots): it works on
    // EVERY step path and is attributed to stepStartPc — the line the user stepped
    // over — with no pc-3 JSR guess. Fall back to the stub's OricCycles: field
    // (step-over 'N' only, attributed to pc-3) when no snapshot is available, e.g.
    // an old stub without qOricCpuExtra.
    lastCycleAnnotation = null;
    if (stepCyclesBefore !== null) {
        const after = await readCpuExtra();
        const delta = after ? ((after.cycles - stepCyclesBefore) >>> 0)
                            : (cyclesDelta !== null ? cyclesDelta : null);
        // Attribute to the destination we landed on for run-type resumes (where the
        // user is looking) when it resolves to source; else the start line (always
        // resolvable). Steps use the start line (the line executed).
        let attribPc = stepStartPc;
        if (stepPreferDest && regs && regs.pc !== undefined && sourceFor(regs.pc)) attribPc = regs.pc & 0xFFFF;
        const src = (delta !== null && attribPc !== null) ? sourceFor(attribPc) : null;
        if (delta !== null && src) {
            lastCycleAnnotation = {
                pc: attribPc,
                cycles: delta,
                symbol: symbolAt(attribPc),
                file: src.file,
                line: src.line
            };
        }
        stepCyclesBefore = null; stepStartPc = null; stepPreferDest = false;
    } else if (cyclesDelta !== null && regs && regs.pc !== undefined) {
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

    // Stopgap: warn if the loaded code at the PC doesn't match the symbols (multi-
    // overlay / link-layout mismatch). Runs after module resolution so it judges
    // against the active module's symbols.
    await checkSymbolBinaryMismatch();

    // Sync any by-hand monitor breakpoint edits into VS Code's model.
    await reconcileMonitorBreakpoints();

    // Watchpoint events: an access-triggered breakpoint with the same actions as an
    // exec logpoint. Identify the fired event by address+type; run its log / [save] /
    // [stop] actions; a watch with no message (or with [stop]) stops, otherwise it logs
    // and resumes transparently (step off — commits the store for a write watch — then
    // continue), exactly like a logpoint.
    if (watchAddr !== null) {
        const evs = watchEventsAt(watchAddr, watchType);
        if (evs.length) {
            let forceStop = false;
            for (const ev of evs) {
                if (!ev.logMessage) { forceStop = true; continue; }   // plain stop watch
                let raw = ev.logMessage;
                if (/\[stop\]/i.test(raw)) { forceStop = true; raw = raw.replace(/\s*\[stop\]\s*/ig, ' ').trim(); }
                const doSnap = /\[save\]/i.test(raw);
                if (doSnap) raw = raw.replace(/\s*\[save\]\s*/ig, ' ').trim();
                let sig = null;
                const sm = raw.match(/\[signal:([^\]]+)\]/i);       // [signal:<id>] — fire a named event a script can await
                if (sm) { sig = sm[1].trim(); raw = raw.replace(/\s*\[signal:[^\]]+\]\s*/ig, ' ').trim(); }
                let line;
                try { line = await interpolateLog(raw); }
                catch (e) { line = '[watch log error: ' + (e && e.message ? e.message : e) + ']'; }
                const tag = watchType === 'read' ? 'R' : watchType === 'access' ? 'RW' : 'W';
                evt('output', { category: 'console', output: '\x1b[36m[' + tag + ' $' + (ev.addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0') + '] ' + line + '\x1b[0m\n' });
                if (doSnap) {
                    const nm = 'watch-' + (ev.addr & 0xFFFF).toString(16).padStart(4, '0');
                    const sv = await doSaveSnapshot(nm);
                    evt('output', { category: 'console', output: '\x1b[36m' + (sv.error ? '[save failed: ' + sv.error + ']' : '[snapshot saved: ' + sv.name + ']') + '\x1b[0m\n' });
                }
                if (sig) evt('oricSignal', { id: sig, addr: ev.addr & 0xFFFF, pc: regs ? regs.pc : undefined });
            }
            if (!forceStop) {
                resumeMode = 'run';
                continueAfterStep = true;   // step off (commits a write watch), onStopReply then issues 'c'
                running = true;
                regs = null;
                gdbWrite('s');
                return;                     // logged and resumed — no 'stopped' event
            }
        }
        // Reached here with a watch address = the watch is STOPPING (plain stop watch, a
        // [stop] tag, or a plain data breakpoint with no event). Mark it so `continue`
        // steps off the accessing instruction first — otherwise a bare 'c' re-fires on the
        // same access and F5 appears stuck on the current instruction.
        stoppedOnWatch = true;
    }

    // Logpoints: a source breakpoint with a logMessage prints instead of stopping.
    // Print every logpoint at this PC; if nothing else here would stop, resume
    // transparently (step off the bp first, then continue — same as `continue`).
    // A message containing "[stop]" logs AND stops (VS Code allows only a
    // logpoint OR a plain bp per line — this is how to get both at once); "[save]"
    // also snapshots the machine on hit. Logpoint output is cyan (ANSI) so it
    // stands out from the emulator's own stdout in the Debug Console.
    if (watchAddr === null && regs && regs.pc !== undefined) {
        const logs = logpointsAt(regs.pc);
        if (logs.length) {
            let forceStop = false;
            for (const bp of logs) {
                let raw = bp.logMessage;
                if (/\[stop\]/i.test(raw)) { forceStop = true; raw = raw.replace(/\s*\[stop\]\s*/ig, ' ').trim(); }
                const doSnap = /\[save\]/i.test(raw);
                if (doSnap) raw = raw.replace(/\s*\[save\]\s*/ig, ' ').trim();
                let sig = null;
                const sm = raw.match(/\[signal:([^\]]+)\]/i);       // [signal:<id>] — fire a named event a script can await
                if (sm) { sig = sm[1].trim(); raw = raw.replace(/\s*\[signal:[^\]]+\]\s*/ig, ' ').trim(); }
                let line;
                try { line = await interpolateLog(raw); }
                catch (e) { line = '[logpoint error: ' + (e && e.message ? e.message : e) + ']'; }
                evt('output', { category: 'console', output: '\x1b[36m' + line + '\x1b[0m\n' });
                if (sig) evt('oricSignal', { id: sig, pc: regs.pc });
                if (doSnap) {
                    // Self-describing name: <file>-<func>-L<line>, so it's findable
                    // later (line alone isn't enough). NO sequence — a [save] point
                    // OVERWRITES its own snapshot each hit (you want the latest state
                    // at that point, not a pile of per-iteration files). Snapshot a
                    // specific iteration with a conditional logpoint instead.
                    const fileBase = (bp.source && (bp.source.name || (bp.source.path ? path.basename(bp.source.path) : ''))) || '';
                    const fnRaw = currentFunction(regs.pc);
                    const fn = fnRaw ? fnRaw.replace(/^_+/, '') : '';
                    const nm = [fileBase, fn, bp.line ? 'L' + bp.line : ''].filter(Boolean).join('-') || 'auto';
                    const sv = await doSaveSnapshot(nm);
                    evt('output', { category: 'console', output: '\x1b[36m' + (sv.error ? '[save failed: ' + sv.error + ']' : '[snapshot saved: ' + sv.name + ']') + '\x1b[0m\n' });
                }
            }
            if (!forceStop && !stoppingBpAt(regs.pc)) {
                resumeMode = 'run';
                continueAfterStep = true;   // step past the bp; onStopReply then issues 'c'
                running = true;
                regs = null;
                gdbWrite('s');
                return;                     // no 'stopped' event — logpoints don't stop
            }
        }
    }

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

    // A stub bp we didn't arm was set by hand in the monitor. If it maps to a source
    // line, promote it to a VS Code SourceBreakpoint; otherwise (ROM / no source) adopt
    // it as an adapter-owned ADDRESS breakpoint (VS Code can't show it as anything else).
    const added = [];       // source-backed → VS Code SourceBreakpoints
    let addrChanged = false;
    for (const a of stubAddrs) {
        if (armedAddrs.has(a)) continue;          // already ours (source, function, or address bp)
        const s = sourceFor(a);
        if (s) added.push({ address: a, file: s.file, line: s.line });
        else { await armAddr(a); addrBps.set(a, { addr: a }); addrChanged = true; }
    }
    // An address we armed that the stub no longer has was cleared in the monitor.
    const removed = [];
    for (const a of [...armedAddrs.keys()]) {
        if (stubAddrs.has(a)) continue;
        if (addrBps.has(a)) { await disarmAddr(a); addrBps.delete(a); addrChanged = true; }
        else { const s = sourceFor(a); removed.push(s ? { address: a, file: s.file, line: s.line } : { address: a }); }
    }

    if (added.length || removed.length) evt('oricMonitorBreakpoints', { added, removed });
    if (addrChanged) fireAddrBps();   // refresh the Address panel + disasm dots
}

// While the session is STOPPED, the adapter is otherwise idle, so a breakpoint set
// by hand in Oricutron's monitor (bs/bc) wouldn't reach VS Code until the next stop.
// A light poll reconciles it within a second or two. It runs only while stopped
// (never adds traffic during free-run), skips overlapping runs, and is a no-op when
// the breakpoint set hasn't changed (reconcileMonitorBreakpoints emits nothing).
function startMonitorBpPoll() {
    if (bpPollTimer) return;
    bpPollTimer = setInterval(async () => {
        if (running || bpPollBusy || disconnecting || !sock) return;
        bpPollBusy = true;
        try { await reconcileMonitorBreakpoints(); }
        catch (_) { /* transient (socket blip) — ignore, next tick retries */ }
        finally { bpPollBusy = false; }
    }, 1500);
    if (bpPollTimer.unref) bpPollTimer.unref();   // don't keep the process alive on its own
}
function stopMonitorBpPoll() {
    if (bpPollTimer) { clearInterval(bpPollTimer); bpPollTimer = null; }
}

// After loading a snapshot the emulator's exec-breakpoint table is whatever the
// snapshot captured (snapshot.c saves cpu.breakpoints) — which may not match the
// debugger's current set. Bring the emulator back in line with armedAddrs so a
// later reconcileMonitorBreakpoints doesn't see a phantom delta and mutate VS
// Code's breakpoints, and so no breakpoint is silently missing from the machine.
async function resyncStubBreakpoints() {
    const reply = await gdbCmd('qOricBreakpoints');
    if (typeof reply !== 'string' || !reply.startsWith('bp:')) return;
    const stub = new Set();
    for (const tok of reply.slice(3).split(',')) { const a = parseInt(tok, 16); if (!isNaN(a)) stub.add(a & 0xffff); }
    for (const a of stub) if (!armedAddrs.has(a)) await gdbCmd('z0,' + a.toString(16) + ',1');       // drop stale (snapshot) bp
    for (const a of armedAddrs.keys()) if (!stub.has(a)) await gdbCmd('Z0,' + a.toString(16) + ',1'); // re-arm a bp the snapshot lacked
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
    // Resolve an address to a symbol name (build symbol, then exact ROM symbol),
    // or fall back to hex — so e.g. `JMP $F77C` renders as `JMP Char2Scr`.
    const s = (addr, w) => symbolAt(addr) || romExactName(addr) || ('$' + (w === 2 ? h2(addr) : h4(addr)));
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

// Valid 6502 mnemonics (from the OPS table above) — used to find the instruction
// mnemonic at the start of an assembly source line.
const MNEMONICS = new Set(OPS.filter(Boolean).map(s => s.substring(0, 3)));

// Pull the instruction mnemonic from an assembly source line, or null if the line
// isn't a plain instruction (label-only, directive, scope, macro, comment). Scans
// tokens and returns the first real 6502 mnemonic: "label lda #0"->LDA, "delete_word"
// ->null, ".byt 0"->null, "SET_SKIP_POINT(0)"->null. Conservative: null = don't judge.
function leadingMnemonic(lineText) {
    const t = String(lineText).split(';')[0].replace(/\t/g, ' ').trim();
    if (!t) return null;
    for (const tok of t.split(/[\s(]+/)) {
        if (!tok) continue;
        const u = tok.toUpperCase();
        if (MNEMONICS.has(u)) return u;
        if (tok[0] === '.' || tok[0] === '*' || tok[0] === '#') return null;  // directive/origin/immediate → not an instruction leader
    }
    return null;
}

// Stopgap for the multi-overlay / link-layout mismatch class (see the Encounter
// input_utils-vs-bytestream overlap): if the live opcode at the stopped PC doesn't
// match the instruction the mapped .s source line implies, the symbols don't
// describe the loaded binary here — warn once (per PC) so wrong labels/lines don't
// silently mislead. Assembly source only (C lines aren't 6502 mnemonics); any doubt
// (illegal opcode, non-instruction line, unreadable memory) skips silently.
async function checkSymbolBinaryMismatch() {
    try {
        if (!regs || regs.pc === undefined) return;
        const pc = regs.pc & 0xFFFF;
        if (warnedMismatchPCs.has(pc)) return;
        const src = sourceFor(pc);
        if (!src || !src.file || !/\.(s|asm)$/i.test(src.file)) return;
        const lineText = getSourceLine(src.file, src.line);
        const srcMnem = lineText ? leadingMnemonic(lineText) : null;
        if (!srcMnem) return;
        const mem = await readMem(pc, 1);
        if (!mem || mem.length < 1) return;
        const entry = OPS[mem[0]];
        if (!entry) return;                          // illegal opcode → can't judge
        const liveMnem = entry.substring(0, 3).toUpperCase();
        if (liveMnem === srcMnem) return;            // matches → symbols fit the code here
        warnedMismatchPCs.add(pc);
        const fn = src.file.split(/[\\/]/).pop();
        evt('output', { category: 'important', output:
            '⚠ Symbols may not match the loaded binary at $' + pc.toString(16).toUpperCase().padStart(4, '0') +
            ': the CPU is at a `' + liveMnem + '` instruction, but the mapped source (' + fn + ':' + src.line +
            ') is `' + String(lineText).replace(/\s+/g, ' ').trim() + '`. Labels and line info around here are ' +
            'likely wrong (multi-overlay address clash or a link-layout mismatch) — verify against raw bytes.\n' });
    } catch (e) { /* a diagnostic must never disrupt a stop */ }
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

// Write memory through the stub. Invalidates the per-stop read cache so the
// new bytes are immediately visible — the cache is otherwise only cleared on
// stop notifications, and a `w`/writeMemory while stopped would keep serving
// the old bytes. THE one M-packet sender (console `w` + DAP writeMemory).
async function writeMem(addr, bytes) {
    let hex = '';
    for (const b of bytes) hex += (b & 0xFF).toString(16).padStart(2, '0');
    const reply = await gdbCmd('M' + (addr & 0xFFFF).toString(16) + ',' + bytes.length.toString(16) + ':' + hex);
    if (reply === 'OK') clearGdbReadCache();
    return reply === 'OK';
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

// Whether decoded values include the "|%binary" part. Off trims the display to
// "$hex|dec". Global, live-toggleable (setShowBinary request / bin console cmd),
// seeded from the oric-debug.showBinary VS Code setting at launch.
let showBinary = true;
function binPart(v, bits) { return showBinary ? '|%' + v.toString(2).padStart(bits, '0') : ''; }

// Numeric part shared by enum display: "$hex|dec[|%binary]" (no char glyph — an
// enum byte is a code/flag word, not text).
function enumNumeric(v, size) {
    if (size >= 2)
        return '$' + v.toString(16).toUpperCase().padStart(4, '0') + '|' + v + binPart(v, 16);
    return '$' + v.toString(16).toUpperCase().padStart(2, '0') + '|' + v + binPart(v, 8);
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

// Byte width of a scalar/enum type name, or 0 when unknown (structs are the
// callers' job via typeDefs). Shared by the watch cast parser and the pointer
// dereference in buildTypedVar.
function scalarSizeOf(t) {
    const n = String(t).toLowerCase();
    if (n === 'char' || n === 'uchar' || n === 'schar' || n === 'byte' || n === 'ubyte' || n === 'bool') return 1;
    if (n === 'int' || n === 'uint' || n === 'short' || n === 'ushort' || n === 'sint' || n === 'sshort' || n === 'word' || n === 'uword') return 2;
    if (resolveEnum(t)) return 1;
    return 0;
}

// Format a scalar value from raw bytes for display
function formatScalar(typeName, mem, offset, size) {
    // Value first: '|' chains pick their enum by it. Case-sensitive lookup —
    // enum tags before lowercasing.
    const vv = size >= 2 ? ((mem[offset] || 0) | ((mem[offset + 1] || 0) << 8)) : (mem[offset] || 0);
    const ed = resolveEnum(typeName, vv);
    if (ed) return formatEnum(ed, mem, offset, size);
    const t = typeName.toLowerCase();
    const isSigned = (t === 'char' || t === 'schar' || t === 'int' || t === 'short' || t === 'sint' || t === 'sshort');
    // Uniform "hex|dec|%binary" form, matching the disassembly annotations.
    if (size === 1) {
        const v = mem[offset] || 0;
        const sv = (isSigned && v > 127) ? v - 256 : v;
        // Show the ASCII glyph for any displayable byte value, whatever the type.
        const ch = (v >= 32 && v < 127) ? " '" + String.fromCharCode(v) + "'" : '';
        return '$' + v.toString(16).toUpperCase().padStart(2, '0') + '|' + (isSigned ? sv : v) + binPart(v, 8) + ch;
    } else if (size === 2) {
        const w = (mem[offset] || 0) | ((mem[offset + 1] || 0) << 8);
        const sv = (isSigned && w > 32767) ? w - 65536 : w;
        return '$' + w.toString(16).toUpperCase().padStart(4, '0') + '|' + (isSigned ? sv : w) + binPart(w, 16);
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

// The ONE symbol-record builder — PURE (symbol table + resolver only, NO memory reads).
// Produces one record per address with merged co-located labels, canonical-name ordering,
// per-name source, size/group/typeInfo. Shared by readAllSymbols (which layers live value +
// annotated display on top) and symbolTableLite (Memory Map). Keeping this single means the
// Symbol Browser and the Memory Map see identical labels/aliases/sources by construction —
// the earlier split reimplemented alias gathering and drifted (aliases went missing on the map).
// Co-located labels = the flat `symbols` map merged by address UNIONed with the resolver's
// aliases at that exact address (the resolver is the authority; the flat map may not carry all).
function assembleSymbols() {
    if (symbols.size === 0) return [];
    const allAddrs = [];
    for (const [name, addr] of symbols) {
        const info = symInfo.get(name);
        allAddrs.push({ name, addr, size: info ? info.size : 1,
                        group: info ? info.group : (addr <= 0xFF ? 'zp' : (addr < 0xC000 ? 'ram' : 'high')) });
    }
    allAddrs.sort((a, b) => a.addr - b.addr);
    const out = [];
    for (let i = 0; i < allAddrs.length; ) {
        const s = allAddrs[i];
        let names = [s.name], maxSize = s.size, j = i + 1;
        while (j < allAddrs.length && allAddrs[j].addr === s.addr) {
            names.push(allAddrs[j].name);
            if (allAddrs[j].size > maxSize) maxSize = allAddrs[j].size;
            j++;
        }
        i = j;
        // Canonical owner + union the resolver's co-located aliases (exact-address record).
        const rec = resolverInstance ? resolverInstance.resolve(s.addr) : null;
        if (rec && rec.symbol) {
            if (rec.symbol.name && !names.includes(rec.symbol.name)) names.push(rec.symbol.name);
            for (const al of (rec.symbol.aliases || [])) if (al.name && !names.includes(al.name)) names.push(al.name);
        }
        const master = rec && rec.symbol ? rec.symbol.name : null;
        if (master && names.includes(master)) names = [master, ...names.filter(n => n !== master).sort((a, b) => a.length - b.length)];
        else names.sort((a, b) => a.length - b.length);
        // Per-name navigation source: owner → the record's winning source, each alias → its
        // own #SYM decl (resolver aliases[].source), declOf() as the fallback.
        const aliasSrc = new Map();
        if (rec && rec.symbol) for (const al of rec.symbol.aliases) if (al.source) aliasSrc.set(al.name, al.source);
        const nameSources = {};
        for (const n of names) {
            const src2 = (n === master && rec && rec.source) ? rec.source
                : aliasSrc.get(n) || (resolverInstance ? resolverInstance.declOf(n) : null);
            if (src2) nameSources[n] = { file: src2.file, line: src2.line };
        }
        const src = rec && rec.source ? rec.source : null;
        const vt = varTypes.get(names[0]);
        out.push({ name: names[0], aliases: names.slice(1), addr: s.addr,
                   size: vt ? vt.totalSize : maxSize, rawSize: maxSize, group: s.group,
                   source: src ? { file: src.file, line: src.line } : null,
                   nameSources,
                   typeInfo: vt ? { type: vt.type, base: vt.base, count: vt.count,
                                    fields: typeDefs.has(vt.base) ? typeDefs.get(vt.base).fields : null } : null });
    }
    return out;
}

// Parse comment-based debug annotations from all source files (.h uses "// @...",
// .s uses "; @..."). Rebuilds annByField (C struct members) and annBySymbol
// (C globals & asm data labels). Directives: @bool, @enum <E>, @bitset <E>.
function parseAnnotations(files) {
  annByField.clear();
  annBySymbol.clear();
  paramsByEnumMember.clear();
  headerEnumDefs.clear();
  try {
    // stream before str: alternation is first-match (str\b would not match "stream"
    // anyway due to \b, but keep the longer tokens earlier to be safe).
    const ANN = /@(bool|enum|bitset|ptr16|bcd(?:-[bl]e)?|strptr|stream|str)\b\s*([\w|]+)?/;   // matched within the comment portion; [\w|] admits '|' fallback chains
    const PARAMS = /@params\b[ \t]*([^\r\n]*)$/;   // grammar for a byte-stream command enum member
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
        let inEnum = false, enumName = null, pendingParams = [];
        let enumMembers = [], enumNextVal = 0, enumValid = true;
        for (const line of lines) {
            // Enter a C struct/union body (name may be trailing on the '}' line).
            if (!isAsm && !inStruct && /\b(typedef\s+)?(struct|union)\b/.test(line)
                && !/;/.test(line.replace(/\/\/.*$/, ''))) {
                inStruct = true; pending = [];
                const nm = line.match(/(?:struct|union)\s+([A-Za-z_]\w*)\s*\{/);
                structName = nm ? nm[1] : null;
            }
            // Enter a C enum body — its members may carry @params byte-stream grammar.
            if (!isAsm && !inEnum && /\benum\b/.test(line)
                && !/;/.test(line.replace(/\/\/.*$/, ''))) {
                inEnum = true; pendingParams = []; enumName = null;
                enumMembers = []; enumNextVal = 0; enumValid = true;
            }
            // Split code from comment. C comment = "//"; asm also allows ";".
            let ci = line.indexOf('//');
            if (isAsm) {
                const s = line.indexOf(';');
                if (s >= 0 && (ci < 0 || s < ci)) ci = s;
            }
            const code = ci >= 0 ? line.slice(0, ci) : line;
            const comment = ci >= 0 ? line.slice(ci) : '';
            // @params on an enum member: record the ordered grammar tokens.
            if (!isAsm && inEnum) {
                const pm = comment.match(PARAMS);
                if (pm) {
                    const c = code.replace(/[=,].*$/, '');
                    const ids = c.match(/[A-Za-z_]\w*/g);
                    const member = ids ? ids[ids.length - 1] : null;
                    if (member) pendingParams.push({ member, types: pm[1].trim() ? pm[1].trim().split(/\s+/) : [] });
                }
                // Member VALUES, for the headerEnumDefs fallback. Skip the decl
                // line itself; only literal decimal/hex or implicit sequential
                // values are trusted — any other member line poisons the whole
                // enum (enumValid=false) so we never render wrong names.
                if (!/\b(typedef|enum)\b/.test(code)) {
                    const em = code.match(/^\s*([A-Za-z_]\w*)\s*(?:=\s*([^,\s]+))?\s*,?\s*$/);
                    if (em) {
                        let v;
                        if (em[2] === undefined) v = enumNextVal;
                        else if (/^\d+$/.test(em[2])) v = parseInt(em[2], 10);
                        else if (/^0[xX][0-9a-fA-F]+$/.test(em[2])) v = parseInt(em[2], 16);
                        else enumValid = false;
                        if (v !== undefined) { enumMembers.push({ name: em[1], value: v }); enumNextVal = v + 1; }
                    } else if (code.trim() && !/[{}]/.test(code)) {
                        enumValid = false;   // unparseable member line — don't guess
                    }
                }
            }
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
                // @str / @strptr carry an optional TERMINATOR byte value
                // (decimal — no implicit hex), not an enum name. Default 0 (NUL);
                // Encounter's attribute-text uses 255 (TEXT_END).
                if (m[1] === 'str' || m[1] === 'strptr') {
                    directive.enumName = null;
                    if (m[2] && /^\d+$/.test(m[2])) directive.term = parseInt(m[2], 10) & 0xFF;
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
            // Close a C enum: flush buffered @params grammar under the enum's name,
            // plus the header-parsed member values (fallback defs for pure-asm
            // projects — resolveEnum consults these only when no compiler-emitted
            // enum record exists). isFlags heuristic matches the #TYPES parser.
            if (!isAsm && inEnum && /\}/.test(line)) {
                const nm = line.match(/\}\s*([A-Za-z_]\w*)\s*;/);
                if (nm) enumName = nm[1];
                if (enumName) for (const p of pendingParams) paramsByEnumMember.set(enumName + '.' + p.member, p.types);
                if (enumName && enumValid && enumMembers.length && !headerEnumDefs.has(enumName)) {
                    const byValue = new Map();
                    let allSingleBit = true, nonZero = 0, seenBits = 0, maxVal = 0;
                    for (const mb of enumMembers) {
                        if (!byValue.has(mb.value)) byValue.set(mb.value, mb.name);  // first name wins on aliases
                        const ev = mb.value;
                        if (ev !== 0) {
                            nonZero++;
                            if (ev > maxVal) maxVal = ev;
                            if ((ev & (ev - 1)) !== 0 || (seenBits & ev)) allSingleBit = false;
                            seenBits |= ev;
                        }
                    }
                    const isFlags = nonZero >= 2 && allSingleBit && maxVal >= 4;
                    headerEnumDefs.set(enumName, { size: 1, byValue, isFlags });
                }
                inEnum = false; enumName = null; pendingParams = [];
                enumMembers = []; enumNextVal = 0; enumValid = true;
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

// Read a terminated string at `addr` for display: up to `term` (Encounter has
// classic NUL-terminated text AND attribute-laden text where 0 is BLACK INK —
// those use TEXT_END 255 instead), capped, non-printables as dots (attribute
// bytes stay visible as placeholders without hiding the words).
async function readTermString(addr, term) {
    const CAP = 40;
    const mem = await readMem(addr & 0xFFFF, CAP);
    let len = 0;
    while (len < CAP && mem[len] !== term) len++;
    return (formatCharArray(mem, 0, len) || '""') + (len === CAP ? '…' : '');
}

// Decode one @params parameter token from the stream bytes in `mem` at `memPos`
// (absolute address `absAddr`, for symbol lookups). Returns { value, size }.
// Reuses the shared formatters (formatEnum/formatScalar/formatCharArray) — no
// second render path. `str` = inline NUL-terminated string; `word` = 16-bit LE;
// anything else is an enum name (decoded) or `byte` (raw).
function decodeStreamParam(tok, absAddr, mem, memPos, depth) {
    if (tok === 'str') {
        let len = 0;
        while (memPos + len < mem.length && mem[memPos + len] !== 0) len++;
        return { value: (formatCharArray(mem, memPos, len) || '""'), size: len + 1 };
    }
    if (tok === 'word') {
        const w = (mem[memPos] || 0) | ((mem[memPos + 1] || 0) << 8);
        let v = '$' + w.toString(16).toUpperCase().padStart(4, '0');
        const s = symbolAt(w);
        v += s ? ' →' + s : ' (' + w + ')';
        return { value: v, size: 2 };
    }
    // cmd:<enum> — a nested sub-command decoded by <enum>'s grammar (e.g. the
    // condition operator inside a JUMP_IF). Renders like a top-level command and
    // reports its full byte length so the outer walk stays in sync.
    if (tok.indexOf('cmd:') === 0) {
        const subEnum = tok.slice(4);
        const sub = decodeOneCommand(subEnum, mem, memPos, absAddr - memPos, (depth || 0) + 1);
        return { value: streamCmdText(sub, subEnum), size: sub.size };
    }
    const b = mem[memPos] || 0;
    if (tok === 'byte') return { value: '$' + b.toString(16).toUpperCase().padStart(2, '0') + '|' + b, size: 1 };
    const ed = resolveEnum(tok, b);
    return { value: ed ? formatEnum(ed, [b], 0, 1) : formatScalar('uchar', [b], 0, 1), size: 1 };
}

// Decode a single command at mem[pos] (chunk base `base`, for word symbol
// lookups) using enum `enumName` + paramsByEnumMember. Returns
// {offset, opcode, name, known, params:[{value,size}], size, end}. Shared by
// decodeStream (top-level list) and the cmd:<enum> nested param (DRY). `depth`
// guards runaway nesting.
function decodeOneCommand(enumName, mem, pos, base, depth) {
    const unknown = (name) => ({ offset: pos, opcode: mem[pos] || 0, name: name === undefined ? null : name, known: false, params: [], size: 1, end: true });
    if ((depth || 0) > 4) return unknown(null);
    const ed = resolveEnum(enumName);
    if (!ed) return unknown(null);
    const opcode = mem[pos] || 0;
    const name = ed.byValue.get(opcode);
    if (name === undefined) return unknown(undefined);
    const grammar = paramsByEnumMember.get(enumName + '.' + name);
    if (grammar === undefined) return { offset: pos, opcode, name, known: false, params: [], size: 1, end: true };
    let p = pos + 1, stop = false;
    const params = [];
    for (const tok of grammar) {
        if (tok === 'end') { stop = true; break; }
        if (p >= mem.length) break;
        const r = decodeStreamParam(tok, base + p, mem, p, depth || 0);
        params.push(r);
        p += r.size;
    }
    return { offset: pos, opcode, name, known: true, params, size: p - pos, end: stop };
}

// Decode up to `maxCmds` byte-stream commands starting at `addr`, using enum
// `enumName` for the opcode byte and paramsByEnumMember for each command's
// grammar. Returns [{offset, opcode, name, known, params:[{value}], size, end}].
// Stops at: maxCmds, an opcode not in the enum, a command with no @params
// grammar, a grammar containing the `end` token (terminators / jumps), or a
// chunk overrun. One readMem for the whole window (per-stop cache makes it cheap).
async function decodeStream(enumName, addr, maxCmds) {
    const out = [];
    if (!resolveEnum(enumName)) return out;
    const CHUNK = 128;
    const base = addr & 0xFFFF;
    const mem = await readMem(base, CHUNK);
    let pos = 0;
    for (let n = 0; n < maxCmds && pos < CHUNK; n++) {
        const c = decodeOneCommand(enumName, mem, pos, base, 0);
        c.offset = pos;
        out.push(c);
        pos += c.size;
        if (c.end || !c.known) break;  // terminator/jump, unknown opcode, or no grammar
    }
    return out;
}

// One-line text for a decoded stream command — shared by the collapsed/inline
// stream value and the expanded child list so they read identically (DRY).
function streamCmdText(c, enumName) {
    if (c.name === null) return '??? $' + c.opcode.toString(16).toUpperCase().padStart(2, '0') + ' (not a ' + enumName + ')';
    if (!c.known) return c.name + '  (no @params grammar)';
    return c.name + (c.params.length ? '(' + c.params.map(p => p.value).join(', ') + ')' : '') + (c.end ? '  …' : '');
}

// Render a value using a comment annotation (@bool/@enum/@bitset/@ptr16/@bcd/
// @str/@strptr/@stream). Returns { value, ref? } or null. bitset & stream return
// an expandable ref (bitset children = set bits; stream children = decoded cmds).
async function formatAnnotated(ann, addr, size) {
    // @stream <E>: a 16-bit pointer into a byte-code stream whose opcodes are
    // enum <E>. Expand to the next decoded commands (see the varRefs handler).
    if (ann.kind === 'stream') {
        const m = await readMem(addr, 2);
        const target = (m[0] | (m[1] << 8)) & 0xFFFF;
        const tHex = '$' + target.toString(16).toUpperCase().padStart(4, '0');
        if (target === 0) return { value: '(null)', type: ann.enumName || 'stream' };
        const ref = stableRef('stream:' + target + ':' + ann.enumName,
                              { kind: 'stream', addr: target, enumName: ann.enumName });
        // Show the first command inline so the collapsed value (and the disasm
        // annotation) is informative without expanding; the ref lists the rest.
        const head = await decodeStream(ann.enumName, target, 1);
        const headTxt = head.length ? ' = ' + streamCmdText(head[0], ann.enumName) : '';
        return { value: '→ ' + tHex + headTxt, ref, type: ann.enumName || 'stream' };
    }
    // @str [term]: the text itself sits at the symbol; @strptr [term]: a 16-bit
    // pointer to it. term defaults to 0 (NUL); attribute-text uses e.g. 255.
    if (ann.kind === 'str') {
        return { value: await readTermString(addr, ann.term || 0), type: 'str' + (ann.term ? '/' + ann.term : '') };
    }
    if (ann.kind === 'strptr') {
        const m = await readMem(addr, 2);
        const target = (m[0] | (m[1] << 8)) & 0xFFFF;
        const tHex = '$' + target.toString(16).toUpperCase().padStart(4, '0');
        if (target === 0) return { value: '→ ' + tHex, type: 'strptr' };
        return { value: '→ ' + tHex + ' = ' + await readTermString(target, ann.term || 0), type: 'strptr' + (ann.term ? '/' + ann.term : '') };
    }
    if (ann.kind === 'ptr16') {
        // Typed pointer (@ptr16 <struct>): render as *<struct> through the one
        // render path — the pointed-to struct is expandable in every view.
        if (ann.enumName && typeDefs.has(ann.enumName)) {
            const v = await buildTypedVar('', addr, '*' + ann.enumName, 2, null, { omitAddr: true });
            return { value: v.value, ref: v.variablesReference, type: null }; // value already names the type
        }
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
        const sz = size || 1;
        const mem = await readMem(addr, sz);
        // Buffers (.dsb arrays like gWordBuffer, one id per byte): decode each
        // byte on its own — a 16-bit read across two ids is meaningless.
        if (sz > 2) {
            const parts = [];
            for (let i = 0; i < sz; i++) {
                const b = mem[i] || 0;
                const edi = resolveEnum(ann.enumName, b);
                parts.push(edi && edi.byValue.has(b) ? edi.byValue.get(b)
                         : '$' + b.toString(16).toUpperCase().padStart(2, '0'));
            }
            return { value: '[' + parts.join(', ') + ']', type: ann.enumName || 'enum' };
        }
        const v = sz >= 2 ? ((mem[0] || 0) | ((mem[1] || 0) << 8)) : (mem[0] || 0);
        const ed = resolveEnum(ann.enumName, v);
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
// array-element expansion, the inline instruction annotation (via
// opts.omitAddr — the operand label already carries the address), and any
// future scope ("auto", etc.). Do NOT format a variable's value inline in a
// handler: that path drift is what silently broke annotations in the Watch
// window, and later hid @enum decoding from the instruction annotation. Handles scalars, enums, structs, arrays,
// pointer-to-struct, and comment annotations (@bool/@enum/@bitset via `ann`).
// Look up `ann` with annForSymbol(name) for symbols or annByField for fields;
// resolve enums with resolveEnum() so it works regardless of the active module.
// (Registers/Flags are CPU state, not memory-typed values — they legitimately
// render separately.) See CORE-CONCEPTS.md → "One render path".
// ============================================================================
// Every typed row, whichever view asked for it, carries a declaration reference when the name has a
// real definition. That is what lets the BUILT-IN Variables/Watch rows navigate to source: those
// views are rendered by VS Code, so a reference resolved through the `locations` request is the only
// hook available. Stamped in ONE wrapper rather than at each of the seven return sites below, so a
// new render path cannot forget it. Struct members and other non-symbol names simply get nothing.
async function buildTypedVar(name, addr, fullType, size, ann, opts) {
    const v = await buildTypedVarCore(name, addr, fullType, size, ann, opts);
    if (v && v.declarationLocationReference === undefined) {
        const ref = locationRefForName(name);
        if (ref !== undefined) v.declarationLocationReference = ref;
    }
    return v;
}
async function buildTypedVarCore(name, addr, fullType, size, ann, opts) {
    addr &= 0xFFFF;
    const hAddr = '$' + addr.toString(16).toUpperCase().padStart(4, '0');
    // opts.omitAddr: compact form for the inline instruction annotation, where
    // the operand label already carries the address.
    const at = (opts && opts.omitAddr) ? '' : '  @ ' + hAddr;
    // Comment annotation (@bool/@enum/@bitset) overrides the default rendering.
    if (ann) {
        const a = await formatAnnotated(ann, addr, size);
        // Show the detected type token (e.g. "bcd-be", "bool", the enum name) the same
        // way the scalar path shows fullType, so annotated values read consistently.
        if (a) {
            const t = a.type ? '  ' + a.type : '';
            return { name, value: a.value + t + at, variablesReference: a.ref || 0 };
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
            return { name, value: fullType + ' → ' + tHex + at, variablesReference: ref };
        }
        // char pointee: a C string — show the NUL-terminated text, not one
        // character ("description: *char → $2DD7 = 'e'" told the user nothing;
        // the string IS the context). Attribute-text with other terminators is
        // covered by @str / @strptr annotations instead.
        if (isCharType(pointed) && target !== 0) {
            return { name, value: fullType + ' → ' + tHex + ' = ' + await readTermString(target, 0) + at, variablesReference: 0 };
        }
        // Scalar target: dereference one hop and show the pointed-to value,
        // mirroring the @ptr16 annotation's "→" so pointers read consistently.
        const psz = scalarSizeOf(pointed);
        if (psz && target !== 0) {
            const tm = await readMem(target, psz);
            return { name, value: fullType + ' → ' + tHex + ' = ' + formatScalar(pointed, tm, 0, psz) + at, variablesReference: 0 };
        }
        return { name, value: fullType + ' = ' + tHex + at, variablesReference: 0 };
    }
    const am = fullType.match(/^(.+)\[(\d+)\]$/);
    const base = am ? am[1] : fullType;
    const count = am ? parseInt(am[2], 10) : 1;
    if (typeDefs.has(base) || count > 1) {
        const ref = stableRef('st:' + addr + ':' + base + ':' + count,
                              { addr, typeName: base, count, totalSize: size });
        let val = fullType + at;
        if (count > 1 && isCharType(base)) {
            const mem = await readMem(addr, size);
            val = formatCharArray(mem, 0, count) + '  ' + fullType + at;
        }
        return { name, value: val, variablesReference: ref };
    }
    const mem = await readMem(addr, size);
    return { name, value: formatScalar(base, mem, 0, size) + '  ' + fullType + at, variablesReference: 0 };
}

// Check if a file path looks like a build artifact (linked.s, etc.)
function isBuildArtifact(filePath) {
    const base = path.basename(filePath).toLowerCase();
    return base === 'linked.s' || base === 'linked.asm';
}

// Definition site of a symbol BY NAME: the file:line where it is declared. Tries the name as given
// and its C<->asm underscore variant. Build artifacts (linked.s, TMP intermediates) are refused —
// they are ephemeral, so navigating there lands in a file that no longer matches what is running.
// ONE implementation, shared by the symbolDefinition request and the DAP location references, so
// a name is navigable in the built-in views exactly when it is navigable in our own panels.
function definitionOfName(n) {
    for (const cand of [n, (n[0] === '_' ? n.slice(1) : '_' + n)]) {
        const src = symSource.get(cand)
            || (resolverInstance && resolverInstance.declOf ? resolverInstance.declOf(cand) : null);
        if (src && src.file && !isBuildArtifact(src.file) && !/[\\/]tmp[\\/]/i.test(src.file))
            return { name: cand, file: src.file, line: src.line || 0 };
    }
    return null;
}

// DAP location references. The client receives an opaque integer on a Variable / evaluate result and
// asks the `locations` request to turn it into a source position. Deduplicated by file:line so a
// long-running session with many refreshes does not grow one entry per repaint.
const locationRefs = new Map();     // id -> {file, line}
const locationRefIds = new Map();   // "file:line" -> id
let nextLocationRef = 1;
function locationRefFor(src) {
    if (!src || !src.file) return undefined;
    const key = src.file + ':' + (src.line || 0);
    let id = locationRefIds.get(key);
    if (id === undefined) {
        id = nextLocationRef++;
        locationRefIds.set(key, id);
        locationRefs.set(id, { file: src.file, line: src.line || 0 });
    }
    return id;
}
// Location reference for a symbol name, or undefined when it has no navigable definition.
function locationRefForName(name) {
    if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) return undefined;
    return locationRefFor(definitionOfName(name));
}

// Record name -> definition site, keeping the best source we have seen for that name.
// A symbol can be listed several times across the symbol file: once at its real definition
// (loader.asm:710) and again via the linked.s intermediate. Whichever is parsed LAST used to
// win, so a real source could be replaced by an artifact — and consumers that refuse artifacts
// (symbolDefinition, hence click-to-definition) then found nothing at all. Rule, mirroring the
// addr->source merge: first definition wins, except that a real source displaces an artifact.
function setSymSource(map, name, src) {
    if (!src || !src.file) return;
    const prev = map.get(name);
    if (!prev || (isBuildArtifact(prev.file) && !isBuildArtifact(src.file))) map.set(name, src);
}

// Address of the next different source line after `pc` (source-level
// step-over's temp-bp target) — thin wrapper over the resolver's inverse
// mapping (§5.6). Returns -1 when the file ends (caller falls back to
// instruction stepping).
function findNextSourceLineAddr(pc, file, line) {
    return resolverInstance ? resolverInstance.nextLineAddr(pc, file, line) : -1;
}

// One move of a source-level Step Over: if the instruction at PC is a JSR ($20), step
// OVER the call by setting a temp breakpoint at the return address (PC+3) and continuing;
// otherwise single-step. Branches/JMP just move the PC and are handled by the single-step.
// Reads the opcode live (one round-trip/step) — a step over usually spans few instructions.
async function stepOverMove() {
    const pc = (regs && regs.pc !== undefined) ? (regs.pc & 0xFFFF) : -1;
    let op = -1;
    if (pc >= 0) { try { const b = await readMem(pc, 1); if (b && b.length) op = b[0]; } catch (e) { /* fall back to single-step */ } }
    // Continuing from a PC that holds a user breakpoint re-triggers it in this stub, so
    // don't 'c' over a JSR that is itself breakpointed — single-step into it instead; the
    // sp-depth check in the loop then keeps stepping until we return, so it's still a step OVER.
    const canSkip = op === 0x20 && pc >= 0 && !isBreakpointAt(pc);
    running = true;
    regs = null;
    if (canSkip) {                          // JSR abs → run the call, stop at its return
        const ret = (pc + 3) & 0xFFFF;
        await armAddr(ret);
        tempStepBp = ret;
        gdbWrite('c');
    } else {
        gdbWrite('s');
    }
}

// Arm an execution breakpoint (Z0) in the stub, ref-counted so that N logical
// breakpoints (source/function/instruction/temp) sharing one address arm exactly
// one Z0. Returns true if the address is armed after the call. See armedAddrs.
async function armAddr(addr) {
    const n = armedAddrs.get(addr) || 0;
    armedAddrs.set(addr, n + 1);
    if (n === 0) {
        const r = await gdbCmd('Z0,' + addr.toString(16) + ',1');
        if (r !== 'OK') { // roll back on failure
            armedAddrs.delete(addr);
            // E20 = the stub's execution-breakpoint table is full. Surface it — an
            // unarmed breakpoint otherwise just shows a silent gray marker.
            log('FAILED to arm breakpoint at $' + (addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0') +
                ' — stub reply "' + r + '"' + (r === 'E20'
                    ? ' (Oricutron execution-breakpoint table FULL; ' + armedAddrs.size + ' armed)'
                    : '') );
            return false;
        }
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

// VS Code hitCondition ("5", ">=5", "> 5"…) -> a numeric hit target (fire on/after
// the Nth qualifying hit; 0 = none). The stub does ">= target" semantics.
function hitTargetOf(hitCondition) {
    if (!hitCondition) return 0;
    const m = String(hitCondition).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

// Rewrite a VS Code condition so C variables become the memory reads the stub's
// cond compiler understands. A variable reference (an identifier plus any
// .member / ->member / [index] postfix) is turned into an address computation
// wrapped in a load:
//   - local/parameter   -> address is *$fp:w + off (frame-relative)
//   - global/asm symbol -> address is the constant $addr
//   - .field  adds the field offset; ->field derefs the pointer then adds it;
//     [i] adds (index)*stride, index resolved by the same rewriter.
// The final lvalue is read as *(addr) or *(addr):w by its scalar width.
// Registers/flags, numbers and operators pass through untouched; the stub reports
// genuinely unknown names. Aggregates (whole array/struct) and >2-byte scalars
// (long) can't be compared as one value and return a clear error instead of
// silently-wrong bytecode. Returns { expr, error }.
function resolveCondSymbols(expr, locals, fpAddr, apAddr) {
    let out = '', i = 0, error = null;
    const s = expr;
    const isHex = c => /[0-9a-fA-F]/.test(c), isDig = c => c >= '0' && c <= '9';
    const isIdS = c => /[A-Za-z_]/.test(c), isId = c => c && /[A-Za-z0-9_]/.test(c);
    const fail = m => { error = error || m; };
    const skipWs = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };

    // Bytes a type occupies: pointer=2, T[N]=N*sizeof(T), struct via typeDefs,
    // else scalar/enum. Tolerates an 'unsigned '/'signed ' prefix. 0 = unknown.
    const typeSizeOf = t => {
        if (!t) return 0;
        if (t[0] === '*') return 2;
        const am = t.match(/^(.+)\[(\d+)\]$/);
        if (am) return parseInt(am[2], 10) * typeSizeOf(am[1]);
        if (typeDefs.has(t)) return typeDefs.get(t).size;
        const norm = t.replace(/\b(unsigned|signed)\s+/g, '');
        return scalarSizeOf(t) || scalarSizeOf(norm);
    };

    // Base lvalue for an identifier: { addrExpr, type, size } or null (not a var).
    const baseOf = name => {
        const loc = locals && locals.find(l => l.cname === name);
        if (loc) {
            const baseAddr = loc.base === 'ap' ? apAddr : fpAddr;
            if (typeof baseAddr !== 'number') { fail("no frame pointer to resolve local '" + name + "'"); return null; }
            const off = loc.offset | 0;
            const term = off >= 0 ? ' + ' + off : ' - ' + (-off);
            return { addrExpr: '*$' + (baseAddr & 0xFFFF).toString(16) + ':w' + term, type: loc.type, size: loc.size };
        }
        let addr = symbols.get(name);
        if (addr === undefined && name[0] !== '_') addr = symbols.get('_' + name);
        if (addr !== undefined) {
            const spec = renderSpec(name) || {};
            return { addrExpr: '$' + (addr & 0xFFFF).toString(16), type: spec.type || 'uchar', size: spec.size || 1 };
        }
        return null;
    };

    // Read the identifier at the cursor plus its access chain, returning the cond
    // read expression — or the bare name if it isn't a variable (register/flag/
    // unknown; the stub decides). Advances the cursor `i`.
    const consumeAccess = () => {
        let name = ''; while (i < s.length && isId(s[i])) name += s[i++];
        const base = baseOf(name);
        if (!base) {
            // Not a variable: an enum constant resolves to its value; anything else
            // (register/flag, or a genuinely unknown name) passes through.
            const ev = enumMemberValue(name);
            return ev !== undefined ? String(ev) : name;
        }
        let cur = base;
        for (;;) {
            const save = i; skipWs();
            if (s[i] === '.' || (s[i] === '-' && s[i + 1] === '>')) {
                const arrow = s[i] === '-'; i += arrow ? 2 : 1; skipWs();
                let fld = ''; while (i < s.length && isId(s[i])) fld += s[i++];
                let structName, structAddr;
                if (arrow) {
                    if (cur.type[0] !== '*') { fail("'->' on non-pointer '" + cur.type + "'"); return name; }
                    structName = cur.type.slice(1); structAddr = '*(' + cur.addrExpr + '):w';
                } else { structName = cur.type; structAddr = cur.addrExpr; }
                if (!typeDefs.has(structName)) { fail("'" + structName + "' is not a struct (for ." + fld + ")"); return name; }
                const f = typeDefs.get(structName).fields.find(x => x.name === fld);
                if (!f) { fail("no field '" + fld + "' in '" + structName + "'"); return name; }
                cur = { addrExpr: f.offset ? structAddr + ' + ' + f.offset : structAddr, type: f.type, size: f.size };
                continue;
            }
            if (s[i] === '[') {
                i++; let depth = 1; const start = i;
                while (i < s.length && depth > 0) { if (s[i] === '[') depth++; else if (s[i] === ']') depth--; if (depth > 0) i++; }
                const idxText = s.slice(start, i);
                if (s[i] === ']') i++; else { fail("missing ']'"); return name; }
                let elemType, elemBase;
                if (cur.type[0] === '*') { elemType = cur.type.slice(1); elemBase = '*(' + cur.addrExpr + '):w'; }
                else {
                    const am = cur.type.match(/^(.+)\[(\d+)\]$/);
                    if (!am) { fail("cannot index non-array '" + cur.type + "'"); return name; }
                    elemType = am[1]; elemBase = cur.addrExpr;
                }
                const stride = typeSizeOf(elemType);
                if (!stride) { fail("unknown element size for '" + elemType + "'"); return name; }
                const idx = resolveCondSymbols(idxText, locals, fpAddr, apAddr);
                if (idx.error) { fail(idx.error); return name; }
                const term = stride === 1 ? '(' + idx.expr + ')' : '(' + idx.expr + ')*' + stride;
                cur = { addrExpr: elemBase + ' + ' + term, type: elemType, size: stride };
                continue;
            }
            i = save; break;   // no more postfix
        }
        const w = cur.type[0] === '*' ? 2 : (cur.size === 1 ? 1 : (cur.size === 2 ? 2 : 0));
        if (!w) { fail("'" + name + "' is a " + cur.size + "-byte " + cur.type + " — conditions compare only 8/16-bit values"); return name; }
        // Plain global scalar (no deref): compact *$addr form; else a computed load.
        if (cur === base && base.addrExpr[0] === '$') return '*' + base.addrExpr + (w === 2 ? ':w' : '');
        return '*(' + cur.addrExpr + ')' + (w === 2 ? ':w' : '');
    };

    while (i < s.length) {
        const ch = s[i];
        if (ch === '$') { out += ch; i++; while (i < s.length && isHex(s[i])) out += s[i++]; continue; }
        if (ch === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) { out += s[i] + s[i + 1]; i += 2; while (i < s.length && isHex(s[i])) out += s[i++]; continue; }
        if (isDig(ch)) { while (i < s.length && isDig(s[i])) out += s[i++]; continue; }
        if (isIdS(ch)) { out += consumeAccess(); continue; }
        out += ch; i++;
    }
    return { expr: out, error };
}

// Bytes a C type occupies: pointer=2, T[N]=N*sizeof(T), struct via typeDefs, else
// scalar/enum (tolerating an unsigned/signed prefix). 0 = unknown. Shared by the
// Watch access evaluator below.
function ctypeSizeOf(t) {
    if (!t) return 0;
    if (t[0] === '*') return 2;
    const am = t.match(/^(.+)\[(\d+)\]$/);
    if (am) return parseInt(am[2], 10) * ctypeSizeOf(am[1]);
    if (typeDefs.has(t)) return typeDefs.get(t).size;
    return scalarSizeOf(t) || scalarSizeOf(t.replace(/\b(unsigned|signed)\s+/g, ''));
}

// Runtime evaluator for a C variable access (ident + .member / ->member / [index])
// used by Watch. Reads live memory to follow pointers and index variables and
// returns { addr, type, size } for the final lvalue, or null if the head isn't a
// variable (so the caller falls through to other forms). Throws Error(msg) on a
// typed mistake (no such field, indexing a non-array, …).
async function evalAccess(expr, locals, fpVal, apVal) {
    let i = 0; const s = expr;
    const isIdS = c => /[A-Za-z_]/.test(c), isId = c => c && /[A-Za-z0-9_]/.test(c);
    const skipWs = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };
    const readWord = async (addr, n) => { const m = await readMem(addr & 0xFFFF, n); return n >= 2 ? ((m[0] || 0) | ((m[1] || 0) << 8)) : (m[0] || 0); };

    skipWs();
    let name = ''; while (i < s.length && isId(s[i])) name += s[i++];
    if (!name) return null;
    let cur;
    const loc = locals && locals.find(l => l.cname === name);
    if (loc) {
        const baseVal = loc.base === 'ap' ? apVal : fpVal;
        cur = { addr: (baseVal + (loc.offset | 0)) & 0xFFFF, type: loc.type, size: loc.size };
    } else {
        let addr = symbols.get(name);
        if (addr === undefined && name[0] !== '_') addr = symbols.get('_' + name);
        if (addr === undefined) return null;
        const spec = renderSpec(name) || {};
        cur = { addr: addr & 0xFFFF, type: spec.type || 'uchar', size: spec.size || 1 };
    }
    for (;;) {
        skipWs();
        if (s[i] === '.' || (s[i] === '-' && s[i + 1] === '>')) {
            const arrow = s[i] === '-'; i += arrow ? 2 : 1; skipWs();
            let fld = ''; while (i < s.length && isId(s[i])) fld += s[i++];
            let structName, structAddr;
            if (arrow) {
                if (cur.type[0] !== '*') throw new Error("'->' used on non-pointer '" + cur.type + "'");
                structName = cur.type.slice(1); structAddr = await readWord(cur.addr, 2);
            } else { structName = cur.type; structAddr = cur.addr; }
            if (!typeDefs.has(structName)) throw new Error("'" + structName + "' is not a struct");
            const f = typeDefs.get(structName).fields.find(x => x.name === fld);
            if (!f) throw new Error("no field '" + fld + "' in '" + structName + "'");
            cur = { addr: (structAddr + f.offset) & 0xFFFF, type: f.type, size: f.size };
            continue;
        }
        if (s[i] === '[') {
            i++; let depth = 1; const start = i;
            while (i < s.length && depth > 0) { if (s[i] === '[') depth++; else if (s[i] === ']') depth--; if (depth > 0) i++; }
            const idxText = s.slice(start, i);
            if (s[i] === ']') i++; else throw new Error("missing ']'");
            let elemType, baseAddr;
            if (cur.type[0] === '*') { elemType = cur.type.slice(1); baseAddr = await readWord(cur.addr, 2); }
            else {
                const am = cur.type.match(/^(.+)\[(\d+)\]$/);
                if (!am) throw new Error("cannot index non-array '" + cur.type + "'");
                elemType = am[1]; baseAddr = cur.addr;
            }
            const stride = ctypeSizeOf(elemType);
            if (!stride) throw new Error("unknown element size for '" + elemType + "'");
            const idxVal = await evalIndexValue(idxText, locals, fpVal, apVal);
            cur = { addr: (baseAddr + idxVal * stride) & 0xFFFF, type: elemType, size: stride };
            continue;
        }
        break;
    }
    skipWs();
    if (i < s.length) throw new Error("unexpected '" + s.slice(i) + "'");
    return cur;
}

// Evaluate an array index to a number: a literal ($hex/0x/decimal) or a variable
// whose current value is read from memory.
async function evalIndexValue(text, locals, fpVal, apVal) {
    const t = text.trim();
    let m;
    if ((m = t.match(/^(?:\$|0x)([0-9a-fA-F]+)$/i))) return parseInt(m[1], 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const lv = await evalAccess(t, locals, fpVal, apVal);
    if (!lv) throw new Error("index '" + t + "' is not a number or variable");
    const w = lv.type[0] === '*' ? 2 : (lv.size <= 2 ? lv.size : 2);
    const m2 = await readMem(lv.addr, w);
    return w >= 2 ? ((m2[0] || 0) | ((m2[1] || 0) << 8)) : (m2[0] || 0);
}

// Pull the variable-access expressions out of a C source line for the Current
// Instruction panel: each maximal identifier + .member/->member/[index] chain,
// plus any bare identifier used as an array index. Non-variables (macros, field
// names, function calls) are filtered later by evalAccess returning null. String
// and char literals are blanked first so their contents aren't matched. Deduped,
// source order.
function extractLineExprs(line) {
    const clean = line.replace(/"(\\.|[^"\\])*"/g, '""').replace(/'(\\.|[^'\\])*'/g, "''");
    const seen = new Set(), out = [];
    const add = e => { e = e.replace(/\s+/g, ''); if (e && !seen.has(e)) { seen.add(e); out.push(e); } };
    let m;
    const CHAIN = /[A-Za-z_]\w*(?:\s*(?:\.\w+|->\w+|\[[^\][]*\]))*/g;
    while ((m = CHAIN.exec(clean))) {
        if (clean[CHAIN.lastIndex] === '(') continue;   // a function call, not a variable
        add(m[0]);
    }
    const IDX = /\[([^\][]*)\]/g;
    while ((m = IDX.exec(clean))) { let im; const ID = /[A-Za-z_]\w*/g; while ((im = ID.exec(m[1]))) add(im[0]); }
    return out;
}

// Attach a VS Code breakpoint condition / hit target to a JUST-ARMED stub
// breakpoint at addr. C globals in the expression are resolved to memory reads
// here; the stub then compiles it with the SAME cond_compile the monitor uses
// (no duplicated JS compiler). A bad expression comes back as "E cond: <msg>",
// which we surface. Nothing to send when unconditional — arming already cleared
// the slot's condition. Returns an error string or null.
async function sendCond(addr, condExpr, hitTarget) {
    if (!condExpr && !hitTarget) return null;
    let sendExpr = condExpr;
    if (condExpr) {
        const func = currentFunction(addr);
        const locals = func ? localDefs.get(func) : null;
        const r = resolveCondSymbols(condExpr, locals, symbols.get('fp'), symbols.get('ap'));
        if (r.error) { log('condition "' + condExpr + '" rejected: ' + r.error); return r.error; }
        sendExpr = r.expr;
    }
    const hex = sendExpr ? Buffer.from(sendExpr, 'utf8').toString('hex') : '';
    const r = await gdbCmd('qOricCond,' + (addr & 0xFFFF).toString(16) + ',' + ((hitTarget || 0)).toString(16) + ',' + hex);
    if (typeof r === 'string' && r.indexOf('E cond:') === 0) {
        const msg = r.slice(7).trim();
        log('condition "' + condExpr + '" rejected: ' + msg);
        return msg;
    }
    return null;
}

// Attach a condition to a JUST-ARMED watchpoint at addr (data-breakpoint analogue
// of sendCond). A watchpoint isn't tied to a function frame, so there's no local
// context — only globals / registers / memory resolve. The stub compiles the
// expression (qOricWatchCond) with the SAME cond_compile the exec path uses.
// For a WRITE watch the condition runs before the store commits, so "A == $10"
// tests the value being written. Returns an error string or null.
async function sendWatchCond(addr, condExpr) {
    if (!condExpr) return null;
    const r = resolveCondSymbols(condExpr, null, symbols.get('fp'), symbols.get('ap'));
    if (r.error) { log('watch condition "' + condExpr + '" rejected: ' + r.error); return r.error; }
    const hex = Buffer.from(r.expr, 'utf8').toString('hex');
    const rr = await gdbCmd('qOricWatchCond,' + (addr & 0xFFFF).toString(16) + ',' + hex);
    if (typeof rr === 'string' && rr.indexOf('E cond:') === 0) {
        const msg = rr.slice(7).trim();
        log('watch condition "' + condExpr + '" rejected: ' + msg);
        return msg;
    }
    return null;
}

// Arm a VALUE watch (qOricWatchVal): stop when the byte at `addr` changes and `condExpr`
// holds, tested against real committed memory — fires no matter HOW it changed (STA/STX/
// STY/INC/DMA/…), unlike the pre-store Z2 write-watch. The condition is resolved the SAME
// way as sendWatchCond (C names → memory reads, enum constants → values). This is the
// "wait until a variable holds a value" primitive used by scripted automation (waitFor).
async function sendWatchVal(addr, condExpr) {
    let hex = '';
    if (condExpr) {
        const r = resolveCondSymbols(condExpr, null, symbols.get('fp'), symbols.get('ap'));
        if (r.error) { log('value-watch condition "' + condExpr + '" rejected: ' + r.error); return r.error; }
        hex = Buffer.from(r.expr, 'utf8').toString('hex');
    }
    const rr = await gdbCmd('qOricWatchVal,' + (addr & 0xFFFF).toString(16) + ',' + hex);
    if (typeof rr === 'string' && rr.indexOf('E cond:') === 0) {
        const msg = rr.slice(7).trim();
        log('value-watch condition "' + condExpr + '" rejected: ' + msg);
        return msg;
    }
    return null;
}
async function clearWatchVal(addr) { await gdbCmd('qOricWatchValClr,' + (addr & 0xFFFF).toString(16)); }

// --- Watchpoint events (arm / disarm / scope / lookup) ------------------------
function accessZType(access) { return access === 'read' ? '3' : access === 'readWrite' ? '4' : '2'; }
// A watchpoint is live when enabled AND its module is active (resident 'R' / null = ANY,
// or the currently active overlay) — same gating rule as exec breakpoints.
function watchDesired(ev) {
    if (ev.enabled === false) return false;
    return ev.module == null || ev.module === 'R' || ev.module === activeModuleId;
}
async function armWatch(ev) {
    const z = accessZType(ev.access);
    let ok = true;
    for (let k = 0; k < (ev.size || 1); k++) {          // a size>1 var arms one watch per byte
        const a = (ev.addr + k) & 0xFFFF;
        const r = await gdbCmd('Z' + z + ',' + a.toString(16) + ',1');
        if (r !== 'OK') ok = false;
    }
    ev.armed = ok;
    if (ok && ev.condition) await sendWatchCond(ev.addr, ev.condition);  // condition on the base byte
    return ok;
}
async function disarmWatch(ev) {
    const z = accessZType(ev.access);
    for (let k = 0; k < (ev.size || 1); k++)
        await gdbCmd('z' + z + ',' + ((ev.addr + k) & 0xFFFF).toString(16) + ',1');
    ev.armed = false;
}
// Watchpoint events covering `addr` for an access of `type` (write|read|access).
function watchEventsAt(addr, type) {
    return watchEvents.filter(ev => ev.armed && addr >= ev.addr && addr < ev.addr + (ev.size || 1) &&
        (type === 'write' ? ev.access !== 'read' : type === 'read' ? ev.access !== 'write' : true));
}

// Check if any user-set breakpoint is armed (live in the stub) at this address.
// Disarmed source breakpoints (inactive overlay module) don't count.
function isBreakpointAt(addr) {
    for (const [, bp] of bps)  { if (bp.addr === addr) return true; }
    for (const [, bp] of ibps) { if (bp.addr === addr) return true; }
    for (const [, arr] of srcBps) { for (const bp of arr) { for (const b of bp.bindings) if (b.addr === addr && b.armed) return true; } }
    return false;
}

// Is a snapped source line executable code? Movement actions (run-to / jump /
// turbo) on a DATA line are traps: the breakpoint never hits, or the PC lands
// inside storage. Judged from the SNAP's own kind — the requested file's
// intent — NOT resolve(addr).kind: at an aliased address (the $FD40 case) the
// canonical owner can be another unit's code while this file's line is data.
// C/H lines always count as code — a C statement is not a 6502 mnemonic and C
// emits many instructions per line, so both classifiers misread them.
function executableSnap(snap, file) {
    if (/\.[ch]$/i.test(file || '')) return true;
    return !!snap && snap.kind === 'code';
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
// Nearest ROM symbol at-or-below `addr` → { name, offset }, or null. No distance
// cap: ROM is code, so the enclosing routine owns everything up to the next symbol.
function resolveRomSym(addr) {
    addr &= 0xFFFF;
    if (romSymAddrs.length === 0) return null;
    let lo = 0, hi = romSymAddrs.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (romSymAddrs[mid] <= addr) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best < 0) return null;
    const s = romSymbols[best];
    return { name: s.name, offset: addr - s.addr };
}

// Render a { name, offset } symbol hit as "name+$off" ("name" when offset 0). One place
// so every label (disassembly, call stack, annotations) formats the offset identically.
function fmtSymOff(sym) {
    return sym.offset ? sym.name + '+$' + sym.offset.toString(16).toUpperCase() : sym.name;
}

// Render an address as a ROM "name+$off" label if a ROM symbol covers it, else null.
function romLabelFor(addr) {
    const rs = resolveRomSym(addr);
    return rs ? fmtSymOff(rs) : null;
}

// ROM symbol name only when one sits EXACTLY at `addr` (a routine entry), for the
// disassembly's label column — matches how build labels are shown (exact-match).
function romExactName(addr) {
    const rs = resolveRomSym(addr);
    return (rs && rs.offset === 0) ? rs.name : null;
}

// Fetch Oricutron's ROM symbol table (romsyms, auto-loaded from <romfile>.sym for
// the active machine) via the paged qOricRomSyms query and index it. Best-effort and
// non-fatal: an old stub replies with an empty/unknown packet and we just leave
// romSymbols empty, so ROM frames stay bare "$addr" exactly as before.
async function loadRomSymbols() {
    romSymbols = []; romSymAddrs = [];
    try {
        let start = 0, guard = 0;
        for (;;) {
            const reply = await gdbCmd('qOricRomSyms,' + start);
            if (!reply || reply.slice(0, 3) !== 'RS:') { romSymbols = []; break; } // unsupported / error
            // Format: RS:<total>:<next>:aaaa=name,aaaa=name,...
            const c1 = reply.indexOf(':', 3);
            const c2 = reply.indexOf(':', c1 + 1);
            if (c1 < 0 || c2 < 0) break;
            const total = parseInt(reply.slice(3, c1), 10);
            const next = parseInt(reply.slice(c1 + 1, c2), 10);
            const body = reply.slice(c2 + 1);
            if (body) {
                for (const pair of body.split(',')) {
                    const eq = pair.indexOf('=');
                    if (eq < 0) continue;
                    const addr = parseInt(pair.slice(0, eq), 16);
                    const name = pair.slice(eq + 1);
                    if (!isNaN(addr) && name) romSymbols.push({ addr: addr & 0xFFFF, name });
                }
            }
            if (!(next > start) || next >= total || ++guard > 10000) break; // done / no progress
            start = next;
        }
        romSymbols.sort((a, b) => a.addr - b.addr);
        romSymAddrs = romSymbols.map(s => s.addr);
        if (romSymbols.length) log('Loaded ' + romSymbols.length + ' ROM symbols from Oricutron');
    } catch (e) {
        romSymbols = []; romSymAddrs = [];
    }
}

function labelFor(addr) {
    addr &= 0xFFFF;
    const r = resolverInstance ? resolverInstance.resolve(addr) : null;
    if (r && r.symbol)
        return fmtSymOff(r.symbol);
    return '$' + addr.toString(16).toUpperCase().padStart(4, '0');
}

// The routine base (owner entry address) that contains `addr`, from build symbols
// first (active-module view) then ROM symbols, or null when nothing owns it.
function routineBaseOf(addr) {
    addr &= 0xFFFF;
    const r = resolverInstance ? resolverInstance.resolve(addr) : null;
    if (r && r.symbol) return r.symbol.base & 0xFFFF;
    const rs = resolveRomSym(addr);
    if (rs) return (addr - rs.offset) & 0xFFFF;
    return null;
}

// True when `addr` is EXACTLY a routine entry (a symbol sits right there), build
// symbol or ROM symbol. A real `JSR foo` targets foo's entry; that's the signal we
// use to tell a genuine return address from stack garbage.
function isCallTarget(addr) {
    return routineBaseOf(addr & 0xFFFF) === (addr & 0xFFFF);
}

// Walk the hardware stack (page 1) and identify JSR return addresses.
//
// JSR pushes (PC+2) — the last byte of the JSR — so a return address is
// (stack word) + 1 and the JSR itself is 3 bytes before it. Scanning the raw stack
// for that pattern gives false positives: deep in a routine the stack is full of
// PHA/PHP saves and locals that coincidentally point 3 bytes past a $20.
//
// Discriminator: a genuine return address sits right after `JSR <entry>`, i.e. the
// call targets a KNOWN routine's exact entry (isCallTarget). Garbage 2-byte stack
// values rarely point 3 bytes past a $20 whose operand is exactly a symbol, so this
// drops them — while keeping real frames even across JMP trampolines (putchar2 →
// $238 → JMP Char2Scr): the still-valid caller chain on the stack (putsloop, _main,
// DoNextLine) all sit after JSRs to known entries and survive; the bogus $3101 /
// SGN+$1D / $3710 frames don't. Chain-consistency isn't used (trampolines break it).
// A fully source-less program (no symbols at all) yields only the top frame; the
// reverse-engineering mode will add manual symbols to recover deeper frames.
async function buildCallStack() {
    if (!regs || regs.sp === undefined) return [];

    const sp = regs.sp;
    const stackSize = 0xFF - sp;
    if (stackSize < 2) return [];

    // Read stack bytes — uses readMem (which has per-stop dedup cache)
    const stackAddr = 0x0100 + sp + 1;
    const readSize = Math.min(stackSize, 64);
    const stk = await readMem(stackAddr, readSize);

    // Read + cache the 3 bytes at a JSR site (opcode + operand). Real return
    // addresses point across the whole map (RAM C code AND ROM), so a single bulk
    // range read isn't viable at a trampoline — verify each site on demand instead
    // (readMem dedups, so repeats are cheap).
    const jsrCache = new Map();
    async function jsrAt(a) {
        a &= 0xFFFF;
        if (jsrCache.has(a)) return jsrCache.get(a);
        const m = await readMem(a, 3);
        const v = (m && m.length >= 3) ? { op: m[0], target: ((m[2] << 8) | m[1]) & 0xFFFF } : null;
        jsrCache.set(a, v);
        return v;
    }

    // Greedy scan: accept a slot only when it's the return of a `JSR <known entry>`.
    const frames = [];
    let pos = 0;
    while (pos + 1 < stk.length && frames.length < 32) {
        const retAddr = (((stk[pos + 1] << 8) | stk[pos]) + 1) & 0xFFFF;
        let accept = false;
        if (retAddr > 0x01FF && retAddr < 0xFFF0) {
            const j = await jsrAt((retAddr - 3) & 0xFFFF);
            if (j && j.op === 0x20 && isCallTarget(j.target)) accept = true;
        }
        if (accept) {
            frames.push(retAddr);
            pos += 2;
        } else {
            pos += 1;                                 // skip a byte (PHA/PHP or non-return data)
        }
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

// Connect to the emulator's GDB stub (with retries), do the initial `?` handshake,
// then respond to `req` and fire 'initialized'. Shared by launch/attach/relaunch.
// Returns true on success; on failure returns false WITHOUT responding, so each
// caller can add its own cleanup + failure message.
// Base name shown in the emulator window title. Set on connect; the AI-piloting
// overlay (setEmulatorPiloting) appends to it, so the base lives in one place.
let emuBaseTitle = 'Oricutron';

// The program name to show in the emulator window title. Prefers the built
// program's name — the disk/tap basename, which for OSDK is OSDKNAME (e.g. DBGZOO) —
// else an explicit diskImage, else the project-dir basename. Applied post-connect
// via qOricTitle, so it works for both launch paths (OSDK script + direct emulatorPath).
function projectTitle() {
    const artifact = resolvedTarget || launchArtifactPath || config.diskImage;
    if (artifact) {
        const b = path.basename(String(artifact), path.extname(String(artifact)));
        if (b) return b;
    }
    const dir = config.cwd || (config.build && config.build.cwd) || config.workspaceFolder ||
                (config.symbolFile && path.dirname(config.symbolFile)) || process.cwd();
    const name = path.basename(String(dir).replace(/[\\/]+$/, ''));
    return name || 'Oricutron';
}

async function connectAndHandshake(req) {
    const host = config.host || 'localhost';
    const port = config.port || 6502;
    const retries = config.connectRetries || 10;
    const retryDelay = config.connectRetryDelay || 1000;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            await gdbConnect(host, port);
            emuPid = (launchedProcess && launchedProcess.pid) || pidsOnPort(port)[0] || null;
            log('Connected to Oricutron at ' + host + ':' + port + ' (pid ' + (emuPid || '?') + ')');
            writeEmuPidFile(emuPid);   // persist so the next session can kill it if we're hard-terminated (window reload)
            const reply = await gdbCmd('?');
            log('GDB ? reply: ' + (reply || '(null)'));
            if (reply) {
                regs = parseStopRegs(reply);
                log('Parsed regs: PC=$' + (regs.pc !== undefined ? regs.pc.toString(16).toUpperCase().padStart(4, '0') : '??'));
            }
            await loadRomSymbols();   // name ROM addresses the build symbols don't cover (best-effort)
            startMonitorBpPoll();     // pick up hand-set monitor breakpoints while stopped
            // Time-travel history: size the ring so reverse-stepping works from VS Code.
            // Budget from launch cfg historyBudgetMB (default 64MB; set 0 to disable).
            histBudgetKB = ((config.historyBudgetMB != null ? config.historyBudgetMB : 64) * 1024) | 0;
            histEnabled = histBudgetKB > 0;
            try { await gdbCmd('qOricHistConfig,' + histBudgetKB); } catch (e) { /* old stub: no history */ }
            // Put the debugged program's name (e.g. DBGZOO) in the emulator window
            // title/taskbar. No-op on an older stub (qOricTitle unknown).
            emuBaseTitle = projectTitle();
            try { await gdbCmd('qOricTitle,' + Buffer.from(emuBaseTitle, 'utf8').toString('hex')); } catch (e) { /* old stub: no title cmd */ }
            respond(req);
            evt('initialized');
            // NOTE: we deliberately do NOT advertise supportsStepBack. VS Code's native
            // Step Back / Reverse buttons are "step"-flavoured and can't be relabeled;
            // instead the extension contributes custom Replay Rewind / Forward / to-Head
            // toolbar buttons (custom requests oricReplayRewind/Forward/ToHead below),
            // gated on the oric.canRewind / oric.canReplayForward context keys it sets from
            // qOricHistStatus. history navigation is non-destructive (redo-capable ring).
            return true;
        } catch (e) {
            if (attempt < retries) {
                if (attempt === 0) log('Waiting for Oricutron on ' + host + ':' + port + '...');
                await new Promise(r => setTimeout(r, retryDelay));
            }
        }
    }
    return false;
}

// Notify the extension that the address-breakpoint set changed, carrying the full
// current list so it can refresh the panel/dots AND persist it without a round-trip.
function fireAddrBps() {
    evt('oricAddressBreakpoints', { breakpoints: [...addrBps.values()].map(b => ({ address: b.addr, enabled: b.enabled })) });
}

// Push the current machine state onto the emulator's history ring before a
// user-visible FORWARD step, so Replay Rewind can return to it. No-op when
// history is disabled. Called only at the user step-request entry — NOT on the
// adapter's internal transparent steps (module-watch, step-over temp bp), which
// would over-capture. When the ring cursor is parked in the past, this is also
// what discards the diverged "future" (handled emulator-side in hist_push).
async function histPush() {
    if (histEnabled) { try { await gdbCmd('qOricHistPush'); } catch (e) { /* ignore */ } }
}

// Shared replay navigation: send a qOricHist{Back,Forward} command and, on a T05
// stop reply, adopt the restored registers, resync breakpoints, and emit a
// 'stopped' event so VS Code refreshes. A non-'T' reply ("E hist: nothing …")
// means the cursor was already at an end — we still emit 'stopped' to re-sync the
// UI at the current location. Returns true if the cursor actually moved.
async function histNav(gdbHistCmd) {
    let moved = false;
    if (histEnabled) {
        const reply = await gdbCmd(gdbHistCmd);
        if (typeof reply === 'string' && reply[0] === 'T') {
            regs = parseStopRegs(reply);
            running = false;
            await resyncStubBreakpoints();
            moved = true;
        }
    }
    evt('stopped', { reason: 'step', threadId: 1, allThreadsStopped: true });
    return moved;
}

// Full relaunch from within the restart handler: kill the current emulator,
// re-spawn (same as launch's Step 2a/2b) and reconnect (Step 3). Used when the
// binary changed — a hard reset can't reload a tape program, and terminated{restart}
// loops back into restart while spawning a second emulator. Mirrors launch so a
// rebuild-restart behaves exactly like a fresh Start. Responds to `req` itself.
async function relaunchEmulator(req) {
    const host = config.host || 'localhost';
    const port = config.port || 6502;

    // Tear down. `disconnecting` guards the socket-close handler from firing a stray
    // 'terminated' (which would end the whole session mid-relaunch).
    disconnecting = true;
    if (sock) { try { gdbWrite('D'); } catch (_) { /* ignore */ } try { sock.destroy(); } catch (_) { /* ignore */ } sock = null; }
    if (scriptLaunched) { killByPort(port); scriptLaunched = false; }
    else if (launchedProcess) { try { launchedProcess.kill(); } catch (_) { /* ignore */ } launchedProcess = null; }
    running = false; configDone = false; pendingStop = null; regs = null;
    awaitingEntry = false; moduleByteTrusted = false; baselineReady = false;
    await new Promise(r => setTimeout(r, 700));   // let the old emulator release the gdb port
    disconnecting = false;

    // Re-spawn (mirror launch Step 2a/2b).
    if (config.launchScript) {
        const scriptCwd = config.cwd || (config.build && config.build.cwd) || process.cwd();
        const osdkEnv = await harvestOsdkConfig(scriptCwd);
        const entry = (config.gdbBreak || osdkEnv.OSDKADDR || '').toString().trim().replace(/^\$/, '').replace(/^0x/i, '');
        initBreakAddr = /^[0-9a-fA-F]+$/.test(entry) ? parseInt(entry, 16) & 0xffff : -1;
        entryAddr = initBreakAddr;
        if (await probePort(host, port)) { respond(req, {}, false, 'gdb port ' + port + ' still in use after relaunch — close the old Oricutron and retry'); return; }
        const launchEnv = { OSDKGDBPORT: String(port) };
        if (initBreakAddr >= 0) launchEnv.OSDKGDBBREAK = initBreakAddr.toString(16);
        log('Relaunching via ' + config.launchScript + ' (gdb port ' + port + (initBreakAddr >= 0 ? ', entry $' + initBreakAddr.toString(16) : '') + ')');
        const runner = spawnOsdk(config.launchScript, { cwd: scriptCwd, env: launchEnv });
        if (runner.stdout) runner.stdout.on('data', d => evt('output', { category: 'stdout', output: d.toString() }));
        if (runner.stderr) runner.stderr.on('data', d => evt('output', { category: 'stderr', output: d.toString() }));
        runner.on('error', err => log('Relaunch script failed to start: ' + err.message));
        scriptLaunched = true;
    } else if (config.emulatorPath) {
        const relaunchMedia = resolvedDiskMedia();
        if (!relaunchMedia) {
            respond(req, {}, false, 'No disk image to load on relaunch: "diskImage" is unset and no .dsk was found under build/. ' +
                'Build the project, or set "diskImage" in launch.json.');
            return;
        }
        const emuArgs = [relaunchMedia, '--gdb_port', String(port), '-s', 'symbols', ...(config.emulatorArgs || [])];
        const emuCwd = config.emulatorCwd || path.dirname(config.emulatorPath);
        log('Relaunching: ' + config.emulatorPath + ' ' + emuArgs.join(' '));
        launchedProcess = child_process.spawn(config.emulatorPath, emuArgs, { cwd: emuCwd, detached: false, windowsHide: false });
        launchedProcess.on('close', (code) => { launchedProcess = null; if (!disconnecting) { log('Emulator exited (code ' + code + ')'); evt('terminated'); } });
        if (launchedProcess.stdout) launchedProcess.stdout.on('data', d => evt('output', { category: 'stdout', output: d.toString() }));
        if (launchedProcess.stderr) launchedProcess.stderr.on('data', d => evt('output', { category: 'stderr', output: d.toString() }));
    } else {
        respond(req, {}, false, 'Cannot relaunch: launch config has no launchScript or emulatorPath'); return;
    }

    // Reconnect + handshake (shared with launch/attach).
    if (!await connectAndHandshake(req))
        respond(req, {}, false, 'Could not reconnect to Oricutron after relaunch');
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
            // Conditions/hit-counts are evaluated natively inside Oricutron (the
            // cond bytecode VM), so no per-hit debugger round-trip. VS Code will
            // grey out "Edit Breakpoint > Expression/Hit Count" unless these are
            // advertised here.
            supportsConditionalBreakpoints: true,
            supportsHitConditionalBreakpoints: true,
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
        if (config.showBinary !== undefined) showBinary = !!config.showBinary; // seed from the VS Code setting
        applyLogLevel(logLevel, true); // reflect the initial level in the status bar (don't re-persist)
        const host = config.host || 'localhost';
        const port = config.port || 6502;

        if (config.symbolFile) loadSymbols(config.symbolFile);

        if (!await connectAndHandshake(req))
            respond(req, {}, false, 'Could not connect to ' + host + ':' + port + ' — is Oricutron running with --gdb_port?');
    },

    async launch(req) {
        config = req.arguments || {};
        disconnecting = false; // reset — a reused adapter process (e.g. after a terminated{restart} relaunch) must not start a launch in the disconnecting state
        logSessionBanner();
        moduleByteTrusted = false; // fresh boot — don't believe the module byte until the loader stamps it
        if (config.logLevel !== undefined) logLevel = config.logLevel;
        if (config.showBinary !== undefined) showBinary = !!config.showBinary; // seed from the VS Code setting
        applyLogLevel(logLevel, true); // reflect the initial level in the status bar (don't re-persist)
        const port = config.port || 6502;

        // Kill any emulator orphaned by a previous session of this project (e.g. a window
        // reload hard-killed the old adapter before it could clean up). Must run before we
        // spawn a new one, so reloads can't accumulate stray Oricutron windows.
        reclaimOrphanEmulator();

        if (config.symbolFile) loadSymbols(config.symbolFile);
        // Re-resolve existing breakpoints against the freshly-loaded symbols so a
        // rebuild that changed line info (e.g. toggling -g1) is reflected in the UI
        // and in which addresses are actually armed. (VS Code does not re-send
        // setBreakpoints on a fresh launch for unchanged breakpoints.)
        if (config.symbolFile) await revalidateBreakpointsAfterSymbolLoad();

        // Hash the disk image now, so a later `reloadsymbols` can tell a
        // byte-identical rebuild (safe to reload symbols in place) from a real
        // rebuild (emulator holds a stale binary — needs a relaunch).
        // Artifact whose checksum decides snapshot validity: the disk image if set,
        // else the build output (e.g. the .tap that actually gets loaded — OSDK tape
        // projects have no diskImage). Without this the hash is null and snapshot
        // invalidation is inert. (Assigned after Step 1, once resolvedTarget is
        // known — see below.)
        launchArtifactPath = null;
        launchArtifactHash = null;

        // --- Step 1: Build if stale ---
        // Resolve the target artifact once: explicit output/diskImage if set,
        // else auto-detected from build/ (newest .dsk, else newest .tap). This
        // lets a generic template omit output/diskImage entirely; the build is
        // the source of truth, so we scan what it produced.
        const buildCwdHint = (config.build && config.build.cwd) || config.cwd || process.cwd();
        const buildDir = path.join(buildCwdHint, 'build');
        resolvedTarget = resolveBuildArtifact(
            config.diskImage || (config.build && config.build.output),
            buildDir
        );

        if (config.build) {
            const buildCmd    = config.build.command;
            const buildCwd    = config.build.cwd;
            const staleOpts   = {
                extensions: config.build.extensions,
                exclude:    config.build.exclude
            };

            if (buildCmd) {
                // checkStale treats a missing/null output as stale (statSync fails),
                // so a generic template with no output builds on first launch, then
                // we re-scan below to pick up whatever the build produced.
                const stale = checkStale(resolvedTarget, config.build.sources, staleOpts);
                if (stale) {
                    log('Build is stale, running ' + buildCmd + '...');
                    try {
                        await runBuild(buildCmd, buildCwd);
                        log('Build succeeded.');
                    } catch (e) {
                        respond(req, {}, false, e.message);
                        return;
                    }
                    // Re-resolve: the build may have produced an artifact we
                    // couldn't see before (first launch, or a renamed output).
                    if (!resolvedTarget) {
                        const after = resolveBuildArtifact(null, buildDir);
                        if (after) { resolvedTarget = after; log('Detected build output: ' + after); }
                    }
                } else {
                    log('Build is up to date.');
                }
            }
        }

        // Now that resolvedTarget is final (post any rebuild + re-scan), set the
        // artifact path/hash used for snapshot-invalidation and reloadsymbols.
        launchArtifactPath = resolvedTarget;
        launchArtifactHash = launchArtifactPath ? hashFile(launchArtifactPath) : null;

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
            entryAddr = initBreakAddr;   // preserve it — restart re-arms from here (initBreakAddr is cleared once hit)
            if (initBreakAddr < 0)
                log('No entry address (OSDKADDR/gdbBreak) — launching without an initial breakpoint; may miss the entry.');

            if (await probePort(config.host || 'localhost', port)) {
                const { foreign, free } = await reclaimStaleEmulator(port, config.host);
                if (foreign || !free) {
                    respond(req, {}, false, 'gdb port ' + port + ' is already in use by another process — ' +
                        'close it (or change "port" in launch.json) and retry.');
                    return;
                }
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
            // Guard: if something already listens on the gdb port, a stale emulator owns
            // it. Spawning another would fail to bind and we'd silently attach to the OLD
            // emulator (fresh symbols vs stale code). Reclaim our own stale Oricutron; only
            // refuse if a NON-Oricutron process holds the port.
            if (!isNoDebug && await probePort(config.host || 'localhost', port)) {
                const { foreign, free } = await reclaimStaleEmulator(port, config.host);
                if (foreign || !free) {
                    respond(req, {}, false, 'gdb port ' + port + ' is already in use by another process — ' +
                        'close it (or change "port" in launch.json) and retry.');
                    return;
                }
            }
            // Guard: direct-launch (emulatorPath) needs media to load. If neither
            // diskImage nor an auto-detected .dsk resolved, don't launch Oricutron with
            // 'undefined' as the media arg — report a clear error instead. (Tape projects
            // use the launchScript path, not this branch.)
            const loadMedia = resolvedDiskMedia();
            if (!loadMedia) {
                respond(req, {}, false, 'No disk image to load: "diskImage" is unset and no .dsk was found under build/. ' +
                    'Build the project, or set "diskImage" in launch.json.');
                return;
            }
            const emuArgs = isNoDebug
                ? [loadMedia, '-s', 'symbols', ...(config.emulatorArgs || [])]
                : [loadMedia, '--gdb_port', String(port), '-s', 'symbols', ...(config.emulatorArgs || [])];
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

        // --- Step 3: Connect GDB + handshake (shared with attach/relaunch) ---
        const host = config.host || 'localhost';
        if (await connectAndHandshake(req)) return;
        // Total connect failure: kill the emulator we spawned so it doesn't linger and
        // own the port for the next launch (which would then attach to this stale one).
        if (launchedProcess) {
            try { launchedProcess.kill(); } catch (_) { /* ignore */ }
            launchedProcess = null;
        } else if (scriptLaunched) {
            killByPort(config.port || 6502);
        }
        respond(req, {}, false, 'Could not connect to ' + host + ':' + (config.port || 6502) +
            ' — is Oricutron running with --gdb_port?');
    },

    configurationDone(req) {
        configDone = true;
        respond(req);

        // Arm the hidden module-load watch before any free-run so overlay switches
        // are caught from the very first run. Queued ahead of the continue below
        // (whenGdbIdle waits for the Z2 to complete first).
        armModuleWatch();

        // Instant restart via baseline snapshot: the machine is restored AT the entry
        // (osdk_start), exactly where launch's entry-hit leaves it. Mirror what launch
        // does next — stop at entry only if stopOnEntry, otherwise continue and run to
        // the first breakpoint (e.g. main), so Restart lands where a fresh start does.
        // Breakpoints were re-sent above and reconciled against the restored set.
        if (restartViaSnapshot) {
            restartViaSnapshot = false;
            if (config.stopOnEntry) {
                log('configurationDone: restored baseline — stop at entry');
                evt('stopped', { reason: 'entry', threadId: 1, allThreadsStopped: true });
            } else {
                log('configurationDone: restored baseline — running to first breakpoint');
                whenGdbIdle(() => { running = true; gdbWrite('c'); });
            }
            return;
        }

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
        // Same resolution as launch: explicit output/diskImage if set, else
        // auto-detected from build/ (newest .dsk, else newest .tap).
        let rebuilt = false;
        const buildCwdHint = (config.build && config.build.cwd) || config.cwd || process.cwd();
        const buildDir = path.join(buildCwdHint, 'build');
        resolvedTarget = resolveBuildArtifact(
            config.diskImage || (config.build && config.build.output),
            buildDir
        );

        if (config.build) {
            const buildCmd    = config.build.command;
            const buildCwd    = config.build.cwd;
            const staleOpts   = {
                extensions: config.build.extensions,
                exclude:    config.build.exclude
            };

            if (buildCmd) {
                const stale = checkStale(resolvedTarget, config.build.sources, staleOpts);
                if (stale) {
                    log('Build is stale, running ' + buildCmd + '...');
                    try {
                        await runBuild(buildCmd, buildCwd);
                        log('Build succeeded.');
                        rebuilt = true;
                    } catch (e) {
                        respond(req, {}, false, 'Rebuild failed: ' + e.message);
                        return;
                    }
                    if (!resolvedTarget) {
                        const after = resolveBuildArtifact(null, buildDir);
                        if (after) { resolvedTarget = after; log('Detected build output: ' + after); }
                    }
                } else {
                    log('Build is up to date.');
                }
            }
        }
        // Keep the artifact path AND hash in step with the (possibly rebuilt)
        // target — otherwise a later reloadsymbols compares against the previous
        // build's hash and misjudges a real rebuild as byte-identical.
        launchArtifactPath = resolvedTarget;
        launchArtifactHash = launchArtifactPath ? hashFile(launchArtifactPath) : null;

        // --- Step 2: Reload symbols ---
        if (config.symbolFile) {
            loadSymbols(config.symbolFile);
            // Re-resolve existing breakpoints against the new symbols (same reason
            // as launch: a rebuild may have changed what can bind).
            await revalidateBreakpointsAfterSymbolLoad();
        }

        configDone = false;
        pendingStop = null;
        running = false;

        // Binary changed? (rebuilt in Step 1, or an external rebuild — re-hash the
        // disk image and compare to what the snapshots were taken against.) If so,
        // every snapshot holds the OLD program's RAM and is unusable — discard them
        // all and force the hard-reset path (which reloads the new binary).
        let binaryChanged = rebuilt;
        if (launchArtifactPath) {
            const nowHash = hashFile(launchArtifactPath);
            if (nowHash && nowHash !== launchArtifactHash) { binaryChanged = true; launchArtifactHash = nowHash; }
        }
        if (binaryChanged) {
            // The entry baseline is the OLD build's state — invalidate just that (re-captured on
            // relaunch). User snapshots are self-contained files, so they are KEPT (never
            // discarded on a rebuild).
            invalidateBaseline();
            log('Binary changed on restart — kept saved snapshots (self-contained); relaunching to load the new build');
            // A hard reset can't reload a tape program (and doesn't reliably
            // re-autoload one), so it would reboot to ROM/BASIC without the new
            // build. Do an explicit relaunch — kill this emulator and re-spawn +
            // reconnect exactly like a fresh Start — so the rebuilt media loads.
            // (terminated{restart} is NOT usable here: VS Code re-invokes restart
            // rather than launch, and spawns a second emulator without killing this
            // one.) Works for both tape and disk projects.
            await relaunchEmulator(req);
            return;
        }

        // --- Step 3a: Instant restart via the entry baseline snapshot ---
        // Same binary in RAM and a baseline captured at launch: reload it — no ROM
        // boot, no tape load. configurationDone then just stops at the restored
        // entry. Falls back to the hard reset below on any problem.
        if (scriptLaunched && baselineReady && !binaryChanged && fs.existsSync(snapshotFile(BASELINE))) {
            const r = await gdbCmd('qOricLoadSnapshot,' + Buffer.from(snapshotFile(BASELINE), 'utf8').toString('hex'));
            if (!(typeof r === 'string' && r.indexOf('E snapshot') === 0)) {
                regs = parseStopRegs(r);
                moduleByteTrusted = false;
                clearGdbReadCache();
                await resyncStubBreakpoints();   // realign the emulator's bp table with the debugger's set
                restartViaSnapshot = true;
                log('Restart via baseline snapshot (instant), PC=$' + (regs && regs.pc !== undefined ? regs.pc.toString(16).toUpperCase().padStart(4, '0') : '??'));
                respond(req);
                evt('initialized');   // VS Code re-sends breakpoints; configurationDone stops at entry
                return;
            }
            log('Baseline load failed (' + r + '); falling back to hard reset');
        }

        // --- Step 3b: Hard reset Oricutron (reloads disk + resets CPU, pauses) ---
        // Fresh boot: don't trust the resident module byte until the loader re-stamps
        // it (loadSymbols already reset activeModuleId/moduleReported). Matches launch().
        moduleByteTrusted = false;
        // Fresh boot: don't trust the resident module byte until the loader re-stamps
        // it (loadSymbols already reset activeModuleId/moduleReported). Matches launch().
        moduleByteTrusted = false;

        const reply = await gdbCmd('qOricHardReset');
        if (reply) {
            regs = parseStopRegs(reply);
            log('Hard reset complete, PC=$' + (regs.pc !== undefined ? regs.pc.toString(16).toUpperCase().padStart(4, '0') : '??'));
        }

        // Re-establish the entry breakpoint. On launch the emulator halts at the
        // program entry via --gdb_break; the reset above cleared that (and it was
        // already dropped once hit, so initBreakAddr is -1). Re-arm it and restore
        // initBreakAddr so configurationDone runs THROUGH boot/auto-CLOAD to the
        // entry (dropping it on hit) instead of leaving the machine paused at the
        // ROM reset vector with a stale screen.
        if (scriptLaunched && entryAddr >= 0) {
            initBreakAddr = entryAddr;
            awaitingEntry = false;   // set true by configurationDone's continue-to-entry branch
            await gdbCmd('Z0,' + entryAddr.toString(16) + ',1');
            log('Re-armed entry breakpoint ($' + entryAddr.toString(16) + ') for restart');
        }

        respond(req);

        // Send initialized so VS Code re-sends breakpoints, then configurationDone
        evt('initialized');
    },

    async disconnect(req) {
        disconnecting = true;
        stopMonitorBpPoll();
        if (sock) {
            gdbWrite('D'); // detach — don't wait for reply
            sock.destroy();
            sock = null;
        }
        // Kill the emulator we launched (direct child, or by-port for a detached script
        // launch). Shared with the process-exit safety nets so behaviour can't diverge.
        killLaunchedEmulator();
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
            const name = (R && R.symbol)
                ? fmtSymOff(R.symbol)
                // No build symbol here — fall back to a ROM symbol (e.g. $F785 in a
                // ROM routine) before showing a bare address.
                : (romLabelFor(addr) || '$' + addr.toString(16).toUpperCase().padStart(4, '0'));
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
            }
            // No real source (ROM / unsymbolized code): leave `source` unset so VS Code
            // does NOT auto-open a virtual "Disassembly @ $XXXX" text tab when it reveals
            // this frame (that was the intrusive window, and worse when the frame was a
            // false-positive unwind). The Oric Disassembly webview is the viewer for these;
            // the frame still carries a name + instructionPointerReference, so VS Code's own
            // Disassembly View still works if the user opens it explicitly.
            return frame;
        }

        // Frame 0: current PC
        const top = makeFrame(0, pc);
        const stackFrames = [top];

        // Walk the hardware stack to find JSR return addresses, and always show the
        // deeper frames — a JMP into ROM/page-2 (putjar → $238 → JMP Char2Scr) doesn't
        // touch the stack, so the caller chain (putsloop, _main, ...) is still valid
        // and useful. BUT when the current PC has no source (ROM/unsymbolized), VS Code
        // would auto-reveal the first DEEPER frame that HAS a source (e.g. printint in
        // printf.s) and yank the editor there on every step, making ROM tracing
        // impossible. So in that case mark the deeper frames' source `deemphasize`: they
        // stay visible in the call stack, but VS Code won't steal focus to them — the
        // Oric Disassembly webview remains the viewer for the ROM location.
        const deemphasizeDeeper = !top.source;
        const returnAddrs = await buildCallStack();
        for (let i = 0; i < returnAddrs.length; i++) {
            const f = makeFrame(i + 1, returnAddrs[i]);
            if (deemphasizeDeeper && f.source) f.source.presentationHint = 'deemphasize';
            stackFrames.push(f);
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
            // A tracked type tag (regTags) REPLACES the raw form — this is THE
            // register value rendering: the built-in Variables panel, the
            // Registers webview and the watch all read it from here, so the tag
            // shows identically everywhere (one representation, not a bolt-on row).
            const rr = (r2) => regTagStr(r2) || formatScalar('uchar', [regs[r2]], 0, 1);
            respond(req, { variables: [
                { name: 'A',  value: rr('a'), variablesReference: 0 },
                { name: 'X',  value: rr('x'), variablesReference: 0 },
                { name: 'Y',  value: rr('y'), variablesReference: 0 },
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
            // @stream expansion: one child per decoded command, at its byte offset.
            if (info.kind === 'stream') {
                const cmds = await decodeStream(info.enumName, info.addr, 16);
                const vars = cmds.map(c => ({ name: '+' + c.offset, value: streamCmdText(c, info.enumName), variablesReference: 0 }));
                if (vars.length === 0) vars.push({ name: '(empty)', value: '', variablesReference: 0 });
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
            if (snap && executableSnap(snap, srcPath)) { addr = snap.addr; if (snap.line > 0) targetLine = snap.line; }
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
        lastStopPc = addr; // PC edited in place — keep register-tag tracking coherent
        respond(req);
        evt('stopped', { reason: 'goto', threadId: 1, allThreadsStopped: true });
    },

    // -- Execution control ----------------------------------------

    async continue(req) {
        resumeMode = 'run';
        await histPush();   // record the state we're leaving (and diverge the future if parked)
        // Cycle annotation for a run→stop (native Run-to-Cursor and F5-to-breakpoint both
        // land here). Snapshot the counter unless a step/turbo already did — the next stop
        // then shows how many cycles the run took, attributed to the line we land on.
        if (stepCyclesBefore === null) await snapshotStepStart(true);
        // A data watchpoint stops ON the instruction that accessed the watched byte(s).
        // A bare 'c' would re-detect that same access and re-fire immediately (F5 stuck).
        // Step off it first — the dobp=FALSE 's' step doesn't re-trigger the watch — then
        // continue via continueAfterStep. F5 thus always advances (and may stop at the next
        // in-range access, e.g. the high byte of a 2-byte var, which is fine).
        if (stoppedOnWatch) {
            stoppedOnWatch = false;
            continueAfterStep = true;
            regs = null;
            respond(req, { allThreadsContinued: true });
            running = true;
            gdbWrite('s');
            evt('continued', { threadId: 1, allThreadsContinued: true });
            return;
        }
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
        await histPush();
        await snapshotStepStart();   // cycle-count annotation: record before-state while stopped
        const granularity = (req.arguments && req.arguments.granularity) || 'statement';
        logVerbose('next: granularity=' + granularity);
        const src = regs ? sourceFor(regs.pc) : null;
        // Source-level step-over: single-step (stepping OVER JSRs) until the source line
        // changes or we return from this function. onStopReply drives the loop. This follows
        // real execution, so it works with -O1 block reordering — unlike the old "set a temp
        // bp at the predicted next-line address" approach, which overshot to the function
        // exit when the next source line's code wasn't at the next-higher address.
        if (granularity === 'statement' && src && /\.[cC]$/i.test(src.file)) {
            stepOverInProgress = true;
            stepOverStartFile = src.file;
            stepOverStartLine = src.line;
            stepOverStartSp = (regs && regs.sp !== undefined) ? regs.sp : -1;
            stepOverBudget = 20000;   // step over can traverse a whole statement (incl. skipped calls)
            respond(req);
            await stepOverMove();     // reads regs.pc for the first move, then nulls regs + resumes
            evt('continued', { threadId: 1, allThreadsContinued: true });
            return;
        }
        regs = null;
        respond(req);
        running = true;
        gdbWrite('N');
    },

    async stepIn(req) {
        resumeMode = 'step';
        await histPush();
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

    async stepOut(req) {
        resumeMode = 'step';
        await histPush();
        await snapshotStepStart();   // annotate the cycles spent finishing this function
        regs = null;
        respond(req);
        running = true;
        gdbWrite('O');
    },

    // -- Replay navigation (time-travel history ring, REDO-capable) -------------
    // The forward handlers (continue/step) push the pre-step state; these move the
    // ring CURSOR and restore — WITHOUT discarding anything, so you can replay
    // forward again toward where you were. The recorded future is dropped only when
    // you actually execute forward while parked in the past (native to hist_push).
    // The stub's qOricHistBack/Forward reply with a T05 stop reply (treated as the
    // command's response, see stopReplyIsResponse). A restored entry carries its own
    // saved breakpoint table, so resync the stub afterwards (like a snapshot load).
    // These are custom requests driven by the extension's Replay toolbar buttons.
    async oricReplayRewind(req)  { respond(req); await histNav('qOricHistBack,1'); },
    async oricReplayForward(req) { respond(req); await histNav('qOricHistForward,1'); },
    // Jump to the head (most recent state) in one go: forward by "everything".
    async oricReplayToHead(req)  { respond(req); await histNav('qOricHistForward,4294967295'); },

    pause(req) {
        respond(req);
        if (sock) sock.write('\x03');
    },

    // -- Breakpoints ----------------------------------------------

    async setBreakpoints(req) {
        // Serialized: on a bulk enable/disable VS Code fires a burst of setBreakpoints
        // for the same file (one per removed/added bp); concurrent runs interleave the
        // disarm/re-arm and the srcBps[file] rebuild, leaving breakpoints armed at random.
        return withBpLock(async () => {
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
            const condExpr = sbp.condition || null;    // VS Code's condition string (compiled by the stub)
            const hitTarget = hitTargetOf(sbp.hitCondition);
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
                // A workspace .c file with ZERO line entries almost always means the
                // project was built without -g1: the compiler then emits no .csource
                // markers, so the .c file never appears in #FILES and gets no #LINES
                // entries (only assembly .s files do). The shared helper distinguishes
                // that from a genuinely empty line so the user gets an actionable hint.
                result.push({ id, verified: false, message: unboundBpMessage(srcPath, norm) });
                continue;
            }
            // Arm bindings for the active/resident module now; others arm on switch
            // (rearmModuleBreakpoints). armAddr is ref-counted so overlap is safe.
            let anyArmed = false, anyFail = false;
            for (const b of bindings) {
                if (b.module === 'R' || b.module === activeModuleId) {
                    b.armed = await armAddr(b.addr);
                    if (b.armed) { anyArmed = true; await sendCond(b.addr, condExpr, hitTarget); }
                    else anyFail = true;
                }
            }
            // Location context for the native Breakpoints panel's hover — it has
            // no function/address column, so put "func+$off ($addr)" in the message
            // (shown in the breakpoint's tooltip). Prefer the active/resident binding.
            const dispBind = bindings.find(b => b.module === 'R' || b.module === activeModuleId) || bindings[0];
            const hex = '$' + (dispBind.addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
            const lbl = labelFor(dispBind.addr);
            const where = (lbl === hex ? hex : lbl + ' (' + hex + ')');
            const status = anyFail ? 'failed to arm (Oricutron breakpoint table full?)'
                : (!activeInFile ? 'inactive module (' + owners.map(m => moduleNames.get(m) || m).join('/') + ') — binds when it loads' : '');
            const message = status ? where + ' — ' + status : where;
            // Resolution snaps to the nearest #LINES entry. A FORWARD snap (to the
            // next code line) is useful feedback, but a BACKWARD snap — no entry at
            // or after the requested line, so it fell to an earlier one — reports a
            // misleading earlier line (e.g. a bp on 262 shown as 256/void main) even
            // though it binds and fires correctly at the requested code. Keep the
            // requested line in that case.
            const shownLine = (dispLine >= reqLine) ? dispLine : reqLine;
            // logMessage (VS Code "Logpoint"): this bp doesn't stop — on hit it
            // prints the interpolated message and resumes (see onStopReply).
            newBps.push({ id, line: shownLine, source: args.source, bindings, logMessage: sbp.logMessage || null, condExpr, hitTarget });
            result.push({ id, verified: anyArmed, line: shownLine, source: args.source, message });
        }
        srcBps.set(norm, newBps);
        respond(req, { breakpoints: result });
        });
    },

    async setFunctionBreakpoints(req) {
      return withBpLock(async () => {
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
      });
    },

    setExceptionBreakpoints(req) {
        respond(req);
    },

    async setInstructionBreakpoints(req) {
      return withBpLock(async () => {
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
      });
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
        const ok = await writeMem(addr, buf);
        respond(req, { bytesWritten: ok ? buf.length : 0 });
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

        // Address-of:  &sym  — the ADDRESS, never the bytes stored there. Essential for a code
        // label (e.g. &_KernelEndText): a .text marker has no meaningful "value", so
        // dereferencing it just reports whatever opcodes happen to sit at that address.
        // Accepts the C<->asm underscore variants, like "Go to: <symbol>".
        if ((m = expr.match(/^&\s*([A-Za-z_][A-Za-z0-9_]*)$/))) {
            const want = m[1];
            const lookOne = (n) => {
                if (symbols.has(n)) return symbols.get(n);
                const lower = n.toLowerCase();
                for (const [k, v] of symbols) if (k.toLowerCase() === lower) return v;
                if (Array.isArray(romSymbols)) for (const s of romSymbols) if (s.name === n || s.name.toLowerCase() === lower) return s.addr;
                return undefined;
            };
            let addr = lookOne(want);
            if (addr === undefined) addr = lookOne(want[0] === '_' ? want.slice(1) : '_' + want);
            if (addr === undefined) { respond(req, {}, false, "Unknown symbol: '" + want + "'"); return; }
            respond(req, {
                result: '$' + (addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0') + ' (' + (addr & 0xFFFF) + ')  address of ' + want,
                variablesReference: 0,
                memoryReference: '0x' + (addr & 0xFFFF).toString(16)
            });
            return;
        }

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

        // Re-read source annotations without a rebuild/reload:  reparse
        // Add a "; @ptr16 foo" while debugging, save, run this — it's live, no
        // context lost. Only annotations refresh; symbol addresses need a build.
        if (/^reparse$/i.test(expr)) {
            const n = reparseAnnotations();
            respond(req, { result: 'Reparsed annotations — ' + n + ' now active (symbol addresses unchanged; rebuild for those)', variablesReference: 0 });
            return;
        }

        // Re-read the symbol FILE after a byte-identical rebuild (new enum members,
        // types, symbols) WITHOUT relaunching:  reloadsymbols  [force]
        // Gated on the disk-image hash so a real (non-byte-identical) rebuild is
        // refused — the running emulator would mismatch the fresh symbols.
        if (/^reloadsymbols(\s+force)?$/i.test(expr)) {
            const r = reloadSymbols(/force/i.test(expr));
            respond(req, {
                result: r.reloaded
                    ? 'Reloaded symbol file — ' + r.symbols + ' symbols (binary unchanged since launch)'
                    : 'Not reloaded: ' + r.reason,
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
            lastStopPc = newPc; // PC edited in place — keep register-tag tracking coherent
            respond(req, {
                result: 'Skipped to ' + labelFor(newPc) + ' ($' + newPc.toString(16).toUpperCase().padStart(4, '0') + ')',
                variablesReference: 0
            });
            evt('stopped', { reason: 'step', threadId: 1, allThreadsStopped: true });
            return;
        }

        // Memory read:  x $ADDR [LEN]  or  m ADDR,LEN
        // No implicit hex: for `x`, $ = hex and bare digits = decimal; `m` is
        // the GDB-protocol form and stays all-hex as documented.
        if ((m = expr.match(/^([xm])\s+(\$?)([0-9a-fA-F]{1,4})(?:[,\s]+(\d+))?$/i))) {
            const isHex = m[1].toLowerCase() === 'm' || m[2] === '$';
            if (!isHex && !/^\d+$/.test(m[3])) { respond(req, {}, false, 'Hex addresses need a $ prefix (e.g. x $' + m[3].toUpperCase() + ')'); return; }
            const addr = parseInt(m[3], isHex ? 16 : 10);
            const len  = parseInt(m[4] || '16', 10);
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

        // Memory write:  w $ADDR $VAL   ($ = hex, bare digits = decimal — no implicit hex)
        if ((m = expr.match(/^w\s+(\$?)([0-9a-fA-F]{1,4})\s+(\$?)([0-9a-fA-F]{1,3})$/i))) {
            if ((!m[1] && !/^\d+$/.test(m[2])) || (!m[3] && !/^\d+$/.test(m[4]))) {
                respond(req, {}, false, 'Hex values need a $ prefix (e.g. w $C000 $FF)'); return;
            }
            const addr = parseInt(m[2], m[1] ? 16 : 10);
            const val  = parseInt(m[4], m[3] ? 16 : 10);
            if (val > 255) { respond(req, {}, false, 'Value must fit in one byte'); return; }
            const ok = await writeMem(addr, [val]);
            respond(req, {
                result: ok ? 'OK' : 'Write failed',
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

        // Register read:  A, X, Y, SP, PC — decoded through the register's
        // tracked type tag when one is live (see regTags).
        if (regs) {
            const u = expr.toUpperCase();
            const vals = { A: regs.a, X: regs.x, Y: regs.y, SP: regs.sp, PC: regs.pc };
            if (u in vals) {
                const v = vals[u];
                const w = u === 'PC' ? 4 : 2;
                const tagged = regTagStr(u.toLowerCase());
                respond(req, {
                    result: tagged ? tagged + '  ' + u
                                   : '$' + v.toString(16).toUpperCase().padStart(w, '0') + ' (' + v + ')',
                    variablesReference: 0
                });
                return;
            }
        }

        // Goto (set PC):  goto $ADDR  or  goto symbolName
        // No implicit hex: a bare token falls through to the symbol form below
        // (a label named "abcd" must never be hijacked as address $ABCD).
        if ((m = expr.match(/^goto\s+(?:\$|0x)([0-9a-fA-F]{1,4})$/i))) {
            const addr = parseInt(m[1], 16) & 0xFFFF;
            const pcLo = (addr & 0xFF).toString(16).padStart(2, '0');
            const pcHi = ((addr >> 8) & 0xFF).toString(16).padStart(2, '0');
            await gdbCmd('P4=' + pcLo + pcHi);
            const r = await gdbCmd('g');
            regs = parseRegsG(r);
            lastStopPc = addr; // PC edited in place
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
            lastStopPc = symAddr; // PC edited in place
            respond(req, {
                result: 'PC = ' + m[1] + ' ($' + symAddr.toString(16).toUpperCase().padStart(4, '0') + ')',
                variablesReference: 0
            });
            evt('stopped', { reason: 'goto', threadId: 1, allThreadsStopped: true });
            return;
        }

        // Register tags:  tag                 list the tracked tags
        //                 tag a location_id   tag a register with an enum type
        //                 untag a | untag     clear one / all
        // Manual tags follow the same tracking lifecycle as inferred ones (a
        // later untyped load or transform clears them).
        if ((m = expr.match(/^tag(?:\s+(a|x|y)\s+(\w+))?$/i))) {
            if (m[1]) {
                if (!resolveEnum(m[2])) { respond(req, {}, false, 'Unknown enum: ' + m[2]); return; }
                regTags[m[1].toLowerCase()] = { enumName: m[2], source: 'manual' };
            }
            const parts = [];
            for (const rn of ['a', 'x', 'y']) {
                const t = regTags[rn];
                parts.push(rn.toUpperCase() + ': ' + (t ? t.enumName + ' [' + t.source + '] = ' + (regTagStr(rn) || '?') : '(untagged)'));
            }
            respond(req, { result: parts.join('\n'), variablesReference: 0 });
            return;
        }
        if ((m = expr.match(/^untag(?:\s+(a|x|y))?$/i))) {
            if (m[1]) regTags[m[1].toLowerCase()] = null; else clearRegTags();
            respond(req, { result: 'OK', variablesReference: 0 });
            return;
        }

        // Type cast:  (TYPE)EXPR — view EXPR's address as TYPE, rendered through
        // the one render path (buildTypedVar) so a cast behaves exactly like a
        // .ctype-typed variable. TYPE = scalar / enum / struct name, optionally
        // '*' (pointer) or '[N]' (array). EXPR = symbol (with _ fallback) or a
        // $hex/0xhex address. Examples: (uchar*)tmp0, (save_game_file)$C000,
        // (uchar[8])_g_palette, (GamePhase)current_phase.
        if ((m = expr.match(/^\(\s*([A-Za-z_]\w*)\s*(\*|\[\s*(\d+)\s*\])?\s*\)\s*(\S+)$/))) {
            const baseType = m[1];
            const isPtr = m[2] === '*';
            const count = m[3] ? parseInt(m[3], 10) : 0;
            const target = m[4];
            const elemSize = typeDefs.has(baseType) ? typeDefs.get(baseType).size : scalarSizeOf(baseType);
            if (!elemSize && !isPtr) { respond(req, {}, false, 'Unknown type: ' + baseType); return; }
            // Registers are cast by VALUE, not address: (item_id)a interprets
            // the A register as the type — no memory involved. Registers take
            // precedence over symbols, matching bare-watch behavior (so "a" is
            // never silently hex-parsed as address $000A).
            const rm = target.match(/^(a|x|y|sp|pc)$/i);
            if (rm) {
                if (!regs) { respond(req, {}, false, 'No register state'); return; }
                if (isPtr || count || typeDefs.has(baseType)) {
                    respond(req, {}, false, 'A register holds a value — cast it to a scalar or enum type'); return;
                }
                const rname = rm[1].toLowerCase();
                const rv = regs[rname] || 0;
                respond(req, {
                    result: formatScalar(baseType, [rv & 0xFF, (rv >> 8) & 0xFF], 0, elemSize) + '  ' + baseType + '  ' + rname.toUpperCase(),
                    variablesReference: 0
                });
                return;
            }
            let castAddr = symbols.get(target);
            if (castAddr === undefined && !target.startsWith('_')) castAddr = symbols.get('_' + target);
            if (castAddr === undefined) {
                // No implicit hex: $/0x = hex address, bare digits = DECIMAL
                // address. A hex-looking word without a prefix (e.g. a mistyped
                // symbol "face") must not silently become a memory address.
                const hm = target.match(/^(?:\$|0x)([0-9a-fA-F]{1,4})$/);
                if (hm) castAddr = parseInt(hm[1], 16);
                else if (/^\d+$/.test(target)) castAddr = parseInt(target, 10) & 0xFFFF;
            }
            if (castAddr === undefined) { respond(req, {}, false, 'Cast target not found: ' + target); return; }
            let fullType, size;
            if (isPtr)      { fullType = '*' + baseType; size = 2; }
            else if (count) { fullType = baseType + '[' + count + ']'; size = count * elemSize; }
            else            { fullType = baseType; size = elemSize; }
            const v = await buildTypedVar(expr, castAddr & 0xFFFF, fullType, size, undefined);
            respond(req, {
                result: v.value,
                variablesReference: v.variablesReference,
                memoryReference: '0x' + (castAddr & 0xFFFF).toString(16)
            });
            return;
        }

        // C variable access:  EXPR.member  EXPR->member  EXPR[index]  (and chains).
        // Resolves the live address (reading fp for locals, following pointers and
        // index variables) and renders through the one path, buildTypedVar — so a
        // watched g_entities[i].hp reads exactly like the same node in the tree.
        if (regs && /^[A-Za-z_]\w*\s*(\.|->|\[)/.test(expr)) {
            let lv;
            try {
                const func = currentFunction(regs.pc);
                const wlocals = func ? localDefs.get(func) : null;
                const fpA = symbols.get('fp'), apA = symbols.get('ap');
                let fpVal = 0, apVal = 0;
                if (typeof fpA === 'number') { const mm = await readMem(fpA, 2); fpVal = (mm[0] || 0) | ((mm[1] || 0) << 8); }
                if (typeof apA === 'number') { const mm = await readMem(apA, 2); apVal = (mm[0] || 0) | ((mm[1] || 0) << 8); }
                lv = await evalAccess(expr, wlocals, fpVal, apVal);
            } catch (e) { respond(req, {}, false, e.message); return; }
            if (lv) {
                const v = await buildTypedVar(expr, lv.addr, lv.type, lv.size, undefined);
                respond(req, { result: v.value, variablesReference: v.variablesReference, memoryReference: '0x' + lv.addr.toString(16) });
                return;
            }
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
                memoryReference: '0x' + a.toString(16),
                // Makes the row navigable in the BUILT-IN Watch view, which we do not render and so
                // cannot make clickable ourselves — the client resolves this via `locations`.
                // Undefined when the symbol has no real definition, and an absent field simply
                // means "not navigable", so older clients that ignore it are unaffected.
                valueLocationReference: locationRefForName(symName)
            });
            return;
        }

        // Symbol owned by an INACTIVE module: answer quietly instead of erroring.
        // Multi-module projects legitimately watch symbols that only exist while
        // their overlay is loaded (gSaveGameFile in Splash/Outro, the MonkeyKing
        // scores…). The built-in Watch shows the calm text; the Symbol Browser's
        // watch section folds these away via the `inactive`/`owners` fields.
        // Memory is NOT read — the address belongs to whatever module is mapped.
        {
            const owners = [];
            for (const [mod, b] of moduleBuckets) {
                if (mod === 'R' || mod === activeModuleId) continue; // active view already searched
                const ba = b.symbols.get(expr) !== undefined ? b.symbols.get(expr) : b.symbols.get('_' + expr);
                if (ba !== undefined)
                    owners.push((moduleNames.get(mod) || ('module ' + mod)) + ' @ $' + ba.toString(16).toUpperCase().padStart(4, '0'));
            }
            if (owners.length) {
                respond(req, {
                    result: '(inactive — ' + owners.join(', ') + ')',
                    variablesReference: 0,
                    inactive: true,
                    owners: owners.join(', ')
                });
                return;
            }
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

        // Binary column toggle:  bin  |  bin on|off   (the |%binary in decoded values)
        if ((m = expr.match(/^bin(?:\s+(on|off))?$/i))) {
            if (m[1] !== undefined) showBinary = (m[1].toLowerCase() === 'on');
            respond(req, { result: 'Binary in values: ' + (showBinary ? 'on' : 'off'), variablesReference: 0 });
            evt('stopped', { reason: 'pause', threadId: 1, allThreadsStopped: true });
            return;
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
        // Read memory in chunks: the stub clamps a single `m` reply to ~4093 bytes, so a
        // large region (e.g. a 240x128 HIRES buffer = 5120 bytes for the graphic view) would
        // come back truncated. Read <=2048-byte pieces and concatenate the hex.
        const CHUNK = 2048;
        let data = '';
        for (let off = 0; off < count; off += CHUNK) {
            const n = Math.min(CHUNK, count - off);
            const r = await gdbCmd('m' + ((addr + off) & 0xffff).toString(16) + ',' + n.toString(16));
            if (!r || r[0] === 'E') break;
            data += r;
            if (r.length < n * 2) break;   // short read — stop rather than pad with stale hex
        }
        respond(req, { address: addr, data, expression: rawExpr });
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

    // Idempotent SET (vs the toggle) — reliable for scripts: forces warp to exactly `on`
    // regardless of the current state, so a dropped/duplicated call can't invert it. Returns
    // the applied state. (qOricWarp is a stub command, so the caller should be halted — while
    // a 'c' is in flight it would queue behind it; the automation's warp op ensureStopped's.)
    async setWarp(req) {
        const on = !!(req.arguments && req.arguments.on);
        const reply = await gdbCmd('qOricWarp,' + (on ? '1' : '0'));
        if (reply === null) { respond(req, {}, false, 'Not connected'); return; }
        respond(req, { warp: on });
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
            const snap = resolverInstance ? resolverInstance.addrForLine(a.file, a.line) : null;
            addr = snap ? snap.addr : -1;
            if (snap && !executableSnap(snap, a.file)) {
                respond(req, {}, false, 'Target line is data, not executable code'); return;
            }
        }
        if ((a.symbol || a.file) && addr < 0) { respond(req, {}, false, 'Turbo target not found'); return; }
        // Cycle-count annotation for "Run to Here": snapshot the counter now and
        // attribute the elapsed cycles to the line we're running FROM (the current PC),
        // same as step-over. The current PC always resolves to a source line (we're
        // stopped on it); the target address may not (e.g. a disassembly instruction
        // with no #LINES entry), which would silently drop the annotation. Cycles count
        // identically under warp. continue() below preserves this snapshot; the stop
        // handler consumes it.
        await snapshotStepStart(true);   // run-type: attribute to the destination line
        await armTurbo(addr, a.warp !== false); // warp:false = run-to-target at normal speed
        return handlers.continue(req); // responds + issues continue (handles PC-on-BP)
    },

    // -- Multi-module symbol selection (custom requests) --------------
    getModules(req) {
        respond(req, { modules: listModules(), active: activeModuleId });
    },

    // For the Oric Breakpoints tree: which module(s) own each given source file.
    // The extension groups its breakpoints by this. Path normalization is done
    // here (fileToModules is keyed by our canonPath) and returned keyed by the
    // exact input path so the caller can join without re-normalizing. Files in
    // no #MODULE section (or with no module info) are resident ('R').
    getBreakpointModules(req) {
        const files = (req.arguments && req.arguments.files) || [];
        const locs = (req.arguments && req.arguments.locs) || [];
        const byFile = {};
        for (const f of files) byFile[f] = fileToModules.get(canonPath(f)) || ['R'];
        const modules = [{ id: 'R', name: 'Resident' }];
        for (const [id, name] of moduleNames) modules.push({ id, name });
        // Bound (snapped) line for each requested bp line — a line with no code of
        // its own (e.g. an assignment folded into adjacent statements) binds to the
        // next line that has code. Returned so the panel shows the same line VS Code
        // does instead of the requested one.
        // Also a per-location verified flag: false when the line can't bind (e.g. a
        // .c file built without -g1). The panel uses this to grey out unverified bps;
        // it's more reliable than SourceBreakpoint.verified (whose propagation from a
        // verified:false DAP response is inconsistent across VS Code versions).
        const snaps = {};
        const bpVerified = {};
        if (resolverInstance) {
            for (const loc of locs) {
                const s = resolverInstance.addrForLine(loc.file, loc.line);
                const key = loc.file + ':' + loc.line;
                bpVerified[key] = !!s;
                if (s && s.line && s.line !== loc.line) snaps[key] = s.line;
            }
        }
        respond(req, { modules, byFile, snaps, bpVerified });
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
        respond(req, { addr: snap.addr, line: snap.line, executable: executableSnap(snap, a.file) });
    },

    // -- Reparse annotations (custom request) -------------------------
    // Fired by the extension when a source file is saved (or from the palette
    // command), so annotation edits go live without a rebuild or session restart.
    reparseAnnotations(req) {
        const n = reparseAnnotations();
        respond(req, { count: n });
    },

    // -- Reload symbol file (custom request) --------------------------
    // Re-parse the (rebuilt) symbol file in place after a byte-identical build —
    // new enum members / types / symbols without relaunching. Gated on the disk
    // hash; returns { reloaded, changed?, reason?, symbols? } so the caller can
    // tell "refreshed" from "binary changed — restart needed".
    reloadSymbols(req) {
        const force = req.arguments && req.arguments.force;
        respond(req, reloadSymbols(force));
    },

    // -- Toggle the binary column in decoded values (custom request) --
    // Pushed by the extension from the oric-debug.showBinary setting (at launch
    // and on change) so the global preference applies live.
    setShowBinary(req) {
        showBinary = !!(req.arguments && req.arguments.on);
        respond(req, { showBinary });
        if (!running) evt('stopped', { reason: 'pause', threadId: 1, allThreadsStopped: true }); // repaint values
    },

    // -- Reset cycle counter (custom request) -------------------------

    async resetCycles(req) {
        const reply = await gdbCmd('qOricResetCycles');
        respond(req, { result: reply === 'OK' ? 'Cycles reset' : 'Failed' });
    },

    // Set the emulator window title at runtime (qOricTitle) to an explicit string.
    // Tolerant of an older stub that doesn't know the command.
    async setEmulatorTitle(req) {
        const t = (req.arguments && req.arguments.title) || '';
        try { await gdbCmd('qOricTitle,' + Buffer.from(t, 'utf8').toString('hex')); } catch (e) { /* old stub: no title cmd */ }
        respond(req, {});
    },

    // Flag AI-bot piloting in the window title: keeps the program-name base the DA
    // resolved on connect and just appends/removes the marker, so the base stays
    // authoritative in one place (no folder-vs-program-name drift with the extension).
    async setEmulatorPiloting(req) {
        const ai = !!(req.arguments && req.arguments.ai);
        const t = ai ? (emuBaseTitle + '  ● AI piloting') : emuBaseTitle;
        try { await gdbCmd('qOricTitle,' + Buffer.from(t, 'utf8').toString('hex')); } catch (e) { /* old stub: no title cmd */ }
        respond(req, {});
    },

    // -- Snapshots: save / restore / list (custom requests) -----------
    async saveSnapshot(req) {
        const r = await doSaveSnapshot((req.arguments && req.arguments.name) || 'snap');
        if (r.error) { respond(req, {}, false, r.error); return; }
        respond(req, { name: r.name });
    },
    async renameSnapshot(req) {
        const from = req.arguments && req.arguments.name;
        const toRaw = req.arguments && req.arguments.to;
        if (!from || !toRaw) { respond(req, {}, false, 'rename needs name + to'); return; }
        const to = String(toRaw).replace(/[^\w.-]/g, '_').slice(0, 64);
        if (!to) { respond(req, {}, false, 'invalid new name'); return; }
        try { fs.renameSync(snapshotFile(from), snapshotFile(to)); }
        catch (e) { respond(req, {}, false, 'rename failed: ' + e.message); return; }
        snapshotsChanged();
        respond(req, { name: to });
    },
    async restoreSnapshot(req) {
        const name = req.arguments && req.arguments.name;
        if (!name) { respond(req, {}, false, 'No snapshot name'); return; }
        if (!fs.existsSync(snapshotFile(name))) { respond(req, {}, false, 'Snapshot not found: ' + name); return; }
        const r = await gdbCmd('qOricLoadSnapshot,' + Buffer.from(snapshotFile(name), 'utf8').toString('hex'));
        if (typeof r === 'string' && r.indexOf('E snapshot') === 0) { respond(req, {}, false, r.slice(2).trim()); return; }
        regs = parseStopRegs(r);   // r is the post-restore stop reply
        running = false;
        clearGdbReadCache();
        await resyncStubBreakpoints();   // realign the emulator's bp table with the debugger's set
        // A restored snapshot is a real running state (like attach), so the _osdk_dbg_module
        // byte in RAM is meaningful — trust it and re-detect the active overlay, otherwise a
        // multi-module project shows "(none)" and hides that module's symbols after a restore.
        moduleByteTrusted = true;
        if (moduleNames.size > 0) await checkModuleSwitch(true);
        log('Snapshot restored: ' + name + ' (PC=$' + (regs && regs.pc !== undefined ? regs.pc.toString(16).toUpperCase().padStart(4, '0') : '??') + ')');
        respond(req, { name });
        evt('stopped', { reason: 'restore', threadId: 1, allThreadsStopped: true });
    },
    listSnapshots(req) {
        // The directory IS the source of truth (no manifest): each *.snapshot file is a snapshot,
        // its mtime is when it was saved. Reserved names (__baseline) are hidden.
        let snaps = [];
        try {
            snaps = fs.readdirSync(snapshotDir())
                .filter(f => f.endsWith('.snapshot') && f.indexOf('__') !== 0)
                .map(f => { let at = 0; try { at = Math.round(fs.statSync(path.join(snapshotDir(), f)).mtimeMs); } catch (e) { /* keep 0 */ } return { name: f.slice(0, -('.snapshot'.length)), at }; })
                .sort((a, b) => (b.at || 0) - (a.at || 0));
        } catch (e) { /* no snapshot dir yet */ }
        respond(req, { snapshots: snaps });
    },
    async deleteSnapshot(req) {
        const name = req.arguments && req.arguments.name;
        if (!name) { respond(req, {}, false, 'No snapshot name'); return; }
        try { fs.unlinkSync(snapshotFile(name)); } catch (e) { /* already gone */ }
        snapshotsChanged();
        respond(req, { name });
    },

    // -- Symbol table WITHOUT values (custom request) ------------------
    // The merged per-address records from the ONE builder (assembleSymbols) — NO memory reads,
    // so it's safe while the CPU is RUNNING (readAllSymbols would hang on `m`). Feeds the Memory
    // Map, which only needs the static layout (name + co-located aliases + source).
    symbolTableLite(req) {
        respond(req, { symbols: assembleSymbols() });
    },

    // Definition site of a SYMBOL BY NAME (not by address): the file:line where it is declared.
    // Backs click-to-definition on identifiers in the panels. Tries the name as given and the
    // C<->asm underscore variants. Build artifacts (TMP intermediates, linked.s) are refused —
    // they are ephemeral and jumping into them lands the user in a file that no longer matches.
    symbolDefinition(req) {
        const names = (req.arguments && req.arguments.names) || [];
        respond(req, { defs: names.map(n => (typeof n === 'string' ? definitionOfName(n) : null)) });
    },

    // DAP `locations`: resolve a location reference handed out earlier (on a Variable or an evaluate
    // result) to a real source position. This is what makes the BUILT-IN Variables and Watch rows
    // navigable — those views are not ours to render, so a reference plus this request is the only
    // way to offer "go to declaration" there.
    locations(req) {
        const id = req.arguments && req.arguments.locationReference;
        const loc = locationRefs.get(id);
        if (!loc) { respond(req, {}, false, 'Unknown location reference'); return; }
        respond(req, { source: { name: path.basename(loc.file), path: loc.file }, line: loc.line || 1 });
    },

    // Resolve addresses to their symbol labels. Used for the CPU block's interrupt vectors: a bare
    // "$FCCC" says nothing, "IrqDoNothing" says everything. Batched because a caller wants several
    // at once (NMI/RST/IRQ) and one round-trip per stop is the budget.
    labelsForAddresses(req) {
        const list = (req.arguments && req.arguments.addresses) || [];
        respond(req, { labels: list.map(a => (typeof a === 'number' ? labelFor(a & 0xFFFF) : null)) });
    },

    // Real bound/armed state of every source breakpoint the adapter holds, so a caller
    // (the MCP bridge / an agent) can tell "accepted" from "actually armed" instead of
    // trusting an optimistic message. bound = the line resolved to >=1 address in some
    // owning module; armed = a Z0 is live in the emulator right now (the binding for the
    // ACTIVE module — others stay pending until that overlay is resident).
    breakpointStatus(req) {
        const out = [];
        for (const [norm, list] of srcBps) {
            for (const bp of list) {
                const bindings = bp.bindings || [];
                out.push({
                    file: (bp.source && bp.source.path) || norm,
                    line: bp.line,
                    id: bp.id,
                    bound: bindings.length > 0,
                    armed: bindings.some(b => b.armed),
                    // Report module NAMES, not internal bucket ids — "module 0" is meaningless to
                    // a caller when oric_module already says "Splash". 'R' = resident stays as-is.
                    modules: bindings.map(b => moduleLabel(b.module)),
                    addrs: bindings.map(b => b.addr),
                    condition: bp.condExpr || null,
                    hitTarget: bp.hitTarget || null,
                });
            }
        }
        respond(req, { breakpoints: out, activeModule: moduleLabel(activeModuleId) });
    },

    // Resolve a symbol name to its address, for "Go to: <symbol>" in the disassembly.
    // Accepts an optional "+/-<hexoffset>" suffix (e.g. "_InputDelete+3"). Exact match
    // first, then case-insensitive, then ROM symbols. Returns { addr } or { addr: null }.
    addrForSymbol(req) {
        let name = String((req.arguments && req.arguments.name) || '').trim();
        let off = 0;
        const m = name.match(/^(.*?)\s*([+-])\s*\$?([0-9a-fA-F]+)$/);
        if (m) { name = m[1].trim(); off = (m[2] === '-' ? -1 : 1) * parseInt(m[3], 16); }
        // Try the name as typed, then the C<->asm underscore variants: a C symbol
        // (System_RestoreIRQ_SimpleVbl) is exported with a leading '_' in the symbol
        // table (_System_...), and vice-versa. So try "name", then "_name", then a
        // '_'-stripped form — first hit wins.
        const lookOne = (n) => {
            if (symbols.has(n)) return symbols.get(n);
            const lower = n.toLowerCase();
            for (const [k, v] of symbols) { if (k.toLowerCase() === lower) return v; }
            if (Array.isArray(romSymbols)) {
                for (const s of romSymbols) { if (s.name === n || s.name.toLowerCase() === lower) return s.addr; }
            }
            return undefined;
        };
        let addr;
        if (name) {
            const cands = [name];
            if (name[0] === '_') cands.push(name.slice(1)); else cands.push('_' + name);
            for (const c of cands) { addr = lookOne(c); if (addr !== undefined) break; }
        }
        respond(req, { addr: addr !== undefined ? ((addr + off) & 0xFFFF) : null });
    },

    // -- Read all symbols with current values (custom request) ---------

    async readAllSymbols(req) {
        // Records (merged aliases, source, size/group/typeInfo) come from the ONE shared builder;
        // this handler only adds the LIVE value + annotated display (the memory-dependent part).
        const recs = assembleSymbols();
        if (recs.length === 0) { respond(req, { symbols: [] }); return; }

        // Collect the unique 256-byte pages the values span (read size = each record's byte extent).
        const pages = new Set();
        for (const s of recs) {
            const page = s.addr >> 8;
            const endPage = (s.addr + s.rawSize - 1) >> 8;
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

        // Layer the live value + annotated display onto each record (naming/source/size/type
        // already resolved by assembleSymbols). Value spans the record's byte extent (rawSize);
        // display goes through the SAME formatAnnotated path as Watch (@bcd/@enum/@bool/@bitset).
        const result = [];
        for (const s of recs) {
            const value = [];
            for (let i = 0; i < s.rawSize; i++) {
                const a = s.addr + i, page = a >> 8, off = a & 0xFF, pageData = mem.get(page);
                value.push(pageData ? pageData[off] : 0);
            }
            let display = null;
            const mAnn = annForSymbol(s.name);
            if (mAnn) {
                const fa = await formatAnnotated(mAnn, s.addr, s.rawSize);
                if (fa) display = fa.value + (fa.type ? '  ' + fa.type : '');
            }
            result.push({ name: s.name, aliases: s.aliases, addr: s.addr, size: s.size, value,
                          group: s.group, display, source: s.source, nameSources: s.nameSources,
                          typeInfo: s.typeInfo });
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
      return withBpLock(async () => {
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
            let ok = r === 'OK';
            let message = ok ? undefined : 'Failed to set watchpoint';
            if (ok) {
                dataBps.set(id, { id, addr, accessType: access, gdbType, condition: dbp.condition || null });
                // DAP data breakpoints carry an optional `condition`; compile it native-side
                // so the emulator only stops on the interesting store (e.g. "A == $10").
                if (dbp.condition) {
                    const cerr = await sendWatchCond(addr, dbp.condition);
                    if (cerr) { ok = false; message = 'condition: ' + cerr; }
                }
            }
            result.push({ id: id, verified: ok, message: message });
        }
        respond(req, { breakpoints: result });
      });
    },

    // Extension-owned watchpoint EVENTS (module-scoped, conditional, with log/[save]/
    // [stop] actions). The extension owns the list and re-sends the full set here — on
    // session start (restoring persisted watchpoints), on edits, and after a module
    // switch is unnecessary (the adapter rearms those itself). We reconcile: disarm the
    // old set, store the new one, and arm the events whose module is active now.
    async oricSetWatchpoints(req) {
      return withBpLock(async () => {
        for (const ev of watchEvents) if (ev.armed) await disarmWatch(ev);
        watchEvents = (req.arguments.watchpoints || []).map(w => ({
            id: w.id,
            addr: (w.addr | 0) & 0xFFFF,
            size: w.size || 1,
            access: w.access || 'write',
            module: (w.module === undefined ? null : w.module),
            condition: w.condition || null,
            logMessage: w.logMessage || null,
            enabled: w.enabled !== false,
            armed: false,
        }));
        for (const ev of watchEvents) if (watchDesired(ev)) await armWatch(ev);
        // verified = armed, OR valid-but-waiting because its module isn't active yet.
        respond(req, { watchpoints: watchEvents.map(ev => ({
            id: ev.id, armed: ev.armed, verified: ev.armed || !watchDesired(ev),
        })) });
      });
    },

    // Transient VALUE watch for scripted automation (waitFor): stop when the byte at
    // `addr` changes to satisfy `condition`, tested against real committed memory so it
    // fires regardless of the write mechanism. Separate from the module-scoped, persisted
    // watchpoint EVENTS above — this one is armed for the duration of a single wait and
    // cleared after. The caller must have the CPU halted (the stub queues packets behind a
    // running 'c'); the in-session/standalone ops ensureStopped() before calling.
    async oricArmValueWatch(req) {
      return withBpLock(async () => {
        const addr = (req.arguments.addr | 0) & 0xFFFF;
        const err = await sendWatchVal(addr, req.arguments.condition || null);
        respond(req, { armed: !err, error: err || null });
      });
    },
    async oricClearValueWatch(req) {
      return withBpLock(async () => {
        await clearWatchVal((req.arguments.addr | 0) & 0xFFFF);
        respond(req, {});
      });
    },

    // Resolve a C symbol / label / enum constant to its address and/or value from the
    // loaded symbol + enum tables (pure lookup, no stub round-trip — works while the
    // program is running). Lets automation scripts (and callers) use REAL names
    // (_gCurrentLocation, e_LOC_LARGE_STAIRCASE) instead of hardcoded addresses/enum
    // values that silently rot when the game changes. Tolerates the leading underscore
    // the C compiler adds. Returns { found, addr, value, size, type, enumName }.
    oricResolve(req) {
        const name = ((req.arguments && req.arguments.name) || '').trim();
        if (!name) { respond(req, { found: false }); return; }
        const ev = enumMemberValue(name);
        let addr = symbols.get(name);
        if (addr === undefined && name[0] !== '_') addr = symbols.get('_' + name);
        let size = null, type = null, enumName = null;
        if (addr !== undefined) { const spec = renderSpec(name) || renderSpec('_' + name) || {}; size = spec.size || 1; type = spec.type || null; }
        if (ev !== undefined) enumName = enumOfMember(name);
        respond(req, {
            found: ev !== undefined || addr !== undefined,
            name,
            addr: addr === undefined ? null : (addr & 0xFFFF),
            value: ev === undefined ? null : ev,
            size, type, enumName,
        });
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

        // Value of a DIRECT operand (the effective address IS the symbol):
        // when the registry knows how to DECODE the symbol (annotation or a
        // real .ctype type), render through buildTypedVar — THE one render
        // path — in its compact omitAddr form (the operand label already
        // shows the address). Untyped symbols keep the plain byte form
        // rather than gaining a noisy default "uchar" token.
        const typedValStr = async (addr) => {
            const name = sym(addr);
            if (name) {
                const info = infoForSymbol(name);
                const spec = renderSpec(name);
                if (spec.ann || (info && info.type)) {
                    const v = await buildTypedVar(name, addr, spec.type, spec.size, spec.ann, { omitAddr: true });
                    return v.value;
                }
            }
            return fmtVal(await readByte(addr));
        };

        // A code-line directive types an indexed/indirect read whose operand has
        // no per-symbol type. One helper so every indexed mode honours it:
        //   ; @enum <E>    the fetched byte, decoded as enum <E>
        //   ; @word        the 16-bit LE word at the effective address, + symbol
        //   ; @stream <E>  that word treated as a stream pointer -> first command
        // Returns the display string, or null when there is no directive (caller
        // falls back to the plain byte).
        const lineDirs = lineDirectivesOf(pc);
        const valOrEnum = async (b, ea) => {
            if (!lineDirs.length) return fmtVal(b);
            const hasWord = lineDirs.some(d => d.kind === 'word');
            const streamDir = lineDirs.find(d => d.kind === 'stream');
            const enumDir = lineDirs.find(d => d.kind === 'enum');
            const parts = [];
            if (enumDir) {                                     // byte-level: decode the fetched byte
                const ed = resolveEnum(enumDir.enumName, b);
                parts.push(ed ? formatEnum(ed, [b], 0, 1) + '  ' + enumDir.enumName : fmtVal(b));
            }
            if (hasWord || streamDir) {                        // word-level: the 16-bit word at the addr
                const m = await readMem(ea, 2);
                const w = (m[0] | (m[1] << 8)) & 0xFFFF;
                let s = '$' + w.toString(16).toUpperCase().padStart(4, '0');
                if (hasWord) { const sy = symbolAt(w); s += sy ? ' →' + sy : ' (' + w + ')'; }
                else { s = '→ ' + s; }                         // stream-only: keep the arrow form
                if (streamDir) {
                    const cmds = await decodeStream(streamDir.enumName, w, 1);
                    if (cmds.length && cmds[0].known) s += ' = ' + streamCmdText(cmds[0], streamDir.enumName);
                }
                parts.push(s);
            }
            return parts.length ? parts.join('  ') : fmtVal(b);
        };

        let annotation = '';
        try {
            switch (mode) {
                case '#': { // immediate
                    // Decode the immediate as an enum when the intent is known:
                    // an explicit "; @enum <E>" on the line, else the NAMED operand
                    // token (lda #FLAG_END_STREAM) via the same lookup the register
                    // tagger uses — so both show "FLAG_END_STREAM  stream_stop_flags".
                    const enumDir = lineDirs.find(d => d.kind === 'enum');
                    let en = enumDir ? enumDir.enumName : null;
                    if (!en) { const t = immediateTokenEnum(pc); if (t) en = t.enumName; }
                    const ed = en ? resolveEnum(en, lo) : null;
                    annotation = '#' + (ed ? formatEnum(ed, [lo], 0, 1) + '  ' + en : fmtVal(lo));
                    break;
                }
                case 'z': { // zero page
                    if (annHint) {
                        annotation = await annHintStr((lo - annHint.off) & 0xFF, false);
                        break;
                    }
                    annotation = '(' + symAddr(lo, false) + ')=' + await typedValStr(lo);
                    break;
                }
                case 'x': { // zp,X
                    const ea = (lo + regs.x) & 0xFF;
                    const val = await readByte(ea);
                    annotation = '(' + symAddr(lo, false) + '+X:' + h2(regs.x) + '=' + h2(ea) + ')=' + await valOrEnum(val, ea);
                    break;
                }
                case 'y': { // zp,Y
                    const ea = (lo + regs.y) & 0xFF;
                    const val = await readByte(ea);
                    annotation = '(' + symAddr(lo, false) + '+Y:' + h2(regs.y) + '=' + h2(ea) + ')=' + await valOrEnum(val, ea);
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
                        annotation = '(' + symAddr(addr, true) + ')=' + await typedValStr(addr);
                    }
                    break;
                }
                case 'X': { // abs,X
                    const base = (hi << 8) | lo;
                    const ea = (base + regs.x) & 0xFFFF;
                    const val = await readByte(ea);
                    annotation = '$' + h4(base) + '+X:' + h2(regs.x) + '=$' + h4(ea) + ' =' + await valOrEnum(val, ea);
                    break;
                }
                case 'Y': { // abs,Y
                    const base = (hi << 8) | lo;
                    const ea = (base + regs.y) & 0xFFFF;
                    const val = await readByte(ea);
                    annotation = '$' + h4(base) + '+Y:' + h2(regs.y) + '=$' + h4(ea) + ' =' + await valOrEnum(val, ea);
                    break;
                }
                case '(': { // (zp,X) indirect X
                    const ptr = (lo + regs.x) & 0xFF;
                    const ea = await readWord(ptr);
                    const val = await readByte(ea);
                    annotation = '(' + symAddr(lo, false) + '+X:' + h2(regs.x) + '=' + h2(ptr) + ')=$' + h4(ea) + ' =' + await valOrEnum(val, ea);
                    break;
                }
                case ')': { // (zp),Y indirect Y
                    const ptr = await readWord(lo);
                    const ea = (ptr + regs.y) & 0xFFFF;
                    // An explicit code-line directive (@word / @stream / @enum) on
                    // THIS line wins over the pointer's own @stream/@ptr16 typing —
                    // the user annotated this instruction on purpose (e.g. @word on
                    // the JUMP handler's read to show the jump target).
                    if (lineDirs.length) {
                        annotation = '(' + symAddr(lo, false) + ')=' + await valOrEnum(await readByte(ea), ea);
                        break;
                    }
                    // Struct-aware: a @ptr16 <struct> pointer names the FIELD the
                    // Y offset lands in, and decodes the value with the field's
                    // type ((_gStreamItemPtr→item.flags)=ITEM_FLAG_…). XA has no
                    // struct syntax — this is where "ldy #4" gets its meaning back.
                    const pname = sym(lo);
                    const pann = pname ? annForSymbol(pname) : null;
                    // (fp),y / (ap),y is a C frame access: Y is the frame offset, so
                    // name the local/parameter it lands in and decode it with its C
                    // type — "(fp→i)=$0002 int" instead of a raw pointer+offset.
                    if (pname === 'fp' || pname === 'ap') {
                        const li = localAtFrameOffset(currentFunction(pc), pname, regs.y);
                        if (li) {
                            const l = li.local;
                            const fann = annForSymbol(l.cname);
                            if (li.isArray) {
                                const ev = await buildTypedVar('', ea, li.base, li.elemSize, fann, { omitAddr: true });
                                annotation = '(' + pname + '→' + l.cname + '[' + li.index + '] @ $' + h4(ea) + ')=' + ev.value;
                            } else {
                                const localAddr = (ptr + l.offset) & 0xFFFF;
                                const fv = await buildTypedVar('', localAddr, l.type, l.size, fann, { omitAddr: true });
                                annotation = '(' + pname + '→' + l.cname + (li.within ? '+' + li.within : '')
                                    + ' @ $' + h4(ea) + ')=' + fv.value;
                            }
                            break;
                        }
                    }
                    // @stream pointer: when it sits AT a decodable command (a
                    // boundary — e.g. the opcode fetch, or a handler peeking a
                    // param of the current command), show that command and which
                    // byte Y fetches. When the pointer is mid-command (its own
                    // byte isn't a valid opcode — a handler that already advanced
                    // past the opcode), fall through to the plain byte annotation
                    // rather than mis-decoding garbage as "??? $xx".
                    if (pann && pann.kind === 'stream') {
                        const cmds = await decodeStream(pann.enumName, ptr, 1);
                        if (cmds.length && cmds[0].known) {
                            annotation = '(' + pname + '→' + streamCmdText(cmds[0], pann.enumName) + ')  +Y:' + h2(regs.y) + '=' + fmtVal(await readByte(ea));
                            break;
                        }
                    }
                    const sname = (pann && pann.kind === 'ptr16') ? pann.enumName : null;
                    const info = sname ? fieldAtOffset(sname, regs.y) : null;
                    if (info) {
                        const fann = annByField.get(sname + '.' + info.field.name);
                        if (info.isArray) {
                            // Y indexes an ELEMENT — decode the one element at `ea`
                            // with the element type (directions[i] = e_LOC_…),
                            // not the whole array header.
                            const ev = await buildTypedVar('', ea, info.base, info.elemSize, fann, { omitAddr: true });
                            annotation = '(' + pname + '→' + sname + '.' + info.field.name + '[' + info.index + ']'
                                + ' @ $' + h4(ea) + ')=' + ev.value;
                        } else {
                            const fv = await buildTypedVar('', (ea - info.within) & 0xFFFF, info.field.type, info.field.size,
                                                           fann, { omitAddr: true });
                            annotation = '(' + pname + '→' + sname + '.' + info.field.name
                                + (info.within ? '+' + info.within : '')
                                + ' @ $' + h4(ea) + ')=' + fv.value;
                        }
                        break;
                    }
                    const val = await readByte(ea);
                    annotation = '(*(' + symAddr(lo, false) + ')=$' + h4(ptr) + '+Y:' + h2(regs.y) + ')=$' + h4(ea) + ' =' + await valOrEnum(val, ea);
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

            // Register context (user request 2026-07-15): comparisons and
            // A-arithmetic show the implicit register operand next to the
            // memory/immediate one — both compared values at a glance while
            // tracing — and implied/accumulator ops show the register they
            // touch. A tagged register decodes through its tag, and a CMP/CPX/
            // CPY IMMEDIATE decodes through the compared register's tag too
            // (both sides live in the same domain: #e_ITEM_CURRENT vs
            // A=e_ITEM_YoungGirl).
            const regVal = (rn) => regTagStr(rn) || fmtVal(regs[rn] || 0);
            const CMP_REG = { CMP: 'a', CPX: 'x', CPY: 'y' };
            const ARITH_A = new Set(['ADC', 'SBC', 'AND', 'ORA', 'EOR']);
            const IMPLIED_REG = { INX: 'x', DEX: 'x', INY: 'y', DEY: 'y',
                                  TAX: 'a', TAY: 'a', TXA: 'x', TYA: 'y',
                                  PHA: 'a', PLA: 'a', TXS: 'x' };
            if (CMP_REG[mne]) {
                const rn = CMP_REG[mne];
                const tag = regTags[rn];
                if (mode === '#' && tag) {
                    const def = resolveEnum(tag.enumName, lo);
                    if (def) annotation = '#' + formatEnum(def, [lo], 0, 1);
                }
                annotation += '  vs ' + rn.toUpperCase() + '=' + regVal(rn);
            } else if (ARITH_A.has(mne)) {
                annotation += '  A=' + regVal('a');
            } else if (mode === 'A') {
                annotation = 'A=' + regVal('a');
            } else if (mode === 'I' && IMPLIED_REG[mne]) {
                const rn = IMPLIED_REG[mne];
                annotation = rn.toUpperCase() + '=' + regVal(rn);
            }
        } catch (_) { /* annotation stays empty */ }

        const src = sourceFor(pc);
        // Collapse indentation/alignment runs to single spaces: whitespace that
        // keeps many source lines aligned is just noise for one line lifted into a
        // small view ("   LDA #X       ; c" -> "LDA #X ; c"). Then split off a
        // trailing comment (; or //) so the view can show the human description on
        // its own line, above the code.
        let srcLine = src ? (getSourceLine(src.file, src.line) || '').replace(/\s+/g, ' ').trim() : '';
        let srcComment = '';
        const cmatch = srcLine.match(/(;|\/\/)/);
        if (cmatch) {
            srcComment = srcLine.slice(cmatch.index + cmatch[1].length).trim();
            srcLine = srcLine.slice(0, cmatch.index).trim();
        }
        // On a C source line, auto-decode the variable expressions on it (like
        // Watch entries) so the panel shows C-level state instead of the lone
        // 6502 op, which is meaningless mid-statement.
        const isC = !!(src && /\.(c|h|cc|cpp|i)$/i.test(src.file));
        let lineVars = null;
        if (isC && srcLine) {
            const exprs = extractLineExprs(srcLine);
            if (exprs.length) {
                const func = currentFunction(pc);
                const locals = func ? localDefs.get(func) : null;
                const fpA = symbols.get('fp'), apA = symbols.get('ap');
                let fpVal = 0, apVal = 0;
                if (typeof fpA === 'number') { const mm = await readMem(fpA, 2); fpVal = (mm[0] || 0) | ((mm[1] || 0) << 8); }
                if (typeof apA === 'number') { const mm = await readMem(apA, 2); apVal = (mm[0] || 0) | ((mm[1] || 0) << 8); }
                const rows = [];
                for (const e of exprs) {
                    if (rows.length >= 12) break;
                    try {
                        const lv = await evalAccess(e, locals, fpVal, apVal);
                        if (!lv) continue;
                        const v = await buildTypedVar(e, lv.addr, lv.type, lv.size, undefined, { omitAddr: true });
                        rows.push({ expr: e, value: (v.value || '').trim() });
                    } catch (_) { /* skip an expression that can't be evaluated */ }
                }
                if (rows.length) lineVars = rows;
            }
        }
        // The actual 6502 instruction text at PC (mnemonic + operand). Shown below
        // the C decode so you still see exactly which instruction you're on.
        const operandTxt = fmtOp(mode, lo, hi, pc);
        const disasm = mne.toUpperCase() + (operandTxt ? ' ' + operandTxt : '');
        respond(req, {
            annotation,
            pc,
            file: src ? src.file : null,
            line: src ? src.line : 0,
            srcLine,
            srcComment,
            isC,
            lineVars,
            disasm
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

        // Anchor the decode to the PC. `center` (the PC) IS a real instruction
        // boundary, but decoding blindly from center-preBytes can drift — ROM keeps
        // data between routines and uses the BIT ($2C) skip trick for multi-entry
        // points, so a naive forward decode may never land a boundary exactly on
        // center, leaving the view with no current-line row. Pick the FURTHEST-BACK
        // start whose forward decode lands exactly on center (center itself always
        // qualifies → zero before-context as the safe floor).
        const opAt = (a) => mem[a - startAddr];
        const sizeAt = (a) => { const e = OPS[opAt(a)]; return e ? opSize(e[3]) : 1; };
        const alignsOnCenter = (S) => { let a = S; while (a < center) a += sizeAt(a); return a === center; };
        let decodeStart = center;
        for (let S = startAddr; S < center; S++) {
            if (alignsOnCenter(S)) { decodeStart = S; break; }
        }

        // Disassemble all bytes from the aligned start (guarantees a row at center=PC)
        const allInsns = [];
        let addr = decodeStart;
        while (addr < startAddr + totalBytes) {
            const off = addr - startAddr;
            const opcode = mem[off];
            const entry = OPS[opcode];
            // ROM label: exact build symbol, else exact ROM symbol (e.g. Char2Scr @ $F77C)
            const label = symbolAt(addr) || romExactName(addr);
            if (!entry) {
                // Illegal opcode — emit as data byte
                allInsns.push({ address: addr, bytes: [opcode], mnemonic: '???', operand: '$' + opcode.toString(16).toUpperCase().padStart(2, '0'), label });
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
            allInsns.push({ address: addr, bytes: bytesArr, mnemonic: mnem, operand, label });
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
        for (const [, bp] of addrBps) (bp.enabled ? bpAddrs : pendingAddrs).push(bp.addr);
        for (const [, fileBps] of srcBps) {
            for (const bp of fileBps) for (const b of bp.bindings) (b.armed ? bpAddrs : pendingAddrs).push(b.addr);
        }

        // Time-travel history line: how far the cursor can rewind, and a one-line
        // preview of where Replay Rewind would land. The target can be a far/unrelated
        // address after a free-run, so the view shows it as a distinct row, NOT as the
        // instruction physically above the PC. `fwd` carries replay-forward availability
        // so the panel/buttons can reflect the redo direction too.
        let history = null;
        try {
            const hs = await gdbCmd('qOricHistStatus');   // "hist:<back>,<prevpc>,<fwd>,<nextpc>"
            const hm = /^hist:(\d+),([0-9a-fA-F]+|-),(\d+),([0-9a-fA-F]+|-)$/.exec(hs || '');
            if (hm) {
                const depth = parseInt(hm[1], 10);
                const fwd = parseInt(hm[3], 10);
                if (depth > 0 && hm[2] !== '-') {
                    const paddr = parseInt(hm[2], 16) & 0xFFFF;
                    const mem = await readMem(paddr, 3);
                    const op = mem[0], entry = OPS[op];
                    let text;
                    if (entry) {
                        const mode = entry[3], sz = opSize(mode);
                        const operand = fmtOp(mode, sz > 1 ? mem[1] : 0, sz > 2 ? mem[2] : 0, paddr);
                        text = entry.substring(0, 3) + (operand ? ' ' + operand : '');
                    } else {
                        text = '.byte $' + op.toString(16).toUpperCase().padStart(2, '0');
                    }
                    const R = resolverInstance ? resolverInstance.resolve(paddr) : null;
                    const label = (R && R.symbol)
                        ? fmtSymOff(R.symbol)
                        : (romLabelFor(paddr) || '');
                    history = { depth, fwd, address: paddr, text, label };
                } else {
                    history = { depth, fwd };   // ring empty (or disabled → depth 0): no target
                }
            }
        } catch (e) { /* old stub / history disabled — no history line */ }

        respond(req, { instructions, pc, breakpoints: bpAddrs, pendingBreakpoints: pendingAddrs, history });
    },

    // -- Get last cycle annotation (custom request) -------------------

    getCycleAnnotation(req) {
        respond(req, { annotation: lastCycleAnnotation });
    },

    // -- Replay availability (custom request) -------------------------
    // Cheap status for the Replay toolbar buttons: how many entries the cursor
    // can rewind (back) / replay forward (fwd). The extension sets its
    // oric-debug.canRewind / canReplayForward context keys from this on each stop.
    async histStatus(req) {
        let back = 0, fwd = 0;
        if (histEnabled) {
            try {
                const hs = await gdbCmd('qOricHistStatus');   // "hist:<back>,<prevpc>,<fwd>,<nextpc>"
                const hm = /^hist:(\d+),(?:[0-9a-fA-F]+|-),(\d+),(?:[0-9a-fA-F]+|-)$/.exec(hs || '');
                if (hm) { back = parseInt(hm[1], 10); fwd = parseInt(hm[2], 10); }
            } catch (e) { /* old stub / disabled */ }
        }
        respond(req, { enabled: histEnabled, back, fwd });
    },

    // -- Map an address to its source location (custom request) -------
    // Used by the disassembly view so a gutter toggle can create a real
    // SourceBreakpoint in VS Code's model rather than a view-local one.
    locationForAddress(req) {
        const addr = req.arguments && req.arguments.address;
        if (typeof addr !== 'number') { respond(req, { location: null }); return; }
        const src = sourceFor(addr & 0xffff);
        respond(req, { location: src ? { file: src.file, line: src.line } : null });
    },

    // -- Adapter-owned ADDRESS breakpoints (custom requests) ----------
    // For no-source / ROM addresses, armed directly (Z0) instead of via VS Code's
    // InstructionBreakpoint model (which it won't arm for programmatic bps). The Oric
    // Disassembly gutter and the Oric Breakpoints panel drive these.

    // Toggle: add (armed) if absent, remove if present. Reply { address, set }.
    async toggleAddressBreakpoint(req) {
        const addr = req.arguments && req.arguments.address;
        if (typeof addr !== 'number') { respond(req, { set: false }); return; }
        const a = addr & 0xFFFF;
        return withBpLock(async () => {
            let set;
            if (addrBps.has(a)) { if (addrBps.get(a).enabled) await disarmAddr(a); addrBps.delete(a); set = false; }
            else                { await armAddr(a); addrBps.set(a, { addr: a, enabled: true }); set = true; }
            respond(req, { address: a, set });
            fireAddrBps();   // extension refreshes the panel + disasm dots
        });
    },

    // Enable/disable without removing: a disabled address breakpoint stays in the
    // list but is disarmed (no Z0), so it won't stop. Reply {}.
    async setAddressBreakpointEnabled(req) {
        const addr = req.arguments && req.arguments.address;
        const enabled = !!(req.arguments && req.arguments.enabled);
        if (typeof addr !== 'number' || !addrBps.has(addr & 0xFFFF)) { respond(req, {}); return; }
        const a = addr & 0xFFFF;
        return withBpLock(async () => {
            const b = addrBps.get(a);
            if (enabled && !b.enabled) await armAddr(a);
            else if (!enabled && b.enabled) await disarmAddr(a);
            b.enabled = enabled;
            respond(req, {});
            fireAddrBps();
        });
    },

    // Remove (disarm) an address breakpoint. Reply {}.
    async clearAddressBreakpoint(req) {
        const addr = req.arguments && req.arguments.address;
        if (typeof addr === 'number' && addrBps.has(addr & 0xFFFF)) {
            const a = addr & 0xFFFF;
            return withBpLock(async () => { if (addrBps.get(a).enabled) await disarmAddr(a); addrBps.delete(a); respond(req, {}); fireAddrBps(); });
        }
        respond(req, {});
    },

    // Replace the whole address-breakpoint set (restore persisted ones at session
    // start — they're adapter-owned, so the extension re-sends them, preserving each
    // one's enabled state). Accepts [{address, enabled}] (or bare numbers). Reply {}.
    async setAddressBreakpoints(req) {
        const items = (req.arguments && Array.isArray(req.arguments.breakpoints)) ? req.arguments.breakpoints
                    : (req.arguments && Array.isArray(req.arguments.addresses)) ? req.arguments.addresses.map(a => ({ address: a, enabled: true }))
                    : [];
        return withBpLock(async () => {
            for (const [a, b] of addrBps) if (b.enabled) await disarmAddr(a);
            addrBps.clear();
            for (const it of items) {
                const a = (typeof it === 'number' ? it : it.address) & 0xFFFF;
                const enabled = (typeof it === 'number') ? true : (it.enabled !== false);
                if (addrBps.has(a)) continue;
                if (enabled) await armAddr(a);
                addrBps.set(a, { addr: a, enabled });
            }
            respond(req, {});
            fireAddrBps();
        });
    },

    // List the current address breakpoints (for the Oric Breakpoints panel).
    listAddressBreakpoints(req) {
        const list = [...addrBps.values()].map(b => ({
            address: b.addr,
            label: labelFor(b.addr),                 // build/ROM symbol name if any
            source: !!sourceFor(b.addr),
            enabled: b.enabled
        }));
        list.sort((x, y) => x.address - y.address);
        respond(req, { breakpoints: list });
    }
};
