# OSDK - VS Code Extension

6502/XA assembly language support and interactive debugging for the [Oric](https://en.wikipedia.org/wiki/Oric) home computer, using the [OSDK](https://osdk.org) toolchain and the [Oricutron](https://github.com/pete-gordon/oricutron) emulator.

## Requirements

- **OSDK** (Oric Software Development Kit) - version TBD or later
- **Oricutron** with GDB stub support - version TBD or later (must include the `--gdb_port` command-line option)
- **VS Code** 1.64.0 or later

No additional dependencies are required. The extension is pure JavaScript and uses only Node.js built-in modules.

## Features

### Syntax Highlighting

- 6502 and XA assembly language syntax highlighting for `.asm` and `.s` files
- TextMate grammar with support for mnemonics, directives, labels, numbers, strings, and comments

### Debug Adapter

Connects VS Code to Oricutron's GDB Remote Serial Protocol (RSP) stub over TCP. Supports:

- **Attach** to a running Oricutron instance
- **Step** (F10/F11), **Continue** (F5), **Pause** (F6)
- **Instruction breakpoints** via the Breakpoints panel
- **Function breakpoints** using symbol names
- **Call stack** walking (reconstructed from the hardware stack)
- **Disassembly view** with symbol resolution in operands

### Debug Panels

Three dedicated panels appear in the Debug sidebar:

- **Oric Registers** - CPU registers (A, X, Y, SP, PC), processor flags (N, V, B, D, I, Z, C), last PC, cycle counter, frame count, raster line, and interrupt vectors (NMI, RST, IRQ)
- **Oric Zero Page** - Zero page variables with symbol names (from the symbol file)
- **Oric Peripherals** - Live state of the VIA 6522, AY-3-8912 sound chip, WD1793 floppy disk controller, Microdisc interface, and ACIA 6551 serial controller

### Debug Console Commands

| Command | Description |
|---|---|
| `A`, `X`, `Y`, `SP`, `PC` | Read a CPU register |
| `A=65`, `A=$41` | Write a register (decimal or $hex) |
| `x $ADDR [LEN]` | Read memory (default 16 bytes) |
| `w $ADDR $VAL` | Write a byte to memory |
| `goto $ADDR` | Set PC to address |
| `goto symbol` | Set PC to symbol address |
| `skip` | Skip current instruction (advance PC without executing) |
| `sym NAME` | Look up a symbol address |
| `symbolName` | Look up a symbol by typing its name directly |

## Setup

### 1. Install the extension

Copy the extension folder to your VS Code extensions directory:

- **Windows**: `%USERPROFILE%\.vscode\extensions\osdk-debug\`
- **macOS/Linux**: `~/.vscode/extensions/osdk-debug/`

### 2. Configure your project

Add a `launch.json` to your project's `.vscode` folder:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "oric-debug",
            "request": "attach",
            "name": "Attach to Oricutron",
            "host": "localhost",
            "port": 6502,
            "symbolFile": "${workspaceFolder}/build/symbols",
            "stopOnAttach": true
        }
    ]
}
```

### 3. Launch Oricutron with GDB support

Start Oricutron with the `--gdb_port` option:

```
Oricutron program.tap --gdb_port 6502
```

Or configure your OSDK build to pass the flag automatically (e.g., via `osdk_config.bat`):

```bat
IF NOT "%OSDKGDBPORT%"=="" SET OSDKEMULPARAMS=%OSDKEMULPARAMS% --gdb_port %OSDKGDBPORT%
```

### 4. Attach the debugger

Press **F5** in VS Code to attach to the running Oricutron instance.

## Configuration

| Property | Type | Default | Description |
|---|---|---|---|
| `host` | string | `"localhost"` | Hostname of the Oricutron GDB stub |
| `port` | number | `6502` | TCP port of the Oricutron GDB stub |
| `symbolFile` | string | | Path to symbol file (`HHHH symbol_name` per line) |
| `stopOnAttach` | boolean | `true` | Break execution when the debugger attaches |

## Symbol File Format

The symbol file is a plain text file with one symbol per line:

```
0400 _main
0450 _irq_handler
00f0 ptr_screen
```

Each line contains a 4-digit hex address followed by a space and the symbol name. The OSDK toolchain generates these files during the build process.

## Architecture

```
+-------------+     stdin/stdout (DAP)      +-----------------+
|   VS Code   | <-------------------------> | debug_adapter.js|
|  Debug UI   |                             |                 |
+-------------+                             |  TCP (GDB RSP)  |
                                            +--------+--------+
                                                     |
                                            +--------v--------+
                                            |    Oricutron    |
                                            |    GDB stub     |
                                            |    port 6502    |
                                            +-----------------+
```

The debug adapter is a pure JavaScript process that communicates with VS Code via the Debug Adapter Protocol (DAP) over stdin/stdout, and with Oricutron via the GDB Remote Serial Protocol over TCP. No npm dependencies are required.

## License

TBD
