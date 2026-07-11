#!/usr/bin/env node
// Offline golden test for the single-source-of-truth address resolver (SPEC-address-resolver.md §8).
//
// Diffs the resolver's decisions against test/resolver.golden.json — an INDEPENDENT oracle
// computed by Fable (gen_golden.cjs) under spec v3 §5.3/§5.4, NOT derived from resolver.cjs.
// Runs with plain `node`, no emulator, no VS Code:
//
//     node test/resolver.golden.test.cjs [symbolFile]
//     NOVA_SYM=/path/to/symbols_ext_combined node test/resolver.golden.test.cjs
//
// Exit codes:  0 = all pass   1 = golden mismatch   2 = resolver.cjs not implemented yet (test-first)
//
// Requires the §6.0 pure module:
//     buildResolver(symbolFileText, { readSourceLine, sourceRoot, workspaceFolder }) → resolver
//     resolver.setActiveModule(id) ; resolver.resolve(addr) ; resolver.aliasedAddresses()
// resolver.cjs does not exist yet — this test is expected to exit 2 until it lands.

const fs = require('fs');
const path = require('path');

const SYM = process.argv[2] || process.env.NOVA_SYM || 'E:/git/Nova2026/build/symbols_ext_combined';
const GOLDEN = path.join(__dirname, 'resolver.golden.json');
const NOVA_ROOT = process.env.NOVA_ROOT || 'E:/git/Nova2026';

// --- helpers -------------------------------------------------------------
function fail(msg, code){ process.stderr.write(msg + '\n'); process.exit(code); }

// canonPath-equivalent for cross-platform path comparison (matches the extension's convention:
// case-insensitive on Windows/macOS, forward-slash normalized). Comparison-only.
function canon(p){
  if (p == null) return p;
  let s = String(p).replace(/\\/g, '/');
  if (process.platform === 'win32' || process.platform === 'darwin') s = s.toLowerCase();
  return s;
}
function samePath(a, b){
  if (a == null || b == null) return a === b;
  return canon(a) === canon(b);
}

// Fixture source reader injected into buildResolver (adapter uses getSourceLine; test reads real files).
const srcCache = Object.create(null);
function readSourceLine(absFile, line1){
  if (!(absFile in srcCache)){
    try { srcCache[absFile] = fs.readFileSync(absFile, 'utf8').split(/\r?\n/); }
    catch (_) { srcCache[absFile] = null; }
  }
  const arr = srcCache[absFile];
  if (!arr) return null;
  return (line1 >= 1 && line1 <= arr.length) ? arr[line1 - 1] : null;
}

// --- load inputs ---------------------------------------------------------
let symbolText, golden;
try { symbolText = fs.readFileSync(SYM, 'utf8'); }
catch (e) { fail('FATAL: cannot read symbol file "' + SYM + '": ' + e.message +
  '\n  Set NOVA_SYM or pass the path as argv[1].', 2); }
try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); }
catch (e) { fail('FATAL: cannot read golden "' + GOLDEN + '": ' + e.message, 2); }

// --- require the resolver (test-first: may not exist yet) ----------------
let buildResolver;
try { ({ buildResolver } = require('../resolver.cjs')); }
catch (e) {
  process.stderr.write(
    'resolver.cjs not available yet — this is expected before it is implemented (test-first).\n' +
    '  Implement the §6.0 interface:\n' +
    '    module.exports.buildResolver(symbolFileText, { readSourceLine, sourceRoot, workspaceFolder })\n' +
    '  then re-run this test. (' + e.message + ')\n');
  process.exit(2);
}
if (typeof buildResolver !== 'function') fail('resolver.cjs does not export buildResolver()', 2);

const resolver = buildResolver(symbolText, {
  readSourceLine,
  sourceRoot: undefined,
  workspaceFolder: NOVA_ROOT,
});
for (const fn of ['resolve', 'setActiveModule']) {
  if (typeof resolver[fn] !== 'function') fail('resolver missing required method: ' + fn + '()', 2);
}

