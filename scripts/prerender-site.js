/**
 * Prerender publicznych stron (Hosting targety `kurs` i `www`) — predeploy w firebase.json.
 *
 * Kopiuje site_<target>/ do .build/site_<target>/, pobiera GET /api/public/site i wykonuje
 * skrypt strony (kurs.js / www.js) w Node (linkedom, window.__PRERENDER__), więc HTML
 * wysłany botom ma już ceny, daty, harmonogram, imprezy i kontakt. W przeglądarce skrypt
 * i tak odświeża dane. Dokłada też JSON-LD, sitemap.xml i llms.txt.
 * Źródła w repo nie zawierają liczb ani dat.
 *
 * Uwaga: zmiana Vars_KURS / imprez → redeploy targetu, żeby wersja dla botów była aktualna.
 *
 * Użycie: node scripts/prerender-site.js kurs|www
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {parseHTML} = require("linkedom");

const ROOT = path.join(__dirname, "..");
const API = "https://app.morzkulc.pl/api/public/site";
const CLUB_URL = "https://morzkulc.pl";
const MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];

const TARGETS = {
  kurs: {
    src: "site_kurs",
    out: ".build/site_kurs",
    base: "https://kurs.morzkulc.pl",
    script: "kurs.js",
    hook: "__kursApply",
    pages: [
      {file: "index.html", path: "/", jsonld: kursIndexJsonLd},
      {file: "poznaj.html", path: "/poznaj", jsonld: orgOnlyJsonLd},
    ],
    sitemap: ["/", "/poznaj", "/regulamin"],
    llms: kursLlms,
  },
  www: {
    src: "site_www",
    out: ".build/site_www",
    base: CLUB_URL,
    script: "www.js",
    hook: "__siteApply",
    pages: [
      {file: "index.html", path: "/", jsonld: wwwJsonLd},
    ],
    sitemap: ["/"],
    llms: wwwLlms,
  },
};

function fail(msg) {
  console.error("[prerender] BŁĄD: " + msg);
  process.exit(1);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, {recursive: true});
  for (const e of fs.readdirSync(src, {withFileTypes: true})) {
    if (e.name.startsWith(".") || e.name === "README.md") continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const fmtDate = (iso) => {
  const [y, m, d] = String(iso).split("-").map(Number);
  return d + " " + MONTHS[m - 1] + " " + y;
};
const pln = (n) => Number(n).toLocaleString("pl-PL") + " zł";

function organization(data) {
  const org = {
    "@type": ["SportsOrganization", "NGO"],
    "@id": CLUB_URL + "/#org",
    "name": "SKK Morzkulc",
    "url": CLUB_URL,
    "logo": CLUB_URL + "/img/logo.jpg",
    "description": "Klub kajakowy z Gdańska: kajakarstwo morskie, górskie i nizinne, coroczny kurs kajakarstwa.",
    "sport": "Kajakarstwo",
    "areaServed": "Trójmiasto",
    "email": "prezes@morzkulc.pl",
    "taxID": "9571173709",
    "identifier": [
      {"@type": "PropertyValue", "propertyID": "KRS", "value": "0000297900"},
      {"@type": "PropertyValue", "propertyID": "REGON", "value": "528688909"},
    ],
  };
  const m = /^(.*?),\s*(\d{2}-\d{3})\s+(.+)$/.exec(norm(data.adres));
  if (m) {
    org.address = {"@type": "PostalAddress", "streetAddress": m[1], "postalCode": m[2], "addressLocality": m[3], "addressCountry": "PL"};
  }
  const soc = data.social || {};
  const sameAs = [soc.facebook, soc.instagram, soc.kurs].filter(Boolean);
  if (sameAs.length) org.sameAs = sameAs;
  return org;
}

function orgOnlyJsonLd(data) {
  return {"@context": "https://schema.org", "@graph": [organization(data)]};
}

function wwwJsonLd(data) {
  return {"@context": "https://schema.org", "@graph": [
    organization(data),
    {"@type": "WebSite", "@id": CLUB_URL + "/#site", "url": CLUB_URL + "/", "name": "SKK Morzkulc", "inLanguage": "pl", "publisher": {"@id": CLUB_URL + "/#org"}},
  ]};
}

function kursIndexJsonLd(data, document, cfg) {
  const k = data.kurs || {};
  const h = k.harmonogram || [];
  const graph = [organization(data)];

  const course = {
    "@type": "Course",
    "@id": cfg.base + "/#kurs",
    "name": norm("Kurs Kajakarstwa Górskiego i Morskiego " + (k.edycja || "")),
    "description": norm(document.querySelector("meta[name=description]")?.getAttribute("content")),
    "url": cfg.base + "/",
    "inLanguage": "pl",
    "provider": {"@id": CLUB_URL + "/#org"},
  };
  const inCourse = h.filter((x) => x.type !== "po_kursie");
  const start = k.start || (h[0] && h[0].from);
  if (start) {
    const end = inCourse.map((x) => x.to || x.from).sort().pop();
    course.hasCourseInstance = {
      "@type": "CourseInstance",
      "courseMode": "Onsite",
      "startDate": start,
      ...(end ? {"endDate": end} : {}),
      "location": {"@type": "Place", "name": "Gdańsk i Trójmiasto"},
    };
  }
  if (k.cena) {
    const availability = {otwarte: "InStock", rezerwowa: "LimitedAvailability", wkrotce: "PreOrder", zamkniete: "SoldOut"}[k.zapisyStatus];
    course.offers = {
      "@type": "Offer",
      "category": "Paid",
      "price": k.cena,
      "priceCurrency": "PLN",
      "url": cfg.base + "/#cena",
      ...(availability ? {"availability": "https://schema.org/" + availability} : {}),
    };
  }
  graph.push(course);

  const faq = Array.from(document.querySelectorAll(".faq details")).map((d) => ({
    "@type": "Question",
    "name": norm(d.querySelector("summary")?.textContent),
    "acceptedAnswer": {"@type": "Answer", "text": norm(d.querySelector("p")?.textContent)},
  })).filter((q) => q.name && q.acceptedAnswer.text);
  if (faq.length) graph.push({"@type": "FAQPage", "@id": cfg.base + "/#faq", "mainEntity": faq});

  return {"@context": "https://schema.org", "@graph": graph};
}

function kursLlms(data, cfg) {
  const k = data.kurs || {};
  const h = k.harmonogram || [];
  const L = [];
  L.push("# SKK Morzkulc — Kurs Kajakarstwa Górskiego i Morskiego" + (k.edycja ? " " + k.edycja : ""));
  L.push("");
  L.push("> Kurs kajakarstwa górskiego i morskiego dla osób pełnoletnich, także bez doświadczenia, prowadzony przez klub kajakowy SKK Morzkulc z Gdańska: wykłady, zajęcia basenowe i weekendowe wyjazdy szkoleniowe. Cały sprzęt w cenie.");
  L.push("");
  if (k.cena) L.push("- Cena: " + pln(k.cena) + (k.cenaMlodzi && k.mlodziWiek ? " (osoby do " + k.mlodziWiek + " roku życia: " + pln(k.cenaMlodzi) + ")" : ""));
  if (k.zadatek) L.push("- Zadatek przy zapisie: " + pln(k.zadatek));
  if (k.start) L.push("- Start kursu: " + fmtDate(k.start));
  const status = {otwarte: "otwarte", wkrotce: "wkrótce" + (k.zapisyOd ? " (od " + fmtDate(k.zapisyOd) + ")" : ""), rezerwowa: "lista rezerwowa", zamkniete: "zamknięte"}[k.zapisyStatus];
  if (status) L.push("- Zapisy: " + status + " — " + cfg.base + "/zapis");
  if (k.limitMiejsc) L.push("- Liczba miejsc: " + k.limitMiejsc);
  if (k.kontaktEmail) L.push("- Kontakt: " + k.kontaktEmail + (k.kontaktTelefon ? ", tel. " + k.kontaktTelefon : ""));
  if (data.adres) L.push("- Adres klubu: " + data.adres);
  if (h.length) {
    L.push("");
    L.push("## Harmonogram");
    for (const x of h) {
      const when = x.to && x.to !== x.from ? fmtDate(x.from) + " – " + fmtDate(x.to) : fmtDate(x.from);
      L.push("- " + when + ": " + x.name + (x.place ? " (" + x.place + ")" : ""));
    }
  }
  L.push("");
  L.push("## Strony");
  L.push("- [Strona kursu](" + cfg.base + "/): program, cena, harmonogram, FAQ");
  L.push("- [Poznaj nas](" + cfg.base + "/poznaj): kim jesteśmy i co dzieje się po kursie");
  L.push("- [Regulamin kursu](" + cfg.base + "/regulamin)");
  L.push("- [Klub SKK Morzkulc](" + CLUB_URL + ")");
  return L.join("\n") + "\n";
}

function wwwLlms(data) {
  const k = data.kurs || {};
  const today = new Date().toISOString().slice(0, 10);
  const L = [];
  L.push("# SKK Morzkulc");
  L.push("");
  L.push("> SKK Morzkulc to klub kajakowy z Gdańska. Pływamy po morzu, rzekach nizinnych i górskich, organizujemy wyjazdy i co roku wiosną prowadzimy kurs kajakarstwa górskiego i morskiego.");
  L.push("");
  if (data.adres) L.push("- Siedziba: " + data.adres);
  L.push("- Kurs kajakarstwa: https://kurs.morzkulc.pl" + (k.edycja ? " (edycja " + k.edycja + (k.start ? ", start " + fmtDate(k.start) : "") + ")" : ""));
  const soc = data.social || {};
  if (soc.facebook) L.push("- Facebook: " + soc.facebook);
  if (soc.instagram) L.push("- Instagram: " + soc.instagram);
  L.push("- Dane rejestrowe: KRS 0000297900, NIP 9571173709, REGON 528688909");
  const zarzad = data.zarzad || [];
  if (zarzad.length) {
    L.push("");
    L.push("## Zarząd i kontakt");
    for (const p of zarzad) L.push("- " + p.funkcja + ": " + p.name + " — " + p.mailbox);
  }
  const events = (data.events || []).filter((e) => (e.endDate || e.startDate) >= today);
  if (events.length) {
    L.push("");
    L.push("## Najbliższe imprezy (stan na " + fmtDate(today) + ")");
    for (const e of events) {
      const when = e.endDate && e.endDate !== e.startDate ? fmtDate(e.startDate) + " – " + fmtDate(e.endDate) : fmtDate(e.startDate);
      L.push("- " + when + ": " + e.name + (e.location ? " (" + e.location + ")" : ""));
    }
  }
  L.push("");
  L.push("## Strony");
  L.push("- [Strona klubu](" + CLUB_URL + "/)");
  L.push("- [Kurs kajakarstwa](https://kurs.morzkulc.pl/): program, cena, harmonogram, FAQ");
  L.push("- [Poznaj nas](https://kurs.morzkulc.pl/poznaj)");
  return L.join("\n") + "\n";
}

function sitemap(cfg) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = cfg.sitemap.map((p) => `  <url><loc>${cfg.base}${p}</loc><lastmod>${today}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

async function main() {
  const name = process.argv[2];
  const cfg = TARGETS[name];
  if (!cfg) fail("nieznany target: " + name + " (dostępne: " + Object.keys(TARGETS).join(", ") + ")");

  const res = await fetch(API + "?b=" + Date.now(), {headers: {"Accept": "application/json"}});
  if (!res.ok) fail(API + " → HTTP " + res.status);
  const data = await res.json();
  if (!data || !data.ok) fail("niepoprawna odpowiedź API");
  if (name === "kurs" && !data.kurs) fail("odpowiedź API bez pola kurs");

  const src = path.join(ROOT, cfg.src);
  const out = path.join(ROOT, cfg.out);
  fs.rmSync(out, {recursive: true, force: true});
  copyDir(src, out);

  const script = fs.readFileSync(path.join(src, cfg.script), "utf8");
  for (const page of cfg.pages) {
    const file = path.join(out, page.file);
    const {document} = parseHTML(fs.readFileSync(file, "utf8"));
    const window = {__PRERENDER__: true};
    vm.runInNewContext(script, {window, document});
    if (typeof window[cfg.hook] !== "function") fail(cfg.script + " nie wystawił " + cfg.hook);
    window[cfg.hook](JSON.parse(JSON.stringify(data)));
    document.documentElement.setAttribute("data-prerendered", "");

    const ld = document.createElement("script");
    ld.setAttribute("type", "application/ld+json");
    ld.textContent = JSON.stringify(page.jsonld(data, document, cfg)).replace(/</g, "\\u003c");
    document.head.appendChild(ld);

    fs.writeFileSync(file, "<!doctype html>\n" + document.documentElement.outerHTML + "\n", "utf8");
    console.log("[prerender] " + cfg.base + page.path + " ✓");
  }

  fs.writeFileSync(path.join(out, "sitemap.xml"), sitemap(cfg), "utf8");
  fs.writeFileSync(path.join(out, "llms.txt"), cfg.llms(data, cfg), "utf8");
  console.log("[prerender] sitemap.xml, llms.txt ✓ → " + cfg.out);
}

main().catch((e) => fail(e && e.stack || String(e)));
