# OSDK — Oric development & debugging for VS Code

The [OSDK](https://osdk.org) lets you write [Oric](https://en.wikipedia.org/wiki/Oric_%28computer%29)
software on your PC, in C and assembly.

![VS Code debugging an Oric game: Debug Dashboard, breakpoints and snapshots in the sidebar, C source with inline cycle counts, the live Oric screen, disassembly and memory views](images/screenshots/debugging-overview.jpg)

This extension complements the OSDK with quality-of-life features that make Oric development more
comfortable:

- Syntax colouring of XA source code
- Built-in references for the 6502 and XA instruction sets
- Source-level debugging for C and assembly
- Annotation support for rich assembly debugging
- Time-travel debugging with snapshots and reverse trace
- Visual inspection of the screen output and memory regions
- Test automation
- MCP support for AI system interaction

Debugging runs your program in [Oricutron](https://github.com/pete-gordon/oricutron), which the
extension drives over the emulator's GDB stub.

## Requirements

- **OSDK 2.0 or later**, with the `OSDK` environment variable pointing at it
- **Oricutron** with GDB-stub support — included in OSDK 2.0
- **VS Code** 1.74 or later

No other dependencies: the extension is pure JavaScript on Node's built-in modules.

## Get started

1. Install the extension, then open your OSDK project.
2. Run **Oric: Set Up Project for Debugging** from the Command Palette — it writes the `.vscode/`
   files an existing OSDK project doesn't have.
3. Press **F5**.

Run **Oric: Getting Started** for a live checklist that verifies your OSDK, its version, the
emulator and the project, with a status per step.

→ **[Getting started guide](docs/getting-started.md)** for the full walkthrough, including the
compiler flags (`OSDKDEBUG=-g1`, `OSDKCOMP=-O1`) that C-level debugging needs.

## Documentation

| | |
|---|---|
| **[Getting started](docs/getting-started.md)** | Install, project setup, `launch.json`, first step |
| **[Feature tour](docs/features.md)** | Everything it does, area by area |
| **[Panels](docs/panels.md)** | Every view and panel, and how to read them |
| **[Debugging](docs/debugging.md)** | Time-travel, snapshots, editing while running |
| **[Annotations & navigation](docs/annotations.md)** | `@…` type annotations, hover, go-to-definition |
| **[Automation scripting](docs/automation.md)** | Drive a session from JavaScript |
| **[AI-driven debugging](docs/mcp.md)** | MCP server and the collaborative bridge |
| **[Reference](docs/reference.md)** | Commands, shortcuts, settings, symbol format |
| **[Troubleshooting](TROUBLESHOOTING.md)** | When it doesn't work |

All of it is reachable in-editor from the **Oric Documentation** panel.

## License

MIT — see [LICENSE](LICENSE).
