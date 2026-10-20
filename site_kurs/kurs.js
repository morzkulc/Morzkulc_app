// Strona kursu: wszystkie liczby/daty/kontakty z GET /api/public/site (pole `kurs`,
// źródło: arkusz 1_App_SETUP → Vars_KURS). Brak wartości = element z data-need ukryty.
(function () {
  "use strict";
  var API = "https://app.morzkulc.pl/api/public/site";
  var MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
  var MONTHS_SHORT = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];
  var TYPE_LABEL = {spotkanie: "spotkanie", wyklad: "wykład", basen: "basen", wyjazd: "wyjazd", po_kursie: "po kursie"};

  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function parseIso(s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function fmtDate(s) { var d = parseIso(s); return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }
  function fmtShort(s) { var d = parseIso(s); return d.getDate() + " " + MONTHS_SHORT[d.getMonth()]; }
  function fmtPln(n) { return Number(n).toLocaleString("pl-PL") + " zł"; }
  function plural(n, forms) {
    var f = forms.split("|");
    if (n === 1) return f[0];
    var d = n % 10, h = n % 100;
    return (d >= 2 && d <= 4 && (h < 12 || h > 14)) ? f[1] : f[2];
  }
  function range(a, b) {
    if (!b || a === b) return fmtShort(a);
    var da = parseIso(a), db = parseIso(b);
    return da.getMonth() === db.getMonth() ? da.getDate() + "–" + fmtShort(b) : fmtShort(a) + " – " + fmtShort(b);
  }
  function has(v) { return v !== undefined && v !== null && v !== ""; }

  function derive(k) {
    var h = k.harmonogram || [];
    if (h.length) {
      k.start = h[0].from;
      var w = h.filter(function (x) { return x.type === "wyjazd"; }).length;
      if (w) k.wyjazdy = w;
    }
    return k;
  }

  function fill(k) {
    $$("[data-k]").forEach(function (el) {
      var v = k[el.getAttribute("data-k")];
      if (!has(v)) return;
      var fmt = el.getAttribute("data-fmt");
      var txt = fmt === "pln" ? fmtPln(v) : fmt === "date" ? fmtDate(v) : fmt === "date-short" ? fmtShort(v) : String(v);
      var pl = el.getAttribute("data-plural");
      if (pl) txt += " " + plural(Number(v), pl);
      el.textContent = txt;
    });
    $$("[data-need]").forEach(function (el) {
      var key = el.getAttribute("data-need");
      var v = k[key];
      if (!has(v) || (Array.isArray(v) && !v.length)) el.classList.add("is-missing");
    });
  }

  function status(k) {
    var s = k.zapisyStatus;
    var label = "Zapisy", sub = "", btn = "Zapytaj o kurs", href = "#kontakt", enabled = true;
    if (s === "otwarte") {
      label = "Zapisy otwarte"; sub = k.zapisyDo ? "do " + fmtDate(k.zapisyDo) : "zapisz się już teraz";
      btn = "Zapisz się"; href = k.linkZapisu || "#kontakt";
    } else if (s === "wkrotce") {
      label = "Zapisy wkrótce"; sub = k.zapisyOd ? "od " + fmtDate(k.zapisyOd) : "śledź nasze profile";
      btn = k.zapisyOd ? "Zapisy od " + fmtDate(k.zapisyOd) : "Zapisy wkrótce"; enabled = false;
    } else if (s === "rezerwowa") {
      label = "Lista rezerwowa"; sub = "miejsca na liście głównej zajęte";
      btn = "Zapisz się na listę rezerwową"; href = k.linkZapisu || "#kontakt";
    } else if (s === "zamkniete") {
      label = "Zapisy zamknięte"; sub = "do zobaczenia w kolejnej edycji"; btn = "Zapisy zamknięte"; enabled = false;
    } else {
      sub = "napisz do nas";
    }
    $$(".js-status-label").forEach(function (el) { el.textContent = label; });
    $$(".js-status-sub").forEach(function (el) { el.textContent = sub; });
    $$(".fact-status").forEach(function (el) { el.classList.toggle("open", s === "otwarte"); });
    $$(".js-signup").forEach(function (el) {
      el.textContent = btn;
      el.href = href;
      if (/^https?:/.test(href)) { el.target = "_blank"; el.rel = "noopener"; }
      el.classList.toggle("is-disabled", !enabled);
    });
    if (!enabled) $$(".js-cta").forEach(function (el) { el.textContent = label; });
  }

  function timeline(k) {
    var h = k.harmonogram || [];
    var ol = document.querySelector(".js-timeline");
    if (!ol || !h.length) return;
    var t0 = today();
    ol.innerHTML = "";
    h.forEach(function (x) {
      var li = document.createElement("li");
      li.className = "tl t-" + x.type + (parseIso(x.to || x.from) < t0 ? " past" : "");
      var date = document.createElement("span"); date.className = "tl-date"; date.textContent = range(x.from, x.to);
      var card = document.createElement("div"); card.className = "tl-card";
      var type = document.createElement("span"); type.className = "tl-type"; type.textContent = TYPE_LABEL[x.type] || x.type;
      var name = document.createElement("strong"); name.textContent = x.name;
      card.appendChild(type); card.appendChild(name);
      if (x.place) { var pl = document.createElement("span"); pl.className = "tl-place"; pl.textContent = x.place; card.appendChild(pl); }
      li.appendChild(date); li.appendChild(card); ol.appendChild(li);
    });
    var counts = {};
    h.forEach(function (x) { counts[x.type] = (counts[x.type] || 0) + 1; });
    var parts = [];
    if (counts.wyklad) parts.push(counts.wyklad + " " + plural(counts.wyklad, "wykład|wykłady|wykładów"));
    if (counts.basen) parts.push(counts.basen + " " + plural(counts.basen, "basen|baseny|basenów"));
    if (counts.wyjazd) parts.push(counts.wyjazd + " " + plural(counts.wyjazd, "wyjazd|wyjazdy|wyjazdów"));
    var sum = document.querySelector(".js-hsum");
    if (sum && parts.length) sum.textContent = parts.join(" · ") + ". Od " + fmtDate(h[0].from) + ".";
    var cd = document.querySelector(".js-cd");
    var days = Math.round((parseIso(h[0].from) - t0) / 86400000);
    if (cd) {
      if (days > 0) cd.textContent = days;
      else cd.closest(".countdown").classList.add("is-missing");
    }
  }

  function film(k) {
    var box = document.querySelector(".js-film");
    if (!box || !k.filmUrl) return;
    var yt = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(k.filmUrl);
    if (yt) {
      var f = document.createElement("iframe");
      f.src = "https://www.youtube-nocookie.com/embed/" + yt[1];
      f.title = "Film z kursu"; f.loading = "lazy"; f.allowFullscreen = true;
      f.allow = "accelerometer; encrypted-media; gyroscope; picture-in-picture";
      box.appendChild(f);
    } else {
      var v = document.createElement("video");
      v.src = k.filmUrl; v.controls = true; v.preload = "metadata"; v.playsInline = true;
      box.appendChild(v);
    }
  }

  function contact(data, k) {
    $$(".js-mail").forEach(function (a) { if (k.kontaktEmail) a.href = "mailto:" + k.kontaktEmail; });
    $$(".js-tel").forEach(function (a) { if (k.kontaktTelefon) a.href = "tel:" + k.kontaktTelefon.replace(/[^\d+]/g, ""); });
    $$(".js-adres").forEach(function (p) { p.textContent = data.adres || ""; });
    var soc = data.social || {};
    $$(".js-social").forEach(function (p) {
      [["facebook", "Facebook"], ["instagram", "Instagram"]].forEach(function (s) {
        if (!soc[s[0]]) return;
        var a = document.createElement("a"); a.href = soc[s[0]]; a.textContent = s[1]; a.target = "_blank"; a.rel = "noopener";
        if (p.childNodes.length) p.appendChild(document.createTextNode(" · "));
        p.appendChild(a);
      });
    });
  }

  function apply(data) {
    var k = derive((data && data.kurs) || {});
    fill(k); status(k); timeline(k); film(k); contact(data || {}, k);
  }

  // ---------- UI ----------
  var nav = document.getElementById("nav");
  function onScroll() { nav.classList.toggle("scrolled", window.scrollY > 40); }
  window.addEventListener("scroll", onScroll, {passive: true}); onScroll();

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, {rootMargin: "0px 0px -8% 0px"});
    $$(".reveal").forEach(function (el) { io.observe(el); });
  } else {
    $$(".reveal").forEach(function (el) { el.classList.add("in"); });
  }

  // Galeria: podgląd z przewijaniem (strzałki, klawiatura, przesunięcie palcem).
  var lb = document.getElementById("lightbox");
  var lbImg = lb.querySelector("img");
  var lbCap = lb.querySelector(".lb-cap");
  var lbCount = lb.querySelector(".lb-count");
  var items = $$(".js-gallery a");
  var cur = 0;
  function show(i) {
    cur = (i + items.length) % items.length;
    var a = items[cur];
    lbImg.classList.remove("lb-swap"); void lbImg.offsetWidth; lbImg.classList.add("lb-swap");
    lbImg.src = a.href;
    lbImg.alt = a.querySelector("img").alt;
    lbCap.textContent = lbImg.alt;
    lbCount.textContent = (cur + 1) + " / " + items.length;
    [cur - 1, cur + 1].forEach(function (n) { new Image().src = items[(n + items.length) % items.length].href; });
  }
  function close() { lb.hidden = true; lbImg.src = ""; document.body.style.overflow = ""; }
  items.forEach(function (a, i) {
    a.addEventListener("click", function (e) {
      e.preventDefault(); lb.hidden = false; document.body.style.overflow = "hidden"; show(i);
    });
  });
  lb.querySelector(".lb-prev").addEventListener("click", function (e) { e.stopPropagation(); show(cur - 1); });
  lb.querySelector(".lb-next").addEventListener("click", function (e) { e.stopPropagation(); show(cur + 1); });
  lb.querySelector(".lb-close").addEventListener("click", close);
  lb.addEventListener("click", function (e) { if (e.target === lb || e.target.classList.contains("lb-fig")) close(); });
  document.addEventListener("keydown", function (e) {
    if (lb.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") show(cur + 1);
    else if (e.key === "ArrowLeft") show(cur - 1);
  });
  var x0 = null;
  lb.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, {passive: true});
  lb.addEventListener("touchend", function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 40) show(cur + (dx < 0 ? 1 : -1));
  });

  fetch(API, {mode: "cors", credentials: "omit"})
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(apply)
    .catch(function () { apply(null); });
})();
