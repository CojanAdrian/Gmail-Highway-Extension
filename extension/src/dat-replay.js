// Learns DAT One's truck search from one search you make, then runs it
// again for any lane, so BulkPosting can find trucks without you opening DAT.
//
// Learning: the requests DAT's own page made during that search are kept
// (never your password or login headers). In them we find the lane you
// searched (cities, states, coordinates, dates, equipment) and the values one
// request passed on from an earlier answer (like a search id). That becomes a
// recipe: the same requests with those spots left open.
//
// Running: inside a DAT page (so your DAT session is used), the recipe's
// requests are sent again with the new lane filled in, each one taking the
// values it needs from the answers before it.
(function (root) {
  const SENSITIVE_RE = /^(cookie|authorization|proxy-authorization)$|token|auth|session|csrf|xsrf|secret|api-?key|signature/i;
  const DROP_HEADER_RE = /^(content-length|host|origin|referer|user-agent|accept-encoding|connection|cookie|sec-|x-mcx)/i;
  const MAX_STEPS = 8;
  const DAY = 86400000;

  // ---------- headers ----------

  function headerEntries(h) {
    if (!h) return [];
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      const out = [];
      h.forEach((v, k) => out.push([k, v]));
      return out;
    }
    return Array.isArray(h) ? h : Object.entries(h);
  }

  // The headers a recipe keeps: everything except login and browser ones.
  function plainHeaders(h) {
    const out = {};
    for (const [k, v] of headerEntries(h)) {
      const key = String(k).toLowerCase();
      if (SENSITIVE_RE.test(key) || DROP_HEADER_RE.test(key)) continue;
      out[key] = String(v);
    }
    return out;
  }

  // Only the login headers (kept in the page's memory, never saved).
  function loginHeaders(h) {
    const out = {};
    for (const [k, v] of headerEntries(h)) {
      const key = String(k).toLowerCase();
      if (key === 'cookie') continue;
      if (SENSITIVE_RE.test(key)) out[key] = String(v);
    }
    return out;
  }

  function stripSensitiveQuery(url) {
    try {
      const u = new URL(url);
      for (const k of [...u.searchParams.keys()]) if (SENSITIVE_RE.test(k)) u.searchParams.delete(k);
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  // ---------- the lane ----------

  const eqi = (a, b) => a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase() && String(a).trim() !== '';

  function caseOf(s) {
    if (s === s.toUpperCase() && s !== s.toLowerCase()) return 'upper';
    if (s === s.toLowerCase() && s !== s.toUpperCase()) return 'lower';
    return 'title';
  }

  function applyCase(s, how) {
    s = String(s == null ? '' : s);
    if (how === 'upper') return s.toUpperCase();
    if (how === 'lower') return s.toLowerCase();
    return s.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  // Which end of the lane a JSON path talks about, if it says.
  function sideOf(path) {
    const p = path.join('.').toLowerCase();
    if (/dest|drop|deliver|consignee|(^|\.)to(\.|$)/.test(p)) return 'dest';
    if (/orig|pick|shipper|(^|\.)from(\.|$)/.test(p)) return 'origin';
    return null;
  }

  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  function shiftDay(day, days) {
    const ms = Date.parse(day + 'T12:00:00Z');
    return isNaN(ms) ? day : isoDay(ms + days * DAY);
  }

  // ---------- templates ----------
  // A template is plain JSON where open spots are { $mcx: ... } objects:
  //   { $mcx: 'lane', f: 'originCity', c: 'upper' }   a lane field
  //   { $mcx: 'num', f: 'originLat' }                 a coordinate
  //   { $mcx: 'day', d: '2026-11-18' }                a date, moved with the lane
  //   { $mcx: 'text', parts: [...] }                  a string with spots inside
  //   { $mcx: 'bind', step: 0, path: [...] }          a value from an earlier answer

  // Every leaf string/number in an answer, with where it is.
  function leaves(json) {
    const out = [];
    (function walk(v, path, depth) {
      if (depth > 30 || v == null) return;
      if (typeof v === 'string' || typeof v === 'number') return out.push({ v, path });
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, path.concat(i), depth + 1));
      else for (const [k, x] of Object.entries(v)) walk(x, path.concat(k), depth + 1);
    })(json, [], 0);
    return out;
  }

  // Values worth binding: ids and similar, not everyday words or small numbers.
  function bindable(v, key) {
    if (typeof v === 'string') return v.length >= 6 && v.length <= 300 && !/^\s|\s$/.test(v) && !/^(true|false|null)$/i.test(v) && /\d/.test(v);
    if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) >= 10000 && /id$/i.test(String(key || ''));
    return false;
  }

  function parseJson(text) {
    if (typeof text !== 'string' || !/^\s*[[{]/.test(text)) return undefined;
    try {
      return JSON.parse(text);
    } catch (e) {
      return undefined;
    }
  }

  function makeLearner(lane, answers) {
    const found = { originPlace: false, destPlace: false };
    const order = { city: 0, state: 0, lat: 0, lng: 0 }; // for an origin and destination that look the same

    // Earlier answers' values -> where they are: the newest answer wins.
    function bindIndex(beforeStep) {
      const index = new Map();
      for (let s = 0; s < beforeStep; s++) {
        for (const leaf of answers[s] || []) {
          const key = leaf.path[leaf.path.length - 1];
          if (bindable(leaf.v, key)) index.set(typeof leaf.v + ':' + leaf.v, { $mcx: 'bind', step: s, path: leaf.path });
        }
      }
      return index;
    }

    function pick(kind, path, isOrigin, isDest) {
      if (isOrigin && isDest) {
        const side = sideOf(path);
        if (side) return side;
        return order[kind]++ % 2 === 0 ? 'origin' : 'dest';
      }
      return isOrigin ? 'origin' : isDest ? 'dest' : null;
    }

    function laneString(s, path) {
      const key = String(path[path.length - 1] || '');
      const city = pick('city', path, eqi(s, lane.originCity), eqi(s, lane.destCity));
      if (city) {
        found[city + 'Place'] = true;
        return { $mcx: 'lane', f: city + 'City', c: caseOf(s) };
      }
      const state = pick('state', path, eqi(s, lane.originState), eqi(s, lane.destState));
      if (state && s.trim().length <= 3) return { $mcx: 'lane', f: state + 'State', c: caseOf(s) };
      if (lane.equipment && eqi(s, lane.equipment) && /equip|trailer|truck|type/i.test(path.join('.') + key)) {
        return { $mcx: 'lane', f: 'equipment', c: caseOf(s) };
      }
      return null;
    }

    // "Chicago, IL", "2026-11-18T08:00:00", ids inside urls and the like.
    function textParts(s, binds, path) {
      const needles = [];
      const sideFirst = sideOf(path || []);
      for (const end of sideFirst === 'dest' ? ['dest', 'origin'] : ['origin', 'dest']) {
        const city = lane[end + 'City'];
        const state = lane[end + 'State'];
        if (city && state) {
          needles.push({ re: new RegExp(escapeRe(city) + '(\\s*,\\s*|\\s+|%2C%20|%2C\\+|,\\+)' + escapeRe(state) + '\\b', 'i'), end });
        }
      }
      let parts = [s];
      let changed = false;
      // Lane places.
      for (const n of needles) {
        parts = parts.flatMap((p) => {
          if (typeof p !== 'string') return [p];
          const m = p.match(n.re);
          if (!m) return [p];
          changed = true;
          found[n.end + 'Place'] = true;
          const at = m.index;
          const cityText = m[0].slice(0, lane[n.end + 'City'].length);
          const stateText = m[0].slice(m[0].length - lane[n.end + 'State'].length);
          return [p.slice(0, at), { $mcx: 'lane', f: n.end + 'City', c: caseOf(cityText) }, m[1], { $mcx: 'lane', f: n.end + 'State', c: caseOf(stateText) }, p.slice(at + m[0].length)];
        });
      }
      // Dates.
      parts = parts.flatMap((p) => {
        if (typeof p !== 'string') return [p];
        const out = [];
        let last = 0;
        p.replace(/\b(20\d\d-[01]\d-[0-3]\d)/g, (m, d, at) => {
          out.push(p.slice(last, at), { $mcx: 'day', d });
          last = at + m.length;
          changed = true;
          return m;
        });
        out.push(p.slice(last));
        return out;
      });
      // Values from earlier answers (longest first, so one id inside another is fine).
      const keys = [...binds.keys()].filter((k) => k.startsWith('string:')).map((k) => k.slice(7)).sort((a, b) => b.length - a.length);
      for (const value of keys) {
        parts = parts.flatMap((p) => {
          if (typeof p !== 'string' || !p.includes(value)) return [p];
          changed = true;
          const pieces = p.split(value);
          const out = [];
          pieces.forEach((piece, i) => {
            if (i) out.push(binds.get('string:' + value));
            out.push(piece);
          });
          return out;
        });
      }
      parts = parts.filter((p) => p !== '');
      return changed ? { $mcx: 'text', parts } : s;
    }

    function laneNumber(n, path) {
      const p = path.join('.').toLowerCase();
      const near = (a, b) => typeof b === 'number' && Math.abs(a - b) < 0.35;
      const isLat = /lat/.test(p) || (!/lon|lng/.test(p) && Math.abs(n) <= 90 && n > 15);
      const isLng = /lon|lng/.test(p) || (!/lat/.test(p) && n < -50);
      if (isLat) {
        const end = pick('lat', path, near(n, lane.originLat), near(n, lane.destLat));
        if (end) {
          found[end + 'Place'] = true;
          return { $mcx: 'num', f: end + 'Lat' };
        }
      }
      if (isLng) {
        const end = pick('lng', path, near(n, lane.originLng), near(n, lane.destLng));
        if (end) return { $mcx: 'num', f: end + 'Lng' };
      }
      return null;
    }

    function template(value, binds) {
      return (function walk(v, path) {
        if (typeof v === 'string') {
          const bound = binds.get('string:' + v);
          if (bound) return bound;
          return laneString(v, path) || textParts(v, binds, path);
        }
        if (typeof v === 'number') {
          const bound = bindable(v, path[path.length - 1]) && binds.get('number:' + v);
          if (bound) return bound;
          return laneNumber(v, path) ?? v;
        }
        if (v == null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map((x, i) => walk(x, path.concat(i)));
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = walk(x, path.concat(k));
        return out;
      })(value, []);
    }

    return { found, template, textParts, bindIndex };
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function usedSteps(t, set = new Set()) {
    if (t && typeof t === 'object') {
      if (t.$mcx === 'bind') set.add(t.step);
      for (const v of Array.isArray(t) ? t : Object.values(t)) usedSteps(v, set);
    }
    return set;
  }

  function hasLane(t) {
    if (!t || typeof t !== 'object') return false;
    if (t.$mcx === 'lane' || t.$mcx === 'num') return true;
    return (Array.isArray(t) ? t : Object.values(t)).some(hasLane);
  }

  // steps: [{ url, method, headers, body, response, hadCarriers }] in the order
  // DAT's page sent them during your search; lane: what you were asked to search.
  // Returns { ok: true, recipe } or { ok: false, error, detail }.
  function buildRecipe(steps, lane, { now = Date.now() } = {}) {
    if (!Array.isArray(steps) || !steps.length) return { ok: false, error: 'no-requests' };
    const answers = steps.map((s) => {
      const json = parseJson(s.response);
      return json === undefined ? [] : leaves(json);
    });
    const learner = makeLearner(lane, answers);
    const templated = steps.map((s, i) => {
      const binds = learner.bindIndex(i);
      const json = parseJson(s.body);
      return {
        method: String(s.method || 'GET').toUpperCase(),
        url: learner.textParts(stripSensitiveQuery(String(s.url)), binds, []),
        headers: plainHeaders(s.headers),
        body: json !== undefined ? { json: learner.template(json, binds) } : s.body ? { text: learner.textParts(String(s.body), binds, []) } : null,
      };
    });
    // The search with carriers in its answer, after (or at) the first one with the lane in it.
    const laneAt = templated.findIndex((t) => hasLane(t.url) || hasLane(t.body));
    if (laneAt < 0 || !learner.found.originPlace || !learner.found.destPlace) {
      return { ok: false, error: 'lane-not-found', detail: { origin: learner.found.originPlace, dest: learner.found.destPlace } };
    }
    const finalAt = steps.findIndex((s, i) => i >= laneAt && s.hadCarriers);
    if (finalAt < 0) return { ok: false, error: 'no-carriers-after-search' };
    // Keep the final search, the requests carrying the lane before it, and
    // every request whose answer one of those needs.
    const keep = new Set([finalAt]);
    templated.forEach((t, i) => i <= finalAt && (hasLane(t.url) || hasLane(t.body)) && keep.add(i));
    for (let changed = true; changed; ) {
      changed = false;
      for (const i of [...keep]) {
        for (const j of usedSteps(templated[i])) if (!keep.has(j)) keep.add(j) && (changed = true);
      }
    }
    const kept = [...keep].sort((a, b) => a - b);
    if (kept.length > MAX_STEPS) return { ok: false, error: 'too-many-requests', detail: { count: kept.length } };
    const renumber = new Map(kept.map((old, i) => [old, i]));
    const fix = (t) => {
      if (!t || typeof t !== 'object') return t;
      if (t.$mcx === 'bind') return { ...t, step: renumber.get(t.step) };
      if (Array.isArray(t)) return t.map(fix);
      const out = {};
      for (const [k, v] of Object.entries(t)) out[k] = fix(v);
      return out;
    };
    return {
      ok: true,
      recipe: {
        v: 1,
        learnedAt: now,
        learnedDay: isoDay(now),
        lane,
        steps: kept.map((i) => fix(templated[i])),
      },
    };
  }

  // ---------- running ----------

  function getPath(json, path) {
    let v = json;
    for (const k of path) {
      if (v == null) return undefined;
      v = v[k];
    }
    return v;
  }

  // Fills a template for a lane. answers: parsed answers of the steps run so far.
  function fill(t, ctx) {
    if (t == null || typeof t !== 'object') return t;
    if (Array.isArray(t)) return t.map((x) => fill(x, ctx));
    switch (t.$mcx) {
      case 'lane':
        return applyCase(ctx.lane[t.f] != null ? ctx.lane[t.f] : ctx.recipe.lane[t.f], t.c);
      case 'num': {
        const v = Number(ctx.lane[t.f]);
        if (!isFinite(v) || ctx.lane[t.f] == null || ctx.lane[t.f] === '') throw Object.assign(new Error('The load has no map position for ' + t.f), { code: 'no-coords' });
        return Math.round(v * 1e6) / 1e6;
      }
      case 'day': {
        const learnedPickup = ctx.recipe.lane.pickupDate;
        if (learnedPickup && t.d === learnedPickup && ctx.lane.pickupDate) return ctx.lane.pickupDate;
        // Other dates keep their distance from the day the search was learned.
        const days = Math.round((Date.parse(ctx.today + 'T12:00:00Z') - Date.parse(ctx.recipe.learnedDay + 'T12:00:00Z')) / DAY);
        let day = shiftDay(t.d, days);
        if (ctx.lane.pickupDate && learnedPickup) {
          // A date range around the pickup moves with the pickup.
          const offset = Math.round((Date.parse(t.d + 'T12:00:00Z') - Date.parse(learnedPickup + 'T12:00:00Z')) / DAY);
          if (Math.abs(offset) <= 7) day = shiftDay(ctx.lane.pickupDate, offset);
        }
        return day < ctx.today && t.d >= ctx.recipe.learnedDay ? ctx.today : day;
      }
      case 'text':
        return t.parts.map((p) => (typeof p === 'string' ? p : String(fill(p, ctx)))).join('');
      case 'bind': {
        const v = getPath(ctx.answers[t.step], t.path);
        if (v === undefined) throw Object.assign(new Error('DAT answered differently than when it was learned'), { code: 'changed' });
        return v;
      }
      default: {
        const out = {};
        for (const [k, v] of Object.entries(t)) out[k] = fill(v, ctx);
        return out;
      }
    }
  }

  // Runs a recipe for a lane. fetchFn is the page's fetch; loginFor(url)
  // gives the login headers the page itself is using for that address.
  // Returns { ok, answerText, status, error, code }.
  async function runRecipe(recipe, lane, { fetchFn, loginFor = () => ({}), now = Date.now() } = {}) {
    const ctx = { recipe, lane, answers: [], today: isoDay(now) };
    let text = '';
    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      let url;
      let body;
      try {
        url = fill(step.url, ctx);
        body = step.body ? (step.body.json !== undefined ? JSON.stringify(fill(step.body.json, ctx)) : fill(step.body.text, ctx)) : undefined;
      } catch (e) {
        return { ok: false, code: e.code || 'fill', error: e.message, step: i };
      }
      const headers = { ...step.headers, ...loginFor(url) };
      let res;
      try {
        res = await fetchFn(url, { method: step.method, headers, body: step.method === 'GET' || step.method === 'HEAD' ? undefined : body, credentials: 'include' });
      } catch (e) {
        return { ok: false, code: 'network', error: String((e && e.message) || e), step: i };
      }
      text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) return { ok: false, code: 'login', status: res.status, step: i };
      if (!res.ok) return { ok: false, code: 'http', status: res.status, error: text.slice(0, 200), step: i };
      const json = parseJson(text);
      ctx.answers[i] = json;
      // GraphQL reports failures inside a normal answer.
      if (json && Array.isArray(json.errors) && json.errors.length && !json.data) {
        const msg = String((json.errors[0] && json.errors[0].message) || 'error');
        return { ok: false, code: /auth|token|login|unauthor/i.test(msg) ? 'login' : 'http', error: msg.slice(0, 200), step: i };
      }
    }
    return { ok: true, answerText: text };
  }

  // A short, safe description of a recipe for diagnostics.
  function describeRecipe(recipe) {
    if (!recipe) return null;
    const urlText = (t) => (typeof t === 'string' ? t : t.parts.map((p) => (typeof p === 'string' ? p : '{' + (p.f || p.$mcx) + '}')).join(''));
    return {
      learnedAt: new Date(recipe.learnedAt).toISOString(),
      lane: recipe.lane,
      steps: recipe.steps.map((s) => ({ method: s.method, url: urlText(s.url).slice(0, 160), withLane: hasLane(s.url) || hasLane(s.body), uses: [...usedSteps(s)] })),
      startUrl: recipe.startUrl || null,
    };
  }

  const api = { buildRecipe, runRecipe, fill, plainHeaders, loginHeaders, describeRecipe, applyCase, SENSITIVE_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.McxDatReplay = api;
})(typeof self !== 'undefined' ? self : this);
