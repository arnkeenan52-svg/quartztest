// api/log-visit.js — Logs a visitor heartbeat to Vercel KV
//
// Called by every page on the site every 30 seconds.
// Stores: visitor IDs with timestamps for "active now" + daily counters.

import { kv } from './_kv.js';
import { randomInt, randomBytes } from 'crypto';

// Only allow the site's own origins to post visitor heartbeats (reduces
// off-site abuse / metric pollution). '*' previously let anyone write.
const ALLOWED_ORIGINS = [
  'https://quartzmolle.dk',
  'https://www.quartzmolle.dk',
  'https://quartzzmolle-dusky.vercel.app',
];

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Bekræftelseslinket i mailen er et alm. GET — vis "bekræft"-siden.
  if (req.method === 'GET') {
    if ((req.query && req.query.action) === 'nlconfirm') return handleConfirmPage(req, res, req.query);
    return res.status(405).end();
  }
  if (req.method !== 'POST') return res.status(405).end();
  // Reject cross-origin callers (requests with an Origin that isn't ours).
  // Same-origin fetches from our own pages typically omit Origin or send ours.
  if (origin && !allowed) return res.status(403).json({ ok: false });

  // ── NYHEDSBREV: tilmelding med 10% velkomstrabat ──
  // Folded into this (public) endpoint so it adds no extra serverless function.
  let nlBody = req.body;
  if (typeof nlBody === 'string') { try { nlBody = JSON.parse(nlBody); } catch { nlBody = {}; } }
  if (nlBody && nlBody.action === 'newsletter') {
    return handleNewsletter(req, res, nlBody);
  }
  if (nlBody && nlBody.action === 'nlconfirm') {
    return handleNewsletterConfirm(req, res, nlBody);
  }

  // ── KUNDEREJSE: anonym "i kurv" / "gået til checkout" til admin-tragten ──
  if (nlBody && (nlBody.action === 'cart' || nlBody.action === 'checkoutstart')) {
    try {
      const id = String(nlBody.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 40) || 'anon';
      const now = Date.now();
      const count = Math.max(0, Math.min(999, parseInt(nlBody.count, 10) || 0));
      const total = Math.max(0, Math.min(99999, parseInt(nlBody.total, 10) || 0));
      if (nlBody.action === 'cart') {
        if (count === 0) {
          await kv.zrem('funnel:carts', id);
          await kv.del('funnel:cart:' + id);
        } else {
          await kv.zadd('funnel:carts', { score: now, member: id });
          await kv.set('funnel:cart:' + id, { t: now, count, total }, { ex: 3600 });
        }
      } else {
        await kv.zadd('funnel:checkouts', { score: now, member: id });
        await kv.zrem('funnel:carts', id); // videre i tragten — ikke længere "i kurv"
        await kv.del('funnel:cart:' + id);
      }
    } catch (e) { console.error('funnel log failed:', e && e.message); }
    return res.status(200).json({ ok: true });
  }

  try {
    // Simple visitor ID = hash of trusted IP + user-agent (no cookies needed)
    const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const ua = (req.headers['user-agent'] || '').slice(0, 100);
    const visitorId = Buffer.from(ip + '|' + ua).toString('base64').slice(0, 24);

    const now = Math.floor(Date.now() / 1000);

    // Active visitors: sorted set, score = timestamp
    // Members older than 60 sec are removed when we query
    await kv.zadd('active_visitors', { score: now, member: visitorId });

    // Daily unique visitor counter using a date-stamped set
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    await kv.sadd(`visitors:${today}`, visitorId);
    // Keep daily sets ~100 days so the admin can show accurate conversion rates
    // for 7/30/90-day periods (not just the last week).
    await kv.expire(`visitors:${today}`, 100 * 86400);

    return res.status(200).json({ ok: true });
  } catch (err) {
    // KV may not be configured yet - fail silently so site keeps working
    console.error('log-visit error:', err.message);
    return res.status(200).json({ ok: false });
  }
}

// ── NEWSLETTER SIGNUP (dobbelt opt-in) ───────────────────────────────────────
// En tilmelding gemmes som AFVENTENDE og udløser en bekræftelses-mail. Først
// når kunden klikker bekræftelseslinket, udstedes en UNIK engangs-rabatkode i
// Stripe og velkomstmailen sendes. Der findes ingen delt fælles-kode: fejler
// den unikke kode, tilmeldes kunden uden kode (ingen kode kan misbruges).

