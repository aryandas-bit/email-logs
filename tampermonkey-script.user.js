// ==UserScript==
// @name         Yellow.ai → Email Log
// @namespace    https://email-logs.vercel.app
// @version      1.2
// @description  Auto-logs Resolved / On Hold actions from Yellow.ai to your Email Log Sheet
// @match        https://cloud.yellow.ai/*
// @match        https://email-logs.vercel.app/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
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
    // Prevent duplicate if same ticket logged within 5 seconds
    const recent = arr[arr.length - 1];
    if (recent && recent.ticketId === ticketId && recent.status === status &&
        Date.now() - recent.id < 5000) return;
    arr.push({ id: Date.now(), ticketId, timestamp: makeTimestamp(), status });
    saveEntries(arr);
  }

  // ─────────────────────────────────────────────────────────────────
  //  YELLOW.AI SIDE
  // ─────────────────────────────────────────────────────────────────
  if (location.hostname === 'cloud.yellow.ai') {

    // Inject animation style
    const style = document.createElement('style');
    style.textContent = `
      @keyframes yl-fadein { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }
    `;
    document.head.appendChild(style);

    function showToast(msg, color) {
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

    function getTicketInfo() {
      // 1. Try to find email address anywhere in the visible conversation header/sidebar
      const allText = [...document.querySelectorAll(
        '[class*="header"] *, [class*="sidebar"] *, [class*="profile"] *, [class*="contact"] *, [class*="customer"] *'
      )].map(el => el.textContent.trim()).join(' ');

      const emailMatch = allText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) return emailMatch[0];

      // 2. Try ticket/conversation ID from URL
      const urlMatch = location.pathname.match(/\/(\d{6,})/);
      if (urlMatch) return `Ticket #${urlMatch[1]}`;

      // 3. Try page title or any heading
      const heading = document.querySelector(
        '[class*="title"],[class*="name"],[class*="conversation-header"] h1,[class*="ticket"] h1'
      );
      if (heading && heading.textContent.trim()) return heading.textContent.trim().slice(0, 80);

      // 4. Fallback
      return `Ticket-${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
    }

    // Event delegation — captures clicks on Resolve / On Hold buttons
    document.addEventListener('click', function (e) {
      const el = e.target.closest(
        'button, [role="button"], [class*="btn"], li[role="menuitem"], [class*="dropdown-item"], [class*="option"]'
      );
      if (!el) return;

      const text = el.innerText ? el.innerText.trim().toLowerCase() : '';

      const isResolved =
        text === 'resolve' || text === 'resolved' ||
        text.includes('mark as resolved') || text.includes('mark resolved') ||
        text === 'close' || text === 'close ticket';

      const isOnHold =
        text === 'on hold' || text === 'hold' ||
        text.includes('on hold') || text.includes('put on hold') || text.includes('snooze');

      if (isResolved) {
        const info = getTicketInfo();
        pushEntry(info, 'Resolved');
        showToast(`✓ Logged as Resolved — ${info.slice(0, 50)}`, '#2e7d32');
      } else if (isOnHold) {
        const info = getTicketInfo();
        pushEntry(info, 'On Hold');
        showToast(`⏸ Logged as On Hold — ${info.slice(0, 50)}`, '#f5a623');
      }
    }, true);
  }

  // ─────────────────────────────────────────────────────────────────
  //  EMAIL LOG PAGE SIDE (email-logs.vercel.app)
  // ─────────────────────────────────────────────────────────────────
  if (location.hostname === 'email-logs.vercel.app') {

    function syncToPage() {
      const uw = unsafeWindow;
      if (typeof uw.render !== 'function') return;
      const stored = getEntries();
      // Only update if something changed
      if (JSON.stringify(uw.entries) !== JSON.stringify(stored)) {
        uw.entries = stored;
        uw.render();
      }
    }

    window.addEventListener('load', function () {
      // Initial sync
      syncToPage();

      // Poll for new entries from Yellow.ai every 3 seconds
      setInterval(syncToPage, 3000);

      // Patch page functions so manual actions also persist to GM storage
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
