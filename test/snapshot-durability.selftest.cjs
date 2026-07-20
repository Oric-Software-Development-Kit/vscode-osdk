'use strict';
/* snapshot-durability.selftest — guards two invariants that a data-loss incident exposed:
 *   1. User snapshots are NEVER bulk-deleted by an automatic path (staleness / rebuild / launch).
 *   2. There is no manifest: the .oric-snapshots DIRECTORY is the single source of truth, so a
 *      copied-in file appears and nothing silently loses track of a save.
 * The adapter's snapshot code isn't independently unit-testable (module-global state), so this
 * scans debug_adapter.js for the dangerous / removed shapes. Deterministic and fast. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'debug_adapter.js'), 'utf8');

function bodyOf(fnName) {
    const i = src.indexOf('function ' + fnName + '(');
    assert.ok(i >= 0, fnName + ' not found');
    let j = src.indexOf('{', i), depth = 0, k = j;
    for (; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) break; }
    return src.slice(j, k + 1);
}

// 1. No destructive bulk-delete primitive, and no launch-time prune.
assert.ok(!/discardAllSnapshots\s*\(/.test(src), 'no discardAllSnapshots (destructive bulk-delete) may exist or be called');
assert.ok(!/pruneStaleSnapshots\s*\(/.test(src), 'no pruneStaleSnapshots (auto-invalidation) may exist or be called');

// 2. The manifest is gone — the directory is the source of truth.
assert.ok(!/manifest\.json/.test(src), 'no manifest.json — the directory is the single source of truth');
assert.ok(!/readSnapshotManifest|writeSnapshotManifest|reconcileSnapshotManifest/.test(src), 'no manifest read/write/reconcile functions');

// 3. Baseline invalidation touches ONLY the baseline.
const inval = bodyOf('invalidateBaseline');
const invalUnlinks = inval.match(/fs\.unlinkSync\([^)]*\)/g) || [];
assert.strictEqual(invalUnlinks.length, 1, 'invalidateBaseline unlinks exactly one file');
assert.ok(/BASELINE/.test(invalUnlinks[0]), 'invalidateBaseline unlinks the BASELINE, not a user snapshot');

// 4. Every snapshot-file unlink is the BASELINE or the single explicit delete (a bare `name`) —
//    never a loop over many.
const allUnlinks = src.match(/fs\.unlinkSync\(snapshotFile\([^)]*\)\)/g) || [];
for (const u of allUnlinks) {
    assert.ok(/BASELINE|\(\s*name\s*\)/.test(u), 'unexpected snapshot unlink (only BASELINE / explicit single delete allowed): ' + u);
}
assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*unlinkSync\(snapshotFile/.test(src.replace(/\n/g, ' ')), 'no loop may unlink snapshot files');

console.log('SNAPSHOT-DURABILITY SELFTEST: PASS (' + allUnlinks.length + ' guarded unlink site(s), no manifest)');
