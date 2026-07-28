# Feature tour

Everything the extension does, grouped by area. For the one-screen summary see the
[README](../README.md); for how to drive each piece, follow the links from the
[documentation index](README.md).

---

### Syntax Highlighting

- 6502 and XA assembly language syntax highlighting for `.asm` and `.s` files
- TextMate grammar with support for mnemonics, directives, labels, numbers, strings, and comments

### Debug Adapter

Connects VS Code to Oricutron's GDB Remote Serial Protocol (RSP) stub over TCP.

- **Launch** mode: build your project (with staleness check), launch Oricutron, and attach automatically
- **Attach** mode: connect to an already-running Oricutron instance
- **Step** (F10/F11), **Step Out** (Shift+F11, native), **Continue** (F5), **Pause** (F6)
- **Instruction / address breakpoints** via the Breakpoints panel — adapter-owned, persisted per workspace, individually enable/disable-able (useful for source-less RE work where you break on a raw `$address`)
- **Function breakpoints** using symbol names
- **Conditional breakpoints** — put a condition on any line breakpoint (VS Code: right-click gutter → *Edit Breakpoint… → Expression*). The condition is compiled to a tiny **bytecode VM that runs inside the emulator**, so it's evaluated at full speed with no debugger round-trip, and it also works from the standalone monitor. Conditions understand registers/flags (`X == 30`), C variables including members/subscripts/enums (`e->hp < 0`, `g_entities[i].hp == 0`, `_gCurrentLocation == e_LOC_MARKETPLACE`), and memory (`*$94:w > 1000`). Conditions persist across sessions.
- **Data breakpoints (watchpoints)** — break on read / write / access of a memory address. Right-click a variable in Variables or the Symbol Browser watch → *Break on Value Read/Change/Access*, or **Oric: Add Watchpoint…**. Watchpoints can carry a **condition** too (break only when the written value matches), and are managed in the **Oric Breakpoints** panel. (Single address per watchpoint; the stub allows up to 16.)
- **Time-travel / reverse debugging** — step backwards through recent history (see [Time-Travel Debugging](debugging.md#time-travel-debugging)).
- **Logpoints (print breakpoints)** — a breakpoint that prints instead of stopping. Right-click the editor gutter → *Add Logpoint*, and enter a message with `{expr}` placeholders. On hit the message is evaluated, written to the Debug Console (in cyan, to stand out from the emulator's own output), and execution resumes automatically. Placeholders accept a register (`{a}`, `{pc}` — decoded via its type tag), a symbol (`{gCurrentLocation}` — fully typed: enum name, struct, etc.), or a `$hex` address (`{$C000}`). `{{`/`}}` are literal braces. Put **`[stop]`** anywhere in the message to both log **and** stop at that line (VS Code allows only one breakpoint-or-logpoint per line, so this is how to get both behaviours at one spot); the `[stop]` marker itself is not printed. Put **`[save]`** in the message to take a machine **snapshot** every time the line is hit (see [Snapshots](debugging.md#snapshots)) — e.g. a logpoint `Entering level {level} [save]` gives you a restore point at each level. Marker tokens are never printed.
- **Call stack** walking (reconstructed from the hardware stack)
- **Disassembly panel** — a dockable view (*Oric: Disassembly View*) with symbol-resolved operands and per-line run / turbo-run / jump / skip actions
- **Automatic disassembly fallback** — when execution stops in code with *no source mapping* (ROM or a library), the debugger opens a generated disassembly of the surrounding instructions in a read-only editor tab, centered on the current PC — so you land on the instructions instead of a blank "no source" screen, and can keep stepping

### Screen & Video

- **Oric Screen View** (*Oric: Screen View*) — a live view of the Oric's display, with an optional WebGL **CRT shader** (scanlines, aperture mask, optional curvature) and a pixel-aspect toggle.
- **Full keyboard control** — type into the Screen View to drive the running program; key presses are queued to the emulator over a live control channel.
- **Screenshots** — save a PNG or copy the current screen to the clipboard (and open the screenshots folder).
- **Pixel inspection** — hover the screen (or a graphic memory view) to zoom in with a crosshair and read the pixel / byte / colour under the cursor.

### Memory & Graphics

- **Oric Memory** (*Oric: Memory View*) — inspect memory at any expression (`_Symbol`, `*_Ptr`, `$A000`, `_Buf+X`) as **hex / words / decimal / binary**, or as a **graphic** view that decodes the bytes as an Oric HIRES bitmap (HIRES and masked/alpha decoders, width in bytes, zoom, optional grid), with hover inspection relayed to the Screen View zoomer.
- **Oric Memory Map** (*Oric: Memory Map*) — a built-in memory map (Normal / Overlay / Zero tabs, section totals, largest blocks, clickable labels), regenerated from the current module's symbols (see [Memory Map](panels.md#memory-map)).
- **Oric Memory Heatmap** (*Oric: Memory Heatmap*) — a heatmap view of memory activity across the address space.
- **Oric Symbol Browser** (*Oric: Symbol Browser*) — a searchable symbol + `#define` browser with live typed values, jump-to-source and pin-to-Watch, plus a Watch section for arbitrary expressions.

### Typed C-Language Decoding

- Values are decoded from the symbol file's type info and `@…` source annotations — **enums** by name, **pointers** followed, **structs / arrays / members / subscripts**, **bitsets**, **BCD**, **booleans** and **strings** — consistently across the Watch, Variables, the **Debug Dashboard**, inline annotations, breakpoint conditions and disassembly operands. One shared render path, so a value looks the same wherever it appears.

### Registers & Peripherals

- **Debug Dashboard** — one panel for the whole stop: flags and cycles, A / X / Y, SP with a preview of the pushed stack and its probable return addresses, previous and current location, the current instruction, the C statement with its variables decoded, locals, and the interrupt vectors resolved to routine names. Every identifier in it jumps to its definition.
- **Oric Peripherals** — live VIA, AY (PSG), FDC and ACIA hardware registers.

### Snapshots

- Save and restore full machine-state **snapshots**, with a lightweight history ring that powers time-travel and one-click restore points (including via `[save]` logpoints). See [Snapshots](debugging.md#snapshots).

### Automation

- Run **automation scripts** (`automation/*.js`) against the live session — step, read/write memory, set breakpoints, capture screenshots — from the **Snapshots & Automation** panel's *Automation* group (see [Automation scripting](automation.md)).

### AI Collaboration (MCP)

- Expose the live debug session over the **Model Context Protocol** so an AI assistant (e.g. Claude) can inspect and drive it (*Oric: Register MCP Server*), and share your running GUI session through a **collaborative bridge** with an on-screen control indicator (*Oric: AI Collaboration — Start/Stop Bridge*). See [Collaborative mode](mcp.md#collaborative-mode--how-to-use-it).

### Editor Integration

- **Source-file label colouring** by type — C / header / assembler / automation — in editor tabs and the Explorer.
- **`@` annotations** (`@enum`, `@ptr16`, `@bool`, `@bcd`, `@word`, `@str`, `@bitset`) drive the typed decoding and are re-read on save (*Oric: Reparse Annotations*); *Oric: Reload Symbols* picks up new symbols/types after a byte-identical rebuild.
- **Documentation panel** — one-click links to this manual, the XA / 6502 references, and the OSDK site / Defence Force forum.

---

[← Documentation index](README.md) · [Extension README](../README.md)
