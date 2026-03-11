// Runs in ISOLATED world on cloud.yellow.ai
// Receives entries from inject.js via postMessage, saves to chrome.storage + Firebase

// ── SET YOUR FIREBASE URL HERE ──
const FIREBASE_URL = 'https://yl-logs-default-rtdb.firebaseio.com';

function sanitizeKey(email) {
  // Firebase keys can't contain . # $ [ ] /
  return (email || 'unknown').replace(/[@.]/g, '_');
}

const recentPushes = {}; // ticketId|status → timestamp, prevents duplicate Firebase writes

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

  // Block fake/invalid ticket IDs: auto-generated Ticket-XXXXX or non 3-5 digit numbers
  if (!entry.ticketId || /^Ticket-\d+$/i.test(entry.ticketId) || !/^\d{1,5}$/.test(entry.ticketId)) return;

  // Synchronous dedup — block duplicate Firebase pushes within 10 minutes
  const key = entry.ticketId + '|' + entry.status;
  const now = Date.now();
  if (recentPushes[key] && now - recentPushes[key] < 600000) return;
  recentPushes[key] = now;

  // Push to shared Firebase (always, regardless of local storage state)
  pushToFirebase(entry);

  // Save locally (chrome.storage may be unavailable if extension context was invalidated)
  try {
    chrome.storage.local.get({ yl_entries: [] }, function (data) {
      if (chrome.runtime.lastError) return;
      const entries = data.yl_entries;
      const recent = entries.filter(e => e.ticketId === entry.ticketId && e.status === entry.status &&
          entry.id - e.id < 600000);
      if (recent.length > 0) return;
      entries.push(entry);
      chrome.storage.local.set({ yl_entries: entries }, function () {
        console.log('[YL-Logger] Saved to storage:', entry.status, entry.ticketId);
      });
    });
  } catch (_) {
    console.warn('[YL-Logger] Storage unavailable — refresh the page to restore full functionality');
  }
});
