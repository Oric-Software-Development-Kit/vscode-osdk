# Changelog

## 1.0.0

First release published to the Marketplace. The 0.0.x versions below were never published, so this
entry describes the feature set rather than the increments that built it.

### Debugging
- Source-level debugging for C and assembly over Oricutron's GDB stub: breakpoints, stepping, call
  stack and locals. Step-over follows C statements at `-O1` rather than stepping into every `JSR`.
- **Conditional breakpoints** compiled to a bytecode VM that runs inside the emulator, so a condition
  is evaluated without a debugger round-trip. Conditions understand registers, flags, memory and C
  variables including members, subscripts and enum names, and persist across sessions.
- **Watchpoints** on read / write / access, optionally conditional; hit counts; **logpoints** with
  `{expr}` placeholders and `[stop]` / `[save]` markers.
- **Reverse stepping** over a history ring, and full machine **snapshots** to save and restore.
- Instruction and address breakpoints, and function breakpoints by symbol name, for work without
  source. Stopping in source-less code opens a generated disassembly instead of a blank editor.

### Panels
- **Debug Dashboard** — the machine at the current stop in one view: flags and cycles, A/X/Y, SP with
  a preview of the pushed stack and its probable return addresses, previous and current location, the
  current instruction, the C statement with its variables decoded, locals, and the interrupt vectors
  resolved to routine names. Identifiers jump to their definition. Wrap and `%binary` toggles in the
  title bar.
- **Oric Breakpoints** as a module → file → line tree, with per-condition rows.
- **Snapshots & Automation**, **Oric Peripherals** (VIA, PSG, FDC, ACIA), **Oric Documentation**.
- **Screen View** with an optional WebGL CRT shader, keyboard control of the running program,
  screenshots and pixel inspection.
- **Memory** as hex / words / decimal / binary or decoded as a HIRES bitmap, plus **Memory Map**,
  **Memory Heatmap**, **Symbol Browser** and **Disassembly**.

### Typed values
- Values are decoded from the symbol file's type information and `@…` comment annotations — enums by
  name, pointers followed, structs, arrays, members, subscripts, bitsets, BCD, booleans and strings —
  through one shared render path, so a value reads the same in every view.

### Automation and AI
- `automation/*.js` scripts driven against a live session: step, read/write memory, set breakpoints,
  capture screenshots.
- An **MCP server** exposing the session to an AI assistant, with a collaborative bridge and an
  on-screen control indicator.

### Editor integration
- 6502/XA syntax highlighting, built-in XA and 6502 references, inline cycle counts and operand
  annotations, hover and go-to-definition, and source-file label colouring by type.

### Requirements
- **OSDK 2.0 or later** (verified at startup, with a live checklist under *Oric: Getting Started*)
  and Oricutron with GDB-stub support, included in OSDK 2.0.
