# Reference

Commands, shortcuts, settings, launch-configuration keys, the symbol-file format and
the internal architecture.

---

## Commands

All commands are available from the Command Palette (Ctrl+Shift+P):

| Command | Description | Available |
|---|---|---|
| **Oric: Memory View** | Open the expression-based memory viewer | Always |
| **Oric: Memory Heatmap** | Open the real-time memory access heatmap | Always |
| **Oric: Screen View** | Open the live Oric screen display | Always |
| **Oric: Symbol Browser** | Open the symbol/define browser + watch panel | Always |
| **Oric: Memory Map** | Open the built-in memory map (Normal/Overlay/Zero tabs) | Always |
| **Oric: Disassembly View** | Open the disassembly panel (with per-line run/turbo/jump/skip actions) | Always |
| **Oric: Reparse Annotations (no rebuild)** | Re-read `@…` comment annotations from source into the live session (also runs automatically on save) | Debug |
| **Oric: Reload Symbols (after byte-identical rebuild)** | Re-read the symbol file in place after a rebuild that left the binary unchanged — new enum members/types/symbols without relaunching | Debug |
| **Oric: Toggle Binary Column in Values** | Show/hide the `%binary` part of decoded values (also the `oric-debug.showBinary` setting) | Always |
| **Oric: Copy Line + Annotation** | Copy the source line plus its inline decoded annotation (gutter right-click, or the palette) | Debug (stopped) |
| **Oric: Copy Instruction Annotation** | Copy just the decoded annotation for the current instruction (without the source line) | Debug (stopped) |
| **Oric: Active Module** | Pick the active overlay module (multi-module projects) | Debug |
| **Oric: Toggle Step Granularity (Statement / Instruction)** | Switch stepping between C statement and instruction | Debug |
| **Oric: Debug Log Level** | Set log verbosity (Errors / Normal / Verbose) | Always |
| **Oric: Skip Instruction** | Advance PC past the current instruction without executing it | Debug (stopped) |
| **Oric: Toggle Warp Speed** | Toggle Oricutron's warp mode (run at maximum speed) | Debug |
| **Oric: Reset Cycle Counter** | Reset the CPU cycle counter to zero | Debug (stopped) |
| **Oric: Show Current Location** | Navigate the editor to the current PC location | Debug (stopped) |
| **Oric: Turbo Run to Cursor** | Fast-forward at warp speed to the cursor's line (also on the debug toolbar) | Debug (stopped) |
| **Oric: Save Snapshot** / **Restore Snapshot** | Save / restore full machine state (see [Snapshots](debugging.md#snapshots)) | Debug |
| **Oric: Restart to Most Recent Snapshot** | Jump back to the latest restore point | Debug |
| **Oric: Delete Snapshot** / **Refresh Snapshots** | Manage the snapshot list | Debug |
| **Oric: Open Snapshots Folder** | Reveal the project's `.oric-snapshots/` folder in the OS file manager | Always |
| **Oric: Run Automation Script…** / **Stop Automation Script** | Run / stop a `automation/*.js` script against the live session | Debug |
| **Oric: Open Automation Folder** | Reveal the project's `automation/` folder in the OS file manager | Always |
| **Oric: Register MCP Server (for Claude)…** | Write/merge `.mcp.json` and validate the MCP server | Always |
| **Oric: AI Collaboration — Start/Stop Bridge** | Share the live session with an MCP assistant (see [Collaborative mode](mcp.md#collaborative-mode--how-to-use-it)) | Debug |
| **Oric: Take Debug Control (from AI)** | Reclaim execution control while an assistant is piloting | Debug |
| **Oric: Add Watchpoint…** | Add a (conditional) data breakpoint on an address | Debug |
| **Oric: Enable/Disable Warp Speed** | Turn warp on/off explicitly (vs. the toggle) | Debug |
| **Oric: XA Quick Reference** | Open the XA assembler directive reference | Always |
| **Oric: 6502 Opcode Reference** | Open the 6502 instruction set reference | Always |

The line-number **gutter right-click** menu (while stopped) also offers **Run to This Line**, **Turbo Run to This Line**, **Jump to This Line** / **Skip This Line** (contextual — skip only on the PC line), and **Copy Line + Annotation**.

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
| **Shift+F10** | Replay Rewind (load previous snapshot) |
| **Shift+F12** | Replay Forward (load next snapshot) |
| **F9** | Toggle Breakpoint |
| **F12** | Go to Definition (on symbol) |
| **Ctrl+Click** | Go to Definition (on symbol) |

---

## Debug Toolbar Buttons

When a debug session is active, extra Oric-specific buttons appear in the debug toolbar. Most act on the stopped session; **Warp Speed** toggles at any time:

| Action | Description |
|---|---|
| **Replay Rewind** | Load the previous history snapshot (step back in time) |
| **Replay Forward** | Load the next snapshot |
| **Replay to Head** | Jump to the most recent snapshot |
| **Skip Instruction** | Advance PC without executing the current instruction |
| **Warp Speed** (on/off) | Toggle running at maximum speed (a single button that flips between enable/disable) |
| **Reset Cycle Counter** | Zero the cycle counter |
| **Show Current Location** | Navigate the editor to the current PC |
| **Turbo Run to Cursor** | Fast-forward at warp speed to the cursor's line |

---

## Debug Console Commands

Type these commands in the VS Code Debug Console during a debug session:

| Command | Description | Example |
|---|---|---|
| `A`, `X`, `Y`, `SP`, `PC` | Read a CPU register | `A` |
| `REG=value` | Write a register (decimal or `$hex`) | `A=$41`, `X=0` |
| `x $ADDR [LEN]` | Read memory ($ = hex, no $ = decimal; default 16 bytes) | `x $0400 32` |
| `m ADDR,LEN` | Read memory, GDB-style (addr and len always hex) | `m 0400,20` |
| `w $ADDR $VAL` | Write a byte to memory ($ = hex, no $ = decimal) | `w $BB80 $41` |
| `goto $ADDR` | Set PC to address (refused below $0400) | `goto $0500` |
| `goto symbol` | Set PC to symbol address | `goto _main` |
| `skip` | Skip current instruction (advance PC) | `skip` |
| `sym NAME` | Look up a symbol address | `sym _irq_handler` |
| `symbolName` | Look up a symbol by typing its name | `_main` |
| `(TYPE)EXPR` | View EXPR as TYPE — a cast: `(uchar*)tmp0`, `(int)$C000`, `(item_id)a` | `(location_id)a` |
| `tag a ENUM` / `untag [a\|x\|y]` | Manually type a register with an enum / clear tag(s) | `tag a item_id` |
| `hex` / `dec` | Set the number base for console output | `hex` |
| `bin [on\|off]` | Show/hide the `%binary` column in decoded values | `bin off` |
| `reparse` | Re-read `@…` annotations from source (no rebuild) | `reparse` |
| `reloadsymbols [force]` | Re-read the symbol file after a byte-identical rebuild (no relaunch) | `reloadsymbols` |
| `loglevel [0\|1\|2]` | Show or set log verbosity (Errors/Normal/Verbose) | `loglevel 1` |
| `profile [on\|off]` | Per-request timing + gdb read counts in the log (find slow stops) | `profile on` |
| `! <cmd>` | Run a raw Oricutron monitor command | `! = tmp0+2` |
| `help` (or `?`) | Show the full command reference | `help` |

The status bar (bottom left, during a session) shows the active **Module** and the
current **Log** level. Click either one to change it — the log-level picker is the
quickest way to silence verbose GDB/DAP tracing without editing `launch.json`.

---

## Settings

VS Code settings (User or Workspace) under **Oric Debug**:

| Setting | Type | Default | Description |
|---|---|---|---|
| `oric-debug.showBinary` | boolean | `true` | Show the `%binary` column in decoded values (`$02\|2\|%00000010`). Turn off for a compact `$02\|2`. Applies live to a running session; also toggleable via **Oric: Toggle Binary Column in Values** or the `bin` console command. |
| `oric-debug.breakpointsFollowActiveModule` | boolean | `true` | In the **Oric Breakpoints** panel, expand the active overlay module's section and collapse the others as the active module changes (multi-module/overlay projects). The active module is always highlighted regardless of this setting. |
| `oric-debug.colorSourceFilesByType` | boolean | `true` | Tint file-name labels (editor tabs and Explorer) by type: C source `.c` green, headers `.h` teal, assembler `.s`/`.asm` blue, automation scripts `.js` violet. The colors are the `oric.*` theme colors below — override them in `workbench.colorCustomizations`. |
| `oric-debug.wrapPanelRows` | boolean | `false` | Wrap long rows in the **Debug Dashboard** panel instead of clipping them. Wrapping shows the whole value (long paths, wide arrays) at the cost of vertical space; clipping keeps the panel compact while stepping. Toggle it from that panel's title bar (**Oric: Wrap Long Rows In Panel** / **Stop Wrapping…**). |

File-label tint colors (contributed theme colors, overridable in `workbench.colorCustomizations`):

| Color id | Applies to |
|---|---|
| `oric.cFileColor` | C source files (`.c`) |
| `oric.headerFileColor` | Header files (`.h`) |
| `oric.asmFileColor` | Assembler files (`.s`/`.asm`) |
| `oric.scriptFileColor` | Automation scripts (`.js`) |

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
| `launchScript` | string | | An OSDK launch script (e.g. `osdk_debug.bat`) that builds and starts the emulator with the GDB stub — the recommended "OSDK way", and an alternative to `emulatorPath` + `diskImage`. |
| `emulatorPath` | string | *required¹* | Path to the Oricutron executable |
| `emulatorArgs` | string[] | `[]` | Additional command-line arguments for Oricutron |
| `diskImage` | string | *required¹* | Disk image to load (`.dsk` or `.tap`) |
| `emulatorCwd` | string | | Working directory for Oricutron (defaults to the emulator's directory) |
| `cwd` | string | | Working directory for `launchScript` / build (defaults to `build.cwd`, then the process cwd) |
| `stopOnEntry` | boolean | | Break at the program entry point on launch |
| `turboRunTo` | string | | Symbol to warp (max-speed) fast-forward to on launch (e.g. a game or module entry label) |
| `build.command` | string | | Build command (e.g. `osdk_build.bat`) |
| `build.cwd` | string | | Working directory for the build command |
| `build.output` | string | | Build output file to check for staleness |
| `build.sources` | string[] | | Source directories/files to check for staleness |

¹ Required unless `launchScript` is set (which supplies its own emulator invocation).

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

[← Documentation index](README.md) · [Extension README](../README.md)
