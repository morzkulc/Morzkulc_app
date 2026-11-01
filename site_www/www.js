// Strona klubu (morzkulc.pl): wszystkie podstrony wypełniane danymi na żywo z aplikacji
// (GET /api/public/site): imprezy, zarząd, adres, socjale, liczby, Blachy, basen.
// Przy deployu scripts/prerender-site.js wykonuje ten plik w Node (window.__PRERENDER__)
// i zapisuje wypełniony HTML (boty bez JS widzą treść); przeglądarka zawsze pobiera dane na nowo.
// Każda funkcja działa tylko na elementach obecnych na danej stronie. Język: <html lang> (pl / en).
(function () {
  "use strict";
  var PRERENDER = !!window.__PRERENDER__;
  var API = "https://app.morzkulc.pl/api/public/site";
  var EN = document.documentElement.getAttribute("lang") === "en";
  var MONTHS = EN ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] :
    ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
  var DAYS = EN ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] :
    ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];
  var FUNKCJE_EN = {"Prezes": "President", "Skarbnik": "Treasurer", "Sprzętowiec": "Equipment manager", "Szkoleniowiec": "Training coordinator", "Sekretarz": "Secretary", "Wiceprezes": "Vice-president"};
  var T = EN ? {
    noEvents: "No upcoming events — check back soon.",
    seat: "Club seat: ",
    poolNoDates: "The pool season is on — sessions are published in the club app.",
    poolNext: "The pool season is on. Next session: ",
    poolPlace: " (Relaxcenter, Gdynia).",
    poolSignup: " Sign-up in the club app.",
    poolHero: "Pool season is on",
    poolHeroNext: " · next session: ",
    honorary: "honorary",
    rip: "† ",
    fail: "Could not load the list — see the full calendar.",
  } : {
    noEvents: "Brak zaplanowanych imprez — zajrzyj wkrótce.",
    seat: "Siedziba: ",
    poolNoDates: "Sezon basenowy trwa — terminy pojawiają się w aplikacji.",
    poolNext: "Sezon basenowy trwa. Najbliższy termin: ",
    poolPlace: " (Relaxcenter, Gdynia).",
    poolSignup: " Zapisy w aplikacji klubowej.",
    poolHero: "Ruszyły baseny",
    poolHeroNext: " · najbliższy termin: ",
    honorary: "honorowa",
    rip: "ś.p. ",
    fail: "Nie udało się wczytać listy — skorzystaj z pełnego kalendarza.",
  };
  var ICONS = {
    facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 22v-8h2.7l.4-3.2h-3.1V8.8c0-.9.3-1.5 1.6-1.5h1.7V4.4c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1v2.4H7.6V14h2.8v8h3.1z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.3A4.7 4.7 0 1 0 12 16.7 4.7 4.7 0 0 0 12 7.3zm0 7.7a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm6-7.9a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0zM21.9 8c-.1-1.6-.4-3-1.6-4.2S17.6 2.2 16 2.1C14.4 2 9.6 2 8 2.1c-1.6.1-3 .4-4.2 1.6S2.2 6.4 2.1 8C2 9.6 2 14.4 2.1 16c.1 1.6.4 3 1.6 4.2s2.6 1.5 4.2 1.6c1.6.1 6.4.1 8 0 1.6-.1 3-.4 4.2-1.6s1.5-2.6 1.6-4.2c.1-1.6.1-6.4 0-8zm-2.1 9.7a3.3 3.3 0 0 1-1.8 1.8c-1.3.5-4.3.4-5.7.4s-4.4.1-5.7-.4a3.3 3.3 0 0 1-1.8-1.8c-.5-1.3-.4-4.3-.4-5.7s-.1-4.4.4-5.7A3.3 3.3 0 0 1 6.6 4.5c1.3-.5 4.3-.4 5.7-.4s4.4-.1 5.7.4a3.3 3.3 0 0 1 1.8 1.8c.5 1.3.4 4.3.4 5.7s.1 4.4-.4 5.7z"/></svg>',
    discord: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.6 5.3A17 17 0 0 0 15.4 4l-.5 1.1a15.7 15.7 0 0 0-5.8 0L8.6 4a17 17 0 0 0-4.2 1.3C1.7 9.3 1 13.2 1.3 17a17 17 0 0 0 5.2 2.6l1.1-1.8a11 11 0 0 1-1.7-.8l.4-.3a12.2 12.2 0 0 0 11.4 0l.4.3-1.7.8 1.1 1.8a17 17 0 0 0 5.2-2.6c.4-4.4-.7-8.3-3.1-11.7zM8.7 14.7c-1 0-1.9-.9-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1zm6.6 0c-1 0-1.9-.9-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z"/></svg>'
  };
  var LABELS = {facebook: "Facebook", instagram: "Instagram", discord: "Discord"};

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function show(sel, on) { $$(sel).forEach(function (e) { e.classList.toggle("hidden", !on); }); }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function plDate(iso) {
    var p = String(iso || "").split("-");
    return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : "";
  }
  function pln(n) { return EN ? Number(n).toLocaleString("en-GB") + " PLN" : Number(n).toLocaleString("pl-PL") + " zł"; }
  // Numer konta w grupach po 4 cyfry (2 + 6×4).
  function konto(nr) { return String(nr || "").replace(/^(\d{2})/, "$1 ").replace(/(\d{4})(?=\d)/g, "$1 "); }
  function dayDate(iso) {
    var p = String(iso || "").split("-").map(Number);
    if (p.length !== 3) return "";
    return DAYS[new Date(p[0], p[1] - 1, p[2]).getDay()] + (EN ? ", " : " ") + p[2] + " " + MONTHS[p[1] - 1];
  }
  function range(a, b) {
    if (!b || a === b) return plDate(a);
    var pa = a.split("-"), pb = b.split("-");
    if (pa[0] === pb[0] && pa[1] === pb[1]) return pa[2] + "–" + plDate(b);
    if (pa[0] === pb[0]) return pa[2] + "." + pa[1] + "–" + plDate(b);
    return plDate(a) + " – " + plDate(b);
  }
  function safeUrl(u) { return /^https:\/\//i.test(String(u || "")) ? u : ""; }
  function upcoming(list) {
    var t = todayIso();
    return (list || []).filter(function (ev) { return (ev.endDate || ev.startDate) >= t; });
  }
  function plural(n, one, few, many) {
    var n10 = n % 10, n100 = n % 100;
    if (n === 1) return one;
    if (EN) return few;
    return n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  }

  function renderEvents(list) {
    list = upcoming(list);
    $$(".js-events").forEach(function (ul) {
      var limit = Number(ul.getAttribute("data-limit")) || list.length;
      ul.textContent = "";
      if (!list.length) {
        ul.appendChild(el("li")).appendChild(el("span", "muted", T.noEvents));
        return;
      }
      list.slice(0, limit).forEach(function (ev) {
        var li = el("li");
        li.appendChild(el("span", "d", range(ev.startDate, ev.endDate)));
        li.appendChild(el("span", "n", ev.name));
        if (ev.location) li.appendChild(el("span", "l", ev.location));
        ul.appendChild(li);
      });
    });
  }

  function renderZarzad(list) {
    if (!list.length) return;
    $$(".js-zarzad").forEach(function (box) {
      box.textContent = "";
      list.forEach(function (p) {
        var d = el("div", "person");
        d.appendChild(el("div", "f", EN ? FUNKCJE_EN[p.funkcja] || p.funkcja : p.funkcja));
        if (p.name) d.appendChild(el("div", "nm", p.name));
        var a = el("a", null, p.mailbox);
        a.href = "mailto:" + p.mailbox;
        d.appendChild(a);
        box.appendChild(d);
      });
    });
  }

  function renderAdres(adres) {
    if (!adres) return;
    $$(".js-adres").forEach(function (p) { p.textContent = adres; });
    $$(".js-adres-foot").forEach(function (p) { p.textContent = T.seat + adres; });
    $$(".js-mapa-link").forEach(function (p) {
      p.querySelector("a").href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("SKK Morzkulc, " + adres).replace(/%20/g, "+");
      p.classList.remove("hidden");
    });
  }

  function socialLink(k, url, withLabel) {
    var a = el("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = ICONS[k];
    if (withLabel) a.appendChild(document.createTextNode(LABELS[k]));
    else { a.setAttribute("aria-label", LABELS[k]); a.title = LABELS[k]; }
    return a;
  }

  // Socjale: same ikony w nagłówku i stopce, przyciski z podpisem w treści.
  function renderSocial(social) {
    var keys = ["facebook", "instagram", "discord"];
    $$(".js-hero-social, .js-social-foot").forEach(function (box) {
      box.textContent = "";
      keys.forEach(function (k) { var u = safeUrl(social[k]); if (u) box.appendChild(socialLink(k, u, false)); });
    });
    $$(".js-social").forEach(function (box) {
      box.textContent = "";
      keys.forEach(function (k) { var u = safeUrl(social[k]); if (u) box.appendChild(socialLink(k, u, true)); });
    });
  }

  // Basen pokazujemy tylko, gdy moduł basenu jest udostępniony w aplikacji.
  function basenText(b) {
    if (!b || !b.ruszyl) return "";
    if (!b.terminy.length) return T.poolNoDates;
    return T.poolNext + dayDate(b.terminy[0]) + T.poolPlace;
  }

  function renderBasen(b) {
    var t = basenText(b);
    $$(".js-basen-text").forEach(function (p) { p.textContent = t ? t + T.poolSignup : ""; });
    show(".js-basen-box", !!t);
    // Plakietka w nagłówku strony głównej (obok przycisków kursu i imprez).
    var hero = t ? T.poolHero + (b.terminy.length ? T.poolHeroNext + dayDate(b.terminy[0]) : "") : "";
    $$(".js-basen-hero-text").forEach(function (s) { s.textContent = hero; });
    show(".js-basen-hero", !!hero);
  }

  function kajakiOpis(kj) {
    if (!kj || !kj.razem) return "";
    var parts = [];
    if (EN) {
      if (kj.gorskie) parts.push(kj.gorskie + " whitewater");
      if (kj.nizinne) parts.push(kj.nizinne + " touring");
      if (kj.morskie) parts.push(kj.morskie + " sea");
      if (kj.freestyle) parts.push(kj.freestyle + " freestyle");
      if (kj.kanadyjki) parts.push(kj.kanadyjki + " " + plural(kj.kanadyjki, "canoe", "canoes"));
      return " (" + kj.razem + " kayaks: " + parts.join(", ") + ")";
    }
    if (kj.gorskie) parts.push(kj.gorskie + " górskich");
    if (kj.nizinne) parts.push(kj.nizinne + " nizinnych");
    if (kj.morskie) parts.push(kj.morskie + " morskich");
    if (kj.freestyle) parts.push(kj.freestyle + " freestyle");
    if (kj.kanadyjki) parts.push(kj.kanadyjki + " " + plural(kj.kanadyjki, "kanadyjka", "kanadyjki", "kanadyjek"));
    return " (" + kj.razem + " kajaków: " + parts.join(", ") + ")";
  }

  function renderStats(s) {
    $$(".js-lat").forEach(function (e) { e.textContent = String(new Date().getFullYear() - 1975); });
    if (!s) return;
    function num(sel, value, label) {
      var box = $(sel);
      if (!box || !value) return;
      box.querySelector("strong").textContent = String(value);
      if (label) box.querySelector("span").textContent = label;
      box.classList.remove("hidden");
    }
    num(".js-num-czlonkowie", s.czlonkowie);
    num(".js-num-kajaki", s.kajaki && s.kajaki.razem);
    if (s.imprezy) {
      num(".js-num-imprezy", s.imprezy.liczba, EN ? plural(s.imprezy.liczba, "event", "events") + " in the " + s.imprezy.rok + " calendar" :
        plural(s.imprezy.liczba, "impreza", "imprezy", "imprez") + " w kalendarzu " + s.imprezy.rok);
    }
    var opis = kajakiOpis(s.kajaki);
    $$(".js-kajaki-opis").forEach(function (e) { e.textContent = opis; });
  }

  // „09-01”, „03-01” → „, płatna od września i od marca” / „, due from September and from March”.
  function semestry(list) {
    var m = (list || []).map(function (d) { return MONTHS[Number(d.slice(0, 2)) - 1]; }).filter(Boolean);
    if (!m.length) return "";
    return EN ? ", due from " + m.join(" and from ") : ", płatna od " + m.join(" i od ");
  }

  function kursCena(k) {
    if (!k.cena) return "";
    return pln(k.cena) + (k.cenaMlodzi && k.mlodziWiek ? (EN ? " (under " + k.mlodziWiek + ": " : " (do " + k.mlodziWiek + " lat: ") + pln(k.cenaMlodzi) + ")" : "");
  }

  // Składka, konto i ceny — z SETUP (Vars_MEMBERS / Vars_BASEN / Vars_KURS) przez API.
  function renderFinanse(data) {
    var f = data.finanse, k = data.kurs || {}, b = data.basenCennik || {};
    if (f && f.konto) {
      $$(".js-konto").forEach(function (e) { e.textContent = konto(f.konto); });
      $$(".js-bank").forEach(function (e) { e.textContent = f.bank ? " (" + f.bank + ")" : ""; });
      $$(".js-konto-inline").forEach(function (e) { e.textContent = " " + konto(f.konto) + (f.bank ? " (" + f.bank + ")" : ""); });
      show(".js-konto-box", true);
    }
    var skladka = f && f.skladkaSemestr ? pln(f.skladkaSemestr) + (EN ? " per semester" : " za semestr") + semestry(f.semestry) : "";
    if (skladka) $$(".js-skladka").forEach(function (e) { e.textContent = " (" + skladka + ")"; });
    $$(".js-kurs-skrot").forEach(function (e) {
      e.textContent = k.edycja ? (EN ? "Course " : "Kurs ") + k.edycja + (k.cena ? ": " + kursCena(k) : "") + "." : "";
    });
    var parts = [];
    if (EN) {
      if (k.cena) parts.push("Course " + (k.edycja || "") + ": " + kursCena(k) + " — equipment included, details (in Polish) at kurs.morzkulc.pl.");
      if (skladka) parts.push("Membership fee: " + skladka + ".");
      if (b.godzina) parts.push("Winter pool: " + pln(b.godzina) + " per hour" + (b.karnet5 && b.karnet10 ? ", 5- and 10-hour passes: " + pln(b.karnet5) + " and " + pln(b.karnet10) : "") + ".");
    } else {
      if (k.cena) parts.push("Kurs " + (k.edycja || "") + ": " + kursCena(k) + " — sprzęt w cenie, szczegóły na kurs.morzkulc.pl.");
      if (skladka) parts.push("Składka członkowska: " + skladka + ".");
      if (b.godzina) parts.push("Basen zimą: " + pln(b.godzina) + " za godzinę" + (b.karnet5 && b.karnet10 ? ", karnety 5 i 10 godzin: " + pln(b.karnet5) + " i " + pln(b.karnet10) : "") + ".");
    }
    if (parts.length) $$(".js-faq-koszty").forEach(function (e) { e.textContent = parts.join(" "); });
  }

  function renderBlachy(list) {
    var tb = $(".js-blachy");
    if (!tb || !list) return;
    tb.textContent = "";
    list.forEach(function (b) {
      var tr = el("tr");
      tr.appendChild(el("td", "nr", b.honorowa ? T.honorary : (b.nr == null ? "—" : String(b.nr).padStart(2, "0"))));
      var who = el("td");
      who.appendChild(el("span", "nm", (b.sp ? T.rip : "") + b.imie + (b.ksywa ? " „" + b.ksywa + "”" : "") + " " + b.nazwisko));
      var extra = [b.klub, b.okazja, b.miejsce].filter(Boolean).join(" · ");
      if (extra) who.appendChild(el("span", "sub", extra));
      tr.appendChild(who);
      tr.appendChild(el("td", "rok", b.rok ? String(b.rok) : "—"));
      tb.appendChild(tr);
    });
    $$(".js-blachy-summary").forEach(function (p) {
      p.textContent = EN ? list.length + " people awarded the Club Badge." :
        list.length + " " + plural(list.length, "osoba wyróżniona", "osoby wyróżnione", "osób wyróżnionych") + " Blachą Klubową.";
    });
  }

  // Film „Jak działa Klub” — adres z SETUP; plik pobiera się dopiero po kliknięciu (preload="none").
  function renderFilm(url) {
    url = safeUrl(url);
    $$(".js-film").forEach(function (v) { if (url) v.setAttribute("src", url); });
    show(".js-film-box", !!url);
  }

  function apply(data) {
    renderEvents(data.events || []);
    renderZarzad(data.zarzad || []);
    renderAdres(data.adres || "");
    renderSocial(data.social || {});
    renderBasen(data.basen);
    renderStats(data.stats);
    renderBlachy(data.blachy);
    renderFinanse(data);
    renderFilm(data.film);
  }

  if (PRERENDER) { window.__siteApply = apply; return; }

  var toggle = $(".navToggle");
  if (toggle) toggle.addEventListener("click", function () {
    var open = document.body.classList.toggle("navOpen");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  var prerendered = document.documentElement.hasAttribute("data-prerendered");
  function fail() {
    if (prerendered) return;
    $$(".js-events").forEach(function (ul) {
      ul.textContent = "";
      ul.appendChild(el("li")).appendChild(el("span", "muted", T.fail));
    });
  }

  if (!window.fetch) { fail(); return; }
  // Parametr zmienia się co 5 min: CDN nie poda odpowiedzi starszej niż 5 min.
  fetch(API + "?b=" + Math.floor(Date.now() / 300000), {mode: "cors", credentials: "omit"})
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(apply)
    .catch(fail);
})();
