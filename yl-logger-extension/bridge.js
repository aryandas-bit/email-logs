// Runs in ISOLATED world on cloud.yellow.ai
// Receives entries from inject.js and saves to chrome.storage.local

window.addEventListener('yl-log-entry', function (e) {
  const entry = e.detail;
  chrome.storage.local.get({ yl_entries: [] }, function (data) {
    const entries = data.yl_entries;
    // Prevent duplicate within 5 seconds
    const last = entries[entries.length - 1];
    if (last && last.ticketId === entry.ticketId && last.status === entry.status &&
        entry.id - last.id < 5000) return;
    entries.push(entry);
    chrome.storage.local.set({ yl_entries: entries });
  });
});
