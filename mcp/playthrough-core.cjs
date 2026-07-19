'use strict';
/*
 * playthrough-core — the driver-agnostic playthrough/automation STEP ALGORITHMS.
 *
 * makeApi(ops, cfg) returns the `t` object a playthrough script drives:
 *   waitFor / waitScreen / runFrames / press / type / read / eval /
 *   assert / assertEq / assertMem / warp / screenshot / log / launch.
 *
 * The algorithms depend only on a small `ops` interface, so the SAME logic runs against
 * two drivers:
 *   - standalone (test/playthrough.cjs) — spawns its own adapter + emulator, and
 *   - in-session (the VS Code extension) — drives the LIVE debug session so a script plays
 *     in the Oric Screen View and can be paused/inspected/resumed.
 *
 * Reliability principle: synchronise on STATE, never on fixed sleeps. `waitFor(addr,cond)`
 * arms a conditional watchpoint and runs full-speed → stops EXACTLY at the checkpoint.
 *
 * ops (all async unless noted):
 *   continue()            resume execution
 *   pause()               halt; resolves when stopped
 *   waitStopped(ms)       resolve on the next 'stopped'; reject on timeout
 *   isStopped()           -> bool (sync)
 *   readMem(addr, n)      -> Buffer
 *   evaluate(expr)        -> string
 *   sendKey(id, down)     inject a key (sync ok)
 *   releaseKeys()         (sync ok)
 *   vizFrame()            -> current viz frame counter (sync)
 *   vizScreen()           -> 240x224 palette Buffer | null (sync)
 *   setWatch(addr, access, cond)   arm a (conditional) watchpoint
 *   clearWatch()          clear the transient watch
 *   warp(on)              set fast-forward
 *   launch(config)        (optional) start a session from nothing
 */

const path = require('path');
const fs = require('fs');
const { screenToPng } = require('./oric-debug-client.cjs');

const { KEYS, keyId } = require('./oric-keys.cjs');   // one shared key-id table (see oric-keys.cjs)

