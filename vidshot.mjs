import { chromium } from 'playwright';
import zlib from 'node:zlib';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const W = 430, H = 932;
const page = await browser.newPage({ viewport: { width: W, height: H } });
const T=[]; const t=(n,c,extra)=>T.push(`${c?'PASS':'FAIL'}  ${n}${extra?'  ('+extra+')':''}`);

// Lille PNG-dekoder (8-bit, ikke-interlaced) så vi kan måle pixels i screenshots
function decodePng(buf){
  let p=8; const idat=[]; let w=0,h=0,ct=0;
  while(p<buf.length){
    const len=buf.readUInt32BE(p), type=buf.toString('ascii',p+4,p+8), d=buf.subarray(p+8,p+8+len);
    if(type==='IHDR'){ w=d.readUInt32BE(0); h=d.readUInt32BE(4); ct=d[9]; }
    else if(type==='IDAT') idat.push(d);
    p+=12+len; if(type==='IEND') break;
  }
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct===6?4 : ct===2?3 : ct===4?2 : 1;
  const stride=w*bpp, out=Buffer.alloc(h*stride); let ip=0;
  for(let y=0;y<h;y++){
    const ft=raw[ip++], rs=y*stride, ps=(y-1)*stride;
    for(let x=0;x<stride;x++){
      const r=raw[ip++], a=x>=bpp?out[rs+x-bpp]:0, b=y>0?out[ps+x]:0, c=(x>=bpp&&y>0)?out[ps+x-bpp]:0; let v;
      switch(ft){
        case 0: v=r; break; case 1: v=r+a; break; case 2: v=r+b; break; case 3: v=r+((a+b)>>1); break;
        default: { const pp=a+b-c, pa=Math.abs(pp-a), pb=Math.abs(pp-b), pc=Math.abs(pp-c); v=r+((pa<=pb&&pa<=pc)?a:(pb<=pc)?b:c); }
      }
      out[rs+x]=v&255;
    }
  }
  const lum=(x,y)=>{ const i=(y*w+x)*bpp; return bpp>=3 ? 0.299*out[i]+0.587*out[i+1]+0.114*out[i+2] : out[i]; };
  return { w, h, lum };
}
// Scan en lodret kolonne: største spring mellem to nabo-rækker = "søm"-mål
function column(img, x){
  const L=[]; for(let y=0;y<img.h;y++) L.push(img.lum(x,y));
  let maxJump=0, at=-1; for(let y=1;y<L.length;y++){ const d=Math.abs(L[y]-L[y-1]); if(d>maxJump){maxJump=d; at=y;} }
  return { L, maxJump, at };
}

// mock R2-videoer (fejler at dekode → gennemsigtig video → sektionsbaggrund ses)
const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNksb9dDwAEDwHf9YQFQwAAAABJRU5ErkJggg==','base64');
await page.route('**/api/**', r => r.fulfill({ json:{ok:true, products:[]} }));
await page.route('**/r2.dev/**', r => r.fulfill({ status:200, contentType:'image/png', body: png1 }));
await page.goto('http://localhost:8199/index.html', { waitUntil:'domcontentloaded' });
await page.waitForTimeout(1200);
// sitet har html{scroll-behavior:smooth} → scrollTo animerer; slå det fra, så
// screenshots ikke tages midt i en scroll (gav "sorte bånd" = umalet område)
await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });

// 1) kilder
const srcs = await page.$$eval('#videoStage video source', els => els.map(e => e.getAttribute('src')));
t('vid1 (hero) = three.mp4', /\/three\.mp4$/.test(srcs[0]||''));
t('vid2 (story) = DJI_20250503120750_0017_D%20(1).mp4', /\/DJI_20250503120750_0017_D%20\(1\)\.mp4$/.test(srcs[1]||''));

