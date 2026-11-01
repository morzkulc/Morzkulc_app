import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {getServiceConfig} from "../service_config";
import {normNullish} from "../../modules/shared/text_utils";
import {getCachedDoc} from "../../modules/setup/doc_cache";
import {isProfileComplete} from "../../modules/users/profile_complete";

/**
 * Task: users.incompleteRegistration (decyzja 01.11.2026)
 *
 * Konta, które zalogowały się, ale nie dokończyły rejestracji (isProfileComplete = false):
 *  1. JEDEN mail z przypomnieniem po `rejestracja_dni_do_przypomnienia` dniach od założenia konta (fallback 3),
 *  2. usunięcie konta po `rejestracja_dni_do_usuniecia` dniach od założenia (fallback 7).
 * Termin usunięcia ustalany przy wysyłce przypomnienia (service.registrationDeleteAfter) i podany w mailu.
 * Konta starsze niż termin usunięcia w chwili wysyłki (wdrożenie 01.11.2026) dostają pełne N dni od maila.
 * Zadanie uruchamiane codziennie tylko sprawdza terminy — każda osoba dostaje jeden mail.
 *
 * Usuwamy tylko to, co aplikacja dodała sama przy logowaniu: pulę „Bilans otwarcia" w godzinki_ledger
 * i statystyki km; historyczne km_logs wracają pod uid archiwum (odtworzą się przy ponownej rejestracji).
 * Konto z innymi danymi (godzinki, km dopisane ręcznie) jest pomijane — do ręcznej decyzji.
 * Pomijane: admin@morzkulc.pl, konto delegowane, konta testowe.
 */

const REMIND_DAYS_FALLBACK = 3;
const DELETE_DAYS_FALLBACK = 7;
const DAY_MS = 24 * 3600 * 1000;
const PROTECTED = ["admin@morzkulc.pl"];

type Payload = {dry?: boolean};

function ms(v: any): number {
  return v && typeof v.toMillis === "function" ? v.toMillis() : 0;
}

