# Scripted playthrough regression runner

`playthrough.cjs` plays an Oric game **deterministically in warp**, driving keys and
waiting on game state, asserting prerequisites at each checkpoint — an unattended
end-to-end regression test. It drives the osdk-debug adapter (DAP) + viz stream via the
shared client (`../mcp/oric-debug-client.cjs`), the same client the MCP server uses.

## The one principle that makes it reliable
**Synchronise on STATE, never on fixed `sleep`s** (that's what makes input automation flaky):
- `waitSignal(id)` — **the preferred checkpoint.** A logpoint/watchpoint tagged
  `[signal:<id>]` fires a named signal when hit; the script just `await t.waitSignal('id')`.
  The checkpoint lives in the code (a persisted, module-scoped breakpoint), not hardcoded in
  the script — so the script survives address/layout changes. Runs full-speed until the signal.
- `waitFor(expr)` — a **value watch**: runs full-speed and stops *exactly* when the watched
  variable holds the value, tested against real committed memory — so it fires no matter HOW
  the byte was written (`STA`/`STX`/`STY`/`INC`/`DMA`/…). It watches the *value*, not the
  write. `waitFor('_gCurrentLocation == e_LOC_ENTRANCEHALL')` or the shorthand
  `waitFor('_gCurrentLocation', 'e_LOC_ENTRANCEHALL')`. (Emulator: `qOricWatchVal` → an
  `MBPF_CHANGE` watch whose condition is evaluated after each change.)
- `waitScreen(pred)` — polls the live viz screen buffer while running (no CPU stop).
- `runFrames(n)` — runs n emulator frames (used to hold a key across a keyboard scan).

The `[signal:<id>]` token composes with `[stop]` (halt at the exact point) and `[save]`
(snapshot on hit) — e.g. a message `game prompt ready [signal:prompt] [save]`.

A step is: **drive input → wait for state → assert**. Same inputs → same run (the game is
deterministic, fixed RNG seed).

## Run
```
node test/playthrough.cjs <config.json>
```
`config.json` is an oric-debug launch config — `{ port, launchScript|emulatorPath, diskImage,
cwd, symbolFile, gdbBreak }`. **`port` = the human base gdb port + 1** so it runs its own
emulator. Screenshots + `report.json` land in `test/playthrough-out/`.

**Prerequisite:** the emulator it launches must be the **conditional-watchpoint build**
(`qOricWatchCond`), or `waitForWrite` conditions won't apply.

## Harness API (`t`, from `mcp/playthrough-core.cjs makeApi(ops)`)
- `launch(config)` · `warp(on)`
- `waitSignal(id, {timeoutMs, keepRunning})` · `waitFor(expr | target, valueOrCond, {timeoutMs})` · `waitScreen(predFn)` · `runFrames(n)`
- `press(key, holdFrames, gapFrames)` · `type(text, {hold, gap, settle})` · `KEY` (id table) ·
  `key(name)` — `key` is a letter (`'u'`), a name (`'RETURN'`/`'KEY_RETURN'`/`'UP'`/`'CTRL'`/`'ESC'`…)
  or a numeric code; `type`'s `'\n'`/`'\r'` submits the line via RETURN. Key ids live in one shared
  table (`mcp/oric-keys.cjs`), used by the runner AND injected into the Oric Screen View webview, so
  scripted and manual keypresses can't drift (that table mirrors the emulator's `viz_map_key`).
  Typing is **human-paced by necessity** — the Oric keyboard has no buffer and no n-key rollover, so
  each key is held across a scan (`hold`), released with a `gap` before the next, and `type` waits a
  short `settle` (nothing held) before the first key so any "wait until keys released" phase clears.
- `read(target, n)` · `eval(expr)` · `sym(name)` · `assert(label, cond)` · `assertEq(label, a, b)` · `assertMem(label, target, expected)`
- `screenshot(name)` · `log(m)` · `summary()`

### Reusable, game-specific helpers
Keep the `t` API game-agnostic; put game knowledge in a helper module next to your scripts and
`require` it. Encounter's lives at `<project>/automation/encounter.js` and exposes `command(t, 'take bag')`
(waits for the parser prompt to be ready, then types + Return), `waitLocation(t, 'e_LOC_...')`,
`assertLocation(...)`. Scripts then read like a walkthrough. The in-session runner **reloads the whole
automation folder each run**, so editing a helper takes effect on the next run — no window reload.

### Real names, not magic numbers
`target` (waitFor/read/assertMem) and `expected` (assertMem) accept the game's **actual
symbols**: a C global (`_gCurrentLocation`), an enum constant (`e_LOC_LARGE_STAIRCASE`),
a `'$hex'` address, or a plain number. `condExpr` likewise understands registers, globals
and enum constants (resolved natively in the emulator). All are resolved **live** from the
loaded debug tables (via the adapter's `oricResolve` request), so a script never hardcodes
addresses/enum values that rot when the game changes:

```js
await t.waitFor('_gCurrentLocation == e_LOC_LARGE_STAIRCASE');   // one expression
await t.waitFor('_gCurrentLocation', 'e_LOC_LARGE_STAIRCASE');    // var, expected value
await t.assertMem('at staircase', '_gCurrentLocation', 'e_LOC_LARGE_STAIRCASE');
const loc = await t.sym('_gCurrentLocation');   // { addr, value, size, type, enumName }
```

`waitFor` does what it says: it waits for the variable's **value**, so you never think about
which instruction (or DMA) wrote it. For compound state use an explicit condition on the
watched var, e.g. `waitFor('_gSceneImage', '*_gSceneImage == 0x10 && _gCurrentLocation != 0')`
— it fires when `_gSceneImage` changes and both hold. (To instead catch the *culprit
instruction* that performs a write — landing you on the `STA` with the call stack — use the
Oric Breakpoints panel's write-watchpoint with a register condition; that's a different tool.)

The step algorithms live in `mcp/playthrough-core.cjs` (`makeApi(ops)`) and are shared with
the VS Code in-session automation runner — this standalone driver just binds the DAP+viz
client to `ops`. `run(config, scriptFn)` launches, runs the script, and writes report.json.

## Example (Encounter test build)
The `main()` in `playthrough.cjs` shows a slice: boot → wait for the entrance → assert
`$91 == 23` → screenshot → press `U` → wait for the staircase → assert `$91 == 26` →
screenshot. Adjust the addresses/enum values/keys for your build and extend across the game.

## Self-test (no emulator)
`node test/playthrough.selftest.cjs` drives the harness against mock DAP/viz clients to
verify the control flow (arm+wait, frame-counting, key press, assert, screenshot, report).
Exit 0 = pass. Run it after changing the harness.
