// Runs in DAT One's own page context (world: MAIN, document_start).
// Passively reads the API responses DAT already receives (search results,
// refreshes) and hands any carrier MC#s to the extension's content script.
// It never makes requests of its own and never changes the responses.
(function () {
  if (window.__mcxDatHooked) return;
  window.__mcxDatHooked = true;

  function handleText(text) {
    if (!text || typeof text !== 'string' || text.indexOf('McNumber') === -1) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return;
    }
    let carriers;
    try {
      carriers = McxDatExtract.extractCarriers(json);
    } catch (e) {
      return;
    }
    if (carriers.length) window.postMessage({ source: 'mcx-dat', carriers }, location.origin);
  }

  // fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      const p = origFetch.apply(this, arguments);
      p.then((res) => {
        try {
          const type = res.headers.get('content-type') || '';
          if (type.indexOf('json') === -1) return;
          res.clone().text().then(handleText, () => {});
        } catch (e) {}
      }, () => {});
      return p;
    };
  }

  // XMLHttpRequest
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          const rt = this.responseType;
          if (rt === '' || rt === 'text') handleText(this.responseText);
          else if (rt === 'json' && this.response) handleText(JSON.stringify(this.response));
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }
})();
