// End-to-end test af nyhedsbrevet med usynlig verifikation (proof-of-work)
// — rigtig Redis, mock'et Resend, ingen Stripe (koder bliver null).
process.env.LOCKER_REDIS_REDIS_URL = 'redis://127.0.0.1:6390';
process.env.RESEND_API_KEY = 'test_key';
delete process.env.STRIPE_SECRET_KEY;

import { createHash } from 'crypto';

const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    sentEmails.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ id: 'mock' }) };
  }
  return realFetch(url, opts);
};

const { default: handler } = await import('./api/log-visit.js');
const { kv } = await import('./api/_kv.js');

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: null, jsonBody: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = c => { res.statusCode = c; return res; };
  res.json = o => { res.jsonBody = o; res.body = JSON.stringify(o); return res; };
  res.send = h => { res.body = h; return res; };
  res.end = () => res;
  return res;
}
async function call({ method = 'POST', body = null, query = {}, ip = '10.0.0.1', origin = 'https://quartzmolle.dk' }) {
  const res = makeRes();
  await handler({ method, headers: { origin, 'x-real-ip': ip, 'user-agent': 'test' }, body, query }, res);
  return res;
}

// Løs en udfordring præcis som browseren: SHA-256(ch+':'+nonce) med >=15 nul-bits
function zeros(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    let b = byte;
    while ((b & 0x80) === 0) { bits++; b <<= 1; }
    break;
  }
  return bits;
}
function solve(ch, bits = 15) {
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    const h = createHash('sha256').update(ch + ':' + nonce).digest();
    if (zeros(h) >= bits) return String(nonce);
  }
  throw new Error('kunne ikke løse PoW');
}
// Hent udfordring + løs + tilbagedatér (så min-alder på 2 sek. er opfyldt)
async function freshPow(ip = '10.0.0.1') {
  const r = await call({ body: { action: 'nlchallenge' }, ip });
  const ch = r.jsonBody?.ch;
  const nonce = solve(ch, r.jsonBody?.bits || 15);
  await kv.set(`newsletter:pow:${ch}`, { t: Date.now() - 3000 }, { ex: 900 });
  return { ch, nonce };
}

