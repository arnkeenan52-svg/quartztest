import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

const mkToday = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const todayOrders = [
  { id: 'a', ref: 'R1', customerName: 'Mette', city: 'København', amount: 258, date: mkToday(8, 40), itemCount: 2, delivery: 'gls' },
  { id: 'b', ref: 'R2', customerName: 'Lars', city: 'Aarhus', amount: 129, date: mkToday(10, 15), itemCount: 1, delivery: 'pickup' },
  { id: 'c', ref: 'R3', customerName: 'Sofie', city: 'Odense', amount: 517, date: mkToday(12, 5), itemCount: 4, delivery: 'gls' },
  { id: 'd', ref: 'R4', customerName: 'Peter', city: 'Ballerup', amount: 258, date: mkToday(12, 45), itemCount: 2, delivery: 'gls' },
  { id: 'e', ref: 'R5', customerName: 'Nina', city: 'Vejle', amount: 189, date: mkToday(15, 30), itemCount: 1, delivery: 'pickup' },
];
const weekOrders = Array.from({ length: 12 }, (_, i) => ({
  id: 'w' + i, ref: 'W' + i, customerName: 'K' + i, city: 'By', amount: 150 + i * 40,
  date: Date.now() - i * 86400000 / 2, itemCount: 1, delivery: 'gls',
}));

await page.route('**/api/**', r => r.fulfill({ json: { ok: true } }));
await page.route('**/api/admin-stats*', r => {
  const u = new URL(r.request().url());
  const single = u.searchParams.get('from') && (!u.searchParams.get('to') || u.searchParams.get('from') === u.searchParams.get('to'));
  const list = single ? todayOrders : weekOrders;
  return r.fulfill({ json: { ok: true, totalOrders: list.length, totalRevenue: list.reduce((a, o) => a + o.amount, 0), visitorsToday: 40, activeNow: 1, orders: list, topProducts: [], locations: [], conversion: 2, alerts: [] } });
});
await page.route('**/api/admin-live*', r => r.fulfill({ json: { ok: true, activeNow: 1, visitorsToday: 40, visitorsYesterday: 30 } }));
await page.route('**/api/locker', r => r.fulfill({ json: { ok: true, count: 0, emails: [] } }));

await page.goto('http://localhost:8199/admin.html');
await page.waitForSelector('#trendChart svg', { timeout: 10000 });

const T = []; const t = (n, c) => T.push(`${c ? 'PASS' : 'FAIL'}  ${n}`);

// 7-dages visning: stadig linje
t('7 dage: linjegraf tegnes', await page.locator('#trendChart .trc-line').count() === 1);

// Skift til "I dag" -> søjler pr. time
await page.click('#btnToday');
await page.waitForSelector('#trendChart .trc-bar', { timeout: 10000 });
t('I dag: søjler i stedet for én prik', await page.locator('#trendChart .trc-bar').count() === 4);
t('I dag: ingen linje/prik', await page.locator('#trendChart .trc-line').count() === 0);
t('aria-label siger pr. time', await page.locator('#trendChart svg').getAttribute('aria-label') === 'Omsætning pr. time');
t('opsummering: I alt + ordrer + travlest', /I alt.*1\.351.*5 ordrer.*Travlest.*kl\. 12–13/s.test(await page.locator('#trendChart .trc-sum').innerText().then(x => x.replace(/ /g, '.'))) || /1351|1\.351/.test(await page.locator('#trendChart .trc-sum').innerText()));
t('header viser travleste time', /Travlest: kl\. 12–13/.test(await page.locator('#trendPeak').innerText()));
t('paneltitel skifter til pr. time', /pr\. time/i.test(await page.locator('#trendChart').locator('xpath=ancestor::div[contains(@class,"panel")]//h2').innerText()));

// Tooltip på en søjle
const svg = page.locator('#trendChart svg');
const box = await svg.boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(200);
t('tooltip vises med kl.-interval', /kl\. \d+–\d+/.test(await page.locator('#trcTip').innerText()));

// Tilbage til 7 dage -> linjen er tilbage
await page.click('button[data-range="7"]');
await page.waitForTimeout(400);
t('tilbage til 7 dage: linjegraf igen', await page.locator('#trendChart .trc-line').count() === 1);
t('paneltitel tilbage til pr. dag', /pr\. dag/i.test(await page.locator('#trendChart').locator('xpath=ancestor::div[contains(@class,"panel")]//h2').innerText()));

// Skaermbillede af time-visningen
await page.click('#btnToday');
await page.waitForSelector('#trendChart .trc-bar');
await page.waitForTimeout(900);
await page.locator('#trendChart').locator('xpath=ancestor::div[contains(@class,"panel")]').screenshot({ path: 'hourchart.png' });

console.log(T.join('\n'));
const f = T.filter(x => x.startsWith('FAIL')).length;
console.log(`\n${T.length - f}/${T.length} PASS`);
await browser.close();
process.exit(f ? 1 : 0);
