# Changelog

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
