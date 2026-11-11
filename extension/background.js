// Background service worker: lookup queue, result cache, Highway worker tabs.
importScripts('src/mc.js', 'src/queue.js', 'src/highway-parse.js');

const HW_ORIGIN = 'https://highway.com';
const HW_BROKER = HW_ORIGIN + '/broker';
const HW_SEARCH = HW_BROKER + '/carriers/search-results?q=';
const DEFAULTS = { ignore: [], cacheHours: 12, workers: 3 };
const POLL_MS = 350;

let settings = { ...DEFAULTS };
let cache = {}; // mc -> { result, ts }
let loginNeeded = false;
let fastNavDisabled = false;
let workerWindowId = null;
let slots = []; // index -> { tabId, loaded }
let queue = null;

const ready = init();

async function init() {
  const sync = await chrome.storage.sync.get(DEFAULTS);
  settings = { ...DEFAULTS, ...sync };
  const local = await chrome.storage.local.get({ cache: {}, fastNavDisabled: false });
  cache = local.cache || {};
  fastNavDisabled = !!local.fastNavDisabled;
  const sess = await chrome.storage.session.get({ workerWindowId: null, slots: [], loginNeeded: false });
  workerWindowId = sess.workerWindowId;
  slots = sess.slots || [];
  loginNeeded = !!sess.loginNeeded;
  queue = makeQueue();
  if (loginNeeded) queue.pause();
}

function makeQueue() {
  return new LookupQueue({ concurrency: clampWorkers(settings.workers), worker: lookupWithRetry });
}

function clampWorkers(n) {
  return Math.max(1, Math.min(6, Number(n) || DEFAULTS.workers));
}

function saveSession() {
  return chrome.storage.session.set({ workerWindowId, slots, loginNeeded });
}

// ---------- cache ----------

function ttlMs() {
  return Math.max(0.1, Number(settings.cacheHours) || DEFAULTS.cacheHours) * 3600 * 1000;
}

function cachedResult(mc) {
  const e = cache[mc];
  if (!e) return null;
  if (Date.now() - e.ts > ttlMs()) return null;
  // Results saved by v0.1 stored "Partial Pass" as status 'pass'.
  if (e.result && /partial/i.test(e.result.label || '')) e.result.status = 'partial';
  return e.result;
}

let saveTimer = null;
function saveCacheSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const now = Date.now();
    const ttl = ttlMs();
    for (const k of Object.keys(cache)) if (now - cache[k].ts > ttl) delete cache[k];
    chrome.storage.local.set({ cache });
  }, 1000);
}

// ---------- messaging ----------

async function broadcast(msg) {
  const tabs = await chrome.tabs.query({ url: ['https://mail.google.com/*', 'https://one.dat.com/*'] });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg.type) {
      case 'lookup': {
        const mc = McParse.normalizeMc(msg.mc);
        if (!mc) return sendResponse({ error: 'bad mc' });
        if (msg.force) delete cache[mc];
        const hit = cachedResult(mc);
        if (hit) return sendResponse({ result: hit });
        sendResponse({ pending: true, loginNeeded });
        enqueue(mc);
        return;
      }
      case 'state':
        return sendResponse({ loginNeeded, queued: queue.size });
      case 'open-highway':
        await chrome.tabs.create({
          url: msg.mc ? HW_SEARCH + encodeURIComponent(msg.mc) : HW_BROKER + '/',
          active: true,
        });
        return sendResponse({ ok: true });
      case 'clear-cache':
        cache = {};
        await chrome.storage.local.set({ cache });
        return sendResponse({ ok: true });
      case 'reset-fast-nav':
        fastNavDisabled = false;
        await chrome.storage.local.set({ fastNavDisabled });
        return sendResponse({ ok: true });
      default:
        return sendResponse({ error: 'unknown message' });
    }
  })();
  return true; // async response
});

function enqueue(mc) {
  if (queue.has(mc)) return;
  queue
    .add(mc)
    .then((result) => {
      result = { ...result, mc, checkedAt: Date.now() };
      cache[mc] = { result, ts: Date.now() };
      saveCacheSoon();
      broadcast({ type: 'result', mc, result });
    })
    .catch((err) => {
      console.warn('[MC Check] lookup failed', mc, err);
      broadcast({ type: 'result', mc, result: { status: 'error', label: 'Error', mc, error: String(err && err.message || err) } });
    });
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue ?? DEFAULTS[k];
  if (changes.workers && queue && queue.size === 0) {
    queue = makeQueue();
    if (loginNeeded) queue.pause();
  }
  if (changes.cacheHours) saveCacheSoon();
});

// ---------- login state ----------

function isHighwayLoginPage(url) {
  if (!url) return false;
  if (url.startsWith('chrome-error:') || url === 'about:blank') return false;
  if (!url.startsWith(HW_BROKER)) return true; // redirected away from the broker app
  return /\/(login|log-in|sign-?in|auth)(\/|\?|$)/i.test(new URL(url).pathname);
}

