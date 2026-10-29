import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {
  BasenSessionDecision, cancelSession, getBasenVars, isSessionCancelled, listSeasonSessions,
  sessionDecisionMs, todayIso,
} from "../../modules/basen/basen_service";
import {computeSeason, loadSeasonEnrollments} from "../../modules/basen/basen_season";
import {sessionLight} from "../../modules/basen/basen_finance";

/**
 * Decyzja o terminie basenowym (regulamin basenu § 5) — co godzinę (basenDecideHourly),
 * dla terminów, których moment decyzji (początek H1 − basen_rezygnacja_za_darmo h,
 * w praktyce 15:00 dnia poprzedniego) już minął, a decyzji jeszcze nie ma.
 *
 * Rusza: wynik ≥ 0, albo strata ≤ basen_max_strata_terminu i wynik netto sezonu po
 * niej ≥ −basen_budzet_sezonu. Inaczej termin jest odwoływany (zwrot wejść, mail).
 * Termin z pulą kursancką zawsze rusza — opłacają go zajęcia kursu, nie wejścia.
 * Przy okazji wygasza listy rezerwowe minionych terminów.
 */
export const basenDecideSessionsTask: ServiceTask<Record<string, never>> = {
  id: "basen.decideSessions",
  description: "Basen: decyzja 30 h przed terminem — potwierdza albo odwołuje termin wg wyniku i budżetu sezonu.",

  validate: () => {
    // brak parametrów
  },

  run: async (_payload, ctx) => {
    const db = ctx.firestore;
    const vars = await getBasenVars(db);
    const today = todayIso();
    const now = Date.now();
    const fv = {koszt_terminu: vars.basen_koszt_terminu, max_strata_terminu: vars.basen_max_strata_terminu, budzet_sezonu: vars.basen_budzet_sezonu};

    const isDue = (s: any) => s.date >= today && !s.decision && !isSessionCancelled(s) &&
      sessionDecisionMs(s, vars.basen_okno_anulowania_h) > 0 && now >= sessionDecisionMs(s, vars.basen_okno_anulowania_h);

    const confirmed: string[] = [];
    const cancelled: string[] = [];
    // Po jednym terminie na raz, z odświeżeniem danych — decyzja poprzedniego zmienia wynik sezonu.
    for (let guard = 0; guard < 20; guard++) {
      const sessions = await listSeasonSessions(db);
      const s = sessions.find(isDue);
      if (!s) break;

      const enrollments = await loadSeasonEnrollments(db, sessions);
      const {rows, summary} = computeSeason(sessions, enrollments, vars, today);
      const row = rows.find((r) => r.id === s.id);
      if (!row) break;

      const isKurs = Object.values(s.slots || {}).some((sl) => sl?.reservedSpots?.restrictedToKursant === true);
      const light = isKurs ? "green" : sessionLight(row.resultPln, summary.netPln, fv);
      const decision: BasenSessionDecision = {
        status: light === "red" ? "cancelled" : "confirmed",
        at: admin.firestore.FieldValue.serverTimestamp(),
        zapisy: row.zapisy,
        entries: row.entries,
        valuePln: row.valuePln,
        costPln: row.costPln,
        resultPln: row.resultPln,
        seasonNetPln: summary.netPln,
        light,
      };

      if (decision.status === "confirmed") {
        await db.collection("basen_sessions").doc(s.id).update({decision, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
        confirmed.push(s.id);
        continue;
      }

      await cancelSession(db, s.id, "system", "frekwencja", {decision});
      const jobRef = db.collection("service_jobs").doc();
      await jobRef.set({
        id: jobRef.id,
        taskId: "basen.notifySessionCancelled",
        payload: {
          sessionId: s.id,
          reason: `Za mało zapisów (${row.zapisy}, termin odbywa się przy co najmniej ${vars.basen_min_zapisow} zapisach na obu godzinach).`,
        },
        status: "queued",
        attempts: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      cancelled.push(s.id);
    }

    // Listy rezerwowe minionych terminów — nic już z nich nie wyniknie.
    const waitSnap = await db.collection("basen_waitlist").where("status", "==", "waiting").get();
    const stale = waitSnap.docs.filter((d) => String((d.data() as any)?.sessionId || "") < today);
    for (const d of stale) {
      await d.ref.update({status: "expired", updatedAt: admin.firestore.FieldValue.serverTimestamp()});
    }

    return {
      ok: true,
      message: `confirmed=${confirmed.length}, cancelled=${cancelled.length}, waitlistExpired=${stale.length}`,
      details: {confirmed, cancelled, waitlistExpired: stale.length},
    };
  },
};
