// DAT One content script: receives carriers from dat-main.js (MC#s read
// from DAT's own search responses), starts Highway lookups for all of them
// right away, and puts a compact PASS/FAIL tag before each company name.
(function () {
  const { normName } = McxDatExtract;
  const store = McxTags.createStore(() => renderAll());
  const byName = new Map(); // normalized company name -> Map(mc -> contacts[])
  let ignore = new Set();

  chrome.storage.sync.get({ ignore: [] }).then((s) => {
    ignore = new Set((s.ignore || []).map((x) => String(x).replace(/^0+/, '')));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.ignore) {
      ignore = new Set((changes.ignore.newValue || []).map((x) => String(x).replace(/^0+/, '')));
    }
  });

  // ---------- diagnostics (sent to the background, shown in settings) ----------

  const diag = {
    frame: window === window.top ? 'top' : 'iframe',
    href: location.href,
    contentScript: true,
    hookHello: false,
    hook: null,
    carrierMessages: 0,
    carriers: 0,
    uniqueMcs: 0,
    sampleCarriers: [],
    shape: null,
    tagsOnPage: 0,
    unmatchedRows: [],
    iframes: [],
  };
  const seenMcs = new Set();

  let diagTimer = null;
  function reportSoon() {
    if (diagTimer) return;
    diagTimer = setTimeout(() => {
      diagTimer = null;
      diag.href = location.href;
      diag.tagsOnPage = document.querySelectorAll('.mcx-tag').length;
      if (window === window.top) {
        diag.iframes = [...document.querySelectorAll('iframe')].map((f) => (f.src || '(no src)').slice(0, 120)).slice(0, 8);
      }
      if (diag.carriers && !diag.tagsOnPage) diag.unmatchedRows = sampleUnmatched();
      store.send({ type: 'dat-stats', stats: diag });
    }, 1500);
  }

  // For a few carriers, find their row on screen by phone number and report
  // the row's text, to see why the company name didn't match.
  function sampleUnmatched() {
    const out = [];
    if (!document.body) return out;
    const phones = [];
    for (const m of byName.values()) {
      for (const contacts of m.values()) {
        for (const c of contacts) if (/^\d{10,}$/.test(c)) phones.push(c.slice(-10));
      }
      if (phones.length >= 6) break;
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && out.length < 3) {
      const digits = (node.nodeValue || '').replace(/\D/g, '');
      if (digits.length < 10) continue;
      if (!phones.some((p) => digits.includes(p))) continue;
      let row = node.parentElement;
      for (let i = 0; i < 6 && row.parentElement && (row.parentElement.textContent || '').length < 600; i++) {
        row = row.parentElement;
      }
      out.push((row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300));
    }
    if (!out.length) out.push('(no row on screen contains any carrier phone number from the data)');
    return out;
  }

  reportSoon();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'mcx-dat') return;
    const d = e.data;
    if (d.kind === 'hello') {
      diag.hookHello = true;
      reportSoon();
      return;
    }
    if (d.kind === 'stats') {
      diag.hook = d.stats;
      reportSoon();
      return;
    }
    diag.carrierMessages++;
    if (d.shape) diag.shape = d.shape;
    for (const c of d.carriers || []) {
      diag.carriers++;
      if (c && c.mc && !seenMcs.has(c.mc)) {
        seenMcs.add(c.mc);
        if (diag.sampleCarriers.length < 5) diag.sampleCarriers.push({ mc: c.mc, names: c.names });
      }
    }
    diag.uniqueMcs = seenMcs.size;
    reportSoon();
    for (const c of d.carriers || []) {
      if (!c || !c.mc || ignore.has(c.mc)) continue;
      for (const name of c.names || []) {
        if (!name) continue;
        let m = byName.get(name);
        if (!m) byName.set(name, (m = new Map()));
        m.set(c.mc, c.contacts || []);
      }
      store.request(c.mc); // every posting, visible or not
    }
    scheduleScan();
  });

  // ---------- matching rows on screen ----------

  function textOf(el) {
    return (el && el.textContent) || '';
  }

  // Which known company does this on-screen text refer to?
  function lookupName(raw) {
    let t = raw.trim();
    const truncated = /(\.\.\.|…)$/.test(t);
    if (truncated) t = t.replace(/(\.\.\.|…)$/, '');
    const key = normName(t);
    if (key.length < 2) return null;
    if (!truncated) return byName.get(key) || null;
    if (key.length < 4) return null;
    const merged = new Map();
    for (const [name, m] of byName) {
      if (name.startsWith(key)) for (const [mc, c] of m) merged.set(mc, c);
    }
    return merged.size ? merged : null;
  }

  // Several carriers with the same name: use the row's phone/email to choose.
  function pickMc(candidates, el, nameText) {
    if (candidates.size === 1) return candidates.keys().next().value;
    // Climb to the posting's row: stop before an element that holds the same
    // company name twice (= several rows).
    const key = normName(nameText.replace(/(\.\.\.|…)\s*$/, ''));
    let row = el;
    for (let i = 0; i < 8 && row.parentElement; i++) {
      const p = row.parentElement;
      const pt = textOf(p);
      if (pt.length > 3000 || normName(pt).split(key).length - 1 > 1) break;
      row = p;
    }
    const text = textOf(row).toLowerCase();
    const digits = text.replace(/\D/g, '');
    for (const [mc, contacts] of candidates) {
      for (const c of contacts) {
        if (c.includes('@') ? text.includes(c.slice(0, 12)) : c.length >= 10 && digits.includes(c.slice(-10))) {
          return mc;
        }
      }
    }
    return null;
  }

  const SKIP_PARENTS = /^(SCRIPT|STYLE|NOSCRIPT|INPUT|TEXTAREA|SELECT|OPTION|TITLE)$/;

  function scan() {
    if (!byName.size || !document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = [];
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      if (!v || v.length > 120) continue;
      const trimmed = v.trim();
      if (trimmed.length < 2) continue;
      const parent = node.parentElement;
      if (!parent || SKIP_PARENTS.test(parent.tagName) || parent.closest('.mcx-tag')) continue;
      const cands = lookupName(trimmed);
      if (cands) found.push({ node, parent, cands });
    }
    for (const { node, parent, cands } of found) {
      const mc = pickMc(cands, parent, node.nodeValue);
      if (!mc) continue;
      // Put the tag before the element holding just the name (e.g. the link),
      // or right before the text if the element holds more than the name.
      const wrapperOnlyName = textOf(parent).trim() === node.nodeValue.trim();
      const anchor = wrapperOnlyName ? parent : node;
      const prev = anchor.previousSibling;
      let tag = prev && prev.nodeType === 1 && prev.classList.contains('mcx-tag') ? prev : null;
      if (!tag) {
        tag = McxTags.makeTag((t) => {
          McxTags.defaultClick(store, t);
          renderAll();
        });
        tag.dataset.compact = '1';
        anchor.parentNode.insertBefore(tag, anchor);
      }
      tag.dataset.forMc = mc;
      renderTag(tag);
    }
    reportSoon();
  }

  function renderTag(tag) {
    const mc = tag.dataset.forMc;
    if (!mc) return;
    McxTags.apply(tag, McxTags.describe(store, { state: null, mc, compact: true }));
  }

  function renderAll() {
    document.querySelectorAll('.mcx-tag[data-for-mc]').forEach(renderTag);
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 250);
  }

  function start() {
    new MutationObserver((muts) => {
      // Ignore mutations caused only by our own tags.
      for (const m of muts) {
        const t = m.target;
        if (t.nodeType === 1 && t.classList && t.classList.contains('mcx-tag')) continue;
        if ([...m.addedNodes].every((n) => n.nodeType === 1 && n.classList && n.classList.contains('mcx-tag'))
            && m.removedNodes.length === 0 && m.addedNodes.length) continue;
        scheduleScan();
        return;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleScan();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
