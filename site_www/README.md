# morzkulc.pl

Strona klubu. Firebase Hosting, projekt `morzkulc-e9df7`, site `morzkulc-klub`, target `www`.

- Deploy: `firebase deploy --only hosting:www --project morzkulc-e9df7`
- predeploy `scripts/prerender-site.js www` wypełnia HTML danymi z `/api/public/site` → `.build/site_www`; postdeploy pinguje IndexNow.
- Imprezy w wersji dla botów są aktualne na dzień deployu; przeglądarka zawsze pobiera je na żywo.
- Adres techniczny: https://morzkulc-klub.web.app
