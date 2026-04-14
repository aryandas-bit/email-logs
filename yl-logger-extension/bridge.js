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

// ── Presence event bridge ──
// Receives yl-presence-event postMessages from inject.js and forwards to background.js.
window.addEventListener('message', function (e) {
  if (e.source !== window) return;
  if (!e.data || e.data.type !== 'yl-presence-event') return;

  const event = e.data.event;
  if (!event || !event.email || !event.type) return;

  try {
    chrome.runtime.sendMessage({ type: 'yl-presence-event', event }, function () {
      if (chrome.runtime.lastError) {
        // Service worker may be waking up — non-fatal, alarm will reconcile state
        console.warn('[YL-Bridge] Presence:', chrome.runtime.lastError.message);
      }
    });
  } catch (_) {
    console.warn('[YL-Bridge] Presence: runtime unavailable');
  }
});

// ── Ticket log bridge (unchanged) ──
window.addEventListener('message', function (e) {
  if (e.source !== window) return;
  if (!e.data || e.data.type !== 'yl-log-entry') return;

  const entry = e.data.entry;

  // Block fake/invalid ticket IDs: auto-generated Ticket-XXXXX or non 3-5 digit numbers
  if (!entry.ticketId || /^Ticket-\d+$/i.test(entry.ticketId) || !/^\d{1,5}$/.test(entry.ticketId)) return;

  // Synchronous dedup — block duplicate Firebase pushes for the same ticket+status within 10 minutes
  const now = Date.now();
  // If already Resolved, never overwrite with On Hold within 10 minutes
  if (entry.status === 'On Hold' && recentPushes[entry.ticketId + '|Resolved'] && now - recentPushes[entry.ticketId + '|Resolved'] < 600000) return;
  const key = entry.ticketId + '|' + entry.status;
  if (recentPushes[key] && now - recentPushes[key] < 600000) return;
  recentPushes[key] = now; // set immediately to block any rapid duplicates

  // Save locally (chrome.storage may be unavailable if extension context was invalidated)
  try {
    chrome.storage.local.get({ yl_entries: [] }, function (data) {
      if (chrome.runtime.lastError) {
        pushToFirebase(entry); // storage unavailable (orphaned context) — push directly
        return;
      }
      const entries = data.yl_entries;
      const recent = entries.filter(e => e.ticketId === entry.ticketId && e.status === entry.status &&
          entry.id - e.id < 600000);
      if (recent.length > 0) return;

      pushToFirebase(entry);
      entries.push(entry);
      chrome.storage.local.set({ yl_entries: entries }, function () {
        console.log('[YL-Logger] Saved to storage:', entry.status, entry.ticketId);
      });
    });
  } catch (_) {
    console.warn('[YL-Logger] Storage unavailable — refresh the page to restore full functionality');
  }
});
