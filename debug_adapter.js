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

function log(msg) {
    evt('output', { category: 'console', output: msg + '\n' });
}

function logVerbose(msg) {
    if (logLevel >= 2) log(msg);
}

// ----------------------------------------------------------------
// GDB RSP client  (TCP, $packet#checksum framing)
// ----------------------------------------------------------------

let sock = null;
let rxBuf = '';
let pendingResolve = null;
let pendingCmdType = null;   // first char of pending GDB command (to distinguish responses)
let gdbQueue = [];           // queued commands: [{cmd, resolve}]
let disconnecting = false;

function gdbConnect(host, port) {
    return new Promise((resolve, reject) => {
        const s = net.createConnection({ host: host, port: port }, () => {
            sock = s;
            resolve();
        });
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

        logVerbose('[GDB] ← ' + payload.substring(0, 40));
        // Route the packet: if we're waiting for a command response,
        // deliver it — UNLESS it's an unsolicited stop notification
        // (T05/S05) while we're waiting for a non-'?' response.
        if (pendingResolve) {
            const isStop = (payload[0] === 'T' || payload[0] === 'S');
            if (isStop && pendingCmdType !== '?') {
                // Unsolicited stop while waiting for a command response
                onStopReply(payload);
            } else {
                const r = pendingResolve;
                pendingResolve = null;
                pendingCmdType = null;
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
    logVerbose('[GDB] → ' + cmd.substring(0, 40));
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
    return new Promise(resolve => {
        if (!sock) { resolve(null); return; }
        if (pendingResolve) {
            // Another command is in flight — queue this one
            gdbQueue.push({ cmd, resolve });
        } else {
            // Send immediately
            pendingResolve = resolve;
            pendingCmdType = cmd[0];
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
let lineTable  = [];          // [{addr, file, line}] sorted by addr (from #LINES)
let regs       = null;        // { a, x, y, sp, pc, f }
let running    = false;
let config     = {};
let bpId       = 1;
let bps        = new Map();   // id -> { id, addr, name } (function breakpoints)
let ibps       = new Map();   // id -> { id, addr }       (instruction breakpoints)
let zpSymbols  = [];          // [{addr, name, size}] sorted by address
let configDone = false;
let pendingStop = null;       // deferred stopped event body
let srcBps     = new Map();   // file -> [{id, addr}] (source breakpoints per file)
let dataBps    = new Map();   // id -> { addr, accessType, gdbType } (data breakpoints)
let gotoTargetMap = new Map(); // targetId -> address (for goto/setNextStatement)
let lastCycleAnnotation = null; // { pc, cycles } from last step-over
let launchedProcess = null;     // child_process handle if we launched Oricutron

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
    for (const dir of sourceDirs) {
        let stat;
        try { stat = fs.statSync(dir); } catch (e) { continue; }
        if (stat.isFile()) {
            if (stat.mtimeMs > outMtime) return true;
            continue;
        }
        const files = readdirRecursive(dir);
        for (const f of files) {
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
        const isWin = process.platform === 'win32';
        const shell = isWin ? 'cmd' : 'sh';
        const shellArgs = isWin ? ['/c', command] : ['-c', command];
        const child = child_process.spawn(shell, shellArgs, {
            cwd: cwd || process.cwd(),
            windowsHide: true
        });
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

function loadSymbols(file) {
    symbols.clear();
    addrSym.clear();
    addrSource.clear();
    lineTable = [];
    zpSymbols = [];
    try {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        let isV2 = false;
        let section = 'sym';    // 'sym', 'files', or 'lines'
        let fileIndex = [];     // index -> absolute path (from #FILES)

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '#SYM V2')  { isV2 = true; section = 'sym'; continue; }
            if (trimmed === '#FILES')   { section = 'files'; fileIndex = []; continue; }
            if (trimmed === '#LINES')   { section = 'lines'; continue; }

            if (section === 'files') {
                // Format: "index filepath"
                const fm = trimmed.match(/^(\d+)\s+(.+)$/);
                if (fm) fileIndex[parseInt(fm[1], 10)] = fm[2];
                continue;
            }

            if (section === 'lines') {
                // Format: "HHHH fileIndex:line"
                const lm = trimmed.match(/^([0-9a-fA-F]{4})\s+(\d+):(\d+)$/);
                if (lm) {
                    const fi = parseInt(lm[2], 10);
                    lineTable.push({
                        addr: parseInt(lm[1], 16),
                        file: fileIndex[fi] || ('file#' + fi),
                        line: parseInt(lm[3], 10)
                    });
                }
                continue;
            }

            // section === 'sym': parse symbol entries
            const m = line.match(/^([0-9a-fA-F]{4})\s+(\S+)/);
            if (m) {
                const a = parseInt(m[1], 16);
                const n = m[2];
                symbols.set(n, a);
                if (!addrSym.has(a)) addrSym.set(a, n);
                if (isV2 && !addrSource.has(a)) {
                    const rest = line.substring(m[0].length).trim();
                    const cm = rest.match(/^(.+):(\d+)$/);
                    if (cm) {
                        addrSource.set(a, { file: cm[1], line: parseInt(cm[2], 10) });
                    }
                }
            }
        }

        // Sort line table by address (modules may be concatenated in any order)
        // then deduplicate: keep last entry for each address (the code-producing line)
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

        // Build sorted zero-page symbol list with inferred sizes
        const zpAddrs = [];
        for (const [a, n] of addrSym) {
            if (a <= 0xFF) zpAddrs.push({ addr: a, name: n });
        }
        zpAddrs.sort((a, b) => a.addr - b.addr);
        for (let i = 0; i < zpAddrs.length; i++) {
            const next = i + 1 < zpAddrs.length ? zpAddrs[i + 1].addr : zpAddrs[i].addr + 2;
            const size = Math.min(next - zpAddrs[i].addr, 2); // 1 or 2 bytes
            zpSymbols.push({ addr: zpAddrs[i].addr, name: zpAddrs[i].name, size: size });
        }
        log('Loaded ' + symbols.size + ' symbols, ' + lineTable.length + ' line entries from ' + file);
    } catch (e) {
        log('Could not load symbols: ' + e.message);
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

function onStopReply(payload) {
    running = false;
    regs = parseStopRegs(payload);
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

    // Handle cycle annotation from step-over
    // The annotation belongs on the JSR instruction line (PC-3), not the return address
    lastCycleAnnotation = null;
    if (cyclesDelta !== null && regs && regs.pc !== undefined) {
        const jsrPc = (regs.pc - 3) & 0xFFFF;
        const src = sourceFor(jsrPc);
        lastCycleAnnotation = {
            pc: jsrPc,
            cycles: cyclesDelta,
            symbol: addrSym.get(jsrPc) || null,
            file: src ? src.file : null,
            line: src ? src.line : 0
        };
    }

    // Determine stop reason
    let reason = sig === 5 ? 'step' : 'pause';
    let hitIds;

    if (watchAddr !== null) {
        reason = 'data breakpoint';
    } else if (sig === 5 && regs && regs.pc !== undefined) {
        for (const [id, bp] of bps) {
            if (bp.addr === regs.pc) { reason = 'breakpoint'; hitIds = [id]; break; }
        }
        if (!hitIds) {
            for (const [id, bp] of ibps) {
                if (bp.addr === regs.pc) { reason = 'breakpoint'; hitIds = [id]; break; }
            }
        }
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

function fmtOp(mode, lo, hi, pc, symMap) {
    const h2 = v => v.toString(16).toUpperCase().padStart(2, '0');
    const h4 = v => v.toString(16).toUpperCase().padStart(4, '0');
    // Resolve an address to a symbol name, or fall back to hex
    const s = (addr, w) => (symMap && symMap.get(addr)) || ('$' + (w === 2 ? h2(addr) : h4(addr)));
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
// Check if a symbol at symAddr is a plausible source mapping for targetAddr.
// Pages 0-3 ($0000-$03FF) are ZP/stack/page2/IO — a symbol there can never
// be a valid reference for code outside that page.  For the rest of memory
// ($0400+) allow up to 1KB offset within the same general region.
function isPlausibleMapping(symAddr, targetAddr) {
    const offset = targetAddr - symAddr;
    if (offset < 0) return false;
    // Symbol in pages 0-3: only valid if target is on the exact same page
    if (symAddr < 0x0400) return (symAddr >> 8) === (targetAddr >> 8);
    // Symbol in main/ROM memory: allow up to 1KB
    return offset <= 1024;
}

function sourceFor(addr) {
    // Binary search the line table for largest address <= addr
    if (lineTable.length > 0) {
        let lo = 0, hi = lineTable.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lineTable[mid].addr <= addr) { best = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        if (best >= 0 && isPlausibleMapping(lineTable[best].addr, addr))
            return lineTable[best];
    }
    // Fall back to symbol-based source map
    const exact = addrSource.get(addr);
    if (exact) return exact;
    let bestAddr = -1, bestSrc = null;
    for (const [a, src] of addrSource) {
        if (a <= addr && a > bestAddr) { bestAddr = a; bestSrc = src; }
    }
    if (bestSrc && !isPlausibleMapping(bestAddr, addr)) return null;
    return bestSrc;
}

// Resolve address to nearest symbol label
function labelFor(addr) {
    const exact = addrSym.get(addr);
    if (exact) return exact;
    let bestAddr = -1, bestName = null;
    for (const [a, n] of addrSym) {
        if (a <= addr && a > bestAddr) { bestAddr = a; bestName = n; }
    }
    if (bestName && isPlausibleMapping(bestAddr, addr))
        return bestName + '+$' + (addr - bestAddr).toString(16).toUpperCase();
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

    // Read stack bytes — single GDB command
    const stackAddr = 0x0100 + sp + 1;
    const readSize = Math.min(stackSize, 64);
    const reply = await gdbCmd('m' + stackAddr.toString(16) + ',' + readSize.toString(16));
    if (!reply || reply[0] === 'E') return [];

    const stk = [];
    for (let i = 0; i < reply.length; i += 2)
        stk.push(parseInt(reply.substring(i, i + 2), 16));

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

    let verifyMap = null;
    if (rangeSize <= 4096) {
        // Reasonable range — read in one shot
        const vReply = await gdbCmd('m' + minAddr.toString(16) + ',' + rangeSize.toString(16));
        if (vReply && vReply[0] !== 'E') {
            verifyMap = new Map();
            for (let i = 0; i < vReply.length; i += 2)
                verifyMap.set(minAddr + i / 2, parseInt(vReply.substring(i, i + 2), 16));
        }
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
            const opcode = verifyMap ? verifyMap.get(jsrAddr) : undefined;
            if (opcode === 0x20 || !verifyMap) {
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

const DISASM_CONTEXT = 40;      // instructions before/after PC
let disasmRefCounter = 100000;  // sourceReference counter (high to avoid clash)
const disasmRefMap = new Map(); // sourceReference → target address

// ----------------------------------------------------------------
// DAP request dispatcher
// ----------------------------------------------------------------

function handleDap(msg) {
    if (msg.type !== 'request') return;
    logVerbose('[DAP] ← ' + msg.command);
    const h = handlers[msg.command];
    if (h) {
        Promise.resolve(h(msg)).catch(e => {
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
            supportsDisassembleRequest: true,
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
        if (config.logLevel !== undefined) logLevel = config.logLevel;
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
        if (config.logLevel !== undefined) logLevel = config.logLevel;
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

        // --- Step 2: Launch Oricutron ---
        if (config.emulatorPath) {
            // VS Code sends noDebug inside arguments for Ctrl+F5
            const isNoDebug = config.noDebug || false;
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
        respond(req, {}, false, 'Could not connect to ' + host + ':' + port +
            ' after ' + retries + ' retries — is Oricutron running?');
    },

    configurationDone(req) {
        configDone = true;
        respond(req);

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

        // Build a stack frame with optional source location from V2 symbols
        function makeFrame(id, addr) {
            const frame = {
                id: id,
                name: labelFor(addr),
                line: 0,
                column: 0,
                instructionPointerReference: '0x' + addr.toString(16).padStart(4, '0')
            };
            const src = sourceFor(addr);
            if (src) {
                const filePath = path.isAbsolute(src.file) ? src.file
                    : config.sourceRoot ? path.resolve(config.sourceRoot, src.file)
                    : config.workspaceFolder ? path.resolve(config.workspaceFolder, src.file)
                    : src.file;
                frame.source = { name: path.basename(filePath), path: filePath };
                frame.line = src.line;
            } else {
                // No source mapping — provide a virtual disassembly source.
                // VS Code will request the content via the DAP 'source' request.
                const ref = ++disasmRefCounter;
                disasmRefMap.set(ref, addr);
                frame.source = {
                    name: 'Disassembly @ $' + addr.toString(16).toUpperCase().padStart(4, '0'),
                    sourceReference: ref
                };
                frame.line = DISASM_CONTEXT + 1; // PC is in the middle
            }
            return frame;
        }

        // Frame 0: current PC
        const stackFrames = [makeFrame(0, pc)];

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
        const scopes = [
            { name: 'Registers', variablesReference: 1, expensive: false },
            { name: 'Flags',     variablesReference: 2, expensive: false },
        ];
        if (zpSymbols.length > 0) {
            scopes.push({ name: 'Zero Page', variablesReference: 3, expensive: false });
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

        const h = (v, w) => '$' + v.toString(16).toUpperCase().padStart(w, '0');

        if (ref === 1) {
            respond(req, { variables: [
                { name: 'A',  value: h(regs.a, 2)  + ' (' + regs.a  + ')', variablesReference: 0 },
                { name: 'X',  value: h(regs.x, 2)  + ' (' + regs.x  + ')', variablesReference: 0 },
                { name: 'Y',  value: h(regs.y, 2)  + ' (' + regs.y  + ')', variablesReference: 0 },
                { name: 'SP', value: h(regs.sp, 2) + ' (' + regs.sp + ')', variablesReference: 0 },
                { name: 'PC', value: h(regs.pc, 4), memoryReference: '0x' + regs.pc.toString(16).padStart(4, '0'), variablesReference: 0 }
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
            // Zero page variables — read all 256 bytes, map symbols to values
            if (zpSymbols.length === 0) { respond(req, { variables: [] }); return; }
            const zpReply = await gdbCmd('m0,100');
            if (!zpReply || zpReply[0] === 'E') { respond(req, { variables: [] }); return; }
            const zp = [];
            for (let i = 0; i < zpReply.length && i < 512; i += 2)
                zp.push(parseInt(zpReply.substring(i, i + 2), 16));
            const vars = [];
            for (const s of zpSymbols) {
                const a = s.addr;
                if (a >= zp.length) continue;
                const hAddr = '$' + a.toString(16).toUpperCase().padStart(2, '0');
                let val;
                if (s.size >= 2 && a + 1 < zp.length) {
                    const w = zp[a] | (zp[a + 1] << 8);
                    val = '$' + w.toString(16).toUpperCase().padStart(4, '0') + ' (' + w + ')';
                } else {
                    val = '$' + zp[a].toString(16).toUpperCase().padStart(2, '0') + ' (' + zp[a] + ')';
                }
                vars.push({ name: hAddr + ' ' + s.name, value: val, variablesReference: 0 });
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
        // In disassembly view, the source path is like "0xABCD"
        let addr = 0;
        if (args.source && args.source.path) {
            const parsed = parseInt(args.source.path, 16);
            if (!isNaN(parsed)) addr = parsed & 0xFFFF;
        }
        // Also try line as a fallback (some views encode address there)
        if (addr === 0 && args.line) addr = args.line & 0xFFFF;

        const id = bpId++;  // unique target ID
        gotoTargetMap.set(id, addr);
        respond(req, {
            targets: [{
                id: id,
                label: labelFor(addr),
                line: 0,
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

    continue(req) {
        regs = null;
        respond(req, { allThreadsContinued: true });
        running = true;
        gdbWrite('c');
        evt('continued', { threadId: 1, allThreadsContinued: true });
    },

    next(req) {
        regs = null;
        respond(req);
        running = true;
        gdbWrite('N');
    },

    stepIn(req) {
        regs = null;
        respond(req);
        running = true;
        gdbWrite('s');
    },

    stepOut(req) {
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

        // Remove previous source breakpoints for this file
        const prev = srcBps.get(srcPath) || [];
        for (const bp of prev) {
            await gdbCmd('z0,' + bp.addr.toString(16) + ',1');
        }
        srcBps.set(srcPath, []);

        const result = [];
        const newBps = [];

        for (const sbp of (args.breakpoints || [])) {
            const reqLine = sbp.line;

            // Search line table for best match: same file, nearest line <= requested
            let bestAddr = -1, bestLine = -1;
            for (const entry of lineTable) {
                // Compare paths case-insensitively on Windows
                const match = path.resolve(entry.file).toLowerCase() === path.resolve(srcPath).toLowerCase();
                if (match && entry.line <= reqLine && entry.line > bestLine) {
                    bestLine = entry.line;
                    bestAddr = entry.addr;
                }
            }

            if (bestAddr >= 0) {
                const r = await gdbCmd('Z0,' + bestAddr.toString(16) + ',1');
                const id = bpId++;
                const ok = r === 'OK';
                newBps.push({ id: id, addr: bestAddr });
                result.push({
                    id: id,
                    verified: ok,
                    line: bestLine,
                    source: args.source,
                    message: ok ? undefined : 'Failed to set breakpoint'
                });
            } else {
                result.push({
                    id: bpId++,
                    verified: false,
                    message: 'No code at this line'
                });
            }
        }
        srcBps.set(srcPath, newBps);
        respond(req, { breakpoints: result });
    },

    async setFunctionBreakpoints(req) {
        // Clear all existing function breakpoints from the stub
        for (const [, bp] of bps) {
            await gdbCmd('z0,' + bp.addr.toString(16) + ',1');
        }
        bps.clear();

        // Set new ones by resolving symbol names to addresses
        const result = [];
        for (const fbp of (req.arguments.breakpoints || [])) {
            const name = fbp.name;
            const addr = symbols.get(name);
            if (addr !== undefined) {
                const r = await gdbCmd('Z0,' + addr.toString(16) + ',1');
                const id = bpId++;
                const ok = r === 'OK';
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
            await gdbCmd('z0,' + bp.addr.toString(16) + ',1');
        }
        ibps.clear();

        const result = [];
        for (const ibp of (req.arguments.breakpoints || [])) {
            const addr = (parseInt(ibp.instructionReference, 16) + (ibp.offset || 0)) & 0xFFFF;
            const r = await gdbCmd('Z0,' + addr.toString(16) + ',1');
            const id = bpId++;
            const ok = r === 'OK';
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
        const addr = disasmRefMap.get(ref);
        if (addr === undefined) {
            respond(req, { content: '; Source not available\n' });
            return;
        }

        // Read memory around the target address and disassemble
        const startAddr = Math.max(0, addr - DISASM_CONTEXT * 3);
        const totalBytes = (DISASM_CONTEXT * 2 + 20) * 3;
        const readAddr = startAddr & 0xFFFF;
        const readLen = Math.min(totalBytes, 0xFFFF - readAddr + 1);
        const reply = await gdbCmd('m' + readAddr.toString(16) + ',' + readLen.toString(16));
        if (!reply || reply[0] === 'E') {
            respond(req, { content: '; Failed to read memory at $' + readAddr.toString(16).toUpperCase().padStart(4, '0') + '\n' });
            return;
        }

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
                const operand = fmtOp(mode, lo, hi, a, addrSym);
                let bytes = '';
                for (let j = 0; j < sz && off + j < mem.length; j++)
                    bytes += mem[off + j].toString(16).toUpperCase().padStart(2, '0') + ' ';
                insts.push({ addr: a, bytes: bytes.trimEnd(), text: mne + (operand ? ' ' + operand : ''), sym: addrSym.get(a) });
                off += sz;
            } else {
                const bh = mem[off].toString(16).toUpperCase().padStart(2, '0');
                insts.push({ addr: a, bytes: bh, text: '.byte $' + bh });
                off += 1;
            }
        }

        // Find instruction at target addr
        let pivotIdx = 0;
        for (let i = 0; i < insts.length; i++) {
            if (insts[i].addr >= addr) { pivotIdx = i; break; }
        }

        // Extract window around pivot
        const startIdx = Math.max(0, pivotIdx - DISASM_CONTEXT);
        const endIdx = Math.min(insts.length, pivotIdx + DISASM_CONTEXT + 1);
        const window = insts.slice(startIdx, endIdx);

        // Format as assembly text
        const lines = [];
        for (const inst of window) {
            const ah = inst.addr.toString(16).toUpperCase().padStart(4, '0');
            if (inst.sym) lines.push(inst.sym + ':');
            lines.push(ah + '  ' + inst.bytes.padEnd(9) + ' ' + inst.text);
        }

        respond(req, { content: lines.join('\n') + '\n', mimeType: 'text/x-asm' });
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
                const operand = fmtOp(mode, lo, hi, a, addrSym);
                let opBytes = '';
                for (let j = 0; j < sz && off + j < mem.length; j++)
                    opBytes += mem[off + j].toString(16).toUpperCase().padStart(2, '0') + ' ';
                const instr = {
                    address: '0x' + a.toString(16).padStart(4, '0'),
                    instructionBytes: opBytes.trim(),
                    instruction: mne + (operand ? ' ' + operand : '')
                };
                const sym = addrSym.get(a);
                if (sym) instr.symbol = sym;
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

        // Try as bare symbol name
        const a = symbols.get(expr);
        if (a !== undefined) {
            respond(req, {
                result: '$' + a.toString(16).toUpperCase().padStart(4, '0'),
                variablesReference: 0
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

        // Try qOricEval as fallback for watch expressions
        {
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
        }

        // Help
        respond(req, {}, false,
            'Commands: A/X/Y/SP/PC (read) | A=$xx (write) | skip | goto $ADDR | goto SYMBOL | x $ADDR [LEN] | w $ADDR $VAL | sym NAME | ! <mon cmd> | <symbol>');
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
        const expr = req.arguments.expression || '';
        const count = req.arguments.count || 128;
        // Evaluate expression via qOricEval
        const hexExpr = Buffer.from(expr, 'utf8').toString('hex');
        const evalReply = await gdbCmd('qOricEval,' + hexExpr);
        if (!evalReply || !evalReply.startsWith('V')) {
            respond(req, { error: 'Invalid expression: ' + expr });
            return;
        }
        const addr = parseInt(evalReply.substring(1), 16);
        // Read memory
        const memReply = await gdbCmd('m' + addr.toString(16) + ',' + count.toString(16));
        respond(req, { address: addr, data: memReply || '', expression: expr });
    },

    logToConsole(req) {
        const text = (req.arguments && req.arguments.text) || '';
        log(text);
        respond(req, {});
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

    // -- Reset cycle counter (custom request) -------------------------

    async resetCycles(req) {
        const reply = await gdbCmd('qOricResetCycles');
        respond(req, { result: reply === 'OK' ? 'Cycles reset' : 'Failed' });
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

    // -- Get last cycle annotation (custom request) -------------------

    getCycleAnnotation(req) {
        respond(req, { annotation: lastCycleAnnotation });
    }
};
