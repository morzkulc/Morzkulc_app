// public/modules/profile_data_box.js
// Profil → blok „Moje dane”: podgląd i edycja własnego imienia, nazwiska, telefonu i daty urodzenia.
// Niepoprawna data (np. poniżej 16 / powyżej 100 lat) → serwer odrzuca z komunikatem; pop-up przy
// starcie aplikacji (app_shell.js) przekierowuje tu z flagą FIX_DOB_KEY i formularz otwiera się sam.
// Zapis idzie do bazy i od razu (job w tle, kilka sekund) do arkusza członków — arkusz jest
// źródłem tych danych, nocna synchronizacja nadpisałaby zmianę zrobioną tylko w aplikacji.
import { apiGetJson, apiPostJson } from "/core/api_client.js";
import { mapUserFacingApiError } from "/core/user_error_messages.js";
import { escapeHtml, escapeAttr } from "/core/html_utils.js";
import { checkBirthDateClient } from "/core/birth_date.js";

const URL_PROFILE_DATA = "/api/profile/data";
export const FIX_DOB_KEY = "mk.fixBirthDate";

function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || "—");
}

function phoneDigits(v) {
  return String(v || "").replace(/[^\d]/g, "").length;
}

function birthNoteHtml(bd) {
  if (!bd || !bd.message) return "";
  return `<p class="${bd.ok ? "hint" : "err"}">${escapeHtml(bd.message)}</p>`;
}

function viewHtml(d, note) {
  return `
    <h3 class="profileBlockTitle">Moje dane</h3>
    <div class="mentorRow"><span class="mentorRole">Imię</span><span class="mentorName">${escapeHtml(d.firstName || "—")}</span></div>
    <div class="mentorRow"><span class="mentorRole">Nazwisko</span><span class="mentorName">${escapeHtml(d.lastName || "—")}</span></div>
    <div class="mentorRow"><span class="mentorRole">Telefon</span><span class="mentorName">${escapeHtml(d.phone || "—")}</span></div>
    <div class="mentorRow"><span class="mentorRole">Data urodzenia</span><span class="mentorName">${escapeHtml(fmtDate(d.dateOfBirth))}</span></div>
    ${birthNoteHtml(d.birthDate)}
    ${note ? `<p class="hint">${escapeHtml(note)}</p>` : ""}
    <div class="actions"><button type="button" class="ghost" data-pd-edit>Edytuj dane</button></div>`;
}

function formHtml(d, fixDob) {
  return `
    <h3 class="profileBlockTitle">Moje dane</h3>
    <label for="pdFirstName">Imię</label>
    <input id="pdFirstName" autocomplete="given-name" maxlength="60" value="${escapeAttr(d.firstName)}" />
    <label for="pdLastName">Nazwisko</label>
    <input id="pdLastName" autocomplete="family-name" maxlength="60" value="${escapeAttr(d.lastName)}" />
    <label for="pdPhone">Telefon</label>
    <input id="pdPhone" autocomplete="tel" inputmode="tel" maxlength="30" value="${escapeAttr(d.phone)}" />
    <label for="pdDob">Data urodzenia</label>
    <input id="pdDob" type="date" autocomplete="bday" value="${escapeAttr(d.dateOfBirth)}" />
    <div id="pdDobMsg">${fixDob && d.birthDate && !d.birthDate.ok ? birthNoteHtml(d.birthDate) : ""}</div>
    <p class="muted">Zmiany trafią też do arkusza członków klubu.</p>
    <p class="err hidden" id="pdErr"></p>
    <div class="actions">
      <button type="button" class="ghost ghostCancel" data-pd-cancel>Anuluj</button>
      <button type="button" class="primary" data-pd-save>Zapisz</button>
    </div>`;
}

