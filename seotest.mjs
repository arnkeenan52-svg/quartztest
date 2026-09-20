// Google-visningen: titler, beskrivelser (bio) og struktureret data.
import fs from 'node:fs';
import { chromium } from 'playwright';
const T=[]; const t=(n,c,x)=>T.push(`${c?'PASS':'FAIL'}  ${n}${x?'  ('+x+')':''}`);
const læs = f => fs.readFileSync(f,'utf8');
const ld  = s => [...s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m=>JSON.parse(m[1]));
const meta= (s,n)=> (s.match(new RegExp(`<meta name="${n}" content="([^"]*)"`))||[])[1] || '';
const titel=s=> (s.match(/<title>(.*?)<\/title>/)||[])[1] || '';

// ── Forsiden ──────────────────────────────────────────────────────────────
const idx = læs('index.html');
const g = ld(idx)[0]['@graph'];
const node = ty => g.find(n => JSON.stringify(n['@type']).includes(ty));
const bio = meta(idx,'description');
t('forside: bio er 120–160 tegn', bio.length>=120 && bio.length<=160, `${bio.length} tegn`);
t('forside: bio nævner økologisk, stenkværn og køb', /økologisk/i.test(bio) && /stenkværn/i.test(bio) && /(køb|levering)/i.test(bio));
t('forside: bio er ikke den gamle korte', !/producerer økologisk mel malet på stenkværn i Danmark\.$/.test(bio));
t('forside: og:description = bio', idx.includes(`<meta property="og:description" content="${bio}"`));
t('forside: ét samlet @graph', g.length===5, g.map(n=>n['@type']).join(' / '));

const org = node('Organization');
t('org: navn + juridisk navn', org.name==='Quartz Mølle' && org.legalName==='Quartz Mølle ApS');
t('org: logo som ImageObject', org.logo['@type']==='ImageObject' && org.logo.url.startsWith('https://www.quartzmolle.dk/'));
t('org: sameAs peger på Facebook og Instagram', org.sameAs.some(u=>u.includes('facebook.com/quartzmolle')) && org.sameAs.some(u=>u.includes('instagram.com/quartzmolle')));
t('org: CVR/moms', org.vatID==='DK42117188' && org.taxID==='42117188');
t('org: adresse komplet', ['streetAddress','postalCode','addressLocality','addressCountry'].every(k=>org.address[k]));
t('org: kontaktpunkt med sprog og lande', org.contactPoint.email==='hello@quartzmolle.dk' && org.contactPoint.areaServed.includes('DK'));
t('org: beskrivelse er fyldig', org.description.length>150, `${org.description.length} tegn`);

const site = node('WebSite');
t('website: udgiver = organisationen', site.publisher['@id']===org['@id']);
t('website: søgefelt peger på /shop?q=', site.potentialAction.target.urlTemplate==='https://www.quartzmolle.dk/shop?q={search_term_string}');
t('website: dansk', site.inLanguage==='da-DK');
t('shop.js læser ?q= (ellers er søgefeltet en løgn)', /URLSearchParams\(location\.search\)\.get\('q'\)/.test(læs('js/shop.js')));

const butik = node('Store');
t('butik: koordinater matcher kortet', butik.geo.latitude===55.36665 && butik.geo.longitude===11.762342);
t('butik: hører til organisationen', butik.parentOrganization['@id']===org['@id']);
t('butik: prisinterval + betaling', !!butik.priceRange && /MobilePay/.test(butik.paymentAccepted));

