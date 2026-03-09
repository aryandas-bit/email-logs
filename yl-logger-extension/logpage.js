// Runs in ISOLATED world on email-logs.vercel.app
// Reads entries from chrome.storage.local and injects into the page

function syncToPage() {
  chrome.storage.local.get({ yl_entries: [] }, function (data) {
    const entries = data.yl_entries;
    // Inject into page's MAIN world via script tag
    const s = document.createElement('script');
    s.textContent = `
      (function() {
        var incoming = ${JSON.stringify(entries)};
        if (JSON.stringify(window.entries) !== JSON.stringify(incoming)) {
          window.entries = incoming;
          if (typeof window.render === 'function') window.render();
        }
      })();
    `;
    document.documentElement.appendChild(s);
    s.remove();
  });
}

// Also patch removeEntry / updateStatus so changes sync back to storage
function patchPageFunctions() {
  const s = document.createElement('script');
  s.textContent = `
    (function() {
      var _remove = window.removeEntry;
      var _update = window.updateStatus;
      function saveBack() {
        window.dispatchEvent(new CustomEvent('yl-save-entries', { detail: window.entries }));
      }
      if (_remove) window.removeEntry = function(id) { _remove(id); saveBack(); };
      if (_update) window.updateStatus = function(id, s) { _update(id, s); saveBack(); };
    })();
  `;
  document.documentElement.appendChild(s);
  s.remove();
}

window.addEventListener('yl-save-entries', function (e) {
  chrome.storage.local.set({ yl_entries: e.detail });
});

window.addEventListener('load', function () {
  syncToPage();
  patchPageFunctions();
  setInterval(syncToPage, 3000);
});
