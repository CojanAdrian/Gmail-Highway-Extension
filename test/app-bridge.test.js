const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Runs app-bridge.js in a fake page with a fake chrome API and records what
// it tells the page and the background.
function setup({ ignore = [], lookup = () => ({ pending: true }) } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://bulkposting.example.com/inquiries', runScripts: 'outside-only' });
  const win = dom.window;
  const toBackground = [];
  const listeners = [];
  win.chrome = {
    storage: { sync: { get: async () => ({ ignore }) }, onChanged: { addListener() {} } },
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      sendMessage: async (msg) => {
        toBackground.push(msg);
        if (msg.type === 'state') return { loginNeeded: false };
        if (msg.type === 'lookup') return lookup(msg);
        if (msg.type === 'dat-list') return { carriers: [{ mc: '884213', name: 'REDLINE HAUL', emails: ['dispatch@redline.com'], phones: [], at: 5 }] };
        return { ok: true };
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  win.eval(fs.readFileSync(path.join(__dirname, '../extension/src/mc.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(__dirname, '../extension/src/app-bridge.js'), 'utf8'));
  const toPage = [];
  win.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'mc-check') toPage.push(e.data);
  });
  // Delivered as a browser does: source is the page's own window.
  const post = (msg) => win.dispatchEvent(new win.MessageEvent('message', { data: { source: 'bulkposting', ...msg }, source: win, origin: win.location.origin }));
  const tick = () => new Promise((r) => setTimeout(r, 30));
  return { win, toBackground, toPage, listeners, post, tick };
}

test('announces itself to the page', async () => {
  const b = setup();
  await b.tick();
  assert.ok(b.toPage.some((m) => m.type === 'ready' && m.version === '9.9.9'));
});

test('skips ignored MC#s, looks up the next and passes the cached result back', async () => {
  const b = setup({ ignore: ['689501'], lookup: () => ({ result: { status: 'pass', label: 'Pass' } }) });
  await b.tick();
  b.post({ type: 'lookup', key: 'inq-7', mcs: ['689501', '123456'] });
  await b.tick();
  const picked = b.toPage.find((m) => m.type === 'picked');
  assert.equal(picked.key, 'inq-7');
  assert.equal(picked.mc, '123456');
  assert.ok(b.toBackground.some((m) => m.type === 'lookup' && m.mc === '123456' && m.from === 'app'));
  assert.equal(b.toPage.find((m) => m.type === 'result').result.status, 'pass');
});

test('forwards results that arrive later from the background', async () => {
  const b = setup();
  await b.tick();
  b.listeners.forEach((fn) => fn({ type: 'result', mc: '55', result: { status: 'fail', label: 'Fail' } }));
  await b.tick();
  assert.ok(b.toPage.some((m) => m.type === 'result' && m.mc === '55' && m.result.status === 'fail'));
});

test('answers with no MC# when every one is ignored', async () => {
  const b = setup({ ignore: ['1'] });
  await b.tick();
  b.post({ type: 'lookup', key: 'k', mcs: ['1'] });
  await b.tick();
  assert.equal(b.toPage.find((m) => m.type === 'picked').mc, null);
  assert.ok(!b.toBackground.some((m) => m.type === 'lookup'));
});

test('hands DAT carriers to the page, asked for and as they arrive', async () => {
  const b = setup();
  await b.tick();
  b.post({ type: 'dat-list', since: 0 });
  await b.tick();
  const listed = b.toPage.find((m) => m.type === 'dat-carriers');
  assert.equal(listed.carriers[0].emails[0], 'dispatch@redline.com');
  b.listeners.forEach((fn) => fn({ type: 'dat-carriers', carriers: [{ mc: '55', name: 'NEW', emails: [], phones: [], at: 9 }] }));
  await b.tick();
  assert.equal(b.toPage.filter((m) => m.type === 'dat-carriers').length, 2);
});