/** Montuje blok w kontenerze profilu; onSaved(data) — np. odświeżenie imienia w nagłówku. */
export function renderProfileDataBox(el, ctx, onSaved) {
  if (!el) return;
  let data = { firstName: "", lastName: "", phone: "", dateOfBirth: "", birthDate: null };

  const showErr = (msg) => {
    const e = el.querySelector("#pdErr");
    if (!e) return;
    e.textContent = msg || "";
    e.classList.toggle("hidden", !msg);
  };

  // Data urodzenia — komunikat od razu po wpisaniu.
  el.addEventListener("change", (ev) => {
    if (ev.target?.id !== "pdDob") return;
    const box = el.querySelector("#pdDobMsg");
    if (box) box.innerHTML = ev.target.value ? birthNoteHtml(checkBirthDateClient(ev.target.value, ctx?.ageLimits)) : "";
  });

  el.addEventListener("click", async (ev) => {
    if (ev.target.closest("[data-pd-edit]")) {
      el.innerHTML = formHtml(data);
      el.querySelector("#pdFirstName")?.focus();
      return;
    }
    if (ev.target.closest("[data-pd-cancel]")) {
      el.innerHTML = viewHtml(data);
      return;
    }
    const saveBtn = ev.target.closest("[data-pd-save]");
    if (!saveBtn) return;
    const firstName = el.querySelector("#pdFirstName").value.trim();
    const lastName = el.querySelector("#pdLastName").value.trim();
    const phone = el.querySelector("#pdPhone").value.trim();
    const dateOfBirth = el.querySelector("#pdDob").value.trim();
    if (!firstName || !lastName || !phone || !dateOfBirth) return showErr("Uzupełnij imię, nazwisko, telefon i datę urodzenia.");
    const bd = checkBirthDateClient(dateOfBirth, ctx?.ageLimits);
    if (!bd.ok) {
      el.querySelector("#pdDobMsg").innerHTML = birthNoteHtml(bd);
      el.querySelector("#pdDob").focus();
      return showErr("Popraw datę urodzenia.");
    }
    const digits = phoneDigits(phone);
    if (digits < 8 || digits > 15) return showErr("Telefon ma nieprawidłowy format (8–15 cyfr).");
    saveBtn.disabled = true;
    saveBtn.textContent = "Zapisuję...";
    showErr("");
    try {
      const r = await apiPostJson({ url: URL_PROFILE_DATA, idToken: ctx.idToken, body: { firstName, lastName, phone, dateOfBirth } });
      data = { firstName: r.firstName, lastName: r.lastName, phone: r.phone, dateOfBirth: r.dateOfBirth, birthDate: r.birthDate };
      const note = !r.changed ? "" :
        r.sheet === "queued" ? "Zapisano. Arkusz członków zaktualizuje się w ciągu kilku sekund." : "Zapisano.";
      el.innerHTML = viewHtml(data, note);
      if (r.changed && typeof onSaved === "function") onSaved(data);
    } catch (e) {
      showErr(mapUserFacingApiError(e, "Nie udało się zapisać danych."));
      saveBtn.disabled = false;
      saveBtn.textContent = "Zapisz";
    }
  });

  apiGetJson({ url: URL_PROFILE_DATA, idToken: ctx.idToken })
    .then((d) => {
      data = { firstName: d.firstName || "", lastName: d.lastName || "", phone: d.phone || "",
        dateOfBirth: d.dateOfBirth || "", birthDate: d.birthDate || null };
      let fix = false;
      try { fix = sessionStorage.getItem(FIX_DOB_KEY) === "1"; sessionStorage.removeItem(FIX_DOB_KEY); } catch { /* ignore */ }
      if (fix || (data.birthDate && !data.birthDate.ok)) {
        el.innerHTML = formHtml(data, true);
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.querySelector("#pdDob")?.focus();
      } else {
        el.innerHTML = viewHtml(data);
      }
    })
    .catch((e) => {
      el.innerHTML = `<h3 class="profileBlockTitle">Moje dane</h3><p class="err">${escapeHtml(mapUserFacingApiError(e, "Nie udało się wczytać danych."))}</p>`;
    });
}
