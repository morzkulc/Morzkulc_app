// Strona klubu (morzkulc.pl): imprezy, zarząd, adres, socjale i skrót kursu z GET /api/public/site.
// Przy deployu scripts/prerender-site.js wykonuje ten plik w Node (window.__PRERENDER__)
// i zapisuje wypełniony HTML, żeby boty bez JS widziały treść.
(function () {
  "use strict";
  var PRERENDER = !!window.__PRERENDER__;
  var API = "https://app.morzkulc.pl/api/public/site";
  var MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
  var ICONS = {
    facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 22v-8h2.7l.4-3.2h-3.1V8.8c0-.9.3-1.5 1.6-1.5h1.7V4.4c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1v2.4H7.6V14h2.8v8h3.1z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.3A4.7 4.7 0 1 0 12 16.7 4.7 4.7 0 0 0 12 7.3zm0 7.7a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm6-7.9a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0zM21.9 8c-.1-1.6-.4-3-1.6-4.2S17.6 2.2 16 2.1C14.4 2 9.6 2 8 2.1c-1.6.1-3 .4-4.2 1.6S2.2 6.4 2.1 8C2 9.6 2 14.4 2.1 16c.1 1.6.4 3 1.6 4.2s2.6 1.5 4.2 1.6c1.6.1 6.4.1 8 0 1.6-.1 3-.4 4.2-1.6s1.5-2.6 1.6-4.2c.1-1.6.1-6.4 0-8zm-2.1 9.7a3.3 3.3 0 0 1-1.8 1.8c-1.3.5-4.3.4-5.7.4s-4.4.1-5.7-.4a3.3 3.3 0 0 1-1.8-1.8c-.5-1.3-.4-4.3-.4-5.7s-.1-4.4.4-5.7A3.3 3.3 0 0 1 6.6 4.5c1.3-.5 4.3-.4 5.7-.4s4.4-.1 5.7.4a3.3 3.3 0 0 1 1.8 1.8c.5 1.3.4 4.3.4 5.7s.1 4.4-.4 5.7z"/></svg>'
  };
  var LABELS = {facebook: "Facebook", instagram: "Instagram"};

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function plDate(iso) {
    var p = String(iso || "").split("-");
    return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : "";
  }
  function longDate(iso) {
    var p = String(iso || "").split("-").map(Number);
    return p.length === 3 ? p[2] + " " + MONTHS[p[1] - 1] + " " + p[0] : "";
  }
  function range(a, b) {
    if (!b || a === b) return plDate(a);
    var pa = a.split("-"), pb = b.split("-");
    if (pa[0] === pb[0] && pa[1] === pb[1]) return pa[2] + "–" + plDate(b);
    if (pa[0] === pb[0]) return pa[2] + "." + pa[1] + "–" + plDate(b);
    return plDate(a) + " – " + plDate(b);
  }
  function safeUrl(u) { return /^https:\/\//i.test(String(u || "")) ? u : ""; }

  function renderEvents(list) {
    var ul = $(".js-events");
    var t = todayIso();
    list = list.filter(function (ev) { return (ev.endDate || ev.startDate) >= t; });
    ul.textContent = "";
    if (!list.length) {
      ul.appendChild(el("li")).appendChild(el("span", "muted", "Brak zaplanowanych imprez — zajrzyj wkrótce."));
      return;
    }
    list.forEach(function (ev) {
      var li = el("li");
      li.appendChild(el("span", "d", range(ev.startDate, ev.endDate)));
      li.appendChild(el("span", "n", ev.name));
      if (ev.location) li.appendChild(el("span", "l", ev.location));
      ul.appendChild(li);
    });
  }

  function renderZarzad(list, adres) {
    if (list.length) {
      var box = $(".js-zarzad");
      box.textContent = "";
      list.forEach(function (p) {
        var d = el("div", "person");
        d.appendChild(el("div", "f", p.funkcja));
        d.appendChild(el("div", "nm", p.name));
        var a = el("a", null, p.mailbox);
        a.href = "mailto:" + p.mailbox;
        d.appendChild(a);
        box.appendChild(d);
      });
    }
    if (adres) $(".js-adres").textContent = "Siedziba klubu: " + adres;
  }

  function socialLink(k, url) {
    var a = el("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = ICONS[k];
    return a;
  }

  // Socjale: ikony w nagłówku + przyciski z podpisem w sekcji „Bądź na bieżąco”.
  function renderSocial(social) {
    var box = $(".js-social"), hero = $(".js-hero-social");
    box.textContent = ""; hero.textContent = "";
    ["facebook", "instagram"].forEach(function (k) {
      var url = safeUrl(social[k]);
      if (!url) return;
      var icon = socialLink(k, url);
      icon.setAttribute("aria-label", LABELS[k]);
      icon.title = LABELS[k];
      hero.appendChild(icon);
      var a = socialLink(k, url);
      a.appendChild(document.createTextNode(LABELS[k]));
      box.appendChild(a);
    });
  }

  // Skrót kursu; szczegóły (cena, harmonogram) są na kurs.morzkulc.pl.
  function renderKurs(k) {
    $(".js-kurs-edycja").textContent = k.edycja || "";
    var start = $(".js-kurs-start");
    start.textContent = k.start ? "Start: " + longDate(k.start) + "." : "";
    start.classList.toggle("is-missing", !k.start);
    var z = {
      otwarte: "Zapisy otwarte" + (k.zapisyDo ? " do " + longDate(k.zapisyDo) : "") + ".",
      wkrotce: "Zapisy" + (k.zapisyOd ? " od " + longDate(k.zapisyOd) : " wkrótce") + ".",
      rezerwowa: "Zapisy na listę rezerwową.",
      zamkniete: "Zapisy zamknięte — do zobaczenia w kolejnej edycji.",
    }[k.zapisyStatus] || "";
    var zap = $(".js-kurs-zapisy");
    zap.textContent = z;
    zap.classList.toggle("is-missing", !z);
  }

  function apply(data) {
    renderEvents(data.events || []);
    renderZarzad(data.zarzad || [], data.adres || "");
    renderSocial(data.social || {});
    renderKurs(data.kurs || {});
  }

  if (PRERENDER) { window.__siteApply = apply; return; }
  var prerendered = document.documentElement.hasAttribute("data-prerendered");

  function fail() {
    if (prerendered) return;
    var ul = $(".js-events");
    ul.textContent = "";
    ul.appendChild(el("li")).appendChild(el("span", "muted", "Nie udało się wczytać listy — skorzystaj z pełnego kalendarza poniżej."));
  }

  if (!window.fetch) { fail(); return; }
  // Parametr zmienia się co 5 min: CDN nie poda odpowiedzi starszej niż 5 min.
  fetch(API + "?b=" + Math.floor(Date.now() / 300000), {mode: "cors", credentials: "omit"})
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(apply)
    .catch(fail);
})();
