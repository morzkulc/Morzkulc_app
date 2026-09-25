import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {normNullish} from "../../modules/shared/text_utils";

/**
 * Task: gear.notifyHalfHalfOwner
 *
 * Powiadamia właściciela kajaka „pół na pół" (kolumna arkusza „Pół na pół?"),
 * że ktoś zgłosił wypożyczenie jego sztuki.
 *
 * Reguła biznesowa (decyzja użytkownika 23.09.2026): „pół na pół" oznacza
 * WYŁĄCZNIE pierwszeństwo właściciela w realu. Kajak jest traktowany jak klubowy
 * — rezerwuje go każdy, nie ma żadnych opłat ani blokad w aplikacji. Ten mail
 * jest jedynym mechanizmem: właściciel dowiaduje się o rezerwacji i sam się
 * dogaduje, jeśli potrzebuje kajaka na ten termin.
 *
 * Adresatem jest `ownerContact` z dokumentu kajaka — to adres z arkusza, który
 * nie musi należeć do konta w aplikacji, więc NIE szukamy go w users_active.
 *
 * Idempotencja przy retry: znacznik halfHalfNotifiedTo na rezerwacji (arrayUnion),
 * ten sam wzorzec co gearNotifyReservationCancelledByAdmin.
 */

type Payload = {
  reservationId: string;
  kayakIds: string[];
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

/**
 * Znajduje dokument kajaka po wartości pola `id` (klucz z arkusza), z fallbackiem
 * na identyfikator dokumentu — dokładnie ta sama dwutorowość co w fetchItemDetails
 * (`norm(d?.id) || doc.id`), bo w katalogu bywają rekordy bez pola `id`.
 */
async function findKayak(db: FirebaseFirestore.Firestore, kayakId: string): Promise<any | null> {
  const byField = await db.collection("gear_kayaks").where("id", "==", kayakId).limit(1).get();
  if (!byField.empty) return byField.docs[0].data();
  const byDocId = await db.collection("gear_kayaks").doc(kayakId).get();
  return byDocId.exists ? byDocId.data() : null;
}

export const gearNotifyHalfHalfOwnerTask: ServiceTask<Payload> = {
  id: "gear.notifyHalfHalfOwner",
  description: "Powiadamia właściciela kajaka „pół na pół” o zgłoszonym wypożyczeniu jego sztuki.",

  validate: (payload) => {
    if (!payload?.reservationId) throw new Error("Missing reservationId");
    if (!Array.isArray(payload?.kayakIds) || !payload.kayakIds.length) throw new Error("Missing kayakIds");
  },

  run: async (payload, ctx) => {
    const rRef = ctx.firestore.collection("gear_reservations").doc(payload.reservationId);
    const rSnap = await rRef.get();
    if (!rSnap.exists) {
      return {ok: false, message: `Reservation ${payload.reservationId} not found`};
    }

    const r = rSnap.data() as any;
    const alreadyNotified: string[] = Array.isArray(r?.halfHalfNotifiedTo) ? r.halfHalfNotifiedTo : [];

    // Kto wypożycza — imię i nazwisko plus mail, żeby właściciel mógł się odezwać.
    const userUid = normNullish(r?.userUid);
    let borrowerLabel = normNullish(r?.userEmail).toLowerCase();
    if (userUid) {
      const uSnap = await ctx.firestore.collection("users_active").doc(userUid).get();
      const u = uSnap.data() as any;
      const name = displayNameOf(u);
      const mail = normNullish(u?.email).toLowerCase() || borrowerLabel;
      borrowerLabel = [name, mail].filter(Boolean).join(" — ") || mail;
    }

    const term = `${formatDatePL(r?.startDate)} – ${formatDatePL(r?.endDate)}`;

    // Grupujemy po właścicielu: jeden człowiek może mieć kilka sztuk w tej samej
    // rezerwacji — wtedy dostaje jednego maila z listą, nie kilku osobnych.
    const byOwner = new Map<string, string[]>();
    for (const kayakId of payload.kayakIds) {
      const k = await findKayak(ctx.firestore, kayakId);
      if (!k) {
        ctx.logger.warn("gearNotifyHalfHalfOwner: kayak not found", {kayakId, reservationId: payload.reservationId});
        continue;
      }
      const owner = normNullish(k?.ownerContact).toLowerCase();
      if (!owner || !owner.includes("@")) {
        ctx.logger.info("gearNotifyHalfHalfOwner: kayak without owner contact", {kayakId});
        continue;
      }
      const label = [normNullish(k?.brand), normNullish(k?.model)].filter(Boolean).join(" ");
      const number = normNullish(k?.number) || kayakId;
      const desc = label ? `${label} (nr ${number})` : `Kajak nr ${number}`;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner)?.push(desc);
    }

    let sent = 0;
    let errors = 0;
    const sentTo: string[] = [];

    for (const [owner, kayaksDesc] of byOwner.entries()) {
      if (alreadyNotified.includes(owner)) continue;

      const body = [
        "Cześć,",
        "",
        "Ktoś z klubu zgłosił wypożyczenie kajaka, którego jesteś współwłaścicielem („pół na pół”).",
        "",
        `Sprzęt: ${kayaksDesc.join(", ")}`,
        `Termin: ${term}`,
        `Wypożycza: ${borrowerLabel || "—"}`,
        "",
        "To tylko informacja — kajak jest w klubie traktowany jak klubowy, a Ty masz do niego",
        "pierwszeństwo. Jeśli potrzebujesz go w tym terminie, odezwij się bezpośrednio do tej osoby",
        "albo do Zarządu: zarzad@morzkulc.pl",
        "",
        "SKK Morzkulc",
      ].join("\n");

      try {
        await ctx.workspace.sendGenericEmail(owner, "Wypożyczenie Twojego kajaka (pół na pół)", body);
        sent++;
        sentTo.push(owner);
      } catch (e: any) {
        errors++;
        ctx.logger.error("gearNotifyHalfHalfOwner: send failed", {
          reservationId: payload.reservationId,
          email: owner,
          message: e?.message,
        });
      }
    }

    if (sentTo.length) {
      await rRef.update({
        halfHalfNotifiedTo: admin.firestore.FieldValue.arrayUnion(...sentTo),
      });
    }

    ctx.logger.info("gearNotifyHalfHalfOwner: done", {reservationId: payload.reservationId, sent, errors});
    return {
      ok: errors === 0,
      message: `sent=${sent}, errors=${errors}`,
      details: {sent, errors, owners: byOwner.size},
    };
  },
};
