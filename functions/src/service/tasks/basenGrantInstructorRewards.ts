import {ServiceTask} from "../types";
import {grantInstructorReward, getAllInstructorRewardEnrollmentIds} from "../../modules/basen/basen_godziny_service";
import {isSessionCancelled} from "../../modules/basen/basen_service";
import {creditApprovedEarn} from "../../modules/hours/godzinki_service";
import {getGodzinkiVars} from "../../modules/hours/godzinki_vars";

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
 *
 * Ratownik terminu (opiekun basenu, zapis z ratownik:true) za odbyty termin dostaje
 * 1 GODZINKĘ KLUBOWĄ (godzinki_ledger, earn zatwierdzony), nie godzinę basenową.
 * Odwołany termin = brak nagrody. Idempotentnie: wpis o stałym id basen_ratownik_{zapis}.
 */
export const basenGrantInstructorRewardsTask: ServiceTask<Payload> = {
  id: "basen.grantInstructorRewards",
  description: "Nagradza instruktorów 1h basenową, a ratownika 1 godzinką klubową za każdy odbyty termin.",

  validate: () => {
    // brak wymaganych pól
  },

  run: async (_payload, ctx) => {
    const today = todayIso(ctx.now);

    const sessionsSnap = await ctx.firestore
      .collection("basen_sessions")
      .where("date", "<", today)
      .get();

    if (sessionsSnap.empty) {
      return {ok: true, message: "Brak minionych terminów do rozliczenia.", details: {granted: 0}};
    }

    const alreadyRewarded = await getAllInstructorRewardEnrollmentIds(ctx.firestore);

    let granted = 0;
    let skipped = 0;
    let notInstructor = 0;
    let ratownikGranted = 0;
    const godzinkiVars = await getGodzinkiVars(ctx.firestore);
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

      if (session.ratownikUid && !isSessionCancelled(session)) {
        const ratSnap = await ctx.firestore.collection("basen_enrollments")
          .where("sessionId", "==", sessionDoc.id)
          .where("ratownik", "==", true)
          .where("status", "==", "active")
          .get();
        for (const enrollDoc of ratSnap.docs) {
          const enrollment = enrollDoc.data() as any;
          const docId = `basen_ratownik_${enrollDoc.id}`;
          if ((await ctx.firestore.collection("godzinki_ledger").doc(docId).get()).exists) continue;
          if (ctx.dryRun) {
            ratownikGranted++;
            continue;
          }
          try {
            const now = ctx.now;
            const expiresAt = new Date(now);
            expiresAt.setMonth(expiresAt.getMonth() + godzinkiVars.expiryMonths);
            await creditApprovedEarn(ctx.firestore, String(enrollment.userUid), 1, now, expiresAt, {
              reason: `Ratownik na basenie ${sessionDoc.id}`,
              approvedBy: "system",
              submittedBy: "system",
              docId,
            });
            await enrollDoc.ref.update({ratownikRewardedAt: now});
            ratownikGranted++;
          } catch (e: any) {
            errors.push(`${enrollDoc.id} (ratownik): ${e?.message || String(e)}`);
            ctx.logger.error("basenGrantInstructorRewards: ratownik grant failed", {enrollmentId: enrollDoc.id, message: e?.message});
          }
        }
      }

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
      message: `granted=${granted}, skipped=${skipped}, notInstructor=${notInstructor}, ratownik=${ratownikGranted}, errors=${errors.length}`,
      details: {granted, skipped, notInstructor, ratownikGranted, errors},
    };
  },
};
