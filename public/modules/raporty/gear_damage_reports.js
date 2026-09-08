// public/modules/raporty/gear_damage_reports.js
// Raport „Zgłoszenia uszkodzeń" — otwarte zgłoszenia (member/kandydat/kr/zarząd →
// gear_damage_reports), posortowane wg wagi (trup najpierw). Czysto informacyjne —
// NIE wpływa na dostępność sprzętu (jedynym źródłem prawdy o sprawności jest arkusz
// + sync). "Oznacz jako naprawione" tylko zdejmuje zgłoszenie z tej listy.
import { apiGetJson, apiPostJson } from "/core/api_client.js";
import { mapUserFacingApiError } from "/core/user_error_messages.js";

const REPORT_URL = "/api/admin/reports/gear-damage";
const RESOLVE_URL = "/api/admin/gear-damage/resolve";

function escapeHtml(s) {
  return String(s == null ? "" : s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatDatePL(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "—";
}

function severityBadgeHtml(severity) {
  if (severity === "dead") return `<span class="badge danger">Trup</span>`;
  if (severity === "repair") return `<span class="badge danger">To się wyklepie</span>`;
  return `<span class="badge soft">Da się używać</span>`;
}

export const gearDamageReportsReport = {
  id: "gear-damage-reports",
  category: "Sprzęt",
  label: "Zgłoszenia uszkodzeń",
  description: "",

  render({ container, ctx }) {
    container.innerHTML = `<div id="gdrContent"><p class="hint">Ładuję...</p></div>`;
    const content = container.querySelector("#gdrContent");

    const load = async () => {
      content.innerHTML = `<p class="hint">Ładuję...</p>`;
      try {
        const data = await apiGetJson({ url: REPORT_URL, idToken: ctx.idToken });
        renderItems(Array.isArray(data?.items) ? data.items : []);
      } catch (e) {
        content.innerHTML = `<p class="err">${escapeHtml(mapUserFacingApiError(e, "Nie udało się pobrać raportu."))}</p>`;
      }
    };

    const renderItems = (items) => {
      if (!items.length) {
        content.innerHTML = `<p class="hint">Brak zgłoszeń.</p>`;
        return;
      }
      content.innerHTML = items.map((item) => {
        const dateStr = item.createdAt ? formatDatePL(item.createdAt.slice(0, 10)) : "—";
        const photosHtml = (item.photoUrls || []).length
          ? `<div style="display:flex;gap:6px;margin-top:6px;">${item.photoUrls.map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="Zdjęcie zgłoszenia" style="width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid var(--border);display:block;" /></a>`).join("")}</div>`
          : "";
        return `
          <div class="gearCard" style="margin-bottom:8px;">
            <div class="approvalCard">
              <div class="approvalCardMain">
                <div class="approvalCardTitle">${escapeHtml(item.itemLabel || "—")} (nr ${escapeHtml(item.itemNumber || "—")}) — ${severityBadgeHtml(item.severity)}</div>
                <div class="approvalCardSubtitle">${escapeHtml(item.description || "—")} · zgłosił: ${escapeHtml(item.reporterName || "—")} · ${escapeHtml(dateStr)}</div>
                ${photosHtml}
              </div>
              <div class="approvalCardActions">
                <button type="button" class="approveBtn" data-resolve-damage="${escapeHtml(item.id)}">Oznacz jako naprawione</button>
              </div>
            </div>
          </div>
        `;
      }).join("");
    };

    content.addEventListener("click", async (ev) => {
      const btn = ev.target.closest?.("[data-resolve-damage]");
      if (!btn) return;
      const reportId = btn.getAttribute("data-resolve-damage");
      if (!reportId) return;
      const card = btn.closest(".gearCard");
      card?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try {
        await apiPostJson({ url: RESOLVE_URL, idToken: ctx.idToken, body: { reportId } });
        await load();
      } catch (e) {
        content.insertAdjacentHTML("afterbegin", `<p class="err">${escapeHtml(mapUserFacingApiError(e, "Nie udało się oznaczyć zgłoszenia jako naprawione."))}</p>`);
        card?.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      }
    });

    load();
  },
};
