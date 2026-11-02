/**
 * Zgoda na pliki cookies + tag Google Ads (pomiar konwersji kampanii Ad Grants) — wspólny
 * dla morzkulc.pl i kurs.morzkulc.pl (prerender kopiuje site_shared/ do obu targetów).
 *
 * Zasady (plan DOCS/Reklama/02.11_kampania_1_kurs_2027_PLAN.md, decyzja 02.11.2026):
 * - tag Google (gtag.js) ładuje się DOPIERO po „Akceptuję” (Consent Mode v2, tryb podstawowy);
 *   przed zgodą i po odmowie żadne żądanie do Google nie wychodzi;
 * - zgoda obejmuje tylko pomiar reklam (ad_storage, ad_user_data); personalizacja reklam
 *   (remarketing) i Analytics zawsze odrzucone — polityka prywatności: „dane nie są profilowane”;
 * - wybór w cookie `mk_consent` na .morzkulc.pl (jeden wybór dla obu serwisów), 12 miesięcy;
 * - „Ustawienia cookies” (element z [data-consent-open]) otwiera baner ponownie — wycofanie
 *   zgody tak samo łatwe jak jej udzielenie.
 * Brak GOOGLE_TAG_ID → skrypt nic nie robi (nie ma czego mierzyć, więc nie pytamy o zgodę).
 *
 * Konwersje: window.mkTrack("zapis" | "kontakt" | "start_zapisu"); etykiety z konta Google Ads.
 * mailto:/tel: i linki do /zapis są śledzone automatycznie.
 */
(function () {
  "use strict";
  var GOOGLE_TAG_ID = "AW-18551694807"; // konto Google Ads (Ad Grants) SKK Morzkulc
  var CONVERSIONS = {zapis: "xjHrCPK617AdENfLkY5F", kontakt: "4oxmCPW617AdENfLkY5F", start_zapisu: "HeVTCPi617AdENfLkY5F"}; // etykiety akcji konwersji (konto Ads 912-694-6195)
  var COOKIE = "mk_consent";
  var MAX_AGE = 365 * 24 * 3600;

  var EN = (document.documentElement.lang || "").toLowerCase().indexOf("en") === 0;
  var T = EN ? {
    text: "We use a Google Ads cookie only to measure whether our ads lead to course sign-ups and contact. No ad personalisation, no analytics profiling.",
    more: "Privacy policy", href: "https://morzkulc.pl/en/privacy",
    yes: "Accept", no: "Reject", label: "Cookie consent",
  } : {
    text: "Używamy pliku cookie Google Ads wyłącznie do sprawdzenia, czy nasze reklamy prowadzą do zapisów na kurs i kontaktu. Bez personalizacji reklam i profilowania.",
    more: "Polityka prywatności", href: "https://morzkulc.pl/polityka-prywatnosci",
    yes: "Akceptuję", no: "Odrzucam", label: "Zgoda na pliki cookies",
  };

  window.mkTrack = function () {};
  if (!GOOGLE_TAG_ID) return;

  function readChoice() {
    var m = document.cookie.match(/(?:^|;\s*)mk_consent=(granted|denied)/);
    return m ? m[1] : "";
  }

  function saveChoice(v) {
    var host = location.hostname;
    var domain = /(^|\.)morzkulc\.pl$/.test(host) ? "; domain=.morzkulc.pl" : "";
    document.cookie = COOKIE + "=" + v + "; max-age=" + MAX_AGE + "; path=/; samesite=lax; secure" + domain;
  }

  var loaded = false;
  function loadTag() {
    if (loaded) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("consent", "default", {
      ad_storage: "granted", ad_user_data: "granted", ad_personalization: "denied", analytics_storage: "denied",
    });
    window.gtag("js", new Date());
    window.gtag("config", GOOGLE_TAG_ID, {allow_ad_personalization_signals: false});
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GOOGLE_TAG_ID);
    document.head.appendChild(s);
    window.mkTrack = function (name) {
      var label = CONVERSIONS[name];
      if (label) window.gtag("event", "conversion", {send_to: GOOGLE_TAG_ID + "/" + label});
    };
  }

  // Wycofanie zgody: tag już załadowany w tej karcie → odebranie zgody + usunięcie cookies Google.
  function revoke() {
    if (loaded && window.gtag) window.gtag("consent", "update", {ad_storage: "denied", ad_user_data: "denied"});
    window.mkTrack = function () {};
    document.cookie.split(";").forEach(function (c) {
      var n = c.split("=")[0].trim();
      if (/^_gcl_|^_ga/.test(n)) {
        document.cookie = n + "=; max-age=0; path=/";
        document.cookie = n + "=; max-age=0; path=/; domain=.morzkulc.pl";
      }
    });
  }

  var bar = null;
  function showBar() {
    if (bar) { bar.hidden = false; return; }
    var st = document.createElement("style");
    st.textContent =
      ".mkConsent{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:720px;margin:0 auto;" +
      "background:#0b1e2b;color:#f2f6f9;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:14px 16px;" +
      "font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)}" +
      ".mkConsent p{margin:0 0 10px}.mkConsent a{color:#8fd3ff}" +
      ".mkConsent .mkBtns{display:flex;gap:8px;flex-wrap:wrap}" +
      ".mkConsent button{flex:1 1 140px;padding:10px 14px;border-radius:8px;border:1px solid #8fd3ff;" +
      "background:transparent;color:#f2f6f9;font:600 14px system-ui,sans-serif;cursor:pointer}" +
      ".mkConsent button:hover{background:rgba(143,211,255,.15)}";
    document.head.appendChild(st);
    bar = document.createElement("div");
    bar.className = "mkConsent";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", T.label);
    bar.innerHTML = "<p>" + T.text + " <a href=\"" + T.href + "\">" + T.more + "</a></p>" +
      "<div class=\"mkBtns\"><button type=\"button\" data-c=\"denied\">" + T.no + "</button>" +
      "<button type=\"button\" data-c=\"granted\">" + T.yes + "</button></div>";
    bar.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-c]");
      if (!b) return;
      var v = b.getAttribute("data-c");
      saveChoice(v);
      bar.hidden = true;
      if (v === "granted") loadTag(); else revoke();
    });
    document.body.appendChild(bar);
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-consent-open]")) {
      e.preventDefault();
      showBar();
      return;
    }
    var a = e.target.closest("a[href]");
    if (!a) return;
    var h = a.getAttribute("href") || "";
    if (/^(mailto|tel):/i.test(h)) window.mkTrack("kontakt");
    else if (/(^|kurs\.morzkulc\.pl)\/zapis\b/.test(h)) window.mkTrack("start_zapisu");
  });

  function init() {
    // Link „Ustawienia cookies” w stopce jest ukryty, dopóki tag nie jest skonfigurowany.
    Array.prototype.forEach.call(document.querySelectorAll("[data-consent-open]"), function (el) { el.hidden = false; });
    var c = readChoice();
    if (c === "granted") loadTag();
    else if (!c) showBar();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
