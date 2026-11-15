// Filling DAT One's truck search (laid out like one.dat.com/search-equipment).
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const F = require('../extension/src/dat-form.js');

const PLACES = ['Ft Collins, CO', 'Ft Collins, CO 80521', 'Oklahoma City, OK', 'Collinsville, IL', 'Chicago, IL', 'Chicago Heights, IL', 'Dallas, TX'];
const EQUIPMENT = ['Vans (Standard)', 'Van - Air-Ride', 'Reefers', 'Flatbeds', 'Step Decks'];

function datPage({ dateValue = '11/14/2026 – 11/14/2026', twoDateBoxes = false } = {}) {
  const field = (label, extra = '') => `<mat-form-field class="mat-mdc-form-field"><mat-label>${label}</mat-label><input class="mat-mdc-input-element" ${extra}></mat-form-field>`;
  const dateField = twoDateBoxes
    ? `<mat-form-field class="mat-mdc-form-field"><mat-label>Date Range*</mat-label><mat-date-range-input><input id="dt" placeholder="Start date" value="11/16/2026"><span>–</span><input id="dt2" placeholder="End date" value="11/15/2026"></mat-date-range-input><button class="cal" type="button">calendar</button></mat-form-field>`
    : field('Date Range*', `id="dt" value="${dateValue}"`);
  const html = `<!doctype html><body>
    <nav><input placeholder="Search carriers"><button class="side-search"><mat-icon>search</mat-icon></button></nav>
    <main><form class="search-form">
      ${field('Origin', 'id="o" aria-autocomplete="list"')} ${field('DH-O', 'value="150"')}
      ${field('Destination', 'id="d" aria-autocomplete="list"')} ${field('DH-D', 'value="150"')}
      ${field('Equipment Type*', 'id="e" value="Vans (Standard)"')}
      ${field('Load Type', 'value="Full & Partial"')} ${field('Length ft')} ${field('Weight lbs')}
      ${dateField}
      <button type="button" class="go"><mat-icon>search</mat-icon> SEARCH</button>
    </form></main>
    <div class="cdk-overlay-container"></div></body>`;
  const dom = new JSDOM(html, { url: 'https://one.dat.com/search-equipment', pretendToBeVisual: true });
  const w = dom.window;
  w.__mcxNoLayout = true;
  const doc = w.document;
  const overlay = doc.querySelector('.cdk-overlay-container');
  const chosen = {};
  // Search-as-you-type lists, like DAT's.
  function list(input, items) {
    input.addEventListener('input', () => {
      overlay.innerHTML = '';
      const q = input.value.toLowerCase().replace(/^fort\b/, 'ft').split(',')[0].trim();
      if (q.length < 2) return;
      for (const text of items.filter((t) => t.toLowerCase().includes(q))) {
        const o = doc.createElement('mat-option');
        o.setAttribute('role', 'option');
        o.textContent = text;
        o.addEventListener('click', () => {
          input.value = text;
          chosen[input.id] = text;
          overlay.innerHTML = '';
        });
        overlay.appendChild(o);
      }
    });
  }
  list(doc.getElementById('o'), PLACES);
  list(doc.getElementById('d'), PLACES);
  list(doc.getElementById('e'), EQUIPMENT);
  let searched = 0;
  let sideSearched = 0;
  doc.querySelector('.go').addEventListener('click', () => searched++);
  doc.querySelector('.side-search').addEventListener('click', () => sideSearched++);
  return { doc, chosen, searched: () => searched, sideSearched: () => sideSearched };
}

const LANE = { originCity: 'Fort Collins', originState: 'CO', destCity: 'Oklahoma City', destState: 'OK', equipment: 'V', pickupDate: '2026-11-15' };

test('finds the fields by their labels', () => {
  const { doc } = datPage();
  const { fields } = F.findFields(doc);
  assert.equal(fields.origin.id, 'o');
  assert.equal(fields.destination.id, 'd');
  assert.equal(fields.equipment.id, 'e');
  assert.equal(fields.date.id, 'dt');
});

