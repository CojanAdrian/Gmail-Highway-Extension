// Runs on highway.com. Only acts when the background asks (worker tabs).
(function () {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'hw-check') {
      const snap = HighwayParse.readHighway(document, msg.mc);
      snap.href = location.href;
      sendResponse(snap);
      return;
    }
    if (msg.type === 'hw-nav') {
      // In-app navigation without reloading Highway: push the new URL and let
      // the app's router (Vue Router) react to a popstate event.
      try {
        history.pushState(null, '', msg.url);
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }
    if (msg.type === 'hw-ping') {
      sendResponse({ ok: true, href: location.href });
    }
  });
})();
