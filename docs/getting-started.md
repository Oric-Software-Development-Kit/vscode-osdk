# Getting started

Install the extension, point it at a project, and take your first step. If something
does not work, see [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) — or run
**Oric: Getting Started** from the Command Palette for a live checklist that verifies
`%OSDK%`, its version, the emulator and the project.

---

## Setup

### 0. Install the OSDK

The extension drives the [OSDK](https://osdk.org) toolchain, so install that first and make sure the
`OSDK` environment variable points at it — **version 2.0 or later**. The extension checks this at
startup and reports it if the OSDK is missing or too old.

> Setting `OSDK` requires a **full VS Code restart**, not just *Reload Window* — a reload keeps the
> old environment.

### 1. Install the extension

From VS Code: open **Extensions** (`Ctrl+Shift+X`), search for **OSDK**, and install the one
published by *Defence Force*. Nothing else is needed — the extension is pure JavaScript and uses
only Node built-ins.

<details>
<summary>Installing from source instead (for development, or an unreleased build)</summary>

Copy or clone the extension folder into your VS Code extensions directory, then restart VS Code:

- **Windows**: `%USERPROFILE%\.vscode\extensions\osdk-debug\`
- **macOS/Linux**: `~/.vscode/extensions/osdk-debug/`

</details>

### 2. Set up the project

Open your OSDK project folder and run **Oric: Set Up Project for Debugging** from the Command
Palette (it is also a button in the **Oric Documentation** panel). It writes the `.vscode/`
`launch.json`, `tasks.json` and `settings.json` an existing OSDK project does not have.

Prefer to do it by hand, or need to understand the keys? The rest of this section explains them.

### 3. Configure launch.json

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

### 4. Launch Oricutron with GDB Support

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

### 5. Start Debugging

Press **F5** in VS Code to start the debug session.

---

## Setting Up OSDK for Full Debugging

For the extension to give you C-source stepping, typed variables, and inspectable locals, the
OSDK build must emit debug info and an enriched symbol file. Configure this once in your
project's `osdk_config.bat` / build scripts.

### Compiler settings — `OSDKDEBUG=-g1` + `OSDKCOMP=-O1`

```bat
SET OSDKDEBUG=-g1
SET OSDKCOMP=-O1
```

- **`-g1`** makes the C compiler emit source-line info, struct/type records (`#TYPES`), and
  local/parameter names — the basis for source breakpoints, typed globals, and the Locals scope.
  It is **new in OSDK 2.0** and lives in its own **`OSDKDEBUG`** variable, so a project that sets
  its own optimization flags cannot silently drop the debug info. Put it there, not in `OSDKCOMP`.
- **`-O1` (not `-O2`)** is required to inspect function **body locals**. At `-O2` the compiler
  register-allocates body locals off the stack, so they have no address the debugger can read
  (parameters still show at `-O2`, but in-function locals do not). Use `-O1` for full local
  visibility.

### Symbol file — build with `xa -S build\symbols_ext`

The assembler must produce the **V2** symbol file (see [Symbol File Format](reference.md#symbol-file-format)): `#SYM V2` +
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

(The `emulatorPath` + `diskImage` style shown under *Configure launch.json* above still works and is fine for
attach or non-OSDK setups.)

To give the debugger richer type information about individual values, use the comment-based
**[type annotations](annotations.md#type-annotations-comment-based)**.

---

[← Documentation index](README.md) · [Extension README](../README.md)
