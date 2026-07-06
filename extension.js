'use strict';

const vscode = require('vscode');

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
        // Read CPU registers, flags, and extra state from the debug adapter
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
            return;
        }

        const flagNames = ['N', 'V', 'B', 'D', 'I', 'Z', 'C'];
        const flagKeys = ['N (Negative)', 'V (Overflow)', 'B (Break)', 'D (Decimal)', 'I (Interrupt)', 'Z (Zero)', 'C (Carry)'];
        let flagsHtml = flagNames.map((name, i) => {
            const val = flags[flagKeys[i]];
            const on = val === '1';
            return '<span class="' + (on ? 'fon' : 'foff') + '" title="' + flagKeys[i] + '">' + name + '</span>';
        }).join(' ');

        function hex4(v) { return '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }

        let extraHtml = '';
        if (extra) {
            const lpc = extra.L !== undefined ? hex4(extra.L) : '?';
            const cy = extra.C !== undefined ? extra.C.toString() : '?';
            const fm = extra.F !== undefined ? extra.F.toString() : '?';
            const rs = extra.R !== undefined ? extra.R.toString() : '?';
            const nmi = extra.N !== undefined ? hex4(extra.N) : '?';
            const rst = extra.T !== undefined ? hex4(extra.T) : '?';
            const irq = extra.I !== undefined ? hex4(extra.I) : '?';
            extraHtml = `<div class="sep"></div>
<div class="r">
 <span><span class="n">LPC</span>=<span class="v">${lpc}</span></span>
 <span><span class="n">CY</span>=<span class="v">${cy}</span></span>
 <span><span class="n">FM</span>=<span class="v">${fm}</span></span>
 <span><span class="n">RS</span>=<span class="v">${rs}</span></span>
</div>
<div class="sep"></div>
<div class="r">
 <span><span class="n">NMI</span>=<span class="v">${nmi}</span></span>
 <span><span class="n">RST</span>=<span class="v">${rst}</span></span>
 <span><span class="n">IRQ</span>=<span class="v">${irq}</span></span>
</div>`;
        }

        this._view.webview.html = `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground); padding: 4px 8px; margin: 0; }
.r { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 3px 0; align-items: baseline; }
.n { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
.v { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.fon { color: var(--vscode-debugTokenExpression-number, #b5cea8); font-weight: bold; }
.foff { opacity: 0.35; }
.sep { border-top: 1px solid var(--vscode-widget-border, #444); margin: 4px 0; }
</style></head><body>
<div class="r">
 <span><span class="n">A</span>=<span class="v">${regs.A || '?'}</span></span>
 <span><span class="n">X</span>=<span class="v">${regs.X || '?'}</span></span>
 <span><span class="n">Y</span>=<span class="v">${regs.Y || '?'}</span></span>
 <span><span class="n">SP</span>=<span class="v">${regs.SP || '?'}</span></span>
 <span><span class="n">PC</span>=<span class="v">${regs.PC || '?'}</span></span>
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
            return;
        }

        const sections = [];

        if (d.V) {
            let rows = '';
            for (let i = 0; i < d.V.length; i++) {
                let extra = '';
                if (i === 11 || i === 12) extra = ' ' + bin8(d.V[i]);
                else if (i === 13 || i === 14) extra = ' ' + decodeViaIFR(d.V[i]);
                rows += '<span title="$030' + i.toString(16).toUpperCase() + '"><span class="n">' + VIA_REG_NAMES[i] + '</span>=<span class="v">' + h2(d.V[i]) + '</span>' + (extra ? '<span class="x">' + extra + '</span>' : '') + '</span> ';
            }
            sections.push({ name: 'VIA 6522', addr: '$0300', html: rows });
        }

        if (d.A) {
            let rows = '';
            for (let i = 0; i < d.A.length; i++) {
                let extra = '';
                if (i === 7) extra = ' ' + decodeAyEnable(d.A[i]);
                rows += '<span title="AY R' + i + '"><span class="n">' + AY_REG_NAMES[i] + '</span>=<span class="v">' + h2(d.A[i]) + '</span>' + (extra ? '<span class="x">' + extra + '</span>' : '') + '</span> ';
            }
            sections.push({ name: 'AY-3-8912', addr: 'Sound', html: rows });
        }

        if (d.F) {
            let rows = '';
            for (let i = 0; i < d.F.length; i++) {
                let extra = '';
                if (i === 0) extra = ' ' + decodeFdcStatus(d.F[i]);
                rows += '<span title="$031' + i.toString(16).toUpperCase() + '"><span class="n">' + FDC_REG_NAMES[i] + '</span>=<span class="v">' + h2(d.F[i]) + '</span>' + (extra ? '<span class="x">' + extra + '</span>' : '') + '</span> ';
            }
            sections.push({ name: 'WD1793 FDC', addr: '$0310', html: rows });
        }

        if (d.M) {
            let rows = '';
            for (let i = 0; i < d.M.length; i++) {
                let extra = '';
                if (i === 0) extra = ' ' + decodeMdControl(d.M[i]);
                rows += '<span><span class="n">' + MD_REG_NAMES[i] + '</span>=<span class="v">' + h2(d.M[i]) + '</span>' + (extra ? '<span class="x">' + extra + '</span>' : '') + '</span> ';
            }
            sections.push({ name: 'Microdisc', addr: '$0314', html: rows });
        }

        if (d.C) {
            let rows = '';
            for (let i = 0; i < d.C.length; i++) {
                rows += '<span title="$031' + (0xC + i).toString(16).toUpperCase() + '"><span class="n">' + ACIA_REG_NAMES[i] + '</span>=<span class="v">' + h2(d.C[i]) + '</span></span> ';
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
.x { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
.hdr { color: var(--vscode-sideBarSectionHeader-foreground, #ccc); font-weight: bold; font-size: 0.95em; margin-top: 2px; }
.addr { color: var(--vscode-descriptionForeground, #888); font-weight: normal; font-size: 0.9em; }
.hr { border-top: 1px solid var(--vscode-widget-border, #444); margin: 4px 0; }
</style></head><body>${body}</body></html>`;
    }
}