// Typing cadence, in emulator frames (~50 Hz PAL). The Oric keyboard has NO buffering and
// NO n-key rollover, so keys must be entered like a human, never "as fast as possible":
//   HOLD   — a key must stay down across >= 1 keyboard scan to register;
//   GAP    — release + a pause before the next key, so consecutive presses are distinct
//            (and only one key is ever down at a time — there's no rollover);
//   SETTLE — a beat BEFORE the first key with nothing held, so any debounce / "wait until
//            keys released" phase in the game clears (otherwise it eats the first key).
// All overridable per t.type(..., {hold, gap, settle}) / t.press(key, hold, gap).
const KEY_HOLD_FRAMES = 4, KEY_GAP_FRAMES = 2, KEY_SETTLE_FRAMES = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeApi(ops, cfg = {}) {
    const log = cfg.log || (m => process.stderr.write('[play] ' + m + '\n'));
    const outDir = cfg.outDir || path.join(__dirname, '..', 'test', 'playthrough-out');
    // Cooperative pause/cancel: every step passes through _check() first (Stage B wires
    // the UI to pause()/resume()/cancel(); the algorithm is ready for it now).
    const state = { paused: false, cancelled: false, _resume: null };
    async function _check() {
        if (state.cancelled) throw new Error('playthrough cancelled');
        while (state.paused && !state.cancelled) {
            await new Promise(res => { state._resume = res; });
        }
        if (state.cancelled) throw new Error('playthrough cancelled');
    }
    async function _waitUntil(pred, timeoutMs, what) {
        const t0 = Date.now();
        while (Date.now() - t0 < (timeoutMs || 20000)) { if (pred()) return true; await sleep(20); }
        throw new Error('timeout waiting for ' + (what || 'condition'));
    }
    // Coerce a target to a number so a script can use REAL names instead of hardcoded
    // magic numbers: a plain number passes through; '$xx'/'0xxx' is hex; a decimal string
    // is decimal; anything else is a C symbol / label / enum constant resolved LIVE from
    // the loaded debug tables via ops.resolve (so it can't drift out of sync with the game).
    //   kind 'addr'  -> prefer the symbol's address   (waitFor/read/assertMem target)
    //   kind 'value' -> prefer the enum/const's value (assertMem expected)
    async function _num(v, kind) {
        if (typeof v === 'number') return v;
        const s = String(v).trim();
        if (/^(\$|0x)/i.test(s)) return parseInt(s.replace(/^\$/, '').replace(/^0x/i, ''), 16);
        if (/^-?\d+$/.test(s)) return parseInt(s, 10);
        if (!ops.resolve) throw new Error("cannot resolve name '" + s + "' — this driver has no symbol resolver");
        const r = await ops.resolve(s);
        if (!r) throw new Error("unknown symbol/enum '" + s + "' (rebuilt with debug symbols?)");
        const n = kind === 'value' ? (r.value != null ? r.value : r.addr) : (r.addr != null ? r.addr : r.value);
        if (n == null) throw new Error("'" + s + "' has no " + (kind === 'value' ? 'value' : 'address'));
        return n;
    }
    // The first variable reference in a boolean expression — a C identifier or a $hex /
    // *$hex memory ref — used to derive the watched address from a single-expression waitFor.
    function _firstName(expr) {
        const m = String(expr).match(/\*?\$?[A-Za-z_]\w*|\*?\$[0-9a-fA-F]+/);
        return m ? m[0].replace(/^\*/, '') : null;
    }
    // Express a target as a condition lvalue: a symbol name stays a name (the adapter
    // resolves it to a memory read), a $hex/number becomes an explicit *$hex load.
    function _lval(target) {
        if (typeof target === 'number') return '*$' + (target & 0xffff).toString(16);
        const s = String(target).trim();
        if (/^(\$|0x)/i.test(s)) return '*$' + s.replace(/^\$/, '').replace(/^0x/i, '');
        if (/^-?\d+$/.test(s)) return '*$' + (parseInt(s, 10) & 0xffff).toString(16);
        return s;
    }

    const results = [];
    const ok = (label, detail) => { results.push({ label, ok: true, detail }); log('  PASS  ' + label + (detail != null ? ' — ' + detail : '')); };
    const bad = (label, detail) => { results.push({ label, ok: false, detail }); log('  FAIL  ' + label + (detail != null ? ' — ' + detail : '')); };

    const t = {
        results,
        // control surface (used by the runner / Stage B UI)
        _pause() { state.paused = true; },
        _resume() { state.paused = false; if (state._resume) { const r = state._resume; state._resume = null; r(); } },
        _cancel() { state.cancelled = true; this._resume(); },
        _isPaused() { return state.paused; },

        async launch(config) { if (ops.launch) await ops.launch(config); else throw new Error('this driver has no launch(); run against an active session'); },
        async warp(on) { await _check(); await ops.warp(!!on); },

        // Wait until a VARIABLE HOLDS A VALUE — a value-watch: fires when the watched byte
        // changes to satisfy the condition, tested against real committed memory, so it
        // triggers no matter HOW the byte was written (STA/STX/STY/INC/DEC/DMA/…). Checks
        // once immediately too, so an already-true wait returns at once. Forms:
        //   waitFor('_gCurrentLocation == e_LOC_ENTRANCEHALL')  // one boolean expression
        //   waitFor('_gCurrentLocation', 'e_LOC_ENTRANCEHALL')  // variable, expected value
        //   waitFor('_gSceneImage', '*_gSceneImage == 0x10 && _gCurrentLocation != 0')
        // Names (globals, enum constants) are resolved by the emulator/adapter; runs
        // full-speed until the value holds.
        async waitFor(a, b, opts = {}) {
            await _check();
            let target, cond;
            if (b === undefined || (b !== null && typeof b === 'object')) {
                // Single boolean expression — derive the watched var from its first name.
                opts = (b && typeof b === 'object') ? b : {};
                cond = String(a).trim();
                target = _firstName(cond);
                if (target == null) throw new Error("waitFor: no variable to watch in '" + cond + "'");
            } else if (/[=<>!&|~]/.test(String(b))) {
                // Explicit condition expression (compound / advanced).
                target = a; cond = String(b);
            } else {
                // Variable + expected value/enum — build "<var> == <value>".
                target = a; cond = _lval(a) + ' == ' + String(b).trim();
            }
            const addr = await _num(target, 'addr');
            await ops.armValueWatch(addr & 0xffff, cond || null);
            // Only the value-watch firing ('data breakpoint') ends the wait — a manual pause/
            // step (the user inspecting) is ignored, so the CPU just freezes and the wait
            // resumes on continue. The timeout is measured in EMULATED frames (the viz counter),
            // which FREEZE while the machine is paused — so pausing to inspect never trips a
            // spurious timeout; it only fires if the game actually RAN that long without hitting.
            let stopped = false, stopErr = null;
            ops.waitStopped(opts.timeoutMs || 3600000, 'data breakpoint').then(() => { stopped = true; }).catch(e => { stopErr = e; });
            await ops.continue();
            const budget = opts.timeoutFrames || 3000;   // ~60s of RUNNING @ 50 Hz
            const start = ops.vizFrame();
            try {
                while (!stopped) {
                    await _check();   // let Stop / a terminated session abort this wait
                    if (stopErr) throw stopErr;
                    if (ops.vizFrame() - start > budget) throw new Error('waitFor timeout — not met while running: ' + (cond || ('$' + addr.toString(16))));
                    await sleep(30);
                }
            } finally { await ops.clearValueWatch(addr & 0xffff).catch(() => {}); }
        },
        // Resolve a real name to { addr, value, size, type, enumName } (or null). Lets a
        // script read the live address/enum value instead of copying a magic number.
        async sym(name) { return ops.resolve ? ops.resolve(name) : null; },

        // --- Overlay modules ---------------------------------------------------------
        // The active OSDK overlay module NAME (or null). Lets one script work no matter the
        // entry point (splash/intro/game/credits): branch on where the machine actually is.
        async module() {
            if (!ops.getModules) return null;
            const r = await ops.getModules();
            if (!r) return null;
            const m = (r.modules || []).find(x => x.id === r.active);
            return m ? m.name : null;
        },
        // All module names known to this build.
        async modules() { const r = ops.getModules ? await ops.getModules() : null; return r && r.modules ? r.modules.map(m => m.name) : []; },
        // Wait until the active module becomes `name`. Polls (cheap — reads adapter state, no
        // stub round-trip) while running a few frames between checks; a module switch is
        // detected as the overlay's _osdk_dbg_module byte changes. Returns at once if already there.
        async waitModule(name, opts = {}) {
            await _check();
            if ((await this.module()) === name) return;
            const budget = opts.timeoutFrames || 900, poll = opts.pollFrames || 10;   // ~18s of RUNNING @ 50 Hz
            let ran = 0;
            while (ran < budget) {
                const adv = await this.runFrames(poll); ran += adv > 0 ? adv : poll;   // frames FROZEN while user-paused → no burn
                if ((await this.module()) === name) return;
            }
            throw new Error("timeout waiting for module '" + name + "'");
        },
        // Wait until ANY overlay module is active (module() stops being null) — e.g. right
        // after a cold start, let the machine BOOT until the first overlay stamps itself
        // (the adapter can't name the module before then). Runs frames while polling; returns
        // the module name.
        async waitModuleKnown(opts = {}) {
            await _check();
            const budget = opts.timeoutFrames || 1500, poll = opts.pollFrames || 10;   // ~30s of RUNNING (cold boot / tape load)
            let ran = 0;
            for (;;) {
                const m = await this.module();
                if (m != null) return m;
                if (ran >= budget) throw new Error('timeout: no overlay module active yet (did the program boot?)');
                const adv = await this.runFrames(poll); ran += adv > 0 ? adv : poll;
            }
        },
        // Wait until the active module is no longer `from` (it switched to anything else).
        // Pairs with press() for explicit overlay navigation: press the skip key, then wait
        // for the switch before re-checking where you are.
        async waitModuleChange(from, opts = {}) {
            await _check();
            const budget = opts.timeoutFrames || 900, poll = opts.pollFrames || 10;
            let ran = 0;
            while (ran < budget) {
                if ((await this.module()) !== from) return;
                const adv = await this.runFrames(poll); ran += adv > 0 ? adv : poll;   // paused → frozen → no burn
            }
            throw new Error("timeout: module still '" + from + "'");
        },
        // One-shot "run to here": run (normal speed; {warp:true} to rush) until the CPU
        // reaches `target` (a symbol name like '_AskInput', or an address), then stop there.
        // The DIRECT, deterministic way to sync on the game REACHING a point — you can't miss
        // it the way a transient state flag can, so it's ideal for nested/repeated prompts.
        async runTo(target, opts = {}) {
            await _check();
            if (!ops.runTo) throw new Error('this driver does not support runTo');
            await ops.runTo(target, opts);
        },
        // Wait until a logpoint/watchpoint tagged [signal:<id>] fires — the checkpoint lives
        // in the code (a persisted, module-scoped breakpoint), not in the script. Runs
        // full-speed until the signal; then pauses (unless opts.keepRunning) so you can assert.
        async waitSignal(id, opts = {}) {
            await _check();
            if (!ops.waitSignal) throw new Error('this driver does not support waitSignal');
            const p = ops.waitSignal(id, opts.timeoutMs || 60000);
            await ops.continue();
            try { await p; } finally { if (opts.keepRunning !== true) await ops.pause(); }
        },
        // Wait until predFn(scr) holds — polls the live screen while running.
        async waitScreen(predFn, opts = {}) {
            await _check();
            await ops.continue();
            await _waitUntil(() => { const s = ops.vizScreen(); return s && predFn(s); }, opts.timeoutMs || 20000, 'screen condition');
            await ops.pause();
        },
        // Run n emulator frames, then stop (used to hold a key across keyboard scans, and as
        // the polling step for the module/state waits). Returns the frames that ACTUALLY
        // advanced. Respects a USER pause: while the user has the machine paused to inspect,
        // it does NOT resume — it blocks until they continue — so the automation never fights
        // the pause, and callers that budget on the return value don't count paused time.
        async runFrames(n) {
            await _check();
            while (ops.isUserPaused && ops.isUserPaused()) { await sleep(150); await _check(); }
            const start = ops.vizFrame();
            await ops.continue();
            await _waitUntil(() => ops.vizFrame() >= start + n, 10000, n + ' frames').catch(() => {});
            await ops.pause();
            return Math.max(0, ops.vizFrame() - start);
        },
        // Press a key held over `holdFrames` scans. `key` is a letter ('u'), a name
        // ('RETURN'/'KEY_RETURN'/'UP'/'CTRL'), or a numeric code — resolved by the shared
        // keyId() so the automation and the Screen View speak the exact same key ids.
        // Two call forms:
        //   press(key[, holdFrames[, gapFrames]])   one press.
        //   press(key, { until, timeoutFrames, pollFrames, hold, gap })   MASH the key until
        //     the async predicate `until()` returns truthy — for attract modes / sub-prompts
        //     that sample the keyboard intermittently (a single press can be missed, and warp
        //     makes an individual press unreliable). Bounded by timeoutFrames so a wrong key
        //     errors instead of hanging. Returns at once if `until` is already true. Examples:
        //       await t.press('ESC',   { until: async () => (await t.read('gGameStarting',1))[0] === 1 });
        //       await t.press('SPACE', { until: async () => (await t.module()) !== 'Intro' });
        async press(key, holdOrOpts, gapArg) {
            const o = (holdOrOpts && typeof holdOrOpts === 'object') ? holdOrOpts : { hold: holdOrOpts, gap: gapArg };
            const once = async () => {
                await _check();
                const id = keyId(key);
                if (id == null) throw new Error("unknown key '" + key + "' (use a letter, a name like RETURN/UP/CTRL, or a numeric code)");
                const hold = o.hold == null ? KEY_HOLD_FRAMES : o.hold;
                const gap = o.gap == null ? KEY_GAP_FRAMES : o.gap;
                if (ops.tapKey) {
                    // Emulator-OWNED tap: Oricutron presses the key and holds it for `hold`
                    // emulated frames (= guaranteed keyboard scans) then releases, playing one
                    // key at a time. Reliable regardless of host speed/warp, and it can't spam
                    // the input path — we just let it play out. (No timing race here.)
                    ops.tapKey(id, hold);
                    await this.runFrames(hold + gap + 3);
                } else {
                    // Fallback for an emulator without the TAP queue: raw down/hold/up — this
                    // is the timing-sensitive path (a press can be missed under warp).
                    ops.sendKey(id, 1);
                    await this.runFrames(hold);
                    ops.sendKey(id, 0);
                    ops.releaseKeys();
                    await this.runFrames(gap);
                }
            };
            if (!o.until) return once();
            const budget = o.timeoutFrames || 1500, poll = o.pollFrames || 15;
            let ran = 0;
            while (!(await o.until())) {
                if (ran > budget) throw new Error("press('" + key + "'): condition still not met after " + budget + " frames");
                await once();
                const adv = await this.runFrames(poll); ran += adv > 0 ? adv : poll;
            }
        },
        // Type a string at a human pace; '\n'/'\r' submit the line via the RETURN key (the
        // real matrix key — the game reads it back as its own KEY_RETURN). A short settle
        // first, with nothing held, lets any debounce / "wait until keys released" phase
        // clear so the first key isn't eaten. Timing overridable: type(text, {hold,gap,settle}).
        async type(text, opts = {}) {
            const settle = opts.settle == null ? KEY_SETTLE_FRAMES : opts.settle;
            if (settle > 0) { await _check(); await this.runFrames(settle); }
            for (const ch of String(text)) await this.press(ch === '\n' || ch === '\r' ? 'RETURN' : ch, opts.hold, opts.gap);
        },
        // Named key ids (t.KEY.RETURN) and the resolver (t.key('KEY_RETURN') → id).
        KEY: KEYS,
        key: keyId,

        async read(target, n) { await _check(); const addr = await _num(target, 'addr'); return ops.readMem(addr & 0xffff, n || 1); },
        async eval(expr) { await _check(); return ops.evaluate(expr); },
        assert(label, cond, detail) { cond ? ok(label, detail) : bad(label, detail); return !!cond; },
        assertEq(label, actual, expected) { const c = String(actual) === String(expected); c ? ok(label, String(actual)) : bad(label, 'got ' + actual + ', want ' + expected); return c; },
        // `target` and `expected` may be real names — 'e_LOC_LARGE_STAIRCASE' resolves to its
        // enum value, so assertMem('at staircase', '_gCurrentLocation', 'e_LOC_LARGE_STAIRCASE').
        async assertMem(label, target, expected) {
            const b = await this.read(target, 1);
            const exp = await _num(expected, 'value');
            return this.assertEq(label, b.length ? b[0] : '(none)', exp);
        },

        screenshot(name) {
            const scr = ops.vizScreen();
            if (!scr) { log('screenshot skipped (no frame): ' + name); return null; }
            fs.mkdirSync(outDir, { recursive: true });
            const p = path.join(outDir, /\.png$/i.test(name) ? name : name + '.png');
            fs.writeFileSync(p, screenToPng(scr, 3));
            log('screenshot ' + p);
            return p;
        },
        log(m) { log(m); },

        summary() {
            const pass = results.filter(r => r.ok).length;
            return { pass, total: results.length, allPassed: pass === results.length && results.length > 0, results };
        },
    };
    return t;
}

module.exports = { makeApi };
