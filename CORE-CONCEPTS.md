# Core concepts (read before adding features)

These are load-bearing invariants for the Oric debug extension. Breaking them
doesn't fail loudly — it produces silent drift (a feature works in one view and
not another). Keep them intact; when in doubt, unify rather than duplicate.

## 1. DRY: one code path per concept

If two places do "the same kind of thing," they must go through **one** function.
Copy-paste that "just gets the feature working" in a second place is tech debt: the
two copies drift, and the bug surfaces later, far from the edit. We hit this exactly
once — annotations were wired into the Globals view but the Watch window re-implemented
variable rendering inline, so `@bool`/`@enum`/`@bitset` silently did nothing in Watch.

Rule: **add behavior in the shared function, not at the call site.**

## 2. One render path: `buildTypedVar`

Rendering "a named value living at an address" happens in **exactly one** place:
`buildTypedVar(name, addr, fullType, size, ann)`.

Every view calls it: Globals, Locals, Zero-page, Watch/`evaluate`, struct-field and
array-element expansion, and any future scope (e.g. "auto"). A handler must NOT format
a value inline. To render, a view only:
1. resolves the address + type/size for the symbol/field,
2. looks up the annotation (`annForSymbol(name)` for symbols, `annByField.get("Struct.field")` for fields),
3. calls `buildTypedVar(...)` and adapts the returned shape (`{name,value,variablesReference}`)
   to what the request needs (e.g. Watch maps `value`→`result`).

Exceptions (legitimately not memory-typed values): the **Registers** and **Flags**
scopes render CPU state directly. `formatScalar`/`formatEnum`/`formatAnnotated` are the
value-string primitives buildTypedVar composes — call them only from inside buildTypedVar
or another formatter, never to re-render a whole variable in a handler.

## 3. Enum resolution is module-independent: `resolveEnum`

