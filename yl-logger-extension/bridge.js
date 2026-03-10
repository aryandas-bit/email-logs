// Runs in ISOLATED world on cloud.yellow.ai
// Receives entries from inject.js via postMessage, saves to chrome.storage + Firebase

// ── SET YOUR FIREBASE URL HERE ──
const FIREBASE_URL = 'https://yl-logs-default-rtdb.firebaseio.com';

function sanitizeKey(email) {
  // Firebase keys can't contain . # $ [ ] /
  return (email || 'unknown').replace(/[@.]/g, '_');
}

function pushToFirebase(entry) {
  const agentKey = sanitizeKey(entry.agentEmail);
  fetch(`${FIREBASE_URL}/entries/${agentKey}/${entry.id}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry)
  }).then(() => {
    console.log('[YL-Logger] Pushed to Firebase:', entry.status, entry.ticketId);
  }).catch(e => {
    console.error('[YL-Logger] Firebase push failed:', e);
  });
}

window.addEventListener('message', function (e) {
  if (e.source !== window) return;
  if (!e.data || e.data.type !== 'yl-log-entry') return;

  const entry = e.data.entry;

  // Save locally
  chrome.storage.local.get({ yl_entries: [] }, function (data) {
    const entries = data.yl_entries;
    const last = entries[entries.length - 1];
    if (last && last.ticketId === entry.ticketId && last.status === entry.status &&
        entry.id - last.id < 5000) return;
    entries.push(entry);
    chrome.storage.local.set({ yl_entries: entries }, function () {
      console.log('[YL-Logger] Saved to storage:', entry.status, entry.ticketId);
    });
  });

  // Push to shared Firebase
  pushToFirebase(entry);
});
