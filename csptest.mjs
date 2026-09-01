// Serverer siderne med PRÆCIS de headers fra vercel.json og fanger enhver
// CSP-blokering eller konsolfejl på hver eneste side.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { chromium } from 'playwright';

const cfg = JSON.parse(await readFile('vercel.json', 'utf8'));
const globalHeaders = cfg.headers.find(h => h.source === '/(.*)').headers;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json', '.mp4':'video/mp4', '.webp':'image/webp' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (!extname(p)) p += '.html';
  try {
    const buf = await readFile(join(process.cwd(), p));
    for (const h of globalHeaders) res.setHeader(h.key, h.value);
    res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream');
    res.end(buf);
  } catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise(r => server.listen(8210, r));

const PAGES = ['/', '/shop', '/product?id=rug-fuldkorn', '/om', '/forhandlere', '/success',
               '/admin', '/locker', '/fufill', '/packing', '/erhverv', '/erhvervsportal'];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let problems = 0;
for (const path of PAGES) {
  const page = await browser.newPage();
  const csp = [], errs = [], failed = [];
  page.on('console', m => {
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 180));
    else if (m.type() === 'error' && !/favicon|404|Failed to load resource/i.test(t)) errs.push(t.slice(0, 140));
  });
  page.on('pageerror', e => errs.push('JS: ' + e.message.slice(0, 140)));
  page.on('requestfailed', r => {
    const f = r.failure() && r.failure().errorText || '';
    if (/blocked/i.test(f)) failed.push(r.url().slice(0, 90) + ' -> ' + f);
  });
  // eksterne kald mockes så testen ikke afhænger af nettet, men CSP evalueres stadig
  // (CSP afgøres FØR netværket — en blokering logges som "Refused to load" uanset
  //  om kaldet bagefter afbrydes her). Registreres først = lavest prioritet.
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.route('**://api.stripe.com/**', r => r.fulfill({ status: 200, body: '{}' }));
  await page.route('**/api/**', r => r.fulfill({ json: { ok: true, products: [], orders: [], emails: [], lockers: [], history: [] } }));
  try {
    await page.goto('http://localhost:8210' + path, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2600);
  } catch (e) { errs.push('NAV: ' + e.message.slice(0, 100)); }
  if (path === '/') {
    const vids = await page.evaluate(() => Array.from(document.querySelectorAll('video')).length);
    const shopBtn = await page.evaluate(() => !!document.querySelector('a[href*="shop"]'));
    console.log(`        forside: ${vids} video-elementer, shop-link: ${shopBtn ? 'ja' : 'NEJ'}`);
  }
  const bad = csp.length + failed.length;
  problems += bad;
  const tag = bad ? 'BLOKERET' : (errs.length ? 'js-fejl ' : 'OK      ');
  console.log(`${tag} ${path}`);
  csp.slice(0, 4).forEach(c => console.log('        CSP: ' + c));
  failed.slice(0, 4).forEach(f => console.log('        REQ: ' + f));
  errs.slice(0, 3).forEach(e => console.log('        err: ' + e));
  await page.close();
}
await browser.close();
server.close();
console.log(problems ? `\n${problems} CSP-BLOKERINGER — headeren skal justeres` : '\nIngen CSP-blokeringer på nogen side');
process.exit(problems ? 1 : 0);
