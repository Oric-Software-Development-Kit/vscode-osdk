#!/usr/bin/env node
// Offline nearest-below test for the address resolver (SPEC-address-resolver.md §5.7).
//
// Additive to resolver.golden.test.cjs. The golden covers EXACT aliased addresses;
// this covers ARBITRARY mid-routine PCs (nearest symbol below + nearest line below,
// gated by plausible()). Fixture = test/resolver.nearest.json, computed by an
// INDEPENDENT §5.7 implementation and hand-verified, NOT derived from resolver.cjs.
//
//     node test/resolver.nearest.test.cjs [symbolFile]
//     NOVA_SYM=/path/to/symbols_ext_combined node test/resolver.nearest.test.cjs
//
// Exit: 0 = all pass  1 = mismatch  2 = resolver.cjs not implemented yet / inputs missing.

const fs = require('fs');
const path = require('path');

const SYM = process.argv[2] || process.env.NOVA_SYM || 'E:/git/Nova2026/build/symbols_ext_combined';
const FIXTURE = path.join(__dirname, 'resolver.nearest.json');
const NOVA_ROOT = process.env.NOVA_ROOT || 'E:/git/Nova2026';

function fail(msg, code) { process.stderr.write(msg + '\n'); process.exit(code); }

// Fixture source reader injected into buildResolver (adapter uses getSourceLine).
const srcCache = Object.create(null);
function readSourceLine(absFile, line1) {
  if (!(absFile in srcCache)) {
    try { srcCache[absFile] = fs.readFileSync(absFile, 'utf8').split(/\r?\n/); }
    catch (_) { srcCache[absFile] = null; }
  }
  const arr = srcCache[absFile];
  if (!arr) return null;
  return (line1 >= 1 && line1 <= arr.length) ? arr[line1 - 1] : null;
}

let symbolText, fixture;
try { symbolText = fs.readFileSync(SYM, 'utf8'); }
catch (e) { fail('FATAL: cannot read symbol file "' + SYM + '": ' + e.message + '\n  Set NOVA_SYM or pass the path as argv[1].', 2); }
try { fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); }
catch (e) { fail('FATAL: cannot read fixture "' + FIXTURE + '": ' + e.message, 2); }

let buildResolver;
try { ({ buildResolver } = require('../resolver.cjs')); }
catch (e) {
  process.stderr.write(
    'resolver.cjs not available yet — expected before it is implemented (test-first).\n' +
    '  Implement §6.0 buildResolver(...) then re-run. (' + e.message + ')\n');
  process.exit(2);
}
if (typeof buildResolver !== 'function') fail('resolver.cjs does not export buildResolver()', 2);

const resolver = buildResolver(symbolText, { readSourceLine, sourceRoot: undefined, workspaceFolder: NOVA_ROOT });
for (const fn of ['resolve', 'setActiveModule']) {
  if (typeof resolver[fn] !== 'function') fail('resolver missing required method: ' + fn + '()', 2);
}

// --- comparison helpers --------------------------------------------------
const hex = n => (typeof n === 'number' ? n.toString(16).padStart(4, '0') : n);
// Source is compared by basename + line (full-path plumbing is covered by the golden).
function sourceMatches(want, gotSource) {
  if (want == null) return gotSource == null;
  if (gotSource == null) return false;
  return path.basename(String(gotSource.file || '')).toLowerCase() === String(want.file).toLowerCase()
      && gotSource.line === want.line;
}

let total = 0, failed = 0;
process.stderr.write('Fixture: ' + FIXTURE + '\nSymbols: ' + SYM + '\n\n');

for (const c of fixture.cases) {
  total++;
  resolver.setActiveModule(c.module);
  const addr = parseInt(c.addr, 16);
  let rec;
  try { rec = resolver.resolve(addr); }
  catch (e) { process.stderr.write('[FAIL] ' + c.name + '\n    resolve($' + c.addr + ') THREW: ' + e.message + '\n'); failed++; continue; }

  const w = c.expect;
  const sym = rec && rec.symbol;
  const gotName = sym ? sym.name : null;
  const gotBase = sym ? hex(sym.base) : null;
  const gotOff = sym ? sym.offset : null;

  const problems = [];
  if (gotName !== (w.name === undefined ? null : w.name)) problems.push('name: got ' + JSON.stringify(gotName) + ' want ' + JSON.stringify(w.name ?? null));
  if (w.base != null || gotBase != null) { if (gotBase !== (w.base ?? null)) problems.push('base: got ' + JSON.stringify(gotBase) + ' want ' + JSON.stringify(w.base ?? null)); }
  if (w.offset != null || gotOff != null) { if (gotOff !== (w.offset ?? null)) problems.push('offset: got ' + JSON.stringify(gotOff) + ' want ' + JSON.stringify(w.offset ?? null)); }
  if (!sourceMatches(w.source ?? null, rec ? rec.source : null))
    problems.push('source: got ' + JSON.stringify(rec ? rec.source : null) + ' want ' + JSON.stringify(w.source ?? null));
  if ((rec ? rec.kind : null) !== w.kind) problems.push('kind: got ' + JSON.stringify(rec ? rec.kind : null) + ' want ' + JSON.stringify(w.kind));
  if ((rec ? rec.module : null) !== w.module) problems.push('module: got ' + JSON.stringify(rec ? rec.module : null) + ' want ' + JSON.stringify(w.module));

  if (problems.length) {
    failed++;
    process.stderr.write('[FAIL] $' + c.addr + '  ' + c.name + '\n');
    for (const p of problems) process.stderr.write('    ' + p + '\n');
  } else {
    const shown = gotName ? (gotName + '+$' + gotOff + ' @ ' + (rec.source ? path.basename(rec.source.file) + ':' + rec.source.line : '-') + ' [' + rec.kind + ']')
                          : '(no owner/source — gate rejected) [' + rec.kind + ']';
    process.stderr.write('[PASS] $' + c.addr + '  ' + c.name + '\n       -> ' + shown + '\n');
  }
}

process.stderr.write('\n=========================================================\n');
process.stderr.write('NEAREST-BELOW: ' + (total - failed) + '/' + total + ' cases pass.\n');
if (failed) { process.stderr.write('RESULT: FAIL\n'); process.exit(1); }
process.stderr.write('RESULT: PASS\n');
process.exit(0);