// ----------------------------------------------------------------
// Zero Page TreeDataProvider
// ----------------------------------------------------------------

class ZeroPageProvider {
    constructor() {
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChange.event;
        this._vars = null;
    }

    refresh(session) {
        if (!session || session.type !== 'oric-debug') {
            this._vars = null;
            this._onDidChange.fire();
            return;
        }
        session.customRequest('variables', { variablesReference: 3 }).then(resp => {
            this._vars = resp && resp.variables;
            this._onDidChange.fire();
        }).catch(() => {
            this._vars = null;
            this._onDidChange.fire();
        });
    }

    getTreeItem(element) { return element; }

    getChildren() {
        if (!this._vars) return [];
        return this._vars.map(v => {
            const item = new vscode.TreeItem(v.name, vscode.TreeItemCollapsibleState.None);
            item.description = v.value;
            return item;
        });
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
<canvas id="zpCanvas" class="page-canvas" width="256" height="1"></canvas>
<div class="label-row"><span>$0100 Stack</span><span>$01FF</span></div>
<canvas id="stackCanvas" class="page-canvas" width="256" height="1"></canvas>
<div class="label-row"><span>$0200 Page 2</span><span>$02FF</span></div>
<canvas id="page2Canvas" class="page-canvas" width="256" height="1"></canvas>
<div class="label-row"><span>$0300 I/O</span><span>$03FF</span></div>
<canvas id="ioCanvas" class="page-canvas" width="256" height="1"></canvas>
<div class="label-row"><span>$0400</span><span>$BFFF</span></div>
<canvas id="mainCanvas" width="256" height="188"></canvas>
<div class="label-row" id="romLabel">
    <span>$C000</span><span id="romLabelRight">ROM $FFFF</span>
</div>
<canvas id="bottomCanvas" width="256" height="64"></canvas>
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

window.addEventListener('message', e => {
    if (e.data.type === 'heatmapFrame') renderFrame(e.data);
    if (e.data.type === 'status') { status.textContent = e.data.text; errorDiv.style.display = 'none'; }
    if (e.data.type === 'error') { errorDiv.textContent = e.data.text; errorDiv.style.display = 'block'; }
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
zoomFactorSel.addEventListener('change', () => { saveSettings(); if (hoverPx >= 0) updateInspector(hoverPx, hoverPy); });
zoomRegionSel.addEventListener('change', () => { saveSettings(); if (hoverPx >= 0) updateInspector(hoverPx, hoverPy); });

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
                return config;
            }
        })
    );

    vizOutputChannel = vscode.window.createOutputChannel('Oric Debug');
    context.subscriptions.push(vizOutputChannel);

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
            const fileAnnotations = cycleAnnotations.get(filePath);
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
        vscode.window.onDidChangeVisibleTextEditors(() => applyCycleDecorations())
    );

    const regsProvider = new RegistersWebviewProvider();
    const zpProvider = new ZeroPageProvider();
    const periphProvider = new PeripheralsWebviewProvider();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('oricCpuRegs', regsProvider),
        vscode.window.registerTreeDataProvider('oricZeroPage', zpProvider),
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
        vscode.commands.registerCommand('oric-debug.toggleWarp', () => {
            const session = vscode.debug.activeDebugSession;
            if (session && session.type === 'oric-debug') {
                session.customRequest('toggleWarp').then(resp => {
                    if (resp) {
                        vscode.window.setStatusBarMessage(
                            resp.warp ? 'Warp: ON' : 'Warp: OFF', 3000
                        );
                    }
                }).catch(e => {
                    vscode.window.showErrorMessage('Warp toggle failed: ' + e.message);
                });
            }
        }),
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
        vscode.commands.registerCommand('osdk.6502Reference', () => create6502ReferencePanel())
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
                }
            });

            vizRegisterConsumer(screenConsumer);
        }
    });

    function refreshAll() {
        const session = vscode.debug.activeDebugSession;
        regsProvider.refresh(session);
        zpProvider.refresh(session);
        periphProvider.refresh(session);
        refreshMemoryPanels(session);
    }

    // Auto-navigate: VS Code doesn't always switch back from a virtual
    // disassembly tab to a real source file when the frame changes.
    // This handler ensures we open the source file when it's available.
    let pendingNavigate = false;

    async function autoNavigateFromFrame(topFrame) {
        try {
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

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('oric-debug', {
            createDebugAdapterTracker(session) {
                return {
                    onDidSendMessage(msg) {
                        if (msg.type === 'event' && msg.event === 'stopped') {
                            setTimeout(() => refreshAll(), 50);
                            pendingNavigate = true;
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
                                const path = require('path');
                                const filePath = path.isAbsolute(ann.file) ? ann.file : ann.file;
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
                setTimeout(() => refreshAll(), 500);
                // Auto-connect viz stream if any consumer panels are open
                if (vizConsumers.size > 0) {
                    vizConnect(gdbHost, gdbPort + 1);
                }
            }
        }),
        vscode.debug.onDidTerminateDebugSession(() => {
            vizLog('Debug session terminated');
            refreshAll();
            vizDisconnect();
            clearCycleAnnotations();
        })
    );
}

function deactivate() {
    vizDisconnect();
    vizOutputChannel = null;
}

module.exports = { activate, deactivate };
