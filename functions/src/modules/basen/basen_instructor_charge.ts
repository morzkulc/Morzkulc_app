import * as admin from "firebase-admin";
import {BasenEnrollment, BasenSession, ClientError, enrollmentId, getBasenVars, isSessionCancelled} from "./basen_service";
import {computeBasenGodzinyBalance} from "./basen_godziny_service";
import {nextEntryValuePln} from "./basen_finance";
import {computeBalance, deductHoursInTx, getAllRecords, refundHoursForReservationInTx} from "../hours/godzinki_service";
import {getGodzinkiVars} from "../hours/godzinki_vars";
import {getServiceConfig} from "../../service/service_config";

/**
 * Opłata za instruktora na basenie (regulamin basenu § 6): instruktor to zasób klubowy.
 * - Role z godzinkami (członek, zarząd, KR, kandydat): basen_instruktor_godzinki (domyślnie 1)
 *   godzinka społeczna za godzinę basenową — jak wypożyczenie sprzętu, z debetem do limitu
 *   (limit_debetu_godzinek). Rekord spend z reservationId basen_instr_{zapis}.
 * - Sympatyk (bez godzinek): dodatkowa godzina basenowa z salda (booking_block z
 *   instructorFeeFor = zapis), bez debetu.
 * - Kursant: instruktor za darmo.
 *
 * Rozliczenie jak godzina basenowa: pobierane, gdy zapis dostaje instruktora; zwracane przy
 * rezygnacji na czas, odwołaniu terminu, wypisaniu się instruktora i odebraniu instruktora.
 * Spóźniona rezygnacja: opłata przepada (chyba że miejsce przejęła lista rezerwowa).
 *
 * Stan pożądany wyliczany jest z zapisu (syncInstructorCharge), więc wywołanie jest
 * idempotentne — handler woła je po każdej zmianie, a zadanie dzienne dociąga zaległe.
 */

const SLOT_NAMES: Record<string, string> = {H1: "I godz.", H2: "II godz.", SAUNA: "sauna"};

type Payer = "godzinki" | "basen" | "free";

export function instructorChargeId(eid: string): string {
  return `basen_instr_${eid}`;
}

function payerFor(roleKey: string): Payer {
  if (roleKey === "rola_kursant") return "free";
  return getServiceConfig().godzinkiRoleKeys.includes(roleKey) ? "godzinki" : "basen";
}

/**
 * Przed przypisaniem instruktora: czy opłatę da się pobrać (limit debetu godzinek albo
 * saldo godzin basenowych; `enrolling` — ten sam zapis pobierze jeszcze 1 godzinę basenową).
 * Rzuca ClientError z komunikatem dla użytkownika.
 */
export async function precheckInstructorCharge(
  db: FirebaseFirestore.Firestore,
  uid: string,
  opts: {enrolling?: boolean} = {}
): Promise<void> {
  const userSnap = await db.collection("users_active").doc(uid).get();
  const payer = payerFor(String((userSnap.data() as any)?.role_key || ""));
  if (payer === "free") return;
  const bVars = await getBasenVars(db);
  if (payer === "basen") {
    const snap = await db.collection("basen_godziny_ledger").where("uid", "==", uid).get();
    const balance = computeBasenGodzinyBalance(snap.docs.map((d) => d.data() as any));
    const need = opts.enrolling ? 2 : 1;
    if (balance < need) {
      throw new ClientError(`Instruktor kosztuje dodatkową godzinę basenową — potrzebujesz ${need} na saldzie (masz ${balance}).`);
    }
    return;
  }
  const [gVars, records] = await Promise.all([getGodzinkiVars(db), getAllRecords(db, uid)]);
  const after = computeBalance(records) - bVars.basen_instruktor_godzinki;
  if (after < -gVars.negativeBalanceLimit) {
    throw new ClientError(`Instruktor kosztuje ${bVars.basen_instruktor_godzinki} godz. — przekroczony limit debetu godzinek (−${gVars.negativeBalanceLimit}).`);
  }
}

export type InstructorChargeResult = "charged" | "refunded" | "none" | "refund_failed";

