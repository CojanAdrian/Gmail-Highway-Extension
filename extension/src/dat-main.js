// Runs in DAT One's own page context (world: MAIN, document_start).
// Reads the API answers DAT already receives (search results, refreshes)
// and hands any carrier MC#s to the extension's content script. It never
// changes DAT's requests or answers.
//
// For BulkPosting's automatic truck search it also:
//  - while learning, keeps the requests this page sends during your one
//    truck search (login headers left out) and hands them over;
//  - remembers, in memory only, the login headers the page itself is using,
//    so a learned search can be sent again from this page (McxDatReplay).
(function () {
  if (window.__mcxDatHooked) return;
  window.__mcxDatHooked = true;

  const stats = { seen: 0, json: 0, withMcText: 0, withCarriers: 0, parseErrors: 0, lastUrls: [] };
  let shapeSent = false;
  const MAX_LEARN_STEPS = 60;
  const MAX_ANSWER = 400000;

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

  // Returns the carriers found in an answer (possibly none).
  function handleText(text, url) {
    stats.seen++;
    if (url) {
      stats.lastUrls.push(String(url).slice(0, 120));
      if (stats.lastUrls.length > 6) stats.lastUrls.shift();
    }
    postStatsSoon();
    if (!text || typeof text !== 'string') return [];
    if (/^\s*[[{]/.test(text)) stats.json++;
    if (text.indexOf('McNumber') === -1 && text.indexOf('mcNumber') === -1) return [];
    stats.withMcText++;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      stats.parseErrors++;
      return [];
    }
    let carriers;
    try {
      carriers = McxDatExtract.extractCarriers(json);
    } catch (e) {
      stats.parseErrors++;
      return [];
    }
    if (!carriers.length) return [];
    stats.withCarriers++;
    const msg = { kind: 'carriers', carriers };
    if (!shapeSent) {
      shapeSent = true;
      try {
        msg.shape = McxDatExtract.shapeOfFirstPosting(json);
      } catch (e) {}
    }
    post(msg);
    return carriers;
  }

  // ---------- login headers and learning ----------

  const R = window.McxDatReplay;
  const loginByHost = new Map(); // host -> login headers the page last used
  let learning = false;
  let learnSteps = [];
  let replaying = 0;

  function hostOf(url) {
    try {
      return new URL(url, location.href).host;
    } catch (e) {
      return '';
    }
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).toString();
    } catch (e) {
      return String(url);
    }
  }

  function noteRequest(url, headers) {
    if (!R) return;
    const login = R.loginHeaders(headers);
    if (!Object.keys(login).length) return;
    const host = hostOf(url);
    const first = !loginByHost.has(host);
    loginByHost.set(host, login);
    if (first) post({ kind: 'login-seen', host });
  }

  function record(req, text, carriers) {
    if (!learning || replaying || !R) return;
    if (!text || !/^\s*[[{]/.test(text)) return; // only API answers
    learnSteps.push({
      url: absolute(req.url),
      method: req.method || 'GET',
      headers: R.plainHeaders(req.headers),
      body: typeof req.body === 'string' ? req.body : null,
      response: text.length > MAX_ANSWER ? text.slice(0, MAX_ANSWER) : text,
      hadCarriers: carriers.length > 0,
    });
    if (learnSteps.length > MAX_LEARN_STEPS) learnSteps.shift();
    if (carriers.length) post({ kind: 'learn-steps', steps: learnSteps.slice(), href: location.href });
  }

  // ---------- fetch ----------

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      const req = { url: typeof input === 'string' || input instanceof URL ? String(input) : input && input.url, method: (init && init.method) || (input && input.method) || 'GET', headers: (init && init.headers) || (input && input.headers) || null, body: init ? init.body : null };
      try {
        noteRequest(req.url, req.headers);
      } catch (e) {}
      // A Request object carries its own body.
      const bodyReady = !init && input && typeof input === 'object' && input.clone && learning && !/^(GET|HEAD)$/i.test(req.method)
        ? input.clone().text().then((t) => (req.body = t), () => {})
        : Promise.resolve();
      p.then((res) => {
        try {
          const type = (res.headers.get('content-type') || '').toLowerCase();
          if (/event-stream|image\/|font\/|audio\/|video\/|octet-stream/.test(type)) return;
          res.clone().text().then((t) => {
            const carriers = handleText(t, req.url);
            bodyReady.then(() => record(req, t, carriers));
          }, () => {});
        } catch (e) {}
      }, () => {});
      return p;
    };
  }

  // ---------- XMLHttpRequest ----------

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      this.__mcxUrl = url;
      this.__mcxMethod = method;
      this.__mcxHeaders = {};
      return origOpen.apply(this, arguments);
    };
    const origSetHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.setRequestHeader = function (k, v) {
      try {
        if (this.__mcxHeaders) this.__mcxHeaders[k] = v;
      } catch (e) {}
      return origSetHeader.apply(this, arguments);
    };
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function (body) {
      const req = { url: this.__mcxUrl, method: this.__mcxMethod || 'GET', headers: this.__mcxHeaders || {}, body: typeof body === 'string' ? body : null };
      try {
        noteRequest(req.url, req.headers);
      } catch (e) {}
      this.addEventListener('load', function () {
        try {
          const rt = this.responseType;
          let text = null;
          if (rt === '' || rt === 'text') text = this.responseText;
          else if (rt === 'json' && this.response) text = JSON.stringify(this.response);
          const carriers = handleText(text, text == null ? this.__mcxUrl + ' [responseType=' + rt + ']' : this.__mcxUrl);
          record(req, text, carriers);
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  // ---------- commands from the extension (dat.js) ----------

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'mcx-dat-cmd') return;
    const cmd = e.data;
    if (cmd.kind === 'learn') {
      learning = !!cmd.on;
      learnSteps = [];
      return;
    }
    if (cmd.kind === 'replay') {
      if (!R) return post({ kind: 'replay-done', id: cmd.id, ok: false, code: 'not-ready' });
      replaying++;
      let out;
      try {
        out = await R.runRecipe(cmd.recipe, cmd.lane, {
          fetchFn: (url, init) => window.fetch(url, init),
          loginFor: (url) => loginByHost.get(hostOf(url)) || {},
        });
      } catch (err) {
        out = { ok: false, code: 'error', error: String((err && err.message) || err) };
      } finally {
        replaying--;
      }
      let carriers = [];
      if (out.ok) {
        try {
          carriers = McxDatExtract.extractCarriers(JSON.parse(out.answerText));
        } catch (err) {}
      }
      delete out.answerText;
      post({ kind: 'replay-done', id: cmd.id, ...out, carriers });
    }
  });

  post({ kind: 'hello', href: location.href, hosts: [...loginByHost.keys()] });
})();
