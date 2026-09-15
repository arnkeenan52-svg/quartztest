// Etiket-billeder i checkout, erhvervsportal og admin — aldrig posefotoet.
import { CATALOG, buildPriceMap, labelImage, LABEL_IMAGES } from './api/_catalog.js';
import fs from 'node:fs';
const T=[]; const t=(n,c,x)=>T.push(`${c?'PASS':'FAIL'}  ${n}${x?'  ('+x+')':''}`);

const keys = Object.keys(buildPriceMap());
t('alle varer har en etiket', keys.every(k=>{const [id,l]=k.split('|'); return !!labelImage(id,l);}), `${keys.length} varer`);
t('ingen etiket er et posefoto', Object.values(LABEL_IMAGES).every(v=>!/pose-/.test(v)));
t('alle etiketfiler findes', Object.values(LABEL_IMAGES).every(v=>fs.existsSync(v)), `${Object.keys(LABEL_IMAGES).length} filer`);
t('etiket matcher vægten', labelImage('rug-fuldkorn','11 kg').includes('11Kg') && labelImage('rug-fuldkorn','3 kg').includes('3Kg'));
t('ukendt vægt falder tilbage til produktets egen etiket', labelImage('spelt-fuldkorn','x').includes('Spelt'));
t('ukendt vare giver null', labelImage('findes-ikke','3 kg')===null);

// kildekoden må ikke sende posefotos videre
for (const [f,navn] of [['api/checkout.js','checkout'],['api/b2b.js','erhvervsportal']]) {
  const s=fs.readFileSync(f,'utf8');
  t(`${navn}: bruger labelImage()`, /labelImage\(/.test(s));
  t(`${navn}: ingen pose-referencer`, !/pose-/.test(s));
}
const ao=fs.readFileSync('api/admin-order.js','utf8');
t('admin: reservebillede er etiketter', !/pose-/.test(ao));
t('admin: Blå hvede har reservebillede', /bla(a|å) ?hvede/i.test(ao));

console.log(T.join('\n')); const f=T.filter(x=>x.startsWith('FAIL')).length;
console.log(`\n${T.length-f}/${T.length} PASS`); process.exit(f?1:0);
