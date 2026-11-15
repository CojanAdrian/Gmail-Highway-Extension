// Background part of BulkPosting's automatic truck search on DAT (loaded by
// background.js with importScripts, so it shares its helpers: tabExists,
// navigateFull, waitForTabComplete, sleep, rememberDatCarriers).
//
// Learned once from a truck search you make on DAT (see dat-replay.js), then
// run for any lane in a minimized DAT window, one search at a time.
//
//   app -> here   dat-learn { lane }       open DAT, learn from your next search of that lane
//                 dat-find { id, lane }    search DAT for a lane
//                 dat-forget               drop what was learned
//   here -> app   dat-learned { ok, error }
//                 dat-find-status { id, stage: waiting|opening|searching|done|error, carriers, code }

const DAT_START = 'https://one.dat.com/search-trucks';
const DAT_GAP_MS = 12000; // between two searches
const DAT_IDLE_CLOSE_MS = 10 * 60 * 1000;
let datRecipe = null;
let datLearn = null; // { lane, appTab, at }
let datLastRun = null; // for diagnostics
let datLastRunAt = 0;
let datWindowId = null;
let datTabId = null;
let datCloseTimer = null;
let datChain = Promise.resolve();
const datFrames = new Map(); // tabId -> Map(frameId -> { origin, top, hosts: Set })

function datFrame(sender) {
  if (!sender.tab) return null;
  let frames = datFrames.get(sender.tab.id);
  if (!frames) datFrames.set(sender.tab.id, (frames = new Map()));
  let f = frames.get(sender.frameId);
  if (!f) frames.set(sender.frameId, (f = { origin: null, top: false, hosts: new Set() }));
  return f;
}

function tellApp(tabId, msg) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function setLearning(on) {
  const tabs = await chrome.tabs.query({ url: 'https://*.dat.com/*' });
  for (const t of tabs) if (t.id !== datTabId) chrome.tabs.sendMessage(t.id, { type: 'dat-learn', on }).catch(() => {});
}

async function onDatMessage(msg, sender) {
  switch (msg.type) {
    case 'dat-frame': {
      const f = datFrame(sender);
      if (f) Object.assign(f, { origin: msg.origin, top: !!msg.top });
      if (datLearn && sender.tab && sender.tab.id !== datTabId) chrome.tabs.sendMessage(sender.tab.id, { type: 'dat-learn', on: true }).catch(() => {});
      return { ok: true };
    }
    case 'dat-login-seen': {
      const f = datFrame(sender);
      if (f) f.hosts.add(msg.host);
      return { ok: true };
    }
    case 'dat-learn': {
      datLearn = { lane: msg.lane, appTab: sender.tab ? sender.tab.id : null, at: Date.now() };
      await setLearning(true);
      await chrome.tabs.create({ url: DAT_START, active: true });
      return { ok: true };
    }
    case 'dat-learn-steps': {
      if (!datLearn || !sender.tab || sender.tab.id === datTabId) return { ok: false };
      const r = McxDatReplay.buildRecipe(msg.steps, datLearn.lane);
      if (!r.ok) {
        tellApp(datLearn.appTab, { type: 'dat-learned', ok: false, error: r.error });
        return { ok: false };
      }
      let startUrl = DAT_START;
      try {
        const u = new URL(sender.tab.url);
        if (/(^|\.)dat\.com$/.test(u.hostname)) startUrl = u.origin + u.pathname;
      } catch (e) {}
      datRecipe = { ...r.recipe, startUrl, frameOrigin: msg.origin };
      await chrome.storage.local.set({ datRecipe });
      const appTab = datLearn.appTab;
      datLearn = null;
      await setLearning(false);
      tellApp(appTab, { type: 'dat-learned', ok: true });
      return { ok: true };
    }
    case 'dat-forget':
      datRecipe = null;
      datLearn = null;
      await chrome.storage.local.remove('datRecipe');
      await setLearning(false);
      return { ok: true };
    case 'dat-find': {
      const appTab = sender.tab ? sender.tab.id : null;
      const run = datChain.then(() => runDatFind(msg.id, msg.lane, appTab));
      datChain = run.catch(() => {});
      return { ok: true };
    }
  }
  return { error: 'unknown message' };
}

