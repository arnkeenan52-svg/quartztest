// js/track.js — Pings /api/log-visit so admin dashboard can show active users
(function() {
  // Don't track admin page itself
  if (window.location.pathname.includes('/admin')) return;

  function ping() {
    fetch('/api/log-visit', { method: 'POST', keepalive: true })
      .catch(() => { /* silent */ });
  }

  // Ping immediately + every 30 sec while page is visible
  ping();
  let timer = setInterval(() => {
    if (!document.hidden) ping();
  }, 30000);

  // Also ping when tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ping();
  });
})();
