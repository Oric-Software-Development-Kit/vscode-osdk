# Changelog

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
