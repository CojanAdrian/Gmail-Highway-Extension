// MC# extraction from email text. Pure functions, shared by the Gmail content
// script and the Node tests.
(function (root) {
  // Matches: MC# 123456, MC#123456, MC 123456, MC-123456, MC123456,
  // M.C. #123456, MC Number: 123456, MC No. 123456, MC #: 123456, MC: 123456
  const MC_RE =
    /\bM\.?\s?C\.?\s*(?:#|No\.?|Num(?:ber)?\.?)?\s*[:#\-]?\s*#?\s*(\d{3,8})(?!\d)/gi;

  function normalizeMc(mc) {
    const s = String(mc).replace(/\D/g, '').replace(/^0+/, '');
    return s || null;
  }

  // All MC numbers in a text, in order of appearance, normalized, de-duplicated.
  function findAllMcs(text) {
    const out = [];
    if (!text) return out;
    MC_RE.lastIndex = 0;
    let m;
    while ((m = MC_RE.exec(text))) {
      const mc = normalizeMc(m[1]);
      if (mc && !out.includes(mc)) out.push(mc);
    }
    return out;
  }

  // First MC in the text that is not in the ignore list.
  function findFirstMc(text, ignore) {
    const ign = toIgnoreSet(ignore);
    return findAllMcs(text).find((mc) => !ign.has(mc)) || null;
  }

  function toIgnoreSet(ignore) {
    if (ignore instanceof Set) return ignore;
    return new Set((ignore || []).map(normalizeMc).filter(Boolean));
  }

  // Cut a plain-text email body down to the part written in this message,
  // dropping quoted replies / forwarded history.
  function stripQuoted(text) {
    if (!text) return '';
    let t = String(text).replace(/\r\n?/g, '\n');
    const cutters = [
      // Gmail / Apple: "On Mon, Nov 3, 2026 at 9:00 AM John <j@x.com> wrote:" (may wrap)
      /(^|\n)[ \t]*On [^\n]{0,250}?(\n[^\n]{0,120}?)?wrote:[ \t]*(\n|$)/i,
      // Outlook
      /(^|\n)[ \t]*-{2,}\s*Original Message\s*-{2,}/i,
      /(^|\n)[ \t]*_{8,}[ \t]*\n[ \t]*From:/i,
      /(^|\n)[ \t]*From:[^\n]*\n(?:[^\n]*\n){0,3}?[ \t]*(?:Sent|Date):/i,
      // Forwards
      /(^|\n)[ \t]*-{2,}\s*Forwarded message\s*-{2,}/i,
    ];
    let cut = t.length;
    for (const re of cutters) {
      const m = re.exec(t);
      if (m && m.index < cut) cut = m.index;
    }
    t = t.slice(0, cut);
    return t
      .split('\n')
      .filter((line) => !/^\s*>/.test(line))
      .join('\n');
  }

  // Decide which MC an email is about.
  //   subject, snippet: strings from the inbox row
  //   messages: array of plain-text message bodies, NEWEST FIRST (optional)
  // Subject/snippet first, then the newest message's own text, then older
  // messages' own text (only if the newest one has no MC at all).
  function extractMc({ subject, snippet, messages }, ignore) {
    const ign = toIgnoreSet(ignore);
    const quick = findFirstMc(`${subject || ''}\n${snippet || ''}`, ign);
    if (quick) return quick;
    for (const body of messages || []) {
      const mc = findFirstMc(stripQuoted(body), ign);
      if (mc) return mc;
    }
    return null;
  }

  const api = { findAllMcs, findFirstMc, stripQuoted, extractMc, normalizeMc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.McParse = api;
})(typeof self !== 'undefined' ? self : this);
