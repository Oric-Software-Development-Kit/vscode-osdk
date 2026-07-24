'use strict';

const vscode = require('vscode');

// workspaceState key: per-project debug console log verbosity (0/1/2).
// Persists an explicit runtime choice across sessions; scoped to the workspace
// so each Oric project keeps its own preference.
const LOG_LEVEL_KEY = 'oric-debug.logLevel';

// workspaceState key: adapter-owned ADDRESS breakpoints (ROM / no-source). Unlike
// source breakpoints, VS Code doesn't persist these, so we mirror them here and
// re-arm them on session start. Stored as an array of numeric addresses.
const ADDR_BP_KEY = 'oric-debug.addressBreakpoints';

// workspaceState key: extension-owned WATCHPOINT events (access breakpoints with
// module scope + condition + log/[save]/[stop] actions). Like address bps, VS Code
// doesn't persist these; the extension is the source of truth and re-sends the full
// set to the adapter (oricSetWatchpoints) on session start / first stop / edit.
const WATCH_BP_KEY = 'oric-debug.watchpoints';

// Shared dimming for live-data webviews when the debugger isn't stopped (no session,
// or running): keep the last values but grey them out, so it's visually clear the data
// is stale rather than live. Providers add `class="stale"` on <body>.
const STALE_CSS = 'body.stale{opacity:.5;filter:grayscale(.35)}';

// workspaceState key: remembers gitlens.currentLine.enabled's prior value while
// we suppress it during a debug session, so a mid-session crash can still be
// recovered on next activation rather than leaving GitLens blame off forever.
const GITLENS_BLAME_KEY = 'oric-debug.gitlensBlamePrev';

// mtime of extension.js as loaded by THIS VS Code host (captured once at module
// load). If the on-disk file later becomes newer, the running host is stale and a
// window reload is needed. Only extension.js can go stale this way — the adapter
// and resolver.cjs respawn from disk on every debug session.
const loadedExtMtimeMs = (() => { try { return require('fs').statSync(__filename).mtimeMs; } catch (_) { return 0; } })();

// Warn (with a Reload action) when extension.js on disk is newer than what the
// host loaded — complements the adapter's session banner, which only reports disk
// mtimes and can't tell whether the running host matches them.
function warnIfStaleExtension(session) {
    let cur = 0;
    try { cur = require('fs').statSync(__filename).mtimeMs; } catch (_) { return; }
    if (!loadedExtMtimeMs || cur <= loadedExtMtimeMs + 1000) return; // 1s slack for fs mtime granularity
    const msg = 'Oric Debug: extension.js changed since this window loaded — reload to run the latest.';
    if (session) session.customRequest('logToConsole', { text: '⚠ ' + msg }).catch(() => {});
    vscode.window.showWarningMessage(msg, 'Reload Window').then(pick => {
        if (pick === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
}

// Canonical key for comparing filesystem paths across sources (symbol-file
// paths vs VS Code's editor.document.uri.fsPath). path.resolve normalizes the
// separators for the host OS (and, on Windows, e.g. "E:\a" vs "e:/a"), which is
// why a raw === compare of a symbol-file path against fsPath fails and
// decorations never render. Case folding is applied ONLY on case-insensitive
// filesystems (Windows, macOS) so Linux — where case matters — stays correct.
const nodePath = require('path');
// The one shared Oric key-id table (also used by the automation runner). Injected into the
// Oric Screen View webview so the page and the scripts speak identical key ids — one source.
const { KEYS: ORIC_KEY_TABLE } = require('./mcp/oric-keys.cjs');
// The one shared viz wire-protocol definition (framing, constants, palette, key uplink),
// mirrored from the emulator's viz_stream.c and shared with the MCP/playthrough VizClient.
const vizProto = require('./mcp/oric-viz-protocol.cjs');
const { createBridgeServer } = require('./mcp/bridge-server.cjs');
const { CONTROL: BRIDGE_CONTROL, DISCOVERY_FILE } = require('./mcp/oric-bridge-protocol.cjs');
const { VIZ_PORT_OFFSET } = vizProto;   // viz port = gdb port + 1
// Per-panel editor-tab icons (SVGs in images/). Webview iconPath needs a Uri, not a built-in
// codicon, so each panel gets a small purpose glyph (screen / memory grid / heat grid / disasm
// listing / search / book). Note: webview tab icons do NOT resolve `currentColor` to the theme
// (it falls back to black), so the SVGs are drawn white to stay visible on the dark theme. VS Code
// caches these icons by PATH, so the files are versioned (-v2) — bump the suffix if a glyph changes.
const panelIcon = name => vscode.Uri.file(nodePath.join(nodePath.dirname(__filename), 'images', name + '.svg'));
// Only the field sizes the frame DECODER below needs (framing itself lives in the module).
const VIZ_SCR_SIZE = vizProto.SCR_SIZE;
const VIZ_VIDBASES_SIZE = vizProto.VIZ_VIDBASES;
const VIZ_VIDRAM_MAIN = vizProto.VIZ_VIDRAM_MAIN;
const VIZ_VIDRAM_BOTTOM = vizProto.VIZ_VIDRAM_BOTTOM;
const caseInsensitiveFS = process.platform === 'win32' || process.platform === 'darwin';
const canonPath = p => {
    if (!p) return '';
    const r = nodePath.resolve(p);
    return caseInsensitiveFS ? r.toLowerCase() : r;
};

// Human-readable "go to definition" mouse gesture for hover hints. VS Code binds
// go-to-definition to the modifier NOT used for multi-cursor: when
// editor.multiCursorModifier is 'ctrlCmd', the gesture is Alt+Click; otherwise
// it's Ctrl+Click (Cmd+Click on macOS). Keeps the hint correct on any platform.
function gotoGesture() {
    const mod = vscode.workspace.getConfiguration('editor').get('multiCursorModifier');
    if (mod === 'ctrlCmd') return 'Alt+Click or F12';
    return (process.platform === 'darwin' ? 'Cmd+Click' : 'Ctrl+Click') + ' or F12';
}

// ----------------------------------------------------------------
// Peripheral display names
// ----------------------------------------------------------------

const VIA_REG_NAMES = [
    'ORB',   'ORA',   'DDRB',  'DDRA',
    'T1C-L', 'T1C-H', 'T1L-L', 'T1L-H',
    'T2C-L', 'T2C-H', 'SR',    'ACR',
    'PCR',   'IFR',   'IER',   'ORA2'
];

const AY_REG_NAMES = [
    'Ch.A Freq Lo',  'Ch.A Freq Hi',
    'Ch.B Freq Lo',  'Ch.B Freq Hi',
    'Ch.C Freq Lo',  'Ch.C Freq Hi',
    'Noise Period',   'Enable',
    'Ch.A Amp',       'Ch.B Amp',
    'Ch.C Amp',       'Env Period Lo',
    'Env Period Hi',  'Env Shape',
    'Port A'
];

const FDC_REG_NAMES = ['Status', 'Track', 'Sector', 'Data'];
const MD_REG_NAMES  = ['Control', 'INTRQ', 'DRQ', 'Drive', 'Side', 'Cur.Track'];
const ACIA_REG_NAMES = ['RX/TX', 'Status', 'Command', 'Control'];

// ----------------------------------------------------------------
// Formatting helpers
// ----------------------------------------------------------------

function h2(v) { return '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }
function bin8(v) { return '%' + (v & 0xFF).toString(2).padStart(8, '0'); }

function decodeViaIFR(v) {
    const bits = [];
    if (v & 0x01) bits.push('CA2');
    if (v & 0x02) bits.push('CA1');
    if (v & 0x04) bits.push('SR');
    if (v & 0x08) bits.push('CB2');
    if (v & 0x10) bits.push('CB1');
    if (v & 0x20) bits.push('T2');
    if (v & 0x40) bits.push('T1');
    return bits.length ? bits.join('|') : 'none';
}

function decodeAyEnable(v) {
    const parts = [];
    if (!(v & 0x01)) parts.push('ToneA');
    if (!(v & 0x02)) parts.push('ToneB');
    if (!(v & 0x04)) parts.push('ToneC');
    if (!(v & 0x08)) parts.push('NoiseA');
    if (!(v & 0x10)) parts.push('NoiseB');
    if (!(v & 0x20)) parts.push('NoiseC');
    return parts.length ? parts.join('|') : 'all off';
}

function decodeFdcStatus(v) {
    const bits = [];
    if (v & 0x01) bits.push('BUSY');
    if (v & 0x02) bits.push('DRQ');
    if (v & 0x04) bits.push('LOST');
    if (v & 0x08) bits.push('CRC');
    if (v & 0x10) bits.push('RNF');
    if (v & 0x20) bits.push('WRTERR');
    if (v & 0x40) bits.push('WRPROT');
    if (v & 0x80) bits.push('NOTRDY');
    return bits.length ? bits.join('|') : 'OK';
}

function decodeMdControl(v) {
    const parts = [];
    if (v & 0x01) parts.push('IRQEN');
    if (v & 0x02) parts.push('ROMDIS');
    if (v & 0x08) parts.push('DDENS');
    parts.push('Side' + ((v & 0x10) ? '1' : '0'));
    parts.push('Drv' + ((v >> 5) & 3));
    if (v & 0x80) parts.push('EPROM');
    return parts.join(' ');
}

// ----------------------------------------------------------------
// Registers WebviewViewProvider (compact HTML layout)
// ----------------------------------------------------------------

class RegistersWebviewProvider {
    constructor() {
        this._view = null;
        this._prev = {};  // previous values for change detection
        this._last = null; // last live {regs, flags, extra}, kept to show dimmed when stale
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: false };
        // Fetch current registers immediately if an oric-debug session is active
        // and stopped (so the panel isn't empty on open — matches the native VS
        // Code Registers view, which populates proactively). Without this the
        // panel shows nothing until the next stop event triggers refreshAll().
        const session = vscode.debug.activeDebugSession;
        if (session && session.type === 'oric-debug' && oricDebugStopped) {
            this.refresh(session);
        } else {
            this.markStale();
        }
    }

    refresh(session) {
        if (!this._view) return;
        if (!session || session.type !== 'oric-debug') {
            this.markStale();
            return;
        }
        Promise.all([
            session.customRequest('variables', { variablesReference: 1 }),
            session.customRequest('variables', { variablesReference: 2 }),
            session.customRequest('readCpuExtra')
        ]).then(([regResp, flagResp, extraResp]) => {
            const regs = {};
            if (regResp && regResp.variables)
                for (const v of regResp.variables) regs[v.name] = v.value;
            const flags = {};
            if (flagResp && flagResp.variables)
                for (const v of flagResp.variables) flags[v.name] = v.value;
            const extra = extraResp && extraResp.extra;
            this._last = { regs, flags, extra };
            this._updateHtml(regs, flags, extra, false);
        }).catch(() => this.markStale());
    }

    // No live data (no session or running): keep the last values but dimmed, so it's
    // obviously stale. Nothing ever shown yet → the plain "no session" placeholder.
    markStale() {
        if (!this._view) return;
        if (this._last) this._updateHtml(this._last.regs, this._last.flags, this._last.extra, true);
        else this._view.webview.html = '<body style="color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);padding:8px"><i>No debug session</i></body>';
    }

    _updateHtml(regs, flags, extra, stale) {
        if (!this._view || !regs) return;

        // Compare with previous values: returns CSS class 'v' or 'mod'
        const p = this._prev;
        const vc = (key, val) => {
            const changed = p[key] !== undefined && p[key] !== val;
            p[key] = val;
            return changed ? 'mod' : 'v';
        };
        // Flag: returns 'fon'/'foff' + ' mod' if changed
        const fc = (key, val) => {
            const on = val === '1';
            const changed = p[key] !== undefined && p[key] !== val;
            p[key] = val;
            return (on ? 'fon' : 'foff') + (changed ? ' mod' : '');
        };

        const flagNames = ['N', 'V', 'B', 'D', 'I', 'Z', 'C'];
        const flagKeys = ['N (Negative)', 'V (Overflow)', 'B (Break)', 'D (Decimal)', 'I (Interrupt)', 'Z (Zero)', 'C (Carry)'];
        let flagsHtml = flagNames.map((name, i) => {
            const val = flags[flagKeys[i]];
            return '<span class="' + fc('f' + name, val) + '" title="' + flagKeys[i] + '">' + name + '</span>';
        }).join(' ');

        function hex4(v) { return '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }

        const rv = (name) => {
            const val = regs[name] || '?';
            return '<span><span class="n">' + name + '</span>=<span class="' + vc('r' + name, val) + '">' + val + '</span></span>';
        };

        let extraHtml = '';
        if (extra) {
            const ex = (label, key, val) => {
                const s = val !== undefined ? (typeof val === 'number' ? (key === 'CY' || key === 'FM' || key === 'RS' ? val.toString() : hex4(val)) : val) : '?';
                return '<span><span class="n">' + label + '</span>=<span class="' + vc('x' + key, s) + '">' + s + '</span></span>';
            };
            extraHtml = `<div class="sep"></div>
<div class="r">
 ${ex('LPC', 'LPC', extra.L)} ${ex('CY', 'CY', extra.C)} ${ex('FM', 'FM', extra.F)} ${ex('RS', 'RS', extra.R)}
</div>
<div class="sep"></div>
<div class="r">
 ${ex('NMI', 'NMI', extra.N)} ${ex('RST', 'RST', extra.T)} ${ex('IRQ', 'IRQ', extra.I)}
</div>`;
        }

        this._view.webview.html = `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 4px 8px; margin: 0; }
.r { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 3px 0; align-items: baseline; }
.n { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
.v { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.mod { color: var(--vscode-charts-red, #e04040); }
.fon { color: var(--vscode-debugTokenExpression-number, #b5cea8); font-weight: bold; }
.fon.mod { color: var(--vscode-charts-red, #e04040); font-weight: bold; }
.foff { opacity: 0.35; }
.foff.mod { opacity: 1.0; color: var(--vscode-charts-red, #e04040); }
.sep { border-top: 1px solid var(--vscode-widget-border, #444); margin: 4px 0; }
${STALE_CSS}
</style></head><body class="${stale ? 'stale' : ''}">
<div class="r">
 ${rv('A')} ${rv('X')} ${rv('Y')} ${rv('SP')} ${rv('PC')}
</div>
<div class="sep"></div>
<div class="r">${flagsHtml}</div>${extraHtml}
</body></html>`;
    }
}

// ----------------------------------------------------------------
// Peripherals WebviewViewProvider (compact HTML layout)
// ----------------------------------------------------------------

class PeripheralsWebviewProvider {
    constructor() {
        this._view = null;
        this._prev = {};  // previous values for change detection
        this._last = null; // last live peripherals, kept to show dimmed when stale
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: false };
        // Fetch current peripherals immediately if an oric-debug session is active
        // and stopped (same fix as RegistersWebviewProvider — without this the
        // panel is empty until the next stop).
        const session = vscode.debug.activeDebugSession;
        if (session && session.type === 'oric-debug' && oricDebugStopped) {
            this.refresh(session);
        } else {
            this.markStale();
        }
    }

    refresh(session) {
        if (!this._view) return;
        if (!session || session.type !== 'oric-debug') {
            this.markStale();
            return;
        }
        session.customRequest('readPeripherals').then(resp => {
            const d = resp && resp.peripherals;
            if (d) { this._last = d; this._updateHtml(d, false); }
            else this.markStale();
        }).catch(() => this.markStale());
    }

    // No live data (no session or running): last values dimmed, else a placeholder.
    markStale() {
        if (!this._view) return;
        if (this._last) this._updateHtml(this._last, true);
        else this._view.webview.html = '<body style="color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);padding:8px"><i>No debug session</i></body>';
    }

    _updateHtml(d, stale) {
        if (!this._view || !d) return;

        // Compare with previous values: returns CSS class 'v' or 'mod'
        const p = this._prev;
        const vc = (key, val) => {
            const changed = p[key] !== undefined && p[key] !== val;
            p[key] = val;
            return changed ? 'mod' : 'v';
        };

        const sections = [];

        if (d.V) {
            let rows = '';
            for (let i = 0; i < d.V.length; i++) {
                let extra = '';
                if (i === 11 || i === 12) extra = ' ' + bin8(d.V[i]);
                else if (i === 13 || i === 14) extra = ' ' + decodeViaIFR(d.V[i]);
                const cls = vc('V' + i, d.V[i]);
                rows += '<span title="$030' + i.toString(16).toUpperCase() + '"><span class="n">' + VIA_REG_NAMES[i] + '</span>=<span class="' + cls + '">' + h2(d.V[i]) + '</span>' + (extra ? '<span class="x">' + extra + '</span>' : '') + '</span> ';
            }
            sections.push({ name: 'VIA 6522', addr: '$0300', html: rows });
        }

        if (d.A) {
            let rows = '';
            for (let i = 0; i < d.A.length; i++) {
                let extra = '';
                if (i === 7) extra = ' ' + decodeAyEnable(d.A[i]);
                const cls = vc('A' + i, d.A[i]);
                rows += '<span title="AY R' + i + '"><span class="n">' + AY_REG_NAMES[i] + '</span>=<span class="' + cls + '">' + h2(d.A[i]) + '</span>' + (extra ? '<span class="x">' + extra + '</span>' : '') + '</span> ';
            }
            sections.push({ name: 'AY-3-8912', addr: 'Sound', html: rows });
        }

        if (d.F) {
            let rows = '';
            for (let i = 0; i < d.F.length; i++) {
                let extra = '';
                if (i === 0) extra = ' ' + decodeFdcStatus(d.F[i]);
                const cls = vc('F' + i, d.F[i]);
                rows += '<span title="$031' + i.toString(16).toUpperCase() + '"><span class="n">' + FDC_REG_NAMES[i] + '</span>=<span class="' + cls + '">' + h2(d.F[i]) + '</span>' + (extra ? '<span class="x">' + extra + '</span>' : '') + '</span> ';
            }
            sections.push({ name: 'WD1793 FDC', addr: '$0310', html: rows });
        }

        if (d.M) {
            let rows = '';
            for (let i = 0; i < d.M.length; i++) {
                let extra = '';
                if (i === 0) extra = ' ' + decodeMdControl(d.M[i]);
                const cls = vc('M' + i, d.M[i]);
                rows += '<span><span class="n">' + MD_REG_NAMES[i] + '</span>=<span class="' + cls + '">' + h2(d.M[i]) + '</span>' + (extra ? '<span class="x">' + extra + '</span>' : '') + '</span> ';
            }
            sections.push({ name: 'Microdisc', addr: '$0314', html: rows });
        }

        if (d.C) {
            let rows = '';
            for (let i = 0; i < d.C.length; i++) {
                const cls = vc('C' + i, d.C[i]);
                rows += '<span title="$031' + (0xC + i).toString(16).toUpperCase() + '"><span class="n">' + ACIA_REG_NAMES[i] + '</span>=<span class="' + cls + '">' + h2(d.C[i]) + '</span></span> ';
            }
            sections.push({ name: 'ACIA 6551', addr: '$031C', html: rows });
        }

        let body = '';
        for (let s = 0; s < sections.length; s++) {
            if (s > 0) body += '<div class="hr"></div>';
            body += '<div class="hdr">' + sections[s].name + ' <span class="addr">' + sections[s].addr + '</span></div>';
            body += '<div class="r">' + sections[s].html + '</div>';
        }

        this._view.webview.html = `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 4px 8px; margin: 0; }
.r { display: flex; flex-wrap: wrap; gap: 2px 10px; margin: 2px 0 6px 0; }
.n { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
.v { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.mod { color: var(--vscode-charts-red, #e04040); }
.x { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.hdr { color: var(--vscode-sideBarSectionHeader-foreground, #ccc); font-weight: bold; font-size: 0.95em; margin-top: 2px; }
.addr { color: var(--vscode-descriptionForeground, #888); font-weight: normal; font-size: 0.9em; }
.hr { border-top: 1px solid var(--vscode-widget-border, #444); margin: 4px 0; }
${STALE_CSS}
</style></head><body class="${stale ? 'stale' : ''}">${body}</body></html>`;
    }
}

// ----------------------------------------------------------------
// Memory View Panel (editor tab — multiple instances supported)
// ----------------------------------------------------------------

const memoryPanels = [];
let memoryPanelCounter = 0;

function bytesForEntry(entry) {
    if (entry.format === 'graphic') {
        const wbytes = entry.w || 40, h = entry.h || 128;   // w = bytes/row (6 px each in HIRES)
        return wbytes * h;
    }
    return entry.rows * (entry.format === 'binary' ? 8 : 16);
}

function createMemoryPanel(context) {
    memoryPanelCounter++;
    const panel = vscode.window.createWebviewPanel(
        'oricMemory',
        'Oric Memory #' + memoryPanelCounter,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    wireMemoryPanel(panel, []);
    return panel;
}

// Wire up a memory panel (message handling, registration, html) and seed it with
// any restored entries. Shared by createMemoryPanel and the reload serializer so
// both behave identically (DRY).
function wireMemoryPanel(panel, initialEntries) {
    panel.iconPath = panelIcon('panel-memory-v2');   // tab glyph (create + reload both call this)
    const state = { entries: [], results: [] };
    for (const e of (initialEntries || [])) {
        if (!e || !e.expression) continue;
        const entry = { expression: e.expression, rows: e.rows || 8, format: e.format || 'hex',
            w: e.w || 40, h: e.h || 128, grid: !!e.grid, zoom: e.zoom || 2, decoder: e.decoder || 'hires', transp: e.transp || 'gray' };   // w = bytes/row
        state.entries.push(entry);
        state.results.push({ ...entry, address: null, data: '', error: null });
    }

    panel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'add' && msg.expression) {
            const expr = msg.expression.trim();
            if (expr && !state.entries.some(e => e.expression === expr)) {
                const entry = { expression: expr, rows: 8, format: 'hex', w: 40, h: 128, grid: false, zoom: 2, decoder: 'hires', transp: 'gray' };   // w = bytes/row
                state.entries.push(entry);
                state.results.push({ ...entry, address: null, data: '', error: null });
                const session = vscode.debug.activeDebugSession;
                if (session && session.type === 'oric-debug') {
                    evaluateOne(session, state, state.entries.length - 1).then(() => postResults(panel, state));
                } else {
                    postResults(panel, state);
                }
            }
        } else if (msg.type === 'remove' && typeof msg.index === 'number') {
            if (msg.index >= 0 && msg.index < state.entries.length) {
                state.entries.splice(msg.index, 1);
                state.results.splice(msg.index, 1);
                postResults(panel, state);
            }
        } else if (msg.type === 'edit' && typeof msg.index === 'number' && msg.expression) {
            // Change an existing entry's expression in place (no remove/re-add).
            if (msg.index >= 0 && msg.index < state.entries.length) {
                const expr = msg.expression.trim();
                if (expr) {
                    state.entries[msg.index].expression = expr;
                    const session = vscode.debug.activeDebugSession;
                    if (session && session.type === 'oric-debug') {
                        evaluateOne(session, state, msg.index).then(() => postResults(panel, state));
                    } else {
                        state.results[msg.index] = { ...state.entries[msg.index], address: null, data: '', error: null };
                        postResults(panel, state);
                    }
                }
            }
        } else if (msg.type === 'configure' && typeof msg.index === 'number') {
            if (msg.index >= 0 && msg.index < state.entries.length) {
                const entry = state.entries[msg.index];
                if (msg.rows !== undefined) entry.rows = Math.max(1, Math.min(128, msg.rows));
                if (msg.format !== undefined) entry.format = msg.format;
                if (msg.w !== undefined) entry.w = Math.max(1, Math.min(512, msg.w | 0));   // bytes/row
                if (msg.h !== undefined) entry.h = Math.max(1, Math.min(2048, msg.h | 0));  // scanlines
                if (msg.grid !== undefined) entry.grid = !!msg.grid;
                if (msg.zoom !== undefined) entry.zoom = Math.max(1, Math.min(16, msg.zoom | 0));
                if (msg.decoder !== undefined) entry.decoder = msg.decoder;
                if (msg.transp !== undefined) entry.transp = msg.transp;
                const session = vscode.debug.activeDebugSession;
                if (session && session.type === 'oric-debug') {
                    evaluateOne(session, state, msg.index).then(() => postResults(panel, state));
                } else {
                    state.results[msg.index] = { ...entry, address: state.results[msg.index].address, data: state.results[msg.index].data, error: state.results[msg.index].error };
                    postResults(panel, state);
                }
            }
        } else if (msg.type === 'gfxInspect') {
            // Relay a graphic-view hover to the ONE Screen View zoomer. No-op (never throws) if
            // that panel isn't open — the user's responsibility, per design.
            if (screenPanel) screenPanel.webview.postMessage({ type: 'gfxZoom', sub: msg.sub, pixels: msg.pixels, w: msg.w, h: msg.h, x: msg.x, y: msg.y, addr: msg.addr, byte: msg.byte, bit: msg.bit, color: msg.color });
        } else if (msg.type === 'hover') {
            showHoverHelp(msg.text);
        } else if (msg.type === 'hoverEnd') {
            showHoverHelp(null);
        }
    });

    panel.onDidDispose(() => {
        const idx = memoryPanels.indexOf(panelEntry);
        if (idx >= 0) memoryPanels.splice(idx, 1);
    });

    const panelEntry = { panel, state };
    memoryPanels.push(panelEntry);
    panel.webview.html = memoryPanelHtml();
    // Render restored entries (and evaluate them if a session is live).
    const session = vscode.debug.activeDebugSession;
    if (state.entries.length && session && session.type === 'oric-debug') {
        Promise.all(state.entries.map((_, i) => evaluateOne(session, state, i))).then(() => postResults(panel, state));
    } else {
        postResults(panel, state);
    }
    // If we're attaching mid-run, dim right away — the values are a snapshot, not live.
    panel.webview.postMessage({ type: 'setStale', stale: !!(session && session.type === 'oric-debug' && !oricDebugStopped) });
}

async function evaluateOne(session, state, index) {
    const entry = state.entries[index];
    const count = bytesForEntry(entry);
    try {
        const resp = await session.customRequest('evaluateMemory', { expression: entry.expression, count });
        if (resp.error) {
            state.results[index] = { ...entry, address: null, data: '', error: resp.error };
        } else {
            state.results[index] = { ...entry, address: resp.address, data: resp.data, error: null };
        }
    } catch (e) {
        state.results[index] = { ...entry, address: null, data: '', error: e.message || 'Evaluation failed' };
    }
}

function postResults(panel, state) {
    panel.webview.postMessage({ type: 'update', results: state.results });
}

// Dim/undim the memory panels: bytes can only be read when the CPU is halted, so while
// the emulator runs the panel shows a stale snapshot — dim it so that's obvious (same cue
// as the Registers/Peripherals views), and undim when a stop re-reads fresh values.
function setMemoryPanelsStale(stale) {
    for (const { panel } of memoryPanels) panel.webview.postMessage({ type: 'setStale', stale: !!stale });
}

function refreshMemoryPanels(session) {
    for (const { panel, state } of memoryPanels) {
        if (!session || session.type !== 'oric-debug') {
            state.results = state.entries.map(e => ({ ...e, address: null, data: '', error: null }));
            postResults(panel, state);
            panel.webview.postMessage({ type: 'setStale', stale: false });   // no session → blank, not a stale snapshot
            continue;
        }
        const promises = state.entries.map((_, i) => evaluateOne(session, state, i));
        Promise.all(promises).then(() => {
            postResults(panel, state);
            panel.webview.postMessage({ type: 'setStale', stale: false });   // fresh read at this stop
        }).catch(() => postResults(panel, state));
    }
}

function memoryPanelHtml() {
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 8px 12px; margin: 0; }
.input-row { display: flex; gap: 4px; margin-bottom: 10px; }
.input-row input[type="text"] { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 4px 24px 4px 8px; font-family: inherit; font-size: inherit; }
.input-row button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; font-size: inherit; }
.input-row button:hover { background: var(--vscode-button-hoverBackground); }
.input-wrap { position: relative; flex: 1; display: flex; }
.input-wrap .clear-btn { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--vscode-descriptionForeground, #888); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 3px; display: none; }
.input-wrap .clear-btn:hover { background: none; color: var(--vscode-foreground); }
.input-wrap input:not(:placeholder-shown) ~ .clear-btn { display: block; }
.entry { margin-bottom: 10px; }
.entry-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; gap: 6px; }
.entry-hdr .left { display: flex; align-items: center; gap: 4px; flex-shrink: 1; min-width: 0; }
.entry-hdr .expr { color: var(--vscode-debugTokenExpression-name, #9cdcfe); font-weight: bold; white-space: nowrap; }
.expr-input { background: transparent; color: var(--vscode-debugTokenExpression-name, #9cdcfe); font-weight: bold; font-family: inherit; font-size: inherit; border: 1px solid transparent; border-radius: 3px; padding: 1px 4px; min-width: 60px; max-width: 320px; }
.expr-input:hover { border-color: var(--vscode-input-border, #555); }
.expr-input:focus { outline: none; border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
.entry-hdr .addr { color: var(--vscode-debugTokenExpression-number, #b5cea8); white-space: nowrap; }
.entry-hdr .controls { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.rows-input { width: 38px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 1px 3px; font-family: inherit; font-size: 0.9em; text-align: center; }
.rows-label { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.fmt-select, .gfx-zoom, .gfx-dec, .gfx-transp { background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, #555)); padding: 1px 3px; font-family: inherit; font-size: 0.9em; }
.remove { cursor: pointer; color: var(--vscode-descriptionForeground, #888); padding: 0 2px; font-size: 1.2em; }
.remove:hover { color: var(--vscode-errorForeground, #f44); }
.dump { white-space: pre; line-height: 1.4; color: var(--vscode-editor-foreground); }
.dump .addr-col { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.dump .ascii { color: var(--vscode-descriptionForeground, #888); }
.error { color: var(--vscode-errorForeground, #f44); font-style: italic; }
.sep { border-top: 1px solid var(--vscode-widget-border, #444); margin: 8px 0; }
.empty { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
/* Graphic view controls + canvas */
.gfx-input { width: 44px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 1px 3px; font-family: inherit; font-size: 0.9em; text-align: center; }
.gfx-lbl { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; display: inline-flex; align-items: center; gap: 2px; }
.gfx-unit { color: var(--vscode-descriptionForeground, #888); font-size: 0.8em; }
.gfx-wrap { overflow: auto; background: #000; padding: 4px; border: 1px solid var(--vscode-widget-border, #444); display: inline-block; max-width: 100%; }
.gfx-canvas { display: block; image-rendering: pixelated; }
/* Dimmed while the emulator is running: memory can only be read when the CPU is halted,
   so these bytes are a snapshot from the last stop, not live. Undims on the next stop.
   Same cue the Registers/Peripherals/Watch views use (STALE_CSS). */
body.stale { opacity: 0.5; filter: grayscale(0.35); }
</style></head><body>
<div class="input-row">
    <span class="input-wrap"><input type="text" id="exprInput" placeholder="Expression: _Symbol, *_Ptr, $A000, _Buf+X" data-help="Add a memory watch — a symbol, *pointer, $address, or an expression like _Buf+X" /><button class="clear-btn" id="exprClear" data-help="Clear the expression (Esc)">×</button></span>
    <button id="addBtn" data-help="Add the expression as a new memory view">Add</button>
</div>
<div id="entries"><div class="empty">Add an expression to view memory</div></div>
<script>
const vscode = acquireVsCodeApi();
const input = document.getElementById('exprInput');
const addBtn = document.getElementById('addBtn');
const entriesDiv = document.getElementById('entries');

// --- Graphic view: decode Oric HIRES bytes -> pixels (matches Oricutron ula.c) ---
const PALETTE = [[0,0,0],[255,0,0],[0,255,0],[255,255,0],[0,0,255],[255,0,255],[0,255,255],[255,255,255]];
// (c & 0x60)==0 => serial attribute: 0x00 ink=c&7, 0x10 paper=c&7 (0x08 text/flash + 0x18
// mode ignored for a still image). Else 6 pixels from c & 0x3f (bit 5 = leftmost), inverse
// = c & 0x80 (swap ink/paper). ink/paper reset per row — a future pass adds an override for
// pixel-only buffers copied in attribute-preserve mode.
function hiresDecode(hex, w, h, stride) 
{
    const out = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) 
    {
        let fg = 7, bg = 0, x = 0;
        for (let col = 0; col < stride && x < w; col++) 
        {
            const idx = (row * stride + col) * 2;
            if (idx + 1 >= hex.length) break;
            const c = parseInt(hex.substring(idx, idx + 2), 16);
            const inv = (c & 0x80) !== 0;
            let data = c & 0x3f;
            if ((c & 0x60) === 0)
            {  
                // Attribute
                const a = c & 0x18;
                if (a === 0x00) fg = c & 7; else if (a === 0x10) bg = c & 7;
                data = 0;                
            } 
            // Graphics
            for (let p = 0; p < 6 && x < w; p++) 
            {
                const bit = (data >> (5 - p)) & 1;
                const color = bit ? fg : bg;
                out[row * w + x++] = inv ? (7-color) : color;
            }
        }
    }
    return out;
}
// Masked-sprite decoder (Encounter's software format — the real ULA can't show it). Bits 5-0
// = 6 px (bit 5 leftmost); bit 7 = LEFT-half (px 5-3) alpha, bit 6 = RIGHT-half (px 2-0) alpha
// (1 = transparent). ON pixels always draw ink; OFF pixels are transparent in a transparent
// half, else paper. From display.s _BlitSprite/_TableMask. 255 = transparent sentinel.
function maskedDecode(hex, w, h, stride) {
    const out = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
        let x = 0;
        for (let col = 0; col < stride && x < w; col++) {
            const idx = (row * stride + col) * 2;
            if (idx + 1 >= hex.length) break;
            const c = parseInt(hex.substring(idx, idx + 2), 16);
            const leftT = (c & 0x80) !== 0, rightT = (c & 0x40) !== 0;
            for (let p = 0; p < 6 && x < w; p++) {
                const on = (c >> (5 - p)) & 1;
                out[row * w + x++] = on ? 7 : (((p < 3) ? leftT : rightT) ? 255 : 0);
            }
        }
    }
    return out;
}
// Fill colour for a transparent (255) pixel — a NON-Oric solid (so it can't be mistaken for a
// real pixel), or a checkerboard. Default mid-gray.
function transpRGB(mode, x, y) {
    if (mode === 'checker') { const v = ((x + y) & 1) ? 102 : 153; return [v, v, v]; }
    if (mode === 'dark') return [48, 48, 48];
    return [128, 128, 128];   // 'gray'
}
const gfxState = {};   // idx -> { off, w, h, stride, base, zoom, grid, px, data, transp }
function drawGfxGrid(ctx, st) {
    ctx.strokeStyle = 'rgba(128,128,128,0.4)'; ctx.lineWidth = 1; ctx.beginPath();
    const z = st.zoom;
    for (let gx = 0; gx <= st.w; gx += 6) { const X = gx * z + 0.5; ctx.moveTo(X, 0); ctx.lineTo(X, st.h * z); }
    for (let gy = 0; gy <= st.h; gy += 8) { const Y = gy * z + 0.5; ctx.moveTo(0, Y); ctx.lineTo(st.w * z, Y); }
    ctx.stroke();
}
// Repaint one graphic canvas from its cached image (+ grid), optionally with the hover
// crosshair — the SAME dual-line (black/white/black) style as the Screen View overlay.
function drawGfxRedraw(i, hx, hy) {
    const st = gfxState[i];
    const canvas = document.querySelector('.gfx-canvas[data-idx="' + i + '"]');
    if (!st || !canvas) return;
    const z = st.zoom, W = st.w * z, H = st.h * z;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(st.off, 0, 0, W, H);
    if (st.grid) drawGfxGrid(ctx, st);
    if (hx >= 0) {
        const cx = Math.round((hx + 0.5) * z), cy = Math.round((hy + 0.5) * z);
        const lines = [{ o: -1, c: 'rgba(0,0,0,0.6)' }, { o: 0, c: 'rgba(255,255,255,0.8)' }, { o: 1, c: 'rgba(0,0,0,0.6)' }];
        ctx.lineWidth = 1;
        for (const l of lines) {
            ctx.strokeStyle = l.c;
            ctx.beginPath(); ctx.moveTo(cx + l.o + 0.5, 0); ctx.lineTo(cx + l.o + 0.5, H); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, cy + l.o + 0.5); ctx.lineTo(W, cy + l.o + 0.5); ctx.stroke();
        }
    }
}
function drawGfx(i, r) {
    const canvas = document.querySelector('.gfx-canvas[data-idx="' + i + '"]');
    if (!canvas) return;
    const stride = r.w || 40, h = r.h || 128, zoom = r.zoom || 2;   // stride = bytes/row
    const w = stride * 6;                                           // pixel width (6 px/byte)
    const decode = r.decoder === 'masked' ? maskedDecode : hiresDecode;
    const px = decode(r.data || '', w, h, stride);
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const octx = off.getContext('2d'), img = octx.createImageData(w, h);
    for (let j = 0; j < w * h; j++) {
        const v = px[j], o = j * 4;
        const rgb = (v === 255) ? transpRGB(r.transp, j % w, (j / w) | 0) : (PALETTE[v] || PALETTE[0]);
        img.data[o] = rgb[0]; img.data[o+1] = rgb[1]; img.data[o+2] = rgb[2]; img.data[o+3] = 255;
    }
    octx.putImageData(img, 0, 0);
    canvas.width = w * zoom; canvas.height = h * zoom;
    gfxState[i] = { off, w, h, stride, base: (typeof r.address === 'number' ? r.address : 0), zoom, grid: !!r.grid, px, data: r.data || '', transp: r.transp || 'gray' };
    drawGfxRedraw(i, -1);
    // Hover: dual-line crosshair here + relay to the ONE Screen View zoomer (no-op if that
    // panel is closed). New canvas elements each render, so property handlers don't stack.
    canvas.onmouseenter = () => {
        const st = gfxState[i]; if (!st) return;
        vscode.postMessage({ type: 'gfxInspect', sub: 'buf', pixels: Array.from(st.px), w: st.w, h: st.h, transp: st.transp });
    };
    canvas.onmousemove = (e) => {
        const st = gfxState[i]; if (!st) return;
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left) / st.zoom), y = Math.floor((e.clientY - rect.top) / st.zoom);
        if (x < 0 || x >= st.w || y < 0 || y >= st.h) return;
        drawGfxRedraw(i, x, y);
        const col = Math.floor(x / 6), bit = 5 - (x % 6);
        const addr = (st.base + y * st.stride + col) & 0xffff;
        const bidx = (y * st.stride + col) * 2;
        const byte = (st.data && bidx + 1 < st.data.length) ? parseInt(st.data.substring(bidx, bidx + 2), 16) : 0;
        vscode.postMessage({ type: 'gfxInspect', sub: 'at', x, y, addr, byte, bit, color: st.px[y * st.w + x] });
    };
    canvas.onmouseleave = () => { drawGfxRedraw(i, -1); vscode.postMessage({ type: 'gfxInspect', sub: 'end' }); };
}

function addExpr() {
    const expr = input.value.trim();
    if (expr) {
        vscode.postMessage({ type: 'add', expression: expr });
        input.value = '';
    }
}
addBtn.addEventListener('click', addExpr);
input.addEventListener('keydown', e => { if (e.key === 'Enter') addExpr(); else if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; } });
document.getElementById('exprClear').addEventListener('click', () => { input.value = ''; input.focus(); });
// Status-bar hover help (no native tooltips — a large cursor covers them). Delegated so it also
// covers the dynamically-rendered per-row controls; the panel forwards these to showHoverHelp.
document.body.addEventListener('mouseover', e => { const el = e.target.closest('[data-help]'); if (el) vscode.postMessage({ type: 'hover', text: el.getAttribute('data-help') }); });
document.body.addEventListener('mouseout', e => { const el = e.target.closest('[data-help]'); if (el) vscode.postMessage({ type: 'hoverEnd' }); });

function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDump(address, hexData, rows, format) {
    if (!hexData) return '<span class="error">No data</span>';
    const bpr = format === 'binary' ? 8 : 16;
    const lines = [];
    for (let row = 0; row < rows; row++) {
        const rowAddr = (address + row * bpr) & 0xFFFF;
        const addrStr = rowAddr.toString(16).toUpperCase().padStart(4, '0');
        let content = '';

        if (format === 'hex') {
            let hexPart = '';
            let asciiPart = '';
            for (let col = 0; col < 16; col++) {
                const idx = (row * 16 + col) * 2;
                if (idx + 1 < hexData.length) {
                    const bh = hexData.substring(idx, idx + 2).toUpperCase();
                    const bv = parseInt(bh, 16);
                    hexPart += bh + ' ';
                    asciiPart += (bv >= 32 && bv < 127) ? String.fromCharCode(bv) : '.';
                } else { hexPart += '   '; asciiPart += ' '; }
                if (col === 7) hexPart += ' ';
            }
            content = hexPart + ' <span class="ascii">' + escapeHtml(asciiPart) + '</span>';
        } else if (format === 'words') {
            let parts = '';
            for (let w = 0; w < 8; w++) {
                const idx = (row * 16 + w * 2) * 2;
                if (idx + 3 < hexData.length) {
                    const lo = parseInt(hexData.substring(idx, idx + 2), 16);
                    const hi = parseInt(hexData.substring(idx + 2, idx + 4), 16);
                    parts += '$' + ((hi << 8) | lo).toString(16).toUpperCase().padStart(4, '0') + ' ';
                } else { parts += '      '; }
                if (w === 3) parts += ' ';
            }
            content = parts;
        } else if (format === 'decimal') {
            let parts = '';
            for (let col = 0; col < 16; col++) {
                const idx = (row * 16 + col) * 2;
                if (idx + 1 < hexData.length) {
                    parts += parseInt(hexData.substring(idx, idx + 2), 16).toString().padStart(3, ' ') + ' ';
                } else { parts += '    '; }
                if (col === 7) parts += ' ';
            }
            content = parts;
        } else if (format === 'binary') {
            let parts = '';
            for (let col = 0; col < 8; col++) {
                const idx = (row * 8 + col) * 2;
                if (idx + 1 < hexData.length) {
                    parts += parseInt(hexData.substring(idx, idx + 2), 16).toString(2).padStart(8, '0') + ' ';
                } else { parts += '         '; }
                if (col === 3) parts += ' ';
            }
            content = parts;
        }
        lines.push('<span class="addr-col">' + addrStr + '</span>: ' + content);
    }
    return lines.join('\\n');
}

function renderResults(results) {
    // Persist the entry list so the panel's expressions survive a window reload
    // (the WebviewPanelSerializer receives this state).
    vscode.setState({ entries: (results || []).map(r => ({ expression: r.expression, rows: r.rows, format: r.format, w: r.w, h: r.h, grid: r.grid, zoom: r.zoom, decoder: r.decoder, transp: r.transp })) });
    if (!results || results.length === 0) {
        entriesDiv.innerHTML = '<div class="empty">Add an expression to view memory</div>';
        return;
    }
    let html = '';
    results.forEach((r, i) => {
        if (i > 0) html += '<div class="sep"></div>';
        const addrStr = r.address !== null ? ' \\u2192 $' + r.address.toString(16).toUpperCase().padStart(4, '0') : '';
        const fmtOpts = ['hex','words','decimal','binary','graphic'];
        const fmtLabels = ['Hex','Words','Decimal','Binary','Graphic'];
        let selHtml = '<select class="fmt-select" data-idx="' + i + '" data-help="Display format for these bytes (Hex / Words / Decimal / Binary / Graphic)">';
        for (let f = 0; f < fmtOpts.length; f++) {
            selHtml += '<option value="' + fmtOpts[f] + '"' + (r.format === fmtOpts[f] ? ' selected' : '') + '>' + fmtLabels[f] + '</option>';
        }
        selHtml += '</select>';

        html += '<div class="entry">';
        html += '<div class="entry-hdr">';
        html += '<span class="left"><input class="expr-input" data-idx="' + i + '" data-orig="' + escapeHtml(r.expression) + '" value="' + escapeHtml(r.expression) + '" spellcheck="false" data-help="Edit the expression, Enter to apply (e.g. messagePtr \\u2192 *messagePtr)"><span class="addr">' + addrStr + '</span></span>';
        const isGfx = r.format === 'graphic';
        html += '<span class="controls">';
        if (isGfx) {
            html += '<select class="gfx-dec" data-idx="' + i + '" data-help="Graphic decoder (HIRES or Masked)">';
            [['hires','HIRES'],['masked','Masked']].forEach(o => { html += '<option value="' + o[0] + '"' + ((r.decoder || 'hires') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; });
            html += '</select>';
            html += '<span class="gfx-lbl" data-help="Width in bytes (6 pixels each)">W<input type="number" class="gfx-input gfx-w" data-idx="' + i + '" value="' + (r.w || 40) + '" min="1" max="512"><span class="gfx-unit">B</span></span>';
            html += '<span class="gfx-lbl" data-help="Height in scanlines">H<input type="number" class="gfx-input gfx-h" data-idx="' + i + '" value="' + (r.h || 128) + '" min="1" max="2048"></span>';
            html += '<label class="gfx-lbl" data-help="Overlay a pixel grid on the graphic view"><input type="checkbox" class="gfx-grid" data-idx="' + i + '"' + (r.grid ? ' checked' : '') + '> grid</label>';
            if ((r.decoder || 'hires') === 'masked') {
                html += '<select class="gfx-transp" data-idx="' + i + '" data-help="How transparent (masked) pixels are shown">';
                [['gray','Gray'],['dark','Dark'],['checker','Checker']].forEach(o => { html += '<option value="' + o[0] + '"' + ((r.transp || 'gray') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; });
                html += '</select>';
            }
            html += '<select class="gfx-zoom" data-idx="' + i + '" data-help="Zoom factor for the graphic view">';
            [1,2,3,4].forEach(z => { html += '<option value="' + z + '"' + ((r.zoom || 2) === z ? ' selected' : '') + '>' + z + 'x</option>'; });
            html += '</select>';
        } else {
            html += '<input type="number" class="rows-input" data-idx="' + i + '" value="' + r.rows + '" min="1" max="128" data-help="Number of rows to display">';
            html += '<span class="rows-label">rows</span>';
        }
        html += selHtml;
        html += '<span class="remove" data-idx="' + i + '" data-help="Remove this memory view">\\u00d7</span>';
        html += '</span></div>';
        if (r.error) {
            html += '<div class="error">' + escapeHtml(r.error) + '</div>';
        } else if (isGfx) {
            html += '<div class="gfx-wrap"><canvas class="gfx-canvas" data-idx="' + i + '"></canvas></div>';
        } else {
            html += '<div class="dump">' + formatDump(r.address, r.data, r.rows, r.format) + '</div>';
        }
        html += '</div>';
    });
    entriesDiv.innerHTML = html;

    document.querySelectorAll('.remove').forEach(el => {
        el.addEventListener('click', () => {
            vscode.postMessage({ type: 'remove', index: parseInt(el.dataset.idx) });
        });
    });
    document.querySelectorAll('.fmt-select').forEach(el => {
        el.addEventListener('change', () => {
            vscode.postMessage({ type: 'configure', index: parseInt(el.dataset.idx), format: el.value });
        });
    });
    document.querySelectorAll('.rows-input').forEach(el => {
        el.addEventListener('change', () => {
            vscode.postMessage({ type: 'configure', index: parseInt(el.dataset.idx), rows: parseInt(el.value) || 8 });
        });
    });
    // Edit an entry's expression in place (Enter or blur applies + re-evaluates).
    document.querySelectorAll('.expr-input').forEach(el => {
        const commit = () => {
            const v = el.value.trim();
            if (v && v !== el.dataset.orig) {
                el.dataset.orig = v;
                vscode.postMessage({ type: 'edit', index: parseInt(el.dataset.idx), expression: v });
            }
        };
        el.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
            else if (e.key === 'Escape') { el.value = el.dataset.orig; el.blur(); }
        });
        el.addEventListener('blur', commit);
    });
    // Graphic entries: draw the canvas, and wire the W/H/grid/zoom controls.
    results.forEach((r, i) => { if (r.format === 'graphic' && !r.error) drawGfx(i, r); });
    document.querySelectorAll('.gfx-w').forEach(el => el.addEventListener('change', () =>
        vscode.postMessage({ type: 'configure', index: parseInt(el.dataset.idx), w: parseInt(el.value) || 40 })));
    document.querySelectorAll('.gfx-h').forEach(el => el.addEventListener('change', () =>
        vscode.postMessage({ type: 'configure', index: parseInt(el.dataset.idx), h: parseInt(el.value) || 128 })));
    document.querySelectorAll('.gfx-grid').forEach(el => el.addEventListener('change', () =>
        vscode.postMessage({ type: 'configure', index: parseInt(el.dataset.idx), grid: el.checked })));
    document.querySelectorAll('.gfx-zoom').forEach(el => el.addEventListener('change', () =>
        vscode.postMessage({ type: 'configure', index: parseInt(el.dataset.idx), zoom: parseInt(el.value) || 2 })));
    document.querySelectorAll('.gfx-dec').forEach(el => el.addEventListener('change', () =>
        vscode.postMessage({ type: 'configure', index: parseInt(el.dataset.idx), decoder: el.value })));
    document.querySelectorAll('.gfx-transp').forEach(el => el.addEventListener('change', () =>
        vscode.postMessage({ type: 'configure', index: parseInt(el.dataset.idx), transp: el.value })));
}

window.addEventListener('message', e => {
    if (e.data.type === 'update') renderResults(e.data.results);
    else if (e.data.type === 'setStale') document.body.classList.toggle('stale', !!e.data.stale);
});
</script>
</body></html>`;
}

// ----------------------------------------------------------------
// XA Quick Reference Panel
// ----------------------------------------------------------------

function createXaReferencePanel() {
    const panel = vscode.window.createWebviewPanel(
        'xaReference', 'XA Quick Reference',
        vscode.ViewColumn.One, { enableScripts: true }
    );
    panel.iconPath = panelIcon('panel-reference-v2');
    panel.webview.html = xaReferenceHtml();
    return panel;
}

function xaReferenceHtml() {
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 12px 20px; margin: 0; max-width: 960px; }
.search-bar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 0 12px 0; z-index: 10; }
.search-bar input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 6px 28px 6px 10px; font-family: inherit; font-size: inherit; }
.search-bar input:focus { outline: 1px solid var(--vscode-focusBorder); }
.search-bar .clear-btn { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--vscode-descriptionForeground, #888); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 3px; display: none; }
.search-bar .clear-btn:hover { color: var(--vscode-foreground); }
.search-bar input:not(:placeholder-shown) ~ .clear-btn { display: block; }
h2 { color: var(--vscode-sideBarSectionHeader-foreground, #ccc); font-size: 1.15em; margin: 18px 0 8px 0; border-bottom: 1px solid var(--vscode-widget-border, #444); padding-bottom: 4px; }
h2:first-of-type { margin-top: 8px; }
.entry { margin: 0 0 14px 0; padding: 8px 10px; background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04)); border-radius: 4px; border-left: 3px solid var(--vscode-debugTokenExpression-name, #9cdcfe); }
.entry-name { color: var(--vscode-debugTokenExpression-name, #9cdcfe); font-weight: bold; font-size: 1.05em; }
.entry-aliases { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; margin-left: 8px; }
.entry-syntax { color: var(--vscode-debugTokenExpression-number, #b5cea8); margin: 3px 0; }
.entry-desc { margin: 3px 0; line-height: 1.4; }
.entry-example { background: var(--vscode-textBlockQuote-background, rgba(0,0,0,0.2)); color: var(--vscode-debugTokenExpression-number, #b5cea8); padding: 4px 8px; margin: 4px 0 0 0; border-radius: 3px; white-space: pre; font-size: 0.95em; }
.category { display: none; }
.category.visible { display: block; }
.no-results { color: var(--vscode-descriptionForeground, #888); font-style: italic; padding: 20px 0; text-align: center; }
</style></head><body>
<div class="search-bar">
    <input type="text" id="searchInput" placeholder="Search directives... (e.g. byt, segment, define)" autofocus /><button class="clear-btn" id="clearBtn" title="Clear (Esc)">×</button>
</div>
<div id="content"></div>
<script>
const directives = [
  { cat:'Data Definition', items:[
    { n:'.byt', a:'.byte, .db', s:'.byt value [, value ...]', d:'Define one or more byte values in the output.', e:'.byt $41, $42, $43    ; outputs bytes A, B, C\\n.byt <label           ; low byte of label' },
    { n:'.word', a:'.dw', s:'.word value [, value ...]', d:'Define one or more 16-bit words (little-endian).', e:'.word $1234, label   ; two 16-bit values' },
    { n:'.long', a:'', s:'.long value [, value ...]', d:'Define one or more 24-bit values (little-endian). Used for 65816 addressing.', e:'.long $123456        ; three bytes, lo-mid-hi' },
    { n:'.asc', a:'', s:'.asc "string"', d:'Embed an ASCII string. No terminator added automatically.', e:'.asc "Hello"         ; 5 bytes: $48 $65 $6C $6C $6F' },
    { n:'.scr', a:'', s:'.scr "string"', d:'Embed a screen-code string (bit 7 set on each character). Used for Oric HIRES text.', e:'.scr "Title"         ; screen-code encoded' },
    { n:'.psc', a:'', s:'.psc "string"', d:'Embed a packed screen-code string (alternate encoding).', e:'.psc "Test"          ; packed screen codes' },
    { n:'.dsb', a:'.dupb, .blkb', s:'.dsb count [, fill]', d:'Reserve count bytes. If fill is given, emit that value; otherwise reserve (BSS) space.', e:'.dsb 256, 0          ; 256 zero bytes\\n.dsb 16               ; reserve 16 bytes (BSS)' },
  ]},
  { cat:'Segments', items:[
    { n:'.text', a:'', s:'.text', d:'Switch to the code/text segment. This is the default segment for executable code.', e:'.text\\n    lda #0' },
    { n:'.data', a:'', s:'.data', d:'Switch to the initialized data segment. Used for tables and constant data.', e:'.data\\nmy_table .byt 1,2,3' },
    { n:'.bss', a:'', s:'.bss', d:'Switch to the uninitialized data segment. No bytes emitted; just reserves space.', e:'.bss\\nbuffer .dsb 256' },
    { n:'.zero', a:'', s:'.zero', d:'Switch to the zero-page segment ($00-$FF). Variables here use faster addressing modes.', e:'.zero\\nptr .dsb 2          ; 2-byte ZP pointer' },
  ]},
  { cat:'Scope Blocks', items:[
    { n:'.( / .)', a:'', s:'.( ... .)', d:'Create an anonymous scope block. Labels defined inside are local and not visible outside.', e:'.(\\n    ldx #0\\nloop  inx\\n    bne loop   ; loop is local\\n.)' },
    { n:'.block / .bend', a:'', s:'.block [name] ... .bend', d:'Create a named scope block. Internal labels are accessed as name.label from outside.', e:'.block player\\n  x .dsb 1\\n  y .dsb 1\\n.bend\\n; access as player.x' },
  ]},
  { cat:'Layout', items:[
    { n:'.align', a:'', s:'.align boundary [, fill]', d:'Align the program counter to a power-of-two boundary. Optional fill byte (default $00).', e:'.align 256           ; align to page boundary' },
    { n:'.fopt', a:'', s:'.fopt option', d:'Set file options (tape header options for Oric).', e:'.fopt 1              ; set file option' },
    { n:'.bin', a:'', s:'.bin "filename" [, skip [, length]]', d:'Include a raw binary file. Optionally skip bytes from the start and limit length.', e:'.bin "sprite.raw"    ; include entire file\\n.bin "data.bin", 4, 128  ; skip 4, read 128' },
  ]},
  { cat:'Assertions', items:[
    { n:'.assert', a:'', s:'.assert expression', d:'Halt assembly with an error if the expression evaluates to zero (false).', e:'.assert * < $C000   ; error if PC >= $C000' },
    { n:'.asserteq', a:'', s:'.asserteq expr1, expr2', d:'Halt assembly with an error if the two expressions are not equal.', e:'.asserteq end-start, 256  ; must be exactly 256 bytes' },
  ]},
  { cat:'Compatibility', items:[
    { n:'.end', a:'', s:'.end', d:'Mark the end of the source file. Anything after this line is ignored.', e:'.end\\n; everything below ignored' },
    { n:'.list', a:'', s:'.list', d:'Enable assembly listing output (if the assembler supports listing files).', e:'.list' },
    { n:'.xlist', a:'', s:'.xlist', d:'Disable assembly listing output.', e:'.xlist' },
    { n:'.dft', a:'', s:'.dft', d:'Reset assembler defaults. Compatibility directive.', e:'.dft' },
  ]},
  { cat:'PC Control', items:[
    { n:'*=', a:'', s:'*= expression', d:'Set the program counter to an explicit address. Use sparingly; prefer segment directives and let the linker/assembler assign addresses.', e:'*= $0500             ; set PC to $0500' },
  ]},
  { cat:'Preprocessor', items:[
    { n:'#define', a:'', s:'#define NAME value\\n#define NAME(args) body', d:'Define a text macro. Can be a simple substitution or parameterized.', e:'#define SCREEN $BB80\\n#define MAX(a,b) (((a)>(b))?(a):(b))' },
    { n:'#include', a:'', s:'#include "filename"', d:'Include another source file at this point.', e:'#include "macros.h"' },
    { n:'#ifdef', a:'', s:'#ifdef NAME', d:'Assemble the following block only if NAME is defined.', e:'#ifdef DEBUG\\n    jsr trace\\n#endif' },
    { n:'#ifndef', a:'', s:'#ifndef NAME', d:'Assemble the following block only if NAME is not defined.', e:'#ifndef RELEASE\\n    .byt "DBG"\\n#endif' },
    { n:'#if', a:'', s:'#if expression', d:'Assemble the following block only if expression is non-zero.', e:'#if VERSION >= 2\\n    jsr new_feature\\n#endif' },
    { n:'#else', a:'', s:'#else', d:'Alternate branch for #if / #ifdef / #ifndef.', e:'#ifdef PAL\\n    lda #50\\n#else\\n    lda #60\\n#endif' },
    { n:'#elif', a:'', s:'#elif expression', d:'Else-if branch for #if chains.', e:'#if MODE==1\\n    ..\\n#elif MODE==2\\n    ..\\n#endif' },
    { n:'#endif', a:'', s:'#endif', d:'End a conditional assembly block.', e:'#endif' },
    { n:'#undef', a:'', s:'#undef NAME', d:'Remove a previously defined macro.', e:'#undef DEBUG' },
    { n:'#pragma', a:'', s:'#pragma option', d:'Set assembler pragma options (e.g. character encoding).', e:'#pragma charmap $41, $01' },
  ]},
  { cat:'65816 Width Modes', items:[
    { n:'.al', a:'', s:'.al', d:'Set accumulator to 16-bit (long) mode. 65816 only.', e:'.al\\n    lda #$1234   ; 16-bit immediate' },
    { n:'.as', a:'', s:'.as', d:'Set accumulator to 8-bit (short) mode. 65816 only. This is the default.', e:'.as\\n    lda #$12     ; 8-bit immediate' },
    { n:'.xl', a:'', s:'.xl', d:'Set index registers to 16-bit (long) mode. 65816 only.', e:'.xl\\n    ldx #$0400   ; 16-bit index' },
    { n:'.xs', a:'', s:'.xs', d:'Set index registers to 8-bit (short) mode. 65816 only. This is the default.', e:'.xs\\n    ldx #$10     ; 8-bit index' },
  ]},
];

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function render(filter) {
    const f = filter.toLowerCase().trim();
    const content = document.getElementById('content');
    let html = '';
    let anyMatch = false;

    for (const cat of directives) {
        const matched = cat.items.filter(item => {
            if (!f) return true;
            return item.n.toLowerCase().includes(f)
                || item.a.toLowerCase().includes(f)
                || item.d.toLowerCase().includes(f)
                || item.s.toLowerCase().includes(f)
                || item.cat && item.cat.toLowerCase().includes(f);
        });
        if (matched.length === 0 && f) continue;
        const items = f ? matched : cat.items;
        if (items.length === 0) continue;
        anyMatch = true;

        html += '<div class="category visible"><h2>' + escHtml(cat.cat) + '</h2>';
        for (const item of items) {
            html += '<div class="entry">';
            html += '<span class="entry-name">' + escHtml(item.n) + '</span>';
            if (item.a) html += '<span class="entry-aliases"> (also: ' + escHtml(item.a) + ')</span>';
            html += '<div class="entry-syntax">' + escHtml(item.s) + '</div>';
            html += '<div class="entry-desc">' + escHtml(item.d) + '</div>';
            if (item.e) html += '<div class="entry-example">' + escHtml(item.e) + '</div>';
            html += '</div>';
        }
        html += '</div>';
    }

    if (!anyMatch) {
        html = '<div class="no-results">No directives matching "' + escHtml(f) + '"</div>';
    }
    content.innerHTML = html;
}

const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', e => render(e.target.value));
searchInput.addEventListener('keydown', e => { if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); searchInput.value = ''; render(''); } });
document.getElementById('clearBtn').addEventListener('click', () => { searchInput.value = ''; searchInput.focus(); render(''); });
render('');
</script>
</body></html>`;
}

// ----------------------------------------------------------------
// 6502 Opcode Reference Panel
// ----------------------------------------------------------------

function create6502ReferencePanel() {
    const panel = vscode.window.createWebviewPanel(
        'opcodeReference', '6502 Opcode Reference',
        vscode.ViewColumn.One, { enableScripts: true }
    );
    panel.iconPath = panelIcon('panel-reference-v2');
    panel.webview.html = opcodeReferenceHtml();
    return panel;
}

function opcodeReferenceHtml() {
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 12px 20px; margin: 0; max-width: 1100px; }
.search-bar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 0 12px 0; z-index: 10; }
.search-bar input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 6px 28px 6px 10px; font-family: inherit; font-size: inherit; }
.search-bar input:focus { outline: 1px solid var(--vscode-focusBorder); }
.search-bar .clear-btn { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--vscode-descriptionForeground, #888); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 3px; display: none; }
.search-bar .clear-btn:hover { color: var(--vscode-foreground); }
.search-bar input:not(:placeholder-shown) ~ .clear-btn { display: block; }
h2 { color: var(--vscode-sideBarSectionHeader-foreground, #ccc); font-size: 1.15em; margin: 18px 0 8px 0; border-bottom: 1px solid var(--vscode-widget-border, #444); padding-bottom: 4px; }
.opcode { margin: 0 0 14px 0; padding: 8px 10px; background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04)); border-radius: 4px; border-left: 3px solid var(--vscode-debugTokenExpression-name, #9cdcfe); }
.op-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.op-name { color: var(--vscode-debugTokenExpression-name, #9cdcfe); font-weight: bold; font-size: 1.15em; }
.op-desc { color: var(--vscode-foreground); }
.op-flags { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.op-c02 { color: var(--vscode-charts-orange, #d19a66); font-size: 0.85em; font-weight: bold; margin-left: 6px; }
table { border-collapse: collapse; margin: 4px 0 0 0; font-size: 0.95em; width: 100%; }
th { text-align: left; color: var(--vscode-descriptionForeground, #888); font-weight: normal; font-size: 0.9em; padding: 2px 10px 2px 0; border-bottom: 1px solid var(--vscode-widget-border, #333); }
td { padding: 2px 10px 2px 0; }
td.hex { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
td.c02 { color: var(--vscode-charts-orange, #d19a66); }
.no-results { color: var(--vscode-descriptionForeground, #888); font-style: italic; padding: 20px 0; text-align: center; }
</style></head><body>
<div class="search-bar">
    <input type="text" id="searchInput" placeholder="Search opcodes... (e.g. LDA, load, branch, A9)" autofocus /><button class="clear-btn" id="clearBtn" title="Clear (Esc)">×</button>
</div>
<div id="content"></div>
<script>
// m: [mode, syntax, opcode_hex, bytes, cycles, is65c02]
const opcodes = [
  { cat:'Load / Store', ops:[
    { n:'LDA', d:'Load Accumulator', f:'N Z', m:[
      ['Immediate','LDA #$nn','A9',2,'2',0],['Zero Page','LDA $nn','A5',2,'3',0],['Zero Page,X','LDA $nn,X','B5',2,'4',0],
      ['Absolute','LDA $nnnn','AD',3,'4',0],['Absolute,X','LDA $nnnn,X','BD',3,'4+',0],['Absolute,Y','LDA $nnnn,Y','B9',3,'4+',0],
      ['(Indirect,X)','LDA ($nn,X)','A1',2,'6',0],['(Indirect),Y','LDA ($nn),Y','B1',2,'5+',0],
      ['(Zero Page)','LDA ($nn)','B2',2,'5',1]
    ]},
    { n:'LDX', d:'Load X Register', f:'N Z', m:[
      ['Immediate','LDX #$nn','A2',2,'2',0],['Zero Page','LDX $nn','A6',2,'3',0],['Zero Page,Y','LDX $nn,Y','B6',2,'4',0],
      ['Absolute','LDX $nnnn','AE',3,'4',0],['Absolute,Y','LDX $nnnn,Y','BE',3,'4+',0]
    ]},
    { n:'LDY', d:'Load Y Register', f:'N Z', m:[
      ['Immediate','LDY #$nn','A0',2,'2',0],['Zero Page','LDY $nn','A4',2,'3',0],['Zero Page,X','LDY $nn,X','B4',2,'4',0],
      ['Absolute','LDY $nnnn','AC',3,'4',0],['Absolute,X','LDY $nnnn,X','BC',3,'4+',0]
    ]},
    { n:'STA', d:'Store Accumulator', f:'', m:[
      ['Zero Page','STA $nn','85',2,'3',0],['Zero Page,X','STA $nn,X','95',2,'4',0],
      ['Absolute','STA $nnnn','8D',3,'4',0],['Absolute,X','STA $nnnn,X','9D',3,'5',0],['Absolute,Y','STA $nnnn,Y','99',3,'5',0],
      ['(Indirect,X)','STA ($nn,X)','81',2,'6',0],['(Indirect),Y','STA ($nn),Y','91',2,'6',0],
      ['(Zero Page)','STA ($nn)','92',2,'5',1]
    ]},
    { n:'STX', d:'Store X Register', f:'', m:[
      ['Zero Page','STX $nn','86',2,'3',0],['Zero Page,Y','STX $nn,Y','96',2,'4',0],['Absolute','STX $nnnn','8E',3,'4',0]
    ]},
    { n:'STY', d:'Store Y Register', f:'', m:[
      ['Zero Page','STY $nn','84',2,'3',0],['Zero Page,X','STY $nn,X','94',2,'4',0],['Absolute','STY $nnnn','8C',3,'4',0]
    ]},
    { n:'STZ', d:'Store Zero', f:'', c02:1, m:[
      ['Zero Page','STZ $nn','64',2,'3',1],['Zero Page,X','STZ $nn,X','74',2,'4',1],
      ['Absolute','STZ $nnnn','9C',3,'4',1],['Absolute,X','STZ $nnnn,X','9E',3,'5',1]
    ]},
  ]},
  { cat:'Arithmetic', ops:[
    { n:'ADC', d:'Add with Carry', f:'N V Z C', m:[
      ['Immediate','ADC #$nn','69',2,'2',0],['Zero Page','ADC $nn','65',2,'3',0],['Zero Page,X','ADC $nn,X','75',2,'4',0],
      ['Absolute','ADC $nnnn','6D',3,'4',0],['Absolute,X','ADC $nnnn,X','7D',3,'4+',0],['Absolute,Y','ADC $nnnn,Y','79',3,'4+',0],
      ['(Indirect,X)','ADC ($nn,X)','61',2,'6',0],['(Indirect),Y','ADC ($nn),Y','71',2,'5+',0],
      ['(Zero Page)','ADC ($nn)','72',2,'5',1]
    ]},
    { n:'SBC', d:'Subtract with Carry', f:'N V Z C', m:[
      ['Immediate','SBC #$nn','E9',2,'2',0],['Zero Page','SBC $nn','E5',2,'3',0],['Zero Page,X','SBC $nn,X','F5',2,'4',0],
      ['Absolute','SBC $nnnn','ED',3,'4',0],['Absolute,X','SBC $nnnn,X','FD',3,'4+',0],['Absolute,Y','SBC $nnnn,Y','F9',3,'4+',0],
      ['(Indirect,X)','SBC ($nn,X)','E1',2,'6',0],['(Indirect),Y','SBC ($nn),Y','F1',2,'5+',0],
      ['(Zero Page)','SBC ($nn)','F2',2,'5',1]
    ]},
    { n:'INC', d:'Increment Memory', f:'N Z', m:[
      ['Accumulator','INC A','1A',1,'2',1],['Zero Page','INC $nn','E6',2,'5',0],['Zero Page,X','INC $nn,X','F6',2,'6',0],
      ['Absolute','INC $nnnn','EE',3,'6',0],['Absolute,X','INC $nnnn,X','FE',3,'7',0]
    ]},
    { n:'DEC', d:'Decrement Memory', f:'N Z', m:[
      ['Accumulator','DEC A','3A',1,'2',1],['Zero Page','DEC $nn','C6',2,'5',0],['Zero Page,X','DEC $nn,X','D6',2,'6',0],
      ['Absolute','DEC $nnnn','CE',3,'6',0],['Absolute,X','DEC $nnnn,X','DE',3,'7',0]
    ]},
    { n:'INX', d:'Increment X', f:'N Z', m:[['Implied','INX','E8',1,'2',0]] },
    { n:'INY', d:'Increment Y', f:'N Z', m:[['Implied','INY','C8',1,'2',0]] },
    { n:'DEX', d:'Decrement X', f:'N Z', m:[['Implied','DEX','CA',1,'2',0]] },
    { n:'DEY', d:'Decrement Y', f:'N Z', m:[['Implied','DEY','88',1,'2',0]] },
  ]},
  { cat:'Compare', ops:[
    { n:'CMP', d:'Compare Accumulator', f:'N Z C', m:[
      ['Immediate','CMP #$nn','C9',2,'2',0],['Zero Page','CMP $nn','C5',2,'3',0],['Zero Page,X','CMP $nn,X','D5',2,'4',0],
      ['Absolute','CMP $nnnn','CD',3,'4',0],['Absolute,X','CMP $nnnn,X','DD',3,'4+',0],['Absolute,Y','CMP $nnnn,Y','D9',3,'4+',0],
      ['(Indirect,X)','CMP ($nn,X)','C1',2,'6',0],['(Indirect),Y','CMP ($nn),Y','D1',2,'5+',0],
      ['(Zero Page)','CMP ($nn)','D2',2,'5',1]
    ]},
    { n:'CPX', d:'Compare X Register', f:'N Z C', m:[
      ['Immediate','CPX #$nn','E0',2,'2',0],['Zero Page','CPX $nn','E4',2,'3',0],['Absolute','CPX $nnnn','EC',3,'4',0]
    ]},
    { n:'CPY', d:'Compare Y Register', f:'N Z C', m:[
      ['Immediate','CPY #$nn','C0',2,'2',0],['Zero Page','CPY $nn','C4',2,'3',0],['Absolute','CPY $nnnn','CC',3,'4',0]
    ]},
  ]},
  { cat:'Logic', ops:[
    { n:'AND', d:'Logical AND', f:'N Z', m:[
      ['Immediate','AND #$nn','29',2,'2',0],['Zero Page','AND $nn','25',2,'3',0],['Zero Page,X','AND $nn,X','35',2,'4',0],
      ['Absolute','AND $nnnn','2D',3,'4',0],['Absolute,X','AND $nnnn,X','3D',3,'4+',0],['Absolute,Y','AND $nnnn,Y','39',3,'4+',0],
      ['(Indirect,X)','AND ($nn,X)','21',2,'6',0],['(Indirect),Y','AND ($nn),Y','31',2,'5+',0],
      ['(Zero Page)','AND ($nn)','32',2,'5',1]
    ]},
    { n:'ORA', d:'Logical OR', f:'N Z', m:[
      ['Immediate','ORA #$nn','09',2,'2',0],['Zero Page','ORA $nn','05',2,'3',0],['Zero Page,X','ORA $nn,X','15',2,'4',0],
      ['Absolute','ORA $nnnn','0D',3,'4',0],['Absolute,X','ORA $nnnn,X','1D',3,'4+',0],['Absolute,Y','ORA $nnnn,Y','19',3,'4+',0],
      ['(Indirect,X)','ORA ($nn,X)','01',2,'6',0],['(Indirect),Y','ORA ($nn),Y','11',2,'5+',0],
      ['(Zero Page)','ORA ($nn)','12',2,'5',1]
    ]},
    { n:'EOR', d:'Exclusive OR', f:'N Z', m:[
      ['Immediate','EOR #$nn','49',2,'2',0],['Zero Page','EOR $nn','45',2,'3',0],['Zero Page,X','EOR $nn,X','55',2,'4',0],
      ['Absolute','EOR $nnnn','4D',3,'4',0],['Absolute,X','EOR $nnnn,X','5D',3,'4+',0],['Absolute,Y','EOR $nnnn,Y','59',3,'4+',0],
      ['(Indirect,X)','EOR ($nn,X)','41',2,'6',0],['(Indirect),Y','EOR ($nn),Y','51',2,'5+',0],
      ['(Zero Page)','EOR ($nn)','52',2,'5',1]
    ]},
    { n:'BIT', d:'Bit Test', f:'N V Z', m:[
      ['Zero Page','BIT $nn','24',2,'3',0],['Absolute','BIT $nnnn','2C',3,'4',0],
      ['Immediate','BIT #$nn','89',2,'2',1],['Zero Page,X','BIT $nn,X','34',2,'4',1],['Absolute,X','BIT $nnnn,X','3C',3,'4+',1]
    ]},
    { n:'TRB', d:'Test and Reset Bits', f:'Z', c02:1, m:[
      ['Zero Page','TRB $nn','14',2,'5',1],['Absolute','TRB $nnnn','1C',3,'6',1]
    ]},
    { n:'TSB', d:'Test and Set Bits', f:'Z', c02:1, m:[
      ['Zero Page','TSB $nn','04',2,'5',1],['Absolute','TSB $nnnn','0C',3,'6',1]
    ]},
  ]},
  { cat:'Shift / Rotate', ops:[
    { n:'ASL', d:'Arithmetic Shift Left', f:'N Z C', m:[
      ['Accumulator','ASL A','0A',1,'2',0],['Zero Page','ASL $nn','06',2,'5',0],['Zero Page,X','ASL $nn,X','16',2,'6',0],
      ['Absolute','ASL $nnnn','0E',3,'6',0],['Absolute,X','ASL $nnnn,X','1E',3,'7',0]
    ]},
    { n:'LSR', d:'Logical Shift Right', f:'N Z C', m:[
      ['Accumulator','LSR A','4A',1,'2',0],['Zero Page','LSR $nn','46',2,'5',0],['Zero Page,X','LSR $nn,X','56',2,'6',0],
      ['Absolute','LSR $nnnn','4E',3,'6',0],['Absolute,X','LSR $nnnn,X','5E',3,'7',0]
    ]},
    { n:'ROL', d:'Rotate Left', f:'N Z C', m:[
      ['Accumulator','ROL A','2A',1,'2',0],['Zero Page','ROL $nn','26',2,'5',0],['Zero Page,X','ROL $nn,X','36',2,'6',0],
      ['Absolute','ROL $nnnn','2E',3,'6',0],['Absolute,X','ROL $nnnn,X','3E',3,'7',0]
    ]},
    { n:'ROR', d:'Rotate Right', f:'N Z C', m:[
      ['Accumulator','ROR A','6A',1,'2',0],['Zero Page','ROR $nn','66',2,'5',0],['Zero Page,X','ROR $nn,X','76',2,'6',0],
      ['Absolute','ROR $nnnn','6E',3,'6',0],['Absolute,X','ROR $nnnn,X','7E',3,'7',0]
    ]},
  ]},
  { cat:'Branch', ops:[
    { n:'BCC', d:'Branch if Carry Clear', f:'', m:[['Relative','BCC label','90',2,'2/3+',0]] },
    { n:'BCS', d:'Branch if Carry Set', f:'', m:[['Relative','BCS label','B0',2,'2/3+',0]] },
    { n:'BEQ', d:'Branch if Equal (Z=1)', f:'', m:[['Relative','BEQ label','F0',2,'2/3+',0]] },
    { n:'BNE', d:'Branch if Not Equal (Z=0)', f:'', m:[['Relative','BNE label','D0',2,'2/3+',0]] },
    { n:'BMI', d:'Branch if Minus (N=1)', f:'', m:[['Relative','BMI label','30',2,'2/3+',0]] },
    { n:'BPL', d:'Branch if Plus (N=0)', f:'', m:[['Relative','BPL label','10',2,'2/3+',0]] },
    { n:'BVC', d:'Branch if Overflow Clear', f:'', m:[['Relative','BVC label','50',2,'2/3+',0]] },
    { n:'BVS', d:'Branch if Overflow Set', f:'', m:[['Relative','BVS label','70',2,'2/3+',0]] },
    { n:'BRA', d:'Branch Always', f:'', c02:1, m:[['Relative','BRA label','80',2,'3+',1]] },
  ]},
  { cat:'Jump / Call', ops:[
    { n:'JMP', d:'Jump', f:'', m:[
      ['Absolute','JMP $nnnn','4C',3,'3',0],['Indirect','JMP ($nnnn)','6C',3,'5',0],
      ['(Absolute,X)','JMP ($nnnn,X)','7C',3,'6',1]
    ]},
    { n:'JSR', d:'Jump to Subroutine', f:'', m:[['Absolute','JSR $nnnn','20',3,'6',0]] },
    { n:'RTS', d:'Return from Subroutine', f:'', m:[['Implied','RTS','60',1,'6',0]] },
    { n:'RTI', d:'Return from Interrupt', f:'all', m:[['Implied','RTI','40',1,'6',0]] },
    { n:'BRK', d:'Force Break (Software IRQ)', f:'B I', m:[['Implied','BRK','00',1,'7',0]] },
  ]},
  { cat:'Transfer', ops:[
    { n:'TAX', d:'Transfer A to X', f:'N Z', m:[['Implied','TAX','AA',1,'2',0]] },
    { n:'TXA', d:'Transfer X to A', f:'N Z', m:[['Implied','TXA','8A',1,'2',0]] },
    { n:'TAY', d:'Transfer A to Y', f:'N Z', m:[['Implied','TAY','A8',1,'2',0]] },
    { n:'TYA', d:'Transfer Y to A', f:'N Z', m:[['Implied','TYA','98',1,'2',0]] },
    { n:'TSX', d:'Transfer SP to X', f:'N Z', m:[['Implied','TSX','BA',1,'2',0]] },
    { n:'TXS', d:'Transfer X to SP', f:'', m:[['Implied','TXS','9A',1,'2',0]] },
  ]},
  { cat:'Stack', ops:[
    { n:'PHA', d:'Push Accumulator', f:'', m:[['Implied','PHA','48',1,'3',0]] },
    { n:'PLA', d:'Pull Accumulator', f:'N Z', m:[['Implied','PLA','68',1,'4',0]] },
    { n:'PHP', d:'Push Processor Status', f:'', m:[['Implied','PHP','08',1,'3',0]] },
    { n:'PLP', d:'Pull Processor Status', f:'all', m:[['Implied','PLP','28',1,'4',0]] },
    { n:'PHX', d:'Push X Register', f:'', c02:1, m:[['Implied','PHX','DA',1,'3',1]] },
    { n:'PLX', d:'Pull X Register', f:'N Z', c02:1, m:[['Implied','PLX','FA',1,'4',1]] },
    { n:'PHY', d:'Push Y Register', f:'', c02:1, m:[['Implied','PHY','5A',1,'3',1]] },
    { n:'PLY', d:'Pull Y Register', f:'N Z', c02:1, m:[['Implied','PLY','7A',1,'4',1]] },
  ]},
  { cat:'Flags', ops:[
    { n:'CLC', d:'Clear Carry', f:'C', m:[['Implied','CLC','18',1,'2',0]] },
    { n:'SEC', d:'Set Carry', f:'C', m:[['Implied','SEC','38',1,'2',0]] },
    { n:'CLD', d:'Clear Decimal', f:'D', m:[['Implied','CLD','D8',1,'2',0]] },
    { n:'SED', d:'Set Decimal', f:'D', m:[['Implied','SED','F8',1,'2',0]] },
    { n:'CLI', d:'Clear Interrupt Disable', f:'I', m:[['Implied','CLI','58',1,'2',0]] },
    { n:'SEI', d:'Set Interrupt Disable', f:'I', m:[['Implied','SEI','78',1,'2',0]] },
    { n:'CLV', d:'Clear Overflow', f:'V', m:[['Implied','CLV','B8',1,'2',0]] },
  ]},
  { cat:'Misc', ops:[
    { n:'NOP', d:'No Operation', f:'', m:[['Implied','NOP','EA',1,'2',0]] },
  ]},
];

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function render(filter) {
    const f = filter.toLowerCase().trim();
    const content = document.getElementById('content');
    let html = '';
    let anyMatch = false;

    for (const cat of opcodes) {
        const matched = cat.ops.filter(op => {
            if (!f) return true;
            if (op.n.toLowerCase().includes(f)) return true;
            if (op.d.toLowerCase().includes(f)) return true;
            if (cat.cat.toLowerCase().includes(f)) return true;
            return op.m.some(r => r[2].toLowerCase().includes(f));
        });
        if (matched.length === 0 && f) continue;
        const ops = f ? matched : cat.ops;
        if (ops.length === 0) continue;
        anyMatch = true;

        html += '<h2>' + escHtml(cat.cat) + '</h2>';
        for (const op of ops) {
            html += '<div class="opcode">';
            const has65c02 = op.c02 || op.m.some(r => r[5]);
            html += '<div class="op-header"><span class="op-name">' + op.n + '</span>';
            html += '<span class="op-desc">' + escHtml(op.d) + '</span>';
            if (has65c02) html += '<span class="op-c02">' + (op.c02 ? '65C02 only' : '+ 65C02') + '</span>';
            if (op.f) html += '<span class="op-flags">Flags: ' + op.f + '</span>';
            html += '</div>';
            html += '<table><tr><th>Mode</th><th>Syntax</th><th>Opcode</th><th>Bytes</th><th>Cycles</th></tr>';
            for (const r of op.m) {
                const cls = r[5] ? ' class="c02"' : '';
                const hexCls = r[5] ? 'hex c02' : 'hex';
                html += '<tr' + cls + '><td>' + r[0] + (r[5]?' *':'') + '</td><td>' + r[1] + '</td><td class="' + hexCls + '">$' + r[2] + '</td><td>' + r[3] + '</td><td>' + r[4] + '</td></tr>';
            }
            html += '</table></div>';
        }
    }

    if (!anyMatch) {
        html = '<div class="no-results">No opcodes matching "' + escHtml(f) + '"</div>';
    }
    html += '<div style="color:var(--vscode-descriptionForeground);font-size:0.85em;margin-top:20px;padding-top:8px;border-top:1px solid var(--vscode-widget-border,#444)">+ = add 1 cycle if page boundary crossed &nbsp; * = 65C02 only &nbsp; Branch cycles: 2 not taken / 3 taken / +1 page cross</div>';
    content.innerHTML = html;
}

const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', e => render(e.target.value));
searchInput.addEventListener('keydown', e => { if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); searchInput.value = ''; render(''); } });
document.getElementById('clearBtn').addEventListener('click', () => { searchInput.value = ''; searchInput.focus(); render(''); });
render('');
</script>
</body></html>`;
}

// ----------------------------------------------------------------
// Heatmap Panel (editor tab — movable, like Memory View)
// ----------------------------------------------------------------

let heatmapPanel = null;
let screenPanel = null;
let vizOutputChannel = null;
let vizConnected = false;   // true while the viz stream socket is actually connected

// --- Automation runner state (in-session playthrough scripts) ----------------
let vizLastFrame = -1;              // latest viz frame counter (for runFrames/waitScreen)
let vizLastScrB64 = null;           // latest 240x224 screen buffer, base64 (for screenshots)
let vizLastVidMode = 0;             // latest video mode byte (bit2 = HIRES) — for the bridge screenshot caption
let vizLastVidAddr = 0;             // latest video base address
const automationEvents = new vscode.EventEmitter();   // fires {type:'stopped'|'continued'|'signal', id?}
let automationRunning = null;       // the running script's `t` (for Stop), or null
let automationRunningPath = null;   // fsPath of the script currently running (for the Automation panel), or null
let automationConfigMemento = null; // = context.workspaceState (set in activate); remembers the last-chosen launch config
const AUTO_CFG_KEY = 'oric-debug.lastAutomationConfig';
let refreshAutomationView = null;   // set in activate → refreshes the Oric Automation panel (module-level so the runner can call it)
let automationChan = null;          // lazily-created Output channel

// Tell the Screen View whether the Oric is connected — gates its keyboard control
// (no controlling a disconnected Oric) and the "click to control" badge.
function postScreenConn(connected) {
    if (screenPanel) screenPanel.webview.postMessage({ type: 'conn', connected: !!connected });
}

// Tell the Screen View the emulator run-state so it can show a turbo (▶▶) / paused (‖)
// OSD badge. `active` = an oric-debug session is live; the badge is hidden otherwise.
function postScreenRunState() {
    if (screenPanel) screenPanel.webview.postMessage({
        type: 'runstate', active: oricSessionActive,
        // "stopped" = the machine is GENUINELY halted for inspection. During automation the
        // script cycles stop/continue rapidly (the game is animating), so the pause indicator
        // must NOT track that churn — only a real USER pause counts. Outside automation it's
        // the normal stopped state.
        stopped: automationRunning ? oricUserPaused : oricDebugStopped,
        warp: oricWarpOn,               // ▶▶ follows t.warp(true) / the turbo toggle
        scripted: !!automationRunning,  // a scripted automation is driving — badge in the opposite corner
        aiPiloting: !!bridgeServer && bridgeControl === BRIDGE_CONTROL.AI   // AI holds control via the collab bridge
    });
}

// ----------------------------------------------------------------
// Shared viz_stream connection (single TCP, multiple consumers)
// ----------------------------------------------------------------

let vizSocket = null;
let vizRxBuf = Buffer.alloc(0);
const vizConsumers = new Set();  // { postFrame(msg), postStatus(text), postError(text) }
let vizHost = null;
let vizPort = null;

// Viz protocol constants (VIZ_MAGIC, VIZ_PORT_OFFSET, screen/frame sizes) now come from the
// shared mcp/oric-viz-protocol.cjs — imported near the top of this file — so there is one
// definition of the wire format, mirrored from the emulator's viz_stream.c.

function vizLog(msg) {
    if (vizOutputChannel) vizOutputChannel.appendLine('[VIZ] ' + msg);
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'oric-debug') {
        session.customRequest('logToConsole', { text: msg }).catch(() => {});
    }
}

let vizReconnectTimer = null;

function vizScheduleReconnect() {
    if (vizReconnectTimer) return;
    if (vizConsumers.size === 0) return;
    // Only reconnect if a debug session is still active
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'oric-debug') return;
    vizReconnectTimer = setTimeout(() => {
        vizReconnectTimer = null;
        if (vizSocket) return; // already reconnected
        if (vizConsumers.size === 0) return;
        const s = vscode.debug.activeDebugSession;
        if (!s || s.type !== 'oric-debug') return;
        const config = s.configuration;
        const h = config.host || 'localhost';
        const p = (config.port || 6502) + VIZ_PORT_OFFSET;
        vizLog('Auto-reconnecting to ' + h + ':' + p + '...');
        vizConnect(h, p);
    }, 2000);
}

function vizCancelReconnect() {
    if (vizReconnectTimer) {
        clearTimeout(vizReconnectTimer);
        vizReconnectTimer = null;
    }
}

// Find a free TCP port for the GDB stub so a project can be debugged with no port
// configured anywhere — nothing has to live in osdk_config.bat. The adapter spawns
// Oricutron with --gdb_port <this> and connects to it; the viz stream lives at
// <this>+VIZ_PORT_OFFSET, so we require that neighbour to be free too. Resolves to 0
// only if no suitable port turns up, letting the adapter fall back to its default.
function findFreeGdbPort() {
    const net = require('net');
    function ephemeral() {
        return new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.unref();
            srv.on('error', reject);
            srv.listen(0, '127.0.0.1', () => {
                const p = srv.address().port;
                srv.close(() => resolve(p));
            });
        });
    }
    function isFree(p) {
        return new Promise((resolve) => {
            const srv = net.createServer();
            srv.unref();
            srv.on('error', () => resolve(false));
            srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
        });
    }
    return (async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
            let p;
            try { p = await ephemeral(); } catch (_) { continue; }
            if (p + VIZ_PORT_OFFSET <= 65535 && await isFree(p + VIZ_PORT_OFFSET)) return p;
        }
        return 0;
    })();
}

function vizConnect(host, port) {
    if (vizSocket) return; // already connected
    if (!port) return;

    const net = require('net');
    const sock = new net.Socket();
    vizSocket = sock;
    vizRxBuf = Buffer.alloc(0);
    vizHost = host;
    vizPort = port;

    vizLog('Connecting to viz server at ' + host + ':' + port + '...');

    sock.connect(port, host, () => {
        vizLog('Connected to ' + host + ':' + port);
        vizConnected = true;
        postScreenConn(true);
        for (const c of vizConsumers) c.postStatus('Connected to ' + host + ':' + port);
    });

    let syncErrors = 0;

    sock.on('data', (chunk) => {
        vizRxBuf = Buffer.concat([vizRxBuf, chunk]);

        // Framing/sizing/resync is done once in the shared protocol module (nextFrame);
        // here we only DECODE the fields the webview consumers need (base64 for postMessage).
        while (true) {
            const r = vizProto.nextFrame(vizRxBuf);
            vizRxBuf = r.rest;
            if (r.status === 'need') break;
            if (r.status === 'resync') {
                if (r.reason === 'nomagic') {
                    syncErrors++;
                    vizLog('Frame sync error: bad magic, discarded ' + r.skipped + ' bytes (' + syncErrors + ' total sync errors)');
                    for (const c of vizConsumers) c.postError('Frame sync error (resynchronizing...)');
                    break;                               // wait for more data
                }
                if (r.reason === 'realign') { syncErrors++; vizLog('Frame sync: skipped ' + r.skipped + ' bytes to re-align'); }
                continue;                                // realign / corrupt: retry on the realigned buffer
            }

            // r.status === 'frame': decode header + heat + (v1/v2) screen block.
            const frame = r.frame, version = r.version, s = r.scrOff;
            const msg = {
                version,
                frameCounter: frame.readUInt32LE(4),
                romdis: frame[8],
                vidMode: frame[9],
                vidAddr: frame.readUInt16LE(10),
                charsetAddr: frame.readUInt16LE(12),
            };
            if (version >= 2) {
                // heat deltas as raw count-prefixed run-list bytes; the webview applies
                // them onto its own arrays and does the decay.
                msg.readRuns  = frame.slice(r.ranges[0][0], r.ranges[0][1]).toString('base64');
                msg.writeRuns = frame.slice(r.ranges[1][0], r.ranges[1][1]).toString('base64');
                msg.ulaRuns   = frame.slice(r.ranges[2][0], r.ranges[2][1]).toString('base64');
            } else {
                msg.readHeat  = frame.slice(16, 16 + 65536).toString('base64');
                msg.writeHeat = frame.slice(16 + 65536, 16 + 65536 * 2).toString('base64');
                msg.ulaHeat   = frame.slice(16 + 65536 * 2, 16 + 65536 * 3).toString('base64');
            }
            if (s >= 0) {                                // screen block present (v1/v2)
                msg.scrBuf = frame.slice(s, s + VIZ_SCR_SIZE).toString('base64');
                msg.vidbases = [
                    frame.readUInt16LE(s + VIZ_SCR_SIZE),
                    frame.readUInt16LE(s + VIZ_SCR_SIZE + 2),
                    frame.readUInt16LE(s + VIZ_SCR_SIZE + 4),
                    frame.readUInt16LE(s + VIZ_SCR_SIZE + 6)
                ];
                msg.vidRamMain = frame.slice(s + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE,
                                             s + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE + VIZ_VIDRAM_MAIN).toString('base64');
                msg.vidRamBottom = frame.slice(s + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE + VIZ_VIDRAM_MAIN,
                                               s + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE + VIZ_VIDRAM_MAIN + VIZ_VIDRAM_BOTTOM).toString('base64');
            }

            vizLastFrame = msg.frameCounter;                 // tap for the automation runner
            if (msg.scrBuf) vizLastScrB64 = msg.scrBuf;
            vizLastVidMode = msg.vidMode; vizLastVidAddr = msg.vidAddr;   // for the bridge screenshot caption
            for (const c of vizConsumers) c.postFrame(msg);
        }
    });

    sock.on('error', (err) => {
        vizLog('Connection error: ' + err.message);
        for (const c of vizConsumers) c.postError('Connection error: ' + err.message);
    });

    sock.on('close', () => {
        vizLog('Disconnected from viz server');
        vizSocket = null;
        vizConnected = false;
        postScreenConn(false);
        for (const c of vizConsumers) c.postStatus('Disconnected — reconnecting...');
        vizScheduleReconnect();
    });
}

function vizDisconnect() {
    vizCancelReconnect();
    if (vizSocket) {
        vizSocket.destroy();
        vizSocket = null;
    }
    vizRxBuf = Buffer.alloc(0);
}

function vizRegisterConsumer(consumer) {
    vizConsumers.add(consumer);
    // Auto-connect if a debug session is active and we're not already connected
    if (!vizSocket) {
        const session = vscode.debug.activeDebugSession;
        if (session && session.type === 'oric-debug') {
            const config = session.configuration;
            const gdbHost = config.host || 'localhost';
            const gdbPort = config.port || 6502;
            vizConnect(gdbHost, gdbPort + VIZ_PORT_OFFSET);
        }
    }
}

function vizUnregisterConsumer(consumer) {
    vizConsumers.delete(consumer);
    if (vizConsumers.size === 0) {
        vizDisconnect();
    }
}

// Send raw bytes up the viz_stream socket (VS Code -> emulator uplink).
// Used for keyboard/input injection from the Screen View.
function vizSendInput(bytes) {
    if (vizSocket && !vizSocket.destroyed) {
        try { vizSocket.write(Buffer.from(bytes)); } catch (_) {}
    }
}

// ----------------------------------------------------------------
// Heatmap consumer
// ----------------------------------------------------------------

const heatmapConsumer = {
    postFrame(msg) {
        if (heatmapPanel) {
            heatmapPanel.webview.postMessage({
                type: 'heatmapFrame',
                version: msg.version,
                frameCounter: msg.frameCounter,
                romdis: msg.romdis,
                vidMode: msg.vidMode,
                vidAddr: msg.vidAddr,
                charsetAddr: msg.charsetAddr,
                // v2 heat deltas (run-lists); v0/v1 full arrays (legacy)
                readRuns: msg.readRuns,
                writeRuns: msg.writeRuns,
                ulaRuns: msg.ulaRuns,
                readHeat: msg.readHeat,
                writeHeat: msg.writeHeat,
                ulaHeat: msg.ulaHeat
            });
        }
    },
    postStatus(text) {
        if (heatmapPanel) heatmapPanel.webview.postMessage({ type: 'status', text });
    },
    postError(text) {
        if (heatmapPanel) heatmapPanel.webview.postMessage({ type: 'error', text });
    }
};

// ----------------------------------------------------------------
// Heatmap address highlight relay
// ----------------------------------------------------------------

let lastPcAddr = -1;

function highlightHeatmapAddr(addr) {
    if (heatmapPanel) {
        heatmapPanel.webview.postMessage({ type: 'highlightAddr', addr });
    }
}

function clearHeatmapHighlight() {
    if (heatmapPanel) {
        heatmapPanel.webview.postMessage({ type: 'clearHighlight' });
    }
}

function restoreHeatmapPcHighlight() {
    if (lastPcAddr >= 0 && vscode.debug.activeDebugSession) {
        highlightHeatmapAddr(lastPcAddr);
    } else {
        clearHeatmapHighlight();
    }
}

// ----------------------------------------------------------------
// Screen View consumer
// ----------------------------------------------------------------

const screenConsumer = {
    postFrame(msg) {
        if (screenPanel && msg.version >= 1) {
            screenPanel.webview.postMessage({
                type: 'screenFrame',
                frameCounter: msg.frameCounter,
                vidMode: msg.vidMode,
                vidAddr: msg.vidAddr,
                vidbases: msg.vidbases,
                scrBuf: msg.scrBuf,
                vidRamMain: msg.vidRamMain,
                vidRamBottom: msg.vidRamBottom
            });
        }
    },
    postStatus(text) {
        if (screenPanel) screenPanel.webview.postMessage({ type: 'status', text });
    },
    postError(text) {
        if (screenPanel) screenPanel.webview.postMessage({ type: 'error', text });
    }
};

function createHeatmapPanel() {
    if (heatmapPanel) {
        heatmapPanel.reveal();
        return heatmapPanel;
    }

    const panel = vscode.window.createWebviewPanel(
        'oricHeatmap',
        'Oric Memory Heatmap',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.onDidDispose(() => {
        heatmapPanel = null;
        vizUnregisterConsumer(heatmapConsumer);
    });

    heatmapPanel = panel; panel.iconPath = panelIcon('panel-heatmap-v2');
    panel.webview.html = heatmapPanelHtml();
    vizRegisterConsumer(heatmapConsumer);

    return panel;
}

function heatmapPanelHtml() {
    return `<!DOCTYPE html>
<html><head><style>
body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    padding: 8px 12px;
    margin: 0;
    background: var(--vscode-editor-background);
}
canvas { display: block; image-rendering: pixelated; border: 1px solid #404040; box-sizing: border-box; width: 100%; }
.page-canvas { height: 14px; }
.canvas-wrap { position: relative; }
.canvas-wrap .highlight-overlay {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;
}
#status {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 0.85em;
    margin: 2px 0;
    white-space: nowrap;
}
#error {
    color: var(--vscode-errorForeground, #f44);
    font-size: 0.85em;
    margin: 2px 0;
    display: none;
}
#tooltip {
    color: var(--vscode-debugTokenExpression-number, #b5cea8);
    font-size: 0.9em;
    height: 1.3em;
    margin: 4px 0;
}
.legend {
    display: flex;
    gap: 12px;
    font-size: 0.85em;
    margin: 6px 0;
    flex-wrap: wrap;
}
.legend span { display: flex; align-items: center; gap: 4px; }
.swatch { width: 12px; height: 12px; display: inline-block; border: 1px solid #555; }
.label-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground, #888);
    margin: 2px 0;
}
</style></head><body>
<div id="status">Waiting for connection...</div>
<div id="error"></div>
<div id="tooltip">&nbsp;</div>
<div class="legend">
    <span><span class="swatch" style="background:#f00"></span> Write</span>
    <span><span class="swatch" style="background:#0f0"></span> Read</span>
    <span><span class="swatch" style="background:#00f"></span> ULA</span>
    <span><span class="swatch" style="background:#ff0"></span> R+W</span>
    <span><span class="swatch" style="background:#0ff"></span> R+U</span>
    <span><span class="swatch" style="background:#f0f"></span> W+U</span>
</div>
<div class="label-row"><span>$0000 Zero Page</span><span>$00FF</span></div>
<div class="canvas-wrap"><canvas id="zpCanvas" class="page-canvas" width="256" height="1"></canvas><canvas class="highlight-overlay page-canvas" id="zpOverlay" width="256" height="1"></canvas></div>
<div class="label-row"><span>$0100 Stack</span><span>$01FF</span></div>
<div class="canvas-wrap"><canvas id="stackCanvas" class="page-canvas" width="256" height="1"></canvas><canvas class="highlight-overlay page-canvas" id="stackOverlay" width="256" height="1"></canvas></div>
<div class="label-row"><span>$0200 Page 2</span><span>$02FF</span></div>
<div class="canvas-wrap"><canvas id="page2Canvas" class="page-canvas" width="256" height="1"></canvas><canvas class="highlight-overlay page-canvas" id="page2Overlay" width="256" height="1"></canvas></div>
<div class="label-row"><span>$0300 I/O</span><span>$03FF</span></div>
<div class="canvas-wrap"><canvas id="ioCanvas" class="page-canvas" width="256" height="1"></canvas><canvas class="highlight-overlay page-canvas" id="ioOverlay" width="256" height="1"></canvas></div>
<div class="label-row"><span>$0400</span><span>$BFFF</span></div>
<div class="canvas-wrap"><canvas id="mainCanvas" width="256" height="188"></canvas><canvas class="highlight-overlay" id="mainOverlay" width="256" height="188"></canvas></div>
<div class="label-row" id="romLabel">
    <span>$C000</span><span id="romLabelRight">ROM $FFFF</span>
</div>
<div class="canvas-wrap"><canvas id="bottomCanvas" width="256" height="64"></canvas><canvas class="highlight-overlay" id="bottomOverlay" width="256" height="64"></canvas></div>
<script>
const vscode = acquireVsCodeApi();
const topCanvases = [
    document.getElementById('zpCanvas'),
    document.getElementById('stackCanvas'),
    document.getElementById('page2Canvas'),
    document.getElementById('ioCanvas')
];
const topCtxs = topCanvases.map(c => c.getContext('2d'));
const topImgs = topCtxs.map(ctx => ctx.createImageData(256, 1));
const mainCanvas = document.getElementById('mainCanvas');
const bottomCanvas = document.getElementById('bottomCanvas');
const mainCtx = mainCanvas.getContext('2d');
const bottomCtx = bottomCanvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const errorDiv = document.getElementById('error');
const status = document.getElementById('status');
const romLabelRight = document.getElementById('romLabelRight');

mainCanvas.style.height = 'auto';
mainCanvas.style.aspectRatio = '256 / 188';
bottomCanvas.style.height = 'auto';
bottomCanvas.style.aspectRatio = '256 / 64';

const mainImg = mainCtx.createImageData(256, 188);
const bottomImg = bottomCtx.createImageData(256, 64);

// v2: the webview owns the heat state; the emulator sends per-frame access
// deltas (run-lists) and we decay locally at the same rate it used to.
const heatR = new Uint8Array(65536);
const heatW = new Uint8Array(65536);
const heatU = new Uint8Array(65536);
const HEAT_DECAY = 8;

function b64decode(str) {
    const bin = atob(str);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

function decayHeat(a) {
    for (let i = 0; i < a.length; i++) {
        const v = a[i];
        if (v) a[i] = v > HEAT_DECAY ? v - HEAT_DECAY : 0;
    }
}

// Apply a base64 run-list ([u16 nRuns][nRuns x (u16 start, u16 len)]): set every
// address in each run to full heat (the emulator marks accesses as 255).
function applyRuns(heat, b64) {
    if (!b64) return;
    const b = b64decode(b64);
    if (b.length < 2) return;
    const nRuns = b[0] | (b[1] << 8);
    let o = 2;
    for (let r = 0; r < nRuns; r++) {
        if (o + 4 > b.length) break;
        const start = b[o] | (b[o + 1] << 8);
        const len   = b[o + 2] | (b[o + 3] << 8);
        o += 4;
        const end = Math.min(start + len, 65536);
        for (let a = start; a < end; a++) heat[a] = 255;
    }
}

let heatDrawPending = false;
const heatMeta = { frameCounter: 0, romdis: 0, vidMode: 0, vidAddr: 0 };

function renderFrame(msg) {
    errorDiv.style.display = 'none';
    // State update runs on EVERY message — v2 deltas are non-droppable (each
    // carries one frame's decay + accesses). Only the draw is coalesced below.
    if (msg.version >= 2) {
        decayHeat(heatR); decayHeat(heatW); decayHeat(heatU);
        applyRuns(heatR, msg.readRuns);
        applyRuns(heatW, msg.writeRuns);
        applyRuns(heatU, msg.ulaRuns);
    } else {
        // legacy v0/v1: full arrays every frame.
        heatR.set(b64decode(msg.readHeat));
        heatW.set(b64decode(msg.writeHeat));
        heatU.set(b64decode(msg.ulaHeat));
    }
    heatMeta.frameCounter = msg.frameCounter;
    heatMeta.romdis = msg.romdis;
    heatMeta.vidMode = msg.vidMode;
    heatMeta.vidAddr = msg.vidAddr;
    // Coalesce the expensive canvas redraw to at most once per display frame, so
    // a burst of 50fps deltas on a slow/backgrounded webview can't back up.
    if (!heatDrawPending) {
        heatDrawPending = true;
        requestAnimationFrame(drawHeat);
    }
}

function drawHeat() {
    heatDrawPending = false;
    const readHeat = heatR, writeHeat = heatW, ulaHeat = heatU;

    for (let block = 0; block < 4; block++) {
        const baseAddr = block * 256;
        const img = topImgs[block];
        for (let i = 0; i < 256; i++) {
            const addr = baseAddr + i;
            const px = i * 4;
            img.data[px]     = writeHeat[addr];
            img.data[px + 1] = readHeat[addr];
            img.data[px + 2] = ulaHeat[addr];
            img.data[px + 3] = 255;
        }
        topCtxs[block].putImageData(img, 0, 0);
    }

    for (let i = 0; i < 256 * 188; i++) {
        const addr = 0x0400 + i;
        if (addr > 0xBFFF) break;
        const px = i * 4;
        mainImg.data[px]     = writeHeat[addr];
        mainImg.data[px + 1] = readHeat[addr];
        mainImg.data[px + 2] = ulaHeat[addr];
        mainImg.data[px + 3] = 255;
    }
    mainCtx.putImageData(mainImg, 0, 0);

    for (let i = 0; i < 256 * 64; i++) {
        const addr = 0xC000 + i;
        const px = i * 4;
        bottomImg.data[px]     = writeHeat[addr];
        bottomImg.data[px + 1] = readHeat[addr];
        bottomImg.data[px + 2] = ulaHeat[addr];
        bottomImg.data[px + 3] = 255;
    }
    bottomCtx.putImageData(bottomImg, 0, 0);

    romLabelRight.textContent = heatMeta.romdis ? 'RAM $FFFF' : 'ROM $FFFF';
    status.textContent = 'Frame ' + heatMeta.frameCounter +
        ' | Mode ' + heatMeta.vidMode +
        ' | Vid $' + heatMeta.vidAddr.toString(16).toUpperCase().padStart(4, '0');
}

function addrFromMouse(canvas, e, baseAddr, width, height) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * width);
    const y = Math.floor((e.clientY - rect.top) / rect.height * height);
    if (x < 0 || x >= width || y < 0 || y >= height) return -1;
    return baseAddr + y * width + x;
}

function addrFromTopMouse(blockIndex, e) {
    const canvas = topCanvases[blockIndex];
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * 256);
    if (x < 0 || x >= 256) return -1;
    return blockIndex * 256 + x;
}

function showAddr(addr) {
    if (addr < 0 || addr > 0xFFFF) { tooltip.textContent = ''; return; }
    tooltip.textContent = '$' + addr.toString(16).toUpperCase().padStart(4, '0');
}

topCanvases.forEach((c, i) => {
    c.addEventListener('mousemove', e => showAddr(addrFromTopMouse(i, e)));
    c.addEventListener('mouseleave', () => { tooltip.textContent = ''; });
});
mainCanvas.addEventListener('mousemove', e => showAddr(addrFromMouse(mainCanvas, e, 0x0400, 256, 188)));
bottomCanvas.addEventListener('mousemove', e => showAddr(addrFromMouse(bottomCanvas, e, 0xC000, 256, 64)));

[mainCanvas, bottomCanvas].forEach(c => {
    c.addEventListener('mouseleave', () => { tooltip.textContent = ''; });
});

// --- Address highlight crosshair ---
const topOverlays = [
    document.getElementById('zpOverlay'),
    document.getElementById('stackOverlay'),
    document.getElementById('page2Overlay'),
    document.getElementById('ioOverlay')
];
const mainOverlay = document.getElementById('mainOverlay');
const bottomOverlay = document.getElementById('bottomOverlay');
const allOverlays = [...topOverlays, mainOverlay, bottomOverlay];
let highlightAddr = -1;

function resizeOverlayCanvas(overlay, refCanvas) {
    const rect = refCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (overlay.width !== w || overlay.height !== h) {
        overlay.width = w;
        overlay.height = h;
    }
}

function drawHighlight() {
    // Clear all overlays
    for (const ov of allOverlays) {
        const ctx = ov.getContext('2d');
        ctx.clearRect(0, 0, ov.width, ov.height);
    }
    if (highlightAddr < 0 || highlightAddr > 0xFFFF) return;
    const addr = highlightAddr;

    // Determine which canvas region
    let overlay, refCanvas, x, y, cw, ch;
    if (addr < 0x0400) {
        const block = addr >> 8;
        overlay = topOverlays[block];
        refCanvas = topCanvases[block];
        x = addr & 0xFF;
        y = 0;
        cw = 256; ch = 1;
    } else if (addr < 0xC000) {
        overlay = mainOverlay;
        refCanvas = mainCanvas;
        const off = addr - 0x0400;
        x = off & 0xFF;
        y = off >> 8;
        cw = 256; ch = 188;
    } else {
        overlay = bottomOverlay;
        refCanvas = bottomCanvas;
        const off = addr - 0xC000;
        x = off & 0xFF;
        y = off >> 8;
        cw = 256; ch = 64;
    }

    resizeOverlayCanvas(overlay, refCanvas);
    const ctx = overlay.getContext('2d');
    const w = overlay.width;
    const h = overlay.height;
    const sx = w / cw;
    const sy = h / ch;
    const cx = Math.round((x + 0.5) * sx);
    const cy = Math.round((y + 0.5) * sy);

    const lines = [
        { offset: -1, color: 'rgba(0,0,0,0.6)' },
        { offset:  0, color: 'rgba(255,255,255,0.9)' },
        { offset:  1, color: 'rgba(0,0,0,0.6)' }
    ];
    ctx.lineWidth = 1;
    for (const l of lines) {
        ctx.strokeStyle = l.color;
        ctx.beginPath();
        ctx.moveTo(cx + l.offset + 0.5, 0);
        ctx.lineTo(cx + l.offset + 0.5, h);
        ctx.stroke();
        if (ch > 1) {
            ctx.beginPath();
            ctx.moveTo(0, cy + l.offset + 0.5);
            ctx.lineTo(w, cy + l.offset + 0.5);
            ctx.stroke();
        }
    }
}

const hlResizeObs = new ResizeObserver(() => drawHighlight());
hlResizeObs.observe(mainCanvas);

window.addEventListener('message', e => {
    if (e.data.type === 'heatmapFrame') renderFrame(e.data);
    if (e.data.type === 'status') { status.textContent = e.data.text; errorDiv.style.display = 'none'; }
    if (e.data.type === 'error') { errorDiv.textContent = e.data.text; errorDiv.style.display = 'block'; }
    if (e.data.type === 'highlightAddr') {
        highlightAddr = typeof e.data.addr === 'number' ? e.data.addr : -1;
        drawHighlight();
    }
    if (e.data.type === 'clearHighlight') {
        highlightAddr = -1;
        drawHighlight();
    }
});
</script>
</body></html>`;
}

// ----------------------------------------------------------------
// Screen View Panel (editor tab — Oric screen with overlays)
// ----------------------------------------------------------------

function createScreenPanel() {
    if (screenPanel) {
        screenPanel.reveal();
        return screenPanel;
    }

    const panel = vscode.window.createWebviewPanel(
        'oricScreenView',
        'Oric Screen View',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    wireScreenPanel(panel);
    return panel;
}

// Shared Screen View wiring — used by BOTH createScreenPanel and the reload serializer so a
// RESTORED panel behaves identically. (This was duplicated; the serializer's copy fell behind
// and dropped hover-help / open-screenshots / screenReady after a reload.) One handler, one setup.
function wireScreenPanel(panel) {
    screenPanel = panel;
    panel.iconPath = panelIcon('panel-screen-v2');
    panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
    panel.webview.html = screenPanelHtml();
    panel.onDidDispose(() => { screenPanel = null; vizUnregisterConsumer(screenConsumer); });

    const fs = require('fs');
    const path = require('path');
    panel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'screenReady') { postScreenConn(vizConnected); postScreenRunState(); return; }
        if (msg.type === 'hover') { showHoverHelp(msg.text); return; }
        if (msg.type === 'hoverEnd') { showHoverHelp(null); return; }
        if (msg.type === 'openScreenshots') {
            const base = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0])
                ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;
            if (!base) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            const ssDir = path.join(base, 'screenshots');
            try { if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true }); } catch (_) {}
            vscode.env.openExternal(vscode.Uri.file(ssDir));
            return;
        }
        if (msg.type === 'saveImage' && msg.dataUrl) {
            // Find workspace folder for screenshot subfolder
            let baseDir = null;
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                baseDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
            }
            if (!baseDir) {
                vscode.window.showErrorMessage('No workspace folder open — cannot save screenshot.');
                return;
            }
            const ssDir = path.join(baseDir, 'screenshots');
            if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });

            const now = new Date();
            const ts = now.getFullYear().toString()
                + (now.getMonth() + 1).toString().padStart(2, '0')
                + now.getDate().toString().padStart(2, '0')
                + '_' + now.getHours().toString().padStart(2, '0')
                + now.getMinutes().toString().padStart(2, '0')
                + now.getSeconds().toString().padStart(2, '0');
            // Enrich the name for easier identification: active overlay module (sanitized) and
            // the emulator frame counter (also disambiguates two captures in the same second).
            const modPart = activeOricModuleName ? '_' + activeOricModuleName.replace(/[^A-Za-z0-9._-]+/g, '-') : '';
            const framePart = (typeof msg.frame === 'number' && msg.frame >= 0) ? '_f' + msg.frame : '';
            const filePath = path.join(ssDir, 'oric_' + ts + modPart + framePart + '.png');

            const base64 = msg.dataUrl.replace(/^data:image\/png;base64,/, '');
            fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
            vscode.window.showInformationMessage('Screenshot saved: ' + path.basename(filePath));
        } else if (msg.type === 'copyImage' && msg.dataUrl) {
            // Write to temp file, then use PowerShell to copy to clipboard
            const os = require('os');
            const tmpFile = path.join(os.tmpdir(), 'oric_clipboard.png');
            const base64 = msg.dataUrl.replace(/^data:image\/png;base64,/, '');
            fs.writeFileSync(tmpFile, Buffer.from(base64, 'base64'));

            const { exec } = require('child_process');
            const psCmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${tmpFile.replace(/\\/g, '\\\\')}'))`;
            exec('powershell -NoProfile -Command "' + psCmd + '"', (err) => {
                if (err) {
                    vscode.window.showErrorMessage('Clipboard copy failed: ' + err.message);
                } else {
                    vscode.window.showInformationMessage('Screenshot copied to clipboard');
                }
                try { fs.unlinkSync(tmpFile); } catch (_) {}
            });
        } else if (msg.type === 'oricKey') {
            // Keyboard input from the Screen View -> Oric keyboard matrix (shared uplink frame).
            vizSendInput(vizProto.keyFrame(msg.id, msg.down));
        } else if (msg.type === 'oricKeyReleaseAll') {
            vizSendInput(vizProto.releaseAllFrame());
        }
    });

    vizRegisterConsumer(screenConsumer);
}

function screenPanelHtml() {
    return `<!DOCTYPE html>
<html><head><style>
body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    padding: 8px 12px;
    margin: 0;
    background: var(--vscode-editor-background);
    user-select: none;
}
/* Match the screen's max width so the toolbar / status line up with the screen's
   right edge instead of the (letterboxed) view's far-right gray area. */
.statusrow { display: flex; align-items: center; max-width: 720px; margin: 2px 0; }
#status {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 0.85em;
    white-space: nowrap;
}
/* Keyboard-control state — right-aligned on the status line (over the Copy button),
   NOT overlaid on the live screen. */
#kbdBadge {
    margin-left: auto; padding-left: 12px;
    font: 11px monospace; color: #888; white-space: nowrap;
}
#error {
    color: var(--vscode-errorForeground, #f44);
    font-size: 0.85em;
    margin: 2px 0;
    display: none;
    max-width: 720px;
}
.controls {
    display: flex;
    gap: 16px;
    align-items: center;
    margin: 6px 0;
    font-size: 0.9em;
    max-width: 720px;
}
.controls label { cursor: pointer; display: flex; align-items: center; gap: 4px; }
.controls input[type="checkbox"] { cursor: pointer; }
.controls button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 2px 8px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
}
.controls button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.controls button:disabled { opacity: 0.4; cursor: default; }
/* Row by default: screen fills the space, inspector is a fixed narrow column beside it
   (so a taller screen never squeezes the inspector until it wraps below → scroll). Only
   a genuinely narrow view stacks them (media query) — then the inspector goes full-width. */
.stage { display: flex; gap: 16px; align-items: flex-start; }
/* Row mode: inspector shrinks to its CONTENT (the zoomer / info text) instead of a fixed
   width, so no dead space is reserved beside it — the screen gets that width. Its internals
   stack (zoomer over info, selects and pixel/col/row on their own lines) to stay narrow. */
.inspect-panel { flex: 0 0 auto; min-width: 0; }
.inspector { flex-direction: column; }
.pxrow { flex-direction: column; }
.inspect-panel .controls { flex-direction: column; align-items: flex-start; gap: 4px; }
/* Fixed width so the panel width can't jitter as the (variable-length) hover text changes
   — otherwise every mouse move would resize the panel and rescale the screen. */
.info { flex: 0 0 auto; width: 150px; }
/* Narrow OR portrait view: stack the screen over the inspector; the inspector then goes
   full-width and its internals lay out side-by-side (zoomer beside info, one-line pixel/col/row). */
@media (max-width: 640px), (max-aspect-ratio: 1/1) {
    /* stretch (not flex-start) so the screen column fills the FULL view width — otherwise it
       shrinks to its content, which is the button row, capping the screen at ~500px. */
    .stage { flex-direction: column; align-items: stretch; }
    .inspect-panel { flex: 1 1 auto; }
    .inspector { flex-direction: row; flex-wrap: wrap; }
    .pxrow { flex-direction: row; flex-wrap: wrap; column-gap: 14px; }
    .inspect-panel .controls { flex-direction: row; align-items: center; gap: 16px; }
    .info { flex: 1 1 160px; min-width: 160px; width: auto; }
}
/* The screen column holds the status row + button bar + screen, all the SAME width, so
   the buttons and "click to control" badge always align to the screen's right edge (not
   the whole view's). It's the flex item that grows; the inspector sits beside it. */
.screen-col {
    flex: 1 1 340px;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.screen-col .statusrow, .screen-col .controls { max-width: none; }
.screen-wrap {
    position: relative;
    width: 100%;
    border: 1px solid #404040;
    cursor: none;
}
#screenCanvas {
    display: block;
    width: 100%;
    height: auto;
    image-rendering: pixelated;
}
/* CRT post-effect canvas (WebGL). Covers the raw screen when enabled; the grid/crosshair
   overlay stays above it. pointer-events:none so it never blocks hover / click-to-control. */
#crtCanvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: none;
    pointer-events: none;
}
#overlayCanvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
}
/* Run-state OSD badge (top-right of the screen). Purely informational — pointer-events
   none so it never steals a hover or a click-to-control. Shows ⏹ NOT RUNNING when there's
   no session, ‖ when halted, ▶▶ under warp; hidden while running normally or on hover. */
.osd {
    position: absolute;
    top: 6px;
    right: 8px;
    display: none;
    pointer-events: none;
    font: bold 40px/1 monospace;
    padding: 5px 12px;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.55);
    letter-spacing: 1px;
    z-index: 5;
}
.osd.turbo  { color: #7ee787; }   /* ▶▶ warp/turbo */
.osd.paused { color: #e2a03f; }   /* ‖ halted at a breakpoint */
/* No debug session (stopped / disconnected / not running). Smaller text badge, muted
   red so it reads as "not live" — distinct from the amber pause and green turbo. */
.osd.offline { color: #f0776c; font-size: 15px; letter-spacing: 0; }
/* Scripted-automation badge — OPPOSITE (top-left) corner so it coexists with the turbo/pause
   OSD, showing that a script is driving. Same non-interactive, hover-hiding behaviour. */
.osd-script {
    position: absolute;
    top: 6px;
    left: 8px;
    display: none;
    pointer-events: none;
    font: bold 15px/1 monospace;
    padding: 5px 10px;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.55);
    color: #58a6ff;
    letter-spacing: 1px;
    z-index: 5;
}
/* AI-piloting badge — top-left, below the SCRIPT badge (both rarely show at once), so it's
   an unmistakable "the assistant holds debug control" indicator. */
.osd-ai {
    position: absolute;
    top: 44px;
    left: 8px;
    display: none;
    pointer-events: none;
    font: bold 15px/1 monospace;
    padding: 5px 10px;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.55);
    color: #d2a8ff;
    letter-spacing: 1px;
    z-index: 5;
}
/* Pause = two thick bars, like a tape recorder's pause button (rather than the thin ‖). */
.osd .pausebar {
    display: inline-block;
    width: 13px;
    height: 40px;
    background: currentColor;
    border-radius: 1px;
    margin: 0 4px;
    vertical-align: middle;
}
.inspector {
    display: flex;
    gap: 12px;
    margin-top: 8px;
    align-items: flex-start;
}
.pxrow { display: flex; }
#zoomCanvas {
    border: 1px solid #404040;
    image-rendering: pixelated;
    flex-shrink: 0;
}
.info {
    font-size: 0.9em;
    line-height: 1.6;
}
.info .label { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
.info .value { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.info .dim { color: var(--vscode-descriptionForeground, #888); }
/* The "= $xx %bbbbbbbbb" byte value sits on its own line, slightly indented, so the
   address line stays short (helps the panel reflow in a narrow column). */
.info .byteline { margin-left: 12px; }
/* The bit the hovered pixel maps to is marked directly in the binary (underlined +
   accented) instead of a trailing "bit N" — reads at a glance, no counting. */
.info .bit { color: var(--vscode-charts-orange, #e2a03f); font-weight: bold; text-decoration: underline; }
.swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 1px solid #555;
    vertical-align: middle;
    margin-left: 4px;
}
/* View-options popup: rarely-changed grid / zoom / appearance controls, grouped into
   sections, opened from the ⚙ Options button so the toolbar stays uncluttered. */
.opt-menu {
    position: fixed; z-index: 60; display: none;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--vscode-menu-border, #454545);
    box-shadow: 0 2px 10px rgba(0,0,0,0.5);
    padding: 6px 0; min-width: 210px; max-height: 80vh; overflow-y: auto;
}
.opt-menu.open { display: block; }
.opt-menu .opt-sec {
    padding: 4px 12px 2px; font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground, #888);
}
.opt-menu .opt-sec + .opt-sec, .opt-menu label + .opt-sec {
    margin-top: 5px; border-top: 1px solid var(--vscode-menu-separatorBackground, #454545); padding-top: 6px;
}
.opt-menu label { display: flex; align-items: center; gap: 6px; padding: 3px 12px; white-space: nowrap; cursor: pointer; }
.opt-menu label:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.opt-menu label select { margin-left: auto; }
</style></head><body>
<div class="stage">
<div class="screen-col">
<div class="statusrow">
    <div id="status">Waiting for connection...</div>
    <div id="kbdBadge">⏸ Oric not connected</div>
</div>
<div id="error"></div>
<div class="controls">
    <button id="btnOptions">&#9881; Options</button>
    <span style="flex:1"></span>
    <button id="btnSave">Save</button>
    <button id="btnCopy">Copy</button>
    <button id="btnOpenSs">\u{1F4C1}</button>
</div>
<div class="screen-wrap" id="screenWrap">
    <canvas id="screenCanvas" width="240" height="224"></canvas>
    <canvas id="crtCanvas"></canvas>
    <canvas id="overlayCanvas" width="240" height="224"></canvas>
    <div class="osd" id="osd"></div>
    <div class="osd-script" id="osdScript">● SCRIPT</div>
    <div class="osd-ai" id="osdAi">● AI</div>
</div>
</div>
<div class="inspect-panel">
<div class="inspector">
    <canvas id="zoomCanvas" width="120" height="120"></canvas>
    <div class="info" id="infoPanel"></div>
</div>
</div>
</div>
<div id="optMenu" class="opt-menu">
    <div class="opt-sec">Grid</div>
    <label><input type="checkbox" id="colGrid"> Columns</label>
    <label><input type="checkbox" id="rowGrid"> Rows</label>
    <label>Color <select id="gridColor">
        <option value="128,0,0">Maroon</option>
        <option value="0,128,0">Forest</option>
        <option value="0,0,128">Navy</option>
        <option value="128,128,0">Olive</option>
        <option value="128,0,128">Purple</option>
        <option value="0,128,128">Teal</option>
        <option value="128,128,128" selected>Gray</option>
        <option value="255,128,0">Orange</option>
    </select></label>
    <div class="opt-sec">Zoom (inspector)</div>
    <label>Zoom <select id="zoomFactor">
        <option value="2">2x</option>
        <option value="4">4x</option>
        <option value="6" selected>6x</option>
        <option value="8">8x</option>
        <option value="12">12x</option>
    </select></label>
    <label>Context <select id="zoomRegion">
        <option value="10">10px</option>
        <option value="20" selected>20px</option>
        <option value="30">30px</option>
        <option value="40">40px</option>
    </select></label>
    <div class="opt-sec">Appearance</div>
    <label title="Show the turbo / paused / not-running run-state badge on the screen"><input type="checkbox" id="osdToggle" checked> OSD badge</label>
    <label title="Square = 1:1 pixels; off = true 50Hz Oric aspect (wider pixels)"><input type="checkbox" id="squarePx" checked> Square pixels</label>
    <label title="Retro CRT effect (scanlines + aperture mask, optional curvature)">Screen type <select id="crtMode">
        <option value="off" selected>Off</option>
        <option value="flat">Flat CRT</option>
        <option value="gentle">Curved (slight)</option>
        <option value="curved">Curved (full)</option>
    </select></label>
</div>
<script>
const vscode = acquireVsCodeApi();
const screenCanvas = document.getElementById('screenCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const zoomCanvas = document.getElementById('zoomCanvas');
const screenCtx = screenCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');
const zoomCtx = zoomCanvas.getContext('2d');
const status = document.getElementById('status');
const errorDiv = document.getElementById('error');
const infoPanel = document.getElementById('infoPanel');
const colGridCb = document.getElementById('colGrid');
const rowGridCb = document.getElementById('rowGrid');
const gridColorSel = document.getElementById('gridColor');
const screenWrap = document.getElementById('screenWrap');
const zoomFactorSel = document.getElementById('zoomFactor');
const zoomRegionSel = document.getElementById('zoomRegion');
const osdToggle = document.getElementById('osdToggle');
const osd = document.getElementById('osd');
const squarePxCb = document.getElementById('squarePx');
const crtCanvas = document.getElementById('crtCanvas');
const crtSel = document.getElementById('crtMode');

// --- Settings persistence ---
function saveSettings() {
    vscode.setState({
        colGrid: colGridCb.checked,
        rowGrid: rowGridCb.checked,
        gridColor: gridColorSel.value,
        zoomFactor: zoomFactorSel.value,
        zoomRegion: zoomRegionSel.value,
        osd: osdToggle.checked,
        squarePx: squarePxCb.checked,
        crtMode: crtSel.value
    });
}
{
    const s = vscode.getState();
    if (s) {
        colGridCb.checked = !!s.colGrid;
        rowGridCb.checked = !!s.rowGrid;
        if (s.gridColor) gridColorSel.value = s.gridColor;
        if (s.zoomFactor) zoomFactorSel.value = s.zoomFactor;
        if (s.zoomRegion) zoomRegionSel.value = s.zoomRegion;
        if (s.osd !== undefined) osdToggle.checked = !!s.osd;
        if (s.squarePx !== undefined) squarePxCb.checked = !!s.squarePx;
        if (s.crtMode) crtSel.value = s.crtMode;
    }
}

// --- CRT post-effect (optional WebGL shader over the screen) ---------------------
// Renders the 240x224 screen (uploaded as a texture) through a single-pass CRT shader,
// parameterised by mode: scanlines, an RGB aperture mask, barrel curvature and vignette,
// each switchable via a uniform. Purely a display flourish over the 2D screen canvas.
// When CURVATURE is active the grid overlay and hover→pixel mapping apply the SAME barrel
// math (curveInv / curveFwd below) so the character matrix and inspector stay aligned.
// Falls back gracefully if WebGL is absent. Barrel constants shared with the shader:
const CRT_CURVE_X = 5.0, CRT_CURVE_Y = 4.0;   // larger = flatter (denominators in the curve)
const CRT_MODES = {
    off:    null,
    flat:   { curve: 0.0, mask: 1, scan: 0.35, vig: 0 },   // scanlines + aperture, no curvature
    gentle: { curve: 0.4, mask: 1, scan: 0.35, vig: 1 },   // a little curvature
    curved: { curve: 1.0, mask: 1, scan: 0.35, vig: 1 }    // full curvature
};
const crt = (function () {
    let gl = null, prog = null, tex = null, ready = false, params = null;
    let U = {};
    const VS = [
        'attribute vec2 aPos;',
        'varying vec2 vUv;',
        'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
    ].join('\\n');
    const FS = [
        'precision mediump float;',
        'varying vec2 vUv;',
        'uniform sampler2D uTex;',
        'uniform vec2 uRes;',
        'uniform float uCurve;',   // 0 = flat, 1 = barrel curvature
        'uniform float uMask;',    // aperture mask strength
        'uniform float uScan;',    // scanline strength
        'uniform float uVig;',     // vignette strength
        'vec2 curve(vec2 uv){',
        '  vec2 cc = uv * 2.0 - 1.0;',
        '  vec2 off = abs(cc.yx) / vec2(' + CRT_CURVE_X.toFixed(1) + ', ' + CRT_CURVE_Y.toFixed(1) + ');',
        '  vec2 cv = (cc + cc * off * off) * 0.5 + 0.5;',
        '  return mix(uv, cv, uCurve);',
        '}',
        'void main(){',
        '  vec2 uv = curve(vUv);',
        '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }',
        '  vec3 col = texture2D(uTex, uv).rgb;',
        '  float sl = sin(uv.y * uRes.y * 6.28318) * 0.5 + 0.5;',
        '  col *= mix(1.0, sl, uScan);',
        '  float m = mod(gl_FragCoord.x, 3.0);',
        '  vec3 mask = m < 1.0 ? vec3(1.05, 0.75, 0.75) : (m < 2.0 ? vec3(0.75, 1.05, 0.75) : vec3(0.75, 0.75, 1.05));',
        '  col *= mix(vec3(1.0), mask, uMask);',
        '  float vig = pow(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.18);',
        '  col *= mix(1.0, clamp(vig, 0.0, 1.0), uVig);',
        '  col *= 1.0 + 0.45 * uScan + 0.22 * uMask;',   // compensate for the darkening
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
    ].join('\\n');
    function compile(type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.error('CRT shader: ' + gl.getShaderInfoLog(sh)); return null; }
        return sh;
    }
    function init() {
        try { gl = crtCanvas.getContext('webgl') || crtCanvas.getContext('experimental-webgl'); } catch (e) { gl = null; }
        if (!gl) return false;
        const vs = compile(gl.VERTEX_SHADER, VS), fs = compile(gl.FRAGMENT_SHADER, FS);
        if (!vs || !fs) return false;
        prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('CRT link: ' + gl.getProgramInfoLog(prog)); return false; }
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        ['uRes', 'uCurve', 'uMask', 'uScan', 'uVig'].forEach(n => { U[n] = gl.getUniformLocation(prog, n); });
        ready = true;
        return true;
    }
    function resize() {
        if (!ready) return;
        const rect = screenCanvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
        if (crtCanvas.width !== w || crtCanvas.height !== h) { crtCanvas.width = w; crtCanvas.height = h; }
    }
    function render() {
        if (!ready || !params || crtCanvas.style.display === 'none') return;
        resize();
        gl.viewport(0, 0, crtCanvas.width, crtCanvas.height);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, screenCanvas);
        gl.uniform2f(U.uRes, 240.0, 224.0);
        gl.uniform1f(U.uCurve, params.curve);
        gl.uniform1f(U.uMask, params.mask);
        gl.uniform1f(U.uScan, params.scan);
        gl.uniform1f(U.uVig, params.vig);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    const available = init();
    return {
        available: available,
        setMode(name) {
            params = (available && CRT_MODES[name]) || null;
            crtCanvas.style.display = params ? 'block' : 'none';
            if (params) render();
        },
        curveAmount() { return params ? params.curve : 0; },
        render: render,
        resize: resize
    };
})();

// Barrel curve shared with the CRT shader, blended by the current curvature amount k
// (matching the shader's mix(uv, cv, uCurve)) so a "slight" curve bends the grid/hover by
// exactly the same fraction the shader bends the image.
// curveFwd: screen pos (0..1) -> texture/Oric pos (0..1)  — used by hover to find the pixel.
// curveInv: texture pos -> screen pos (fixed-point iteration) — used to bend the grid lines.
function crtCurved() { return crt.curveAmount() > 0; }
function fullCurve(nx, ny) {   // the k=1 barrel map (in 0..1 space), identical to the shader
    const ccx = nx * 2 - 1, ccy = ny * 2 - 1;
    const offx = Math.abs(ccy) / CRT_CURVE_X, offy = Math.abs(ccx) / CRT_CURVE_Y;
    return [(ccx + ccx * offx * offx) * 0.5 + 0.5, (ccy + ccy * offy * offy) * 0.5 + 0.5];
}
function curveFwd(nx, ny) {
    const k = crt.curveAmount();
    if (k <= 0) return [nx, ny];
    const cv = fullCurve(nx, ny);
    return [nx + (cv[0] - nx) * k, ny + (cv[1] - ny) * k];
}
function curveInv(tx, ty) {
    const k = crt.curveAmount();
    if (k <= 0) return [tx, ty];
    // Solve curveFwd(s) = t for s by fixed-point: s = t - k*(fullCurve(s) - s).
    let sx = tx, sy = ty;
    for (let i = 0; i < 14; i++) {
        const cv = fullCurve(sx, sy);
        sx = tx - k * (cv[0] - sx);
        sy = ty - k * (cv[1] - sy);
    }
    return [sx, sy];
}

const PALETTE = [
    [0,0,0], [255,0,0], [0,255,0], [255,255,0],
    [0,0,255], [255,0,255], [0,255,255], [255,255,255]
];
const COLOR_NAMES = ['Black','Red','Green','Yellow','Blue','Magenta','Cyan','White'];

const screenImg = screenCtx.createImageData(240, 224);

// Current frame state for inspector lookups
let curScrBuf = null;     // Uint8Array 240*224
let curVidRamMain = null;  // Uint8Array 8000
let curVidRamBottom = null; // Uint8Array 120
let curVidMode = 0;
let curVidAddr = 0;
let curVidbases = [0, 0, 0, 0];
let curFrameCounter = 0;

// Last hover position for refreshing zoom on new frames
let hoverPx = -1, hoverPy = -1;

function b64decode(str) {
    const bin = atob(str);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

function renderScreen(msg) {
    errorDiv.style.display = 'none';
    curScrBuf = b64decode(msg.scrBuf);
    updateSaveButtons();   // a frame exists now — enable Save / Copy
    curVidRamMain = b64decode(msg.vidRamMain);
    curVidRamBottom = b64decode(msg.vidRamBottom);
    curVidMode = msg.vidMode;
    curVidAddr = msg.vidAddr;
    curVidbases = msg.vidbases;
    curFrameCounter = msg.frameCounter;

    for (let i = 0; i < 240 * 224; i++) {
        const c = curScrBuf[i] & 7;
        const px = i * 4;
        screenImg.data[px]     = PALETTE[c][0];
        screenImg.data[px + 1] = PALETTE[c][1];
        screenImg.data[px + 2] = PALETTE[c][2];
        screenImg.data[px + 3] = 255;
    }
    screenCtx.putImageData(screenImg, 0, 0);
    crt.render();   // refresh the CRT effect from the new frame (no-op when disabled)

    status.textContent = 'Frame ' + msg.frameCounter +
        ' | ' + ((msg.vidMode & 4) ? 'HIRES' : 'TEXT') +
        ' | Vid $' + msg.vidAddr.toString(16).toUpperCase().padStart(4, '0');

    // Refresh inspector if mouse is hovering
    if (hoverPx >= 0) updateInspector(hoverPx, hoverPy);
}

// --- Overlay grid (drawn at display resolution for crisp 1px lines) ---

function resizeOverlay() {
    const rect = screenCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
        overlayCanvas.width = w;
        overlayCanvas.height = h;
    }
    drawOverlay();
    crt.render();   // keep the CRT canvas sized to the screen and redraw
}

function getGridColor(alpha) {
    return 'rgba(' + gridColorSel.value + ',' + alpha + ')';
}

// Stroke a texture-space vertical line (constant tx) as it appears on the (possibly curved)
// screen — a straight segment when flat, a bent polyline through curveInv when curved.
function strokeCurvedV(tx, w, h, xShift) {
    const steps = 20;
    overlayCtx.beginPath();
    for (let i = 0; i <= steps; i++) {
        const p = curveInv(tx, i / steps);
        const X = p[0] * w + (xShift || 0), Y = p[1] * h;
        if (i === 0) overlayCtx.moveTo(X, Y); else overlayCtx.lineTo(X, Y);
    }
    overlayCtx.stroke();
}
function strokeCurvedH(ty, w, h, yShift) {
    const steps = 20;
    overlayCtx.beginPath();
    for (let i = 0; i <= steps; i++) {
        const p = curveInv(i / steps, ty);
        const X = p[0] * w, Y = p[1] * h + (yShift || 0);
        if (i === 0) overlayCtx.moveTo(X, Y); else overlayCtx.lineTo(X, Y);
    }
    overlayCtx.stroke();
}

function drawOverlay() {
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    const sx = w / 240;
    const sy = h / 224;
    const curved = crtCurved();   // bend the grid/crosshair to match the CRT curvature
    overlayCtx.clearRect(0, 0, w, h);
    overlayCtx.strokeStyle = getGridColor(0.5);
    overlayCtx.lineWidth = 1;
    if (colGridCb.checked) {
        for (let col = 6; col < 240; col += 6) {
            if (curved) { strokeCurvedV(col / 240, w, h, 0); }
            else {
                const dx = Math.round(col * sx) + 0.5;
                overlayCtx.beginPath(); overlayCtx.moveTo(dx, 0); overlayCtx.lineTo(dx, h); overlayCtx.stroke();
            }
        }
    }
    if (rowGridCb.checked) {
        for (let row = 8; row < 224; row += 8) {
            if (curved) { strokeCurvedH(row / 224, w, h, 0); }
            else {
                const dy = Math.round(row * sy) + 0.5;
                overlayCtx.beginPath(); overlayCtx.moveTo(0, dy); overlayCtx.lineTo(w, dy); overlayCtx.stroke();
            }
        }
    }
    // Crosshair at hover position (black-white-black for visibility on any background)
    if (hoverPx >= 0) {
        const lines = [
            { offset: -1, color: 'rgba(0,0,0,0.6)' },
            { offset:  0, color: 'rgba(255,255,255,0.8)' },
            { offset:  1, color: 'rgba(0,0,0,0.6)' }
        ];
        overlayCtx.lineWidth = 1;
        if (curved) {
            const tx = (hoverPx + 0.5) / 240, ty = (hoverPy + 0.5) / 224;
            for (const l of lines) {
                overlayCtx.strokeStyle = l.color;
                strokeCurvedV(tx, w, h, l.offset);
                strokeCurvedH(ty, w, h, l.offset);
            }
        } else {
            const cx = Math.round((hoverPx + 0.5) * sx);
            const cy = Math.round((hoverPy + 0.5) * sy);
            for (const l of lines) {
                overlayCtx.strokeStyle = l.color;
                overlayCtx.beginPath(); overlayCtx.moveTo(cx + l.offset + 0.5, 0); overlayCtx.lineTo(cx + l.offset + 0.5, h); overlayCtx.stroke();
                overlayCtx.beginPath(); overlayCtx.moveTo(0, cy + l.offset + 0.5); overlayCtx.lineTo(w, cy + l.offset + 0.5); overlayCtx.stroke();
            }
        }
    }
}

const resizeObs = new ResizeObserver(() => resizeOverlay());
resizeObs.observe(screenCanvas);

squarePxCb.addEventListener('change', () => { saveSettings(); applyAspect(); });
crtSel.addEventListener('change', () => {
    saveSettings();
    crt.setMode(crtSel.value);
    drawOverlay();   // grid straightens/bends with the mode
    if (hoverPx >= 0) updateInspector(hoverPx, hoverPy);
});
colGridCb.addEventListener('change', () => { saveSettings(); drawOverlay(); });
rowGridCb.addEventListener('change', () => { saveSettings(); drawOverlay(); });
gridColorSel.addEventListener('change', () => { saveSettings(); drawOverlay(); if (hoverPx >= 0) updateInspector(hoverPx, hoverPy); });

// --- Inspector ---

function hex4(v) { return '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }
function hex2(v) { return '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }
function bin8(v) { return '%' + (v & 0xFF).toString(2).padStart(8, '0'); }
// bin8 with the given bit position (0=LSB..7=MSB) wrapped for highlighting. In the
// "%b7b6b5b4b3b2b1b0" string, bit N is at index (8 - N) (index 0 is the '%').
function bin8hl(v, bitPos) {
    const s = bin8(v);
    if (bitPos === undefined || bitPos < 0 || bitPos > 7) return s;
    const i = 8 - bitPos;
    return s.slice(0, i) + '<span class="bit">' + s[i] + '</span>' + s.slice(i + 1);
}

function computeScreenAddress(x, y) {
    const col = Math.floor(x / 6);
    if (y < 200) {
        if (curVidMode & 4) {
            return { addr: curVidAddr + y * 40 + col, mode: 'HIRES', bitPos: 5 - (x % 6) };
        } else {
            return { addr: curVidAddr + Math.floor(y / 8) * 40 + col, mode: 'TEXT' };
        }
    } else {
        return { addr: curVidbases[2] + Math.floor(y / 8) * 40 + col, mode: 'TEXT (status)' };
    }
}

function computeAltAddress(x, y) {
    const col = Math.floor(x / 6);
    if (y < 200) {
        if (curVidMode & 4) {
            // Currently HIRES, show alternate TEXT address
            return { addr: curVidAddr + Math.floor(y / 8) * 40 + col, mode: 'TEXT' };
        } else {
            // Currently TEXT, show alternate HIRES address
            return { addr: curVidAddr + y * 40 + col, mode: 'HIRES', bitPos: 5 - (x % 6) };
        }
    }
    return null;
}

function lookupByte(addr) {
    // Try main vidram area first
    const mainOff = addr - curVidAddr;
    if (mainOff >= 0 && mainOff < 8000 && curVidRamMain) {
        return curVidRamMain[mainOff];
    }
    // Try bottom rows area
    const bottomOff = addr - curVidbases[2];
    if (bottomOff >= 0 && bottomOff < 120 && curVidRamBottom) {
        return curVidRamBottom[bottomOff];
    }
    return null;
}

function updateInspector(px, py) {
    if (!curScrBuf) return;

    const zf = parseInt(zoomFactorSel.value) || 6;   // zoom factor (pixels per Oric pixel)
    const region = parseInt(zoomRegionSel.value) || 20; // region size in Oric pixels
    const zoomR = Math.floor(region / 2);
    const canvasSize = region * zf;

    // Resize zoom canvas if needed
    if (zoomCanvas.width !== canvasSize || zoomCanvas.height !== canvasSize) {
        zoomCanvas.width = canvasSize;
        zoomCanvas.height = canvasSize;
    }

    zoomCtx.clearRect(0, 0, canvasSize, canvasSize);
    for (let dy = -zoomR; dy < zoomR; dy++) {
        for (let dx = -zoomR; dx < zoomR; dx++) {
            const sx = px + dx, sy = py + dy;
            let r = 0, g = 0, b = 0;
            if (sx >= 0 && sx < 240 && sy >= 0 && sy < 224) {
                const c = curScrBuf[sy * 240 + sx] & 7;
                r = PALETTE[c][0]; g = PALETTE[c][1]; b = PALETTE[c][2];
            }
            zoomCtx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
            zoomCtx.fillRect((dx + zoomR) * zf, (dy + zoomR) * zf, zf, zf);
        }
    }

    // Grid lines in zoom view
    const gridColor = getGridColor(0.4);
    zoomCtx.strokeStyle = gridColor;
    zoomCtx.lineWidth = 1;
    if (colGridCb.checked) {
        const leftOric = px - zoomR;
        const firstCol = Math.ceil(leftOric / 6) * 6;
        for (let cx = firstCol; cx < leftOric + region; cx += 6) {
            const zx = (cx - leftOric) * zf + 0.5;
            zoomCtx.beginPath();
            zoomCtx.moveTo(zx, 0);
            zoomCtx.lineTo(zx, canvasSize);
            zoomCtx.stroke();
        }
    }
    if (rowGridCb.checked) {
        const topOric = py - zoomR;
        const firstRow = Math.ceil(topOric / 8) * 8;
        for (let ry = firstRow; ry < topOric + region; ry += 8) {
            const zy = (ry - topOric) * zf + 0.5;
            zoomCtx.beginPath();
            zoomCtx.moveTo(0, zy);
            zoomCtx.lineTo(canvasSize, zy);
            zoomCtx.stroke();
        }
    }

    // Center pixel highlight (black-white-black, outside the pixel so color stays visible)
    const px0 = zoomR * zf;
    zoomCtx.lineWidth = 1;
    zoomCtx.strokeStyle = 'rgba(0,0,0,0.7)';
    zoomCtx.strokeRect(px0 - 1.5, px0 - 1.5, zf + 2, zf + 2);
    zoomCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    zoomCtx.strokeRect(px0 - 0.5, px0 - 0.5, zf, zf);
    zoomCtx.strokeStyle = 'rgba(0,0,0,0.7)';
    zoomCtx.strokeRect(px0 + 0.5, px0 + 0.5, zf - 2, zf - 2);

    // Info text
    const col = Math.floor(px / 6);
    const row = Math.floor(py / 8);
    const colorIdx = curScrBuf[py * 240 + px] & 7;
    const pri = computeScreenAddress(px, py);
    const priB = lookupByte(pri.addr);

    let html = '<div class="pxrow">'
        + '<span><span class="label">Pixel</span> <span class="value">(' + px + ', ' + py + ')</span></span>'
        + '<span><span class="label">Col</span> <span class="value">' + col + '</span> '
        + '<span class="label">Row</span> <span class="value">' + row + '</span></span>'
        + '</div>';

    // Primary address (mode + address on one line, the byte value on the next)
    html += '<div><span class="label">' + pri.mode + '</span> <span class="value">' + hex4(pri.addr) + '</span></div>';
    if (priB !== null) {
        html += '<div class="byteline">= <span class="value">' + hex2(priB) + ' ' + bin8hl(priB, pri.bitPos) + '</span></div>';
    }

    // Color
    const rgb = PALETTE[colorIdx];
    html += '<div><span class="label">Color</span> <span class="value">' + COLOR_NAMES[colorIdx] + ' (' + colorIdx + ')</span>';
    html += '<span class="swatch" style="background:rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')"></span></div>';

    infoPanel.innerHTML = html;
}

// External feed: an Oric Memory graphic entry drives this ONE zoomer while its canvas is
// hovered (you can't hover both surfaces at once, so the screen isn't using it then). The
// memory panel relays the decoded pixels + the pre-computed address/byte/bit/color, so this
// just magnifies from that buffer and shows the memory info. Same zoom/grid controls.
let extZoom = null;   // { px:Uint8Array, w, h, transp, x, y, addr, byte, bit, color }
function transpRGB(mode, x, y) {   // transparent-pixel fill (255 sentinel); mirrors the memory panel
    if (mode === 'checker') { const v = ((x + y) & 1) ? 102 : 153; return [v, v, v]; }
    if (mode === 'dark') return [48, 48, 48];
    return [128, 128, 128];
}
function updateInspectorExt() {
    if (!extZoom) return;
    const src = extZoom, px = src.x, py = src.y;
    const zf = parseInt(zoomFactorSel.value) || 6;
    const region = parseInt(zoomRegionSel.value) || 20;
    const zoomR = Math.floor(region / 2);
    const canvasSize = region * zf;
    if (zoomCanvas.width !== canvasSize || zoomCanvas.height !== canvasSize) { zoomCanvas.width = canvasSize; zoomCanvas.height = canvasSize; }
    zoomCtx.clearRect(0, 0, canvasSize, canvasSize);
    for (let dy = -zoomR; dy < zoomR; dy++) {
        for (let dx = -zoomR; dx < zoomR; dx++) {
            const sx = px + dx, sy = py + dy;
            let r = 0, g = 0, b = 0;
            if (sx >= 0 && sx < src.w && sy >= 0 && sy < src.h) {
                const v = src.px[sy * src.w + sx];
                if (v === 255) { const t = transpRGB(src.transp, sx, sy); r = t[0]; g = t[1]; b = t[2]; }
                else { const c = v & 7; r = PALETTE[c][0]; g = PALETTE[c][1]; b = PALETTE[c][2]; }
            }
            zoomCtx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
            zoomCtx.fillRect((dx + zoomR) * zf, (dy + zoomR) * zf, zf, zf);
        }
    }
    const gridColor = getGridColor(0.4); zoomCtx.strokeStyle = gridColor; zoomCtx.lineWidth = 1;
    if (colGridCb.checked) { const l = px - zoomR, f = Math.ceil(l / 6) * 6; for (let cx = f; cx < l + region; cx += 6) { const zx = (cx - l) * zf + 0.5; zoomCtx.beginPath(); zoomCtx.moveTo(zx, 0); zoomCtx.lineTo(zx, canvasSize); zoomCtx.stroke(); } }
    if (rowGridCb.checked) { const t = py - zoomR, f = Math.ceil(t / 8) * 8; for (let ry = f; ry < t + region; ry += 8) { const zy = (ry - t) * zf + 0.5; zoomCtx.beginPath(); zoomCtx.moveTo(0, zy); zoomCtx.lineTo(canvasSize, zy); zoomCtx.stroke(); } }
    const p0 = zoomR * zf; zoomCtx.lineWidth = 1;
    zoomCtx.strokeStyle = 'rgba(0,0,0,0.7)'; zoomCtx.strokeRect(p0 - 1.5, p0 - 1.5, zf + 2, zf + 2);
    zoomCtx.strokeStyle = 'rgba(255,255,255,0.9)'; zoomCtx.strokeRect(p0 - 0.5, p0 - 0.5, zf, zf);
    zoomCtx.strokeStyle = 'rgba(0,0,0,0.7)'; zoomCtx.strokeRect(p0 + 0.5, p0 + 0.5, zf - 2, zf - 2);
    const col = Math.floor(px / 6);
    let colorHtml, swRgb;
    if (src.color === 255) { colorHtml = 'transparent'; swRgb = transpRGB(src.transp, px, py); }
    else { const c = src.color & 7; colorHtml = COLOR_NAMES[c] + ' (' + c + ')'; swRgb = PALETTE[c]; }
    let html = '<div class="pxrow"><span><span class="label">Pixel</span> <span class="value">(' + px + ', ' + py + ')</span></span>'
        + '<span><span class="label">Col</span> <span class="value">' + col + '</span></span></div>';
    html += '<div><span class="label">Mem</span> <span class="value">' + hex4(src.addr) + '</span></div>';
    html += '<div class="byteline">= <span class="value">' + hex2(src.byte) + ' ' + bin8hl(src.byte, src.bit) + '</span></div>';
    html += '<div><span class="label">Color</span> <span class="value">' + colorHtml + '</span><span class="swatch" style="background:rgb(' + swRgb[0] + ',' + swRgb[1] + ',' + swRgb[2] + ')"></span></div>';
    infoPanel.innerHTML = html;
}

// Mouse tracking on the screen canvas wrapper
screenWrap.addEventListener('mousemove', (e) => {
    const rect = screenCanvas.getBoundingClientRect();
    // Map the cursor through the CRT curve (identity when flat) so the located pixel is the
    // one actually drawn under the cursor on a curved screen.
    const t = curveFwd((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    const px = Math.floor(t[0] * 240);
    const py = Math.floor(t[1] * 224);
    if (px >= 0 && px < 240 && py >= 0 && py < 224) {
        const wasHovering = hoverPx >= 0;
        hoverPx = px; hoverPy = py;
        updateInspector(px, py);
        drawOverlay();
        if (!wasHovering) updateOsd();   // entered the screen → hide the OSD (crosshair up)
    }
});

screenWrap.addEventListener('mouseleave', () => {
    hoverPx = -1; hoverPy = -1;
    infoPanel.innerHTML = '';
    zoomCtx.clearRect(0, 0, zoomCanvas.width, zoomCanvas.height);
    drawOverlay();
    updateOsd();   // left the screen → restore the OSD
});

// Fit the screen to the available HEIGHT too: cap its width so its (aspect-locked)
// height never exceeds what's on screen — so shrinking the view vertically scales the
// screen down (like a stamp) instead of forcing a scrollbar. Width-capping keeps the
// canvas aspect-correct, so the hover→pixel math (canvas bounding rect) stays valid.
// Display pixel aspect. The Oric's 240x224 pixels are NOT square on a real 50Hz PAL CRT:
// the frame spreads those lines over more scanlines than a 60Hz one, so the image is
// COMPRESSED vertically (shorter/wider) by ~260/308 — round shapes render as flattened
// (horizontal) ellipses. Matches Oricutron's own aspect-ratio correction. "Square px"
// (default) = 1:1 pixels (also ≈ correct at 60Hz); unchecked = the shorter/wider 50Hz
// look. Only the vertical DISPLAY size changes — the 240x224 pixel buffer, grid and hover
// math are unchanged (everything derives from the canvas's live bounding rect).
const ORIC_VSCALE = 260 / 308;   // ≈ 0.844 vertical compression (50Hz vs 60Hz scanline count)
function displayAspectH() { return squarePxCb.checked ? 224 : Math.round(224 * ORIC_VSCALE); }
function applyAspect() {
    screenCanvas.style.aspectRatio = '240 / ' + displayAspectH();
    resizeOverlay();   // overlay/grid re-derive from the new canvas size
    scheduleFit();     // width cap depends on the aspect
}

function fitScreen() {
    const col = document.querySelector('.screen-col');
    if (!col) return;
    // Measure from the screen's own top (below the status + button bar) so the fit accounts
    // for the height those rows consume. Cap the column width → the screen (width:100%) can't
    // grow taller than the space left, so a short view scales it down instead of scrolling.
    const top = screenWrap.getBoundingClientRect().top;
    let availH = Math.max(60, (document.documentElement.clientHeight || window.innerHeight) - top - 12);
    // When the inspector is stacked BELOW the screen (portrait/narrow), reserve its height
    // so the screen doesn't grow tall enough to push the inspector off the bottom (scrollbar).
    const stage = document.querySelector('.stage');
    if (stage && getComputedStyle(stage).flexDirection === 'column') {
        const insp = document.querySelector('.inspect-panel');
        if (insp) availH = Math.max(60, availH - insp.offsetHeight - 16);
    }
    // No artificial max: the screen fills the space, bounded by available height (this cap)
    // and, in row mode, by the flex width (view minus the inspector beside it).
    const maxW = Math.floor(availH * 240 / displayAspectH());
    const px = maxW + 'px';
    if (col.style.maxWidth !== px) col.style.maxWidth = px;   // avoid redundant writes / observer churn
}
// Defer one frame so measurements are taken AFTER any media-query reflow (row↔column) has
// settled — otherwise we'd read the pre-reflow inspector height/position and mis-size.
let fitPending = false;
function scheduleFit() {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(() => { fitPending = false; fitScreen(); });
}
window.addEventListener('resize', scheduleFit);
// The iframe often isn't at its final height when the script first runs (and no resize
// event follows the settle), so a one-shot fit would lock the screen to a too-small height.
// A ResizeObserver on the root recomputes on the initial settle AND every later layout change.
if (window.ResizeObserver) new ResizeObserver(scheduleFit).observe(document.documentElement);
applyAspect();   // apply the restored square/Oric aspect + schedule the initial fit
// CRT: disable the dropdown if WebGL is unavailable; otherwise apply the restored mode.
if (!crt.available) { crtSel.value = 'off'; crtSel.disabled = true; }
crt.setMode(crtSel.value);
drawOverlay();   // reflect a restored "curved" mode in the grid immediately

// Zoom controls: refresh inspector on change
zoomFactorSel.addEventListener('change', () => {
    saveSettings();
    if (hoverPx >= 0) updateInspector(hoverPx, hoverPy);
    else {
        const zf = parseInt(zoomFactorSel.value) || 6;
        const region = parseInt(zoomRegionSel.value) || 20;
        const sz = region * zf;
        zoomCanvas.width = sz; zoomCanvas.height = sz;
        zoomCtx.clearRect(0, 0, sz, sz);
    }
});
zoomRegionSel.addEventListener('change', () => {
    saveSettings();
    if (hoverPx >= 0) updateInspector(hoverPx, hoverPy);
    else {
        const zf = parseInt(zoomFactorSel.value) || 6;
        const region = parseInt(zoomRegionSel.value) || 20;
        const sz = region * zf;
        zoomCanvas.width = sz; zoomCanvas.height = sz;
        zoomCtx.clearRect(0, 0, sz, sz);
    }
});

// --- Save / Copy buttons ---
// Save / Copy only make sense once a frame has been captured (curScrBuf). Disable them
// until then (and they stay enabled after a stop, since the last frame persists).
function updateSaveButtons() {
    const has = !!curScrBuf;
    const s = document.getElementById('btnSave'), c = document.getElementById('btnCopy');
    if (s) s.disabled = !has;
    if (c) c.disabled = !has;
}
document.getElementById('btnSave').addEventListener('click', () => {
    if (!curScrBuf) return;
    vscode.postMessage({ type: 'saveImage', dataUrl: screenCanvas.toDataURL('image/png'), frame: curFrameCounter });
});
document.getElementById('btnCopy').addEventListener('click', () => {
    if (!curScrBuf) return;
    vscode.postMessage({ type: 'copyImage', dataUrl: screenCanvas.toDataURL('image/png') });
});
updateSaveButtons();   // start disabled until the first frame arrives
document.getElementById('btnOpenSs').addEventListener('click', () => {
    vscode.postMessage({ type: 'openScreenshots' });
});
// View-options popup: rarely-changed grid / zoom / appearance controls live here so the
// toolbar keeps only the actions. Toggled by the ⚙ button; clicks inside keep it open
// (change several at once); a click elsewhere closes it.
const btnOptions = document.getElementById('btnOptions');
const optMenu = document.getElementById('optMenu');
btnOptions.addEventListener('click', e => {
    e.stopPropagation();
    if (optMenu.classList.toggle('open')) {
        const r = btnOptions.getBoundingClientRect();
        optMenu.style.left = Math.max(2, Math.min(r.left, window.innerWidth - optMenu.offsetWidth - 4)) + 'px';
        optMenu.style.top = (r.bottom + 2) + 'px';
    }
});
document.addEventListener('click', e => {
    if (optMenu.classList.contains('open') && !optMenu.contains(e.target) && e.target !== btnOptions) optMenu.classList.remove('open');
});
window.addEventListener('keydown', e => { if (e.key === 'Escape') optMenu.classList.remove('open'); });
// Status-bar hover help for the toolbar buttons (visible alternative to tooltips).
const SS_HELP = {
    btnOptions: 'View options — grid lines, zoom/context, and appearance (screen type, pixels, OSD)',
    btnSave: 'Save the current screen as a PNG in the project screenshots/ folder',
    btnCopy: 'Copy the current screen to the clipboard',
    btnOpenSs: 'Open the screenshots/ folder in the file manager'
};
for (const id in SS_HELP) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.addEventListener('mouseenter', () => vscode.postMessage({ type: 'hover', text: SS_HELP[id] }));
    b.addEventListener('mouseleave', () => vscode.postMessage({ type: 'hoverEnd' }));
}

// Run-state OSD: ⏹ NOT RUNNING when there's no debug session, ‖ when halted at a breakpoint,
// ▶▶ when warp/turbo is on, nothing while running normally. Purely a status indicator (see
// the "State" toggle). All variants hide under the crosshair on hover.
let runState = { active: false, stopped: false, warp: false, scripted: false, aiPiloting: false };
const osdScript = document.getElementById('osdScript');
const osdAi = document.getElementById('osdAi');
function updateOsd() {
    let html = '', cls = 'osd';
    // Hidden while the mouse is over the screen (hoverPx >= 0) so it never sits under the
    // inspection crosshair; shown again on mouse-leave.
    if (osdToggle.checked && hoverPx < 0) {
        if (!runState.active) { cls = 'osd offline'; html = '&#9209; NOT RUNNING'; }   // ⏹ no debug session
        else if (runState.stopped) { cls = 'osd paused'; html = '<span class="pausebar"></span><span class="pausebar"></span>'; }
        else if (runState.warp) { cls = 'osd turbo'; html = '▶▶'; }
    }
    osd.className = cls;
    osd.innerHTML = html;
    osd.style.display = html ? 'block' : 'none';
    // Scripted badge in the opposite corner — shown whenever a script is driving (regardless
    // of turbo/pause), and hidden under the crosshair on hover like the OSD.
    osdScript.style.display = (osdToggle.checked && runState.scripted && hoverPx < 0) ? 'block' : 'none';
    osdAi.style.display = (osdToggle.checked && runState.aiPiloting && hoverPx < 0) ? 'block' : 'none';
}

window.addEventListener('message', e => {
    if (e.data.type === 'gfxZoom') {
        // A memory graphic entry is driving the zoomer (relayed from the memory panel).
        if (e.data.sub === 'buf') { extZoom = { px: Uint8Array.from(e.data.pixels || []), w: e.data.w | 0, h: e.data.h | 0, transp: e.data.transp || 'gray', x: 0, y: 0, addr: 0, byte: 0, bit: 0, color: 0 }; }
        else if (e.data.sub === 'at' && extZoom) { extZoom.x = e.data.x | 0; extZoom.y = e.data.y | 0; extZoom.addr = e.data.addr | 0; extZoom.byte = e.data.byte | 0; extZoom.bit = e.data.bit | 0; extZoom.color = e.data.color | 0; updateInspectorExt(); }
        else if (e.data.sub === 'end') { extZoom = null; infoPanel.innerHTML = ''; zoomCtx.clearRect(0, 0, zoomCanvas.width, zoomCanvas.height); }
        return;
    }
    if (e.data.type === 'screenFrame') renderScreen(e.data);
    if (e.data.type === 'status') { status.textContent = e.data.text; errorDiv.style.display = 'none'; }
    if (e.data.type === 'error') { errorDiv.textContent = e.data.text; errorDiv.style.display = 'block'; }
    if (e.data.type === 'runstate') {
        runState = { active: !!e.data.active, stopped: !!e.data.stopped, warp: !!e.data.warp, scripted: !!e.data.scripted, aiPiloting: !!e.data.aiPiloting };
        updateOsd();
    }
});
osdToggle.addEventListener('change', () => { saveSettings(); updateOsd(); });

// --- Keyboard input -> Oric (Phase 1) ---
// While the Screen View is focused, capture keys and forward them to the
// extension, which writes them up the viz_stream socket to the emulator.
(function(){
    const held = new Set();
    let connected = false, focused = false;
    // Badge lives on the status line (right-aligned), NOT overlaid on the live screen.
    const badge = document.getElementById('kbdBadge');
    function updateBadge(){
        if (!connected){ badge.textContent = '⏸ Oric not connected'; badge.style.color = '#888'; return; }
        badge.textContent = focused ? '⌨ input → Oric' : 'click to control the Oric';
        badge.style.color = focused ? '#8f8' : '#aaa';
    }
    function setFocused(f){ focused = f; updateBadge(); }
    // Connection state (viz stream) — no keyboard control when disconnected.
    window.addEventListener('message', function(e){
        if (e.data && e.data.type === 'conn'){ connected = !!e.data.connected; if (!connected) releaseAll(); updateBadge(); }
    });
    window.addEventListener('focus', function(){ setFocused(true); });
    window.addEventListener('blur', function(){ setFocused(false); releaseAll(); });
    function isUiControl(){
        const t = document.activeElement;
        return t && /^(BUTTON|SELECT|INPUT|TEXTAREA)$/.test(t.tagName);
    }
    // Key ids come from the shared table injected by the extension (mcp/oric-keys.cjs) —
    // NOT hardcoded here — so the Screen View and the automation runner can never drift.
    // Only the browser-specific bit stays local: which physical DOM e.code is which key name.
    const ORIC_KEYS = ${JSON.stringify(ORIC_KEY_TABLE)};
    const DOM_KEY = { ArrowUp:'UP', ArrowDown:'DOWN', ArrowLeft:'LEFT', ArrowRight:'RIGHT',
        Enter:'RETURN', NumpadEnter:'RETURN', Escape:'ESC', Space:'SPACE', Backspace:'BACKSPACE',
        ShiftLeft:'SHIFT', ShiftRight:'SHIFT', ControlLeft:'CTRL', ControlRight:'CTRL', Tab:'TAB' };
    function mapKey(e){
        const n = DOM_KEY[e.code];
        if (n && ORIC_KEYS[n] != null) return ORIC_KEYS[n];
        if (e.key && e.key.length === 1){ const c = e.key.charCodeAt(0); if (c >= 0x20 && c < 0x7f) return c; }
        return null;
    }
    function releaseAll(){ held.clear(); vscode.postMessage({ type: 'oricKeyReleaseAll' }); }
    window.addEventListener('keydown', function(e){
        if (!connected || isUiControl()) return;   // no control of a disconnected Oric
        const id = mapKey(e); if (id == null) return;
        e.preventDefault();
        if (e.repeat) return;
        held.add(id);
        vscode.postMessage({ type: 'oricKey', id: id, down: true });
    });
    window.addEventListener('keyup', function(e){
        if (!connected || isUiControl()) return;
        const id = mapKey(e); if (id == null) return;
        e.preventDefault();
        held.delete(id);
        vscode.postMessage({ type: 'oricKey', id: id, down: false });
    });
    updateBadge();
    vscode.postMessage({ type: 'screenReady' });   // ask the extension for the current connection state
})();
</script>
</body></html>`;
}

// ----------------------------------------------------------------
// Oric Disassembly Panel (custom webview, persists across reloads)
// ----------------------------------------------------------------

// All open Oric Disassembly panels. It's meant to be a singleton, but VS Code can
// restore a previously-open tab on window reload (deserializeWebviewPanel) — and if
// more than one ever exists, EVERY one must receive updates, or the untracked tab
// goes stale (shows the trace via Oricutron but its own view never moves). So track
// the set and post to all of them.
let disasmPanels = new Set();
let disasmCenterAddr = null;

// "Instruction-step mode": F10/F11 do instruction steps (keybindings gate on
// `oricInstructionStepMode`). Driven by which view the user last SELECTED: clicking the
// Oric Disassembly enters instruction mode, clicking a source editor returns to
// statement mode. The catch is VS Code's reveal-on-stop, which also focuses the source
// editor after every step — so we IGNORE editor-focus changes that land within a short
// window after a stop (lastStopMs); only a genuine user click flips the mode. This lets
// continued instruction-stepping survive the auto-reveal while source stepping stays
// source-level.
const REVEAL_ON_STOP_MS = 500; // focus changes within this window after a stop = auto-reveal, not a click
let instrStepMode = false;
let lastStopMs = 0;
let stepModeStatusBar = null; // created in activate(); reflects/toggles the mode
let hoverHelpStatusBar = null; // created in activate(); shows Debug Controls button help on hover (tooltips get covered by a large cursor — see no-tooltip-dependent-ui)
let oricDebugStopped = false; // true between 'stopped' and 'continued' events — gates all line actions
let replayCanRewind = false;  // history cursor can rewind (older entries exist) — gates Replay Rewind
let replayCanForward = false; // history cursor can replay forward (a rewind to undo) — gates Forward/to-Head
let lineActionLens = null;    // created in activate(); refreshed on stop/continue/selection change
let currentStopLoc = null;    // {path, line} of the top stack frame while stopped (null = no source)
let bpTreeEmitter = null;     // Oric Breakpoints tree refresh signal (created in activate)
let activeOricModuleId = null; // active overlay module id (for the breakpoint tree's follow/highlight)
let activeOricModuleName = null; // active overlay module NAME (for screenshot filenames)
let debugControlsProvider = null; // Oric Debug Controls webview view (button toolbar in the Run & Debug sidebar)
let oricSessionActive = false; // true between an oric-debug session's start and terminate (activeDebugSession races on terminate)
let oricWarpOn = false;       // current warp/turbo speed state (mirrors the toggleWarp toggle) — for the Screen View OSD
let dimLiveViews = null;      // set in activate: greys the live-data views (regs/peripherals/…) when not stopped
let refreshAllViews = null;   // set in activate = refreshAll; lets module-level code repaint the panels
let handleSymBpAction = null; // set in activate: perform a Symbols-panel breakpoint action (exec bp / watchpoint)
let refreshSymbolBpMarks = null; // set in activate: push the set of bp/wp addresses to the Symbols panel
let lastAddrBpAddrs = [];     // cache of adapter-owned address-bp addresses (for the Symbols panel marks)
let automationUiTimer = null; // debounces UI repaints while an automation script cycles stop/continue
let oricUserPaused = false;   // true when the USER paused the debugger mid-automation (not an automation-issued pause) — waits suspend
let automationPauseInFlight = false; // set while the automation itself issues a pause, so its own stop isn't mistaken for a user pause
// --- Collaborative MCP bridge state (share the LIVE session with an external MCP client) ---
let bridgeServer = null;            // net server (null = collaboration off)
let bridgeControl = BRIDGE_CONTROL.HUMAN;   // who pilots execution/breakpoints: 'human' | 'ai'
let bridgeStatusBar = null;         // status-bar indicator + one-click "take control"
const bridgeDiscoveryPaths = [];    // .oric-bridge.json files we wrote (cleaned up on stop)

// Central stopped-state switch: gates the source CodeLens AND the disasm
// panel's line actions (the webview hides its buttons/menu while the program
// runs or no session exists — run/jump/skip on a live PC would misfire).
function setOricDebugStopped(v, reason) {
    oricDebugStopped = !!v;
    // reason (from the DAP 'stopped' body) lets the automation runner tell a real
    // value-watch hit ('data breakpoint') from a manual pause / step — a waitFor must
    // NOT be satisfied by the user pausing to look around.
    automationEvents.fire({ type: oricDebugStopped ? 'stopped' : 'continued', reason: reason });   // drive the automation runner's waits
    if (bridgeServer) bridgeServer.broadcast(oricDebugStopped ? 'stopped' : 'continued', { reason });   // let a collaborating MCP client track run state
    if (automationRunning) {
        // A running script drives rapid continue/pause cycles; repainting on each is the
        // flicker. But a genuine USER pause (not one the automation issued) must still refresh
        // the UI and suspend the script's waits. Detect it, and debounce the repaint so it
        // only fires once the state has SETTLED — which is exactly a real pause, never cycling.
        if (oricDebugStopped) { if (reason === 'pause' && !automationPauseInFlight) oricUserPaused = true; }
        else { oricUserPaused = false; }   // resumed (by the user or the automation)
        scheduleAutomationUiSync();
        return;
    }
    applyDebugStateVisuals();
}

// The per-state UI repaint (line actions, bp tree, disasm state, control buttons, live-view
// dimming, Screen View OSD). Immediate outside automation; debounced during it (below).
function applyDebugStateVisuals() {
    if (!oricDebugStopped) { currentStopLoc = null; updatePcLineContext(); }
    if (lineActionLens) lineActionLens.refresh();
    if (bpTreeEmitter) bpTreeEmitter.fire();   // clear/redraw the "stopped here" marker
    pushDebugStateToDisasm();
    if (debugControlsProvider) debugControlsProvider.pushState();
    // Not stopped (running or session ended) → grey the live-data views to show the
    // values are stale. When stopped, refreshAll() re-renders them live.
    if (!oricDebugStopped && dimLiveViews) dimLiveViews();
    postScreenRunState();   // update the Screen View turbo/paused OSD
    updateReplayContext();  // enable/disable the Replay Rewind/Forward/to-Head buttons
}

// Drive a Replay toolbar button: ask the adapter to move the history cursor
// (non-destructive) via a custom request. The resulting 'stopped' event refreshes
// every view (incl. the button enablement, via applyDebugStateVisuals). No-op with
// no active Oric session.
async function replayNav(customReq) {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'oric-debug') return;
    try { await session.customRequest(customReq); }
    catch (e) { /* nothing to do / stub too old — silent */ }
}

// Set the context keys the Replay buttons enable on: canRewind (entries older than
// the cursor) and canReplayForward (entries newer — i.e. a rewind we can undo).
// Cleared whenever the program isn't stopped in an Oric session.
async function updateReplayContext() {
    const session = vscode.debug.activeDebugSession;
    let back = 0, fwd = 0;
    if (oricDebugStopped && session && session.type === 'oric-debug') {
        try { const r = await session.customRequest('histStatus'); if (r) { back = r.back | 0; fwd = r.fwd | 0; } }
        catch (e) { /* old stub / history disabled */ }
    }
    vscode.commands.executeCommand('setContext', 'oric-debug.canRewind', back > 0);
    vscode.commands.executeCommand('setContext', 'oric-debug.canReplayForward', fwd > 0);
    replayCanRewind = back > 0;
    replayCanForward = fwd > 0;
    if (debugControlsProvider) debugControlsProvider.pushState();   // refresh the toolbar buttons
}

// Debounced repaint for while an automation script runs: only fires after ~350 ms with no
// further stop/continue, i.e. the state has settled (a user pause, or the script sitting
// stopped) — so it never flickers during the rapid cycling, yet a real pause DOES refresh
// (including the panels, when stopped).
function scheduleAutomationUiSync() {
    if (automationUiTimer) clearTimeout(automationUiTimer);
    automationUiTimer = setTimeout(() => {
        automationUiTimer = null;
        applyDebugStateVisuals();   // cheap: just posts webview messages (buttons/dim/OSD)
        // The HEAVY panel refresh (regs/memory/symbols/disasm — many serialized adapter
        // round-trips) runs ONLY on a genuine user pause, not on every transient settle
        // between script steps — otherwise those bursts pile up and drain for seconds.
        if (oricUserPaused && refreshAllViews) refreshAllViews();
    }, 350);
}

// --- In-session automation runner --------------------------------------------
// Runs an automation/*.js playthrough script against the ACTIVE debug session, so it plays
// in the Oric Screen View and every debug view stays live. Reuses the shared step-algorithms
// (makeApi) — this just binds `ops` to the session + the extension's viz.
function automationChannel() { if (!automationChan) automationChan = vscode.window.createOutputChannel('Oric Automation'); return automationChan; }
function waitSessionEvent(type, timeoutMs, filter) {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => { sub.dispose(); reject(new Error('timeout waiting for ' + type)); }, timeoutMs || 30000);
        const sub = automationEvents.event(e => { if (e.type === type && (!filter || filter(e))) { clearTimeout(to); sub.dispose(); resolve(e); } });
    });
}
function inSessionOps(session) {
    // The GDB stub only services packets while the CPU is HALTED: a free-running 'c'
    // holds the command channel, so an arm-watchpoint / memory-read / evaluate issued
    // while running would queue behind it and never be sent (it only lands when the
    // program next stops — which is exactly the "nothing happens until I pause" symptom).
    // So every stub-dependent op halts first (pause = out-of-band \x03, always works).
    const self = {
        async continue() { if (oricDebugStopped) await session.customRequest('continue', { threadId: 1 }).catch(() => {}); },
        // automationPauseInFlight brackets the automation's OWN pause so the resulting stop
        // isn't mistaken for a user pause (see setOricDebugStopped's detection).
        async pause() { if (!oricDebugStopped) { automationPauseInFlight = true; const p = waitSessionEvent('stopped', 4000); await session.customRequest('pause', { threadId: 1 }).catch(() => {}); await p.catch(() => {}); automationPauseInFlight = false; } },
        async ensureStopped() { if (!oricDebugStopped) await self.pause(); return oricDebugStopped; },
        // True while the USER has paused the debugger mid-run — the core's waits suspend on it.
        isUserPaused() { return oricUserPaused; },
        // Optional `reason` filters which stop resolves the wait (e.g. 'data breakpoint'
        // for a value-watch hit) so a manual pause/step during a waitFor is ignored.
        waitStopped(ms, reason) { return waitSessionEvent('stopped', ms || 30000, reason ? (e => e.reason === reason) : null); },
        isStopped() { return oricDebugStopped; },
        async readMem(addr, n) { await self.ensureStopped(); const r = await session.customRequest('readMemory', { memoryReference: (addr & 0xffff).toString(16), offset: 0, count: n || 1 }); return r && r.data ? Buffer.from(r.data, 'base64') : Buffer.alloc(0); },
        async evaluate(expr) {
            await self.ensureStopped();
            let fid;
            try { const st = await session.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 1 }); fid = st && st.stackFrames && st.stackFrames[0] ? st.stackFrames[0].id : undefined; } catch (_) {}
            const r = await session.customRequest('evaluate', { expression: expr, frameId: fid, context: 'repl' });
            return r ? r.result : undefined;
        },
        sendKey(id, down) { vizSendInput(vizProto.keyFrame(id, down)); },
        releaseKeys() { vizSendInput(vizProto.releaseAllFrame()); },
        // Enqueue an emulator-owned key tap: Oricutron holds it `hold` emulated frames then
        // releases (reliable, one-at-a-time). Needs the TAP-queue emulator build; press()
        // falls back to sendKey down/up if this op is absent.
        tapKey(id, hold) { vizSendInput(vizProto.tapFrame(id, hold)); },
        vizFrame() { return vizLastFrame; },
        vizScreen() { return vizLastScrB64 ? Buffer.from(vizLastScrB64, 'base64') : null; },
        async setWatch(addr, access, cond) {
            await self.ensureStopped();   // must be halted to arm — else the Z-packet queues behind 'c'
            const info = await session.customRequest('dataBreakpointInfo', { name: '$' + (addr & 0xffff).toString(16) });
            if (!info || !info.dataId) throw new Error('cannot watch $' + (addr & 0xffff).toString(16));
            const bp = { dataId: info.dataId, accessType: access || 'write' };
            if (cond) bp.condition = cond;
            await session.customRequest('setDataBreakpoints', { breakpoints: [bp] });
        },
        async clearWatch() { await session.customRequest('setDataBreakpoints', { breakpoints: [] }).catch(() => {}); },
        // Value-watch used by waitFor: stop when the byte at addr changes to satisfy cond,
        // tested against real committed memory (fires regardless of the write mechanism).
        // Must be halted to arm (packet would queue behind a running 'c').
        async armValueWatch(addr, cond) {
            await self.ensureStopped();
            const r = await session.customRequest('oricArmValueWatch', { addr: addr & 0xffff, condition: cond || null });
            if (r && r.error) throw new Error('value-watch: ' + r.error);
        },
        async clearValueWatch(addr) { await session.customRequest('oricClearValueWatch', { addr: addr & 0xffff }).catch(() => {}); },
        // Active overlay module + list (pure adapter-state read — no stub, safe while running).
        async getModules() { try { return await session.customRequest('getModules'); } catch (_) { return null; } },
        // One-shot run-to: arm a temp breakpoint at target (symbol/addr) and run until hit.
        // Uses turboRun (which sets a one-shot temp bp); must be halted to arm it.
        async runTo(target, opts = {}) {
            await self.ensureStopped();
            const arg = (typeof target === 'number') ? { addr: target & 0xffff } : { symbol: String(target) };
            arg.warp = opts.warp === true;   // normal speed by default
            const stopP = self.waitStopped(opts.timeoutMs || 60000);
            stopP.catch(() => {});           // avoid an unhandled rejection if turboRun throws below
            try { await session.customRequest('turboRun', arg); }
            catch (e) { throw new Error('runTo(' + target + '): ' + (e && e.message ? e.message : e)); }
            await stopP;
        },
        // Reliable warp for scripts: an idempotent SET, AWAITED and confirmed — not the
        // fire-and-forget toggle (which returned before applying and raced on stale state,
        // so a warp(false) could be dropped and bleed warp into the next section). Halt first
        // so the stub actually applies it (a 'c' in flight would queue it), then reflect the
        // confirmed state in the tracker + Screen View OSD.
        async warp(on) {
            on = !!on;
            if (vizConnected) {
                // Always-live uplink: applies IMMEDIATELY even while the CPU runs — no halt,
                // no queuing behind a 'c'. This is the reliable path (viz is connected for the run).
                vizSendInput(vizProto.warpFrame(on));
                oricWarpOn = on;
            } else {
                // No viz stream — fall back to the halted-only GDB-stub set.
                await self.ensureStopped();
                const r = await session.customRequest('setWarp', { on }).catch(() => null);
                if (r) oricWarpOn = !!r.warp;
            }
            vscode.commands.executeCommand('setContext', 'oric-debug.warp', oricWarpOn);
            postScreenRunState();
            if (debugControlsProvider) debugControlsProvider.pushState();   // reflect on the Warp button
        },
        waitSignal(id, ms) { return waitSessionEvent('signal', ms || 60000, e => !id || e.id === id); },
        // Resolve a real name (_gCurrentLocation / e_LOC_LARGE_STAIRCASE) to { addr, value, ... }
        // so scripts never hardcode addresses/enum values. Pure symbol-table lookup (no stub).
        async resolve(name) { try { const r = await session.customRequest('oricResolve', { name: String(name) }); return r && r.found ? r : null; } catch (_) { return null; } },
    };
    return self;
}

// Start an oric-debug session from cold (the F5 equivalent) and wait until the adapter is
// LIVE — so a script can run with nothing already open, and the MCP has one tested path to a
// fully-hooked session (right emulator args, symbols, viz). Resolves to the session, or null
// (with a reported reason). Picks the oric-debug config from launch.json (quick-picks if >1).
async function startOricDebugSession(log, preferConfigName) {
    log = log || (() => {});
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) { vscode.window.showErrorMessage('Oric: open the project folder first (need its launch.json).'); return null; }
    const candidates = [];
    for (const f of folders) {
        const cfgs = vscode.workspace.getConfiguration('launch', f.uri).get('configurations') || [];
        for (const c of cfgs) if (c && c.type === 'oric-debug') candidates.push({ folder: f, config: c });
    }
    if (!candidates.length) { vscode.window.showErrorMessage('Oric: no "oric-debug" configuration found in launch.json.'); return null; }
    // Pick a config WITHOUT prompting when we can: the script's declared config, else the only one,
    // else the last one used (remembered) — only prompt when genuinely ambiguous, and remember it.
    let chosen = null;
    if (preferConfigName) chosen = candidates.find(c => (c.config.name || '') === preferConfigName) || null;
    if (!chosen && candidates.length === 1) chosen = candidates[0];
    if (!chosen && automationConfigMemento) {
        const last = automationConfigMemento.get(AUTO_CFG_KEY);
        if (last) chosen = candidates.find(c => (c.config.name || '') === last) || null;
    }
    if (!chosen) {
        const pick = await vscode.window.showQuickPick(
            candidates.map((c, i) => ({ label: c.config.name || ('configuration ' + i), description: c.folder.name, i })),
            { placeHolder: 'Which Oric debug configuration should the script launch? (remembered for next time)' });
        if (!pick) return null;
        chosen = candidates[pick.i];
    }
    if (automationConfigMemento && chosen && chosen.config.name) automationConfigMemento.update(AUTO_CFG_KEY, chosen.config.name).then(() => {}, () => {});
    // Capture the session the moment it starts (startDebugging only returns a bool).
    const startedP = new Promise(resolve => {
        const sub = vscode.debug.onDidStartDebugSession(s => { if (s && s.type === 'oric-debug') { sub.dispose(); resolve(s); } });
        setTimeout(() => { sub.dispose(); resolve(null); }, 30000);
    });
    log('Launching "' + (chosen.config.name || 'oric-debug') + '"…');
    const ok = await vscode.debug.startDebugging(chosen.folder, chosen.config.name || chosen.config);
    if (!ok) { vscode.window.showErrorMessage('Oric: failed to start the debug session.'); return null; }
    const session = await startedP;
    if (!session) { vscode.window.showErrorMessage('Oric: the debug session did not start in time.'); return null; }
    // Wait until the adapter answers a lightweight request (connected + symbols loaded). The
    // script's own waits (ensureGame / waitFor) then cover any tape/disk load time.
    for (let i = 0; i < 60; i++) {
        try { if (await session.customRequest('getModules')) { log('Session live.'); return session; } } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
    }
    log('Session started but the adapter did not become ready in time — running anyway.');
    return session;
}

// The automation OWNS its viz connection so it never depends on the Oric Screen View being
// open — the frame counter (runFrames/waitModule*) and screenshots come from the viz stream.
// A no-op consumer keeps the socket alive; vizRegisterConsumer auto-connects when a session
// is active, and unregistering leaves it connected if a panel is still using it.
const automationVizConsumer = { postFrame() {}, postStatus() {}, postError() {} };
function waitVizConnected(ms) {
    return new Promise(resolve => {
        if (vizConnected) return resolve(true);
        const t0 = Date.now();
        const iv = setInterval(() => {
            if (vizConnected) { clearInterval(iv); resolve(true); }
            else if (Date.now() - t0 > (ms || 8000)) { clearInterval(iv); resolve(false); }
        }, 100);
    });
}

async function runAutomationScript(scriptPath) {
    if (automationRunning) { vscode.window.showWarningMessage('An Oric automation script is already running — Stop it first.'); return; }
    const scriptName = nodePath.basename(scriptPath);
    // Load the script FIRST — its optional metadata decides how we get a session (so ▶ Run doesn't
    // prompt for a launch config it doesn't need). Fresh each run: bust the require cache for the
    // script AND every sibling module in its folder (helpers in automation/lib/), so editing a
    // helper reloads without a window reload.
    let mod;
    try {
        const dir = canonPath(nodePath.dirname(scriptPath)) + nodePath.sep;
        for (const k of Object.keys(require.cache)) { if (canonPath(k).startsWith(dir)) delete require.cache[k]; }
        mod = require(scriptPath);
    }
    catch (e) { vscode.window.showErrorMessage('Automation script load error: ' + (e && e.message ? e.message : e)); return; }
    // A script exports EITHER a function directly, OR an object `{ run, session, config }` — the
    // object form lets the metadata sit at the TOP of the file (a bare `module.exports = fn`
    // assignment can't, since it would overwrite any properties set before it).
    const scriptFn = (typeof mod === 'function') ? mod
        : (mod && typeof mod.default === 'function') ? mod.default
        : (mod && typeof mod.run === 'function') ? mod.run : null;
    if (typeof scriptFn !== 'function') { vscode.window.showErrorMessage('An automation script must export a function:  module.exports = async (t) => { … }   — or an object  module.exports = { run: async (t) => { … }, session, config }.'); return; }
    // Optional metadata, read from the object OR the function:
    //   session = 'existing' → run in the CURRENT debug session (a utility — never launches);
    //           | 'fresh'    → needs a freshly-launched emulator (confirms a restart if one runs);
    //           | 'any'      → (default) reuse the running session, else launch one.
    //   config  = name of the launch.json oric-debug config to launch (skips the picker).
    const need = (mod && mod.session) || scriptFn.session || 'any';
    const wantConfig = (mod && mod.config) || scriptFn.config || null;
    const chan = automationChannel(); chan.clear(); chan.show(true);
    let session = vscode.debug.activeDebugSession;
    const haveSession = !!(session && session.type === 'oric-debug');
    if (need === 'existing') {
        if (!haveSession) { vscode.window.showWarningMessage('Automation "' + scriptName + '" runs in the CURRENT debug session, but none is active — start one (F5) first. (Set  module.exports.session = "any"  to auto-launch.)'); return; }
        chan.appendLine('Using the active debug session (' + session.name + ').');
    } else if (need === 'fresh') {
        if (haveSession) {
            const go = await vscode.window.showWarningMessage('Automation "' + scriptName + '" needs a freshly-launched emulator. Restart the current debug session?', { modal: true }, 'Restart');
            if (go !== 'Restart') return;
            chan.appendLine('Restarting the debug session for a fresh run…');
            try { await vscode.debug.stopDebugging(session); } catch (_) {}
            await new Promise(r => setTimeout(r, 800));
        } else {
            chan.appendLine('Launching a fresh debug session…');
        }
        session = await startOricDebugSession(m => chan.appendLine(m), wantConfig);
        if (!session) return;
    } else {   // 'any' (default)
        if (haveSession) chan.appendLine('Using the active debug session (' + session.name + ').');
        else { chan.appendLine('No debug session — launching one…'); session = await startOricDebugSession(m => chan.appendLine(m), wantConfig); if (!session) return; }
    }
    // Lazy: the shared step-core (+ its client deps) load only when a script is actually run,
    // so any issue there can never break the extension's activation.
    let makeApi;
    try { ({ makeApi } = require('./mcp/playthrough-core.cjs')); }
    catch (e) { vscode.window.showErrorMessage('Automation core failed to load: ' + (e && e.message ? e.message : e)); return; }
    // Own the viz stream for the run (frame timing + screenshots) — independent of any panel.
    vizRegisterConsumer(automationVizConsumer);
    if (!vizConnected) {
        chan.appendLine('Connecting viz stream (screen + frame timing)…');
        if (!(await waitVizConnected(8000)))
            chan.appendLine('⚠ viz stream not connected — frame timing/screenshots may not work (is the emulator up?).');
    }
    const outDir = nodePath.join(nodePath.dirname(scriptPath), 'out');
    const t = makeApi(inSessionOps(session), { log: m => chan.appendLine(m), outDir });
    automationRunning = t;
    automationRunningPath = scriptPath;
    vscode.commands.executeCommand('setContext', 'oric-debug.automationRunning', true);
    if (refreshAutomationView) refreshAutomationView();   // mark the running script in the panel
    postScreenRunState();   // show the "SCRIPT" badge on the Screen View OSD right away
    chan.appendLine('▶ ' + nodePath.basename(scriptPath) + '   (session: ' + session.name + ')');
    const t0 = Date.now();
    try { await scriptFn(t); }
    catch (e) { t.assert('script completed', false, e && e.message ? e.message : String(e)); }
    const sum = t.summary();
    chan.appendLine('──────────────────────────────');
    chan.appendLine((sum.allPassed ? '✓ ' : '✗ ') + sum.pass + '/' + sum.total + ' checks passed   (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
    // Clean up ONLY if we're still the current run — a force-Stop / session-end (stopAutomation)
    // may already have torn this down, or a new run may have started; don't clobber either.
    if (automationRunning === t) {
        vizUnregisterConsumer(automationVizConsumer);   // leaves it up if a panel still uses it
        automationRunning = null;
        automationRunningPath = null;
        oricUserPaused = false;
        if (automationUiTimer) { clearTimeout(automationUiTimer); automationUiTimer = null; }
        vscode.commands.executeCommand('setContext', 'oric-debug.automationRunning', false);
        if (refreshAutomationView) refreshAutomationView();
        // Repaint once now that the rapid-cycling suppression is off (buttons/dim/panels live again).
        applyDebugStateVisuals();
        if (refreshAllViews) refreshAllViews();
    }
    vscode.window.showInformationMessage('Oric automation: ' + sum.pass + '/' + sum.total + (sum.allPassed ? ' passed ✓' : ' — some FAILED ✗') + ' (see "Oric Automation" output)');
}

// Stop a running automation script and FORCE the state clean, so it can never wedge: cancel
// it cooperatively (its next checkpoint throws), AND clear the running flag / context key /
// UI-debounce / viz consumer right now — so "Stop", and ending the debug session, always
// recover even if the script was stuck in a wait against a dead session. Returns true if one
// was running.
function stopAutomation(reason) {
    if (!automationRunning) return false;
    try { automationRunning._cancel(); } catch (_) {}
    automationRunning = null;
    automationRunningPath = null;
    oricUserPaused = false;
    if (automationUiTimer) { clearTimeout(automationUiTimer); automationUiTimer = null; }
    try { vizUnregisterConsumer(automationVizConsumer); } catch (_) {}
    vscode.commands.executeCommand('setContext', 'oric-debug.automationRunning', false);
    if (refreshAutomationView) refreshAutomationView();
    if (automationChan) automationChan.appendLine('■ automation ' + (reason || 'stopped'));
    return true;
}

// Array-valued context key for the line-number gutter menu: the PC line when
// the ACTIVE editor shows the stopped file, else empty. when-clauses cannot
// compare two context keys, but `editorLineNumber in oric-debug.pcEditorLines`
// tests membership in this extension-managed array — that's how the gutter
// menu offers ONLY "skip" on the PC line and only run/turbo/jump elsewhere.
function updatePcLineContext() {
    const ed = vscode.window.activeTextEditor;
    const match = currentStopLoc && ed && ed.document.uri.scheme === 'file'
        && canonPath(ed.document.uri.fsPath) === canonPath(currentStopLoc.path);
    vscode.commands.executeCommand('setContext', 'oric-debug.pcEditorLines', match ? [currentStopLoc.line] : []);
}
function pushDebugStateToDisasm() {
    for (const p of disasmPanels) p.webview.postMessage({ type: 'debugState', stopped: oricDebugStopped });
}

// Custom debug-control toolbar as a webview VIEW in the Run & Debug sidebar (always
// present, next to Registers/Variables/Call Stack). Unlike a toolbar inside the
// disassembly panel, focusing this doesn't flip VS Code into instruction stepping,
// so its buttons drive C-statement stepping AND assembler stepping. Buttons carry
// PRINTED labels (no tooltip reliance) and fire either VS Code's built-in debug
// commands or our own (replay navigation, warp), which dispatch to our adapter.
// Hovering a button shows its purpose + shortcut in the status bar (showHoverHelp).
function debugControlsHtml() {
    return `<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); padding: 6px; }
.grp { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.grp:last-child { margin-bottom: 0; }
.dbg-btn {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-widget-border, #555);
    border-radius: 4px; padding: 5px 9px; cursor: pointer;
    font-family: inherit; font-size: inherit; white-space: nowrap; flex: 0 0 auto;
}
.dbg-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.dbg-btn:disabled { opacity: 0.35; cursor: default; }
.dbg-btn .ic { font-size: 1.1em; line-height: 1; }
.dbg-btn.go .ic   { color: var(--vscode-debugIcon-continueForeground, #89d185); }
.dbg-btn.stop .ic { color: var(--vscode-debugIcon-stopForeground, #f48771); }
.dbg-btn.rev .ic  { color: var(--vscode-debugIcon-stepBackForeground, #75beff); }
/* Warp toggle: muted while off, filled + green icon while on (matches the ▶▶ turbo OSD). */
.dbg-btn.warp .ic { color: #7ee787; }
.dbg-btn.warp.warpon {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0e639c);
}
</style></head><body>
<div class="grp">
    <button class="dbg-btn go" id="playpause" data-act="playpause"><span class="ic" id="ppIcon">&#9654;</span><span id="ppLbl">Continue</span></button>
    <button class="dbg-btn stop" data-act="stop"><span class="ic">&#9632;</span>Stop</button>
    <button class="dbg-btn" data-act="restart"><span class="ic">&#8635;</span>Restart</button>
    <button class="dbg-btn warp" id="warpBtn" data-act="warp"><span class="ic">&#187;&#187;</span><span id="warpLbl">Warp: Off</span></button>
</div>
<div class="grp">
    <button class="dbg-btn" data-act="stepOver"><span class="ic">&#8631;</span>Step Over</button>
    <button class="dbg-btn" data-act="stepInto"><span class="ic">&#8628;</span>Step Into</button>
    <button class="dbg-btn" data-act="stepOut"><span class="ic">&#8630;</span>Step Out</button>
</div>
<div class="grp">
    <button class="dbg-btn rev" data-act="replayRewind"><span class="ic">&#9194;</span>Rewind</button>
    <button class="dbg-btn rev" data-act="replayForward"><span class="ic">&#9193;</span>Forward</button>
    <button class="dbg-btn rev" data-act="replayToHead"><span class="ic">&#9197;</span>To Head</button>
</div>
<script>
const vscode = acquireVsCodeApi();
let stopped = true, active = false, canRewind = false, canForward = false, warp = false;
document.body.addEventListener('click', e => {
    const b = e.target.closest('button.dbg-btn');
    if (!b || b.disabled) return;
    // The play/pause button resolves to continue (when halted) or pause (when running).
    let act = b.dataset.act;
    if (act === 'playpause') act = stopped ? 'continue' : 'pause';
    vscode.postMessage({ type: 'debugAction', action: act });
});
// Hover help: show each button's purpose + shortcut in the status bar (a visible
// alternative to tooltips, which a large cursor tends to cover).
const HELP = {
    playpause: 'Continue (F5) / Pause (F6) execution',
    stop: 'Stop the debug session  (Shift+F5)',
    restart: 'Restart the debug session  (Ctrl+Shift+F5)',
    stepOver: 'Step Over — execute one statement  (F10)',
    stepInto: 'Step Into — enter the call  (F11)',
    stepOut: 'Step Out — run to the caller  (Shift+F11)',
    replayRewind: 'Replay Rewind — load the previous snapshot (non-destructive)  (Shift+F10)',
    replayForward: 'Replay Forward — load the next snapshot, undoing a rewind  (Shift+F12)',
    replayToHead: 'Replay to Head — jump to the most recent snapshot (recover from over-rewinding)',
    warp: 'Warp — toggle fast-forward (run the emulator at maximum speed)  (Ctrl+Shift+F6)'
};
document.querySelectorAll('button.dbg-btn').forEach(b => {
    const help = HELP[b.dataset.act];
    if (!help) return;
    b.addEventListener('mouseenter', () => vscode.postMessage({ type: 'hover', text: help }));
    b.addEventListener('mouseleave', () => vscode.postMessage({ type: 'hoverEnd' }));
});
function apply() {
    const set = (act, on) => { const b = document.querySelector('[data-act="' + act + '"]'); if (b) b.disabled = !on; };
    // Forward stepping only makes sense while halted.
    ['stepOver','stepInto','stepOut'].forEach(a => set(a, active && stopped));
    // Replay: rewind when there's older history; forward/to-head when a rewind can be undone.
    set('replayRewind',  active && stopped && canRewind);
    set('replayForward', active && stopped && canForward);
    set('replayToHead',  active && stopped && canForward);
    // One button: Continue (green ▶) when halted, Pause (‖) when running; live whenever a session is.
    const pp = document.getElementById('playpause');
    if (pp) {
        pp.disabled = !active;
        if (stopped) { pp.classList.add('go'); document.getElementById('ppIcon').innerHTML = '&#9654;'; document.getElementById('ppLbl').textContent = 'Continue'; }
        else { pp.classList.remove('go'); document.getElementById('ppIcon').innerHTML = '&#9208;'; document.getElementById('ppLbl').textContent = 'Pause'; }
    }
    set('restart', active);
    set('stop', active);
    // Warp works whenever a session is live (running or halted); reflect the current state.
    set('warp', active);
    const wb = document.getElementById('warpBtn');
    if (wb) {
        wb.classList.toggle('warpon', warp);
        document.getElementById('warpLbl').textContent = warp ? 'Warp: On' : 'Warp: Off';
    }
}
window.addEventListener('message', e => { if (e.data && e.data.type === 'state') { active = !!e.data.active; stopped = !!e.data.stopped; canRewind = !!e.data.canRewind; canForward = !!e.data.canForward; warp = !!e.data.warp; apply(); } });
apply();
</script>
</body></html>`;
}

// Show (or clear, with null) a one-line help string in the hover-help status bar.
// Driven by the Debug Controls webview's button mouse-over so the description +
// shortcut are visible without relying on a tooltip.
function showHoverHelp(text) {
    if (!hoverHelpStatusBar) return;
    if (text) { hoverHelpStatusBar.text = text; hoverHelpStatusBar.show(); }
    else hoverHelpStatusBar.hide();
}

class DebugControlsWebviewProvider {
    constructor() { this._view = null; }
    resolveWebviewView(view) {
        this._view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = debugControlsHtml();
        view.webview.onDidReceiveMessage(msg => {
            if (!msg) return;
            if (msg.type === 'hover') { showHoverHelp(msg.text); return; }
            if (msg.type === 'hoverEnd') { showHoverHelp(null); return; }
            if (msg.type !== 'debugAction') return;
            const CMD = {
                continue: 'workbench.action.debug.continue',
                stepOver: 'workbench.action.debug.stepOver',
                stepInto: 'workbench.action.debug.stepInto',
                stepOut: 'workbench.action.debug.stepOut',
                replayRewind: 'oric-debug.replayRewind',
                replayForward: 'oric-debug.replayForward',
                replayToHead: 'oric-debug.replayToHead',
                warp: 'oric-debug.toggleWarp',
                pause: 'workbench.action.debug.pause',
                restart: 'workbench.action.debug.restart',
                stop: 'workbench.action.debug.stop'
            };
            const cmd = CMD[msg.action];
            if (cmd) vscode.commands.executeCommand(cmd);
        });
        this.pushState();
    }
    pushState() {
        if (!this._view) return;
        // Use the tracked flag, not activeDebugSession — the latter can still be set
        // during onDidTerminateDebugSession, leaving Stop looking enabled after the end.
        this._view.webview.postMessage({ type: 'state', active: oricSessionActive, stopped: oricDebugStopped, canRewind: replayCanRewind, canForward: replayCanForward, warp: oricWarpOn });
    }
}
function setInstrStepMode(on) {
    on = !!on;
    if (on === instrStepMode) return;
    instrStepMode = on;
    vscode.commands.executeCommand('setContext', 'oricInstructionStepMode', on);
    if (stepModeStatusBar) {
        stepModeStatusBar.text = on ? '$(debug-step-into) Step: Instruction' : '$(debug-step-over) Step: Statement';
    }
}

// Move the caret to a 1-based line of ctx.uri — ctx is the {uri, lineNumber}
// shape both the line-number gutter menu and the cursor-line CodeLens pass.
// The built-in run-to-cursor / jump-to-cursor commands only know the active
// cursor, so line-targeted actions position it first. Returns false when
// invoked without a usable target (e.g. from the command palette).
async function cursorToLine(ctx) {
    if (!ctx || !ctx.uri || typeof ctx.lineNumber !== 'number') return false;
    const editor = await vscode.window.showTextDocument(ctx.uri, { preserveFocus: false });
    const pos = new vscode.Position(ctx.lineNumber - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    return true;
}

// The one turboRun request path — cursor-, line- and address-targeted commands
// all call this so target resolution and error reporting can't drift apart.
// args.warp === false = run to the target at normal speed (same adapter path,
// no warp). `what` names the operation in error toasts.
async function requestTurboRun(args, what = 'Turbo Run') {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'oric-debug') return;
    try {
        await session.customRequest('turboRun', args);
    } catch (e) {
        vscode.window.showErrorMessage(what + ' failed: ' + (e && e.message ? e.message : e));
    }
}

// The one goto core (source jump/skip AND disassembly jump): ask the adapter
// for a goto target, validate it, move the PC. Straight DAP instead of the
// built-in debug.jumpToCursor, which proved unreliable invoked
// programmatically; the adapter's 'stopped' event makes VS Code reveal the new
// PC. `validate` returns a warning string to refuse the target, or null.
async function gotoViaTargets(targetsArgs, validate) {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'oric-debug') return;
    try {
        const res = await session.customRequest('gotoTargets', targetsArgs);
        const target = res && res.targets && res.targets[0];
        const warning = validate(target);
        if (warning) { vscode.window.showWarningMessage(warning); return; }
        await session.customRequest('goto', { threadId: 1, targetId: target.id });
    } catch (e) {
        vscode.window.showErrorMessage('Jump failed: ' + (e && e.message ? e.message : e));
    }
}

// Jump/skip on a source line. `afterLine` (skip): the target must lie strictly
// beyond that line — at end of file the snap falls backward, and skipping must
// refuse a backward jump rather than re-run earlier code.
async function gotoSourceLine(uri, line, afterLine) {
    await gotoViaTargets({ source: { path: uri.fsPath }, line }, target => {
        if (!target) return afterLine ? 'No executable line after line ' + afterLine : 'No code found for line ' + line;
        if (afterLine && target.line > 0 && target.line <= afterLine) return 'No executable line after line ' + afterLine;
        return null;
    });
}

// Jump to a raw address (disassembly panel) — the adapter's gotoTargets treats
// a "0xABCD" source path as the address itself.
async function gotoAddress(addr) {
    const hex = '0x' + (addr & 0xFFFF).toString(16).padStart(4, '0');
    await gotoViaTargets({ source: { path: hex }, line: 0 }, target => target ? null : 'No goto target at ' + hex);
}

// True when file:line snaps to executable CODE (adapter lineInfo request).
// Movement actions on a data line are traps — a run-to breakpoint on a .dsb
// never hits and a jump moves the PC into storage — so warn instead.
async function lineExecutable(uri, lineNumber) {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'oric-debug') return false;
    try {
        const r = await session.customRequest('lineInfo', { file: uri.fsPath, line: lineNumber });
        if (r && r.addr >= 0 && r.executable) return true;
        vscode.window.showWarningMessage('Line ' + lineNumber + ' is ' + (r && r.addr >= 0 ? 'data, not executable code' : 'not mapped to any code'));
        return false;
    } catch (e) { return true; } // request unavailable: don't block
}

// ----------------------------------------------------------------
// Oric Symbols Panel (searchable/sortable symbol browser)
// ----------------------------------------------------------------

let symbolsPanel = null;

// --- Watched expressions (shown inside the Symbol Browser panel) ---
// The in-memory list is the source of truth; workspaceState is a mirror.
// Memento.update() is ASYNC — reading it back right after an add races
// and can return the old list.
let watchedExprs = [];
let watchMemento = null; // set in activate()
let watchExpanded = new Set(); // expanded node paths, e.g. '_gSaveGameFile/items'
let lastWatchGood = null;      // last live {active, inactive} — shown grayed after the session ends
let symbolMru = [];            // search-box history, persisted per workspace
function saveWatchedExprs() {
    if (watchMemento) watchMemento.update('oric-debug.watchExpressions', watchedExprs);
}
function removeWatchedExpr(expr) {
    watchedExprs = watchedExprs.filter(e => e !== expr);
    for (const p of watchExpanded)
        if (p === expr || p.startsWith(expr + '/')) watchExpanded.delete(p);
}

// One watch tree node. Expansion is resolved HERE, not in the webview: the
// adapter's variablesReference is only valid until the next resume, so the
// webview never stores one — it just reports expand/collapse by path and
// receives the fully-resolved tree each refresh.
// Source {file,line} for a top-level watched symbol (from the shared symbol cache),
// so a pinned row can be clicked to jump to its definition — like the search results.
// Only plain symbols resolve; computed expressions (a[i].f) have no single source.
function watchNodeSource(expr) {
    const c = symbolCache.get(expr);
    return (c && c.source && c.source.file) ? { file: c.source.file, line: c.source.line } : undefined;
}
async function buildWatchNode(session, path, label, value, vref, error, depth) {
    const node = { path, label, value, error: !!error, canExpand: !!vref, expanded: false, children: null };
    if (depth === 0) { const src = watchNodeSource(label); if (src) node.source = src; }
    if (vref && watchExpanded.has(path) && depth < 8) {
        node.expanded = true;
        try {
            const resp = await session.customRequest('variables', { variablesReference: vref });
            const vars = (resp && resp.variables) || [];
            node.children = [];
            for (const v of vars)
                node.children.push(await buildWatchNode(session, path + '/' + v.name, v.name, v.value, v.variablesReference, false, depth + 1));
        } catch (e) {
            node.children = [];
        }
    }
    return node;
}

// Evaluate every watched expression through the adapter's ONE evaluate path
// (symbols, casts, registers, tags — everything the built-in Watch can do)
// and post the results to the Symbol Browser. Entries whose symbol lives in
// an INACTIVE module fold into a collapsed group instead of burning a row
// each on errors; they migrate back automatically on module switch.
async function refreshWatchValues(session) {
    if (!symbolsPanel) return;
    const exprs = watchedExprs.slice();
    if (!session || session.type !== 'oric-debug') {
        postStaleWatch(exprs);
        return;
    }
    const active = [], inactive = [];
    for (const e of exprs) {
        try {
            const r = await session.customRequest('evaluate', { expression: e, context: 'watch' });
            if (r && r.inactive) inactive.push({ path: e, label: e, owners: r.owners || '', source: watchNodeSource(e) });
            else active.push(await buildWatchNode(session, e, e, (r && r.result) || '', r && r.variablesReference, false, 0));
        } catch (err) {
            const m = err && err.message ? err.message : 'error';
            // Session died mid-refresh ("no debugger available, can not send
            // 'evaluate'") — fall back to the last live values instead of
            // painting every row with the same error.
            if (/no debugger available/i.test(m)) { postStaleWatch(exprs); return; }
            active.push(await buildWatchNode(session, e, e, '⚠ ' + m, 0, true, 0));
        }
    }
    lastWatchGood = { active, inactive };
    symbolsPanel.webview.postMessage({ type: 'watch', active, inactive });
}

// No live session: repost the last live values, grayed out in the UI —
// practical while editing code against the program's final state. Entries
// removed since then are filtered; entries added since show empty.
function postStaleWatch(exprs) {
    if (!lastWatchGood) {
        symbolsPanel.webview.postMessage({ type: 'watch', noSession: true,
            active: exprs.map(e => ({ path: e, label: e, value: '', source: watchNodeSource(e) })), inactive: [] });
        return;
    }
    const keep = new Set(exprs);
    const active = lastWatchGood.active.filter(n => keep.has(n.path));
    const inactive = lastWatchGood.inactive.filter(n => keep.has(n.path));
    const have = new Set([...active.map(n => n.path), ...inactive.map(n => n.path)]);
    for (const e of exprs)
        if (!have.has(e)) active.push({ path: e, label: e, value: '', source: watchNodeSource(e) });
    symbolsPanel.webview.postMessage({ type: 'watch', stale: true, active, inactive });
}

// Symbol cache: populated from readAllSymbols responses, used by hover provider
const symbolCache = new Map(); // name -> { addr, size, value, group, source }

// Define cache: populated by scanning workspace source files for #define directives
const defineCache = new Map(); // name -> { value (string), numValue (number|null), file, line }

async function scanDefines() {
    defineCache.clear();
    const files = await vscode.workspace.findFiles('**/*.{s,h,asm}', '**/node_modules/**', 500);
    const fs = require('fs');
    for (const uri of files) {
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^\s*#\s*define\s+([A-Za-z_]\w*)\s+(.+?)\s*$/);
                if (!m) continue;
                const name = m[1];
                let rawValue = m[2];
                // Skip macro-style defines with parentheses (parameterized macros)
                if (name.includes('(') || rawValue.startsWith('\\')) continue;
                // Strip trailing comments (// or ;) and capture as tooltip
                let comment = null;
                const cmtMatch = rawValue.match(/^(.*?)\s+(?:\/\/|;)\s*(.*)$/);
                if (cmtMatch) {
                    rawValue = cmtMatch[1].trimEnd();
                    comment = cmtMatch[2].trim() || null;
                }
                // Try to resolve numeric value
                let numValue = null;
                const hexM = rawValue.match(/^\$([0-9a-fA-F]{1,4})$/);
                const decM = rawValue.match(/^(\d+)$/);
                const binM = rawValue.match(/^%([01]+)$/);
                if (hexM) numValue = parseInt(hexM[1], 16);
                else if (decM) numValue = parseInt(decM[1], 10);
                else if (binM) numValue = parseInt(binM[1], 2);
                // Don't overwrite — first definition wins (matches preprocessor behavior)
                if (!defineCache.has(name)) {
                    defineCache.set(name, { value: rawValue, numValue, comment, file: uri.fsPath, line: i + 1 });
                }
            }
        } catch (_) { /* skip unreadable files */ }
    }
}

function createSymbolsPanel(context) {
    if (symbolsPanel) {
        symbolsPanel.reveal();
        return;
    }
    symbolsPanel = vscode.window.createWebviewPanel(
        'oricSymbols', 'Oric Symbols',
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    symbolsPanel.webview.html = symbolsPanelHtml();
    setupSymbolsPanel(symbolsPanel);

    // Initial data fetch
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'oric-debug') {
        session.customRequest('readAllSymbols').then(resp => {
            if (symbolsPanel && resp && resp.symbols) {
                const combined = [...resp.symbols, ...buildDefineEntries()];
                symbolsPanel.webview.postMessage({ type: 'symbols', data: combined });
            }
        }).catch(() => {});
    } else {
        // No debug session — still show defines
        const defines = buildDefineEntries();
        if (defines.length > 0 && symbolsPanel) {
            symbolsPanel.webview.postMessage({ type: 'symbols', data: defines });
        }
    }
    refreshWatchValues(session && session.type === 'oric-debug' ? session : null);
}

// Shared wiring for the symbols panel — fresh create AND serializer restore
// (one setup path, the two used to drift): dispose tracking, webview messages,
// and refresh-on-reveal. Data changed while the panel was hidden reaches only
// the symbolCache; a panel becoming visible must refetch or it shows stale rows.
function setupSymbolsPanel(panel) {
    panel.iconPath = panelIcon('panel-symbols-v2');   // tab glyph (search)
    panel.onDidDispose(() => { symbolsPanel = null; });
    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.visible) {
            refreshSymbolsPanel(vscode.debug.activeDebugSession);
            refreshWatchValues(vscode.debug.activeDebugSession);
        }
    });
    panel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'symbolHover' && typeof msg.addr === 'number') {
            highlightHeatmapAddr(msg.addr);
        } else if (msg.type === 'symbolLeave') {
            restoreHeatmapPcHighlight();
        } else if (msg.type === 'watchToggle' && msg.expr) {
            const expr = String(msg.expr).trim();
            if (watchedExprs.includes(expr)) removeWatchedExpr(expr);
            else watchedExprs.push(expr);
            saveWatchedExprs();
            refreshWatchValues(vscode.debug.activeDebugSession);
        } else if (msg.type === 'watchRemove' && msg.expr) {
            removeWatchedExpr(msg.expr);
            saveWatchedExprs();
            refreshWatchValues(vscode.debug.activeDebugSession);
        } else if (msg.type === 'symBp' && typeof msg.addr === 'number') {
            if (handleSymBpAction) handleSymBpAction(msg);   // set/remove exec bp or watchpoint (activate closure)
        } else if (msg.type === 'mruGet') {
            panel.webview.postMessage({ type: 'mru', items: symbolMru });
        } else if (msg.type === 'mruUpdate' && Array.isArray(msg.items)) {
            symbolMru = msg.items.slice(0, 10);
            if (watchMemento) watchMemento.update('oric-debug.symbolSearchMru', symbolMru);
        } else if (msg.type === 'watchExpand' && msg.path) {
            watchExpanded.add(msg.path);
            refreshWatchValues(vscode.debug.activeDebugSession);
        } else if (msg.type === 'watchCollapse' && msg.path) {
            watchExpanded.delete(msg.path);
            refreshWatchValues(vscode.debug.activeDebugSession);
        } else if (msg.type === 'gotoSymbol' && msg.file && msg.line > 0) {
            const uri = vscode.Uri.file(msg.file);
            vscode.workspace.openTextDocument(uri).then(doc => {
                vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One }).then(editor => {
                    const line = msg.line - 1;
                    const range = new vscode.Range(line, 0, line, 0);
                    editor.selection = new vscode.Selection(range.start, range.start);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                });
            }).catch(() => {});
        } else if (msg.type === 'hover') {
            showHoverHelp(msg.text);
        } else if (msg.type === 'hoverEnd') {
            showHoverHelp(null);
        }
    });
}

function buildDefineEntries() {
    const entries = [];
    for (const [name, def] of defineCache) {
        // Skip defines that shadow a runtime symbol (symbol takes priority)
        if (symbolCache.has(name)) continue;
        entries.push({
            name, aliases: [], addr: -1,
            size: 0, value: [], group: 'define',
            source: { file: def.file, line: def.line },
            nameSources: { [name]: { file: def.file, line: def.line } },
            defineValue: def.value,
            defineComment: def.comment || null
        });
    }
    return entries;
}

function refreshSymbolsPanel(session) {
    if (!session || session.type !== 'oric-debug') {
        if (symbolsPanel) {
            // Even without a debug session, show defines if available
            const defines = buildDefineEntries();
            symbolsPanel.webview.postMessage({ type: 'symbols', data: defines.length > 0 ? defines : null });
        }
        symbolCache.clear();
        return;
    }
    // Only fetch symbol values from memory when the symbols panel is visible
    // or when the cache hasn't been populated yet (needed for hover provider).
    // This avoids dozens of GDB memory reads on every single step.
    const panelVisible = symbolsPanel && symbolsPanel.visible;
    if (!panelVisible && symbolCache.size > 0) return;
    session.customRequest('readAllSymbols').then(resp => {
        if (resp && resp.symbols) {
            // Update symbol cache (primary name + aliases all point to same entry)
            // Note: we overwrite entries instead of clearing first, so the cache
            // is never empty between reads (which would defeat the guard above).
            const newKeys = new Set();
            for (const s of resp.symbols) {
                const entry = { addr: s.addr, size: s.size, value: s.value, group: s.group,
                                display: s.display,
                                source: s.source, aliases: s.aliases, nameSources: s.nameSources };
                symbolCache.set(s.name, entry);
                newKeys.add(s.name);
                if (s.aliases) {
                    for (const alias of s.aliases) { symbolCache.set(alias, entry); newKeys.add(alias); }
                }
            }
            // Remove stale entries that no longer exist in the symbol table
            for (const key of symbolCache.keys()) {
                if (!newKeys.has(key)) symbolCache.delete(key);
            }
            if (panelVisible) {
                // Merge runtime symbols with defines
                const combined = [...resp.symbols, ...buildDefineEntries()];
                symbolsPanel.webview.postMessage({ type: 'symbols', data: combined });
                if (refreshSymbolBpMarks) refreshSymbolBpMarks();   // light the bp dots
            }
        }
    }).catch(() => {});
}

// ----------------------------------------------------------------
// Oric Memory Map panel — built-in memmap (like osdk_showmap), regenerated from the
// module-composed symbols on every symbol change. Sections Zero/Normal/Overlay as tabs;
// block size = gap to the next symbol; a label starting with '_' or 'osdk' is a section
// marker whose "total" = sum until the next marker (ported from osdk MemMap/memmap.cpp).
// Labels are clickable → jump to source. Incremental search across all sections.
// ----------------------------------------------------------------
let memoryMapPanel = null;
function createMemoryMapPanel() {
    if (memoryMapPanel) { memoryMapPanel.reveal(); return memoryMapPanel; }
    const panel = vscode.window.createWebviewPanel('oricMemoryMap', 'Oric Memory Map',
        vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    wireMemoryMapPanel(panel);
    return panel;
}
// Shared by create + the reload serializer (DRY — see the Screen View lesson).
function wireMemoryMapPanel(panel) {
    memoryMapPanel = panel;
    panel.iconPath = panelIcon('panel-memory-v2');
    panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
    panel.webview.html = memoryMapHtml();
    panel.onDidDispose(() => { memoryMapPanel = null; });
    panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) refreshMemoryMap(vscode.debug.activeDebugSession); });
    panel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'gotoSymbol' && msg.file && msg.line > 0) {
            const uri = vscode.Uri.file(msg.file);
            vscode.workspace.openTextDocument(uri).then(doc => {
                vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One }).then(ed => {
                    const line = Math.max(0, msg.line - 1);
                    const range = new vscode.Range(line, 0, line, 0);
                    ed.selection = new vscode.Selection(range.start, range.start);
                    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                });
            }).catch(() => {});
        }
    });
    refreshMemoryMap(vscode.debug.activeDebugSession);
}
let lastMapSymbols = null;   // last module-composed symbol list — persists after the session ends so the map stays visible
// Feed the map the module-composed symbols (name/addr/source; NO values, NO memory read — so
// it works while the CPU is running, stopped, and after the session via the cached copy).
function refreshMemoryMap(session) {
    if (!memoryMapPanel) return;
    if (session && session.type === 'oric-debug') {
        session.customRequest('symbolTableLite').then(resp => {
            if (!memoryMapPanel) return;
            if (resp && resp.symbols) { lastMapSymbols = resp.symbols; memoryMapPanel.webview.postMessage({ type: 'mapSymbols', symbols: resp.symbols }); }
        }).catch(() => { /* old adapter without the request — keep the last map */ });
    } else {
        // No live session: show the last symbols we saw this run (the map is a static layout).
        memoryMapPanel.webview.postMessage({ type: 'mapSymbols', symbols: lastMapSymbols });
    }
}
function memoryMapHtml() {
    return `<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; overflow: hidden; }
.toolbar { flex: none; display: flex; gap: 8px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, #444); }
.tabs { display: flex; gap: 2px; }
.tab { cursor: pointer; padding: 3px 10px; border: 1px solid transparent; border-radius: 4px; color: var(--vscode-descriptionForeground, #888); background: none; font-family: inherit; font-size: inherit; }
.tab.active { color: var(--vscode-foreground); border-color: var(--vscode-widget-border, #444); background: var(--vscode-list-activeSelectionBackground, #094771); }
.tab .cnt { font-size: 0.85em; opacity: 0.8; }
.search { flex: 1; position: relative; }
.search input { width: 100%; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vscode-input-border, #555); padding: 3px 22px 3px 6px; font-family: inherit; font-size: inherit; }
.search .clear-btn { position: absolute; right: 3px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--vscode-descriptionForeground, #888); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 3px; display: none; }
.search .clear-btn:hover { color: var(--vscode-foreground); }
.search input:not(:placeholder-shown) ~ .clear-btn { display: block; }
.summary { flex: none; padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border, #444); color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; max-height: 22%; overflow-y: auto; }
.summary a { color: var(--vscode-textLink-foreground); cursor: pointer; white-space: nowrap; }
.summary a:hover { text-decoration: underline; }
#wrap { flex: 1 1 auto; overflow: auto; }
table { width: 100%; border-collapse: collapse; }
th { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-widget-border, #444); color: var(--vscode-sideBarSectionHeader-foreground, #ccc); font-weight: bold; }
th.r { text-align: right; }
td { padding: 1px 8px; white-space: nowrap; }
tr:nth-child(even) td { background: rgba(255,255,255,0.03); }
.addr { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.sz { color: var(--vscode-descriptionForeground, #888); text-align: right; }
tr.master td { font-weight: bold; }
tr.master .total { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.name { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
.sym-link { cursor: pointer; }
.sym-link:hover { text-decoration: underline; }
tr.flash td { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,220,0,0.35)) !important; }
.dim { color: var(--vscode-descriptionForeground, #888); padding: 16px 8px; font-style: italic; }
</style></head><body>
<div class="toolbar">
    <div class="tabs" id="tabs"></div>
    <div class="search"><input type="text" id="search" placeholder="Search symbols..." autocomplete="off" autofocus><button class="clear-btn" id="clearBtn" title="Clear (Esc)">×</button></div>
</div>
<div class="summary" id="summary" style="display:none"></div>
<div id="wrap">
    <div class="dim" id="dim">No debug session or no symbols loaded</div>
    <table id="tbl" style="display:none"><thead><tr><th>Address</th><th class="r">Total</th><th class="r">Size</th><th>Name(s)</th></tr></thead><tbody id="tbody"></tbody></table>
</div>
<script>
const vscode = acquireVsCodeApi();
const SEC = [['Normal', 0x400, 0xBFFF], ['Overlay', 0xC000, 0xFFFF], ['Zero', 0x00, 0xFF]];
let syms = null, active = 'Normal', filter = '', flashAddr = null;   // flashAddr = the "Largest"-selected row; re-applied on every render so a focus/refresh rebuild can't drop it
const tabsEl = document.getElementById('tabs'), tbody = document.getElementById('tbody'), tbl = document.getElementById('tbl'), dim = document.getElementById('dim'), searchEl = document.getElementById('search'), summaryEl = document.getElementById('summary');
function h(v, w) { return '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0'); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function isMaster(n) { return !!n && (n[0] === '_' || n.slice(0, 4) === 'osdk'); }
function masterName(b) { const m = b.labels.find(l => isMaster(l.name)); return m ? m.name : b.labels[0].name; }
function computeSection(begin, end) {
    // syms = adapter's merged per-address records {name, aliases, addr, source, nameSources}.
    // One record = one block; expand its labels (name + aliases) with each label's source.
    const blocks = [];
    for (const r of (syms || [])) {
        if (r.addr == null || r.addr < begin || r.addr > end) continue;
        const ns = r.nameSources || {};
        const labels = [{ name: r.name, source: ns[r.name] || r.source }];
        for (const a of (r.aliases || [])) labels.push({ name: a, source: ns[a] || null });
        blocks.push({ addr: r.addr, labels });
    }
    blocks.sort((a, b) => a.addr - b.addr);
    let master = null;
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        b.blockSize = (i + 1 < blocks.length ? blocks[i + 1].addr : end + 1) - b.addr;
        b.isMaster = b.labels.some(l => isMaster(l.name)); b.total = 0;
        if (b.isMaster) master = b;
        if (master) master.total += b.blockSize;
    }
    return blocks;
}
function matchCount(begin, end) {
    if (!filter) return 0;
    const f = filter.toLowerCase(); let n = 0;
    for (const r of (syms || [])) {
        if (r.addr == null || r.addr < begin || r.addr > end) continue;
        if (r.name.toLowerCase().includes(f) || (r.aliases || []).some(a => a.toLowerCase().includes(f))) n++;
    }
    return n;
}
function renderTabs() {
    tabsEl.innerHTML = '';
    for (const [name, begin, end] of SEC) {
        const b = document.createElement('button'); b.className = 'tab' + (name === active ? ' active' : ''); b.textContent = name;
        if (filter) { const c = matchCount(begin, end); if (c) { const s = document.createElement('span'); s.className = 'cnt'; s.textContent = ' (' + c + ')'; b.appendChild(s); } }
        b.onclick = () => { active = name; render(); };
        tabsEl.appendChild(b);
    }
}
function nameHtml(lbl) {
    const src = (lbl.nameSources && lbl.nameSources[lbl.name]) || lbl.source;
    if (src && src.file) return '<span class="name sym-link" data-file="' + esc(src.file) + '" data-line="' + (src.line || 0) + '">' + esc(lbl.name) + '</span>';
    return '<span class="name">' + esc(lbl.name) + '</span>';
}
function render() {
    renderTabs();
    if (!syms) { dim.style.display = 'block'; tbl.style.display = 'none'; summaryEl.style.display = 'none'; dim.textContent = 'No debug session or no symbols loaded'; return; }
    const sec = SEC.find(s => s[0] === active);
    const blocks = computeSection(sec[1], sec[2]);
    const f = filter.toLowerCase();
    // Largest sections summary (master blocks by total) — hidden while filtering.
    const masters = blocks.filter(b => b.isMaster && b.total > 0).sort((a, b) => b.total - a.total).slice(0, 20);
    if (masters.length && !f) { summaryEl.style.display = 'block'; summaryEl.innerHTML = 'Largest: ' + masters.map(m => '<a data-addr="' + m.addr + '">' + esc(masterName(m)) + '</a> (' + m.total + ')').join(' · '); }
    else summaryEl.style.display = 'none';
    let html = '';
    for (const b of blocks) {
        const hit = f && b.labels.some(l => l.name.toLowerCase().includes(f));
        if (f && !hit) continue;
        const bold = (b.addr & 0xFF) === 0;
        const addrCell = '<td class="addr">' + (bold ? '<b>' : '') + h(b.addr, 4) + (bold ? '</b>' : '') + '</td>';
        const sizeCells = (b.isMaster && b.total) ? '<td class="sz total">' + b.total + '</td><td class="sz">' + b.blockSize + '</td>' : '<td class="sz" colspan="2">' + b.blockSize + '</td>';
        html += '<tr class="' + (b.isMaster ? 'master' : '') + '" data-addr="' + b.addr + '">' + addrCell + sizeCells + '<td>' + b.labels.map(nameHtml).join(', ') + '</td></tr>';
    }
    tbody.innerHTML = html || '<tr><td colspan="4" class="dim">No symbols in this section' + (f ? ' matching "' + esc(filter) + '"' : '') + '</td></tr>';
    dim.style.display = 'none'; tbl.style.display = '';
    applyFlash(false);   // re-apply the Largest-selection highlight after the rebuild (no scroll)
}
// Highlight the flashAddr row (clearing any previous), optionally scrolling to it. Called on
// click AND at the end of render(), so a focus/refresh/tab rebuild re-applies it instead of
// dropping it — fixes the "first click's highlight blinks and vanishes" (focus re-render).
function applyFlash(scroll) {
    tbody.querySelectorAll('tr.flash').forEach(r => r.classList.remove('flash'));
    if (flashAddr == null) return;
    const row = tbody.querySelector('tr[data-addr="' + flashAddr + '"]');
    if (row) { row.classList.add('flash'); if (scroll) row.scrollIntoView({ block: 'center' }); }
}
summaryEl.addEventListener('click', e => {
    const a = e.target.closest('a[data-addr]'); if (!a) return;
    flashAddr = a.dataset.addr;
    applyFlash(true);
});
tbody.addEventListener('click', e => { const el = e.target.closest('.sym-link[data-file]'); if (el) vscode.postMessage({ type: 'gotoSymbol', file: el.dataset.file, line: parseInt(el.dataset.line, 10) }); });
searchEl.addEventListener('input', () => {
    filter = searchEl.value.trim();
    // If the active tab has no matches but another does, jump to the first that does (in
    // Normal/Overlay/Zero order). Only when the current tab is empty — so manual tab clicks stick.
    if (filter) {
        const cur = SEC.find(s => s[0] === active);
        if (matchCount(cur[1], cur[2]) === 0) { const hit = SEC.find(s => matchCount(s[1], s[2]) > 0); if (hit) active = hit[0]; }
    }
    render();
});
searchEl.addEventListener('keydown', e => { if (e.key === 'Escape' && searchEl.value) { e.preventDefault(); searchEl.value = ''; filter = ''; render(); } });
document.getElementById('clearBtn').addEventListener('click', () => { searchEl.value = ''; filter = ''; searchEl.focus(); render(); });
window.addEventListener('message', e => { if (e.data.type === 'mapSymbols') { syms = e.data.symbols; render(); } });
render();
</script>
</body></html>`;
}

// ----------------------------------------------------------------
// Oric Disassembly Panel — create / refresh / HTML
// ----------------------------------------------------------------

// Wire a (new or VS-Code-restored) disassembly panel: render it, track it, and hook
// its lifecycle + message handler. Shared by createDisasmPanel and the serializer so
// restored panels are first-class (and receive updates) instead of orphaned.
function adoptDisasmPanel(panel) {
    panel.iconPath = panelIcon('panel-disasm-v2');   // tab glyph (code listing)
    disasmPanels.add(panel);
    panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
    panel.webview.html = disasmPanelHtml();
    panel.onDidDispose(() => { disasmPanels.delete(panel); if (disasmPanels.size === 0) setInstrStepMode(false); });
    // Selecting the disassembly enters instruction mode. We only flip to instruction on
    // activation here; returning to statement mode happens when the user clicks a source
    // editor (onDidChangeActiveTextEditor), NOT when the panel merely loses focus — so
    // VS Code's reveal-on-stop can't knock us out of instruction stepping.
    panel.onDidChangeViewState(e => { if (e.webviewPanel.active) setInstrStepMode(true); });
    setupDisasmMessageHandler(panel);
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'oric-debug') refreshDisasmPanel(session);
}

function createDisasmPanel() {
    // Reveal the existing one rather than spawning a duplicate.
    if (disasmPanels.size) { [...disasmPanels][0].reveal(); return; }
    const panel = vscode.window.createWebviewPanel(
        'oricDisassembly', 'Oric Disassembly',
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    adoptDisasmPanel(panel);
    setInstrStepMode(true); // the user just opened it
}

function setupDisasmMessageHandler(panel) {
    panel.webview.onDidReceiveMessage(msg => {
        const session = vscode.debug.activeDebugSession;
        if (msg.type === 'gotoAddress') {
            const addr = parseInt(msg.address, 16);
            if (!isNaN(addr)) {
                disasmCenterAddr = addr & 0xFFFF;
                if (session && session.type === 'oric-debug') refreshDisasmPanel(session);
            }
        } else if (msg.type === 'followPc') {
            disasmCenterAddr = null;
            if (session && session.type === 'oric-debug') refreshDisasmPanel(session);
        } else if (msg.type === 'toggleBreakpoint' && typeof msg.address === 'number') {
            if (session && session.type === 'oric-debug') {
                // The disassembly view is a thin view over VS Code's breakpoint
                // model: a gutter click mutates the model, and onDidChangeBreakpoints
                // refreshes the dots. This keeps it in sync with the source gutter,
                // the Breakpoints panel, and Oricutron.
                toggleBreakpointViaModel(session, msg.address);
            }
        } else if (msg.type === 'lineAction' && typeof msg.address === 'number') {
            // Right-click actions on a disassembly row — same operations as the
            // source-editor gutter menu, address-targeted. 'skip' arrives as a
            // jump to the FOLLOWING instruction's address (the webview knows it).
            // The webview hides these while running, but gate here too (a click
            // can race a resume).
            if (session && session.type === 'oric-debug' && oricDebugStopped) {
                const addr = msg.address & 0xFFFF;
                if (msg.action === 'turbo') requestTurboRun({ addr });
                else if (msg.action === 'run') requestTurboRun({ addr, warp: false }, 'Run to address');
                else if (msg.action === 'jump') gotoAddress(addr);
            }
        }
    });
    // Tell the (fresh or restored) webview the current run state so it shows or
    // hides the line actions correctly from the first render.
    pushDebugStateToDisasm();
}

// Toggle a breakpoint at `address` by mutating VS Code's breakpoint model (the
// single source of truth). Prefers a SourceBreakpoint when the address maps to a
// source line; falls back to an InstructionBreakpoint otherwise.
async function toggleBreakpointViaModel(session, address) {
    let loc = null;
    try {
        const r = await session.customRequest('locationForAddress', { address });
        loc = r && r.location;
    } catch (e) { /* fall through to instruction breakpoint */ }

    if (loc && loc.file && loc.line > 0) {
        const uri = vscode.Uri.file(loc.file);
        const line0 = loc.line - 1;
        const existing = vscode.debug.breakpoints.find(bp =>
            bp instanceof vscode.SourceBreakpoint &&
            canonPath(bp.location.uri.fsPath) === canonPath(uri.fsPath) &&
            bp.location.range.start.line === line0);
        if (existing) vscode.debug.removeBreakpoints([existing]);
        else vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(
            new vscode.Location(uri, new vscode.Position(line0, 0)))]);
    } else {
        // No source (ROM / page-2, e.g. $238): an adapter-owned ADDRESS breakpoint.
        // VS Code's InstructionBreakpoint model won't even arm a programmatically
        // created one, so the adapter arms/tracks it directly and fires
        // 'oricAddressBreakpoints' — the message listener then refreshes the gutter
        // dot and the Oric Breakpoints panel (which is in rebuildBpTree's scope).
        try { await session.customRequest('toggleAddressBreakpoint', { address: address & 0xFFFF }); }
        catch (e) { /* ignore */ }
    }
}

// Apply monitor-side breakpoint edits (from the adapter's reconciliation) to VS
// Code's model. Adds are idempotent; removes drop the matching source/instruction
// breakpoint. This makes Oricutron's monitor a peer of the other breakpoint views.
function syncMonitorBreakpoints(body) {
    const sameSource = (bp, file, line0) =>
        bp instanceof vscode.SourceBreakpoint &&
        canonPath(bp.location.uri.fsPath) === canonPath(vscode.Uri.file(file).fsPath) &&
        bp.location.range.start.line === line0;
    const sameInstr = (bp, addr16) =>
        bp instanceof vscode.InstructionBreakpoint &&
        parseInt(bp.instructionReference, 16) === addr16;

    const toAdd = [];
    for (const b of (body.added || [])) {
        if (b.file && b.line > 0) {
            const line0 = b.line - 1;
            if (!vscode.debug.breakpoints.some(bp => sameSource(bp, b.file, line0)))
                toAdd.push(new vscode.SourceBreakpoint(
                    new vscode.Location(vscode.Uri.file(b.file), new vscode.Position(line0, 0))));
        } else {
            const addr16 = b.address & 0xFFFF;
            const ref = '0x' + addr16.toString(16).padStart(4, '0');
            if (!vscode.debug.breakpoints.some(bp => sameInstr(bp, addr16)))
                toAdd.push(new vscode.InstructionBreakpoint(ref));
        }
    }

    const toRemove = [];
    for (const b of (body.removed || [])) {
        const addr16 = b.address & 0xFFFF;
        const line0 = (b.file && b.line > 0) ? b.line - 1 : -1;
        for (const bp of vscode.debug.breakpoints) {
            if (line0 >= 0 && sameSource(bp, b.file, line0)) toRemove.push(bp);
            else if (sameInstr(bp, addr16)) toRemove.push(bp);
        }
    }

    if (toAdd.length) vscode.debug.addBreakpoints(toAdd);
    if (toRemove.length) vscode.debug.removeBreakpoints(toRemove);
}

// Toggle warp/turbo speed and reflect the new state in the context key
// `oric-debug.warp`, which swaps the toolbar icon ($(watch) normal ↔ $(rocket)
// warp) so the current speed is always visible at a glance.
function doToggleWarp() {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'oric-debug') return;
    if (vizConnected) {
        // Always-live uplink: the toggle applies immediately, even mid-run — so a warp
        // KEYBINDING pressed while the program is running (or warping) can't lag behind a
        // 'c' on the halted-only GDB stub, which is why it "didn't always stop in time".
        const newState = !oricWarpOn;
        vizSendInput(vizProto.warpFrame(newState));
        oricWarpOn = newState;
        vscode.commands.executeCommand('setContext', 'oric-debug.warp', oricWarpOn);
        vscode.window.setStatusBarMessage(oricWarpOn ? 'Warp: ON' : 'Warp: OFF', 3000);
        postScreenRunState();
        if (debugControlsProvider) debugControlsProvider.pushState();   // reflect on the Warp button
        return;
    }
    // No viz stream (e.g. no Screen View open) — fall back to the GDB-stub toggle.
    session.customRequest('toggleWarp').then(resp => {
        if (resp) {
            oricWarpOn = !!resp.warp;
            vscode.commands.executeCommand('setContext', 'oric-debug.warp', oricWarpOn);
            vscode.window.setStatusBarMessage(oricWarpOn ? 'Warp: ON' : 'Warp: OFF', 3000);
            postScreenRunState();   // reflect warp in the Screen View OSD
            if (debugControlsProvider) debugControlsProvider.pushState();   // and on the Warp button
        }
    }).catch(e => {
        vscode.window.showErrorMessage('Warp toggle failed: ' + e.message);
    });
}

function refreshDisasmPanel(session) {
    if (!disasmPanels.size) return;
    if (!session || session.type !== 'oric-debug') {
        for (const p of disasmPanels) p.webview.postMessage({ type: 'disasm', data: null });
        return;
    }
    session.customRequest('disassembleRange', {
        address: disasmCenterAddr, count: 64, before: 24
    }).then(resp => {
        const following = disasmCenterAddr === null;   // null center = tracking the PC
        for (const p of disasmPanels) p.webview.postMessage({ type: 'disasm', data: resp, following });
    }).catch(() => {});
}

function disasmPanelHtml() {
    return `<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0;
}
/* Header (toolbar + history line) only makes sense while stopped — hidden otherwise. */
.dheader { position: sticky; top: 0; z-index: 10; background: var(--vscode-editor-background); display: none; }
body.dbg-stopped .dheader { display: block; }
.toolbar {
    background: var(--vscode-editor-background);
    padding: 6px 8px;
    display: flex; gap: 8px; align-items: center;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
}
.toolbar input {
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 3px 6px;
    font-family: inherit; font-size: inherit;
    width: 80px;
}
.toolbar button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; padding: 3px 10px; cursor: pointer;
    font-family: inherit; font-size: inherit;
}
.toolbar button:hover:not(:disabled) { opacity: 0.85; }
.toolbar button:disabled { opacity: 0.4; cursor: default; }
.toolbar .status {
    color: var(--vscode-foreground);
    font-weight: bold; margin-right: 12px;
}
table { width: 100%; border-collapse: collapse; user-select: text; table-layout: fixed; }
tr { height: 20px; }
/* Hover highlight marks the row the line actions will target — only while the
   debuggee is STOPPED (body.dbg-stopped, pushed by the extension); the PC row
   keeps its own color (:not(.pc-row)). */
body.dbg-stopped tr:hover:not(.pc-row) { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
tr.pc-row { background: var(--vscode-editor-selectionBackground, rgba(38,79,120,0.5)); }
tr.label-row td { border-top: 1px solid var(--vscode-widget-border, #333); padding-top: 6px; }
td { padding: 0 4px; white-space: nowrap; vertical-align: middle; }
td.gutter {
    width: 20px; text-align: center; cursor: pointer;
    color: var(--vscode-editorGutter-foldingControlForeground, #888);
    user-select: none; position: relative;
}
td.gutter .bp-dot {
    display: inline-block; width: 12px; height: 12px; border-radius: 50%;
    pointer-events: none;
}
td.gutter .bp-dot.set { background: #e51400; }
td.gutter .bp-dot.pending { border: 1.5px solid #e51400; background: transparent; }
td.gutter .bp-dot.unset { border: 1.5px solid var(--vscode-editorGutter-foldingControlForeground, #666); }
td.addr { color: var(--vscode-descriptionForeground, #888); width: 50px; }
td.bytes { color: var(--vscode-descriptionForeground, #666); width: 75px; }
td.label-col { color: var(--vscode-symbolIcon-functionForeground, #75beff); font-weight: bold; width: 140px; overflow: hidden; text-overflow: ellipsis; }
td.mnemonic { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); font-weight: bold; width: 36px; }
td.operand { color: var(--vscode-foreground); }
td.pc-arrow { width: 18px; color: var(--vscode-debugIcon-startForeground, #89d185); font-weight: bold; user-select: none; }
/* Line-action buttons sit right after the operand text (6502 lines are short —
   far-right buttons were a mile from the instruction). */
td.operand .acts { margin-left: 16px; user-select: none; }
td.operand .act {
    visibility: hidden; cursor: pointer; padding: 0 6px;
    color: var(--vscode-descriptionForeground, #888);
    white-space: nowrap;
}
body.dbg-stopped tr:hover td.operand .act { visibility: visible; }
td.operand .act:hover { color: var(--vscode-foreground); }
.no-session { padding: 20px; color: var(--vscode-descriptionForeground, #888); text-align: center; }
/* Time-travel history line: where Step Back would land + ring depth. Styled DISTINCTLY
   from the disassembly (it's often a far address, not the instruction above the PC). */
.hist-line {
    padding: 4px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--vscode-descriptionForeground, #999);
    background: var(--vscode-inputValidation-infoBackground, rgba(100,120,180,0.10));
    border-bottom: 1px dashed var(--vscode-widget-border, #555);
    border-left: 3px solid var(--vscode-debugIcon-stepBackForeground, #75beff);
}
.hist-line .hb { color: var(--vscode-debugIcon-stepBackForeground, #75beff); font-weight: bold; }
.hist-line .hl { color: var(--vscode-symbolIcon-functionForeground, #75beff); }
.hist-line .hi { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
.hist-line .hd { color: var(--vscode-descriptionForeground, #888); }
.ctx-menu {
    position: fixed; z-index: 100; min-width: 180px;
    background: var(--vscode-menu-background, #252526);
    color: var(--vscode-menu-foreground, #ccc);
    border: 1px solid var(--vscode-menu-border, #454545);
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    padding: 4px 0; user-select: none;
}
.ctx-menu .item { padding: 4px 14px; cursor: pointer; white-space: nowrap; }
.ctx-menu .item:hover {
    background: var(--vscode-menu-selectionBackground, #094771);
    color: var(--vscode-menu-selectionForeground, #fff);
}
.ctx-menu .addr-hint {
    padding: 2px 14px 4px; font-size: 0.85em;
    color: var(--vscode-descriptionForeground, #888);
    border-bottom: 1px solid var(--vscode-menu-border, #454545);
    margin-bottom: 3px;
}
</style></head><body>
<div class="dheader">
<div class="toolbar">
    <span class="status" id="statusText"></span>
    <span style="color:var(--vscode-descriptionForeground,#888)">Go to:</span>
    <input type="text" id="gotoInput" placeholder="$XXXX" spellcheck="false">
    <button id="gotoBtn">Go</button>
    <button id="followBtn">Follow PC</button>
</div>
<div id="histLine"></div>
</div>
<div id="content"><div class="no-session">No debug session active</div></div>
<script>
const vscode = acquireVsCodeApi();
let lastData = null;
let debugStopped = false; // pushed by the extension; gates the line actions

// Use mousedown + event delegation for breakpoint gutter clicks.
// In VS Code webviews the first 'click' after focus acquisition is often
// swallowed; mousedown fires reliably on every press including the first.
document.getElementById('content').addEventListener('mousedown', e => {
    if (e.button !== 0) return; // right-click opens the line-action menu, not a bp toggle
    // Hover line-action buttons (run/turbo/jump/skip on the row itself)
    const act = e.target.closest('span.act');
    if (act) {
        e.preventDefault();
        e.stopPropagation();
        const tr = act.closest('tr');
        const addr = tr && tr.id && tr.id[0] === 'r' ? parseInt(tr.id.slice(1)) : NaN;
        if (isNaN(addr)) return;
        if (act.dataset.action === 'skip') {
            const next = nextAddrAfter(addr);
            if (next !== null) vscode.postMessage({ type: 'lineAction', action: 'jump', address: next });
        } else {
            vscode.postMessage({ type: 'lineAction', action: act.dataset.action, address: addr });
        }
        return;
    }
    const td = e.target.closest('td.gutter');
    if (!td) return;
    e.preventDefault();
    e.stopPropagation();
    const addr = parseInt(td.dataset.addr);
    if (!isNaN(addr)) vscode.postMessage({ type: 'toggleBreakpoint', address: addr });
});

document.getElementById('gotoBtn').addEventListener('click', doGoto);
document.getElementById('gotoInput').addEventListener('keydown', e => { if (e.key === 'Enter') doGoto(); });
document.getElementById('gotoInput').addEventListener('input', updateHeaderButtons);
document.getElementById('followBtn').addEventListener('click', () => vscode.postMessage({ type: 'followPc' }));

let following = true;   // true = view is tracking the PC (extension: disasmCenterAddr === null)
// Go: only meaningful with a valid $addr typed. Follow PC: only when NOT already following.
function updateHeaderButtons() {
    const v = document.getElementById('gotoInput').value.trim().replace(/^\\$/, '');
    document.getElementById('gotoBtn').disabled = !/^[0-9a-fA-F]{1,4}$/.test(v);
    document.getElementById('followBtn').disabled = following;
}
updateHeaderButtons();

// Drag a label out (e.g. into an editor) as plain text.
document.getElementById('content').addEventListener('dragstart', e => {
    const el = e.target.closest('[data-drag]');
    if (el) e.dataTransfer.setData('text/plain', el.dataset.drag);
});

// Right-click on an instruction row: run/turbo/jump/skip targeted at that
// address — the address-based twin of the source editors' line-number menu.
let ctxMenu = null;
function closeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
document.addEventListener('mousedown', e => { if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });
window.addEventListener('wheel', closeCtxMenu, { passive: true });

// Address of the instruction FOLLOWING addr in the rendered window — the skip
// target ("jump over one instruction"). Shared by the context menu and the
// hover buttons. null on the window's last row.
function nextAddrAfter(addr) {
    const list = (lastData && lastData.instructions) || [];
    const i = list.findIndex(ins => ins.address === addr);
    return i >= 0 && i + 1 < list.length ? list[i + 1].address : null;
}

document.getElementById('content').addEventListener('contextmenu', e => {
    if (!debugStopped) return; // no line actions on a running machine
    const tr = e.target.closest('tr');
    if (!tr || !tr.id || tr.id[0] !== 'r' || !lastData) return;
    e.preventDefault();
    closeCtxMenu();
    const addr = parseInt(tr.id.slice(1));
    if (isNaN(addr)) return;
    const next = nextAddrAfter(addr);
    const h4 = v => v.toString(16).toUpperCase().padStart(4, '0');

    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ctx-menu';
    // Contextual: the PC row only offers "skip"; other rows offer the movement
    // actions (skip is meaningless when you are not skipping the NEXT thing).
    const items = [];
    if (addr === lastData.pc) {
        if (next !== null) items.push(['\\u21B7 Skip Instruction', 'jump', next]);
    } else {
        items.push(['\\u25B6 Run to Here', 'run', addr]);
        items.push(['\\u26A1 Turbo Run to Here', 'turbo', addr]);
        items.push(['\\u2316 Jump Here', 'jump', addr]);
    }
    if (!items.length) return;
    let mh = '<div class="addr-hint">$' + h4(addr) + '</div>';
    for (let k = 0; k < items.length; k++) mh += '<div class="item" data-k="' + k + '">' + items[k][0] + '</div>';
    ctxMenu.innerHTML = mh;
    ctxMenu.addEventListener('mousedown', ev => {
        const it = ev.target.closest('.item');
        if (!it) return;
        ev.preventDefault(); ev.stopPropagation();
        const [, action, a] = items[+it.dataset.k];
        vscode.postMessage({ type: 'lineAction', action, address: a });
        closeCtxMenu();
    });
    document.body.appendChild(ctxMenu);
    // Position: clamp so the menu stays inside the view.
    const mw = ctxMenu.offsetWidth, mhgt = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - mw - 4) + 'px';
    ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - mhgt - 4) + 'px';
});

// Suppress the browser's native context menu everywhere in the webview — Shift+F10
// (our reverse-step key) and right-clicks off a row would otherwise pop the cut/
// copy/paste menu. Our own line-action menu (right-click on a row) is built by the
// handler above; text is still copyable via selection + Ctrl+C.
document.addEventListener('contextmenu', e => e.preventDefault());

function doGoto() {
    let v = document.getElementById('gotoInput').value.trim().replace(/^\\$/, '');
    if (/^[0-9a-fA-F]{1,4}$/.test(v)) {
        vscode.postMessage({ type: 'gotoAddress', address: v });
    }
}

window.addEventListener('message', e => {
    if (e.data.type === 'disasm') {
        lastData = e.data.data;
        following = !!e.data.following;
        render();
        updateHeaderButtons();
    } else if (e.data.type === 'debugState') {
        // Stopped/running (pushed by the extension): line actions only make
        // sense on a stopped machine, so hide them while running / no session.
        debugStopped = !!e.data.stopped;
        document.body.classList.toggle('dbg-stopped', debugStopped);
        if (!debugStopped) closeCtxMenu();
    }
});

function renderHistLine(history, h4) {
    // Pinned in the sticky header (#histLine), so it stays visible while the
    // disassembly scrolls beneath it. Shows where Step Back would land + ring depth.
    const hl = document.getElementById('histLine');
    if (!history || !history.depth) { hl.innerHTML = ''; return; }
    const d = history.depth + ' step' + (history.depth > 1 ? 's' : '') + ' back';
    if (history.address !== null && history.address !== undefined) {
        hl.innerHTML = '<div class="hist-line">'
            + '<span class="hb">\\u25C0 back \\u2192 $' + h4(history.address) + '</span>'
            + (history.label ? '  <span class="hl">' + escHtml(history.label) + '</span>' : '')
            + (history.text ? '  <span class="hi">' + escHtml(history.text) + '</span>' : '')
            + '  <span class="hd">(' + d + ')</span></div>';
    } else {
        hl.innerHTML = '<div class="hist-line"><span class="hb">\\u25C0</span> <span class="hd">' + d + ' available</span></div>';
    }
}

function render() {
    const el = document.getElementById('content');
    const h4 = v => v.toString(16).toUpperCase().padStart(4, '0');
    if (!lastData || !lastData.instructions || lastData.instructions.length === 0) {
        el.innerHTML = '<div class="no-session">No debug session active</div>';
        document.getElementById('statusText').textContent = '';
        renderHistLine(null, h4);
        return;
    }
    const { instructions, pc, breakpoints, pendingBreakpoints, history } = lastData;
    const bpSet = new Set(breakpoints || []);
    const pendingSet = new Set(pendingBreakpoints || []);
    const h2 = v => v.toString(16).toUpperCase().padStart(2, '0');
    renderHistLine(history, h4);

    let html = '<table>';
    let pcRowId = null;
    for (const ins of instructions) {
        const isPc = ins.address === pc;
        const hasLabel = ins.label && ins.label.length > 0;
        const hasBp = bpSet.has(ins.address);
        const isPending = !hasBp && pendingSet.has(ins.address);
        const cls = [];
        if (isPc) cls.push('pc-row');
        if (hasLabel) cls.push('label-row');
        const rowId = 'r' + ins.address;
        if (isPc) pcRowId = rowId;

        const bytesStr = ins.bytes.map(b => h2(b)).join(' ');
        const bpCls = hasBp ? 'bp-dot set' : (isPending ? 'bp-dot pending' : 'bp-dot unset');

        html += '<tr id="' + rowId + '"' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>';
        html += '<td class="pc-arrow">' + (isPc ? '\\u25B6' : '') + '</td>';
        html += '<td class="gutter" data-addr="' + ins.address + '"><span class="' + bpCls + '"></span></td>';
        html += '<td class="addr">$' + h4(ins.address) + '</td>';
        html += '<td class="bytes">' + bytesStr + '</td>';
        html += '<td class="label-col"' + (hasLabel ? ' draggable="true" data-drag="' + ins.label + '"' : '') + '>' + (hasLabel ? ins.label : '') + '</td>';
        html += '<td class="mnemonic">' + ins.mnemonic + '</td>';
        // Hover-revealed line actions ride inside the operand cell so they sit
        // right after the instruction text. Labels are printed, NOT tooltips —
        // VS Code draws tooltips under the pointer, unreadable with a large
        // cursor (user accessibility requirement). Contextual: the PC row only
        // offers "skip" (you are already here); other rows offer the movement
        // actions and no skip. Skip's target resolves at click time.
        const acts = isPc
            ? '<span class="act" data-action="skip">\\u21B7 skip</span>'
            : '<span class="act" data-action="run">\\u25B6 run</span>'
            + '<span class="act" data-action="turbo">\\u26A1 turbo</span>'
            + '<span class="act" data-action="jump">\\u2316 jump</span>';
        html += '<td class="operand">' + escHtml(ins.operand)
            + '<span class="acts">' + acts + '</span></td>';
        html += '</tr>';
    }
    html += '</table>';
    el.innerHTML = html;

    // Scroll PC row into view
    if (pcRowId) {
        const row = document.getElementById(pcRowId);
        if (row) row.scrollIntoView({ block: 'center', behavior: 'auto' });
    }

    document.getElementById('statusText').textContent = 'PC: $' + h4(pc);
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Restore state after webview becomes visible again
const saved = vscode.getState();
if (saved && saved.lastData) { lastData = saved.lastData; render(); }

// Persist state on updates
const origRender = render;
render = function() { origRender(); if (lastData) vscode.setState({ lastData }); };
</script>
</body></html>`;
}

function symbolsPanelHtml() {
    return `<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0;
    /* Fixed column layout: toolbar / watch / splitter / symbols.
       The page itself never scrolls — each region scrolls on its own. */
    display: flex; flex-direction: column; overflow: hidden;
}
.toolbar {
    flex: none;
    background: var(--vscode-editor-background);
    padding: 6px 8px;
    display: flex; gap: 8px; align-items: center;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
}
.search-wrap {
    flex: 1; min-width: 100px; position: relative;
}
.search-wrap input {
    width: 100%; box-sizing: border-box; height: 24px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 3px 46px 3px 6px;
    font-family: inherit; font-size: inherit;
}
/* Recent-searches caret = a real dropdown button on the right, styled to read
   like the groupFilter <select>'s arrow: full height, its own separator, and the
   foreground colour (not a tiny dim glyph). Same behaviour → same look. */
.search-wrap .mru-btn {
    position: absolute; right: 1px; top: 1px; bottom: 1px; width: 22px;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; border-left: 1px solid var(--vscode-input-border, #555);
    color: var(--vscode-foreground); cursor: pointer; font-size: 12px; line-height: 1; padding: 0;
}
.search-wrap .mru-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
/* Clear × sits just left of the caret button, and only while there is text. */
.search-wrap .clear-btn {
    position: absolute; right: 26px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--vscode-descriptionForeground, #888);
    cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px;
    display: none;
}
.search-wrap .clear-btn:hover { color: var(--vscode-foreground); }
.search-wrap input:not(:placeholder-shown) ~ .clear-btn { display: block; }
/* Match the field height to the sibling dropdown so the combo and the select line up. */
.toolbar select { height: 24px; box-sizing: border-box; }
.search-wrap .mru-list {
    position: absolute; top: 100%; left: 0; right: 0; z-index: 20;
    background: var(--vscode-dropdown-background, #3c3c3c);
    border: 1px solid var(--vscode-dropdown-border, #555);
    max-height: 160px; overflow-y: auto;
    display: none;
}
.search-wrap .mru-list.open { display: block; }
.search-wrap .mru-item {
    padding: 3px 8px; cursor: pointer; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
    color: var(--vscode-dropdown-foreground, #ccc);
}
.search-wrap .mru-item:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
}
.toolbar button.wadd {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; padding: 3px 8px; cursor: pointer;
    font-family: inherit; font-size: inherit; white-space: nowrap;
}
.toolbar button.wadd:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.toolbar select {
    background: var(--vscode-dropdown-background, #3c3c3c);
    color: var(--vscode-dropdown-foreground, #ccc);
    border: 1px solid var(--vscode-dropdown-border, #555);
    padding: 3px 4px;
    font-family: inherit; font-size: inherit;
}
.toolbar .count {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 0.9em;
    white-space: nowrap;
}
table {
    width: 100%; border-collapse: collapse; table-layout: fixed;
}
col.col-name  { width: auto; }
col.col-addr  { width: 60px; }
col.col-size  { width: 38px; }
col.col-value { width: 170px; }
col.col-group { width: 44px; }
th {
    position: sticky; top: 0; z-index: 5;
    background: var(--vscode-editor-background);
    text-align: left; padding: 3px 8px;
    cursor: pointer; user-select: none;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
    color: var(--vscode-sideBarSectionHeader-foreground, #ccc);
    font-weight: bold; font-size: 0.95em;
    white-space: nowrap;
}
th:hover { color: var(--vscode-foreground); }
th .arrow { font-size: 0.8em; margin-left: 2px; }
td {
    padding: 2px 8px; white-space: nowrap;
}
tr:nth-child(even) td {
    background: rgba(255,255,255,0.03);
}
.name { color: var(--vscode-debugTokenExpression-name, #9cdcfe); overflow: hidden; text-overflow: ellipsis; }
.alias { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.addr { color: var(--vscode-descriptionForeground, #888); }
.sz   { color: var(--vscode-descriptionForeground, #888); }
.val  { color: var(--vscode-debugTokenExpression-number, #b5cea8); overflow: hidden; text-overflow: ellipsis; }
.val.mod { color: var(--vscode-charts-red, #e04040); }
.grp  { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.dim  { color: var(--vscode-descriptionForeground, #888); padding: 16px 8px; }
.sym-link { cursor: pointer; }
.sym-link:hover { text-decoration: underline; }
/* --- Watched expressions section (sticky, under the toolbar) --- */
#watchSec {
    flex: none;
    background: var(--vscode-editor-background);
    padding: 2px 8px 4px;
    /* Own scrollbar; the splitter below resizes it (drag sets an explicit height) */
    max-height: 40%; overflow-y: auto; overflow-x: hidden;
}
#splitter {
    flex: none; height: 5px; cursor: ns-resize;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
}
#splitter:hover, #splitter.dragging { background: var(--vscode-focusBorder, #007fd4); }
#symWrap {
    flex: 1 1 auto; min-height: 60px;
    overflow-y: auto; overflow-x: hidden;
}
.wrow { display: flex; gap: 5px; align-items: baseline; padding: 1px 0; }
.wx { cursor: pointer; color: var(--vscode-descriptionForeground, #888); flex: none; font-size: 14px; line-height: 1; }
.wx:hover { color: var(--vscode-errorForeground, #f48771); }
.wt { flex: none; width: 11px; color: var(--vscode-descriptionForeground, #888); }
.wt[data-path] { cursor: pointer; }
.wt[data-path]:hover { color: var(--vscode-foreground); }
/* Indent guide: one slot per depth level; the ::before lines of consecutive
   rows stack into a continuous vertical line marking the expanded scope */
.wg { flex: none; width: 11px; align-self: stretch; position: relative; }
.wg::before { content: ''; position: absolute; left: 5px; top: -1px; bottom: -1px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke, #585858); }
.wtype { color: var(--vscode-debugTokenExpression-type, #4ec9b0); }
.waddr { color: var(--vscode-descriptionForeground, #888); }
/* Decoded enum/bool name: a distinct greenish tint so the symbolic value stands
   out from the raw ($hex|dec|%bin) that follows it. */
.wenum { color: var(--vscode-symbolIcon-enumeratorMemberForeground, #a5d6a7); }
/* Stale: session ended, rows show the last live values grayed out */
#watchSec.stale .wrow { opacity: 0.55; }
.wn { color: var(--vscode-debugTokenExpression-name, #9cdcfe); flex: none; }
.wv { color: var(--vscode-debugTokenExpression-number, #b5cea8); overflow-wrap: anywhere; }
.wv.mod { color: var(--vscode-charts-red, #e04040); }
.wv.err { color: var(--vscode-errorForeground, #f48771); }
.wv.idle { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
#watchSec details { margin-top: 2px; }
#watchSec summary { cursor: pointer; color: var(--vscode-descriptionForeground, #888); user-select: none; }
/* Watch PIN column. Deliberately a pushpin, NOT the round red breakpoint dot, so
   pinning a symbol to the Watch list is never mistaken for setting a breakpoint.
   Grayed + faded when unpinned, full colour when pinned. */
col.col-watch { width: 22px; }
.wdot { cursor: pointer; text-align: center; padding: 2px 0 2px 6px; font-size: 12px; line-height: 1; filter: grayscale(1); opacity: 0.4; }
.wdot:hover { opacity: 0.85; }
.wdot.on { filter: none; opacity: 1; }
/* Breakpoint marker column — the REAL breakpoint (execution or watchpoint), red like
   the gutter. Hollow ring when none, solid dot when set. Click opens the action menu. */
col.col-bp { width: 20px; }
.bpdot { cursor: pointer; text-align: center; padding: 2px 0 2px 6px; font-size: 13px; line-height: 1;
    color: var(--vscode-debugIcon-breakpointForeground, #e51400); opacity: 0.35; }
.bpdot:hover { opacity: 0.85; }
.bpdot.on { opacity: 1; }
/* Per-row breakpoint action menu (webviews have no native context menu). */
#symBpMenu {
    position: fixed; z-index: 50; display: none; min-width: 150px;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--vscode-menu-border, #454545);
    box-shadow: 0 2px 8px rgba(0,0,0,0.4); padding: 3px 0;
}
#symBpMenu .mi { padding: 4px 14px; cursor: pointer; white-space: nowrap; color: var(--vscode-menu-foreground, #ccc); }
#symBpMenu .mi:hover { background: var(--vscode-menu-selectionBackground, #094771); color: var(--vscode-menu-selectionForeground, #fff); }
#symBpMenu .sep { height: 1px; background: var(--vscode-menu-separatorBackground, #454545); margin: 3px 0; }
</style></head><body>
<div class="toolbar">
    <div class="search-wrap">
        <input type="text" id="search" placeholder="Search name or value..." autocomplete="off" />
        <button class="mru-btn" id="mruBtn">\u25BE</button>
        <button class="clear-btn" id="clearBtn" title="Clear">\u00D7</button>
        <div class="mru-list" id="mruList"></div>
    </div>
    <button id="watchBtn" class="wadd">+ Watch</button>
    <select id="groupFilter">
        <option value="all">All</option>
        <option value="zp">Zero Page</option>
        <option value="ram">RAM</option>
        <option value="high">High</option>
        <option value="define">Define</option>
    </select>
    <span class="count" id="count"></span>
</div>
<div id="watchSec" style="display:none"></div>
<div id="splitter" style="display:none"></div>
<div id="symWrap">
<table>
    <colgroup>
        <col class="col-bp">
        <col class="col-watch">
        <col class="col-name">
        <col class="col-addr">
        <col class="col-size">
        <col class="col-value">
        <col class="col-group">
    </colgroup>
    <thead><tr>
        <th></th>
        <th></th>
        <th data-col="name">Name <span class="arrow"></span></th>
        <th data-col="addr">Addr <span class="arrow"></span></th>
        <th data-col="size">Size <span class="arrow"></span></th>
        <th data-col="value">Value <span class="arrow"></span></th>
        <th data-col="group">Group <span class="arrow"></span></th>
    </tr></thead>
    <tbody id="tbody"></tbody>
</table>
<div class="dim" id="nodata">No debug session or no symbols loaded</div>
</div>
<div id="symBpMenu"></div>
<script>
const vscode = acquireVsCodeApi();
const searchEl = document.getElementById('search');
const groupEl = document.getElementById('groupFilter');
const tbody = document.getElementById('tbody');
const countEl = document.getElementById('count');
const nodata = document.getElementById('nodata');
const headers = document.querySelectorAll('th[data-col]');

const clearBtn = document.getElementById('clearBtn');
const mruListEl = document.getElementById('mruList');
const watchSec = document.getElementById('watchSec');
const splitterEl = document.getElementById('splitter');

let allSymbols = null;
let watchActive = [];          // watch tree nodes {path, label, value, error?, canExpand, expanded, children}
let watchInactive = [];        // [{path, label, owners}]
let watchNoSession = false;
let watchStale = false;        // session ended — showing the last live values grayed
let watchedSet = new Set();    // exprs, for the row dots
let bpMarks = new Set();       // addresses with an execution bp or watchpoint, for the bp column
let prevWatchVals = {};        // expr -> value, red-highlight changes
let watchInactiveOpen = false; // <details> fold state survives re-renders
let prevValues = {};   // name -> value string for change detection
let sortCol = 'addr';
let sortAsc = true;
let filterText = '';
let filterGroup = 'all';
let mruItems = [];     // most-recently-used search terms
const MRU_MAX = 10;

function h(v, w) { return '$' + v.toString(16).toUpperCase().padStart(w, '0'); }

function fmtValue(sym) {
    if (sym.defineValue !== undefined) return sym.defineValue;
    // Annotated value pre-rendered by the adapter (same path as Watch) — @bcd/@enum/etc.
    if (sym.display) return sym.display;
    if (sym.typeInfo) return sym.typeInfo.type;
    const v = sym.value;
    if (!v || v.length === 0) return '?';
    if (v.length === 1) return h(v[0], 2) + ' (' + v[0] + ')';
    if (v.length === 2) {
        const w = v[0] | (v[1] << 8);
        return h(w, 4) + ' (' + w + ')';
    }
    return v.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function valueKey(sym) {
    return sym.value ? sym.value.join(',') : '';
}

function groupLabel(g) {
    if (g === 'zp') return 'ZP';
    if (g === 'ram') return 'RAM';
    if (g === 'high') return 'High';
    if (g === 'define') return '#def';
    return g;
}

function render() {
    if (!allSymbols) {
        tbody.innerHTML = '';
        nodata.style.display = 'block';
        countEl.textContent = '';
        return;
    }
    nodata.style.display = 'none';

    let list = allSymbols;
    if (filterGroup !== 'all') list = list.filter(s => s.group === filterGroup);
    if (filterText) {
        const ft = filterText.toLowerCase();
        // Address queries: normalise "$94" / "0x94" / "94" so they match the padded
        // hex ($0094). Strip a leading $ or 0x, then substring-match the 4-digit hex,
        // so a short address finds the full one instead of needing all four digits.
        let hexq = ft;
        if (hexq.charAt(0) === '$') hexq = hexq.slice(1);
        else if (hexq.slice(0, 2) === '0x') hexq = hexq.slice(2);
        const hexLike = hexq.length > 0 && /^[0-9a-f]+$/.test(hexq);
        list = list.filter(s => {
            if (s.name.toLowerCase().includes(ft)) return true;
            if (s.aliases && s.aliases.some(a => a.toLowerCase().includes(ft))) return true;
            if (fmtValue(s).toLowerCase().includes(ft)) return true;
            if (s.addr >= 0) {
                const hx = s.addr.toString(16).padStart(4, '0');   // "0094"
                if (('$' + hx).includes(ft)) return true;          // "$0094" / "0094" / "94"
                if (hexLike && hx.includes(hexq)) return true;     // "$94" / "0x94" -> "94" in "0094"
            }
            return false;
        });
    }

    list.sort((a, b) => {
        let cmp = 0;
        if (sortCol === 'name') cmp = a.name.localeCompare(b.name);
        else if (sortCol === 'addr') {
            // Non-numeric defines (addr=-1) sort to the end
            if (a.addr < 0 && b.addr >= 0) cmp = 1;
            else if (b.addr < 0 && a.addr >= 0) cmp = -1;
            else cmp = a.addr - b.addr;
        }
        else if (sortCol === 'size') cmp = a.size - b.size;
        else if (sortCol === 'value') cmp = fmtValue(a).localeCompare(fmtValue(b));
        else if (sortCol === 'group') cmp = a.group.localeCompare(b.group);
        return sortAsc ? cmp : -cmp;
    });

    countEl.textContent = list.length + ' / ' + allSymbols.length;

    // Update sort arrows
    headers.forEach(th => {
        const arrow = th.querySelector('.arrow');
        if (th.dataset.col === sortCol) arrow.textContent = sortAsc ? '\\u25B2' : '\\u25BC';
        else arrow.textContent = '';
    });

    let html = '';
    for (const s of list) {
        const vk = valueKey(s);
        const prev = prevValues[s.name];
        const mod = prev !== undefined && prev !== vk ? ' mod' : '';
        let attrs = ' data-addr="' + s.addr + '"';
        // Build name cell with individually clickable names
        const ns = s.nameSources || {};
        function nameSpan(name) {
            const src = ns[name];
            if (src && src.file) {
                return '<span class="sym-link" data-file="' + src.file.replace(/"/g, '&quot;') + '" data-line="' + src.line + '">' + name + '</span>';
            }
            return name;
        }
        let nameHtml = nameSpan(s.name);
        if (s.aliases && s.aliases.length > 0) {
            nameHtml += ' <span class="alias">/ ' + s.aliases.map(a => nameSpan(a)).join(' / ') + '</span>';
        }
        // Breakpoint marker (defines are constants / addr-less — no breakpoint).
        const bpon = bpMarks.has(s.addr);
        const bpsrc = (s.source && s.source.file)
            ? ' data-bpfile="' + s.source.file.replace(/"/g, '&quot;') + '" data-bpline="' + s.source.line + '"' : '';
        const bpcell = (s.defineValue !== undefined || s.addr < 0) ? '<td class="bpdot"></td>'
            : '<td class="bpdot' + (bpon ? ' on' : '') + '" data-bpaddr="' + s.addr + '" data-bpname="' + s.name + '" data-bpsize="' + (s.size > 0 ? s.size : 1) + '"' + bpsrc
              + ' title="' + (bpon ? 'Breakpoint set — click to change/remove' : 'Set breakpoint / watchpoint') + '">'
              + (bpon ? '\\u25CF' : '\\u25CB') + '</td>';
        // Watch toggle dot (defines are constants — nothing to watch)
        const wdot = s.defineValue !== undefined ? '<td class="wdot"></td>'
            : '<td class="wdot' + (watchedSet.has(s.name) ? ' on' : '') + '" data-wname="' + s.name
              + '" title="' + (watchedSet.has(s.name) ? 'Pinned to Watch — click to unpin' : 'Pin to Watch')
              + '">\\uD83D\\uDCCC</td>';   // 📌 pushpin (not a breakpoint dot)
        html += '<tr' + attrs + ' title="' + s.name + (s.aliases && s.aliases.length ? ' / ' + s.aliases.join(' / ') : '') + '">'
            + bpcell
            + wdot
            + '<td class="name" draggable="true" data-drag="' + s.name + '">' + nameHtml + '</td>'
            + '<td class="addr">' + (s.addr >= 0 ? h(s.addr, 4) : '\u2014') + '</td>'
            + '<td class="sz">' + (s.size > 0 ? s.size : '\u2014') + '</td>'
            + '<td class="val' + mod + '" title="' + (s.defineComment || fmtValue(s)).replace(/"/g, '&quot;') + '">' + fmtValue(s) + '</td>'
            + '<td class="grp">' + groupLabel(s.group) + '</td>'
            + '</tr>';
    }
    tbody.innerHTML = html;
}

// --- MRU helpers ---
function mruAdd(term) {
    term = term.trim();
    if (!term) return;
    mruItems = mruItems.filter(t => t !== term);
    mruItems.unshift(term);
    if (mruItems.length > MRU_MAX) mruItems.length = MRU_MAX;
}
function mruRender() {
    if (mruItems.length === 0) { mruListEl.classList.remove('open'); return; }
    mruListEl.innerHTML = mruItems.map(t =>
        '<div class="mru-item">' + t.replace(/</g, '&lt;') + '</div>'
    ).join('');
    mruListEl.classList.add('open');
}
function mruClose() { mruListEl.classList.remove('open'); }
function mruSave() { vscode.postMessage({ type: 'mruUpdate', items: mruItems }); }
// ▾ opens/closes the full history; mousedown (not click) so the input keeps
// focus and the blur-close timer never races the toggle.
document.getElementById('mruBtn').addEventListener('mousedown', e => {
    e.preventDefault();
    if (mruListEl.classList.contains('open')) mruClose();
    else mruRender();
});
mruListEl.addEventListener('mousedown', e => {
    const item = e.target.closest('.mru-item');
    if (item) {
        searchEl.value = item.textContent;
        filterText = searchEl.value;
        mruClose();
        render();
    }
});

// --- Search input ---
searchEl.addEventListener('input', () => { filterText = searchEl.value; mruClose(); render(); });
searchEl.addEventListener('focus', () => { if (!searchEl.value && mruItems.length) mruRender(); });
searchEl.addEventListener('blur', () => { setTimeout(mruClose, 150); });
searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { searchEl.value = ''; filterText = ''; mruClose(); render(); }
    // Enter watches the typed expression (and remembers it in the search history).
    if (e.key === 'Enter') {
        if (filterText.trim()) { mruAdd(filterText); mruSave(); }
        mruClose();
        watchTyped();
        return;
    }
    if (e.key === 'ArrowDown' && !searchEl.value && mruItems.length) { mruRender(); }
});

// "+ Watch" button / Enter: watch WHATEVER is typed — casts like (item_id)a,
// registers, hex addresses — no need to match a row in the table.
function watchTyped() {
    const expr = searchEl.value.trim();
    if (expr) vscode.postMessage({ type: 'watchToggle', expr: expr });
}
document.getElementById('watchBtn').addEventListener('click', watchTyped);
clearBtn.addEventListener('click', () => {
    if (searchEl.value.trim()) { mruAdd(searchEl.value); mruSave(); }
    searchEl.value = ''; filterText = ''; mruClose(); render(); searchEl.focus();
});

groupEl.addEventListener('change', () => { filterGroup = groupEl.value; render(); });

// Status-bar hover help (visible alternative to native tooltips, which a large cursor
// covers — see no-tooltip-dependent-ui). Mirrors Screen View's SS_HELP; the panel forwards
// these 'hover'/'hoverEnd' messages to the shared showHoverHelp() status-bar item.
const SYM_HELP = {
    mruBtn: 'Recent searches',
    clearBtn: 'Clear the search (Esc)',
    watchBtn: 'Watch the typed expression (name, cast, register, or $address)',
    groupFilter: 'Filter by memory region: All / Zero Page / RAM / High / Define'
};
for (const id in SYM_HELP) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('mouseenter', () => vscode.postMessage({ type: 'hover', text: SYM_HELP[id] }));
    el.addEventListener('mouseleave', () => vscode.postMessage({ type: 'hoverEnd' }));
}

headers.forEach(th => {
    th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (sortCol === col) sortAsc = !sortAsc;
        else { sortCol = col; sortAsc = true; }
        render();
    });
});

// --- Hover → heatmap highlight, Click → go-to-definition ---
tbody.addEventListener('mouseover', e => {
    const tr = e.target.closest('tr[data-addr]');
    if (tr) vscode.postMessage({ type: 'symbolHover', addr: parseInt(tr.dataset.addr, 10) });
});
tbody.addEventListener('mouseleave', () => {
    vscode.postMessage({ type: 'symbolLeave' });
});
// Drag a symbol name out (e.g. into an editor) as plain text.
tbody.addEventListener('dragstart', e => {
    const el = e.target.closest('[data-drag]');
    if (el) e.dataTransfer.setData('text/plain', el.dataset.drag);
});
tbody.addEventListener('click', e => {
    const dot = e.target.closest('.wdot[data-wname]');
    if (dot) {
        vscode.postMessage({ type: 'watchToggle', expr: dot.dataset.wname });
        return;
    }
    const bp = e.target.closest('.bpdot[data-bpaddr]');
    if (bp) {
        openBpMenu(bp, e.clientX, e.clientY);
        return;
    }
    const link = e.target.closest('.sym-link[data-file]');
    if (link) {
        vscode.postMessage({ type: 'gotoSymbol', file: link.dataset.file, line: parseInt(link.dataset.line, 10) });
    }
});

// --- Per-row breakpoint action menu (webviews have no native context menu) ---
const symBpMenu = document.getElementById('symBpMenu');
let bpMenuTarget = null;   // { addr, name, size, on }
function openBpMenu(cell, x, y) {
    bpMenuTarget = { addr: parseInt(cell.dataset.bpaddr, 10), name: cell.dataset.bpname,
                     size: parseInt(cell.dataset.bpsize, 10) || 1, on: cell.classList.contains('on'),
                     file: cell.dataset.bpfile || null, line: cell.dataset.bpline ? parseInt(cell.dataset.bpline, 10) : 0 };
    symBpMenu.innerHTML =
        '<div class="mi" data-act="execute">Break on execute</div>' +
        '<div class="mi" data-act="change">Break on change</div>' +
        '<div class="mi" data-act="access">Break on access</div>' +
        (bpMenuTarget.on ? '<div class="sep"></div><div class="mi" data-act="remove">Remove breakpoint</div>' : '');
    symBpMenu.style.display = 'block';
    // Keep the menu on-screen.
    const mw = symBpMenu.offsetWidth, mh = symBpMenu.offsetHeight;
    symBpMenu.style.left = Math.max(2, Math.min(x, window.innerWidth - mw - 4)) + 'px';
    symBpMenu.style.top = Math.max(2, Math.min(y, window.innerHeight - mh - 4)) + 'px';
}
function closeBpMenu() { symBpMenu.style.display = 'none'; bpMenuTarget = null; }
symBpMenu.addEventListener('click', e => {
    const mi = e.target.closest('.mi');
    if (!mi || !bpMenuTarget) return;
    vscode.postMessage({ type: 'symBp', action: mi.dataset.act, addr: bpMenuTarget.addr, name: bpMenuTarget.name, size: bpMenuTarget.size, file: bpMenuTarget.file, line: bpMenuTarget.line });
    closeBpMenu();
});
document.addEventListener('click', e => {
    if (symBpMenu.style.display === 'block' && !symBpMenu.contains(e.target) && !e.target.closest('.bpdot')) closeBpMenu();
});
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeBpMenu(); });

// --- Watched expressions section ---
function escW(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Draggable splitter between the watch section and the symbol table.
// Dragging pins an explicit height on watchSec (replacing its 40% max-height).
let splitDragging = false;
splitterEl.addEventListener('mousedown', e => {
    splitDragging = true;
    splitterEl.classList.add('dragging');
    e.preventDefault();
});
window.addEventListener('mousemove', e => {
    if (!splitDragging) return;
    const top = watchSec.getBoundingClientRect().top;
    const h = Math.max(24, Math.min(e.clientY - top, window.innerHeight * 0.8));
    watchSec.style.maxHeight = 'none';
    watchSec.style.height = h + 'px';
});
window.addEventListener('mouseup', () => {
    splitDragging = false;
    splitterEl.classList.remove('dragging');
});

function renderWatch() {
    if (!watchActive.length && !watchInactive.length) {
        watchSec.innerHTML = '';
        watchSec.style.display = 'none';
        splitterEl.style.display = 'none';
        return;
    }
    watchSec.style.display = 'block';
    splitterEl.style.display = 'block';
    watchSec.classList.toggle('stale', watchStale);
    const newVals = {};
    // Colorize the adapter's pre-rendered value string. buildTypedVar joins
    // its fields with TWO spaces — "value  type  @ $addr", "type  @ $addr"
    // (structs), "value  type  A" (register casts) — so split on that
    // delimiter and classify each segment instead of pattern-guessing.
    function colorVal(v) {
        const segs = escW(v).split('  ');
        const isType = s => /^\\*?[A-Za-z_][\\w|-]*(\\[\\d+\\])?$/.test(s);
        return segs.map((seg, i) => {
            if (/^@ \\$[0-9A-Fa-f]+$/.test(seg)) return '<span class="waddr">' + seg + '</span>';
            if (/^(A|X|Y|SP|PC)$/.test(seg)) return seg;              // register token of a cast
            if (i > 0 && isType(seg)) return '<span class="wtype">' + seg + '</span>';
            if (i === 0) {
                // Struct render is just "type  @ $addr" — the type IS the first segment
                if (segs.length === 2 && /^@ \\$/.test(segs[1]) && isType(seg))
                    return '<span class="wtype">' + seg + '</span>';
                // Decoded enum/bool value: "NAME (raw)" or flags "A|B|C (raw)" — tint
                // the name(s) distinctly from the numeric part in parentheses.
                const em = seg.match(/^([A-Za-z_][\\w]*(?:\\|[A-Za-z_][\\w]*)*) (\\(.+\\))$/);
                if (em) return '<span class="wenum">' + em[1] + '</span> ' + em[2];
                // Pointer values lead with their type: "*item → $0421"
                return seg.replace(/^(\\*[A-Za-z_]\\w*)/, '<span class="wtype">$1</span>');
            }
            return seg;
        }).join('  ');
    }
    // One node = one row; expanded children recurse, each depth level adds an
    // indent-guide slot whose vertical line shows the expanded scope.
    // Only top-level rows get the remove x; expandables get a twisty.
    function wnode(n, depth, removable) {
        const twisty = n.canExpand
            ? '<span class="wt" data-path="' + escW(n.path) + '" data-open="' + (n.expanded ? '1' : '0') + '">'
              + (n.expanded ? '\\u25BE' : '\\u25B8') + '</span>'
            : '<span class="wt"></span>';
        const x = removable ? '<span class="wx" data-expr="' + escW(n.label) + '">\\u00D7</span>' : '';
        let val;
        if (watchNoSession) val = '<span class="wv idle">(no session)</span>';
        else if (n.owners !== undefined) val = '<span class="wv idle">' + escW(n.owners) + '</span>';
        else {
            const mod = !watchStale && prevWatchVals[n.path] !== undefined && prevWatchVals[n.path] !== n.value;
            newVals[n.path] = n.value;
            val = '<span class="wv' + (n.error ? ' err' : mod ? ' mod' : '') + '">'
                + (n.error ? escW(n.value) : colorVal(n.value)) + '</span>';
        }
        let guides = '';
        for (let i = 0; i < depth; i++) guides += '<span class="wg"></span>';
        // Top-level symbol rows are clickable to jump to their definition (like the search
        // results); computed/child rows have no single source, so stay plain.
        const linkable = depth === 0 && n.source && n.source.file;
        const nameCls = linkable ? 'wn sym-link' : 'wn';
        const nameAttrs = linkable ? ' data-file="' + escW(n.source.file) + '" data-line="' + n.source.line + '"' : '';
        let html = '<div class="wrow">' + guides + twisty
            + '<span class="' + nameCls + '"' + nameAttrs + '>' + escW(n.label) + '</span>' + x + ' = ' + val + '</div>';
        if (n.expanded && n.children)
            for (const c of n.children) html += wnode(c, depth + 1, false);
        return html;
    }
    let html = watchActive.map(n => wnode(n, 0, true)).join('');
    if (watchInactive.length) {
        html += '<details' + (watchInactiveOpen ? ' open' : '') + '><summary>Inactive (' + watchInactive.length + ')</summary>'
            + watchInactive.map(n => wnode(n, 0, true)).join('')
            + '</details>';
    }
    watchSec.innerHTML = html;
    const det = watchSec.querySelector('details');
    if (det) det.addEventListener('toggle', ev => { watchInactiveOpen = ev.target.open; });
    prevWatchVals = newVals;
}

watchSec.addEventListener('click', e => {
    const link = e.target.closest('.sym-link[data-file]');
    if (link) { vscode.postMessage({ type: 'gotoSymbol', file: link.dataset.file, line: parseInt(link.dataset.line, 10) }); return; }
    const x = e.target.closest('.wx[data-expr]');
    if (x) { vscode.postMessage({ type: 'watchRemove', expr: x.dataset.expr }); return; }
    const t = e.target.closest('.wt[data-path]');
    if (t) vscode.postMessage({ type: t.dataset.open === '1' ? 'watchCollapse' : 'watchExpand', path: t.dataset.path });
});

window.addEventListener('message', e => {
    if (e.data.type === 'symbols') {
        if (e.data.data) {
            // Update prevValues from old data before replacing
            if (allSymbols) {
                const pv = {};
                for (const s of allSymbols) pv[s.name] = valueKey(s);
                prevValues = pv;
            }
            allSymbols = e.data.data;
        } else {
            allSymbols = null;
            prevValues = {};
        }
        render();
    } else if (e.data.type === 'watch') {
        watchActive = e.data.active || [];
        watchInactive = e.data.inactive || [];
        watchNoSession = !!e.data.noSession;
        watchStale = !!e.data.stale;
        // Watch values arrive on every step — only re-render the (heavy)
        // symbol table when the watched SET changed (a dot must flip).
        const newSet = new Set([...watchActive.map(it => it.path), ...watchInactive.map(it => it.path)]);
        const setChanged = newSet.size !== watchedSet.size || [...newSet].some(x => !watchedSet.has(x));
        watchedSet = newSet;
        renderWatch();
        if (setChanged) render();
    } else if (e.data.type === 'mru') {
        mruItems = (e.data.items || []).slice(0, MRU_MAX);
    } else if (e.data.type === 'symBpMarks') {
        const next = new Set((e.data.addrs || []));
        const changed = next.size !== bpMarks.size || [...next].some(a => !bpMarks.has(a));
        bpMarks = next;
        if (changed) render();   // flip the bp dots
    }
});
vscode.postMessage({ type: 'mruGet' }); // load the persisted search history
</script>
</body></html>`;
}

// ----------------------------------------------------------------
// Collaborative MCP bridge — let an external MCP client share the LIVE debug session, so the
// human and the AI look at ONE screen / one set of breakpoints / one CPU. Observation is
// always open to both; execution control (pause/continue/step/breakpoints/warp/AI-keys) is
// gated on who holds control. The human's OWN keyboard goes through the Screen View webview,
// never through the bridge, so it's never blocked. See mcp/bridge-server.cjs.
// ----------------------------------------------------------------
// Keep the viz stream alive while the bridge is up (AI screenshots/frames work with no panel open).
const bridgeVizConsumer = { postFrame() {}, postStatus() {}, postError() {} };

function bridgeUpdateStatusBar() {
    if (!bridgeStatusBar) return;
    // Visible whenever the bridge is up OR a session is active, so you can always SEE the state
    // (off / you-pilot / AI-pilots) — the label itself carries it (no tooltip needed).
    if (!bridgeServer && !oricSessionActive) { bridgeStatusBar.hide(); return; }
    if (!bridgeServer) {
        bridgeStatusBar.text = '$(broadcast) AI bridge: off';
        bridgeStatusBar.tooltip = 'AI collaboration bridge is OFF. Click to start sharing this session with an MCP assistant.';
        bridgeStatusBar.backgroundColor = undefined;
        bridgeStatusBar.show();
        return;
    }
    const ai = bridgeControl === BRIDGE_CONTROL.AI;
    bridgeStatusBar.text = ai ? '$(hubot) AI bridge: AI piloting' : '$(broadcast) AI bridge: you piloting';
    bridgeStatusBar.tooltip = ai
        ? 'The AI holds debug control (pause/continue/step/breakpoints). Click to TAKE CONTROL. You can always type into the Screen View and inspect.'
        : 'Bridge on — you hold debug control; the AI can observe but not drive until it requests control. Click for bridge options.';
    bridgeStatusBar.backgroundColor = ai ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    bridgeStatusBar.show();
}

// Flip control ownership + reflect it everywhere (status bar, Screen View OSD, connected clients).
function setBridgeControl(owner) {
    bridgeControl = (owner === BRIDGE_CONTROL.AI) ? BRIDGE_CONTROL.AI : BRIDGE_CONTROL.HUMAN;
    bridgeUpdateStatusBar();
    postScreenRunState();
    if (bridgeServer) bridgeServer.broadcast('control', { control: bridgeControl });
}

// The injected surface the bridge server proxies to (everything routes through the live
// session's customRequest + the extension's already-multiplexed viz).
function bridgeDeps() {
    return {
        customRequest: (cmd, args) => {
            const s = vscode.debug.activeDebugSession;
            if (!s || s.type !== 'oric-debug') return Promise.reject(new Error('NO_SESSION'));
            return s.customRequest(cmd, args);
        },
        hasSession: () => { const s = vscode.debug.activeDebugSession; return !!(s && s.type === 'oric-debug'); },
        vizFrame: () => vizLastFrame,
        vizScreen: () => vizLastScrB64 || null,
        vizMeta: () => ({ frame: vizLastFrame, vidMode: vizLastVidMode, vidAddr: vizLastVidAddr }),
        vizInput: buf => vizSendInput(buf),
        // Breakpoints via VS Code's OWN model so the AI manages the SAME ones shown in the panel
        // (and VS Code re-syncs the adapter). Clears the panel too — not just an adapter-side set.
        bpList: () => vscode.debug.breakpoints
            .filter(b => b instanceof vscode.SourceBreakpoint)
            .map(b => ({ file: b.location.uri.fsPath, line: b.location.range.start.line + 1, condition: b.condition || null, enabled: b.enabled })),
        bpSet: (file, line, condition) => {
            if (!file || !line) return { ok: false, error: 'file and line required' };
            const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(line - 1, 0)), true, condition || undefined);
            vscode.debug.addBreakpoints([bp]);
            return { ok: true };
        },
        bpClearAll: file => {
            const all = vscode.debug.breakpoints;
            const target = file
                ? all.filter(b => b instanceof vscode.SourceBreakpoint && (b.location.uri.fsPath === file || nodePath.basename(b.location.uri.fsPath) === file))
                : all;   // no file → remove EVERYTHING (source + function breakpoints)
            vscode.debug.removeBreakpoints(target);
            return { removed: target.length };
        },
        getState: () => ({ stopped: oricDebugStopped, userPaused: oricUserPaused, warp: oricWarpOn, module: activeOricModuleId }),
        getControl: () => bridgeControl,
        setControl: o => setBridgeControl(o),
        sessionName: () => { const s = vscode.debug.activeDebugSession; return s ? s.name : null; },
        log: m => { if (vizOutputChannel) vizOutputChannel.appendLine('[BRIDGE] ' + m); },
    };
}

async function toggleMcpBridge() {
    if (bridgeServer) { stopMcpBridge(); vscode.window.showInformationMessage('Oric: AI collaboration bridge stopped.'); return; }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) { vscode.window.showErrorMessage('Oric: open the project folder first (nowhere to advertise the bridge).'); return; }
    const fs = require('fs'); const path = require('path');
    bridgeServer = createBridgeServer(bridgeDeps());
    let port;
    try { port = await bridgeServer.listen(0); }
    catch (e) { bridgeServer = null; vscode.window.showErrorMessage('Oric: could not start the bridge — ' + (e.message || e)); return; }
    bridgeControl = BRIDGE_CONTROL.HUMAN;
    vizRegisterConsumer(bridgeVizConsumer);
    // Advertise the port in each workspace folder so the MCP (cwd = project root) finds it.
    const info = JSON.stringify({ port, host: '127.0.0.1', pid: process.pid }) + '\n';
    for (const f of folders) {
        try { const p = path.join(f.uri.fsPath, DISCOVERY_FILE); fs.writeFileSync(p, info); bridgeDiscoveryPaths.push(p); } catch (_) {}
    }
    bridgeUpdateStatusBar();
    vscode.window.showInformationMessage('Oric: AI collaboration bridge live (127.0.0.1:' + port + '). In your assistant, call oric_attach. You hold control until the AI requests it.');
}

function stopMcpBridge() {
    const fs = require('fs');
    for (const p of bridgeDiscoveryPaths) { try { fs.unlinkSync(p); } catch (_) {} }
    bridgeDiscoveryPaths.length = 0;
    try { vizUnregisterConsumer(bridgeVizConsumer); } catch (_) {}
    if (bridgeServer) { bridgeServer.close(); bridgeServer = null; }
    bridgeControl = BRIDGE_CONTROL.HUMAN;
    bridgeUpdateStatusBar();
    postScreenRunState();
}

// ----------------------------------------------------------------
// MCP server registration — write/merge .mcp.json for Claude Code, then health-check.
// ----------------------------------------------------------------
//
// Claude Code discovers MCP servers from a plain-JSON `.mcp.json` at the project root, so
// registering is just merging in our `oric` entry (pointing at the server shipped inside this
// extension). We then run the REAL MCP handshake against it (mcp/validate.cjs) so the user gets
// "registered AND proven healthy — N tools", not just a file written. We can't force Claude Code
// to ingest it (it reads .mcp.json at session start), so we tell the user to run /mcp / restart.
// Add the Oric MCP server's allow rules to a Claude Code settings FILE so the assistant isn't
// prompted ("Do you want to proceed?") per tool call. Writes BOTH documented server-wide forms —
// the bare `mcp__<name>` and the anchored wildcard `mcp__<name>__*` (each matches ALL of that
// server's tools per the docs; only an unanchored `mcp__*` is ignored — and note the prompt
// DISPLAYS single underscores but the real format is double) — and removes any prior per-tool /
// duplicate rules for this server. Two things the caller must know: (1) Claude Code loads
// permissions at SESSION START, so a FRESH session is required; (2) PROJECT `.claude/settings.json`
// is only honored for a TRUSTED workspace, whereas USER `~/.claude/settings.json` is ALWAYS loaded
// — so the caller writes both. Non-fatal — returns {ok,error}.
function addMcpAllowRule(settingsFile, serverName) {
    const fs = require('fs'); const path = require('path');
    const prefix = 'mcp__' + serverName + '__';   // e.g. mcp__oric__
    const wildcard = prefix + '*';                 // mcp__oric__*  (anchored wildcard)
    const bare = 'mcp__' + serverName;             // mcp__oric     (bare server name)
    let s = {};
    if (fs.existsSync(settingsFile)) {
        try { s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; }
        catch (e) { return { ok: false, error: path.basename(settingsFile) + ' is not valid JSON (' + (e.message || e) + ')' }; }
    }
    if (!s.permissions || typeof s.permissions !== 'object') s.permissions = {};
    const allow = Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
    const isOurs = r => typeof r === 'string' && (r === bare || r.indexOf(prefix) === 0);   // any rule for this server
    const kept = allow.filter(r => !isOurs(r));
    kept.push(bare, wildcard);
    s.permissions.allow = kept;
    try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2) + '\n', 'utf8'); }
    catch (e) { return { ok: false, error: (e.message || String(e)) }; }
    return { ok: true };
}

async function registerMcpServerFlow(context) {
    const fs = require('fs');
    const path = require('path');
    const serverPath = path.join(context.extensionPath, 'mcp', 'oric-mcp-server.cjs');
    if (!fs.existsSync(serverPath)) {
        vscode.window.showErrorMessage('Oric MCP: server not found at ' + serverPath);
        return;
    }

    // Pick the target workspace folder (the project whose .mcp.json we write).
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) {
        vscode.window.showErrorMessage('Oric MCP: open a project folder first (nowhere to write .mcp.json).');
        return;
    }
    let folder = folders[0];
    if (folders.length > 1) {
        const pick = await vscode.window.showQuickPick(
            folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
            { title: 'Register Oric MCP server in which project?', ignoreFocusOut: true });
        if (!pick) return;
        folder = pick.folder;
    }
    const mcpPath = path.join(folder.uri.fsPath, '.mcp.json');

    // Read + merge (preserve any other servers the user already registered).
    let cfg = { mcpServers: {} };
    if (fs.existsSync(mcpPath)) {
        try { cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) || {}; }
        catch (e) {
            const go = await vscode.window.showWarningMessage(
                '.mcp.json exists but is not valid JSON (' + (e.message || e) + '). Overwrite it with a fresh Oric entry?',
                { modal: true }, 'Overwrite');
            if (go !== 'Overwrite') return;
            cfg = { mcpServers: {} };
        }
        if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
    }
    cfg.mcpServers.oric = { command: 'node', args: [serverPath] };
    try { fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); }
    catch (e) { vscode.window.showErrorMessage('Oric MCP: could not write ' + mcpPath + ' — ' + (e.message || e)); return; }

    // Health-check it the way an MCP client would (spawn + initialize + tools/list). This also
    // yields the tool list so the allowlist can enumerate every tool.
    let result;
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Oric MCP: validating server…' },
        async () => { try { result = await require('./mcp/validate.cjs').validateServer(serverPath); } catch (e) { result = { ok: false, error: e.message || String(e) }; } });

    // Pre-approve the server's tools so the assistant isn't prompted per call. Write to BOTH:
    //  - USER settings (~/.claude/settings.json): ALWAYS loaded, so it works even when the folder
    //    isn't "trusted" in Claude Code (an untrusted folder's PROJECT settings are IGNORED — that
    //    trap cost a long debugging detour);
    //  - PROJECT settings (.claude/settings.json): applies once the folder is trusted / for teammates.
    const userSettings = path.join(require('os').homedir(), '.claude', 'settings.json');
    const projectSettings = path.join(folder.uri.fsPath, '.claude', 'settings.json');
    const rUser = addMcpAllowRule(userSettings, 'oric');
    const rProj = addMcpAllowRule(projectSettings, 'oric');
    const allowMsg = rUser.ok
        ? ' Pre-approved mcp__oric__* in your user settings (always loaded)' + (rProj.ok ? ' + the project settings' : '') + ' — start a FRESH Claude session to load it (no per-tool prompts).'
        : (rProj.ok
            ? ' Pre-approved mcp__oric__* in the project settings (NOTE: applies only to a trusted workspace) — start a fresh session.'
            : ' (Could not pre-approve tools: ' + (rUser.error || rProj.error) + ' — you may be prompted per tool.)');

    const rel = vscode.workspace.asRelativePath(mcpPath);
    if (result && result.ok) {
        const action = await vscode.window.showInformationMessage(
            'Oric MCP registered in ' + rel + ' and validated — ' + result.count + ' tools healthy.' + allowMsg,
            'Show .mcp.json');
        if (action === 'Show .mcp.json') vscode.window.showTextDocument(vscode.Uri.file(mcpPath));
    } else {
        vscode.window.showWarningMessage(
            'Oric MCP: wrote ' + rel + ', but the server FAILED validation — ' + (result && result.error || 'unknown error') +
            '. The entry is written; fix the server before using it.');
    }
}

// ----------------------------------------------------------------
// Extension activation
// ----------------------------------------------------------------

function activate(context) {
    // --- Conflict detection: warn if jede.osdk is also installed ---
    const conflicting = vscode.extensions.getExtension('jede.osdk');
    if (conflicting) {
        vscode.window.showWarningMessage(
            'The "jede.osdk" extension conflicts with this OSDK extension (duplicate language ID and grammar scope). Disable or uninstall it to avoid unpredictable syntax coloring.',
            'Show Extension', 'Ignore'
        ).then(choice => {
            if (choice === 'Show Extension') {
                vscode.commands.executeCommand('extension.open', 'jede.osdk');
            }
        });
    }

    // --- Ensure .s and .asm files are associated with our language ---
    const filesConfig = vscode.workspace.getConfiguration('files');
    const globalAssoc = filesConfig.get('associations') || {};
    let globalNeedsUpdate = false;
    for (const ext of ['*.s', '*.asm']) {
        if (globalAssoc[ext] !== 'osdk') {
            globalAssoc[ext] = 'osdk';
            globalNeedsUpdate = true;
        }
    }
    if (globalNeedsUpdate) {
        filesConfig.update('associations', globalAssoc, vscode.ConfigurationTarget.Global);
    }

    // --- Merge our Oric terms into spell checker ---
    const oricWords = [
        'ACIA', 'Arkos', 'Atmos',
        'endif', 'elif', 'elseif', 'ifdef', 'ifndef', 'undef',
        'Chema', 'Cumana', 'Cumulus',
        'Defence', 'DDENS', 'DDRA', 'DDRB', 'DRQ',
        'EPROM', 'Erebus', 'Euphoric',
        'HIRES', 'INTRQ', 'IRQ',
        'Jasmin', 'Loci', 'LORES',
        'Microdisc', 'NMI', 'NOTRDY',
        'ORA2', 'ORB', 'Oric', 'Oricutron', 'osdk', 'OSDK',
        'PCR', 'PSG', 'ROMDIS', 'RST',
        'Sedoric', 'Stratsed',
        'Telestrat', 'Twilight',
        'VIA', 'WRPROT', 'WRTERR'
    ];
    const cspell = vscode.workspace.getConfiguration('cSpell');
    const existing = new Set((cspell.get('words') || []).map(w => w.toLowerCase()));
    const toAdd = oricWords.filter(w => !existing.has(w.toLowerCase()));
    if (toAdd.length > 0) {
        cspell.update('words', [...(cspell.get('words') || []), ...toAdd], vscode.ConfigurationTarget.Global);
    }
    // Ignore 6502-style hex ($BFDF) and binary (%10110011) literals
    const ignorePatterns = ['\\$[0-9A-Fa-f]+', '%[01]+'];
    const existingPatterns = cspell.get('ignoreRegExpList') || [];
    const patternsToAdd = ignorePatterns.filter(p => !existingPatterns.includes(p));
    if (patternsToAdd.length > 0) {
        cspell.update('ignoreRegExpList', [...existingPatterns, ...patternsToAdd], vscode.ConfigurationTarget.Global);
    }

    // --- OSDK project detection: also claim .h files in OSDK workspaces ---
    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            const osdkConfig = vscode.Uri.joinPath(folder.uri, 'osdk_config.bat');
            vscode.workspace.fs.stat(osdkConfig).then(() => {
                const wsAssoc = filesConfig.inspect('associations');
                const current = (wsAssoc && wsAssoc.workspaceFolderValue) || {};
                if (current['*.h'] !== 'osdk') {
                    current['*.h'] = 'osdk';
                    filesConfig.update('associations', current, vscode.ConfigurationTarget.WorkspaceFolder);
                }
            }, () => { /* not an OSDK project, skip */ });
        }
    }

    // --- Debug configuration validation ---
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('oric-debug', {
            async resolveDebugConfiguration(folder, config, token) {
                // Warn if user has attach config but likely wants launch
                if (config.request === 'attach' && config.emulatorPath) {
                    vscode.window.showWarningMessage(
                        'This debug config has "request": "attach" but also specifies emulatorPath. ' +
                        'Change to "request": "launch" to auto-launch Oricutron.');
                }
                // Warn if launch config is missing required fields
                if (config.request === 'launch') {
                    if (config.launchScript) {
                        // Script-launch relies on the OSDK toolchain (osdk_execute.bat,
                        // %OSDK%\Oricutron, libraries). Bail early with a clear message
                        // if the SDK isn't installed/configured.
                        if (!process.env.OSDK) {
                            vscode.window.showErrorMessage(
                                'The OSDK environment variable is not set — the Oric SDK does not appear to be ' +
                                'installed/configured. Set %OSDK% to your OSDK folder (and restart VS Code) to debug.');
                            return undefined;
                        }
                    } else {
                        if (!config.emulatorPath) {
                            vscode.window.showErrorMessage(
                                'Launch config is missing "emulatorPath" (or "launchScript"). Set it to the Oricutron executable path.');
                            return undefined; // abort launch
                        }
                        // diskImage is optional: if unset, the debug adapter auto-detects
                        // the build output (newest .dsk, else newest .tap under build/).
                        // Don't pre-check here — variable substitution (e.g.
                        // ${workspaceFolder}) hasn't fully resolved at this point, so a
                        // host-side build/ scan would look in the wrong place. Let the
                        // launch proceed; the DA resolves paths correctly and reports if it
                        // genuinely can't find any media.
                    }
                }
                // Auto-pick a free GDB port when none is configured (missing or 0).
                // Nothing needs to be set in osdk_config.bat: the adapter spawns
                // Oricutron with --gdb_port <this> and the viz stream uses <this>+16.
                // An explicit non-zero port is always respected. Attach configs keep
                // whatever port they name (they connect to an already-running stub).
                if (config.request === 'launch' && !config.port) {
                    config.port = await findFreeGdbPort();
                    if (config.port)
                        vizLog('Auto-selected free GDB port ' + config.port + ' (viz at ' + (config.port + VIZ_PORT_OFFSET) + ')');
                    else
                        vizLog('Could not auto-select a GDB port; adapter will use its default');
                }

                // Log verbosity precedence: a persisted per-project choice wins;
                // otherwise an explicit launch.json value; otherwise Normal (1).
                const persistedLevel = context.workspaceState.get(LOG_LEVEL_KEY);
                if (typeof persistedLevel === 'number') {
                    config.logLevel = persistedLevel;
                } else if (config.logLevel === undefined) {
                    config.logLevel = 1;
                }
                // Seed the binary-column preference from the global setting so the
                // adapter starts with it applied.
                if (config.showBinary === undefined)
                    config.showBinary = vscode.workspace.getConfiguration('oric-debug').get('showBinary', true);
                return config;
            }
        })
    );

    vizOutputChannel = vscode.window.createOutputChannel('Oric Debug');
    context.subscriptions.push(vizOutputChannel);

    // --- Scan workspace for #define directives ---
    scanDefines();

    // --- Cycle annotation decorations ---
    const cycleDecorationType = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
            margin: '0 0 0 2em'
        },
        isWholeLine: true
    });
    // Map<filePath, Map<lineNumber, { cycles, symbol }>>
    const cycleAnnotations = new Map();

    // --- Unverified-breakpoint gutter badge ---
    // VS Code's native red gutter dot is DA-driven and reverts to red when no
    // session asserts verified:false. The host can't change the dot, but it CAN
    // layer a decoration icon on top — this warning badge marks a breakpoint that
    // won't bind (e.g. a .c line built without -g1) while keeping the red dot
    // visible. Fed from rebuildBpTree's daVerified signal.
    const unverifiedBpDecoType = vscode.window.createTextEditorDecorationType({
        // Yellow ! in the glyph margin marks a breakpoint that won't bind (e.g. a .c
        // line built without -g1). VS Code's own red dot sits in the line-number
        // column and can't be host-controlled (its tooltip is DA/session-only, and
        // glyph-margin hovers are shadowed — VS Code issue #5923), so the ! is the
        // host-side visual signal. Explanation is in the ORIC panel tooltip + the
        // debug-console warning on F5.
        gutterIconPath: vscode.Uri.file(context.asAbsolutePath('images/bp-unverified.svg')),
        gutterIconSize: 'contain',
        isWholeLine: true
    });
    // canonPath(filePath) -> Set(requestedLine) for breakpoints that won't bind.
    const unverifiedBpLines = new Map();

    function applyCycleDecorations() {
        for (const editor of vscode.window.visibleTextEditors) {
            const filePath = editor.document.uri.fsPath;
            const fileAnnotations = cycleAnnotations.get(canonPath(filePath));
            if (!fileAnnotations || fileAnnotations.size === 0) {
                editor.setDecorations(cycleDecorationType, []);
                continue;
            }
            const decorations = [];
            for (const [line, info] of fileAnnotations) {
                if (line < 1 || line > editor.document.lineCount) continue;
                const range = new vscode.Range(line - 1, 0, line - 1, 0);
                const cyclesStr = info.cycles.toLocaleString();
                decorations.push({
                    range,
                    renderOptions: {
                        after: { contentText: '\u23F1 ' + cyclesStr + ' cycles' }
                    }
                });
            }
            editor.setDecorations(cycleDecorationType, decorations);
        }
    }

    function clearCycleAnnotations() {
        cycleAnnotations.clear();
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(cycleDecorationType, []);
        }
    }

    // Apply the unverified-bp gutter badge to every visible editor whose file has
    // unverified breakpoint lines. Passing [] clears the badge when a file has none
    // (so re-enabling -g1 and rebuilding removes the badges). Mirrors applyCycleDecorations.
    // Shared explanation for breakpoints that won't bind (used by the gutter hover
    // message and kept in sync with the DA's warning + the ORIC panel tooltip).
    const UNVERIFIED_BP_HOVER = 'This breakpoint won\'t bind: the project was built without -g1, ' +
        'so no C source-line info is present. Add -g1 to OSDKCOMP in osdk_config.bat and rebuild. ' +
        '(Assembly breakpoints are unaffected.)';

    function applyUnverifiedBpDecorations() {
        for (const editor of vscode.window.visibleTextEditors) {
            const lines = unverifiedBpLines.get(canonPath(editor.document.uri.fsPath));
            if (!lines || lines.size === 0) { editor.setDecorations(unverifiedBpDecoType, []); continue; }
            const decos = [];
            for (const ln of lines) {
                if (ln < 1 || ln > editor.document.lineCount) continue;
                decos.push({ range: new vscode.Range(ln - 1, 0, ln - 1, 0), hoverMessage: UNVERIFIED_BP_HOVER });
            }
            editor.setDecorations(unverifiedBpDecoType, decos);
        }
    }

    context.subscriptions.push(
        cycleDecorationType,
        unverifiedBpDecoType,
        vscode.window.onDidChangeVisibleTextEditors(() => { applyCycleDecorations(); applyUnverifiedBpDecorations(); })
    );

    // --- Current-instruction view (bottom-panel webview) ---------------------
    // The resolved-operand annotation for the paused PC can be long and richly
    // structured (dereferences, decoded commands, enum operands). Inline editor
    // text (CodeLens / decorations) can neither wrap nor colour segments, so it
    // lives in a dedicated always-on panel that rewrites in place on each stop —
    // coloured and wrapped, no scrolling log, no hover dependency.
    let instrDecoFile = null;
    let instrDecoLine = -1;
    let instrDecoText = '';
    let instrDecoSrc = '';         // the source-line text at the PC (shown above the decode)
    let instrDecoComment = '';     // trailing comment split off that line (its own row)
    let instrDecoVars = null;      // on a C line: [{expr,value}] auto-decoded like Watch entries
    let instrDecoIsC = false;      // current line is C source (colorize as C, show vars not the asm op)
    let instrDecoDisasm = '';      // the 6502 instruction text at PC (shown below the C decode)
    let currentInstrView = null;   // WebviewView, set once the panel is resolved

    let lastGoodInstr = null;   // last LIVE render that had content, replayed dimmed when not stopped
    function renderCurrentInstr(stale) {
        if (!currentInstrView) return;
        const msg = {
            type: 'instr',
            stale: !!stale,   // keep the content but grey it out when not stopped
            pc: (typeof lastPcAddr === 'number') ? lastPcAddr : null,
            file: instrDecoFile,
            line: instrDecoLine,
            src: instrDecoSrc || '',
            comment: instrDecoComment || '',
            annotation: instrDecoText || '',
            lineVars: instrDecoVars || null,
            isC: instrDecoIsC,
            disasm: instrDecoDisasm || ''
        };
        // Remember the last LIVE render with real content, so markInstrStale can replay
        // it dimmed even if instrDeco* got cleared meanwhile (keeps the line info).
        if (!stale && (msg.annotation || (msg.lineVars && msg.lineVars.length))) lastGoodInstr = msg;
        currentInstrView.webview.postMessage(msg);
    }

    function clearInstrDecoration() {
        instrDecoFile = null;
        instrDecoLine = -1;
        instrDecoText = '';
        instrDecoVars = null;
        instrDecoIsC = false;
        instrDecoDisasm = '';
        instrDecoSrc = '';
        instrDecoComment = '';
        renderCurrentInstr();
    }

    // Keep the last instruction visible but dimmed when not stopped (no clearing), so
    // you can still read what it was after ending the session to fix the issue. Replays
    // the last GOOD render dimmed, so an intermediate empty clear can't wipe the info.
    function markInstrStale() {
        if (!currentInstrView) return;
        if (lastGoodInstr) currentInstrView.webview.postMessage(Object.assign({}, lastGoodInstr, { stale: true }));
        else renderCurrentInstr(true);
    }

    function refreshInstructionAnnotation(session) {
        if (!session || session.type !== 'oric-debug') { markInstrStale(); return; }
        session.customRequest('resolveInstruction').then(resp => {
            const hasVars = resp && resp.lineVars && resp.lineVars.length > 0;
            if (resp && (resp.annotation || hasVars) && resp.file && resp.line > 0) {
                instrDecoFile = resp.file;
                instrDecoLine = resp.line;
                instrDecoText = resp.annotation;
                instrDecoVars = hasVars ? resp.lineVars : null;
                instrDecoIsC = !!resp.isC;
                instrDecoDisasm = resp.disasm || '';
                instrDecoSrc = resp.srcLine || '';
                instrDecoComment = resp.srcComment || '';
                lastPcAddr = resp.pc;
                highlightHeatmapAddr(resp.pc);
                renderCurrentInstr();
            } else {
                if (resp && typeof resp.pc === 'number') {
                    lastPcAddr = resp.pc;
                    highlightHeatmapAddr(resp.pc);
                }
                clearInstrDecoration();
            }
        }).catch(() => { markInstrStale(); });   // session dying (query threw) → keep last-good dimmed, don't clear
    }

    function currentInstrHtml() {
        // .replace(/\r/g,'') guards the CRLF-in-template webview bug: a stray \r
        // inside the delivered <script> can break it silently.
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
            body { font-family: var(--vscode-editor-font-family, monospace);
                   font-size: var(--vscode-editor-font-size, 13px);
                   color: var(--vscode-editor-foreground); padding: 6px 10px; margin: 0; }
            #hdr { color: var(--vscode-descriptionForeground, #808080); font-size: 0.85em; padding-bottom: 5px; margin-bottom: 6px;
                   border-bottom: 1px solid var(--vscode-panel-border, #80808040); }
            #hdr .loc-link { color: var(--vscode-textLink-foreground); cursor: pointer; }
            #hdr .loc-link:hover { text-decoration: underline; }
            #src { white-space: pre-wrap; word-break: break-word; padding-bottom: 6px; margin-bottom: 6px;
                   border-bottom: 1px solid var(--vscode-panel-border, #80808040); opacity: 0.9; }
            #ann { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
            .vrow { white-space: pre; line-height: 1.55; }
            .vrow .op { padding: 0 3px; }
            #asm { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, #80808040);
                   white-space: pre-wrap; word-break: break-word; }
            #asm .lbl { color: var(--vscode-descriptionForeground, #808080); font-size: 0.85em; }
            #asmann { color: var(--vscode-descriptionForeground, #808080); }
            /* Comment green has no workbench color var (it is a TextMate token colour),
               so it stays literal with an explicit light-theme override. */
            #cmt { color: #6A9955; font-style: italic; margin-bottom: 5px;
                   white-space: pre-wrap; word-break: break-word; }
            body.vscode-light #cmt { color: #008000; }
            .empty { color: var(--vscode-descriptionForeground, #808080); font-style: italic; }
            body.stale { opacity: 0.5; filter: grayscale(0.35); }
            /* Token colours = the same theme vars the Symbols/Memory panels use — theme-aware,
               so no manual body.vscode-light overrides are needed. */
            .val { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
            .kw  { color: var(--vscode-debugTokenExpression-type, #c586c0); }
            .sym { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
            .op  { color: var(--vscode-descriptionForeground, #808080); }
            .mne { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
        </style></head><body>
            <div id="hdr"></div>
            <div id="cmt"></div>
            <div id="src"></div>
            <div id="ann"><span class="empty">— no instruction —</span></div>
            <div id="asm" style="display:none"></div>
            <script>
                const vs = acquireVsCodeApi();
                const hdr = document.getElementById('hdr');
                const cmt = document.getElementById('cmt');
                const src = document.getElementById('src');
                const ann = document.getElementById('ann');
                const asm = document.getElementById('asm');
                function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
                function classify(id){
                    if (/^e_/.test(id)) return 'kw';
                    if (id === id.toUpperCase() && /_/.test(id)) return 'kw';
                    return 'sym';
                }
                // Shared token walker: values ($hex/decimal) and operators are fixed;
                // identifiers are classed by the caller (annotation = enum-aware,
                // asm = plain symbols) so both decode consistently.
                function tokenize(text, idClass){
                    const re = /(\\$[0-9A-Fa-f]+)|([A-Za-z_][A-Za-z0-9_.]*)|(\\d+)|(#|→|=|\\||\\+|\\(|\\)|,)/g;
                    let out = '', last = 0, m;
                    while ((m = re.exec(text)) !== null){
                        if (m.index > last) out += esc(text.slice(last, m.index));
                        if (m[1]) out += '<span class="val">' + esc(m[1]) + '</span>';
                        else if (m[2]) out += '<span class="' + idClass(m[2]) + '">' + esc(m[2]) + '</span>';
                        else if (m[3]) out += '<span class="val">' + esc(m[3]) + '</span>';
                        else out += '<span class="op">' + esc(m[4]) + '</span>';
                        last = re.lastIndex;
                    }
                    if (last < text.length) out += esc(text.slice(last));
                    return out;
                }
                function colorize(text){ return tokenize(text, classify); }
                // Watch-style value rows for a C line: each variable expression on
                // the left (padded to align), its decoded value on the right.
                function renderVars(list){
                    let w = 0; for (const r of list) if (r.expr.length > w) w = r.expr.length;
                    let html = '';
                    for (const r of list){
                        const pad = r.expr + ' '.repeat(Math.max(0, w - r.expr.length));
                        html += '<div class="vrow"><span class="sym">' + esc(pad) + '</span><span class="op">=</span>' + colorize(r.value) + '</div>';
                    }
                    return html;
                }
                // Lightweight 6502-asm colouring (not the editor's TextMate grammar):
                // first token = mnemonic, the rest are plain symbols/values/operators.
                function colorizeAsm(text){
                    const mm = text.match(/^(\\s*)([A-Za-z_.][\\w.]*)/);
                    if (!mm) return tokenize(text, function(){ return 'sym'; });
                    return esc(mm[1]) + '<span class="mne">' + esc(mm[2]) + '</span>'
                         + tokenize(text.slice(mm[0].length), function(){ return 'sym'; });
                }
                window.addEventListener('message', function(e){
                    const d = e.data;
                    if (!d || d.type !== 'instr') return;
                    document.body.classList.toggle('stale', !!d.stale);
                    const hasVars = d.lineVars && d.lineVars.length;
                    if (!d.annotation && !hasVars){ hdr.style.display='none'; cmt.style.display='none'; src.style.display='none'; ann.innerHTML='<span class="empty">— no instruction —</span>'; return; }
                    let h = '';
                    if (typeof d.pc === 'number') h += esc('$' + (d.pc & 0xFFFF).toString(16).toUpperCase().padStart(4,'0'));
                    if (d.file && d.line){
                        const base = String(d.file).split(/[\\\\/]/).pop();
                        h += (h?'  ·  ':'') + '<span class="loc-link" data-file="' + esc(String(d.file)) + '" data-line="' + d.line + '">' + esc(base + ':' + d.line) + '</span>';
                    }
                    hdr.innerHTML = h; hdr.style.display = '';
                    cmt.textContent = d.comment || ''; cmt.style.display = d.comment ? '' : 'none';
                    // C source colorizes as C (plain identifiers); asm as a mnemonic line.
                    src.innerHTML = d.isC ? colorize(d.src || '') : colorizeAsm(d.src || ''); src.style.display = d.src ? '' : 'none';
                    // On a C line show the auto-decoded variable values (Watch-style);
                    // otherwise the single-instruction operand decode.
                    ann.innerHTML = hasVars ? renderVars(d.lineVars) : colorize(d.annotation);
                    // On a C line, also show the current 6502 instruction below a
                    // separator, so you still see exactly where you are mid-statement.
                    if (d.isC && d.disasm){
                        let a = '<div class="lbl">current instruction</div>' + colorizeAsm(d.disasm);
                        if (d.annotation) a += '<div id="asmann">' + colorize(d.annotation) + '</div>';
                        asm.innerHTML = a; asm.style.display = '';
                    } else { asm.style.display = 'none'; asm.innerHTML = ''; }
                });
                hdr.addEventListener('click', function(e){
                    const el = e.target.closest('.loc-link[data-file]');
                    if (el) vs.postMessage({ type: 'gotoSymbol', file: el.dataset.file, line: parseInt(el.dataset.line, 10) });
                });
                vs.postMessage({ type: 'ready' });
            </script>
        </body></html>`.replace(/\r/g, '');
    }

    const currentInstrProvider = {
        resolveWebviewView(view) {
            currentInstrView = view;
            view.webview.options = { enableScripts: true };
            view.webview.onDidReceiveMessage(msg => {
                if (msg && msg.type === 'ready') { renderCurrentInstr(); return; }
                if (msg && msg.type === 'gotoSymbol' && msg.file && msg.line > 0) {
                    const uri = vscode.Uri.file(msg.file);
                    vscode.workspace.openTextDocument(uri).then(doc => {
                        vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One }).then(ed => {
                            const line = Math.max(0, msg.line - 1);
                            const range = new vscode.Range(line, 0, line, 0);
                            ed.selection = new vscode.Selection(range.start, range.start);
                            ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                        });
                    }).catch(() => {});
                }
            });
            view.onDidDispose(() => { if (currentInstrView === view) currentInstrView = null; });
            view.webview.html = currentInstrHtml();
        }
    };
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('oricCurrentInstr', currentInstrProvider)
    );

    // --- Oric Breakpoints tree (module-grouped enable/disable) ----------------
    // Source breakpoints grouped by the overlay module that owns their file (the
    // adapter's fileToModules). Three tiers of enable/disable: all (view title),
    // per module (row actions / right-click), per breakpoint (checkbox). Every
    // toggle flips VS Code's own `enabled` flag (remove + re-add), so the native
    // Breakpoints panel stays in sync. Module grouping needs a live oric session
    // (that's where the module map lives); without one it's a flat list.
    let bpTreeModel = { modules: [], grouped: false, addrBps: [] };
    let bpTreeGen = 0;             // rebuild generation — drops superseded async rebuilds
    bpTreeEmitter = new vscode.EventEmitter();

    // Extension-owned watchpoint events (source of truth; the tree reads this list
    // directly). Each: { id, address, size, access:'write'|'read'|'readWrite', module,
    // condition, logMessage, enabled, label }. Restored from workspaceState here.
    let watchBpList = (context.workspaceState.get(WATCH_BP_KEY, []) || []).filter(w => w && typeof w.address === 'number');
    const toAdapterWp = w => ({ id: w.id, addr: w.address, size: w.size || 1, access: w.access || 'write',
        module: w.module == null ? null : w.module, condition: w.condition || null,
        logMessage: w.logMessage || null, enabled: w.enabled !== false });
    // Refresh the tree FIRST (never blocked by the adapter), then persist and push the
    // full set to the adapter fire-and-forget. The adapter arms the module-active ones
    // and handles rearm on module switch itself. A failed push (e.g. a stale adapter
    // without the oricSetWatchpoints handler, or arming while running) is surfaced.
    function pushWatchpoints() {
        bpTreeEmitter.fire();
        context.workspaceState.update(WATCH_BP_KEY, watchBpList);
        const s = vscode.debug.activeDebugSession;
        if (s && s.type === 'oric-debug') {
            s.customRequest('oricSetWatchpoints', { watchpoints: watchBpList.map(toAdapterWp) })
                .then(undefined, e => vscode.window.showWarningMessage('Oric: watchpoint arm failed — ' + (e && e.message ? e.message : String(e)) + ' (is the emulator the conditional-watchpoint build, and the session live?)'));
        }
    }

    // Push the set of addresses that carry an execution breakpoint OR a watchpoint to the
    // Symbols panel, so its per-row breakpoint dots show solid. Union of the adapter-owned
    // address breakpoints (cached in lastAddrBpAddrs, refreshed by rebuildBpTree) and the
    // extension-owned watchpoints.
    refreshSymbolBpMarks = () => {
        if (!symbolsPanel) return;
        const addrs = new Set();
        for (const w of watchBpList) addrs.add(w.address & 0xFFFF);
        for (const a of lastAddrBpAddrs) addrs.add(a & 0xFFFF);
        // Source breakpoints: light the dot for any symbol whose declared line carries one,
        // so a bp set from this panel OR from the editor gutter shows on the row (both ways).
        const srcBps = vscode.debug.breakpoints.filter(b => b instanceof vscode.SourceBreakpoint);
        if (srcBps.length) {
            for (const entry of symbolCache.values()) {
                if (entry.addr < 0 || !entry.source || !entry.source.file || !entry.source.line) continue;
                const line0 = entry.source.line - 1;
                if (srcBps.some(b => b.location.range.start.line === line0 &&
                        canonPath(b.location.uri.fsPath) === canonPath(entry.source.file)))
                    addrs.add(entry.addr & 0xFFFF);
            }
        }
        symbolsPanel.webview.postMessage({ type: 'symBpMarks', addrs: [...addrs] });
    };

    // Perform a breakpoint action requested from a Symbols-panel row. All three actions are
    // address-keyed so the row dot stays accurate: execute = an adapter-owned ADDRESS
    // (execution) breakpoint; change/access = a watchpoint (write / read+write) sized to the
    // symbol; remove = clear whichever is set at that address.
    handleSymBpAction = async (msg) => {
        const addr = msg.addr & 0xFFFF;
        const size = msg.size || 1;
        const label = msg.name || null;
        const session = vscode.debug.activeDebugSession;
        const liveOric = session && session.type === 'oric-debug';
        const addrBpPresent = async () => {
            if (!liveOric) return false;
            try { const r = await session.customRequest('listAddressBreakpoints', {}); return !!(r && r.breakpoints && r.breakpoints.some(b => (b.address & 0xFFFF) === addr)); }
            catch (e) { return false; }
        };
        // Find an existing SOURCE breakpoint at the symbol's declared line (if any).
        const findSrcBp = () => {
            if (!(msg.file && msg.line > 0)) return null;
            const uri = vscode.Uri.file(msg.file), line0 = msg.line - 1;
            return vscode.debug.breakpoints.find(bp => bp instanceof vscode.SourceBreakpoint &&
                canonPath(bp.location.uri.fsPath) === canonPath(uri.fsPath) &&
                bp.location.range.start.line === line0) || null;
        };
        if (msg.action === 'execute') {
            // Prefer a real SOURCE breakpoint (visible in the editor gutter, and the SAME
            // object a gutter click would make — so no duplicate) when the symbol maps to
            // source; fall back to an adapter-owned address bp only for source-less symbols.
            if (msg.file && msg.line > 0) {
                if (!findSrcBp()) vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(
                    new vscode.Location(vscode.Uri.file(msg.file), new vscode.Position(msg.line - 1, 0)))]);
            } else if (liveOric) {
                if (!(await addrBpPresent())) await session.customRequest('toggleAddressBreakpoint', { address: addr }).catch(() => {});
            } else {
                vscode.window.showInformationMessage('Start a debug session to set an execution breakpoint (this symbol has no source line).');
            }
        } else if (msg.action === 'change' || msg.action === 'access') {
            const access = msg.action === 'change' ? 'write' : 'readWrite';
            if (!watchBpList.some(w => (w.address & 0xFFFF) === addr && w.access === access)) {
                watchBpList.push({ id: 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
                    address: addr, size, access, module: null, condition: null, logMessage: null, enabled: true, label });
                pushWatchpoints();
                if (!liveOric) vscode.window.showInformationMessage('Watchpoint added — will arm when you start debugging.');
            }
        } else if (msg.action === 'remove') {
            const before = watchBpList.length;
            watchBpList = watchBpList.filter(w => (w.address & 0xFFFF) !== addr);
            if (watchBpList.length !== before) pushWatchpoints();
            const sb = findSrcBp();
            if (sb) vscode.debug.removeBreakpoints([sb]);
            if (await addrBpPresent()) await session.customRequest('toggleAddressBreakpoint', { address: addr }).catch(() => {});
        }
        if (refreshSymbolBpMarks) refreshSymbolBpMarks();
    };
    // Resolve a watch target: "$BFED"/"0xBFED" = hex addr, bare digits = decimal addr
    // (the no-implicit-hex rule), anything else = a symbol resolved via the adapter.
    async function resolveWatchTarget(t) {
        t = (t || '').trim();
        let m;
        if ((m = t.match(/^\$([0-9a-fA-F]{1,4})$/)) || (m = t.match(/^0x([0-9a-fA-F]{1,4})$/i)))
            return { address: parseInt(m[1], 16) & 0xFFFF, label: null };
        if (/^[0-9]+$/.test(t)) return { address: parseInt(t, 10) & 0xFFFF, label: null };
        const s = vscode.debug.activeDebugSession;
        if (!s || s.type !== 'oric-debug') { vscode.window.showErrorMessage('Start a debug session to resolve symbol "' + t + '", or enter a $address.'); return null; }
        try { const r = await s.customRequest('dataBreakpointInfo', { name: t }); if (r && r.dataId) return { address: parseInt(r.dataId, 16) & 0xFFFF, label: t }; } catch (_) { /* fall through */ }
        vscode.window.showErrorMessage('Could not resolve "' + t + '" to an address.');
        return null;
    }
    async function addWatchpointFlow() {
        const input = await vscode.window.showInputBox({ title: 'Add watchpoint', prompt: 'Address ($BFED / 0xBFED) or symbol (_gSoundEnabled)', ignoreFocusOut: true });
        if (input == null || !input.trim()) return;
        const tgt = await resolveWatchTarget(input);
        if (!tgt) return;
        const acc = await vscode.window.showQuickPick(
            [{ label: 'Write', v: 'write' }, { label: 'Read', v: 'read' }, { label: 'Read + Write', v: 'readWrite' }],
            { title: 'Break when the memory is…', ignoreFocusOut: true });
        if (!acc) return;
        const sizeStr = await vscode.window.showInputBox({ title: 'Size (bytes)', value: '1', ignoreFocusOut: true, validateInput: v => (/^[1-9][0-9]*$/.test((v || '').trim()) ? null : 'positive integer') });
        if (sizeStr == null) return;
        const condition = ((await vscode.window.showInputBox({ title: 'Condition (optional)', prompt: 'e.g.  A == $10 && *$91 != 0   — blank = always', ignoreFocusOut: true })) || '').trim() || null;
        const logMessage = ((await vscode.window.showInputBox({ title: 'Log message (optional)', prompt: 'Printed on hit; {expr} interpolates; [save] snapshot, [stop] break, [signal:id] fire a signal a script can await. Blank = stop only.', ignoreFocusOut: true })) || '').trim() || null;
        watchBpList.push({
            id: 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
            address: tgt.address, size: parseInt(sizeStr, 10) || 1, access: acc.v,
            module: null, condition, logMessage, enabled: true, label: tgt.label || null,
        });
        await pushWatchpoints();
        const hx = '$' + (tgt.address & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
        vscode.window.showInformationMessage('Watchpoint added: ' + hx + ' [' + acc.v + ']' + (condition ? ' if ' + condition : '') +
            (vscode.debug.activeDebugSession ? '' : ' — will arm when you start debugging'));
    }
    function removeWatchpoint(node) {
        if (!node || !node.w) return;
        watchBpList = watchBpList.filter(w => w.id !== node.w.id);
        pushWatchpoints();
    }
    // Edit ONE property of a watchpoint in place (no delete/re-add). `w` is the live
    // list entry; mutating it + pushWatchpoints() re-arms and refreshes the tree.
    async function editWatchProp(w, prop) {
        if (!w) return;
        if (prop === 'access') {
            const acc = await vscode.window.showQuickPick(
                [{ label: 'Write', v: 'write' }, { label: 'Read', v: 'read' }, { label: 'Read + Write', v: 'readWrite' }],
                { title: 'Break when the memory is…', ignoreFocusOut: true });
            if (!acc) return; w.access = acc.v;
        } else if (prop === 'size') {
            const v = await vscode.window.showInputBox({ title: 'Size (bytes)', value: String(w.size || 1), ignoreFocusOut: true, validateInput: x => (/^[1-9][0-9]*$/.test((x || '').trim()) ? null : 'positive integer') });
            if (v == null) return; w.size = parseInt(v, 10) || 1;
        } else if (prop === 'condition') {
            const v = await vscode.window.showInputBox({ title: 'Condition', value: w.condition || '', prompt: 'e.g.  A == $10 && *$91 != 0   — blank to clear', ignoreFocusOut: true });
            if (v === undefined) return; w.condition = v.trim() || null;
        } else if (prop === 'logMessage') {
            const v = await vscode.window.showInputBox({ title: 'Log message', value: w.logMessage || '', prompt: '{expr} interpolates; [save] snapshot, [stop] break, [signal:id] fire a signal a script can await. Blank to clear.', ignoreFocusOut: true });
            if (v === undefined) return; w.logMessage = v.trim() || null;
        } else return;
        pushWatchpoints();
    }
    // Main-row pencil: pick which property to edit (mirrors the exec-bp bpEdit picker).
    async function editWatchpoint(node) {
        const w = node && node.w && watchBpList.find(x => x.id === node.w.id);
        if (!w) return;
        const items = [
            { label: 'Access', description: w.access, prop: 'access' },
            { label: 'Size', description: String(w.size || 1), prop: 'size' },
            { label: 'Condition', description: w.condition || '(none)', prop: 'condition' },
            { label: 'Log message', description: w.logMessage || '(none)', prop: 'logMessage' },
        ];
        const hx = '$' + (w.address & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
        const pick = await vscode.window.showQuickPick(items, { title: 'Edit watchpoint ' + hx, ignoreFocusOut: true });
        if (pick) await editWatchProp(w, pick.prop);
    }

    // Toggle by LOCATION against the LIVE breakpoint list, not the passed model
    // instances (which may be stale between a change and the tree rebuild). This
    // is idempotent: a breakpoint in a file shared by two modules is the SAME
    // object, so toggling either module — even in quick succession — converges
    // instead of re-adding a duplicate.
    const bpKey = bp => bp.location.uri.fsPath + ':' + bp.location.range.start.line + ':' + bp.location.range.start.character;
    function setBpsEnabled(targets, enabled) {
        const keys = new Set(targets.map(bpKey));
        const rem = [], add = [];
        for (const bp of vscode.debug.breakpoints) {
            if (!(bp instanceof vscode.SourceBreakpoint) || !keys.has(bpKey(bp)) || bp.enabled === enabled) continue;
            rem.push(bp);
            add.push(new vscode.SourceBreakpoint(bp.location, enabled, bp.condition, bp.hitCondition, bp.logMessage));
        }
        if (rem.length) { vscode.debug.removeBreakpoints(rem); vscode.debug.addBreakpoints(add); }
    }

    // Editing breakpoints straight from the Oric panel (no need to hunt for the
    // gutter's native "Edit Breakpoint"). Each edit re-creates VS Code's own
    // SourceBreakpoint with the one property changed, keeping the rest — so the
    // native panel and the adapter (which re-sends condition/hitCount on change)
    // stay in sync. Works with or without a live session.
    const PROP_META = {
        condition:    { label: 'Condition',   prompt: 'Break only when this holds — leave blank to clear', ph: 'e.g.  g_score > 100   ·   e->hp == 0   ·   g_entities[i].kind == KIND_DRAGON' },
        hitCondition: { label: 'Hit Count',    prompt: 'Break on/after the Nth hit — leave blank to clear',  ph: 'e.g.  5' },
        logMessage:   { label: 'Log Message',  prompt: 'Print on hit and keep running; {expr} interpolates; [stop] break, [signal:id] fire a script signal — leave blank to clear', ph: 'e.g.  reached start, i={i}, hp={e->hp}  [stop]' }
    };
    const propVal = (bp, prop) => prop === 'condition' ? bp.condition : prop === 'hitCondition' ? bp.hitCondition : bp.logMessage;
    function updateBpProps(bps, changes) {
        const keys = new Set(bps.map(bpKey));
        const rem = [], add = [];
        for (const bp of vscode.debug.breakpoints) {
            if (!(bp instanceof vscode.SourceBreakpoint) || !keys.has(bpKey(bp))) continue;
            rem.push(bp);
            const cond = 'condition' in changes ? changes.condition : bp.condition;
            const hit  = 'hitCondition' in changes ? changes.hitCondition : bp.hitCondition;
            const log  = 'logMessage' in changes ? changes.logMessage : bp.logMessage;
            add.push(new vscode.SourceBreakpoint(bp.location, bp.enabled, cond || undefined, hit || undefined, log || undefined));
        }
        if (rem.length) { vscode.debug.removeBreakpoints(rem); vscode.debug.addBreakpoints(add); }
    }
    async function editBpProp(L, prop) {
        if (!L || !L.bps || !L.bps.length) return;
        const meta = PROP_META[prop];
        const val = await vscode.window.showInputBox({
            prompt: meta.prompt, value: propVal(L.bps[0], prop) || '',
            placeHolder: meta.ph, ignoreFocusOut: true
        });
        if (val === undefined) return;   // cancelled — leave unchanged
        updateBpProps(L.bps, { [prop]: val.trim() || undefined });
    }
    function removeBpLine(L) {
        if (!L || !L.bps || !L.bps.length) return;
        const keys = new Set(L.bps.map(bpKey));
        const rem = vscode.debug.breakpoints.filter(b => b instanceof vscode.SourceBreakpoint && keys.has(bpKey(b)));
        if (rem.length) vscode.debug.removeBreakpoints(rem);
    }
    // Delete a set of breakpoints after a modal confirmation ("Delete all N in <what>?").
    async function removeBpsConfirmed(bpList, what) {
        if (!bpList || !bpList.length) { vscode.window.showInformationMessage('No breakpoints to delete' + (what ? ' in ' + what : '') + '.'); return; }
        const keys = new Set(bpList.map(bpKey));
        const rem = vscode.debug.breakpoints.filter(b => b instanceof vscode.SourceBreakpoint && keys.has(bpKey(b)));
        if (!rem.length) return;
        const pick = await vscode.window.showWarningMessage('Delete all ' + rem.length + ' breakpoint' + (rem.length === 1 ? '' : 's') + (what ? ' in ' + what : '') + '?', { modal: true }, 'Delete');
        if (pick === 'Delete') vscode.debug.removeBreakpoints(rem);
    }
    async function editBpLine(node) {
        const L = node && node.ln;
        if (!L || !L.bps || !L.bps.length) return;
        const rep = L.bps[0];
        const items = Object.keys(PROP_META).map(prop => ({
            label: PROP_META[prop].label, description: propVal(rep, prop) || '(none)', prop
        }));
        items.push({ label: '$(trash) Remove Breakpoint', prop: '__remove' });
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Edit breakpoint — line ' + L.line + (L.col ? ':' + L.col : '')
        });
        if (!pick) return;
        if (pick.prop === '__remove') return removeBpLine(L);
        await editBpProp(L, pick.prop);
    }

    // Declared here (before rebuildBpTree, which is called during activate before the
    // parser functions below are defined) so the first rebuild doesn't hit the temporal
    // dead zone. null = not yet parsed; Set(canonPath) once parsed.
    let hostFilesWithLines = null;

    async function rebuildBpTree() {
        const gen = ++bpTreeGen;
        const all = vscode.debug.breakpoints.filter(b => b instanceof vscode.SourceBreakpoint);
        const session = vscode.debug.activeDebugSession;
        let modulesMeta = [{ id: 'R', name: 'Resident' }];
        let byFile = {};
        let snaps = {};   // "<fsPath>:<reqLine>" -> bound line (when a requested line has no code of its own)
        let bpVerified = {};   // "<fsPath>:<reqLine>" -> bool (DA-authoritative: false when the line can't bind)
        if (session && session.type === 'oric-debug' && all.length) {
            const files = [...new Set(all.map(b => b.location.uri.fsPath))];
            const locs = all.map(b => ({ file: b.location.uri.fsPath, line: b.location.range.start.line + 1 }));
            try {
                const r = await session.customRequest('getBreakpointModules', { files, locs });
                if (r && r.modules) modulesMeta = r.modules;
                if (r && r.byFile) byFile = r.byFile;
                if (r && r.snaps) snaps = r.snaps;
                if (r && r.bpVerified) bpVerified = r.bpVerified;
            } catch (e) { /* adapter unavailable: fall back to a flat list */ }
        }
        // Adapter-owned ADDRESS breakpoints (ROM / no-source, e.g. $238) — their own
        // category, fetched regardless of whether any source breakpoints exist.
        let addrBpList = [];
        if (session && session.type === 'oric-debug') {
            try {
                const r = await session.customRequest('listAddressBreakpoints', {});
                if (r && Array.isArray(r.breakpoints)) addrBpList = r.breakpoints;
            } catch (e) { /* old adapter without the request: no address category */ }
        }
        if (gen !== bpTreeGen) return;   // a newer rebuild started during the await — let it win
        // Cache the address-bp addresses and refresh the Symbols-panel bp dots (also covers
        // watchpoint changes: pushWatchpoints fires bpTreeEmitter, which re-runs this).
        lastAddrBpAddrs = addrBpList.map(b => b.address & 0xFFFF);
        if (refreshSymbolBpMarks) refreshSymbolBpMarks();
        const nameOf = new Map(modulesMeta.map(m => [String(m.id), m.name]));
        // module -> { files: fsPath -> { uri, name, lines: locKey -> { line, col, uri, bps:[] } } }
        const mods = new Map();
        const ensureMod = key => {
            const k = String(key);
            if (!mods.has(k)) mods.set(k, { key: k, name: nameOf.get(k) || ('Module ' + k), files: new Map() });
            return mods.get(k);
        };
        for (const b of all) {
            const fsPath = b.location.uri.fsPath;
            const owners = (byFile[fsPath] && byFile[fsPath].length) ? byFile[fsPath] : ['R'];
            const reqLine = b.location.range.start.line + 1;
            // Show the BOUND line (where the bp actually binds) so the panel matches
            // VS Code's gutter/native view when the requested line has no code.
            const line = snaps[fsPath + ':' + reqLine] || reqLine;
            // Bind-state: false when the line can't bind. The DA's per-line map is
            // authoritative during a session; when it has no entry (no session, or the
            // DA hasn't assessed this bp), fall back to the host-side filesWithLines
            // parse of symbols_ext — which is what makes startup, post-stop, and
            // post-rebuild all show the correct state without a DA running. Only .c
            // files are at risk (assembly .s always has line info), so restrict the
            // host fallback to .c to avoid false-positives on unrelated files.
            // Wrapped so a parse/path failure can never abort the panel render.
            let daVerified = bpVerified[fsPath + ':' + reqLine];
            if (daVerified === undefined) {
                try {
                    const bindable = hostBpBindableFiles();
                    if (bindable && /\.c$/i.test(fsPath) && !bindable.has(canonPath(fsPath))) {
                        daVerified = false;
                    }
                } catch (_) { /* host parse unavailable → leave daVerified undefined (verified) */ }
            }
            const col = b.location.range.start.character;
            const locKey = line + ':' + col;
            const name = b.location.uri.path.split('/').pop();
            for (const owner of owners) {
                const M = ensureMod(owner);
                let F = M.files.get(fsPath);
                if (!F) { F = { uri: b.location.uri, name, lines: new Map() }; M.files.set(fsPath, F); }
                let L = F.lines.get(locKey);
                if (!L) { L = { line, col, uri: b.location.uri, bps: [], daVerified }; F.lines.set(locKey, L); }
                // Keep daVerified in sync if multiple bps land here (they share a reqLine).
                if (daVerified !== undefined) L.daVerified = daVerified;
                L.bps.push(b);   // >1 = duplicate/column-distinct bps at one location
            }
        }
        const modArr = [...mods.values()].sort((a, b) =>
            a.key === 'R' ? 1 : b.key === 'R' ? -1 : (Number(a.key) - Number(b.key)));
        for (const M of modArr) {
            M.fileArr = [...M.files.values()].sort((a, b) => a.name.localeCompare(b.name));
            for (const F of M.fileArr) F.lineArr = [...F.lines.values()].sort((a, b) => a.line - b.line || a.col - b.col);
        }
        // Show breakpoints NOW — the async source-text enrichment below must never
        // hide or delay them (that async work is exactly what let rebuilds race).
        bpTreeModel = { modules: modArr, grouped: modArr.length > 1, addrBps: addrBpList };
        bpTreeEmitter.fire();
        // Refresh the unverified-bp gutter badges from the same daVerified signal.
        // Group unverified requested lines by file, then apply to visible editors.
        unverifiedBpLines.clear();
        for (const M of modArr) for (const F of M.fileArr) for (const L of F.lineArr) {
            if (L.daVerified === false) {
                const key = canonPath(F.uri.fsPath);
                if (!unverifiedBpLines.has(key)) unverifiedBpLines.set(key, new Set());
                unverifiedBpLines.get(key).add(L.line);
            }
        }
        applyUnverifiedBpDecorations();

        // Enrich each line with its trimmed source ("236:  if (SetupColors(..."),
        // then refresh again. Bail if a newer rebuild has superseded us.
        const docCache = new Map();
        const lineText = async (uri, ln) => {
            const k = uri.fsPath;
            if (!docCache.has(k)) {
                try { docCache.set(k, await vscode.workspace.openTextDocument(uri)); }
                catch (e) { docCache.set(k, null); }
            }
            const doc = docCache.get(k);
            return (doc && ln >= 1 && ln <= doc.lineCount) ? doc.lineAt(ln - 1).text.trim() : '';
        };
        for (const M of modArr) for (const F of M.fileArr) for (const L of F.lineArr) {
            if (gen !== bpTreeGen) return;
            L.text = await lineText(L.uri, L.line);
        }
        if (gen === bpTreeGen) bpTreeEmitter.fire();
    }

    const linesOf = f => f.lineArr;
    const enabledCount = lines => lines.filter(l => l.bps.some(b => b.enabled)).length;
    // Condition / hit-count shown as their OWN child rows under the breakpoint, so
    // a long expression gets a full line of its own instead of being pushed off to
    // the right of the code. Icon carries an at-a-glance cue; text is the label.
    const lineDetails = L => {
        const rep = L.bps[0], out = [];
        if (rep.condition) out.push({ text: 'if ' + rep.condition, icon: 'debug-breakpoint-conditional', prop: 'condition' });
        if (rep.hitCondition) out.push({ text: 'hit count ' + rep.hitCondition, icon: 'symbol-number', prop: 'hitCondition' });
        // The logpoint message on its own row (like the condition) instead of a
        // tiny "log" tag — a conditional logpoint then reads clearly: "if <cond>"
        // above "log: <message>". Both fire together (log only when cond holds).
        if (rep.logMessage) {
            // "[stop]" in the message means log AND break — reflect that in the row
            // label (token stripped for readability) so the behavior is visible.
            const stops = /\[stop\]/i.test(rep.logMessage);
            const msg = rep.logMessage.replace(/\s*\[stop\]\s*/ig, ' ').trim();
            out.push({ text: (stops ? 'log & stop: ' : 'log: ') + msg, icon: 'debug-breakpoint-log', prop: 'logMessage' });
        }
        return out;
    };
    // Watchpoint child rows: access / size / condition / log, each independently
    // editable (like a standard breakpoint's condition + logpoint detail rows). Shown
    // even when empty ("(none)") so a condition or message can be ADDED from the row.
    const watchDetails = w => {
        const acc = w.access === 'read' ? 'Read' : w.access === 'readWrite' ? 'Read + Write' : 'Write';
        const sz = w.size || 1;
        const stops = w.logMessage && /\[stop\]/i.test(w.logMessage);
        return [
            { prop: 'access', icon: 'debug-breakpoint-data', text: 'access: ' + acc },
            { prop: 'size', icon: 'symbol-number', text: 'size: ' + sz + (sz > 1 ? ' bytes' : ' byte') },
            { prop: 'condition', icon: 'debug-breakpoint-conditional', text: w.condition ? ('if ' + w.condition) : 'condition: (none)' },
            { prop: 'logMessage', icon: 'debug-breakpoint-log', text: w.logMessage ? ((stops ? 'log & stop: ' : 'log: ') + w.logMessage.replace(/\s*\[stop\]\s*/ig, ' ').trim()) : 'log: (none)' },
        ];
    };

    const bpTreeProvider = {
        onDidChangeTreeData: bpTreeEmitter.event,
        getChildren(el) {
            if (!el) {
                const roots = [];
                if (bpTreeModel.grouped) roots.push(...bpTreeModel.modules.map(m => ({ kind: 'module', mod: m })));
                else {
                    const m = bpTreeModel.modules[0];   // single group: skip the module level
                    if (m) roots.push(...m.fileArr.map(f => ({ kind: 'file', file: f, mod: m })));
                }
                // Address breakpoints (ROM / no-source) get their own category at the end.
                if (bpTreeModel.addrBps && bpTreeModel.addrBps.length) roots.push({ kind: 'addrGroup' });
                // Watchpoints (memory access events) get their own category too.
                if (watchBpList.length) roots.push({ kind: 'watchGroup' });
                return roots;
            }
            if (el.kind === 'addrGroup') return bpTreeModel.addrBps.map(a => ({ kind: 'addrBp', a }));
            if (el.kind === 'watchGroup') return watchBpList.map(w => ({ kind: 'watchBp', w }));
            if (el.kind === 'watchBp') return watchDetails(el.w).map((d, i) => ({ kind: 'watchDetail', w: el.w, idx: i, prop: d.prop, text: d.text, icon: d.icon }));
            if (el.kind === 'module') return el.mod.fileArr.map(f => ({ kind: 'file', file: f, mod: el.mod }));
            if (el.kind === 'file') return el.file.lineArr.map(l => ({ kind: 'line', ln: l, file: el.file, mod: el.mod }));
            if (el.kind === 'line') return lineDetails(el.ln).map((d, i) => ({ kind: 'detail', ln: el.ln, el, idx: i, ...d }));
            return [];
        },
        getTreeItem(el) {
            if (el.kind === 'addrGroup') {
                const it = new vscode.TreeItem('Address breakpoints',
                    vscode.TreeItemCollapsibleState.Expanded);
                it.description = String(bpTreeModel.addrBps.length);
                it.contextValue = 'oricAddrGroup';
                it.iconPath = new vscode.ThemeIcon('symbol-number');
                it.id = 'addrgroup';
                return it;
            }
            if (el.kind === 'addrBp') {
                const a = el.a;
                const enabled = a.enabled !== false;
                const hx = '$' + (a.address & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
                const it = new vscode.TreeItem(
                    (a.label && a.label !== hx) ? (hx + '  ' + a.label) : hx,
                    vscode.TreeItemCollapsibleState.None);
                it.contextValue = 'oricAddrBp';
                it.checkboxState = enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
                it.iconPath = new vscode.ThemeIcon(enabled ? 'debug-breakpoint' : 'debug-breakpoint-disabled',
                    new vscode.ThemeColor(enabled ? 'debugIcon.breakpointForeground' : 'debugIcon.breakpointDisabledForeground'));
                it.id = 'addrbp:' + a.address;
                return it;
            }
            if (el.kind === 'watchGroup') {
                const it = new vscode.TreeItem('Watchpoints', vscode.TreeItemCollapsibleState.Expanded);
                it.description = String(watchBpList.length);
                it.contextValue = 'oricWatchGroup';
                it.iconPath = new vscode.ThemeIcon('eye');
                it.id = 'watchgroup';
                return it;
            }
            if (el.kind === 'watchBp') {
                const w = el.w;
                const enabled = w.enabled !== false;
                const hx = '$' + (w.address & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
                const acc = w.access === 'read' ? 'R' : w.access === 'readWrite' ? 'RW' : 'W';
                const name = (w.label && w.label !== hx) ? (hx + ' ' + w.label) : hx;
                // Access/size/condition/log live in editable child rows (below); the top row
                // stays concise: address + access tag.
                const it = new vscode.TreeItem(name + '  [' + acc + ']', vscode.TreeItemCollapsibleState.Expanded);
                it.contextValue = 'oricWatchBp';
                it.checkboxState = enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
                it.iconPath = new vscode.ThemeIcon(
                    w.logMessage ? 'debug-breakpoint-log' : (w.condition ? 'debug-breakpoint-conditional' : 'debug-breakpoint-data'),
                    new vscode.ThemeColor(enabled ? 'debugIcon.breakpointForeground' : 'debugIcon.breakpointDisabledForeground'));
                it.id = 'watchbp:' + w.id;
                return it;
            }
            if (el.kind === 'watchDetail') {
                const it = new vscode.TreeItem(el.text, vscode.TreeItemCollapsibleState.None);
                it.iconPath = new vscode.ThemeIcon(el.icon);
                it.contextValue = 'oricWatchDetail';
                it.id = 'watchdetail:' + el.w.id + ':' + el.prop;
                return it;
            }
            if (el.kind === 'detail') {
                const it = new vscode.TreeItem(el.text);
                it.iconPath = new vscode.ThemeIcon(el.icon);
                it.contextValue = 'oricBpDetail';
                const L = el.ln;
                it.id = 'detail:' + el.el.mod.key + ':' + el.el.file.uri.fsPath + ':' + L.line + ':' + L.col + ':' + el.idx;
                it.command = { command: 'vscode.open', title: 'Reveal',
                    arguments: [L.uri, { selection: new vscode.Range(L.line - 1, L.col, L.line - 1, L.col) }] };
                return it;
            }
            if (el.kind === 'module') {
                const lines = el.mod.fileArr.flatMap(linesOf);
                const isActive = activeOricModuleId != null && String(activeOricModuleId) === el.mod.key;
                // Follow the active module (setting): expand it, collapse the rest.
                // Encoding active/inactive in the id makes VS Code re-apply this on
                // each module switch while still honouring a manual expand between
                // switches (the id is stable until the active module changes).
                const follow = vscode.workspace.getConfiguration('oric-debug').get('breakpointsFollowActiveModule', true);
                const it = new vscode.TreeItem(
                    isActive ? { label: el.mod.name, highlights: [[0, el.mod.name.length]] } : el.mod.name,
                    (follow && !isActive) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
                it.description = (isActive ? 'active · ' : '') + enabledCount(lines) + '/' + lines.length + ' enabled';
                it.contextValue = 'oricModule';
                it.iconPath = new vscode.ThemeIcon('layers', isActive ? new vscode.ThemeColor('list.highlightForeground') : undefined);
                it.id = 'mod:' + el.mod.key + (follow ? (isActive ? ':A' : ':I') : '');
                return it;
            }
            if (el.kind === 'file') {
                const it = new vscode.TreeItem(el.file.name, vscode.TreeItemCollapsibleState.Expanded);
                it.description = enabledCount(el.file.lineArr) + '/' + el.file.lineArr.length + ' enabled';
                it.contextValue = 'oricFile';
                it.iconPath = vscode.ThemeIcon.File;
                it.resourceUri = el.file.uri;
                it.id = 'file:' + el.mod.key + ':' + el.file.uri.fsPath;
                return it;
            }
            const L = el.ln, rep = L.bps[0];
            const enabled = L.bps.some(b => b.enabled);
            // Bind-state: false when the line can't bind (e.g. a .c file built without
            // -g1). Computed either by the DA (during a session, per-line) or by the
            // host's symbols_ext parse (startup/post-stop/post-rebuild, per-file).
            const verified = L.daVerified !== false;
            let unverifiedMsg = L.bps.map(b => b.message).filter(Boolean).join(' / ');
            // When the host detected unverified (no DA message available), supply the
            // actionable hint so the tooltip explains why even without a session.
            if (!verified && !unverifiedMsg) {
                unverifiedMsg = 'No source-line info for this C file — rebuild with -g1 '
                    + '(set OSDKCOMP=-O1 -g1 in osdk_config.bat) so C breakpoints can bind.';
            }
            const here = oricDebugStopped && currentStopLoc && currentStopLoc.line === L.line
                && canonPath(currentStopLoc.path) === canonPath(L.uri.fsPath);
            const lineTag = L.line + (L.col ? ':' + L.col : '');
            const marks = [];
            if (here) marks.push('▶ stopped here');
            if (L.bps.length > 1) marks.push(L.bps.length + ' bps');
            if (!verified) marks.push('⚠ unverified');   // can't bind — see tooltip
            // Condition/hit-count/log-message are NOT put here — they get their own
            // child rows (see lineDetails) so long text is fully visible on its own line.
            const details = lineDetails(L);
            // Line number FIRST in the label so it stays visible — long code would
            // otherwise push a trailing line number off-screen. Code follows it and
            // just truncates when long; markers ride in the gray description.
            const it = new vscode.TreeItem(L.text ? (lineTag + ':  ' + L.text) : ('Line ' + lineTag),
                details.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
            it.description = marks.join('  ');
            it.tooltip = unverifiedMsg || undefined;
            it.contextValue = 'oricBp';
            it.checkboxState = enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
            // Unverified bps get the hollow grey glyph regardless of enabled/log/conditional
            // variant — "can't bind" is the dominant state and should read at a glance.
            if (!verified) {
                it.iconPath = new vscode.ThemeIcon('debug-breakpoint-unverified');
            } else {
                const base = rep.logMessage ? 'debug-breakpoint-log' : (rep.condition ? 'debug-breakpoint-conditional' : 'debug-breakpoint');
                it.iconPath = here
                    ? new vscode.ThemeIcon('debug-stackframe', new vscode.ThemeColor('debugIcon.breakpointCurrentStackframeForeground'))
                    : new vscode.ThemeIcon(enabled ? base : base + '-disabled',
                        new vscode.ThemeColor(enabled ? 'debugIcon.breakpointForeground' : 'debugIcon.breakpointDisabledForeground'));
            }
            it.id = 'line:' + el.mod.key + ':' + el.file.uri.fsPath + ':' + L.line + ':' + L.col;
            it.command = { command: 'vscode.open', title: 'Reveal',
                arguments: [L.uri, { selection: new vscode.Range(L.line - 1, L.col, L.line - 1, L.col) }] };
            return it;
        }
    };

    const bpTree = vscode.window.createTreeView('oricBreakpoints',
        { treeDataProvider: bpTreeProvider, showCollapseAll: true });
    bpTree.onDidChangeCheckboxState(ev => {
        for (const [node, state] of ev.items) {
            if (node.kind === 'line') setBpsEnabled(node.ln.bps, state === vscode.TreeItemCheckboxState.Checked);
            else if (node.kind === 'addrBp') {
                const s = vscode.debug.activeDebugSession;
                if (s && s.type === 'oric-debug')
                    s.customRequest('setAddressBreakpointEnabled',
                        { address: node.a.address, enabled: state === vscode.TreeItemCheckboxState.Checked }).catch(() => {});
            }
            else if (node.kind === 'watchBp') {
                const w = watchBpList.find(x => x.id === node.w.id);
                if (w) { w.enabled = state === vscode.TreeItemCheckboxState.Checked; pushWatchpoints(); }
            }
        }
    });
    const modBps = m => m.fileArr.flatMap(f => f.lineArr.flatMap(l => l.bps));
    const fileBps = f => f.lineArr.flatMap(l => l.bps);
    const allBps = () => bpTreeModel.modules.flatMap(modBps);
    context.subscriptions.push(
        bpTree,
        vscode.debug.onDidChangeBreakpoints(() => rebuildBpTree()),
        // Rebuild now AND after the session settles: at start, VS Code is still
        // restoring/verifying imported breakpoints, so an immediate read can catch
        // a transient (pre-verification) line. The delayed pass re-reads the
        // settled locations — matching the native panel — without needing a manual
        // breakpoint edit.
        vscode.debug.onDidStartDebugSession(() => { rebuildBpTree(); setTimeout(rebuildBpTree, 1500); }),
        // Re-arm persisted address breakpoints (ROM / no-source) — adapter-owned, so
        // VS Code didn't restore them. A short delay lets the adapter finish connecting.
        vscode.debug.onDidStartDebugSession(s => {
            if (!s || s.type !== 'oric-debug') return;
            const saved = context.workspaceState.get(ADDR_BP_KEY, []);
            if (Array.isArray(saved) && saved.length)
                setTimeout(() => s.customRequest('setAddressBreakpoints', { breakpoints: saved }).catch(() => {}), 400);
            // Re-send watchpoint events too (adapter-owned, like address bps).
            if (watchBpList.length)
                setTimeout(() => s.customRequest('oricSetWatchpoints', { watchpoints: watchBpList.map(toAdapterWp) }).catch(() => {}), 450);
        }),
        vscode.commands.registerCommand('oric-debug.runAutomationScript', async () => {
            const files = await vscode.workspace.findFiles('**/automation/*.js', '**/node_modules/**', 100);
            if (!files.length) { vscode.window.showInformationMessage('No automation scripts. Create <project>/automation/<name>.js  (module.exports = async (t) => { … }).'); return; }
            files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
            const pick = await vscode.window.showQuickPick(
                files.map(f => ({ label: nodePath.basename(f.fsPath), description: vscode.workspace.asRelativePath(f), fsPath: f.fsPath })),
                { title: 'Run Oric automation script', ignoreFocusOut: true });
            if (pick) runAutomationScript(pick.fsPath);
        }),
        vscode.commands.registerCommand('oric-debug.stopAutomationScript', () => {
            vscode.window.showInformationMessage(stopAutomation('stopped by user') ? 'Oric automation: stopped.' : 'No Oric automation script is running.');
        }),
        vscode.commands.registerCommand('oric-debug.registerMcpServer', () => registerMcpServerFlow(context)),
        vscode.commands.registerCommand('oric-debug.startMcpBridge', () => toggleMcpBridge()),
        vscode.commands.registerCommand('oric-debug.takeControl', async () => {
            if (!bridgeServer) { const go = await vscode.window.showInformationMessage('The AI collaboration bridge is off.', 'Start Bridge'); if (go === 'Start Bridge') toggleMcpBridge(); return; }
            if (bridgeControl === BRIDGE_CONTROL.AI) { setBridgeControl(BRIDGE_CONTROL.HUMAN); vscode.window.setStatusBarMessage('Oric: you now hold debug control.', 3000); }
            else vscode.window.showInformationMessage('You already hold debug control. The AI can observe (read/screenshot) but not drive until it requests it.');
        }),
        // Ending the debug session must also stop any running script — otherwise it spins on a
        // dead session (ops swallow the errors) and can't be stopped or re-run.
        vscode.debug.onDidTerminateDebugSession(s => { if (!s || s.type === 'oric-debug') stopAutomation('debug session ended'); }),
        vscode.commands.registerCommand('oric-debug.addWatchpoint', () => addWatchpointFlow()),
        vscode.commands.registerCommand('oric-debug.removeWatchpoint', node => removeWatchpoint(node)),
        vscode.commands.registerCommand('oric-debug.editWatchpoint', node => editWatchpoint(node)),
        vscode.commands.registerCommand('oric-debug.editWatchProp', node => { if (node && node.w && node.prop) editWatchProp(watchBpList.find(x => x.id === node.w.id), node.prop); }),
        vscode.debug.onDidTerminateDebugSession(() => { activeOricModuleId = null; activeOricModuleName = null; hostFilesWithLines = null; rebuildBpTree(); }),
        vscode.commands.registerCommand('oric-debug.bpEnableModule', node => { if (node && node.mod) setBpsEnabled(modBps(node.mod), true); }),
        vscode.commands.registerCommand('oric-debug.bpDisableModule', node => { if (node && node.mod) setBpsEnabled(modBps(node.mod), false); }),
        vscode.commands.registerCommand('oric-debug.bpEnableFile', node => { if (node && node.file) setBpsEnabled(fileBps(node.file), true); }),
        vscode.commands.registerCommand('oric-debug.bpDisableFile', node => { if (node && node.file) setBpsEnabled(fileBps(node.file), false); }),
        vscode.commands.registerCommand('oric-debug.bpEnableAll', () => setBpsEnabled(allBps(), true)),
        vscode.commands.registerCommand('oric-debug.bpDisableAll', () => setBpsEnabled(allBps(), false)),
        // Delete-all (with confirmation) — clean up a pile of test breakpoints in one go.
        vscode.commands.registerCommand('oric-debug.bpRemoveFile', node => { if (node && node.file) removeBpsConfirmed(fileBps(node.file), node.file.name); }),
        vscode.commands.registerCommand('oric-debug.bpRemoveModule', node => { if (node && node.mod) removeBpsConfirmed(modBps(node.mod), node.mod.name); }),
        vscode.commands.registerCommand('oric-debug.bpRemoveAll', () => removeBpsConfirmed(allBps(), null)),
        // Edit from the panel: line row -> pick which property; detail row -> edit
        // that property directly; plus remove.
        vscode.commands.registerCommand('oric-debug.bpEdit', editBpLine),
        vscode.commands.registerCommand('oric-debug.bpEditDetail', node => { if (node && node.ln && node.prop) editBpProp(node.ln, node.prop); }),
        vscode.commands.registerCommand('oric-debug.bpRemove', node => { if (node && node.ln) removeBpLine(node.ln); }),
        // Snapshots (SPEC-snapshots.md): save/restore the full machine state to a
        // per-project folder so you can poke around then rewind.
        vscode.commands.registerCommand('oric-debug.snapshotSave', async () => {
            const s = vscode.debug.activeDebugSession;
            if (!s || s.type !== 'oric-debug') { vscode.window.showInformationMessage('Oric: start a debug session first.'); return; }
            const name = await vscode.window.showInputBox({ prompt: 'Snapshot name', value: 'snap', ignoreFocusOut: true });
            if (!name) return;
            try { const r = await s.customRequest('saveSnapshot', { name }); vscode.window.setStatusBarMessage('Oric: saved snapshot "' + r.name + '"', 3000); }
            catch (e) { vscode.window.showErrorMessage('Snapshot save failed: ' + (e && e.message ? e.message : e)); }
        }),
        vscode.commands.registerCommand('oric-debug.snapshotRestore', async () => {
            const s = vscode.debug.activeDebugSession;
            if (!s || s.type !== 'oric-debug') { vscode.window.showInformationMessage('Oric: start a debug session first.'); return; }
            let list; try { list = await s.customRequest('listSnapshots'); } catch (e) { vscode.window.showErrorMessage('List failed: ' + (e && e.message ? e.message : e)); return; }
            const snaps = (list && list.snapshots) || [];
            if (!snaps.length) { vscode.window.showInformationMessage('Oric: no snapshots saved yet.'); return; }
            const pick = await vscode.window.showQuickPick(
                snaps.map(x => ({ label: x.name, description: x.pc != null ? 'PC $' + (x.pc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0') : '' })),
                { placeHolder: 'Restore which snapshot?' });
            if (!pick) return;
            try { await s.customRequest('restoreSnapshot', { name: pick.label }); vscode.window.setStatusBarMessage('Oric: restored "' + pick.label + '"', 3000); }
            catch (e) { vscode.window.showErrorMessage('Restore failed: ' + (e && e.message ? e.message : e)); }
        }),
        vscode.commands.registerCommand('oric-debug.snapshotRestartRecent', async () => {
            const s = vscode.debug.activeDebugSession;
            if (!s || s.type !== 'oric-debug') { vscode.window.showInformationMessage('Oric: start a debug session first.'); return; }
            let list; try { list = await s.customRequest('listSnapshots'); } catch (e) { vscode.window.showErrorMessage('List failed: ' + (e && e.message ? e.message : e)); return; }
            const snaps = (list && list.snapshots) || [];   // already newest-first, baseline excluded
            if (!snaps.length) { vscode.window.showInformationMessage('Oric: no snapshots yet — use "Save Snapshot" first.'); return; }
            const latest = snaps[0].name;
            try { await s.customRequest('restoreSnapshot', { name: latest }); vscode.window.setStatusBarMessage('Oric: restarted to "' + latest + '"', 3000); }
            catch (e) { vscode.window.showErrorMessage('Restart-to-snapshot failed: ' + (e && e.message ? e.message : e)); }
        }),
        vscode.commands.registerCommand('oric-debug.snapshotDelete', async () => {
            const s = vscode.debug.activeDebugSession;
            if (!s || s.type !== 'oric-debug') { vscode.window.showInformationMessage('Oric: start a debug session first.'); return; }
            let list; try { list = await s.customRequest('listSnapshots'); } catch (e) { return; }
            const snaps = (list && list.snapshots) || [];
            if (!snaps.length) { vscode.window.showInformationMessage('Oric: no snapshots to delete.'); return; }
            const pick = await vscode.window.showQuickPick(snaps.map(x => x.name), { placeHolder: 'Delete which snapshot?' });
            if (!pick) return;
            try { await s.customRequest('deleteSnapshot', { name: pick }); vscode.window.setStatusBarMessage('Oric: deleted "' + pick + '"', 3000); }
            catch (e) { vscode.window.showErrorMessage('Delete failed: ' + (e && e.message ? e.message : e)); }
        })
    );
    rebuildBpTree();

    // Watch symbols_ext for changes so breakpoint bind-state refreshes immediately
    // after any rebuild (CTRL-B task, launch build.command, external shell, make) —
    // not just on the next F5. The glob covers the conventional build/ location;
    // the handler invalidates the host parse cache and rebuilds the bp panel.
    const symWatcher = vscode.workspace.createFileSystemWatcher('**/build/symbols_ext');
    const onSymChange = () => { hostFilesWithLines = null; rebuildBpTree(); };
    symWatcher.onDidChange(onSymChange);
    symWatcher.onDidCreate(onSymChange);
    context.subscriptions.push(symWatcher);

    // ---- Oric Snapshots panel (TreeView) --------------------------------------
    // Lists the project's snapshots (from the adapter). Restore on click, inline
    // restore/delete/rename; refreshes on the adapter's oricSnapshotsChanged event
    // (covers the [save] logpoint token) and on session start/stop.
    const snapEmitter = new vscode.EventEmitter();
    // Gray the snapshot rows when there's no session (a TreeView can't be CSS-dimmed like a
    // webview, but a FileDecorationProvider can tint the labels with a themed disabled color).
    const snapDecoEmitter = new vscode.EventEmitter();
    const snapDecoProvider = {
        onDidChangeFileDecorations: snapDecoEmitter.event,
        provideFileDecoration(uri) {
            if (uri.scheme !== 'oric-snapshot' || oricSessionActive) return undefined;
            return { color: new vscode.ThemeColor('disabledForeground') };
        }
    };
    // The .oric-snapshots directory is the source of truth — read it directly so snapshots show
    // even with NO active session (you can then start one FROM a snapshot). mtime = save time.
    function snapshotsFolder() {
        const fsx = require('fs');
        const s = vscode.debug.activeDebugSession;
        const cfg = s && s.configuration;
        const bases = [];
        const cwd = cfg && (cfg.cwd || (cfg.build && cfg.build.cwd));
        if (cwd) bases.push(cwd);
        for (const f of (vscode.workspace.workspaceFolders || [])) bases.push(f.uri.fsPath);
        for (const b of bases) { const d = nodePath.join(b, '.oric-snapshots'); try { if (fsx.existsSync(d)) return d; } catch (_) {} }
        return null;
    }
    // --- Host-side breakpoint bind-state (no debug session required) ---
    // The bindability of a .c breakpoint is a property of build/symbols_ext on disk,
    // not of the debug session. When built without -g1, .c files are absent from the
    // symbol file's #FILES/#LINES (only a temp TMP\main appears), so .c breakpoints
    // can't bind. We read symbols_ext directly so the ORIC BREAKPOINTS panel shows the
    // correct state at startup, after a rebuild, and after the debugger stops — none
    // of which have a DA running to supply the (session-only) getBreakpointModules map.
    // (hostFilesWithLines is declared above rebuildBpTree to avoid a TDZ on first call.)
    function symbolsExtPath() {
        const fsx = require('fs');
        const s = vscode.debug.activeDebugSession;
        const cfg = s && s.configuration;
        const candidates = [];
        // 1. Active session's symbolFile (authoritative during a session).
        if (cfg && cfg.symbolFile) candidates.push(cfg.symbolFile);
        // 2. launch.json oric-debug configs across all workspace folders.
        for (const f of (vscode.workspace.workspaceFolders || [])) {
            const cfgs = vscode.workspace.getConfiguration('launch', f.uri).get('configurations') || [];
            for (const c of cfgs) if (c && c.type === 'oric-debug' && c.symbolFile) {
                candidates.push(c.symbolFile.replace(/\$\{workspaceFolder\}/g, f.uri.fsPath));
            }
        }
        // 3. Conventional fallbacks per workspace folder.
        for (const f of (vscode.workspace.workspaceFolders || [])) {
            candidates.push(nodePath.join(f.uri.fsPath, 'build', 'symbols_ext'));
            candidates.push(nodePath.join(f.uri.fsPath, 'build', 'symbols'));
        }
        for (const c of candidates) { try { if (c && fsx.existsSync(c) && fsx.statSync(c).isFile()) return c; } catch (_) {} }
        return null;
    }
    // Parse symbols_ext's #FILES/#LINES into a Set of canonPaths that have >=1 line
    // entry (the bindability predicate the DA uses as `filesWithLines`). Returns null
    // if the file can't be read. Ported from debug_adapter.js's loadSymbols (#FILES/#LINES
    // section only — #SYM/#TYPES are irrelevant here).
    function parseHostFilesWithLines() {
        const fsx = require('fs');
        const p = symbolsExtPath();
        if (!p) return null;
        let text;
        try { text = fsx.readFileSync(p, 'utf8'); } catch (_) { return null; }
        const result = new Set();
        let section = null;
        const fileIndex = [];
        for (const raw of text.split(/\r?\n/)) {
            const t = raw.trim();
            if (t === '#FILES') { section = 'files'; continue; }
            if (t === '#LINES') { section = 'lines'; continue; }
            if (t.startsWith('#') || !section) {
                if (t.startsWith('#')) { section = null; }
                continue;
            }
            if (section === 'files') {
                const fm = t.match(/^(\d+)\s+(.+)$/);
                if (fm) fileIndex[parseInt(fm[1], 10)] = fm[2];
            } else if (section === 'lines') {
                const lm = t.match(/^([0-9a-fA-F]{4})\s+(\d+):(\d+)$/);
                if (lm) {
                    const fi = parseInt(lm[2], 10);
                    const fpath = fileIndex[fi];
                    if (fpath) result.add(canonPath(fpath));
                }
            }
        }
        return result;
    }
    // Returns the cached host filesWithLines, parsing lazily on first use.
    function hostBpBindableFiles() {
        if (hostFilesWithLines === null) hostFilesWithLines = parseHostFilesWithLines();
        return hostFilesWithLines;
    }
    function listSnapshotsOnDisk() {
        const fsx = require('fs');
        const dir = snapshotsFolder();
        if (!dir) return [];
        let files = []; try { files = fsx.readdirSync(dir); } catch (_) { return []; }
        return files.filter(f => f.endsWith('.snapshot') && f.indexOf('__') !== 0)
            .map(f => { let at = 0; try { at = Math.round(fsx.statSync(nodePath.join(dir, f)).mtimeMs); } catch (_) { /* keep 0 */ } return { name: f.slice(0, -('.snapshot'.length)), at }; })
            .sort((a, b) => (b.at || 0) - (a.at || 0));
    }
    function formatSnapWhen(at) {
        if (!at) return '';
        try { return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch (_) { return ''; }
    }
    // Just trigger a re-render — getChildren re-reads the folder. (Fired on save/session events.)
    function refreshSnapshots() { snapEmitter.fire(); }
    const snapTreeProvider = {
        onDidChangeTreeData: snapEmitter.event,
        getChildren() {
            // Read the folder every time (no cache) so the panel is correct on the FIRST render —
            // initial load / Reload Window with no session — and always matches the actual files.
            const items = listSnapshotsOnDisk();
            if (items.length) return items.map(x => ({ kind: 'snap', snap: x }));
            return [{ kind: 'hint', label: '(no snapshots yet — Save Snapshot during a session)' }];
        },
        getTreeItem(el) {
            if (el.kind === 'hint') { const it = new vscode.TreeItem(el.label); it.contextValue = 'oricSnapHint'; return it; }
            const x = el.snap;
            const active = !!(vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === 'oric-debug');
            const it = new vscode.TreeItem(x.name);
            it.description = formatSnapWhen(x.at);   // when it was saved (the file's mtime)
            it.tooltip = x.name + (x.at ? '\nSaved ' + new Date(x.at).toLocaleString() : '') +
                (active ? '\nClick to restore into the running session.' : '\nClick to start a session from this snapshot.');
            it.contextValue = 'oricSnap';
            it.iconPath = new vscode.ThemeIcon('history');
            it.id = 'snap:' + x.name;
            // Click restores into the live session — or STARTS one from this snapshot if none.
            it.command = { command: 'oric-debug.snapshotRestoreItem', title: 'Restore', arguments: [el] };
            return it;
        }
    };
    const snapTree = vscode.window.createTreeView('oricSnapshots', { treeDataProvider: snapTreeProvider });
    const snapSession = () => { const s = vscode.debug.activeDebugSession; return (s && s.type === 'oric-debug') ? s : null; };
    context.subscriptions.push(
        snapTree,
        vscode.window.registerFileDecorationProvider(snapDecoProvider),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
            if (e.event === 'oricSnapshotsChanged') refreshSnapshots();
            else if (e.event === 'oricSignal') { automationEvents.fire({ type: 'signal', id: e.body && e.body.id, pc: e.body && e.body.pc }); if (bridgeServer) bridgeServer.broadcast('signal', { id: e.body && e.body.id, pc: e.body && e.body.pc }); }
        }),
        vscode.debug.onDidStartDebugSession(() => setTimeout(refreshSnapshots, 300)),
        vscode.debug.onDidTerminateDebugSession(() => refreshSnapshots()),
        vscode.commands.registerCommand('oric-debug.snapshotRefresh', () => refreshSnapshots()),
        vscode.commands.registerCommand('oric-debug.snapshotRestoreItem', async node => {
            if (!node || !node.snap) return;
            const name = node.snap.name;
            let s = snapSession();
            const starting = !s;
            if (!s) {   // no session → start one (F5-equivalent), then load the snapshot into it
                s = await startOricDebugSession(() => {});
                if (!s) return;   // startOricDebugSession already reported why
                await new Promise(r => setTimeout(r, 400));   // let the entry stop settle before loading
            }
            try {
                await s.customRequest('restoreSnapshot', { name });
                vscode.window.setStatusBarMessage('Oric: ' + (starting ? 'started from' : 'restored') + ' "' + name + '"', 3000);
            } catch (e) { vscode.window.showErrorMessage((starting ? 'Start from snapshot' : 'Restore') + ' failed: ' + (e && e.message ? e.message : e)); }
        }),
        vscode.commands.registerCommand('oric-debug.snapshotDeleteItem', async node => {
            const s = snapSession(); if (!s || !node || !node.snap) return;
            try { await s.customRequest('deleteSnapshot', { name: node.snap.name }); }
            catch (e) { vscode.window.showErrorMessage('Delete failed: ' + (e && e.message ? e.message : e)); }
        }),
        vscode.commands.registerCommand('oric-debug.snapshotRenameItem', async node => {
            const s = snapSession(); if (!s || !node || !node.snap) return;
            const to = await vscode.window.showInputBox({ prompt: 'Rename snapshot', value: node.snap.name, ignoreFocusOut: true });
            if (!to || to === node.snap.name) return;
            try { await s.customRequest('renameSnapshot', { name: node.snap.name, to }); }
            catch (e) { vscode.window.showErrorMessage('Rename failed: ' + (e && e.message ? e.message : e)); }
        }),
        vscode.commands.registerCommand('oric-debug.snapshotOpenFolder', () => {
            const dir = snapshotsFolder();
            if (!dir) { vscode.window.showInformationMessage('No snapshots folder yet — save a snapshot first (it creates .oric-snapshots/).'); return; }
            vscode.env.openExternal(vscode.Uri.file(dir));
        })
    );
    if (snapSession()) refreshSnapshots();

    // --- Oric Automation panel — list runnable automation scripts with a ▶ Run button.
    // Folder-split convention: standalone scripts are automation/<name>.js (the glob lists only
    // the top level); utility modules go in automation/lib/ and are NOT listed. getChildren reads
    // disk so scripts show with no session; ▶ Run starts a session if needed (runAutomationScript).
    const autoEmitter = new vscode.EventEmitter();
    refreshAutomationView = () => autoEmitter.fire();
    automationConfigMemento = context.workspaceState;   // remember the last-chosen launch config (skip the picker next time)
    async function listAutomationScriptFiles() {
        const files = await vscode.workspace.findFiles('**/automation/*.js', '**/node_modules/**', 200);
        return files.map(f => ({ name: nodePath.basename(f.fsPath), fsPath: f.fsPath }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    // The automation scripts folder: the dir of an existing script if any, else
    // <cwd|workspace>/automation (may not exist yet — the caller handles that).
    async function automationFolder() {
        const found = await vscode.workspace.findFiles('**/automation/*.js', '**/node_modules/**', 1);
        if (found.length) return nodePath.dirname(found[0].fsPath);
        const fsx = require('fs');
        const s = vscode.debug.activeDebugSession, cfg = s && s.configuration;
        const bases = [];
        const cwd = cfg && (cfg.cwd || (cfg.build && cfg.build.cwd));
        if (cwd) bases.push(cwd);
        for (const f of (vscode.workspace.workspaceFolders || [])) bases.push(f.uri.fsPath);
        for (const b of bases) { const d = nodePath.join(b, 'automation'); try { if (fsx.existsSync(d)) return d; } catch (_) {} }
        return bases.length ? nodePath.join(bases[0], 'automation') : null;
    }
    const autoTreeProvider = {
        onDidChangeTreeData: autoEmitter.event,
        async getChildren() {
            const items = await listAutomationScriptFiles();
            if (!items.length) return [{ kind: 'hint', label: '(no scripts — add automation/<name>.js; utilities go in automation/lib/)' }];
            return items.map(x => ({ kind: 'script', name: x.name, fsPath: x.fsPath }));
        },
        getTreeItem(el) {
            if (el.kind === 'hint') { const it = new vscode.TreeItem(el.label); it.contextValue = 'oricAutoHint'; return it; }
            const running = automationRunningPath && canonPath(automationRunningPath) === canonPath(el.fsPath);
            const it = new vscode.TreeItem(el.name.replace(/\.js$/, ''));
            it.description = running ? '● running' : '';
            it.tooltip = el.fsPath + (running ? '\nRunning — use ■ Stop to cancel.' : '\nClick ▶ to run (starts a debug session if none); click the row to open the script.');
            it.contextValue = 'oricAutoScript';
            it.iconPath = new vscode.ThemeIcon(running ? 'loading~spin' : 'file-code');   // row = script glyph; the ▶ Run action is the inline button
            it.id = 'auto:' + el.fsPath;
            it.command = { command: 'oric-debug.automationOpenItem', title: 'Open', arguments: [el] };   // row-click opens; ▶ runs
            return it;
        }
    };
    const autoTree = vscode.window.createTreeView('oricAutomation', { treeDataProvider: autoTreeProvider });
    const autoWatcher = vscode.workspace.createFileSystemWatcher('**/automation/*.js');
    autoWatcher.onDidCreate(() => autoEmitter.fire());
    autoWatcher.onDidDelete(() => autoEmitter.fire());
    autoWatcher.onDidChange(() => autoEmitter.fire());
    context.subscriptions.push(
        autoTree, autoWatcher,
        vscode.commands.registerCommand('oric-debug.automationRunItem', node => { if (node && node.fsPath) runAutomationScript(node.fsPath); }),
        vscode.commands.registerCommand('oric-debug.automationOpenItem', node => { if (node && node.fsPath) vscode.window.showTextDocument(vscode.Uri.file(node.fsPath)); }),
        vscode.commands.registerCommand('oric-debug.automationRefresh', () => autoEmitter.fire()),
        vscode.commands.registerCommand('oric-debug.automationOpenFolder', async () => {
            const dir = await automationFolder();
            if (!dir || !require('fs').existsSync(dir)) { vscode.window.showInformationMessage('No automation folder yet — create <project>/automation/ (scripts) with utilities in automation/lib/.'); return; }
            vscode.env.openExternal(vscode.Uri.file(dir));
        })
    );

    // --- Oric Documentation panel — quick links to the manual + internal/external references.
    // Static rows: each fires a command (internal reference panels) or opens a URL (external).
    // Each row gets a distinct theme-aware icon colour (charts.* palette). VS Code doesn't let a
    // TreeView recolour label/description text, but icon tints via ThemeColor are supported and
    // adapt to light/dark themes — enough to give the panel some colour.
    const docsItems = [
        { sep: true, label: '— documentation —' },
        { label: 'Extension manual', icon: 'book', color: 'charts.blue', desc: 'This extension’s page & README', cmd: 'oric-debug.openManual' },
        { label: 'XA assembler reference', icon: 'symbol-keyword', color: 'charts.purple', desc: 'Internal quick reference', cmd: 'osdk.xaReference' },
        { label: '6502 opcode reference', icon: 'symbol-numeric', color: 'charts.green', desc: 'Internal quick reference', cmd: 'osdk.6502Reference' },
        { sep: true, label: '— useful links —' },
        { label: 'OSDK website', icon: 'globe', color: 'charts.orange', desc: 'osdk.org (external)', cmd: 'vscode.open', args: [vscode.Uri.parse('http://www.osdk.org')] },
        { label: 'Defence Force forum', icon: 'comment-discussion', color: 'charts.yellow', desc: 'forum.defence-force.org (external)', cmd: 'vscode.open', args: [vscode.Uri.parse('https://forum.defence-force.org')] },
        // Quick shortcuts to the UI tabs — avoids CTRL+SHIFT+P to find and run them.
        // iconFile reuses the same panel SVG as the tab itself, for visual consistency.
        { sep: true, label: '— debugger panels —' },
        { label: 'Disassembly', iconFile: 'panel-disasm-v2', desc: 'Open the disassembly view', cmd: 'oric-debug.openDisassembly' },
        { label: 'Screen View', iconFile: 'panel-screen-v2', desc: 'Open the screen view', cmd: 'oric-debug.openScreenView' },
        { label: 'Memory Map', iconFile: 'panel-memory-v2', desc: 'Open the memory map', cmd: 'oric-debug.openMemoryMap' },
        { label: 'Memory Heatmap', iconFile: 'panel-heatmap-v2', desc: 'Open the memory heatmap', cmd: 'oric-debug.openHeatmap' },
        { label: 'Memory View', iconFile: 'panel-memory-v2', desc: 'Open the memory view', cmd: 'oric-debug.openMemoryView' },
        { label: 'Symbol Browser', iconFile: 'panel-symbols-v2', desc: 'Open the symbol browser', cmd: 'oric-debug.openSymbols' }
    ];
    const docsProvider = {
        getChildren: () => docsItems,
        getTreeItem: (it) => {
            // Separator rows: a header-like label, no icon, no command (click does nothing).
            if (it.sep) {
                const t = new vscode.TreeItem(it.label, vscode.TreeItemCollapsibleState.None);
                t.contextValue = 'oricDocSep';   // no row commands bound to this contextValue
                return t;
            }
            const t = new vscode.TreeItem(it.label);
            t.iconPath = it.iconFile
                ? panelIcon(it.iconFile)                                          // same SVG as the panel tab
                : new vscode.ThemeIcon(it.icon, it.color ? new vscode.ThemeColor(it.color) : undefined);
            t.description = it.desc;
            t.tooltip = it.desc;
            t.command = { command: it.cmd, title: it.label, arguments: it.args || [] };
            return t;
        }
    };
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('oricDocs', docsProvider),
        // Open the extension's page (README rendered inside VS Code); fall back to a README preview.
        vscode.commands.registerCommand('oric-debug.openManual', async () => {
            try { await vscode.commands.executeCommand('extension.open', 'dbug.osdk-debug'); }
            catch (e) {
                const readme = vscode.Uri.file(nodePath.join(nodePath.dirname(__filename), 'README.md'));
                vscode.commands.executeCommand('markdown.showPreview', readme).then(undefined, () => vscode.commands.executeCommand('vscode.open', readme));
            }
        })
    );

    // Tint source-file name labels (editor tabs + Explorer) by type — .c green, .h gray, .s/.asm
    // blue, .js violet — via a FileDecorationProvider (theme colors only; label text, not
    // background). No type badge: the extension already names the type, and the badge slot is left
    // for git's M/A/U marks. Toggle with the
    // oric-debug.colorSourceFilesByType setting; colors are the oric.* theme colors (user-overridable).
    const fileColorEmitter = new vscode.EventEmitter();
    const fileColorProvider = {
        onDidChangeFileDecorations: fileColorEmitter.event,
        provideFileDecoration(uri) {
            if (uri.scheme !== 'file') return undefined;
            if (!vscode.workspace.getConfiguration('oric-debug').get('colorSourceFilesByType', true)) return undefined;
            const ext = nodePath.extname(uri.fsPath).toLowerCase();
            // Tint only — no type badge. The extension is already in the name, so
            // a "JS"/"C" badge would just duplicate it; the badge slot is left for
            // git's own M/A/U marks, which have no other indicator.
            if (ext === '.c') return { color: new vscode.ThemeColor('oric.cFileColor'), tooltip: 'C source' };
            if (ext === '.h') return { color: new vscode.ThemeColor('oric.headerFileColor'), tooltip: 'C / assembler header' };
            if (ext === '.s' || ext === '.asm') return { color: new vscode.ThemeColor('oric.asmFileColor'), tooltip: '6502 assembler' };
            if (ext === '.js') return { color: new vscode.ThemeColor('oric.scriptFileColor'), tooltip: 'Automation script' };
            return undefined;
        }
    };
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(fileColorProvider),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('oric-debug.colorSourceFilesByType')) fileColorEmitter.fire(undefined); })
    );

    // Re-read source @annotations into the running adapter — no rebuild, no lost
    // debugger state. Panels/watch refresh via the adapter's oricSymbolsChanged
    // event; refreshAll() also updates registers + the inline instruction hint.
    // `explicit` = user-invoked (palette/command): show feedback and a
    // no-session notice; auto-on-save stays silent.
    async function reparseAnnotations(explicit) {
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'oric-debug') {
            if (explicit) vscode.window.showInformationMessage('Oric: start a debug session first — reparse updates the live one.');
            return;
        }
        try {
            const r = await session.customRequest('reparseAnnotations');
            refreshAll();
            const n = r && typeof r.count === 'number' ? r.count : null;
            vscode.window.setStatusBarMessage('Oric: reparsed annotations' + (n !== null ? ' — ' + n + ' active' : ''), 4000);
        } catch (e) {
            if (explicit) vscode.window.showErrorMessage('Oric reparse failed: ' + (e && e.message ? e.message : String(e)));
        }
    }

    // Auto-reparse on save: editing an annotation in a source file and saving
    // makes it live immediately, mid-debug. Only source files that can carry
    // annotations trigger it, and only while an oric-debug session is running.
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
        if (!/\.(h|s|asm|c)$/i.test(doc.fileName)) return;
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'oric-debug') return;
        reparseAnnotations(false);
    }));

    // Push the oric-debug.showBinary setting to the live session when it changes,
    // so toggling the %binary column applies immediately without relaunching.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('oric-debug.showBinary')) return;
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'oric-debug') return;
        const on = vscode.workspace.getConfiguration('oric-debug').get('showBinary', true);
        session.customRequest('setShowBinary', { on }).then(() => refreshAll(), () => {});
    }));

    // Reload the symbol file after a rebuild WITHOUT relaunching — for changes
    // the build produced but that are byte-identical (new enum members, types,
    // symbols). The adapter gates on the disk-image hash: if the binary changed,
    // it refuses and tells you to restart (the emulator holds the old binary).
    async function reloadSymbols() {
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'oric-debug') {
            vscode.window.showInformationMessage('Oric: start a debug session first.');
            return;
        }
        try {
            const r = await session.customRequest('reloadSymbols');
            if (r && r.reloaded) {
                refreshAll();
                vscode.window.setStatusBarMessage('Oric: reloaded symbols — ' + r.symbols + ' symbols (binary unchanged)', 5000);
            } else if (r && r.changed) {
                vscode.window.showWarningMessage('Oric: the binary changed since launch — restart the debug session to load the new build (the emulator is still running the old one).');
            } else {
                vscode.window.showInformationMessage('Oric: symbols not reloaded' + (r && r.reason ? ' — ' + r.reason : ''));
            }
        } catch (e) {
            vscode.window.showErrorMessage('Oric reload-symbols failed: ' + (e && e.message ? e.message : String(e)));
        }
    }

    // --- Editor hover provider: show symbol info + heatmap highlight ---
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('osdk', {
            provideHover(document, position) {
                const range = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
                if (!range) {
                    // Try hex address like $XXXX
                    const hexRange = document.getWordRangeAtPosition(position, /\$[0-9a-fA-F]{2,4}/);
                    if (hexRange) {
                        const hexWord = document.getText(hexRange);
                        const addr = parseInt(hexWord.substring(1), 16);
                        if (addr >= 0 && addr <= 0xFFFF) {
                            highlightHeatmapAddr(addr);
                            return new vscode.Hover(
                                new vscode.MarkdownString('**$' + addr.toString(16).toUpperCase().padStart(4, '0') + '** (address ' + addr + ')'),
                                hexRange
                            );
                        }
                    }
                    return null;
                }
                const word = document.getText(range);

                // Check symbol cache first (runtime symbols with live values)
                const sym = symbolCache.get(word);
                if (sym) {
                    highlightHeatmapAddr(sym.addr);

                    const h4 = v => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
                    const h2 = v => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
                    let valueTxt = '?';
                    if (sym.value && sym.value.length === 1) {
                        valueTxt = h2(sym.value[0]) + ' (' + sym.value[0] + ')';
                    } else if (sym.value && sym.value.length === 2) {
                        const w = sym.value[0] | (sym.value[1] << 8);
                        valueTxt = h4(w) + ' (' + w + ')';
                    } else if (sym.value && sym.value.length > 2) {
                        valueTxt = sym.value.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
                    }
                    const groupLabel = sym.group === 'zp' ? 'ZP' : sym.group === 'ram' ? 'RAM' : 'High';
                    let md = '**' + word + '** \u2014 ' + h4(sym.addr) + ' (' + sym.size + ' byte' + (sym.size > 1 ? 's' : '') + ', ' + groupLabel + ')  \n';
                    if (sym.aliases && sym.aliases.length > 0) {
                        const allNames = [word];
                        for (const [k, v] of symbolCache) {
                            if (v === sym && k !== word && !allNames.includes(k)) allNames.push(k);
                        }
                        if (allNames.length > 1) {
                            md += 'Also known as: ' + allNames.filter(n => n !== word).join(', ') + '  \n';
                        }
                    }
                    md += 'Value: ' + valueTxt;
                    const perNameSrc = sym.nameSources && sym.nameSources[word];
                    const src = perNameSrc || sym.source;
                    if (src && src.file) {
                        const pathMod = require('path');
                        md += '  \nDefined in: ' + pathMod.basename(src.file) + ':' + src.line + ' \u2014 ' + gotoGesture() + ' to go';
                    }
                    return new vscode.Hover(new vscode.MarkdownString(md), range);
                }

                // Check define cache (preprocessor #define constants)
                const def = defineCache.get(word);
                if (def) {
                    if (def.numValue !== null && def.numValue >= 0 && def.numValue <= 0xFFFF) {
                        highlightHeatmapAddr(def.numValue);
                    }
                    const pathMod = require('path');
                    let md = '**' + word + '** \u2014 `#define`  \n';
                    md += 'Value: `' + def.value + '`';
                    if (def.numValue !== null) md += ' (' + def.numValue + ')';
                    md += '  \nDefined in: ' + pathMod.basename(def.file) + ':' + def.line + ' \u2014 ' + gotoGesture() + ' to go';
                    return new vscode.Hover(new vscode.MarkdownString(md), range);
                }

                return null;
            }
        }),
        // Definition provider: Ctrl+Click / F12 to jump to symbol/define source
        vscode.languages.registerDefinitionProvider('osdk', {
            provideDefinition(document, position) {
                const range = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
                if (!range) return null;
                const word = document.getText(range);
                // Check symbols
                const sym = symbolCache.get(word);
                if (sym) {
                    const perNameSrc = sym.nameSources && sym.nameSources[word];
                    const src = perNameSrc || sym.source;
                    if (src && src.file) {
                        return new vscode.Location(
                            vscode.Uri.file(src.file),
                            new vscode.Position((src.line || 1) - 1, 0)
                        );
                    }
                }
                // Check defines
                const def = defineCache.get(word);
                if (def && def.file) {
                    return new vscode.Location(
                        vscode.Uri.file(def.file),
                        new vscode.Position((def.line || 1) - 1, 0)
                    );
                }
                return null;
            }
        }),
        vscode.window.onDidChangeTextEditorSelection(e => {
            restoreHeatmapPcHighlight();
            // A genuine click or keyboard move in a source editor returns to statement
            // stepping — even when that editor was already the active one (in which case
            // onDidChangeActiveTextEditor never fires, which is why clicking a
            // already-focused .c file previously failed to leave instruction mode).
            // e.kind distinguishes a real user selection from the programmatic reveal
            // VS Code performs when the debugger stops.
            const K = vscode.TextEditorSelectionChangeKind;
            if (e && (e.kind === K.Mouse || e.kind === K.Keyboard)
                && e.textEditor && e.textEditor.document
                && e.textEditor.document.uri.scheme === 'file') {
                setInstrStepMode(false);
            }
        })
    );

    watchMemento = context.workspaceState;
    watchedExprs = watchMemento.get('oric-debug.watchExpressions', []).slice();
    symbolMru = watchMemento.get('oric-debug.symbolSearchMru', []).slice();

    const regsProvider = new RegistersWebviewProvider();
    const periphProvider = new PeripheralsWebviewProvider();
    // Grey the live-data views when the debugger isn't stopped (see setOricDebugStopped).
    dimLiveViews = () => { regsProvider.markStale(); periphProvider.markStale(); markInstrStale(); refreshWatchValues(null); setMemoryPanelsStale(true); };
    refreshAllViews = refreshAll;   // module-level hook so the automation debounce can repaint the panels

    debugControlsProvider = new DebugControlsWebviewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('oricDebugControls', debugControlsProvider),
        vscode.debug.onDidStartDebugSession(s => { if (s && s.type === 'oric-debug') { oricSessionActive = true; oricWarpOn = false; } debugControlsProvider.pushState(); snapDecoEmitter.fire(); postScreenRunState(); bridgeUpdateStatusBar(); }),
        vscode.debug.onDidTerminateDebugSession(() => { oricSessionActive = false; oricWarpOn = false; debugControlsProvider.pushState(); snapDecoEmitter.fire(); postScreenRunState(); bridgeUpdateStatusBar(); }),
        vscode.window.registerWebviewViewProvider('oricCpuRegs', regsProvider),
        vscode.window.registerWebviewViewProvider('oricPeripherals', periphProvider),
        vscode.commands.registerCommand('oric-debug.openMemoryView', () => createMemoryPanel(context)),
        vscode.commands.registerCommand('oric-debug.openHeatmap', () => createHeatmapPanel()),
        vscode.commands.registerCommand('oric-debug.openScreenView', () => createScreenPanel()),
        vscode.commands.registerCommand('oric-debug.skipInstruction', () => {
            const session = vscode.debug.activeDebugSession;
            if (session && session.type === 'oric-debug') {
                session.customRequest('skip').catch(e => {
                    vscode.window.showErrorMessage('Skip failed: ' + e.message);
                });
            }
        }),
        // Replay navigation (redo-capable history ring): rewind / forward / to-head.
        // Non-destructive — rewinding keeps the future so Forward/to-Head can return.
        vscode.commands.registerCommand('oric-debug.replayRewind', () => replayNav('oricReplayRewind')),
        vscode.commands.registerCommand('oric-debug.replayForward', () => replayNav('oricReplayForward')),
        vscode.commands.registerCommand('oric-debug.replayToHead', () => replayNav('oricReplayToHead')),
        vscode.commands.registerCommand('oric-debug.toggleWarp', () => doToggleWarp()),
        vscode.commands.registerCommand('oric-debug.warpOn', () => doToggleWarp()),
        vscode.commands.registerCommand('oric-debug.warpOff', () => doToggleWarp()),
        vscode.commands.registerCommand('oric-debug.resetCycleCounter', () => {
            const session = vscode.debug.activeDebugSession;
            if (session && session.type === 'oric-debug') {
                session.customRequest('resetCycles').then(() => {
                    vscode.window.setStatusBarMessage('Cycle counter reset', 3000);
                    regsProvider.refresh(session);
                }).catch(e => {
                    vscode.window.showErrorMessage('Reset cycles failed: ' + e.message);
                });
            }
        }),
        vscode.commands.registerCommand('osdk.xaReference', () => createXaReferencePanel()),
        vscode.commands.registerCommand('osdk.6502Reference', () => create6502ReferencePanel()),
        vscode.commands.registerCommand('oric-debug.openSymbols', () => createSymbolsPanel(context)),
        vscode.commands.registerCommand('oric-debug.openMemoryMap', () => createMemoryMapPanel()),
        vscode.commands.registerCommand('oric-debug.reparseAnnotations', () => reparseAnnotations(true)),
        vscode.commands.registerCommand('oric-debug.reloadSymbols', () => reloadSymbols()),
        vscode.commands.registerCommand('oric-debug.toggleBinary', async () => {
            const cfg = vscode.workspace.getConfiguration('oric-debug');
            const next = !cfg.get('showBinary', true);
            await cfg.update('showBinary', next, vscode.ConfigurationTarget.Global);
            vscode.window.setStatusBarMessage('Oric: %binary in values ' + (next ? 'on' : 'off'), 3000);
        }),
        vscode.commands.registerCommand('oric-debug.openDisassembly', () => createDisasmPanel()),
        vscode.commands.registerCommand('oric-debug.stepOverInstruction', async () => {
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== 'oric-debug') return;
            try {
                const threads = await session.customRequest('threads');
                const threadId = (threads.threads && threads.threads[0]) ? threads.threads[0].id : 1;
                await session.customRequest('next', { threadId, granularity: 'instruction' });
            } catch (_) {}
        }),
        vscode.commands.registerCommand('oric-debug.stepIntoInstruction', async () => {
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== 'oric-debug') return;
            try {
                const threads = await session.customRequest('threads');
                const threadId = (threads.threads && threads.threads[0]) ? threads.threads[0].id : 1;
                await session.customRequest('stepIn', { threadId, granularity: 'instruction' });
            } catch (_) {}
        }),
        vscode.commands.registerCommand('oric-debug.showCurrentLocation', async () => {
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== 'oric-debug') return;
            try {
                const threads = await session.customRequest('threads');
                const threadId = (threads.threads && threads.threads[0]) ? threads.threads[0].id : 1;
                const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
                if (stack.stackFrames && stack.stackFrames.length > 0) {
                    autoNavigateFromFrame(stack.stackFrames[0]);
                }
            } catch (_) {}
        }),

        vscode.commands.registerCommand('oric-debug.turboRunToCursor', async () => {
            const ed = vscode.window.activeTextEditor;
            // No editor = plain turbo run (warp + continue, no target breakpoint).
            await requestTurboRun(ed ? { file: ed.document.uri.fsPath, line: ed.selection.active.line + 1 } : {});
        }),

        // Copy the current inline instruction annotation to the clipboard —
        // retyping "(_gStreamItemPtr→item.flags)=ITEM_FLAG_…" by hand is not a
        // workflow (user request). Native VS Code clipboard API, cross-platform.
        vscode.commands.registerCommand('oric-debug.copyInstructionAnnotation', async () => {
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== 'oric-debug') return;
            try {
                const r = await session.customRequest('resolveInstruction');
                if (r && r.annotation) {
                    await vscode.env.clipboard.writeText(r.annotation);
                    vscode.window.setStatusBarMessage('Copied: ' + r.annotation.slice(0, 60), 3000);
                } else {
                    vscode.window.setStatusBarMessage('No instruction annotation to copy', 3000);
                }
            } catch (e) {
                vscode.window.showErrorMessage('Copy annotation failed: ' + (e && e.message ? e.message : e));
            }
        }),

        // Copy a source line EXACTLY as seen on screen — the raw text plus the
        // inline decoded annotation the debugger renders after it. Made for
        // reporting a problem: right-click the gutter, paste the full context.
        // The annotation only exists for the current PC line (that's the only
        // line the adapter decodes), so off-PC lines copy just the source text.
        // Falls back to the active editor's cursor line when invoked without a
        // gutter context (palette / keybinding).
        vscode.commands.registerCommand('oric-debug.copyLine', async (ctx) => {
            let uri, lineNumber; // 1-based, matching ctx.lineNumber and instrDecoLine
            if (ctx && ctx.uri && typeof ctx.lineNumber === 'number') {
                uri = ctx.uri; lineNumber = ctx.lineNumber;
            } else {
                const ed = vscode.window.activeTextEditor;
                if (!ed) { vscode.window.setStatusBarMessage('Copy line: no active editor', 3000); return; }
                uri = ed.document.uri; lineNumber = ed.selection.active.line + 1;
            }
            let out;
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                out = doc.lineAt(lineNumber - 1).text.replace(/\s+$/, '');
            } catch (e) {
                vscode.window.showErrorMessage('Copy line failed: ' + (e && e.message ? e.message : e));
                return;
            }
            // Append the on-screen inline annotation when this IS the decorated line.
            if (instrDecoText && instrDecoFile
                && canonPath(uri.fsPath) === canonPath(instrDecoFile) && lineNumber === instrDecoLine) {
                out += '    ' + instrDecoText;
            }
            await vscode.env.clipboard.writeText(out);
            vscode.window.setStatusBarMessage('Copied line: ' + out.trim().slice(0, 70), 3000);
        }),

        // --- Line-targeted debug actions (line-number gutter menu + CodeLens) ---
        // Run/jump reuse the built-in cursor commands after positioning the caret
        // on the requested line; turbo goes straight to the adapter, which takes
        // an explicit file+line.
        vscode.commands.registerCommand('oric-debug.runToLine', async (ctx) => {
            // jump/turbo are refused adapter-side on data lines; run-to goes
            // through the built-in breakpoint machinery, so validate here.
            if (!ctx || !ctx.uri || !(await lineExecutable(ctx.uri, ctx.lineNumber))) return;
            if (await cursorToLine(ctx)) vscode.commands.executeCommand('editor.debug.action.runToCursor');
        }),
        vscode.commands.registerCommand('oric-debug.jumpToLine', async (ctx) => {
            if (ctx && ctx.uri) await gotoSourceLine(ctx.uri, ctx.lineNumber);
        }),
        vscode.commands.registerCommand('oric-debug.skipLine', async (ctx) => {
            // Skip = jump to the first executable line AFTER this one.
            if (ctx && ctx.uri) await gotoSourceLine(ctx.uri, ctx.lineNumber + 1, ctx.lineNumber);
        }),
        vscode.commands.registerCommand('oric-debug.turboRunToLine', async (ctx) => {
            if (ctx && ctx.uri) await requestTurboRun({ file: ctx.uri.fsPath, line: ctx.lineNumber });
        }),

        vscode.commands.registerCommand('oric-debug.selectModule', async () => {
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== 'oric-debug') return;
            try {
                const r = await session.customRequest('getModules');
                if (!r || !r.modules || r.modules.length === 0) {
                    vscode.window.showInformationMessage('This project uses a single symbol module.');
                    return;
                }
                const pick = await vscode.window.showQuickPick(
                    r.modules.map(m => ({ label: (m.active ? '$(check) ' : '$(circle-outline) ') + m.name, id: m.id })),
                    { placeHolder: 'Select the active Oric module (which overlay’s symbols to use)' });
                if (pick) {
                    const resp = await session.customRequest('setActiveModule', { id: pick.id });
                    if (resp && resp.name) vscode.window.setStatusBarMessage('Oric module: ' + resp.name, 4000);
                }
            } catch (e) {
                vscode.window.showErrorMessage('Module select failed: ' + (e && e.message ? e.message : e));
            }
        }),
        vscode.commands.registerCommand('oric-debug.selectLogLevel', async () => {
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== 'oric-debug') return;
            try {
                const pick = await vscode.window.showQuickPick(
                    [
                        { label: 'Errors',  description: 'errors only',              level: 0 },
                        { label: 'Normal',  description: 'default — key events',     level: 1 },
                        { label: 'Verbose', description: 'full GDB/DAP trace',        level: 2 }
                    ],
                    { placeHolder: 'Debug console log verbosity' });
                if (pick) {
                    const resp = await session.customRequest('setLogLevel', { level: pick.level });
                    if (resp && resp.name) vscode.window.setStatusBarMessage('Oric log level: ' + resp.name, 3000);
                }
            } catch (e) {
                vscode.window.showErrorMessage('Log level change failed: ' + (e && e.message ? e.message : e));
            }
        })
    );

    // --- Webview serializers: restore panels after VS Code reload ---
    vscode.window.registerWebviewPanelSerializer('oricHeatmap', {
        async deserializeWebviewPanel(panel) {
            heatmapPanel = panel; panel.iconPath = panelIcon('panel-heatmap-v2');
            panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
            panel.webview.html = heatmapPanelHtml();
            panel.onDidDispose(() => { heatmapPanel = null; vizUnregisterConsumer(heatmapConsumer); });
            vizRegisterConsumer(heatmapConsumer);
        }
    });
    vscode.window.registerWebviewPanelSerializer('oricMemory', {
        async deserializeWebviewPanel(panel, state) {
            panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
            wireMemoryPanel(panel, state && state.entries);   // restores the saved expressions
        }
    });
    vscode.window.registerWebviewPanelSerializer('oricScreenView', {
        async deserializeWebviewPanel(panel) {
            wireScreenPanel(panel);   // same setup + message handler as createScreenPanel (DRY)
        }
    });
    vscode.window.registerWebviewPanelSerializer('oricMemoryMap', {
        async deserializeWebviewPanel(panel) {
            wireMemoryMapPanel(panel);   // same setup as createMemoryMapPanel (DRY)
        }
    });
    vscode.window.registerWebviewPanelSerializer('oricSymbols', {
        async deserializeWebviewPanel(panel) {
            symbolsPanel = panel;
            panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
            panel.webview.html = symbolsPanelHtml();
            setupSymbolsPanel(panel);
            refreshSymbolsPanel(vscode.debug.activeDebugSession);
        }
    });
    vscode.window.registerWebviewPanelSerializer('oricDisassembly', {
        async deserializeWebviewPanel(panel) {
            adoptDisasmPanel(panel);
            if (panel.active) setInstrStepMode(true);
        }
    });

    function isDisasmFocused() {
        for (const p of disasmPanels) if (p.active) return true;
        return false;
    }

    function refreshAll() {
        const session = vscode.debug.activeDebugSession;
        const lightMode = isDisasmFocused(); // instruction-stepping: skip heavy refreshes
        regsProvider.refresh(session);
        refreshWatchValues(session); // watches matter while stepping — always refresh
        refreshDisasmPanel(session);
        if (!lightMode) {
            periphProvider.refresh(session);
            refreshMemoryPanels(session);
            refreshSymbolsPanel(session);
        }
        refreshInstructionAnnotation(session);
    }

    // Auto-navigate: VS Code doesn't always switch back from a virtual
    // disassembly tab to a real source file when the frame changes.
    // This handler ensures we open the source file when it's available.
    let pendingNavigate = false;
    let disassemblyAutoOpened = false; // auto-open disassembly view once per session

    async function autoNavigateFromFrame(topFrame) {
        try {
            // Don't steal focus from the disassembly view or VS Code's built-in one.
            // When either is focused, activeTextEditor is undefined (webview) or we
            // check our own panel. Skipping navigation keeps focus there so subsequent
            // F10 presses still send granularity=instruction.
            if (!vscode.window.activeTextEditor) return;
            if (isDisasmFocused()) return;

            if (topFrame.source && topFrame.source.path && topFrame.line > 0) {
                const uri = vscode.Uri.file(topFrame.source.path);
                const line = topFrame.line - 1; // 0-based
                const doc = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(doc, {
                    preview: true,
                    preserveFocus: false,
                    viewColumn: vscode.ViewColumn.One
                });
                const range = new vscode.Range(line, 0, line, 0);
                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
            // No-source case: the debug adapter now provides a virtual
            // disassembly source, so VS Code opens it automatically.
        } catch (_) {
            // Silently ignore — don't break the debug experience
        }
    }

    // --- GitLens current-line blame suppression during debug ---
    // Our inline value annotation renders at end-of-line on the current line —
    // the same slot GitLens uses for current-line blame, which would hide ours
    // (its long, truncated text pushes ours past the viewport). The user doesn't
    // want git blame while tracing, so turn it off for the session and restore it
    // afterwards. The prior value is mirrored to workspaceState for crash recovery.
    async function suppressGitLensBlame() {
        if (!vscode.extensions.getExtension('eamodio.gitlens')) return;
        const cfg = vscode.workspace.getConfiguration('gitlens');
        if (cfg.get('currentLine.enabled') === false) return; // already off — nothing to change or restore
        const insp = cfg.inspect('currentLine.enabled');
        const prevGlobal = insp ? insp.globalValue : undefined; // undefined = no explicit override
        // Store null for "no override" (workspaceState can't hold undefined meaningfully).
        await context.workspaceState.update(GITLENS_BLAME_KEY, { prev: prevGlobal === undefined ? null : prevGlobal });
        await cfg.update('currentLine.enabled', false, vscode.ConfigurationTarget.Global);
    }
    async function restoreGitLensBlame() {
        const saved = context.workspaceState.get(GITLENS_BLAME_KEY);
        if (!saved) return;
        await context.workspaceState.update(GITLENS_BLAME_KEY, undefined);
        if (!vscode.extensions.getExtension('eamodio.gitlens')) return;
        const cfg = vscode.workspace.getConfiguration('gitlens');
        // null -> undefined restores "no explicit override" (GitLens default of true).
        await cfg.update('currentLine.enabled', saved.prev === null ? undefined : saved.prev, vscode.ConfigurationTarget.Global);
    }
    // Crash recovery: a prior session that died mid-run may have left blame off.
    if (!vscode.debug.activeDebugSession || vscode.debug.activeDebugSession.type !== 'oric-debug') {
        restoreGitLensBlame();
    }

    const moduleStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    moduleStatusBar.command = 'oric-debug.selectModule';
    moduleStatusBar.tooltip = 'Active Oric symbol module — click to change';
    context.subscriptions.push(moduleStatusBar);
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => moduleStatusBar.hide()));

    // AI-collaboration control indicator — shown only while the bridge is up; click = take control.
    bridgeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
    bridgeStatusBar.command = 'oric-debug.takeControl';
    context.subscriptions.push(bridgeStatusBar);
    bridgeUpdateStatusBar();   // reflect initial state (e.g. after a mid-session window reload)
    // A collaborating client must re-attach per session; tell it the session ended and re-assert
    // human control (so the AI can't keep "piloting" a dead session).
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(s => {
        if (s && s.type !== 'oric-debug') return;
        if (bridgeServer) bridgeServer.broadcast('ended', {});
        if (bridgeControl === BRIDGE_CONTROL.AI) setBridgeControl(BRIDGE_CONTROL.HUMAN);
    }));

    // Debug console verbosity — click to pick Errors / Normal / Verbose.
    const logLevelStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
    logLevelStatusBar.command = 'oric-debug.selectLogLevel';
    logLevelStatusBar.tooltip = 'Oric debug log verbosity — click to change';
    context.subscriptions.push(logLevelStatusBar);
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => logLevelStatusBar.hide()));

    // Step granularity (Statement vs Instruction). Reflects the mode set by clicking a
    // source editor vs the Oric Disassembly; also clickable to toggle directly.
    // Hover help for the Debug Controls buttons: their descriptions + shortcuts appear
    // here on mouse-over (a visible alternative to tooltips, which a large cursor covers).
    // LEFT-aligned with a very LOW priority so it's the LAST (right-most) item of the left
    // group — to the right of Build & Debug and our other items. For left-aligned items a
    // lower priority sits further right, so with nothing to its right and the middle gap to
    // its left of the right group, it shows/hides on mouse-move WITHOUT shifting anything.
    hoverHelpStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100000);
    hoverHelpStatusBar.color = '#e3b341';   // amber accent so the help reads as a hint, not a plain white line
    context.subscriptions.push(hoverHelpStatusBar);

    stepModeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
    stepModeStatusBar.command = 'oric-debug.toggleStepMode';
    stepModeStatusBar.tooltip = 'F10/F11 step granularity — click to toggle (or select a source / the Oric Disassembly)';
    stepModeStatusBar.text = '$(debug-step-over) Step: Statement';
    context.subscriptions.push(stepModeStatusBar);
    context.subscriptions.push(vscode.commands.registerCommand('oric-debug.toggleStepMode', () => setInstrStepMode(!instrStepMode)));
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => { stepModeStatusBar.hide(); if (hoverHelpStatusBar) hoverHelpStatusBar.hide(); setInstrStepMode(false); }));
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(s => { if (s.type === 'oric-debug') stepModeStatusBar.show(); }));

    // Clicking a source editor returns to statement stepping — but ignore the automatic
    // focus change VS Code makes on reveal-on-stop (within REVEAL_ON_STOP_MS of a stop),
    // which isn't a real user selection.
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document && editor.document.uri.scheme === 'file'
            && (Date.now() - lastStopMs) > REVEAL_ON_STOP_MS) {
            setInstrStepMode(false);
        }
    }));

    // Keep the disassembly view's breakpoint dots in sync with VS Code's model —
    // whether a breakpoint changed via the source gutter, the Breakpoints panel,
    // the disasm gutter, or (via inbound promotion) Oricutron itself.
    context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(() => {
        const session = vscode.debug.activeDebugSession;
        if (session && session.type === 'oric-debug') refreshDisasmPanel(session);
    }));

    // --- Cursor-line action CodeLens: one-click run/turbo/jump, no menu ---
    // Rendered only on the active editor's cursor line while an Oric session is
    // STOPPED, so editors are untouched outside debugging. Trial UX chosen by the
    // user alongside the line-number gutter menu — drop either if it doesn't
    // survive real use.
    const lensEmitter = new vscode.EventEmitter();
    lineActionLens = {
        onDidChangeCodeLenses: lensEmitter.event,
        refresh: () => lensEmitter.fire(),
        async provideCodeLenses(document) {
            if (!oricDebugStopped) return [];
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== 'oric-debug') return [];
            const ed = vscode.window.activeTextEditor;
            if (!ed || ed.document !== document) return [];
            const line = ed.selection.active.line;
            const range = new vscode.Range(line, 0, line, 0);
            const arg = { uri: document.uri, lineNumber: line + 1 };
            // Contextual: ON the PC line only "skip" is meaningful (you are
            // already here); on any other line skip is meaningless and the
            // movement actions apply.
            const onPcLine = currentStopLoc && line + 1 === currentStopLoc.line
                && canonPath(document.uri.fsPath) === canonPath(currentStopLoc.path);
            if (onPcLine)
                return [new vscode.CodeLens(range, { title: '↷ skip line', command: 'oric-debug.skipLine', arguments: [arg] })];
            // Movement actions only on executable lines — no "run to here" on a
            // .dsb data declaration (the breakpoint would never hit; a jump
            // would move the PC into storage).
            try {
                const info = await session.customRequest('lineInfo', { file: document.uri.fsPath, line: line + 1 });
                if (!info || info.addr < 0 || !info.executable) return [];
            } catch (e) { /* request unavailable: show rather than block */ }
            return [
                new vscode.CodeLens(range, { title: '▶ run to here', command: 'oric-debug.runToLine', arguments: [arg] }),
                new vscode.CodeLens(range, { title: '⚡ turbo run', command: 'oric-debug.turboRunToLine', arguments: [arg] }),
                new vscode.CodeLens(range, { title: '⌖ jump here', command: 'oric-debug.jumpToLine', arguments: [arg] }),
            ];
        }
    };
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lineActionLens));
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(() => {
        if (oricDebugStopped) lineActionLens.refresh();
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        if (oricDebugStopped) updatePcLineContext();
    }));
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => {
        setOricDebugStopped(false);
    }));

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('oric-debug', {
            createDebugAdapterTracker(session) {
                let addrBpsRestored = false;   // re-arm persisted address bps once per session
                return {
                    onDidSendMessage(msg) {
                        // Running/stopped state for the line actions (CodeLens + disasm panel).
                        if (msg.type === 'event' && (msg.event === 'stopped' || msg.event === 'continued')) {
                            setOricDebugStopped(msg.event === 'stopped', msg.body && msg.body.reason);
                        }
                        if (msg.type === 'event' && msg.event === 'stopped') {
                            // Re-arm persisted ADDRESS breakpoints (ROM / no-source) on the
                            // first stop — the adapter is now connected and responsive, which
                            // onDidStartDebugSession can't guarantee (too early / restart).
                            if (!addrBpsRestored) {
                                addrBpsRestored = true;
                                const saved = context.workspaceState.get(ADDR_BP_KEY, []);
                                if (Array.isArray(saved) && saved.length)
                                    session.customRequest('setAddressBreakpoints', { breakpoints: saved }).catch(() => {});
                                // Same for watchpoint events — re-send the full set once per session.
                                const wsaved = context.workspaceState.get(WATCH_BP_KEY, []);
                                if (Array.isArray(wsaved) && wsaved.length)
                                    session.customRequest('oricSetWatchpoints', {
                                        watchpoints: wsaved.filter(w => w && typeof w.address === 'number').map(w => ({
                                            id: w.id, addr: w.address, size: w.size || 1, access: w.access || 'write',
                                            module: w.module == null ? null : w.module, condition: w.condition || null,
                                            logMessage: w.logMessage || null, enabled: w.enabled !== false,
                                        })),
                                    }).catch(() => {});
                            }
                            // An automation script drives rapid stop/continue cycles — don't
                            // repaint panels or yank the editor on each one (that's the flicker);
                            // runAutomationScript repaints once at the end. (The bp restore above
                            // still runs, once, so a cold-started automation session is armed.)
                            if (!automationRunning) {
                                // Record the stop time so the imminent reveal-on-stop focus
                                // change (source editor) isn't mistaken for a user click that
                                // would flip step mode.
                                lastStopMs = Date.now();
                                // Drop the previous line's annotation at once so it can't
                                // flicker there during the post-step navigation churn; the
                                // fresh one is applied when refreshAll's resolve returns.
                                clearInstrDecoration();
                                setTimeout(() => refreshAll(), 50);
                                // While instruction-stepping (the disassembly panel is visible,
                                // tracked by the oricInstructionStepMode context key) don't yank
                                // the user to a source editor on each stop — that focus theft is
                                // what broke instruction-stepping. Source navigation resumes when
                                // they leave the disassembly view.
                                if (!instrStepMode) {
                                    pendingNavigate = true;
                                }
                                // Auto-open custom disassembly panel on first stop of session
                                if (!disassemblyAutoOpened) {
                                    disassemblyAutoOpened = true;
                                    setTimeout(() => createDisasmPanel(), 200);
                                }
                            }
                        }
                        // Refresh disasm dots once the adapter has actually applied a
                        // breakpoint change (its maps are updated at response time —
                        // onDidChangeBreakpoints fires earlier, before the round-trip).
                        if (msg.type === 'response' && msg.success &&
                            (msg.command === 'setBreakpoints' ||
                             msg.command === 'setInstructionBreakpoints' ||
                             msg.command === 'setFunctionBreakpoints')) {
                            refreshDisasmPanel(session);
                        }
                        // Track the stopped location (top frame) for the contextual
                        // line actions: the PC line offers only "skip", other lines
                        // offer run/turbo/jump.
                        if (msg.type === 'response' && msg.command === 'stackTrace' && msg.success) {
                            const f = msg.body && msg.body.stackFrames && msg.body.stackFrames[0];
                            currentStopLoc = (f && f.source && f.source.path && f.line > 0)
                                ? { path: f.source.path, line: f.line } : null;
                            updatePcLineContext();
                            if (lineActionLens) lineActionLens.refresh();
                            if (bpTreeEmitter) bpTreeEmitter.fire();   // highlight the matching breakpoint
                        }
                        // Intercept VS Code's own stackTrace response — the UI
                        // now has frame data, so opening disassembly will work.
                        if (pendingNavigate && msg.type === 'response' && msg.command === 'stackTrace' && msg.success) {
                            const frames = msg.body && msg.body.stackFrames;
                            if (frames && frames.length > 0) {
                                pendingNavigate = false;
                                // Small delay to let VS Code finish updating its call stack UI
                                setTimeout(() => autoNavigateFromFrame(frames[0]), 50);
                            }
                        }
                        // Handle cycle annotation events from the debug adapter
                        if (msg.type === 'event' && msg.event === 'cycleAnnotation' && msg.body) {
                            const ann = msg.body;
                            if (ann.file && ann.line > 0 && ann.cycles !== undefined) {
                                const filePath = canonPath(ann.file);
                                if (!cycleAnnotations.has(filePath)) {
                                    cycleAnnotations.set(filePath, new Map());
                                }
                                cycleAnnotations.get(filePath).set(ann.line, {
                                    cycles: ann.cycles,
                                    symbol: ann.symbol
                                });
                                applyCycleDecorations();
                            }
                        }
                        // Breakpoints set/cleared by hand in Oricutron's monitor —
                        // sync them into VS Code's model (Oricutron is just another view).
                        if (msg.type === 'event' && msg.event === 'oricMonitorBreakpoints' && msg.body) {
                            syncMonitorBreakpoints(msg.body);
                        }
                        // Adapter-owned address breakpoints (ROM / no-source) changed —
                        // refresh the Oric Breakpoints panel (Address category) + gutter dots.
                        if (msg.type === 'event' && msg.event === 'oricAddressBreakpoints') {
                            rebuildBpTree();
                            refreshDisasmPanel(vscode.debug.activeDebugSession);
                            // Mirror to workspaceState (the event carries the full list, incl.
                            // enabled state) — VS Code doesn't persist these, so we re-arm them
                            // on the next session's first stop.
                            if (msg.body && Array.isArray(msg.body.breakpoints))
                                context.workspaceState.update(ADDR_BP_KEY, msg.body.breakpoints);
                        }
                        // Active symbol module changed (auto-switch or manual) — reflect in status bar
                        if (msg.type === 'event' && msg.event === 'oricActiveModule' && msg.body) {
                            moduleStatusBar.text = '$(layers) Module: ' + msg.body.name;
                            moduleStatusBar.show();
                            activeOricModuleId = (msg.body.id !== undefined ? msg.body.id : null);
                            activeOricModuleName = (activeOricModuleId != null && msg.body.name && msg.body.name !== '(none)') ? msg.body.name : null;
                            if (bpTreeEmitter) bpTreeEmitter.fire();   // re-highlight / re-fold the active module
                        }
                        // Symbols (re)loaded or module switched — the cached symbol
                        // table is stale NOW, panel visible or not (the hover
                        // provider reads it too). Clear and refetch; a hidden panel
                        // repaints on reveal (setupSymbolsPanel's view-state hook).
                        if (msg.type === 'event' && msg.event === 'oricSymbolsChanged') {
                            symbolCache.clear();
                            refreshSymbolsPanel(session);
                            refreshWatchValues(session); // re-sort active/inactive on module switch
                            rebuildBpTree();             // module map may now be available/changed
                            refreshMemoryMap(session);   // rebuild the memory map for the new module/symbols
                        }
                        // Log verbosity changed (initial config, status bar, or console) — reflect it
                        if (msg.type === 'event' && msg.event === 'oricLogLevel' && msg.body) {
                            logLevelStatusBar.text = '$(output) Log: ' + msg.body.name;
                            logLevelStatusBar.show();
                            // Persist explicit changes per project so they survive across
                            // sessions; the initial value from config is not re-persisted.
                            if (!msg.body.initial && typeof msg.body.level === 'number') {
                                context.workspaceState.update(LOG_LEVEL_KEY, msg.body.level);
                            }
                        }
                    }
                };
            }
        }),
        vscode.debug.onDidStartDebugSession(s => {
            if (s.type === 'oric-debug') {
                const config = s.configuration;
                const gdbHost = config.host || 'localhost';
                const gdbPort = config.port || 6502;
                vizLog('Debug session started — GDB on ' + gdbHost + ':' + gdbPort);
                warnIfStaleExtension(s); // flag a stale host (on-disk extension.js newer than loaded)
                disassemblyAutoOpened = false;
                disasmCenterAddr = null;
                vscode.commands.executeCommand('setContext', 'oric-debug.warp', false); // session starts at normal speed
                scanDefines(); // Rescan defines (build may have regenerated headers)
                suppressGitLensBlame(); // free the end-of-line slot for our value annotation
                setTimeout(() => refreshAll(), 500);
                // Auto-connect viz stream if any consumer panels are open
                if (vizConsumers.size > 0) {
                    vizConnect(gdbHost, gdbPort + VIZ_PORT_OFFSET);
                }
            }
        }),
        vscode.debug.onDidTerminateDebugSession(() => {
            vizLog('Debug session terminated');
            vscode.commands.executeCommand('setContext', 'oric-debug.warp', false);
            refreshAll();
            vizDisconnect();
            clearCycleAnnotations();
            clearInstrDecoration();
            restoreGitLensBlame(); // give the user back their git blame
            lastPcAddr = -1;
            clearHeatmapHighlight();
            symbolCache.clear();
            disasmCenterAddr = null;
        })
    );
}

function deactivate() {
    try { stopMcpBridge(); } catch (_) {}   // close the collab bridge + remove its discovery file
    vizDisconnect();
    vizOutputChannel = null;
}

module.exports = { activate, deactivate };
