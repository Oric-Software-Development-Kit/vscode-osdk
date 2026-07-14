# Design spec — single-source-of-truth address resolver (v2)

Status: **Draft v3 for review** (2026-07-11). Author: Opus 4.8 session; design-reviewed + corpus-validated by Fable 5.
Scope: `osdk-debug` extension (`debug_adapter.js` + `extension.js`).
Related: roadmap Foundation #2 (module-aware symbol table); `DOGFOODING.md` #1.

**v2→v3 (Fable enumerated the full corpus — 309 aliased rows across 7 composed views — and found
the v2 rule STILL shipped bug #1 at 14 addresses):** two validated fixes folded in.
(1) **Owner tie-break within the winning unit** (§5.3 stage 3b, REQUIRED) — line-entry-first picks
the right *line* but "first symbol in unit" then let a boundary/EQU marker (`ZpCommonEnd @ $0070`,
`_EndBSS @ $8740`, `_TextScrollCodeEnd @ $3298`) beat the real symbol; without this the redesign
reships #1. (2) **Source-text code/data classification** (§5.4) — Δ≤3 alone misclassifies packed
data/ZP `.dsb` as "code" (41 cases), so `kind` is derived from the source line text, Δ only as
fallback, and `kind` never gates behavior. Corpus finding: **line selection is already
corpus-proof; the owner name needs fix (1); the `kind` label needs fix (2).** Golden anchors:
`$FD40`, `$0070`, `$8740`, `$3298`.

**v2 changes (verified against Nova's real symbol file):** line-entry-first owner rule with unit
tagging (§5.3), run-based classification as a v1 requirement (§5.4), corrected `$FD40` expectation
(§2/§8), inverse mapping (§5.6), fixed extension-cache prescription (§6), offline golden test
(§7/§8).

---

## 1. Purpose

Every part of the debugger that answers *"what is at address X?"* must give the **same** answer.
Today several independent paths resolve this and disagree at addresses shared by multiple symbols,
so the call stack can navigate to the wrong source line. This spec defines one authoritative
resolver all views are forced through, so agreement is guaranteed **by construction**.

Foundational change: it must be reliable and land incrementally without breaking a working
debugger at any step. Quality bar: clean, readable, maintainable, not fragile, correct on
Windows/Linux/macOS.

---

## 2. The problem (verified against ground truth)

`DOGFOODING.md` #1: stopped at `$FD40`, the call-stack frame shows name `_LoaderResidentStart`
but source line `kernel.s:734` (`_OverlayBufferEnd`, a buffer-end marker aliased to the same
address). The Oric Disassembly view is correct. Same address, different answers.

**Confirmed in `E:\git\Nova2026\build\symbols_ext_combined`:** `$FD40` has **two** `#LINES`
entries, in different blocks:
- `fd40 0:150` in the **loader** block (fileIndex 0 = `loader.asm`) → **`loader.asm:150`**
  = `jsr _LoadData`, the first instruction of `_LoaderResidentStart`, followed by `fd43 0:151`
  (Δ3) → a genuine **instruction run at the run address**.
- `fd40 0:734` in the **kernel** block (fileIndex 0 = `kernel.s`) → **`kernel.s:734`**
  = `_OverlayBufferEnd`, the boundary label after `.dsb OVERLAY_BUFFER_SIZE`, the **last** entry
  of its block.

**Root cause — divergent tie-breaks + lost block identity:**

| Table | Populated by | Tie-break at a shared address |
|---|---|---|
| `addrSym` (addr→name) | `debug_adapter.js:647`, merge `:436` — `if (!has)` | keeps **first** declared → `_LoaderResidentStart` |
| `lineTable` (#LINES) | sort by addr, dedup `:447` | keeps **last** entry → `_OverlayBufferEnd` |

`makeFrame` (`:1890`) reads `name` from `addrSym` (via `labelFor`) and `line` from `lineTable`
(via `sourceFor`): first-wins vs last-wins → disagreement. Two aggravators, both verified:
- **`#FILES` index is per-block**: `fileIndex 0` = `loader.asm` in one block, `kernel.s` in
  another. `loadSymbols` resolves the file string at parse time per block (so `lineTable` files
  are correct), but it **discards which block/unit an entry came from** — so there is no way to
  associate a `#LINES` entry with the *symbol* declared in the same unit.
- **`#SYM V2` source = first textual occurrence, not definition**: `_LoaderResidentStart` →
  `loader.asm:137` (a `jmp _LoaderResidentStart` *call site*); `_OverlayBufferEnd` →
  `kernel.s:132` (an `lda` *reference*). So `symSource`/`addrSource` is unreliable as a
  navigation target and must rank below a real code line.

**Expected fixed result:** frame at `$FD40` = `_LoaderResidentStart @ loader.asm:150` — a real
source line (NOT null / disassembly fallback).

---

## 3. Goals / non-goals

**Goals**
- One resolver is the only way any view learns an address's symbol, source, kind, and module.
  Name and source can never disagree.
- The resolver owns **both directions**: `resolve(addr)` and `addrForLine(file,line)` +
  run-aware next-line (stepping and breakpoint binding need the line→addr direction too).
- Deterministic, documented owner rule at aliased addresses.
- Module-aware (resident + active overlay), per Foundation #2.
- Cross-platform; all path work via `canonPath`; resolver returns **absolute** paths.
- Incremental, non-breaking migration; debugger usable after every step.

**Non-goals**
- No symbol-file / OSDK-build format change (a later optional improvement: stop emitting
  `#LINES` for pure data labels, and/or add a `kind` flag to `#SYM` to mark EQU constants).
- No new debugging features; this is the plumbing existing features sit on.
- Not rewriting the disassembler, only how it labels addresses.

---

## 4. Current state (orientation)

**Data (`debug_adapter.js` ~290–300; per-module buckets ~415–460):** `addrSym` (first-wins),
`addrSource` (first-wins), `symbols` (name→addr), `lineTable` (`[{addr,file,line}]`, sorted,
keep-last dedup), `symSource`, `zpSymbols`, `varTypes`, `typeDefs`, `localDefs`; per-module
`moduleBuckets`, `fileToModule`, `moduleNames`, `activeModuleId`; `disasmCache`.

**Resolution fns:** `labelFor` (~1364), `sourceFor` (~1116), `isPlausibleMapping` (~1093, ≤1KB
magic), `exactLineSource`/`addrSource`-skip (~1252, ~1271).

**Consumers to migrate (all resolve independently today):**

| Consumer | File / fn (~line) | Uses |
|---|---|---|
| Call-stack frame | `makeFrame` (1890) | `labelFor` + `sourceFor` ← **#1** |
| Inline annotation | `resolveInstruction` (3260) | `addrSym.get` + `sourceFor(pc)` |
| Step/goto text | `skip`, goto (2710, 2815) | `labelFor` |
| Cycle annotation | step-over (908) | `sourceFor` + `addrSym.get` |
| Disassembly (virtual) | `disassemble`/`buildDisasmCache` (1477, 1507) | `addrSym` + `sourceFor` |
| `disassembleRange` | (2624–2638) | `addrSym` + `sourceFor` |
| `locationForAddress` | (3504) | `sourceFor` |
| Symbol browser | `readAllSymbols` (3161) | `addrSym` + `exactLineSource` + per-alias `nameSources` |
| **line → addr (inverse)** | `resolveSrcLineAddr` (1335), `findNextSourceLineAddr` (1281), monitor-bp `locFor` (973) | direct `lineTable` (same alias/dedup pathology) |
| Disasm operand labels | `fmtOp(..., addrSym)` (1477, 2624, 3461) | raw `addrSym` |
| Hover / definition | `extension.js` `symbolCache` (adapter-fed) + `defineCache` (source `#define` scan) | see §6 |

---

## 5. Proposed design

### 5.1 The record

```js
resolve(addr) → {
  addr,
  symbol: { name, base, offset, aliases: [ { name, source } ] } | null,
  source: { file, line } | null,   // absolute file; derived from the SAME owner
  kind:   'code' | 'data' | 'unknown',
  module: 'R' | <overlayId>,
}
```

Invariant that kills the bug class: **`symbol` and `source` are read off the one canonical owner
chosen for `addr` — never from two tables.** Aliases carry their own source so the symbol browser
keeps per-alias navigation.

### 5.2 One reconciled index, built at load time

**Prerequisite parser change:** tag every `#SYM` and `#LINES` entry with a **unit id** — one per
`#SYM V2` / `#MODULE` block. `loadSymbols` currently drops this; without it, symbol↔line
association (the crux) is impossible. Cheap: a counter bumped on each block header.

Then build, at load and on module switch:
```
addrIndex: Map<addr, { owner:{name, aliases:[{name,source}]}, source:{file,line}|null, kind, module }>
+ a parallel sorted address array   // for nearest-below search; also removes sourceFor's O(n) addrSource scan
```
`resolve(addr)` = exact hit; else nearest entry below within run/plausibility bounds (§5.3/§5.7),
filling `offset`. This is the single lookup every consumer calls.

### 5.3 Canonical-owner rule — line-entry-first (rewritten)

Symbol-first is unworkable (symbol→line association is exactly what's missing). Resolve
line-entry-first:

1. **Classify runs per (unit, file):** within one unit's line sequence for one file, chain entries
   into instruction runs by address delta ≤ 3 (max 6502 instruction size), transitively. (§5.4)
2. **At an aliased address, rank the (line, unit-owner) pairs and take the best.** Rank
   **lexicographically** by `[source-text kind (code>data>unknown), owner stage-3b rank, -ord]` —
   source-text kind (§5.4) is the primary key, NOT raw run-position (run-membership is only §5.4's
   *fallback* when the source line is unreadable). The winner's line = `source`, its owner = the
   name. This is what makes `$0070` pick the megabuilding `_flash_idx` line over the resident
   `ZpCommonEnd` line (same kind → owner rank breaks it). Owner is restricted to the line's own unit
   (below), so run detection never needs to cross units.
3. **Owner = a symbol at that address, restricted to the winning line's unit.** Restricting to the
   winning unit is itself important: at `$FD40` it excludes `_OverlayBufferEnd` (kernel unit),
   leaving only `_LoaderResidentStart` (loader unit). Other symbols at the address (any unit)
   become `aliases` (deduped by name — every module re-exports via `*_exports.h`).
   **3b. Owner tie-break within the winning unit (REQUIRED — corpus RB2, fixes 14 addresses).**
   When several symbols in the winning unit share the address, "first declared" reships bug #1
   (a boundary/EQU marker beats the real symbol). Choose, in order:
   - the symbol whose `#SYM` source line **equals the winning `#LINES` line**; else
   - a symbol that is **NOT an `=`/EQU assignment** over one that is — detected by the **source-line
     form** `name = expr` (read via `readSourceLine`), **NOT by name pattern**: `_EndModule` is a
     `*End` *name* but a plain position label and must WIN over an EQU like `ZpCommonEnd = *`
     (corpus `$8740`). Among non-EQU, prefer a storage directive (`.dsb`/`.byt`/`.word`); else
   - first-in-file within the unit (documented), lexicographic name as the deterministic fallback.
   `kind` for an owner with **no winning `#LINES` line is `'unknown'`** (not `'data'`), and its
   `source` comes from the `#SYM` decl line (absolutized) — the only source available. Aliased
   addresses with **zero symbols** (pure `#LINES` segment/load boundaries like `$1000`) are out of
   scope for owner selection; they exercise the nearest-symbol-below path (§5.7), not §5.3.
   Verified against the corpus: fixes `$0070` (→ real `_flash_idx`/`_src_ptr`/… over `ZpCommonEnd`),
   `$8740`, `$3298`, and **preserves `$FD40`** (its owner `_LoaderResidentStart` has no exact-line
   match — its `#SYM` src is the *call site* `loader.asm:137` — but wins because the kernel-unit
   `_OverlayBufferEnd` is already excluded by the unit restriction in stage 3).

`$FD40`: loader's `fd40→fd43` (Δ3) is a run member and beats kernel's boundary entry → owner
`_LoaderResidentStart @ loader.asm:150`; `_OverlayBufferEnd` becomes an alias. A symbol with no
code line (resident code whose run address genuinely lacks `#LINES`) yields `source: null` and
consumers fall back to disassembly — but per §2 that is NOT the `$FD40` case.

**Corpus scope confirmed:** the current code emits a wrong name-or-line at ~10–20% of aliased
addresses **every session** (41 R-internal + per-overlay) — #1 is systemic, not a one-off.

### 5.4 Code/data classification — source-text primary (v1 requirement; corpus RB1)

"`#LINES` present ⇒ code" is **empirically false** (XA emits `#LINES` for `.dsb`/`.byt`), and the
corpus proved **Δ≤3 alone is also false**: ZP `.dsb 1`/`.dsb 2` scratch vars are inherently 1–2
bytes apart, so Δ-chaining fakes an instruction run — 41 addresses (most of ZP + packed `.byt` in
code space) misclassify as "code." So classification is derived from **source-line text**, which
the adapter can read at load time (it already caches sources via `getSourceLine`):
- Read the source line the winning `#LINES` entry points to: a **6502 mnemonic** ⇒ `code`;
  `.dsb`/`.byt`/`.word`/`=`/EQU ⇒ `data`. Needs a **macro-name allowlist** (a macro invocation like
  `OPP $a000,y` is real code but not a bare mnemonic; RB5).
- **Fallback** to Δ≤3 / code-address-space only when the line is a comment, a bare label, or
  unavailable (RB5: some AKY-player `#LINES` point at comment/label lines).
- **No opcode decoding at build time** (symbols load before `gdbConnect`; overlay memory mutates).
- **`kind` is advisory — never gate selection correctness on it.** It informs the §5.3 stage-3b
  preference (storage-def vs boundary) and is surfaced to consumers, but owner/line selection must
  stay correct even if `kind` is wrong.
- Accepted residual (RB3): a 1-byte instruction (`rts`, Δ1) vs a `.byt` run (Δ1) is undecidable by
  spacing; source-text resolves most, remainder logged.

### 5.5 Module-awareness

`resolve()` consults the composed view (resident 'R' + active overlay), record carries `module`,
index rebuilt/re-layered on module switch. Resident symbols resolve regardless of active overlay.
Caveat (see §10): after a switch, stack return addresses into a *previous* overlay will be labeled
with the new module's symbols; decide intended behavior when the §8 harness flags it.

### 5.6 Inverse mapping (line → addr)

The resolver also owns `addrForLine(file, line)` and a run-aware "next executable line ≥ line",
replacing direct `lineTable` reads in `resolveSrcLineAddr`, `findNextSourceLineAddr`, and monitor
`locFor`. Consequence: the **ordered line sequence must survive** — a breakpoint on `kernel.s:734`
must bind to kernel data intent, not silently arm resident loader code. So §7's "delete legacy" is
scoped to the resolution *functions*, not the `lineTable` structure.

### 5.7 Arbitrary-PC resolution (nearest-below)

§5.3 governs addresses where a symbol sits **exactly**. But `makeFrame`/`resolveInstruction`
resolve arbitrary mid-routine PCs on every stop, where usually **no symbol and often no line** is
exactly at the PC. For those, `name` and `source` are resolved **independently** — this is the
classic `labelFor`+`sourceFor` behavior and does NOT reintroduce #1 (that bug was two answers at the
*same* address; here they legitimately come from different addresses):

- **Source:** the winning exact line *at* the PC if present (never discard an available line —
  regression trap), else the **nearest line below** (floor of the sorted line addresses), gated.
- **Name:** the **nearest symbol below** (floor of the sorted symbol addresses), gated; the record's
  `offset` = `addr - owner.base`. If several symbols share that nearest address, stage-3b picks.
- **Gate (`plausible(base, addr)`):** `offset ≥ 0`; for base in pages 0–3 (ZP/stack) require the
  **same page** (never let a ZP symbol own a mid-memory PC); otherwise within a size bound
  (`NEAR_SPAN`, currently 1 KB — a later refinement is the owner's computed run span). Past the
  gate, return `null` for that facet rather than a nonsense `func+$700`.

`kind` follows the chosen source line (§5.4), or `'unknown'` when the name came from a symbol with
no line. `module` is the **owner's** module (or, when there is a plausible line but no plausible
symbol, the **line's** module). The `#SYM` decl-line fallback for a lineless owner applies ONLY to
an **exact** symbol at the address; for a mid-routine PC whose nearest line was gated out, `source`
stays `null` — we don't invent the enclosing symbol's decl location as the PC's source.

---

## 6. API surface

### 6.0 Pure resolver module (`resolver.cjs`) — testability boundary
The rule lives in a **pure, side-effect-free module** so both the adapter and the offline golden
test use the identical code. No sockets, no DAP, no direct `fs` — source reading is **injected**:

```js
// resolver.cjs
buildResolver(symbolFileText, {
  readSourceLine(absFile, line1) → string|null,   // injected (adapter: getSourceLine; test: fixture reader)
  sourceRoot, workspaceFolder,                     // for absolutizing #FILES paths
}) → {
  resolve(addr)            → { addr, symbol:{name,base,offset,aliases:[{name,source}]}|null,
                               source:{file,line}|null, kind, module },
  addrForLine(file, line)      → { addr, line } | null,  // snapped line reported (skip-line needs it)
  nextLineAddr(pc, file, line) → addr | -1,   // next DIFFERENT line of file strictly after pc (stepping)
  declOf(name)             → { file, line } | null,   // (Step D, not yet implemented)
  setActiveModule(id),                     // recompose R + overlay; cheap (re-layer, not full reparse)
  aliasedAddresses()       → [addr…],      // for the disagreement log + golden test
}
```
The adapter constructs one `buildResolver` per symbol load and calls `setActiveModule` on switch.
The golden test constructs it over the Nova fixture with a fixture `readSourceLine` and asserts.

- **Adapter-internal wrappers:** `labelFor`/`sourceFor` become thin wrappers over `resolve()`
  during migration, removed once all callers move (the `lineTable` sequence stays for §5.6).
- **Custom requests:** extend `locationForAddress` to return the full record. `resolveInstruction`
  keeps its annotation but takes `file/line` from `resolve(pc)`.
- **Extension side (corrected):** `symbolCache` is **already** adapter-fed from `readAllSymbols` —
  not an independent truth, but it goes **stale across module switches when the panel is hidden**
  (`extension.js:2433` early-returns). Fix by pushing an invalidation/refresh event from the
  adapter on symbol load and module switch — do **not** delete it. `defineCache` scans `#define`
  from source (knowledge absent from the symbol file) — **keep it**; deleting loses hover data.

---

## 7. Migration plan (incremental, non-breaking)

1. **Parser unit-tagging + `addrIndex` + `resolve()`/`addrForLine()`** alongside existing tables,
   no consumer changes. Add a per-address-deduped **disagreement log** (resolve vs legacy
   `labelFor`+`sourceFor`) to surface every aliased address in real sessions. Add the **offline
   golden test** (§8).
2. **Migrate `makeFrame`.** ← fixes #1. Verify call stack = `loader.asm:150`.
3. **Migrate `resolveInstruction`, cycle annotation, step/goto text.**
4. **Migrate disassembly + `disassembleRange` + `locationForAddress` + `fmtOp` operand labels.**
5. **Migrate the inverse-direction consumers** (`resolveSrcLineAddr`, `findNextSourceLineAddr`,
   monitor `locFor`) to `addrForLine`/`nextLineAddr`.
6. **Migrate the symbol browser** (per-alias source via `declOf`/`aliases[].source`).
7. **Extension:** adapter-pushed cache invalidation; keep `defineCache`.
8. **Collapse** the legacy resolution functions (keep the `lineTable` sequence + dedup semantics
   that stepping relies on).

### 8. Verification

Reliability must be proven (self-driven; gdb port base+1 so the human's session is untouched):
- **Offline golden test** (`node`-runnable, no emulator): parse `symbols_ext_combined`, enumerate
  all aliased addresses, snapshot owner decisions. Tie-break regression anchors (from the corpus):
  `fd40 → _LoaderResidentStart / loader.asm:150`; `0070 → ` the active real ZP var (e.g.
  `_flash_idx`, NOT `ZpCommonEnd`); `8740 → _EndModule` not `_EndBSS`; `3298 → _DotIdx` not
  `_TextScrollCodeEnd`. Runs CI-style before any live test. (Fable's `corpus3.cjs`/`refine.cjs` in
  scratchpad are the starting point.)
- **Cross-view agreement:** at each stop, `resolve(pc)` matches call stack + disassembly + inline
  annotation.
- **Acceptance for #1 = `loader.asm:150` in the call stack** (NOT "agrees with disassembly" — that
  would pass a fallback that hid an available line).
- **Stepping regression** over macro-heavy code (multiple lines per address — the case keep-last
  dedup was written for); **breakpoint-at-`kernel.s:734`** sanity (must bind to kernel intent).
- **Module switch:** resolution flips resident↔overlay correctly; no stale overlay symbol.
- **Non-regression:** ordinary code addresses resolve identically before/after.

---

## 9. Cross-platform

Path comparison already unified via `canonPath` (Win/macOS case-insensitive, Linux case-sensitive)
in both files. The resolver must not reintroduce raw `===`/`.toLowerCase()` path handling, and it
absolutizes `source.file` centrally (kills the triplicated `sourceRoot`/`workspaceFolder` blocks at
`makeFrame:1900`, `buildDisasmCache:1512`, `disassemble:2640`).

---

## 10. Risks & open questions

- **Classification accuracy (§5.4)** — corpus-driven; `kind` is advisory (never gates selection),
  so a misclass degrades a label, not correctness. Accepted residuals: Δ1 `rts`-vs-`.byt` (RB3);
  `#LINES` pointing at comment/label lines needing the fallback + macro allowlist (RB5). Keep the
  guard for true `.word` jump/vector tables (Δ2/3) even though Nova has none at an aliased address —
  source-text classification defends against them; Δ alone would not.
- **EQU/value constants** — code-less shared buffers (`_Buffer_8000 = BUFFER_ADDRESS` at `$0400`,
  RB4, 17 rows) have no line entry, so ownership is a pure `#SYM` tie-break; §5.3 stage-3b's
  storage-over-EQU rule reshuffles some to semantic names, but where neither is "wrong" — accept +
  log. Note the legit SMC idiom `label=*+1` (`$fd45`) is a real code operand label, not junk.
  Longer-term: a `kind` flag in `#SYM` (OSDK build change) would remove the ambiguity.
- **Stale frames across module switch** — decide intended labeling before the §8 harness flags it.
- **Dedup semantics feed stepping** — preserve within-(unit,file) keep-last while fixing the
  cross-unit collision; §8 stepping test guards this.
- **Symbol-file emission-order stability** across builds — affects the first-in-unit tie-break and
  golden-test stability; confirm it's deterministic.
- **Resident run-vs-load addresses** — **resolved:** resident `#LINES` use run addresses (verified
  at `$FD40`). Left here as a confirmed fact, not an open question.

---

## 11. Appendix — quick start for a fresh session

- Repo: `C:\Users\Mike\.vscode\extensions\osdk-debug\` (own git, branch `main`). `debug_adapter.js`
  = DAP adapter + all symbol/line/resolution logic; `extension.js` = VS Code UI.
- No build step — plain JS; `node --check` both files, then reload the window to test.
- Test project: Nova2026 (`E:\git\Nova2026`), symbol file `build/symbols_ext_combined`
  (`#FILES`/`#LINES`/`#SYM V2` sections, one block per `#SYM V2`/`#MODULE`; `#FILES` index is
  **per-block**; paths absolute, `E:\` casing). GDB base port `OSDKGDBPORT=6502`; Claude uses
  **base+1 (6503)** so it never fights the human session.
- Read order: `loadSymbols` (block merge ~415–460, `#LINES` parse ~574) → `sourceFor`/`labelFor`/
  `isPlausibleMapping` → `makeFrame` (`stackTrace`) → the inverse-direction fns (§4 table).
- Context: roadmap Foundation #2; `DOGFOODING.md` #1 is the first test case.
