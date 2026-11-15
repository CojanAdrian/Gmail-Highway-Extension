// BulkPosting bridge: lets the BulkPosting app ask for Highway checks the
// same way the Gmail and DAT tags do (same queue, Highway tabs and saved
// results). The page and this script talk with window.postMessage:
//
//   page -> extension  { source: 'bulkposting', type: 'hello' }
//                      { source: 'bulkposting', type: 'lookup', key, mcs: [...], force }
//                      { source: 'bulkposting', type: 'open-highway', mc }
//                      { source: 'bulkposting', type: 'dat-list', since }   (carriers seen on DAT since then)
//   extension -> page  { source: 'mc-check', type: 'ready', version, loginNeeded }
//                      { source: 'mc-check', type: 'picked', key, mc }   (mc null: none left after the ignore list)
//                      { source: 'mc-check', type: 'result', mc, result }
//                      { source: 'mc-check', type: 'login', needed }
//                      { source: 'mc-check', type: 'dat-carriers', carriers: [{ mc, name, emails, phones, at }] }
(function () {
  if (window.__mcCheckBridge) return;
  window.__mcCheckBridge = true;

  let ignore = new Set();
  const ready = chrome.storage.sync.get({ ignore: [] }).then((s) => {
    ignore = new Set((s.ignore || []).map(McParse.normalizeMc).filter(Boolean));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.ignore) {
      ignore = new Set((changes.ignore.newValue || []).map(McParse.normalizeMc).filter(Boolean));
    }
  });

  function toPage(msg) {
    window.postMessage({ source: 'mc-check', ...msg }, window.location.origin);
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage({ ...msg, from: 'app' }).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // extension reloaded; this page is orphaned
    }
  }

  async function announce() {
    const state = await send({ type: 'state' });
    toPage({ type: 'ready', version: chrome.runtime.getManifest().version, loginNeeded: !!(state && state.loginNeeded) });
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'bulkposting') return;
    const msg = event.data;
    if (msg.type === 'hello') return announce();
    if (msg.type === 'open-highway') return send({ type: 'open-highway', mc: msg.mc || null });
    if (msg.type === 'dat-list') {
      const r = await send({ type: 'dat-list', since: msg.since });
      return toPage({ type: 'dat-carriers', carriers: (r && r.carriers) || [] });
    }
    if (msg.type === 'lookup') {
      await ready;
      const mc = McParse.pickMc(msg.mcs, ignore);
      toPage({ type: 'picked', key: msg.key, mc });
      if (!mc) return;
      const r = await send({ type: 'lookup', mc, force: !!msg.force });
      if (!r) return;
      if (r.result) toPage({ type: 'result', mc, result: r.result });
      if (r.loginNeeded) toPage({ type: 'login', needed: true });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'result') toPage({ type: 'result', mc: msg.mc, result: msg.result });
    else if (msg.type === 'login') toPage({ type: 'login', needed: msg.needed });
    else if (msg.type === 'dat-carriers') toPage({ type: 'dat-carriers', carriers: msg.carriers || [] });
  });

  announce();
})();
