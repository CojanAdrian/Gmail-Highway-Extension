// Fills DAT One's truck search form (one.dat.com/search-equipment) like a
// person would: types the origin and destination and picks DAT's suggestion,
// sets the equipment and the date, and presses Search. Runs in the DAT page
// (content script), started by the extension for BulkPosting.
//
// DAT's page isn't known field by field, so fields are found by what they
// are called (label, placeholder, aria-label, Angular form name). When a field
// can't be found, the fields that are there are described for diagnostics.
(function (root) {
  const KEYWORDS = {
    origin: [/origin/i, /\bfrom\b/i, /pick.?up (city|location|place)/i],
    destination: [/destination/i, /\bdest\b/i, /\bto\b/i, /deliver/i, /drop/i],
    equipment: [/equip/i, /truck type/i, /trailer/i, /\btype\b/i],
    date: [/avail/i, /date/i, /ready/i, /pick.?up$/i, /when/i],
  };

  const EQUIPMENT_NAMES = {
    V: ['vans (standard)', 'van'],
    R: ['reefers', 'reefer', 'refrigerated'],
    F: ['flatbeds', 'flatbed'],
    VR: ['van or reefer', 'vans or reefers', 'van/reefer', 'van, reefer'],
    FR: ['flatbed or van', 'flat/van'],
    SD: ['step deck', 'stepdeck'],
    DD: ['double drop'],
    RGN: ['removable gooseneck', 'rgn'],
    PO: ['power only'],
    HS: ['hotshot'],
    CN: ['conestoga'],
    VF: ['van or flatbed', 'flatbed or van'],
    LB: ['lowboy'],
    TNK: ['tanker'],
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 10000, every = 150) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(every);
    }
  }

  // Lower case, words only, with DAT's short city words (Ft Collins, St Louis).
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\bfort\b/g, 'ft')
      .replace(/\bsainte\b/g, 'ste')
      .replace(/\bsaint\b/g, 'st')
      .replace(/\bmount\b/g, 'mt')
      .trim();

  // Codes that DAT may only offer as two separate types.
  const EQUIPMENT_PARTS = { VR: ['V', 'R'], VF: ['V', 'F'], FR: ['F', 'R'] };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // A real page's element with no box is hidden (tests have no layout).
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || !!el.ownerDocument.defaultView.__mcxNoLayout;
  }

  // Everything a field is called.
  function describe(el) {
    const doc = el.ownerDocument;
    const parts = [];
    const attr = (n) => el.getAttribute && el.getAttribute(n);
    parts.push(attr('aria-label'), attr('placeholder'), attr('formcontrolname'), attr('name'), attr('id'), attr('data-test'), attr('data-testid'), attr('data-cy'), attr('title'));
    const labelledby = attr('aria-labelledby');
    if (labelledby) for (const id of labelledby.split(/\s+/)) parts.push((doc.getElementById(id) || {}).textContent);
    if (el.id) {
      const lab = [...doc.querySelectorAll('label[for]')].find((l) => l.getAttribute('for') === el.id);
      if (lab) parts.push(lab.textContent);
    }
    const field = el.closest('mat-form-field, .mat-form-field, .mat-mdc-form-field, label, [class*="form-field"], [class*="FormField"]');
    if (field) {
      const lab = field.querySelector('mat-label, label, .mat-mdc-floating-label, [class*="label"]');
      if (lab) parts.push(lab.textContent);
      parts.push(field.getAttribute('formcontrolname'), field.getAttribute('formgroupname'));
    }
    // Text just before the field (a label above it).
    let cur = el;
    for (let i = 0; i < 3 && cur && !field; i++) {
      const prev = cur.previousElementSibling;
      if (prev && prev.textContent && prev.textContent.trim().length < 40) {
        parts.push(prev.textContent);
        break;
      }
      cur = cur.parentElement;
    }
    const group = el.closest('[formgroupname]');
    if (group) parts.push(group.getAttribute('formgroupname'));
    return parts.filter(Boolean).map((p) => String(p).replace(/\s+/g, ' ').trim()).join(' | ');
  }

  function candidates(doc) {
    return [...doc.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, mat-select, [role="combobox"]:not(input), select')]
      .filter(visible)
      .filter((el, i, all) => !all.some((o) => o !== el && o.contains(el) && o.tagName !== 'MAT-SELECT' && o.getAttribute('role') !== 'combobox'));
  }

  function score(text, kind) {
    let best = 0;
    KEYWORDS[kind].forEach((re, i) => {
      if (re.test(text)) best = Math.max(best, 10 - i);
    });
    return best;
  }

  // Assigns each kind of field to the element that fits it best.
  function findFields(doc) {
    const list = candidates(doc).map((el) => ({ el, text: describe(el) }));
    const out = {};
    const used = new Set();
    for (const kind of ['origin', 'destination', 'equipment', 'date']) {
      let best = null;
      for (const c of list) {
        if (used.has(c.el)) continue;
        let s = score(c.text, kind);
        if (kind === 'date' && (c.el.type === 'date' || /datepicker|date/i.test(c.el.className))) s += 5;
        if (kind !== 'date' && /date|avail/i.test(c.text) && kind !== 'equipment') s -= 5;
        if (s > 0 && (!best || s > best.s)) best = { c, s };
      }
      if (best) {
        out[kind] = best.c.el;
        used.add(best.c.el);
      }
    }
    // Origin and destination are often unlabeled twins: the first two place boxes.
    if (!out.origin || !out.destination) {
      const places = list.filter((c) => !used.has(c.el) && c.el.tagName === 'INPUT' && (c.el.getAttribute('aria-autocomplete') || /auto|place|city|location/i.test(c.text)));
      if (!out.origin && places[0]) out.origin = places.shift().el;
      if (!out.destination && places[0]) out.destination = places.shift().el;
    }
    return { fields: out, seen: list.map((c) => `${c.el.tagName.toLowerCase()}${c.el.type ? '[' + c.el.type + ']' : ''}: ${c.text}`.slice(0, 160)) };
  }

  // ---------- acting like a person ----------

  function fire(el, type, init = {}) {
    const win = el.ownerDocument.defaultView;
    const Ctor = /^key/.test(type) ? win.KeyboardEvent : /^(mouse|click|pointer)/.test(type) ? win.MouseEvent : /^focus|blur/.test(type) ? win.FocusEvent : win.Event;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  function click(el) {
    el.scrollIntoView && el.scrollIntoView({ block: 'center' });
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(el, t);
  }

  function setValue(el, value) {
    const win = el.ownerDocument.defaultView;
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  async function type(el, text) {
    el.focus();
    fire(el, 'focus', { bubbles: false });
    fire(el, 'focusin');
    click(el);
    setValue(el, '');
    fire(el, 'input');
    // A few characters at a time, so search-as-you-type boxes react.
    const steps = [Math.min(3, text.length), text.length];
    for (const n of steps) {
      setValue(el, text.slice(0, n));
      fire(el, 'keydown', { key: text[n - 1] });
      fire(el, 'input', { data: text[n - 1], inputType: 'insertText' });
      fire(el, 'keyup', { key: text[n - 1] });
      await sleep(120);
    }
  }

  function key(el, k) {
    const codes = { ArrowDown: 40, Enter: 13, Escape: 27, Tab: 9 };
    for (const t of ['keydown', 'keyup']) fire(el, t, { key: k, code: k, keyCode: codes[k], which: codes[k] });
  }

  function options(doc) {
    return [...doc.querySelectorAll('[role="option"], mat-option, .mat-option, .mat-mdc-option, [role="listbox"] li, .pac-item')].filter(visible);
  }

  function pickOption(doc, wanted) {
    let best = null;
    for (const o of options(doc)) {
      const t = norm(o.textContent);
      const s = wanted(t);
      if (s > 0 && (!best || s > best.s)) best = { o, s };
    }
    return best && best.o;
  }

  // Types a city and picks DAT's suggestion for it.
  async function fillPlace(doc, el, city, state) {
    const c = norm(city);
    const st = norm(state);
    const wanted = (t) => {
      if (!t.includes(c)) return 0;
      let s = 1;
      if (new RegExp(`\\b${st}\\b`).test(t)) s += 5;
      if (t.startsWith(c)) s += 2;
      return s - t.length / 200;
    };
    for (const text of [`${city}, ${state}`, city]) {
      await type(el, text);
      const opt = await waitFor(() => pickOption(doc, wanted), 6000);
      if (opt) {
        click(opt);
        await sleep(300);
        return { ok: true, picked: opt.textContent.trim().slice(0, 60) };
      }
    }
    // No list showed: take the first suggestion with the keyboard, if any.
    key(el, 'ArrowDown');
    key(el, 'Enter');
    fire(el, 'change');
    await sleep(300);
    return { ok: false, typed: el.value };
  }

  function equipmentWanted(code) {
    const c = String(code || '').toUpperCase();
    const names = EQUIPMENT_NAMES[c] || [];
    return (t) => {
      const words = t.split(' ');
      let s = 0;
      if (words[0] === c.toLowerCase()) s += 6;
      else if (words.includes(c.toLowerCase())) s += 4;
      for (const n of names) if (t.includes(norm(n))) s += 5 + n.length / 20;
      return s;
    };
  }

  async function fillEquipment(doc, el, code) {
    if (!code) return { ok: true, skipped: true };
    const first = await fillOneEquipment(doc, el, code);
    const parts = EQUIPMENT_PARTS[String(code).toUpperCase()];
    if (first.ok || !parts) return first;
    const picked = [];
    for (const part of parts) {
      const r = await fillOneEquipment(doc, el, part);
      if (r.ok) picked.push(r.picked);
    }
    return picked.length ? { ok: true, picked: picked.join(' + ') } : { ok: false };
  }

  async function fillOneEquipment(doc, el, code) {
    const wanted = equipmentWanted(code);
    const isTextBox = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.readOnly;
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].map((o) => ({ o, s: wanted(norm(o.textContent + ' ' + o.value)) })).sort((a, b) => b.s - a.s)[0];
      if (!opt || opt.s <= 0) return { ok: false };
      el.value = opt.o.value;
      fire(el, 'change');
      return { ok: true, picked: opt.o.textContent.trim() };
    }
    if (isTextBox) await type(el, code);
    else click(el);
    let opt = await waitFor(() => pickOption(doc, wanted), 5000);
    if (!opt && isTextBox) {
      await type(el, (EQUIPMENT_NAMES[String(code).toUpperCase()] || [code])[0]);
      opt = await waitFor(() => pickOption(doc, wanted), 4000);
    }
    if (!opt) return { ok: false };
    click(opt);
    await sleep(250);
    // A list that stays open (several can be ticked) closes with Escape.
    if (options(doc).length) key(doc.activeElement || el, 'Escape');
    return { ok: true, picked: opt.textContent.trim().slice(0, 60) };
  }

  function dateText(el, day) {
    const [y, m, d] = day.split('-');
    if (el.type === 'date') return day;
    const ph = String(el.getAttribute('placeholder') || '');
    if (/^\s*d{1,2}[/.-]m/i.test(ph)) return `${d}/${m}/${y}`;
    if (/yyyy-mm/i.test(ph)) return day;
    if (/yy\s*$/i.test(ph) && !/yyyy/i.test(ph)) return `${m}/${d}/${y.slice(2)}`;
    return `${m}/${d}/${y}`;
  }

  async function fillDate(doc, el, day) {
    if (!day || !el || el.tagName !== 'INPUT') return { ok: false, skipped: true };
    if (el.readOnly) return pickInCalendar(doc, el, day);
    let text = dateText(el, day);
    const rangeSep = String(el.value || el.getAttribute('placeholder') || '').match(/\d\s*(–|-|to)\s*\d/);
    if (rangeSep && !el.closest('mat-date-range-input')) text = `${text} ${rangeSep[1]} ${text}`;
    el.focus();
    fire(el, 'focusin');
    setValue(el, text);
    fire(el, 'input');
    fire(el, 'change');
    key(el, 'Enter');
    await sleep(150);
    fire(el, 'blur', { bubbles: false });
    fire(el, 'focusout');
    // A date range has a second box right after; same day there.
    const range = el.closest('mat-date-range-input, [class*="date-range"]');
    const end = range && [...range.querySelectorAll('input')].find((i) => i !== el);
    if (end && !end.value) {
      setValue(end, text);
      fire(end, 'input');
      fire(end, 'change');
      fire(end, 'blur', { bubbles: false });
    }
    if (options(doc).length) key(el, 'Escape');
    return { ok: true, typed: text };
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // Opens the date picker and clicks the day (twice for a range: from and to).
  async function pickInCalendar(doc, el, day) {
    const [y, m, d] = day.split('-').map(Number);
    const labels = [`${MONTHS[m - 1]} ${d}, ${y}`, `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`, `${m}/${d}/${y}`];
    const opener = (el.closest('mat-form-field, .mat-mdc-form-field') || el.parentElement || el).querySelector('button, mat-datepicker-toggle, [class*="calendar"], [class*="toggle"]') || el;
    click(el);
    let cell = await waitFor(() => findDayCell(doc, labels), 1500);
    if (!cell && opener !== el) {
      click(opener);
      cell = await waitFor(() => findDayCell(doc, labels), 3000);
    }
    // The wanted month may be the next one.
    for (let i = 0; !cell && i < 2; i++) {
      const next = [...doc.querySelectorAll('button')].find((b) => visible(b) && /next month/i.test(b.getAttribute('aria-label') || ''));
      if (!next) break;
      click(next);
      cell = await waitFor(() => findDayCell(doc, labels), 1500);
    }
    if (!cell) return { ok: false, calendar: true };
    click(cell);
    await sleep(250);
    const again = findDayCell(doc, labels);
    if (again) click(again);
    await sleep(250);
    const done = [...doc.querySelectorAll('button')].find((b) => visible(b) && /^(apply|done|ok|close)$/i.test((b.textContent || '').trim()));
    if (done) click(done);
    else key(doc.activeElement || el, 'Escape');
    return { ok: true, picked: el.value };
  }

  function findDayCell(doc, labels) {
    const cells = [...doc.querySelectorAll('[aria-label], [data-date], td, [role="gridcell"] button, [role="gridcell"]')].filter(visible);
    return cells.find((c) => labels.some((l) => (c.getAttribute('aria-label') || '').trim().startsWith(l) || c.getAttribute('data-date') === l)) || null;
  }

  // How close two elements sit in the page (depth of their shared parent).
  function closeness(a, b) {
    if (!a || !b) return 0;
    const chain = new Set();
    for (let n = a; n; n = n.parentElement) chain.add(n);
    let depth = 0;
    let shared = null;
    for (let n = b; n; n = n.parentElement) if (chain.has(n)) { shared = n; break; }
    for (let n = shared; n; n = n.parentElement) depth++;
    return depth;
  }

  function findSearchButton(doc, near) {
    const buttons = [...doc.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible).filter((b) => !b.disabled);
    // Icon names count as text ("search SEARCH"), so repeated words go.
    const label = (b) => [...new Set(norm(b.textContent || b.value || b.getAttribute('aria-label')).split(' '))].join(' ');
    const exact = buttons.filter((b) => /^(search|search trucks|search equipment|find trucks)$/.test(label(b)));
    if (exact.length) {
      // The one sitting with the origin box (not the menu's carrier search).
      return exact.sort((a, b) => closeness(b, near) - closeness(a, near) || (/search/i.test(b.textContent.replace(/search/, '')) ? 1 : 0) - (/search/i.test(a.textContent.replace(/search/, '')) ? 1 : 0))[0];
    }
    const form = near && near.closest('form');
    return (form && form.querySelector('button[type="submit"], input[type="submit"]')) || buttons.find((b) => /\bsearch\b/.test(label(b))) || null;
  }

  // Fills the form for a lane and presses Search.
  // Returns { ok, code, steps, seen } (seen: the fields on the page, for diagnostics).
  async function fillAndSearch(doc, lane, { formTimeout = 20000 } = {}) {
    const steps = {};
    const found = await waitFor(() => {
      const f = findFields(doc);
      return f.fields.origin && f.fields.destination ? f : null;
    }, formTimeout, 300);
    if (!found) return { ok: false, code: 'form-not-found', seen: findFields(doc).seen.slice(0, 25) };
    const { fields } = found;
    steps.origin = await fillPlace(doc, fields.origin, lane.originCity, lane.originState);
    steps.destination = await fillPlace(doc, fields.destination, lane.destCity, lane.destState);
    if (!steps.origin.ok || !steps.destination.ok) {
      return { ok: false, code: 'no-place', steps, seen: found.seen.slice(0, 25) };
    }
    steps.equipment = fields.equipment ? await fillEquipment(doc, fields.equipment, lane.equipment) : { ok: false, missing: true };
    steps.date = fields.date ? await fillDate(doc, fields.date, lane.pickupDate) : { ok: false, missing: true };
    await sleep(300);
    const button = await waitFor(() => findSearchButton(doc, fields.origin), 4000);
    if (!button) return { ok: false, code: 'no-search-button', steps, seen: found.seen.slice(0, 25) };
    click(button);
    return { ok: true, steps, seen: found.seen.slice(0, 25) };
  }

  const api = { fillAndSearch, findFields, describe, equipmentWanted, dateText, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.McxDatForm = api;
})(typeof self !== 'undefined' ? self : this);
