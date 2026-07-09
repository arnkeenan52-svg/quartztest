// api/admin-search.js — Search ALL orders (across time), for the admin panel.
//
// The dashboard's built-in search only filters the orders already loaded for the
// selected date range. This endpoint scans a wide window of Stripe checkout
// sessions so staff can find any order by number, name, e-mail or city — no
// matter how old.
//
// Auth: shares the /locker session cookie (lk_sess).
// Query: ?q=<text>

import { createHmac, timingSafeEqual } from 'crypto';

const SESSION_SECRET = process.env.LOCKER_SESSION_SECRET || '';

function checkAuth(req) {
  if (!SESSION_SECRET || SESSION_SECRET === 'CHANGE_ME_IN_VERCEL_ENV') return false;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)lk_sess=([^;]+)/);
  if (!m) return false;
  const tok = decodeURIComponent(m[1]);
  const dot = tok.lastIndexOf('.');
  if (dot < 0) return false;
  const data = tok.slice(0, dot), mac = tok.slice(dot + 1);
  const expect = createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  try {
    if (mac.length !== expect.length) return false;
    if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expect, 'hex'))) return false;
  } catch { return false; }
  const exp = parseInt(data, 10);
  return Number.isFinite(exp) && exp > Date.now();
}

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.status(200).json({ ok: true, orders: [], query: '' });

  try {
    const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);

    const nowTs = Math.floor(Date.now() / 1000);
    const since = nowTs - 400 * 86400; // ~13 months back

    const MAX_SESSIONS = 3000;  // scan cap (matches admin-stats)
    const MAX_MATCHES = 200;    // enough to display; stop early once reached
    let scanned = 0;
    const matches = [];

    const iterator = stripe.checkout.sessions.list({
      limit: 100,
      created: { gte: since, lte: nowTs },
    });

    for await (const s of iterator) {
      if (++scanned > MAX_SESSIONS) break;
      if (s.payment_status !== 'paid') continue;

      const ref = String(s.id).slice(-12).toUpperCase();
      const name = s.customer_details?.name || s.shipping_details?.name || '';
      const email = s.customer_details?.email || '';
      const addr = s.shipping_details?.address || s.customer_details?.address || {};
      const city = addr.city || '';
      const country = (addr.country || '').toUpperCase();

      const hay = `${ref} ${name} ${email} ${city} ${country}`.toLowerCase();
      if (!hay.includes(q)) continue;

      matches.push({
        id: s.id,
        ref,
        customerName: name || 'Kunde',
        email,
        amount: (s.amount_total || 0) / 100,
        city: city || 'Ukendt',
        country,
        itemCount: null,
        date: new Date((s.created || 0) * 1000).toISOString(),
      });
      if (matches.length >= MAX_MATCHES) break;
    }

    matches.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.status(200).json({
      ok: true,
      orders: matches,
      query: q,
      truncated: scanned > MAX_SESSIONS,
    });
  } catch (err) {
    console.error('admin-search error', err.message);
    return res.status(500).json({ error: 'Søgningen mislykkedes' });
  }
}
