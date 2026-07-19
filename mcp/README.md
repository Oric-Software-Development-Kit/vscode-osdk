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
| `oric_send_keys` | **type into the Oric RELIABLY** (`{text}`; `\n` = Return) — each key played by the emulator's tap queue (held across scans, one at a time), so keystrokes aren't dropped under warp. |
| `oric_press` | press one key: a letter, a NAME (`RETURN`/`ESC`/`UP`/`SPACE`/`CTRL`…), or a code. |
| `oric_warp` | `{on}` — fast-forward on/off; applies immediately even while running. |
| `oric_wait_for` | `{expr}` — run until a variable holds a value (`_gCurrentLocation == e_LOC_MARKETPLACE`); the reliable "wait until", any write path, frame-based timeout. |
| `oric_run_to` | `{target}` — run to a symbol (`_AskInput`) or `$hex`, then stop. |
| `oric_run_frames` | `{frames}` — let N emulated frames pass (~50 = 1 s), then stop. |
| `oric_module` / `oric_wait_module` | active OSDK overlay (Splash/Intro/Game/…) / run until a given one. |
| `oric_wait_signal` | `{id}` — run until a logpoint/watchpoint tagged `[signal:<id>]` fires. |

The interaction tools (`send_keys`/`press`/`warp`/`wait_for`/`run_to`/`module`/`wait_signal`) run
on the **same `makeApi(ops)` control core** the VS Code automation uses — so the MCP inherits the
same reliability: emulator-owned key timing, the always-live control channel, deterministic
"wait until a variable holds a value", and overlay-module awareness. Combined with
`oric_screenshot` (sight) + the symbol-aware debug tools, an agent can form a hypothesis, act
reliably, and observe the result.

## Known limitations (this is a scaffold)

- **Not exercised end-to-end against a live emulator via an MCP client** — the transport, tool
  registry, PNG encoder and the shared control core are validated (selftests); a full agent run
  through an MCP client is the remaining check.
- **No symbol-address breakpoints** — breakpoints are `file:line` (DAP `setBreakpoints`).
  Symbol/address bps could be added via the adapter's address-bp / custom requests.
- **Command-line typing verification is game-specific** — `oric_send_keys` types reliably, but
  the input-buffer *verify/retry* (as in the Encounter `enc.command` helper) lives in game
  scripts, not the generic MCP tool.
- **`disassemble` / `read_memory`** aren't exposed as tools yet (the adapter has the
  machinery — `disassembleRange` etc.; easy follow-ups).
- **Launch config** is passed through verbatim; no discovery of `.vscode/launch.json`.
- Single session at a time; viz reconnect is best-effort (one retry).

These are all straightforward extensions once the core is confirmed against a real project.
