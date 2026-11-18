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
      return { ok: true, quiet: !!(sender.tab && sender.tab.id === datTabId) };
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
  chrome.storage.session.set({ datWindowId }).catch(() => {});
  const [first] = await chrome.tabs.query({ windowId: win.id });
  datTabId = first.id;
  chrome.tabs.update(datTabId, { autoDiscardable: false }).catch(() => {});
  await waitForTabComplete(datTabId, 30000).catch(() => {});
  return datTabId;
}

// Closes the DAT window as soon as a search is over, so windows don't pile up.
async function closeDatWindow() {
  clearTimeout(datCloseTimer);
  const id = datWindowId;
  datWindowId = null;
  datTabId = null;
  chrome.storage.session.remove('datWindowId').catch(() => {});
  if (id != null) await chrome.windows.remove(id).catch(() => {});
}

// A DAT window left behind when the extension restarted mid-search is closed too.
chrome.storage.session.get({ datWindowId: null }).then(({ datWindowId: left }) => {
  if (left != null && left !== datWindowId) chrome.windows.remove(left).catch(() => {});
  chrome.storage.session.remove('datWindowId').catch(() => {});
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === datWindowId) {
    datWindowId = null;
    datTabId = null;
  }
});
chrome.tabs.onRemoved.addListener((id) => datFrames.delete(id));

const DAT_SEARCH_PAGE = 'https://one.dat.com/search-equipment';

// Shows or hides (minimizes) the DAT window without taking focus.
async function setDatWindowShown(shown) {
  if (datWindowId == null) return;
  await chrome.windows.update(datWindowId, shown ? { state: 'normal', focused: false } : { state: 'minimized' }).catch(() => {});
}

// Opens DAT's truck search page, fills in the lane and presses Search, like
// a person would; the carriers come from DAT's answer (dat-main.js).
async function searchOnDatPage(tabId, lane) {
  const t0 = Date.now();
  // Wait for DAT to load and its page script to say hello.
  while (Date.now() - t0 < 25000) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return { ok: false, code: 'dat-open' };
    if (t.url && t.status === 'complete' && isDatLoginPage(t.url)) return { ok: false, code: 'dat-login' };
    if (datFrames.get(tabId) && datFrames.get(tabId).size) break;
    await sleep(300);
  }
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'dat-search-form', lane }),
      sleep(100000).then(() => ({ ok: false, code: 'timeout' })),
    ]);
  } catch (e) {
    return { ok: false, code: 'dat-not-ready', error: String((e && e.message) || e) };
  }
}

async function runDatFind(id, lane, appTab) {
  const status = (stage, extra = {}) => tellApp(appTab, { type: 'dat-find-status', id, stage, ...extra });
  const wait = datLastRunAt + DAT_GAP_MS - Date.now();
  if (wait > 0) {
    status('waiting', { ms: wait });
    await sleep(wait);
  }
  datLastRunAt = Date.now();
  status('opening');
  let res = null;
  // First in a minimized window; if DAT's lists don't open there, once more with the window shown (behind yours).
  for (const shown of [false, true]) {
    let tabId;
    try {
      tabId = await ensureDatTab(DAT_SEARCH_PAGE);
      await setDatWindowShown(shown);
    } catch (e) {
      res = { ok: false, code: 'dat-open', error: String((e && e.message) || e) };
      break;
    }
    status('searching');
    res = (await searchOnDatPage(tabId, lane)) || { ok: false, code: 'error' };
    if (res.ok || !['no-place', 'no-equipment', 'form-not-found', 'no-search-button'].includes(res.code)) break;
  }
  await closeDatWindow();
  datLastRun = { at: new Date().toISOString(), lane, ok: !!(res && res.ok), code: res && res.code, steps: res && res.steps, fieldsSeen: res && res.seen, carriers: res && res.carriers ? res.carriers.length : 0 };
  if (!res || !res.ok) return status('error', { code: (res && res.code) || 'error' });
  const carriers = rememberDatCarriers(res.carriers || []) || [];
  status('done', { carriers });
}
