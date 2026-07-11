'use strict';

const vscode = require('vscode');

// workspaceState key: per-project debug console log verbosity (0/1/2).
// Persists an explicit runtime choice across sessions; scoped to the workspace
// so each Oric project keeps its own preference.
const LOG_LEVEL_KEY = 'oric-debug.logLevel';

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
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: false };
        this._updateHtml(null);
    }

    refresh(session) {
        if (!this._view) return;
        if (!session || session.type !== 'oric-debug') {
            this._updateHtml(null);
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
            this._updateHtml(regs, flags, extra);
        }).catch(() => this._updateHtml(null));
    }

    _updateHtml(regs, flags, extra) {
        if (!this._view) return;
        if (!regs) {
            this._view.webview.html = '<body style="color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);padding:8px"><i>No debug session</i></body>';
            this._prev = {};  // reset so next session starts fresh
            return;
        }

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
.mod { color: #e04040; }
.fon { color: var(--vscode-debugTokenExpression-number, #b5cea8); font-weight: bold; }
.fon.mod { color: #e04040; font-weight: bold; }
.foff { opacity: 0.35; }
.foff.mod { opacity: 1.0; color: #e04040; }
.sep { border-top: 1px solid var(--vscode-widget-border, #444); margin: 4px 0; }
</style></head><body>
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
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: false };
        this._updateHtml(null);
    }

    refresh(session) {
        if (!this._view) return;
        if (!session || session.type !== 'oric-debug') {
            this._updateHtml(null);
            return;
        }
        session.customRequest('readPeripherals').then(resp => {
            this._updateHtml(resp && resp.peripherals);
        }).catch(() => this._updateHtml(null));
    }

    _updateHtml(d) {
        if (!this._view) return;
        if (!d) {
            this._view.webview.html = '<body style="color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);padding:8px"><i>No debug session</i></body>';
            this._prev = {};
            return;
        }

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
.mod { color: #e04040; }
.x { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.hdr { color: var(--vscode-sideBarSectionHeader-foreground, #ccc); font-weight: bold; font-size: 0.95em; margin-top: 2px; }
.addr { color: var(--vscode-descriptionForeground, #888); font-weight: normal; font-size: 0.9em; }
.hr { border-top: 1px solid var(--vscode-widget-border, #444); margin: 4px 0; }
</style></head><body>${body}</body></html>`;
    }
}

// ----------------------------------------------------------------
// Memory View Panel (editor tab — multiple instances supported)
// ----------------------------------------------------------------

const memoryPanels = [];
let memoryPanelCounter = 0;

function bytesForEntry(entry) {
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

    const state = { entries: [], results: [] };

    panel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'add' && msg.expression) {
            const expr = msg.expression.trim();
            if (expr && !state.entries.some(e => e.expression === expr)) {
                const entry = { expression: expr, rows: 8, format: 'hex' };
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
        } else if (msg.type === 'configure' && typeof msg.index === 'number') {
            if (msg.index >= 0 && msg.index < state.entries.length) {
                const entry = state.entries[msg.index];
                if (msg.rows !== undefined) entry.rows = Math.max(1, Math.min(128, msg.rows));
                if (msg.format !== undefined) entry.format = msg.format;
                const session = vscode.debug.activeDebugSession;
                if (session && session.type === 'oric-debug') {
                    evaluateOne(session, state, msg.index).then(() => postResults(panel, state));
                } else {
                    state.results[msg.index] = { ...entry, address: state.results[msg.index].address, data: state.results[msg.index].data, error: state.results[msg.index].error };
                    postResults(panel, state);
                }
            }
        }
    });

    panel.onDidDispose(() => {
        const idx = memoryPanels.indexOf(panelEntry);
        if (idx >= 0) memoryPanels.splice(idx, 1);
    });

    const panelEntry = { panel, state };
    memoryPanels.push(panelEntry);
    panel.webview.html = memoryPanelHtml();
    return panel;
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

function refreshMemoryPanels(session) {
    for (const { panel, state } of memoryPanels) {
        if (!session || session.type !== 'oric-debug') {
            state.results = state.entries.map(e => ({ ...e, address: null, data: '', error: null }));
            postResults(panel, state);
            continue;
        }
        const promises = state.entries.map((_, i) => evaluateOne(session, state, i));
        Promise.all(promises).then(() => postResults(panel, state)).catch(() => postResults(panel, state));
    }
}

function memoryPanelHtml() {
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 8px 12px; margin: 0; }
.input-row { display: flex; gap: 4px; margin-bottom: 10px; }
.input-row input[type="text"] { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); padding: 4px 8px; font-family: inherit; font-size: inherit; }
.input-row button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; font-size: inherit; }
.input-row button:hover { background: var(--vscode-button-hoverBackground); }
.entry { margin-bottom: 10px; }
.entry-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; gap: 6px; }
.entry-hdr .left { display: flex; align-items: center; gap: 4px; flex-shrink: 1; min-width: 0; }
.entry-hdr .expr { color: var(--vscode-debugTokenExpression-name, #9cdcfe); font-weight: bold; white-space: nowrap; }
.entry-hdr .addr { color: var(--vscode-debugTokenExpression-number, #b5cea8); white-space: nowrap; }
.entry-hdr .controls { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.rows-input { width: 38px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); padding: 1px 3px; font-family: inherit; font-size: 0.9em; text-align: center; }
.rows-label { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.fmt-select { background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, #444)); padding: 1px 3px; font-family: inherit; font-size: 0.9em; }
.remove { cursor: pointer; color: var(--vscode-descriptionForeground, #888); padding: 0 2px; font-size: 1.2em; }
.remove:hover { color: var(--vscode-errorForeground, #f44); }
.dump { white-space: pre; line-height: 1.4; color: var(--vscode-editor-foreground); }
.dump .addr-col { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.dump .ascii { color: var(--vscode-descriptionForeground, #888); }
.error { color: var(--vscode-errorForeground, #f44); font-style: italic; }
.sep { border-top: 1px solid var(--vscode-widget-border, #444); margin: 8px 0; }
.empty { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
</style></head><body>
<div class="input-row">
    <input type="text" id="exprInput" placeholder="Expression: _Symbol, *_Ptr, $A000, _Buf+X" />
    <button id="addBtn">Add</button>
</div>
<div id="entries"><div class="empty">Add an expression to view memory</div></div>
<script>
const vscode = acquireVsCodeApi();
const input = document.getElementById('exprInput');
const addBtn = document.getElementById('addBtn');
const entriesDiv = document.getElementById('entries');

function addExpr() {
    const expr = input.value.trim();
    if (expr) {
        vscode.postMessage({ type: 'add', expression: expr });
        input.value = '';
    }
}
addBtn.addEventListener('click', addExpr);
input.addEventListener('keydown', e => { if (e.key === 'Enter') addExpr(); });

function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
    if (!results || results.length === 0) {
        entriesDiv.innerHTML = '<div class="empty">Add an expression to view memory</div>';
        return;
    }
    let html = '';
    results.forEach((r, i) => {
        if (i > 0) html += '<div class="sep"></div>';
        const addrStr = r.address !== null ? ' \\u2192 $' + r.address.toString(16).toUpperCase().padStart(4, '0') : '';
        const fmtOpts = ['hex','words','decimal','binary'];
        const fmtLabels = ['Hex','Words','Decimal','Binary'];
        let selHtml = '<select class="fmt-select" data-idx="' + i + '" title="Display format">';
        for (let f = 0; f < fmtOpts.length; f++) {
            selHtml += '<option value="' + fmtOpts[f] + '"' + (r.format === fmtOpts[f] ? ' selected' : '') + '>' + fmtLabels[f] + '</option>';
        }
        selHtml += '</select>';

        html += '<div class="entry">';
        html += '<div class="entry-hdr">';
        html += '<span class="left"><span class="expr">' + escapeHtml(r.expression) + '</span><span class="addr">' + addrStr + '</span></span>';
        html += '<span class="controls">';
        html += '<input type="number" class="rows-input" data-idx="' + i + '" value="' + r.rows + '" min="1" max="128" title="Number of rows">';
        html += '<span class="rows-label">rows</span>';
        html += selHtml;
        html += '<span class="remove" data-idx="' + i + '" title="Remove">\\u00d7</span>';
        html += '</span></div>';
        if (r.error) {
            html += '<div class="error">' + escapeHtml(r.error) + '</div>';
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
}

window.addEventListener('message', e => {
    if (e.data.type === 'update') renderResults(e.data.results);
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
    panel.webview.html = xaReferenceHtml();
    return panel;
}

function xaReferenceHtml() {
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 12px 20px; margin: 0; max-width: 960px; }
.search-bar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 0 12px 0; z-index: 10; }
.search-bar input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); padding: 6px 10px; font-family: inherit; font-size: inherit; }
.search-bar input:focus { outline: 1px solid var(--vscode-focusBorder); }
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
    <input type="text" id="searchInput" placeholder="Search directives... (e.g. byt, segment, define)" autofocus />
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

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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

document.getElementById('searchInput').addEventListener('input', e => render(e.target.value));
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
    panel.webview.html = opcodeReferenceHtml();
    return panel;
}

function opcodeReferenceHtml() {
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 12px 20px; margin: 0; max-width: 1100px; }
.search-bar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 0 12px 0; z-index: 10; }
.search-bar input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); padding: 6px 10px; font-family: inherit; font-size: inherit; }
.search-bar input:focus { outline: 1px solid var(--vscode-focusBorder); }
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
    <input type="text" id="searchInput" placeholder="Search opcodes... (e.g. LDA, load, branch, A9)" autofocus />
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

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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

document.getElementById('searchInput').addEventListener('input', e => render(e.target.value));
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

// ----------------------------------------------------------------
// Shared viz_stream connection (single TCP, multiple consumers)
// ----------------------------------------------------------------

let vizSocket = null;
let vizRxBuf = Buffer.alloc(0);
const vizConsumers = new Set();  // { postFrame(msg), postStatus(text), postError(text) }
let vizHost = null;
let vizPort = null;

const VIZ_FRAME_SIZE_V0 = 16 + 65536 * 3;          // 196624
const VIZ_SCR_SIZE       = 240 * 224;                // 53760
const VIZ_VIDBASES_SIZE  = 4 * 2;                    // 8
const VIZ_VIDRAM_MAIN    = 8000;
const VIZ_VIDRAM_BOTTOM  = 120;
const VIZ_FRAME_SIZE_V1  = VIZ_FRAME_SIZE_V0 + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE + VIZ_VIDRAM_MAIN + VIZ_VIDRAM_BOTTOM; // 258512
const VIZ_MAGIC          = 0x4349564F;  // "OVIC" as uint32 LE

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
        const p = (config.port || 6502) + 1;
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
        for (const c of vizConsumers) c.postStatus('Connected to ' + host + ':' + port);
    });

    let syncErrors = 0;

    sock.on('data', (chunk) => {
        vizRxBuf = Buffer.concat([vizRxBuf, chunk]);

        // Determine frame size from version field once we have the header
        while (vizRxBuf.length >= 16) {
            const magic = vizRxBuf.readUInt32LE(0);
            if (magic !== VIZ_MAGIC) {
                syncErrors++;
                let found = -1;
                for (let i = 1; i <= vizRxBuf.length - 4; i++) {
                    if (vizRxBuf.readUInt32LE(i) === VIZ_MAGIC) { found = i; break; }
                }
                if (found < 0) {
                    const discarded = vizRxBuf.length - 3;
                    vizRxBuf = vizRxBuf.slice(vizRxBuf.length - 3);
                    vizLog('Frame sync error: bad magic, discarded ' + discarded + ' bytes (' + syncErrors + ' total sync errors)');
                    for (const c of vizConsumers) c.postError('Frame sync error (resynchronizing...)');
                    return;
                }
                vizLog('Frame sync: skipped ' + found + ' bytes to re-align');
                vizRxBuf = vizRxBuf.slice(found);
                if (vizRxBuf.length < 16) return;
            }

            const version = vizRxBuf.readUInt16LE(14);
            const frameSize = (version >= 1) ? VIZ_FRAME_SIZE_V1 : VIZ_FRAME_SIZE_V0;

            if (vizRxBuf.length < frameSize) return; // wait for more data

            const frame = vizRxBuf.slice(0, frameSize);
            vizRxBuf = vizRxBuf.slice(frameSize);

            // Build parsed message
            const msg = {
                version,
                frameCounter: frame.readUInt32LE(4),
                romdis: frame[8],
                vidMode: frame[9],
                vidAddr: frame.readUInt16LE(10),
                charsetAddr: frame.readUInt16LE(12),
                readHeat: frame.slice(16, 16 + 65536).toString('base64'),
                writeHeat: frame.slice(16 + 65536, 16 + 65536 * 2).toString('base64'),
                ulaHeat: frame.slice(16 + 65536 * 2, 16 + 65536 * 3).toString('base64')
            };

            if (version >= 1) {
                const v1Off = VIZ_FRAME_SIZE_V0;
                msg.scrBuf = frame.slice(v1Off, v1Off + VIZ_SCR_SIZE).toString('base64');
                msg.vidbases = [
                    frame.readUInt16LE(v1Off + VIZ_SCR_SIZE),
                    frame.readUInt16LE(v1Off + VIZ_SCR_SIZE + 2),
                    frame.readUInt16LE(v1Off + VIZ_SCR_SIZE + 4),
                    frame.readUInt16LE(v1Off + VIZ_SCR_SIZE + 6)
                ];
                msg.vidRamMain = frame.slice(v1Off + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE,
                                             v1Off + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE + VIZ_VIDRAM_MAIN).toString('base64');
                msg.vidRamBottom = frame.slice(v1Off + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE + VIZ_VIDRAM_MAIN,
                                               v1Off + VIZ_SCR_SIZE + VIZ_VIDBASES_SIZE + VIZ_VIDRAM_MAIN + VIZ_VIDRAM_BOTTOM).toString('base64');
            }

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
            vizConnect(gdbHost, gdbPort + 1);
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
                frameCounter: msg.frameCounter,
                romdis: msg.romdis,
                vidMode: msg.vidMode,
                vidAddr: msg.vidAddr,
                charsetAddr: msg.charsetAddr,
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

    heatmapPanel = panel;
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

function b64decode(str) {
    const bin = atob(str);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

function renderFrame(msg) {
    errorDiv.style.display = 'none';
    const readHeat = b64decode(msg.readHeat);
    const writeHeat = b64decode(msg.writeHeat);
    const ulaHeat = b64decode(msg.ulaHeat);

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

    romLabelRight.textContent = msg.romdis ? 'RAM $FFFF' : 'ROM $FFFF';
    status.textContent = 'Frame ' + msg.frameCounter +
        ' | Mode ' + msg.vidMode +
        ' | Vid $' + msg.vidAddr.toString(16).toUpperCase().padStart(4, '0');
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

    panel.onDidDispose(() => {
        screenPanel = null;
        vizUnregisterConsumer(screenConsumer);
    });

    screenPanel = panel;
    panel.webview.html = screenPanelHtml();

    const fs = require('fs');
    const path = require('path');

    panel.webview.onDidReceiveMessage(msg => {
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
            const filePath = path.join(ssDir, 'oric_' + ts + '.png');

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
            // Keyboard input from the Screen View -> Oric keyboard matrix.
            // Uplink frame: [0x01 KEY][len 2][keyid][down]
            vizSendInput([0x01, 0x02, msg.id & 0xff, msg.down ? 1 : 0]);
        } else if (msg.type === 'oricKeyReleaseAll') {
            vizSendInput([0x02, 0x00]); // RELEASE_ALL
        }
    });

    vizRegisterConsumer(screenConsumer);

    return panel;
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
.controls {
    display: flex;
    gap: 16px;
    align-items: center;
    margin: 6px 0;
    font-size: 0.9em;
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
.controls button:hover { background: var(--vscode-button-hoverBackground); }
.screen-wrap {
    position: relative;
    display: inline-block;
    width: 100%;
    max-width: 720px;
    border: 1px solid #404040;
    cursor: none;
}
#screenCanvas {
    display: block;
    width: 100%;
    height: auto;
    image-rendering: pixelated;
}
#overlayCanvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
}
.inspector {
    display: flex;
    gap: 16px;
    margin-top: 8px;
    align-items: flex-start;
    min-height: 130px;
}
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
.swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 1px solid #555;
    vertical-align: middle;
    margin-left: 4px;
}
</style></head><body>
<div id="status">Waiting for connection...</div>
<div id="error"></div>
<div class="controls">
    <label><input type="checkbox" id="colGrid"> Columns (6px)</label>
    <label><input type="checkbox" id="rowGrid"> Rows (8px)</label>
    <select id="gridColor" title="Grid color">
        <option value="128,0,0">Dark Red</option>
        <option value="0,128,0">Dark Green</option>
        <option value="0,0,128">Dark Blue</option>
        <option value="128,128,0">Dark Yellow</option>
        <option value="128,0,128">Dark Magenta</option>
        <option value="0,128,128">Dark Cyan</option>
        <option value="128,128,128" selected>Gray</option>
        <option value="255,128,0">Orange</option>
    </select>
    <span style="flex:1"></span>
    <button id="btnSave" title="Save screenshot to project">Save PNG</button>
    <button id="btnCopy" title="Copy to clipboard">Copy</button>
</div>
<div class="screen-wrap" id="screenWrap">
    <canvas id="screenCanvas" width="240" height="224"></canvas>
    <canvas id="overlayCanvas" width="240" height="224"></canvas>
</div>
<div class="controls">
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
</div>
<div class="inspector">
    <canvas id="zoomCanvas" width="120" height="120"></canvas>
    <div class="info" id="infoPanel">
        <div class="dim">Hover over the screen to inspect</div>
    </div>
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

// --- Settings persistence ---
function saveSettings() {
    vscode.setState({
        colGrid: colGridCb.checked,
        rowGrid: rowGridCb.checked,
        gridColor: gridColorSel.value,
        zoomFactor: zoomFactorSel.value,
        zoomRegion: zoomRegionSel.value
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
    }
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
}

function getGridColor(alpha) {
    return 'rgba(' + gridColorSel.value + ',' + alpha + ')';
}

function drawOverlay() {
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    const sx = w / 240;
    const sy = h / 224;
    const color = getGridColor(0.5);
    overlayCtx.clearRect(0, 0, w, h);
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = 1;
    if (colGridCb.checked) {
        for (let col = 6; col < 240; col += 6) {
            const dx = Math.round(col * sx) + 0.5;
            overlayCtx.beginPath();
            overlayCtx.moveTo(dx, 0);
            overlayCtx.lineTo(dx, h);
            overlayCtx.stroke();
        }
    }
    if (rowGridCb.checked) {
        for (let row = 8; row < 224; row += 8) {
            const dy = Math.round(row * sy) + 0.5;
            overlayCtx.beginPath();
            overlayCtx.moveTo(0, dy);
            overlayCtx.lineTo(w, dy);
            overlayCtx.stroke();
        }
    }
    // Crosshair at hover position (black-white-black for visibility on any background)
    if (hoverPx >= 0) {
        const cx = Math.round((hoverPx + 0.5) * sx);
        const cy = Math.round((hoverPy + 0.5) * sy);
        const lines = [
            { offset: -1, color: 'rgba(0,0,0,0.6)' },
            { offset:  0, color: 'rgba(255,255,255,0.8)' },
            { offset:  1, color: 'rgba(0,0,0,0.6)' }
        ];
        overlayCtx.lineWidth = 1;
        for (const l of lines) {
            overlayCtx.strokeStyle = l.color;
            overlayCtx.beginPath();
            overlayCtx.moveTo(cx + l.offset + 0.5, 0);
            overlayCtx.lineTo(cx + l.offset + 0.5, h);
            overlayCtx.stroke();
            overlayCtx.beginPath();
            overlayCtx.moveTo(0, cy + l.offset + 0.5);
            overlayCtx.lineTo(w, cy + l.offset + 0.5);
            overlayCtx.stroke();
        }
    }
}

const resizeObs = new ResizeObserver(() => resizeOverlay());
resizeObs.observe(screenCanvas);

colGridCb.addEventListener('change', () => { saveSettings(); drawOverlay(); });
rowGridCb.addEventListener('change', () => { saveSettings(); drawOverlay(); });
gridColorSel.addEventListener('change', () => { saveSettings(); drawOverlay(); if (hoverPx >= 0) updateInspector(hoverPx, hoverPy); });

// --- Inspector ---

function hex4(v) { return '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }
function hex2(v) { return '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }
function bin8(v) { return '%' + (v & 0xFF).toString(2).padStart(8, '0'); }

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
    const alt = computeAltAddress(px, py);
    const priB = lookupByte(pri.addr);

    let html = '<div><span class="label">Pixel</span> <span class="value">(' + px + ', ' + py + ')</span>';
    html += '  <span class="label">Col</span> <span class="value">' + col + '</span>';
    html += '  <span class="label">Row</span> <span class="value">' + row + '</span></div>';

    // Primary address
    html += '<div><span class="label">' + pri.mode + '</span> <span class="value">' + hex4(pri.addr) + '</span>';
    if (priB !== null) {
        html += ' = <span class="value">' + hex2(priB) + '  ' + bin8(priB) + '</span>';
        if (pri.bitPos !== undefined) {
            html += '  <span class="dim">bit ' + pri.bitPos + '</span>';
        }
    }
    html += '</div>';

    // Alternate address (dimmed)
    if (alt) {
        const altB = lookupByte(alt.addr);
        html += '<div class="dim">if ' + alt.mode + ' ' + hex4(alt.addr);
        if (altB !== null) {
            html += ' = ' + hex2(altB) + '  ' + bin8(altB);
            if (alt.bitPos !== undefined) html += '  bit ' + alt.bitPos;
        }
        html += '</div>';
    }

    // Color
    const rgb = PALETTE[colorIdx];
    html += '<div><span class="label">Color</span> <span class="value">' + COLOR_NAMES[colorIdx] + ' (' + colorIdx + ')</span>';
    html += '<span class="swatch" style="background:rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')"></span></div>';

    infoPanel.innerHTML = html;
}

// Mouse tracking on the screen canvas wrapper
screenWrap.addEventListener('mousemove', (e) => {
    const rect = screenCanvas.getBoundingClientRect();
    const px = Math.floor((e.clientX - rect.left) / rect.width * 240);
    const py = Math.floor((e.clientY - rect.top) / rect.height * 224);
    if (px >= 0 && px < 240 && py >= 0 && py < 224) {
        hoverPx = px; hoverPy = py;
        updateInspector(px, py);
        drawOverlay();
    }
});

screenWrap.addEventListener('mouseleave', () => {
    hoverPx = -1; hoverPy = -1;
    infoPanel.innerHTML = '<div class="dim">Hover over the screen to inspect</div>';
    zoomCtx.clearRect(0, 0, zoomCanvas.width, zoomCanvas.height);
    drawOverlay();
});

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
document.getElementById('btnSave').addEventListener('click', () => {
    if (!curScrBuf) return;
    vscode.postMessage({ type: 'saveImage', dataUrl: screenCanvas.toDataURL('image/png') });
});
document.getElementById('btnCopy').addEventListener('click', () => {
    if (!curScrBuf) return;
    vscode.postMessage({ type: 'copyImage', dataUrl: screenCanvas.toDataURL('image/png') });
});

window.addEventListener('message', e => {
    if (e.data.type === 'screenFrame') renderScreen(e.data);
    if (e.data.type === 'status') { status.textContent = e.data.text; errorDiv.style.display = 'none'; }
    if (e.data.type === 'error') { errorDiv.textContent = e.data.text; errorDiv.style.display = 'block'; }
});

// --- Keyboard input -> Oric (Phase 1) ---
// While the Screen View is focused, capture keys and forward them to the
// extension, which writes them up the viz_stream socket to the emulator.
(function(){
    const held = new Set();
    const badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;top:4px;right:6px;font:11px monospace;'
        + 'padding:2px 7px;border-radius:3px;background:rgba(0,0,0,0.55);'
        + 'color:#888;pointer-events:none;z-index:99;';
    badge.textContent = 'click to control the Oric';
    document.body.appendChild(badge);
    function setFocused(f){
        badge.textContent = f ? '⌨ input → Oric' : 'click to control the Oric';
        badge.style.color = f ? '#8f8' : '#888';
    }
    window.addEventListener('focus', function(){ setFocused(true); });
    window.addEventListener('blur', function(){ setFocused(false); releaseAll(); });
    function isUiControl(){
        const t = document.activeElement;
        return t && /^(BUTTON|SELECT|INPUT|TEXTAREA)$/.test(t.tagName);
    }
    function mapKey(e){
        switch(e.code){
            case 'ArrowUp': return 0x80; case 'ArrowDown': return 0x81;
            case 'ArrowLeft': return 0x82; case 'ArrowRight': return 0x83;
            case 'Enter': case 'NumpadEnter': return 0x84;
            case 'Escape': return 0x85; case 'Space': return 0x86;
            case 'Backspace': return 0x87;
            case 'ShiftLeft': case 'ShiftRight': return 0x88;
            case 'ControlLeft': case 'ControlRight': return 0x89;
            case 'Tab': return 0x8b;
        }
        if (e.key && e.key.length === 1){ const c = e.key.charCodeAt(0); if (c >= 0x20 && c < 0x7f) return c; }
        return null;
    }
    function releaseAll(){ held.clear(); vscode.postMessage({ type: 'oricKeyReleaseAll' }); }
    window.addEventListener('keydown', function(e){
        if (isUiControl()) return;
        const id = mapKey(e); if (id == null) return;
        e.preventDefault();
        if (e.repeat) return;
        held.add(id);
        vscode.postMessage({ type: 'oricKey', id: id, down: true });
    });
    window.addEventListener('keyup', function(e){
        if (isUiControl()) return;
        const id = mapKey(e); if (id == null) return;
        e.preventDefault();
        held.delete(id);
        vscode.postMessage({ type: 'oricKey', id: id, down: false });
    });
})();
</script>
</body></html>`;
}

// ----------------------------------------------------------------
// Oric Disassembly Panel (custom webview, persists across reloads)
// ----------------------------------------------------------------

let disasmPanel = null;
let disasmCenterAddr = null;

// ----------------------------------------------------------------
// Oric Symbols Panel (searchable/sortable symbol browser)
// ----------------------------------------------------------------

let symbolsPanel = null;

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
    symbolsPanel.onDidDispose(() => { symbolsPanel = null; });

    // Handle messages from symbols webview
    symbolsPanel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'symbolHover' && typeof msg.addr === 'number') {
            highlightHeatmapAddr(msg.addr);
        } else if (msg.type === 'symbolLeave') {
            restoreHeatmapPcHighlight();
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
        }
    });

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
            }
        }
    }).catch(() => {});
}

// ----------------------------------------------------------------
// Oric Disassembly Panel — create / refresh / HTML
// ----------------------------------------------------------------

function createDisasmPanel() {
    if (disasmPanel) { disasmPanel.reveal(); return; }
    disasmPanel = vscode.window.createWebviewPanel(
        'oricDisassembly', 'Oric Disassembly',
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    disasmPanel.webview.html = disasmPanelHtml();
    disasmPanel.onDidDispose(() => { disasmPanel = null; });
    setupDisasmMessageHandler(disasmPanel);

    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'oric-debug') refreshDisasmPanel(session);
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
        }
    });
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
        const addr16 = address & 0xFFFF;
        const ref = '0x' + addr16.toString(16).padStart(4, '0');
        const existing = vscode.debug.breakpoints.find(bp =>
            bp instanceof vscode.InstructionBreakpoint &&
            parseInt(bp.instructionReference, 16) === addr16);
        if (existing) vscode.debug.removeBreakpoints([existing]);
        else vscode.debug.addBreakpoints([new vscode.InstructionBreakpoint(ref)]);
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
    session.customRequest('toggleWarp').then(resp => {
        if (resp) {
            vscode.commands.executeCommand('setContext', 'oric-debug.warp', !!resp.warp);
            vscode.window.setStatusBarMessage(resp.warp ? 'Warp: ON' : 'Warp: OFF', 3000);
        }
    }).catch(e => {
        vscode.window.showErrorMessage('Warp toggle failed: ' + e.message);
    });
}

function refreshDisasmPanel(session) {
    if (!disasmPanel) return;
    if (!session || session.type !== 'oric-debug') {
        disasmPanel.webview.postMessage({ type: 'disasm', data: null });
        return;
    }
    session.customRequest('disassembleRange', {
        address: disasmCenterAddr, count: 64, before: 24
    }).then(resp => {
        if (disasmPanel) disasmPanel.webview.postMessage({ type: 'disasm', data: resp });
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
.toolbar {
    position: sticky; top: 0; z-index: 10;
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
.toolbar button:hover { opacity: 0.85; }
.toolbar .status {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 0.9em; margin-left: auto;
}
table { width: 100%; border-collapse: collapse; user-select: none; table-layout: fixed; }
tr { height: 20px; }
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
td.pc-arrow { width: 18px; color: var(--vscode-debugIcon-startForeground, #89d185); font-weight: bold; }
.no-session { padding: 20px; color: var(--vscode-descriptionForeground, #888); text-align: center; }
</style></head><body>
<div class="toolbar">
    <span style="color:var(--vscode-descriptionForeground,#888)">Go to:</span>
    <input type="text" id="gotoInput" placeholder="$XXXX" spellcheck="false">
    <button id="gotoBtn">Go</button>
    <button id="followBtn">Follow PC</button>
    <span class="status" id="statusText"></span>
</div>
<div id="content"><div class="no-session">No debug session active</div></div>
<script>
const vscode = acquireVsCodeApi();
let lastData = null;

// Use mousedown + event delegation for breakpoint gutter clicks.
// In VS Code webviews the first 'click' after focus acquisition is often
// swallowed; mousedown fires reliably on every press including the first.
document.getElementById('content').addEventListener('mousedown', e => {
    const td = e.target.closest('td.gutter');
    if (!td) return;
    e.preventDefault();
    e.stopPropagation();
    const addr = parseInt(td.dataset.addr);
    if (!isNaN(addr)) vscode.postMessage({ type: 'toggleBreakpoint', address: addr });
});

document.getElementById('gotoBtn').addEventListener('click', doGoto);
document.getElementById('gotoInput').addEventListener('keydown', e => { if (e.key === 'Enter') doGoto(); });
document.getElementById('followBtn').addEventListener('click', () => vscode.postMessage({ type: 'followPc' }));

function doGoto() {
    let v = document.getElementById('gotoInput').value.trim().replace(/^\\$/, '');
    if (/^[0-9a-fA-F]{1,4}$/.test(v)) {
        vscode.postMessage({ type: 'gotoAddress', address: v });
    }
}

window.addEventListener('message', e => {
    if (e.data.type === 'disasm') {
        lastData = e.data.data;
        render();
    }
});

function render() {
    const el = document.getElementById('content');
    if (!lastData || !lastData.instructions || lastData.instructions.length === 0) {
        el.innerHTML = '<div class="no-session">No debug session active</div>';
        document.getElementById('statusText').textContent = '';
        return;
    }
    const { instructions, pc, breakpoints, pendingBreakpoints } = lastData;
    const bpSet = new Set(breakpoints || []);
    const pendingSet = new Set(pendingBreakpoints || []);
    const h2 = v => v.toString(16).toUpperCase().padStart(2, '0');
    const h4 = v => v.toString(16).toUpperCase().padStart(4, '0');

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
        html += '<td class="label-col">' + (hasLabel ? ins.label : '') + '</td>';
        html += '<td class="mnemonic">' + ins.mnemonic + '</td>';
        html += '<td class="operand">' + escHtml(ins.operand) + '</td>';
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
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0;
}
.toolbar {
    position: sticky; top: 0; z-index: 10;
    background: var(--vscode-editor-background);
    padding: 6px 8px;
    display: flex; gap: 8px; align-items: center;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
}
.search-wrap {
    flex: 1; min-width: 100px; position: relative;
}
.search-wrap input {
    width: 100%;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 3px 24px 3px 6px;
    font-family: inherit; font-size: inherit;
}
.search-wrap .clear-btn {
    position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--vscode-descriptionForeground, #888);
    cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px;
    display: none;
}
.search-wrap .clear-btn:hover { color: var(--vscode-foreground); }
.search-wrap input:not(:placeholder-shown) ~ .clear-btn { display: block; }
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
col.col-value { width: 120px; }
col.col-group { width: 44px; }
th {
    position: sticky; top: 33px; z-index: 5;
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
.val  { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.val.mod { color: #e04040; }
.grp  { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.dim  { color: var(--vscode-descriptionForeground, #888); padding: 16px 8px; }
.sym-link { cursor: pointer; }
.sym-link:hover { text-decoration: underline; }
</style></head><body>
<div class="toolbar">
    <div class="search-wrap">
        <input type="text" id="search" placeholder="Search name or value..." autocomplete="off" />
        <button class="clear-btn" id="clearBtn" title="Clear">\u00D7</button>
        <div class="mru-list" id="mruList"></div>
    </div>
    <select id="groupFilter">
        <option value="all">All</option>
        <option value="zp">Zero Page</option>
        <option value="ram">RAM</option>
        <option value="high">High</option>
        <option value="define">Define</option>
    </select>
    <span class="count" id="count"></span>
</div>
<table>
    <colgroup>
        <col class="col-name">
        <col class="col-addr">
        <col class="col-size">
        <col class="col-value">
        <col class="col-group">
    </colgroup>
    <thead><tr>
        <th data-col="name">Name <span class="arrow"></span></th>
        <th data-col="addr">Addr <span class="arrow"></span></th>
        <th data-col="size">Size <span class="arrow"></span></th>
        <th data-col="value">Value <span class="arrow"></span></th>
        <th data-col="group">Group <span class="arrow"></span></th>
    </tr></thead>
    <tbody id="tbody"></tbody>
</table>
<div class="dim" id="nodata">No debug session or no symbols loaded</div>
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

let allSymbols = null;
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
        list = list.filter(s => s.name.toLowerCase().includes(ft) ||
            (s.aliases && s.aliases.some(a => a.toLowerCase().includes(ft))) ||
            fmtValue(s).toLowerCase().includes(ft) ||
            (s.addr >= 0 && h(s.addr, 4).toLowerCase().includes(ft)));
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
        html += '<tr' + attrs + ' title="' + s.name + (s.aliases && s.aliases.length ? ' / ' + s.aliases.join(' / ') : '') + '">'
            + '<td class="name">' + nameHtml + '</td>'
            + '<td class="addr">' + (s.addr >= 0 ? h(s.addr, 4) : '\u2014') + '</td>'
            + '<td class="sz">' + (s.size > 0 ? s.size : '\u2014') + '</td>'
            + '<td class="val' + mod + '"' + (s.defineComment ? ' title="' + s.defineComment.replace(/"/g, '&quot;') + '"' : '') + '>' + fmtValue(s) + '</td>'
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
    if (e.key === 'Enter' && filterText.trim()) { mruAdd(filterText); mruClose(); }
    if (e.key === 'ArrowDown' && !searchEl.value && mruItems.length) { mruRender(); }
});
clearBtn.addEventListener('click', () => {
    if (searchEl.value.trim()) mruAdd(searchEl.value);
    searchEl.value = ''; filterText = ''; mruClose(); render(); searchEl.focus();
});

groupEl.addEventListener('change', () => { filterGroup = groupEl.value; render(); });

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
tbody.addEventListener('click', e => {
    const link = e.target.closest('.sym-link[data-file]');
    if (link) {
        vscode.postMessage({ type: 'gotoSymbol', file: link.dataset.file, line: parseInt(link.dataset.line, 10) });
    }
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
    }
});
</script>
</body></html>`;
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
            resolveDebugConfiguration(folder, config, token) {
                // Warn if user has attach config but likely wants launch
                if (config.request === 'attach' && config.emulatorPath) {
                    vscode.window.showWarningMessage(
                        'This debug config has "request": "attach" but also specifies emulatorPath. ' +
                        'Change to "request": "launch" to auto-launch Oricutron.');
                }
                // Warn if launch config is missing required fields
                if (config.request === 'launch') {
                    if (!config.emulatorPath) {
                        vscode.window.showErrorMessage(
                            'Launch config is missing "emulatorPath". Set it to the Oricutron executable path.');
                        return undefined; // abort launch
                    }
                    if (!config.diskImage) {
                        vscode.window.showErrorMessage(
                            'Launch config is missing "diskImage". Set it to the .dsk or .tap file.');
                        return undefined;
                    }
                }
                // Log verbosity precedence: a persisted per-project choice wins;
                // otherwise an explicit launch.json value; otherwise Normal (1).
                const persistedLevel = context.workspaceState.get(LOG_LEVEL_KEY);
                if (typeof persistedLevel === 'number') {
                    config.logLevel = persistedLevel;
                } else if (config.logLevel === undefined) {
                    config.logLevel = 1;
                }
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

    context.subscriptions.push(
        cycleDecorationType,
        vscode.window.onDidChangeVisibleTextEditors(() => { applyCycleDecorations(); applyInstrDecoration(); })
    );

    // --- Instruction annotation decoration (resolved operands) ---
    const instrDecorationType = vscode.window.createTextEditorDecorationType({
        after: {
            color: '#888888',
            fontStyle: 'italic',
            margin: '0 0 0 3em'
        },
        isWholeLine: true
    });
    let instrDecoFile = null;
    let instrDecoLine = -1;
    let instrDecoText = '';

    function applyInstrDecoration() {
        for (const editor of vscode.window.visibleTextEditors) {
            const filePath = editor.document.uri.fsPath;
            if (canonPath(filePath) === canonPath(instrDecoFile) && instrDecoLine > 0 && instrDecoText) {
                const range = new vscode.Range(instrDecoLine - 1, 0, instrDecoLine - 1, 0);
                editor.setDecorations(instrDecorationType, [{
                    range,
                    renderOptions: { after: { contentText: instrDecoText } }
                }]);
            } else {
                editor.setDecorations(instrDecorationType, []);
            }
        }
    }

    function clearInstrDecoration() {
        instrDecoFile = null;
        instrDecoLine = -1;
        instrDecoText = '';
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(instrDecorationType, []);
        }
    }

    function refreshInstructionAnnotation(session) {
        if (!session || session.type !== 'oric-debug') { clearInstrDecoration(); return; }
        session.customRequest('resolveInstruction').then(resp => {
            if (resp && resp.annotation && resp.file && resp.line > 0) {
                instrDecoFile = resp.file;
                instrDecoLine = resp.line;
                instrDecoText = resp.annotation;
                // Also auto-highlight PC on heatmap
                lastPcAddr = resp.pc;
                highlightHeatmapAddr(resp.pc);
                applyInstrDecoration();
            } else {
                if (resp && typeof resp.pc === 'number') {
                    lastPcAddr = resp.pc;
                    highlightHeatmapAddr(resp.pc);
                }
                clearInstrDecoration();
            }
        }).catch(() => { clearInstrDecoration(); });
    }

    context.subscriptions.push(instrDecorationType);

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
        vscode.window.onDidChangeTextEditorSelection(() => {
            restoreHeatmapPcHighlight();
        })
    );

    const regsProvider = new RegistersWebviewProvider();
    const periphProvider = new PeripheralsWebviewProvider();

    context.subscriptions.push(
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
            const session = vscode.debug.activeDebugSession;
            if (!session || session.type !== 'oric-debug') return;
            const ed = vscode.window.activeTextEditor;
            const args = {};
            if (ed) { args.file = ed.document.uri.fsPath; args.line = ed.selection.active.line + 1; }
            try {
                await session.customRequest('turboRun', args);
            } catch (e) {
                vscode.window.showErrorMessage('Turbo Run failed: ' + (e && e.message ? e.message : e));
            }
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
            heatmapPanel = panel;
            panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
            panel.webview.html = heatmapPanelHtml();
            panel.onDidDispose(() => { heatmapPanel = null; vizUnregisterConsumer(heatmapConsumer); });
            vizRegisterConsumer(heatmapConsumer);
        }
    });
    vscode.window.registerWebviewPanelSerializer('oricScreenView', {
        async deserializeWebviewPanel(panel) {
            screenPanel = panel;
            panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
            panel.webview.html = screenPanelHtml();
            panel.onDidDispose(() => { screenPanel = null; vizUnregisterConsumer(screenConsumer); });

            const fs = require('fs');
            const path = require('path');
            panel.webview.onDidReceiveMessage(msg => {
                if (msg.type === 'saveImage' && msg.dataUrl) {
                    let baseDir = null;
                    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                        baseDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
                    }
                    if (!baseDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
                    const ssDir = path.join(baseDir, 'screenshots');
                    if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
                    const now = new Date();
                    const ts = now.getFullYear().toString()
                        + (now.getMonth()+1).toString().padStart(2,'0')
                        + now.getDate().toString().padStart(2,'0')
                        + '_' + now.getHours().toString().padStart(2,'0')
                        + now.getMinutes().toString().padStart(2,'0')
                        + now.getSeconds().toString().padStart(2,'0');
                    const filePath = path.join(ssDir, 'oric_' + ts + '.png');
                    const base64 = msg.dataUrl.replace(/^data:image\/png;base64,/, '');
                    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
                    vscode.window.showInformationMessage('Screenshot saved: ' + path.basename(filePath));
                } else if (msg.type === 'copyImage' && msg.dataUrl) {
                    const os = require('os');
                    const tmpFile = path.join(os.tmpdir(), 'oric_clipboard.png');
                    const base64 = msg.dataUrl.replace(/^data:image\/png;base64,/, '');
                    fs.writeFileSync(tmpFile, Buffer.from(base64, 'base64'));
                    const { exec } = require('child_process');
                    const psCmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${tmpFile.replace(/\\/g, '\\\\')}'))`;
                    exec('powershell -NoProfile -Command "' + psCmd + '"', (err) => {
                        if (err) vscode.window.showErrorMessage('Clipboard copy failed: ' + err.message);
                        else vscode.window.showInformationMessage('Screenshot copied to clipboard');
                        try { fs.unlinkSync(tmpFile); } catch (_) {}
                    });
                } else if (msg.type === 'oricKey') {
                    vizSendInput([0x01, 0x02, msg.id & 0xff, msg.down ? 1 : 0]);
                } else if (msg.type === 'oricKeyReleaseAll') {
                    vizSendInput([0x02, 0x00]);
                }
            });

            vizRegisterConsumer(screenConsumer);
        }
    });
    vscode.window.registerWebviewPanelSerializer('oricSymbols', {
        async deserializeWebviewPanel(panel) {
            symbolsPanel = panel;
            panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
            panel.webview.html = symbolsPanelHtml();
            panel.onDidDispose(() => { symbolsPanel = null; });
            panel.webview.onDidReceiveMessage(msg => {
                if (msg.type === 'symbolHover' && typeof msg.addr === 'number') {
                    highlightHeatmapAddr(msg.addr);
                } else if (msg.type === 'symbolLeave') {
                    restoreHeatmapPcHighlight();
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
                }
            });
        }
    });
    vscode.window.registerWebviewPanelSerializer('oricDisassembly', {
        async deserializeWebviewPanel(panel) {
            disasmPanel = panel;
            panel.webview.options = { enableScripts: true, retainContextWhenHidden: true };
            panel.webview.html = disasmPanelHtml();
            panel.onDidDispose(() => { disasmPanel = null; });
            setupDisasmMessageHandler(panel);
            const session = vscode.debug.activeDebugSession;
            if (session && session.type === 'oric-debug') refreshDisasmPanel(session);
        }
    });

    function isDisasmFocused() {
        return disasmPanel && disasmPanel.active;
    }

    function refreshAll() {
        const session = vscode.debug.activeDebugSession;
        const lightMode = isDisasmFocused(); // instruction-stepping: skip heavy refreshes
        regsProvider.refresh(session);
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

    // Debug console verbosity — click to pick Errors / Normal / Verbose.
    const logLevelStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
    logLevelStatusBar.command = 'oric-debug.selectLogLevel';
    logLevelStatusBar.tooltip = 'Oric debug log verbosity — click to change';
    context.subscriptions.push(logLevelStatusBar);
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => logLevelStatusBar.hide()));

    // Keep the disassembly view's breakpoint dots in sync with VS Code's model —
    // whether a breakpoint changed via the source gutter, the Breakpoints panel,
    // the disasm gutter, or (via inbound promotion) Oricutron itself.
    context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(() => {
        const session = vscode.debug.activeDebugSession;
        if (session && session.type === 'oric-debug') refreshDisasmPanel(session);
    }));

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('oric-debug', {
            createDebugAdapterTracker(session) {
                return {
                    onDidSendMessage(msg) {
                        if (msg.type === 'event' && msg.event === 'stopped') {
                            // Drop the previous line's annotation at once so it can't
                            // flicker there during the post-step navigation churn; the
                            // fresh one is applied when refreshAll's resolve returns.
                            clearInstrDecoration();
                            setTimeout(() => refreshAll(), 50);
                            // Skip source-file navigation when the disassembly panel is focused
                            if (!isDisasmFocused()) pendingNavigate = true;
                            // Auto-open custom disassembly panel on first stop of session
                            if (!disassemblyAutoOpened) {
                                disassemblyAutoOpened = true;
                                setTimeout(() => createDisasmPanel(), 200);
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
                        // Active symbol module changed (auto-switch or manual) — reflect in status bar
                        if (msg.type === 'event' && msg.event === 'oricActiveModule' && msg.body) {
                            moduleStatusBar.text = '$(layers) Module: ' + msg.body.name;
                            moduleStatusBar.show();
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
                    vizConnect(gdbHost, gdbPort + 1);
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
    vizDisconnect();
    vizOutputChannel = null;
}

module.exports = { activate, deactivate };
