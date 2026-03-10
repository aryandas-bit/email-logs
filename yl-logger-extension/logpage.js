// Runs on email-logs.vercel.app
// Reads entries from chrome.storage.local, writes to page's localStorage, re-renders

function syncToPage() {
  chrome.storage.local.get({ yl_entries: [] }, function (data) {
    const incoming = data.yl_entries;
    const current = localStorage.getItem('yl_entries') || '[]';
    if (JSON.stringify(incoming) !== current) {
      localStorage.setItem('yl_entries', JSON.stringify(incoming));
      window.entries = incoming;
      if (typeof window.render === 'function') window.render();
    }
  });
}

// Instant sync when storage changes
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.yl_entries) {
    const incoming = changes.yl_entries.newValue || [];
    localStorage.setItem('yl_entries', JSON.stringify(incoming));
    window.entries = incoming;
    if (typeof window.render === 'function') window.render();
  }
});

// Initial load sync
window.addEventListener('load', function () {
  syncToPage();
});