/** Doprowadza opłatę za instruktora dla jednego zapisu do stanu wynikającego z zapisu. */
export async function syncInstructorCharge(db: FirebaseFirestore.Firestore, eid: string): Promise<InstructorChargeResult> {
  const [bVars, gVars] = await Promise.all([getBasenVars(db), getGodzinkiVars(db)]);
  const cost = bVars.basen_instruktor_godzinki;
  const chargeId = instructorChargeId(eid);

  return db.runTransaction(async (tx) => {
    const enrollSnap = await tx.get(db.collection("basen_enrollments").doc(eid));
    if (!enrollSnap.exists) return "none";
    const e = enrollSnap.data() as BasenEnrollment;
    const [sessionSnap, userSnap, instrSnap] = await Promise.all([
      tx.get(db.collection("basen_sessions").doc(e.sessionId)),
      tx.get(db.collection("users_active").doc(e.userUid)),
      e.instructorUid ?
        tx.get(db.collection("basen_enrollments").doc(enrollmentId(e.sessionId, e.slot, e.instructorUid))) :
        Promise.resolve(null),
    ]);
    const payer = payerFor(String((userSnap.data() as any)?.role_key || ""));
    const session = sessionSnap.data() as BasenSession | undefined;
    const sessionCancelled = !session || isSessionCancelled(session) || session.slots?.[e.slot]?.status === "cancelled";
    const instr = instrSnap && instrSnap.exists ? (instrSnap.data() as BasenEnrollment) : null;
    const hasInstructor = e.type === "training" && Boolean(e.instructorUid) &&
      instr?.status === "active" && instr?.type === "instructor";
    const keptLate = e.status === "cancelled" && e.cancelledLate === true && e.lateRefunded !== true &&
      e.type === "training" && Boolean(e.instructorUid);
    const shouldCharge = payer !== "free" && !sessionCancelled &&
      ((e.status === "active" && hasInstructor) || keptLate);
    const label = `Instruktor na basenie ${e.sessionId} (${SLOT_NAMES[e.slot] || e.slot})`;

    if (payer === "basen") {
      const ledgerSnap = await tx.get(db.collection("basen_godziny_ledger").where("uid", "==", e.userUid));
      const records = ledgerSnap.docs.map((d) => ({id: d.id, ...d.data()} as any));
      const fee = records.filter((r) => r.instructorFeeFor === eid);
      const charged = fee.filter((r) => r.type === "booking_block").length > fee.filter((r) => r.type === "booking_refund").length;
      const now = admin.firestore.FieldValue.serverTimestamp();
      const base = {uid: e.userUid, sessionId: e.sessionId, slot: e.slot, enrollmentId: eid, instructorFeeFor: eid,
        performedBy: "system:instructorFee", createdAt: now, updatedAt: now};
      if (shouldCharge && !charged) {
        if (computeBasenGodzinyBalance(records) < 1) return "none"; // brak salda — precheck nie wpuścił; nie schodzimy pod zero
        const ref = db.collection("basen_godziny_ledger").doc();
        tx.set(ref, {id: ref.id, ...base, type: "booking_block", amount: -1,
          valuePln: nextEntryValuePln(records, bVars.basen_cena_za_godzine), reason: label});
        return "charged";
      }
      if (!shouldCharge && charged) {
        const ref = db.collection("basen_godziny_ledger").doc();
        const block = fee.filter((r) => r.type === "booking_block").pop();
        tx.set(ref, {id: ref.id, ...base, type: "booking_refund", amount: 1, valuePln: Number(block?.valuePln) || 0,
          reason: "Zwrot godziny — instruktor"});
        return "refunded";
      }
      return "none";
    }

    const spendSnap = await tx.get(db.collection("godzinki_ledger")
      .where("uid", "==", e.userUid)
      .where("type", "==", "spend")
      .where("reservationId", "==", chargeId));
    const charged = spendSnap.docs.some((d) => (d.data() as any).refunded !== true);
    if (shouldCharge && cost > 0 && !charged) {
      const r = await deductHoursInTx(tx, db, e.userUid, {
        amount: cost,
        reason: label,
        reservationId: chargeId,
        force: true, // limit sprawdzony przy przypisaniu (precheckInstructorCharge)
      }, gVars);
      return r.ok ? "charged" : "none";
    }
    if (!shouldCharge && charged) {
      const r = await refundHoursForReservationInTx(tx, db, e.userUid, chargeId, cost);
      return r.ok ? "refunded" : "refund_failed";
    }
    return "none";
  });
}

/** Wszystkie zapisy szkoleniowe terminu (po odwołaniu terminu / rezygnacji instruktora). */
export async function syncSessionInstructorCharges(
  db: FirebaseFirestore.Firestore,
  sessionId: string,
  logger?: {error: (msg: string, meta?: any) => void}
): Promise<void> {
  const snap = await db.collection("basen_enrollments").where("sessionId", "==", sessionId).get();
  for (const d of snap.docs) {
    if ((d.data() as BasenEnrollment).type !== "training") continue;
    await syncInstructorChargeSafe(db, d.id, logger);
  }
}

/** Jak syncInstructorCharge, ale nie przerywa akcji użytkownika — błąd tylko do logu (zadanie dzienne dociągnie). */
export async function syncInstructorChargeSafe(
  db: FirebaseFirestore.Firestore,
  eid: string,
  logger?: {error: (msg: string, meta?: any) => void}
): Promise<InstructorChargeResult | "error"> {
  try {
    const r = await syncInstructorCharge(db, eid);
    if (r === "refund_failed") (logger || console).error("basen instructor charge: refund failed", {eid});
    return r;
  } catch (err: any) {
    (logger || console).error("basen instructor charge: sync failed", {eid, message: err?.message});
    return "error";
  }
}
