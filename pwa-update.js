(function () {
  console.log('[PWA] pwa-update.js loaded');
  if (!('serviceWorker' in navigator)) {
    console.warn('[PWA] Service workers NOT supported in this context — registration is impossible here.');
    return;
  }

  const updateBtn = document.getElementById('update-btn');
  const pageHadController = !!navigator.serviceWorker.controller;
  const watchedWorkers = new WeakSet();
  let newWorker;      // reference to the waiting worker
  let refreshing = false; // guard against multiple reloads
  let firstClaim = false; // first SW claiming an uncontrolled page is not an update

  function showUpdateButton() {
    if (updateBtn) updateBtn.style.display = 'inline-block';
  }

  function hideUpdateButton() {
    if (updateBtn) updateBtn.style.display = 'none';
  }

  function log(...args) {
    console.log('[PWA]', ...args);
  }

  function watchInstallingWorker(reg) {
    const worker = reg.installing;
    if (!worker || watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);
    worker.addEventListener('statechange', () => {
      log('worker state:', worker.state);
      if (
        worker.state === 'installed' &&
        navigator.serviceWorker.controller // not the very first install
      ) {
        newWorker = worker;
        log('update ready — showing update button');
        showUpdateButton();
      }
    });
  }

  function checkForUpdate(reg) {
    log('checking for a new version...');
    reg.update().catch(() => { /* ignore transient update-check errors */ });
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
      log('registered. controller:', !!navigator.serviceWorker.controller);

      // Case 1: a new SW is already waiting when the page loads
      if (reg.waiting) {
        newWorker = reg.waiting;
        log('new version already waiting — showing update button');
        showUpdateButton();
      }

      // A worker may already be installing before we attach the listener
      if (reg.installing) watchInstallingWorker(reg);

      // Case 2: a new SW is found while the page is open
      reg.addEventListener('updatefound', () => {
        log('updatefound — new service worker found');
        watchInstallingWorker(reg);
      });

      // Check for a new version once, when the app opens
      // (register() itself also performs an update check on every load)
      checkForUpdate(reg);

    }).catch((err) => console.error('[PWA] SW registration failed:', err));

    // When a new SW takes control, reload the page once — but only for a real
    // update, not when the very first SW claims an uncontrolled page
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      log('controllerchange (pageHadController:', pageHadController, 'firstClaim:', firstClaim, ')');
      if (refreshing) return;
      if (!pageHadController && !firstClaim) {
        firstClaim = true;
        return;
      }
      refreshing = true;
      // Give the app a chance to persist unsaved work before going away
      window.dispatchEvent(new Event('pwa:before-reload'));
      window.location.reload();
    });
  });

  // Button click: tell the waiting worker to activate now
  if (updateBtn) {
    updateBtn.addEventListener('click', () => {
      hideUpdateButton();
      if (newWorker) {
        newWorker.postMessage({ type: 'SKIP_WAITING' });
        return;
      }
      // Fallback: we may not hold a reference (waiting worker from a previous page load)
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }).catch(() => { /* ignore */ });
    });
  }
})();
