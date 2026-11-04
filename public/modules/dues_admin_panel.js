// public/modules/dues_admin_panel.js
// Panel Zarządu → zakładka „Składki”: widzi cały Zarząd i KR, obsługuje tylko skarbnik.
// Zgłoszenia wpłat (potwierdź → data trafia do arkusza członków, potem do aplikacji;
// odrzuć z powodem), ostatnie decyzje ze stanem zapisu do arkusza, zaległości z przypomnieniami
// (pojedynczo i zbiorczo) i — pod kreską — zaległości powyżej limitu, do decyzji Zarządu.
import { apiGetJson, apiPostJson } from "/core/api_client.js";
import { mapUserFacingApiError } from "/core/user_error_messages.js";
import { escapeHtml, escapeAttr } from "/core/html_utils.js";
import { semestersLabel } from "/modules/dues_box.js";

const URL_ADMIN = "/api/admin/dues";

function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "—";
}

function pln(n) {
  return `${Number(n || 0).toLocaleString("pl-PL")} zł`;
}

// „Ksywa (Imię Nazwisko)”; bez ksywy — samo imię i nazwisko.
function personLabel(r) {
  const nick = String(r.userNick || "").trim();
  const name = String(r.userName || "").trim();
  if (nick && name && nick !== name) return `${nick} (${name})`;
  return nick || name;
}

function what(o) {
  if (o.kind === "odwieszenie") return `Odwieszenie — ${semestersLabel(o.semesters)}`;
  return o.kind === "wpisowe" ? "Wpisowe (2 semestry)" : `Składka — ${semestersLabel(o.semesters)}`;
}

const WB_LABEL = {
  pending: "zapis do arkusza w toku",
  done: "wpisane do arkusza",
  conflict: "KONFLIKT — sprawdź arkusz",
};

function pendingTable(rows, canAct) {
  if (!rows.length) return `<p class="muted">Brak zgłoszeń czekających na potwierdzenie.</p>`;
  return `<div class="tableWrapper"><table class="reportTable"><thead><tr>
    <th>Osoba</th><th>Za</th><th>Kwota</th><th>Tytuł przelewu</th><th>Zgłoszono</th><th>Po potwierdzeniu</th>${canAct ? "<th></th>" : ""}
  </tr></thead><tbody>
  ${rows.map((o) => `<tr>
    <td>${escapeHtml(o.userName)} <span class="muted">ID ${escapeHtml(String(o.memberId))}</span></td>
    <td>${escapeHtml(what(o))}</td>
    <td>${pln(o.amountPln)}</td>
    <td>${escapeHtml(o.transferTitle)}</td>
    <td>${fmtDate(o.createdAt)}</td>
    <td>opłacone do ${fmtDate(o.previewPaidUntil)}</td>
    ${canAct ? `<td class="duesActions">
      <button type="button" class="primary" data-dues-approve="${escapeAttr(o.id)}">Potwierdź wpłatę</button>
      <button type="button" class="ghost" data-dues-reject="${escapeAttr(o.id)}">Odrzuć</button>
    </td>` : ""}
  </tr>`).join("")}
  </tbody></table></div>`;
}

function recentTable(rows) {
  if (!rows.length) return "";
  return `<h4>Ostatnie decyzje</h4><div class="tableWrapper"><table class="reportTable"><thead><tr>
    <th>Osoba</th><th>Za</th><th>Kwota</th><th>Decyzja</th><th>Arkusz</th>
  </tr></thead><tbody>
  ${rows.map((o) => `<tr>
    <td>${escapeHtml(o.userName)} <span class="muted">ID ${escapeHtml(String(o.memberId))}</span></td>
    <td>${escapeHtml(what(o))}</td>
    <td>${pln(o.amountPln)}</td>
    <td>${o.status === "approved" ? `potwierdzona ${fmtDate(o.decidedAt)}` : `odrzucona ${fmtDate(o.decidedAt)}: ${escapeHtml(o.rejectReason)}`}</td>
    <td>${o.status === "approved" && o.writeBack ? `<span class="${o.writeBack.status === "conflict" ? "duesBad" : o.writeBack.status === "done" ? "duesOk" : ""}">${escapeHtml(WB_LABEL[o.writeBack.status] || o.writeBack.status)}</span>
      ${o.writeBack.status === "done" ? ` → ${fmtDate(o.writeBack.to)}` : ""}
      ${o.writeBack.message ? `<div class="hint">${escapeHtml(o.writeBack.message)}</div>` : ""}` : "—"}</td>
  </tr>`).join("")}
  </tbody></table></div>`;
}

function overdueTable(rows, canAct, idPrefix) {
  if (!rows.length) return `<p class="muted">Brak.</p>`;
  return `<div class="tableWrapper"><table class="reportTable"><thead><tr>
    ${canAct ? `<th><input type="checkbox" data-dues-all="${idPrefix}" aria-label="Zaznacz wszystkich" /></th>` : ""}
    <th>Osoba</th><th>Zaległość</th><th>Opłacone do</th><th>Przypomnienie</th>${canAct ? "<th></th>" : ""}
  </tr></thead><tbody>
  ${rows.map((r) => `<tr>
    ${canAct ? `<td><input type="checkbox" data-dues-pick="${idPrefix}" value="${escapeAttr(r.uid)}" /></td>` : ""}
    <td>${escapeHtml(personLabel(r))}${r.kind === "wpisowe" ? ` <span class="muted">(kandydat — płaci wpisowe)</span>` : ""}</td>
    <td><strong>${r.overdue === null ? "brak wpłat" : semestersLabel(r.overdue)}</strong></td>
    <td class="muted">${r.paidUntil ? fmtDate(r.paidUntil) : "—"}</td>
    <td class="muted">${r.reminderSentAt ? `wysłane ${fmtDate(r.reminderSentAt)}` : "—"}</td>
    ${canAct ? `<td><button type="button" class="ghost" data-dues-remind="${escapeAttr(r.uid)}">Wyślij przypomnienie</button></td>` : ""}
  </tr>`).join("")}
  </tbody></table></div>
  ${canAct ? `<div class="actions"><button type="button" class="ghost" data-dues-remind-picked="${idPrefix}">Wyślij przypomnienie zaznaczonym</button></div>` : ""}`;
}

