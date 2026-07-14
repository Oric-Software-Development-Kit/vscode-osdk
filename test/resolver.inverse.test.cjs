#!/usr/bin/env node
// Offline inverse-mapping test for the address resolver (SPEC §5.6):
// addrForLine(file, line) and nextLineAddr(pc, file, line).
//
// Additive to resolver.golden.test.cjs (exact addr->owner) and
// resolver.nearest.test.cjs (mid-routine PCs). Fixture = resolver.inverse.json,
// computed by an INDEPENDENT parse of the symbol file and hand-verified, NOT
// derived from resolver.cjs. Key anchor: a breakpoint on kernel.s:734 must bind
// to $FD40 with KERNEL intent (spec §8) even though the address is aliased.
//
//     node test/resolver.inverse.test.cjs [symbolFile]
//     NOVA_SYM=/path/to/symbols_ext_combined node test/resolver.inverse.test.cjs
//
// Exit: 0 = all pass  1 = mismatch  2 = inputs missing / API not implemented.

const fs = require('fs');
const path = require('path');

const SYM = process.argv[2] || process.env.NOVA_SYM || 'E:/git/Nova2026/build/symbols_ext_combined';
const FIXTURE = path.join(__dirname, 'resolver.inverse.json');
const NOVA_ROOT = process.env.NOVA_ROOT || 'E:/git/Nova2026';

function fail(msg, code) { process.stderr.write(msg + '\n'); process.exit(code); }

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
catch (e) { fail('cannot load resolver.cjs: ' + e.message, 2); }

const resolver = buildResolver(symbolText, { readSourceLine, sourceRoot: undefined, workspaceFolder: NOVA_ROOT });
for (const fn of ['addrForLine', 'nextLineAddr', 'declOf', 'setActiveModule']) {
  if (typeof resolver[fn] !== 'function') fail('resolver missing required method: ' + fn + '()', 2);
}

// Fixture files are basenames; resolve each to the full path recorded in the
// symbol file's #FILES tables (the resolver compares full paths, as the
// adapter passes them). Unknown basenames stay as-is (the "unknown file" case).
const fullPathByBase = new Map();
for (const m of symbolText.matchAll(/^\d+\s+(.+)$/gm)) {
  const p = m[1].trim();
  const b = p.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!fullPathByBase.has(b)) fullPathByBase.set(b, p);
}
const toFull = f => fullPathByBase.get(String(f).toLowerCase()) || f;

const hex = n => n.toString(16).padStart(4, '0');
let total = 0, failed = 0;
process.stderr.write('Fixture: ' + FIXTURE + '\nSymbols: ' + SYM + '\n\n');

for (const c of fixture.cases) {
  total++;
  resolver.setActiveModule(c.module);
  let got, shown, ok;
  try {
    if (c.fn === 'addrForLine') {
      got = resolver.addrForLine(toFull(c.file), c.line);
      ok = c.expect === null ? got === null
         : !!got && hex(got.addr) === c.expect.addr && got.line === c.expect.line;
      shown = got ? '$' + hex(got.addr) + ' (line ' + got.line + ')' : 'null';
    } else if (c.fn === 'nextLineAddr') {
      got = resolver.nextLineAddr(parseInt(c.pc, 16), toFull(c.file), c.line);
      ok = (c.expect === -1) ? got === -1 : got >= 0 && hex(got) === c.expect;
      shown = got === -1 ? '-1' : '$' + hex(got);
    } else if (c.fn === 'declOf') {
      got = resolver.declOf(c.symbol);
      const gotBase = got ? path.basename(String(got.file)).toLowerCase() : null;
      ok = c.expect === null ? got === null
         : !!got && gotBase === c.expect.file.toLowerCase() && got.line === c.expect.line;
      shown = got ? gotBase + ':' + got.line : 'null';
    } else { throw new Error('unknown fn ' + c.fn); }
  } catch (e) {
    process.stderr.write('[FAIL] ' + c.name + '\n    THREW: ' + e.message + '\n'); failed++; continue;
  }
  if (ok) process.stderr.write('[PASS] ' + c.name + '\n       -> ' + shown + '\n');
  else { failed++; process.stderr.write('[FAIL] ' + c.name + '\n    got ' + shown + '  want ' + JSON.stringify(c.expect) + '\n'); }
}

process.stderr.write('\n=========================================================\n');
process.stderr.write('INVERSE: ' + (total - failed) + '/' + total + ' cases pass.\n');
if (failed) { process.stderr.write('RESULT: FAIL\n'); process.exit(1); }
process.stderr.write('RESULT: PASS\n');
process.exit(0);
