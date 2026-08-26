import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
// 6 IP'er med 2+ tilmeldinger hver (skal foldes til 3 + knap)
const emails = [];
for (let g = 0; g < 6; g++) for (let i = 0; i < 3; i++)
  emails.push({ email: `u${g}_${i}@x.dk`, code: 'QM10AB' + g + i, t: Date.now() - i*86400000, ip: '192.76.153.' + (10 + g) });
// plus nogle enlige (skal ikke vises)
for (let i = 0; i < 5; i++) emails.push({ email: `solo${i}@x.dk`, code: 'QM10X'+i, t: Date.now(), ip: '10.0.0.' + i });

await page.route('**/api/**', r => r.fulfill({ json: { ok: true } }));
await page.route('**/api/admin-stats*', r => r.fulfill({ json: { ok: true, orders: [], topProducts: [], locations: [], alerts: [] } }));
await page.route('**/api/admin-live*', r => r.fulfill({ json: { ok: true, activeNow: 0, visitorsToday: 0 } }));
await page.route('**/api/locker', r => {
  const b = JSON.parse(r.request().postData() || '{}');
  if (b.action === 'newsletterlist') return r.fulfill({ json: { ok: true, count: emails.length, emails } });
  return r.fulfill({ json: { ok: true } });
});
await page.route('**/api/b2b', r => r.fulfill({ json: { ok: true, orders: [], customers: [] } }));

await page.goto('http://localhost:8199/admin.html');
await page.waitForSelector('#nlIpGroups .ipg', { timeout: 10000 });
await page.waitForTimeout(400);

const T=[];const t=(n,c)=>T.push(`${c?'PASS':'FAIL'}  ${n}`);
t('IP-tjek viser 3 grupper foldet', await page.locator('#nlIpGroups .ipg').count() === 3);
t('foldeknap: "Vis alle 6 IP-adresser"', /Vis alle 6 IP-adresser/.test(await page.locator('#nlIpGroups .fold-btn').innerText()));
await page.click('#nlIpGroups [data-ipfold]');
await page.waitForTimeout(200);
t('udfoldet: alle 6 grupper', await page.locator('#nlIpGroups .ipg').count() === 6);
t('knap skifter til "Vis færre"', /Vis færre/.test(await page.locator('#nlIpGroups .fold-btn').innerText()));
await page.click('#nlIpGroups [data-ipfold]');
await page.waitForTimeout(200);
t('foldet igen: 3 grupper', await page.locator('#nlIpGroups .ipg').count() === 3);
await page.locator('#nlIpGroups').locator('xpath=ancestor::div[contains(@class,"panel")]').screenshot({ path: 'ipfold.png' }).catch(()=>{});

console.log(T.join('\n'));
const f=T.filter(x=>x.startsWith('FAIL')).length;
console.log(`\n${T.length-f}/${T.length} PASS`);
await browser.close();
process.exit(f?1:0);