function datePL(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** Termin usunięcia: założenie + N dni, ale nie wcześniej niż po (N − przypomnienie) dniach od maila;
 *  konto już starsze niż N dni dostaje pełne N dni od maila. */
export function deletionDeadline(createdAt: number, now: number, remindDays: number, deleteDays: number): number {
  const byCreation = createdAt + deleteDays * DAY_MS;
  return byCreation >= now + (deleteDays - remindDays) * DAY_MS ? byCreation : now + deleteDays * DAY_MS;
}

function reminderBody(deadline: number): string {
  return [
    "Cześć,",
    "",
    "na ten adres rozpoczęto rejestrację w aplikacji klubowej SKK Morzkulc, ale nie została dokończona —",
    "brakuje danych z formularza (imię i nazwisko, telefon, data urodzenia, zgody).",
    "",
    "Aby ją dokończyć, zaloguj się tym samym kontem Google na https://app.morzkulc.pl i wypełnij formularz.",
    "",
    `Jeśli rejestracja nie zostanie dokończona do ${datePL(deadline)}, konto zostanie usunięte.`,
    "Zawsze możesz założyć je ponownie, logując się do aplikacji.",
    "",
    "Pytania: zarzad@morzkulc.pl",
    "",
    "SKK Morzkulc",
  ].join("\n");
}

export const usersIncompleteRegistrationTask: ServiceTask<Payload> = {
  id: "users.incompleteRegistration",
  description: "Jedno przypomnienie o niedokończonej rejestracji (3 dni), usunięcie konta (7 dni).",

  validate: () => undefined,

  run: async (payload, ctx) => {
    const db = ctx.firestore;
    const dryRun = ctx.dryRun || Boolean(payload?.dry);
    const varsSnap = await getCachedDoc(db, "setup", "vars_members");
    const vars = ((varsSnap.exists ? (varsSnap.data() as any)?.vars : null) || {}) as Record<string, any>;
    const numVar = (k: string, fb: number) => {
      const n = Number(vars?.[k]?.value);
      return Number.isFinite(n) && n > 0 ? n : fb;
    };
    const remindDays = numVar("rejestracja_dni_do_przypomnienia", REMIND_DAYS_FALLBACK);
    const deleteDays = Math.max(remindDays + 1, numVar("rejestracja_dni_do_usuniecia", DELETE_DAYS_FALLBACK));
    const testAccounts = String(vars?.konta_testowe?.value ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const protectedEmails = new Set([...PROTECTED, normNullish(getServiceConfig().workspace.delegatedSubject).toLowerCase(), ...testAccounts]);

    const now = Date.now();
    let reminded = 0;
    let deleted = 0;
    let skippedWithData = 0;
    let kmMoved = false;
    const deletedEmails: string[] = [];

    const users = await db.collection("users_active").get();
    for (const doc of users.docs) {
      const u = doc.data() as any;
      const email = normNullish(u?.email).toLowerCase();
      if (!email || protectedEmails.has(email) || isProfileComplete(u?.profile)) continue;
      const createdAt = ms(u?.createdAt);
      if (!createdAt || now - createdAt < remindDays * DAY_MS) continue;

      const deleteAfter = ms(u?.service?.registrationDeleteAfter);
      if (!deleteAfter) {
        const deadline = deletionDeadline(createdAt, now, remindDays, deleteDays);
        if (!dryRun) {
          await ctx.workspace.sendGenericEmail(email, "Dokończ rejestrację w aplikacji SKK Morzkulc", reminderBody(deadline));
          await doc.ref.set({service: {
            registrationReminderAt: admin.firestore.Timestamp.now(),
            registrationDeleteAfter: admin.firestore.Timestamp.fromMillis(deadline),
          }}, {merge: true});
        }
        reminded++;
        continue;
      }
      if (now < deleteAfter) continue;

      // Usunięcie — tylko dane dodane automatycznie przy logowaniu.
      const ledger = await db.collection("godzinki_ledger").where("uid", "==", doc.id).get();
      const histUid = normNullish(u?.service?.kmHistMergedFrom);
      const km = await db.collection("km_logs").where("uid", "==", doc.id).get();
      const manualLedger = ledger.docs.some((d) => normNullish((d.data() as any)?.reason) !== "Bilans otwarcia");
      const manualKm = km.docs.some((d) => (d.data() as any)?.sourceType !== "historical") || (!km.empty && !histUid);
      if (manualLedger || manualKm) {
        ctx.logger.warn("users.incompleteRegistration: konto z danymi — pominięte", {uid: doc.id});
        skippedWithData++;
        continue;
      }
      if (!dryRun) {
        for (const d of ledger.docs) await d.ref.delete();
        for (const d of km.docs) await d.ref.update({uid: histUid, updatedAt: admin.firestore.Timestamp.now()});
        await db.collection("km_user_stats").doc(doc.id).delete();
        await doc.ref.delete();
        try {
          await admin.auth().deleteUser(doc.id);
        } catch (e: any) {
          if (e?.code !== "auth/user-not-found") throw e;
        }
        if (!km.empty) {
          kmMoved = true;
          const job = db.collection("service_jobs").doc();
          await job.set({id: job.id, taskId: "km.rebuildUserStats", payload: {uid: histUid}, status: "queued", attempts: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
        }
      }
      deleted++;
      deletedEmails.push(email);
    }

    if (kmMoved && !dryRun) {
      const job = db.collection("service_jobs").doc();
      await job.set({id: job.id, taskId: "km.rebuildRankings", payload: {}, status: "queued", attempts: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
    }
    const details = {remindDays, deleteDays, reminded, deleted, skippedWithData, deletedEmails, dryRun};
    ctx.logger.info("users.incompleteRegistration: done", details);
    return {ok: true, message: `Przypomnienia: ${reminded}, usunięte: ${deleted}, pominięte (dane): ${skippedWithData}`, details};
  },
};
