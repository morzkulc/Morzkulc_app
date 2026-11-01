import {ServiceTask} from "../types";
import {syncInstructorChargeSafe} from "../../modules/basen/basen_instructor_charge";
import {finalizePastSessions} from "../../modules/basen/basen_season";
import {getBasenVars} from "../../modules/basen/basen_service";
import {grantInstructorReward, getAllInstructorRewardEnrollmentIds} from "../../modules/basen/basen_godziny_service";

type Payload = Record<string, never>;

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Task: basen.grantInstructorRewards
 *
 * Nagradza instruktorów 1 godziną basenową za KAŻDY PRZEPROWADZONY termin, na który
 * byli zapisani jako instructor — dopiero PO dacie terminu (nie przy samym zapisie,
 * żeby nie nagradzać kogoś kto się zapisał ale termin np. odwołano — wtedy enrollment
 * jest "cancelled" i w ogóle nie wchodzi do rozpatrzenia). Uruchamiane cyklicznie
 * (basenGrantInstructorRewardsDaily), bezpieczne do wielokrotnego odpalenia — pomija
 * zapisy, które już dostały nagrodę (sprawdzane po enrollmentId w ledgerze).
 *
 * Nagroda to godzina basenowa (basen_godziny_ledger), nie godzinki. Dostaje ją tylko osoba,
 * która W CHWILI naliczania ma uprawnienie instruktora z arkusza członków
 * (admin.basenInstructor, kolumna „Instruktor (basen)"). Zapis bez uprawnienia nie jest
 * oznaczany jako nagrodzony — gdy uprawnienie wróci, nagroda zostanie naliczona.
 */
export const basenGrantInstructorRewardsTask: ServiceTask<Payload> = {
  id: "basen.grantInstructorRewards",
  description: "Nagradza instruktorów 1h basenową za każdy odbyty termin.",

  validate: () => {
    // brak wymaganych pól
  },

  run: async (_payload, ctx) => {
    const today = todayIso(ctx.now);

    // Wynik odbytych terminów zapisywany na terminie — ekran basenu nie czyta już ich zapisów.
    const finalized = ctx.dryRun ? 0 : await finalizePastSessions(ctx.firestore, await getBasenVars(ctx.firestore), today);

    // Dociąga opłaty za instruktora (godzinka społeczna), których nie zapisała akcja
    // użytkownika (np. błąd sieci po zapisie) — idempotentne.
    let chargeFixes = 0;
    if (!ctx.dryRun) {
      const trainingSnap = await ctx.firestore.collection("basen_enrollments").where("type", "==", "training").get();
      for (const d of trainingSnap.docs) {
        const r = await syncInstructorChargeSafe(ctx.firestore, d.id, ctx.logger);
        if (r === "charged" || r === "refunded") chargeFixes++;
      }
    }

    const sessionsSnap = await ctx.firestore
      .collection("basen_sessions")
      .where("date", "<", today)
      .get();

    if (sessionsSnap.empty) {
      return {ok: true, message: "Brak minionych terminów do rozliczenia.", details: {granted: 0, chargeFixes, finalized}};
    }

    const alreadyRewarded = await getAllInstructorRewardEnrollmentIds(ctx.firestore);

    let granted = 0;
    let skipped = 0;
    let notInstructor = 0;
    const instructorFlag = new Map<string, boolean>();
    const isInstructor = async (uid: string): Promise<boolean> => {
      if (!instructorFlag.has(uid)) {
        const u = await ctx.firestore.collection("users_active").doc(uid).get();
        instructorFlag.set(uid, (u.data() as any)?.admin?.basenInstructor === true);
      }
      return instructorFlag.get(uid) === true;
    };
    const errors: string[] = [];

    for (const sessionDoc of sessionsSnap.docs) {
      const session = sessionDoc.data() as any;
      const slotLabels = Object.keys(session.slots || {});

      for (const slot of slotLabels) {
        const enrollmentsSnap = await ctx.firestore
          .collection("basen_enrollments")
          .where("sessionId", "==", sessionDoc.id)
          .where("slot", "==", slot)
          .where("type", "==", "instructor")
          .where("status", "==", "active")
          .get();

        for (const enrollDoc of enrollmentsSnap.docs) {
          const enrollment = enrollDoc.data() as any;
          if (alreadyRewarded.has(enrollDoc.id)) {
            skipped++;
            continue;
          }
          if (!(await isInstructor(String(enrollment.userUid || "")))) {
            notInstructor++;
            continue;
          }
          if (ctx.dryRun) {
            granted++;
            continue;
          }
          try {
            await grantInstructorReward(ctx.firestore, {
              uid: enrollment.userUid,
              sessionId: sessionDoc.id,
              slot,
              enrollmentId: enrollDoc.id,
              performedBy: "system:basenGrantInstructorRewards",
            });
            granted++;
          } catch (e: any) {
            errors.push(`${enrollDoc.id}: ${e?.message || String(e)}`);
            ctx.logger.error("basenGrantInstructorRewards: grant failed", {enrollmentId: enrollDoc.id, message: e?.message});
          }
        }
      }
    }

    return {
      ok: errors.length === 0,
      message: `granted=${granted}, skipped=${skipped}, notInstructor=${notInstructor}, chargeFixes=${chargeFixes}, finalized=${finalized}, errors=${errors.length}`,
      details: {granted, skipped, notInstructor, chargeFixes, finalized, errors},
    };
  },
};
