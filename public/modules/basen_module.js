// public/modules/basen_module.js
import { apiGetJson, apiPostJson } from "/core/api_client.js";

const NAV_BACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const NAV_HOME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
// Ikonki w komórkach kalendarza admina — basen (fala) i sauna (płomień) zaznaczane
// OSOBNO, żeby dało się na pierwszy rzut oka odróżnić dzień z samą sauną od dnia
// z basenem (albo obiema).
const POOL_ICON_SVG = `<svg class="basenCalIcon basenCalIconPool" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 17c1.5-2 3.5-2 5 0s3.5 2 5 0 3.5-2 5 0 3.5 2 5 0"/><path d="M2 12c1.5-2 3.5-2 5 0s3.5 2 5 0 3.5-2 5 0 3.5 2 5 0"/></svg>`;
const SAUNA_ICON_SVG = `<svg class="basenCalIcon basenCalIconSauna" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1 3-3 4-3 8a3 3 0 0 0 6 0c0-1-1-2-1-2 2 1 3 3 3 5a5 5 0 0 1-10 0c0-5 5-6 5-11z"/></svg>`;

const SESSIONS_URL = "/api/basen/sessions";
const ENROLL_URL = "/api/basen/enroll";
const CANCEL_ENROLL_URL = "/api/basen/cancel-enrollment";
const CREATE_SESSION_URL = "/api/basen/sessions/create";
const CANCEL_SESSION_URL = "/api/basen/sessions/cancel";
const ADD_SAUNA_URL = "/api/basen/sessions/add-sauna";
const SET_KAYAK_URL = "/api/basen/kayak";
const SET_INSTRUCTOR_URL = "/api/basen/instructor";
const CLAIM_URL = "/api/basen/instructor/claim";
const KAYAKS_URL = "/api/basen/kayaks";
const ATTENDEES_URL = "/api/basen/attendees";
const GODZINY_USERS_URL = "/api/basen/admin/godziny/users";
const GODZINY_ADD_URL = "/api/basen/admin/godziny/add";
const GODZINY_HISTORY_URL = "/api/basen/admin/godziny/history";
const GODZINY_MY_URL = "/api/basen/godziny/my";
const ORDER_URL = "/api/basen/order";

const SLOT_ORDER = ["H1", "H2", "SAUNA"];
const SLOT_LABELS = { H1: "I godzina", H2: "II godzina", SAUNA: "Sauna" };
const SEEKING_SENTINEL = "__SEEKING__";

// Pełny tekst na desktopie, skrócony na mobile (przełącznik czysto CSS-owy przez
// media query, patrz .basenBtnTextFull/.basenBtnTextShort w basen.css) — żeby obok
// "Edytuj" zmieściło się w jednym rzędzie na wąskim ekranie.
const CANCEL_BTN_HTML = `<span class="basenBtnTextFull">Zrezygnuj z basenu</span><span class="basenBtnTextShort">Zrezygnuj</span>`;

// Musi być identyczny z render_shell.js::HOME_BASEN_SCROLL_TARGET_KEY — kalendarz
// basenowy na stronie głównej zapisuje tu docelową datę przed nawigacją (router.js
// obsługuje tylko jeden segment ścieżki, sessionStorage to najprostszy handoff).
// ID karty dnia = data sesji (basen_sessions/{date} ma deterministyczne ID = data).
const HOME_SCROLL_TARGET_KEY = "basenHomeScrollTarget";