// 2) filter-strategi: INGEN backdrop-filter på overlayet, blur på selve videoen
const ov = await page.$$eval('#vs1 .video-overlay', els => els.map(el => { const s=getComputedStyle(el); return { bf: s.backdropFilter || s.webkitBackdropFilter, bg: s.backgroundImage, size: s.backgroundSize, pos: s.backgroundPosition }; }));
t('hero-overlay har ingen backdrop-filter', ov.every(o => !o.bf || o.bf==='none'), ov.map(o=>o.bf).join(' | '));
t('hero-overlay er gradient', ov.every(o => /gradient/.test(o.bg)));
t('hero-halvdele: gradient strakt over 150vh, b forskudt -75vh', ov.length===2 && ov.every(o => o.size.split(', ').every(s => s===`100% ${H*1.5}px`)) && ov[0].pos.split(', ').every(p => p==='0px 0px') && ov[1].pos.split(', ').every(p => p===`0px ${-H*0.75}px`), ov.map(o=>o.size+' @ '+o.pos).join(' | '));
const ov2 = await page.$$eval('#vs2 .video-overlay', els => els.map(el => { const s=getComputedStyle(el); return { bf: s.backdropFilter || s.webkitBackdropFilter, bg: s.backgroundImage }; }));
t('story-overlay har ingen backdrop-filter', ov2.every(o => !o.bf || o.bf==='none'), ov2.map(o=>o.bf).join(' | '));
t('story-overlay er retnings-gradient (begge halvdele)', ov2.length===2 && ov2.every(o => /90deg/.test(o.bg)));
const vf = await page.$$eval('#videoStage video', els => els.map(e => getComputedStyle(e).filter));
t('begge videoer har blur(2px)-filter', vf.length===2 && vf.every(f => /blur\(2px\)/.test(f)), vf.join(' | '));
t('cart-backdrop beholder sin blur (uændret)', await page.$eval('.cart-backdrop', el => /blur/.test(getComputedStyle(el).backdropFilter||'')).catch(()=>true));

// 3) geometri: dækker overlayet HELE skærmen i alle scroll-positioner (ingen synlig kant)?
const vh = await page.evaluate(()=>window.innerHeight);
const stageH = await page.evaluate(()=>document.getElementById('videoStage').offsetHeight);
const cssPin = await page.evaluate(()=>CSS.supports('animation-timeline: scroll()'));
t('Chromium kører CSS scroll-pin (samme mekanisme som iOS 17+)', cssPin);
// 3a) overlayet er delt i to halvdele (iOS tiler malede lag > 1280px) — hver
//     halvdel skal være under 1024px selv på den højeste iPhone (956pt), og
//     de skal mødes uden hul og uden overlap
const halves = await page.evaluate(()=>['#vs1','#vs2'].map(s=>{
  const els=[...document.querySelectorAll(s+' .video-overlay')].map(e=>{const r=e.getBoundingClientRect(); return {cls:e.className, top:r.top, bottom:r.bottom, h:r.height};});
  return els;
}));
for (const [i,els] of halves.entries()) {
  t(`vs${i+1}: to overlay-halvdele (.ov-a + .ov-b)`, els.length===2 && /ov-a/.test(els[0].cls) && /ov-b/.test(els[1].cls), els.map(e=>e.cls).join(' , '));
  if (els.length===2) {
    t(`vs${i+1}: halvdele mødes præcist (a.bund = b.top)`, Math.abs(els[0].bottom-els[1].top) < 0.6, `${els[0].bottom.toFixed(1)} vs ${els[1].top.toFixed(1)}`);
    t(`vs${i+1}: hver halvdel ≤ 1024px ved 956pt-skærm (75lvh)`, els.every(e => e.h/vh <= 0.751 && e.h/vh >= 0.749), els.map(e=>(e.h/vh).toFixed(3)+'vh').join(' '));
  }
}
for (const frac of [0, 0.25, 0.5, 0.9, 1.2, 1.6, 2.2]) {
  const y = Math.round(vh*frac);
  await page.evaluate(y=>window.scrollTo(0,y), y); await page.waitForTimeout(250);
  const r = await page.evaluate(()=>{
    const u = s => { const rs=[...document.querySelectorAll(s+' .video-overlay')].map(e=>e.getBoundingClientRect()); return { top: Math.min(...rs.map(r=>r.top)), bottom: Math.max(...rs.map(r=>r.bottom)) }; };
    const o1=u('#vs1'), o2=u('#vs2');
    return { top1:o1.top, bot1:o1.bottom, top2:o2.top, bot2:o2.bottom, sy:window.scrollY };
  });
  const inStage = r.sy < stageH - vh;
  const ok = !inStage || (r.top1 <= 0 && r.bot1 >= vh && r.top2 <= 0 && r.bot2 >= vh);
  t(`overlay dækker viewport ved scroll ${frac}vh`, ok, `top ${Math.round(r.top1)} / bund ${Math.round(r.bot1)}${inStage?'':' (uden for stage)'}`);
}

