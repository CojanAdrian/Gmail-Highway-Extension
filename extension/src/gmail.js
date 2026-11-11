// Gmail content script: finds inbox rows, extracts the MC#, shows a tag.
(function () {
  const ROW_SEL = 'tr.zA';
  const PRINT_CONCURRENCY = 4;

  const state = {
    ignore: new Set(),
    threads: new Map(), // rowKey -> { pending } | { mc } | { error }
  };
  const store = McxTags.createStore(() => renderAll());

  // ---------- settings ----------

  function setIgnore(list) {
    state.ignore = new Set((list || []).map(McParse.normalizeMc).filter(Boolean));
  }

  chrome.storage.sync.get({ ignore: [] }).then((s) => {
    setIgnore(s.ignore);
    scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.ignore) {
      setIgnore(changes.ignore.newValue);
      state.threads.clear(); // re-extract with the new ignore list
      scheduleScan();
    }
  });

  // ---------- reading full emails (Gmail print view) ----------

  function getIk() {
    const attr = document.documentElement.getAttribute('data-mcx-ik');
    if (attr) return attr;
    for (const s of document.scripts) {
      const m = /GLOBALS=\[(?:(?:"[^"]*"|[^,[\]]*),){9}"([0-9a-f]{6,16})"/.exec(s.textContent || '');
      if (m) return m[1];
    }
    return null;
  }

  function accountPath() {
    const m = /\/mail\/u\/(\d+)/.exec(location.pathname);
    return `/mail/u/${m ? m[1] : 0}/`;
  }

  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'TR', 'TABLE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  ]);

  function htmlToText(node) {
    let out = '';
    (function walk(n) {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) out += '\n';
      for (const c of n.childNodes) walk(c);
      if (block) out += '\n';
      if (tag === 'TD') out += ' ';
    })(node);
    return out;
  }

  // Newest-first list of each message's text, quoted parts removed.
  async function fetchThreadMessages(threadId) {
    const ik = getIk();
    const qs = (ik ? `ik=${ik}&` : '') + `view=pt&search=all&th=${encodeURIComponent(threadId)}`;
    const res = await fetch(`${location.origin}${accountPath()}?${qs}`, { credentials: 'include' });
    if (!res.ok) throw new Error('print view HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    let msgs = Array.from(doc.querySelectorAll('table.message'));
    if (!msgs.length) msgs = [doc.body];
    return msgs.reverse().map((el) => {
      const clone = el.cloneNode(true);
      clone
        .querySelectorAll('blockquote, .gmail_quote, .gmail_extra, #divRplyFwdMsg, #appendonsend ~ *')
        .forEach((q) => q.remove());
      return htmlToText(clone);
    });
  }

  // Small concurrency limiter for print-view fetches.
  let printActive = 0;
  const printWaiting = [];
  function limited(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        printActive++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            printActive--;
            if (printWaiting.length) printWaiting.shift()();
          });
      };
      if (printActive < PRINT_CONCURRENCY) run();
      else printWaiting.push(run);
    });
  }

  // Subject/preview first; only reads the full email if no MC# is there.
  async function resolveRow(threadId, subject, snippet) {
    const quick = McParse.extractMc({ subject, snippet }, state.ignore);
    if (quick) return { mc: quick };
    const messages = await limited(() => fetchThreadMessages(threadId));
    return { mc: McParse.extractMc({ subject, snippet, messages }, state.ignore) };
  }

  // ---------- rows & tags ----------

  function text(row, sel) {
    const el = row.querySelector(sel);
    return el ? el.textContent.trim() : '';
  }

  function rowInfo(row) {
    const idEl = row.querySelector('[data-legacy-thread-id]');
    const threadId = idEl && idEl.getAttribute('data-legacy-thread-id');
    if (!threadId) return null;
    const subject = text(row, 'span.bog');
    const snippet = text(row, 'span.y2');
    // Key changes when a new message arrives in the thread (snippet changes).
    const key = `${threadId}|${snippet.slice(0, 80)}`;
    return { threadId, subject, snippet, key };
  }

  function ensureTag(row, key) {
    let tag = row.querySelector('.mcx-tag');
    if (tag && tag.dataset.key === key) return tag;
    if (tag) tag.remove();
    tag = McxTags.makeTag(onTagClick);
    tag.dataset.key = key;
    // Right end of the subject/snippet cell = just left of the timestamp.
    const host = row.querySelector('.xT');
    if (!host) return null;
    host.classList.add('mcx-host');
    host.appendChild(tag);
    return tag;
  }

  function processRow(row) {
    const info = rowInfo(row);
    if (!info) return;
    const tag = ensureTag(row, info.key);
    if (!tag) return;
    if (!state.threads.has(info.key)) {
      state.threads.set(info.key, { pending: true });
      resolveRow(info.threadId, info.subject, info.snippet)
        .then((r) => {
          state.threads.set(info.key, r);
          if (r.mc) store.request(r.mc);
        })
        .catch((err) => {
          console.warn('[MC Check] could not read email', info.threadId, err);
          state.threads.set(info.key, { error: true, message: String((err && err.message) || err) });
        })
        .finally(renderAll);
    }
    renderTag(tag);
  }

  function renderTag(tag) {
    const t = state.threads.get(tag.dataset.key);
    let s = null;
    if (!t || t.pending) s = 'scanning';
    else if (t.error) s = 'readerr';
    else if (!t.mc) s = 'nomc';
    McxTags.apply(
      tag,
      McxTags.describe(store, { state: s, mc: t && t.mc, errorMessage: t && t.error ? t.message : '' })
    );
  }

  function renderAll() {
    document.querySelectorAll('.mcx-tag').forEach(renderTag);
  }

  function onTagClick(tag) {
    if (tag.dataset.view === 'readerr') {
      state.threads.delete(tag.dataset.key);
      scheduleScan();
      return;
    }
    McxTags.defaultClick(store, tag);
    renderAll();
  }

  // ---------- watching Gmail ----------

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      document.querySelectorAll(ROW_SEL).forEach(processRow);
    }, 150);
  }

  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  scheduleScan();
})();
