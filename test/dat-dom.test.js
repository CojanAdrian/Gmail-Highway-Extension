const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = (f) => fs.readFileSync(path.join(__dirname, '../extension/src', f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rows like the DAT screenshot: company link + contact in each row.
const row = (company, contact) => `
  <div class="row"><div class="cell">8m</div><div class="cell">Grove City, OH</div>
  <div class="cell company"><a href="#">${company}</a></div>
  <div class="cell contact"><a>${contact}</a> - IL</div></div>`;

async function setup(rowsHtml, results) {
  const dom = new JSDOM(`<!doctype html><body><div id="results">${rowsHtml}</div></body>`, {
    runScripts: 'outside-only',
    url: 'https://one.dat.com/search-equipment',
  });
  const w = dom.window;
  const sent = [];
  w.chrome = {
    storage: { sync: { get: async (d) => d }, onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type === 'lookup') return { result: results[msg.mc] };
        return {};
      },
    },
  };
  // Like Chrome: dat-extract.js only runs in the page (MAIN) world, not here.
  w.eval(src('tags.js'));
  w.eval(src('dat.js'));
  return { w, sent };
}

function post(w, carriers) {
  w.dispatchEvent(new w.MessageEvent('message', { data: { source: 'mcx-dat', kind: 'carriers', carriers }, source: w }));
}

test('tags every row with the right result, including truncated names and duplicates', async () => {
  const { w, sent } = await setup(
    row('Matrix Logistics Inc', '(708) 351-7448') +
      row('Alenkos Express Llc', '(859) 221-5295') +
      row('Alenkos Express Llc', 'alenkosexpress@g...') +
      row('JAROGROUP TRANSP...', '(847) 592-7260'),
    {
      108527: { status: 'pass', label: 'Pass' },
      200001: { status: 'fail', label: 'Fail' },
      300003: { status: 'partial', label: 'Partial Pass' },
    }
  );
  post(w, [
    { mc: '108527', names: ['MATRIX LOGISTICS INC'], contacts: ['7083517448'] },
    { mc: '200001', names: ['ALENKOS EXPRESS LLC'], contacts: ['8592215295', 'alenkosexpress@gmail.com'] },
    { mc: '300003', names: ['JAROGROUP TRANSPORT INC'], contacts: ['8475927260'] },
  ]);
  await sleep(400);
  const tags = [...w.document.querySelectorAll('.row')].map((r) => {
    const t = r.querySelector('.mcx-tag');
    return t && [t.textContent, t.dataset.forMc, t.className.includes('mcx-compact')];
  });
  assert.deepEqual(tags, [
    ['PASS', '108527', true],
    ['FAIL', '200001', true],
    ['FAIL', '200001', true],
    ['PARTIAL', '300003', true],
  ]);
  // Tag sits right before the company link, inside the company cell.
  const first = w.document.querySelector('.row .company');
  assert.equal(first.firstElementChild.className.split(' ')[0], 'mcx-tag');
  // All carriers looked up immediately, once each.
  assert.deepEqual(sent.filter((m) => m.type === 'lookup').map((m) => m.mc).sort(), ['108527', '200001', '300003']);
});

test('same name, different MC: picks the one whose phone is in the row', async () => {
  const { w } = await setup(row('US Cargo LLC', '(614) 772-7484') + row('US Cargo LLC', '(305) 111-2222'), {
    1111: { status: 'pass', label: 'Pass' },
    2222: { status: 'fail', label: 'Fail' },
  });
  post(w, [
    { mc: '1111', names: ['US CARGO LLC'], contacts: ['6147727484'] },
    { mc: '2222', names: ['US CARGO LLC'], contacts: ['3051112222'] },
  ]);
  await sleep(400);
  const tags = [...w.document.querySelectorAll('.mcx-tag')].map((t) => t.dataset.forMc);
  assert.deepEqual(tags, ['1111', '2222']);
});

