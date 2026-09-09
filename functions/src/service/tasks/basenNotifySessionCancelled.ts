import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {norm} from "../../modules/shared/text_utils";

type Payload = {
  sessionId: string;
  reason?: string; // opcjonalny powód podany przez admina przy anulowaniu
};

export const basenNotifySessionCancelledTask: ServiceTask<Payload> = {
  id: "basen.notifySessionCancelled",
  description: "Wysyła e-mail do instruktorów i uczestników po anulowaniu terminu basenowego (zawsze cały dzień).",

  validate: (payload) => {
    if (!payload?.sessionId) throw new Error("Missing sessionId");
  },

  run: async (payload, ctx) => {
    const sessionRef = ctx.firestore.collection("basen_sessions").doc(payload.sessionId);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) {
      return {ok: false, message: `Session ${payload.sessionId} not found`};
    }

    const session = sessionSnap.data() as any;
    const dateStr = norm(session?.date);

    // Idempotencja przy retry jobu (patrz eventsNotifyUpcoming.ts po ten sam wzorzec):
    // bez tego jeden nieudany mail w partii oznacza cały task jako failed → retry wysyła
    // ponownie do WSZYSTKICH odbiorców, łącznie z tymi, którzy już dostali powiadomienie.
    const alreadyNotified: string[] = Array.isArray(session?.cancelNotifiedEmails) ?
      session.cancelNotifiedEmails : [];

    const enrollmentsSnap = await ctx.firestore
      .collection("basen_enrollments")
      .where("sessionId", "==", payload.sessionId)
      .where("status", "==", "cancelled")
      .get();

    const enrollments = enrollmentsSnap.docs.map((d) => d.data() as any);

    const reason = norm(payload.reason);
    const subject = `Anulowanie zajęć basenowych — ${dateStr}`;
    const body = [
      "Informujemy, że zajęcia basenowe zostały anulowane.",
      "",
      `Termin: ${dateStr}`,
      ...(reason ? ["", `Powód: ${reason}`] : []),
      "",
      "Jeśli za ten termin została zablokowana godzina basenowa — wróciła już na Twoje saldo.",
      "",
      "SKK Morzkulc",
    ].join("\n");

    const recipients = new Set<string>();

    // Instruktorzy i uczestnicy — wszyscy są dziś zapisami (type: instructor/training/regular).
    // Opiekunowie basenowi (vars_basen.basen_admin_mail) świadomie NIE dostają tu kopii —
    // to oni anulują termin, więc już wiedzą, że to zrobili.
    for (const enrollment of enrollments) {
      const email = norm(enrollment?.userEmail);
      if (email && email.includes("@")) {
        recipients.add(email);
      }
    }

    const newRecipients = Array.from(recipients).filter((email) => !alreadyNotified.includes(email));

    let sent = 0;
    let errors = 0;
    const sentEmails: string[] = [];

    for (const to of newRecipients) {
      try {
        await ctx.workspace.sendGenericEmail(to, subject, body);
        sent++;
        sentEmails.push(to);
        ctx.logger.info("basenNotifySessionCancelled: sent", {to, sessionId: payload.sessionId});
      } catch (e: any) {
        errors++;
        ctx.logger.error("basenNotifySessionCancelled: send failed", {
          to,
          message: e?.message || String(e),
        });
      }
    }

    if (sentEmails.length) {
      await sessionRef.update({
        cancelNotifiedEmails: admin.firestore.FieldValue.arrayUnion(...sentEmails),
      });
    }

    return {
      ok: errors === 0,
      message: `sent=${sent}, errors=${errors}, recipients=${newRecipients.length}, alreadyNotified=${alreadyNotified.length}`,
      details: {sent, errors, recipients: newRecipients.length, alreadyNotified: alreadyNotified.length},
    };
  },
};
