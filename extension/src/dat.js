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

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'mcx-dat') return;
    for (const c of e.data.carriers || []) {
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
