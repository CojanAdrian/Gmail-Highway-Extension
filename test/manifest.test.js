const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));

// Chrome injects an identical file only once per frame, so a file listed for
// both the MAIN and the ISOLATED world on the same site only runs in one of them.
test('no script file is listed in both MAIN and ISOLATED worlds for the same site', () => {
  const entries = m.content_scripts.map((c) => ({ world: c.world || 'ISOLATED', matches: c.matches, js: c.js }));
  for (const a of entries) {
    for (const b of entries) {
      if (a.world === b.world) continue;
      if (!a.matches.some((x) => b.matches.includes(x))) continue;
      const shared = a.js.filter((f) => b.js.includes(f));
      assert.deepEqual(shared, [], `shared between ${a.world} and ${b.world} on ${a.matches}`);
    }
  }
});

test('every referenced file exists', () => {
  for (const c of m.content_scripts) {
    for (const f of [...c.js, ...(c.css || [])]) {
      assert.ok(fs.existsSync(path.join(__dirname, '../extension', f)), f);
    }
  }
});
