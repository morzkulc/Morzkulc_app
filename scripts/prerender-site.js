/**
 * Prerender publicznych stron (Hosting targety `kurs` i `www`) — predeploy w firebase.json.
 *
 * Kopiuje site_<target>/ do .build/site_<target>/, pobiera GET /api/public/site i wykonuje
 * skrypt strony (kurs.js / www.js) w Node (linkedom, window.__PRERENDER__), więc HTML
 * wysłany botom ma już ceny, daty, harmonogram, imprezy i kontakt. W przeglądarce skrypt
 * i tak odświeża dane. Dokłada też JSON-LD, sitemap.xml i llms.txt.
 * Źródła w repo nie zawierają liczb ani dat.
 *
 * Target `www` jest wielostronicowy: każda podstrona to site_www/pages/<ścieżka>.html
 * (pierwsza linia = komentarz z JSON-em: path, title, description, og, crumbs, jsonld, build, noindex),
 * składana z site_www/_layout.html (menu, okruszki, stopka). sitemap.xml i llms.txt z listy podstron.
 *
 * Uwaga: zmiana Vars_KURS / imprez → redeploy targetu, żeby wersja dla botów była aktualna.
 *
 * Użycie: node scripts/prerender-site.js kurs|www [--extra plik.json]
 * --extra: pola dopisane do odpowiedzi API (podgląd lokalny przed wdrożeniem nowego pola w API).
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {parseHTML} = require("linkedom");
const {pathToFileURL} = require("url");

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
    layout: "_layout.html",
    pagesDir: "pages",
    llms: wwwLlms,
  },
};

function fail(msg) {
  console.error("[prerender] BŁĄD: " + msg);
  process.exit(1);
}

function copyDir(src, dst, skip = []) {
  fs.mkdirSync(dst, {recursive: true});
  for (const e of fs.readdirSync(src, {withFileTypes: true})) {
    if (e.name.startsWith(".") || e.name === "README.md" || skip.includes(e.name)) continue;
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
    "legalName": "Stowarzyszenie Klub Kajakowy Morzkulc",
    "url": CLUB_URL,
    "logo": CLUB_URL + "/img/logo.jpg",
    "description": "Klub kajakowy z Gdańska: kajakarstwo morskie, górskie i nizinne, coroczny kurs kajakarstwa.",
    "sport": "Kajakarstwo",
    "areaServed": "Trójmiasto",
    "email": "zarzad@morzkulc.pl",
    "foundingDate": "1975",
    "taxID": "9571173709",
    "identifier": [
      {"@type": "PropertyValue", "propertyID": "KRS", "value": "0001106300"},
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

// ── Dwie wersje językowe: PL (/) i EN (/en). Strona EN ma w nagłówku "alt" = ścieżka polskiego odpowiednika;
// z tego powstają linki hreflang (w obie strony) i przełącznik języka w menu.
const HOME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 11.5h3V21h5.5v-6h3v6H19v-9.5h3z"/></svg>';
const LANG = {
  pl: {
    home: "/",
    ogLocale: "pl_PL",
    // [href, etykieta]. Mapa „Gdzie pływamy” jest przyciskiem na stronie głównej.
    nav: [["/", HOME_ICON + "<span>Start</span>"], ["/o-nas", "O nas"], ["/dolacz", "Dołącz"], ["/wydarzenia", "Wydarzenia"],
      ["/galeria", "Galeria"], ["/blachy", "Blachy"], ["/wspomnienia", "Wspomnienia"], ["https://kurs.morzkulc.pl", "Kurs"], ["/kontakt", "Kontakt"]],
    foot: [["/kontakt", "Kontakt"], ["/baza-wiedzy", "Baza wiedzy"], ["/wydarzenia/archiwum", "Archiwum"],
      ["/rzutki", "Rzutki"], ["/dokumenty", "Dokumenty"], ["/polityka-prywatnosci", "Polityka prywatności"],
      ["https://kurs.morzkulc.pl", "kurs.morzkulc.pl"], ["https://app.morzkulc.pl", "Aplikacja klubowa"]],
    t: {SKIP: "Przejdź do treści", HOME_LABEL: "SKK Morzkulc — strona główna", MENU_LABEL: "Menu główne", FOOT_LABEL: "Stopka",
      TAGLINE: "klub kajakowy z Gdańska od 1975 roku", CRUMBS: "Okruszki", ROOT: "Start", SWITCH: "EN", SWITCH_LABEL: "English version"},
  },
  en: {
    home: "/en",
    ogLocale: "en_GB",
    nav: [["/en", HOME_ICON + "<span>Home</span>"], ["/en/about", "About"], ["/en/join", "Join"], ["/en/events", "Events"],
      ["/en/gallery", "Gallery"], ["/en/club-badges", "Club Badges"], ["/en/memories", "Memories"], ["https://kurs.morzkulc.pl", "Course"], ["/en/contact", "Contact"]],
    foot: [["/en/contact", "Contact"], ["/en/safety", "Safety"], ["/en/events/archive", "Archive"],
      ["/en/links", "Links"], ["/en/documents", "Documents"], ["/en/privacy", "Privacy"],
      ["https://kurs.morzkulc.pl", "kurs.morzkulc.pl (PL)"], ["https://app.morzkulc.pl", "Club app"]],
    t: {SKIP: "Skip to content", HOME_LABEL: "SKK Morzkulc — home", MENU_LABEL: "Main menu", FOOT_LABEL: "Footer",
      TAGLINE: "kayaking club from Gdańsk since 1975", CRUMBS: "Breadcrumbs", ROOT: "Home", SWITCH: "PL", SWITCH_LABEL: "Wersja polska"},
  },
};
const langOf = (meta) => (meta.lang === "en" ? "en" : "pl");
const pageUrl = (p) => CLUB_URL + (p === "/" ? "/" : p);

// JSON-LD podstrony www: organizacja + WebPage + okruszki; strona główna dokłada WebSite, /wydarzenia — Event.
function wwwPageJsonLd(data, meta, document) {
  const L = LANG[langOf(meta)];
  const url = pageUrl(meta.path);
  const inLanguage = langOf(meta);
  const graph = [organization(data)];
  if (meta.path === L.home) {
    graph.push({"@type": "WebSite", "@id": CLUB_URL + "/#site", "url": CLUB_URL + "/", "name": "SKK Morzkulc", "inLanguage": ["pl", "en"], "publisher": {"@id": CLUB_URL + "/#org"}});
  }
  graph.push({"@type": "WebPage", "@id": url + "#page", "url": url, "name": meta.title, "description": meta.description, "inLanguage": inLanguage,
    "isPartOf": {"@id": CLUB_URL + "/#site"}, "about": {"@id": CLUB_URL + "/#org"}});
  if (meta.crumbs && meta.crumbs.length) {
    const items = [[L.t.ROOT, L.home], ...meta.crumbs];
    graph.push({"@type": "BreadcrumbList", "itemListElement": items.map(([name, p], i) => ({"@type": "ListItem", "position": i + 1, "name": name, "item": pageUrl(p)}))});
  }
  // Film na stronie (O nas) → VideoObject. Data publikacji = utworzenie pliku w Storage (05.09.2026).
  const film = document.querySelector("video.js-film[src]");
  if (film) {
    graph.push({"@type": "VideoObject", "name": film.getAttribute("data-name"), "description": film.getAttribute("data-description"),
      "thumbnailUrl": CLUB_URL + "/img/foto8.jpg", "uploadDate": "2026-09-05", "duration": "PT6M2S", "contentUrl": film.getAttribute("src"),
      "inLanguage": "pl", "publisher": {"@id": CLUB_URL + "/#org"}});
  }
  if (meta.jsonld === "faq") {
    const faq = Array.from(document.querySelectorAll(".faq details")).map((d) => ({
      "@type": "Question",
      "name": norm(d.querySelector("summary")?.textContent),
      "acceptedAnswer": {"@type": "Answer", "text": norm(d.querySelector("p")?.textContent)},
    })).filter((q) => q.name && q.acceptedAnswer.text);
    if (faq.length) graph.push({"@type": "FAQPage", "@id": url + "#faq", "mainEntity": faq});
  }
  if (meta.jsonld === "events") {
    const today = new Date().toISOString().slice(0, 10);
    for (const e of (data.events || []).filter((x) => (x.endDate || x.startDate) >= today)) {
      graph.push({"@type": "Event", "name": e.name, "startDate": e.startDate, ...(e.endDate ? {"endDate": e.endDate} : {}),
        "eventStatus": "https://schema.org/EventScheduled", "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
        "location": {"@type": "Place", "name": e.location || "Polska", "address": e.location || "Polska"},
        "organizer": {"@id": CLUB_URL + "/#org"}});
    }
  }
  return {"@context": "https://schema.org", "@graph": graph};
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function navHtml(meta, altPath) {
  const L = LANG[langOf(meta)];
  const p = meta.path;
  const links = L.nav.map(([href, label]) => {
    const cur = href === L.home ? p === L.home : href.startsWith("/") && (p === href || p.startsWith(href + "/"));
    const attrs = (cur ? " aria-current=\"page\"" : "") + (href === L.home ? " class=\"navHome\"" : "");
    return `<a href="${href}"${attrs}>${label}</a>`;
  });
  const other = langOf(meta) === "en" ? LANG.pl : LANG.en;
  links.push(`<a class="navLang" href="${altPath || other.home}" hreflang="${langOf(meta) === "en" ? "pl" : "en"}" aria-label="${L.t.SWITCH_LABEL}">${L.t.SWITCH}</a>`);
  return links.join("\n      ");
}

function footNavHtml(meta) {
  return LANG[langOf(meta)].foot.map(([href, label]) => `<a href="${href}">${label}</a>`).join("\n      ");
}

function crumbsHtml(meta) {
  if (!meta.crumbs || !meta.crumbs.length) return "";
  const L = LANG[langOf(meta)];
  const items = [[L.t.ROOT, L.home], ...meta.crumbs];
  const li = items.map(([name, p], i) => i === items.length - 1 ?
    `<li aria-current="page">${esc(name)}</li>` : `<li><a href="${p}">${esc(name)}</a></li>`).join("");
  return `<nav class="crumbs wrap" aria-label="${L.t.CRUMBS}"><ol>${li}</ol></nav>`;
}

function hreflangHtml(meta, altPath) {
  if (meta.noindex || !altPath) return "";
  const pl = langOf(meta) === "pl" ? meta.path : altPath;
  const en = langOf(meta) === "en" ? meta.path : altPath;
  return [`<link rel="alternate" hreflang="pl" href="${pageUrl(pl)}">`, `<link rel="alternate" hreflang="en" href="${pageUrl(en)}">`,
    `<link rel="alternate" hreflang="x-default" href="${pageUrl(pl)}">`].join("\n");
}

// Wszystkie pliki site_www/pages/**/*.html → [{meta, body}].
function readPages(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), {withFileTypes: true})) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) {
      out.push(...readPages(dir, r));
      continue;
    }
    if (!e.name.endsWith(".html")) continue;
    const raw = fs.readFileSync(path.join(dir, r), "utf8");
    const m = /^<!--(\{[\s\S]*?\})-->\s*/.exec(raw);
    if (!m) fail("brak nagłówka JSON w pages/" + r);
    const meta = JSON.parse(m[1]);
    if (!meta.path || !meta.title || !meta.description) fail("pages/" + r + ": wymagane path, title, description");
    out.push({meta, body: raw.slice(m[0].length)});
  }
  return out.sort((a, b) => a.meta.path.localeCompare(b.meta.path));
}