const out = []; const ok = (n, c) => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}`);

// 0) ryd test-nøgler fra tidligere kørsler
const day = new Date().toISOString().slice(0, 10);
const hour = new Date().toISOString().slice(0, 13);
await kv.del('newsletter:emails', `newsletter:sigg:${hour}`, `newsletter:mintday:${day}`);

// 1) udfordring udstedes
let r = await call({ body: { action: 'nlchallenge' } });
ok('nlchallenge -> ok + ch + bits=15', r.jsonBody?.ok === true && !!r.jsonBody?.ch && r.jsonBody?.bits === 15);

// 2) tilmelding UDEN bevis -> 400 retry, ingen mail
r = await call({ body: { action: 'newsletter', email: 'nopow@example.dk' } });
ok('uden bevis -> 400 retry:true', r.statusCode === 400 && r.jsonBody?.retry === true);
ok('uden bevis -> ingen mail', sentEmails.length === 0);

// 3) for UNG udfordring (bot svarer på 0 sek.) -> 400 retry
{
  const cr = await call({ body: { action: 'nlchallenge' } });
  const nonce = solve(cr.jsonBody.ch);
  r = await call({ body: { action: 'newsletter', email: 'fastbot@example.dk', ch: cr.jsonBody.ch, nonce } });
  ok('for hurtigt svar (<2 sek.) -> 400 retry', r.statusCode === 400 && r.jsonBody?.retry === true);
}

// 4) gyldigt bevis -> tilmeldt med det samme + velkomstmail
let pow = await freshPow();
r = await call({ body: { action: 'newsletter', email: 'kunde1@example.dk', ...pow } });
ok('gyldigt bevis -> ok+stored', r.jsonBody?.ok === true && r.jsonBody?.stored === true);
ok('velkomstmail sendt med det samme', sentEmails.length === 1 && /Velkommen/i.test(sentEmails[0]?.subject || ''));
let rec = await kv.hget('newsletter:emails', 'kunde1@example.dk');
ok('abonnent gemt med ip', !!rec && rec.ip === '10.0.0.1');

// 5) GENBRUGT udfordring (engangsbevis) -> 400 retry, ingen mail
r = await call({ body: { action: 'newsletter', email: 'replay@example.dk', ...pow } });
ok('genbrugt bevis -> 400 retry', r.statusCode === 400 && r.jsonBody?.retry === true);
ok('genbrugt bevis -> ingen ekstra mail', sentEmails.length === 1);

// 6) forkert nonce (ikke nok nul-bits) -> 400
{
  const cr = await call({ body: { action: 'nlchallenge' } });
  await kv.set(`newsletter:pow:${cr.jsonBody.ch}`, { t: Date.now() - 3000 }, { ex: 900 });
  r = await call({ body: { action: 'newsletter', email: 'badnonce@example.dk', ch: cr.jsonBody.ch, nonce: 'ikke-et-svar' } });
  ok('forkert nonce -> 400 retry', r.statusCode === 400 && r.jsonBody?.retry === true);
}

// 7) honningkrukke -> pænt ok, INTET gemt/sendt (selv med gyldigt bevis)
pow = await freshPow();
r = await call({ body: { action: 'newsletter', email: 'bot@example.com', website: 'http://spam.ru', ...pow } });
ok('honningkrukke: svarer pænt ok', r.jsonBody?.ok === true && !r.jsonBody?.stored);
ok('honningkrukke: ingen mail', sentEmails.length === 1);
ok('honningkrukke: intet gemt', !(await kv.hget('newsletter:emails', 'bot@example.com')));

// 8) ugyldig e-mail -> 400
r = await call({ body: { action: 'newsletter', email: 'ikke-en-mail' } });
ok('ugyldig e-mail -> 400', r.statusCode === 400 && r.jsonBody?.ok === false);

// 9) allerede tilmeldt -> already (KRÆVER nu et gyldigt bevis: tjekket ligger
//    efter verifikationen, saa endpointet ikke kan bruges til at slaa fremmede
//    mailadresser op og se, om de er kunder)
r = await call({ body: { action: 'newsletter', email: 'kunde1@example.dk' } });
ok('allerede tilmeldt UDEN bevis -> afvist som alt andet', r.statusCode === 400 && r.jsonBody?.retry === true && sentEmails.length === 1);
pow = await freshPow();
r = await call({ body: { action: 'newsletter', email: 'kunde1@example.dk', ...pow } });
ok('allerede tilmeldt MED bevis -> already', r.jsonBody?.already === true && sentEmails.length === 1);

// 10) gmail-punktum-trick -> already (normaliseret adresse)
pow = await freshPow();
r = await call({ body: { action: 'newsletter', email: 'ku.nde.1@example.dk'.replace('example.dk', 'gmail.com'), ...pow } });
// først: tilmeld gmail-adressen rigtigt
ok('gmail-adresse tilmeldt', r.jsonBody?.stored === true);
pow = await freshPow();
r = await call({ body: { action: 'newsletter', email: 'kunde1+rabat@gmail.com', ...pow } });
ok('punktum/plus-trick -> already', r.jsonBody?.already === true);

// 11) IP-loft: max 3 tilmeldinger pr. IP pr. døgn — nr. 4 gemmes ikke
{
  const before = sentEmails.length;
  for (let i = 1; i <= 4; i++) {
    const p = await freshPow('10.0.0.9');
    await call({ body: { action: 'newsletter', email: `offer${i}@example.dk`, ...p }, ip: '10.0.0.9' });
  }
  ok('max 3 velkomstmails fra samme IP', sentEmails.length === before + 3);
  const rt = await call({ body: { action: 'newsletter', email: 'offer9@example.dk', ...(await freshPow('10.0.0.9')) }, ip: '10.0.0.9' });
  ok('throttlet svar uden stored-flag', rt.jsonBody?.ok === true && !rt.jsonBody?.stored);
}

// 12) global time-bremse: 25 tilmeldinger/time -> nr. 26 gemmes ikke
{
  await kv.set(`newsletter:sigg:${hour}`, 25, { ex: 7200 });
  const p = await freshPow('10.7.7.7');
  const before = sentEmails.length;
  r = await call({ body: { action: 'newsletter', email: 'global@example.dk', ...p }, ip: '10.7.7.7' });
  ok('global bremse: ok uden stored, ingen mail', r.jsonBody?.ok === true && !r.jsonBody?.stored && sentEmails.length === before);
  await kv.del(`newsletter:sigg:${hour}`);
}

// 13) globalt kode-loft (60/døgn): tilmeldes stadig, bare uden kode
{
  await kv.set(`newsletter:mintday:${day}`, 60, { ex: 90000 });
  const p = await freshPow('10.8.8.8');
  r = await call({ body: { action: 'newsletter', email: 'capday@example.dk', ...p }, ip: '10.8.8.8' });
  ok('kode-loft: stadig tilmeldt (stored)', r.jsonBody?.stored === true);
  const rr = await kv.hget('newsletter:emails', 'capday@example.dk');
  ok('kode-loft: gemt uden kode', !!rr && rr.code === null);
  await kv.del(`newsletter:mintday:${day}`);
}

// 14) udfordrings-loft: 30 pr. IP pr. døgn -> nr. 31 får 429
{
  await kv.set(`newsletter:powip:10.6.6.6:${day}`, 30, { ex: 90000 });
  r = await call({ body: { action: 'nlchallenge' }, ip: '10.6.6.6' });
  ok('udfordrings-loft -> 429', r.statusCode === 429);
}

// 15) race: to samtidige tilmeldinger af samme adresse -> én vinder, én mail
{
  const p1 = await freshPow('10.4.4.1');
  const p2 = await freshPow('10.4.4.2');
  const before = sentEmails.length;
  const [a, b] = await Promise.all([
    call({ body: { action: 'newsletter', email: 'race@example.dk', ...p1 }, ip: '10.4.4.1' }),
    call({ body: { action: 'newsletter', email: 'race@example.dk', ...p2 }, ip: '10.4.4.2' }),
  ]);
  const stored = [a, b].filter(x => x.jsonBody?.stored === true).length;
  ok('race: præcis én stored', stored === 1);
  ok('race: præcis én velkomstmail', sentEmails.length === before + 1);
}

// 16) LEGACY: gammelt bekræftelseslink fra indbakken virker stadig
{
  await kv.set('newsletter:pending:legacytoken123', { key: 'gammel@example.dk', email: 'gammel@example.dk', lang: 'da', ip: '10.1.1.1' }, { ex: 900 });
  const before = sentEmails.length;
  r = await call({ method: 'GET', query: { action: 'nlconfirm', t: 'legacytoken123' }, ip: '10.1.1.2' });
  ok('legacy-link bekræfter (200 + tilmeldt)', r.statusCode === 200 && /tilmeldt/i.test(r.body));
  ok('legacy-link -> velkomstmail', sentEmails.length === before + 1);
  r = await call({ method: 'GET', query: { action: 'nlconfirm', t: 'legacytoken123' } });
  ok('genbrugt legacy-link -> ingen dublet', sentEmails.length === before + 1);
}

// 17) ukendt token -> 410 udløbet-side
r = await call({ method: 'GET', query: { action: 'nlconfirm', t: 'x'.repeat(30) } });
ok('ukendt token -> 410', r.statusCode === 410);

// 18) alm. GET uden nlconfirm -> 405
r = await call({ method: 'GET' });
ok('alm. GET -> 405', r.statusCode === 405);

// 19) heartbeat + funnel virker stadig
r = await call({ body: {} });
ok('heartbeat ok', r.jsonBody?.ok === true);
r = await call({ body: { action: 'cart', id: 'abc123', count: 2, total: 400 } });
ok('kurve-funnel ok', r.jsonBody?.ok === true);
r = await call({ body: { action: 'checkoutstart', id: 'abc123', count: 2, total: 400 } });
ok('checkout-funnel ok', r.jsonBody?.ok === true);

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - fails}/${out.length} PASS${fails ? ` — ${fails} FEJL` : ''}`);
process.exit(fails ? 1 : 0);
