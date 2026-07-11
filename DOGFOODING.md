# Nova dogfooding — debug experience issues

Running log of things that don't work as expected while actually debugging Nova
(and later Encounter) with the osdk-debug extension. Newest entries at the top.
Status: **Open** (not yet fixed) / **Fixed** (with commit) / **Won't fix** (with reason).

---

## #1 — Call-stack frame lands on the wrong symbol at an aliased address — Fixed

**Fixed** by the single-source-of-truth resolver (`resolver.cjs`, `SPEC-address-resolver.md`),
wired into `makeFrame`. User-verified: `jmp _LoaderResidentStart` now stays in `loader.asm` on the
real `jsr _LoadData` (`loader.asm:150`) instead of `kernel.s:734`. Validated by two independent
implementations (resolver + Fable oracle) — exact-address golden 412/412 across 7 views + 7/7
nearest-below cases. Other consumers (inline annotation, disassembly labels, breakpoint binding)
still migrate next (SPEC §7 steps 3–6).


**Observed:** Stepping in `loader.asm`, line 137 `jmp _LoaderResidentStart` correctly
jumps to `$FD40` (`_LoaderResidentStart`) — Oricutron shows `$FD40`, and the VS Code
**Oric Disassembly** view correctly shows `FD40 / _LoaderResidentStart`. But the
**Call Stack** shows `_LoaderResidentStart — kernel.s (734)`, and line 734 is actually
`_OverlayBufferEnd`, a *different* symbol that happens to sit at the same address
`$FD40`. So the source navigation jumps to the wrong line.

Context: all done at `Module: (none)`, which otherwise worked great — labels,
expressions, and the inline value annotation all resolved correctly.

**Root cause:** `makeFrame()` in `debug_adapter.js` resolves a frame's *name* and its
*source line* through two independent tables:
- name = `labelFor(addr)` → `addrSym` map → picks `_LoaderResidentStart` (correct)
- line = `sourceFor(addr)` → `#LINES` `lineTable` → picks `kernel.s:734` (`_OverlayBufferEnd`)

At an address shared by multiple symbols, the two paths disagree. Aggravated by the
resident/overlay model: `_LoaderResidentStart` *runs* at `$FD40`, but the only clean
`#LINES` entry at that exact address is the coincidental data/boundary label
`_OverlayBufferEnd`. The line-table dedup (keep last entry per address) can also favor
the wrong alias.

**Possible fixes (TBD):**
- Align the two resolutions: when choosing the source line, prefer a `lineTable` entry
  whose owning symbol matches the name `labelFor()` chose.
- Prefer a line entry that begins an executable run over a data/boundary label at the
  same address (needs a code/data distinction).
- Don't emit `#LINES` entries for pure data/boundary labels during build.

Related: resident/overlay symbol model, [[osdk-module-structure]].

---
