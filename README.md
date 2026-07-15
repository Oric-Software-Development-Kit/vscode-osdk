# OSDK - VS Code Extension

6502/XA assembly language support and interactive debugging for the [Oric](https://en.wikipedia.org/wiki/Oric) home computer, using the [OSDK](https://osdk.org) toolchain and the [Oricutron](https://github.com/pete-gordon/oricutron) emulator.

## Requirements

- **OSDK** (Oric Software Development Kit) - version TBD or later
- **Oricutron** with GDB stub support - version TBD or later (must include the `--gdb_port` command-line option)
- **VS Code** 1.64.0 or later

No additional dependencies are required. The extension is pure JavaScript and uses only Node.js built-in modules.

---

## Features

### Syntax Highlighting

- 6502 and XA assembly language syntax highlighting for `.asm` and `.s` files
- TextMate grammar with support for mnemonics, directives, labels, numbers, strings, and comments

### Debug Adapter

Connects VS Code to Oricutron's GDB Remote Serial Protocol (RSP) stub over TCP.

- **Launch** mode: build your project (with staleness check), launch Oricutron, and attach automatically
- **Attach** mode: connect to an already-running Oricutron instance
- **Step** (F10/F11), **Continue** (F5), **Pause** (F6)
- **Instruction breakpoints** via the Breakpoints panel
- **Function breakpoints** using symbol names
- **Call stack** walking (reconstructed from the hardware stack)
- **Disassembly view** with symbol resolution in operands
- **Virtual disassembly source**: when no source mapping exists, the extension generates a disassembly document centered on the current PC

---

## Debug Panels

Three dedicated panels appear in the Debug sidebar when a session is active:

| Panel | Description |
|---|---|
| **Oric Registers** | CPU registers (A, X, Y, SP, PC), processor flags (N, V, B, D, I, Z, C), last PC, cycle counter, frame count, raster line, and interrupt vectors (NMI, RST, IRQ) |
| **Oric Zero Page** | Zero page variables ($00-$FF) with symbol names from the symbol file |
| **Oric Peripherals** | Live state of the VIA 6522, AY-3-8912 (PSG), WD1793 floppy disk controller, Microdisc interface, and ACIA 6551 serial controller |

---

## Webview Panels

### Memory View

Expression-based memory viewer supporting hex, words, decimal, and binary display formats.

Open via command palette: **Oric: Memory View**

### Memory Heatmap

Real-time visualization of memory access patterns across the Oric's 64KB address space.

Open via command palette: **Oric: Memory Heatmap**

- **Color mapping**: Red = CPU writes, Green = CPU reads, Blue = ULA video fetches. Overlapping accesses blend additively (yellow = read+write, cyan = read+ULA, etc.)
- **Layout**: Four top strips (Zero Page, Stack, Page 2, I/O), main RAM ($0400-$BFFF), and ROM/RAM ($C000-$FFFF) with ROMDIS-aware labeling
- **Address crosshair**: Hovering over a symbol in the Symbol Browser or editor source code draws a crosshair on the heatmap at that address. The crosshair auto-follows the PC on each debug stop.
- **Hover tooltip**: Shows the hex address under the cursor
- **Auto-connect**: Connects to Oricutron's visualization stream on `gdb_port + 1`
- **Pause-aware**: Freezes the display when the emulator is paused; resumes when execution continues

### Screen View

Live Oric screen display rendered from Oricutron's 240x224 screen buffer.

Open via command palette: **Oric: Screen View**

- **Column grid** (6px) and **row grid** (8px) overlays with selectable colors
- **Pixel inspector**: hover to see address, byte value, bit position, and color info
- **Zoom**: configurable zoom factor (2x/4x/6x/8x/12x) and region size
- **Crosshair**: black-white-black crosshair on main view, pixel highlight in zoom
- **Screenshot**: save PNG to project `screenshots/` folder with timestamp
- **Clipboard**: copy screen to clipboard (Windows)
- All settings (grids, color, zoom) persisted across reloads

### Symbol Browser

Browsable list of all symbols (runtime symbols from symbol file + `#define` constants from source files).

Open via command palette: **Oric: Symbol Browser**

- **Alias merging**: symbols at the same address are merged into one row, with the master definition listed first
- **Columns**: Name, Address, Size, Value (live during debug), Group (ZP, BSS, Code, Data, Define)
- **Group filter**: dropdown to show only symbols of a specific group
- **Sorting**: click column headers to sort
- **Search**: filter symbols by name
- **Hover to highlight**: hovering a symbol row draws a crosshair on the Memory Heatmap
- **Click to navigate**: click any symbol name to jump to its source definition (requires V2 symbol file or `#define` in source)
- **Defines**: `#define` constants from `.s`, `.h`, and `.asm` files are included with their resolved values

### Reference Panels

- **OSDK: XA Quick Reference** - searchable XA assembler directive reference
- **OSDK: 6502 Opcode Reference** - searchable 6502 instruction set reference with cycle counts

---

## Inline Annotations

### Cycle Annotations

When stopped at a breakpoint, cycle count annotations appear inline next to source lines that map to executed instructions.

### Instruction Operand Annotations

On each debug stop, the current source line is annotated with the resolved operand values of the instruction about to execute. This shows the effective address and memory contents without needing to check registers manually.

Examples:
- `lda #$41` → `#$41 (65)`
- `sta $80` → `(tmp1=$80)=$3F`
- `sta ($50),Y` → `(*(ptr=$50)=$A398+Y:$02)=$A39A`
- `beq label` → `→$0450 [taken]` or `→$0450 [not taken]`

All 6502 addressing modes are supported: immediate, zero page, zp+X, zp+Y, absolute, abs+X, abs+Y, (indirect,X), (indirect),Y, indirect, and relative branches (with taken/not-taken status).

---

## Type Annotations (comment-based)

Add lightweight annotations inside ordinary comments to tell the debugger how to interpret a
value. They are pure comments — `//` in C (`.h`/`.c`), `;` in assembler (`.s`) — so they never
change the built program and every compiler/assembler ignores them. They work on **C globals, C
struct fields, and assembler data labels** (`.byt`/`.dsb`); the extension scans your headers and
sources for them at session start.

| Annotation | Shows | Example |
|---|---|---|
| `@bool` | `true` / `false` (0 = false, non-zero = true) | `unsigned char music_enabled; // @bool` |
| `@enum <E>` | the enumerator name for the value | `unsigned char layout; // @enum KeyboardLayout` |
| `@enum <E1>\|<E2>` | fallback chain for union holders: the first enum that defines the value wins | `_gWordBuffer .dsb 3 ; @enum word_id\|item_id` |
| `@bitset <E>` | the set bits decoded to a list of enum names | `_gAchievements .dsb 7 ; @bitset achievement` |
| `@ptr16` | the 16-bit pointer and what it currently points to | `sourcePtr = tmp0 ; @ptr16` |
| `@ptr16 <struct>` | typed pointer: expandable pointed-to struct; `(ptr),y` disassembly names the FIELD the Y offset hits and decodes it with the field's type | `_gStreamItemPtr .dsb 2 ; @ptr16 item` |
| `@bcd` / `@bcd-be` / `@bcd-le` | packed BCD decoded to a readable number | `current_score_bcd .dsb 2 ; @bcd-be` |
| `@str [term]` | terminated string at the symbol (terminator byte in decimal, default 0) | `_Text_Title ; @str 255` |
| `@strptr [term]` | 16-bit pointer to a terminated string | `textPtr .dsb 2 ; @strptr 255` |
| `@stream <E>` | a 16-bit pointer into a byte-code stream whose opcodes are enum `<E>`; expands to the next decoded commands with typed parameters | `_gCurrentStream .dsb 2 ; @stream script_command` |
| `@params <t>…` | on an enum MEMBER: the byte-stream parameters that opcode consumes (drives `@stream`) | `COMMAND_WAIT = 6, // @params byte` |

Notes:
- `@enum` / `@bitset` name a C `enum` type (the OSDK compiler emits enum info under `-g1`, and XA
  supports `enum {}` in shared C/asm headers). `@bitset` decodes bit *P* as byte `P>>3`, bit `1<<(P&7)`.
- `@bcd-be` (default, and the plain `@bcd` alias) = most-significant byte at the lowest address;
  `@bcd-le` = least-significant first. An explicit width may follow, e.g. `@bcd-be 3` for a 3-byte value.
- `@str` / `@strptr` take the terminator as a DECIMAL byte value (no implicit hex): plain
  NUL-terminated text needs no argument; attribute-laden text where 0 is a valid byte (ink codes)
  uses its end marker, e.g. `@str 255` for `TEXT_END`. Non-printable bytes render as dots.
  Plain `*char` / `char*` variables and struct fields show their NUL-terminated string automatically.
- An `@enum` on a CODE line (e.g. `lda (_gCurrentStream),y ; @enum item_id`) types the value the
  instruction fetches: the destination register gets tagged with it when single-stepping.
- An `@enum` on a multi-byte symbol (a `.dsb` buffer) decodes each byte separately:
  `gWordBuffer → [e_WORD_TAKE, e_ITEM_Meat, ...]`. Chains resolve per byte, so mixed
  word/item buffers show the right names as long as the enums' value ranges don't overlap.
- `@stream <E>` visualizes a byte-code stream: watching the pointer expands to the next
  commands, each shown as `COMMAND_NAME(param, param, …)` with parameters decoded by their
  `@params` types. Each `@params` token is an enum type name, `byte`, `word` (16-bit LE),
  `str` (inline NUL-terminated string), or `end` (a terminator/jump that stops the linear
  preview). A member with no `@params` (or an unknown opcode) stops the walk. `@params`
  comments must contain ONLY tokens and must match the byte layout the engine consumes,
  or the walk desyncs. Edit one and reparse (no rebuild) to see it live.
- Annotated values render consistently in the Watch/Variables views, the Symbol Browser, and inline
  in the disassembly — each shows the decoded value plus a short type token (e.g. `bool`, the enum
  name, `bcd-be`).

---

## Code Navigation

### Hover Information

Hover over a symbol name or `#define` constant in the editor to see:
- Address and size
- Current value (during debug)
- Aliases (other names at the same address)
- Source file and line where it's defined

Also works for hex addresses written as `$HHHH` in source code.

### Go to Definition

**Ctrl+Click** or **F12** on a symbol name or `#define` constant to jump to its definition in the source code.

Requires either a V2 symbol file (with source location info) or a `#define` directive in a workspace source file.

---

## Commands

All commands are available from the Command Palette (Ctrl+Shift+P):

| Command | Description | Available |
|---|---|---|
| **Oric: Memory View** | Open the expression-based memory viewer | Always |
| **Oric: Memory Heatmap** | Open the real-time memory access heatmap | Always |
| **Oric: Screen View** | Open the live Oric screen display | Always |
| **Oric: Symbol Browser** | Open the symbol/define browser panel | Always |
| **Oric: Skip Instruction** | Advance PC past the current instruction without executing it | Debug (stopped) |
| **Oric: Toggle Warp Speed** | Toggle Oricutron's warp mode (run at maximum speed) | Debug |
| **Oric: Reset Cycle Counter** | Reset the CPU cycle counter to zero | Debug (stopped) |
| **Oric: Show Current Location** | Navigate the editor to the current PC location | Debug (stopped) |
| **OSDK: XA Quick Reference** | Open the XA assembler directive reference | Always |
| **OSDK: 6502 Opcode Reference** | Open the 6502 instruction set reference | Always |

---

## Keyboard Shortcuts

| Shortcut | Command | When |
|---|---|---|
| **Ctrl+Shift+F12** | Skip Instruction | Debug stopped |
| **Ctrl+Shift+F6** | Toggle Warp Speed | Debug active |
| **Ctrl+Shift+F9** | Reset Cycle Counter | Debug stopped |
| **Ctrl+Alt+Home** | Show Current Location | Debug stopped |

Standard VS Code debug shortcuts also apply:

| Shortcut | Action |
|---|---|
| **F5** | Start/Continue |
| **Shift+F5** | Stop |
| **F10** | Step Over |
| **F11** | Step Into |
| **Shift+F11** | Step Out |
| **F9** | Toggle Breakpoint |
| **F12** | Go to Definition (on symbol) |
| **Ctrl+Click** | Go to Definition (on symbol) |

---

## Debug Toolbar Buttons

When a debug session is active, four extra buttons appear in the debug toolbar:

| Icon | Action |
|---|---|
| Step Over icon | **Skip Instruction** - advance PC without executing |
| Rocket icon | **Toggle Warp Speed** - run at maximum speed |
| History icon | **Reset Cycle Counter** - zero the cycle counter |
| Stackframe icon | **Show Current Location** - navigate to current PC |

---

## Debug Console Commands

Type these commands in the VS Code Debug Console during a debug session:

| Command | Description | Example |
|---|---|---|
| `A`, `X`, `Y`, `SP`, `PC` | Read a CPU register | `A` |
| `REG=value` | Write a register (decimal or `$hex`) | `A=$41`, `X=0` |
| `x $ADDR [LEN]` | Read memory (default 16 bytes) | `x $0400 32` |
| `w $ADDR $VAL` | Write a byte to memory | `w $BB80 $41` |
| `goto $ADDR` | Set PC to address (refused below $0400) | `goto $0500` |
| `goto symbol` | Set PC to symbol address | `goto _main` |
| `skip` | Skip current instruction (advance PC) | `skip` |
| `sym NAME` | Look up a symbol address | `sym _irq_handler` |
| `symbolName` | Look up a symbol by typing its name | `_main` |
| `hex` / `dec` | Set the number base for console output | `hex` |
| `loglevel [0\|1\|2]` | Show or set log verbosity (Errors/Normal/Verbose) | `loglevel 1` |
| `profile [on\|off]` | Per-request timing + gdb read counts in the log (find slow stops) | `profile on` |
| `! <cmd>` | Run a raw Oricutron monitor command | `! = tmp0+2` |
| `help` (or `?`) | Show the full command reference | `help` |

The status bar (bottom left, during a session) shows the active **Module** and the
current **Log** level. Click either one to change it — the log-level picker is the
quickest way to silence verbose GDB/DAP tracing without editing `launch.json`.

---

## Setting Up OSDK for Full Debugging

For the extension to give you C-source stepping, typed variables, and inspectable locals, the
OSDK build must emit debug info and an enriched symbol file. Configure this once in your
project's `osdk_config.bat` / build scripts.

### Compiler settings — `OSDKCOMP=-O1 -g1`

```bat
SET OSDKCOMP=-O1 -g1
```

- **`-g1`** makes the C compiler emit source-line info, struct/type records (`#TYPES`), and
  local/parameter names — the basis for source breakpoints, typed globals, and the Locals scope.
- **`-O1` (not `-O2`)** is required to inspect function **body locals**. At `-O2` the compiler
  register-allocates body locals off the stack, so they have no address the debugger can read
  (parameters still show at `-O2`, but in-function locals do not). Use `-O1` for full local
  visibility.

### Symbol file — build with `xa -S build\symbols_ext`

The assembler must produce the **V2** symbol file (see *Symbol File Format* below): `#SYM V2` +
`#FILES` + `#LINES` + `#TYPES`. Have your build run `xa -S build\symbols_ext` and point
`symbolFile` at `build/symbols_ext`. Assembler code always maps to real source; C code needs the
`-g1` above. (Without a V2 file you still get address/label-level debugging, just not C-source
stepping or typed locals.)

### Recommended launch config — `launchScript` (the OSDK way)

Rather than hand-wiring the emulator path and a fixed port, let the extension run your project's
`osdk_execute.bat`; it auto-picks a free gdb port, injects it via the environment, and halts at
the program entry (`OSDKADDR`) so timing is race-free:

```json
{
    "type": "oric-debug",
    "request": "launch",
    "name": "Build & Debug (Oric)",
    "launchScript": "osdk_execute.bat",
    "cwd": "${workspaceFolder}",
    "symbolFile": "${workspaceFolder}/build/symbols_ext",
    "stopOnEntry": false,
    "build": {
        "command": "osdk_build.bat",
        "cwd": "${workspaceFolder}",
        "output": "${workspaceFolder}/build/YOURGAME.tap",
        "sources": ["${workspaceFolder}/main.c", "${workspaceFolder}/code"]
    }
}
```

(The `emulatorPath` + `diskImage` style shown under *Setup* below still works and is fine for
attach or non-OSDK setups.)

To give the debugger richer type information about individual values, use the comment-based
**[Type Annotations](#type-annotations-comment-based)** described above.

---

## Setup

### 1. Install the Extension

Copy the extension folder to your VS Code extensions directory:

- **Windows**: `%USERPROFILE%\.vscode\extensions\osdk-debug\`
- **macOS/Linux**: `~/.vscode/extensions/osdk-debug/`

Reload VS Code after copying.

### 2. Configure launch.json

Add a debug configuration to your project's `.vscode/launch.json`. The extension provides two configuration snippets accessible via the "Add Configuration" button.

#### Launch Mode (Build & Debug)

Builds your project if sources are newer than the output, launches Oricutron, and attaches the debugger:

```json
{
    "type": "oric-debug",
    "request": "launch",
    "name": "Build & Debug",
    "emulatorPath": "${env:OSDK}/Oricutron/Oricutron.exe",
    "diskImage": "${workspaceFolder}/build/program.dsk",
    "port": 6502,
    "symbolFile": "${workspaceFolder}/build/symbols",
    "stopOnAttach": true,
    "build": {
        "command": "osdk_build.bat",
        "cwd": "${workspaceFolder}",
        "output": "${workspaceFolder}/build/program.dsk",
        "sources": ["${workspaceFolder}/code"]
    }
}
```

#### Attach Mode

Connect to an already-running Oricutron instance:

```json
{
    "type": "oric-debug",
    "request": "attach",
    "name": "Attach to Oricutron",
    "host": "localhost",
    "port": 6502,
    "symbolFile": "${workspaceFolder}/build/symbols",
    "stopOnAttach": true
}
```

### 3. Launch Oricutron with GDB Support

Start Oricutron with the `--gdb_port` option:

```
Oricutron program.dsk --gdb_port 6502
```

Or configure your OSDK project to pass the flag automatically via `osdk_config.bat`:

```bat
SET OSDKGDBPORT=6502
IF NOT "%OSDKGDBPORT%"=="" SET OSDKEMULPARAMS=%OSDKEMULPARAMS% --gdb_port %OSDKGDBPORT%
```

In Launch mode, the extension handles starting Oricutron for you.

### 4. Start Debugging

Press **F5** in VS Code to start the debug session.

---

## Configuration Reference

### Attach Configuration

| Property | Type | Default | Description |
|---|---|---|---|
| `host` | string | `"localhost"` | Hostname of the Oricutron GDB stub |
| `port` | number | `6502` | TCP port of the Oricutron GDB stub |
| `symbolFile` | string | | Path to symbol file |
| `stopOnAttach` | boolean | `true` | Break execution when the debugger attaches |
| `logLevel` | number | `1` | Debug log verbosity: 0=errors only, 1=normal, 2=verbose |

### Launch Configuration

All attach properties above, plus:

| Property | Type | Default | Description |
|---|---|---|---|
| `emulatorPath` | string | *required* | Path to the Oricutron executable |
| `emulatorArgs` | string[] | `[]` | Additional command-line arguments for Oricutron |
| `diskImage` | string | *required* | Disk image to load (`.dsk` or `.tap`) |
| `emulatorCwd` | string | | Working directory for Oricutron (defaults to the emulator's directory) |
| `build.command` | string | | Build command (e.g. `osdk_build.bat`) |
| `build.cwd` | string | | Working directory for the build command |
| `build.output` | string | | Build output file to check for staleness |
| `build.sources` | string[] | | Source directories/files to check for staleness |

---

## Symbol File Format

The extension supports two symbol file formats.

### V1 (Basic)

One symbol per line: 4-digit hex address followed by a space and the symbol name.

```
0400 _main
0450 _irq_handler
00F0 ptr_screen
```

### V2 (With Source Locations)

Starts with a `#SYM V2` header. Each symbol line includes the source file and line number after the name:

```
#SYM V2
0400 _main main.s:10
0450 _irq_handler irq.s:25
00F0 ptr_screen vars.s:3
#FILES
main.s
irq.s
vars.s
#LINES
main.s 10 0400
main.s 11 0403
...
```

V2 symbol files enable **Go to Definition** (Ctrl+Click / F12) and source location display in hover tooltips and the Symbol Browser.

The OSDK toolchain generates symbol files during the build process.

---

## Architecture

```
+-------------+     stdin/stdout (DAP)      +-----------------+
|   VS Code   | <-------------------------> | debug_adapter.js|
|  Debug UI   |                             |                 |
+------+------+                             |  TCP (GDB RSP)  |
       |                                    +--------+--------+
       |  extension.js                               |
       |  TCP (binary frames, port+1)       +--------v--------+
       +------------------------------+--> |    Oricutron    |
              viz_stream               |    |  GDB stub :6502 |
                                       +--> |  VIZ stream:6503|
                                            +-----------------+
```

- **debug_adapter.js**: Pure JavaScript DAP process. Communicates with VS Code via stdin/stdout and with Oricutron via the GDB Remote Serial Protocol over TCP.
- **extension.js**: VS Code extension host. Manages webview panels, providers, decorations, and the visualization stream connection.
- **viz_stream**: Separate TCP connection on `gdb_port + 1` carrying binary frames (~192KB at ~16fps) with per-address heat values (reads, writes, ULA fetches) and a 240x224 screen buffer.

No npm dependencies are required.

---

## License

TBD
