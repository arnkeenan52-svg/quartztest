import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const T = []; const t = (n, c) => T.push(`${c ? 'PASS' : 'FAIL'}  ${n}`);

// ── ERHVERV.HTML ──
{
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const products = [
    { key: 'rug-fuldkorn|11 kg', id: 'rug-fuldkorn', label: '11 kg', name: 'Rug · Fuldkorn', image: 'images/pose-rug-fuldkorn.jpg', kg: 11, price: 180 },
    { key: 'spelt-fuldkorn|12,5 kg', id: 'spelt-fuldkorn', label: '12,5 kg', name: 'Spelt · Fuldkorn', image: 'images/pose-spelt-fuldkorn.jpg', kg: 12.5, price: null },
  ];
  let loggedIn = false, orderPayload = null, myOrders = [];
  await page.route('**/api/b2b', route => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'me') return route.fulfill({ status: loggedIn ? 200 : 401, json: loggedIn ? { ok: true, customer: { name: 'Megans Surdej', email: 'm@s.dk' }, products } : { ok: false } });
    if (b.action === 'reqcode') return route.fulfill({ json: { ok: true } });
    if (b.action === 'verify') { loggedIn = b.code === '123456'; return route.fulfill({ status: loggedIn ? 200 : 400, json: loggedIn ? { ok: true } : { ok: false, error: 'Forkert kode — prøv igen.' } }); }
    if (b.action === 'order') { orderPayload = b; myOrders.unshift({ no: 7, t: Date.now(), status: 'ny', lines: [{ name: 'Rug · Fuldkorn', label: '11 kg', qty: 10, price: 180 }] }); return route.fulfill({ json: { ok: true, no: 7 } }); }
    if (b.action === 'myorders') return route.fulfill({ json: { ok: true, orders: myOrders } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/images/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') }));

  await page.goto('http://localhost:8199/erhverv.html');
  await page.waitForSelector('#stepEmail', { timeout: 10000 });
  t('login-side vises (ikke logget ind)', await page.locator('#login').isVisible());

  await page.fill('#emailIn', 'm@s.dk');
  await page.click('#sendCodeBtn');
  await page.waitForSelector('#stepCode:not(.hide)');
  t('kode-trin vises efter send', await page.locator('#otpWrap').isVisible());

  const otp0 = page.locator('#otpWrap input').first();
  await otp0.fill('999999');
  await page.waitForTimeout(400);
  t('forkert kode viser fejl + ryster', /Forkert kode/.test(await page.locator('#loginErr').innerText()));
  t('6 separate kodefelter (21st-mønster)', await page.locator('#otpWrap input').count() === 6);
  t('gensend-knap med nedtælling', /Send igen \(\d+\)/.test(await page.locator('#resendBtn').innerText()));

  await otp0.fill('123456'); // fordeles + auto-login ved 6. ciffer
  await page.waitForSelector('#app:not(.hide)', { timeout: 5000 });
  t('logget ind -> portalen vises', await page.locator('#custName').innerText() === 'Megans Surdej');
  t('produktkort vises med pris og aftalt pris', await page.locator('.pcard').count() === 2 && /aftalt pris/.test(await page.locator('#prodList').innerText()));
  t('velkomst med kundenavn', /Megans Surdej/.test(await page.locator('#helloName').innerText()));
  t('opsummering viser tom-tilstand', /Ingen varer valgt/.test(await page.locator('#sumLines').innerText()));

  // stepper + sum
  const row = page.locator('.vrow').first();
  await row.locator('[data-plus]').click();
  await row.locator('[data-plus]').click();
  await page.waitForTimeout(100);
  t('stepper tæller op', await row.locator('input').inputValue() === '2');
  t('produktkort markeres aktivt', await page.locator('.pcard.active').count() === 1);
  t('opsummeringslinje viser varen', /Rug/.test(await page.locator('#sumLines').innerText()) && /× 2/.test(await page.locator('#sumLines').innerText()));
  t('subtotal beregnes', /360/.test(await page.locator('#stSum').innerText()));
  t('sum-bar viser stk/kg/kr', /2 stk\. · ca\. 22 kg/.test(await page.locator('#sumMain').innerText()) && /360 kr\./.test(await page.locator('#sumSub').innerText()));
  t('send-knap aktiv', !(await page.locator('#sendOrderBtn').isDisabled()));

  await page.fill('#ordNote', 'Bagdøren tak');
  await page.click('#sendOrderBtn');
  await page.waitForTimeout(400);
  t('order sendt med rigtige linjer', orderPayload && orderPayload.lines.length === 1 && orderPayload.lines[0].qty === 2 && orderPayload.note === 'Bagdøren tak');
  t('kurv nulstillet efter send', /Ingen varer valgt/.test(await page.locator('#sumMain').innerText()));
  t('toast bekræfter', /Bestilling #7/.test(await page.locator('#toast').innerText()));
  await page.waitForTimeout(200);
  t('mine bestillinger viser ordren med tidslinje', /#7/.test(await page.locator('#myOrders').innerText()) && /Modtaget/.test(await page.locator('#myOrders').innerText()) && /Afventer bekræftelse/.test(await page.locator('#myOrders').innerText()));

  await page.screenshot({ path: 'erhverv.png', fullPage: false });
  await page.close();
}

// ── ADMIN B2B-PANEL ──
{
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  let orders = [
    { id: 'b2b_1', no: 3, t: Date.now(), status: 'ny', email: 'm@s.dk', customerName: 'Megans Surdej',
      lines: [{ name: 'Rug · Fuldkorn', label: '11 kg', qty: 10, kg: 11, price: 180 }], note: 'Bagdøren', wishDate: '2026-08-28' },
    { id: 'b2b_0', no: 2, t: Date.now() - 86400000, status: 'godkendt', email: 'm@s.dk', customerName: 'Megans Surdej',
      lines: [{ name: 'Spelt · Fuldkorn', label: '12,5 kg', qty: 4, kg: 12.5, price: null }], note: '', wishDate: '' },
  ];
  let statusCall = null;
  await page.route('**/api/**', r => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/admin-stats*', r => r.fulfill({ json: { ok: true, totalOrders: 0, totalRevenue: 0, orders: [], topProducts: [], locations: [], alerts: [] } }));
  await page.route('**/api/admin-live*', r => r.fulfill({ json: { ok: true, activeNow: 0, visitorsToday: 0 } }));
  await page.route('**/api/b2b', route => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'admlist') return route.fulfill({ json: { ok: true, orders } });
    if (b.action === 'admcustomers') return route.fulfill({ json: { ok: true, customers: [{ email: 'm@s.dk', name: 'Megans Surdej', cvr: '46218175' }] } });
    if (b.action === 'admsetstatus') { statusCall = b; orders = orders.map(o => o.id === b.id ? { ...o, status: b.status } : o); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/locker', route => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'newsletterlist') return route.fulfill({ json: { ok: true, count: 0, emails: [] } });
    return route.fulfill({ json: { ok: true } });
  });
  page.on('dialog', d => d.accept()); // kun kunde-sletning bruger stadig confirm

  await page.goto('http://localhost:8199/erhvervsportal.html');
  await page.waitForSelector('.b2b-ord', { timeout: 10000 });
  t('admin: B2B-ordrer vises', await page.locator('.b2b-ord').count() === 2);
  t('admin: badge viser 1 ny', /1 ny/i.test(await page.locator('#b2bBadge').innerText()));
  t('admin: ny ordre har Godkend/Afvis', await page.locator('[data-b2b-ok]').count() === 1);
  t('admin: kundeliste vises', /Megans Surdej/.test(await page.locator('#b2bCustomers').innerText()));
  t('subnav har alle tre faner', await page.locator('.subnav-item').count() === 3 && /Erhverv/.test(await page.locator('.subnav-item.is-active').innerText()));

  await page.locator('.b2b-ord').first().screenshot({ path: 'b2badmin.png' });

  await page.click('[data-b2b-ok]');
  await page.waitForSelector('.dlg-back.open', { timeout: 4000 });
  const dlgTxt = await page.locator('#dlgTitle').innerText();
  t('godkend åbner pæn dialog (ikke prompt)', /Godkend bestilling #3/.test(dlgTxt));
  await page.fill('#dlgMsg', 'Leverer torsdag');
  await page.click('#dlgGo');
  await page.waitForTimeout(400);
  t('admin: godkend sender status+besked', statusCall && statusCall.status === 'godkendt' && statusCall.msg === 'Leverer torsdag');
  t('dialogen lukker efter send', await page.locator('.dlg-back.open').count() === 0);
  t('admin: ordren skifter til Godkendt', await page.locator('[data-b2b-ok]').count() === 0 && (await page.locator('.b2b-chip.godkendt').count()) === 2);
  await page.close();
}

// ── FANER + ADMIN UDEN B2B-PANEL ──
{
  const page = await browser.newPage();
  await page.route('**/api/**', r => r.fulfill({ json: { ok: true, lockers: [], orders: [], history: [] } }));
  await page.goto('http://localhost:8199/locker.html');
  await page.waitForTimeout(600);
  t('locker: Erhverv-fane findes', await page.locator('.subnav-item[href="/erhvervsportal"]').count() === 1);
  await page.goto('http://localhost:8199/fufill.html');
  await page.waitForTimeout(600);
  t('fufill: Erhverv-fane findes', await page.locator('.subnav-item[href="/erhvervsportal"]').count() === 1);
  await page.route('**/api/admin-stats*', r => r.fulfill({ json: { ok: true, orders: [], topProducts: [], locations: [], alerts: [] } }));
  await page.goto('http://localhost:8199/admin.html');
  await page.waitForTimeout(1200);
  t('admin: B2B-panelet er flyttet ud', await page.locator('#b2bOrders').count() === 0);
  await page.close();
}

console.log(T.join('\n'));
const f = T.filter(x => x.startsWith('FAIL')).length;
console.log(`\n${T.length - f}/${T.length} PASS`);
await browser.close();
process.exit(f ? 1 : 0);
