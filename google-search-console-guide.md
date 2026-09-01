# Google Search Console — opsætning for quartzmolle.dk

Alt hvad Cowork skal bruge for at få Quartz Mølle indekseret korrekt i Google.

## Filer i dette repo (allerede på plads)
- **sitemap.xml** — 15 offentlige sider (forside, shop, om, forhandlere + 11 produkter).
  Ligger på https://www.quartzmolle.dk/sitemap.xml
- **robots.txt** — tillader crawl af alt offentligt, peger på sitemap'et, og
  udleverer bevidst IKKE de interne sider (admin/locker/fufill/erhverv). De er
  holdt ude af Google med `noindex` i sidernes <meta> + X-Robots-Tag-header.

## Trin i Google Search Console (https://search.google.com/search-console)

### 1. Vælg det rigtige property
Brug **Domain property** = `quartzmolle.dk` (dækker både www og uden-www, http og https).
Alternativt et **URL-prefix property** = `https://www.quartzmolle.dk/`.
Anbefaling: Domain property.

### 2. Verificér ejerskab (kun første gang)
Domain property kræver en **DNS TXT-record**. GSC viser en linje i stil med:
`google-site-verification=xxxxxxxxxxxxxxxxxxxx`
Den skal tilføjes som en TXT-record hos domæne-udbyderen (der hvor
quartzmolle.dk er registreret). Når den er lagt ind → tryk "Verify".

(Hvis I hellere vil bruge URL-prefix: så kan verifikation ske med en HTML-fil
eller en <meta>-tag i forsidens <head> i stedet — sig til, så lægger jeg den ind.)

### 3. Indsend sitemap
Menu → **Sitemaps** → skriv den FULDE adresse i feltet → **Send**:

    https://www.quartzmolle.dk/sitemap.xml

(Et Domain property dækker både www, uden www, http og https, så GSC afviser
den korte form `sitemap.xml` med "Invalid sitemap address".)
Status skal ende på "Lykkedes" / "Success" med 15 opdagede URL'er. Lige efter
indsendelse står den typisk på "Couldn't fetch" med tom "Last read" i op til
et par dage — det er normal ventetid, ikke en fejl.

### 4. Bed om indeksering af forsiden (valgfrit, fremskynder)
Menu → **URL-inspektion** → indsæt `https://www.quartzmolle.dk/` →
**Anmod om indeksering**. Kan gentages for /shop og vigtige produktsider.

### 5. Tjek at de interne sider IKKE indekseres
Under **Sider → Ikke indekseret** bør admin/locker/fufill/erhverv stå som
"Udelukket af 'noindex'-tag" — det er meningen og helt korrekt.

## Vigtigt om domænet
Sitemap'et bruger **www.quartzmolle.dk** som kanonisk domæne. `vercel.json`
indeholder nu et 308-redirect fra `quartzmolle.dk` (uden www) til www på alle
sider (undtagen `/api/*`, så Stripe-webhooken og skab-tabletten ikke rammes).
Det kan desuden sættes i Vercel: Project → Settings → Domains → www som
primær + "Redirect to www" på apex — begge dele må gerne være slået til.
Alle offentlige sider har `<link rel="canonical">` (produktsiden sætter den
fra JS ud fra id'et).

## Hvad Cowork konkret skal gøre
1. Åbn Google Search Console for quartzmolle.dk (opret Domain property hvis den mangler).
2. Verificér med DNS TXT-record (fås inde i GSC).
3. Indsend sitemap med fuld adresse: `https://www.quartzmolle.dk/sitemap.xml`.
4. Anmod om indeksering af forsiden.
Det er alt — Google henter selv resten fra sitemap'et løbende.
