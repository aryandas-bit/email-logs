// Runs on email-logs.vercel.app
// Syncs yl_entries from chrome.storage.local → window.entries so the page can render them

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

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.yl_entries) {
    const incoming = changes.yl_entries.newValue || [];
    localStorage.setItem('yl_entries', JSON.stringify(incoming));
    window.entries = incoming;
    if (typeof window.render === 'function') window.render();
  }
});

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  syncToPage();
} else {
  window.addEventListener('load', syncToPage);
}
