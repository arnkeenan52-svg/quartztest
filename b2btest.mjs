// End-to-end test af erhvervsportalens backend — rigtig Redis, mock'et Resend
process.env.LOCKER_REDIS_REDIS_URL = 'redis://127.0.0.1:6390';
process.env.RESEND_API_KEY = 'test_key';
process.env.LOCKER_SESSION_SECRET = 'testsecret123';
delete process.env.VAPID_PRIVATE_KEY;

import { createHmac } from 'crypto';

const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    mails.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ id: 'mock' }) };
  }
  return realFetch(url, opts);
};

const { default: handler } = await import('./api/b2b.js');
const { kv } = await import('./api/_kv.js');

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: null, jsonBody: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = c => { res.statusCode = c; return res; };
  res.json = o => { res.jsonBody = o; return res; };
  res.end = () => res;
  return res;
}
async function call(body, { cookie = '', ip = '10.0.0.1' } = {}) {
  const res = makeRes();
  await handler({ method: 'POST', headers: { cookie, 'x-real-ip': ip }, body }, res);
  return res;
}
const adminCookie = (() => {
  const data = String(Date.now() + 3600000);
  return 'lk_sess=' + data + '.' + createHmac('sha256', 'testsecret123').update(data).digest('hex');
})();

const out = []; const ok = (n, c) => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}`);
const codeFromMail = m => (m.subject.match(/(\d{6})/) || [])[1];

// ryd op
await kv.del('b2b:customers', 'b2b:orders', 'b2b:orderno', 'b2b:prices');

// 1) ukendt e-mail -> pænt ok, INGEN mail (ingen kunde-aflæsning)
let r = await call({ action: 'reqcode', email: 'fremmed@x.dk' });
ok('ukendt mail: ok uden mail', r.jsonBody?.ok === true && mails.length === 0);

// 2) admin uden login afvises
r = await call({ action: 'admcustomers' });
ok('admin uden cookie -> 401', r.statusCode === 401);
r = await call({ action: 'admcustomers' }, { cookie: 'lk_sess=123.deadbeef' });
ok('admin med falsk cookie -> 401', r.statusCode === 401);

// 3) admin opretter kunde
r = await call({ action: 'admaddcustomer', name: 'Megans Surdej', email: 'megan@surdej.dk', cvr: '46218175', phone: '+45 4272 2746' }, { cookie: adminCookie });
ok('kunde oprettet + invitation sendt', r.jsonBody?.ok === true && r.jsonBody?.invited === true && mails.length === 1 && /Velkommen/.test(mails[0].subject));
ok('invitationen linker til /erhverv', /quartzmolle\.dk\/erhverv/.test(mails[0].html));
r = await call({ action: 'admaddcustomer', name: 'Megans Surdej', email: 'megan@surdej.dk', contact: 'Megan' }, { cookie: adminCookie });
ok('opdatering af kunde sender IKKE ny invitation', r.jsonBody?.invited === false && mails.length === 1);
mails.length = 0;
r = await call({ action: 'admcustomers' }, { cookie: adminCookie });
ok('kundeliste viser kunden', r.jsonBody?.customers?.length === 1 && r.jsonBody.customers[0].name === 'Megans Surdej');

// 4) login-kode sendes til kunden
r = await call({ action: 'reqcode', email: 'MEGAN@surdej.dk' });
ok('kode-mail sendt (case-insensitivt)', r.jsonBody?.ok === true && mails.length === 1);
const code1 = codeFromMail(mails[0]);
ok('mailen indeholder 6-cifret kode', !!code1);

// 5) forkert kode afvises; rigtig kode logger ind
r = await call({ action: 'verify', email: 'megan@surdej.dk', code: '000000' });
ok('forkert kode -> 400', r.statusCode === 400);
r = await call({ action: 'verify', email: 'megan@surdej.dk', code: code1 });
ok('rigtig kode -> ok + session-cookie', r.jsonBody?.ok === true && /b2b_sess=/.test(r.headers['set-cookie'] || ''));
const sessCookie = (r.headers['set-cookie'].match(/b2b_sess=([^;]+)/) || [])[0];

// 6) genbrugt kode virker IKKE (engangs)
r = await call({ action: 'verify', email: 'megan@surdej.dk', code: code1 });
ok('kode er engangs', r.statusCode === 400);

// 7) me -> stamdata + varer
r = await call({ action: 'me' }, { cookie: sessCookie });
ok('me: kundenavn + 22 varer', r.jsonBody?.customer?.name === 'Megans Surdej' && r.jsonBody?.products?.length === 22);
ok('priser er tomme fra start', r.jsonBody.products.every(p => p.price === null));

// 8) admin sætter priser
const priceKey = 'rug-fuldkorn|11 kg';
r = await call({ action: 'admsetprices', prices: { [priceKey]: 180, 'ugyldig|nøgle': 99, 'spelt-fuldkorn|12,5 kg': 260.5 } }, { cookie: adminCookie });
ok('priser gemt', r.jsonBody?.ok === true);
r = await call({ action: 'me' }, { cookie: sessCookie });
const rug = r.jsonBody.products.find(p => p.key === priceKey);
ok('kunden ser B2B-prisen', rug?.price === 180);
ok('ugyldig varenøgle blev ignoreret', !r.jsonBody.products.some(p => p.key === 'ugyldig|nøgle'));

// 9) bestilling — ugyldige linjer filtreres, priser låses server-side
mails.length = 0;
r = await call({ action: 'order', lines: [
  { key: priceKey, qty: 10 }, { key: 'spelt-fuldkorn|12,5 kg', qty: 4 },
  { key: 'hacker|1 kg', qty: 99 }, { key: priceKey, qty: 0 },
], note: 'Levering bagdøren', wishDate: '2026-08-28' }, { cookie: sessCookie });
ok('bestilling ok med nr. 1', r.jsonBody?.ok === true && r.jsonBody?.no === 1);
ok('mail til møllen + kvittering til kunden', mails.length === 2);
ok('møllens mail viser varer + kg', /Rug/.test(mails[0].html) && /Levering bagdøren/.test(mails[0].html));

// 10) tom bestilling afvises
r = await call({ action: 'order', lines: [{ key: 'hacker|1 kg', qty: 3 }] }, { cookie: sessCookie });
ok('kun ugyldige linjer -> 400', r.statusCode === 400);

// 11) mine bestillinger
r = await call({ action: 'myorders' }, { cookie: sessCookie });
ok('myorders: 1 ordre, status ny', r.jsonBody?.orders?.length === 1 && r.jsonBody.orders[0].status === 'ny');
ok('prisen blev låst ved bestilling', r.jsonBody.orders[0].lines.find(l => l.key === priceKey)?.price === 180);

// 12) admin godkender -> mail til kunden
mails.length = 0;
r = await call({ action: 'admlist' }, { cookie: adminCookie });
const oid = r.jsonBody.orders[0].id;
r = await call({ action: 'admsetstatus', id: oid, status: 'godkendt', msg: 'Leverer torsdag' }, { cookie: adminCookie });
ok('godkendt ok', r.jsonBody?.ok === true);
ok('bekræftelsesmail til kunden', mails.length === 1 && /bekræftet/i.test(mails[0].subject) && /torsdag/i.test(mails[0].html));
r = await call({ action: 'myorders' }, { cookie: sessCookie });
ok('kunden ser status godkendt + besked', r.jsonBody.orders[0].status === 'godkendt' && r.jsonBody.orders[0].statusMsg === 'Leverer torsdag');

// 13) ny ordre -> afvis med besked
mails.length = 0;
await call({ action: 'order', lines: [{ key: priceKey, qty: 2 }] }, { cookie: sessCookie });
r = await call({ action: 'admlist' }, { cookie: adminCookie });
const oid2 = r.jsonBody.orders.find(o => o.status === 'ny').id;
mails.length = 0;
r = await call({ action: 'admsetstatus', id: oid2, status: 'afvist', msg: 'Udsolgt i denne uge' }, { cookie: adminCookie });
ok('afvist ok + mail med besked', r.jsonBody?.ok === true && mails.length === 1 && /Udsolgt/.test(mails[0].html));

// 14) kode-loft: max 5 mails pr. e-mail pr. time
mails.length = 0;
for (let i = 0; i < 7; i++) await call({ action: 'reqcode', email: 'megan@surdej.dk' });
ok('max 5 kode-mails pr. time', mails.length <= 5);

// 15) slettet kunde kan ikke længere bruge sin session
r = await call({ action: 'admdelcustomer', email: 'megan@surdej.dk' }, { cookie: adminCookie });
ok('kunde slettet', r.jsonBody?.ok === true);
r = await call({ action: 'me' }, { cookie: sessCookie });
ok('session død efter sletning -> 401', r.statusCode === 401);

// 16) ukendt handling
r = await call({ action: 'hackepakke' }, { cookie: adminCookie });
ok('ukendt handling -> 400', r.statusCode === 400);

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - fails}/${out.length} PASS`);
process.exit(fails ? 1 : 0);
