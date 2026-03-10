// Runs in MAIN world on cloud.yellow.ai
// Intercepts fetch/XHR, detects Resolved / On Hold, captures agent email

(function () {

  let agentEmail = null;

  function makeTimestamp() {
    return new Date().toLocaleString('en-IN', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });
  }

  function getTicketInfo() {
    const urlMatch = location.pathname.match(/\/(\d+)$/);
    if (urlMatch) return urlMatch[1];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const m = node.nodeValue.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (m) return m[0];
    }
    return 'Ticket-' + Date.now();
  }

  function extractEmail(str, agentOnly) {
    if (!str) return null;
    const s = String(str);
    // If agentOnly, only match @ultrahuman.com addresses
    const pattern = agentOnly
      ? /[\w.+\-]+@ultrahuman\.com/i
      : /[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i;
    const m = s.match(pattern);
    return m ? m[0] : null;
  }

  function detectAgentEmail() {
    if (agentEmail) return agentEmail;

    // 1. Window globals — look for @ultrahuman.com first
    const globals = ['__userData', 'userData', 'user', 'currentUser', 'agentProfile', '__agent', 'YellowAI', 'ylUser'];
    for (const g of globals) {
      try {
        const obj = window[g];
        if (!obj) continue;
        const str = JSON.stringify(obj);
        const e = extractEmail(obj.email, true) || extractEmail(obj.emailId, true) || extractEmail(str, true);
        if (e) { agentEmail = e; return agentEmail; }
      } catch (_) {}
    }

    // 2. localStorage — only match @ultrahuman.com
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const val = localStorage.getItem(localStorage.key(i));
        const e = extractEmail(val, true);
        if (e) { agentEmail = e; return agentEmail; }
      }
    } catch (_) {}

    // 3. Cookies — only match @ultrahuman.com
    try {
      const e = extractEmail(document.cookie, true);
      if (e) { agentEmail = e; return agentEmail; }
    } catch (_) {}

    // 4. DOM scan — only match @ultrahuman.com
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const e = extractEmail(node.nodeValue, true);
      if (e) { agentEmail = e; return agentEmail; }
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

  function logEntry(status) {
    const ticketId = getTicketInfo();
    const agent = detectAgentEmail() || 'unknown';
    const entry = { id: Date.now(), ticketId, timestamp: makeTimestamp(), status, agentEmail: agent };
    window.postMessage({ type: 'yl-log-entry', entry }, '*');
    const color = status === 'Resolved' ? '#2e7d32' : '#f5a623';
    showToast((status === 'Resolved' ? '✓' : '⏸') + ' Logged as ' + status + ': ' + ticketId, color);
    console.log('[YL-Logger] Logged:', status, ticketId, '| agent:', agent);
  }

  // ── Intercept fetch ──
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0];
    const opts = args[1] || {};
    const url = typeof req === 'string' ? req : (req.url || '');
    const method = (opts.method || (req && req.method) || 'GET').toUpperCase();

    // Sniff agent email from profile/user API responses
    if (!agentEmail && /\/(user|agent|profile|me)\b/.test(url)) {
      try {
        const res = await _fetch.apply(this, args);
        res.clone().text().then(text => {
          const m = text.match(/"email"\s*:\s*"([\w.+\-]+@ultrahuman\.com)"/i);
          if (m) agentEmail = m[1];
        }).catch(() => {});
        // Still check for status changes in this response path
        return res;
      } catch (e) {}
    }

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        let body = '';
        if (opts.body) body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        const combined = (url + ' ' + body).toLowerCase();
        if (/resolv/.test(combined) || combined.includes('"status":"resolved"')) {
          setTimeout(() => logEntry('Resolved'), 400);
        } else if (/on.?hold|onhold|"status":"hold"/.test(combined)) {
          setTimeout(() => logEntry('On Hold'), 400);
        }
      } catch (e) {}
    }
    return _fetch.apply(this, args);
  };

  // ── Intercept XHR ──
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (m, u) {
    this._ylMethod = m; this._ylUrl = u;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (['POST', 'PUT', 'PATCH'].includes((this._ylMethod || '').toUpperCase())) {
      try {
        const combined = ((this._ylUrl || '') + ' ' + (body || '')).toLowerCase();
        if (/resolv/.test(combined)) setTimeout(() => logEntry('Resolved'), 400);
        else if (/on.?hold|onhold/.test(combined)) setTimeout(() => logEntry('On Hold'), 400);
      } catch (e) {}
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
