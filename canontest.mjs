import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const T=[]; const t=(n,c,extra)=>T.push(`${c?'PASS':'FAIL'}  ${n}${extra?'  ('+extra+')':''}`);
await page.route('**/api/**', r => r.fulfill({ json:{ok:true} }));
// eksterne kald (fonts, maps, r2) afbrydes lokalt — testen handler kun om <head>
await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());

// statiske canonicals
for (const [file, url] of [['index.html','https://www.quartzmolle.dk/'],['shop.html','https://www.quartzmolle.dk/shop'],['om.html','https://www.quartzmolle.dk/om'],['forhandlere.html','https://www.quartzmolle.dk/forhandlere']]) {
  const html = fs.readFileSync(file,'utf8');
  const m = html.match(/<link rel="canonical" href="([^"]+)"/g) || [];
  t(`${file}: præcis én canonical = ${url}`, m.length===1 && m[0].includes(`href="${url}"`), m.join(' | '));
}
t('product.html: ingen statisk canonical (sættes fra JS)', !/rel="canonical"/.test(fs.readFileSync('product.html','utf8')));
for (const f of ['admin.html','locker.html','fufill.html','erhverv.html','erhvervsportal.html','packing.html','success.html']) {
  t(`${f}: ingen canonical (noindex-side)`, !/rel="canonical"/.test(fs.readFileSync(f,'utf8')));
}

// produktsiden: canonical + og:url + schema-url fra id
await page.goto('http://localhost:8199/product.html?id=rug-fuldkorn&utm_source=test', { waitUntil:'domcontentloaded' });
await page.waitForTimeout(800);
const r = await page.evaluate(() => ({
  canon: document.querySelector('link[rel="canonical"]')?.href,
  og: document.querySelector('meta[property="og:url"]')?.content,
  schema: (()=>{ try { return JSON.parse(document.getElementById('qm-product-schema').textContent).offers.url; } catch(e){ return 'ERR '+e.message; } })(),
  title: document.title,
  n: document.querySelectorAll('link[rel="canonical"]').length,
}));
t('product: canonical = www + kun id (utm fjernet)', r.canon==='https://www.quartzmolle.dk/product?id=rug-fuldkorn', r.canon);
t('product: og:url = canonical', r.og===r.canon, r.og);
t('product: schema offers.url = canonical', r.schema===r.canon, r.schema);
t('product: præcis én canonical-tag', r.n===1, String(r.n));
t('product: titel sat', /Rug/.test(r.title), r.title);
// ukendt id → redirect til shop (uændret adfærd)
await page.goto('http://localhost:8199/product.html?id=findes-ikke', { waitUntil:'domcontentloaded' });
await page.waitForTimeout(600);
t('product: ukendt id sender til shop', /shop\.html$/.test(page.url()), page.url());

// vercel.json: gyldig JSON + apex→www-redirect først og uden /api
const vj = JSON.parse(fs.readFileSync('vercel.json','utf8'));
const r0 = vj.redirects[0];
t('vercel.json: første redirect er apex→www', r0.has?.[0]?.type==='host' && r0.has[0].value==='quartzmolle.dk' && r0.destination==='https://www.quartzmolle.dk/:path' && r0.permanent===true, JSON.stringify(r0));
t('vercel.json: apex-redirect undtager /api/', /\(\?!api\/\)/.test(r0.source), r0.source);
// simulér Vercels path-to-regexp for source-mønstret
const re = new RegExp('^/' + r0.source.slice(1).replace(':path((?!api/).*)', '((?!api/).*)') + '$');
t('mønster matcher / , /shop, /product?id=x', re.test('/') && re.test('/shop') && re.test('/product'), re.source);
t('mønster matcher IKKE /api/checkout', !re.test('/api/checkout'));

console.log(T.join('\n'));
const f=T.filter(x=>x.startsWith('FAIL')).length;
console.log(`\n${T.length-f}/${T.length} PASS`);
await browser.close();
process.exit(f?1:0);