// --- comparison ----------------------------------------------------------
// Map a resolve() record to the golden's flat shape.
function normalizeRecord(rec){
  const sym = rec && rec.symbol;
  const src = rec && rec.source;
  const aliases = (sym && Array.isArray(sym.aliases))
    ? sym.aliases.map(a => (typeof a === 'string' ? a : a.name)).slice().sort()
    : [];
  return {
    name: sym ? sym.name : null,
    file: src ? src.file : null,
    line: src ? src.line : null,
    kind: rec ? rec.kind : null,
    aliases,
  };
}
function diffOne(view, key, want, rec){
  const got = normalizeRecord(rec);
  const wName = want.owner ? want.owner.name : null;
  const wFile = want.owner ? want.owner.file : null;
  const wLine = want.owner ? want.owner.line : null;
  const problems = [];
  if (got.name !== wName) problems.push('name: got ' + JSON.stringify(got.name) + ' want ' + JSON.stringify(wName));
  if (!samePath(got.file, wFile)) problems.push('file: got ' + JSON.stringify(got.file) + ' want ' + JSON.stringify(wFile));
  if (got.line !== wLine) problems.push('line: got ' + JSON.stringify(got.line) + ' want ' + JSON.stringify(wLine));
  if (got.kind !== want.kind) problems.push('kind: got ' + JSON.stringify(got.kind) + ' want ' + JSON.stringify(want.kind));
  const wAlias = (want.aliases || []).slice().sort();
  if (JSON.stringify(got.aliases) !== JSON.stringify(wAlias))
    problems.push('aliases: got ' + JSON.stringify(got.aliases) + ' want ' + JSON.stringify(wAlias));
  return problems;
}

// --- anchors (called out explicitly per the task) ------------------------
const ANCHORS = [
  { view:'R',   addr:0xfd40, want:'_LoaderResidentStart', notWant:null,                  desc:'loader.asm:150 (real jsr, NOT kernel.s:734)' },
  { view:'R+0', addr:0x0070, want:'_flash_idx',           notWant:'ZpCommonEnd',         desc:'active real ZP var, NOT the ZpCommonEnd boundary marker' },
  { view:'R+1', addr:0x8740, want:'_EndModule',           notWant:'_EndBSS',             desc:'_EndModule, NOT the _EndBSS = * alias' },
  { view:'R+3', addr:0x3298, want:'_DotIdx',              notWant:'_TextScrollCodeEnd',  desc:'_DotIdx .byt, NOT the _TextScrollCodeEnd code-end marker' },
];

// --- run -----------------------------------------------------------------
let totalChecked = 0, totalFail = 0;
const viewNames = Object.keys(golden.views);
process.stderr.write('Golden: ' + GOLDEN + '\nSymbols: ' + SYM + '\n\n');

for (const view of viewNames){
  const v = golden.views[view];
  resolver.setActiveModule(v.module);
  let checked = 0, failed = 0;
  const addrKeys = Object.keys(v.addresses);
  for (const key of addrKeys){
    const want = v.addresses[key];
    const addr = want.addr;
    let rec;
    try { rec = resolver.resolve(addr); }
    catch (e) { process.stderr.write('  [' + view + '] $' + key + ' resolve() THREW: ' + e.message + '\n'); failed++; checked++; continue; }
    const problems = diffOne(view, key, want, rec);
    checked++;
    if (problems.length){
      failed++;
      if (failed <= 30){
        process.stderr.write('  [' + view + '] MISMATCH $' + key + ' (addr ' + addr + ')\n');
        for (const p of problems) process.stderr.write('      ' + p + '\n');
      }
    }
  }
  totalChecked += checked; totalFail += failed;
  process.stderr.write('View ' + view.padEnd(5) + ' (module=' + JSON.stringify(v.module) + '): ' +
    (checked - failed) + '/' + checked + ' pass' + (failed ? ('  *** ' + failed + ' FAIL ***') : '') + '\n');
}

// --- anchor callouts -----------------------------------------------------
process.stderr.write('\n--- Regression anchors ---\n');
let anchorFail = 0;
for (const a of ANCHORS){
  resolver.setActiveModule(golden.views[a.view].module);
  let rec; try { rec = resolver.resolve(a.addr); } catch (e) { rec = null; }
  const got = normalizeRecord(rec);
  const key = a.addr.toString(16).padStart(4,'0');
  const okName = got.name === a.want;
  const okNot  = a.notWant == null || got.name !== a.notWant;
  const ok = okName && okNot;
  if (!ok) anchorFail++;
  process.stderr.write('  [' + (ok ? 'PASS' : 'FAIL') + '] [' + a.view + '] $' + key +
    ' → ' + JSON.stringify(got.name) +
    (got.file ? ' @ ' + path.basename(got.file) + ':' + got.line : '') +
    '   (want ' + a.want + (a.notWant ? ', not ' + a.notWant : '') + ' — ' + a.desc + ')\n');
}

// --- verdict -------------------------------------------------------------
process.stderr.write('\n=========================================================\n');
process.stderr.write('TOTAL: ' + (totalChecked - totalFail) + '/' + totalChecked + ' aliased addresses pass across ' +
  viewNames.length + ' views.  Anchor failures: ' + anchorFail + '\n');
if (totalFail || anchorFail){
  process.stderr.write('RESULT: FAIL\n');
  process.exit(1);
}
process.stderr.write('RESULT: PASS\n');
process.exit(0);