async function setLoginNeeded(needed) {
  if (loginNeeded === needed) return;
  loginNeeded = needed;
  if (needed) {
    queue.pause();
    slots.forEach((s) => s && (s.loaded = false));
  } else {
    queue.resume();
  }
  await saveSession();
  broadcast({ type: 'login', needed });
}

// When the user logs into Highway in any tab, resume.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!loginNeeded || info.status !== 'complete') return;
  if (slots.some((s) => s && s.tabId === tabId)) return; // ignore our own worker tabs
  if (tab.url && tab.url.startsWith(HW_BROKER) && !isHighwayLoginPage(tab.url)) {
    ready.then(() => setLoginNeeded(false));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  let changed = false;
  slots.forEach((s, i) => {
    if (s && s.tabId === tabId) {
      slots[i] = null;
      changed = true;
    }
  });
  if (changed) saveSession();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === workerWindowId) {
    workerWindowId = null;
    saveSession();
  }
});

// ---------- worker tabs ----------

let windowLock = Promise.resolve();

function withWindowLock(fn) {
  const run = windowLock.then(fn, fn);
  windowLock = run.catch(() => {});
  return run;
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkerTab(slot) {
  const s = slots[slot];
  if (s && (await tabExists(s.tabId))) return s.tabId;
  return withWindowLock(async () => {
    let win = null;
    if (workerWindowId != null) {
      try {
        win = await chrome.windows.get(workerWindowId);
      } catch {
        win = null;
      }
    }
    let tabId;
    if (!win) {
      try {
        win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
      } catch {
        win = await chrome.windows.create({ url: 'about:blank', focused: false });
      }
      workerWindowId = win.id;
      const [first] = await chrome.tabs.query({ windowId: win.id });
      tabId = first.id;
    } else {
      const t = await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false });
      tabId = t.id;
    }
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    slots[slot] = { tabId, loaded: false };
    await saveSession();
    return tabId;
  });
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('page load timeout'));
    }, timeoutMs);
    function listener(id, info, tab) {
      if (id !== tabId || info.status !== 'complete') return;
      if (!tab.url || tab.url === 'about:blank') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigateFull(tabId, url) {
  const done = waitForTabComplete(tabId);
  await chrome.tabs.update(tabId, { url });
  return done;
}

function sendToTab(tabId, msg, timeoutMs = 3000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    new Promise((_, rej) => setTimeout(() => rej(new Error('tab message timeout')), timeoutMs)),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loginError() {
  const e = new Error('Highway login needed');
  e.requeue = true;
  return e;
}

async function lookupWithRetry(mc, slot) {
  if (loginNeeded) throw loginError();
  try {
    return await lookupOnSlot(mc, slot, false);
  } catch (e) {
    if (e.requeue) throw e;
    console.warn('[MC Check] retrying', mc, e.message);
    if (slots[slot]) slots[slot].loaded = false;
    return lookupOnSlot(mc, slot, true);
  }
}

async function lookupOnSlot(mc, slot, forceFull) {
  const tabId = await ensureWorkerTab(slot);
  const s = slots[slot];
  const url = HW_SEARCH + encodeURIComponent(mc);

  let mode = s.loaded && !fastNavDisabled && !forceFull ? 'fast' : 'full';
  let prevRowsKey = '';

  if (mode === 'fast') {
    try {
      const prev = await sendToTab(tabId, { type: 'hw-check', mc });
      prevRowsKey = prev.rowsKey || '';
      const r = await sendToTab(tabId, { type: 'hw-nav', url });
      if (!r || !r.ok) throw new Error('nav failed');
    } catch {
      mode = 'full';
    }
  }
  if (mode === 'full') {
    const tab = await navigateFull(tabId, url);
    if (isHighwayLoginPage(tab.url)) {
      await setLoginNeeded(true);
      throw loginError();
    }
  }

  let start = Date.now();
  let headingAt = null;
  for (;;) {
    await sleep(POLL_MS);
    const tab = await chrome.tabs.get(tabId);
    if (isHighwayLoginPage(tab.url)) {
      await setLoginNeeded(true);
      throw loginError();
    }
    let snap = null;
    try {
      snap = await sendToTab(tabId, { type: 'hw-check', mc });
    } catch {
      snap = null; // page still loading
    }
    const now = Date.now();
    let d;
    if (snap) {
      if (headingAt == null && HighwayParse.headingMatches(snap, mc)) headingAt = now;
      d = HighwayParse.decide(
        snap,
        mc,
        { elapsed: now - start, sinceHeading: headingAt == null ? null : now - headingAt, prevRowsKey },
        mode
      );
    } else {
      d = now - start >= HighwayParse.TIMING.timeout ? { error: 'timeout' } : { wait: true };
    }

    if (d.done) {
      s.loaded = true;
      saveSession();
      return d.done;
    }
    if (d.fallback) {
      // In-app navigation didn't work; stop using it and reload instead.
      console.warn('[MC Check] fast navigation did not work; switching to full page loads');
      fastNavDisabled = true;
      chrome.storage.local.set({ fastNavDisabled });
      mode = 'full';
      prevRowsKey = '';
      await navigateFull(tabId, url);
      start = Date.now();
      headingAt = null;
      continue;
    }
    if (d.error) throw new Error(d.error);
  }
}
