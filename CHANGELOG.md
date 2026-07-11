# Changelog

## 0.0.11

### No More Auto-Opening Built-in Disassembly View
- The adapter no longer advertises `supportsDisassembleRequest`, so VS Code stops auto-opening (and re-opening on every launch) its built-in **Disassembly** view when execution stops at a source-less address such as the BASIC ROM. This extension provides its own "Oric Disassembly" panel (via a custom request), which is unaffected

## 0.0.10

### Heatmap Delta Streaming (Screen View ~50 fps)
- The viz stream now sends the memory heatmap as **per-frame access deltas** (run-lists) instead of three full 64 KB arrays every frame, and the heatmap webview decays locally and applies the deltas — matching Oricutron's viz protocol v2. This removes the ~192 KB/frame that was throttling the pipeline, so the **Oric Screen View runs at ~50 fps** instead of ~16
- The webview coalesces its canvas redraw with `requestAnimationFrame` (decay + delta-apply still run on every frame, since deltas are non-droppable), so a slow or backgrounded panel can't back up
- The frame parser handles the v2 variable-length format (with a corrupt-length guard) and still accepts legacy v0/v1 full-array frames

## 0.0.9

### Breakpoint Line Snapping
- A breakpoint on a non-executable line (comment, blank, declaration) now snaps **forward** to the next executable line, matching normal debugger behavior — previously it snapped backward to the nearest earlier line, which also caused distinct requested lines to collapse onto one earlier line (duplicate markers). Falls back to the nearest line before only when nothing follows (breakpoint past the last statement).

## 0.0.8

### Stale-Host Detection
- On session start, if `extension.js` on disk is newer than the version this VS Code window actually loaded, a warning fires (with a **Reload Window** button) and a note prints in the Debug Console — closing the gap the mtime banner alone leaves (it reports disk state, not whether the running host matches). The adapter and `resolver.cjs` respawn per session so they can't go stale; only the host-resident `extension.js` can.

## 0.0.7

