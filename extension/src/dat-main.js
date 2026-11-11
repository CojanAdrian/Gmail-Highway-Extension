// Runs in DAT One's own page context (world: MAIN, document_start).
// Passively reads the API responses DAT already receives (search results,
// refreshes) and hands any carrier MC#s to the extension's content script.
// It never makes requests of its own and never changes the responses.
(function () {
  if (window.__mcxDatHooked) return;
  window.__mcxDatHooked = true;

  const stats = { seen: 0, json: 0, withMcText: 0, withCarriers: 0, parseErrors: 0, lastUrls: [] };
  let shapeSent = false;

  function post(msg) {
    try {
      window.postMessage(Object.assign({ source: 'mcx-dat' }, msg), location.origin);
    } catch (e) {}
  }

  let statsTimer = null;
  function postStatsSoon() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      post({ kind: 'stats', stats });
    }, 800);
  }

  function handleText(text, url) {
    stats.seen++;
    if (url) {
      stats.lastUrls.push(String(url).slice(0, 120));
      if (stats.lastUrls.length > 6) stats.lastUrls.shift();
    }
    postStatsSoon();
    if (!text || typeof text !== 'string') return;
    if (/^\s*[[{]/.test(text)) stats.json++;
    if (text.indexOf('McNumber') === -1 && text.indexOf('mcNumber') === -1) return;
    stats.withMcText++;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      stats.parseErrors++;
      return;
    }
    let carriers;
    try {
      carriers = McxDatExtract.extractCarriers(json);
    } catch (e) {
      stats.parseErrors++;
      return;
    }
    if (!carriers.length) return;
    stats.withCarriers++;
    const msg = { kind: 'carriers', carriers };
    if (!shapeSent) {
      shapeSent = true;
      try {
        msg.shape = McxDatExtract.shapeOfFirstPosting(json);
      } catch (e) {}
    }
    post(msg);
  }

  // fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      const url = typeof input === 'string' ? input : input && input.url;
      p.then((res) => {
        try {
          const type = (res.headers.get('content-type') || '').toLowerCase();
          if (/event-stream|image\/|font\/|audio\/|video\/|octet-stream/.test(type)) return;
          res.clone().text().then((t) => handleText(t, url), () => {});
        } catch (e) {}
      }, () => {});
      return p;
    };
  }

  // XMLHttpRequest
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      this.__mcxUrl = url;
      return origOpen.apply(this, arguments);
    };
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          const rt = this.responseType;
          if (rt === '' || rt === 'text') handleText(this.responseText, this.__mcxUrl);
          else if (rt === 'json' && this.response) handleText(JSON.stringify(this.response), this.__mcxUrl);
          else handleText(null, this.__mcxUrl + ' [responseType=' + rt + ']');
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  post({ kind: 'hello', href: location.href });
})();