const outFileFor = (p) => (p === "/" ? "index.html" : p.slice(1) + ".html");

// Treści składane przy buildzie z kodu aplikacji (jedno źródło).
const BUILDERS = {
  async regulaminBasenu(document) {
    const mod = await import(pathToFileURL(path.join(ROOT, "public/modules/basen_regulamin.js")).href);
    const box = document.querySelector(".js-regulamin-basenu");
    box.innerHTML = mod.renderRegulaminHtml();
    const h2 = box.querySelector("h2");
    if (h2) {
      const h1 = document.createElement("h1");
      h1.textContent = h2.textContent;
      h2.replaceWith(h1);
    }
  },
};

async function buildLayoutSite(cfg, data, script, src, out) {
  const layout = fs.readFileSync(path.join(src, cfg.layout), "utf8");
  const pages = readPages(path.join(src, cfg.pagesDir));
  // Odpowiedniki językowe: EN deklaruje "alt" (ścieżka PL), PL dostaje odwrotne przypisanie.
  const paths = new Set(pages.map((p) => p.meta.path));
  const alt = {};
  for (const {meta} of pages) {
    if (langOf(meta) !== "en" || !meta.alt) continue;
    if (!paths.has(meta.alt)) fail(meta.path + ": alt " + meta.alt + " nie istnieje");
    alt[meta.path] = meta.alt;
    alt[meta.alt] = meta.path;
  }
  for (const {meta, body} of pages) {
    const L = LANG[langOf(meta)];
    const url = pageUrl(meta.path);
    let html = layout
      .replace(/\{\{TITLE\}\}/g, esc(meta.title))
      .replace(/\{\{DESCRIPTION\}\}/g, esc(meta.description))
      .replace(/\{\{URL\}\}/g, url)
      .replace("{{LANG}}", langOf(meta))
      .replace("{{OG_LOCALE}}", L.ogLocale)
      .replace("{{HREFLANG}}", hreflangHtml(meta, alt[meta.path]))
      .replace("{{HOME}}", L.home)
      .replace(/\{\{T_([A-Z_]+)\}\}/g, (m, k) => L.t[k] ?? m)
      .replace("{{OG_IMAGE}}", esc(meta.og || "hero.jpg"))
      .replace("{{PAGE}}", esc(meta.path))
      .replace("{{NAV}}", navHtml(meta, alt[meta.path]))
      .replace("{{FOOT_NAV}}", footNavHtml(meta))
      .replace("{{CRUMBS}}", crumbsHtml(meta))
      .replace("{{BODY}}", () => body);
    if (/\{\{[A-Z_]+\}\}/.test(html.replace(body, ""))) fail(meta.path + ": niewypełniony znacznik szablonu");
    // Zdjęcie w nagłówku strony głównej = LCP — przeglądarka pobiera je od razu (Lighthouse: prioritize-lcp-image).
    if (meta.preload) html = html.replace("<link rel=\"icon\"", `<link rel="preload" as="image" href="/img/${esc(meta.preload)}" fetchpriority="high">
<link rel="icon"`);
    if (meta.noindex) html = html.replace("<link rel=\"canonical\"", "<meta name=\"robots\" content=\"noindex\">\n<link rel=\"canonical\"");
    const {document} = parseHTML(html);
    if (meta.build) {
      if (!BUILDERS[meta.build]) fail("nieznany build: " + meta.build);
      await BUILDERS[meta.build](document);
    }
    const window = {__PRERENDER__: true};
    vm.runInNewContext(script, {window, document});
    if (typeof window[cfg.hook] !== "function") fail(cfg.script + " nie wystawił " + cfg.hook);
    window[cfg.hook](JSON.parse(JSON.stringify(data)));
    document.documentElement.setAttribute("data-prerendered", "");
    // Strona kursu to osobny serwis — zawsze w nowej karcie (decyzja usera 01.11.2026).
    for (const a of document.querySelectorAll("a[href^=\"https://kurs.morzkulc.pl\"]")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    }
    if (!meta.noindex) {
      const ld = document.createElement("script");
      ld.setAttribute("type", "application/ld+json");
      ld.textContent = JSON.stringify(wwwPageJsonLd(data, meta, document)).replace(/</g, "\\u003c");
      document.head.appendChild(ld);
    }
    const file = path.join(out, outFileFor(meta.path));
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, "<!doctype html>\n" + document.documentElement.outerHTML + "\n", "utf8");
    console.log("[prerender] " + url + " ✓");
  }
  return pages.filter((p) => !p.meta.noindex).map((p) => p.meta);
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

