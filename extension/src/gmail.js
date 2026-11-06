// Gmail content script: finds inbox rows, extracts the MC#, shows a tag.
(function () {
  const ROW_SEL = 'tr.zA';
  const PRINT_CONCURRENCY = 4;

  const state = {
    ignore: new Set(),
    loginNeeded: false,
    results: new Map(), // mc -> result from background
    requested: new Set(), // mcs already sent to background from this tab
    threads: new Map(), // rowKey -> { pending } | { mc } | { error }
  };

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

  // ---------- background messaging ----------

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // extension was reloaded; this page is orphaned
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'result') {
      state.results.set(msg.mc, msg.result);
      renderAll();
    } else if (msg.type === 'login') {
      state.loginNeeded = msg.needed;
      renderAll();
    }
  });

  send({ type: 'state' }).then((r) => {
    if (r) {
      state.loginNeeded = !!r.loginNeeded;
      renderAll();
    }
  });

  function requestLookup(mc, force) {
    if (!force && state.requested.has(mc)) return;
    state.requested.add(mc);
    send({ type: 'lookup', mc, force: !!force }).then((r) => {
      if (!r) return;
      if (r.result) state.results.set(mc, r.result);
      if (r.loginNeeded) state.loginNeeded = true;
      renderAll();
    });
  }

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
    tag = document.createElement('span');
    tag.className = 'mcx-tag';
    tag.dataset.key = key;
    for (const ev of ['mousedown', 'mouseup', 'dblclick']) {
      tag.addEventListener(ev, (e) => e.stopPropagation(), true);
    }
    tag.addEventListener('click', onTagClick, true);
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
          if (r.mc) requestLookup(r.mc);
        })
        .catch((err) => {
          console.warn('[MC Check] could not read email', info.threadId, err);
          state.threads.set(info.key, { error: true, message: String((err && err.message) || err) });
        })
        .finally(renderAll);
    }
    renderTag(tag);
  }

  const VIEW = {
    scanning: ['mcx-gray', 'Checking…', 'Looking for an MC# in this email'],
    checking: ['mcx-gray', 'Checking…', 'Waiting for Highway'],
    nomc: ['mcx-muted', 'No MC#', 'No MC# found in this email'],
    readerr: ['mcx-orange', 'MC? ↻', 'Could not read this email. Click to retry.'],
    login: ['mcx-orange', 'Log in to Highway', 'Highway session expired. Click to open Highway and log in.'],
    pass: ['mcx-blue', 'PASS', ''],
    partial: ['mcx-green', 'PARTIAL PASS', ''],
    fail: ['mcx-red', 'FAIL', ''],
    other: ['mcx-yellow', '', ''],
    not_found: ['mcx-yellow', 'Not on Highway', 'No carrier with this MC# on Highway'],
    error: ['mcx-orange', 'Error ↻', 'Highway lookup failed. Click to retry.'],
  };

  function renderTag(tag) {
    const t = state.threads.get(tag.dataset.key);
    let view;
    let mc = null;
    let result = null;
    if (!t || t.pending) view = 'scanning';
    else if (t.error) view = 'readerr';
    else if (t.error) view = 'readerr';
    else if (!t.mc) view = 'nomc';
    else {
      mc = t.mc;
      result = state.results.get(mc);
      if (!result) view = state.loginNeeded ? 'login' : 'checking';
      else view = VIEW[result.status] ? result.status : 'other';
    }
    const [cls, label0, title0] = VIEW[view];
    let label = label0;
    let title = title0;
    if (view === 'other') label = (result && result.label) || 'Unknown';
    if (mc && ['pass', 'partial', 'fail', 'other', 'not_found', 'checking', 'login', 'error'].includes(view)) {
      label = `${label} · MC ${mc}`;
    }
    if (t && t.error && t.message) title = `${title}\n${t.message}`;
    if (result && ['pass', 'partial', 'fail', 'other'].includes(view)) {
      const when = result.checkedAt ? new Date(result.checkedAt).toLocaleString() : '';
      title = `${result.name || ''}\nHighway assessment: ${result.label}\nChecked: ${when}\nClick to open on Highway`.trim();
    }
    const cn = `mcx-tag ${cls}`;
    if (tag.className !== cn) tag.className = cn;
    if (tag.textContent !== label) tag.textContent = label;
    if (tag.title !== title) tag.title = title;
    if (tag.dataset.view !== view) tag.dataset.view = view;
    if ((tag.dataset.mc || '') !== (mc || '')) tag.dataset.mc = mc || '';
  }

  function renderAll() {
    document.querySelectorAll('.mcx-tag').forEach(renderTag);
  }

  function onTagClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const tag = e.currentTarget;
    const view = tag.dataset.view;
    const mc = tag.dataset.mc;
    if (view === 'login') send({ type: 'open-highway' });
    else if (view === 'readerr') {
      state.threads.delete(tag.dataset.key);
      scheduleScan();
    } else if (view === 'error' && mc) {
      state.results.delete(mc);
      requestLookup(mc, true);
      renderAll();
    } else if (mc) send({ type: 'open-highway', mc });
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
