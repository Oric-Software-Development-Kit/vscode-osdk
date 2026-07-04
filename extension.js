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
// Extension activation
// ----------------------------------------------------------------

function activate(context) {
    const regsProvider = new RegistersWebviewProvider();
    const zpProvider = new ZeroPageProvider();
    const periphProvider = new PeripheralsWebviewProvider();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('oricCpuRegs', regsProvider),
        vscode.window.registerTreeDataProvider('oricZeroPage', zpProvider),
        vscode.window.registerWebviewViewProvider('oricPeripherals', periphProvider)
    );

    function refreshAll() {
        const session = vscode.debug.activeDebugSession;
        regsProvider.refresh(session);
        zpProvider.refresh(session);
        periphProvider.refresh(session);
    }

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('oric-debug', {
            createDebugAdapterTracker(session) {
                return {
                    onDidSendMessage(msg) {
                        if (msg.type === 'event' && msg.event === 'stopped') {
                            setTimeout(() => refreshAll(), 50);
                        }
                    }
                };
            }
        }),
        vscode.debug.onDidStartDebugSession(s => {
            if (s.type === 'oric-debug')
                setTimeout(() => refreshAll(), 500);
        }),
        vscode.debug.onDidTerminateDebugSession(() => refreshAll())
    );
}

function deactivate() {
}

module.exports = { activate, deactivate };
