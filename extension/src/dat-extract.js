// Pulls carriers out of DAT One API responses (GraphQL JSON).
// We don't depend on DAT's exact schema: any object with a "carrierMcNumber"
// (or similar) field marks a carrier; the posting it belongs to is the nearest
// enclosing array element, and its company name is any string under a key
// containing "company" (or "name") in that posting.
(function (root) {
  // carrierMcNumber, mcNumber, carrierMc, mc (brokerMcNumber is excluded below)
  const MC_KEY_RE = /^(carrier)?mc(number)?$/i;
  const NAME_KEY_RE = /company|^name$|posterName|carrierName|legalName|dbaName/i;
  const SKIP_NAME_KEY_RE = /city|state|place|location|contactName|firstName|lastName|userName|__typename/i;
  const PHONE_RE = /\d{3}\D{0,3}\d{3}\D{0,2}\d{4}/;
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  function normMc(v) {
    if (v == null) return null;
    const s = String(v).replace(/\D/g, '').replace(/^0+/, '');
    return s.length >= 3 && s.length <= 8 ? s : null;
  }

  function normName(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/[.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Collect name / phone / email strings inside a posting object.
  function describePosting(obj) {
    const names = new Set();
    const contacts = new Set();
    (function walk(v, key, depth) {
      if (depth > 8 || v == null) return;
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return;
        if (key && NAME_KEY_RE.test(key) && !SKIP_NAME_KEY_RE.test(key) && s.length >= 2 && s.length <= 100) {
          names.add(normName(s));
        }
        if (EMAIL_RE.test(s)) contacts.add(s.toLowerCase());
        else if (PHONE_RE.test(s) && s.replace(/\D/g, '').length <= 15) contacts.add(s.replace(/\D/g, ''));
        return;
      }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) v.forEach((x) => walk(x, key, depth + 1));
      else for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
    })(obj, null, 0);
    return { names: [...names], contacts: [...contacts] };
  }

  // Returns [{ mc, names: [...], contacts: [...] }], one per posting found.
  function extractCarriers(json) {
    const out = [];
    const seen = new Set();
    // `posting` = nearest enclosing array element
    (function walk(v, posting, depth) {
      if (depth > 40 || v == null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x, x && typeof x === 'object' ? x : posting, depth + 1);
        return;
      }
      for (const [k, x] of Object.entries(v)) {
        if (MC_KEY_RE.test(k) && !/broker/i.test(k)) {
          const mc = normMc(x);
          const p = posting || v;
          if (mc && !seen.has(p)) {
            seen.add(p);
            const d = describePosting(p);
            out.push({ mc, names: d.names, contacts: d.contacts });
          }
        }
        if (x && typeof x === 'object') walk(x, posting, depth + 1);
      }
    })(json, null, 0);
    return out;
  }

  // Diagnostics: "path = value" lines for the first posting that has a
  // carrier MC, so DAT's data layout can be inspected.
  function shapeOfFirstPosting(json) {
    let found = null;
    (function walk(v, posting, depth) {
      if (found || depth > 40 || v == null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x, x && typeof x === 'object' ? x : posting, depth + 1);
        return;
      }
      for (const [k, x] of Object.entries(v)) {
        if (MC_KEY_RE.test(k) && !/broker/i.test(k) && normMc(x)) {
          found = posting || v;
          return;
        }
        if (x && typeof x === 'object') walk(x, posting, depth + 1);
      }
    })(json, null, 0);
    if (!found) return null;
    const lines = [];
    (function walk(v, path, depth) {
      if (lines.length >= 90 || depth > 8) return;
      if (v == null || typeof v !== 'object') {
        if (v === null || v === '') return;
        lines.push(`${path} = ${JSON.stringify(v).slice(0, 50)}`);
        return;
      }
      if (Array.isArray(v)) v.slice(0, 3).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      else for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
    })(found, '', 0);
    return lines;
  }

  const api = { extractCarriers, normName, normMc, shapeOfFirstPosting };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.McxDatExtract = api;
})(typeof self !== 'undefined' ? self : this);