// ─── helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function spinnerHtml(text = "Ładowanie…") {
  return `<div class="thinking">${esc(text)}<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const days = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];
  const d = new Date(`${iso}T12:00:00`);
  const dayName = days[d.getDay()] || "";
  return `${m[3]}.${m[2]}.${m[1]} (${dayName})`;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function renderTabsHtml(activeTab, isAdmin) {
  // "Moje konto" (historia własnych godzin basenowych) widoczne dla WSZYSTKICH —
  // to nie funkcja administracyjna, każdy user ma prawo widzieć swój wyciąg.
  // Obsługa widzi też „Baseny" — widok terminów oczami członka i własne zapisy.
  const tabs = isAdmin
    ? [
      { id: "sessions", label: "Baseny" },
      { id: "calendar", label: "Dodaj / usuń basen" },
      { id: "finance", label: "Finanse" },
      { id: "payments", label: "Płatności" },
      { id: "account", label: "Moje konto" },
    ]
    : [
      { id: "sessions", label: "Baseny" },
      { id: "account", label: "Moje konto" },
    ];

  return `<div class="modTabs basenTabs">
    ${tabs.map((t) => `
      <button type="button"
        class="modTab basenTab${t.id === activeTab ? " active" : ""}"
        data-basen-tab="${esc(t.id)}"
      >${esc(t.label)}</button>
    `).join("")}
  </div>`;
}

// ─── Slot card ────────────────────────────────────────────────────────────────

function renderSlotCard(sessionId, slotKey, slot, ctx, canEnroll, session = null) {
  const remaining = Number(slot.remaining ?? (slot.capacity - slot.enrolledCount));
  const isCancelled = slot.status === "cancelled";
  const isFull = !isCancelled && slot.isFull === true;
  const isSauna = slotKey === "SAUNA";

  // Wolne miejsca zawsze jako „X z Y" — żeby „brak miejsc" nie mylił się z brakiem
  // opłaconych godzin basenowych (to dwie różne rzeczy).
  const totalSpots = Number(slot.capacity) || 0;
  let spotsHtml;
  if (isCancelled) spotsHtml = `<span class="basenSpotsFull">Odwołane</span>`;
  else if (isFull) spotsHtml = `<span class="basenSpotsFull">Wolne miejsca: 0 z ${totalSpots} — lista rezerwowa</span>`;
  else spotsHtml = `<span class="basenSpots">Wolne miejsca: ${remaining} z ${totalSpots}</span>`;

  const reservedNote = (!isSauna && slot.reservedSpots && slot.reservedSpots.count > 0)
    ? `<div class="basenReservedNote">${slot.reservedSpots.count} miejsc zarezerwowanych${slot.reservedSpots.restrictedToKursant ? " dla kursantów" : ""}</div>`
    : "";

  const canBeInstructor = !isSauna && !isCancelled && ctx?.session?.basenInstructor === true;
  const isInstructorEnrolled = slot.userEnrolled && slot.userEnrollmentType === "instructor";
  const isParticipantEnrolled = slot.userEnrolled && slot.userEnrollmentType !== "instructor";

  // Prosta, zawsze widoczna lista uczestników — bez rozwijania, bez kajaka. Ksywka,
  // a jak brak to imię+nazwisko. Instruktorzy zawsze na górze (lekka kreska oddziela
  // ich od reszty), sparowany uczestnik (training + instructorUid) pokazany zwyczajnie
  // obok niebieskiego kafelka z imieniem przypisanego instruktora. Osoba szukająca
  // instruktora dostaje klikalny kafelek (zamiast osobnego przycisku) TYLKO dla widza,
  // który sam jest instruktorem na ten slot — klik od razu go do niej przypisuje.
  const attendeesList = Array.isArray(slot.attendees) ? slot.attendees : [];
  const instructorAttendees = attendeesList.filter((a) => a.type === "instructor");
  const otherAttendees = attendeesList.filter((a) => a.type !== "instructor");
  const instructorLabelByUid = new Map(instructorAttendees.map((a) => [a.userUid, a.displayLabel]));

  // Własny kajak (skrócona etykieta: model, kolor, nr — bez marki) dopisywany TYLKO
  // przy własnym wierszu na liście uczestników — cudze kajaki nikogo nie interesują
  // (patrz komentarz przy .basenOwnKayakTag w basen.css: obcina się wielokropkiem,
  // żeby zawsze zmieścić się w jednym wierszu na mobile).
  const myUid = ctx?.session?.uid || "";
  const ownKayakTagHtml = (!isSauna && slot.userKayakId && slot.userKayakCompactLabel)
    ? ` <span class="basenOwnKayakTag" title="${esc(slot.userKayakLabel || "")}">${esc(slot.userKayakCompactLabel)}</span>`
    : "";

  const renderOtherAttendeeRow = (a) => {
    const label = esc(a.displayLabel);
    const ownKayakSuffix = a.userUid === myUid ? ownKayakTagHtml : "";
    if (a.type === "training" && a.instructorUid) {
      // Uczestnik zwyczajnie (bez niebieskiego tła, bez "+") — niebieski kafelek
      // zostaje TYLKO na przypisanym instruktorze, spójnie z listą instruktorów wyżej.
      const instructorLabel = instructorLabelByUid.get(a.instructorUid);
      return `<div class="basenAttendeeRow">${label}${instructorLabel ? ` <span class="basenAttendeeTag">${esc(instructorLabel)}</span>` : ""}${ownKayakSuffix}</div>`;
    }
    if (a.type === "training" && !a.instructorUid) {
      return isInstructorEnrolled
        ? `<button type="button" class="basenAttendeeTag basenClaimTagBtn" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}" data-target-uid="${esc(a.userUid)}" title="Kliknij, aby przypisać siebie jako instruktora">${label} — potrzebuje instruktora</button>`
        : `<div class="basenAttendeeRow">${label} <span class="basenAttendeeTag">potrzebuje instruktora</span>${ownKayakSuffix}</div>`;
    }
    if (a.ratownik) return `<div class="basenAttendeeRow">${label} <span class="basenAttendeeTag">ratownik</span>${ownKayakSuffix}</div>`;
    return `<div class="basenAttendeeRow">${label}${ownKayakSuffix}</div>`;
  };
  const attendeesHtml = !isCancelled && attendeesList.length ? `
    <div class="basenAttendeesSimple">
      <div class="basenAttendeesSimpleTitle">Uczestnicy</div>
      ${instructorAttendees.map((a) => `<div class="basenAttendeeRow">${esc(a.displayLabel)} <span class="basenAttendeeTag">instruktor</span>${a.userUid === myUid ? ownKayakTagHtml : ""}</div>`).join("")}
      ${instructorAttendees.length && otherAttendees.length ? `<div class="basenAttendeeDivider"></div>` : ""}
      ${otherAttendees.map(renderOtherAttendeeRow).join("")}
    </div>
  ` : "";

  let footerHtml = "";

  // "Będę instruktorem" — kolor/waga wizualna wyraźnie inna niż .ghost (ta znikała
  // w ciemnym motywie) i inna niż .primary ("Zapisz się"), żeby dwa różne działania
  // w jednym rzędzie dało się od razu odróżnić. Wstrzykiwane w tym samym rzędzie co
  // "Zapisz się" gdy oba są realną opcją (slot ma miejsca); w pozostałych gałęziach
  // (pełny/brak uprawnień/odwołany) zostaje dopisywane osobno, tak jak dotychczas —
  // instruktor może zapisać się nawet gdy pula uczestnicka jest pełna.
  const instructorBtnHtml = (!isCancelled && !isInstructorEnrolled && !isParticipantEnrolled && canEnroll && canBeInstructor)
    ? `<button type="button" class="basenInstructorBtn basenBtnAccent" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">Będę instruktorem</button>`
    : "";
  let instructorBtnEmbedded = false;

  // „Będę ratownikiem" — tylko opiekun basenu (basenOpiekun z /api/register), jeden ratownik
  // na termin. Ratownik zajmuje miejsce na godzinie, nie płaci godziną basenową, a po
  // odbytym terminie dostaje 1 godzinkę klubową.
  const ratownikBtnHtml = (!isCancelled && !isSauna && !isFull && !isInstructorEnrolled && !isParticipantEnrolled &&
    ctx?.session?.basenOpiekun === true && session && !session.ratownikUid)
    ? `<button type="button" class="basenRatownikBtn basenBtnAccent" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">Będę ratownikiem</button>`
    : "";

  if (isCancelled) {
    footerHtml = `<span class="basenHint">Ten slot został odwołany.</span>`;
  } else if (isInstructorEnrolled) {
    // Bez zielonej/tekstowej plakietki "Zapisany/a..." — status "jestem tu zapisany"
    // pokazuje sama ramka karty (patrz basenSlotCard--mine/--instructing niżej).
    // "Edytuj" tu = dopisz sobie osobę szukającą instruktora (do 2 naraz, wyłącznie
    // decyzja instruktora — patrz claimWaitingStudent). Ten sam kafelek jest też
    // klikalny bezpośrednio na liście uczestników (.basenClaimTagBtn); ten przycisk
    // to bardziej odkrywalna, jawna droga do tego samego.
    footerHtml = `
      <div class="basenEnrolledActions">
        <button type="button" class="ghost basenClaimEditBtn" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">Edytuj</button>
        <button type="button" class="dangerBtn basenCancelBtn" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">${CANCEL_BTN_HTML}</button>
      </div>
    `;
  } else if (isParticipantEnrolled) {
    // Bez "z instruktorem"/"szukam instruktora" ani pełnej nazwy kajaka tutaj — oba
    // powielały dokładnie to, co już widać na liście "Uczestnicy" wyżej (mój wiersz +
    // tag instruktora/"potrzebuje instruktora" + skrócona nazwa kajaka), tylko robiły
    // bałagan.
    footerHtml = `
      <div class="basenEnrolledActions">
        ${!isSauna ? `<button type="button" class="ghost basenModifyBtn" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}" data-current-kayak-id="${esc(slot.userKayakId || "")}" data-current-instructor-uid="${esc(slot.userInstructorUid || "")}" data-current-type="${esc(slot.userEnrollmentType || "")}">Edytuj</button>` : ""}
        <button type="button" class="dangerBtn basenCancelBtn" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}" data-within-window="${slot.isWithinCancellationWindow ? "1" : "0"}">${CANCEL_BTN_HTML}</button>
      </div>
    `;
  } else if (!canEnroll) {
    footerHtml = `<span class="basenHint">Tylko dla członków klubu.</span>`;
  } else if (isFull && slot.userWaitlistPosition) {
    footerHtml = `
      <div class="basenEnrolledActions">
        <span class="basenWaitlistBadge">Lista rezerwowa — miejsce ${esc(slot.userWaitlistPosition)}</span>
        <button type="button" class="ghost basenWaitlistLeaveBtn" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">Wypisz z listy</button>
      </div>
      <div class="basenHint">Gdy zwolni się miejsce, zapiszemy Cię automatycznie (pobierze jedną godzinę basenową) i wyślemy maila.</div>
    `;
  } else if (isFull && !isSauna && !slot.viaReservedPool) {
    const waitingHtml = slot.waitlistCount ? ` <span class="basenHint">Na liście: ${esc(slot.waitlistCount)}</span>` : "";
    footerHtml = `
      <div class="basenPrimaryActions">
        <button type="button" class="ghost basenWaitlistJoinBtn" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">Zapisz się na listę rezerwową</button>${waitingHtml}
      </div>
    `;
  } else if (isFull) {
    footerHtml = `<span class="basenHint">Slot jest pełny.</span>`;
  } else if (isSauna) {
    // Sauna nie ma kajaka ani parowania z instruktorem — nic do rozwinięcia,
    // "Zapisz się" zapisuje od razu, jednym kliknięciem. Sauna też nie ma opcji
    // "Będę instruktorem" (canBeInstructor już to wyklucza), więc rząd nie jest tu potrzebny.
    footerHtml = `
      <form class="basenEnrollForm" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">
        <button type="submit" class="primary basenEnrollBtn">Zapisz się</button>
      </form>
    `;
  } else {
    // Na starcie TYLKO "Zapisz się" (+ "Będę instruktorem" obok, w jednym rzędzie) —
    // dopiero klik "Zapisz się" rozwija kajak/instruktora, żeby niezapisany slot nie
    // straszył formularzem zanim user w ogóle zdecyduje się zapisać. Drugi klik (już
    // w rozwiniętym stanie) faktycznie wysyła zapis.
    instructorBtnEmbedded = true;
    footerHtml = `
      <form class="basenEnrollForm" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">
        <div class="basenPrimaryActions">
          <button type="button" class="primary basenEnrollRevealBtn">Zapisz się</button>
          ${instructorBtnHtml}
          ${ratownikBtnHtml}
        </div>
        <div class="basenEnrollExpanded hidden">
          <label class="basenCheckLabel">
            <input type="checkbox" class="basenWithInstructorCheck" />
            Potrzebuję instruktora
          </label>
          <div class="basenInstructorPickerWrap hidden">
            <select class="basenInstructorSelect"><option value="">Ładowanie…</option></select>
          </div>
          <div class="row">
            <label>Kajak</label>
            <select class="basenKayakSelect">
              <option value="" disabled selected>Wybierz kajak</option>
              ${(Array.isArray(slot.availableKayaks) ? slot.availableKayaks : []).map((k) => `<option value="${esc(k.id)}">${esc(k.label)}</option>`).join("")}
            </select>
          </div>
          <div class="basenEnrollRow">
            <button type="submit" class="primary basenEnrollBtn">Zapisz się</button>
            <button type="button" class="ghost basenEnrollCancelBtn">Anuluj</button>
          </div>
        </div>
      </form>
    `;
  }
  if (!instructorBtnEmbedded) {
    footerHtml += instructorBtnHtml;
  }

  const cardStateClass = isInstructorEnrolled ? " basenSlotCard--instructing" : isParticipantEnrolled ? " basenSlotCard--mine" : "";

  return `
    <div class="basenSlotCard${isCancelled ? " basenSlotCancelled" : ""}${cardStateClass}" data-session-id="${esc(sessionId)}" data-slot="${esc(slotKey)}">
      <div class="basenSlotHead">
        <span class="basenSlotLabel">${esc(SLOT_LABELS[slotKey] || slotKey)}</span>
        <span class="basenCardTime">${esc(slot.timeStart)}</span>
        ${spotsHtml}
      </div>
      ${reservedNote}
      ${attendeesHtml}
      ${!isCancelled && Array.isArray(slot.waitlistNames) && slot.waitlistNames.length ? `
        <div class="basenAttendeesSimple">
          <div class="basenAttendeesSimpleTitle">Lista rezerwowa (kolejność)</div>
          ${slot.waitlistNames.map((n, i) => `<div class="basenAttendeeRow">${i + 1}. ${esc(n)}</div>`).join("")}
        </div>` : ""}
      <div class="basenSlotFooter">
        ${footerHtml}
      </div>
      <div class="basenCardMsg hidden err" data-slot-msg></div>
    </div>
  `;
}

// "pon 09.11, 15:00" — moment decyzji o terminie (czas przeglądarki = Polska).
function formatDecisionAt(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const days = ["nd", "pon", "wt", "śr", "czw", "pt", "sob"];
  return `${days[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Status terminu dla członków — bez kwot (regulamin § 5: minimum zapisów).
function renderSessionStatusHtml(s, season) {
  const min = Number(season?.minZapisow || 0);
  if (s.outcome === "cancelled") {
    return s.cancelReason === "frekwencja"
      ? `<div class="basenSessionStatus basenSessionStatus--cancelled">Odwołany — za mało zapisów (${esc(s.zapisy)} z wymaganych ${esc(min)})</div>`
      : `<div class="basenSessionStatus basenSessionStatus--cancelled">Odwołany</div>`;
  }
  if (s.outcome === "confirmed") {
    return `<div class="basenSessionStatus basenSessionStatus--ok">Odbędzie się ✓ · zapisy: ${esc(s.zapisy)}</div>`;
  }
  const missing = Math.max(0, min - Number(s.zapisy || 0));
  const decision = s.decisionAtMs ? ` · decyzja: ${esc(formatDecisionAt(s.decisionAtMs))}` : "";
  return `<div class="basenSessionStatus${missing ? " basenSessionStatus--pending" : " basenSessionStatus--ok"}">
    Zapisy: <strong>${esc(s.zapisy)}</strong> / min. ${esc(min)}${missing ? ` — brakuje ${esc(missing)}` : " ✓"}${decision}
  </div>`;
}

function renderSessionCard(s, ctx, canEnroll, season) {
  const isCancelled = s.outcome === "cancelled";
  // Odwołany termin zostaje na liście (widać, że się nie odbył), ale bez slotów i akcji.
  const slotsHtml = isCancelled ? "" : SLOT_ORDER
    .filter((key) => s.slots?.[key])
    .map((key) => renderSlotCard(s.id, key, s.slots[key], ctx, canEnroll, s))
    .join("");

  return `
    <div class="basenCard basenDayCard${isCancelled ? " basenDayCard--cancelled" : ""}" data-session-id="${esc(s.id)}">
      <div class="basenCardHead">
        <div class="basenCardDate">${esc(formatDate(s.date))}</div>
      </div>
      ${renderSessionStatusHtml(s, season)}
      ${s.ratownikName && !isCancelled ? `<div class="basenHint">Ratownik: <strong>${esc(s.ratownikName)}</strong></div>` : ""}
      ${s.notes && !isCancelled ? `<div class="basenCardNotes">${esc(s.notes)}</div>` : ""}
      ${slotsHtml ? `<div class="basenSlotGrid">${slotsHtml}</div>` : ""}
    </div>
  `;
}

function renderSeasonStripHtml(season) {
  if (!season) return "";
  const parts = [`odbyło się ${season.held}`];
  if (season.cancelledLow) parts.push(`odwołano z braku chętnych ${season.cancelledLow}`);
  if (season.cancelledAdmin) parts.push(`odwołano z innych przyczyn ${season.cancelledAdmin}`);
  parts.push(`przed nami ${season.upcoming}`);
  return `
    <div class="basenSeasonStrip">
      <div><strong>Sezon ${esc(season.key)}:</strong> ${esc(parts.join(" · "))}</div>
      <div class="basenHint">Termin odbywa się przy co najmniej ${esc(season.minZapisow)} zapisach na obu godzinach. Decyzja o terminie i koniec darmowej rezygnacji: ${esc(season.oknoH)} h przed basenem (godzina przy każdym terminie). Zapisy na najwyżej ${esc(season.maxDniNaprzod)} terminy naprzód.</div>
    </div>
  `;
}

function renderPastSessionsHtml(past, season) {
  if (!past.length) return "";
  const min = Number(season?.minZapisow || 0);
  const rows = past.slice().reverse().map((s) => {
    const label = s.outcome === "cancelled"
      ? (s.cancelReason === "frekwencja" ? `odwołany — za mało zapisów (${s.zapisy}/${min})` : "odwołany")
      : `odbył się · ${s.zapisy} zapisów`;
    return `<div class="basenPastRow${s.outcome === "cancelled" ? " basenPastRow--cancelled" : ""}"><span>${esc(formatDate(s.date))}</span><span>${esc(label)}</span></div>`;
  }).join("");
  return `
    <details class="basenPastSeason">
      <summary>Minione w sezonie (${past.length})</summary>
      ${rows}
    </details>
  `;
}

async function renderSessionsView(innerEl, ctx, canEnroll, { keepScroll = false } = {}) {
  // Odświeżenie po akcji (zapis, instruktor, rezygnacja) — bez spinnera i z powrotem do
  // tego samego miejsca na stronie; spinner skracał stronę i przeglądarka skakała na górę.
  const scrollY = keepScroll ? window.scrollY : null;
  if (!keepScroll) innerEl.innerHTML = spinnerHtml("Ładowanie terminów…");

  try {
    const data = await apiGetJson({ url: SESSIONS_URL, idToken: ctx.idToken });
    const allSessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const sessions = allSessions.filter((s) => !s.isPast);
    const past = allSessions.filter((s) => s.isPast);
    const season = data?.season || null;
    const balance = Number(data?.userGodzinyBalance ?? 0);
    // Kursant z definicji nie ma i nie kupuje godzin basenowych — saldo (zawsze 0)
    // jest dla niego mylące, samo tylko rodzi zbędne pytania. Backend i tak poprawnie
    // blokuje mu zapis na slot spoza puli kursanckiej (enrollInSlot::isFreeForKursant),
    // więc brak wyświetlania salda nie otwiera żadnej luki — po prostu tego nie widzi.
    const isKursant = ctx?.session?.role_key === "rola_kursant";
    const balanceHtml = canEnroll && !isKursant
      ? `<div class="basenHint" style="margin-top:8px;">Dostępne godziny basenowe: <strong>${balance}</strong>${balance <= 0 ? " — kup godziny basenowe w zakładce „Moje konto”." : ""}</div>`
      : "";

    const headHtml = renderSeasonStripHtml(season) + balanceHtml;
    if (!sessions.length) {
      innerEl._basenSessions = [];
      innerEl.innerHTML = headHtml + `<div class="hint" style="margin-top:16px;">Brak nadchodzących terminów basenowych.</div>` + renderPastSessionsHtml(past, season);
      return;
    }

    innerEl.innerHTML = `
      ${headHtml}
      <div class="basenList">
        ${sessions.map((s) => renderSessionCard(s, ctx, canEnroll, season)).join("")}
      </div>
      ${renderPastSessionsHtml(past, season)}
      ${renderModifyModalHtml()}
      ${renderClaimStudentModalHtml()}
    `;

    // Delegacja zdarzeń bindowana RAZ w render() (patrz bindSessionActionsDelegation) —
    // tu tylko odświeżamy dane, które ten jeden nasłuchiwacz czyta przy każdym kliknięciu.
    innerEl._basenSessions = sessions;
    if (scrollY !== null) window.scrollTo(0, scrollY);
    else scrollToHomeTarget(innerEl);
  } catch (e) {
    innerEl.innerHTML = `<div class="err">${esc(e?.message || "Nie udało się załadować terminów.")}</div>`;
  }
}

// Przewija i podświetla kartę dnia, na którą użytkownik kliknął w kalendarzu na
// stronie głównej. Klucz konsumowany raz — kolejne odświeżenia tego widoku (np.
// po zapisie/anulowaniu) już nie przewijają ponownie.
function scrollToHomeTarget(innerEl) {
  let target;
  try {
    target = sessionStorage.getItem(HOME_SCROLL_TARGET_KEY);
    if (target) sessionStorage.removeItem(HOME_SCROLL_TARGET_KEY);
  } catch {
    return;
  }
  if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return;

  const card = innerEl.querySelector(`.basenDayCard[data-session-id="${target}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.classList.add("basenDayCardHighlight");
  setTimeout(() => card.classList.remove("basenDayCardHighlight"), 2200);
}

async function refreshSessionsView(innerEl, ctx, canEnroll) {
  await renderSessionsView(innerEl, ctx, canEnroll, { keepScroll: true });
}

// Delegacja WSZYSTKICH akcji karty terminu — bindowana RAZ na cały czas życia #basenInner
// (ten sam incydent i ten sam wzorzec naprawy co bindModalCloseDelegation, patrz komentarz
// przy jej wywołaniu w render(): poprzednio te 8 nasłuchiwaczy było spinane od nowa przy
// KAŻDYM renderSessionsView — czyli po każdym zapisie/anulowaniu/przypisaniu w tej samej
// sesji, bo #basenInner samo w sobie nigdy nie jest zastępowane). `sessions` (jedyna dana
// potrzebna tu spoza atrybutów klikniętego elementu — .basenClaimEditBtn) zmienia się przy
// każdym renderze, więc czyta ją z `innerEl._basenSessions` (patrz renderSessionsView), nie
// z domknięcia.
function bindSessionActionsDelegation(innerEl, ctx, canEnroll) {
  innerEl.addEventListener("click", async (ev) => {
    // Klik na kafelek osoby "szukającej instruktora" (widoczny od razu na karcie slotu,
    // tylko dla widza który sam jest instruktorem na tym slocie) → od razu przypisuje.
    const claimTagBtn = ev.target.closest(".basenClaimTagBtn");
    if (claimTagBtn) {
      const sessionId = claimTagBtn.getAttribute("data-session-id");
      const slot = claimTagBtn.getAttribute("data-slot");
      const targetUid = claimTagBtn.getAttribute("data-target-uid");
      claimTagBtn.disabled = true;
      try {
        await apiPostJson({ url: CLAIM_URL, idToken: ctx.idToken, body: { sessionId, slot, targetUid } });
        await refreshSessionsView(innerEl, ctx, canEnroll);
      } catch (e) {
        claimTagBtn.disabled = false;
        alert(e?.message || "Nie udało się przypisać.");
      }
      return;
    }

    // "Edytuj" na karcie instruktora — bardziej odkrywalna droga do tego samego co
    // .basenClaimTagBtn wyżej (klikalny kafelek na liście), przez osobny modal z
    // wyborem osoby szukającej instruktora na ten slot.
    const claimEditBtn = ev.target.closest(".basenClaimEditBtn");
    if (claimEditBtn) {
      const sessionId = claimEditBtn.getAttribute("data-session-id");
      const slot = claimEditBtn.getAttribute("data-slot");
      const sessions = innerEl._basenSessions || [];
      const session = sessions.find((s) => s.id === sessionId);
      const attendees = Array.isArray(session?.slots?.[slot]?.attendees) ? session.slots[slot].attendees : [];
      const waitingStudents = attendees.filter((a) => a.type === "training" && !a.instructorUid);
      openClaimStudentModal(innerEl, ctx, sessionId, slot, waitingStudents, () => refreshSessionsView(innerEl, ctx, canEnroll));
      return;
    }

    // "Zapisz się" (pierwszy klik) → rozwiń formularz (kajak/instruktor), ukryj przycisk-wyzwalacz
    const revealBtn = ev.target.closest(".basenEnrollRevealBtn");
    if (revealBtn) {
      const form = revealBtn.closest(".basenEnrollForm");
      const expanded = form?.querySelector(".basenEnrollExpanded");
      if (!expanded) return;
      revealBtn.classList.add("hidden");
      expanded.classList.remove("hidden");
      return;
    }

    // "Anuluj" w rozwiniętym formularzu → zwiń z powrotem, resetując wybory
    const enrollCancelBtn = ev.target.closest(".basenEnrollCancelBtn");
    if (enrollCancelBtn) {
      const form = enrollCancelBtn.closest(".basenEnrollForm");
      if (!form) return;
      const revealBtnEl = form.querySelector(".basenEnrollRevealBtn");
      const expanded = form.querySelector(".basenEnrollExpanded");
      const check = form.querySelector(".basenWithInstructorCheck");
      const pickerWrap = form.querySelector(".basenInstructorPickerWrap");
      const instructorSelect = form.querySelector(".basenInstructorSelect");
      const kayakSelect = form.querySelector(".basenKayakSelect");
      if (check) check.checked = false;
      if (pickerWrap) pickerWrap.classList.add("hidden");
      if (instructorSelect) instructorSelect.removeAttribute("data-loaded");
      if (kayakSelect) kayakSelect.value = "";
      expanded?.classList.add("hidden");
      revealBtnEl?.classList.remove("hidden");
      return;
    }

    // Ratownik terminu (opiekun basenu)
    const ratownikBtn = ev.target.closest(".basenRatownikBtn");
    if (ratownikBtn) {
      const sessionId = ratownikBtn.getAttribute("data-session-id");
      const slot = ratownikBtn.getAttribute("data-slot");
      const msgEl = ratownikBtn.closest(".basenSlotCard")?.querySelector("[data-slot-msg]");
      ratownikBtn.disabled = true;
      ratownikBtn.textContent = "Zapisuję…";
      try {
        await apiPostJson({ url: ENROLL_URL, idToken: ctx.idToken, body: { sessionId, slot, mode: "ratownik" } });
        await refreshSessionsView(innerEl, ctx, canEnroll);
      } catch (e) {
        ratownikBtn.disabled = false;
        ratownikBtn.textContent = "Będę ratownikiem";
        if (msgEl) {
          msgEl.textContent = e?.message || "Nie udało się zapisać.";
          msgEl.classList.remove("hidden");
        }
      }
      return;
    }

    // Instructor self sign-up
    const instructorBtn = ev.target.closest(".basenInstructorBtn");
    if (instructorBtn) {
      const sessionId = instructorBtn.getAttribute("data-session-id");
      const slot = instructorBtn.getAttribute("data-slot");
      const cardEl = instructorBtn.closest(".basenSlotCard");
      const msgEl = cardEl?.querySelector("[data-slot-msg]");

      instructorBtn.disabled = true;
      instructorBtn.textContent = "Zapisuję…";

      try {
        await apiPostJson({ url: ENROLL_URL, idToken: ctx.idToken, body: { sessionId, slot, mode: "instructor" } });
        await refreshSessionsView(innerEl, ctx, canEnroll);
      } catch (e) {
        instructorBtn.disabled = false;
        instructorBtn.textContent = "Będę instruktorem";
        if (msgEl) {
          msgEl.textContent = e?.message || "Nie udało się zapisać.";
          msgEl.classList.remove("hidden");
        }
      }
      return;
    }

    // Lista rezerwowa — zapis / wypis (bez pobrania wejścia; pobierane przy przejęciu miejsca)
    const waitJoinBtn = ev.target.closest(".basenWaitlistJoinBtn");
    const waitLeaveBtn = ev.target.closest(".basenWaitlistLeaveBtn");
    if (waitJoinBtn || waitLeaveBtn) {
      const btn = waitJoinBtn || waitLeaveBtn;
      const sessionId = btn.getAttribute("data-session-id");
      const slot = btn.getAttribute("data-slot");
      const msgEl = btn.closest(".basenSlotCard")?.querySelector("[data-slot-msg]");
      btn.disabled = true;
      try {
        if (waitJoinBtn) {
          await apiPostJson({ url: ENROLL_URL, idToken: ctx.idToken, body: { sessionId, slot, mode: "waitlist" } });
        } else {
          await apiPostJson({ url: CANCEL_ENROLL_URL, idToken: ctx.idToken, body: { sessionId, slot, waitlist: true } });
        }
        await refreshSessionsView(innerEl, ctx, canEnroll);
      } catch (e) {
        btn.disabled = false;
        if (msgEl) {
          msgEl.textContent = e?.message || "Nie udało się.";
          msgEl.classList.remove("hidden");
        }
      }
      return;
    }

    // Cancel enrollment (regular/training/instructor)
    const cancelBtn = ev.target.closest(".basenCancelBtn");
    if (cancelBtn) {
      const sessionId = cancelBtn.getAttribute("data-session-id");
      const slot = cancelBtn.getAttribute("data-slot");
      const cardEl = cancelBtn.closest(".basenSlotCard");
      const msgEl = cardEl?.querySelector("[data-slot-msg]");

      const withinWindow = cancelBtn.getAttribute("data-within-window") === "1";
      const confirmMsg = withinWindow
        ? "Termin darmowej rezygnacji minął — godzina basenowa przepada, chyba że Twoje miejsce zajmie osoba z listy rezerwowej (wtedy wróci na saldo). Zrezygnować?"
        : "Anulować ten zapis? Godzina basenowa wróci na saldo.";
      if (!confirm(confirmMsg)) return;

      cancelBtn.disabled = true;
      cancelBtn.textContent = "Anuluję…";

      try {
        await apiPostJson({ url: CANCEL_ENROLL_URL, idToken: ctx.idToken, body: { sessionId, slot } });
        await refreshSessionsView(innerEl, ctx, canEnroll);
      } catch (e) {
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = CANCEL_BTN_HTML;
        if (msgEl) {
          msgEl.textContent = e?.message || "Nie udało się anulować.";
          msgEl.classList.remove("hidden");
        }
      }
      return;
    }

    // Modyfikuj zapis (kajak + instruktor) — otwiera wspólny modal
    const modifyBtn = ev.target.closest(".basenModifyBtn");
    if (modifyBtn) {
      const sessionId = modifyBtn.getAttribute("data-session-id");
      const slot = modifyBtn.getAttribute("data-slot");
      const currentKayakId = modifyBtn.getAttribute("data-current-kayak-id") || "";
      const currentInstructorUid = modifyBtn.getAttribute("data-current-instructor-uid") || "";
      const currentType = modifyBtn.getAttribute("data-current-type") || "";
      openModifyModal(innerEl, ctx, sessionId, slot, {currentKayakId, currentInstructorUid, currentType}, () => refreshSessionsView(innerEl, ctx, canEnroll));
      return;
    }
  });

  // "Zapisz się z instruktorem" checkbox → lazy-load instructor list
  innerEl.addEventListener("change", async (ev) => {
    const cb = ev.target.closest(".basenWithInstructorCheck");
    if (!cb) return;

    const form = cb.closest(".basenEnrollForm");
    const wrap = form.querySelector(".basenInstructorPickerWrap");
    if (!wrap) return;
    wrap.classList.toggle("hidden", !cb.checked);
    if (!cb.checked) return;

    const select = wrap.querySelector(".basenInstructorSelect");
    if (select.getAttribute("data-loaded") === "1") return;

    const sessionId = form.getAttribute("data-session-id");
    const slot = form.getAttribute("data-slot");
    try {
      const data = await apiGetJson({ url: `${ATTENDEES_URL}?sessionId=${encodeURIComponent(sessionId)}&slot=${encodeURIComponent(slot)}`, idToken: ctx.idToken });
      const instructors = Array.isArray(data?.instructors) ? data.instructors : [];
      select.innerHTML = instructors.length
        ? `<option value="">Bez wyboru — dopasujemy później</option>${instructors.map((i) => `<option value="${esc(i.userUid)}">${esc(i.userDisplayName)}</option>`).join("")}`
        : `<option value="">Brak dostępnych instruktorów — zapiszesz się na listę oczekujących</option>`;
      select.setAttribute("data-loaded", "1");
    } catch (e) {
      select.innerHTML = `<option value="">Błąd ładowania</option>`;
    }
  });

  // Enroll (regular/training)
  innerEl.addEventListener("submit", async (ev) => {
    const form = ev.target.closest(".basenEnrollForm");
    if (!form) return;
    ev.preventDefault();

    const sessionId = form.getAttribute("data-session-id");
    const slot = form.getAttribute("data-slot");
    const cardEl = form.closest(".basenSlotCard");
    const msgEl = cardEl?.querySelector("[data-slot-msg]");
    const withInstructor = form.querySelector(".basenWithInstructorCheck")?.checked === true;
    const instructorUid = withInstructor ? (form.querySelector(".basenInstructorSelect")?.value || "") : "";
    const kayakSelectEl = form.querySelector(".basenKayakSelect");
    const kayakId = kayakSelectEl?.value || "";
    // Kajak obowiązkowy na godzinie basenu: klubowy z listy albo „Własny kajak" (sauna nie ma wyboru).
    if (kayakSelectEl && !kayakId) {
      if (msgEl) {
        msgEl.textContent = "Wybierz kajak z listy albo „Własny kajak”.";
        msgEl.classList.remove("hidden");
      }
      return;
    }

    const btn = form.querySelector(".basenEnrollBtn");
    btn.disabled = true;
    btn.textContent = "Zapisuję…";
    if (msgEl) { msgEl.textContent = ""; msgEl.classList.add("hidden"); }

    try {
      await apiPostJson({
        url: ENROLL_URL,
        idToken: ctx.idToken,
        body: {
          sessionId,
          slot,
          mode: withInstructor ? "training" : "regular",
          instructorUid: withInstructor ? instructorUid : undefined,
          kayakId: kayakId || undefined,
        },
      });
      await refreshSessionsView(innerEl, ctx, canEnroll);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Zapisz się";
      if (msgEl) {
        msgEl.textContent = e?.message || "Nie udało się zapisać.";
        msgEl.classList.remove("hidden");
      }
    }
  });
}

function bindModalCloseDelegation(innerEl) {
  innerEl.addEventListener("click", (ev) => {
    const key = ev.target?.getAttribute?.("data-basen-modal-close");
    if (key === "modify") closeModifyModal(innerEl);
    if (key === "claim") closeClaimStudentModal(innerEl);
  });
}

// ─── Modal "Modyfikuj zapis" (kajak + instruktor) ─────────────────────────────

function renderModifyModalHtml() {
  return `
    <div id="basenModifyModal" class="basenModal hidden" aria-hidden="true">
      <div class="basenModalBackdrop" data-basen-modal-close="modify"></div>
      <div class="basenModalCard" role="dialog" aria-modal="true" aria-label="Modyfikuj zapis">
        <div class="basenModalTop">
          <div class="basenModalTitle" data-modify-title>Modyfikuj zapis</div>
          <button type="button" class="basenModalClose" data-basen-modal-close="modify" aria-label="Zamknij">✕</button>
        </div>
        <div class="basenModalBody">
          <div class="row">
            <label for="basenModifyKayakSelect">Kajak</label>
            <select id="basenModifyKayakSelect"><option value="">Ładowanie…</option></select>
          </div>
          <div class="row">
            <label for="basenModifyInstructorSelect">Instruktor</label>
            <select id="basenModifyInstructorSelect"><option value="">Ładowanie…</option></select>
          </div>
          <div id="basenModifyMsg" class="err hidden"></div>
        </div>
        <div class="basenModalActions">
          <button type="button" class="ghost" data-basen-modal-close="modify">Anuluj</button>
          <button type="button" class="primary basenModifySaveBtn">Zapisz zmiany</button>
        </div>
      </div>
    </div>
  `;
}

function openModifyModal(innerEl, ctx, sessionId, slotKey, current, onChanged) {
  const modal = innerEl.querySelector("#basenModifyModal");
  if (!modal) return;

  modal.querySelector("[data-modify-title]").textContent = `Modyfikuj zapis — ${SLOT_LABELS[slotKey] || slotKey}`;

  const kayakSelect = modal.querySelector("#basenModifyKayakSelect");
  const instructorSelect = modal.querySelector("#basenModifyInstructorSelect");
  const msgEl = modal.querySelector("#basenModifyMsg");
  const saveBtn = modal.querySelector(".basenModifySaveBtn");

  kayakSelect.innerHTML = `<option value="">Ładowanie…</option>`;
  instructorSelect.innerHTML = `<option value="">Ładowanie…</option>`;
  msgEl.textContent = "";
  msgEl.classList.add("hidden");
  saveBtn.disabled = false;
  saveBtn.textContent = "Zapisz zmiany";

  apiGetJson({ url: `${KAYAKS_URL}?sessionId=${encodeURIComponent(sessionId)}&slot=${encodeURIComponent(slotKey)}`, idToken: ctx.idToken })
    .then((data) => {
      const kayaks = Array.isArray(data?.kayaks) ? data.kayaks : [];
      // Zapis sprzed obowiązkowego wyboru kajaka może nie mieć kajaka — wtedy tylko podpowiedź
      // (nieaktywna), żeby „Zapisz zmiany" nie przypisało po cichu pierwszego kajaka z listy.
      const placeholder = current.currentKayakId ? "" : `<option value="" disabled>Wybierz kajak</option>`;
      kayakSelect.innerHTML = placeholder + kayaks.map((k) => `<option value="${esc(k.id)}">${esc(k.label)}</option>`).join("");
      kayakSelect.value = current.currentKayakId || "";
    })
    .catch(() => { kayakSelect.innerHTML = `<option value="">Błąd ładowania</option>`; });

  // Trzy różne stany, nie dwa: "Brak" (zwykły zapis, bez instruktora, koniec tematu),
  // "Szukam instruktora" (nadal chcę, ale nikt jeszcze nie jest dostępny — dopasujemy
  // później, przez ten sam modal albo przez instruktora z listy uczestników) i konkretny
  // instruktor. Bez tego trzeciego stanu nie dało się PO ZAPISIE dołączyć do listy
  // szukających — jedyna droga była zaznaczenie checkboxa przy samym zapisie.
  const currentSelectValue = current.currentInstructorUid || (current.currentType === "training" ? SEEKING_SENTINEL : "");

  apiGetJson({ url: `${ATTENDEES_URL}?sessionId=${encodeURIComponent(sessionId)}&slot=${encodeURIComponent(slotKey)}`, idToken: ctx.idToken })
    .then((data) => {
      const instructors = Array.isArray(data?.instructors) ? data.instructors : [];
      instructorSelect.innerHTML = `<option value="">Brak</option><option value="${SEEKING_SENTINEL}">Szukam instruktora (dopasujemy później)</option>${instructors.map((i) => `<option value="${esc(i.userUid)}">${esc(i.userDisplayName)}</option>`).join("")}`;
      instructorSelect.value = currentSelectValue;
    })
    .catch(() => { instructorSelect.innerHTML = `<option value="">Błąd ładowania</option>`; });

  saveBtn.onclick = async () => {
    msgEl.classList.add("hidden");
    saveBtn.disabled = true;
    saveBtn.textContent = "Zapisuję…";
    try {
      // Wysyłamy tylko realnie zmienione pola — dla "szukam instruktora" (type=training,
      // instructorUid=null) pole instruktora domyślnie pokazuje "Brak"; wysłanie
      // instructorUid=null bez zmiany cofnęłoby type do "regular" (patrz
      // setEnrollmentInstructor), czyli wypisałoby osobę z listy szukających mimo że
      // nic nie zmieniła.
      const calls = [];
      if ((kayakSelect.value || "") !== (current.currentKayakId || "")) {
        calls.push(apiPostJson({ url: SET_KAYAK_URL, idToken: ctx.idToken, body: { sessionId, slot: slotKey, kayakId: kayakSelect.value || null } }));
      }
      if ((instructorSelect.value || "") !== currentSelectValue) {
        const selected = instructorSelect.value;
        const seeking = selected === SEEKING_SENTINEL;
        const instructorUid = seeking ? null : (selected || null);
        calls.push(apiPostJson({ url: SET_INSTRUCTOR_URL, idToken: ctx.idToken, body: { sessionId, slot: slotKey, instructorUid, seeking } }));
      }
      await Promise.all(calls);
      closeModifyModal(innerEl);
      await onChanged();
    } catch (e) {
      msgEl.textContent = e?.message || "Nie udało się zapisać zmian.";
      msgEl.classList.remove("hidden");
      saveBtn.disabled = false;
      saveBtn.textContent = "Zapisz zmiany";
    }
  };

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModifyModal(innerEl) {
  const modal = innerEl.querySelector("#basenModifyModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

// ─── Modal "Edytuj" instruktora (dopisz osobę szukającą instruktora) ─────────
// Instruktor decyduje sam, czy bierze 1 czy 2 osoby naraz (limit egzekwowany przez
// backend — claimWaitingStudent/MAX_STUDENTS_PER_INSTRUCTOR) — uczestnik NIE może
// samodzielnie dopisać się jako druga osoba do już zajętego instruktora.

function renderClaimStudentModalHtml() {
  return `
    <div id="basenClaimModal" class="basenModal hidden" aria-hidden="true">
      <div class="basenModalBackdrop" data-basen-modal-close="claim"></div>
      <div class="basenModalCard" role="dialog" aria-modal="true" aria-label="Dopisz uczestnika">
        <div class="basenModalTop">
          <div class="basenModalTitle" data-claim-title>Dopisz uczestnika</div>
          <button type="button" class="basenModalClose" data-basen-modal-close="claim" aria-label="Zamknij">✕</button>
        </div>
        <div class="basenModalBody">
          <div id="basenClaimBody"></div>
          <div id="basenClaimMsg" class="err hidden"></div>
        </div>
        <div class="basenModalActions">
          <button type="button" class="ghost" data-basen-modal-close="claim">Zamknij</button>
          <button type="button" class="primary basenClaimSaveBtn hidden">Przypisz</button>
        </div>
      </div>
    </div>
  `;
}

function openClaimStudentModal(innerEl, ctx, sessionId, slotKey, waitingStudents, onChanged) {
  const modal = innerEl.querySelector("#basenClaimModal");
  if (!modal) return;

  modal.querySelector("[data-claim-title]").textContent = `Dopisz uczestnika — ${SLOT_LABELS[slotKey] || slotKey}`;
  const body = modal.querySelector("#basenClaimBody");
  const msgEl = modal.querySelector("#basenClaimMsg");
  const saveBtn = modal.querySelector(".basenClaimSaveBtn");
  msgEl.textContent = "";
  msgEl.classList.add("hidden");

  if (!waitingStudents.length) {
    body.innerHTML = `<p class="basenHint">Brak osób szukających instruktora na ten slot.</p>`;
    saveBtn.classList.add("hidden");
  } else {
    body.innerHTML = `
      <div class="row">
        <label for="basenClaimSelect">Uczestnik</label>
        <select id="basenClaimSelect">
          ${waitingStudents.map((s) => `<option value="${esc(s.userUid)}">${esc(s.displayLabel)}</option>`).join("")}
        </select>
      </div>
    `;
    saveBtn.classList.remove("hidden");
    saveBtn.disabled = false;
    saveBtn.textContent = "Przypisz";
    saveBtn.onclick = async () => {
      const targetUid = modal.querySelector("#basenClaimSelect")?.value;
      if (!targetUid) return;
      saveBtn.disabled = true;
      saveBtn.textContent = "Zapisuję…";
      try {
        await apiPostJson({ url: CLAIM_URL, idToken: ctx.idToken, body: { sessionId, slot: slotKey, targetUid } });
        closeClaimStudentModal(innerEl);
        await onChanged();
      } catch (e) {
        msgEl.textContent = e?.message || "Nie udało się przypisać.";
        msgEl.classList.remove("hidden");
        saveBtn.disabled = false;
        saveBtn.textContent = "Przypisz";
      }
    };
  }

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeClaimStudentModal(innerEl) {
  const modal = innerEl.querySelector("#basenClaimModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

// ─── Kalendarz admina ("Dodaj basen") ──────────────────────────────────────────

const POLISH_MONTHS = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
const WEEKDAY_LABELS_PL = ["Pon", "Wt", "Śr", "Czw", "Pt", "So", "Nd"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoFromParts(year, month, day) {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function buildSessionsByDate(data) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  return new Map(sessions.map((s) => [s.date, s]));
}

function renderCalendarShellHtml(year, month, sessionsByDate) {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // JS getDay(): 0=Ndz..6=Sob — przesuwamy na tydzień Pon-first (0=Pon..6=Ndz)
  const leadBlanks = (first.getDay() + 6) % 7;
  const today = todayIso();

  let cells = "";
  for (let i = 0; i < leadBlanks; i++) {
    cells += `<div class="basenCalDay basenCalDay--blank"></div>`;
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateIso = isoFromParts(year, month, day);
    const session = sessionsByDate.get(dateIso);
    if (dateIso < today && !session) {
      cells += `<div class="basenCalDay basenCalDay--past"><span class="basenCalDayNum">${day}</span></div>`;
      continue;
    }
    // Odwołane i minione terminy zostają w kalendarzu (cały sezon) — tylko do podglądu.
    const hasPool = Boolean(session) && (Boolean(session.slots?.H1) || Boolean(session.slots?.H2));
    const hasSauna = Boolean(session) && Boolean(session.slots?.SAUNA);
    const hasSession = hasPool || hasSauna;
    const stateCls = !hasSession ? "basenCalDay--empty"
      : session.outcome === "cancelled" ? "basenCalDay--has-session basenCalDay--cancelled"
      : session.isPast ? "basenCalDay--has-session basenCalDay--held"
      : "basenCalDay--has-session";
    cells += `
      <button type="button" class="basenCalDay ${stateCls}" data-cal-date="${dateIso}">
        <span class="basenCalDayNum">${day}</span>
        ${hasSession ? `<span class="basenCalDayIcons">${hasPool ? POOL_ICON_SVG : ""}${hasSauna ? SAUNA_ICON_SVG : ""}</span>` : ""}
      </button>
    `;
  }

  return `
    <div class="basenCalendar">
      <div class="basenCalendarHead">
        <button type="button" class="ghost basenCalNavBtn" data-cal-nav="prev">&lsaquo;</button>
        <div class="basenCalendarTitle">${esc(POLISH_MONTHS[month])} ${year}</div>
        <button type="button" class="ghost basenCalNavBtn" data-cal-nav="next">&rsaquo;</button>
      </div>
      <div class="basenCalendarWeekdays">
        ${WEEKDAY_LABELS_PL.map((w) => `<div class="basenCalendarWeekday">${w}</div>`).join("")}
      </div>
      <div class="basenCalendarGrid">${cells}</div>
      <div class="basenCalLegend" style="margin-top:8px;">
        <span class="basenCalLegendItem"><span class="basenCalLegendSwatch basenCalLegendSwatch--planned"></span>zaplanowany</span>
        <span class="basenCalLegendItem"><span class="basenCalLegendSwatch basenCalLegendSwatch--held"></span>odbył się</span>
        <span class="basenCalLegendItem"><span class="basenCalLegendSwatch basenCalLegendSwatch--cancelled"></span>odwołany</span>
      </div>
    </div>
  `;
}

function renderReservedGroupHtml(prefix, title) {
  return `
    <div class="basenReservedGroup" data-reserved-group="${prefix}">
      <div class="basenReservedGroupTitle">${esc(title)}</div>
      <div class="row">
        <label for="cd${prefix}Capacity">Liczba miejsc</label>
        <input type="number" id="cd${prefix}Capacity" min="1" max="60" step="1" />
      </div>
      <div class="row">
        <label for="cd${prefix}Count">Zarezerwuj N miejsc</label>
        <input type="number" id="cd${prefix}Count" min="0" step="1" placeholder="0" />
      </div>
      <label class="basenCheckLabel basenReservedSub hidden" data-reserved-sub="${prefix}">
        <input type="checkbox" id="cd${prefix}Kursant" />
        tylko dla kursantów
      </label>
      <div class="row basenReservedSub hidden" data-reserved-label-wrap="${prefix}">
        <label for="cd${prefix}Label">Etykieta (opcjonalnie)</label>
        <input type="text" id="cd${prefix}Label" maxlength="100" placeholder="np. grupa X" />
      </div>
    </div>
  `;
}

function renderCreateDayModalHtml() {
  return `
    <div id="basenCreateDayModal" class="basenModal hidden" aria-hidden="true">
      <div class="basenModalBackdrop" data-basen-modal-close="createDay"></div>
      <div class="basenModalCard" role="dialog" aria-modal="true" aria-label="Nowy termin basenowy">
        <div class="basenModalTop">
          <div class="basenModalTitle" data-create-day-title>Nowy termin</div>
          <button type="button" class="basenModalClose" data-basen-modal-close="createDay" aria-label="Zamknij">✕</button>
        </div>
        <div class="basenModalBody">
          <form id="basenCreateDayForm" autocomplete="off">
            <label class="basenCheckLabel">
              <input type="checkbox" id="cdSauna" />
              Sauna
            </label>
            <div class="basenFormGrid">
              ${renderReservedGroupHtml("H1", "I godzina (H1)")}
              ${renderReservedGroupHtml("H2", "II godzina (H2)")}
            </div>
            <div class="row">
              <label for="cdNotes">Uwagi</label>
              <textarea id="cdNotes" rows="2" maxlength="500"></textarea>
            </div>
            <div id="cdErr" class="err hidden"></div>
          </form>
        </div>
        <div class="basenModalActions">
          <button type="button" class="ghost" data-basen-modal-close="createDay">Anuluj</button>
          <button type="submit" form="basenCreateDayForm" class="primary" id="cdSubmitBtn">Utwórz termin</button>
        </div>
      </div>
    </div>
  `;
}

function renderDayDetailModalHtml() {
  return `
    <div id="basenDayDetailModal" class="basenModal hidden" aria-hidden="true">
      <div class="basenModalBackdrop" data-basen-modal-close="dayDetail"></div>
      <div class="basenModalCard" role="dialog" aria-modal="true" aria-label="Szczegóły terminu">
        <div class="basenModalTop">
          <div class="basenModalTopLeft">
            <button type="button" class="dangerBtn" id="ddCancelDayBtn">Anuluj basen</button>
            <div class="basenModalTitle" data-day-detail-title>Termin</div>
          </div>
          <button type="button" class="basenModalClose" data-basen-modal-close="dayDetail" aria-label="Zamknij">✕</button>
        </div>
        <div class="basenModalBody">
          <div class="row">
            <label for="ddCancelReason">Powód anulowania (opcjonalnie, trafia w mailu do zapisanych)</label>
            <input type="text" id="ddCancelReason" maxlength="500" placeholder="np. awaria niecki" />
          </div>
          <div data-day-detail-body></div>
          <div data-add-sauna-wrap></div>
        </div>
        <div class="basenModalActions">
          <button type="button" class="ghost" data-basen-modal-close="dayDetail">Zamknij</button>
        </div>
      </div>
    </div>
  `;
}

async function renderCalendarTab(innerEl, ctx) {
  innerEl.innerHTML = spinnerHtml("Ładowanie kalendarza…");

  let sessionsByDate;
  try {
    const data = await apiGetJson({ url: SESSIONS_URL, idToken: ctx.idToken });
    sessionsByDate = buildSessionsByDate(data);
    if (data?.season?.limitNaGodzine) innerEl.dataset.defaultCapacity = String(data.season.limitNaGodzine);
  } catch (e) {
    innerEl.innerHTML = `<div class="err">${esc(e?.message || "Nie udało się pobrać terminów.")}</div>`;
    return;
  }

  const today = new Date();
  const state = { year: today.getFullYear(), month: today.getMonth() };

  const refresh = async () => {
    const fresh = await apiGetJson({ url: SESSIONS_URL, idToken: ctx.idToken });
    sessionsByDate = buildSessionsByDate(fresh);
    draw();
  };

  const draw = () => {
    innerEl.innerHTML = renderCalendarShellHtml(state.year, state.month, sessionsByDate)
      + renderCreateDayModalHtml() + renderDayDetailModalHtml();
    bindCalendarNav(innerEl, state, draw);
    bindReservedFieldToggles(innerEl);
    bindCalendarDayClicks(innerEl, sessionsByDate, ctx, refresh);
  };

  draw();
}

function bindCalendarNav(innerEl, state, draw) {
  innerEl.querySelector(".basenCalendarHead")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-cal-nav]");
    if (!btn) return;
    state.month += btn.getAttribute("data-cal-nav") === "next" ? 1 : -1;
    if (state.month < 0) { state.month = 11; state.year -= 1; }
    if (state.month > 11) { state.month = 0; state.year += 1; }
    draw();
  });
}

function syncReservedSubFields(innerEl, prefix) {
  const n = Number(innerEl.querySelector(`#cd${prefix}Count`)?.value || 0);
  const kursantChecked = innerEl.querySelector(`#cd${prefix}Kursant`)?.checked === true;
  innerEl.querySelector(`[data-reserved-sub="${prefix}"]`)?.classList.toggle("hidden", !(n > 0));
  innerEl.querySelector(`[data-reserved-label-wrap="${prefix}"]`)?.classList.toggle("hidden", !(n > 0 && !kursantChecked));
}

function bindReservedFieldToggles(innerEl) {
  ["H1", "H2"].forEach((prefix) => {
    const sync = () => syncReservedSubFields(innerEl, prefix);
    innerEl.querySelector(`#cd${prefix}Count`)?.addEventListener("input", sync);
    innerEl.querySelector(`#cd${prefix}Kursant`)?.addEventListener("change", sync);
    sync();
  });
}

function bindCalendarModalCloseDelegation(innerEl) {
  innerEl.addEventListener("click", (ev) => {
    const key = ev.target?.getAttribute?.("data-basen-modal-close");
    if (key === "createDay") closeCreateDayModal(innerEl);
    if (key === "dayDetail") closeDayDetailModal(innerEl);
  });
}

function bindCalendarDayClicks(innerEl, sessionsByDate, ctx, onChanged) {
  innerEl.querySelectorAll(".basenCalDay[data-cal-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      const date = cell.getAttribute("data-cal-date");
      const session = sessionsByDate.get(date);
      if (session) openDayDetailModal(innerEl, ctx, session, onChanged);
      else openCreateDayModal(innerEl, ctx, date, onChanged);
    });
  });
}