function wwwLlms(data, cfg, pages) {
  const k = data.kurs || {};
  const s = data.stats || null;
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
  L.push("- Dane rejestrowe: Stowarzyszenie Klub Kajakowy Morzkulc, KRS 0001106300, NIP 9571173709, REGON 528688909");
  L.push("- Klub działa od 1975 roku (założony przy Politechnice Gdańskiej)");
  if (s) {
    L.push("- Aktywni członkowie: " + s.czlonkowie);
    if (s.kajaki && s.kajaki.razem) L.push("- Kajaki klubowe: " + s.kajaki.razem + " (górskie " + s.kajaki.gorskie + ", nizinne " + s.kajaki.nizinne + ", morskie " + s.kajaki.morskie + ", freestyle " + s.kajaki.freestyle + ", kanadyjki " + s.kajaki.kanadyjki + ")");
  }
  if (data.basen && data.basen.ruszyl) L.push("- Sezon basenowy trwa (Relaxcenter, Gdynia)" + (data.basen.terminy.length ? ", najbliższy termin " + fmtDate(data.basen.terminy[0]) : ""));
  if (data.miejsca && data.miejsca.length) L.push("- Najczęściej pływamy: " + data.miejsca.slice(0, 12).map((m) => m.nazwa).join(", "));
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
  const line = (p) => "- [" + p.title + "](" + pageUrl(p.path) + "): " + p.description;
  for (const p of (pages || []).filter((x) => langOf(x) === "pl")) L.push(line(p));
  L.push("- [Kurs kajakarstwa](https://kurs.morzkulc.pl/): program, cena, harmonogram, FAQ");
  L.push("- [Poznaj nas](https://kurs.morzkulc.pl/poznaj)");
  const en = (pages || []).filter((x) => langOf(x) === "en");
  if (en.length) {
    L.push("");
    L.push("## English pages");
    L.push("SKK Morzkulc is a kayaking club from Gdańsk, Poland, active since 1975: whitewater, sea and lowland kayaking, a yearly kayaking course, trips and winter pool training.");
    for (const p of en) L.push(line(p));
  }
  return L.join("\n") + "\n";
}

