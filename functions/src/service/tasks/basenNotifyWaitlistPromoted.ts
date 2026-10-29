import {ServiceTask} from "../types";
import {norm} from "../../modules/shared/text_utils";

type Payload = {
  sessionId: string;
  slot: string;
  uid: string;
};

const SLOT_LABELS: Record<string, string> = {H1: "I godzina", H2: "II godzina"};

/**
 * Mail do osoby, która przejęła miejsce z listy rezerwowej (basen_service.ts::cancelEnrollment).
 * Godzina basenowa została już pobrana — mail informuje, że jest zapisana i jak zrezygnować.
 */
export const basenNotifyWaitlistPromotedTask: ServiceTask<Payload> = {
  id: "basen.notifyWaitlistPromoted",
  description: "Basen: mail do osoby, która przejęła miejsce z listy rezerwowej.",

  validate: (payload) => {
    if (!payload?.sessionId || !payload?.slot || !payload?.uid) throw new Error("Missing sessionId/slot/uid");
  },

  run: async (payload, ctx) => {
    const id = `${payload.sessionId}_${payload.slot}_${payload.uid}`;
    const enrollSnap = await ctx.firestore.collection("basen_enrollments").doc(id).get();
    const enrollment = enrollSnap.data() as any;
    if (!enrollSnap.exists || enrollment?.status !== "active") {
      return {ok: true, message: "Zapis nieaktywny — mail pominięty."};
    }
    if (enrollment?.waitlistNotifiedAt) {
      return {ok: true, message: "Mail już wysłany."};
    }
    const to = norm(enrollment?.userEmail);
    if (!to.includes("@")) return {ok: false, message: "Brak adresu e-mail."};

    const sessionSnap = await ctx.firestore.collection("basen_sessions").doc(payload.sessionId).get();
    const session = sessionSnap.data() as any;
    const time = norm(session?.slots?.[payload.slot]?.timeStart);
    const slotLabel = SLOT_LABELS[payload.slot] || payload.slot;

    const body = [
      "Zwolniło się miejsce na basenie i przejmujesz je z listy rezerwowej.",
      "",
      `Termin: ${norm(session?.date)}, ${slotLabel}${time ? ` (${time})` : ""}`,
      "",
      "Z Twojego salda pobrano jedną godzinę basenową. Jeśli nie możesz przyjść, zrezygnuj w aplikacji.",
      "Rezygnacja przed terminem decyzji (30 h przed basenem) zwraca godzinę basenową; później — tylko",
      "gdy Twoje miejsce zajmie kolejna osoba z listy rezerwowej.",
      "",
      "SKK Morzkulc",
    ].join("\n");

    await ctx.workspace.sendGenericEmail(to, `Basen — masz miejsce z listy rezerwowej (${norm(session?.date)})`, body);
    await enrollSnap.ref.update({waitlistNotifiedAt: new Date()});
    return {ok: true, message: `sent to ${to}`};
  },
};
