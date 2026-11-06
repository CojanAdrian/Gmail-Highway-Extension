// Runs in Gmail's own page context (world: MAIN) only to expose the "ik"
// account key that Gmail's print view URL needs. Nothing else.
(function () {
  function publish() {
    try {
      const ik = window.GLOBALS && window.GLOBALS[9];
      if (typeof ik === 'string' && /^[0-9a-f]{6,16}$/i.test(ik)) {
        document.documentElement.setAttribute('data-mcx-ik', ik);
        return true;
      }
    } catch (e) {}
    return false;
  }
  if (!publish()) {
    let tries = 0;
    const t = setInterval(() => {
      if (publish() || ++tries > 40) clearInterval(t);
    }, 500);
  }
})();
