'use strict';
/*
 * oric-bridge-protocol — one source of truth for the collaborative "bridge" between the
 * VS Code extension (which OWNS the live debug session + viz stream) and an external MCP
 * client that wants to share that SAME session (so the human and the AI look at one screen,
 * one set of breakpoints, one CPU state).
 *
 * Why a bridge (and not a second GDB/viz connection): Oricutron's GDB stub AND its viz
 * stream are each SINGLE-CLIENT (one client_sock). The extension already holds both, so an
 * external process cannot attach directly without stealing them. The extension therefore
 * exposes a thin localhost endpoint and proxies every request through
 * vscode.debug.activeDebugSession.customRequest(...) + its already-multiplexed viz consumer.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over a localhost TCP socket (same framing as the
 * MCP stdio server). Discovery: the extension writes DISCOVERY_FILE at the workspace root so
 * the MCP finds the port without guessing.
 *
 * Methods (params in braces):
 *   bridge.hello {}                       -> { ok, control, session, caps }
 *   bridge.state {}                       -> { stopped, userPaused, warp, control, module }
 *   control.request {}                    -> { control }         (AI asks to pilot)
 *   control.release {}                    -> { control }         (AI hands control back)
 *   dap.<request> {args} | dap {cmd,args} -> customRequest result (GATED: see classify())
 *   viz.frame {}                          -> { frame }
 *   viz.screen {}                         -> { scr }  (base64 palette buffer | null)
 *   viz.input {b64}                       -> {}       (INPUT class: AI key uplink bytes)
 *
 * The extension PUSHES events so a client can track run state without polling:
 *   { method: 'event', params: { event: 'stopped'|'continued'|'output'|'signal'|'control'|'ended', ... } }
 */

const DISCOVERY_FILE = '.oric-bridge.json';

const CONTROL = { HUMAN: 'human', AI: 'ai' };

// Error a control op returns when the other party holds control. Soft — the client keeps its
// connection and its observe ops; it just can't drive execution until it holds control.
const ERR_NO_CONTROL = 'NO_CONTROL';

// Classify a DAP/custom request into an op class. 'control' mutates execution/breakpoints and
// is gated on holding control; 'observe' only reads and is ALWAYS allowed (either party, any
// time — so the human can inspect while the AI pilots and vice-versa).
const CONTROL_REQUESTS = new Set([
    'continue', 'pause', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue',
    'goto', 'restart', 'terminate', 'disconnect',
    'setBreakpoints', 'setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints',
    'setAddressBreakpoints', 'oricSetWatchpoints', 'oricArmValueWatch', 'oricClearValueWatch',
    'turboRun', 'setWarp', 'writeMemory', 'setVariable', 'setExpression',
    // Snapshots that mutate the running machine or the snapshot set — gated on control.
    'restoreSnapshot', 'saveSnapshot', 'renameSnapshot', 'deleteSnapshot',
]);
// Reads — safe to allow regardless of who holds control.
const OBSERVE_REQUESTS = new Set([
    'readMemory', 'evaluate', 'stackTrace', 'scopes', 'variables', 'threads',
    'getModules', 'oricResolve', 'dataBreakpointInfo', 'source', 'modules', 'loadedSources',
    'exceptionInfo', 'gotoTargets', 'listSnapshots',
    // Pure lookups: resolve a symbol to an address, and report breakpoint bound/armed state.
    // Both are reads — an observe-only client must not be blocked on them.
    'addrForSymbol', 'breakpointStatus', 'symbolTableLite', 'labelsForAddresses',
]);
function classify(cmd) {
    if (CONTROL_REQUESTS.has(cmd)) return 'control';
    if (OBSERVE_REQUESTS.has(cmd)) return 'observe';
    return 'control';   // unknown -> treat as control (safe default: gated)
}

module.exports = { DISCOVERY_FILE, CONTROL, ERR_NO_CONTROL, classify, CONTROL_REQUESTS, OBSERVE_REQUESTS };
