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

// ---- New Highway layout (Nov 2026): MC stacked inside the Company cell,
// "In Network" connection badge, curly-quoted heading, "Showing 1-1 of 1" footer.
const COPY = '<svg class="copy"><path d="M0 0"></path></svg>';
const newRow = (name, city, dot, mc, assessment) => `
  <div class="cell company"><div class="name">${name}</div><div class="city">${city}</div>
    <div class="id"><span>DOT ${dot}</span>${COPY}</div><div class="id"><span>MC ${mc}</span>${COPY}</div></div>
  <div class="cell"><span class="badge">In Network</span></div>
  <div class="cell"><div>(847) 584-3826</div><div>arthur@igtransportation.com</div></div>
  <div class="cell"><span class="badge">${assessment}</span></div>
  <div class="cell">409 trucks</div>
  <div class="cell"><svg></svg></div>
  <div class="cell"></div>`;
const NEW_HEADER = ['Company', 'Connection', 'Dispatch', 'Assessment', 'Fleet', 'ELD', 'Certified Partners'];

const NEW_GRID = (rows, q) => `
  <nav><a>Dashboard</a><a>Search</a><a>Offers</a><span>2</span></nav>
  <input value="${q}">
  <h1>Results for “${q}”</h1>
  <div class="table">
    <div class="head">${NEW_HEADER.map((h) => `<div>${h}</div>`).join('')}</div>
    <div class="body">${rows.map((r) => `<div class="row">${newRow(...r)}</div>`).join('')}</div>
    <div class="foot">Showing 1-${rows.length} of ${rows.length}</div>
  </div>`;

const NEW_TABLE = (rows, q) => `
  <h1>Results for “${q}”</h1>
  <table><thead><tr>${NEW_HEADER.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
  <tbody>${rows
    .map((r) => `<tr>${newRow(...r).replace(/<div class="cell([^"]*)">/g, '<td class="cell$1">').replace(/<\/div>\s*(?=<td|$)/g, '</td>')}</tr>`)
    .join('')}</tbody></table>
  <div>Showing 1-${rows.length} of ${rows.length}</div>`;

const IG = ['IG TRANSPORTATION INC', 'ADDISON, IL', '01928967', '689501', 'Pass'];
const IG2 = ['IG TRANSPORTATION LLC', 'CONYERS, GA', '02376257', '815700', 'Partial Pass'];

test('new layout (grid): single result, like the screenshot', () => {
  const s = readHighway(doc(NEW_GRID([IG], '689501')), '689501');
  assert.equal(s.headingQuery, '689501');
  assert.equal(s.match.status, 'pass');
  assert.equal(s.match.label, 'Pass');
  assert.equal(s.match.name, 'IG TRANSPORTATION INC');
});

test('new layout (grid): picks the right row among several', () => {
  const d = doc(NEW_GRID([IG, IG2], 'ig transportation'));
  assert.equal(readHighway(d, '689501').match.status, 'pass');
  assert.equal(readHighway(d, '815700').match.status, 'partial');
  assert.equal(readHighway(d, '815700').match.name, 'IG TRANSPORTATION LLC');
});

test('new layout (table): single and multiple rows', () => {
  assert.equal(readHighway(doc(NEW_TABLE([IG], '689501')), '689501').match.status, 'pass');
  const d = doc(NEW_TABLE([IG, IG2], 'ig'));
  assert.equal(readHighway(d, '815700').match.label, 'Partial Pass');
  assert.equal(readHighway(d, '689501').match.label, 'Pass');
});

test('new layout: "In Network" badge is never mistaken for the assessment', () => {
  const failRow = ['ACME LLC', 'X, TX', '1', '555555', 'Fail'];
  assert.equal(readHighway(doc(NEW_GRID([failRow], '555555')), '555555').match.status, 'fail');
});

// ---- Narrow-window (mobile) card layout, as seen in the minimized worker window.
const card = (name, dot, mc, assessment, extraBadge = 'In Network') => `
  <div class="card">
    <a href="#">${name}</a>
    <div class="badges"><span class="b">${assessment}</span><span class="b">${extraBadge}</span></div>
    <div>DOT: ${dot} · MC: ${mc}</div>
    <div><svg></svg> CREST HILL, IL</div>
    <div><svg></svg><a>(630) 866-7777</a></div>
    <div><svg></svg><a>matt@uzbfreight.com</a></div>
    <div class="foot"><span>Fleet: 296</span><span><svg></svg> Connected</span><svg></svg></div>
  </div>`;
const CARD_PAGE = (cards, q) => `<div id="app"><div class="layout">
  <header><button>menu</button><span>HIGHWAY</span></header>
  <h1>Results for “${q}”</h1>
  <div class="cards">${cards.join("")}</div></div></div>`;

test('card layout: "MC: 004213" with colon and leading zeros, Partial Pass', () => {
  const s = readHighway(doc(CARD_PAGE([card('UZB FREIGHT INC', '02960200', '004213', 'Partial Pass')], '4213')), '4213');
  assert.equal(s.headingQuery, '4213');
  assert.ok(s.mcFound, 'MC found');
  assert.equal(s.match && s.match.status, 'partial');
  assert.equal(s.match.name, 'UZB FREIGHT INC');
});

test('card layout: several cards, each gets its own badge', () => {
  const d = doc(
    CARD_PAGE(
      [
        card('UZB FREIGHT INC', '02960200', '004213', 'Partial Pass'),
        card('OTHER CARRIER LLC', '1111111', '004214', 'Fail', 'Not In Network'),
        card('THIRD LLC', '2222222', '555555', 'Pass'),
      ],
      'x'
    )
  );
  assert.equal(readHighway(d, '4213').match.status, 'partial');
  assert.equal(readHighway(d, '4214').match.status, 'fail');
  assert.equal(readHighway(d, '555555').match.status, 'pass');
});

test('MC text variants on Highway pages', () => {
  const { mcsIn } = require('../extension/src/highway-parse.js');
  for (const t of ['MC 4213', 'MC: 004213', 'MC#4213', 'MC #: 4213', 'DOT: 02960200 · MC: 004213']) {
    assert.ok(mcsIn(t).has('4213'), t);
  }
  assert.ok(!mcsIn('DOT: 4213').has('4213'));
});

test('card layout: a "Fail" filter elsewhere on the page is not mistaken for the badge', () => {
  const html = CARD_PAGE([card('UZB FREIGHT INC', '02960200', '004213', 'Partial Pass')], '4213').replace(
    '<header>',
    '<header><div class="filters"><span>Fail</span><span>Pass</span></div>'
  );
  assert.equal(readHighway(doc(html), '4213').match.status, 'partial');
});
