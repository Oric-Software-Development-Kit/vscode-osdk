# Changelog

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
