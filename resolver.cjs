'use strict';
// ---------------------------------------------------------------------------
// Single-source-of-truth address resolver  (SPEC-address-resolver.md)
//
// Pure, side-effect-free: parse symbol-file text -> model -> resolve(addr).
// No sockets, no DAP, no direct fs — source reading is INJECTED so both the
// adapter and the offline golden test use this identical code.
//
//   const { buildResolver } = require('./resolver.cjs');
//   const r = buildResolver(symbolFileText, { readSourceLine, sourceRoot, workspaceFolder });
//   r.setActiveModule(id);          // null = resident-only; 0..N = R + that overlay
//   r.resolve(addr);                // -> { addr, symbol, source, kind, module }
//
// The whole point: for an EXACT aliased address, name and source are read off
// ONE canonical owner, never from two divergent tables — so the call stack,
// disassembly, hover and annotations can't disagree (fixes DOGFOODING #1). For a
// mid-routine PC (no symbol exactly at addr) name = nearest symbol below and
// source = nearest line below, which legitimately live at different addresses —
// that's the classic labelFor+sourceFor behavior and does NOT reintroduce #1
// (the bug was two answers at the SAME address, not offset resolution).
// ---------------------------------------------------------------------------

const path = require('path');

// 6502 mnemonics — a source line whose statement is one of these is code.
const MNEMONICS = new Set([
  'adc','and','asl','bcc','bcs','beq','bit','bmi','bne','bpl','brk','bvc','bvs',
  'clc','cld','cli','clv','cmp','cpx','cpy','dec','dex','dey','eor','inc','inx',
  'iny','jmp','jsr','lda','ldx','ldy','lsr','nop','ora','pha','php','pla','plp',
  'rol','ror','rti','rts','sbc','sec','sed','sei','sta','stx','sty','tax','tay',
  'tsx','txa','txs','tya',
]);
// Data-defining directives — a line using one of these is data. (Superset of the
// XA/OSDK directive set; keep in sync if new data directives appear.)
const DATA_DIRECTIVE = /(^|\s)\.(dsb|byt|byte|db|dw|word|dword|wor|asc|aasc|text|fill|zero)\b/i;
// An EQU / assignment statement: `name = expr` at statement level.
const EQU_FORM = /^\s*[A-Za-z_.][\w.]*\s*=\s*\S/;
const MAX_INSN = 3;      // largest 6502 instruction size, for run-membership by delta
const NEAR_SPAN = 1024;  // §5.7 fallback: how far below a symbol/line still maps to it

function stripComment(s) { const i = s.indexOf(';'); return i >= 0 ? s.slice(0, i) : s; }

// Push v into the array stored at map[k], creating it if needed.
function pushInto(map, k, v) {
  let a = map.get(k);
  if (!a) { a = []; map.set(k, a); }
  a.push(v);
  return a;
}

// Classify a source line: 'code' | 'data' | null (comment / bare label / unknown).
function classifyLine(text, macroNames) {
  if (text == null) return null;
  const s = stripComment(text);
  if (!s.trim()) return null;
  if (EQU_FORM.test(s)) return 'data';        // name = expr
  if (DATA_DIRECTIVE.test(s)) return 'data';  // .dsb/.byt/...
  // statement token = first token after an optional leading label
  const m = s.match(/^\s*(?:([A-Za-z_.][\w.]*)\s+)?([A-Za-z_.][\w.]*)/);
  if (m) {
    const stmt = m[2];
    if (MNEMONICS.has(stmt.toLowerCase())) return 'code';
    if (macroNames && macroNames.has(stmt)) return 'code';
  }
  return null; // bare label / macro-def / unrecognized -> caller falls back
}

// §5.7 plausibility: does `addr` plausibly belong to the entry at `base`?
function plausible(base, addr) {
  const off = addr - base;
  if (off < 0) return false;
  if (base < 0x0400) return (base >> 8) === (addr >> 8); // ZP/stack: same page only
  return off <= NEAR_SPAN;
}

