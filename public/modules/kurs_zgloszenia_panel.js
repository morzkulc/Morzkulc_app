// public/modules/kurs_zgloszenia_panel.js
// Panel zarządu → zakładka „Kurs”: zgłoszenia z formularza kurs.morzkulc.pl/zapis.
// Akcje: zadatek wpłacony (kursant trafia do arkusza członków = dostęp do aplikacji),
// pełna wpłata, rezygnacja (sprzątanie arkusza / powrót do poprzedniej roli).
import { apiGetJson, apiPostJson } from "/core/api_client.js";
import { mapUserFacingApiError } from "/core/user_error_messages.js";
import { escapeHtml } from "/core/html_utils.js";

const LIST_URL = "/api/admin/kurs/zgloszenia";
const ACTION_URL = "/api/admin/kurs/zgloszenie";

const STATUS_LABEL = {
  nowe: "czeka na zadatek",
  zadatek: "zadatek wpłacony",
  oplacony: "opłacony",
  rezygnacja: "rezygnacja",
};

const ACTIONS = {
  nowe: [["zadatek", "Zadatek wpłacony"], ["oplacony", "Pełna wpłata"], ["rezygnacja", "Rezygnacja"]],
  zadatek: [["oplacony", "Pełna wpłata"], ["rezygnacja", "Rezygnacja"]],
  oplacony: [["rezygnacja", "Rezygnacja"]],
  rezygnacja: [],
};

const CONFIRM = {
  zadatek: "Potwierdzić wpłatę zadatku? Osoba zostanie dopisana do arkusza członków jako Kursant i dostanie mail z dostępem do aplikacji.",
  oplacony: "Potwierdzić pełną wpłatę za kurs?",
  rezygnacja: "Oznaczyć rezygnację? Jeśli osoba była już przeniesiona do aplikacji, zostanie z niej usunięta (albo wróci do poprzedniej roli, jeśli ma konto).",
};

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

function pln(n) {
  return n == null ? "—" : `${Number(n).toLocaleString("pl-PL")} zł`;
}

function yn(v) {
  return v ? "tak" : "nie";
}

function details(z) {
  const f = z.form || {};
  const row = (k, v) => (v === "" || v == null ? "" : `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`);
  return `<table class="reportTable kursDetails"><tbody>
    ${row("Telefon", f.telefon)}
    ${row("Data urodzenia", f.dataUrodzenia)}
    ${row("Miejscowość", f.miejscowosc)}
    ${row(f.brakPesel ? "Dokument (brak PESEL)" : "PESEL", f.brakPesel ? f.dokument : f.pesel)}
    ${row("ICE", `${f.iceImie || ""} ${f.iceTelefon || ""}`.trim())}
    ${row("Wzrost / waga", `${f.wzrost} cm / ${f.waga} kg`)}
    ${row("Doświadczenie", f.doswiadczenie)}
    ${row("Pływanie", f.plywanie)}
    ${row("Sporty", f.sporty)}
    ${row("Choroby przewlekłe", f.chorobyPrzewlekle ? `tak: ${f.chorobyOpis}` : "nie")}
    ${row("Leki", f.leki ? `tak: ${f.lekiOpis}` : "nie")}
    ${row("Schorzenia", (f.schorzenia || []).join(", "))}
    ${row("Student", f.student ? `tak (${f.uczelnia})` : "nie")}
    ${row("Dieta", f.dieta === "wege" ? `wege (awaryjny posiłek mięsny problemem: ${f.wegeMieso || "—"})` : "jem wszystko")}
    ${row("Dlaczego kurs", f.dlaczego)}
    ${row("Zainteresowania", (f.zainteresowania || []).join(", "))}
    ${row("Rok po kursie", f.rokPoKursie)}
    ${row("Pasje", f.pasje)}
    ${row("Dlaczego Ty", f.dlaczegoTy)}
    ${row("Skąd wie", f.skad)}
    ${row("Zgody RODO + statut", yn(f.zgodaRodo && f.zgodaStatut))}
    ${row("Zgoda na wizerunek", yn(f.zgodaWizerunek))}
    ${row("Tytuł przelewu", z.przelew?.tytul)}
    ${row("Do zapłaty", pln(z.przelew?.cena))}
    ${row("Numer członka", z.memberId)}
  </tbody></table>`;
}

