// public/modules/dues_box.js
// Profil → blok „Składki” / „Wpisowe”: stan opłat, zaległość, zgłoszenie wpłaty z danymi
// przelewu, anulowanie niepotwierdzonego zgłoszenia. Datę wpisuje do arkusza skarbnik
// (potwierdzenie w panelu Zarządu) — aplikacja niczego nie zapisuje sama u siebie.
import { apiGetJson, apiPostJson } from "/core/api_client.js";
import { mapUserFacingApiError } from "/core/user_error_messages.js";
import { escapeHtml, escapeAttr } from "/core/html_utils.js";

const URL_DUES = "/api/dues";

function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "—";
}

function pln(n) {
  return `${Number(n || 0).toLocaleString("pl-PL")} zł`;
}

export function semestersLabel(n) {
  if (n === 1) return "1 semestr";
  return `${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "semestry" : "semestrów"}`;
}

function statusLine(st) {
  if (st.blocked) return `<p class="duesState duesBad">Zaległość: ${semestersLabel(st.overdue)}</p>`;
  if (st.overdue === null) return `<p class="duesState duesBad">${st.kind === "wpisowe" ? "Wpisowe nieopłacone" : "Brak opłaconych składek"}</p>`;
  if (st.overdue > 0) return `<p class="duesState duesBad">Opłacone do ${fmtDate(st.paidUntil)} — zaległość: ${semestersLabel(st.overdue)}</p>`;
  return `<p class="duesState duesOk">Opłacone do ${fmtDate(st.paidUntil)}</p>`;
}

function transferHtml(st, order) {
  return `
    <div class="duesTransfer">
      <div><span class="muted">Kwota:</span> <strong>${pln(order.amountPln)}</strong></div>
      ${st.clubAccount ? `<div><span class="muted">Konto${st.clubBank ? ` (${escapeHtml(st.clubBank)})` : ""}:</span> <strong>${escapeHtml(st.clubAccount)}</strong>
        <button type="button" class="ghost duesCopy" data-dues-copy="${escapeAttr(st.clubAccount.replace(/\s+/g, ""))}">Kopiuj numer</button></div>` : ""}
      <div><span class="muted">Tytuł przelewu:</span> <strong>${escapeHtml(order.transferTitle)}</strong>
        <button type="button" class="ghost duesCopy" data-dues-copy="${escapeAttr(order.transferTitle)}">Kopiuj tytuł</button></div>
    </div>`;
}

function render(el, data) {
  const st = data.status;
  const order = data.order;
  const title = st.kind === "wpisowe" ? "Wpisowe" : "Składki";
  // Przy otwartym zgłoszeniu nie pokazujemy obecnej zaległości (wyglądało, jakby wpłata nic nie dała) —
  // tylko datę, do której składki będą opłacone po zaksięgowaniu tej wpłaty.
  let html = `<h3 class="profileBlockTitle">${title}</h3>${order ? "" : statusLine(st)}`;

  if (order) {
    const waiting = order.status === "pending" ?
      "Zgłoszona wpłata czeka na potwierdzenie skarbnika." :
      "Skarbnik potwierdził wpłatę — trwa wpisywanie do arkusza członków.";
    if (order.paidUntilAfter) html += `<p class="duesState duesOk">Po zaksięgowaniu tej wpłaty: opłacone do ${fmtDate(order.paidUntilAfter)}</p>`;
    html += `<p class="hint">${waiting} Dane do przelewu wysłaliśmy też mailem.</p>${transferHtml(st, order)}`;
    if (order.status === "pending") {
      html += `<div class="actions"><button type="button" class="ghost" data-dues-cancel="${escapeAttr(order.id)}">Anuluj zgłoszenie</button></div>`;
    }
  } else if (!st.canOrder) {
    if (st.reason) html += `<p class="${st.blocked ? "err" : "hint"}">${escapeHtml(st.reason)}</p>`;
  } else if (st.kind === "wpisowe") {
    const p = data.previews[0];
    html += `
      <p class="muted">Wpisowe kandydata = 2 składki semestralne (${pln(p.amountPln)}). Po zaksięgowaniu opłacone do ${fmtDate(p.paidUntil)}.</p>
      <div class="actions"><button type="button" class="primary" data-dues-order="2">Zgłoś wpłatę wpisowego</button></div>`;
  } else {
    const suggested = Math.max(1, st.overdue || 1);
    html += `
      <div class="duesForm">
        <label for="duesSemesters">Płacę za</label>
        <select id="duesSemesters">
          ${data.previews.map((p) => `<option value="${p.semesters}"${p.semesters === suggested ? " selected" : ""}>${semestersLabel(p.semesters)} — ${pln(p.amountPln)}</option>`).join("")}
        </select>
        <button type="button" class="primary" data-dues-order="">Zgłoś wpłatę</button>
      </div>
      <p class="muted" id="duesPreview"></p>
      ${st.overdue ? `<p class="hint">Wpłata najpierw pokrywa zaległe semestry.</p>` : ""}`;
  }
  html += `<p class="err hidden" id="duesErr"></p>`;
  el.innerHTML = html;

  const select = el.querySelector("#duesSemesters");
  const preview = el.querySelector("#duesPreview");
  const updatePreview = () => {
    if (!select || !preview) return;
    const p = data.previews.find((x) => String(x.semesters) === select.value);
    preview.textContent = p ? `Po zaksięgowaniu: opłacone do ${fmtDate(p.paidUntil)}` : "";
  };
  select?.addEventListener("change", updatePreview);
  updatePreview();
}

/** Montuje blok w kontenerze profilu. */
export function renderDuesBox(el, ctx) {
  if (!el) return;
  const setErr = (msg) => {
    const e = el.querySelector("#duesErr");
    if (!e) return;
    e.textContent = msg || "";
    e.classList.toggle("hidden", !msg);
  };

  const load = async () => {
    try {
      const data = await apiGetJson({ url: URL_DUES, idToken: ctx.idToken });
      if (!data?.status?.applicable) {
        el.classList.add("hidden");
        return;
      }
      render(el, data);
    } catch (e) {
      el.innerHTML = `<h3 class="profileBlockTitle">Składki</h3><p class="err">${escapeHtml(mapUserFacingApiError(e, "Nie udało się wczytać składek."))}</p>`;
    }
  };

  el.addEventListener("click", async (ev) => {
    const copy = ev.target.closest("[data-dues-copy]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.getAttribute("data-dues-copy") || "");
        const old = copy.textContent;
        copy.textContent = "Skopiowano";
        setTimeout(() => { copy.textContent = old; }, 1500);
      } catch { /* brak schowka — dane są też w mailu */ }
      return;
    }
    const orderBtn = ev.target.closest("[data-dues-order]");
    const cancelBtn = ev.target.closest("[data-dues-cancel]");
    const btn = orderBtn || cancelBtn;
    if (!btn) return;
    btn.disabled = true;
    setErr("");
    try {
      if (orderBtn) {
        const semesters = Number(orderBtn.getAttribute("data-dues-order") || el.querySelector("#duesSemesters")?.value || 1);
        await apiPostJson({ url: URL_DUES, idToken: ctx.idToken, body: { action: "create", semesters } });
      } else {
        await apiPostJson({ url: URL_DUES, idToken: ctx.idToken, body: { action: "cancel", orderId: cancelBtn.getAttribute("data-dues-cancel") } });
      }
      await load();
    } catch (e) {
      setErr(mapUserFacingApiError(e, "Nie udało się."));
      btn.disabled = false;
    }
  });

  load();
}