function openCreateDayModal(innerEl, ctx, date, onChanged) {
  const modal = innerEl.querySelector("#basenCreateDayModal");
  if (!modal) return;

  const form = modal.querySelector("#basenCreateDayForm");
  form.reset();
  ["H1", "H2"].forEach((prefix) => syncReservedSubFields(innerEl, prefix));
  // Domyślna liczba miejsc z SETUP (basen_limit_uczestników), do zmiany w formularzu.
  const defaultCapacity = Number(innerEl.dataset.defaultCapacity) || 12;
  ["H1", "H2"].forEach((prefix) => {
    const el = modal.querySelector(`#cd${prefix}Capacity`);
    if (el) el.value = String(defaultCapacity);
  });
  const errEl = modal.querySelector("#cdErr");
  errEl.textContent = "";
  errEl.classList.add("hidden");
  modal.querySelector("[data-create-day-title]").textContent = `Nowy termin — ${formatDate(date)}`;

  const submitBtn = modal.querySelector("#cdSubmitBtn");

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    errEl.classList.add("hidden");
    submitBtn.disabled = true;
    submitBtn.textContent = "Tworzę…";

    const buildReserved = (prefix) => {
      const count = Number(modal.querySelector(`#cd${prefix}Count`)?.value || 0);
      if (!count) return undefined;
      const restrictedToKursant = modal.querySelector(`#cd${prefix}Kursant`)?.checked === true;
      const label = restrictedToKursant ? undefined : (String(modal.querySelector(`#cd${prefix}Label`)?.value || "").trim() || undefined);
      return { count, restrictedToKursant, label };
    };

    try {
      await apiPostJson({
        url: CREATE_SESSION_URL,
        idToken: ctx.idToken,
        body: {
          date,
          saunaEnabled: modal.querySelector("#cdSauna")?.checked === true,
          h1Reserved: buildReserved("H1"),
          h2Reserved: buildReserved("H2"),
          h1Capacity: Number(modal.querySelector("#cdH1Capacity")?.value) || undefined,
          h2Capacity: Number(modal.querySelector("#cdH2Capacity")?.value) || undefined,
          notes: String(modal.querySelector("#cdNotes")?.value || "").trim(),
        },
      });
      closeCreateDayModal(innerEl);
      await onChanged();
    } catch (e) {
      errEl.textContent = e?.message || "Nie udało się utworzyć terminu.";
      errEl.classList.remove("hidden");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Utwórz termin";
    }
  };

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeCreateDayModal(innerEl) {
  const modal = innerEl.querySelector("#basenCreateDayModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function renderDayDetailSlotHtml(slotKey, slot) {
  const generalCapacity = slot.capacity - (slot.reservedSpots?.count || 0);
  const isCancelled = slot.status === "cancelled";

  let reservedLine = "";
  if (slot.reservedSpots) {
    const rs = slot.reservedSpots;
    reservedLine = rs.restrictedToKursant
      ? `<div>Zarezerwowane: ${rs.count} (tylko kursanci, wykorzystano ${rs.usedCount}/${rs.count})</div>`
      : `<div>Zarezerwowane: ${rs.count}${rs.label ? ` — ${esc(rs.label)}` : ""}</div>`;
  }

  return `
    <div class="basenDayDetailSlot">
      <div class="basenDayDetailSlotHead">
        <span class="basenSlotLabel">${esc(SLOT_LABELS[slotKey] || slotKey)}</span>
        <span class="basenCardTime">${esc(slot.timeStart)}</span>
        ${isCancelled ? `<span class="basenSpotsFull">Odwołane</span>` : ""}
      </div>
      <div class="basenDayDetailSlotStats">
        <div>Ogólna pula: ${slot.enrolledCount} / ${generalCapacity}</div>
        ${reservedLine}
      </div>
    </div>
  `;
}

function openDayDetailModal(innerEl, ctx, session, onChanged) {
  const modal = innerEl.querySelector("#basenDayDetailModal");
  if (!modal) return;

  modal.querySelector("[data-day-detail-title]").textContent = formatDate(session.date);
  const reasonEl = modal.querySelector("#ddCancelReason");
  reasonEl.value = "";
  // Minione i odwołane terminy — tylko podgląd (bez anulowania i dodawania sauny).
  const readOnly = session.isPast || session.outcome === "cancelled";
  modal.querySelector("#ddCancelDayBtn").classList.toggle("hidden", readOnly);
  reasonEl.closest(".row")?.classList.toggle("hidden", readOnly);
  const statusLabel = session.outcome === "cancelled"
    ? (session.cancelReason === "frekwencja" ? `Odwołany automatycznie — za mało zapisów (${session.zapisy})` : "Odwołany")
    : session.isPast ? `Odbył się · zapisy: ${session.zapisy}`
    : session.outcome === "confirmed" ? `Potwierdzony · zapisy: ${session.zapisy}`
    : `Zapisy: ${session.zapisy} · decyzja: ${formatDecisionAt(session.decisionAtMs)}`;
  const body = modal.querySelector("[data-day-detail-body]");
  body.innerHTML = `<div class="basenSessionStatus${session.outcome === "cancelled" ? " basenSessionStatus--cancelled" : ""}">${esc(statusLabel)}</div>` + SLOT_ORDER
    .filter((key) => session.slots?.[key])
    .map((key) => renderDayDetailSlotHtml(key, session.slots[key]))
    .join("");

  const addSaunaWrap = modal.querySelector("[data-add-sauna-wrap]");
  if (readOnly) {
    addSaunaWrap.innerHTML = "";
  } else if (!session.slots?.SAUNA) {
    addSaunaWrap.innerHTML = `<button type="button" class="ghost" id="ddAddSaunaBtn">Dodaj saunę do tego terminu</button>`;
    const addSaunaBtn = addSaunaWrap.querySelector("#ddAddSaunaBtn");
    addSaunaBtn.addEventListener("click", async () => {
      addSaunaBtn.disabled = true;
      addSaunaBtn.textContent = "Dodaję…";
      try {
        await apiPostJson({ url: ADD_SAUNA_URL, idToken: ctx.idToken, body: { sessionId: session.id } });
        closeDayDetailModal(innerEl);
        await onChanged();
      } catch (e) {
        addSaunaBtn.disabled = false;
        addSaunaBtn.textContent = "Dodaj saunę do tego terminu";
        alert(e?.message || "Nie udało się dodać sauny.");
      }
    });
  } else {
    addSaunaWrap.innerHTML = "";
  }

  const cancelDayBtn = modal.querySelector("#ddCancelDayBtn");
  cancelDayBtn.onclick = async () => {
    if (!confirm(`Anulować basen ${formatDate(session.date)}? Wszyscy uczestnicy zostaną wypisani, a pobrane godziny basenowe wrócą na ich saldo.`)) return;
    cancelDayBtn.disabled = true;
    try {
      await apiPostJson({ url: CANCEL_SESSION_URL, idToken: ctx.idToken, body: { sessionId: session.id, reason: reasonEl.value.trim() || undefined } });
      closeDayDetailModal(innerEl);
      await onChanged();
    } catch (e) {
      cancelDayBtn.disabled = false;
      alert(e?.message || "Nie udało się anulować.");
    }
  };

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDayDetailModal(innerEl) {
  const modal = innerEl.querySelector("#basenDayDetailModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

// ─── Płatności (saldo godzin basenowych) ───────────────────────────────────────

function renderAddGodzinyModalHtml() {
  return `
    <div id="basenAddGodzinyModal" class="basenModal hidden" aria-hidden="true">
      <div class="basenModalBackdrop" data-basen-modal-close="addGodziny"></div>
      <div class="basenModalCard" role="dialog" aria-modal="true" aria-label="Dopisz godziny basenowe">
        <div class="basenModalTop">
          <div class="basenModalTitle" data-add-godziny-title>Dopisz godziny</div>
          <button type="button" class="basenModalClose" data-basen-modal-close="addGodziny" aria-label="Zamknij">✕</button>
        </div>
        <div class="basenModalBody">
          <div class="row">
            <label for="agProduct">Co opłacono</label>
            <select id="agProduct">
              <option value="jednorazowe">Godziny basenowe pojedyncze</option>
              <option value="karnet5">Karnet 5 godzin basenowych</option>
              <option value="karnet10">Karnet 10 godzin basenowych</option>
            </select>
          </div>
          <div class="row" data-ag-count-row>
            <label for="agAmount">Liczba godzin basenowych</label>
            <input type="number" id="agAmount" min="1" step="1" placeholder="np. 2" />
          </div>
          <div class="basenHint" data-ag-price></div>
          <div class="row">
            <label for="agReason">Uwagi (opcjonalnie)</label>
            <input type="text" id="agReason" maxlength="200" placeholder="np. przelew 10.11" />
          </div>
          <div id="agErr" class="err hidden"></div>
        </div>
        <div class="basenModalActions">
          <button type="button" class="ghost" data-basen-modal-close="addGodziny">Anuluj</button>
          <button type="button" class="primary" id="agSubmitBtn">Dopisz</button>
        </div>
      </div>
    </div>
  `;
}

function openAddGodzinyModal(innerEl, ctx, user, onSaved, pricing) {
  const modal = innerEl.querySelector("#basenAddGodzinyModal");
  if (!modal) return;

  modal.querySelector("[data-add-godziny-title]").textContent = `Dopisz godziny basenowe — ${user.userName || user.userNick || user.userEmail}`;
  const productEl = modal.querySelector("#agProduct");
  const amountEl = modal.querySelector("#agAmount");
  const countRow = modal.querySelector("[data-ag-count-row]");
  const priceEl = modal.querySelector("[data-ag-price]");
  const reasonEl = modal.querySelector("#agReason");
  const errEl = modal.querySelector("#agErr");
  const submitBtn = modal.querySelector("#agSubmitBtn");

  productEl.value = "jednorazowe";
  amountEl.value = "";
  reasonEl.value = "";
  errEl.textContent = "";
  errEl.classList.add("hidden");
  submitBtn.disabled = false;
  submitBtn.textContent = "Dopisz";

  // Kwota przelewu do sprawdzenia przez obsługę — cennik z SETUP (regulamin § 2).
  const syncPrice = () => {
    const product = productEl.value;
    countRow.classList.toggle("hidden", product !== "jednorazowe");
    const p = pricing || {};
    if (product === "jednorazowe") {
      const n = Number(amountEl.value) || 0;
      priceEl.textContent = p.jednorazowe ? `Kwota wpłaty: ${n * p.jednorazowe} zł (${p.jednorazowe} zł za godzinę basenową)` : "";
    } else {
      const price = product === "karnet5" ? p.karnet5 : p.karnet10;
      priceEl.textContent = price ? `Kwota wpłaty: ${price} zł · tylko członek z opłaconymi składkami i dodatnim saldem godzinek` : "";
    }
  };
  productEl.onchange = syncPrice;
  amountEl.oninput = syncPrice;
  syncPrice();

  submitBtn.onclick = async () => {
    const product = productEl.value;
    const count = Number(amountEl.value);
    if (product === "jednorazowe" && (!count || count <= 0)) {
      errEl.textContent = "Podaj liczbę godzin basenowych większą od 0.";
      errEl.classList.remove("hidden");
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Zapisuję…";
    try {
      const res = await apiPostJson({
        url: GODZINY_ADD_URL,
        idToken: ctx.idToken,
        body: { userUid: user.userUid, product, count: product === "jednorazowe" ? count : undefined, reason: reasonEl.value.trim() || undefined },
      });
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
      await onSaved(res?.newBalance);
    } catch (e) {
      errEl.textContent = e?.message || "Nie udało się dopisać godzin basenowych.";
      errEl.classList.remove("hidden");
      submitBtn.disabled = false;
      submitBtn.textContent = "Dopisz";
    }
  };

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function renderGodzinyHistoryModalHtml() {
  return `
    <div id="basenGodzinyHistoryModal" class="basenModal hidden" aria-hidden="true">
      <div class="basenModalBackdrop" data-basen-modal-close="history"></div>
      <div class="basenModalCard" role="dialog" aria-modal="true" aria-label="Historia godzin basenowych">
        <div class="basenModalTop">
          <div class="basenModalTitle" data-history-title>Historia godzin basenowych</div>
          <button type="button" class="basenModalClose" data-basen-modal-close="history" aria-label="Zamknij">✕</button>
        </div>
        <div class="basenModalBody">
          <div id="basenGodzinyHistoryBody"></div>
        </div>
        <div class="basenModalActions">
          <button type="button" class="ghost" data-basen-modal-close="history">Zamknij</button>
        </div>
      </div>
    </div>
  `;
}

// Ten sam "wyciąg bankowy" co zakładka "Moje konto" (renderGodzinyLedgerRow/formatGodzinyDate
// zdefiniowane niżej w tym pliku) — tylko dla WSKAZANEGO usera zamiast requestera.
function openGodzinyHistoryModal(innerEl, ctx, user) {
  const modal = innerEl.querySelector("#basenGodzinyHistoryModal");
  if (!modal) return;

  modal.querySelector("[data-history-title]").textContent = `Historia godzin basenowych — ${user.userName || user.userNick || user.userEmail}`;
  const body = modal.querySelector("#basenGodzinyHistoryBody");
  body.innerHTML = spinnerHtml("Ładowanie…");

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  apiGetJson({ url: `${GODZINY_HISTORY_URL}?userUid=${encodeURIComponent(user.userUid)}`, idToken: ctx.idToken })
    .then((data) => {
      const balance = Number(data?.balance ?? 0);
      const records = Array.isArray(data?.records) ? data.records : [];
      const rowsHtml = records.length
        ? records.map(renderGodzinyLedgerRow).join("")
        : `<div class="basenHint">Brak historii — brak operacji na godzinach basenowych.</div>`;
      body.innerHTML = `
        <div class="row">
          <div class="basenAttendeesGroupTitle">Saldo</div>
          <div class="${balance > 0 ? "basenGodzinyBalance" : "basenGodzinyBalanceZero"}" style="font-size:20px;">${balance} h</div>
        </div>
        <div class="basenAttendeesGroupTitle" style="margin-top:14px;">Historia</div>
        <div class="basenLedgerList">${rowsHtml}</div>
      `;
    })
    .catch((e) => {
      body.innerHTML = `<div class="err">${esc(e?.message || "Nie udało się pobrać historii.")}</div>`;
    });
}

function closeGodzinyHistoryModal(innerEl) {
  const modal = innerEl.querySelector("#basenGodzinyHistoryModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function renderGodzinyRow(u) {
  const name = esc(u.userName || u.userNick || u.userEmail || u.userUid);
  const nickLine = (u.userNick && u.userName) ? `<div class="basenHint">${esc(u.userNick)}</div>` : "";
  const balCls = u.balance > 0 ? "basenGodzinyBalance" : "basenGodzinyBalanceZero";
  return `
    <div class="basenGodzinyRow" data-uid="${esc(u.userUid)}">
      <div class="basenGodzinyRowInfo">
        <div>${name}</div>
        ${nickLine}
        <div class="basenHint">${esc(u.userEmail || "")}</div>
      </div>
      <div class="${balCls}">${u.balance} h</div>
      <div class="basenGodzinyRowActions">
        <button type="button" class="ghost small basenAddGodzinyBtn" data-uid="${esc(u.userUid)}">Dopisz godziny basenowe</button>
        <button type="button" class="ghost small basenShowHistoryBtn" data-uid="${esc(u.userUid)}">Pokaż historię</button>
      </div>
    </div>
  `;
}

// Zamówienia „Kup" czekające na potwierdzenie wpłaty: opiekun sprawdza wpływ na konto
// (albo gotówkę) i zatwierdza — dopiero wtedy godziny basenowe trafiają na saldo.
function renderPendingOrdersHtml(orders) {
  const rows = orders.map((o) => `
    <div class="basenGodzinyRow" data-order-row="${esc(o.id)}">
      <div class="basenGodzinyRowInfo">
        <div>${esc(o.userName || o.userEmail)}</div>
        <div class="basenHint">${esc(o.userEmail || "")}</div>
        <div>${esc(String(o.label || "").replace(/\s*\(.*\)$/, ""))} · <strong>${esc(formatZl(o.amountPln))}</strong></div>
        <div class="basenHint">Tytuł: ${esc(o.transferTitle)} · ${esc(formatGodzinyDate(o.createdAt))}</div>
      </div>
      <div class="basenGodzinyRowActions">
        <button type="button" class="primary small" data-order-approve="${esc(o.id)}">Wpłata jest — zatwierdź</button>
        <button type="button" class="ghost small" data-order-reject-open="${esc(o.id)}">Odrzuć</button>
      </div>
      <div class="basenShopRejectRow hidden" data-order-reject-box="${esc(o.id)}">
        <input type="text" maxlength="300" placeholder="Powód odrzucenia (trafi do użytkownika mailem)" data-order-reject-reason="${esc(o.id)}" />
        <button type="button" class="ghost small" data-order-reject="${esc(o.id)}">Odrzuć zamówienie</button>
      </div>
    </div>`).join("");
  return `
    <div class="basenAttendeesGroupTitle" style="margin-top:12px;">Do zatwierdzenia (${orders.length})</div>
    <div class="basenGodzinyList">${orders.length ? rows : `<div class="basenHint">Brak zamówień czekających na potwierdzenie wpłaty.</div>`}</div>
    <div id="ordersErr" class="err hidden"></div>`;
}

function bindPendingOrders(innerEl, ctx, reload) {
  const errEl = innerEl.querySelector("#ordersErr");
  const fail = (btn, e) => {
    btn.disabled = false;
    if (errEl) {
      errEl.textContent = e?.message || "Nie udało się zapisać decyzji.";
      errEl.classList.remove("hidden");
    }
  };
  innerEl.querySelectorAll("[data-order-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await apiPostJson({ url: ORDER_URL, idToken: ctx.idToken, body: { action: "approve", orderId: btn.getAttribute("data-order-approve") } });
        await reload();
      } catch (e) {
        fail(btn, e);
      }
    });
  });
  innerEl.querySelectorAll("[data-order-reject-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      innerEl.querySelector(`[data-order-reject-box="${btn.getAttribute("data-order-reject-open")}"]`)?.classList.toggle("hidden");
    });
  });
  innerEl.querySelectorAll("[data-order-reject]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-order-reject");
      const reason = String(innerEl.querySelector(`[data-order-reject-reason="${id}"]`)?.value || "").trim();
      if (!reason) {
        fail(btn, { message: "Podaj powód odrzucenia." });
        return;
      }
      btn.disabled = true;
      try {
        await apiPostJson({ url: ORDER_URL, idToken: ctx.idToken, body: { action: "reject", orderId: id, reason } });
        await reload();
      } catch (e) {
        fail(btn, e);
      }
    });
  });
}

