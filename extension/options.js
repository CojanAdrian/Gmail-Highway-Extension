const DEFAULTS = { ignore: [], myEmails: [], cacheHours: 12, workers: 3 };
const $ = (id) => document.getElementById(id);

function flash(text) {
  $('msg').textContent = text;
  setTimeout(() => ($('msg').textContent = ''), 2500);
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $('ignore').value = (s.ignore || []).join('\n');
  $('myEmails').value = (s.myEmails || []).join('\n');
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
  const myEmails = $('myEmails')
    .value.split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  await chrome.storage.sync.set({ ignore, myEmails, cacheHours, workers });
  $('ignore').value = ignore.join('\n');
  $('myEmails').value = myEmails.join('\n');
  flash('Saved.');
});

$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-cache' });
  flash('Saved results cleared. Reload Gmail to re-check.');
});

$('fast').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reset-fast-nav' });
  flash('Fast navigation re-enabled.');
});