Enum defs live per-module (`enumDefs` is the active module's set). But the same enum
appears in every module, and at boot **no** module is active yet. So all enum lookups
go through `resolveEnum(name)` = active `enumDefs` first, then the `allEnumDefs` union
built across every module at load. Never call `enumDefs.get()` directly for rendering.

## 4. Debug annotations (`@bool` / `@enum <E>` / `@bitset <E>`)

Comment-based, so they stay standard C/asm that every compiler ignores. Parsed by
`parseAnnotations()` from all `#FILES` source (`//` in `.h`/`.c`, `;` in `.s`). Two
association levels: `annByField` (C struct members) and `annBySymbol` (C globals AND
asm `.dsb`/`.byt` labels). `@bitset` decodes bit *P* as byte `P>>3`, bit `1<<(P&7)`.
Byte-neutral: annotations never change the built program.

## 5. Fail loud, never silent

Silent failure is the worst failure. Any `catch` that matters routes through
`logError(context, err)` (DAP `important` category + stderr mirror), and
`uncaughtException`/`unhandledRejection` are netted. A swallowed exception once left the
annotation maps empty while symbols still loaded — invisible until instrumented.

## 6. Prefer VS Code / Node native; stay cross-platform

Use the VS Code API and Node built-ins (`fs`, `path`, `os`, `net`, `child_process`
only when unavoidable). **Do not depend on tools a user would have to install** —
no Python, no PowerShell, no bash-isms, no assuming a particular shell. The extension
should run on **Linux and macOS**, not just Windows.

Practical rules:
- Paths: `path.join`/`path.sep`, never hand-built `a + '\\' + b`. Compare with the
  existing `canonPath`/`caseInsensitiveFS` helpers.
- Processes: if you must shell out, branch per `process.platform` (see the port-kill:
  `netstat`/`taskkill` on win32, `lsof` elsewhere) — and prefer a Node-native approach
  first (e.g. kill a pid via `process.kill`, read files via `fs`, not `type`/`cat`).
- Don't hardcode `.exe`, drive letters, `%VAR%`, or `cmd`/`powershell`.

Current honest state (things to fix, not copy):
- **Screenshot→clipboard uses PowerShell and is duplicated in two places**
  (`extension.js` ~1869 and ~3848) — both a platform-lock *and* a DRY violation.
  Should be one `copyImageToClipboard(dataUrl)` helper that branches: PowerShell
  (win32) / `osascript` (darwin) / `xclip` (linux). VS Code's clipboard API is
  text-only, so image copy is the one case that legitimately needs a per-OS shell.
- **Build/launch runs OSDK `.bat` scripts** (`spawnOsdk`) — inherently Windows today
  because the OSDK build system is `.bat`-based. This is a known limitation of the
  toolchain, not a choice to replicate; the debug adapter, resolver, annotations and
  all rendering are already platform-neutral and must stay that way.

## 7. Reactivity is a feature — a slow debugger is unusable

Stepping must feel instant. For serious work a laggy debugger is worse than none:
the user stops trusting it and stops using it. Treat per-stop latency as a
first-class design constraint, not a "later" optimization.

The dominant cost is **round-trips**, not compute. Every `gdbCmd` is a TCP
round-trip to Oricutron; a single stop can issue dozens (stack walk + each
expanded variable + disassembly + annotations). Rules:

- **Minimize round-trips.** Read the widest contiguous span you need in one `m`
  request rather than N small reads; rely on the per-stop read cache
  (`clearGdbReadCache()` each stop, `readMem` dedups within a stop). Before adding a
  per-stop read, ask "does this already sit in a range something else reads?"
- **Only fetch what's shown.** VS Code re-requests `variables` for every *expanded*
  node on each stop, so cost scales with what's open. Don't auto-read large scopes
  the user hasn't expanded; don't refresh a hidden panel (`readAllSymbols` early-returns
  when the Symbols panel isn't visible — keep that guard shape for new panels).
- **`TCP_NODELAY` on every socket** (adapter *and* the Oricutron stub). RSP is tiny
  request/ack packets; with Nagle on, each exchange stalls ~40ms behind the peer's
  delayed ACK.
- **Sockets, not polling intervals.** The emulator must wake the instant a command
  arrives (`select()` on the client socket — `gdb_stub_wait_readable`), never gate GDB
  on a frame/event-poll timer. A prior `SDL_WaitEventTimeout(50)` in the paused loop
  made *every* command cost ~50ms → a step was ~1s. **But never busy-spin:** block with
  a timeout so an idle-paused session (or one with no client) stays cheap.
- **Don't force needless re-reads.** UI churn that collapses/rebuilds the tree makes VS
  Code re-fetch everything (see §8): stable `variablesReference`s and non-`expensive`
  scopes keep state *and* cut reads.

If you profile (`profile on` in the Debug Console → per-request ms + gdb-read counts),
optimize the request with the most reads first; a timing that's a clean multiple of some
interval (e.g. ~50ms) is a latency/poll bug, not real work.

## 8. Stable tree identity across stops

VS Code keys Variables/Watch tree expansion on `variablesReference` and on stack-frame
identity, and it will not keep an `expensive` scope open. So, to stop the tree
re-collapsing every step (which also forces a full re-read — see §7):
- **Stable refs:** the reference for a logical node (struct/array/pointer/bitset) must be
  the same across stops. Allocate via `stableRef(key, payload)` keyed by address/type/
  offset — never a fresh counter per stop. Reset only on symbol reload / module switch.
- **Scopes are `expensive: false`** so VS Code preserves their expanded/collapsed state;
  set the right `presentationHint` (`locals`/`registers`).

## 9. Staleness self-check

The adapter is `node debug_adapter.js` spawned per session, so a session restart loads
current code — but if you edit the file mid-session, the running process is stale.
`warnIfStale()` (called on each stop) compares the file's mtime now vs. at process start
and prints a loud ⚠️ telling you to restart the session. The session banner shows file
mtimes but can't prove which code is *running* — trust the stale check, not the banner.
