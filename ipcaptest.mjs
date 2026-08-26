// Beviser: max 2 KODER pr. IP (den 3. tilmelding fra samme IP gemmes uden kode)
process.env.LOCKER_REDIS_REDIS_URL = 'redis://127.0.0.1:6390';
process.env.RESEND_API_KEY = 'test_key';
process.env.STRIPE_SECRET_KEY = ''; // ingen Stripe -> createUniqueDiscountCode giver null; vi tester counteren direkte
delete process.env.STRIPE_SECRET_KEY;

import { createHash } from 'crypto';
const sent = [];
const rf = globalThis.fetch;
globalThis.fetch = async (u, o) => { if (String(u).includes('api.resend.com')) { sent.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({}) }; } return rf(u, o); };
const { default: handler } = await import('./api/log-visit.js');
const { kv } = await import('./api/_kv.js');

function makeRes(){const r={statusCode:0,jsonBody:null,headers:{}};r.setHeader=(k,v)=>{r.headers[k.toLowerCase()]=v;return r;};r.status=c=>{r.statusCode=c;return r;};r.json=o=>{r.jsonBody=o;return r;};r.send=()=>r;r.end=()=>r;return r;}
async function call(body,ip){const res=makeRes();await handler({method:'POST',headers:{origin:'https://quartzmolle.dk','x-real-ip':ip},body},res);return res;}
function zeros(b){let n=0;for(const x of b){if(x===0){n+=8;continue;}let y=x;while((y&0x80)===0){n++;y<<=1;}break;}return n;}
function solve(ch){for(let i=0;i<5e6;i++){if(zeros(createHash('sha256').update(ch+':'+i).digest())>=15)return String(i);}}
async function pow(ip){const r=await call({action:'nlchallenge'},ip);const ch=r.jsonBody.ch,n=solve(ch);await kv.set('newsletter:pow:'+ch,{t:Date.now()-3000},{ex:900});return{ch,nonce:n};}

const out=[];const ok=(n,c)=>out.push(`${c?'PASS':'FAIL'}  ${n}`);
await kv.flushall?.();
const day=new Date().toISOString().slice(0,10);
await kv.del('newsletter:emails','newsletter:ipcount:77.0.0.1',`newsletter:mintday:${day}`,`newsletter:sigg:${new Date().toISOString().slice(0,13)}`);

// Simuler at der ALLEREDE er mintet 2 koder fra IP'en, og tjek at nr. 3 ikke får kode.
// (per-IP-tælleren er newsletter:ipcount:<ip>, grænse 2)
await kv.set('newsletter:ipcount:77.0.0.1', 2, { ex: 30*86400 });
// nulstil dags-tilmeldingsloft så det ikke rammer først
const r = await call({ action: 'newsletter', email: 'tredje@x.dk', ...(await pow('77.0.0.1')) }, '77.0.0.1');
const rec = await kv.hget('newsletter:emails', 'tredje@x.dk');
ok('3. kode fra samme IP: tilmeldt men UDEN kode', r.jsonBody?.stored === true && rec && rec.code === null);
const cnt = Number(await kv.get('newsletter:ipcount:77.0.0.1'));
ok(`IP-kode-tælleren står på ${cnt} (>2 = loft ramt)`, cnt > 2);

// og de to FØRSTE fra en frisk IP får kode (hvis Stripe var sat; her er code null pga ingen Stripe,
// men counteren skal stige til 1 og 2 og IKKE blokere)
await kv.del('newsletter:ipcount:88.0.0.1');
let c1 = await call({ action: 'newsletter', email: 'en@x.dk', ...(await pow('88.0.0.1')) }, '88.0.0.1');
let c2 = await call({ action: 'newsletter', email: 'to@x.dk', ...(await pow('88.0.0.1')) }, '88.0.0.1');
const after = Number(await kv.get('newsletter:ipcount:88.0.0.1'));
ok('de 2 første fra frisk IP tælles (=2, ikke blokeret)', c1.jsonBody?.stored && c2.jsonBody?.stored && after === 2);

console.log(out.join('\n'));
const f=out.filter(l=>l.startsWith('FAIL')).length;
console.log(`\n${out.length-f}/${out.length} PASS`);
process.exit(f?1:0);
