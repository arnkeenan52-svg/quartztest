import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const T=[]; const t=(n,c)=>T.push(`${c?'PASS':'FAIL'}  ${n}`);
// mock R2-videoer med et grønt still-billede, så vi kan se overlayet uden netværk
const green = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNksb9dDwAEDwHf9YQFQwAAAABJRU5ErkJggg==','base64');
await page.route('**/r2.dev/three.mp4', r => r.fulfill({ status:200, contentType:'image/png', body: green }));
await page.route('**/r2.dev/two.mp4',   r => r.fulfill({ status:200, contentType:'image/png', body: green }));
await page.route('**/r2.dev/*.mp4',      r => r.fulfill({ status:200, contentType:'image/png', body: green }));
await page.route('**/api/**', r => r.fulfill({ json:{ok:true, products:[]} }));
await page.goto('http://localhost:8199/index.html', { waitUntil:'domcontentloaded' });
await page.waitForTimeout(1500);
// hvilke kilder peger videoerne på?
const srcs = await page.$$eval('#videoStage video source', els => els.map(e => e.getAttribute('src')));
t('vid1 (hero) = three.mp4', /\/three\.mp4$/.test(srcs[0]||''));
t('vid2 (story) = two.mp4', /\/two\.mp4$/.test(srcs[1]||''));
// er overlayet en gradient nu (ikke bare flad farve)?
const bg = await page.$eval('#vs1 .video-overlay', el => getComputedStyle(el).backgroundImage);
t('hero-overlay er gradient', /gradient/.test(bg));
const bg2 = await page.$eval('#vs2 .video-overlay', el => getComputedStyle(el).backgroundImage);
t('story-overlay er retnings-gradient', /gradient/.test(bg2));
// gør hero-overlay synligt til screenshot
await page.evaluate(()=>{document.querySelectorAll('.video-overlay').forEach(o=>o.style.opacity=1);});
await page.waitForTimeout(300);
await page.screenshot({ path:'vid-hero.png' });
await page.evaluate(()=>window.scrollTo(0, window.innerHeight*1.2));
await page.waitForTimeout(600);
await page.screenshot({ path:'vid-story.png' });
console.log(T.join('\n'));
const f=T.filter(x=>x.startsWith('FAIL')).length;
console.log(`\n${T.length-f}/${T.length} PASS`);
await browser.close();
process.exit(f?1:0);
