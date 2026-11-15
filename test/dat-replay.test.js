const test = require('node:test');
const assert = require('node:assert');
const R = require('../extension/src/dat-replay.js');

const LEARNED = {
  originCity: 'Chicago', originState: 'IL', originLat: 41.8781, originLng: -87.6298,
  destCity: 'Dallas', destState: 'TX', destLat: 32.7767, destLng: -96.797,
  pickupDate: '2026-11-18', equipment: 'V',
};
const NEXT = {
  originCity: 'Fort Worth', originState: 'TX', originLat: 32.75, originLng: -97.33,
  destCity: 'Atlanta', destState: 'GA', destLat: 33.749, destLng: -84.388,
  pickupDate: '2026-11-21', equipment: 'R',
};

const createBody = {
  operationName: 'CreateTruckSearch',
  query: 'mutation CreateTruckSearch($criteria: SearchCriteria!) { createSearch(criteria: $criteria) { id } }',
  variables: {
    criteria: {
      origin: { city: 'CHICAGO', stateProv: 'IL', latitude: 41.88, longitude: -87.63 },
      destination: { city: 'DALLAS', stateProv: 'TX', latitude: 32.78, longitude: -96.8 },
      equipmentTypes: ['V'],
      availability: { earliest: '2026-11-18T00:00:00.000Z', latest: '2026-11-19T23:59:59.000Z' },
      originRadiusMiles: 150,
      label: 'Chicago, IL to Dallas, TX',
    },
  },
};
const matches = (n) => JSON.stringify({ data: { matches: Array.from({ length: n }, (_, i) => ({ id: 'm' + i, carrierMcNumber: 100000 + i, companyName: 'CARRIER ' + i })) } });

const STEPS = [
  { url: 'https://one.dat.com/api/telemetry', method: 'POST', headers: {}, body: '{"event":"click"}', response: '{"ok":true}' },
  { url: 'https://freight.api.dat.com/graphql', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SECRET', 'x-dat-app': 'one-web' }, body: JSON.stringify(createBody), response: JSON.stringify({ data: { createSearch: { id: 'srch-9f8e7d12' } } }) },
  { url: 'https://one.dat.com/api/user/prefs', method: 'GET', headers: {}, body: null, response: '{"theme":"dark","id":"user-123456"}' },
  { url: 'https://freight.api.dat.com/searches/srch-9f8e7d12/matches?limit=100&token=abc', method: 'GET', headers: { authorization: 'Bearer SECRET' }, body: null, response: matches(3), hadCarriers: true },
];

test('learns the search: keeps only the requests that matter, without login headers', () => {
  const r = R.buildRecipe(STEPS, LEARNED, { now: Date.parse('2026-11-15T15:00:00Z') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.recipe.steps.length, 2);
  const text = JSON.stringify(r.recipe);
  assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes('token=abc'));
  assert.equal(r.recipe.steps[0].headers['x-dat-app'], 'one-web');
  assert.deepStrictEqual(r.recipe.steps[1].url.parts[1], { $mcx: 'bind', step: 0, path: ['data', 'createSearch', 'id'] });
});

test('runs the search for another lane, passing the new search id along', async () => {
  const { recipe } = R.buildRecipe(STEPS, LEARNED, { now: Date.parse('2026-11-15T15:00:00Z') });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const body = calls.length === 1 ? JSON.stringify({ data: { createSearch: { id: 'srch-NEW77' } } }) : matches(5);
    return { ok: true, status: 200, text: async () => body };
  };
  const out = await R.runRecipe(recipe, NEXT, { fetchFn, loginFor: () => ({ authorization: 'Bearer LIVE' }), now: Date.parse('2026-11-16T10:00:00Z') });
  assert.equal(out.ok, true, JSON.stringify(out));
  const sent = JSON.parse(calls[0].init.body).variables.criteria;
  assert.deepStrictEqual(sent.origin, { city: 'FORT WORTH', stateProv: 'TX', latitude: 32.75, longitude: -97.33 });
  assert.deepStrictEqual(sent.destination, { city: 'ATLANTA', stateProv: 'GA', latitude: 33.749, longitude: -84.388 });
  assert.deepStrictEqual(sent.equipmentTypes, ['R']);
  assert.equal(sent.availability.earliest, '2026-11-21T00:00:00.000Z');
  assert.equal(sent.availability.latest, '2026-11-22T23:59:59.000Z');
  assert.equal(sent.originRadiusMiles, 150);
  assert.equal(sent.label, 'Fort Worth, TX to Atlanta, GA');
  assert.equal(calls[0].init.headers.authorization, 'Bearer LIVE');
  assert.equal(calls[1].url, 'https://freight.api.dat.com/searches/srch-NEW77/matches?limit=100');
  assert.equal(calls[1].init.body, undefined);
  assert.equal(JSON.parse(out.answerText).data.matches.length, 5);
});

test('a search for a different lane than asked is not learned', () => {
  const other = { ...LEARNED, originCity: 'Denver', originState: 'CO', originLat: 39.74, originLng: -104.99 };
  const r = R.buildRecipe(STEPS, other);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'lane-not-found');
});

test('a logged-out DAT is reported as a login problem', async () => {
  const { recipe } = R.buildRecipe(STEPS, LEARNED);
  const fetchFn = async () => ({ ok: false, status: 401, text: async () => '' });
  const out = await R.runRecipe(recipe, NEXT, { fetchFn });
  assert.equal(out.code, 'login');
});

test('a load without map positions cannot be searched by coordinates', async () => {
  const { recipe } = R.buildRecipe(STEPS, LEARNED);
  const out = await R.runRecipe(recipe, { ...NEXT, originLat: null }, { fetchFn: async () => assert.fail('no request') });
  assert.equal(out.code, 'no-coords');
});

test('login headers are told apart from plain ones', () => {
  const h = { Authorization: 'Bearer x', 'X-Auth-Token': 'y', 'Content-Type': 'application/json', Cookie: 'c=1' };
  assert.deepStrictEqual(R.loginHeaders(h), { authorization: 'Bearer x', 'x-auth-token': 'y' });
  assert.deepStrictEqual(R.plainHeaders(h), { 'content-type': 'application/json' });
});