test('rows added later (new trucks) get tagged too', async () => {
  const { w } = await setup(row('Matrix Logistics Inc', '(708) 351-7448'), {
    108527: { status: 'pass', label: 'Pass' },
    444444: { status: 'fail', label: 'Fail' },
  });
  post(w, [{ mc: '108527', names: ['MATRIX LOGISTICS INC'], contacts: [] }]);
  await sleep(400);
  post(w, [{ mc: '444444', names: ['NEW TRUCKING LLC'], contacts: [] }]);
  w.document.getElementById('results').insertAdjacentHTML('afterbegin', row('New Trucking LLC', '(111) 222-3333'));
  await sleep(400);
  assert.equal(w.document.querySelectorAll('.mcx-tag').length, 2);
  assert.equal(w.document.querySelector('.row .mcx-tag').textContent, 'FAIL');
});

// Rows with a checkbox, like DAT's results table.
const cbRow = (company, contact, details = '') => `
  <div class="row"><div class="cell"><input type="checkbox"></div><div class="cell">8m</div>
  <div class="cell company"><a href="#">${company}</a></div>
  <div class="cell contact"><a>${contact}</a> - IL</div><div class="cell network">–</div>${details}</div>`;

test('tag goes at the end of the row (not in the company cell), once per row', async () => {
  const details = '<div class="details"><h3>MATRIX LOGISTICS INC</h3><span>MC# 108527</span></div>';
  const { w } = await setup(
    cbRow('Matrix Logistics Inc', '(708) 351-7448', details) + cbRow('Alenkos Express Llc', '(859) 221-5295'),
    { 108527: { status: 'pass', label: 'Pass' }, 200001: { status: 'fail', label: 'Fail' } }
  );
  post(w, [
    { mc: '108527', names: ['MATRIX LOGISTICS INC'], contacts: [] },
    { mc: '200001', names: ['ALENKOS EXPRESS LLC'], contacts: [] },
  ]);
  await sleep(400);
  const rows = [...w.document.querySelectorAll('.row')];
  for (const r of rows) {
    const tags = r.querySelectorAll('.mcx-tag');
    assert.equal(tags.length, 1, 'one tag per row');
    assert.equal(tags[0].parentElement, r, 'tag is a direct child of the row');
    assert.equal(tags[0].dataset.row, '1');
    assert.equal(tags[0].style.position, 'absolute');
  }
  assert.equal(w.document.querySelector('.company .mcx-tag'), null, 'nothing in the company cell');
  assert.deepEqual(rows.map((r) => r.querySelector('.mcx-tag').textContent), ['PASS', 'FAIL']);
});

test('company name outside any single row (e.g. a details panel listing) gets no tag', async () => {
  const { w } = await setup(
    `<div class="list"><input type="checkbox"><input type="checkbox"><h3>Matrix Logistics Inc</h3></div>`,
    { 108527: { status: 'pass', label: 'Pass' } }
  );
  post(w, [{ mc: '108527', names: ['MATRIX LOGISTICS INC'], contacts: [] }]);
  await sleep(400);
  assert.equal(w.document.querySelectorAll('.mcx-tag').length, 0);
});

test('re-scans (new trucks arriving) never duplicate row tags', async () => {
  const { w } = await setup(cbRow('Matrix Logistics Inc', '(708) 351-7448'), { 108527: { status: 'pass', label: 'Pass' } });
  post(w, [{ mc: '108527', names: ['MATRIX LOGISTICS INC'], contacts: [] }]);
  await sleep(400);
  for (let i = 0; i < 3; i++) {
    w.document.querySelector('.row').insertAdjacentHTML('afterend', cbRow('Matrix Logistics Inc', '(708) 351-7448'));
    await sleep(350);
  }
  const counts = [...w.document.querySelectorAll('.row')].map((r) => r.querySelectorAll('.mcx-tag').length);
  assert.deepEqual(counts, [1, 1, 1, 1]);
});
