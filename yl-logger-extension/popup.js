// popup.js — Agent Presence Dashboard
'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

function istDateKey(ts) {
  return new Date(ts || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Format milliseconds → "Xh Ym" or "Ym Zs" */
function fmtMs(ms) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Format minutes → "Xh Ym" */
function fmtMin(mins) {
  if (!mins || mins <= 0) return '0m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Format timestamp → "HH:MM am/pm IST" */
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata'
  });
}

/**
 * Compute total online duration in ms from statusLog, including the open entry.
 * All statuses contribute to the "time online" total.
 */
function liveTotal(statusLog, now) {
  let ms = 0;
  for (const e of statusLog) {
    const end = e.end !== null ? e.end : now;
    ms += Math.max(0, end - e.start);
  }
  return ms;
}

/**
 * Returns { Available: ms, Busy: ms, Away: ms, Offline: ms }
 */
function statusBreakdown(statusLog, now) {
  const bd = { Available: 0, Busy: 0, Away: 0, Offline: 0 };
  for (const e of statusLog) {
    const end = e.end !== null ? e.end : now;
    const dur = Math.max(0, end - e.start);
    if (e.status in bd) bd[e.status] += dur;
  }
  return bd;
}

function dotClass(status) {
  return 'dot-' + (status || 'offline').toLowerCase();
}
function badgeClass(status) {
  return 'badge-' + (status || 'offline').toLowerCase();
}
function segClass(status) {
  return 'seg-' + (status || 'offline').toLowerCase();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Full DOM rebuild. Called on load and on storage changes.
 */
function fullRender(active, sessions) {
  const now   = Date.now();
  const today = istDateKey(now);

  const dateLabel = document.getElementById('date-label');
  if (dateLabel) {
    dateLabel.textContent = new Date().toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
    });
  }

  const todaySessions = (sessions[today] || {});
  const activeEntries  = Object.entries(active);
  const pastEntries    = Object.entries(todaySessions).filter(([e]) => !active[e]);

  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = '';

  // ── Active agents ──
  if (activeEntries.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'No agents currently online.';
    root.appendChild(div);
  } else {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = 'Online Now';
    root.appendChild(label);

    for (const [email, state] of activeEntries) {
      const session  = todaySessions[email];
      const log      = session ? session.statusLog : [];
      const totalMs  = liveTotal(log, now);
      const bd       = statusBreakdown(log, now);
      const bdTotal  = totalMs || 1;
      const name     = email.split('@')[0];
      const id       = email.replace(/[^a-z0-9]/gi, '_');
      const loginStr = fmtTime(state.loginTime || (session && session.loginTime));
      const sinceStr = fmtTime(state.currentStatusSince);

      const card = document.createElement('div');
      card.className = 'agent-card';
      card.innerHTML = `
        <div class="agent-top">
          <span class="dot ${dotClass(state.currentStatus)}"></span>
          <span class="agent-name" title="${email}">${name}</span>
          <span class="status-badge ${badgeClass(state.currentStatus)}">${state.currentStatus || 'Unknown'}</span>
          <span class="agent-dur" id="dur-${id}">${fmtMs(totalMs)}</span>
        </div>
        <div class="agent-meta">
          Login: ${loginStr}&nbsp;&nbsp;·&nbsp;&nbsp;${state.currentStatus || ''} since ${sinceStr}
        </div>
        <div class="bk-bar" id="bar-${id}">
          ${renderBarSegs(bd, bdTotal)}
        </div>
        <div class="bk-text" id="bktxt-${id}">
          ${renderBkText(bd)}
        </div>
      `;
      root.appendChild(card);
    }
  }

  // ── Past sessions ──
  if (pastEntries.length > 0) {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = 'Logged Out Today';
    root.appendChild(label);

    for (const [email, session] of pastEntries) {
      const name = email.split('@')[0];
      const dur  = fmtMin(session.totalDuration);
      const out  = fmtTime(session.logoutTime);

      const row = document.createElement('div');
      row.className = 'past-row';
      row.innerHTML = `
        <span class="dot dot-offline"></span>
        <span class="past-name" title="${email}">${name}</span>
        <span class="past-meta">Left ${out}</span>
        <span class="past-dur">${dur}</span>
      `;
      root.appendChild(row);
    }
  }
}

/** Renders bar segment HTML string for the breakdown bar. */
function renderBarSegs(bd, total) {
  return ['Available', 'Busy', 'Away', 'Offline']
    .filter(s => bd[s] > 0)
    .map(s => {
      const pct = ((bd[s] / total) * 100).toFixed(1);
      return `<div class="seg ${segClass(s)}" style="width:${pct}%" title="${s}: ${fmtMs(bd[s])}"></div>`;
    })
    .join('');
}

/** Renders breakdown text items HTML string. */
function renderBkText(bd) {
  return ['Available', 'Busy', 'Away', 'Offline']
    .filter(s => bd[s] > 0)
    .map(s => `<span class="bk-item"><span class="dot ${dotClass(s)}"></span>${s}: ${fmtMs(bd[s])}</span>`)
    .join('');
}

/**
 * Live tick: only update duration + breakdown elements to avoid DOM flicker.
 */
function liveTick(active, sessions) {
  const now   = Date.now();
  const today = istDateKey(now);
  const todaySessions = (sessions[today] || {});

  for (const [email, state] of Object.entries(active)) {
    const session = todaySessions[email];
    if (!session) continue;

    const id      = email.replace(/[^a-z0-9]/gi, '_');
    const log     = session.statusLog;
    const totalMs = liveTotal(log, now);
    const bd      = statusBreakdown(log, now);

    const durEl = document.getElementById(`dur-${id}`);
    if (durEl) durEl.textContent = fmtMs(totalMs);

    const barEl = document.getElementById(`bar-${id}`);
    if (barEl) barEl.innerHTML = renderBarSegs(bd, totalMs || 1);

    const txtEl = document.getElementById(`bktxt-${id}`);
    if (txtEl) txtEl.innerHTML = renderBkText(bd);
  }
}

// ── State & Lifecycle ─────────────────────────────────────────────────────────

let _active   = {};
let _sessions = {};

function fetchAndRender() {
  chrome.storage.local.get({ yl_active_agents: {}, yl_sessions: {} }, data => {
    if (chrome.runtime.lastError) return;
    _active   = data.yl_active_agents || {};
    _sessions = data.yl_sessions     || {};
    fullRender(_active, _sessions);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-btn').addEventListener('click', fetchAndRender);
  fetchAndRender();

  // Live duration tick every second
  setInterval(() => liveTick(_active, _sessions), 1000);

  // Re-sync storage every 30 seconds (catches alarm-driven changes)
  setInterval(fetchAndRender, 30000);
});

// Instant update when storage changes while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.yl_active_agents) _active   = changes.yl_active_agents.newValue   || {};
  if (changes.yl_sessions)      _sessions = changes.yl_sessions.newValue        || {};
  if (changes.yl_active_agents || changes.yl_sessions) {
    fullRender(_active, _sessions);
  }
});