const side = node('WebPage');
t('webpage: bundet til website og organisation', side.isPartOf['@id']===site['@id'] && side.about['@id']===org['@id']);
t('alle @id-henvisninger findes', (()=>{ const ids=new Set(g.map(n=>n['@id']).filter(Boolean));
  return [...JSON.stringify(g).matchAll(/"@id":"([^"]+)"/g)].map(m=>m[1]).every(i=>ids.has(i)); })());

// ── Undersider ────────────────────────────────────────────────────────────
const UNDER = { 'shop.html':['Alle produkter','shop'], 'om.html':['Om os','om'],
                'forhandlere.html':['Forhandlere','forhandlere'], 'kontakt.html':['Kontakt os','kontakt'] };
const beskrivelser = [bio], titler = [titel(idx)];
for (const [fil,[navn,sti]] of Object.entries(UNDER)) {
  const s = læs(fil), d = meta(s,'description'), ti = titel(s);
  t(`${navn}: titel starter med sidenavnet (sitelink-etiketten)`, ti.startsWith(navn), ti);
  t(`${navn}: titel er beskrivende, ikke bare navnet`, ti.length>navn.length+16);
  t(`${navn}: beskrivelse 110–165 tegn`, d.length>=110 && d.length<=165, `${d.length} tegn`);
  t(`${navn}: og:description = beskrivelse`, s.includes(`<meta property="og:description" content="${d}"`));
  const krumme = ld(s).flatMap(x=>x['@graph']||[x]).find(n=>n['@type']==='BreadcrumbList');
  t(`${navn}: brødkrumme Hjem › ${navn}`, krumme && krumme.itemListElement.length===2
      && krumme.itemListElement[1].name===navn
      && krumme.itemListElement[1].item===`https://www.quartzmolle.dk/${sti}`);
  const wp = ld(s).flatMap(x=>x['@graph']||[x]).find(n=>['WebPage','ContactPage'].includes(n['@type']));
  t(`${navn}: siden er bundet til forsidens website`, wp.isPartOf['@id']===site['@id'] && wp.about['@id']===org['@id']);
  beskrivelser.push(d); titler.push(ti);
}
t('alle beskrivelser er forskellige', new Set(beskrivelser).size===beskrivelser.length);
t('alle titler er forskellige', new Set(titler).size===titler.length);
t('alle sider har canonical', ['index.html','shop.html','om.html','forhandlere.html'].every(f=>/rel="canonical"/.test(læs(f))));

// ── Produktsiden: schema indsættes af JS, så den skal køres rigtigt ────────
const srv = (await import('node:child_process')).spawn('python3',['-m','http.server','8207'],{cwd:process.cwd(),stdio:'ignore'});
await new Promise(r=>setTimeout(r,900));
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
try {
  const p = await b.newPage();
  await p.goto('http://localhost:8207/product.html?id=rod-hvede-type70');
  await p.waitForFunction(()=>document.getElementById('qm-product-schema'), null, {timeout:8000});
  const r = await p.evaluate(()=>({
    titel: document.title,
    desc: document.querySelector('meta[name="description"]')?.content || '',
    ogt:  document.querySelector('meta[property="og:title"]')?.content || '',
    canon:document.querySelector('link[rel="canonical"]')?.href || '',
    prod: JSON.parse(document.getElementById('qm-product-schema').textContent),
    krum: JSON.parse(document.getElementById('qm-breadcrumb-schema').textContent),
    synlig: [...document.querySelectorAll('#produktKrumme > a, #produktKrumme > [aria-current]')].map(e=>e.textContent.trim()),
  }));
  t('produkt: titel har produktnavn', /Rød hvede/.test(r.titel), r.titel);
  t('produkt: egen beskrivelse (ikke skabelonens)', r.desc.length>60 && r.desc!==bio && !/^Økologisk mel malet på stenkværn i Danmark/.test(r.desc), `${r.desc.length} tegn`);
  t('produkt: beskrivelse max 158 tegn', r.desc.length<=158);
  t('produkt: beskrivelse nævner vægte og pris', /kg/.test(r.desc) && /kr/.test(r.desc), r.desc.slice(-46));
  t('produkt: og:title sat', /Rød hvede/.test(r.ogt));
  t('produkt: canonical uden ekstra parametre', r.canon==='https://www.quartzmolle.dk/product?id=rod-hvede-type70');
  const tilbud = r.prod.offers;
  t('produkt: ét tilbud pr. vægt', Array.isArray(tilbud) && tilbud.length===2, Array.isArray(tilbud) ? tilbud.map(o=>o.name).join(' · ') : typeof tilbud);
  t('produkt: hvert tilbud har egen pris og varenummer', tilbud.every(o=>/^\d+\.\d\d$/.test(o.price) && o.sku.includes('|')));
  t('produkt: vægt angivet i kg', tilbud.every(o=>o.weight && o.weight.unitCode==='KGM' && o.weight.value>0), tilbud.map(o=>o.weight.value).join('/'));
  t('produkt: fragt matcher GLS-satsen for vægten', (()=>{
      const sats = kg => kg<=5?46:kg<=10?55:kg<=15?66:81;
      return tilbud.every(o=>o.shippingDetails.shippingRate.value === sats(o.weight.value).toFixed(2));
    })(), tilbud.map(o=>`${o.weight.value}kg=${o.shippingDetails.shippingRate.value}`).join(' '));
  t('produkt: leveringstid 1–3 hverdage', tilbud.every(o=>o.shippingDetails.deliveryTime.transitTime.minValue===1 && o.shippingDetails.deliveryTime.transitTime.maxValue===3));
  t('produkt: fragt til alle fem lande', tilbud.every(o=>o.shippingDetails.shippingDestination.length===5));
  t('produkt: sælger = organisationen', tilbud.every(o=>o.seller['@id']===org['@id']));
  t('produkt: sku og kategori', r.prod.sku==='rod-hvede-type70' && r.prod.category==='Mel');
  t('produkt: synlig sti matcher schemaet', JSON.stringify(r.synlig)===JSON.stringify(r.krum.itemListElement.map(e=>e.name)), r.synlig.join(' › '));
  t('produkt: brødkrumme Hjem › Alle produkter › vare', r.krum.itemListElement.length===3 && r.krum.itemListElement[1].name==='Alle produkter' && r.krum.itemListElement[2].item===r.canon);

  await p.goto('http://localhost:8207/shop.html');
  await p.waitForFunction(()=>document.getElementById('qm-shop-itemlist'), null, {timeout:8000});
  const liste = await p.evaluate(()=>JSON.parse(document.getElementById('qm-shop-itemlist').textContent));
  t('butikken: struktureret varelistе', liste['@type']==='ItemList' && liste.itemListElement.length===liste.numberOfItems && liste.numberOfItems>=12, `${liste.numberOfItems} varer`);
  t('butikken: hver vare har adresse, billede og fra-pris', liste.itemListElement.every(e=>e.item.url.includes('/product?id=') && e.item.image && e.item.offers.price));
  t('butikken: Blå hvede er med', liste.itemListElement.some(e=>/Blå hvede/.test(e.item.name)));

  await p.goto('http://localhost:8207/shop.html?q=spelt');
  await p.waitForTimeout(700);
  const sq = await p.evaluate(()=>({v:document.getElementById('shopSearch').value, n:document.querySelectorAll('#shopGrid .product-card, #shopGrid a[href*="product"]').length}));
  t('sitelinks-søgefelt virker: ?q=spelt filtrerer shoppen', sq.v==='spelt' && sq.n>0 && sq.n<5, `felt="${sq.v}", ${sq.n} varer`);
  await p.close();
} finally { await b.close(); srv.kill(); }

// ── Menustruktur: de fire sektioner Google skal kunne vælge imellem ───────
const menu = node('ItemList');
const MENU = [['Alle produkter','shop'],['Forhandlere','forhandlere'],['Om os','om'],['Kontakt os','kontakt']];
t('menu: fire sektioner i fast rækkefølge', menu.itemListElement.length===4
   && menu.itemListElement.every((e,i)=>e.name===MENU[i][0] && e.url===`https://www.quartzmolle.dk/${MENU[i][1]}`),
   menu.itemListElement.map(e=>e.name).join(' · '));
t('menu: hver sektion har en forklaring', menu.itemListElement.every(e=>e.description && e.description.length>25));
t('menu: hængt på forsiden', node('WebPage').hasPart['@id']===menu['@id']);

// Samme navne i menuen, i mobilmenuen og i footeren på ALLE offentlige sider.
const OFFENTLIGE = ['index.html','shop.html','om.html','forhandlere.html','kontakt.html','product.html','success.html'];
for (const f of OFFENTLIGE) {
  const h = læs(f);
  t(`${f}: linker til "Alle produkter", ikke "Shop"`, />Shop</.test(h)===false && /shop\.html"[^>]*>Alle produkter</.test(h));
  t(`${f}: "Kontakt os" er en rigtig side`, /kontakt\.html"[^>]*>Kontakt os</.test(h) && !/href="(index\.html)?#kontakt"/.test(h));
}
t('kontaktsiden er i sitemap', læs('sitemap.xml').includes('https://www.quartzmolle.dk/kontakt<'));
t('kontaktsiden har adresse, mail og kort', (()=>{const h=læs('kontakt.html');
  return h.includes('Suså Landevej 101') && h.includes('hello@quartzmolle.dk') && h.includes('maps?q=55.366650');})());
t('synlig brødkrumme på shop og kontakt', /class="qm-krumme"/.test(læs('shop.html')) && /class="qm-krumme"/.test(læs('kontakt.html')));

console.log(T.join('\n')); const f=T.filter(x=>x.startsWith('FAIL')).length;
console.log(`\n${T.length-f}/${T.length} PASS`); process.exit(f?1:0);
