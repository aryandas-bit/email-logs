// Runs in ISOLATED world on cloud.yellow.ai
// Receives entries from inject.js via postMessage and saves to chrome.storage.local

window.addEventListener('message', function (e) {
  if (e.source !== window) return;
  if (!e.data || e.data.type !== 'yl-log-entry') return;

  const entry = e.data.entry;
  chrome.storage.local.get({ yl_entries: [] }, function (data) {
    const entries = data.yl_entries;
    // Prevent duplicate within 5 seconds
    const last = entries[entries.length - 1];
    if (last && last.ticketId === entry.ticketId && last.status === entry.status &&
        entry.id - last.id < 5000) return;
    entries.push(entry);
    chrome.storage.local.set({ yl_entries: entries }, function () {
      console.log('[YL-Logger] Saved to storage:', entry.status, entry.ticketId);
    });
  });
});
