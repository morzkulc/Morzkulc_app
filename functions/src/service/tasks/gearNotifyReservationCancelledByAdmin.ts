import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {getAppVars} from "../../modules/setup/app_vars";
import {normNullish} from "../../modules/shared/text_utils";

/**
 * Task: gear.notifyReservationCancelledByAdmin
 *
 * Wysyła e-mail do właściciela rezerwacji ORAZ na adres zarządu
 * (setup/vars_members.admin_notify_email, domyślnie zarzad@morzkulc.pl — żeby cały
 * zarząd wiedział o takich sytuacjach, nie tylko admin, który je obsłużył)
 * po wymuszonym anulowaniu rezerwacji przez zarząd/KR (panel admina, sekcja
 * "Wypożyczenia sprzętu" — np. sprzęt nie został oddany przez poprzedniego
 * użytkownika). Oba maile zawierają powód anulowania i kto go dokonał.
 * Czyta już zapisany (anulowany) rekord gear_reservations, więc payload
 * niesie tylko jego id.
 */

type Payload = {
  reservationId: string;
};

const CATEGORY_NOUN: Record<string, string> = {
  kayaks: "Kajak",
  paddles: "Wiosło",
  lifejackets: "Kamizelka",
  helmets: "Kask",
  throwbags: "Rzutka",
  sprayskirts: "Fartuch",
};

