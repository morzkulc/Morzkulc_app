/**
 * km_module.js
 *
 * Moduł Kilometrówka / Ranking.
 * Widoki: form (dodaj wpis), rankings (rankingi), my-stats (moje statystyki na tle klubu + moje wpisy),
 * events (imprezy); kursant: form, kursant-ranking, my-logs.
 *
 * Zasady:
 * - Punkty obliczane przez backend ON WRITE — frontend tylko wyświetla gotowe dane
 * - Formularz dynamiczny: skala trudności tylko dla gór (WW) i nizin (U)
 * - Autocomplete nazw akwenów: słownik pobierany raz, filtrowany lokalnie, min 2 znaki
 * - Wywrotolotek: tylko kabina, rolka, dziubek
 */

import { apiGetJson, apiPostJson } from "/core/api_client.js";
import { formatPoints } from "/core/format_utils.js";
import { isUrlOnly } from "/core/text_format.js";

const KM_ADD_LOG_URL = "/api/km/log/add";
const KM_MY_LOGS_URL = "/api/km/logs";
const KM_MY_STATS_URL = "/api/km/stats";
const KM_RANKINGS_URL = "/api/km/rankings";
const KM_PLACES_URL = "/api/km/places";
const KM_EVENT_STATS_URL = "/api/km/event-stats";
const EVENTS_URL = "/api/events";

// Klucz sessionStorage, przez który kafelki na stronie głównej (render_shell.js,
// stała KM_HOME_STAT_PREF_KEY tamże — musi być identyczna) przekazują, który typ
// rankingu otworzyć od razu po wejściu w zakładkę "rankings". Odczyt jednorazowy.
const HOME_STAT_PREF_KEY = "kmHomeRankingType";

const NAV_BACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const NAV_HOME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
const INFO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

const TILE_SVG = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON_GPS = TILE_SVG(`<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>`);
const ICON_MAP = TILE_SVG(`<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>`);
const ICON_RANK_KM = TILE_SVG(`<path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 18c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 6c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/>`);
const ICON_RANK_POINTS = TILE_SVG(`<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>`);
const ICON_RANK_HOURS = TILE_SVG(`<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>`);
const ICON_TROPHY = TILE_SVG(`<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/>`);

// Kafelki nawigacji (wspólne .modTiles z base.css). „Gdzie pływamy" usunięte 12.10.2026 —
// mapa jest w module Klub. 13.10.2026: „Dodaj wpis" pierwszy i domyślny; „Moje wpisy"
// u członka są częścią „Moich statystyk" (osobny kafelek zostaje tylko u kursanta).
const TABS = [
  { id: "form",            label: "Dodaj wpis", add: true, icon: TILE_SVG(`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`) },
  { id: "rankings",        label: "Rankingi", icon: ICON_TROPHY },
  { id: "my-stats",        label: "Moje statystyki", icon: TILE_SVG(`<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="18" y1="20" x2="18" y2="9"/>`) },
  { id: "events",          label: "Imprezy", icon: TILE_SVG(`<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`) },
  { id: "kursant-ranking", label: "Wywrotolotek - wyniki", icon: ICON_TROPHY },
  { id: "my-logs",         label: "Moje wpisy", icon: TILE_SVG(`<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>`) },
];
const TAB_IDS_BY_ROLE = {
  member:   ["form", "rankings", "my-stats", "events"],
  kursant:  ["form", "kursant-ranking", "my-logs"],
  sympatyk: ["rankings", "events"], // tylko przegląda
};

// short + icon: kafelki wyboru w formularzu (5 w jednym rzędzie, także na telefonie).
const WATER_FILL = `<path d="M2 20c2.5-1.5 5 1.5 7.5 0s5-1.5 7.5 0 3.5 1 5 0"/>`;
const WATER_TYPES = [
  { value: "mountains", label: "Góry",                 short: "Góry",     icon: TILE_SVG(`<path d="M2 17l6-10 4 6 3-4 7 8z"/>${WATER_FILL}`) },
  { value: "lowlands",  label: "Niziny",               short: "Niziny",   icon: TILE_SVG(`<path d="M2 14c3-3 6-3 9 0s7 2 11-2"/>${WATER_FILL}`) },
  { value: "sea",       label: "Morze",                short: "Morze",    icon: TILE_SVG(`<circle cx="16" cy="7" r="3"/><path d="M2 14c2.5-1.5 5 1.5 7.5 0s5-1.5 7.5 0 3.5 1 5 0"/>${WATER_FILL}`) },
  { value: "track",     label: "Tor / playspot",       short: "Tor / playspot", icon: TILE_SVG(`<path d="M5 4h14"/><path d="M8 4v10"/><path d="M16 4v10"/>${WATER_FILL}`) },
  { value: "pool",      label: "Basen / kajak-polo",   short: "Basen",    icon: TILE_SVG(`<path d="M8 3v12"/><path d="M15 3v12"/><path d="M8 7h7"/><path d="M8 11h7"/>${WATER_FILL}`) },
];

const DIFFICULTY_WW = ["WW1", "WW2", "WW3", "WW4", "WW5"];
const DIFFICULTY_U  = ["U1", "U2", "U3"];

// Skale w formularzu: kafelki z ikoną-wskaźnikiem (N z max słupków wypełnionych).
const DIFFICULTY_SCALES = {
  mountains: {
    label: "Trudność",
    tip: "Skala WW dla rzek górskich: WW1 łatwa … WW5 ekstremalna.",
    levels: DIFFICULTY_WW,
    hints: ["łatwa", "średnia", "trudna", "b. trudna", "ekstrem."],
  },
  lowlands: {
    label: "Uciążliwość",
    tip: "Skala U dla rzek nizinnych: U1 mała (swobodny spływ), U2 średnia, U3 duża (przenoski, zwałki).",
    levels: DIFFICULTY_U,
    hints: ["mała", "średnia", "duża"],
  },
};

