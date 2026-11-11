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
  w.eval(src('dat-extract.js'));
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
