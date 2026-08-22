import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();

const orders = Array.from({ length: 20 }, (_, i) => ({
  id: 'cs_test_' + i, ref: 'REF' + (100 + i), customerName: 'Kunde ' + i, email: 'k' + i + '@x.dk',
  city: 'By ' + i, country: 'DK', itemCount: 2, amount: 199 + i, date: Date.now() - i * 86400000,
  delivery: i % 3 === 0 ? 'pickup' : 'gls',
}));
const stats = {
  ok: true, totalOrders: 20, totalRevenue: 4500, visitorsToday: 40, activeNow: 2,
  orders, topProducts: [], locations: [], conversion: 2.5, alerts: [],
};
const nlEmails = Array.from({ length: 30 }, (_, i) => ({ email: 'sub' + i + '@x.dk', code: 'QM10AB' + i, t: Date.now(), ip: '1.2.3.' + (i % 5) }));

let liveCalls = 0;
await page.route('**/api/**', route => route.fulfill({ json: { ok: true } }));
await page.route('**/api/admin-stats*', route => route.fulfill({ json: stats }));
await page.route('**/api/admin-live*', route => { liveCalls++; return route.fulfill({ json: { ok: true, activeNow: 2, visitorsToday: 40, visitorsYesterday: 30 } }); });
await page.route('**/api/locker', async route => {
  const b = JSON.parse(route.request().postData() || '{}');
  if (b.action === 'login') return route.fulfill({ json: { ok: true } });
  if (b.action === 'newsletterlist') return route.fulfill({ json: { ok: true, count: 30, emails: nlEmails } });
  return route.fulfill({ json: { ok: true } });
});

await page.goto('http://localhost:8199/admin.html');
await page.waitForSelector('.order-row', { timeout: 10000 });
await page.waitForTimeout(1200); // idle-callback til nyhedsbrev

const T = [];
const t = (n, c) => T.push(`${c ? 'PASS' : 'FAIL'}  ${n}`);

// Ordre-fold
t('kun 8 ordrer vist foldet', await page.locator('#ordersList .order-row').count() === 8);
t('fold-knap viser "Vis alle 20 ordrer"', /Vis alle 20 ordrer/.test(await page.locator('#ordersList .fold-btn').innerText()));
await page.click('#ordersList [data-fold]');
t('udfoldet: alle 20 vist', await page.locator('#ordersList .order-row').count() === 20);
t('knap skifter til "Vis færre"', /Vis færre/.test(await page.locator('#ordersList .fold-btn').innerText()));
await page.click('#ordersList [data-fold]');
t('foldet igen: 8 vist', await page.locator('#ordersList .order-row').count() === 8);

// Filter-chips virker stadig + CSV-knap ødelægger ikke listen
await page.click('.dfilter .dchip[data-df="pickup"]');
const pickupCount = await page.locator('#ordersList .order-row').count();
t('pickup-filter viser kun afhentninger', pickupCount === 7);
await page.click('.dfilter .dchip[data-df="all"]');
await page.waitForSelector('#nlCsvBtn', { state: 'visible' });
await page.evaluate(() => { const a = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){}; window.__ra = a; });
await page.click('#nlCsvBtn');
await page.waitForTimeout(200);
t('CSV-knap nulstiller IKKE ordrelisten (bugfix)', await page.locator('#ordersList .order-row').count() === 8);

// Ordre-modal virker stadig fra en raekke
await page.route('**/api/admin-order*', route => route.fulfill({ json: { ok: true, ref: 'REF100', items: [], amount: 199 } }));
await page.click('#ordersList .order-row >> nth=0');
await page.waitForTimeout(300);
t('ordre-modal aabner stadig', await page.locator('#orderModal.open').count() === 1);
await page.keyboard.press('Escape');

// Nyhedsbrevs-fold
t('nyhedsbrev: 12 raekker foldet', await page.locator('#nlList > div').count() === 12);
await page.click('#nlList [data-nlfold]');
t('nyhedsbrev udfoldet: 30 raekker', await page.locator('#nlList > div').count() === 30);
await page.click('#nlList [data-nlfold]');
t('nyhedsbrev foldet igen: 12', await page.locator('#nlList > div').count() === 12);

// Cache: periodeskift frem og tilbage rammer cachen (ingen "Henter"-blink)
await page.click('button[data-range="30"]');
await page.waitForTimeout(300);
await page.click('button[data-range="7"]');
const flash = await page.evaluate(() => document.getElementById('ordersList').className === 'loading');
t('cachet periodeskift uden loading-blink', !flash);
await page.waitForTimeout(200);
t('ordrer stadig vist efter periodeskift', await page.locator('#ordersList .order-row').count() === 8);

// Poll-pause ved skjult fane
const before = liveCalls;
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(16000);
const during = liveCalls - before;
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(500);
t('polling stoppet mens fanen er skjult', during === 0);
t('polling genoptaget med frisk hent', liveCalls > before);

console.log(T.join('\n'));
const f = T.filter(x => x.startsWith('FAIL')).length;
console.log(`\n${T.length - f}/${T.length} PASS`);
await browser.close();
process.exit(f ? 1 : 0);
