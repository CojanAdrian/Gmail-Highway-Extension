// Shared by the Gmail and DAT content scripts: talks to the background
// (lookups, results, login state) and draws the PASS/FAIL tags.
(function (root) {
  const VIEW = {
    scanning: ['mcx-gray', 'Checking…', 'Looking for an MC#'],
    checking: ['mcx-gray', 'Checking…', 'Waiting for Highway'],
    nomc: ['mcx-muted', 'No MC#', 'No MC# found'],
    readerr: ['mcx-orange', 'MC? ↻', 'Could not read this email. Click to retry.'],
    login: ['mcx-orange', 'Log in to Highway', 'Highway session expired. Click to open Highway and log in.'],
    pass: ['mcx-blue', 'PASS', ''],
    partial: ['mcx-green', 'PARTIAL PASS', ''],
    fail: ['mcx-red', 'FAIL', ''],
    other: ['mcx-yellow', '', ''],
    not_found: ['mcx-yellow', 'Not on Highway', 'No carrier with this MC# on Highway'],
    error: ['mcx-orange', 'Error ↻', 'Highway lookup failed. Click to retry.'],
  };
  // Short labels for narrow columns (DAT).
  const COMPACT = { partial: 'PARTIAL', login: 'Log in', not_found: 'N/A', checking: '…', scanning: '…' };

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // extension was reloaded; this page is orphaned
    }
  }

  // One per page. onChange is called whenever a result or the login state changes.
  function createStore(onChange) {
    const results = new Map(); // mc -> result
    const requested = new Set();
    const store = { loginNeeded: false, results, send };

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'result') {
        results.set(msg.mc, msg.result);
        onChange();
      } else if (msg.type === 'login') {
        store.loginNeeded = msg.needed;
        onChange();
      }
    });

    send({ type: 'state' }).then((r) => {
      if (r) {
        store.loginNeeded = !!r.loginNeeded;
        onChange();
      }
    });

    store.request = function (mc, force) {
      if (!force && requested.has(mc)) return;
      requested.add(mc);
      if (force) results.delete(mc);
      send({ type: 'lookup', mc, force: !!force }).then((r) => {
        if (!r) return;
        if (r.result) results.set(mc, r.result);
        if (r.loginNeeded) store.loginNeeded = true;
        onChange();
      });
    };
    return store;
  }

  // What a tag should show.
  //   state: 'scanning' | 'readerr' | 'nomc' | null (null = we have an MC)
  function describe(store, { state, mc, compact, errorMessage }) {
    let view = state;
    let result = null;
    if (!view) {
      result = store.results.get(mc);
      if (!result) view = store.loginNeeded ? 'login' : 'checking';
      else view = VIEW[result.status] ? result.status : 'other';
    }
    const [cls, label0, title0] = VIEW[view];
    let label = (compact && COMPACT[view]) || label0;
    let title = title0;
    if (view === 'other') label = (result && result.label) || 'Unknown';
    if (mc && !compact && !['scanning', 'nomc', 'readerr'].includes(view)) label = `${label} · MC ${mc}`;
    if (errorMessage) title = `${title}\n${errorMessage}`;
    if (result && ['pass', 'partial', 'fail', 'other'].includes(view)) {
      const when = result.checkedAt ? new Date(result.checkedAt).toLocaleString() : '';
      title = `${result.name || ''}\nMC ${mc} · Highway assessment: ${result.label}\nChecked: ${when}\nClick to open on Highway`.trim();
    } else if (mc && compact) {
      title = `MC ${mc}\n${title}`.trim();
    }
    return { view, cls, label, title, mc: mc || '' };
  }

  function makeTag(onClick) {
    const tag = document.createElement('span');
    tag.className = 'mcx-tag';
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
      tag.addEventListener(ev, (e) => e.stopPropagation(), true);
    }
    tag.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(tag);
      },
      true
    );
    return tag;
  }

  function apply(tag, d) {
    const cn = `mcx-tag ${d.cls}${tag.dataset.compact ? ' mcx-compact' : ''}`;
    if (tag.className !== cn) tag.className = cn;
    if (tag.textContent !== d.label) tag.textContent = d.label;
    if (tag.title !== d.title) tag.title = d.title;
    if (tag.dataset.view !== d.view) tag.dataset.view = d.view;
    if ((tag.dataset.mc || '') !== d.mc) tag.dataset.mc = d.mc;
  }

  // Default click behavior. Returns true if handled.
  function defaultClick(store, tag) {
    const view = tag.dataset.view;
    const mc = tag.dataset.mc;
    if (view === 'login') send({ type: 'open-highway' });
    else if (view === 'error' && mc) store.request(mc, true);
    else if (mc) send({ type: 'open-highway', mc });
    else return false;
    return true;
  }

  root.McxTags = { createStore, describe, makeTag, apply, defaultClick };
})(typeof self !== 'undefined' ? self : this);
