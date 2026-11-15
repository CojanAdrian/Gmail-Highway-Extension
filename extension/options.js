const DEFAULTS = { ignore: [], cacheHours: 12, workers: 3 };
const $ = (id) => document.getElementById(id);

function flash(text) {
  $('msg').textContent = text;
  setTimeout(() => ($('msg').textContent = ''), 2500);
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $('ignore').value = (s.ignore || []).join('\n');
  $('cacheHours').value = s.cacheHours;
  $('workers').value = s.workers;
});

$('save').addEventListener('click', async () => {
  const ignore = $('ignore')
    .value.split(/[\s,;]+/)
    .map((x) => x.replace(/\D/g, '').replace(/^0+/, ''))
    .filter(Boolean);
  const cacheHours = Math.max(0.1, Number($('cacheHours').value) || DEFAULTS.cacheHours);
  const workers = Math.max(1, Math.min(6, Math.round(Number($('workers').value) || DEFAULTS.workers)));
  await chrome.storage.sync.set({ ignore, cacheHours, workers });
  $('ignore').value = ignore.join('\n');
  flash('Saved.');
});

$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-cache' });
  flash('Saved results cleared. Reload Gmail to re-check.');
});

$('diagRun').addEventListener('click', async () => {
  $('diagRun').disabled = true;
  $('diagCopy').disabled = true;
  $('diagMsg').textContent = 'Running… (up to ~45 seconds)';
  $('diagOut').style.display = 'none';
  try {
    const report = await chrome.runtime.sendMessage({ type: 'diag-run', mc: $('diagMc').value });
    $('diagOut').textContent = JSON.stringify(report, null, 1);
    $('diagMsg').textContent = 'Done.';
    $('diagCopy').disabled = false;
  } catch (e) {
    $('diagOut').textContent = 'Diagnostics failed: ' + e;
    $('diagMsg').textContent = '';
  }
  $('diagOut').style.display = 'block';
  $('diagRun').disabled = false;
});

$('diagCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('diagOut').textContent);
  $('diagMsg').textContent = 'Copied — paste it in the chat.';
});

$('fast').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reset-fast-nav' });
  flash('Fast navigation re-enabled.');
});

// ---------- BulkPosting address ----------

chrome.storage.sync.get({ appAddress: '' }).then((s) => {
  $('appAddress').value = s.appAddress || '';
});

$('appSave').addEventListener('click', async () => {
  const raw = $('appAddress').value.trim();
  const say = (text) => ($('appMsg').textContent = text);
  let origin = '';
  if (raw) {
    try {
      origin = new URL(raw).origin;
    } catch {
      return say('That is not a full address (start it with https://).');
    }
    // Must be asked for straight from the click.
    const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
    if (!granted) return say('Permission was not given, so the address was not saved.');
  }
  const r = await chrome.runtime.sendMessage({ type: 'app-address', address: origin });
  if (!r || r.error) return say('Could not save: ' + ((r && r.error) || 'no answer'));
  await chrome.storage.sync.set({ appAddress: origin });
  $('appAddress').value = origin;
  say(origin ? 'Saved. Reload BulkPosting to see Highway checks.' : 'Removed.');
});