function render(container, d) {
  const canAct = d.isTreasurer;
  container.innerHTML = `
    ${canAct ? "" : `<p class="hint">Podgląd — zgłoszenia potwierdza i przypomnienia wysyła skarbnik.</p>`}
    <p class="err hidden" id="duesAdminErr"></p>
    <p class="hint hidden" id="duesAdminMsg"></p>
    <h4>Zgłoszenia do potwierdzenia (${d.pending.length})</h4>
    <p class="muted">Potwierdzenie od razu wpisuje nową datę do kolumny „Składki” w arkuszu członków (wpisowe także miesiąc wpłaty w „Wpisowe (mm.yyyy)”), potem do aplikacji i wysyła mail do osoby.</p>
    ${pendingTable(d.pending, canAct)}
    ${recentTable(d.recent)}
    <h4>Zaległości (${d.overdue.length})</h4>
    <p class="muted">Aktywni członkowie, Zarząd, KR i kandydaci. Składka ${pln(d.feePln)} za semestr; wpisowe = 2 składki.</p>
    ${overdueTable(d.overdue, canAct, "main")}
    <hr class="duesSeparator" />
    <h4>Zaległość powyżej ${d.maxOverdue} semestrów — do decyzji Zarządu (${d.overdueBlocked.length})</h4>
    <p class="muted">Te osoby nie mogą same zgłosić wpłaty — w profilu widzą prośbę o kontakt z Zarządem.</p>
    ${overdueTable(d.overdueBlocked, canAct, "blocked")}
  `;
}

/** Zbiorczy stan składek — pasek na górze panelu Zarządu. */
export function duesSummaryHtml(s, feePln) {
  if (!s) return "";
  const parts = [
    `<span>Opłacone składki: <strong>${s.paid} z ${s.total}</strong></span>`,
    `<span>Zaległości: <strong>${pln(s.overduePln)}</strong> <span class="muted">(${semestersLabel(s.overdueSemesters)} × ${pln(feePln)}, ${s.withOverdue} os.)</span></span>`,
  ];
  if (s.neverPaid) parts.push(`<span>Bez żadnej wpłaty: <strong>${s.neverPaid} os.</strong></span>`);
  return parts.join("");
}

export function renderDuesAdminPanel({ container, ctx, onSummary }) {
  if (!container) return;
  const show = (id, msg) => {
    const el = container.querySelector(id);
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
  };

  const load = async () => {
    try {
      const d = await apiGetJson({ url: URL_ADMIN, idToken: ctx.idToken });
      render(container, d);
      onSummary?.(d);
    } catch (e) {
      container.innerHTML = `<p class="err">${escapeHtml(mapUserFacingApiError(e, "Nie udało się wczytać składek."))}</p>`;
    }
  };

  const post = async (btn, body, okMsg) => {
    btn.disabled = true;
    show("#duesAdminErr", "");
    try {
      const r = await apiPostJson({ url: URL_ADMIN, idToken: ctx.idToken, body });
      await load();
      show("#duesAdminMsg", typeof okMsg === "function" ? okMsg(r) : okMsg);
    } catch (e) {
      show("#duesAdminErr", mapUserFacingApiError(e, "Nie udało się."));
      btn.disabled = false;
    }
  };

  container.addEventListener("change", (ev) => {
    const all = ev.target.closest("[data-dues-all]");
    if (!all) return;
    container.querySelectorAll(`[data-dues-pick="${all.getAttribute("data-dues-all")}"]`).forEach((c) => { c.checked = all.checked; });
  });

  container.addEventListener("click", (ev) => {
    const approve = ev.target.closest("[data-dues-approve]");
    if (approve) {
      post(approve, { action: "approve", orderId: approve.getAttribute("data-dues-approve") },
        (r) => `Wpłata potwierdzona — opłacone do ${fmtDate(r.to)}. Zapis do arkusza trwa kilka sekund.`);
      return;
    }
    const reject = ev.target.closest("[data-dues-reject]");
    if (reject) {
      const reason = window.prompt("Powód odrzucenia (trafi w mailu do osoby):");
      if (reason == null) return;
      post(reject, { action: "reject", orderId: reject.getAttribute("data-dues-reject"), reason }, "Zgłoszenie odrzucone — wysłano mail.");
      return;
    }
    const one = ev.target.closest("[data-dues-remind]");
    if (one) {
      post(one, { action: "remind", uids: [one.getAttribute("data-dues-remind")] }, "Przypomnienie wysłane.");
      return;
    }
    const picked = ev.target.closest("[data-dues-remind-picked]");
    if (picked) {
      const group = picked.getAttribute("data-dues-remind-picked");
      const uids = Array.from(container.querySelectorAll(`[data-dues-pick="${group}"]:checked`)).map((c) => c.value);
      if (!uids.length) {
        show("#duesAdminErr", "Zaznacz osoby do przypomnienia.");
        return;
      }
      post(picked, { action: "remind", uids }, (r) => `Wysłano przypomnienia: ${r.queued}.`);
    }
  });

  load();
}
