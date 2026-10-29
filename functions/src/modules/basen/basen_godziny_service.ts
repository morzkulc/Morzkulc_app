import * as admin from "firebase-admin";
import {BasenProduct, seasonOf, warsawTodayIso} from "./basen_finance";

/**
 * Saldo godzin basenowych — osobna "waluta" od klubowych godzinek
 * (godzinki_ledger). Admin dopisuje wejścia po potwierdzeniu wpłaty przelewem
 * (regulamin basenu § 3) — wybiera produkt z cennika, kwota liczy się sama.
 *
 * Model: prosty ledger (suma amount), bez wygasania/zatwierdzania jak w
 * godzinki_service.ts. Wartość w zł wejść liczona FIFO (basen_finance.ts).
 */
export type BasenGodzinyOpType = "admin_add" | "booking_block" | "booking_refund" | "instructor_reward";

export interface BasenGodzinyRecord {
  id: string;
  uid: string;
  type: BasenGodzinyOpType;
  amount: number; // dodatnie = kredyt, ujemne = debet
  reason: string;
  sessionId?: string;
  slot?: string;
  enrollmentId?: string;
  // Sprzedaż (admin_add): produkt, cena jednego wejścia i kwota wpłaty — finanse sezonu.
  product?: BasenProduct;
  unitPricePln?: number;
  amountPln?: number;
  validUntil?: string; // karnet: koniec ważności (regulamin § 3 pkt 3)
  // Blokada/zwrot: wartość wejścia w zł (FIFO z zakupów).
  valuePln?: number;
  performedBy: string;
  createdAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
  updatedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

const COLLECTION = "basen_godziny_ledger";

export function computeBasenGodzinyBalance(records: BasenGodzinyRecord[]): number {
  // Number.isFinite — jeden nienumeryczny amount (np. ręczna edycja w konsoli) nie może
  // zamienić całego salda użytkownika w NaN.
  return records.reduce((sum, r) => {
    const n = Number(r.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

export async function getBasenGodzinyRecords(
  db: FirebaseFirestore.Firestore,
  uid: string
): Promise<BasenGodzinyRecord[]> {
  const snap = await db.collection(COLLECTION).where("uid", "==", uid).get();
  return snap.docs.map((d) => ({id: d.id, ...d.data()} as BasenGodzinyRecord));
}

export interface ProductPricing {
  basen_cena_za_godzine: number;
  basen_cena_karnet_5: number;
  basen_cena_karnet_10: number;
}

/** Liczba wejść, cena wejścia i kwota wpłaty dla produktu z cennika (regulamin § 2). */
export function priceProduct(product: BasenProduct, count: number, v: ProductPricing): {entries: number; unitPricePln: number; amountPln: number; label: string} {
  if (product === "karnet5") {
    return {entries: 5, unitPricePln: v.basen_cena_karnet_5 / 5, amountPln: v.basen_cena_karnet_5, label: `Karnet 5 wejść (${v.basen_cena_karnet_5} zł)`};
  }
  if (product === "karnet10") {
    return {entries: 10, unitPricePln: v.basen_cena_karnet_10 / 10, amountPln: v.basen_cena_karnet_10, label: `Karnet 10 wejść (${v.basen_cena_karnet_10} zł)`};
  }
  const n = Math.floor(Number(count) || 0);
  return {entries: n, unitPricePln: v.basen_cena_za_godzine, amountPln: n * v.basen_cena_za_godzine, label: `Wejścia jednorazowe × ${n} (${n * v.basen_cena_za_godzine} zł)`};
}

export async function adminAddBasenGodziny(
  db: FirebaseFirestore.Firestore,
  args: { uid: string; product: BasenProduct; count: number; reason: string; performedBy: string; pricing: ProductPricing }
): Promise<string> {
  const priced = priceProduct(args.product, args.count, args.pricing);
  if (!priced.entries || priced.entries <= 0) {
    throw new Error("Liczba wejść musi być większa od 0.");
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection(COLLECTION).doc();
  await ref.set({
    id: ref.id,
    uid: args.uid,
    type: "admin_add",
    amount: priced.entries,
    product: args.product,
    unitPricePln: priced.unitPricePln,
    amountPln: priced.amountPln,
    ...(args.product !== "jednorazowe" ? {validUntil: seasonOf(warsawTodayIso()).karnetValidUntil} : {}),
    reason: args.reason ? `${priced.label} — ${args.reason}` : priced.label,
    performedBy: args.performedBy,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

/**
 * Blokuje 1 godzinę w ramach istniejącej transakcji (enrollInSlot, promocja z listy rezerwowej).
 * `ledgerRef` musi być utworzony PRZED runTransaction (db.collection(...).doc()),
 * tak jak enrollRef/allocationRef — auto-id nie wymaga odczytu sieciowego.
 */
export function blockBasenGodzinyInTx(
  tx: FirebaseFirestore.Transaction,
  ledgerRef: FirebaseFirestore.DocumentReference,
  args: { uid: string; sessionId: string; slot: string; enrollmentId: string; performedBy: string; valuePln: number; reason?: string }
): void {
  const now = admin.firestore.FieldValue.serverTimestamp();
  tx.set(ledgerRef, {
    id: ledgerRef.id,
    uid: args.uid,
    type: "booking_block",
    amount: -1,
    valuePln: args.valuePln,
    reason: args.reason || "Zapis na basen",
    sessionId: args.sessionId,
    slot: args.slot,
    enrollmentId: args.enrollmentId,
    performedBy: args.performedBy,
    createdAt: now,
    updatedAt: now,
  });
}

/** Zwraca 1 godzinę w ramach istniejącej transakcji (cancelEnrollment / cancelSession). */
export function refundBasenGodzinyInTx(
  tx: FirebaseFirestore.Transaction,
  ledgerRef: FirebaseFirestore.DocumentReference,
  args: { uid: string; sessionId: string; slot: string; enrollmentId: string; performedBy: string; valuePln?: number }
): void {
  const now = admin.firestore.FieldValue.serverTimestamp();
  tx.set(ledgerRef, {
    id: ledgerRef.id,
    uid: args.uid,
    type: "booking_refund",
    amount: 1,
    valuePln: Number(args.valuePln) || 0,
    reason: "Zwrot godziny — anulowanie zapisu na basen",
    sessionId: args.sessionId,
    slot: args.slot,
    enrollmentId: args.enrollmentId,
    performedBy: args.performedBy,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Przyznaje 1 godzinę instruktorowi za PRZEPROWADZONY basen — wołane wyłącznie przez
 * zadanie cykliczne `basen.grantInstructorRewards` PO dacie terminu (nie przy zapisie,
 * żeby nie nagradzać za sam zapis, tylko za realne odbycie się zajęć). Idempotencja
 * pilnowana przez wywołującego (sprawdza istniejące rekordy po enrollmentId PRZED
 * wywołaniem tej funkcji) — sama funkcja tylko zapisuje. Wartość 0 zł (FIFO).
 */
export async function grantInstructorReward(
  db: FirebaseFirestore.Firestore,
  args: { uid: string; sessionId: string; slot: string; enrollmentId: string; performedBy: string }
): Promise<string> {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection(COLLECTION).doc();
  await ref.set({
    id: ref.id,
    uid: args.uid,
    type: "instructor_reward",
    amount: 1,
    unitPricePln: 0,
    reason: "Nagroda za poprowadzenie basenu",
    sessionId: args.sessionId,
    slot: args.slot,
    enrollmentId: args.enrollmentId,
    performedBy: args.performedBy,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export async function getAllInstructorRewardEnrollmentIds(db: FirebaseFirestore.Firestore): Promise<Set<string>> {
  const snap = await db.collection(COLLECTION).where("type", "==", "instructor_reward").get();
  return new Set(snap.docs.map((d) => String((d.data() as any)?.enrollmentId || "")).filter(Boolean));
}
