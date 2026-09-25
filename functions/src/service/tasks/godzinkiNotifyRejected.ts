import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {normNullish} from "../../modules/shared/text_utils";

/**
 * Task: godzinki.notifyRejected
 *
 * Wysyła e-mail do osoby zgłaszającej godzinki po odrzuceniu zgłoszenia przez
 * zarząd/KR (panel Zarządu → „Odrzuć" z obowiązkowym powodem).
 *
 * Dlaczego mail jest jedynym kanałem: odrzucony wpis jest ukrywany w historii
 * członka (getGodzinkiHandler filtruje rejected==true) — zgłoszenie użytkownika
 * 23.09.2026. Bez tego maila członek zostałby bez wpisu i bez wyjaśnienia.
 *
 * Powód przychodzi w payloadzie, ale czytany jest też z rekordu (rejectedReason)
 * — payload jest tylko skrótem, źródłem prawdy pozostaje dokument.
 *
 * Idempotencja przy retry: znacznik rejectNotifiedAt na rekordzie.
 */

type Payload = {
  recordId: string;
  reason?: string;
};

function formatDatePL(v: any): string {
  const d = typeof v?.toDate === "function" ? v.toDate() : (v instanceof Date ? v : null);
  if (!d || isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function displayNameOf(u: any): string {
  const firstName = normNullish(u?.profile?.firstName);
  const lastName = normNullish(u?.profile?.lastName);
  const nickname = normNullish(u?.profile?.nickname);
  return [firstName, lastName].filter(Boolean).join(" ") || nickname;
}

export const godzinkiNotifyRejectedTask: ServiceTask<Payload> = {
  id: "godzinki.notifyRejected",
  description: "Wysyła e-mail do członka z powodem odrzucenia zgłoszonych godzinek.",

  validate: (payload) => {
    if (!payload?.recordId) throw new Error("Missing recordId");
  },

  run: async (payload, ctx) => {
    const ref = ctx.firestore.collection("godzinki_ledger").doc(payload.recordId);
    const snap = await ref.get();
    if (!snap.exists) {
      return {ok: false, message: `Record ${payload.recordId} not found`};
    }

    const rec = snap.data() as any;
    if (rec?.rejectNotifiedAt) {
      return {ok: true, message: "already notified"};
    }

    const uid = normNullish(rec?.uid);
    if (!uid) {
      return {ok: false, message: "Record has no uid"};
    }

    const uSnap = await ctx.firestore.collection("users_active").doc(uid).get();
    const u = uSnap.data() as any;
    const email = normNullish(u?.email).toLowerCase();
    if (!email || !email.includes("@")) {
      // Rekordy historyczne (uid typu hist_*) nie mają konta w aplikacji —
      // to nie jest błąd taska, nie ma komu wysłać.
      ctx.logger.info("godzinkiNotifyRejected: no recipient", {recordId: payload.recordId, uid});
      return {ok: true, message: "no recipient email"};
    }

    const reason = normNullish(rec?.rejectedReason) || normNullish(payload?.reason) || "(nie podano)";
    const hours = Number(rec?.amount || 0);
    const name = displayNameOf(u);

    const body = [
      name ? `Cześć ${name},` : "Cześć,",
      "",
      "Twoje zgłoszenie godzinek zostało odrzucone przez Zarząd.",
      "",
      `Liczba godzin: ${hours}`,
      `Data zgłoszenia: ${formatDatePL(rec?.grantedAt || rec?.createdAt)}`,
      `Twój opis: ${normNullish(rec?.reason) || "—"}`,
      "",
      `Powód odrzucenia: ${reason}`,
      "",
      "Zgłoszenie nie jest już widoczne na Twojej liście godzinek i nie wpływa na saldo.",
      "Jeśli uważasz, że to pomyłka — odezwij się do Zarządu: zarzad@morzkulc.pl",
      "",
      "SKK Morzkulc",
    ].join("\n");

    try {
      await ctx.workspace.sendGenericEmail(email, "Odrzucone zgłoszenie godzinek", body);
    } catch (e: any) {
      ctx.logger.error("godzinkiNotifyRejected: send failed", {
        recordId: payload.recordId,
        email,
        message: e?.message,
      });
      throw e; // retry przez jobProcessor
    }

    await ref.update({rejectNotifiedAt: admin.firestore.FieldValue.serverTimestamp()});

    ctx.logger.info("godzinkiNotifyRejected: sent", {recordId: payload.recordId});
    return {ok: true, message: `sent to ${email}`};
  },
};
