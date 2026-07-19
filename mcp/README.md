# oric-mcp-server

An **MCP server** that lets an AI assistant debug Oric code by driving the existing
`osdk-debug` debug adapter — instead of hand-piloting raw GDB RSP (which LLMs are bad at,
because it's a low-level wire protocol with no symbols, no source, and no high-level ops).

It's **Approach A**: a thin, LLM-friendly façade that
- spawns `../debug_adapter.js` and speaks **DAP** to it (all the symbol/source-aware
  stepping, breakpoints, conditions, evaluate, registers, stack the adapter already does), and
- connects to the **viz_stream** socket directly (gdb port + 1) for the two things the
  adapter doesn't expose: **sight** (`oric_screenshot` → PNG of the 240×224 screen) and
  **input** (`oric_send_keys` → keyboard injection via the AY matrix).

Self-contained: pure Node, **no npm dependencies** (MCP JSON-RPC, DAP framing, viz parsing
and a minimal PNG encoder are all inline).

## Requirements

- Node.js (same one that runs the extension).
- This file lives in `osdk-debug/mcp/`; it expects `../debug_adapter.js` next to it.
- A built (or buildable) OSDK/Oric project with a symbol file — same inputs a VS Code
  `oric-debug` launch uses.

## Register it with an MCP client

**Claude Code** — add to your project's `.mcp.json` (or user config):

```json
{
  "mcpServers": {
    "oric": {
      "command": "node",
      "args": ["C:/Users/Mike/.vscode/extensions/osdk-debug/mcp/oric-mcp-server.cjs"]
    }
  }
}
```

**Claude Desktop** — the same shape under `mcpServers` in `claude_desktop_config.json`.

The server logs to **stderr** (stdout is the MCP channel), so client logs will show
`[oric-mcp] ready …` and `[adapter] …` lines.

## Launching a session

Call **`oric_launch`** with a `config` that mirrors a VS Code `oric-debug` launch config:

```jsonc
{
  "config": {
    "port": 6503,                    // IMPORTANT: human base gdb port + 1 (own emulator)
    "launchScript": "osdk_execute.bat",   // OR "emulatorPath": ".../Oricutron.exe" + "diskImage"
    "cwd": "E:/git/Nova2026",
    "symbolFile": "E:/git/Nova2026/build/symbols_ext_combined",
    "gdbBreak": "_game_main"         // optional entry breakpoint
    // "build": { ... }, "emulatorArgs": [ ... ]  as needed
  }
}
```

The **base+1 port convention** matters: the human developer uses the project's base gdb
port; the agent must run its **own** Oricutron on base+1 so the two sessions don't collide.
viz is then at base+2 automatically (port + 1).

## Tools

| Tool | What it does |
|------|--------------|
| `oric_launch` | Build (if stale) + launch Oricutron + connect (DAP + viz). |
| `oric_shutdown` | Terminate the emulator and session. |
| `oric_status` | running / stopped (reason + top frame + source) / ended. |
| `oric_continue` / `oric_pause` | resume / halt. |
| `oric_step_over` / `oric_step_into` / `oric_step_out` | source-line / call stepping. |
| `oric_step_back` / `oric_reverse` | time-travel: reverse one step / run backwards. |
| `oric_set_breakpoint` | `{file,line,condition?}` — native condition (`X == 30`, `e->hp < 0`). |
| `oric_clear_breakpoints` / `oric_list_breakpoints` | manage them. |
| `oric_evaluate` | `{expression}` — symbols, registers, memory, `(TYPE)EXPR` casts. |
| `oric_registers` | 6502 regs + flags. |
| `oric_backtrace` | call stack (symbol + source per frame). |
| `oric_get_output` | recent console output **including logpoint / trace lines**. |
| `oric_screenshot` | **PNG of the screen** so the model can SEE (`scale` 1–6, default 3). |
| `oric_send_keys` | **type into the Oric** (`{text}`; `\n` = Return; machine must be running). |

The combination that makes an agent effective: `oric_screenshot` (sight) + `oric_send_keys`
(input) + the symbol-aware debug tools → it can form a hypothesis, act, and observe the result.

## Known limitations (this is a scaffold)

- **Not yet exercised against a live emulator** — the MCP transport, tool registry and PNG
  encoder are validated; the DAP round-trips assume the adapter behaves as it does for VS Code.
- **`oric_send_keys`** handles printable ASCII + Return; other special keys (arrows, FUNCT,
  etc.) need the emulator's `0x80+` special-code mapping — not wired yet.
- **No symbol-address breakpoints** — breakpoints are `file:line` (DAP `setBreakpoints`).
  Symbol/address bps could be added via the adapter's address-bp / custom requests.
- **`disassemble` / `read_memory`** aren't exposed as tools yet (the adapter has the
  machinery — `disassembleRange` etc.; easy follow-ups).
- **Launch config** is passed through verbatim; no discovery of `.vscode/launch.json`.
- Single session at a time; viz reconnect is best-effort (one retry).

These are all straightforward extensions once the core is confirmed against a real project.
