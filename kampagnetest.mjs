// NYHED-kampagnen: faste Stripe-produkter for Blå hvede + kupon bundet til dem.
import { ensureKampagne, stripeProductId, productFields, KAMPAGNE, _resetKampagneCache } from './api/_kampagne.js';
import fs from 'node:fs';
const T=[]; const t=(n,c,x)=>T.push(`${c?'PASS':'FAIL'}  ${n}${x?'  ('+x+')':''}`);
const missing = () => Object.assign(new Error('No such'), { code: 'resource_missing', statusCode: 404 });

function fakeStripe({ exists = false, boom = false } = {}) {
  const calls = [];
  const rec = (n) => (...a) => { calls.push([n, a[0]]); };
  return { calls,
    products: { retrieve: async (id) => { calls.push(['products.retrieve', id]); if (boom) throw new Error('network'); if (!exists) throw missing(); return { id }; },
                create: async (p) => { calls.push(['products.create', p]); return p; } },
    coupons:  { retrieve: async (id) => { calls.push(['coupons.retrieve', id]); if (!exists) throw missing(); return { id }; },
                create: async (p) => { calls.push(['coupons.create', p]); return p; } },
    promotionCodes: { list: async (q) => { calls.push(['promo.list', q]); return { data: exists ? [{ code: q.code }] : [] }; },
                      create: async (p) => { calls.push(['promo.create', p]); return p; } },
  };
}
const ORIGIN='https://www.quartzmolle.dk';

// 1) Første kald: alt oprettes
_resetKampagneCache();
let s = fakeStripe();
let map = await ensureKampagne(s, ORIGIN);
t('map dækker begge vægte', map && map['bla-hvede-fuldkorn|3 kg'] && map['bla-hvede-fuldkorn|12,5 kg'], JSON.stringify(map));
t('produkt-id er læsbart', map['bla-hvede-fuldkorn|12,5 kg']==='qm-bla-hvede-fuldkorn-12-5-kg');
const pc = s.calls.filter(c=>c[0]==='products.create').map(c=>c[1]);
t('to produkter oprettes', pc.length===2);
t('produktnavn som ad hoc-linjer', pc.every(p=>p.name==='Blå hvede – Fuldkornshvedemel'), pc[0]?.name);
t('beskrivelse indeholder vægt (webhook læser den)', pc.some(p=>/^3 kg · /.test(p.description)) && pc.some(p=>/^12,5 kg · /.test(p.description)));
t('etiket som billede', pc.every(p=>p.images?.[0]?.startsWith(ORIGIN+'/images/blaahvede_')), pc[0]?.images?.[0]);
const cc = s.calls.find(c=>c[0]==='coupons.create')?.[1];
t('kupon NYHED10 = 10 %', cc && cc.id==='NYHED10' && cc.percent_off===10 && cc.duration==='forever');
t('kupon gælder KUN Blå hvede-produkterne', cc && cc.applies_to.products.length===2 && cc.applies_to.products.every(p=>p.startsWith('qm-bla-hvede-fuldkorn')));
const prc = s.calls.find(c=>c[0]==='promo.create')?.[1];
t('rabatkode NYHED peger på kuponen', prc && prc.code==='NYHED' && prc.coupon==='NYHED10');

// 2) Andet kald i samme instans: cache, ingen Stripe-kald
const before = s.calls.length;
await ensureKampagne(s, ORIGIN);
t('cache: ingen nye Stripe-kald', s.calls.length===before);

// 3) Alt findes allerede: intet oprettes
_resetKampagneCache();
s = fakeStripe({ exists: true });
map = await ensureKampagne(s, ORIGIN);
t('findes alt: intet create', map && !s.calls.some(c=>/create/.test(c[0])), s.calls.map(c=>c[0]).join(','));

// 4) Stripe fejler: null, så checkout falder tilbage til ad hoc-linjer
_resetKampagneCache();
s = fakeStripe({ boom: true });
const err=console.error; console.error=()=>{};
map = await ensureKampagne(s, ORIGIN);
console.error=err;
t('Stripe-fejl giver null (checkout fortsætter)', map===null);

// 5) Kildekode
const co = fs.readFileSync('api/checkout.js','utf8');
t('checkout: kalder ensureKampagne', /ensureKampagne\(stripe, origin\)/.test(co));
t('checkout: fast produkt på kampagnelinjer', /product: fastProdukt/.test(co));
t('checkout: falder tilbage til product_data', /product_data/.test(co));
t('checkout: allow_promotion_codes', /allow_promotion_codes: true/.test(co));
t('kampagnen er Blå hvede / NYHED / 10 %', KAMPAGNE.productId==='bla-hvede-fuldkorn' && KAMPAGNE.code==='NYHED' && KAMPAGNE.percent===10);
t('productFields matcher checkout-format', productFields('bla-hvede-fuldkorn','3 kg',ORIGIN).description==='3 kg · Malet på stenkværn i Danmark · Certificeret Økologisk');
t('stripeProductId tåler mærkelige tegn', stripeProductId('x','12,5 kg')==='qm-x-12-5-kg');

console.log(T.join('\n')); const f=T.filter(x=>x.startsWith('FAIL')).length;
console.log(`\n${T.length-f}/${T.length} PASS`); process.exit(f?1:0);
