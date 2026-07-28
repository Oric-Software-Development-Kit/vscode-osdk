# AI-driven debugging (MCP)

Expose the live debug session over the Model Context Protocol, and share a running
GUI session through the collaborative bridge.

---

The extension ships an **MCP server** (`mcp/oric-mcp-server.cjs`) that lets an AI assistant (e.g. Claude) drive an Oricutron debug session with the same reliable primitives as the automation scripts above — it can *see* the screen (screenshots), *act* (reliable keys, warp, run-to-state), and use the full symbol-aware debugger (breakpoints, watchpoints, stepping, registers, backtrace, memory, evaluate).

### One-click registration

Run **Oric: Register MCP Server (for Claude)…**. It writes/merges a `.mcp.json` at your project root (pointing at the server shipped in this extension), **validates** it by performing the real MCP handshake, and **pre-approves its tools** so the assistant isn't prompted "Do you want to proceed?" on every call. It adds `mcp__oric` + `mcp__oric__*` to **both** your user settings (`~/.claude/settings.json`, always loaded) and the project `.claude/settings.json`. **Start a fresh Claude session for it to take effect** (permissions load at session start). If prompts persist, the folder likely isn't *trusted* in Claude Code — see **Stopping the "Do you want to proceed?" prompts** in `mcp/README.md` (it also covers other MCP clients like Gemini/Codex/GLM). It reports how many tools are healthy; then in your assistant run `/mcp` (or restart the session) to load it.

### Tools

Session (`oric_launch` standalone / `oric_attach` collaborative / `oric_shutdown`/`oric_status`), collaboration (`oric_request_control`/`oric_release_control`), execution (`oric_continue`/`oric_pause`/`oric_step_*`/`oric_step_back`/`oric_reverse`/`oric_run_to`/`oric_run_frames`/`oric_warp`), breakpoints & watchpoints (`oric_set_breakpoint` with native condition, `oric_watch_memory`, list/clear), inspection (`oric_read_memory`/`oric_evaluate`/`oric_registers`/`oric_backtrace`/`oric_get_output`), **sight** (`oric_screenshot`), **reliable input** (`oric_send_keys`/`oric_press`), and state waits (`oric_wait_for`/`oric_module`/`oric_wait_module`/`oric_wait_signal`).

### Modes

- **Standalone** — the MCP starts its **own** Oricutron (use `port` = your base gdb port **+ 1** so it never collides with a session you're running yourself) via `oric_launch`. Great for headless/CI runs and for running several emulators at once. The assistant sees only through screenshots + the debugger — it is *not* the emulator window on your screen.
- **Collaborative (shared GUI session)** — the assistant attaches to the **same** live session you're driving in VS Code, so you both look at one screen, one set of breakpoints, one CPU state. The "I found something — take a look" workflow.

### Collaborative mode — how to use it

1. In VS Code, start a debug session (F5) and run **Oric: AI Collaboration — Start/Stop Bridge**. This advertises a local bridge (writes `.oric-bridge.json` at the project root). While a session is active, a **status-bar item** (bottom-left) always shows the state — **`AI bridge: off`**, **`AI bridge: you piloting`**, or **`AI bridge: AI piloting`** — and clicking it starts the bridge / takes control.
2. In your assistant, call **`oric_attach`** (it finds the bridge automatically). You're now sharing the session — **observe-only** to start.
3. The assistant calls **`oric_request_control`** when it wants to drive; the Screen View shows a purple **`● AI`** badge and the status bar reads **`$(hubot) AI piloting`**.
4. You reclaim control any time via the status-bar **"You/AI piloting"** item, **Oric: Take Debug Control**, or `oric_release_control` from the assistant's side.

Who can do what:

| | Observe (screenshot, read memory/registers, backtrace, evaluate) | Game keyboard (into the Oric) | Execution control (pause/continue/step, breakpoints, warp, AI keys) |
|---|---|---|---|
| **You** | always | always (Screen View — never blocked) | when you hold control |
| **AI** | always | via control ops | only while it holds control |

So the classic flow works: the AI sets breakpoints and holds debug control, **you** walk the character to where it crashes (your keyboard always reaches the game), its watchpoint fires, and it inspects — all in the one session you're watching. Copy/Save PNG in the Screen View are always available regardless of who pilots.

---

[← Documentation index](README.md) · [Extension README](../README.md)
