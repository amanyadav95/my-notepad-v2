(function () {
  if (!('serviceWorker' in navigator)) return;

  const updateBtn = document.getElementById('update-btn');
  let newWorker; // reference to the waiting worker
  let refreshing = false; // guard against multiple reloads

  function showUpdateButton() {
    if (updateBtn) updateBtn.style.display = 'inline-block';
  }

  function hideUpdateButton() {
    if (updateBtn) updateBtn.style.display = 'none';
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {

      // Case 1: a new SW is already waiting when the page loads
      if (reg.waiting) {
        newWorker = reg.waiting;
        showUpdateButton();
      }

      // Case 2: a new SW is found while the page is open
      reg.addEventListener('updatefound', () => {
        const installingWorker = reg.installing;
        installingWorker.addEventListener('statechange', () => {
          if (
            installingWorker.state === 'installed' &&
            navigator.serviceWorker.controller // not the very first install
          ) {
            newWorker = installingWorker;
            showUpdateButton();
          }
        });
      });

      // Optional: poll for updates periodically (e.g. every 60s)
      setInterval(() => reg.update(), 60 * 1000);

    }).catch((err) => console.error('SW registration failed:', err));

    // When the new SW takes control, reload the page once
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });

  // Button click: tell the waiting worker to activate now
  if (updateBtn) {
    updateBtn.addEventListener('click', () => {
      hideUpdateButton();
      if (newWorker) {
        newWorker.postMessage({ type: 'SKIP_WAITING' });
      }
    });
  }
})();