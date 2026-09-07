import {ServiceTask} from "../types";
import {getAppVars} from "../../modules/setup/app_vars";

/**
 * Task: gear.notifyDamageReport
 *
 * Wysyła e-mail na adres zarządu (setup/vars_members.admin_notify_email,
 * domyślnie zarzad@morzkulc.pl) zaraz po zgłoszeniu uszkodzenia sprzętu —
 * feedback użytkownika 07.09.2026: stan sprzętu idzie syncem z arkusza, więc
 * zgłoszenie NIE MOŻE po cichu blokować sztuki bez aktywnego powiadomienia
 * zarządu (panel Administracja i tak już to pokazuje, ale to za mało).
 * Czyta już zapisany dokument gear_damage_reports, payload niesie tylko jego id.
 */

type Payload = {
  reportId: string;
};

function norm(v: any): string {
  return String(v == null ? "" : v).trim();
}

function escapeHtml(v: any): string {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CATEGORY_NOUN: Record<string, string> = {
  kayaks: "Kajak",
  paddles: "Wiosło",
  lifejackets: "Kamizelka",
  helmets: "Kask",
  throwbags: "Rzutka",
  sprayskirts: "Fartuch",
};

const SEVERITY_LABEL: Record<string, string> = {
  usable: "👍 Da się używać",
  repair: "👎 To się wyklepie",
  dead: "💀 Trup",
};

export const gearNotifyDamageReportTask: ServiceTask<Payload> = {
  id: "gear.notifyDamageReport",
  description: "Wysyła e-mail do zarządu o nowym zgłoszeniu uszkodzenia sprzętu.",

  validate: (payload) => {
    if (!payload?.reportId) throw new Error("Missing reportId");
  },

  run: async (payload, ctx) => {
    const reportSnap = await ctx.firestore.collection("gear_damage_reports").doc(payload.reportId).get();
    if (!reportSnap.exists) {
      return {ok: false, message: `Damage report ${payload.reportId} not found`};
    }
    const r = reportSnap.data() as any;

    const appVars = await getAppVars(ctx.firestore);
    const boardEmail = norm(appVars.adminNotifyEmail).toLowerCase();
    if (!boardEmail || !boardEmail.includes("@")) {
      return {ok: false, message: "Missing/invalid admin_notify_email"};
    }

    const category = norm(r?.category).toLowerCase();
    const noun = CATEGORY_NOUN[category] || "Sprzęt";
    const itemLabel = norm(r?.itemLabel);
    const itemNumber = norm(r?.itemNumber);
    const itemDesc = [noun, itemNumber].filter(Boolean).join(" ") + (itemLabel ? ` (${itemLabel})` : "");

    const severityKey = norm(r?.severity);
    const severityLabel = SEVERITY_LABEL[severityKey] || severityKey || "—";

    const photoUrls: string[] = Array.isArray(r?.photoUrls) ? r.photoUrls.filter((u: any) => norm(u)) : [];

    const subject = `SKK Morzkulc — zgłoszenie uszkodzenia: ${itemDesc}`;
    const bodyLines = [
      "Nowe zgłoszenie uszkodzenia sprzętu.",
      "",
      `Sprzęt: ${itemDesc}`,
      `Ocena: ${severityLabel}`,
      `Opis: ${norm(r?.description) || "(brak)"}`,
      `Zgłosił: ${norm(r?.reporterName) || "—"} (${norm(r?.reporterEmail) || "—"})`,
    ];
    if (photoUrls.length) {
      bodyLines.push("Zdjęcia:");
      for (const url of photoUrls) bodyLines.push(url);
    }
    bodyLines.push("");
    bodyLines.push("Panel Zarządu — Administracja:");
    bodyLines.push(appVars.appUrl);
    bodyLines.push("");
    bodyLines.push("— Automatyczne powiadomienie SKK Morzkulc");
    const bodyText = bodyLines.join("\n");

    // Zdjęcia osadzone w treści maila (feedback użytkownika 07.09.2026) — zwykłe
    // <img src="..."> na publiczne linki Storage (download-token, ten sam mechanizm
    // co miniatury w panelu Zarządu), nie base64/cid. Wymaga multipart/alternative
    // (sendGenericEmailHtml) — część text/plain zostaje jako fallback + adresy URL.
    const photoTags = photoUrls.map((url) =>
      `<a href="${escapeHtml(url)}"><img src="${escapeHtml(url)}" alt="Zdjęcie zgłoszenia" style="max-width:280px;max-height:280px;object-fit:cover;border-radius:8px;margin:0 8px 8px 0;border:1px solid #ccc;"></a>`
    ).join("");
    const photosHtml = photoUrls.length ?
      `<p><strong>Zdjęcia:</strong></p><div>${photoTags}</div>` :
      "";
    const bodyHtml = [
      "<div style=\"font-family:sans-serif;font-size:14px;color:#111;\">",
      "<p>Nowe zgłoszenie uszkodzenia sprzętu.</p>",
      `<p><strong>Sprzęt:</strong> ${escapeHtml(itemDesc)}<br>`,
      `<strong>Ocena:</strong> ${escapeHtml(severityLabel)}<br>`,
      `<strong>Opis:</strong> ${escapeHtml(norm(r?.description) || "(brak)")}<br>`,
      `<strong>Zgłosił:</strong> ${escapeHtml(norm(r?.reporterName) || "—")} (${escapeHtml(norm(r?.reporterEmail) || "—")})</p>`,
      photosHtml,
      `<p><a href="${escapeHtml(appVars.appUrl)}">Panel Zarządu — Administracja</a></p>`,
      "<p style=\"color:#888;\">— Automatyczne powiadomienie SKK Morzkulc</p>",
      "</div>",
    ].join("");

    if (ctx.dryRun) {
      ctx.logger.info("gearNotifyDamageReport: [DRY RUN] would send", {to: boardEmail, subject, photos: photoUrls.length});
      return {ok: true, message: `[DRY RUN] would notify ${boardEmail}`, details: {sent: false, dryRun: true, subject, photos: photoUrls.length}};
    }

    await ctx.workspace.sendGenericEmailHtml(boardEmail, subject, bodyText, bodyHtml);
    ctx.logger.info("gearNotifyDamageReport: sent", {reportId: payload.reportId, to: boardEmail, photos: photoUrls.length});

    return {ok: true, message: `sent to ${boardEmail}`, details: {sent: true, to: boardEmail, photos: photoUrls.length}};
  },
};
