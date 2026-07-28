# Automation scripting

Drive a live session from JavaScript: step, read/write memory, set breakpoints,
capture screenshots.

---

Drive the emulator from a JavaScript script that runs **against your live debug session** — the program plays in the **Screen View**, and you can pause, inspect, and resume it like any debug session. Scripts are for reproducible playthroughs, regression checks, "get me to the interesting state" setup, and hunting timing/state bugs.

**Folder layout** — a *standalone, runnable* script is a file directly under `automation/` that exports a function; shared *utility modules* go in **`automation/lib/`** (they're never run on their own):

```
automation/
  example.js        ← a runnable script (module.exports = async (t) => { … })
  lib/
    encounter.js    ← utility helpers, imported by scripts (require('./lib/encounter'))
```

```js
// automation/example.js
module.exports = async (t) => {
    await t.waitModuleKnown();            // wait until an overlay module is active
    if (await t.module() === 'Splash') await t.press('SPACE', { until: async () => (await t.module()) !== 'Splash' });
    await t.waitFor('_gCurrentLocation', '== e_LOC_MARKETPLACE');   // run full-speed, stop EXACTLY here
    t.screenshot('at-marketplace');
    await t.type('take bag\n');           // reliable keystrokes (see below)
};
```

Run a script from the **Snapshots & Automation** panel's *Automation* group (in the Run & Debug sidebar) — it lists the
runnable scripts (top-level `automation/*.js`, *not* `lib/`), each with a **▶ Run** button;
clicking a row opens the script, and the running one shows a spinner. Or use **Oric: Run
Automation Script…** from the palette. Running one **starts a debug session if none is active**
(F5-equivalent). Stop it with the panel's **■** (or **Oric: Stop Automation Script**). Edit and
re-run — the whole `automation/` folder is reloaded each time, so scripts *and* their `lib/`
helpers iterate live. Stopping the debug session also stops the script.

**How ▶ Run gets a session** — a script declares its need as metadata, so Run doesn't prompt for a launch config it doesn't require. Put it at the **top** with the object form (metadata can't sit above a bare `module.exports = fn`, which would overwrite it):

```js
module.exports = {
    session: 'any',          // reuse the running session, else launch one   (default)
    config: 'Build & Run',   // when launching, use this config — skips the picker
    run: async (t) => { … }, // the script
};
```

- **`session`**: `'existing'` (run in the CURRENT session — a **utility**, never launches; e.g. "screenshot + snapshot + dump some vars" while debugging) · `'fresh'` (needs a freshly-launched emulator; confirms a restart if one is running) · `'any'` (default: reuse the running session, else launch).
- **`config`**: the launch.json config to launch, skipping the picker. Prefer a **run** (not debug/paused) config for playthroughs — starting paused just makes the script continue past the stop. If `config` is omitted and a launch is needed, Run uses the only config, else the one you last picked (remembered) — prompting at most once.

A plain `module.exports = async (t) => { … }` also works (attach metadata *after* it: `module.exports.session = …`); the object form is just how you get the metadata to the top.

### The `t` API

Everything is `async` unless noted. Values that take a "name" (`waitFor`, `assertMem`, key names) resolve **real symbols and enums** (`_gCurrentLocation`, `e_LOC_MARKETPLACE`) — never hard-code magic numbers.

| Method | What it does |
|---|---|
| `t.waitFor(varName, cond, opts?)` | **The reliable "wait until".** Arms a value-watch on `varName` and runs at full speed until it holds a value — `t.waitFor('_gCurrentLocation', '== e_LOC_MARKETPLACE')`. It fires on *any* write path (STA/STX/INC/DMA…), because you care about the value, not the instruction. Frame-based timeout (doesn't count while you pause). |
| `t.runTo(target, opts?)` | Run to a symbol or `$hex`, then stop. |
| `t.runFrames(n)` | Let N emulated frames pass (~50 = 1 s). Blocks while you've paused. |
| `t.press(key, hold?, gap?)` / `t.press(key, {until})` | Press one key — a letter, a NAME (`RETURN`/`ESC`/`UP`/`SPACE`/`CTRL`…), or a code. Each key is played by the **emulator's own tap queue** (held across keyboard scans, one at a time), so it isn't dropped under warp. The `{until}` form mashes the key until an async predicate is true (attract screens / sub-prompts). |
| `t.type(text, opts?)` | Type a string reliably; `\n`/`\r` send Return. |
| `t.warp(on)` | Fast-forward on/off (applied immediately, even while running). |
| `t.module()` / `t.modules()` | Active OSDK overlay name / all module names. |
| `t.waitModule(name)` / `t.waitModuleKnown()` / `t.waitModuleChange(from)` | Wait for a given overlay / for *any* to become active / to leave one. |
| `t.waitSignal(id)` | Run until a logpoint/watchpoint tagged `[signal:<id>]` fires. |
| `t.waitScreen(pred)` | Run until a predicate over the screen buffer is true. |
| `t.read(target, n?)` / `t.eval(expr)` | Read memory at a symbol/address / evaluate a debugger expression. |
| `t.assert(label, cond)` / `t.assertEq(...)` / `t.assertMem(label, target, expected)` | Checkpoints; `assertMem` resolves enum names for `expected`. |
| `t.screenshot(name)` | Save a PNG of the screen. |
| `t.log(msg)` | Log a line to the automation output. |
| `t.KEY` / `t.key(name)` | The named key-id table / resolve a key name to its id. |

**Reliability principle:** synchronise on *state*, never on fixed sleeps. `waitFor`/`waitModule`/`runTo` run at full speed and stop *exactly* at the checkpoint, so a script is immune to timing and warp.

**Game-specific helpers** stay in a `lib/` module so the generic `t` API stays game-agnostic — e.g. Encounter's `automation/lib/encounter.js` wraps the text-parser handshake into `enc.command(t, 'take bag')` (which types, *verifies* the input buffer landed, and retries). Overlay navigation is written out explicitly with plain `if` blocks per script (transparent and editable), not hidden in a black-box helper.

---

[← Documentation index](README.md) · [Extension README](../README.md)