function levelIconSvg(level, max) {
  const w = 18 / max;
  const bars = Array.from({ length: max }, (_, i) => {
    const h = 6 + (14 * (i + 1)) / max;
    const x = 3 + i * w;
    return `<rect x="${(x + 0.6).toFixed(2)}" y="${(21 - h).toFixed(2)}" width="${(w - 1.2).toFixed(2)}" height="${h.toFixed(2)}" rx="1"
      fill="currentColor" opacity="${i < level ? 1 : 0.22}"/>`;
  }).join("");
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${bars}</svg>`;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function spinnerHtml(text = "Ładowanie…") {
  return `<div class="thinking">${esc(text)}<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return esc(iso);
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y}`;
}

function fmtNum(n, decimals = 1) {
  const v = parseFloat(n) || 0;
  return v % 1 === 0 ? String(v) : parseFloat(v.toFixed(decimals)).toString();
}

function waterTypeLabel(wt) {
  return WATER_TYPES.find(x => x.value === wt)?.label || esc(wt);
}

function rankMedal(rank) {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `${rank}.`;
}

function infoTip(text) {
  return `<button type="button" class="kmInfoBtn" data-km-tip="${esc(text)}" aria-label="Informacja">${INFO_SVG}</button>`;
}

// ─── popover tooltip ──────────────────────────────────────────────────────────

// Jedna delegacja na document na cały czas życia strony. Wcześniej handlery były
// dopinane do przycisków istniejących w chwili wywołania — PRZED wyrenderowaniem treści
// zakładki, więc ikonki „i” w formularzu (i dynamiczne, np. przy trudności) nie reagowały.
// Popover jest w <body> i pozycjonowany przy przycisku z dociśnięciem do krawędzi ekranu.
let kmActivePopover = null;
let kmPopoverDelegationBound = false;

function closeKmActivePopover() {
  if (kmActivePopover) {
    kmActivePopover.remove();
    kmActivePopover = null;
  }
}

function openKmPopover(btn, text = null, warn = false) {
  const pop = document.createElement("div");
  pop.className = warn ? "kmPopover kmPopoverWarn" : "kmPopover";
  pop.setAttribute("role", warn ? "alert" : "tooltip");
  pop.textContent = text ?? (btn.dataset.kmTip || "");
  pop.kmSrcBtn = btn;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
  const below = r.bottom + 6 + ph <= window.innerHeight - 8 || r.top - 6 - ph < 8;
  const top = below ? r.bottom + 6 : r.top - 6 - ph;
  pop.style.left = `${Math.round(left + window.scrollX)}px`;
  pop.style.top = `${Math.round(top + window.scrollY)}px`;
  kmActivePopover = pop;
}

function attachInfoTips() {
  if (kmPopoverDelegationBound) return;
  kmPopoverDelegationBound = true;
  document.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-km-tip]");
    if (!btn) {
      if (!e.target?.closest?.(".kmPopover")) closeKmActivePopover();
      return;
    }
    // Ikonka siedzi w <label> — bez preventDefault klik zaznaczałby/fokusował pole.
    e.preventDefault();
    const same = kmActivePopover?.kmSrcBtn === btn;
    closeKmActivePopover();
    if (!same) openKmPopover(btn);
  });
  // Bez zamykania na resize — na telefonie pasek adresu przy przewijaniu wywołuje resize
  // i popover znikałby od razu. Popover jest w dokumencie, więc przewija się z treścią.
}

// Typy akwenu, przy których kilometry nie mają sensu — pole ukryte, wysyłane 0.
const NO_KM_WATER_TYPES = new Set(["pool", "track"]);

// ─── pola liczbowe: wywrotolotek (całe liczby), km i godziny (przecinek) ─────
// Pola są type="text" + inputmode, bo type="number" przy „0,25” / „12,5” (zależnie od
// języka przeglądarki) oddaje pustą wartość i nie da się wykryć, co ktoś wpisał.
// Niedozwolony znak → zostaje najdłuższy poprawny początek + czerwona chmurka POD polem
// (nie pod ikonką „i”), żeby nie zasłaniała wpisywanej liczby.
const CAPSIZE_INT_MSG = "Wpisujesz liczbę przygód na wodzie — tylko całe liczby (0, 1, 2…). To nie są punkty: punkty policzą się same.";
const KM_DEC_MSG = "Kilometry wpisz jako liczbę z przecinkiem, np. 12 albo 12,5 (najwyżej 2 cyfry po przecinku).";
const HOURS_DEC_MSG = "Godziny wpisz jako liczbę z przecinkiem, np. 2 albo 1,5 (najwyżej 2 cyfry po przecinku).";

function sanitizeInt(raw) {
  if (/^\d{0,3}$/.test(raw)) return { value: raw, ok: true };
  return { value: raw.match(/^\d*/)[0].slice(0, 3), ok: false }; // „1,5” → „1”
}

// Kropka zamieniana na przecinek bez komunikatu; inne znaki → komunikat.
function decimalSanitizer(maxInt, maxDec) {
  const re = new RegExp(`^\\d{0,${maxInt}}(,\\d{0,${maxDec}})?$`);
  return (raw) => {
    const v = raw.replace(/\./g, ",");
    if (re.test(v)) return { value: v, ok: true };
    let n = v.length;
    while (n > 0 && !re.test(v.slice(0, n))) n--;
    return { value: v.slice(0, n), ok: false };
  };
}

function attachInputGuard(inputs, sanitize, msg) {
  inputs.forEach(input => {
    input.addEventListener("input", () => {
      const { value, ok } = sanitize(input.value);
      if (value !== input.value) input.value = value;
      if (ok) return;
      closeKmActivePopover();
      openKmPopover(input, msg, true);
    });
  });
}

// „12,5” → 12.5; pusty / niepoprawny → NaN
function parseDecimal(raw) {
  const v = String(raw || "").trim().replace(",", ".");
  return v === "" || v === "." ? NaN : Number(v);
}

// ─── komunikat po zapisie wpisu ──────────────────────────────────────────────
// Duży zielony baner z ikonką „i”; przewijany na środek ekranu, bo na telefonie
// przycisk „Dodaj” jest na dole długiego formularza i zwykły tekst łatwo przeoczyć.
function showKmSaved(el, msg) {
  el.classList.add("kmSaved");
  el.setAttribute("role", "status");
  el.innerHTML = `<span class="kmSavedIcon" aria-hidden="true">${INFO_SVG}</span><span class="kmSavedText">${esc(msg)}</span>`;
  el.hidden = false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ─── dynamiczne ładowanie zasobów ────────────────────────────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  return new Promise((resolve) => {
    if (document.querySelector(`link[href="${href}"]`)) { resolve(); return; }
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href; l.onload = resolve;
    document.head.appendChild(l);
  });
}

function injectKmLocStyles() {
  if (document.getElementById("kmLocStyles")) return;
  const s = document.createElement("style");
  s.id = "kmLocStyles";
  s.textContent = `
    .kmLocBtns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px;}
    .kmLocBtn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:8px 10px;border-radius:12px;border:1px solid var(--primary);background:var(--primary-2);color:var(--text);font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;}
    .kmLocBtn svg{color:var(--primary);flex:none;}
    .kmLocBtn:hover{background:color-mix(in srgb,var(--primary) 26%,transparent);}
    .kmLocBtn:disabled{opacity:0.6;cursor:wait;}
    .kmLocDisplay{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--ok-2);color:var(--ok);font-size:13px;font-weight:600;}
    .kmLocDisplay[hidden]{display:none;}
    .kmLocClearBtn{flex:none;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:2px 4px;line-height:1;}
    .kmLocClearBtn:hover{color:var(--danger);}
    .kmMapModalOverlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px;}
    .kmMapModalBox{background:#1a1a2e;border:1px solid #333;border-radius:10px;width:100%;max-width:600px;display:flex;flex-direction:column;overflow:hidden;}
    .kmMapModalHeader{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #333;font:13px system-ui,sans-serif;color:#ccc;}
    .kmMapModalClose{background:none;border:none;color:#888;font-size:18px;cursor:pointer;line-height:1;padding:0;}
    .kmMapModalClose:hover{color:#ccc;}
    #kmMapPickerDiv{height:320px;}
    .kmMapModalFooter{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-top:1px solid #333;gap:12px;}
    .kmMapPickedText{font:12px system-ui,sans-serif;color:#888;flex:1;}
  `;
  document.head.appendChild(s);
}

// ─── autocomplete nazwy akwenu ────────────────────────────────────────────────

// Cały słownik km_places pobierany raz (GET ?all=1) i filtrowany lokalnie — wcześniej
// każdy znak (po debounce 300 ms) szedł osobnym zapytaniem do funkcji i Firestore.
// Unieważniany po zapisie wpisu, bo zapis może dodać nowe miejsce do słownika.
let placesDictPromise = null;

function loadPlacesDict(ctx) {
  if (!placesDictPromise) {
    placesDictPromise = apiGetJson({ url: KM_PLACES_URL + "?all=1", idToken: ctx.idToken })
      .then((data) => (data?.places || []).map((p) => ({
        ...p,
        _keys: [p.name, ...(p.aliases || [])].map(normPlaceText).filter(Boolean),
      })))
      .catch((err) => { placesDictPromise = null; throw err; });
  }
  return placesDictPromise;
}

function invalidatePlacesDict() {
  placesDictPromise = null;
}

// Id imprez, które mają co najmniej jeden wpis — zakładka „Imprezy” pokazuje tylko je,
// a gdy nie ma żadnej, kafelek znika. Unieważniane po zapisie wpisu (mógł dojść do imprezy).
let eventIdsWithLogsPromise = null;

// Map eventId → podsumowanie {participants, logs, km, hours, points} (null, gdy serwer go nie podał).
function loadEventIdsWithLogs(ctx) {
  if (!eventIdsWithLogsPromise) {
    eventIdsWithLogsPromise = apiGetJson({ url: KM_EVENT_STATS_URL + "?list=1", idToken: ctx.idToken })
      .then((data) => new Map((data?.eventIds || []).map(id => [id, data?.summaries?.[id] || null])))
      .catch((err) => { eventIdsWithLogsPromise = null; throw err; });
  }
  return eventIdsWithLogsPromise;
}

function invalidateKmCaches() {
  invalidatePlacesDict();
  eventIdsWithLogsPromise = null;
}

// lowercase + bez polskich znaków („ł” nie rozkłada się w NFD — osobno)
function normPlaceText(v) {
  return String(v || "").toLowerCase().replace(/ł/g, "l")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

// Kolejność: nazwa zaczyna się od frazy → słowo zaczyna się od frazy → fraza w środku; potem popularność.
function filterPlaces(dict, query, limit = 10) {
  const q = normPlaceText(query);
  if (q.length < 2) return [];
  const hits = [];
  for (const p of dict) {
    let rank = 3;
    for (const k of p._keys) {
      if (k.startsWith(q)) { rank = 0; break; }
      if (rank > 1 && (" " + k).includes(" " + q)) rank = 1;
      else if (rank > 2 && k.includes(q)) rank = 2;
    }
    if (rank < 3) hits.push({ p, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || (b.p.useCount || 0) - (a.p.useCount || 0));
  return hits.slice(0, limit).map((h) => h.p);
}

function attachPlacesAutocomplete(input, hiddenPlaceId, ctx, hiddenLat, hiddenLng, onLocationSet, onLocationClear) {
  let debounceTimer = null;
  let suggestionsList = null;
  let dict = null;
  loadPlacesDict(ctx).then((d) => { dict = d; }).catch(() => { /* fallback: zapytania do backendu */ });
  let selectedPlaceId = null;

  function closeSuggestions() {
    if (suggestionsList) {
      suggestionsList.remove();
      suggestionsList = null;
    }
  }

  function showSuggestions(places) {
    closeSuggestions();
    if (!places.length) return;

    suggestionsList = document.createElement("ul");
    suggestionsList.className = "kmPlacesSuggestions";

    places.forEach(p => {
      const li = document.createElement("li");
      li.className = "kmPlacesSuggestion";
      li.textContent = (p.lat != null && p.lng != null ? "📍 " : "") + p.name + (p.waterType ? ` (${waterTypeLabel(p.waterType)})` : "");
      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // Zapobiega blur przed kliknięciem
        input.value = p.name;
        selectedPlaceId = p.placeId;
        hiddenPlaceId.value = p.placeId;
        if (hiddenLat) hiddenLat.value = p.lat != null ? p.lat : "";
        if (hiddenLng) hiddenLng.value = p.lng != null ? p.lng : "";
        if (p.lat != null && p.lng != null && onLocationSet) onLocationSet(p.lat, p.lng, "Akwen");
        else if (onLocationClear) onLocationClear();
        closeSuggestions();
      });
      suggestionsList.appendChild(li);
    });

    input.parentNode.style.position = "relative";
    suggestionsList.style.top = (input.offsetTop + input.offsetHeight + 2) + "px";
    input.parentNode.appendChild(suggestionsList);
  }

  input.addEventListener("input", () => {
    selectedPlaceId = null;
    hiddenPlaceId.value = "";
    if (hiddenLat) hiddenLat.value = "";
    if (hiddenLng) hiddenLng.value = "";
    if (onLocationClear) onLocationClear();
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { closeSuggestions(); return; }

    if (dict) { showSuggestions(filterPlaces(dict, q)); return; }

    // Słownik jeszcze się ładuje albo nie dał się pobrać — stara ścieżka przez backend.
    debounceTimer = setTimeout(async () => {
      if (dict) { showSuggestions(filterPlaces(dict, input.value.trim())); return; }
      try {
        const data = await apiGetJson({
          url: KM_PLACES_URL + "?q=" + encodeURIComponent(q) + "&limit=10",
          idToken: ctx.idToken,
        });
        showSuggestions(data?.places || []);
      } catch { /* Cichy błąd — autocomplete nie blokuje wpisu */ }
    }, 300);
  });

  input.addEventListener("blur", () => {
    setTimeout(closeSuggestions, 150);
  });
}

// ─── WIDOK: formularz kursanta ────────────────────────────────────────────────

function renderKursantFormView(inner, ctx) {
  inner.innerHTML = `
    <div class="kmFormSection">
      <form id="kmKursantForm" class="kmForm" novalidate>

        <div class="formRow">
          <label for="kmKursantEvent">Impreza kursowa <span class="required">*</span></label>
          <select id="kmKursantEvent" name="event" required>
            <option value="">Ładowanie…</option>
          </select>
        </div>

        <fieldset class="kmCapsizeFieldset">
          <legend>Wywrotolotek</legend>
          <div class="kmCapsizeGrid">
            <div class="kmCapsizeItem">
              <label for="kmKKabina">Kabina</label>
              <input type="text" id="kmKKabina" name="kabina" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" placeholder="0" />
            </div>
            <div class="kmCapsizeItem">
              <label for="kmKRolka">Rolka</label>
              <input type="text" id="kmKRolka" name="rolka" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" placeholder="0" />
            </div>
            <div class="kmCapsizeItem">
              <label for="kmKDziubek">Dziubek</label>
              <input type="text" id="kmKDziubek" name="dziubek" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" placeholder="0" />
            </div>
          </div>
        </fieldset>

        <div id="kmKursantFormError" class="errorMsg" hidden></div>
        <div id="kmKursantFormSuccess" class="successMsg" hidden></div>

        <div class="formActions">
          <button type="submit" id="kmKursantSubmitBtn" class="primary">Zapisz</button>
        </div>
      </form>
    </div>
  `;

  const eventSelect = inner.querySelector("#kmKursantEvent");
  const form = inner.querySelector("#kmKursantForm");
  const errEl = inner.querySelector("#kmKursantFormError");
  const okEl = inner.querySelector("#kmKursantFormSuccess");
  const btn = inner.querySelector("#kmKursantSubmitBtn");

  function setErr(msg) { errEl.textContent = msg; errEl.hidden = !msg; okEl.hidden = true; }
  function setOk(msg)  { showKmSaved(okEl, msg); errEl.hidden = true; }

  attachInputGuard(inner.querySelectorAll(".kmCapsizeItem input"), sanitizeInt, CAPSIZE_INT_MSG);

  // Załaduj imprezy kursowe asynchronicznie
  apiGetJson({ url: EVENTS_URL + "?mode=all", idToken: ctx.idToken })
    .then(data => {
      const events = (data?.events || []).filter(ev => ev.kursowa === true && ev.ranking === true);
      eventSelect.innerHTML = "";
      if (!events.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Brak aktywnych imprez kursowych";
        eventSelect.appendChild(opt);
        return;
      }
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— wybierz imprezę —";
      eventSelect.appendChild(placeholder);
      events.forEach(ev => {
        const opt = document.createElement("option");
        opt.value = ev.id;
        opt.dataset.eventName = ev.name;
        const dateRange = ev.startDate === ev.endDate ?
          ev.startDate :
          `${ev.startDate} – ${ev.endDate}`;
        opt.textContent = `${ev.name} (${dateRange})`;
        eventSelect.appendChild(opt);
      });
    })
    .catch(() => {
      eventSelect.innerHTML = `<option value="">Nie udało się pobrać imprez</option>`;
    });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setErr("");

    const selectedOpt = eventSelect.options[eventSelect.selectedIndex];
    const eventId = selectedOpt?.value || "";
    const eventName = eventId ? (selectedOpt?.dataset?.eventName || "") : "";

    if (!eventId) { setErr("Wybierz imprezę kursową."); return; }

    const kabina = parseInt(inner.querySelector("#kmKKabina").value, 10) || 0;
    const rolka = parseInt(inner.querySelector("#kmKRolka").value, 10) || 0;
    const dziubek = parseInt(inner.querySelector("#kmKDziubek").value, 10) || 0;

    btn.disabled = true;
    btn.textContent = "Zapisywanie…";

    try {
      const resp = await apiPostJson({
        url: KM_ADD_LOG_URL,
        idToken: ctx.idToken,
        body: {
          date: todayIso(),
          waterType: "lowlands",
          placeName: eventName,
          placeNameRaw: eventName,
          eventId,
          eventName,
          km: 0,
          hoursOnWater: 0,
          capsizeRolls: { kabina, rolka, dziubek },
          // Wpis kursowy: akwen = nazwa imprezy, bez lokalizacji — backend zwalnia z wymogu.
          source: "kursant_form",
        },
      });

      if (resp?.ok) {
        setOk("Zapisano! Punkty dodane do rankingu kursantów.");
        invalidateKmCaches();
        form.reset();
        if (eventSelect.options.length > 0) eventSelect.selectedIndex = 0;
      } else {
        setErr(resp?.message || "Nie udało się zapisać.");
      }
    } catch (err) {
      setErr("Błąd: " + (err?.message || String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = "Zapisz";
    }
  });
}

// ─── WIDOK: formularz dodawania wpisu ────────────────────────────────────────

function renderFormView(inner, ctx, moduleId) {
  const today = todayIso();

  inner.innerHTML = `
    <div class="kmFormSection">
      <form id="kmAddForm" class="kmForm" novalidate>

        <div class="formRow" data-field="date">
          <label for="kmDate">Data aktywności <span class="required">*</span></label>
          <input type="date" id="kmDate" name="date" max="${esc(today)}" value="${esc(today)}" required />
        </div>

        <div class="formRow" data-field="waterType">
          <label id="kmWaterTypeLabel">
            Typ akwenu <span class="required">*</span>
            ${infoTip("Góry → skala WW, Niziny → skala U, pozostałe → brak skali trudności.")}
          </label>
          <div class="kmWaterTiles" id="kmWaterType" role="radiogroup" aria-labelledby="kmWaterTypeLabel">
            ${WATER_TYPES.map(wt => `
              <label class="kmWaterTile" title="${esc(wt.label)}">
                <input type="radio" name="waterType" value="${esc(wt.value)}" />
                <span class="kmWaterTileIcon" aria-hidden="true">${wt.icon}</span>
                <span class="kmWaterTileLabel">${esc(wt.short)}</span>
              </label>
            `).join("")}
          </div>
        </div>

        <div class="formRow" id="kmDifficultyRow" data-field="difficulty" hidden>
          <label id="kmDifficultyLabel"></label>
          <div class="kmWaterTiles kmLevelTiles" id="kmDifficulty" role="radiogroup" aria-labelledby="kmDifficultyLabel"></div>
        </div>

        <div class="formRow" data-field="placeName" style="position:relative">
          <label for="kmPlaceName">
            Rzeka / akwen <span class="required">*</span>
            ${infoTip("Wpisz nazwę rzeki lub akwenu. System podpowie znane nazwy po 2 znakach.")}
          </label>
          <input type="text" id="kmPlaceName" name="placeName" maxlength="200"
            placeholder="np. Radunia, Dunajec, Morze Bałtyckie" autocomplete="off" required />
          <input type="hidden" id="kmPlaceId" name="placeId" />
          <input type="hidden" id="kmLat" />
          <input type="hidden" id="kmLng" />
        </div>

        <div class="formRow" data-field="location">
          <label id="kmLocLabel">
            Lokalizacja <span class="required">*</span>
            ${infoTip("Ustawia się sama po wyborze miejsca z podpowiedzi oznaczonego 📍. Inaczej użyj GPS albo zaznacz punkt na mapie.")}
          </label>
          <div class="kmLocBtns">
            <button type="button" id="kmGpsBtn" class="kmLocBtn" title="Pobierz bieżącą lokalizację z GPS telefonu">${ICON_GPS}<span class="kmLocBtnText">Moja lokalizacja</span></button>
            <button type="button" id="kmMapBtn" class="kmLocBtn" title="Kliknij na mapie, aby wybrać lokalizację">${ICON_MAP}<span class="kmLocBtnText">Wybierz na mapie</span></button>
          </div>
          <div id="kmLocDisplay" class="kmLocDisplay" hidden>
            <span id="kmLocText"></span>
            <button type="button" id="kmLocClear" class="kmLocClearBtn" title="Usuń ustawioną lokalizację" aria-label="Usuń ustawioną lokalizację">✕</button>
          </div>
        </div>

        <div class="kmResults">
          <div class="kmResultsTitle">Wynik</div>

          <div class="kmResultRow" data-field="km" data-hide-nokm>
            <label for="kmKm" class="kmResultLabel" data-type="km">
              <span class="kmResultIcon" aria-hidden="true">${ICON_RANK_KM}</span>
              <span>Kilometrówka <span class="required">*</span></span>
            </label>
            <div class="kmUnitInput">
              <input type="text" id="kmKm" name="km" inputmode="decimal" maxlength="7" autocomplete="off" placeholder="0" required />
              <span class="kmUnit">km</span>
            </div>
          </div>

          <div class="kmResultRow" data-field="hoursOnWater">
            <label for="kmHours" class="kmResultLabel" data-type="hours">
              <span class="kmResultIcon" aria-hidden="true">${ICON_RANK_HOURS}</span>
              <span>Kajakogodziny <span class="required">*</span></span>
              ${infoTip("Całkowity czas spędzony na wodzie (w godzinach). Wpisz 0, jeśli nie mierzono.")}
            </label>
            <div class="kmUnitInput">
              <input type="text" id="kmHours" name="hoursOnWater" inputmode="decimal" maxlength="5" autocomplete="off" placeholder="0" required />
              <span class="kmUnit">h</span>
            </div>
          </div>

          <div class="kmResultRow kmResultRowCapsize" data-hide-pool>
            <div class="kmResultLabel" data-type="points">
              <span class="kmResultIcon" aria-hidden="true">${ICON_RANK_POINTS}</span>
              <span>Wywrotolotek</span>
              ${infoTip("Podaj liczbę przygód na wodzie - punkty policzą się same")}
            </div>
            <div class="kmCapsizeSteppers">
              ${[["kabina", "Kabina"], ["rolka", "Rolka"], ["dziubek", "Dziubek"]].map(([name, label]) => `
                <div class="kmStepper">
                  <span class="kmStepperLabel">${label}</span>
                  <div class="kmStepperCtl">
                    <button type="button" class="kmStepBtn" data-step="-1" data-for="${name}" aria-label="${label}: mniej">−</button>
                    <input type="text" name="${name}" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" value="0" aria-label="${label}" />
                    <button type="button" class="kmStepBtn" data-step="1" data-for="${name}" aria-label="${label}: więcej">+</button>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        </div>

        <div class="kmOptional">
          <div class="kmOptionalTitle">Opcjonalnie</div>

          <div class="formRow" id="kmEventRow" data-hide-pool>
            <label for="kmEvent">Impreza</label>
            <select id="kmEvent" name="event">
              <option value="">— brak / nie dotyczy —</option>
            </select>
            <input type="hidden" id="kmEventName" />
          </div>

          <div class="formRow">
            <label for="kmSection">Odcinek</label>
            <input type="text" id="kmSection" name="sectionDescription" maxlength="500"
              placeholder="np. Olsztynek – Brodnica Dolna" />
          </div>

          <div class="formRow">
            <label for="kmNote">Notatka</label>
            <textarea id="kmNote" name="note" rows="2" maxlength="1000"
              placeholder="Krótka notatka do wpisu…"></textarea>
          </div>
        </div>

        <div id="kmFormError" class="errorMsg" hidden></div>
        <div id="kmFormSuccess" class="successMsg" hidden></div>

        <div class="kmFormButtons">
          <button type="submit" id="kmSubmitBtn" class="kmBigBtn approveBtn">Dodaj</button>
          <button type="button" id="kmCancelBtn" class="kmBigBtn rejectBtn">Anuluj</button>
        </div>
      </form>
    </div>
  `;

  // Dynamika formularza — trudność
  const waterTypeGroup = inner.querySelector("#kmWaterType");
  const difficultyRow = inner.querySelector("#kmDifficultyRow");
  const difficultyTiles = inner.querySelector("#kmDifficulty");
  const difficultyLabel = inner.querySelector("#kmDifficultyLabel");
  let difficultyFor = "";

  function updateDifficultyField() {
    const wt = inner.querySelector('input[name="waterType"]:checked')?.value || "";
    if (wt === difficultyFor) return; // ten sam typ — nie kasuj wybranego poziomu
    difficultyFor = wt;
    clearFieldError("difficulty");
    const scale = DIFFICULTY_SCALES[wt];
    if (!scale) {
      difficultyRow.hidden = true;
      difficultyTiles.innerHTML = "";
      return;
    }
    FIELD_LABELS.difficulty = scale.label;
    difficultyLabel.innerHTML = `${esc(scale.label)} <span class="required">*</span> ${infoTip(scale.tip)}`;
    difficultyTiles.style.setProperty("--cols", scale.levels.length);
    difficultyTiles.innerHTML = scale.levels.map((lvl, i) => `
      <label class="kmWaterTile kmLevelTile" data-level="${i + 1}" title="${esc(lvl + " — " + scale.hints[i])}">
        <input type="radio" name="difficulty" value="${esc(lvl)}" />
        <span class="kmWaterTileIcon" aria-hidden="true">${levelIconSvg(i + 1, scale.levels.length)}</span>
        <span class="kmWaterTileLabel">${esc(lvl)}</span>
        <span class="kmLevelHint">${esc(scale.hints[i])}</span>
      </label>
    `).join("");
    difficultyRow.hidden = false;
  }

  // Basen: liczą się tylko kajakogodziny — km, wywrotolotek i impreza ukryte (wysyłane jako 0 / brak).
  // Tor / playspot: bez kilometrów (wysyłane jako 0), wywrotolotek i impreza zostają.
  function updatePoolMode() {
    const wt = inner.querySelector('input[name="waterType"]:checked')?.value;
    const isPool = wt === "pool";
    const noKm = NO_KM_WATER_TYPES.has(wt);
    inner.querySelectorAll("[data-hide-pool]").forEach(el => { el.hidden = isPool; });
    inner.querySelectorAll("[data-hide-nokm]").forEach(el => { el.hidden = noKm; });
    if (noKm) clearFieldError("km");
  }

  waterTypeGroup.addEventListener("change", () => { updateDifficultyField(); updatePoolMode(); });

  // Wywrotolotek: przyciski − / +
  inner.querySelectorAll(".kmStepBtn").forEach(b => {
    b.addEventListener("click", () => {
      const input = inner.querySelector(`input[name="${b.dataset.for}"]`);
      const v = Math.max(0, Math.min(999, (parseInt(input.value, 10) || 0) + Number(b.dataset.step)));
      input.value = String(v);
    });
  });
  attachInputGuard(inner.querySelectorAll(".kmCapsizeSteppers input"), sanitizeInt, CAPSIZE_INT_MSG);
  attachInputGuard([inner.querySelector("#kmKm")], decimalSanitizer(4, 2), KM_DEC_MSG);
  attachInputGuard([inner.querySelector("#kmHours")], decimalSanitizer(2, 2), HOURS_DEC_MSG);

  // Autocomplete nazwy akwenu
  const placeInput = inner.querySelector("#kmPlaceName");
  const placeIdHidden = inner.querySelector("#kmPlaceId");
  const latHidden = inner.querySelector("#kmLat");
  const lngHidden = inner.querySelector("#kmLng");

  // ── Lokalizacja: GPS + mapa ─────────────────────────────────────────────────
  injectKmLocStyles();

  const gpsBtn   = inner.querySelector("#kmGpsBtn");
  const mapBtn   = inner.querySelector("#kmMapBtn");
  const locDisp  = inner.querySelector("#kmLocDisplay");
  const locTxt   = inner.querySelector("#kmLocText");
  const locClear = inner.querySelector("#kmLocClear");

  function setLocationDisplay(lat, lng, source) {
    latHidden.value = String(lat);
    lngHidden.value = String(lng);
    // Źródło: „Akwen” (podpowiedź ze słownika), „GPS” albo „Mapa”.
    const src = source === "Akwen" ? "ze słownika miejsc" : source === "GPS" ? "z GPS" : source === "Mapa" ? "z mapy" : "";
    locTxt.textContent = `✓ Lokalizacja ustawiona${src ? " " + src : ""} (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;
    locDisp.hidden = false;
    clearFieldError("location");
  }

  function clearLocationDisplay() {
    latHidden.value = "";
    lngHidden.value = "";
    locDisp.hidden = true;
    locTxt.textContent = "";
  }

  locClear.addEventListener("click", clearLocationDisplay);

  attachPlacesAutocomplete(placeInput, placeIdHidden, ctx, latHidden, lngHidden,
    (lat, lng, source) => setLocationDisplay(lat, lng, source),
    () => clearLocationDisplay()
  );

  // GPS
  gpsBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("Twoja przeglądarka nie obsługuje geolokalizacji.");
      return;
    }
    const gpsText = gpsBtn.querySelector(".kmLocBtnText");
    gpsBtn.disabled = true;
    gpsText.textContent = "Szukam…";
    navigator.geolocation.getCurrentPosition(
      pos => {
        setLocationDisplay(pos.coords.latitude, pos.coords.longitude, "GPS");
        gpsBtn.disabled = false;
        gpsText.textContent = "Moja lokalizacja";
      },
      err => {
        alert("Nie udało się pobrać lokalizacji: " + (err.message || "błąd GPS"));
        gpsBtn.disabled = false;
        gpsText.textContent = "Moja lokalizacja";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // Mapa — picker
  let pickedLat = null;
  let pickedLng = null;

  mapBtn.addEventListener("click", async () => {
    if (!window.maplibregl) {
      const mapText = mapBtn.querySelector(".kmLocBtnText");
      mapBtn.disabled = true;
      mapText.textContent = "Ładowanie…";
      await Promise.all([
        loadCss("https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css"),
        loadScript("https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"),
      ]).catch(() => {});
      mapBtn.disabled = false;
      mapText.textContent = "Wybierz na mapie";
    }

    pickedLat = null;
    pickedLng = null;

    const overlay = document.createElement("div");
    overlay.className = "kmMapModalOverlay";
    overlay.innerHTML = `
      <div class="kmMapModalBox">
        <div class="kmMapModalHeader">
          <span>Kliknij na mapie, aby wybrać lokalizację</span>
          <button type="button" class="kmMapModalClose" id="kmMapClose">✕</button>
        </div>
        <div id="kmMapPickerDiv"></div>
        <div class="kmMapModalFooter">
          <span class="kmMapPickedText" id="kmMapPickedText">Kliknij w dowolne miejsce na mapie…</span>
          <button type="button" class="primary" id="kmMapConfirm" disabled>Zatwierdź</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const closeBtn   = overlay.querySelector("#kmMapClose");
    const confirmBtn = overlay.querySelector("#kmMapConfirm");
    const pickedText = overlay.querySelector("#kmMapPickedText");

    let pickerMap    = null;
    let pickerMarker = null;

    function closeModal() {
      if (pickerMap) { pickerMap.remove(); pickerMap = null; pickerMarker = null; }
      overlay.remove();
    }

    closeBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

    confirmBtn.addEventListener("click", () => {
      if (pickedLat != null && pickedLng != null) setLocationDisplay(pickedLat, pickedLng, "Mapa");
      closeModal();
    });

    // Inicjalizacja mapy po wyrenderowaniu overlaya
    setTimeout(() => {
      const existLat = latHidden.value ? parseFloat(latHidden.value) : null;
      const existLng = lngHidden.value ? parseFloat(lngHidden.value) : null;
      const centerLat = existLat ?? 52.0;
      const centerLng = existLng ?? 19.5;
      const zoom = existLat != null ? 12 : 6;

      // OpenFreeMap: darmowy, bez klucza API, hostowany w Europie — zamiennik CARTO
      pickerMap = new window.maplibregl.Map({
        container: "kmMapPickerDiv",
        style: "https://tiles.openfreemap.org/styles/positron",
        center: [centerLng, centerLat],
        zoom,
      });

      if (existLat != null) {
        pickedLat = existLat;
        pickedLng = existLng;
        pickerMarker = new window.maplibregl.Marker().setLngLat([pickedLng, pickedLat]).addTo(pickerMap);
        pickedText.textContent = pickedLat.toFixed(5) + ", " + pickedLng.toFixed(5);
        confirmBtn.disabled = false;
      }

      pickerMap.on("click", e => {
        pickedLat = e.lngLat.lat;
        pickedLng = e.lngLat.lng;
        if (pickerMarker) pickerMarker.remove();
        pickerMarker = new window.maplibregl.Marker().setLngLat([pickedLng, pickedLat]).addTo(pickerMap);
        pickedText.textContent = pickedLat.toFixed(5) + ", " + pickedLng.toFixed(5);
        confirmBtn.disabled = false;
      });
    }, 50);
  });

  // Załaduj listę aktualnych imprez asynchronicznie (mode=recent: od 30 dni wstecz do dziś)
  const eventSelect = inner.querySelector("#kmEvent");
  apiGetJson({ url: EVENTS_URL + "?mode=recent", idToken: ctx.idToken })
    .then(data => {
      const events = data?.events || [];
      events.forEach(ev => {
        const opt = document.createElement("option");
        opt.value = ev.id;
        opt.dataset.eventName = ev.name;
        const dateRange = ev.startDate === ev.endDate
          ? ev.startDate
          : `${ev.startDate} – ${ev.endDate}`;
        opt.textContent = `${ev.name} (${dateRange})`;
        eventSelect.appendChild(opt);
      });
    })
    .catch(() => {/* Cichy błąd — dropdown pozostaje z opcją brak */});

  // Submit
  const form = inner.querySelector("#kmAddForm");
  const errEl = inner.querySelector("#kmFormError");
  const okEl = inner.querySelector("#kmFormSuccess");
  const btn = inner.querySelector("#kmSubmitBtn");

  function setErr(msg) { errEl.textContent = msg; errEl.hidden = !msg; okEl.hidden = true; }
  function setOk(msg)  { showKmSaved(okEl, msg); errEl.hidden = true; }

  const FIELD_LABELS = {
    date: "Data aktywności", waterType: "Typ akwenu", placeName: "Rzeka / akwen",
    location: "Lokalizacja", km: "Kilometry", hoursOnWater: "Godziny na wodzie",
    difficulty: "Trudność", // nadpisywane w updateDifficultyField (Trudność / Uciążliwość)
  };

  function resetForm() {
    form.reset();
    // reset() nie czyści input[type=hidden] — lokalizacja/placeId przechodziłyby na kolejny wpis.
    placeIdHidden.value = "";
    clearLocationDisplay();
    form.date.value = todayIso();
    updateDifficultyField();
    updatePoolMode();
    showFieldErrors({});
    setErr("");
    okEl.hidden = true;
  }

  // Anuluj = porzuć wpisywane dane (formularz wraca do stanu początkowego).
  inner.querySelector("#kmCancelBtn").addEventListener("click", () => {
    resetForm();
    inner.querySelector(".kmFormSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function showFieldErrors(errors) {
    inner.querySelectorAll(".kmFieldErr").forEach(el => el.remove());
    inner.querySelectorAll("[data-field].kmFieldInvalid").forEach(el => el.classList.remove("kmFieldInvalid"));
    const keys = Object.keys(errors);
    if (!keys.length) return;
    for (const key of keys) {
      const row = inner.querySelector(`[data-field="${key}"]`);
      if (!row) continue;
      row.classList.add("kmFieldInvalid");
      const msg = document.createElement("div");
      msg.className = "kmFieldErr";
      msg.textContent = errors[key];
      row.appendChild(msg);
    }
    setErr(`Nie zapisano — popraw: ${keys.map(k => FIELD_LABELS[k] || k).join(", ")}.`);
    const first = inner.querySelector("[data-field].kmFieldInvalid");
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
    first?.querySelector("input:not([type=hidden]), select, textarea")?.focus({ preventScroll: true });
  }

  // Wywoływane też z setLocationDisplay (przed definicją — hoisting deklaracji funkcji).
  function clearFieldError(key) {
    const row = key && inner.querySelector(`[data-field="${key}"]`);
    if (!row?.classList.contains("kmFieldInvalid")) return;
    row.classList.remove("kmFieldInvalid");
    row.querySelector(".kmFieldErr")?.remove();
    if (!inner.querySelector("[data-field].kmFieldInvalid")) setErr("");
  }

  // Błąd znika, gdy użytkownik zacznie poprawiać dane pole.
  form.addEventListener("input", (e) => clearFieldError(e.target.closest("[data-field]")?.dataset.field));
  form.addEventListener("change", (e) => clearFieldError(e.target.closest("[data-field]")?.dataset.field));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setErr("");

    const date = String(form.date.value || "").trim();
    const waterType = String(form.waterType.value || "").trim();
    const placeName = String(form.placeName.value || "").trim();
    const isPool = waterType === "pool";
    const noKm = NO_KM_WATER_TYPES.has(waterType);
    const km = noKm ? 0 : parseDecimal(form.km.value);
    const hoursRaw = String(form.hoursOnWater.value || "").trim();
    const hoursOnWater = parseDecimal(hoursRaw);
    const difficulty = String(form.difficulty?.value || "").trim() || null;
    const difficultyScale = difficulty
      ? (difficulty.startsWith("WW") ? "WW" : "U")
      : null;
    const sectionDescription = String(form.sectionDescription.value || "").trim() || undefined;
    const note = String(form.note.value || "").trim() || undefined;
    const placeId = String(form.placeId.value || "").trim() || undefined;
    const latRaw = inner.querySelector("#kmLat")?.value;
    const lngRaw = inner.querySelector("#kmLng")?.value;
    const lat = latRaw !== "" && latRaw != null ? parseFloat(latRaw) : undefined;
    const lng = lngRaw !== "" && lngRaw != null ? parseFloat(lngRaw) : undefined;

    const kabina = isPool ? 0 : parseInt(form.kabina.value, 10) || 0;
    const rolka = isPool ? 0 : parseInt(form.rolka.value, 10) || 0;
    const dziubek = isPool ? 0 : parseInt(form.dziubek.value, 10) || 0;

    const selectedEventOpt = eventSelect.options[eventSelect.selectedIndex];
    const eventId = (!isPool && selectedEventOpt?.value) || undefined;
    const eventName = eventId ? (selectedEventOpt?.dataset?.eventName || undefined) : undefined;

    // Walidacja wszystkich pól naraz — każde brakujące pole dostaje komunikat pod sobą.
    const errors = {};
    if (!date) errors.date = "Wybierz datę.";
    else if (date > todayIso()) errors.date = "Data nie może być z przyszłości.";
    if (!waterType) errors.waterType = "Wybierz typ akwenu.";
    else if (DIFFICULTY_SCALES[waterType] && !difficulty) {
      errors.difficulty = waterType === "mountains" ? "Wybierz trudność (WW1–WW5)." : "Wybierz uciążliwość (U1–U3).";
    }
    if (!placeName) errors.placeName = "Wpisz nazwę rzeki lub akwenu.";
    if (lat == null || lng == null) errors.location = "Wybierz miejsce z podpowiedzi (📍), użyj „Moja lokalizacja” albo „Wybierz na mapie”.";
    if (noKm) { /* basen, tor / playspot — bez kilometrów */ }
    else if (String(form.km.value || "").trim() === "") errors.km = "Wpisz liczbę kilometrów (0 dla treningu bez trasy).";
    else if (isNaN(km) || km < 0 || km > 9999) errors.km = "Kilometry: liczba od 0 do 9999.";
    if (hoursRaw === "") errors.hoursOnWater = "Wpisz liczbę godzin (0, jeśli nie mierzono).";
    else if (isNaN(hoursOnWater) || hoursOnWater < 0 || hoursOnWater > 99) errors.hoursOnWater = "Godziny: liczba od 0 do 99.";
    if (Object.keys(errors).length) { showFieldErrors(errors); return; }

    btn.disabled = true;
    btn.textContent = "Zapisywanie…";

    try {
      const resp = await apiPostJson({
        url: KM_ADD_LOG_URL,
        idToken: ctx.idToken,
        body: {
          date,
          waterType,
          placeName,
          placeNameRaw: placeName,
          placeId,
          lat,
          lng,
          km,
          hoursOnWater,
          difficultyScale,
          difficulty,
          capsizeRolls: { kabina, rolka, dziubek },
          sectionDescription,
          note,
          eventId,
          eventName,
        },
      });

      if (resp?.ok) {
        invalidateKmCaches(); // wpis mógł dodać miejsce do słownika i wpis do imprezy
        resetForm();
        setOk("Aktywność zapisana! Punkty obliczone i dodane do Twojego rankingu.");
      } else {
        setErr(resp?.message || "Nie udało się zapisać aktywności.");
      }
    } catch (err) {
      if (err?.code === "location_required") showFieldErrors({ location: err.message });
      else if (err?.code === "difficulty_required") showFieldErrors({ difficulty: err.message });
      else setErr("Nie zapisano: " + (err?.message || String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = "Dodaj";
    }
  });
}

// ─── WIDOK: rankingi ──────────────────────────────────────────────────────────

async function renderRankingsView(inner, ctx) {
  const currentYear = new Date().getFullYear();
  const LIMIT = 50;
  const years = [];
  for (let y = currentYear; y >= 2010; y--) years.push(y);

  // Odczyt jednorazowy — kafelek na stronie głównej mógł poprosić o konkretny
  // typ rankingu (km/wywrotolotek/godziny). Bez wpisu w sessionStorage: domyślnie km.
  let preferredType = "km";
  try {
    const stored = sessionStorage.getItem(HOME_STAT_PREF_KEY);
    if (stored) {
      sessionStorage.removeItem(HOME_STAT_PREF_KEY);
      if (["km", "points", "hours"].includes(stored)) preferredType = stored;
    }
  } catch { /* ignore */ }

  // Typ rankingu jako kafelki; kolor typu (--tc) z km.css przez data-type sekcji.
  const RANK_TYPES = [
    { id: "km",     label: "Kilometrówka", unit: "km",  icon: ICON_RANK_KM },
    { id: "points", label: "Wywrotolotek", unit: "pkt", icon: ICON_RANK_POINTS },
    { id: "hours",  label: "Kajakogodziny", unit: "h",  icon: ICON_RANK_HOURS },
  ];

  inner.innerHTML = `
    <div class="kmRankingsSection" data-type="${esc(preferredType)}">
      <div class="kmRankingsControls">
        <div class="kmTypeTiles" role="tablist" aria-label="Typ rankingu">
          ${RANK_TYPES.map(t => `
            <button type="button" class="kmTypeTile${t.id === preferredType ? " active" : ""}" data-km-type="${t.id}">
              <span class="kmTypeTileIcon" aria-hidden="true">${t.icon}</span>
              <span>${esc(t.label)}</span>
            </button>
          `).join("")}
        </div>
        <div class="kmSegment" id="kmPeriodGroup" role="tablist" aria-label="Okres">
          <button type="button" class="kmSegBtn active" data-km-period="year">Bieżący rok</button>
          <button type="button" class="kmSegBtn" data-km-period="specificYear">Wybrany rok</button>
          <button type="button" class="kmSegBtn" data-km-period="alltime">Wszech czasów</button>
        </div>
        <div class="kmYearChips" id="kmYearGroup" hidden>
          ${years.map(y => `<button type="button" class="kmYearChip${y === currentYear - 1 ? " active" : ""}" data-km-year="${y}">${y}</button>`).join("")}
        </div>
      </div>
      <div id="kmRankingsTable">${spinnerHtml("Pobieranie rankingu…")}</div>
    </div>
  `;

  let activeType = preferredType;
  let activePeriod = "year";
  let activeYear = String(currentYear - 1);
  let requestSeq = 0;

  const yearGroup = inner.querySelector("#kmYearGroup");

  const periodTitle = () => activePeriod === "year" ? `Rok ${currentYear}`
    : activePeriod === "specificYear" ? `Rok ${activeYear}` : "Wszech czasów";

  async function loadRanking() {
    const seq = ++requestSeq;
    const tableEl = inner.querySelector("#kmRankingsTable");
    tableEl.innerHTML = spinnerHtml("Pobieranie rankingu…");
    try {
      let url = KM_RANKINGS_URL + `?type=${activeType}&period=${activePeriod}&limit=${LIMIT}`;
      if (activePeriod === "specificYear") url += `&year=${activeYear}`;
      const data = await apiGetJson({ url, idToken: ctx.idToken });
      if (seq !== requestSeq) return; // w międzyczasie kliknięto inny typ/okres
      const entries = data?.entries || [];
      const type = RANK_TYPES.find(t => t.id === activeType);
      const fmtV = (v) => activeType === "points" ? formatPoints(v) : fmtNum(v, 1);
      const myUid = ctx.session?.uid;

      if (!entries.length) {
        tableEl.innerHTML = `<div class="kmRankEmpty">Brak wyników — ${esc(periodTitle().toLowerCase())}.</div>`;
        return;
      }

      const me = entries.find(e => e.uid === myUid);
      const leader = entries[0]?.value || 1;
      const nameOf = (e) => e.nickname || e.displayName || "—";
      // Osoba z archiwum kilometrówki bez konta w aplikacji (km_archive_stats).
      const archTag = (e) => e.archive ? `<span class="kmArchTag" title="Dane z archiwum — osoba bez konta w aplikacji">archiwum</span>` : "";
      const hasArchive = entries.some(e => e.archive);

      const meBox = me
        ? `<div class="kmRankMeBox"><span>Twoje miejsce</span><b>${me.rank}.</b><span class="kmRankMeVal">${fmtV(me.value)} ${esc(type.unit)}</span></div>`
        : `<div class="kmRankMeBox kmRankMeNone"><span>${entries.length >= LIMIT ? `Nie ma Cię w pierwszej ${LIMIT}` : "Nie masz jeszcze wyniku w tym rankingu"}</span></div>`;

      // Podium 2 – 1 – 3 (te same style co w imprezach, kolor typu rankingu).
      const top = entries.slice(0, 3);
      const medals = ["🥇", "🥈", "🥉"];
      const podium = top.length >= 2 ? `
        <div class="kmPodium kmRankPodium">
          ${[1, 0, 2].filter(i => top[i]).map(i => `
            <div class="kmPodiumPlace kmPodium${i + 1}${top[i].uid === myUid ? " kmPodiumMe" : ""}">
              <span class="kmPodiumMedal">${medals[i]}</span>
              <span class="kmPodiumName">${esc(nameOf(top[i]))}</span>${archTag(top[i])}
              <span class="kmPodiumPts">${fmtV(top[i].value)} ${esc(type.unit)}</span>
              <span class="kmPodiumStep"></span>
            </div>
          `).join("")}
        </div>
      ` : "";

      const rest = top.length >= 2 ? entries.slice(3) : entries;

      tableEl.innerHTML = `
        <div class="kmRankHead">
          <div>
            <div class="kmRankHeadTitle">${esc(type.label)} · ${esc(periodTitle())}</div>
            <div class="kmRankHeadSub">${entries.length >= LIMIT ? `Pierwsze ${LIMIT} osób` : `${entries.length} ${entries.length === 1 ? "osoba" : "osób"} z wynikiem`}${hasArchive ? " · z archiwum" : activePeriod === "alltime" ? " · z danymi historycznymi" : ""}</div>
          </div>
          ${meBox}
        </div>
        ${podium}
        <div class="kmLbList">
          ${rest.map(e => `
            <div class="kmLbRow${e.uid === myUid ? " kmLbRowMe" : ""}">
              <span class="kmLbPos">${e.rank <= 3 ? rankMedal(e.rank) : `${e.rank}.`}</span>
              <div class="kmLbMain">
                <span class="kmLbName"><span class="kmLbNameTxt">${esc(nameOf(e))}</span>${e.uid === myUid ? `<em>Ty</em>` : ""}${archTag(e)}</span>
                <span class="kmLbBar"><span style="width:${Math.max(2, Math.min(100, (e.value / leader) * 100)).toFixed(1)}%"></span></span>
              </div>
              <span class="kmLbVal">${fmtV(e.value)}<small>${esc(type.unit)}</small></span>
            </div>
          `).join("")}
        </div>
      `;
    } catch (err) {
      if (seq !== requestSeq) return;
      tableEl.innerHTML = `<p class="errorMsg">Błąd: ${esc(err?.message || String(err))}</p>`;
    }
  }

  inner.querySelectorAll("[data-km-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      inner.querySelectorAll("[data-km-type]").forEach(b => b.classList.toggle("active", b === btn));
      activeType = btn.dataset.kmType;
      inner.querySelector(".kmRankingsSection").dataset.type = activeType;
      loadRanking();
    });
  });

  inner.querySelectorAll("[data-km-period]").forEach(btn => {
    btn.addEventListener("click", () => {
      inner.querySelectorAll("[data-km-period]").forEach(b => b.classList.toggle("active", b === btn));
      activePeriod = btn.dataset.kmPeriod;
      yearGroup.hidden = activePeriod !== "specificYear";
      loadRanking();
    });
  });

  inner.querySelectorAll("[data-km-year]").forEach(chip => {
    chip.addEventListener("click", () => {
      inner.querySelectorAll("[data-km-year]").forEach(c => c.classList.toggle("active", c === chip));
      activeYear = chip.dataset.kmYear;
      loadRanking();
    });
  });

  await loadRanking();
}

// ─── WIDOK: moje statystyki ────────────────────────────────────────────────────

const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

const STAT_TYPES = [
  { id: "km",     key: "km",     label: "Kilometrówka",  unit: "km",  icon: ICON_RANK_KM },
  { id: "hours",  key: "hours",  label: "Kajakogodziny", unit: "h",   icon: ICON_RANK_HOURS },
  { id: "points", key: "points", label: "Wywrotolotek",  unit: "pkt", icon: ICON_RANK_POINTS },
];

function fmtStat(type, v) {
  return type === "points" ? formatPoints(v) : fmtNum(v, 1);
}

// Pasek „na tle klubu”: skala 0 → lider; wypełnienie = ja, kreska = średnia aktywnych.
function clubBarHtml(t, m) {
  const max = m.max || 1;
  const pct = (v) => Math.max(0, Math.min(100, (v / max) * 100)).toFixed(1);
  const better = m.rank && m.active >= 3 ? Math.round(((m.active - m.rank) / m.active) * 100) : null;
  return `
    <div class="kmClubCard" data-type="${t.id}">
      <div class="kmClubHead">
        <span class="kmResultIcon" aria-hidden="true">${t.icon}</span>
        <span class="kmClubTitle">${esc(t.label)}</span>
        ${m.rank ? `<span class="kmClubRank">${m.rank}. miejsce <small>z ${m.active}</small></span>` : `<span class="kmClubRank kmClubRankNone">brak wpisów</span>`}
      </div>
      <div class="kmClubValue">${fmtStat(t.id, m.me)} <small>${t.unit}</small></div>
      <div class="kmClubBar" role="img" aria-label="${esc(`Ty: ${fmtStat(t.id, m.me)} ${t.unit}, średnia klubu: ${fmtStat(t.id, m.avg)} ${t.unit}, lider: ${fmtStat(t.id, m.max)} ${t.unit}`)}">
        <span class="kmClubBarFill" style="width:${pct(m.me)}%"></span>
        ${m.active ? `<span class="kmClubBarAvg" style="left:${pct(m.avg)}%"></span>` : ""}
      </div>
      <div class="kmClubLegend">
        <span><i class="kmDot kmDotAvg"></i>średnia ${fmtStat(t.id, m.avg)}</span>
        <span>lider ${fmtStat(t.id, m.max)}</span>
      </div>
      ${better != null ? `<div class="kmClubBetter">Więcej niż ${better}% aktywnych</div>` : ""}
    </div>
  `;
}

// Wykres miesięcy (SVG skalowany do szerokości). Przyszłe miesiące wyszarzone.
function monthsChartHtml(months, type, year) {
  const t = STAT_TYPES.find(x => x.id === type);
  const vals = months.map(m => Number(m[t.key]) || 0);
  const max = Math.max(...vals, 0);
  const now = new Date();
  const curMonth = now.getFullYear() === year ? now.getMonth() : 11;
  const W = 360, H = 150, top = 18, bottom = 20, gap = 6;
  const bw = (W - gap * 11) / 12;
  const bars = vals.map((v, i) => {
    const h = max ? Math.max(v > 0 ? 3 : 0, ((H - top - bottom) * v) / max) : 0;
    const x = i * (bw + gap);
    const y = H - bottom - h;
    const future = i > curMonth;
    return `
      <rect x="${x.toFixed(1)}" y="${top}" width="${bw.toFixed(1)}" height="${H - top - bottom}" rx="4" class="kmChartTrack${future ? " kmChartFuture" : ""}"/>
      ${h ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" class="kmChartBar"/>` : ""}
      ${v > 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="kmChartVal">${t.id === "points" ? formatPoints(v) : fmtNum(v, v >= 10 ? 0 : 1)}</text>` : ""}
      <text x="${(x + bw / 2).toFixed(1)}" y="${H - 5}" class="kmChartMonth${i === curMonth ? " kmChartNow" : ""}">${ROMAN_MONTHS[i]}</text>
    `;
  }).join("");
  return `<svg class="kmChart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${t.label} w kolejnych miesiącach ${year}`)}">${bars}</svg>`;
}

async function renderMyStatsView(inner, ctx) {
  inner.innerHTML = `
    <div id="kmStatsTop">${spinnerHtml("Pobieranie statystyk…")}</div>
    <div class="kmStatsLogs">
      <h3 class="kmSectionTitle">Moje wpisy</h3>
      <div id="kmStatsLogs">${spinnerHtml("Pobieranie wpisów…")}</div>
    </div>
  `;
  const topEl = inner.querySelector("#kmStatsTop");
  const logsPromise = renderMyLogsView(inner.querySelector("#kmStatsLogs"), ctx);

  let data;
  try {
    data = await apiGetJson({ url: KM_MY_STATS_URL + "?club=1", idToken: ctx.idToken });
  } catch (e) {
    topEl.innerHTML = `<p class="errorMsg">Błąd: ${esc(e?.message || String(e))}</p>`;
    await logsPromise;
    return;
  }

  const stats = data?.stats || {};
  const club = data?.club;
  const year = club?.year || new Date().getFullYear();
  const metrics = club?.metrics || {};
  const months = club?.months || [];

  if (!club) {
    topEl.innerHTML = `<p class="kmEmpty">Brak danych porównawczych.</p>`;
    await logsPromise;
    return;
  }

  const days = metrics.days || {};
  const logsM = metrics.logs || {};
  const miniCmp = (label, m) => {
    const max = Math.max(m.me || 0, m.avg || 0, 1);
    return `
      <div class="kmMiniCmp">
        <div class="kmMiniCmpLabel">${esc(label)}</div>
        <div class="kmMiniRow"><span>Ty</span><span class="kmMiniTrack"><span class="kmMiniFill kmMiniMe" style="width:${((m.me || 0) / max * 100).toFixed(1)}%"></span></span><b>${fmtNum(m.me || 0, 1)}</b></div>
        <div class="kmMiniRow"><span>Klub</span><span class="kmMiniTrack"><span class="kmMiniFill kmMiniAvg" style="width:${((m.avg || 0) / max * 100).toFixed(1)}%"></span></span><b>${fmtNum(m.avg || 0, 1)}</b></div>
      </div>
    `;
  };

  topEl.innerHTML = `
    <div class="kmStatsSection">
      <div class="kmStatsHeader">
        <h3 class="kmSectionTitle">Rok ${year} na tle klubu</h3>
        <p class="kmRankNote">Klub = ${metrics.km?.active ?? 0} osób z wpisami w ${year} r. Kreska na pasku to średnia, koniec paska — lider.</p>
      </div>

      <div class="kmClubGrid">
        ${STAT_TYPES.map(t => clubBarHtml(t, metrics[t.id] || { me: 0, rank: null, active: 0, avg: 0, max: 0 })).join("")}
      </div>

      <div class="kmMiniGrid">
        ${miniCmp("Dni na wodzie", days)}
        ${miniCmp("Wpisy", logsM)}
      </div>

      <div class="kmChartCard">
        <div class="kmChartHead">
          <span class="kmChartTitle">Moje miesiące ${year}</span>
          <div class="kmChartTabs" role="tablist">
            ${STAT_TYPES.map((t, i) => `<button type="button" class="kmChartTab${i === 0 ? " active" : ""}" data-chart-type="${t.id}" data-type="${t.id}">${esc(t.unit)}</button>`).join("")}
          </div>
        </div>
        <div class="kmChartWrap" data-type="km">${monthsChartHtml(months, "km", year)}</div>
      </div>

      <p class="kmAllTime">
        Od początku: <b>${fmtNum(stats.allTimeKm || 0)}</b> km · <b>${fmtNum(stats.allTimeHours || 0)}</b> h ·
        <b>${formatPoints(stats.allTimePoints)}</b> pkt · <b>${stats.allTimeLogs || 0}</b> wpisów
      </p>
    </div>
  `;

  const wrap = topEl.querySelector(".kmChartWrap");
  topEl.querySelectorAll("[data-chart-type]").forEach(b => {
    b.addEventListener("click", () => {
      topEl.querySelectorAll("[data-chart-type]").forEach(x => x.classList.toggle("active", x === b));
      wrap.dataset.type = b.dataset.chartType;
      wrap.innerHTML = monthsChartHtml(months, b.dataset.chartType, year);
    });
  });

  await logsPromise;
}

// ─── WIDOK: moje wpisy ─────────────────────────────────────────────────────────

async function renderMyLogsView(inner, ctx) {
  inner.innerHTML = spinnerHtml("Pobieranie wpisów…");

  let data;
  try {
    data = await apiGetJson({ url: KM_MY_LOGS_URL + "?limit=50", idToken: ctx.idToken });
  } catch (e) {
    inner.innerHTML = `<p class="errorMsg">Błąd: ${esc(e?.message || String(e))}</p>`;
    return;
  }

  const logs = data?.logs || [];

  if (!logs.length) {
    inner.innerHTML = `
      <div class="kmLogsEmpty">
        <p>Brak wpisów aktywności.</p>
        <p>Dodaj pierwszy wpis w zakładce „Dodaj wpis".</p>
      </div>
    `;
    return;
  }

  // Tabela pogrupowana po latach (wiersz-separator z rokiem), data bez roku — czytelna na telefonie.
  const capsizeText = (r) => [
    (r?.kabina || 0) > 0 ? `${r.kabina}× kabina` : "",
    (r?.rolka || 0) > 0 ? `${r.rolka}× rolka` : "",
    (r?.dziubek || 0) > 0 ? `${r.dziubek}× dziubek` : "",
  ].filter(Boolean).join(", ");

  let lastYear = null;
  const rows = logs.map(log => {
    const isHistorical = log.sourceType === "historical";
    const date = String(log.date || "").slice(0, 10);
    const year = date.slice(0, 4);
    const dayMonth = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(8, 10)}.${date.slice(5, 7)}` : "—";
    const meta = [
      !isHistorical && log.waterType ? esc(waterTypeLabel(log.waterType)) : "",
      log.difficulty ? esc(log.difficulty) : "",
      capsizeText(log.capsizeRolls) ? esc(capsizeText(log.capsizeRolls)) : "",
    ].filter(Boolean).join(" · ");
    const yearRow = year !== lastYear ? `<tr class="kmLogsYear"><td colspan="5">${esc(year || "—")}</td></tr>` : "";
    lastYear = year;
    return yearRow + `
      <tr class="${isHistorical ? "kmLogHistorical" : ""}">
        <td class="kmLogDate">${dayMonth}</td>
        <td class="kmLogPlaceCell">
          <span class="kmLogPlace">${esc(log.placeName || "—")}</span>
          ${log.eventName ? `<span class="kmLogChip">${esc(log.eventName)}</span>` : ""}
          ${isHistorical ? `<span class="kmLogChip kmLogChipMuted">historyczny</span>` : ""}
          ${meta ? `<span class="kmLogMeta">${meta}</span>` : ""}
          ${log.note ? `<span class="kmLogNote">${esc(log.note)}</span>` : ""}
        </td>
        <td class="kmNum">${log.km > 0 ? fmtNum(log.km) : "–"}</td>
        <td class="kmNum">${log.hoursOnWater ? fmtNum(log.hoursOnWater) : "–"}</td>
        <td class="kmNum kmLogPts">${log.pointsTotal ? formatPoints(log.pointsTotal) : "–"}</td>
      </tr>
    `;
  }).join("");

  inner.innerHTML = `
    <div class="kmLogsSection">
      <p class="kmRankNote">Ostatnie ${logs.length} wpisów, od najnowszego. Pkt = punkty za wywrotolotek.</p>
      <div class="kmTableWrap">
        <table class="kmTable kmLogsTable">
          <thead>
            <tr><th>Data</th><th>Akwen</th><th class="kmNum">km</th><th class="kmNum">h</th><th class="kmNum">pkt</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ─── WIDOK: imprezy ────────────────────────────────────────────────────────────

const MONTHS_SHORT = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];

// Kafelek daty: „05 / paź” albo „04–05 / paź” (różne miesiące: „30.09 – 02.10”).
function eventDateBadge(start, end) {
  const re = /^(\d{4})-(\d{2})-(\d{2})/;
  const ms = re.exec(String(start || ""));
  if (!ms) return `<div class="kmEvDate"><span class="kmEvDay">?</span></div>`;
  const me = re.exec(String(end || "")) || ms;
  const [, y1, m1, d1] = ms;
  const [, y2, m2, d2] = me;
  let day = d1;
  let mon = MONTHS_SHORT[Number(m1) - 1];
  if (`${y1}${m1}${d1}` !== `${y2}${m2}${d2}`) {
    if (y1 === y2 && m1 === m2) day = `${d1}–${d2}`;
    else { day = `${d1}.${m1}`; mon = `– ${d2}.${m2}`; }
  }
  return `
    <div class="kmEvDate${day.length > 2 ? " kmEvDateWide" : ""}">
      <span class="kmEvDay">${esc(day)}</span>
      <span class="kmEvMon">${esc(mon)}</span>
      <span class="kmEvYear">${esc(y1)}</span>
    </div>
  `;
}

function eventSummaryChips(sum) {
  if (!sum) return "";
  return `
    <div class="kmEvChips">
      <span class="kmEvChip">👥 ${sum.participants} ${sum.participants === 1 ? "osoba" : (sum.participants % 10 >= 2 && sum.participants % 10 <= 4 && (sum.participants % 100 < 12 || sum.participants % 100 > 14)) ? "osoby" : "osób"}</span>
      ${sum.km > 0 ? `<span class="kmEvChip" data-type="km">${fmtNum(sum.km, 1)} km</span>` : ""}
      ${sum.hours > 0 ? `<span class="kmEvChip" data-type="hours">${fmtNum(sum.hours, 1)} h</span>` : ""}
      ${sum.points > 0 ? `<span class="kmEvChip" data-type="points">${formatPoints(sum.points)} pkt</span>` : ""}
    </div>
  `;
}

function eventResultsHtml(data, myUid) {
  const ps = data.participants || [];
  const totals = data.totals || {};
  const withPoints = ps.filter(p => p.pointsTotal > 0);
  const medals = ["🥇", "🥈", "🥉"];
  // Podium: kolejność wizualna 2 – 1 – 3 (zwycięzca w środku, najwyżej).
  const podium = withPoints.length >= 2
    ? `
      <div class="kmPodium" data-type="points">
        ${[1, 0, 2].filter(i => withPoints[i]).map(i => {
          const p = withPoints[i];
          return `
            <div class="kmPodiumPlace kmPodium${i + 1}${p.uid === myUid ? " kmPodiumMe" : ""}">
              <span class="kmPodiumMedal">${medals[i]}</span>
              <span class="kmPodiumName">${esc(p.nickname || p.displayName || "—")}</span>
              <span class="kmPodiumPts">${formatPoints(p.pointsTotal)} pkt</span>
              <span class="kmPodiumStep"></span>
            </div>
          `;
        }).join("")}
      </div>
    `
    : "";

  const rolls = (p) => [
    p.capsizeKabina ? `<span class="kmRoll" title="kabina">kabina ×${p.capsizeKabina}</span>` : "",
    p.capsizeRolka ? `<span class="kmRoll" title="rolka">rolka ×${p.capsizeRolka}</span>` : "",
    p.capsizeDziubek ? `<span class="kmRoll" title="dziubek">dziubek ×${p.capsizeDziubek}</span>` : "",
  ].join("");

  return `
    <div class="kmEvTotals">
      <div><b>${ps.length}</b><span>uczestników</span></div>
      <div data-type="km"><b>${fmtNum(totals.km || 0, 1)}</b><span>km</span></div>
      <div data-type="hours"><b>${fmtNum(totals.hours || 0, 1)}</b><span>godzin</span></div>
      <div data-type="points"><b>${formatPoints(totals.pointsTotal)}</b><span>pkt</span></div>
    </div>
    ${podium}
    <div class="kmEvList">
      ${ps.map((p, i) => `
        <div class="kmEvRow${p.uid === myUid ? " kmEvRowMe" : ""}">
          <span class="kmEvPos">${i + 1}.</span>
          <div class="kmEvWho">
            <span class="kmEvName">${esc(p.nickname || p.displayName || "—")}</span>
            <span class="kmEvMeta">${[p.km > 0 ? `${fmtNum(p.km, 1)} km` : "", p.hours > 0 ? `${fmtNum(p.hours, 1)} h` : ""].filter(Boolean).join(" · ")}</span>
            ${rolls(p) ? `<span class="kmRolls">${rolls(p)}</span>` : ""}
          </div>
          <span class="kmEvPts${p.pointsTotal > 0 ? "" : " kmEvPtsZero"}">${formatPoints(p.pointsTotal)}<small>pkt</small></span>
        </div>
      `).join("")}
    </div>
  `;
}

async function renderEventStatsView(inner, ctx) {
  inner.innerHTML = spinnerHtml("Pobieranie imprez…");

  let eventsData, withLogs;
  try {
    [eventsData, withLogs] = await Promise.all([
      apiGetJson({ url: EVENTS_URL + "?mode=all", idToken: ctx.idToken }),
      loadEventIdsWithLogs(ctx),
    ]);
  } catch (e) {
    inner.innerHTML = `<p class="errorMsg">Błąd: ${esc(e?.message || String(e))}</p>`;
    return;
  }

  // Tylko imprezy z wpisami — bez nich statystyki byłyby puste. Najnowsze na górze.
  const events = (eventsData?.events || [])
    .filter(ev => withLogs.has(ev.id))
    .sort((x, y) => String(y.startDate || "").localeCompare(String(x.startDate || "")));

  if (!events.length) {
    inner.innerHTML = `<div class="kmStatsEmpty"><p>Brak imprez z wpisami.</p></div>`;
    return;
  }

  inner.innerHTML = `
    <div class="kmEventsSection">
      <p class="kmRankNote">Imprezy, z których są wpisy. Dotknij karty, żeby zobaczyć wyniki uczestników.</p>
      <div class="kmEvCards">
        ${events.map(ev => `
          <div class="kmEvCard" data-event-id="${esc(ev.id)}">
            <button type="button" class="kmEvHead" aria-expanded="false">
              ${eventDateBadge(ev.startDate, ev.endDate)}
              <div class="kmEvInfo">
                <span class="kmEvTitle">${esc(ev.name)}</span>
                ${ev.location && !isUrlOnly(ev.location) ? `<span class="kmEvLoc">📍 ${esc(ev.location)}</span>` : ""}
                ${eventSummaryChips(withLogs.get(ev.id))}
              </div>
              <span class="kmEvChevron" aria-hidden="true"></span>
            </button>
            <div class="kmEvBody" hidden></div>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  inner.querySelectorAll(".kmEvCard").forEach(card => {
    const head = card.querySelector(".kmEvHead");
    const body = card.querySelector(".kmEvBody");
    let loaded = false;

    head.addEventListener("click", async () => {
      const open = body.hidden;
      body.hidden = !open;
      card.classList.toggle("open", open);
      head.setAttribute("aria-expanded", String(open));
      if (!open || loaded) return;
      body.innerHTML = spinnerHtml("Pobieranie wyników…");
      try {
        const data = await apiGetJson({
          url: KM_EVENT_STATS_URL + "?eventId=" + encodeURIComponent(card.dataset.eventId),
          idToken: ctx.idToken,
        });
        body.innerHTML = data?.participants?.length
          ? eventResultsHtml(data, ctx.session?.uid)
          : `<p class="kmEmpty">Brak wpisów dla tej imprezy.</p>`;
        loaded = true;
      } catch (e) {
        body.innerHTML = `<p class="errorMsg">Błąd: ${esc(e?.message || String(e))}</p>`;
      }
    });
  });
}

// ─── ranking kursantów ─────────────────────────────────────────────────────────

async function renderKursantRankingView(inner, ctx) {
  inner.innerHTML = spinnerHtml("Pobieranie rankingu…");

  let data;
  try {
    data = await apiGetJson({ url: "/api/km/kursant-stats", idToken: ctx.idToken });
  } catch (e) {
    inner.innerHTML = `<p class="errorMsg">Błąd: ${esc(e?.message || String(e))}</p>`;
    return;
  }

  const leaderboard = data?.leaderboard || [];

  if (!leaderboard.length) {
    inner.innerHTML = `<div class="kmStatsEmpty"><p>Brak danych rankingowych. Dodaj pierwsze wywrotolotek!</p></div>`;
    return;
  }

  // Ten sam układ co ranking członków (typ „points” → bursztynowy akcent z km.css).
  const me = leaderboard.find(row => row.isMe);
  inner.innerHTML = `
    <div class="kmRankingsSection" data-type="points">
      ${me ? `
        <div class="kmKursantSummary">
          <div class="kmKursantSummaryItem">
            <span class="kmKursantSummaryValue">${esc(String(me.rank))}<small> / ${esc(String(leaderboard.length))}</small></span>
            <span class="kmKursantSummaryLabel">Twoje miejsce</span>
          </div>
          <div class="kmKursantSummaryItem">
            <span class="kmKursantSummaryValue">${formatPoints(me.total)}</span>
            <span class="kmKursantSummaryLabel">Twoje punkty</span>
          </div>
        </div>
      ` : ""}
      <p class="kmRankNote">Ranking kursantów — suma punktów za wywrotolotek (kabiny, eskimoski, dziubki).</p>
      <div class="kmRankingList">
        ${leaderboard.map(row => `
          <div class="kmRankRow${row.isMe ? " kmRankRowMe" : ""}">
            <span class="kmRankMedal">${rankMedal(row.rank)}</span>
            <span class="kmRankName">${esc(row.name)}${row.isMe ? " (Ty)" : ""}</span>
            <span class="kmRankValue">${formatPoints(row.total)} pkt</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

// ─── główny render ─────────────────────────────────────────────────────────────

async function renderKmView(viewEl, routeId, ctx, moduleId) {
  const isKursant = ctx?.session?.role_key === "rola_kursant" || ctx?.kursPreviewMode === true;
  const isSympatyk = ctx?.session?.role_key === "rola_sympatyk";
  const roleKey = isKursant ? "kursant" : isSympatyk ? "sympatyk" : "member";
  const visibleTabs = TAB_IDS_BY_ROLE[roleKey].map(id => TABS.find(t => t.id === id));
  // activeTab musi należeć do widocznych zakładek (sympatyk wchodzi domyślnie na "form" → ranking).
  // Stary link #/…/my-logs u członka → „Moje statystyki” (wpisy są tam pod statystykami).
  let requestedTab = TABS.find(t => t.id === routeId)?.id || "form";
  if (roleKey === "member" && requestedTab === "my-logs") requestedTab = "my-stats";
  const activeTab = visibleTabs.some(t => t.id === requestedTab) ? requestedTab : (visibleTabs[0]?.id || "rankings");

  if (!ctx?.idToken) {
    viewEl.innerHTML = `<div class="card center"><p>Brak tokenu sesji. Odśwież stronę.</p></div>`;
    return;
  }
  closeKmActivePopover();

  viewEl.innerHTML = `
    <div class="card wide kmModule">
      <div class="moduleHeader">
        ${isKursant ? "<h2>Wywrotolotek</h2>" : "<span></span>"}
        <div class="moduleNav">
          <button type="button" class="moduleNavBtn" data-mod-back title="Wróć">${NAV_BACK_SVG}</button>
          <button type="button" class="moduleNavBtn" data-mod-home title="Strona główna">${NAV_HOME_SVG}</button>
        </div>
      </div>
      <div class="modTiles" role="tablist" style="--tile-count:${visibleTabs.length}">
        ${visibleTabs.map(t => `
          <button type="button" class="modTile${t.add ? " modTileAdd" : ""}${t.id === activeTab ? " active" : ""}" data-km-tab="${esc(t.id)}">
            <span class="modTileIcon" aria-hidden="true">${t.icon}</span>
            <span class="modTileLabel">${esc(t.label)}</span>
          </button>
        `).join("")}
      </div>
      <div id="kmInner" class="kmInner">${spinnerHtml()}</div>
    </div>
  `;

  const inner = viewEl.querySelector("#kmInner");

  // Kafelek „Imprezy” znika, gdy żadna impreza nie ma wpisów (wejście z linku pokaże komunikat).
  const eventsTile = viewEl.querySelector('[data-km-tab="events"]');
  if (eventsTile) {
    loadEventIdsWithLogs(ctx).then((ids) => {
      if (ids.size || !eventsTile.isConnected) return;
      eventsTile.remove();
      const tiles = viewEl.querySelector(".modTiles");
      tiles?.style.setProperty("--tile-count", String(tiles.children.length));
    }).catch(() => { /* błąd listy — kafelek zostaje */ });
  }

  // Nawigacja
  viewEl.querySelector("[data-mod-home]")?.addEventListener("click", () => {
    import("/core/router.js").then(({ setHash }) => setHash("home", "home"));
  });
  viewEl.querySelector("[data-mod-back]")?.addEventListener("click", () => {
    import("/core/router.js").then(({ setHash }) => {
      if (activeTab !== "form") {
        setHash(moduleId, "form");
      } else {
        setHash("home", "home");
      }
    });
  });

  // Przełączanie zakładek
  viewEl.querySelectorAll("[data-km-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      import("/core/router.js").then(({ setHash }) => {
        setHash(moduleId, btn.dataset.kmTab);
      });
    });
  });

  attachInfoTips();

  // Renderuj aktywną zakładkę
  if (activeTab === "form") {
    if (isKursant) {
      renderKursantFormView(inner, ctx);
    } else {
      renderFormView(inner, ctx, moduleId);
    }
  } else if (activeTab === "rankings") {
    await renderRankingsView(inner, ctx);
  } else if (activeTab === "events") {
    await renderEventStatsView(inner, ctx);
  } else if (activeTab === "my-stats") {
    await renderMyStatsView(inner, ctx);
  } else if (activeTab === "my-logs") {
    await renderMyLogsView(inner, ctx);
  } else if (activeTab === "kursant-ranking") {
    await renderKursantRankingView(inner, ctx);
  }
}

// ─── export ────────────────────────────────────────────────────────────────────

export function createKmModule({ id, type, label, defaultRoute, order, enabled, access }) {
  return {
    id,
    type,
    label,
    defaultRoute: defaultRoute === "home" ? "form" : (defaultRoute || "form"),
    order,
    enabled,
    access,

    async render({ viewEl, routeId, ctx }) {
      await renderKmView(viewEl, routeId || "form", ctx, id);
    },
  };
}