// Normalise an address so alias tricks can't harvest extra codes:
// everything after "+" in the local part is dropped for all domains, and dots
// in the local part are dropped for gmail (where they're ignored anyway).
function normalizeEmail(email) {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at), domain = email.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

const MAX_SIGNUPS_PER_IP_DAY = 3;    // bekræftelses-mails pr. IP pr. døgn
const MAX_SIGNUPS_PER_HOUR = 25;     // global nødbremse på bekræftelses-mails
const MAX_CODES_PER_DAY = 60;        // globalt loft på udstedte koder pr. døgn
                                     // (organisk ~5-20; over dette = angreb → tilmeldt uden kode)
const PENDING_TTL = 48 * 3600;       // bekræftelseslink gælder 48 timer
const PENDING_RESEND_TTL = 6 * 3600; // ny bekræftelses-mail tidligst efter 6 timer
const DAYSEC = 86400;
const dayStamp = () => new Date().toISOString().slice(0, 10);
const hourStamp = () => new Date().toISOString().slice(0, 13);
const SITE = 'https://www.quartzmolle.dk';

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || 'unknown';
}

function escapeHtmlNl(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function handleNewsletter(req, res, body) {
  try {
    // Honningkrukke: usynligt felt. Udfyldt = bot. Svar pænt, gør intet.
    if (String(body.website || '').trim()) {
      return res.status(200).json({ ok: true, pending: true });
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) {
      return res.status(400).json({ ok: false, error: 'Skriv en gyldig e-mailadresse.' });
    }
    const key = normalizeEmail(email);
    const lang = String(body.lang || 'da') === 'en' ? 'en' : 'da';

    // Allerede bekræftet abonnent (normaliseret adresse).
    let existing = null;
    try { existing = await kv.hget('newsletter:emails', key); } catch {}
    if (existing) return res.status(200).json({ ok: true, already: true });

    // IP-loft: max 3 tilmeldinger pr. IP pr. døgn. Dato-stemplet nøgle udløber
    // af sig selv, og expire kaldes hver gang, så en tabt TTL aldrig kan
    // efterlade et permanent loft.
    const ip = clientIp(req);
    const day = dayStamp();
    let sigIp = 0;
    try {
      sigIp = await kv.incr(`newsletter:sig:${ip}:${day}`);
      await kv.expire(`newsletter:sig:${ip}:${day}`, DAYSEC + 3600);
    } catch {}

    // Global nødbremse: organisk 1-5/dag. Over 25/time = distribueret angreb.
    const hour = hourStamp();
    let sigAll = 0;
    try {
      sigAll = await kv.incr(`newsletter:sigg:${hour}`);
      await kv.expire(`newsletter:sigg:${hour}`, 7200);
    } catch {}

    // Throttlet: svar som en normal tilmelding (bots lærer intet), men gem
    // INTET og send ingen mail. 'stored' udelades, så frontenden ikke
    // markerer brugeren som tilmeldt — de kan prøve igen senere.
    if (sigIp > MAX_SIGNUPS_PER_IP_DAY || sigAll > MAX_SIGNUPS_PER_HOUR) {
      console.warn('newsletter: signup throttled', { ip, sigIp, sigAll });
      return res.status(200).json({ ok: true, pending: true });
    }

    // Én bekræftelses-mail ad gangen pr. adresse: atomisk NX-lås. Vinder den
    // ikke låsen, er der allerede sendt en mail (eller en anden request er i
    // gang) — så gen-sender vi ikke. Dette lukker både spam-race og resend.
    let gotLock = null;
    try { gotLock = await kv.set(`newsletter:pendingkey:${key}`, '1', { nx: true, ex: PENDING_RESEND_TTL }); } catch {}
    if (gotLock !== 'OK') return res.status(200).json({ ok: true, pending: true, again: true });

    // Dobbelt opt-in: gem AFVENTENDE tilmelding + send bekræftelseslink.
    // Koden udstedes først ved bekræftelse.
    const token = randomBytes(24).toString('base64url');
    try {
      await kv.set(`newsletter:pending:${token}`, { email, key, lang, ip, t: Date.now() }, { ex: PENDING_TTL });
    } catch (e) {
      try { await kv.del(`newsletter:pendingkey:${key}`); } catch {}
      console.error('newsletter pending store failed:', e.message);
      return res.status(500).json({ ok: false, error: 'Kunne ikke gemme tilmeldingen. Prøv igen.' });
    }

    // Send mailen FØR låsen bliver permanent. Fejler afsendelsen, frigives
    // både token og lås, så en rigtig kunde kan prøve igen med det samme.
    try {
      await sendConfirmEmail(email, token, lang);
    } catch (e) {
      try { await kv.del(`newsletter:pending:${token}`, `newsletter:pendingkey:${key}`); } catch {}
      console.error('confirm email failed:', e.message);
      return res.status(500).json({ ok: false, error: 'Kunne ikke sende bekræftelsen. Prøv igen om lidt.' });
    }

    // Lad låsen pege på det aktive token (til info) resten af vinduet.
    try { await kv.set(`newsletter:pendingkey:${key}`, token, { ex: PENDING_RESEND_TTL }); } catch {}

    return res.status(200).json({ ok: true, pending: true, stored: true });
  } catch (e) {
    console.error('newsletter error:', e);

    return res.status(500).json({ ok: false, error: 'Noget gik galt. Prøv igen.' });
  }
}

// ── BEKRÆFTELSE ──────────────────────────────────────────────────────────────
function cleanToken(t) {
  return String(t || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function nlPage(lang, title, bodyHtml) {
  const en = lang === 'en';
  return `<!DOCTYPE html><html lang="${en ? 'en' : 'da'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtmlNl(title)} · Quartz Mølle</title>
<style>
  body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#faf7f2;color:#1a1611;
       min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.6}
  .card{background:#fff;border:1px solid #e7e1d6;border-radius:18px;box-shadow:0 4px 18px rgba(39,48,113,.10);
        padding:34px 28px;max-width:420px;width:100%;text-align:center}
  .card img{width:64px;height:64px;border-radius:50%;margin-bottom:14px}
  h1{font-size:20px;color:#273071;margin:0 0 10px}
  p{margin:0 0 12px;color:#4a463f;font-size:14.5px}
  .code{background:#fff;border:2px dashed #3a4599;border-radius:14px;padding:16px;margin:16px 0 6px}
  .code b{font-size:26px;font-weight:800;letter-spacing:2px;color:#273071}
  button,a.btn{display:inline-block;background:#273071;color:#fff;border:0;cursor:pointer;text-decoration:none;
        font-family:inherit;font-weight:600;font-size:15px;padding:13px 30px;border-radius:10px;margin-top:8px}
  .sub{font-size:12px;color:#9b9488;margin-top:16px}
</style></head><body><div class="card">
<img src="${SITE}/images/qm-icon-192.png" alt="" onerror="this.style.display='none'">
${bodyHtml}
<div class="sub">Quartz Mølle · Suså Landevej 101, 4160 Herlufmagle</div>
</div></body></html>`;
}

function sendHtml(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(html);
}

// GET-siden bekræfter IKKE i sig selv — mail-scannere (fx Outlook SafeLinks)
// følger links automatisk, men indsender ikke formularer. Selve bekræftelsen
// sker først ved trykket på knappen (POST).
async function handleConfirmPage(req, res, q) {
  const t = cleanToken(q.t);
  let pending = null;
  if (t) { try { pending = await kv.get(`newsletter:pending:${t}`); } catch {} }
  const lang = pending && pending.lang === 'en' ? 'en' : 'da';
  const en = lang === 'en';
  if (!pending) {
    return sendHtml(res, 410, nlPage(lang, en ? 'Link expired' : 'Linket er udløbet',
      en ? '<h1>This link has expired</h1><p>The confirmation link is no longer valid. Sign up again at quartzmolle.dk to get a new one.</p><a class="btn" href="' + SITE + '">Back to quartzmolle.dk</a>'
         : '<h1>Linket er udløbet</h1><p>Bekræftelseslinket gælder ikke længere. Tilmeld dig igen på quartzmolle.dk, så sender vi et nyt.</p><a class="btn" href="' + SITE + '">Tilbage til quartzmolle.dk</a>'));
  }
  return sendHtml(res, 200, nlPage(lang, en ? 'Confirm your signup' : 'Bekræft din tilmelding',
    (en ? '<h1>Confirm your signup</h1><p>Press the button to confirm <strong>' + escapeHtmlNl(pending.email) + '</strong> — then your personal 10% discount code is on its way.</p>'
        : '<h1>Bekræft din tilmelding</h1><p>Tryk på knappen for at bekræfte <strong>' + escapeHtmlNl(pending.email) + '</strong> — så er din personlige 10%-rabatkode på vej.</p>')
    + '<form method="POST" action="/api/log-visit">'
    + '<input type="hidden" name="action" value="nlconfirm">'
    + '<input type="hidden" name="t" value="' + escapeHtmlNl(t) + '">'
    + '<button type="submit">' + (en ? 'Confirm signup' : 'Bekræft tilmelding') + '</button></form>'));
}

async function handleNewsletterConfirm(req, res, body) {
  try {
    const t = cleanToken(body.t);
    // Kig FØRST på tokenet uden at slette (vi skal bruge sprog/adresse til
    // svarsiden og allerede-tilmeldt-tjekket).
    let peek = null;
    if (t) { try { peek = await kv.get(`newsletter:pending:${t}`); } catch {} }
    if (!peek) {
      return sendHtml(res, 410, nlPage('da', 'Linket er udløbet',
        '<h1>Linket er udløbet</h1><p>Bekræftelsen gælder ikke længere — eller er allerede gennemført. Tilmeld dig igen på quartzmolle.dk, hvis du ikke har fået din kode.</p><a class="btn" href="' + SITE + '">Tilbage til quartzmolle.dk</a>'));
    }
    const lang = peek.lang === 'en' ? 'en' : 'da';
    const en = lang === 'en';

    // Idempotent: allerede bekræftet -> ryd op og sig pænt til.
    let existing = null;
    try { existing = await kv.hget('newsletter:emails', peek.key); } catch {}
    if (existing) {
      try { await kv.del(`newsletter:pending:${t}`, `newsletter:pendingkey:${peek.key}`); } catch {}
      return sendHtml(res, 200, nlPage(lang, en ? 'Already subscribed' : 'Allerede tilmeldt',
        en ? '<h1>You are already subscribed</h1><p>Your signup was already confirmed — check your inbox for your discount code.</p><a class="btn" href="' + SITE + '/shop">Shop our flour</a>'
           : '<h1>Du er allerede tilmeldt</h1><p>Din tilmelding er allerede bekræftet — tjek din indbakke for din rabatkode.</p><a class="btn" href="' + SITE + '/shop">Se vores mel</a>'));
    }

    // ATOMISK CLAIM: hent-og-slet tokenet. Ved dobbeltklik/race faar KUN ét
    // kald pending tilbage — resten faar null og afvises. Så ét token kan
    // aldrig minte to koder.
    let pending = null;
    try { pending = await kv.getdel(`newsletter:pending:${t}`); } catch {}
    if (!pending) {
      return sendHtml(res, 200, nlPage(lang, en ? 'Signup confirmed' : 'Tilmelding bekræftet',
        (en ? '<h1>Thank you — you are subscribed</h1><p>Your signup is confirmed. Check your inbox for your discount code.</p>'
            : '<h1>Tak — du er tilmeldt</h1><p>Din tilmelding er bekræftet. Tjek din indbakke for din rabatkode.</p>')
        + '<a class="btn" href="' + SITE + '/shop">' + (en ? 'Shop our flour' : 'Se vores mel') + '</a>'));
    }
    // Resend-låsen frigives — tokenet er nu forbrugt.
    try { await kv.del(`newsletter:pendingkey:${pending.key}`); } catch {}

    // GLOBALT dagligt kode-loft: organisk udstedes ~5-20 koder/dag. Rammer vi
    // loftet, er det et angreb — brugeren tilmeldes stadig, men uden kode.
    // Fail CLOSED: kan tælleren ikke laeses, udsteder vi ikke (beskyt budget).
    const day = dayStamp();
    let minted = null, allowCode = true;
    try {
      minted = await kv.incr(`newsletter:mintday:${day}`);
      await kv.expire(`newsletter:mintday:${day}`, DAYSEC + 3600);
      allowCode = minted <= MAX_CODES_PER_DAY;
    } catch (e) { allowCode = false; console.error('mint counter failed — failing closed', e && e.message); }

    let code = null;
    if (allowCode) {
      try { code = await createUniqueDiscountCode(); } catch (e) { console.error('unique code failed:', (e && e.raw && e.raw.message) || (e && e.message)); }
    } else {
      console.warn('newsletter: global daily code cap reached, no code minted', { day, minted });
    }

    try {
      await kv.hset('newsletter:emails', { [pending.key]: {
        t: Date.now(), code, email: pending.email, ip: pending.ip, cip: clientIp(req),
      } });
    } catch (e) {
      console.error('newsletter store failed:', e.message);
      return sendHtml(res, 500, nlPage(lang, en ? 'Something went wrong' : 'Noget gik galt',
        en ? '<h1>Something went wrong</h1><p>Please try the link again in a moment.</p>'
           : '<h1>Noget gik galt</h1><p>Prøv linket igen om et øjeblik.</p>'));
    }

    try { await sendWelcomeEmail(pending.email, code, lang); } catch (e) { console.error('welcome email failed:', e.message); }

    const codeHtml = code
      ? '<div class="code"><b>' + escapeHtmlNl(code) + '</b></div><p>'
        + (en ? 'Your personal code — 10% off your next order. We have also emailed it to you.'
              : 'Din personlige kode — 10% på din næste ordre. Vi har også sendt den på mail.') + '</p>'
      : '<p>' + (en ? 'Welcome! You are now subscribed.' : 'Velkommen! Du er nu tilmeldt.') + '</p>';
    return sendHtml(res, 200, nlPage(lang, en ? 'Signup confirmed' : 'Tilmelding bekræftet',
      (en ? '<h1>Thank you — you are subscribed</h1>' : '<h1>Tak — du er tilmeldt</h1>')
      + codeHtml
      + '<a class="btn" href="' + SITE + '/shop">' + (en ? 'Shop our flour' : 'Se vores mel') + '</a>'));
  } catch (e) {
    console.error('newsletter confirm error:', e);
    return sendHtml(res, 500, nlPage('da', 'Noget gik galt',
      '<h1>Noget gik galt</h1><p>Prøv linket igen om et øjeblik.</p>'));
  }
}

async function sendConfirmEmail(email, token, lang) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const en = lang === 'en';
  const url = `${SITE}/api/log-visit?action=nlconfirm&t=${token}`;
  const T = en ? {
    subject: 'Confirm your signup — then your 10% code is on its way 🌾',
    heading: 'Confirm your signup',
    text: 'Press the button to confirm your subscription to Quartz Mølle\u2019s newsletter. Your personal 10% discount code arrives right after.',
    btn: 'Confirm signup',
    ignore: 'If you did not sign up at quartzmolle.dk, just ignore this email — nothing happens without your confirmation.',
  } : {
    subject: 'Bekræft din tilmelding — så er din 10%-kode på vej 🌾',
    heading: 'Bekræft din tilmelding',
    text: 'Tryk på knappen for at bekræfte din tilmelding til Quartz Mølles nyhedsbrev. Din personlige 10%-rabatkode kommer straks efter.',
    btn: 'Bekræft tilmelding',
    ignore: 'Har du ikke tilmeldt dig på quartzmolle.dk, kan du bare ignorere denne mail — der sker ingenting uden din bekræftelse.',
  };
  const html = `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:30px 24px;background:#faf7f2;border-radius:16px;color:#1a1611;">
    <div style="text-align:center;margin-bottom:18px;">
      <img src="${SITE}/images/qm-icon-192.png" alt="Quartz Mølle" width="64" height="64" style="border-radius:50%;">
    </div>
    <h2 style="color:#273071;text-align:center;margin:0 0 8px;">${T.heading}</h2>
    <p style="text-align:center;margin:0 0 22px;color:#4a463f;">${T.text}</p>
    <div style="text-align:center;margin-bottom:26px;">
      <a href="${url}" style="background:#273071;color:#fff;text-decoration:none;font-weight:600;padding:14px 32px;border-radius:10px;display:inline-block;">${T.btn}</a>
    </div>
    <p style="font-size:11.5px;color:#9b9488;text-align:center;line-height:1.6;margin:0;">
      ${T.ignore}<br>
      Quartz Mølle · Suså Landevej 101, 4160 Herlufmagle · CVR 42117188
    </p>
  </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from: 'Quartz Mølle <order@quartzmolle.dk>', to: [email], subject: T.subject, html }),
  });
  if (!r.ok) throw new Error('Resend ' + r.status);
}

// One shared 10% coupon (created once, id cached in Redis) + a fresh promotion
// code per subscriber, limited to a SINGLE redemption — so every email gets its
// own personal code that stops working after one order.
async function getSharedCouponId(stripe) {
  let id = null;
  try { id = await kv.get('newsletter:couponId'); } catch {}
  if (id) {
    try { await stripe.coupons.retrieve(id); return id; } catch { /* deleted — recreate */ }
  }
  const coupon = await stripe.coupons.create({
    percent_off: 10, duration: 'once', name: 'Nyhedsbrev – 10% velkomstrabat',
  });
  try { await kv.set('newsletter:couponId', coupon.id); } catch {}
  return coupon.id;
}

function randomCode() {
  // No 0/O/1/I — codes are easy to read and type. Format: QM10-XXXXXX
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[randomInt(chars.length)];
  return 'QM10' + s;
}

async function createUniqueDiscountCode() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);
  const couponId = await getSharedCouponId(stripe);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode();
    try {
      await stripe.promotionCodes.create({ coupon: couponId, code, max_redemptions: 1 });
      return code;
    } catch (e) {
      if (e && e.code === 'resource_already_exists') continue; // collision — retry
      throw e;
    }
  }
  return null;
}

async function sendWelcomeEmail(email, code, lang) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const en = lang === 'en';
  const T = en ? {
    heading: 'Thank you for subscribing',
    welcome: "Welcome to Quartz Mølle's newsletter.",
    first: "You'll be among the first to hear about <strong>new flour varieties</strong>, news from the mill, recipes and the season's grain.",
    codeLabel: 'Your personal discount code – 10% off your next order',
    codeHow: 'Enter the code in the "Add promotion code" field at checkout. The code is personal and can be used once.',
    cta: 'Shop our flour',
    footer1: 'You are receiving this email because you signed up at quartzmolle.dk.',
    footer2: 'To unsubscribe, reply to this email with "Unsubscribe".',
    subjectCode: 'Welcome! Your personal discount code: 10% off your next order 🌾',
    subjectNoCode: "Welcome to Quartz Mølle's newsletter 🌾",
  } : {
    heading: 'Tak for din tilmelding',
    welcome: 'Velkommen til Quartz Mølles nyhedsbrev.',
    first: 'Du bliver blandt de første til at høre om <strong>nye melvarianter</strong>, nyheder fra møllen, opskrifter og sæsonens korn.',
    codeLabel: 'Din personlige rabatkode – 10% på din næste ordre',
    codeHow: 'Indtast koden i feltet "Tilføj rabatkode" ved betalingen. Koden er personlig og kan bruges én gang.',
    cta: 'Se vores mel',
    footer1: 'Du modtager denne mail, fordi du tilmeldte dig på quartzmolle.dk.',
    footer2: 'Ønsker du at afmelde, så svar på denne mail med "Afmeld".',
    subjectCode: 'Velkommen! Din personlige rabatkode: 10% på din næste ordre 🌾',
    subjectNoCode: 'Velkommen til Quartz Mølles nyhedsbrev 🌾',
  };
  const codeBlock = code ? `
    <div style="background:#fff;border:2px dashed #3a4599;border-radius:14px;padding:20px;text-align:center;margin:0 0 8px;">
      <div style="font-size:13px;color:#6b6256;margin-bottom:6px;">${T.codeLabel}</div>
      <div style="font-size:28px;font-weight:800;letter-spacing:2px;color:#273071;">${code}</div>
    </div>
    <p style="text-align:center;font-size:13px;color:#6b6256;margin:0 0 22px;">${T.codeHow}</p>` : '';
  const html = `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:30px 24px;background:#faf7f2;border-radius:16px;color:#1a1611;">
    <div style="text-align:center;margin-bottom:18px;">
      <img src="https://www.quartzmolle.dk/images/qm-icon-192.png" alt="Quartz Mølle" width="64" height="64" style="border-radius:50%;">
    </div>
    <h2 style="color:#273071;text-align:center;margin:0 0 8px;">${T.heading}</h2>
    <p style="text-align:center;margin:0 0 6px;color:#4a463f;">${T.welcome}</p>
    <p style="text-align:center;margin:0 0 20px;color:#4a463f;">${T.first}</p>
    ${codeBlock}
    <div style="text-align:center;margin-bottom:26px;">
      <a href="https://www.quartzmolle.dk/shop" style="background:#273071;color:#fff;text-decoration:none;font-weight:600;padding:13px 30px;border-radius:10px;display:inline-block;">${T.cta}</a>
    </div>
    <p style="font-size:11.5px;color:#9b9488;text-align:center;line-height:1.6;margin:0;">
      ${T.footer1}<br>
      ${T.footer2}<br>
      Quartz Mølle · Suså Landevej 101, 4160 Herlufmagle · CVR 42117188
    </p>
  </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'Quartz Mølle <order@quartzmolle.dk>',
      to: [email],
      subject: code ? T.subjectCode : T.subjectNoCode,
      html,
    }),
  });
  if (!r.ok) throw new Error('Resend ' + r.status);
}
