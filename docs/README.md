# OSDK extension — documentation

Full documentation for the [OSDK VS Code extension](../README.md). Start with **Getting started**;
the rest is reference you can dip into.

| Page | What's in it |
|---|---|
| **[Getting started](getting-started.md)** | Install the OSDK and the extension, set up a project, configure `launch.json`, and take your first step. Also the compiler flags (`OSDKDEBUG=-g1`, `OSDKCOMP=-O1`) and symbol file needed for C-level debugging. |
| **[Feature tour](features.md)** | Everything the extension does, grouped by area — the long version of the README's summary. |
| **[Panels](panels.md)** | Every sidebar view and dockable panel: the **Debug Dashboard**, Breakpoints, Snapshots & Automation, Peripherals, plus the Symbol Browser, Memory, Screen View, Heatmap, Memory Map and Disassembly. |
| **[Debugging](debugging.md)** | Time-travel / reverse stepping, snapshots, and editing code while a session is live. |
| **[Annotations & navigation](annotations.md)** | The `@…` comment annotations that drive typed decoding, inline cycle and operand annotations, hover, and go-to-definition. |
| **[Automation scripting](automation.md)** | Driving a live session from JavaScript — the `automation/*.js` scripts and the `t` API. |
| **[AI-driven debugging (MCP)](mcp.md)** | Exposing the session over the Model Context Protocol, the tool list, modes, and the collaborative bridge. |
| **[Reference](reference.md)** | Commands, keyboard shortcuts, toolbar buttons, Debug Console commands, settings, launch-configuration keys, the symbol-file format, and the architecture. |

## Also in the repository

| File | What's in it |
|---|---|
| [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) | Install/configure steps and fixes for common problems. Reachable in-editor from the **Oric Documentation** panel. |
| [CHANGELOG.md](../CHANGELOG.md) | Release history. |
| [CORE-CONCEPTS.md](../CORE-CONCEPTS.md) | The engineering principles the codebase holds itself to (one render path, module-independent enum resolution, fail-loud, staleness self-check) — useful if you intend to modify the extension. |

## In-editor help

The **Oric Documentation** panel in the Run & Debug sidebar reaches all of this without leaving VS
Code, plus two things this manual cannot do:

- **Oric: Getting Started** — a live checklist that actually verifies `%OSDK%`, its version, the
  emulator and the current project, with green/red status per step.
- **Oric: Set Up Project for Debugging** — writes the `.vscode/` files an existing OSDK project
  lacks.
