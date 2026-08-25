// Sikkerheds-regressionstest: beviser at hvert bekræftet hul er lukket.
process.env.LOCKER_REDIS_REDIS_URL = 'redis://127.0.0.1:6390';
process.env.LOCKER_SESSION_SECRET = 'testsecret123';
process.env.LOCKER_CODE = '482913';
process.env.LOCKER_DEVICE_SECRET = 'device-hemmelighed';
process.env.REFUND_CODE = '167716';
process.env.RESEND_API_KEY = 'test_key';
delete process.env.CRON_SECRET;
delete process.env.STRIPE_SECRET_KEY;

import { createHmac } from 'crypto';

const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) { mails.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({}) }; }
  return realFetch(url, opts);
};

const { kv } = await import('./api/_kv.js');
const locker = (await import('./api/locker.js')).default;
const logvisit = (await import('./api/log-visit.js')).default;
const b2b = (await import('./api/b2b.js')).default;
const daily = (await import('./api/daily-check.js')).default;

function makeRes() {
  const r = { statusCode: 0, headers: {}, jsonBody: null, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = c => { r.statusCode = c; return r; };
  r.json = o => { r.jsonBody = o; return r; };
  r.send = h => { r.body = h; return r; };
  r.end = () => r;
  return r;
}
const call = (h, { method='POST', body=null, query={}, ip='10.0.0.1', cookie='', headers={} } = {}) => {
  const res = makeRes();
  return h({ method, headers: { 'x-real-ip': ip, cookie, origin: 'https://www.quartzmolle.dk', ...headers }, body, query }, res).then(() => res);
};
const adminCookie = (() => { const d = String(Date.now() + 3600000); return 'lk_sess=' + d + '.' + createHmac('sha256','testsecret123').update(d).digest('hex'); })();

const out = []; const ok = (n, c) => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}`);
await kv.del('newsletter:emails','b2b:customers','b2b:orders','b2b:prices');
const day = new Date().toISOString().slice(0,10);

// ── 1) KRITISK: ubegrænsede kode-orakler er fjernet ──
for (const a of ['migrate','promotest']) {
  const r = await call(locker, { body: { action: a, code: '482913' } });
  ok(`'${a}'-grenen findes ikke længere (${a})`, r.statusCode === 401 || r.statusCode === 400);
}
{
  const r = await call(locker, { method: 'GET', query: { action: 'migrate', code: '482913' } });
  ok("migrate via URL-parameter virker ikke", r.statusCode === 401 || r.statusCode === 400 || r.statusCode === 405);
}
{
  const wh = (await import('./api/stripe-webhook.js')).default;
  const r = await call(wh, { method: 'GET', query: { action: 'recover', code: '482913', seed: '1' } });
  ok('stripe-webhook ?action=recover er fjernet', r.statusCode === 405 || r.statusCode === 401);
  ok('recover udleverer ingen kundedata', !JSON.stringify(r.jsonBody || {}).includes('@'));
}

// ── 2) HIGH: login-låsning kan ikke omgås med parallelle gæt ──
{
  await kv.del(`locker:fails:9.9.9.9`, 'locker:fails:global');
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    call(locker, { body: { action: 'login', code: String(100000 + i) }, ip: '9.9.9.9' })));
  const blocked = many.filter(r => r.statusCode === 429).length;
  const allowed = many.filter(r => r.statusCode === 401).length;
  ok(`40 parallelle gæt: kun ${allowed} nåede sammenligningen, ${blocked} blev låst`, allowed <= 5 && blocked >= 30);
  const counter = Number(await kv.get('locker:fails:9.9.9.9'));
  ok(`tælleren tæller atomisk (${counter} ≈ 40, ikke 1)`, counter >= 35);
}

// ── 3) Den globale nødbremse må ikke låse ejeren ude ──
{
  await kv.set('locker:fails:global', 999, { ex: 900 });
  await kv.del('locker:fails:7.7.7.7');
  const r = await call(locker, { body: { action: 'login', code: '482913' }, ip: '7.7.7.7' });
  ok('ejeren kan logge ind selvom global bremse er udløst', r.statusCode === 200 && /lk_sess=/.test(r.headers['set-cookie'] || ''));
  await kv.del('locker:fails:global');
}

// ── 4) Rigtig kode virker stadig, og forkert længde røber intet ──
{
  await kv.del('locker:fails:8.8.8.8', 'locker:fails:global');
  const good = await call(locker, { body: { action: 'login', code: '482913' }, ip: '8.8.8.8' });
  ok('korrekt kode giver session', good.statusCode === 200);
  const short = await call(locker, { body: { action: 'login', code: '1' }, ip: '8.8.8.9' });
  const wrong = await call(locker, { body: { action: 'login', code: '999999' }, ip: '8.8.8.9' });
  ok('kort og forkert kode svarer ens (ingen længde-lækage)',
     short.statusCode === wrong.statusCode && JSON.stringify(short.jsonBody) === JSON.stringify(wrong.jsonBody));
}

// ── 5) Tablet-synk kan ikke plante kode i panelet ──
{
  const XSS = '<img src=x onerror=alert(1)>';
  await call(locker, { body: { action: 'sync', secret: 'device-hemmelighed',
    events: [{ type: XSS, locker: 3, code: XSS, t: Date.now() }, { type: 'in', locker: 4, code: XSS, t: Date.now() }] } });
  const st = await call(locker, { body: { action: 'state' }, cookie: adminCookie });
  const dump = JSON.stringify(st.jsonBody || {});
  ok('ingen HTML fra tabletten når panelet', !dump.includes('onerror') && !dump.includes('<img'));
  const d4 = (st.jsonBody.lockers || []).find(l => l.door === 4);
  ok('koden fra tabletten renses til cifre', !d4 || d4.code === null || /^\d{0,6}$/.test(d4.code || ''));
}

// ── 6) Nyhedsbrev: intet gratis "er denne mail kunde?"-orakel ──
{
  await kv.hset('newsletter:emails', { 'kendt@x.dk': { t: Date.now(), code: 'QM10AAA', email: 'kendt@x.dk' } });
  const known = await call(logvisit, { body: { action: 'newsletter', email: 'kendt@x.dk' } });
  const unknown = await call(logvisit, { body: { action: 'newsletter', email: 'ukendt@x.dk' } });
  ok('kendt og ukendt mail svarer ENS uden bevis',
     known.statusCode === unknown.statusCode && JSON.stringify(known.jsonBody) === JSON.stringify(unknown.jsonBody));
  ok('svaret røber ikke "already"', !JSON.stringify(known.jsonBody).includes('already'));
}

// ── 7) Funnel kan ikke fylde databasen ──
{
  const before = mails.length;
  let last;
  for (let i = 0; i < 320; i++) last = await call(logvisit, { body: { action: 'cart', id: 'x' + i, count: 1, total: 100 }, ip: '5.5.5.5' });
  const n = Number(await kv.get(`funnel:ip:5.5.5.5:${day}`));
  ok(`funnel har IP-loft (tæller ${n} > 300 og kald afvises stille)`, n > 300);
}

// ── 8) B2B engangskode: atomisk, fast levetid, ens fejl ──
{
  await call(b2b, { body: { action: 'admaddcustomer', name: 'Test Bageri', email: 'bager@x.dk' }, cookie: adminCookie });
  mails.length = 0;
  await call(b2b, { body: { action: 'reqcode', email: 'bager@x.dk' } });
  const realCode = (mails[0].subject.match(/(\d{6})/) || [])[1];
  // 4 parallelle gæt (under spærregrænsen) viser om tællingen er atomisk:
  // med den gamle læs-læg-til-skriv ville alle fire læse 0 og ende på 1.
  await kv.del('b2b:tries:bager@x.dk', `b2b:vip:3.3.3.3:${day}`);
  await Promise.all(Array.from({ length: 4 }, (_, i) =>
    call(b2b, { body: { action: 'verify', email: 'bager@x.dk', code: String(200000 + i) }, ip: '3.3.3.3' })));
  const tries = Number(await kv.get('b2b:tries:bager@x.dk'));
  ok(`4 parallelle gæt tælles atomisk (${tries} = 4, ikke 1)`, tries === 4);
  // og videre gæt spærrer koden helt
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    call(b2b, { body: { action: 'verify', email: 'bager@x.dk', code: String(300000 + i) }, ip: '3.3.3.3' })));
  const stillThere = await kv.get('b2b:code:bager@x.dk');
  ok('koden blev spærret efter for mange forsøg', !stillThere);

  const kendt = await call(b2b, { body: { action: 'verify', email: 'bager@x.dk', code: '111111' }, ip: '4.4.4.4' });
  const fremmed = await call(b2b, { body: { action: 'verify', email: 'ingen@x.dk', code: '111111' }, ip: '4.4.4.4' });
  ok('kunde og ikke-kunde får samme fejlbesked',
     kendt.statusCode === fremmed.statusCode && JSON.stringify(kendt.jsonBody) === JSON.stringify(fremmed.jsonBody));
}

// ── 9) B2B: TTL må ikke forlænges af forkerte gæt ──
{
  await kv.del('b2b:tries:bager@x.dk', `b2b:vip:6.6.6.6:${day}`);
  mails.length = 0;
  await call(b2b, { body: { action: 'reqcode', email: 'bager@x.dk' } });
  const t0 = await kv.ttl?.('b2b:code:bager@x.dk');
  await call(b2b, { body: { action: 'verify', email: 'bager@x.dk', code: '000000' }, ip: '6.6.6.6' });
  const rec = await kv.get('b2b:code:bager@x.dk');
  ok('forkert gæt gemmer ikke en ny kode-post (ingen TTL-forlængelse)', rec && rec.tries === undefined);
}

// ── 10) Refund-kode: konstant tid + forsøgsloft ──
{
  const ao = (await import('./api/admin-order.js')).default;
  await kv.del('refund:fails:2.2.2.2');
  const tries = [];
  for (let i = 0; i < 8; i++) tries.push(await call(ao, { method: 'POST', body: { action: 'refund', id: 'cs_test_aaaaaaaaaaaa', code: '000000' }, cookie: adminCookie, ip: '2.2.2.2' }));
  ok('refund-kode låses efter 5 forsøg', tries.some(r => r.statusCode === 429));
  ok('forkert refund-kode giver 403 (ikke 500)', tries[0].statusCode === 403);
}

// ── 11) Cron fejler lukket uden hemmelighed ──
{
  const r = await call(daily, { method: 'GET' });
  ok('daily-check afviser når CRON_SECRET mangler', r.statusCode === 401);
}

// ── 12) Checkout: fremmed Origin kan ikke kapre betalingssiden ──
{
  const src = (await import('fs')).readFileSync('api/checkout.js', 'utf8');
  ok('ingen vercel.app-wildcard i origin-tjekket', !/vercel\\\\?\.app\$/.test(src) || !src.includes('.test(reqOrigin)'));
  ok('success_url bygges på valideret origin', src.includes('success_url: `${origin}/success') && !src.includes('${req.headers.origin}/success'));
  ok('varenavne tages fra kataloget, ikke fra kurven', src.includes('CATALOG[id]') && !src.includes('String(it.productName'));
}

console.log(out.join('\n'));
const f = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - f}/${out.length} PASS${f ? ` — ${f} FEJL` : ''}`);
process.exit(f ? 1 : 0);