function templateHost(t) {
  const first = typeof t === 'string' ? t : t && t.parts && typeof t.parts[0] === 'string' ? t.parts[0] : '';
  try {
    return new URL(first).host;
  } catch (e) {
    return '';
  }
}

function isDatLoginPage(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)dat\.com$/.test(u.hostname)) return true;
    return /^(login|auth|sso|id)\./.test(u.hostname) || /\/(login|log-in|sign-?in|authorize|auth)(\/|\?|$)/i.test(u.pathname);
  } catch (e) {
    return true;
  }
}

async function ensureDatTab(url) {
  if (datTabId != null && (await tabExists(datTabId))) {
    datFrames.delete(datTabId);
    await navigateFull(datTabId, url);
    return datTabId;
  }
  // Desktop-sized so DAT starts normally, then minimized out of the way.
  const win = await chrome.windows.create({ url, focused: false, width: 1400, height: 900, left: 0, top: 0 });
  chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
  datWindowId = win.id;
  const [first] = await chrome.tabs.query({ windowId: win.id });
  datTabId = first.id;
  chrome.tabs.update(datTabId, { autoDiscardable: false }).catch(() => {});
  await waitForTabComplete(datTabId, 30000).catch(() => {});
  return datTabId;
}

function closeDatSoon() {
  clearTimeout(datCloseTimer);
  datCloseTimer = setTimeout(() => {
    if (datWindowId != null) chrome.windows.remove(datWindowId).catch(() => {});
    datWindowId = null;
    datTabId = null;
  }, DAT_IDLE_CLOSE_MS);
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === datWindowId) {
    datWindowId = null;
    datTabId = null;
  }
});
chrome.tabs.onRemoved.addListener((id) => datFrames.delete(id));

async function runDatFind(id, lane, appTab) {
  const status = (stage, extra = {}) => tellApp(appTab, { type: 'dat-find-status', id, stage, ...extra });
  const fail = (code, extra = {}) => {
    datLastRun = { at: new Date().toISOString(), ok: false, code, ...extra };
    status('error', { code, ...extra });
  };
  if (!datRecipe) return fail('not-learned');
  const wait = datLastRunAt + DAT_GAP_MS - Date.now();
  if (wait > 0) {
    status('waiting', { ms: wait });
    await sleep(wait);
  }
  datLastRunAt = Date.now();
  status('opening');
  let tabId;
  try {
    tabId = await ensureDatTab(datRecipe.startUrl || DAT_START);
  } catch (e) {
    return fail('dat-open', { error: String((e && e.message) || e) });
  }
  closeDatSoon();
  // Wait for DAT's page to start and use its login, so the search goes out the same way.
  const hosts = new Set(datRecipe.steps.map((s) => templateHost(s.url)).filter(Boolean));
  let frameId = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return fail('dat-open');
    if (t.url && t.status === 'complete' && isDatLoginPage(t.url)) return fail('dat-login');
    const frames = datFrames.get(tabId);
    if (frames) {
      const matching = [...frames.entries()].filter(([, f]) => f.origin === datRecipe.frameOrigin).sort((a, b) => (b[1].top ? 1 : 0) - (a[1].top ? 1 : 0));
      if (matching.length) {
        frameId = matching[0][0];
        if ([...hosts].every((h) => matching[0][1].hosts.has(h)) || Date.now() - t0 > 12000) break;
      }
    }
    await sleep(300);
  }
  if (frameId == null) return fail('dat-not-ready');
  status('searching');
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'dat-replay', id, recipe: datRecipe, lane, origin: datRecipe.frameOrigin }, { frameId });
  } catch (e) {
    return fail('dat-not-ready', { error: String((e && e.message) || e) });
  }
  if (!res || !res.ok) {
    const code = res && res.code === 'login' ? 'dat-login' : (res && res.code) || 'error';
    return fail(code, { status: res && res.status, error: res && res.error, step: res && res.step });
  }
  const carriers = rememberDatCarriers(res.carriers || []) || [];
  datLastRun = { at: new Date().toISOString(), ok: true, carriers: carriers.length };
  status('done', { carriers });
}
