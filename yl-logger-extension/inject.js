// Runs in MAIN world on cloud.yellow.ai
// Intercepts fetch/XHR, detects Resolved / On Hold, captures agent email

(function () {

  let agentEmail = null;
  const recentLogs = {}; // ticketId+status → timestamp, prevents duplicate fires

  // ── Heartbeat ──
  const HB_URL = 'https://yl-logs-default-rtdb.firebaseio.com/heartbeats';
  let _hbInterval = null;
  function sendHeartbeat() {
    if (!agentEmail) return;
    const key = agentEmail.replace(/[@.]/g, '_');
    fetch(`${HB_URL}/${key}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: agentEmail, lastSeen: Date.now() })
    }).catch(() => {});
  }
  function startHeartbeat() {
    if (_hbInterval) return;
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

  function getTicketInfo(apiUrl, body) {
    // 1. API URL — ticket number in path or query
    if (apiUrl) {
      const m = apiUrl.match(/\/tickets?\/(\d+)/i) ||
                apiUrl.match(/[?&]ticket[_-]?id=(\d+)/i) ||
                apiUrl.match(/\/(\d{4,})/);
      if (m) return m[1];
    }
    // 2. Request body — "ticketId":4107 or "id":4107 etc.
    if (body) {
      const s = typeof body === 'string' ? body : JSON.stringify(body);
      const m = s.match(/"ticket[_-]?id"\s*:\s*(\d+)/i) ||
                s.match(/"ticketId"\s*:\s*"(\d+)"/i) ||
                s.match(/"uid"\s*:\s*"?(\d{4,})"?/i);
      if (m) return m[1];
    }
    // Do NOT fall back to page URL or DOM — that causes false positives when
    // an agent is merely viewing a ticket while an unrelated API call fires
    return null;
  }

  function extractUltraEmail(str) {
    if (!str) return null;
    const m = String(str).match(/[\w.+\-]+@ultrahuman\.com/i);
    return m ? m[0].toLowerCase() : null;
  }

  function sniffEmail(text) {
    if (agentEmail) return;
    const e = extractUltraEmail(text);
    if (e) { agentEmail = e; console.log('[YL-Logger] Agent email detected:', e); startHeartbeat(); }
  }

  function detectAgentEmail() {
    if (agentEmail) return agentEmail;

    // 1. Window globals
    const globals = ['__userData', 'userData', 'user', 'currentUser', 'agentProfile', '__agent', 'YellowAI', 'ylUser'];
    for (const g of globals) {
      try {
        const obj = window[g];
        if (!obj) continue;
        sniffEmail(JSON.stringify(obj));
        if (agentEmail) return agentEmail;
      } catch (_) {}
    }

    // 2. localStorage
    try {
      for (let i = 0; i < localStorage.length; i++) {
        sniffEmail(localStorage.getItem(localStorage.key(i)));
        if (agentEmail) return agentEmail;
      }
    } catch (_) {}

    // 3. Cookies
    try { sniffEmail(document.cookie); } catch (_) {}
    if (agentEmail) return agentEmail;

    // 4. Full DOM scan
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      sniffEmail(node.nodeValue);
      if (agentEmail) return agentEmail;
    }

    return null;
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
    if (!ticketId) { console.log('[YL-Logger] Skipped: could not identify ticket ID'); return; }
    const key = ticketId + '|' + status;
    const now = Date.now();
    // Suppress duplicate fires within 10 minutes for the same ticket+status
    if (recentLogs[key] && now - recentLogs[key] < 600000) return;
    recentLogs[key] = now;
    const agent = detectAgentEmail() || 'unknown';
    const entry = { id: now, ticketId, timestamp: makeTimestamp(), status, agentEmail: agent };
    window.postMessage({ type: 'yl-log-entry', entry }, '*');
    const color = status === 'Resolved' ? '#2e7d32' : '#f5a623';
    showToast((status === 'Resolved' ? '✓' : '⏸') + ' Logged: ' + ticketId + ' · ' + agent.split('@')[0], color);
    console.log('[YL-Logger] Logged:', status, ticketId, '| agent:', agent);
  }

  // ── Intercept fetch — sniff email from ALL responses ──
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const req  = args[0];
    const opts = args[1] || {};
    const url    = typeof req === 'string' ? req : (req.url || '');
    const method = (opts.method || (req && req.method) || 'GET').toUpperCase();

    const res = await _fetch.apply(this, args);

    // Sniff agent email from any response
    if (!agentEmail) {
      try {
        res.clone().text().then(sniffEmail).catch(() => {});
      } catch (_) {}
    }

    // Detect status changes in mutating requests (skip search/filter/list endpoints)
    if (['POST', 'PUT', 'PATCH'].includes(method) && !/search|filter|list|query|export/i.test(url)) {
      try {
        let body = '';
        if (opts.body) body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        const combined = (url + ' ' + body).toLowerCase();
        if (/resolv|"status"\s*:\s*"resolved"/i.test(combined)) {
          setTimeout(() => logEntry('Resolved', url, body), 400);
        } else if (/on.?hold|onhold|"status"\s*:\s*"hold"/i.test(combined)) {
          setTimeout(() => logEntry('On Hold', url, body), 400);
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
    if (!agentEmail) {
      this.addEventListener('load', function () {
        try { sniffEmail(this.responseText); } catch (_) {}
      });
    }
    if (['POST', 'PUT', 'PATCH'].includes((this._ylMethod || '').toUpperCase()) && !/search|filter|list|query|export/i.test(this._ylUrl || '')) {
      try {
        const combined = ((this._ylUrl || '') + ' ' + (body || '')).toLowerCase();
        if (/resolv/.test(combined)) setTimeout(() => logEntry('Resolved', this._ylUrl, body), 400);
        else if (/on.?hold|onhold/.test(combined)) setTimeout(() => logEntry('On Hold', this._ylUrl, body), 400);
      } catch (_) {}
    }
    return _send.apply(this, arguments);
  };

  // ── Click fallback ──
  document.addEventListener('click', function (e) {
    const el = e.target.closest('button,[role="button"],li[role="menuitem"]');
    if (!el) return;
    const text = (el.innerText || '').trim().toLowerCase();
    if (/^resolv|mark.*resolv|close ticket/.test(text)) {
      setTimeout(() => logEntry('Resolved'), 600);
    } else if (/on.?hold|put on hold/.test(text)) {
      setTimeout(() => logEntry('On Hold'), 600);
    }
  }, true);

  console.log('[YL-Logger] Interceptors active on Yellow.ai');
})();
