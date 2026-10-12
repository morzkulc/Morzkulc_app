/**
 * km_module.js
 *
 * Moduł Kilometrówka / Ranking.
 * Widoki: form (dodaj wpis), rankings (rankingi), my-stats (moje statystyki), my-logs (moje wpisy).
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
const ICON_TROPHY = TILE_SVG(`<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/>`);

// Kafelki nawigacji (wspólne .modTiles z base.css). „Gdzie pływamy" usunięte 12.10.2026 —
// mapa jest w module Klub. „Dodaj wpis" na końcu i wyróżniony (jak „Dodaj" w Godzinkach).
const TABS = [
  { id: "rankings",        label: "Rankingi", icon: ICON_TROPHY },
  { id: "events",          label: "Imprezy", icon: TILE_SVG(`<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`) },
  { id: "my-stats",        label: "Moje statystyki", icon: TILE_SVG(`<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="18" y1="20" x2="18" y2="9"/>`) },
  { id: "my-logs",         label: "Moje wpisy", icon: TILE_SVG(`<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>`) },
  { id: "kursant-ranking", label: "Wywrotolotek - wyniki", icon: ICON_TROPHY },
  { id: "form",            label: "Dodaj wpis", add: true, icon: TILE_SVG(`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`) },
];

// short + icon: kafelki wyboru w formularzu (6 w jednym rzędzie, także na telefonie).
const WATER_FILL = `<path d="M2 20c2.5-1.5 5 1.5 7.5 0s5-1.5 7.5 0 3.5 1 5 0"/>`;
const WATER_TYPES = [
  { value: "mountains", label: "Góry",                 short: "Góry",     icon: TILE_SVG(`<path d="M2 17l6-10 4 6 3-4 7 8z"/>${WATER_FILL}`) },
  { value: "lowlands",  label: "Niziny",               short: "Niziny",   icon: TILE_SVG(`<path d="M2 14c3-3 6-3 9 0s7 2 11-2"/>${WATER_FILL}`) },
  { value: "sea",       label: "Morze",                short: "Morze",    icon: TILE_SVG(`<circle cx="16" cy="7" r="3"/><path d="M2 14c2.5-1.5 5 1.5 7.5 0s5-1.5 7.5 0 3.5 1 5 0"/>${WATER_FILL}`) },
  { value: "track",     label: "Tor",                  short: "Tor",      icon: TILE_SVG(`<path d="M5 4h14"/><path d="M8 4v10"/><path d="M16 4v10"/>${WATER_FILL}`) },
  { value: "pool",      label: "Basen / kajak-polo",   short: "Basen",    icon: TILE_SVG(`<path d="M8 3v12"/><path d="M15 3v12"/><path d="M8 7h7"/><path d="M8 11h7"/>${WATER_FILL}`) },
  { value: "playspot",  label: "Playspot / freestyle", short: "Playspot", icon: TILE_SVG(`<path d="M3 16c3 0 4-8 10-8 3 0 5 2 5 4.5S16 16 14 16s-3-1.5-3-3"/>${WATER_FILL}`) },
];

const DIFFICULTY_WW = ["WW1", "WW2", "WW3", "WW4", "WW5"];
const DIFFICULTY_U  = ["U1", "U2", "U3"];

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

// Stan modułowy (nie per-wywołanie) — attachInfoTips jest wołane przy KAŻDYM
// renderKmView (każda zmiana zakładki w Kilometrówce robi pełny re-render). Wcześniej
// każde wywołanie dopinało NOWY `document.addEventListener("click", ..., {capture:true})`
// — nigdy nie usuwany (deklarowany cleanup `container.__closeKmPopover` nigdzie nie był
// odczytywany) — więc z każdą zmianą zakładki przybywał kolejny globalny nasłuchiwacz
// przechwytujący KAŻDE kliknięcie w całej aplikacji, nie tylko w tym module. Naprawione
// przez związanie delegacji do `document` RAZ na cały czas życia strony.
let kmActivePopover = null;
let kmPopoverDelegationBound = false;

function closeKmActivePopover() {
  if (kmActivePopover) {
    kmActivePopover.remove();
    kmActivePopover = null;
  }
}

function attachInfoTips(container) {
  container.querySelectorAll("[data-km-tip]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tip = btn.dataset.kmTip;
      if (kmActivePopover && kmActivePopover.dataset.srcBtn === btn) {
        closeKmActivePopover();
        return;
      }
      closeKmActivePopover();
      const pop = document.createElement("div");
      pop.className = "kmPopover";
      pop.dataset.srcBtn = btn;
      pop.textContent = tip;
      btn.parentNode.insertBefore(pop, btn.nextSibling);
      kmActivePopover = pop;
    });
  });

  if (!kmPopoverDelegationBound) {
    kmPopoverDelegationBound = true;
    document.addEventListener("click", closeKmActivePopover, { capture: true });
  }
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

function loadEventIdsWithLogs(ctx) {
  if (!eventIdsWithLogsPromise) {
    eventIdsWithLogsPromise = apiGetJson({ url: KM_EVENT_STATS_URL + "?list=1", idToken: ctx.idToken })
      .then((data) => new Set(data?.eventIds || []))
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
              <input type="number" id="kmKKabina" name="kabina" min="0" max="999" step="1" placeholder="0" />
            </div>
            <div class="kmCapsizeItem">
              <label for="kmKRolka">Rolka</label>
              <input type="number" id="kmKRolka" name="rolka" min="0" max="999" step="1" placeholder="0" />
            </div>
            <div class="kmCapsizeItem">
              <label for="kmKDziubek">Dziubek</label>
              <input type="number" id="kmKDziubek" name="dziubek" min="0" max="999" step="1" placeholder="0" />
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
  function setOk(msg)  { okEl.textContent = msg; okEl.hidden = false; errEl.hidden = true; }

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

        <div class="formRow" id="kmDifficultyRow" hidden>
          <label for="kmDifficulty">
            Trudność
            ${infoTip("WW1–WW5 dla rzek górskich. U1–U3 dla rzek nizinnych. Nie trzeba podawać.")}
          </label>
          <select id="kmDifficulty" name="difficulty">
            <option value="">— brak —</option>
          </select>
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

        <div class="formRow">
          <label for="kmSection">Odcinek (opcjonalnie)</label>
          <input type="text" id="kmSection" name="sectionDescription" maxlength="500"
            placeholder="np. Olsztynek – Brodnica Dolna" />
        </div>

        <div class="formRow" data-field="km">
          <label for="kmKm">Kilometry <span class="required">*</span></label>
          <input type="number" id="kmKm" name="km" min="0" max="9999" step="0.1"
            placeholder="np. 18.5 (wpisz 0 dla playspot / treningu bez trasy)" required />
        </div>

        <div class="formRow" data-field="hoursOnWater">
          <label for="kmHours">
            Godziny na wodzie <span class="required">*</span>
            ${infoTip("Całkowity czas spędzony na wodzie (w godzinach). Wpisz 0 jeśli nie mierzono.")}
          </label>
          <input type="number" id="kmHours" name="hoursOnWater" min="0" max="99" step="0.5"
            placeholder="np. 4.5 (wpisz 0 jeśli nie mierzono)" required />
        </div>

        <div class="formRow" id="kmEventRow">
          <label for="kmEvent">Impreza (opcjonalnie)</label>
          <select id="kmEvent" name="event">
            <option value="">— brak / nie dotyczy —</option>
          </select>
          <input type="hidden" id="kmEventName" />
        </div>

        <fieldset class="kmCapsizeFieldset">
          <legend>
            Wywrotolotek
            ${infoTip("Liczba udanych wywrotolotek podczas aktywności. Każda pozycja punktowana osobno.")}
          </legend>
          <div class="kmCapsizeGrid">
            <div class="kmCapsizeItem">
              <label for="kmKabina">Kabina</label>
              <input type="number" id="kmKabina" name="kabina" min="0" max="999" step="1" placeholder="0" />
            </div>
            <div class="kmCapsizeItem">
              <label for="kmRolka">Rolka</label>
              <input type="number" id="kmRolka" name="rolka" min="0" max="999" step="1" placeholder="0" />
            </div>
            <div class="kmCapsizeItem">
              <label for="kmDziubek">Dziubek</label>
              <input type="number" id="kmDziubek" name="dziubek" min="0" max="999" step="1" placeholder="0" />
            </div>
          </div>
        </fieldset>

        <div class="formRow">
          <label for="kmNote">Notatka (opcjonalnie)</label>
          <textarea id="kmNote" name="note" rows="2" maxlength="1000"
            placeholder="Krótka notatka do wpisu…"></textarea>
        </div>

        <div id="kmFormError" class="errorMsg" hidden></div>
        <div id="kmFormSuccess" class="successMsg" hidden></div>

        <div class="formActions">
          <button type="submit" id="kmSubmitBtn" class="primary">Zapisz aktywność</button>
        </div>
      </form>
    </div>
  `;

  // Dynamika formularza — trudność
  const waterTypeGroup = inner.querySelector("#kmWaterType");
  const difficultyRow = inner.querySelector("#kmDifficultyRow");
  const difficultySelect = inner.querySelector("#kmDifficulty");

  function updateDifficultyField() {
    const wt = inner.querySelector('input[name="waterType"]:checked')?.value || "";
    if (wt === "mountains") {
      difficultyRow.hidden = false;
      difficultySelect.innerHTML = `<option value="">— brak —</option>` +
        DIFFICULTY_WW.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    } else if (wt === "lowlands") {
      difficultyRow.hidden = false;
      difficultySelect.innerHTML = `<option value="">— brak —</option>` +
        DIFFICULTY_U.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    } else {
      difficultyRow.hidden = true;
      difficultySelect.value = "";
    }
  }

  waterTypeGroup.addEventListener("change", updateDifficultyField);

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
  function setOk(msg)  { okEl.textContent = msg; okEl.hidden = false; errEl.hidden = true; }

  const FIELD_LABELS = {
    date: "Data aktywności", waterType: "Typ akwenu", placeName: "Rzeka / akwen",
    location: "Lokalizacja", km: "Kilometry", hoursOnWater: "Godziny na wodzie",
  };

  function showFieldErrors(errors) {
    inner.querySelectorAll(".kmFieldErr").forEach(el => el.remove());
    inner.querySelectorAll(".formRow.kmFieldInvalid").forEach(el => el.classList.remove("kmFieldInvalid"));
    const keys = Object.keys(errors);
    if (!keys.length) return;
    for (const key of keys) {
      const row = inner.querySelector(`.formRow[data-field="${key}"]`);
      if (!row) continue;
      row.classList.add("kmFieldInvalid");
      const msg = document.createElement("div");
      msg.className = "kmFieldErr";
      msg.textContent = errors[key];
      row.appendChild(msg);
    }
    setErr(`Nie zapisano — popraw: ${keys.map(k => FIELD_LABELS[k] || k).join(", ")}.`);
    const first = inner.querySelector(".formRow.kmFieldInvalid");
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
    first?.querySelector("input:not([type=hidden]), select, textarea")?.focus({ preventScroll: true });
  }

  // Wywoływane też z setLocationDisplay (przed definicją — hoisting deklaracji funkcji).
  function clearFieldError(key) {
    const row = key && inner.querySelector(`.formRow[data-field="${key}"]`);
    if (!row?.classList.contains("kmFieldInvalid")) return;
    row.classList.remove("kmFieldInvalid");
    row.querySelector(".kmFieldErr")?.remove();
    if (!inner.querySelector(".formRow.kmFieldInvalid")) setErr("");
  }

  // Błąd znika, gdy użytkownik zacznie poprawiać dane pole.
  form.addEventListener("input", (e) => clearFieldError(e.target.closest(".formRow")?.dataset.field));
  form.addEventListener("change", (e) => clearFieldError(e.target.closest(".formRow")?.dataset.field));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setErr("");

    const date = String(form.date.value || "").trim();
    const waterType = String(form.waterType.value || "").trim();
    const placeName = String(form.placeName.value || "").trim();
    const km = parseFloat(form.km.value);
    const hoursRaw = String(form.hoursOnWater.value || "").trim();
    const hoursOnWater = parseFloat(hoursRaw);
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

    const kabina = parseInt(form.kabina.value, 10) || 0;
    const rolka = parseInt(form.rolka.value, 10) || 0;
    const dziubek = parseInt(form.dziubek.value, 10) || 0;

    const selectedEventOpt = eventSelect.options[eventSelect.selectedIndex];
    const eventId = selectedEventOpt?.value || undefined;
    const eventName = eventId ? (selectedEventOpt?.dataset?.eventName || undefined) : undefined;

    // Walidacja wszystkich pól naraz — każde brakujące pole dostaje komunikat pod sobą.
    const errors = {};
    if (!date) errors.date = "Wybierz datę.";
    else if (date > todayIso()) errors.date = "Data nie może być z przyszłości.";
    if (!waterType) errors.waterType = "Wybierz typ akwenu.";
    if (!placeName) errors.placeName = "Wpisz nazwę rzeki lub akwenu.";
    if (lat == null || lng == null) errors.location = "Wybierz miejsce z podpowiedzi (📍), użyj „Moja lokalizacja” albo „Wybierz na mapie”.";
    if (String(form.km.value || "").trim() === "") errors.km = "Wpisz liczbę kilometrów (0 dla playspotu / treningu bez trasy).";
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
        setOk("Aktywność zapisana! Punkty obliczone i dodane do Twojego rankingu.");
        invalidateKmCaches(); // wpis mógł dodać miejsce do słownika i wpis do imprezy
        form.reset();
        // reset() nie czyści input[type=hidden] — lokalizacja/placeId przechodziłyby na kolejny wpis.
        placeIdHidden.value = "";
        clearLocationDisplay();
        form.date.value = todayIso();
        difficultyRow.hidden = true;
      } else {
        setErr(resp?.message || "Nie udało się zapisać aktywności.");
      }
    } catch (err) {
      if (err?.code === "location_required") showFieldErrors({ location: err.message });
      else setErr("Nie zapisano: " + (err?.message || String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = "Zapisz aktywność";
    }
  });
}

// ─── WIDOK: rankingi ──────────────────────────────────────────────────────────

async function renderRankingsView(inner, ctx) {
  const currentYear = new Date().getFullYear();
  const yearOptions = [];
  for (let y = currentYear; y >= 2010; y--) {
    yearOptions.push(`<option value="${y}"${y === currentYear - 1 ? " selected" : ""}>${y}</option>`);
  }

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
    { id: "km",     label: "Kilometrówka", icon: TILE_SVG(`<path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 18c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 6c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/>`) },
    { id: "points", label: "Wywrotolotek", icon: TILE_SVG(`<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>`) },
    { id: "hours",  label: "Kajakogodziny", icon: TILE_SVG(`<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>`) },
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
        <div class="kmControlGroup">
          <label>Okres:</label>
          <div class="kmBtnGroup" id="kmPeriodGroup">
            <button class="kmRankBtn active" data-km-period="year">Bieżący rok</button>
            <button class="kmRankBtn" data-km-period="specificYear">Wybrany rok</button>
            <button class="kmRankBtn" data-km-period="alltime">Wszech czasów</button>
          </div>
        </div>
        <div class="kmControlGroup" id="kmYearGroup" style="display:none">
          <label>Rok:</label>
          <select id="kmYearSelect" class="kmYearSelect">${yearOptions.join("")}</select>
        </div>
      </div>
      <div id="kmRankingsTable">${spinnerHtml("Pobieranie rankingu…")}</div>
    </div>
  `;

  let activeType = preferredType;
  let activePeriod = "year";

  const yearGroup = inner.querySelector("#kmYearGroup");
  const yearSelect = inner.querySelector("#kmYearSelect");

  async function loadRanking() {
    const tableEl = inner.querySelector("#kmRankingsTable");
    tableEl.innerHTML = spinnerHtml("Pobieranie rankingu…");
    try {
      let url = KM_RANKINGS_URL + `?type=${activeType}&period=${activePeriod}&limit=50`;
      if (activePeriod === "specificYear") {
        const yr = yearSelect?.value || String(currentYear - 1);
        url += `&year=${yr}`;
      }
      const data = await apiGetJson({ url, idToken: ctx.idToken });
      const entries = data?.entries || [];
      const typeLabel = { km: "km", points: "pkt", hours: "h" }[activeType] || "";

      if (!entries.length) {
        tableEl.innerHTML = `<p class="kmEmpty">Brak danych rankingowych.</p>`;
        return;
      }

      let infoText;
      if (activePeriod === "year") {
        infoText = `<p class="kmRankNote">Ranking dotyczy bieżącego roku. Dane historyczne wliczane do rankingu wszech czasów.</p>`;
      } else if (activePeriod === "specificYear") {
        infoText = `<p class="kmRankNote">Ranking za rok ${esc(data?.year || "")}.</p>`;
      } else {
        infoText = `<p class="kmRankNote">Ranking wszech czasów — uwzględnia dane historyczne i bieżące.</p>`;
      }

      tableEl.innerHTML = infoText + `
        <div class="kmRankingList">
          ${entries.map(e => {
            const isMe = e.uid === ctx.session?.uid;
            const name = e.nickname || e.displayName || "—";
            return `
              <div class="kmRankRow${isMe ? " kmRankRowMe" : ""}">
                <span class="kmRankMedal">${rankMedal(e.rank)}</span>
                <span class="kmRankName">${esc(name)}</span>
                <span class="kmRankValue">${activeType === "points" ? formatPoints(e.value) : fmtNum(e.value, 1)} ${esc(typeLabel)}</span>
              </div>
            `;
          }).join("")}
        </div>
      `;
    } catch (err) {
      tableEl.innerHTML = `<p class="errorMsg">Błąd: ${esc(err?.message || String(err))}</p>`;
    }
  }

  // Event handlers dla przycisków
  inner.querySelectorAll("[data-km-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      inner.querySelectorAll("[data-km-type]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeType = btn.dataset.kmType;
      inner.querySelector(".kmRankingsSection").dataset.type = activeType;
      loadRanking();
    });
  });

  inner.querySelectorAll("[data-km-period]").forEach(btn => {
    btn.addEventListener("click", () => {
      inner.querySelectorAll("[data-km-period]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activePeriod = btn.dataset.kmPeriod;
      yearGroup.style.display = activePeriod === "specificYear" ? "" : "none";
      loadRanking();
    });
  });

  yearSelect?.addEventListener("change", () => {
    if (activePeriod === "specificYear") loadRanking();
  });

  await loadRanking();
}

// ─── WIDOK: moje statystyki ────────────────────────────────────────────────────

async function renderMyStatsView(inner, ctx) {
  inner.innerHTML = spinnerHtml("Pobieranie statystyk…");

  let data;
  try {
    data = await apiGetJson({ url: KM_MY_STATS_URL, idToken: ctx.idToken });
  } catch (e) {
    inner.innerHTML = `<p class="errorMsg">Błąd: ${esc(e?.message || String(e))}</p>`;
    return;
  }

  const stats = data?.stats;

  if (!stats) {
    inner.innerHTML = `
      <div class="kmStatsEmpty">
        <p>Nie masz jeszcze żadnych wpisów aktywności.</p>
        <p>Dodaj pierwszy wpis w zakładce „Dodaj wpis".</p>
      </div>
    `;
    return;
  }

  const currentYear = new Date().getFullYear();

  inner.innerHTML = `
    <div class="kmStatsSection">
      <h3>Wszech czasów</h3>
      <div class="kmStatsGrid">
        <div class="kmStatCard">
          <span class="kmStatValue">${fmtNum(stats.allTimeKm)}</span>
          <span class="kmStatLabel">km</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${formatPoints(stats.allTimePoints)}</span>
          <span class="kmStatLabel">punktów</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${fmtNum(stats.allTimeHours)}</span>
          <span class="kmStatLabel">godzin</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${stats.allTimeDays || 0}</span>
          <span class="kmStatLabel">dni</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${stats.allTimeLogs || 0}</span>
          <span class="kmStatLabel">wpisów</span>
        </div>
      </div>

      <h3>Wywrotolotek (łącznie)</h3>
      <div class="kmStatsGrid kmStatsGridSmall">
        <div class="kmStatCard">
          <span class="kmStatValue">${stats.allTimeCapsizeKabina || 0}</span>
          <span class="kmStatLabel">kabina</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${stats.allTimeCapsizeRolka || 0}</span>
          <span class="kmStatLabel">rolka</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${stats.allTimeCapsizeDziubek || 0}</span>
          <span class="kmStatLabel">dziubek</span>
        </div>
      </div>

      <h3>Rok ${currentYear}</h3>
      <div class="kmStatsGrid">
        <div class="kmStatCard">
          <span class="kmStatValue">${fmtNum(stats.yearKm || 0)}</span>
          <span class="kmStatLabel">km</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${formatPoints(stats.yearPoints)}</span>
          <span class="kmStatLabel">punktów</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${fmtNum(stats.yearHours || 0)}</span>
          <span class="kmStatLabel">godzin</span>
        </div>
        <div class="kmStatCard">
          <span class="kmStatValue">${stats.yearLogs || 0}</span>
          <span class="kmStatLabel">wpisów</span>
        </div>
      </div>
      ${(() => {
        const yearsData = stats.years || {};
        const sortedYears = Object.keys(yearsData).sort((a, b) => b.localeCompare(a));
        if (!sortedYears.length) return "";
        const rows = sortedYears.map(yr => {
          const y = yearsData[yr];
          return `<tr><td>${esc(yr)}</td><td>${fmtNum(y.km)}</td><td>${formatPoints(y.points)}</td><td>${fmtNum(y.hours)}</td><td>${y.days || 0}</td></tr>`;
        }).join("");
        return `
          <h3>Statystyki roczne</h3>
          <table class="kmYearsTable">
            <thead><tr><th>Rok</th><th>km</th><th>pkt</th><th>godz</th><th>dni</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      })()}
    </div>
  `;
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

async function renderEventStatsView(inner, ctx) {
  inner.innerHTML = spinnerHtml("Pobieranie imprez…");

  let eventsData, idsWithLogs;
  try {
    [eventsData, idsWithLogs] = await Promise.all([
      apiGetJson({ url: EVENTS_URL + "?mode=all", idToken: ctx.idToken }),
      loadEventIdsWithLogs(ctx),
    ]);
  } catch (e) {
    inner.innerHTML = `<p class="errorMsg">Błąd: ${esc(e?.message || String(e))}</p>`;
    return;
  }

  // Tylko imprezy z wpisami — bez nich statystyki byłyby puste.
  const events = (eventsData?.events || []).filter(ev => idsWithLogs.has(ev.id));

  if (!events.length) {
    inner.innerHTML = `<div class="kmStatsEmpty"><p>Brak imprez z wpisami.</p></div>`;
    return;
  }

  inner.innerHTML = `
    <div class="kmEventsSection">
      <p class="kmRankNote">Kliknij imprezę aby zobaczyć statystyki wywrotolotek uczestników.</p>
      <div id="kmEventsList">
        ${events.map(ev => {
          const dateRange = ev.startDate === ev.endDate
            ? ev.startDate
            : `${ev.startDate} – ${ev.endDate}`;
          return `
            <div class="kmEventCard" data-event-id="${esc(ev.id)}" data-event-name="${esc(ev.name)}">
              <div class="kmEventCardHeader">
                <div class="kmEventCardInfo">
                  <span class="kmEventCardName">${esc(ev.name)}</span>
                  <span class="kmEventCardDate">${esc(dateRange)}</span>
                  ${ev.location && !isUrlOnly(ev.location) ? `<span class="kmEventCardLoc">${esc(ev.location)}</span>` : ""}
                </div>
                <button class="kmEventStatsBtn" type="button">Statystyki</button>
              </div>
              <div class="kmEventStatsPanel" style="display:none"></div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;

  inner.querySelectorAll(".kmEventCard").forEach(card => {
    const btn = card.querySelector(".kmEventStatsBtn");
    const panel = card.querySelector(".kmEventStatsPanel");
    const eventId = card.dataset.eventId;
    let loaded = false;

    btn.addEventListener("click", async () => {
      const isOpen = panel.style.display !== "none";
      if (isOpen) {
        panel.style.display = "none";
        btn.textContent = "Statystyki";
        return;
      }
      panel.style.display = "";
      btn.textContent = "Ukryj";

      if (loaded) return;
      panel.innerHTML = spinnerHtml("Pobieranie…");

      try {
        const data = await apiGetJson({
          url: KM_EVENT_STATS_URL + "?eventId=" + encodeURIComponent(eventId),
          idToken: ctx.idToken,
        });

        if (!data?.participants?.length) {
          panel.innerHTML = `<p class="kmEmpty">Brak wpisów km dla tej imprezy.</p>`;
          loaded = true;
          return;
        }

        const totals = data.totals || {};
        const rows = data.participants.map(p => {
          const name = p.nickname || p.displayName || "—";
          return `<tr>
            <td>${esc(name)}</td>
            <td>${p.capsizeKabina}</td>
            <td>${p.capsizeRolka}</td>
            <td>${p.capsizeDziubek}</td>
            <td><strong>${formatPoints(p.pointsTotal)}</strong></td>
          </tr>`;
        }).join("");

        panel.innerHTML = `
          <table class="kmTable kmEventTable">
            <thead>
              <tr><th>Uczestnik</th><th class="kmNum">kabina</th><th class="kmNum">rolka</th><th class="kmNum">dziubek</th><th class="kmNum">pkt</th></tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr class="kmEventTotals">
                <td>RAZEM</td>
                <td>${totals.capsizeKabina || 0}</td>
                <td>${totals.capsizeRolka || 0}</td>
                <td>${totals.capsizeDziubek || 0}</td>
                <td><strong>${formatPoints(totals.pointsTotal)}</strong></td>
              </tr>
            </tfoot>
          </table>
        `;
        loaded = true;
      } catch (e) {
        panel.innerHTML = `<p class="errorMsg">Błąd: ${esc(e?.message || String(e))}</p>`;
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
  // Sympatyk tylko przegląda: ranking i imprezy (bez dodawania wpisów i własnych statystyk).
  const visibleTabs = isKursant
    ? TABS.filter(t => t.id !== "rankings" && t.id !== "events" && t.id !== "my-stats")
    : isSympatyk
      ? TABS.filter(t => t.id === "rankings" || t.id === "events")
      : TABS.filter(t => t.id !== "kursant-ranking");
  // activeTab musi należeć do widocznych zakładek (sympatyk wchodzi domyślnie na "form" → ranking).
  const requestedTab = TABS.find(t => t.id === routeId)?.id || "form";
  const activeTab = visibleTabs.some(t => t.id === requestedTab) ? requestedTab : (visibleTabs[0]?.id || "rankings");

  if (!ctx?.idToken) {
    viewEl.innerHTML = `<div class="card center"><p>Brak tokenu sesji. Odśwież stronę.</p></div>`;
    return;
  }

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

  // Attach tooltips
  attachInfoTips(viewEl);

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