async function renderPaymentsTab(innerEl, ctx) {
  innerEl.innerHTML = spinnerHtml("Ładowanie…");

  let rows;
  let pricing = null;
  let pendingOrders = [];
  try {
    const data = await apiGetJson({ url: GODZINY_USERS_URL, idToken: ctx.idToken });
    rows = Array.isArray(data?.rows) ? data.rows : [];
    pricing = data?.pricing || null;
    pendingOrders = Array.isArray(data?.pendingOrders) ? data.pendingOrders : [];
  } catch (e) {
    innerEl.innerHTML = `<div class="err">${esc(e?.message || "Nie udało się pobrać listy użytkowników.")}</div>`;
    return;
  }

  const byUid = new Map(rows.map((u) => [u.userUid, u]));

  const draw = () => {
    innerEl.innerHTML = `
      ${renderPendingOrdersHtml(pendingOrders)}
      <div class="row" style="margin-top:12px;">
        <label for="paymentsSearch">Szukaj (mail / nazwisko / ksywka)</label>
        <input type="text" id="paymentsSearch" placeholder="np. jan.kowalski albo Kowalski albo ksywka" autocomplete="off" />
      </div>
      <div class="basenHint">Lista pokazuje tylko osoby aktywne w basenie (zapis albo ruch na koncie godzin basenowych) w ostatnich 4 miesiącach.</div>
      <div id="paymentsSummary" class="hint" style="margin:8px 0;"></div>
      <div id="paymentsContent"></div>
      ${renderAddGodzinyModalHtml()}
      ${renderGodzinyHistoryModalHtml()}
    `;

    bindPendingOrders(innerEl, ctx, () => renderPaymentsTab(innerEl, ctx));

    const searchEl = innerEl.querySelector("#paymentsSearch");
    const summaryEl = innerEl.querySelector("#paymentsSummary");
    const contentEl = innerEl.querySelector("#paymentsContent");

    const renderList = () => {
      const q = searchEl.value.trim().toLowerCase();
      const filtered = q
        ? rows.filter((u) =>
            String(u.userEmail || "").toLowerCase().includes(q) ||
            String(u.userName || "").toLowerCase().includes(q) ||
            String(u.userNick || "").toLowerCase().includes(q))
        : rows;

      const withHours = filtered.filter((u) => u.balance > 0);
      const withoutHours = filtered.filter((u) => u.balance <= 0);

      summaryEl.textContent = `Razem: ${filtered.length} · Mają godziny basenowe: ${withHours.length} · Brak godzin basenowych: ${withoutHours.length}`;

      let html = "";
      html += `<div class="basenAttendeesGroupTitle">Mają godziny basenowe</div>`;
      html += `<div class="basenGodzinyList">${withHours.length ? withHours.map(renderGodzinyRow).join("") : `<div class="basenHint">Brak.</div>`}</div>`;
      html += `<div class="basenAttendeesGroupTitle" style="margin-top:14px;">Brak godzin basenowych</div>`;
      html += `<div class="basenGodzinyList">${withoutHours.length ? withoutHours.map(renderGodzinyRow).join("") : `<div class="basenHint">Brak.</div>`}</div>`;
      contentEl.innerHTML = html;

      contentEl.querySelectorAll(".basenAddGodzinyBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const user = byUid.get(btn.getAttribute("data-uid"));
          if (!user) return;
          openAddGodzinyModal(innerEl, ctx, user, async (newBalance) => {
            if (typeof newBalance === "number") user.balance = newBalance;
            renderList();
          }, pricing);
        });
      });

      contentEl.querySelectorAll(".basenShowHistoryBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const user = byUid.get(btn.getAttribute("data-uid"));
          if (!user) return;
          openGodzinyHistoryModal(innerEl, ctx, user);
        });
      });
    };

    searchEl.addEventListener("input", renderList);
    innerEl.addEventListener("click", (ev) => {
      const key = ev.target?.getAttribute?.("data-basen-modal-close");
      if (key === "addGodziny") {
        const modal = innerEl.querySelector("#basenAddGodzinyModal");
        modal?.classList.add("hidden");
        modal?.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
      }
      if (key === "history") closeGodzinyHistoryModal(innerEl);
    });

    renderList();
  };

  draw();
}

