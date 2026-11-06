const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { readHighway, decide, headingMatches, TIMING } = require('../extension/src/highway-parse.js');

// Mirrors the user's screenshot, as a <table>.
const TABLE_PAGE = `
<h2>Results for "689501"</h2>
<div class="filters"><span>Assessment</span><span>Pass</span><span>Fail</span></div>
<table>
  <thead><tr><th>Company Name</th><th>HQ</th><th>Identifiers</th><th>Dispatch</th><th>Assessment</th><th>Fleet</th><th>ELD</th><th>Insurance</th></tr></thead>
  <tbody>
    <tr><td><img><span>IG TRANSPORTATION INC</span></td><td>Addison, IL</td><td><div>DOT 01928967</div><div>MC 689501</div></td>
        <td><a>(847) 584-3826</a><a>arthur@igtr...</a></td><td><span class="badge">Pass</span></td><td>414</td><td><svg></svg></td><td></td></tr>
    <tr><td><img><span>IG TRANSPORTATION LLC</span></td><td>Conyers, GA</td><td><div>DOT 02376257</div><div>MC 815700</div></td>
        <td><a>(425) 879-0436</a><a>liyaivan77@...</a></td><td><span class="badge">Fail</span></td><td>1</td><td><svg></svg></td><td></td></tr>
  </tbody>
</table>`;

// Same data as a div grid (common in Vue apps), MC split across nodes.
const GRID_PAGE = `
<h2>Results for “ig transportation”</h2>
<div class="grid">
  <div class="hdr"><div>Company Name</div><div>HQ</div><div>Identifiers</div><div>Dispatch</div><div><span>Assessment</span></div><div>Fleet</div><div>ELD</div><div>Insurance</div></div>
  <div class="r"><div class="cells"><div><span>IG TRANSPORTATION INC</span></div><div>Addison, IL</div><div><p>DOT 01928967</p><p><span>MC</span> <span>689501</span></p></div><div>x</div><div><span>Pass</span></div><div>414</div><div></div><div></div></div></div>
  <div class="r"><div class="cells"><div><span>IG TRANSPORTATION LLC</span></div><div>Conyers, GA</div><div><p>DOT 02376257</p><p><span>MC</span> <span>815700</span></p></div><div>x</div><div><span>Fail</span></div><div>1</div><div></div><div></div></div></div>
</div>`;

const doc = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

test('table layout: reads Pass and Fail for the right rows', () => {
  const d = doc(TABLE_PAGE);
  const a = readHighway(d, '689501');
  assert.equal(a.match.status, 'pass');
  assert.equal(a.match.name, 'IG TRANSPORTATION INC');
  assert.equal(a.headingQuery, '689501');
  const b = readHighway(d, '815700');
  assert.equal(b.match.status, 'fail');
  assert.equal(b.match.name, 'IG TRANSPORTATION LLC');
});

test('grid layout with split MC text', () => {
  const d = doc(GRID_PAGE);
  assert.equal(readHighway(d, '689501').match.status, 'pass');
  assert.equal(readHighway(d, '815700').match.status, 'fail');
  assert.equal(readHighway(d, '815700').headingQuery, 'ig transportation');
});

test('leading zeros in the requested MC are ignored', () => {
  assert.equal(readHighway(doc(TABLE_PAGE), '0689501').match.status, 'pass');
});

test('single-result grid without row wrappers', () => {
  const html = `<h2>Results for "815700"</h2>
    <div><div><div>Company Name</div><div>Identifiers</div><div>Assessment</div></div>
    <div><div>ACME LLC</div><div>MC 815700</div><div><span>Fail</span></div></div></div>`;
  assert.equal(readHighway(doc(html), '815700').match.status, 'fail');
});

test('MC not on page -> no match, heading still read', () => {
  const s = readHighway(doc(TABLE_PAGE.replace('"689501"', '"123456"')), '123456');
  assert.equal(s.match, null);
  assert.equal(s.mcFound, false);
  assert.equal(headingMatches(s, '123456'), true);
});

test('decide: found -> done', () => {
  const snap = readHighway(doc(TABLE_PAGE), '689501');
  assert.equal(decide(snap, '689501', { elapsed: 100, sinceHeading: 0 }, 'full').done.status, 'pass');
});

test('decide: not found waits, then reports not_found', () => {
  const snap = { match: null, mcFound: false, rowCount: 2, rowsKey: '1,2', headingQuery: '5' };
  assert.ok(decide(snap, '5', { elapsed: 500, sinceHeading: 200 }, 'full').wait);
  assert.equal(
    decide(snap, '5', { elapsed: 3000, sinceHeading: TIMING.notFoundWithRows }, 'full').done.status,
    'not_found'
  );
});

test('decide: stale rows from previous search wait longer', () => {
  const snap = { match: null, mcFound: false, rowCount: 2, rowsKey: '1,2', headingQuery: '5' };
  const t = { elapsed: 3000, sinceHeading: TIMING.notFoundWithRows, prevRowsKey: '1,2' };
  assert.ok(decide(snap, '5', t, 'fast').wait);
  t.sinceHeading = TIMING.notFoundEmpty;
  assert.equal(decide(snap, '5', t, 'fast').done.status, 'not_found');
});

test('decide: fast navigation that never shows our query falls back', () => {
  const snap = { match: null, mcFound: false, rowCount: 0, rowsKey: '', headingQuery: 'old' };
  assert.ok(decide(snap, '5', { elapsed: TIMING.fastGiveUp, sinceHeading: null }, 'fast').fallback);
  assert.ok(decide(snap, '5', { elapsed: TIMING.fastGiveUp, sinceHeading: null }, 'full').wait);
  assert.equal(decide(snap, '5', { elapsed: TIMING.timeout, sinceHeading: null }, 'full').error, 'timeout');
});

test('Partial Pass is its own status', () => {
  const html = TABLE_PAGE.replace('<span class="badge">Pass</span>', '<span class="badge">Partial Pass</span>');
  const m = readHighway(doc(html), '689501').match;
  assert.equal(m.status, 'partial');
  assert.equal(m.label, 'Partial Pass');
  assert.equal(readHighway(doc(TABLE_PAGE), '689501').match.status, 'pass');
});
