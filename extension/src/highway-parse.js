// Reads a Highway "search-results" page and finds the Assessment for one MC.
// Works on a live document (content script) or a jsdom document (tests).
(function (root) {
  // "MC 4213", "MC: 004213" (narrow card layout), "MC# 4213", "MC #: 4213"
  const MC_TEXT_RE = /\bMC\s*#?\s*:?\s*0*(\d{1,8})(?!\d)/gi;
  const KNOWN_LABEL_RE =
    /^(pass|passed|partial pass|partially passed|partial|fail|failed|review|needs review|warning|incomplete|pending|not assessed|unassessed|n\/a)$/i;

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  // Like textContent, but with a space between text nodes, so stacked lines
  // ("IG TRANSPORTATION INC" / "MC 689501" / "Pass") don't glue together.
  function textOf(el) {
    if (!el) return '';
    const doc = el.ownerDocument || el;
    const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) continue;
      parts.push(n.nodeValue);
    }
    return parts.join(' ');
  }

  function mcsIn(text) {
    const set = new Set();
    MC_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = MC_TEXT_RE.exec(text || ''))) set.add(m[1].replace(/^0+/, ''));
    return set;
  }

  function statusFromLabel(label) {
    if (/partial/i.test(label)) return 'partial';
    if (/^pass/i.test(label)) return 'pass';
    if (/^fail/i.test(label)) return 'fail';
    return 'other';
  }

  // Elements that directly carry the "MC <mc>" text (deepest such element).
  function findMcElements(doc, mc) {
    const body = doc.body;
    if (!body) return [];
    const walker = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue || '';
      if (v.indexOf(mc) === -1) continue;
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|TITLE)$/.test(parent.tagName)) continue;
      if (mcsIn(v).has(mc)) {
        // "MC 689501" in a single text node.
        if (!hits.includes(parent)) hits.push(parent);
        continue;
      }
      // "MC" and the number in separate nodes: the number must stand alone,
      // and a small nearby element must read "MC <number>".
      if (v.replace(/\D/g, '').replace(/^0+/, '') !== mc) continue;
      let el = parent;
      for (let i = 0; el && i < 3; i++, el = el.parentElement) {
        const t = textOf(el);
        if (t.length > 60) break;
        if (mcsIn(t).has(mc)) {
          if (!hits.includes(el)) hits.push(el);
          break;
        }
      }
    }
    return hits;
  }

  // Climb from the MC element to the element representing the whole result row.
  function findRow(el) {
    let row = el;
    let cur = el;
    while (cur.parentElement && cur.parentElement.tagName !== 'BODY') {
      if (cur.tagName === 'TR' || cur.getAttribute('role') === 'row') return cur;
      const parent = cur.parentElement;
      const text = textOf(parent);
      if (mcsIn(text).size > 1) break; // parent spans several result rows
      if (/\bAssessment\b/.test(text) || /Company Name/.test(text)) break; // header reached
      row = parent;
      cur = parent;
    }
    return row;
  }

  // Possible positions of the "Assessment" column header: [{ index, count }].
  function findAssessmentHeaders(doc) {
    const out = [];
    const candidates = doc.querySelectorAll('th, [role="columnheader"], div, span, p');
    for (const el of candidates) {
      if (el.children.length > 2) continue;
      if (norm(el.textContent) !== 'Assessment') continue;
      // Climb to the element that is a direct child of the header row.
      let cell = el;
      while (cell.parentElement && cell.parentElement.children.length < 3) {
        cell = cell.parentElement;
      }
      if (!cell.parentElement) continue;
      const cells = Array.from(cell.parentElement.children);
      out.push({ index: cells.indexOf(cell), count: cells.length });
    }
    return out;
  }

  function cellsOf(row) {
    if (row.tagName === 'TR') return Array.from(row.cells);
    // Descend through single-child wrappers to reach the cells.
    let cur = row;
    while (cur.children.length === 1) cur = cur.children[0];
    return Array.from(cur.children);
  }

  // Table layouts: the cell under the "Assessment" column header.
  function readAssessmentByHeader(doc, row) {
    const cells = cellsOf(row);
    for (const header of findAssessmentHeaders(doc)) {
      if (header.index < 0 || cells.length !== header.count) continue;
      const label = norm(textOf(cells[header.index]));
      if (label) return label;
    }
    return null;
  }

  function badgeIn(el) {
    for (const leaf of el.querySelectorAll('*')) {
      if (leaf.children.length) continue;
      const t = norm(leaf.textContent);
      if (KNOWN_LABEL_RE.test(t)) return t;
    }
    return null;
  }

  // Any layout (cards, grids): the closest ancestor of the MC element that
  // contains a status badge — i.e. that carrier's card/row, never something
  // farther away on the page.
  function nearestBadge(mcEl, limit) {
    for (let el = mcEl; el; el = el.parentElement) {
      if (el.tagName === 'BODY') break;
      if (mcsIn(textOf(el)).size > 1) break; // reached several carriers
      const label = badgeIn(el);
      if (label) return { label, container: el };
      if (el === limit) break;
    }
    return null;
  }

  function readName(row) {
    for (const el of row.querySelectorAll('*')) {
      if (el.children.length) continue;
      const t = norm(el.textContent);
      if (t.length > 2 && /[A-Za-z]{2}/.test(t) && !/^(DOT|MC)\b/i.test(t)) return t;
    }
    return '';
  }

  // Returns:
  //   headingQuery: the query shown in the 'Results for "..."' heading (or null)
  //   match: { status: 'pass'|'fail'|'other', label, name } or null
  //   rowCount: number of distinct MCs visible on the page
  function readHighway(doc, mcRaw) {
    const mc = String(mcRaw).replace(/^0+/, '');
    const bodyText = textOf(doc.body);
    const h = /Results for\s*["“']([^"”']{1,100})["”']/.exec(bodyText);
    const headingQuery = h ? norm(h[1]) : null;

    let match = null;
    const mcEls = findMcElements(doc, mc);
    for (const el of mcEls) {
      const row = findRow(el);
      let label = readAssessmentByHeader(doc, row);
      let container = row;
      if (!label) {
        const near = nearestBadge(el, null);
        if (near) ({ label, container } = near);
      }
      if (label) {
        match = { status: statusFromLabel(label), label, name: readName(container) };
        break;
      }
    }
    const mcs = Array.from(mcsIn(bodyText)).sort();
    return {
      headingQuery,
      match,
      mcFound: mcEls.length > 0,
      rowCount: mcs.length,
      rowsKey: mcs.join(','),
    };
  }

  // Given a page snapshot from readHighway, decide what the lookup should do.
  //   t.elapsed: ms since navigation started
  //   t.sinceHeading: ms since the heading first showed our query (null = not yet)
  //   t.prevRowsKey: rowsKey of the page before we navigated (rows still equal
  //                  to it may be stale results from the previous search)
  //   mode: 'fast' (in-app navigation) or 'full' (page load)
  // Returns { done: result } | { fallback: true } | { error: 'timeout' } | { wait: true }
  const TIMING = {
    notFoundWithRows: 1500, // results shown, none is our MC
    notFoundEmpty: 4000, // heading shown, no rows at all
    fastGiveUp: 6000, // in-app navigation never showed our query
    timeout: 15000,
  };

  function decide(snap, mc, t, mode) {
    if (snap.match) return { done: snap.match };
    if (t.sinceHeading != null && !snap.mcFound) {
      const freshRows = snap.rowCount > 0 && snap.rowsKey !== (t.prevRowsKey || '');
      const need = freshRows ? TIMING.notFoundWithRows : TIMING.notFoundEmpty;
      if (t.sinceHeading >= need) return { done: { status: 'not_found', label: 'Not on Highway' } };
    }
    if (mode === 'fast' && t.sinceHeading == null && t.elapsed >= TIMING.fastGiveUp) {
      return { fallback: true };
    }
    if (t.elapsed >= TIMING.timeout) {
      if (snap.mcFound) return { done: { status: 'other', label: 'Unknown' } };
      return { error: 'timeout' };
    }
    return { wait: true };
  }

  function headingMatches(snap, query) {
    return !!snap.headingQuery && snap.headingQuery.toLowerCase() === String(query).toLowerCase();
  }

  // Diagnostics: a trimmed HTML sample of the page around the MC (or the
  // page text if the MC isn't there), so the layout can be inspected.
  function debugSample(doc, mcRaw) {
    const mc = String(mcRaw).replace(/^0+/, '');
    const body = doc.body;
    if (!body) return { note: 'no body' };
    const bodyText = norm(textOf(body));
    const at = bodyText.indexOf('Results for');
    const out = {
      title: doc.title,
      heading: at >= 0 ? bodyText.slice(at, at + 80) : null,
      bodyTextStart: bodyText.slice(0, 600),
    };
    const walker = doc.createTreeWalker(body, 4);
    let node;
    let hit = null;
    while ((node = walker.nextNode())) {
      const p = node.parentElement;
      if (!p || /^(SCRIPT|STYLE|TITLE|H1|H2|H3)$/.test(p.tagName)) continue;
      if ((node.nodeValue || '').indexOf(mc) !== -1) {
        hit = p;
        break;
      }
    }
    if (!hit) {
      out.mcTextOnPage = false;
      return out;
    }
    out.mcTextOnPage = true;
    out.mcElementText = norm(textOf(hit)).slice(0, 100);
    // Climb until the sample includes the "Assessment" header or gets big.
    let el = hit;
    for (let i = 0; i < 14 && el.parentElement && el.parentElement !== body; i++) {
      el = el.parentElement;
      if (/Assessment/.test(textOf(el)) || el.outerHTML.length > 20000) break;
    }
    out.html = el.outerHTML
      .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg/>')
      .replace(/\s(style|d|data-v-[\w-]+)="[^"]*"/gi, '')
      .replace(/\s{2,}/g, ' ')
      .slice(0, 9000);
    return out;
  }

  const api = { readHighway, mcsIn, decide, headingMatches, TIMING, debugSample };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HighwayParse = api;
})(typeof self !== 'undefined' ? self : this);