### Single-Source-of-Truth Address Resolver (call stack fixed)
- New `resolver.cjs`: one pure, testable resolver that every view uses to answer "what is at address X" — name and source come from ONE canonical owner, so the call stack, disassembly, hover and annotations can't disagree
- Fixes the call stack landing on the wrong symbol at an aliased address (DOGFOODING #1): at `$FD40`, `jmp _LoaderResidentStart` now resolves to `_LoaderResidentStart @ loader.asm:150` (the real `jsr`), not the coincidental `_OverlayBufferEnd @ kernel.s:734` boundary marker
- Correct owner selection across all aliased addresses: line-entry-first with per-unit run detection, storage-over-EQU tie-break, source-text code/data classification; arbitrary mid-routine PCs resolve to `symbol+$offset` + enclosing line, gated so a ZP symbol never owns a mid-memory PC and an unlabeled stretch doesn't get a nonsense `func+$big`
- Validated by two independent implementations agreeing: an offline golden test (412 aliased addresses × 7 module views) + nearest-below fixtures — runnable with plain `node test/resolver.golden.test.cjs`
- So far wired into the call stack (`makeFrame`); the inline annotation, disassembly labels, and breakpoint binding migrate to the resolver next

### Session Banner
- The Debug Console now prints, at session start, the extension version + file mtimes of `debug_adapter.js` / `extension.js` / `resolver.cjs`, so it's obvious at a glance whether a reload/respawn picked up your edits (the adapter respawns per session; `extension.js` needs a window reload)

## 0.0.6

### Inline Current-Line Value Annotation (fixed + enhanced)
- The current-line operand annotation now renders reliably: it never showed on Windows because symbol files store paths with an uppercase drive letter (`E:\`) while VS Code's `fsPath` is lowercase (`e:\`), so the strict path match failed
- New `canonPath()` (adapter + extension) resolves and case-folds paths **only on case-insensitive filesystems** (Windows/macOS), leaving Linux case-sensitive — replacing the previous Windows-only `.toLowerCase()` matching for decorations, breakpoints, and module mapping
- GitLens' current-line blame is suppressed during a debug session (restored afterward, crash-safe) so the value annotation owns the end-of-line slot instead of being hidden behind it
- The annotation is cleared on each stop, so the previous line's value no longer flickers during post-step navigation
- Resolved byte values are shown three ways: hex | decimal | binary (e.g. `$63|99|%01100011`)

### Go-to-Definition Hint
- The hover's "go to definition" hint now reflects the actual gesture for your `editor.multiCursorModifier` and OS (Alt+Click / Ctrl+Click / Cmd+Click), instead of hard-coding Ctrl+Click

## 0.0.5

### Log Verbosity Control
- Memory-read/write GDB traffic (`m`/`M`/`X`) is suppressed from the verbose log — the constant `[GDB] → m…` / `[GDB] ← (N chars)` noise from the variables/memory views no longer drowns the trace (genuine stop notifications still show)
- Status bar (bottom left) shows the current **Log** level; click to switch Errors / Normal / Verbose without editing `launch.json`
- New `loglevel [0|1|2]` debug-console command shows or sets the level inline

### Debug Console Help
- New `help` (or `?`) command prints a categorized reference of every console command, replacing the single-line fallback message

## 0.0.4

### Transparent Module-Load Breakpoint Arming
- A hidden write-watchpoint on `_osdk_dbg_module` detects overlay module switches during free-run and arms the incoming module's breakpoints *before* its code runs — so a breakpoint set in a not-yet-loaded overlay fires the first time that overlay loads
- The watchpoint stop is handled invisibly (single-step to commit the write, then resume), so a routine that merely touches the flag never surfaces as a stop
- Module state is write-driven and trust-gated: at cold boot the byte is uninitialized RAM, so the extension shows "Module: (none)" and doesn't believe the value until an actual write is observed (or when attaching to a running program). No overlay is presumed active until one truly loads

### Warp Speed Indicator
- The debug toolbar warp button now reflects the current speed: `$(watch)` at normal speed, `$(rocket)` in warp

### Multi-Module Symbols (overlay support)
- Symbol files with `#MODULE <id> <name>` sections load into per-module buckets; resident symbols compose with the active module
- Active module auto-switches from the resident `_osdk_dbg_module` byte on each stop; status bar shows "Module: <name>" (click to override)
- Breakpoints resolve against their file's owning module and arm in the stub only while that module is active (or resident); they re-arm on module switch
- Inactive-overlay breakpoints show as unverified (gray) with an explanatory message, and go verified (red) when their module loads

### Breakpoint Consistency Across Views
- VS Code's breakpoint model is the single source of truth; the source gutter, Breakpoints panel, disassembly view, and Oricutron's monitor are all views over it
- Disassembly gutter clicks now create real VS Code breakpoints (source or instruction), so they replicate to every other view; armed = solid dot, pending = hollow ring
- Breakpoints set or cleared by hand in Oricutron's monitor sync into VS Code (via the stub's `qOricBreakpoints` query, reconciled on each stop)
- One stub breakpoint per address, ref-counted across source/function/instruction/temp breakpoints — no more duplicate or ghost breakpoints; a stop reports every breakpoint at the PC

### Symbol Browser
- New "Oric: Symbol Browser" webview panel listing all runtime symbols and `#define` constants
- Alias merging: symbols at the same address are grouped into a single row, master definition listed first
- Live values displayed during debug sessions
- Group filter dropdown (ZP, BSS, Code, Data, Define)
- Sortable columns and text search
- Hover a row to highlight the address on the Memory Heatmap
- Click any symbol name to jump to its source definition

### Instruction Operand Annotations
- On each debug stop, the current source line shows resolved operand values inline
- All 6502 addressing modes decoded: immediate, zero page, absolute, indexed, indirect, relative
- Branch instructions show "taken" or "not taken" based on current flags
- Example: `sta ($50),Y` → `(*(ptr=$50)=$A398+Y:$02)=$A39A`

### Heatmap Address Crosshair
- Crosshair overlay drawn on the Memory Heatmap when hovering symbols in the Symbol Browser or editor
- Auto-follows the PC address on each debug stop
- Black-white-black 3-line technique for universal contrast on any heatmap color

### Code Navigation
- **Hover provider**: hover over symbol names or `#define` constants to see address, value, aliases, and source location
- **Definition provider**: Ctrl+Click or F12 on symbols to jump to their definition in source code
- `#define` directives (`#define NAME value`) scanned from workspace `.s`, `.h`, `.asm` files
- Hex addresses (`$HHHH`) in source code also show heatmap crosshair on hover

### Show Current Location
- New "Oric: Show Current Location" command (Ctrl+Alt+Home) to navigate back to the current PC
- Also available as a stackframe icon button in the debug toolbar

### Safety Improvements
- "Jump to Cursor" (goto) now refuses addresses below $0400 (zero page, stack, page 2, I/O) to prevent accidental PC corruption

### Documentation
- Comprehensive README with all commands, keyboard shortcuts, debug console commands, configuration reference, and symbol file format documentation

## 0.0.3

### Screen View
- Live Oric screen display in VS Code via "Oric: Screen View" command
- Rendered from Oricutron's 240x224 screen buffer streamed over viz_stream v1
- Column grid (6px) and row grid (8px) overlays with selectable colors
- Grid shown in zoom view as well as main view
- Pixel inspector: hover to see address, byte value, bit position, color info
- Address calculation mirrors Oric ULA logic (HIRES/TEXT/status rows)
- Configurable zoom factor (2x/4x/6x/8x/12x) and region size (10/20/30/40px)
- Black-white-black crosshair on main view, pixel highlight in zoom
- Save PNG to project `screenshots/` folder with timestamp
- Copy screen to clipboard (Windows)
- All settings (grids, color, zoom) persisted across reloads

### Heatmap improvements
- Stacked full-width layout: ZP, Stack, Page 2, I/O as separate strips
- Proper resize behavior at any panel width

### Shared viz_stream connection
- Single TCP connection shared between heatmap and screen panels
- Frame parser auto-detects v0/v1 format from version field
- Consumer registration pattern: panels register/unregister independently
- Auto-reconnect on connection loss (2s retry while debug session active)
- Initial frame sent on connect so paused emulator shows current screen

### Panel persistence
- Heatmap and Screen View panels survive extension reloads via WebviewPanelSerializer

### Virtual disassembly source
- Frames without source mapping now provide a virtual disassembly document
- VS Code automatically opens disassembly as a read-only text tab on first stop
- No more empty disassembly view or manual navigation needed
- 80-instruction window centered on PC with symbol labels

### Source mapping improvements
- Plausible mapping filter prevents bogus source navigation
  - Zero page/stack/IO symbols only match within their own page
  - Main memory symbols allow up to 1KB offset
- `labelFor()` returns raw hex for implausible matches instead of misleading offsets

## 0.0.2

- Memory Heatmap: real-time visualization of CPU reads, writes, and ULA video fetches
  - Opens as a movable editor panel via "Oric: Memory Heatmap" command
  - Connects to Oricutron's heatmap stream on `gdb_port + 1` automatically
  - Color mapping: Red = writes, Green = reads, Blue = ULA, with additive blending
  - Segmented layout: ZP, Stack, Page 2, I/O blocks; main RAM ($0400-$BFFF); ROM/RAM ($C000-$FFFF)
  - Address tooltip on hover, ROMDIS-aware ROM/RAM label
  - Freezes display when emulator is paused, resumes on continue
  - Connection status and errors shown in panel and Debug Console ("Oric Debug" output channel)

## 0.0.1

- 6502/XA assembly syntax highlighting for `.asm` and `.s` files
- Debug adapter for Oricutron via GDB Remote Serial Protocol
- Step, continue, pause, breakpoints, call stack, disassembly view
- Debug panels: CPU Registers, Zero Page, Peripherals
- Debug console commands: register read/write, memory read/write, goto, skip, symbol lookup
- Memory View: expression-based memory viewer with hex, words, decimal, and binary formats
- XA Quick Reference and 6502 Opcode Reference searchable webview panels
- Conflict detection for the jede.osdk extension