export function renderKursZgloszeniaPanel({ container, ctx }) {
  container.innerHTML = `
    <div id="kursZglSummary" class="hint" style="margin:12px 0 8px;"></div>
    <div id="kursZglErr" class="err hidden"></div>
    <div id="kursZglContent"></div>
    <p class="hint" style="margin-top:12px;">Zgłoszenia z formularza kurs.morzkulc.pl/zapis (edycja z Vars_KURS). Kolejność listy: najpierw wpłacone zadatki wg daty wpłaty, potem pozostałe wg daty zgłoszenia; limit miejsc = kurs_limit_miejsc.</p>
  `;
  const summaryEl = container.querySelector("#kursZglSummary");
  const errEl = container.querySelector("#kursZglErr");
  const content = container.querySelector("#kursZglContent");

  const setErr = (msg) => {
    errEl.textContent = msg || "";
    errEl.classList.toggle("hidden", !msg);
  };

  async function load() {
    setErr("");
    content.innerHTML = `<p class="hint">Wczytywanie…</p>`;
    try {
      const data = await apiGetJson({ url: LIST_URL, idToken: ctx.idToken });
      const items = Array.isArray(data.items) ? data.items : [];
      const limit = data.limit ? ` / ${data.limit}` : "";
      summaryEl.textContent = `Kurs ${data.edycja || "—"} · zgłoszeń: ${items.length} · miejsca zajęte (zadatek): ${data.zajete ?? 0}${limit}`;
      if (!items.length) {
        content.innerHTML = `<p class="hint">Brak zgłoszeń.</p>`;
        return;
      }
      let html = `<div class="tableWrapper"><table class="reportTable"><thead><tr><th>#</th><th>Osoba</th><th>Zgłoszenie</th><th>Status</th><th></th></tr></thead><tbody>`;
      for (const z of items) {
        const f = z.form || {};
        const pos = z.pozycja ? `${z.pozycja}${z.lista === "rezerwowa" ? " <span class=\"duesBad\">rez.</span>" : ""}` : "—";
        const dates = [z.zadatekAt && `zadatek ${fmtDate(z.zadatekAt)}`, z.oplaconyAt && `opłata ${fmtDate(z.oplaconyAt)}`, z.rezygnacjaAt && `rezygnacja ${fmtDate(z.rezygnacjaAt)}`].filter(Boolean).join(" · ");
        const btns = (ACTIONS[z.status] || []).map(([a, l]) => `<button type="button" data-kurs-action="${a}" data-id="${escapeHtml(z.id)}">${escapeHtml(l)}</button>`).join(" ");
        html += `<tr>
          <td>${pos}</td>
          <td><div class="reportPerson">${escapeHtml(`${f.imie || ""} ${f.nazwisko || ""}`)}</div><div class="reportEmail">${escapeHtml(z.email)}${f.student ? " · student" : ""}${z.demo ? " · <strong>DEMO</strong>" : ""}</div></td>
          <td class="reportTerm">${escapeHtml(fmtDate(z.createdAt))}</td>
          <td><div>${escapeHtml(STATUS_LABEL[z.status] || z.status)}</div><div class="reportEmail">${escapeHtml(dates)}</div></td>
          <td style="white-space:nowrap">${btns} <button type="button" data-kurs-details="${escapeHtml(z.id)}">Szczegóły</button></td>
        </tr>
        <tr class="hidden" data-kurs-details-row="${escapeHtml(z.id)}"><td colspan="5">${details(z)}</td></tr>`;
      }
      html += `</tbody></table></div>`;
      content.innerHTML = html;
    } catch (e) {
      content.innerHTML = "";
      setErr(mapUserFacingApiError(e, "Nie udało się wczytać zgłoszeń."));
    }
  }

  content.addEventListener("click", async (ev) => {
    const det = ev.target.closest("[data-kurs-details]");
    if (det) {
      const id = det.getAttribute("data-kurs-details");
      content.querySelector(`[data-kurs-details-row="${CSS.escape(id)}"]`)?.classList.toggle("hidden");
      return;
    }
    const btn = ev.target.closest("[data-kurs-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-kurs-action");
    if (!window.confirm(CONFIRM[action] || "Na pewno?")) return;
    btn.disabled = true;
    setErr("");
    try {
      await apiPostJson({ url: ACTION_URL, idToken: ctx.idToken, body: { id: btn.getAttribute("data-id"), action } });
      await load();
    } catch (e) {
      btn.disabled = false;
      setErr(mapUserFacingApiError(e, "Nie udało się zapisać."));
    }
  });

  load();
}