function formatDatePL(iso: string): string {
  const s = normNullish(iso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || "—";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
}

function displayNameOf(u: any): string {
  const firstName = normNullish(u?.profile?.firstName);
  const lastName = normNullish(u?.profile?.lastName);
  const nickname = normNullish(u?.profile?.nickname);
  return [firstName, lastName].filter(Boolean).join(" ") || nickname;
}

function describeItems(r: any): string {
  if (Array.isArray(r?.items) && r.items.length) {
    return r.items
      .map((it: any) => {
        const cat = normNullish(it?.category).toLowerCase();
        const noun = CATEGORY_NOUN[cat] || "Sprzęt";
        const number = normNullish(it?.itemNumber);
        const label = normNullish(it?.itemLabel);
        const head = [noun, number].filter(Boolean).join(" ");
        return label ? `${head} (${label})` : head;
      })
      .join(", ");
  }
  if (Array.isArray(r?.kayakIds) && r.kayakIds.length) {
    return r.kayakIds.map((kid: any) => `Kajak ${normNullish(kid)}`).join(", ");
  }
  return "sprzęt";
}

export const gearNotifyReservationCancelledByAdminTask: ServiceTask<Payload> = {
  id: "gear.notifyReservationCancelledByAdmin",
  description: "Wysyła e-mail do użytkownika o wymuszonym anulowaniu rezerwacji sprzętu przez zarząd/KR i zwrocie godzinek.",

  validate: (payload) => {
    if (!payload?.reservationId) throw new Error("Missing reservationId");
  },

  run: async (payload, ctx) => {
    const rRef = ctx.firestore.collection("gear_reservations").doc(payload.reservationId);
    const rSnap = await rRef.get();
    if (!rSnap.exists) {
      return {ok: false, message: `Reservation ${payload.reservationId} not found`};
    }

    const r = rSnap.data() as any;
    // Idempotencja przy retry jobu (patrz eventsNotifyUpcoming.ts po ten sam wzorzec) —
    // bez tego jeden nieudany mail w parze user/zarząd oznacza cały task jako failed,
    // a retry wysyła OBA maile ponownie, łącznie z tym już dostarczonym.
    const alreadyNotified: string[] = Array.isArray(r?.cancelNotifiedTo) ? r.cancelNotifiedTo : [];
    const userUid = normNullish(r?.userUid);
    let userEmail = normNullish(r?.userEmail).toLowerCase();
    let userName = "";

    if (userUid) {
      const uSnap = await ctx.firestore.collection("users_active").doc(userUid).get();
      const u = uSnap.data() as any;
      if (!userEmail) userEmail = normNullish(u?.email).toLowerCase();
      userName = displayNameOf(u);
    }

    if (!userEmail || !userEmail.includes("@")) {
      return {ok: false, message: "Missing/invalid recipient email"};
    }

    // Kto dokonał anulowania (do audytu w mailu — user i zarząd mają widzieć to samo).
    const adminUid = normNullish(r?.cancelledByUid);
    let adminLabel = "Zarząd";
    if (adminUid) {
      const aSnap = await ctx.firestore.collection("users_active").doc(adminUid).get();
      const a = aSnap.data() as any;
      const adminName = displayNameOf(a);
      const adminEmail = normNullish(a?.email).toLowerCase();
      adminLabel = [adminName, adminEmail].filter(Boolean).join(" — ") || adminEmail || "Zarząd";
    }

    const term = `${formatDatePL(r?.startDate)} – ${formatDatePL(r?.endDate)}`;
    const itemsDesc = describeItems(r);
    const costHours = Number(r?.costHours || 0);
    const reason = normNullish(r?.cancelReason) || "(nie podano)";

    const detailLines = [
      `Sprzęt: ${itemsDesc}`,
      `Termin: ${term}`,
      `Powód: ${reason}`,
      `Anulował: ${adminLabel}`,
    ];
    if (costHours > 0) {
      detailLines.push(`Zwrócone godzinki: ${costHours} godz.`);
    }

    const userGreeting = userName ? `Cześć ${userName},` : "Cześć,";
    const userBody = [
      userGreeting,
      "",
      "Twoja rezerwacja sprzętu została anulowana przez Zarząd.",
      "",
      ...detailLines,
      "",
      "W razie pytań odezwij się do Zarządu: zarzad@morzkulc.pl",
      "",
      "SKK Morzkulc",
    ].join("\n");

    const boardUserLabel = [userName, userEmail].filter(Boolean).join(" — ") || userEmail;
    const boardBody = [
      `Rezerwacja sprzętu użytkownika ${boardUserLabel} została anulowana przez Zarząd (panel Zarządu — Wypożyczenia sprzętu).`,
      "",
      ...detailLines,
      "",
      "SKK Morzkulc — powiadomienie automatyczne",
    ].join("\n");

    const subject = "Anulowanie rezerwacji sprzętu przez Zarząd";
    const appVars = await getAppVars(ctx.firestore);
    const boardEmail = normNullish(appVars.adminNotifyEmail).toLowerCase();

    let sent = 0;
    let errors = 0;
    const sentTo: string[] = [];

    if (!alreadyNotified.includes(userEmail)) {
      try {
        await ctx.workspace.sendGenericEmail(userEmail, subject, userBody);
        sent++;
        sentTo.push(userEmail);
      } catch (e: any) {
        errors++;
        ctx.logger.error("gearNotifyReservationCancelledByAdmin: send to user failed", {
          reservationId: payload.reservationId,
          email: userEmail,
          message: e?.message,
        });
      }
    }

    if (boardEmail && boardEmail.includes("@") && boardEmail !== userEmail && !alreadyNotified.includes(boardEmail)) {
      try {
        await ctx.workspace.sendGenericEmail(boardEmail, subject, boardBody);
        sent++;
        sentTo.push(boardEmail);
      } catch (e: any) {
        errors++;
        ctx.logger.error("gearNotifyReservationCancelledByAdmin: send to board failed", {
          reservationId: payload.reservationId,
          email: boardEmail,
          message: e?.message,
        });
      }
    }

    if (sentTo.length) {
      await rRef.update({
        cancelNotifiedTo: admin.firestore.FieldValue.arrayUnion(...sentTo),
      });
    }

    ctx.logger.info("gearNotifyReservationCancelledByAdmin: done", {reservationId: payload.reservationId, sent, errors});
    return {
      ok: errors === 0,
      message: `sent=${sent}, errors=${errors}, alreadyNotified=${alreadyNotified.length}`,
      details: {sent, errors, alreadyNotified: alreadyNotified.length},
    };
  },
};