// 4) pixel-test: lys baggrund bag overlayet, skjul tekst — så ses kun gradienten.
//    Et hårdt "søm" ville give et stort spring mellem to nabo-rækker.
await page.addStyleTag({ content: `
  #videoStage .video-section { background:#ffffff !important; }
  .hero-content, .scroll-hint, .text-block, header, nav, .site-header, .nav, .topbar { visibility:hidden !important; }
` });
async function shot(name, activeSel, hiddenSel, scrollY){
  await page.evaluate(([a,h])=>{ document.querySelectorAll(a).forEach(e=>e.style.opacity='1'); document.querySelectorAll(h).forEach(e=>e.style.opacity='0'); }, [activeSel, hiddenSel]);
  await page.evaluate(y=>window.scrollTo(0,y), scrollY); await page.waitForTimeout(350);
  const buf = await page.screenshot({ path: name });
  return decodePng(buf);
}
const hero0 = await shot('vid-hero.png', '#vs1 .video-overlay', '#vs2 .video-overlay', 0);
// x=W-50: til venstre for "10% RABAT"-fanen i højre kant (den er ikke en del af overlayet)
for (const x of [8, Math.round(W/2), W-50]) {
  const c = column(hero0, x);
  t(`hero: ingen søm i kolonne x=${x} (maks spring ${c.maxJump.toFixed(1)} ved y=${c.at})`, c.maxJump <= 4);
}
{ const c = column(hero0, Math.round(W/2));
  const top=c.L[10], mid=c.L[Math.round(H*0.5)], bot=c.L[H-10];
  t('hero: mørkest i top og bund, lysest på midten', top < mid && bot < mid, `top ${top.toFixed(0)} mid ${mid.toFixed(0)} bund ${bot.toFixed(0)}`);
  // "lidt for mørk" → målet var ca. 25 % lysere end før (før: top ≈ 0.68+ → ~70 lum på hvid)
  t('hero: midten er ikke for mørk (lum > 150 på hvid baggrund)', mid > 150, mid.toFixed(0));
}
const heroMid = await shot('vid-hero-scrolled.png', '#vs1 .video-overlay', '#vs2 .video-overlay', Math.round(vh*0.45));
{ const c = column(heroMid, Math.round(W/2)); t(`hero scrollet 45 %: ingen søm (maks spring ${c.maxJump.toFixed(1)})`, c.maxJump <= 4); }
const story = await shot('vid-story.png', '#vs2 .video-overlay', '#vs1 .video-overlay', Math.round(vh*1.3));
{ const c = column(story, 8), c2 = column(story, W-50);
  t(`story: ingen søm venstre (maks spring ${c.maxJump.toFixed(1)})`, c.maxJump <= 4);
  t(`story: ingen søm højre (maks spring ${c2.maxJump.toFixed(1)})`, c2.maxJump <= 4);
  const l=c.L[Math.round(H*0.5)], r=c2.L[Math.round(H*0.5)];
  t('story: mørkere i venstre side end højre (tekst-side)', l < r-20, `v ${l.toFixed(0)} h ${r.toFixed(0)}`);
}

console.log(T.join('\n'));
const f=T.filter(x=>x.startsWith('FAIL')).length;
console.log(`\n${T.length-f}/${T.length} PASS`);
await browser.close();
process.exit(f?1:0);
