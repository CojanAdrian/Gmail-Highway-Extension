// The DAT page hook (dat-main.js): learns a truck search while you make it,
// then sends it again for another lane with the page's own login.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const R = require('../extension/src/dat-replay.js');

const src = (f) => fs.readFileSync(path.join(__dirname, '../extension/src', f), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 20));

const LANE = { originCity: 'Chicago', originState: 'IL', originLat: 41.88, originLng: -87.63, destCity: 'Dallas', destState: 'TX', destLat: 32.78, destLng: -96.8, pickupDate: '2026-11-18', equipment: 'V' };
const NEXT = { originCity: 'Denver', originState: 'CO', originLat: 39.74, originLng: -104.99, destCity: 'Atlanta', destState: 'GA', destLat: 33.75, destLng: -84.39, pickupDate: '2026-11-20', equipment: 'R' };

function page() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://one.dat.com/search-trucks', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  // DAT's server: a search is created, then its matches are fetched.
  w.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    let body = '{"ok":true}';
    if (/graphql/.test(url)) {
      const v = JSON.parse(init.body).variables;
      body = JSON.stringify({ data: { createSearch: { id: 'srch-' + v.origin.city.slice(0, 3) + '-1001' } } });
    } else if (/matches/.test(url)) {
      body = JSON.stringify({ data: { matches: [{ id: 'm1', carrierMcNumber: 123456, companyName: 'ACME TRUCKING', contact: { email: 'dispatch@acme.com' } }] } });
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const posts = [];
  w.addEventListener('message', (e) => e.data && e.data.source === 'mcx-dat' && posts.push(e.data));
  w.eval(src('dat-extract.js'));
  w.eval(src('dat-replay.js'));
  w.eval(src('dat-main.js'));
  const cmd = (msg) => w.dispatchEvent(new w.MessageEvent('message', { data: { source: 'mcx-dat-cmd', ...msg }, source: w }));
  return { w, calls, posts, cmd };
}

async function search(w, lane) {
  const headers = { 'content-type': 'application/json', authorization: 'Bearer TOKEN-1' };
  const created = await (await w.fetch('https://freight.api.dat.com/graphql', { method: 'POST', headers, body: JSON.stringify({ query: 'mutation', variables: { origin: { city: lane.originCity, state: lane.originState }, destination: { city: lane.destCity, state: lane.destState }, equipment: [lane.equipment], date: lane.pickupDate } }) })).json();
  await w.fetch(`https://freight.api.dat.com/searches/${created.data.createSearch.id}/matches`, { headers });
}

test('learns a search while you make it and runs it for another lane', async () => {
  const { w, calls, posts, cmd } = page();
  cmd({ kind: 'learn', on: true });
  await tick();
  await search(w, LANE);
  for (let i = 0; i < 5; i++) await tick();
  const learned = posts.find((p) => p.kind === 'learn-steps');
  assert.ok(learned, 'the steps were handed over');
  assert.ok(!JSON.stringify(learned.steps).includes('TOKEN-1'), 'no login header kept');
  assert.ok(posts.some((p) => p.kind === 'login-seen' && p.host === 'freight.api.dat.com'));

  const built = R.buildRecipe(learned.steps, LANE);
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.recipe.steps.length, 2);

  calls.length = 0;
  cmd({ kind: 'replay', id: 'r1', recipe: built.recipe, lane: NEXT });
  for (let i = 0; i < 10; i++) await tick();
  const done = posts.find((p) => p.kind === 'replay-done' && p.id === 'r1');
  assert.ok(done && done.ok, JSON.stringify(done));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.authorization, 'Bearer TOKEN-1', 'the page login is used');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body).variables.origin, { city: 'Denver', state: 'CO' });
  assert.equal(calls[1].url, 'https://freight.api.dat.com/searches/srch-Den-1001/matches');
  assert.equal(done.carriers[0].mc, '123456');
  assert.ok(done.carriers[0].contacts.includes('dispatch@acme.com'));
});

test('nothing is kept when not learning', async () => {
  const { w, posts } = page();
  await search(w, LANE);
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(!posts.some((p) => p.kind === 'learn-steps'));
  assert.ok(posts.some((p) => p.kind === 'carriers'), 'carriers are still read as before');
});
