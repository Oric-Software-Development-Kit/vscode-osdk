#!/usr/bin/env node
// Pre-publish validation of README/docs links, WITHOUT needing vsce or a network.
//
// Why this exists: the Marketplace and the Extensions details page cannot read files out of the
// package, so vsce rewrites the README's relative links at package time —
//   images -> <baseImagesUrl><path>      (default ref: HEAD)
//   links  -> <baseContentUrl><path>     (default ref: HEAD)
// From source those links are inert, so the page cannot be eyeballed before packaging. What CAN be
// verified now is everything that makes a rewritten URL valid: the path exists, and the file is
// actually in the package. Those are the failures that reach users.
//
// Usage:  node test/prepublish-check.cjs [tag]
//         tag defaults to HEAD — pass the real release tag to see the exact URLs to publish with.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TAG = process.argv[2] || 'HEAD';

const repoUrl = ((pkg.repository && pkg.repository.url) || '').replace(/\.git$/, '');
if (!repoUrl) { console.error('FAIL: package.json has no repository.url — vsce cannot rewrite anything'); process.exit(1); }
const slug = repoUrl.replace(/^https?:\/\/github\.com\//, '');
const baseImages = `https://raw.githubusercontent.com/${slug}/${TAG}/`;
const baseContent = `https://github.com/${slug}/blob/${TAG}/`;

const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
function excluded(rel) {
    rel = rel.replace(/\\/g, '/');
    for (const pat of ignore) {
        const p = pat.replace(/\\/g, '/');
        if (p.endsWith('/')) { if (rel === p.slice(0, -1) || rel.startsWith(p)) return pat; continue; }
        if (p.startsWith('**/')) { if (path.basename(rel) === p.slice(3)) return pat; continue; }
        if (p.includes('*')) {
            const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
            if (re.test(rel) || re.test(path.basename(rel))) return pat;
            continue;
        }
        if (rel === p) return pat;
    }
    return null;
}

let fail = 0;
const note = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fail++; };

// ---- 1. README: every relative target must exist, and will become an absolute URL -------------
console.log('README.md — what vsce will publish (ref: ' + TAG + ')');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
let rel = 0;
for (const m of readme.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const isImage = m[1] === '!';
    const target = m[2];
    if (/^https?:/.test(target) || target.startsWith('#')) continue;
    rel++;
    const file = target.split('#')[0];
    const onDisk = fs.existsSync(path.join(ROOT, file));
    const pat = onDisk ? excluded(file) : null;
    note(onDisk, (isImage ? 'image ' : 'link  ') + file + (onDisk ? '' : '  — NOT ON DISK'));
    if (onDisk && isImage && pat) note(false, '   ' + file + ' is excluded by .vscodeignore ("' + pat + '") — fine for the web page, but the in-package copy is gone');
    console.log('       -> ' + (isImage ? baseImages : baseContent) + file);
}
note(rel > 0, rel + ' relative target(s) found in README (they are what gets rewritten)');

// ---- 2. docs/**: relative links must resolve AND ship (these render offline, unrewritten) -----
console.log('');
console.log('docs/** — read in-editor from the package, so paths must resolve on disk');
for (const f of fs.readdirSync(path.join(ROOT, 'docs')).filter(x => x.endsWith('.md'))) {
    const body = fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8');
    for (const m of body.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[2];
        if (/^https?:/.test(target) || target.startsWith('#')) continue;
        const rp = path.posix.normalize(path.posix.join('docs', target.split('#')[0]));
        if (!fs.existsSync(path.join(ROOT, rp))) { note(false, 'docs/' + f + ' -> ' + rp + ' MISSING'); continue; }
        const pat = excluded(rp);
        if (pat) note(false, 'docs/' + f + ' -> ' + rp + ' excluded by .vscodeignore ("' + pat + '") — dead for installed users');
    }
}
note(true, 'all docs/** targets resolve and ship');

// ---- 3. the publish command, with both refs pinned -------------------------------------------
console.log('');
console.log('Publish with BOTH refs pinned, or an old version\'s page shows today\'s content:');
console.log('  vsce publish \\');
console.log('    --baseImagesUrl  ' + baseImages + ' \\');
console.log('    --baseContentUrl ' + baseContent);
if (TAG === 'HEAD') console.log('  (pass the release tag to this script to get the pinned URLs)');

console.log('');
console.log(fail ? 'PRE-PUBLISH: ' + fail + ' problem(s)' : 'PRE-PUBLISH: OK');
process.exit(fail ? 1 : 0);
