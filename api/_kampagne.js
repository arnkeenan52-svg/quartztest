// api/_kampagne.js — kampagnerabat, der kun gælder én vare.
//
// Stripe kan kun begrænse en kupon til bestemte PRODUKTER. Vores varelinjer
// oprettes normalt ad hoc (price_data.product_data) og får derfor et nyt,
// anonymt produkt pr. betaling, som en kupon ikke kan pege på. Derfor får
// kampagnevaren faste Stripe-produkter (ét pr. vægt, med samme navn,
// beskrivelse og etiketbillede som de ad hoc-linjer har i dag, så webhook,
// Shipmondo og ordreoversigten ser præcis det samme), og kuponen bindes til
// dem. Alt oprettes automatisk og idempotent første gang checkout kaldes —
// intet skal sættes op i Stripe-dashboardet.
//
// Rabatkoden kan ikke misbruges på andre varer: har kurven ikke kampagnevaren,
// afviser Stripe selv koden ("gælder ikke for varerne i kurven").

import { CATALOG, labelImage } from './_catalog.js';

export const KAMPAGNE = {
  productId: 'bla-hvede-fuldkorn',   // varen i CATALOG
  code: 'NYHED',                     // det kunden taster
  couponId: 'NYHED10',               // fast Stripe-kupon-id (idempotent)
  percent: 10,
};

// Fast, læsbart Stripe-produkt-id pr. vare+vægt: "qm-bla-hvede-fuldkorn-12-5-kg".
export function stripeProductId(id, label) {
  return ('qm-' + id + '-' + label).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Samme visningsfelter som de ad hoc-linjer i checkout.js bygger.
export function productFields(id, label, origin) {
  const cat = CATALOG[id] || {};
  const typeStr = cat.type ? ` – ${cat.type}` : '';
  const fields = {
    name: `${cat.name || id}${typeStr}`,
    description: `${label} · Malet på stenkværn i Danmark · Certificeret Økologisk`,
  };
  const img = labelImage(id, label);
  if (img) {
    const path = img.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
    fields.images = [`${origin}/${path}`];
  }
  return fields;
}

const isMissing = (e) => e && (e.code === 'resource_missing' || e.statusCode === 404);
const alreadyExists = (e) => e && (e.code === 'resource_already_exists' || /already exists/i.test(e.message || ''));

// Sørger for at produkter, kupon og rabatkode findes. Returnerer et map
// { 'id|vægt': stripeProductId } for kampagnevaren, eller null hvis Stripe
// fejlede — så falder checkout tilbage til ad hoc-linjer og virker stadig.
let cached = null;
export async function ensureKampagne(stripe, origin, k = KAMPAGNE) {
  if (cached) return cached;
  const cat = CATALOG[k.productId];
  if (!cat) return null;
  try {
    const map = {};
    for (const label of Object.keys(cat.weights)) {
      const pid = stripeProductId(k.productId, label);
      try {
        await stripe.products.retrieve(pid);
      } catch (e) {
        if (!isMissing(e)) throw e;
        try { await stripe.products.create({ id: pid, ...productFields(k.productId, label, origin) }); }
        catch (e2) { if (!alreadyExists(e2)) throw e2; }
      }
      map[`${k.productId}|${label}`] = pid;
    }

    try {
      await stripe.coupons.retrieve(k.couponId);
    } catch (e) {
      if (!isMissing(e)) throw e;
      try {
        await stripe.coupons.create({
          id: k.couponId,
          name: `${k.code} – ${k.percent} % på ${cat.name}`,
          percent_off: k.percent,
          duration: 'forever',
          applies_to: { products: Object.values(map) },
        });
      } catch (e2) { if (!alreadyExists(e2)) throw e2; }
    }

    const found = await stripe.promotionCodes.list({ code: k.code, limit: 1 });
    if (!found.data || found.data.length === 0) {
      await stripe.promotionCodes.create({ coupon: k.couponId, code: k.code });
    }

    cached = map;
    return map;
  } catch (e) {
    console.error('Kampagne-opsætning fejlede (checkout fortsætter uden):', e.message);
    return null;
  }
}

// Kun til test.
export function _resetKampagneCache() { cached = null; }
