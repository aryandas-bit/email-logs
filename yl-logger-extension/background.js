// background.js — Service Worker for yl-logger-extension
// Manages agent presence state in chrome.storage.local and syncs to Firebase.
'use strict';

const FIREBASE_URL     = 'https://yl-logs-default-rtdb.firebaseio.com';
const ALARM_NAME       = 'yl-presence-check';
const ALARM_PERIOD_MIN = 2;

const AWAY_THRESHOLD_MS    =  5 * 60 * 1000;  //  5 min no heartbeat → Away
const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;  // 15 min no heartbeat → Offline
const LOGOUT_THRESHOLD_MS  = 30 * 60 * 1000;  // 30 min no heartbeat → implicit logout

// ── Firebase helpers ──────────────────────────────────────────────────────────

function sanitizeKey(str) {
  return (str || 'unknown').replace(/[@.]/g, '_');
}

/**
 * Pushes a session record to Firebase under /presence/{agentKey}/{date}.json
 * Called on login, every status change, and on finalization.
 */
function pushSessionToFirebase(session) {
  if (!session || !session.agentEmail || !session.date) return;
  const agentKey = sanitizeKey(session.agentEmail);
  fetch(`${FIREBASE_URL}/presence/${agentKey}/${session.date}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session)
  }).catch(err => console.error('[YL-BG] Firebase push failed:', err));
}

// ── Storage helpers ──────────────────────────────────────────────────────────

function istDateKey(ts) {
  return new Date(ts || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function readStore() {
  return new Promise(resolve =>
    chrome.storage.local.get({ yl_active_agents: {}, yl_sessions: {} }, d =>
      resolve({ active: d.yl_active_agents, sessions: d.yl_sessions })
    )
  );
}

function writeStore(active, sessions) {
  return new Promise(resolve =>
    chrome.storage.local.set({ yl_active_agents: active, yl_sessions: sessions }, resolve)
  );
}

// ── Session record helpers ────────────────────────────────────────────────────

/** Close the currently-open statusLog entry (end === null) at closeTime. */
function closeCurrentEntry(session, closeTime) {
  const log = session.statusLog;
  if (!log || !log.length) return;
  const last = log[log.length - 1];
  if (last.end === null) {
    last.end      = closeTime;
    last.duration = Math.max(0, Math.round((closeTime - last.start) / 60000));
  }
}

/** Close the open entry, set logoutTime and totalDuration on the session record. */
function finaliseSession(session, logoutTime) {
  closeCurrentEntry(session, logoutTime);
  session.logoutTime    = logoutTime;
  session.totalDuration = session.statusLog.reduce((sum, e) => sum + (e.duration || 0), 0);
}

/** Ensure day + email bucket exists in sessions, return the record. */
function ensureRecord(sessions, date, email) {
  if (!sessions[date])         sessions[date] = {};
  if (!sessions[date][email])  sessions[date][email] = {
    date, agentEmail: email,
    loginTime: null, logoutTime: null, totalDuration: 0,
    statusLog: [], lastHeartbeat: null
  };
  return sessions[date][email];
}

// ── Core event handler ────────────────────────────────────────────────────────

async function handlePresenceEvent(evt) {
  const { type, email, status, ts } = evt;
  if (!email || !type) return;

  const now   = ts || Date.now();
  const today = istDateKey(now);

  const { active, sessions } = await readStore();
  const state   = active[email] || null;
  const session = ensureRecord(sessions, today, email);

  let shouldPush = false;

  if (type === 'login') {
    if (!session.loginTime) session.loginTime = now;
    session.lastHeartbeat = now;

    if (state) {
      // Redundant login — just freshen heartbeat / status
      if (status && state.currentStatus !== status) {
        closeCurrentEntry(session, now);
        session.statusLog.push({ status, start: now, end: null, duration: null });
        active[email].currentStatus      = status;
        active[email].currentStatusSince = now;
        shouldPush = true;
      }
      active[email].lastHeartbeat = now;
    } else {
      // Re-login on same day (after earlier logout): reopen session
      if (session.logoutTime) {
        session.logoutTime    = null;
        session.totalDuration = 0;
      }
      const s = status || 'Available';
      session.statusLog.push({ status: s, start: now, end: null, duration: null });
      active[email] = {
        currentStatus: s, currentStatusSince: now,
        lastHeartbeat: now, date: today, loginTime: session.loginTime
      };
      shouldPush = true;
    }

  } else if (type === 'status_change') {
    if (!session.loginTime) session.loginTime = now;
    session.lastHeartbeat = now;

    const s = status || 'Available';
    if (state) {
      if (state.currentStatus !== s) {
        closeCurrentEntry(session, now);
        session.statusLog.push({ status: s, start: now, end: null, duration: null });
        active[email].currentStatus      = s;
        active[email].currentStatusSince = now;
        shouldPush = true;
      }
      active[email].lastHeartbeat = now;
    } else {
      // No active record (background was restarted) — treat as implicit login
      session.statusLog.push({ status: s, start: now, end: null, duration: null });
      active[email] = {
        currentStatus: s, currentStatusSince: now,
        lastHeartbeat: now, date: today, loginTime: now
      };
      shouldPush = true;
    }

  } else if (type === 'heartbeat') {
    session.lastHeartbeat = now;
    if (!session.loginTime) session.loginTime = now;

    if (state) {
      active[email].lastHeartbeat = now;
      // If alarm had marked agent Away/Offline but they're clearly active again → restore
      if ((state.currentStatus === 'Away' || state.currentStatus === 'Offline') &&
          status && status !== 'Away' && status !== 'Offline') {
        const s = status;
        closeCurrentEntry(session, now);
        session.statusLog.push({ status: s, start: now, end: null, duration: null });
        active[email].currentStatus      = s;
        active[email].currentStatusSince = now;
        shouldPush = true;
      }
    } else {
      // Background was restarted mid-session — reconstruct from heartbeat
      const s = status || 'Available';
      session.statusLog.push({ status: s, start: now, end: null, duration: null });
      active[email] = {
        currentStatus: s, currentStatusSince: now,
        lastHeartbeat: now, date: today, loginTime: now
      };
      shouldPush = true;
    }

  } else if (type === 'logout') {
    if (state) {
      finaliseSession(session, now);
      delete active[email];
      shouldPush = true;
    }
  }

  await writeStore(active, sessions);
  if (shouldPush) pushSessionToFirebase(session);
}

// ── Alarm: staleness check ────────────────────────────────────────────────────

async function runPresenceAlarm() {
  const now   = Date.now();
  const today = istDateKey(now);

  const { active, sessions } = await readStore();
  let changed = false;

  for (const [email, state] of Object.entries(active)) {
    const gap       = now - (state.lastHeartbeat || 0);
    const agentDate = state.date;

    // ── Midnight rollover ──
    if (agentDate && agentDate < today) {
      const [y, mo, d] = agentDate.split('-').map(Number);
      const eod = new Date(Date.UTC(y, mo - 1, d, 18, 29, 59, 999)).getTime();
      const prevSession = sessions[agentDate] && sessions[agentDate][email];
      if (prevSession) {
        finaliseSession(prevSession, eod);
        pushSessionToFirebase(prevSession);
      }
      delete active[email];
      changed = true;
      continue;
    }

    // ── Staleness checks (same day) ──
    if (gap >= LOGOUT_THRESHOLD_MS) {
      const logoutTs = (state.lastHeartbeat || now) + LOGOUT_THRESHOLD_MS;
      const session  = sessions[today] && sessions[today][email];
      if (session) {
        finaliseSession(session, logoutTs);
        pushSessionToFirebase(session);
      }
      delete active[email];
      changed = true;

    } else if (gap >= OFFLINE_THRESHOLD_MS && state.currentStatus !== 'Offline') {
      const offlineAt = (state.lastHeartbeat || now) + OFFLINE_THRESHOLD_MS;
      const session   = sessions[today] && sessions[today][email];
      if (session) {
        closeCurrentEntry(session, offlineAt);
        session.statusLog.push({ status: 'Offline', start: offlineAt, end: null, duration: null });
        pushSessionToFirebase(session);
      }
      active[email].currentStatus      = 'Offline';
      active[email].currentStatusSince = offlineAt;
      changed = true;

    } else if (gap >= AWAY_THRESHOLD_MS &&
               state.currentStatus !== 'Away' &&
               state.currentStatus !== 'Offline') {
      const awayAt  = (state.lastHeartbeat || now) + AWAY_THRESHOLD_MS;
      const session = sessions[today] && sessions[today][email];
      if (session) {
        closeCurrentEntry(session, awayAt);
        session.statusLog.push({ status: 'Away', start: awayAt, end: null, duration: null });
        pushSessionToFirebase(session);
      }
      active[email].currentStatus      = 'Away';
      active[email].currentStatusSince = awayAt;
      changed = true;
    }
  }

  if (changed) await writeStore(active, sessions);
}

// ── Crash/restart recovery ────────────────────────────────────────────────────

async function recoverOrphanedSessions() {
  const today = istDateKey();
  const { active, sessions } = await readStore();
  let changed = false;

  for (const [email, state] of Object.entries(active)) {
    const d = state.date;
    if (d && d < today) {
      // Previous-day orphan — close at end of that day IST
      const [y, mo, day] = d.split('-').map(Number);
      const eod = new Date(Date.UTC(y, mo - 1, day, 18, 29, 59, 999)).getTime();
      if (!sessions[d]) sessions[d] = {};
      if (sessions[d][email]) {
        finaliseSession(sessions[d][email], eod);
        pushSessionToFirebase(sessions[d][email]);
      }
      delete active[email];
      changed = true;
    } else if (d === today) {
      // Same-day record: check if it's been too long since last heartbeat
      const gap = Date.now() - (state.lastHeartbeat || 0);
      if (gap >= LOGOUT_THRESHOLD_MS) {
        const logoutTs = (state.lastHeartbeat || Date.now()) + LOGOUT_THRESHOLD_MS;
        if (sessions[today] && sessions[today][email]) {
          finaliseSession(sessions[today][email], logoutTs);
          pushSessionToFirebase(sessions[today][email]);
        }
        delete active[email];
        changed = true;
      }
    }
  }

  if (changed) await writeStore(active, sessions);
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.type !== 'yl-presence-event') return false;

  handlePresenceEvent(msg.event || msg)
    .then(() => respond({ ok: true }))
    .catch(err => {
      console.error('[YL-BG] handlePresenceEvent error:', err);
      respond({ ok: false });
    });

  return true; // keep async channel open
});

// ── Alarm ─────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    runPresenceAlarm().catch(err => console.error('[YL-BG] alarm error:', err));
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function setupAlarm() {
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: ALARM_PERIOD_MIN,
      periodInMinutes: ALARM_PERIOD_MIN
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  recoverOrphanedSessions().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  recoverOrphanedSessions().catch(console.error);
});

console.log('[YL-BG] Background service worker started');
