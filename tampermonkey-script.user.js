// ==UserScript==
// @name         Yellow.ai → Email Log
// @namespace    https://email-logs.vercel.app
// @version      2.0
// @description  Auto-logs Resolved / On Hold actions from Yellow.ai to your Email Log Sheet
// @match        https://cloud.yellow.ai/*
// @match        https://email-logs.vercel.app/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'yl_log_entries';

  function getEntries() {
    try { return JSON.parse(GM_getValue(STORAGE_KEY, '[]')); } catch (e) { return []; }
  }

  function saveEntries(arr) {
    GM_setValue(STORAGE_KEY, JSON.stringify(arr));
  }

  function makeTimestamp() {
    return new Date().toLocaleString('en-IN', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });
  }

  function pushEntry(ticketId, status) {
    const arr = getEntries();
    const recent = arr[arr.length - 1];
    if (recent && recent.ticketId === ticketId && recent.status === status &&
        Date.now() - recent.id < 5000) return;
    arr.push({ id: Date.now(), ticketId, timestamp: makeTimestamp(), status });
    saveEntries(arr);
    console.log('[YL-Log] Saved:', status, ticketId);
  }

  // ─────────────────────────────────────────────────────────────────
  //  YELLOW.AI SIDE
  // ─────────────────────────────────────────────────────────────────
  if (location.hostname === 'cloud.yellow.ai') {

    // Inject toast style early
    function ensureStyle() {
      if (document.getElementById('yl-log-style')) return;
      const style = document.createElement('style');
      style.id = 'yl-log-style';
      style.textContent = `
        @keyframes yl-fadein { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    function showToast(msg, color) {
      ensureStyle();
      const old = document.getElementById('yl-log-toast');
      if (old) old.remove();
      const t = document.createElement('div');
      t.id = 'yl-log-toast';
      t.style.cssText = `
        position:fixed;bottom:28px;right:28px;z-index:2147483647;
        background:${color};color:#fff;padding:11px 18px;border-radius:9px;
        font-size:13px;font-family:-apple-system,sans-serif;font-weight:500;
        box-shadow:0 4px 16px rgba(0,0,0,0.22);
        animation:yl-fadein 0.2s ease;pointer-events:none;
      `;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => { if (t.parentNode) t.remove(); }, 3200);
    }

    // Extract email/ticket from current page DOM
    function getTicketInfo() {
      // Scan all visible text for an email address
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const m = node.nodeValue.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (m) return m[0];
      }
      // Fallback: ticket ID from URL
      const urlMatch = location.pathname.match(/\/(\d{5,})/);
      if (urlMatch) return `Ticket #${urlMatch[1]}`;
      // Fallback: page title
      if (document.title) return document.title.slice(0, 60);
      return `Entry-${Date.now()}`;
    }

    // ── PRIMARY: Intercept fetch (Yellow.ai is a React SPA, uses fetch) ──
    const uw = unsafeWindow;
    const _fetch = uw.fetch;
    uw.fetch = async function (...args) {
      const req = args[0];
      const opts = args[1] || {};
      const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
      const method = (opts.method || (req.method) || 'GET').toUpperCase();

      // Only care about mutating requests
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        try {
          let bodyStr = '';
          if (opts.body) {
            bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
          }
          const combined = (url + ' ' + bodyStr).toLowerCase();

          // Detect resolved
          if (
            combined.includes('resolve') ||
            combined.includes('"status":"resolved"') ||
            combined.includes('"status": "resolved"') ||
            combined.includes('assignstatus=resolved') ||
            combined.includes('ticket_status=resolved')
          ) {
            const info = getTicketInfo();
            pushEntry(info, 'Resolved');
            setTimeout(() => showToast(`✓ Logged as Resolved — ${info.slice(0, 50)}`, '#2e7d32'), 300);
          }

          // Detect on hold
          if (
            combined.includes('on_hold') ||
            combined.includes('onhold') ||
            combined.includes('"status":"hold"') ||
            combined.includes('"status": "hold"') ||
            combined.includes('on hold') ||
            combined.includes('snooze')
          ) {
            const info = getTicketInfo();
            pushEntry(info, 'On Hold');
            setTimeout(() => showToast(`⏸ Logged as On Hold — ${info.slice(0, 50)}`, '#f5a623'), 300);
          }
        } catch (e) { /* ignore parse errors */ }
      }

      return _fetch.apply(this, args);
    };

    // ── SECONDARY: Intercept XMLHttpRequest ──
    const _XHROpen = uw.XMLHttpRequest.prototype.open;
    const _XHRSend = uw.XMLHttpRequest.prototype.send;

    uw.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._ylMethod = method;
      this._ylUrl = url;
      return _XHROpen.call(this, method, url, ...rest);
    };

    uw.XMLHttpRequest.prototype.send = function (body) {
      const method = (this._ylMethod || '').toUpperCase();
      const url = this._ylUrl || '';
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        try {
          const bodyStr = typeof body === 'string' ? body : '';
          const combined = (url + ' ' + bodyStr).toLowerCase();

          if (
            combined.includes('resolve') ||
            combined.includes('"status":"resolved"') ||
            combined.includes('ticket_status=resolved')
          ) {
            const info = getTicketInfo();
            pushEntry(info, 'Resolved');
            setTimeout(() => showToast(`✓ Logged as Resolved — ${info.slice(0, 50)}`, '#2e7d32'), 300);
          }

          if (
            combined.includes('on_hold') || combined.includes('onhold') ||
            combined.includes('"status":"hold"') || combined.includes('on hold')
          ) {
            const info = getTicketInfo();
            pushEntry(info, 'On Hold');
            setTimeout(() => showToast(`⏸ Logged as On Hold — ${info.slice(0, 50)}`, '#f5a623'), 300);
          }
        } catch (e) { /* ignore */ }
      }
      return _XHRSend.call(this, body);
    };

    // ── FALLBACK: Click detection ──
    document.addEventListener('click', function (e) {
      const el = e.target.closest('button, [role="button"], li[role="menuitem"], [class*="option"]');
      if (!el) return;
      const text = (el.innerText || '').trim().toLowerCase();

      if (['resolve', 'resolved', 'close ticket', 'mark as resolved'].some(k => text === k || text.includes(k))) {
        setTimeout(() => {
          const info = getTicketInfo();
          pushEntry(info, 'Resolved');
          showToast(`✓ Logged as Resolved — ${info.slice(0, 50)}`, '#2e7d32');
        }, 600); // wait 600ms so DOM updates first
      }

      if (['on hold', 'hold', 'put on hold', 'snooze'].some(k => text === k || text.includes(k))) {
        setTimeout(() => {
          const info = getTicketInfo();
          pushEntry(info, 'On Hold');
          showToast(`⏸ Logged as On Hold — ${info.slice(0, 50)}`, '#f5a623');
        }, 600);
      }
    }, true);

    console.log('[YL-Log] Yellow.ai interceptors active');
  }

  // ─────────────────────────────────────────────────────────────────
  //  EMAIL LOG PAGE SIDE
  // ─────────────────────────────────────────────────────────────────
  if (location.hostname === 'email-logs.vercel.app') {

    function syncToPage() {
      const uw = unsafeWindow;
      if (typeof uw.render !== 'function') return;
      const stored = getEntries();
      if (JSON.stringify(uw.entries) !== JSON.stringify(stored)) {
        uw.entries = stored;
        uw.render();
      }
    }

    window.addEventListener('load', function () {
      syncToPage();
      setInterval(syncToPage, 3000);

      const uw = unsafeWindow;

      const origClipboard = uw.logFromClipboard;
      if (origClipboard) {
        uw.logFromClipboard = async function (status) {
          await origClipboard.call(this, status);
          saveEntries(uw.entries);
        };
      }

      const origRemove = uw.removeEntry;
      if (origRemove) {
        uw.removeEntry = function (id) {
          origRemove.call(this, id);
          saveEntries(uw.entries);
        };
      }

      const origUpdate = uw.updateStatus;
      if (origUpdate) {
        uw.updateStatus = function (id, newStatus) {
          origUpdate.call(this, id, newStatus);
          saveEntries(uw.entries);
        };
      }
    });
  }

})();
