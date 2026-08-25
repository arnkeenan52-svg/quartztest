// Reproducerer hændelsen: en stor bunke gamle ordrer der aldrig er markeret
// "mindet om" — og beviser at den nye kode ikke længere sender til dem alle.
process.env.LOCKER_REDIS_REDIS_URL = 'redis://127.0.0.1:6390';
process.env.RESEND_API_KEY = 'test_key';
process.env.CRON_SECRET = 'test-cron-hemmelighed';

const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) { mails.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({}) }; }
  return realFetch(url, opts);
};
const { kv } = await import('./api/_kv.js');
const daily = (await import('./api/daily-check.js')).default;

function makeRes(){const r={statusCode:0,jsonBody:null};r.setHeader=()=>r;r.status=c=>{r.statusCode=c;return r;};r.json=o=>{r.jsonBody=o;return r;};r.end=()=>r;return r;}
const run = async () => { const res = makeRes(); await daily({ method:'GET', headers:{ authorization:'Bearer test-cron-hemmelighed' }, query:{} }, res); return res; };

const out=[]; const ok=(n,c)=>out.push(`${c?'PASS':'FAIL'}  ${n}`);
const DAY = 86400000, now = Date.now();

await kv.del('pickup:orders','pickup:fulfilled','locker:state', `dailycheck:${new Date().toISOString().slice(0,10)}`);

// 50 gamle ordrer, præcis som i virkeligheden: stadig på listen, aldrig mindet om,
// koderne for længst ude af skabet (kunderne HAR hentet dem).
const orders = [];
const fulfilled = {};
for (let i = 0; i < 50; i++) {
  const ref = 'GAMMEL' + i;
  orders.push({ ref, name: 'Kunde ' + i, email: `k${i}@x.dk`, createdAt: now - (60 + i) * DAY, items: [] });
  fulfilled[ref] = { doors: [1], slots: [{ door: 1, code: String(100000 + i) }], email: `k${i}@x.dk`, sentAt: now - (55 + i) * DAY };
}
// én ÆGTE uafhentet ordre: kode ligger stadig i skab 7, sendt for 4 dage siden
orders.push({ ref: 'AEGTE1', name: 'Venter', email: 'venter@x.dk', createdAt: now - 5 * DAY, items: [] });
fulfilled['AEGTE1'] = { doors: [7], slots: [{ door: 7, code: '654321' }], email: 'venter@x.dk', sentAt: now - 4 * DAY };

for (const o of orders) await kv.rpush('pickup:orders', o);
await kv.hset('pickup:fulfilled', fulfilled);
await kv.set('locker:state', { lockers: [{ door: 7, occ: true, code: '654321', since: now - 4*DAY }], updated: now });

const r = await run();
ok('jobbet kørte', r.statusCode === 200);
const reminders = mails.filter(m => /Husk din ordre/.test(m.subject));
ok(`kun ÉN påmindelse sendt (før: 51) — sendte ${reminders.length}`, reminders.length === 1);
ok('den ene gik til den ægte uafhentede ordre', reminders[0] && reminders[0].to[0] === 'venter@x.dk');
ok('ingen af de 50 gamle kunder fik mail', !mails.some(m => /k\d+@x\.dk/.test(JSON.stringify(m.to))));

// kør igen samme dag -> ingenting
mails.length = 0;
const r2 = await run();
ok('samme dag igen: ingen mails', mails.length === 0 && r2.jsonBody?.skipped === 'already ran today');

// næste dag: den ægte er nu markeret mindet om -> stadig ingen påmindelse
await kv.del(`dailycheck:${new Date().toISOString().slice(0,10)}`);
mails.length = 0;
await run();
ok('kunden mindes kun ÉN gang', !mails.some(m => /Husk din ordre/.test(m.subject)));

// worst case: kan skabet ikke læses, sendes der INTET
await kv.del('locker:state', `dailycheck:${new Date().toISOString().slice(0,10)}`);
await kv.hset('pickup:fulfilled', { AEGTE2: { doors:[7], slots:[{door:7,code:'111222'}], email:'x@x.dk', sentAt: now - 4*DAY } });
await kv.rpush('pickup:orders', { ref:'AEGTE2', name:'X', email:'x@x.dk', createdAt: now-5*DAY, items:[] });
mails.length = 0;
await run();
ok('tomt skab = alt hentet: ingen påmindelser', !mails.some(m => /Husk din ordre/.test(m.subject)));

console.log(out.join('\n'));
const f = out.filter(l=>l.startsWith('FAIL')).length;
console.log(`\n${out.length-f}/${out.length} PASS`);
process.exit(f?1:0);