// Smallest value in sorted `arr` strictly greater than `val` (or -1).
function nextAddr(arr, val) {
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] > val) { best = arr[mid]; hi = mid - 1; } else lo = mid + 1; }
  return best;
}

// Does the symbol at `sa` own `addr`? The distance gate (NEAR_SPAN) exists to stop a DATA
// symbol from being attributed to a far address. CODE is different: a PC is always inside some
// function, that function has a definite start, and C functions can be large (>1KB) — so a code
// owner has NO distance cap; the enclosing function owns everything up to the next symbol.
// ZP/stack keeps the same-page rule regardless.
function symOwns(symAddrs, sa, addr, isCode) {
  if (addr < sa) return false;
  if (sa < 0x0400) return (sa >> 8) === (addr >> 8);   // ZP/stack: same page only
  if (isCode) { const nxt = nextAddr(symAddrs, sa); return nxt < 0 || addr < nxt; }
  return (addr - sa) <= NEAR_SPAN;                      // data: keep the distance gate
}

function buildResolver(text, opts) {
  opts = opts || {};
  const readSourceLine = opts.readSourceLine || (() => null);
  const sourceRoot = opts.sourceRoot;
  const workspaceFolder = opts.workspaceFolder;
  const macroNames = opts.macroNames instanceof Set ? opts.macroNames : new Set();

  const absCache = Object.create(null);
  function absFile(f) {
    if (f == null) return f;
    if (f in absCache) return absCache[f];
    let r = f;
    // Nova's #FILES paths are absolute; resolve relative ones against a supplied
    // root. (No cwd fallback — a bare relative path stays relative and is compared
    // as-is; callers should pass sourceRoot/workspaceFolder for portability.)
    if (!path.isAbsolute(f)) {
      if (sourceRoot) r = path.resolve(sourceRoot, f);
      else if (workspaceFolder) r = path.resolve(workspaceFolder, f);
    }
    return (absCache[f] = r);
  }

  // Cross-platform path compare, consistent with the extension's canonPath:
  // case-fold ONLY on case-insensitive filesystems (Windows/macOS).
  function samePathLoose(a, b) {
    if (a == null || b == null) return a === b;
    let na = String(a).replace(/\\/g, '/');
    let nb = String(b).replace(/\\/g, '/');
    if (process.platform === 'win32' || process.platform === 'darwin') { na = na.toLowerCase(); nb = nb.toLowerCase(); }
    return na === nb;
  }

  // A build intermediate under a TMP/ folder (e.g. TMP\main, TMP\linked.s) is
  // ephemeral: it only exists during a build and its contents won't match what's
  // running afterwards. Treat such paths as non-existent — never a source location.
  const isTmp = (f) => !!f && /[\\/]tmp[\\/]/i.test(String(f));

  // --- parse -------------------------------------------------------------
  // Flat entry lists tagged with { module, uid }. uid (unit) increments on every
  // `#SYM V2` and `#MODULE` header — the granularity that owns a run of lines and
  // the symbols declared beside them. module is 'R' until the first #MODULE.
  const syms = [];   // { addr, name, module, uid, symFile, symLine, ord, _defKind? }
  const lines = [];  // { addr, file, line, module, uid }

  (function parse() {
    const rows = String(text).split(/\r?\n/);
    let section = 'sym', fileIndex = [], module = 'R', uid = 0, ord = 0;
    for (const raw of rows) {
      const t = raw.trim();
      const mm = t.match(/^#MODULE\s+(\d+)\s+(\S+)/);
      if (mm) { module = parseInt(mm[1], 10); uid++; section = 'sym'; fileIndex = []; continue; }
      if (t === '#SYM V2') { uid++; section = 'sym'; continue; }
      if (t === '#FILES')  { section = 'files'; fileIndex = []; continue; }
      if (t === '#LINES')  { section = 'lines'; continue; }
      if (t === '#TYPES')  { section = 'types'; continue; }
      if (section === 'files') { const fm = t.match(/^(\d+)\s+(.+)$/); if (fm) fileIndex[parseInt(fm[1], 10)] = fm[2]; continue; }
      if (section === 'lines') {
        const lm = t.match(/^([0-9a-fA-F]{4})\s+(\d+):(\d+)$/);
        if (lm) {
          const f = fileIndex[parseInt(lm[2], 10)] || null;
          // Skip line entries that map to a TMP intermediate — an address with only a
          // TMP line then resolves to no source (→ disassembly) instead of a fake file.
          if (!isTmp(f)) lines.push({ addr: parseInt(lm[1], 16), file: absFile(f), line: parseInt(lm[3], 10), module, uid });
        }
        continue;
      }
      if (section === 'types') continue;
      const sm = raw.match(/^([0-9a-fA-F]{4})\s+(\S+)/); // "HHHH name [file:line]"
      if (sm) {
        const rest = raw.slice(sm[0].length).trim();
        const cm = rest.match(/^(.+):(\d+)$/);
        // Skip compiler-generated intermediate labels: a non-C-linkage name (no '_'
        // prefix) defined only in a TMP intermediate (Lmain132, internal .c→.s labels).
        // They're noise as frame names / nearest-symbol answers. Real C symbols keep
        // their '_' prefix; real asm labels live in .s files (not TMP).
        if (cm && isTmp(cm[1]) && sm[2][0] !== '_') continue;
        // Drop a TMP decl location so an exact symbol never falls back to a TMP file.
        const hasSrc = cm && !isTmp(cm[1]);
        syms.push({ addr: parseInt(sm[1], 16), name: sm[2], module, uid, symFile: hasSrc ? absFile(cm[1]) : null, symLine: hasSrc ? parseInt(cm[2], 10) : null, ord: ord++ });
      }
    }
  })();

  // --- per-view (composed R + active overlay) index, built lazily & purely ----
  let activeModule = null;
  const viewCache = new Map(); // module-key -> view

  const inView = (m, active) => m === 'R' || m === active;

  function buildView(active) {
    const symsByAddr = new Map(), linesByAddr = new Map();
    const runMember = new Map();  // per-view: lineObj -> bool (never mutate shared parse objects, finding #3)
    const seq = new Map();        // (uid,file) -> [lineObj], for run detection
    for (const l of lines) {
      if (!inView(l.module, active)) continue;
      pushInto(linesByAddr, l.addr, l);
      pushInto(seq, l.uid + ' ' + (l.file || ''), l);
    }
    for (const arr of seq.values()) {
      arr.sort((a, b) => a.addr - b.addr);
      for (let i = 0; i < arr.length; i++) {
        const prev = arr[i - 1], next = arr[i + 1];
        runMember.set(arr[i], (!!next && next.addr - arr[i].addr <= MAX_INSN) || (!!prev && arr[i].addr - prev.addr <= MAX_INSN));
      }
    }
    for (const s of syms) if (inView(s.module, active)) pushInto(symsByAddr, s.addr, s);

    const symAddrs = [...symsByAddr.keys()].sort((a, b) => a - b);
    const lineAddrs = [...linesByAddr.keys()].sort((a, b) => a - b);

    // First in-view symbol per name — declOf()'s index, iterated in ord order
    // so the first declaration wins among duplicates. Stores the sym object:
    // defSiteOf() needs addr/uid too (a TMP-dropped decl can still resolve to
    // the unit's line at the symbol's address).
    const declByName = new Map();
    for (const s of syms) {
      if (!inView(s.module, active)) continue;
      if (!declByName.has(s.name)) declByName.set(s.name, s);
    }

    // Aliased = a genuine conflict: 2+ symbols, or 2+ lines, or a lone sym+line
    // that come from DIFFERENT units (cross-unit collision). NOT every label that
    // merely sits on a lined instruction (finding #5).
    const aliased = [];
    for (const addr of symAddrs) {
      const ss = symsByAddr.get(addr), ll = linesByAddr.get(addr);
      if (ss.length > 1 || (ll && ll.length > 1) ||
          (ss.length === 1 && ll && ll.length === 1 && ss[0].uid !== ll[0].uid)) aliased.push(addr);
    }
    return { symsByAddr, linesByAddr, runMember, symAddrs, lineAddrs, aliased, declByName };
  }

  function view() {
    const key = activeModule == null ? 'R' : activeModule;
    let v = viewCache.get(key);
    if (!v) { v = buildView(activeModule); viewCache.set(key, v); }
    return v;
  }

  // Directive form of a symbol's own decl line (memoized): 'equ' | 'storage' | 'label' | 'unknown'.
  function symDefKind(sym) {
    if (sym._defKind !== undefined) return sym._defKind;
    let dk = 'unknown';
    if (sym.symFile && sym.symLine) {
      const line = readSourceLine(sym.symFile, sym.symLine);
      if (line != null) { const s = stripComment(line); dk = EQU_FORM.test(s) ? 'equ' : DATA_DIRECTIVE.test(s) ? 'storage' : 'label'; }
    }
    return (sym._defKind = dk);
  }

  // Stage-3b owner rank (higher = better): exact-line-match > non-EQU storage >
  // non-EQU label/unknown > EQU. `winLine` may be null.
  function symRank(sym, winLine) {
    if (winLine && sym.symFile && sym.symLine && samePathLoose(sym.symFile, winLine.file) && sym.symLine === winLine.line) return 4;
    const dk = symDefKind(sym);
    return dk === 'storage' ? 3 : dk === 'equ' ? 1 : 2;
  }

  // Pick the best symbol among candidates (stage-3b); stable first-in-file tie-break by ord.
  function pickSym(cands, winLine) {
    let best = null, bestRank = -1;
    for (const s of cands) {
      const r = symRank(s, winLine);
      if (r > bestRank || (r === bestRank && best && s.ord < best.ord)) { best = s; bestRank = r; }
    }
    return best;
  }

  // Code-ness of a line: source text first (§5.4), run-membership only as a
  // fallback when the source line is unavailable/unrecognized. NOTE: the fallback
  // can misread a Δ≤3 `.word` table as code when the source file is absent (RB3) —
  // acceptable known residual, contained whenever sources are readable.
  function lineKind(l, v) {
    const k = classifyLine(readSourceLine(l.file, l.line), macroNames);
    if (k) return k;
    return v.runMember.get(l) ? 'code' : 'data';
  }
  const KIND_SCORE = { code: 2, data: 1, unknown: 0 };

  // Among the exact lines at an aliased address, choose the winning (line, owner)
  // pair. Pairs are ranked lexicographically [lineKindScore, ownerRank, -ord] so
  // the priority can't arithmetic-carry (finding #7). Owner is restricted to the
  // line's own unit (keeps name+line same-unit — the anti-#1 invariant).
  function winningPair(symsHere, linesHere, v) {
    let best = null;
    for (const l of linesHere) {
      const unitSyms = symsHere.filter(s => s.uid === l.uid);
      const owner = pickSym(unitSyms, l); // null if this line's unit has no symbol here
      const cand = {
        line: l, owner,
        kindScore: KIND_SCORE[lineKind(l, v)],
        ownerRank: owner ? symRank(owner, l) : 0,
        ord: owner ? owner.ord : Infinity,
      };
      if (!best || cand.kindScore > best.kindScore ||
          (cand.kindScore === best.kindScore && cand.ownerRank > best.ownerRank) ||
          (cand.kindScore === best.kindScore && cand.ownerRank === best.ownerRank && cand.ord < best.ord)) best = cand;
    }
    return best; // { line, owner|null, ... }
  }

  // Largest value in sorted `arr` that is <= addr (or -1).
  function floorAddr(arr, addr) {
    let lo = 0, hi = arr.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= addr) { best = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }

  function resolve(addr) {
    const v = view();
    const symsHere = v.symsByAddr.get(addr) || [];
    const linesHere = v.linesByAddr.get(addr) || [];
    const rec = { addr, symbol: null, source: null, kind: 'unknown', module: activeModule == null ? 'R' : activeModule };

    let owner = null, srcLine = null;
    const exactSymbol = symsHere.length > 0; // landmark address (a symbol sits exactly here)

    if (symsHere.length) {
      // Landmark address — the single-owner rule applies.
      if (linesHere.length) {
        const wp = winningPair(symsHere, linesHere, v);
        srcLine = wp.line;
        owner = wp.owner;
        if (!owner) {
          // Rare: the winning line's unit has no symbol here, but another unit does.
          // Fall back cross-unit for the NAME (source stays the winning line). Not
          // seen in Nova; documented as the acceptable residual of finding #4.
          owner = pickSym(symsHere, wp.line);
        }
      } else {
        // Exact symbol, no exact line: source is the owner's #SYM decl line; kind unknown.
        owner = pickSym(symsHere, null);
      }
    } else {
      // Mid-routine PC (no symbol exactly here) — nearest-below for BOTH, independently.
      // Source: winning exact line here (finding #1a: don't discard it), else nearest below.
      if (linesHere.length) srcLine = winningLineNoOwner(linesHere, v);
      else { const la = floorAddr(v.lineAddrs, addr); if (la >= 0 && plausible(la, addr)) srcLine = winningLineNoOwner(v.linesByAddr.get(la), v); }
      // Name: nearest symbol below (finding #1b, §5.7). If the PC is in code, the enclosing
      // function owns it with no distance cap; the NEAR_SPAN gate only applies to data owners.
      // "In code" = an asm mnemonic line OR any C source line: a C statement isn't a 6502
      // mnemonic and C emits many instructions per line (so #LINES entries are >3 bytes apart),
      // meaning neither classifyLine nor the Δ≤3 run test recognizes it — but a #LINES entry
      // into a C file at a PC IS compiled code.
      const sa = floorAddr(v.symAddrs, addr);
      const inCode = !!srcLine && (lineKind(srcLine, v) === 'code' || /\.[ch]$/i.test(srcLine.file || ''));
      if (sa >= 0 && symOwns(v.symAddrs, sa, addr, inCode)) owner = pickSym(v.symsByAddr.get(sa), srcLine);
    }

    if (!owner && !srcLine) return rec; // truly unknown

    // aliases = OTHER symbols exactly here (deduped by name), for hover "also known as".
    const aliases = [];
    if (owner) {
      const seen = new Set([owner.name]);
      for (const s of symsHere) {
        if (seen.has(s.name)) continue; seen.add(s.name);
        aliases.push({ name: s.name, source: defSiteOf(s, v) });
      }
      aliases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      rec.symbol = { name: owner.name, base: owner.addr, offset: addr - owner.addr, aliases };
      rec.module = owner.module; // owning module, NOT the active view (finding #2b)
    } else if (srcLine) {
      rec.module = srcLine.module; // source-only (no plausible symbol): report the line's module
    }
    if (srcLine) {
      rec.source = { file: srcLine.file, line: srcLine.line };
      rec.kind = lineKind(srcLine, v);
    } else if (owner && exactSymbol && owner.symFile) {
      // Exact symbol with no line of its own → its #SYM decl line (kind unknown). For a
      // MID-ROUTINE PC (owner from nearest-below) we deliberately leave source null rather
      // than invent the enclosing symbol's decl location (spec §5.7).
      rec.source = { file: owner.symFile, line: owner.symLine };
      rec.kind = 'unknown';
    }
    return rec;
  }

  // Winning line when there is no exact owner to couple with: source-text kind, then ord.
  function winningLineNoOwner(linesHere, v) {
    let best = null, bestScore = -1;
    for (const l of linesHere) {
      const sc = KIND_SCORE[lineKind(l, v)];
      if (sc > bestScore) { best = l; bestScore = sc; }
    }
    return best;
  }

  // --- Inverse mapping (§5.6): line -> address ----------------------------

  // file+line -> address. THE snapping rule (breakpoints, goto and turboRun all
  // agree by construction): the next entry at/after reqLine in that file, else
  // the nearest before (end of file); snapping backward first would collapse
  // distinct lines. When the snapped line spans several addresses, the LOWEST
  // one wins (the line's first instruction). Returns { addr, line } or null.
  // By default resolves in the ACTIVE composed view; pass `module` ('R' or an
  // overlay id) to restrict to that module's own lines — breakpoint binding
  // resolves a shared file in EACH owning overlay, whatever is active.
  function addrForLine(file, reqLine, module) {
    let afterAddr = -1, afterLine = Infinity, beforeAddr = -1, beforeLine = -1;
    for (const l of lines) {
      if (module !== undefined ? l.module !== module : !inView(l.module, activeModule)) continue;
      if (!samePathLoose(l.file, file)) continue;
      if (l.line >= reqLine && (l.line < afterLine || (l.line === afterLine && l.addr < afterAddr)))
        { afterLine = l.line; afterAddr = l.addr; }
      if (l.line <= reqLine && (l.line > beforeLine || (l.line === beforeLine && l.addr < beforeAddr)))
        { beforeLine = l.line; beforeAddr = l.addr; }
    }
    if (afterAddr >= 0) return { addr: afterAddr, line: afterLine };
    if (beforeAddr >= 0) return { addr: beforeAddr, line: beforeLine };
    return null;
  }

  // Stepping helper: address of the next DIFFERENT source line of `file`
  // strictly after `pc` — the temp-breakpoint target for source-level
  // step-over. Walks line addresses upward; stops (-1) at the first address
  // with no entry for the file at all (left the function/file — the caller
  // falls back to instruction stepping).
  function nextLineAddr(pc, file, line) {
    const v = view();
    for (let a = nextAddr(v.lineAddrs, pc); a >= 0; a = nextAddr(v.lineAddrs, a)) {
      let sawFile = false;
      for (const l of v.linesByAddr.get(a)) {
        if (!samePathLoose(l.file, file)) continue;
        sawFile = true;
        if (l.line !== line) return a;
      }
      if (!sawFile) return -1;
    }
    return -1;
  }

  // Best-effort DEFINITION site of a symbol. The #SYM location is only the
  // name's FIRST TEXTUAL OCCURRENCE — for exported labels that is often a mere
  // reference (`lda _OverlayBufferEnd`, `jmp _LoaderResidentStart`), not the
  // definition. Trust the decl only when its line TEXT defines the name (label
  // in leading position, which also covers `name = expr`); otherwise prefer the
  // symbol's own unit's #LINES entry at its address (the storage/code line right
  // at the label); else the decl as-is. Exact everywhere once XA records real
  // definition lines.
  function defSiteOf(sym, v) {
    const defines = new RegExp('^\\s*' + sym.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (sym.symFile && sym.symLine) {
      const text = readSourceLine(sym.symFile, sym.symLine);
      if (text == null) return { file: sym.symFile, line: sym.symLine }; // unreadable: trust it
      if (defines.test(stripComment(text))) return { file: sym.symFile, line: sym.symLine };
    }
    const here = v.linesByAddr.get(sym.addr);
    if (here) for (const l of here) if (l.uid === sym.uid) {
      // The entry marks the code/storage AT the address; a bare label defining
      // the name emits no #LINES entry of its own and sits at or a few lines
      // above — scan up for the line that actually starts with the name.
      for (let ln = l.line; ln >= Math.max(1, l.line - 8); ln--) {
        const t = readSourceLine(l.file, ln);
        if (t != null && defines.test(stripComment(t))) return { file: l.file, line: ln };
      }
      return { file: l.file, line: l.line };
    }
    return sym.symFile ? { file: sym.symFile, line: sym.symLine } : null;
  }

  // Definition site of a symbol by NAME in the active view (first declaration
  // wins among duplicates). Spec §6; the symbol browser navigates per-alias
  // through it (Step D).
  function declOf(name) {
    const v = view();
    const sym = v.declByName.get(name);
    return sym ? defSiteOf(sym, v) : null;
  }

  function setActiveModule(id) { activeModule = (id === undefined ? null : id); } // keep explicit: module 0 is falsy but valid
  function aliasedAddresses() { return view().aliased.slice(); } // already sorted ascending

  return { resolve, addrForLine, nextLineAddr, declOf, setActiveModule, aliasedAddresses };
}

module.exports = { buildResolver };