function sitemap(cfg, paths) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = paths.map((p) => `  <url><loc>${cfg.base}${p}</loc><lastmod>${today}</lastmod></url>`);
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
  const extraAt = process.argv.indexOf("--extra");
  if (extraAt > 0) {
    Object.assign(data, JSON.parse(fs.readFileSync(process.argv[extraAt + 1], "utf8")));
    console.log("[prerender] UWAGA: dane uzupełnione z " + process.argv[extraAt + 1] + " (tylko podgląd)");
  }
  if (name === "kurs" && !data.kurs) fail("odpowiedź API bez pola kurs");

  const src = path.join(ROOT, cfg.src);
  const out = path.join(ROOT, cfg.out);
  // Czyścimy zawartość, nie sam katalog: na Windows katalog otwarty przez inny proces (np. podgląd) nie da się usunąć.
  fs.mkdirSync(out, {recursive: true});
  for (const e of fs.readdirSync(out)) fs.rmSync(path.join(out, e), {recursive: true, force: true});
  copyDir(src, out, cfg.layout ? [cfg.layout, cfg.pagesDir] : []);

  const script = fs.readFileSync(path.join(src, cfg.script), "utf8");
  if (cfg.layout) {
    const pages = await buildLayoutSite(cfg, data, script, src, out);
    fs.writeFileSync(path.join(out, "sitemap.xml"), sitemap(cfg, pages.map((p) => p.path)), "utf8");
    fs.writeFileSync(path.join(out, "llms.txt"), cfg.llms(data, cfg, pages), "utf8");
    console.log("[prerender] sitemap.xml, llms.txt ✓ → " + cfg.out);
    return;
  }
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

  fs.writeFileSync(path.join(out, "sitemap.xml"), sitemap(cfg, cfg.sitemap), "utf8");
  fs.writeFileSync(path.join(out, "llms.txt"), cfg.llms(data, cfg), "utf8");
  console.log("[prerender] sitemap.xml, llms.txt ✓ → " + cfg.out);
}

main().catch((e) => fail(e && e.stack || String(e)));
