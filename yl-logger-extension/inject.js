// Runs in MAIN world on cloud.yellow.ai
// Intercepts fetch/XHR, detects Resolved / On Hold, captures agent email

(function () {

  let agentEmail = null;
  const recentLogs = {}; // ticketId+status → timestamp, prevents duplicate fires

  // ── Presence tracking state ──
  let _agentStatus    = null;   // 'Available' | 'Busy' | 'Away' — current known status
  let _presenceStarted = false; // true once the first login event has been posted

  // ── Heartbeat ──
  const HB_URL = 'https://yl-logs-default-rtdb.firebaseio.com/heartbeats';
  let _hbInterval = null;
  let _attendanceDay = null;
  let _firstSeenAt = null;
  let _detectInterval = null;
  let _availableInterval = null;
  let _attendancePending = false;

  function currentIstDayKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  }

  function sendHeartbeat() {
    if (!agentEmail) return;
    const dayKey = currentIstDayKey();
    if (_attendanceDay !== dayKey) {
      _attendanceDay = dayKey;
      _firstSeenAt = Date.now();
    }
    const key = agentEmail.replace(/[@.]/g, '_');
    console.log('[YL-Logger] Sending heartbeat:', agentEmail);
    fetch(`${HB_URL}/${key}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: agentEmail,
        lastSeen: Date.now(),
        attendanceDate: _attendanceDay,
        firstSeenAt: _firstSeenAt
      })
    }).then(() => console.log('[YL-Logger] Heartbeat OK')).catch(e => console.error('[YL-Logger] Heartbeat failed:', e));

    // Also post a presence heartbeat so background.js updates lastHeartbeat
    postPresenceEvent('heartbeat', _agentStatus || 'Available');
  }

  function startHeartbeat() {
    if (_hbInterval) return;
    _attendanceDay = currentIstDayKey();
    _firstSeenAt = Date.now();
    sendHeartbeat();
    _hbInterval = setInterval(sendHeartbeat, 60000);
  }

  function makeTimestamp() {
    return new Date().toLocaleString('en-IN', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      timeZone: 'Asia/Kolkata'
    });
  }

  function extractTicketIdFromText(text) {
    if (!text) return null;
    const s = String(text);
    const patterns = [
      /\/tickets?\/(\d{1,6})(?:\D|$)/i,
      /[?&](?:ticket[_-]?id|ticketId|conversationId|conversation_id|id)=(\d{1,6})(?:\D|$)/i,
      /"(?:ticket[_-]?id|ticketId|conversationId|conversation_id|ticketNumber|ticket_no|ticketNo|id)"\s*:\s*"?(\d{1,6})"?/i,
      /"(?:ticket|conversation)"\s*:\s*\{[^{}]*"id"\s*:\s*"?(\d{1,6})"?/i,
      /\b(?:ticket|conversation)[^\d]{0,20}#?(\d{3,6})\b/i
    ];
    for (const pattern of patterns) {
      const m = s.match(pattern);
      if (m) return m[1];
    }
    return null;
  }

  function getTicketFromPageContext() {
    try {
      const href = window.location.href || '';
      if (!/ticket|conversation/i.test(href)) return null;
      return extractTicketIdFromText(href);
    } catch (_) {
      return null;
    }
  }

  function getTicketInfo(apiUrl, body) {
    const fromUrl = extractTicketIdFromText(apiUrl);
    if (fromUrl) return fromUrl;

    if (body) {
      const s = typeof body === 'string' ? body : JSON.stringify(body);
      const fromBody = extractTicketIdFromText(s);
      if (fromBody) return fromBody;
    }

    // Only use page context when we are explicitly on a ticket/conversation page.
    return getTicketFromPageContext();
  }

  function extractUltraEmail(str) {
    if (!str) return null;
    const m = String(str).match(/[\w.+\-]+@ultrahuman\.com/i);
    return m ? m[0].toLowerCase() : null;
  }

  // Broader extraction for trusted sources (localStorage, globals) — skips personal providers
  function extractWorkEmail(str) {
    if (!str) return null;
    const ms = String(str).match(/[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g);
    if (!ms) return null;
    for (const m of ms) {
      const e = m.toLowerCase();
      if (/\b(gmail|yahoo|hotmail|outlook|live|icloud|rediffmail|protonmail|aol|ymail)\b/.test(e)) continue;
      return e;
    }
    return null;
  }

  // Parse JWT payload and extract email field
  function extractEmailFromJwt(str) {
    if (!str) return null;
    const tokens = String(str).match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g) || [];
    for (const t of tokens) {
      try {
        const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const e = payload.email || payload.emailId || payload.mail || payload.agentEmail;
        if (e && /\w+@\w+\.\w+/.test(e)) return String(e).toLowerCase();
      } catch (_) {}
    }
    return null;
  }

  function sniffEmail(text) {
    if (agentEmail) return;
    const e = extractUltraEmail(text);
    if (e) { agentEmail = e; console.log('[YL-Logger] Agent email detected:', e); }
  }

  function sniffWorkEmail(text) {
    if (agentEmail) return;
    const e = extractEmailFromJwt(text) || extractWorkEmail(text);
    if (e) { agentEmail = e; console.log('[YL-Logger] Agent email detected (work):', e); }
  }

  function sniffEmbeddedPageData() {
    if (agentEmail) return agentEmail;
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const txt = script.textContent;
        if (!txt) continue;
        sniffEmail(txt);
        if (!agentEmail) sniffWorkEmail(txt);
        if (agentEmail) return agentEmail;
      }
    } catch (_) {}
    return agentEmail;
  }

  function ensureAttendance(reason) {
    const email = detectAgentEmail();
    if (!email) {
      _attendancePending = true;
      console.log('[YL-Logger] Attendance pending: email not detected yet', reason || '');
      return false;
    }
    _attendancePending = false;
    startHeartbeat();
    sendHeartbeat();
    setAgentStatus('Available', reason || 'attendance');
    return true;
  }

  function isAvailableSignal(text) {
    if (!text) return false;
    return /"status"\s*:\s*"available"|\bset available\b|\bmark available\b|\bgo online\b|\bavailable\b/i.test(String(text));
  }

  // ── Busy / Away signal detection ──

  function isBusySignal(text) {
    if (!text) return false;
    return /"status"\s*:\s*"busy"|\bset busy\b|\bmark busy\b|\bgo busy\b|\bbusy\b/i.test(String(text));
  }

  function isAwaySignal(text) {
    if (!text) return false;
    return /"status"\s*:\s*"away"|\bset away\b|\bmark away\b|\bgo away\b|\baway\b/i.test(String(text));
  }

  function pageShowsAvailableStatus() {
    try {
      const nodes = document.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"],[role="status"],[data-status],[class*="status"],[class*="Status"],[aria-label],[title],div,span');
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text || text.length > 50) continue;
        if (/\bavailable\b/.test(text)) return true;
      }
    } catch (_) {}
    return false;
  }

  function pageShowsBusyStatus() {
    try {
      const nodes = document.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"],[role="status"],[data-status],[class*="status"],[class*="Status"],[aria-label],[title],div,span');
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text || text.length > 50) continue;
        if (/\bbusy\b/.test(text)) return true;
      }
    } catch (_) {}
    return false;
  }

  function pageShowsAwayStatus() {
    try {
      const nodes = document.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"],[role="status"],[data-status],[class*="status"],[class*="Status"],[aria-label],[title],div,span');
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text || text.length > 50) continue;
        if (/\baway\b/.test(text)) return true;
      }
    } catch (_) {}
    return false;
  }

  // ── Presence event helpers ──

  /**
   * Posts a presence event via window.postMessage.
   * bridge.js (ISOLATED world) receives this and forwards to background.js.
   */
  function postPresenceEvent(evtType, status) {
    const email = agentEmail || detectAgentEmail();
    if (!email) return;
    window.postMessage({
      type: 'yl-presence-event',
      event: {
        type:   evtType,
        email:  email,
        status: status || _agentStatus || 'Available',
        ts:     Date.now()
      }
    }, '*');
  }

  /**
   * Transitions the agent to a new status.
   * First call fires 'login', subsequent calls fire 'status_change'.
   */
  function setAgentStatus(newStatus, source) {
    const email = agentEmail || detectAgentEmail();
    if (!email) return;
    if (!_presenceStarted) {
      _presenceStarted = true;
      _agentStatus     = newStatus;
      postPresenceEvent('login', newStatus);
      console.log('[YL-Logger] Presence login:', newStatus, '|', source);
    } else if (_agentStatus !== newStatus) {
      _agentStatus = newStatus;
      postPresenceEvent('status_change', newStatus);
      console.log('[YL-Logger] Status change →', newStatus, '|', source);
    }
  }

  function findActionElement(target) {
    let el = target;
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) continue;
      if (
        el.matches('button,[role="button"],li[role="menuitem"],[role="menuitem"],[role="option"],[role="listitem"]') ||
        isAvailableSignal(text) ||
        /^resolv|mark.*resolv|close ticket|on.?hold|put on hold/i.test(text)
      ) {
        return el;
      }
    }
    return null;
  }

  function detectAgentEmail() {
    if (agentEmail) return agentEmail;

    // 1. Window globals (use broader work-email detection — safe source)
    const globals = ['__userData', 'userData', 'user', 'currentUser', 'agentProfile', '__agent', 'YellowAI', 'ylUser'];
    for (const g of globals) {
      try {
        const obj = window[g];
        if (!obj) continue;
        const s = JSON.stringify(obj);
        sniffEmail(s);
        if (!agentEmail) sniffWorkEmail(s);
        if (agentEmail) return agentEmail;
      } catch (_) {}
    }

    // 2. localStorage — check JWTs first (most reliable), then any value
    try {
      const vals = [];
      for (let i = 0; i < localStorage.length; i++) vals.push(localStorage.getItem(localStorage.key(i)) || '');
      for (const v of vals) { sniffEmail(v); if (agentEmail) return agentEmail; }
      for (const v of vals) { sniffWorkEmail(v); if (agentEmail) return agentEmail; }
    } catch (_) {}

    // 3. Cookies
    try { sniffEmail(document.cookie); if (!agentEmail) sniffWorkEmail(document.cookie); } catch (_) {}
    if (agentEmail) return agentEmail;

    // 4. Embedded page data / inline scripts
    sniffEmbeddedPageData();
    if (agentEmail) return agentEmail;

    // 5. Full DOM scan
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      sniffEmail(node.nodeValue);
      if (agentEmail) return agentEmail;
    }

    return null;
  }

  function startEmailDetectionLoop() {
    if (_detectInterval) return;
    _detectInterval = setInterval(() => {
      if (agentEmail) {
        clearInterval(_detectInterval);
        _detectInterval = null;
        // Always start presence as soon as email is known — don't wait for "available" signal
        if (!_presenceStarted) {
          const s = pageShowsBusyStatus() ? 'Busy' : pageShowsAwayStatus() ? 'Away' : 'Available';
          setAgentStatus(s, 'email-detected');
          startHeartbeat();
        }
        if (_attendancePending || pageShowsAvailableStatus()) ensureAttendance('email-ready');
        return;
      }
      detectAgentEmail();
    }, 2000);
  }

  function startAvailableDetectionLoop() {
    if (_availableInterval) return;
    _availableInterval = setInterval(() => {
      if (pageShowsAvailableStatus()) {
        ensureAttendance('dom-available');        // sets status → Available
      } else if (pageShowsBusyStatus()) {
        if (agentEmail) setAgentStatus('Busy', 'dom-poll');
      } else if (pageShowsAwayStatus()) {
        if (agentEmail) setAgentStatus('Away', 'dom-poll');
      }
    }, 5000);
  }

  function showToast(msg, color) {
    let t = document.getElementById('yl-ext-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'yl-ext-toast';
      t.style.cssText = `
        position:fixed;bottom:28px;right:28px;z-index:2147483647;
        color:#fff;padding:11px 18px;border-radius:9px;
        font-size:13px;font-family:-apple-system,sans-serif;font-weight:500;
        box-shadow:0 4px 16px rgba(0,0,0,0.22);pointer-events:none;
        transition:opacity 0.3s;opacity:0;
      `;
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = color;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
  }

  function logEntry(status, apiUrl, body) {
    const ticketId = getTicketInfo(apiUrl, body);
    if (!ticketId || !/^\d{1,5}$/.test(ticketId)) {
      console.log('[YL-Logger] Skipped: could not identify ticket ID', {
        status,
        apiUrl: apiUrl || null,
        hasBody: Boolean(body),
        page: window.location.href
      });
      return;
    }
    const key = ticketId;
    const now = Date.now();
    // Suppress any re-fire for the same ticket within 10 minutes (prevents false Resolved after On Hold)
    if (recentLogs[key] && now - recentLogs[key] < 600000) return;
    recentLogs[key] = now;
    const agent = detectAgentEmail() || 'unknown';
    const entry = { id: now, ticketId, timestamp: makeTimestamp(), status, agentEmail: agent };
    window.postMessage({ type: 'yl-log-entry', entry }, '*');
    const color = status === 'Resolved' ? '#2e7d32' : '#f5a623';
    showToast((status === 'Resolved' ? '✓' : '⏸') + ' Logged: ' + ticketId + ' · ' + agent.split('@')[0], color);
    console.log('[YL-Logger] Logged:', status, ticketId, '| agent:', agent);
  }

  function manualLogEntry(ticketId, status, agentOverride) {
    const normalizedTicketId = String(ticketId || '').trim();
    const normalizedStatus = status === 'On Hold' ? 'On Hold' : 'Resolved';
    if (!/^\d{1,5}$/.test(normalizedTicketId)) {
      console.warn('[YL-Logger] Manual log rejected: invalid ticket ID', ticketId);
      return false;
    }

    if (agentOverride) {
      const manualEmail = extractUltraEmail(agentOverride);
      if (manualEmail) agentEmail = manualEmail;
    }

    const agent = detectAgentEmail() || 'unknown';
    const now = Date.now();
    const entry = {
      id: now,
      ticketId: normalizedTicketId,
      timestamp: makeTimestamp(),
      status: normalizedStatus,
      agentEmail: agent
    };

    window.postMessage({ type: 'yl-log-entry', entry }, '*');
    const color = normalizedStatus === 'Resolved' ? '#2e7d32' : '#f5a623';
    showToast((normalizedStatus === 'Resolved' ? '✓' : '⏸') + ' Logged: ' + normalizedTicketId + ' · ' + agent.split('@')[0], color);
    console.log('[YL-Logger] Manual log:', normalizedStatus, normalizedTicketId, '| agent:', agent);
    return true;
  }

  // ── Intercept fetch — sniff email + status signals from ALL responses ──
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const req  = args[0];
    const opts = args[1] || {};
    const url    = typeof req === 'string' ? req : (req.url || '');
    const method = (opts.method || (req && req.method) || 'GET').toUpperCase();

    const res = await _fetch.apply(this, args);

    // Sniff agent email + status signals from any response
    try {
      res.clone().text().then(text => {
        if (!agentEmail) sniffEmail(text);
        if (isAvailableSignal(text)) {
          setTimeout(() => ensureAttendance('response:' + url), 150);
        } else if (isBusySignal(text)) {
          setTimeout(() => { if (_presenceStarted) setAgentStatus('Busy', 'response:' + url); }, 150);
        } else if (isAwaySignal(text)) {
          setTimeout(() => { if (_presenceStarted) setAgentStatus('Away', 'response:' + url); }, 150);
        }
      }).catch(() => {});
    } catch (_) {}

    // Detect status changes in mutating requests (skip search/filter/list endpoints)
    if (['POST', 'PUT', 'PATCH'].includes(method) && !/search|filter|list|query|export/i.test(url)) {
      try {
        let body = '';
        if (opts.body) body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        const combined = url + ' ' + body;
        if (isAvailableSignal(combined)) {
          setTimeout(() => ensureAttendance('fetch:' + url), 150);
        } else if (isBusySignal(combined)) {
          setTimeout(() => { if (_presenceStarted) setAgentStatus('Busy', 'fetch:' + url); }, 150);
        } else if (isAwaySignal(combined)) {
          setTimeout(() => { if (_presenceStarted) setAgentStatus('Away', 'fetch:' + url); }, 150);
        }
        const combinedLower = combined.toLowerCase();
        if (/resolv|"status"\s*:\s*"resolved"/i.test(combinedLower)) {
          setTimeout(() => logEntry('Resolved', url, body), 400);
        } else if (/on.?hold|onhold|"status"\s*:\s*"hold"/i.test(combinedLower)) {
          const hasTicketInCall = !!(extractTicketIdFromText(url) || extractTicketIdFromText(body));
          if (hasTicketInCall) setTimeout(() => logEntry('On Hold', url, body), 400);
        }
      } catch (_) {}
    }

    return res;
  };

  // ── Intercept XHR ──
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (m, u) {
    this._ylMethod = m; this._ylUrl = u;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    // Sniff email from XHR response too
    this.addEventListener('load', function () {
      try {
        if (!agentEmail) sniffEmail(this.responseText);
        if (!agentEmail) sniffWorkEmail(this.responseText);
      } catch (_) {}
    });
    if (['POST', 'PUT', 'PATCH'].includes((this._ylMethod || '').toUpperCase()) && !/search|filter|list|query|export/i.test(this._ylUrl || '')) {
      try {
        const combined = ((this._ylUrl || '') + ' ' + (body || '')).toLowerCase();
        if (isAvailableSignal(combined)) {
          setTimeout(() => ensureAttendance('xhr:' + (this._ylUrl || '')), 150);
        } else if (isBusySignal(combined)) {
          setTimeout(() => { if (_presenceStarted) setAgentStatus('Busy', 'xhr:' + (this._ylUrl || '')); }, 150);
        } else if (isAwaySignal(combined)) {
          setTimeout(() => { if (_presenceStarted) setAgentStatus('Away', 'xhr:' + (this._ylUrl || '')); }, 150);
        }
        if (/resolv/.test(combined)) {
          setTimeout(() => logEntry('Resolved', this._ylUrl, body), 400);
        } else if (/on.?hold|onhold/.test(combined)) {
          const hasTicketInCall = !!(extractTicketIdFromText(this._ylUrl) || extractTicketIdFromText(body));
          if (hasTicketInCall) setTimeout(() => logEntry('On Hold', this._ylUrl, body), 400);
        }
      } catch (_) {}
    }
    return _send.apply(this, arguments);
  };

  // ── Click fallback ──
  document.addEventListener('click', function (e) {
    const el = findActionElement(e.target);
    if (!el) return;
    const text = (el.innerText || '').trim().toLowerCase();
    if (isAvailableSignal(text)) {
      setTimeout(() => ensureAttendance('click:' + text), 150);
    } else if (isBusySignal(text)) {
      setTimeout(() => { if (_presenceStarted) setAgentStatus('Busy', 'click:' + text); }, 150);
    } else if (isAwaySignal(text)) {
      setTimeout(() => { if (_presenceStarted) setAgentStatus('Away', 'click:' + text); }, 150);
    }
    if (/^resolv|mark.*resolv|close ticket/.test(text)) {
      setTimeout(() => logEntry('Resolved'), 600);
    } else if (/on.?hold|put on hold/.test(text)) {
      setTimeout(() => logEntry('On Hold'), 600);
    }
  }, true);

  // ── Presence: resume from Away when tab becomes visible again ──
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && _presenceStarted) {
      // Send a heartbeat so background.js sees the agent is active again.
      // If background had auto-marked them Away, the heartbeat will restore Available.
      sendHeartbeat();
      if (_agentStatus === 'Away') {
        setAgentStatus('Available', 'tab-visible');
      }
    }
  });

  // ── Presence: logout on page unload (best-effort) ──
  // The 30-min alarm threshold in background.js is the reliable fallback.
  window.addEventListener('beforeunload', function () {
    if (_presenceStarted && agentEmail) {
      postPresenceEvent('logout', _agentStatus || 'Available');
    }
  });

  startEmailDetectionLoop();
  startAvailableDetectionLoop();
  window.addEventListener('load', function () {
    detectAgentEmail();
    if (agentEmail && !_presenceStarted) {
      const s = pageShowsBusyStatus() ? 'Busy' : pageShowsAwayStatus() ? 'Away' : 'Available';
      setAgentStatus(s, 'page-load');
      startHeartbeat();
    }
    if (pageShowsAvailableStatus()) ensureAttendance('window-load-available');
  });

  window.YLLoggerManual = {
    log: manualLogEntry,
    attendance: ensureAttendance,
    email: () => detectAgentEmail(),
    status: () => _agentStatus
  };

  console.log('[YL-Logger] Interceptors active on Yellow.ai');
})();