test('fills the lane, picks DAT suggestions and presses the form Search', async () => {
  const page = datPage();
  const out = await F.fillAndSearch(page.doc, LANE, { formTimeout: 1000 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(page.chosen.o, 'Ft Collins, CO');
  assert.equal(page.chosen.d, 'Oklahoma City, OK');
  assert.equal(page.chosen.e, 'Vans (Standard)');
  assert.equal(page.doc.getElementById('dt').value, '11/15/2026 – 11/15/2026');
  assert.equal(page.searched(), 1);
  assert.equal(page.sideSearched(), 0);
});

test('a date range in two boxes gets the pickup day in both (no "Invalid date range")', async () => {
  const page = datPage({ twoDateBoxes: true });
  const out = await F.fillAndSearch(page.doc, LANE, { formTimeout: 1000 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(page.doc.getElementById('dt').value, '11/15/2026');
  assert.equal(page.doc.getElementById('dt2').value, '11/15/2026');
  assert.equal(page.searched(), 1);
});

// Like DAT: one box "from – to"; typing only changes "from"; the calendar
// (opened by its icon) shows "NOV 2026" and plain day numbers; the first
// click sets "from", the second "to", then it closes.
function withDatCalendar(page, startValue = '11/16/2026 – 11/15/2026') {
  const { doc } = page;
  const input = doc.getElementById('dt');
  input.value = startValue;
  const fmt = (d) => `11/${String(d).padStart(2, '0')}/2026`;
  let range = startValue.split(' – ');
  input.addEventListener('input', () => {
    const typed = input.value.split(/\s*–\s*/)[0];
    range = [typed, range[1]];
    input.value = range.join(' – ');
  });
  const icon = doc.createElement('button');
  icon.type = 'button';
  icon.className = 'calendar-icon';
  icon.textContent = 'calendar_today';
  input.parentElement.appendChild(icon);
  let clicks = 0;
  icon.addEventListener('click', () => {
    const cal = doc.createElement('div');
    cal.className = 'dat-calendar';
    cal.innerHTML = '<div>NOV 2026</div><button class="prev">‹</button><button class="next">›</button>' + Array.from({ length: 30 }, (_, i) => `<button class="day">${i + 1}</button>`).join('');
    cal.querySelectorAll('.day').forEach((b) =>
      b.addEventListener('click', () => {
        clicks += 1;
        range = clicks === 1 ? [fmt(b.textContent), fmt(b.textContent)] : [range[0], fmt(b.textContent)];
        input.value = range.join(' – ');
        if (clicks === 2) cal.remove();
      })
    );
    doc.querySelector('.cdk-overlay-container').appendChild(cal);
  });
  return input;
}

test('the date range is set in DAT calendar, from and to the pickup day', async () => {
  const page = datPage();
  const input = withDatCalendar(page);
  const out = await F.fillAndSearch(page.doc, { ...LANE, pickupDate: '2026-11-16' }, { formTimeout: 1000 });
  assert.equal(out.ok, true, JSON.stringify(out.steps && out.steps.date));
  assert.equal(input.value, '11/16/2026 – 11/16/2026');
  assert.equal(out.steps.date.calendar, true);
  assert.equal(page.searched(), 1);
});

test('when the date cannot be set, it stops instead of searching a wrong range', async () => {
  const page = datPage();
  const input = page.doc.getElementById('dt');
  input.value = '11/16/2026 – 11/15/2026';
  input.addEventListener('input', () => (input.value = '11/16/2026 – 11/15/2026'));
  const out = await F.fillAndSearch(page.doc, { ...LANE, pickupDate: '2026-11-16' }, { formTimeout: 1000 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'no-date');
  assert.equal(page.searched(), 0);
});

test('Van or Reefer picks both when DAT has no single entry for it', async () => {
  const page = datPage();
  const picked = [];
  page.doc.getElementById('e').addEventListener('click', () => {});
  const out = await F.fillAndSearch(page.doc, { ...LANE, equipment: 'VR' }, { formTimeout: 1000 });
  assert.equal(out.ok, true);
  assert.match(out.steps.equipment.picked, /Vans \(Standard\) \+ Reefers/);
  picked.push(page.chosen.e);
  assert.equal(page.chosen.e, 'Reefers');
});

test('a page without the search form says what fields it has', async () => {
  const dom = new JSDOM('<!doctype html><body><input placeholder="Search carriers"></body>', { url: 'https://one.dat.com/dashboard' });
  dom.window.__mcxNoLayout = true;
  const out = await F.fillAndSearch(dom.window.document, LANE, { formTimeout: 400 });
  assert.equal(out.code, 'form-not-found');
  assert.ok(out.seen.some((s) => /Search carriers/.test(s)));
});

test('equipment names and dates', () => {
  const w = F.equipmentWanted('R');
  assert.ok(w(F.norm('Reefers')) > w(F.norm('Vans (Standard)')));
  const el = { type: 'text', getAttribute: () => 'MM/DD/YYYY' };
  assert.equal(F.dateText(el, '2026-11-05'), '11/05/2026');
  assert.equal(F.norm('Fort Collins'), F.norm('Ft Collins'));
});

test('only carriers showing in the results are kept (not similar results or other searches)', async () => {
  const dom = new JSDOM(`<!doctype html><body><table>
    <tr><td>Genius Logistics LLC</td><td>(347) 522-1125</td></tr>
    <tr><td>AC Freight Solution...</td><td>(913) 494-2705</td></tr>
    <tr><td>Orozco Trucking Inc</td><td>alex.o@orozcotrucking.com</td></tr>
  </table></body>`);
  const text = await F.resultsText(dom.window.document);
  const heard = [
    { mc: '1', names: ['GENIUS LOGISTICS LLC'], contacts: ['3475221125'] },
    { mc: '2', names: ['AC FREIGHT SOLUTIONS INC'], contacts: ['9134942705'] },
    { mc: '3', names: ['OROZCO TRUCKING INC'], contacts: ['alex.o@orozcotrucking.com'] },
    { mc: '4', names: ['SIMILAR RESULT CARRIER'], contacts: ['5555550100'] },
    { mc: '5', names: ['OTHER SAVED SEARCH LLC'], contacts: ['ops@other.com'] },
  ];
  assert.deepStrictEqual(F.onScreen(heard, text).map((c) => c.mc), ['1', '2', '3']);
});
