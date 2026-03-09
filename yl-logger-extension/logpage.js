// Runs on email-logs.vercel.app
// Reads entries from chrome.storage.local, writes to page's localStorage, re-renders

function syncToPage() {
  chrome.storage.local.get({ yl_entries: [] }, function (data) {
    const incoming = data.yl_entries;
    const current = localStorage.getItem('yl_entries') || '[]';
    if (JSON.stringify(incoming) !== current) {
      localStorage.setItem('yl_entries', JSON.stringify(incoming));
      // Tell the page to reload its entries
      window.entries = incoming;
      if (typeof window.render === 'function') window.render();
    }
  });
}

// Patch page's remove/update so changes sync back to chrome.storage
function patchSaveBack() {
  const orig = window.save;
  if (!orig || window._ylPatched) return;
  window._ylPatched = true;
  window.save = function () {
    orig();
    chrome.storage.local.set({ yl_entries: window.entries });
  };
}

window.addEventListener('load', function () {
  syncToPage();
  patchSaveBack();
  setInterval(syncToPage, 3000);
});