// ─── Finanse (obsługa basenu i zarząd) ────────────────────────────────────────

function formatPln(n) {
  const v = Math.round(Number(n || 0));
  return `${v > 0 ? "+" : ""}${v.toLocaleString("pl-PL")} zł`;
}

function shortDate(iso) {
  const m = String(iso || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}.${m[1]}` : iso;
}

const LIGHT_LABELS = {
  green: "🟢 rusza",
  yellow: "🟡 rusza w ramach budżetu",
  red: "🔴 zostanie odwołany",
};

// Koło budżetu sezonu: w środku % budżetu, który został (100% + wynik netto / budżet).
// Na plusie: pełny zielony pierścień + ciemnozielony łuk nadwyżki (np. 130% → +30%).
// Na minusie: zielony łuk tego, co zostało, i czerwony fragment wykorzystanej straty.
function renderBudgetDonutSvg(netPln, budget) {
  if (!budget) return `<div class="basenHint">Brak budżetu sezonu w SETUP (basen_budzet_sezonu).</div>`;
  const pct = (budget + Number(netPln || 0)) / budget * 100;
  const R = 70, C = 2 * Math.PI * R;
  const arc = (cls, fromPct, lenPct) => {
    const len = Math.max(0, Math.min(100, lenPct)) / 100 * C;
    if (len <= 0) return "";
    return `<circle class="${cls}" cx="90" cy="90" r="${R}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-fromPct / 100 * C).toFixed(2)}" transform="rotate(-90 90 90)" />`;
  };
  let rings;
  if (pct >= 100) {
    rings = arc("bfRingOk", 0, 100) + arc("bfRingSurplus", 0, Math.min(pct - 100, 100));
  } else if (pct > 0) {
    rings = arc("bfRingOk", 0, pct) + arc("bfRingUsed", pct, 100 - pct);
  } else {
    rings = arc("bfRingUsed", 0, 100);
  }
  const cls = pct >= 100 ? "bfPos" : "bfNeg";
  return `
    <div class="basenBudgetDonut">
      <svg viewBox="0 0 180 180" role="img" aria-label="Zostało ${Math.round(pct)}% budżetu sezonu">
        <circle class="bfRingTrack" cx="90" cy="90" r="${R}" />
        ${rings}
        <text class="bfDonutPct ${cls}" x="90" y="92" text-anchor="middle">${esc(Math.round(pct))}%</text>
        <text class="bfDonutSub" x="90" y="114" text-anchor="middle">budżetu zostało</text>
      </svg>
      <div class="basenFinanceLegend">
        <span><i class="bfKey bfKeyOk"></i>zostało</span>
        ${pct < 100 ? `<span><i class="bfKey bfKeyUsed"></i>wykorzystana strata</span>` : ""}
        ${pct > 100 ? `<span><i class="bfKey bfKeySurplus"></i>nadwyżka ponad budżet</span>` : ""}
      </div>
      <div class="basenHint">Budżet ${esc(budget)} zł · wynik netto ${esc(formatPln(netPln))}</div>
    </div>
  `;
}

async function renderFinanceTab(innerEl, ctx) {
  innerEl.innerHTML = spinnerHtml("Ładowanie finansów…");
  let data;
  try {
    data = await apiGetJson({ url: `${SESSIONS_URL}?view=finance`, idToken: ctx.idToken });
  } catch (e) {
    innerEl.innerHTML = `<div class="err">${esc(e?.message || "Nie udało się pobrać finansów.")}</div>`;
    return;
  }

  const s = data.summary || {};
  const rules = data.rules || {};
  const sales = data.sales || {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const upcoming = rows.filter((r) => r.outcome === "planned" || r.outcome === "confirmed");
  const past = rows.filter((r) => r.outcome === "held" || (r.outcome === "cancelled" && r.date < todayIso()));
  const cancelledUpcoming = rows.filter((r) => r.outcome === "cancelled" && r.date >= todayIso());
  const budget = Number(s.budgetPln || 0);
  const usedPct = budget ? Math.min(100, Math.max(0, (-Math.min(0, s.netPln)) / budget * 100)) : 0;

  const upcomingRows = upcoming.map((r) => {
    const missing = r.resultPln < 0 && rules.cenaWejscia ? Math.ceil(-r.resultPln / rules.cenaWejscia) : 0;
    const forecast = r.outcome === "confirmed" ? "✓ potwierdzony" : (LIGHT_LABELS[r.light] || "");
    return `
      <tr>
        <td>${esc(shortDate(r.date))}${r.kurs ? ` <span class="basenHint">kurs</span>` : ""}</td>
        <td>${esc(r.zapisyH1)} / ${esc(r.zapisyH2)}${r.sauna ? ` <span class="basenHint">+${esc(r.sauna)} sauna</span>` : ""}</td>
        <td class="${r.resultPln >= 0 ? "bfPos" : "bfNeg"}">${esc(formatPln(r.resultPln))}${missing ? `<div class="basenHint">do zera ok. ${esc(missing)} godz. basenowych</div>` : ""}</td>
        <td>${esc(forecast)}${r.outcome === "planned" ? `<div class="basenHint">decyzja ${esc(formatDecisionAt(r.decisionAtMs))}</div>` : ""}</td>
      </tr>`;
  }).join("");

  const pastRows = past.slice().reverse().map((r) => `
      <tr class="${r.outcome === "cancelled" ? "bfRowCancelled" : ""}">
        <td>${esc(shortDate(r.date))}${r.kurs ? ` <span class="basenHint">kurs</span>` : ""}</td>
        <td>${r.outcome === "cancelled" ? (r.cancelReason === "frekwencja" ? `odwołany (${esc(r.zapisy)} zapisów)` : "odwołany") : `${esc(r.zapisy)} zapisów · ${esc(r.entries)} godz. basenowych`}</td>
        <td class="${r.resultPln >= 0 ? "bfPos" : "bfNeg"}">${r.outcome === "cancelled" ? "—" : esc(formatPln(r.resultPln))}</td>
      </tr>`).join("");

  innerEl.innerHTML = `
    <div class="basenFinanceTiles">
      <div class="basenFinanceTile">
        <div class="basenFinanceTileLabel">Wynik netto sezonu ${esc(s.key || "")}</div>
        <div class="basenFinanceTileValue ${s.netPln >= 0 ? "bfPos" : "bfNeg"}">${esc(formatPln(s.netPln))}</div>
        <div class="basenHint">odbyte i potwierdzone terminy</div>
      </div>
      <div class="basenFinanceTile">
        <div class="basenFinanceTileLabel">Zapas straty sezonu</div>
        <div class="basenFinanceTileValue">${esc(Math.round(s.budgetLeftPln).toLocaleString("pl-PL"))} zł</div>
        <div class="basenFinanceMeter" title="Wykorzystano ${usedPct.toFixed(0)}% limitu ${esc(budget)} zł"><span style="width:${usedPct.toFixed(1)}%"></span></div>
        <div class="basenHint">limit ${esc(budget)} zł · wykorzystano ${usedPct.toFixed(0)}%</div>
      </div>
      <div class="basenFinanceTile">
        <div class="basenFinanceTileLabel">Terminy</div>
        <div class="basenFinanceTileValue">${esc(s.held)} <span class="basenHint">odbyte</span></div>
        <div class="basenHint">potwierdzone ${esc(s.confirmed)} · zaplanowane ${esc(s.planned)} · odwołane: frekwencja ${esc(s.cancelledLow)}, inne ${esc(s.cancelledAdmin)}</div>
      </div>
      <div class="basenFinanceTile">
        <div class="basenFinanceTileLabel">Sprzedaż w sezonie</div>
        <div class="basenFinanceTileValue">${esc(Math.round(sales.totalPln || 0).toLocaleString("pl-PL"))} zł</div>
        <div class="basenHint">pojedyncze ${esc(sales.jednorazowe?.entries || 0)} godz. basenowych · karnety 5: ${esc(sales.karnet5?.count || 0)} · karnety 10: ${esc(sales.karnet10?.count || 0)}</div>
      </div>
    </div>

    <div class="basenAttendeesGroupTitle" style="margin-top:16px;">Wynik sezonu</div>
    ${renderBudgetDonutSvg(s.netPln, budget)}

    <div class="basenAttendeesGroupTitle" style="margin-top:16px;">Nadchodzące terminy</div>
    ${upcoming.length ? `
      <div class="basenFinanceTableWrap"><table class="basenFinanceTable">
        <thead><tr><th>Data</th><th>Zapisy H1 / H2</th><th>Wynik teraz</th><th>Prognoza</th></tr></thead>
        <tbody>${upcomingRows}</tbody>
      </table></div>` : `<div class="basenHint">Brak nadchodzących terminów.</div>`}
    ${cancelledUpcoming.length ? `<div class="basenHint" style="margin-top:6px;">Odwołane nadchodzące: ${cancelledUpcoming.map((r) => esc(shortDate(r.date))).join(", ")}</div>` : ""}

    <div class="basenAttendeesGroupTitle" style="margin-top:16px;">Minione terminy</div>
    ${past.length ? `
      <div class="basenFinanceTableWrap"><table class="basenFinanceTable">
        <thead><tr><th>Data</th><th>Przebieg</th><th>Wynik</th></tr></thead>
        <tbody>${pastRows}</tbody>
      </table></div>` : `<div class="basenHint">Brak minionych terminów.</div>`}

    <div class="basenHint" style="margin-top:14px;">
      Zasada: termin rusza, gdy wynik ≥ 0 zł albo strata ≤ ${esc(rules.maxStrataTerminu)} zł i wynik sezonu po niej ≥ −${esc(rules.budzetSezonu)} zł.
      Koszt terminu ${esc(rules.kosztTerminu)} zł. Decyzja automatyczna ${esc(rules.oknoH)} h przed basenem; odwołanie zwraca godziny basenowe i wysyła maila.
      Godzina basenowa wyceniana po cenie zakupu, w kolejności zakupów (karnet taniej, nagroda instruktora 0 zł); „do zera” liczone po ${esc(rules.cenaWejscia)} zł. Terminy kursowe poza wynikiem.
    </div>
  `;
}

// ─── Moje konto (wyciąg — pełna historia własnych godzin basenowych) ──────────

const GODZINY_TYPE_LABELS = {
  admin_add: "Dopisane",
  booking_block: "Wykorzystane",
  booking_refund: "Zwrot",
  instructor_reward: "Nagroda za instruktorowanie",
};

function formatGodzinyDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Kilka zapisanych w Firestore "reason" jest za długich na jeden wiersz na mobile —
// skracane tylko na wyświetlaniu (bez migracji danych), wzorem shortenReason w
// godzinki_module.js.
function shortenBasenReason(reason) {
  if (reason === "Zwrot godziny — anulowanie zapisu na basen") return "Zwrot — anulowanie basenu";
  return reason || "";
}

function renderGodzinyLedgerRow(r) {
  const positive = r.amount > 0;
  const sign = positive ? "+" : "";
  const typeLabel = GODZINY_TYPE_LABELS[r.type] || r.type;
  return `
    <div class="basenLedgerRow">
      <div class="basenLedgerMain">
        <div class="basenLedgerType">${esc(typeLabel)}</div>
        <div class="basenLedgerReason">${esc(shortenBasenReason(r.reason))}</div>
        <div class="basenLedgerDate">${esc(formatGodzinyDate(r.createdAt))}</div>
      </div>
      <div class="${positive ? "basenGodzinyBalance" : "basenGodzinyBalanceZero"}">${sign}${r.amount} h</div>
    </div>
  `;
}

const ORDER_STATUS_LABELS = {
  pending: "czeka na potwierdzenie wpłaty",
  approved: "zatwierdzone — godziny basenowe na saldzie",
  rejected: "odrzucone",
  cancelled: "anulowane",
};

function formatZl(n) {
  const v = Number(n || 0);
  return `${Number.isInteger(v) ? v : v.toFixed(2).replace(".", ",")} zł`;
}

// Kafelki „Kup": pojedyncze godziny basenowe dla każdego; karnety tylko dla członka
// klubu — nieaktywne (z powodem), gdy brak opłaconych składek albo dodatniego salda godzinek.
function renderShopHtml(shop) {
  const p = shop?.pricing || {};
  const karnet = shop?.karnet || {};
  const karnetTile = (product, n, price) => {
    if (!karnet.member) return "";
    const disabled = !karnet.eligible;
    return `
      <div class="basenShopTile${disabled ? " disabled" : ""}">
        <div class="basenShopTitle">Karnet ${n}</div>
        <div class="basenShopPrice">${esc(formatZl(price))}</div>
        <div class="basenHint">${n} godzin basenowych · ${esc(formatZl(price / n))} za godzinę</div>
        <button type="button" class="primary small" data-shop-buy="${product}" ${disabled ? "disabled" : ""}>Kup</button>
      </div>`;
  };
  const reasons = karnet.member && !karnet.eligible && Array.isArray(karnet.reasons) && karnet.reasons.length
    ? `<div class="basenShopReasons">Karnety nieaktywne: ${karnet.reasons.map(esc).join(" ")}</div>`
    : "";
  return `
    <div class="basenAttendeesGroupTitle" style="margin-top:16px;">Kup godziny basenowe</div>
    <div class="basenShopGrid">
      <div class="basenShopTile">
        <div class="basenShopTitle">Pojedyncze</div>
        <div class="basenShopPrice">${esc(formatZl(p.jednorazowe))}</div>
        <div class="basenHint">za godzinę basenową</div>
        <div class="basenShopCount">
          <label for="shopCount">Ile</label>
          <input type="number" id="shopCount" min="1" max="${esc(shop?.maxSingleCount || 20)}" step="1" value="1" />
        </div>
        <button type="button" class="primary small" data-shop-buy="jednorazowe">Kup</button>
      </div>
      ${karnetTile("karnet5", 5, p.karnet5)}
      ${karnetTile("karnet10", 10, p.karnet10)}
    </div>
    ${reasons}
    ${karnet.member ? `<div class="basenHint">Godziny basenowe z karnetu wykorzystasz na dowolnych basenach i godzinach do końca sezonu basenowego${shop?.seasonEnd ? ` (${esc(formatDate(shop.seasonEnd).replace(/ \(.*\)$/, ""))})` : ""}.</div>` : ""}
    <div class="basenHint">Płatność przelewem na konto klubu albo gotówką opiekunowi basenu. Godziny basenowe pojawią się na saldzie po potwierdzeniu wpłaty.</div>
    <div id="shopResult"></div>
    <div id="shopErr" class="err hidden"></div>
  `;
}

function renderPaymentInfoHtml(shop, order) {
  const account = shop?.account
    ? `${esc(shop.account)}${shop.bank ? ` <span class="basenHint">(${esc(shop.bank)})</span>` : ""}`
    : "— (brak w ustawieniach, zapytaj opiekuna basenu)";
  return `
    <div class="basenShopPayInfo">
      <div><strong>Zamówienie przyjęte:</strong> ${esc(order.label)}</div>
      <div>Kwota: <strong>${esc(formatZl(order.amountPln))}</strong></div>
      <div>Konto klubu: <strong>${account}</strong></div>
      <div>Tytuł przelewu: <strong>${esc(order.transferTitle)}</strong></div>
      <div class="basenHint">Te same dane wysłaliśmy mailem.</div>
    </div>`;
}

function renderOrdersHtml(orders) {
  if (!orders.length) return "";
  const rows = orders.map((o) => `
    <div class="basenLedgerRow">
      <div class="basenLedgerMain">
        <div class="basenLedgerType">${esc(o.label)}</div>
        <div class="basenLedgerReason">${esc(ORDER_STATUS_LABELS[o.status] || o.status)}${o.status === "rejected" && o.rejectReason ? ` — ${esc(o.rejectReason)}` : ""}</div>
        ${o.status === "pending" ? `<div class="basenHint">Tytuł przelewu: ${esc(o.transferTitle)}</div>` : ""}
        <div class="basenLedgerDate">${esc(formatGodzinyDate(o.createdAt))}</div>
      </div>
      <div class="basenShopOrderSide">
        <div>${esc(formatZl(o.amountPln))}</div>
        ${o.status === "pending" ? `<button type="button" class="ghost small" data-order-cancel="${esc(o.id)}">Anuluj</button>` : ""}
      </div>
    </div>`).join("");
  return `
    <div class="basenAttendeesGroupTitle" style="margin-top:16px;">Twoje zamówienia</div>
    <div class="basenLedgerList">${rows}</div>`;
}

async function renderAccountTab(innerEl, ctx, notice = "") {
  innerEl.innerHTML = spinnerHtml("Ładowanie…");

  let data;
  try {
    data = await apiGetJson({ url: GODZINY_MY_URL, idToken: ctx.idToken });
  } catch (e) {
    innerEl.innerHTML = `<div class="err">${esc(e?.message || "Nie udało się pobrać historii godzin basenowych.")}</div>`;
    return;
  }
  const balance = Number(data?.balance ?? 0);
  const records = Array.isArray(data?.records) ? data.records : [];
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const shop = data?.shop || null;

  const rowsHtml = records.length
    ? records.map(renderGodzinyLedgerRow).join("")
    : `<div class="basenHint">Brak historii — nie masz jeszcze żadnych operacji na godzinach basenowych.</div>`;

  innerEl.innerHTML = `
    <div class="row" style="margin-top:12px;">
      <div class="basenAttendeesGroupTitle">Saldo godzin basenowych</div>
      <div class="${balance > 0 ? "basenGodzinyBalance" : "basenGodzinyBalanceZero"}" style="font-size:20px;">${balance} h</div>
    </div>
    ${shop ? renderShopHtml(shop) : ""}
    ${renderOrdersHtml(orders)}
    <div class="basenAttendeesGroupTitle" style="margin-top:16px;">Historia (wyciąg)</div>
    <div class="basenLedgerList">${rowsHtml}</div>
  `;
  if (notice) innerEl.querySelector("#shopResult").innerHTML = notice;

  const errEl = innerEl.querySelector("#shopErr");
  const showErr = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  };

  innerEl.querySelectorAll("[data-shop-buy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const product = btn.getAttribute("data-shop-buy");
      const count = product === "jednorazowe" ? Number(innerEl.querySelector("#shopCount")?.value) : undefined;
      if (product === "jednorazowe" && (!Number.isInteger(count) || count <= 0)) {
        showErr("Podaj liczbę godzin basenowych większą od 0.");
        return;
      }
      btn.disabled = true;
      try {
        const res = await apiPostJson({ url: ORDER_URL, idToken: ctx.idToken, body: { action: "create", product, count } });
        await renderAccountTab(innerEl, ctx, renderPaymentInfoHtml(shop, res.order));
      } catch (e) {
        btn.disabled = false;
        showErr(e?.message || "Nie udało się złożyć zamówienia.");
      }
    });
  });

  innerEl.querySelectorAll("[data-order-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await apiPostJson({ url: ORDER_URL, idToken: ctx.idToken, body: { action: "cancel", orderId: btn.getAttribute("data-order-cancel") } });
        await renderAccountTab(innerEl, ctx);
      } catch (e) {
        btn.disabled = false;
        showErr(e?.message || "Nie udało się anulować zamówienia.");
      }
    });
  });
}

// ─── Module ───────────────────────────────────────────────────────────────────

export function createBasenModule({ id, type, label, defaultRoute, order, enabled, access }) {
  return {
    id,
    type,
    label,
    defaultRoute,
    order,
    enabled,
    access,

    async render({ viewEl, routeId, ctx }) {
      if (!ctx?.idToken) {
        viewEl.innerHTML = `<div class="card center"><h2>${esc(label)}</h2><p>Brak tokenu sesji. Odśwież stronę.</p></div>`;
        return;
      }

      const actions = ctx?.session?.allowed_actions ?? [];
      const isAdmin = actions.includes("basen.admin");
      const canEnroll = actions.includes("basen.enroll");

      const requestedTab = String(routeId || "").trim();
      const validTabs = ["sessions", "account", ...(isAdmin ? ["calendar", "payments", "finance"] : [])];
      const activeTab = validTabs.includes(requestedTab) ? requestedTab : "sessions";

      viewEl.innerHTML = `
        <div class="card wide">
          <div class="moduleHeader">
            <h2>${esc(label)}</h2>
            <div class="moduleNav">
              <button type="button" class="moduleNavBtn" data-mod-back title="Wróć">${NAV_BACK_SVG}</button>
              <button type="button" class="moduleNavBtn" data-mod-home title="Strona główna">${NAV_HOME_SVG}</button>
            </div>
          </div>
          ${renderTabsHtml(activeTab, isAdmin)}
          <div id="basenInner"></div>
        </div>
      `;

      const innerEl = viewEl.querySelector("#basenInner");

      // Delegacja kliknięć na zamykanie modali — bindowana RAZ na cały czas życia tego
      // #basenInner (świeży węzeł DOM przy każdym wejściu do modułu, patrz viewEl.innerHTML
      // wyżej). Wcześniej wołane wewnątrz bindSessionActions/draw(), czyli PRZY KAŻDYM
      // odświeżeniu widoku (każdy zapis/anulowanie/nawigacja miesiąca) — #basenInner samo
      // w sobie nigdy nie jest zastępowane (tylko jego innerHTML), więc nasłuchiwacze się
      // mnożyły z każdą akcją w tej samej sesji (realny incydent: spowolnienie/zawieszenie
      // po serii zapisów). Funkcje close* i tak robią świeże querySelector przy każdym
      // kliknięciu, więc jednorazowe bindowanie tutaj jest w pełni bezpieczne.
      bindModalCloseDelegation(innerEl);
      bindCalendarModalCloseDelegation(innerEl);
      bindSessionActionsDelegation(innerEl, ctx, canEnroll);

      viewEl.querySelector("[data-mod-home]")?.addEventListener("click", () => {
        window.location.hash = "#home/home";
      });
      viewEl.querySelector("[data-mod-back]")?.addEventListener("click", () => {
        if (activeTab !== "sessions") {
          window.location.hash = `#${id}/sessions`;
        } else {
          window.location.hash = "#home/home";
        }
      });

      viewEl.querySelector(".basenTabs")?.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-basen-tab]");
        if (!btn) return;
        const tab = btn.getAttribute("data-basen-tab");
        window.location.hash = `#${id}/${tab}`;
      });

      if (activeTab === "calendar" && isAdmin) {
        await renderCalendarTab(innerEl, ctx);
      } else if (activeTab === "payments" && isAdmin) {
        await renderPaymentsTab(innerEl, ctx);
      } else if (activeTab === "finance" && isAdmin) {
        await renderFinanceTab(innerEl, ctx);
      } else if (activeTab === "account") {
        await renderAccountTab(innerEl, ctx);
      } else {
        await renderSessionsView(innerEl, ctx, canEnroll);
      }
    },
  };
}
