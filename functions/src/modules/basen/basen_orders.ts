import * as admin from "firebase-admin";
import {BasenProduct} from "./basen_finance";
import {BasenVars, ClientError, getBasenVars} from "./basen_service";
import {adminAddBasenGodzinyInTx, priceProduct, ProductPricing} from "./basen_godziny_service";
import {computeEarnedBalance, deductHoursInTx, getAllRecords, GodzinkiRecord} from "../hours/godzinki_service";
import {getGodzinkiVars} from "../hours/godzinki_vars";
import {MEMBER_ROLE_KEYS, isDuesPaid} from "../users/member_standing";

/**
 * Zamówienia godzin basenowych (kolekcja basen_orders).
 *
 * Użytkownik klika „Kup" → zamówienie `pending` + mail z numerem konta i kwotą.
 * Pieniądze idą przelewem albo gotówką poza aplikacją. Opiekun basenu sprawdza wpłatę
 * i zatwierdza zamówienie, dopiero wtedy godziny basenowe trafiają na saldo
 * (basen_godziny_ledger). Opiekun może odrzucić zamówienie (mail z powodem), a
 * użytkownik może anulować własne, jeszcze niezatwierdzone.
 *
 * Karnet to dofinansowanie klubu (zasady dofinansowania + regulamin basenu § 3): pełny członek
 * z opłaconymi składkami i saldem godzinek WYPRACOWANYCH co najmniej równym kosztowi karnetu
 * w godzinkach (basen_karnet_5/10_godzinki). Godzinki zdejmowane przy zatwierdzeniu wpłaty.
 */

export type KarnetProduct = "karnet5" | "karnet10";

export function karnetGodzinkiCost(product: KarnetProduct, vars: Pick<BasenVars, "basen_karnet_5_godzinki" | "basen_karnet_10_godzinki">): number {
  return product === "karnet5" ? vars.basen_karnet_5_godzinki : vars.basen_karnet_10_godzinki;
}

export const ORDERS = "basen_orders";
export const PRODUCTS: BasenProduct[] = ["jednorazowe", "karnet5", "karnet10"];
/** Górny limit pojedynczych godzin w jednym zamówieniu — ochrona przed literówką. */
export const MAX_SINGLE_COUNT = 20;

export type OrderStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface BasenOrder {
  id: string;
  uid: string;
  userEmail: string;
  userName: string;
  product: BasenProduct;
  count: number; // liczba godzin basenowych
  unitPricePln: number;
  amountPln: number;
  label: string;
  transferTitle: string;
  status: OrderStatus;
  rejectReason?: string;
  decidedBy?: string;
  ledgerId?: string;
  createdAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
  updatedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
  decidedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

export interface KarnetEligibility {
  /** Pełny członek klubu — tylko on w ogóle widzi kafelki karnetów. */
  member: boolean;
  /** Choć jeden karnet dostępny. */
  eligible: boolean;
  byProduct: Record<KarnetProduct, boolean>;
  /** Koszt karnetu w godzinkach (z SETUP). */
  godzinkiCost: Record<KarnetProduct, number>;
  duesPaid: boolean;
  /** Saldo godzinek wypracowanych (wykupione nie robią plusa). */
  godzinkiBalance: number;
  /** Powody nieaktywnych kafelków, gotowe do wyświetlenia. */
  reasons: string[];
}

export async function getKarnetEligibility(
  db: FirebaseFirestore.Firestore,
  uid: string,
  userData: any
): Promise<KarnetEligibility> {
  const vars = await getBasenVars(db);
  const godzinkiCost = {karnet5: karnetGodzinkiCost("karnet5", vars), karnet10: karnetGodzinkiCost("karnet10", vars)};
  const member = MEMBER_ROLE_KEYS.includes(String(userData?.role_key || ""));
  if (!member) {
    return {member, eligible: false, byProduct: {karnet5: false, karnet10: false}, godzinkiCost, duesPaid: false, godzinkiBalance: 0,
      reasons: ["Karnety są dostępne tylko dla członków klubu."]};
  }
  const duesPaid = isDuesPaid(userData);
  const godzinkiBalance = computeEarnedBalance(await getAllRecords(db, uid));
  const reasons: string[] = [];
  if (!duesPaid) reasons.push("Brak opłaconych składek członkowskich.");
  const byProduct = {
    karnet5: duesPaid && godzinkiBalance >= godzinkiCost.karnet5,
    karnet10: duesPaid && godzinkiBalance >= godzinkiCost.karnet10,
  };
  if (godzinkiBalance < Math.max(godzinkiCost.karnet5, godzinkiCost.karnet10)) {
    reasons.push(`Karnet wymaga godzinek wypracowanych: karnet 5 — ${godzinkiCost.karnet5}, karnet 10 — ${godzinkiCost.karnet10} (masz ${godzinkiBalance}).`);
  }
  return {member, eligible: byProduct.karnet5 || byProduct.karnet10, byProduct, godzinkiCost, duesPaid, godzinkiBalance, reasons};
}

/**
 * Pobiera godzinki za karnet w ISTNIEJĄCEJ transakcji (przed jej zapisami): sprawdza saldo
 * godzinek wypracowanych ≥ koszt i zdejmuje koszt (spend, reservationId basen_karnet_{wpis}).
 */
export async function chargeKarnetGodzinkiInTx(
  tx: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  args: {uid: string; product: KarnetProduct; ledgerId: string; vars: BasenVars}
): Promise<void> {
  const cost = karnetGodzinkiCost(args.product, args.vars);
  if (cost <= 0) return;
  const snap = await tx.get(db.collection("godzinki_ledger").where("uid", "==", args.uid));
  const earned = computeEarnedBalance(snap.docs.map((d) => ({id: d.id, ...d.data()} as GodzinkiRecord)));
  if (earned < cost) {
    throw new ClientError(`Karnet wymaga ${cost} godzinek wypracowanych — saldo użytkownika: ${earned}.`);
  }
  const r = await deductHoursInTx(tx, db, args.uid, {
    amount: cost,
    reason: `Karnet basenowy ${args.product === "karnet5" ? 5 : 10} — dofinansowanie`,
    reservationId: `basen_karnet_${args.ledgerId}`,
    force: true, // saldo wypracowane ≥ koszt, więc nie schodzi poniżej zera
  }, await getGodzinkiVars(db));
  if (!r.ok) throw new ClientError(r.message || "Nie udało się pobrać godzinek za karnet.");
}

/** Ręczne dopisanie karnetu przez opiekuna: godzinki za karnet + godziny basenowe w jednej transakcji. */
export async function adminAddKarnet(
  db: FirebaseFirestore.Firestore,
  args: {uid: string; product: KarnetProduct; reason: string; performedBy: string; vars: BasenVars}
): Promise<string> {
  const ledgerRef = db.collection("basen_godziny_ledger").doc();
  await db.runTransaction(async (tx) => {
    await chargeKarnetGodzinkiInTx(tx, db, {uid: args.uid, product: args.product, ledgerId: ledgerRef.id, vars: args.vars});
    adminAddBasenGodzinyInTx(tx, ledgerRef, {
      uid: args.uid, product: args.product, count: 0, reason: args.reason, performedBy: args.performedBy,
      pricing: args.vars, karnetValidUntil: args.vars.basen_koniec_sezonu,
    });
  });
  return ledgerRef.id;
}

/** Liczba godzin basenowych w zamówieniu (karnet ma ją z góry). Rzuca ClientError. */
export function validateOrderInput(product: string, count: unknown): {product: BasenProduct; count: number} {
  if (!PRODUCTS.includes(product as BasenProduct)) {
    throw new ClientError("Wybierz produkt: godziny basenowe pojedyncze, karnet 5 albo karnet 10.");
  }
  if (product !== "jednorazowe") return {product: product as BasenProduct, count: 0};
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) throw new ClientError("Liczba godzin basenowych musi być większa od 0.");
  if (n > MAX_SINGLE_COUNT) throw new ClientError(`Jednorazowo najwyżej ${MAX_SINGLE_COUNT} godzin basenowych.`);
  return {product: "jednorazowe", count: n};
}

/** Tytuł przelewu bez znaków specjalnych (banki odrzucają np. „×"): „Basen karnet 5 Jan Kowalski AB12CD". */
function transferTitle(userName: string, product: BasenProduct, count: number, orderId: string): string {
  const what = product === "jednorazowe" ? `${count} godz` : `karnet ${product === "karnet5" ? 5 : 10}`;
  return `Basen ${what} ${userName} ${orderId.slice(0, 6).toUpperCase()}`.replace(/\s+/g, " ").trim();
}

function queueJob(tx: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore, taskId: string, payload: Record<string, unknown>) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const jobRef = db.collection("service_jobs").doc();
  tx.set(jobRef, {id: jobRef.id, taskId, payload, status: "queued", attempts: 0, createdAt: now, updatedAt: now});
}

export async function createOrder(
  db: FirebaseFirestore.Firestore,
  args: {uid: string; userData: any; userName: string; product: string; count: unknown; pricing: ProductPricing}
): Promise<BasenOrder> {
  const input = validateOrderInput(args.product, args.count);
  if (input.product !== "jednorazowe") {
    const el = await getKarnetEligibility(db, args.uid, args.userData);
    if (!el.byProduct[input.product]) throw new ClientError(el.reasons.join(" ") || "Karnet niedostępny.");
  }
  const priced = priceProduct(input.product, input.count, args.pricing);
  const ref = db.collection(ORDERS).doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const order: BasenOrder = {
    id: ref.id,
    uid: args.uid,
    userEmail: String(args.userData?.email || "").trim().toLowerCase(),
    userName: args.userName,
    product: input.product,
    count: priced.entries,
    unitPricePln: priced.unitPricePln,
    amountPln: priced.amountPln,
    label: priced.label,
    transferTitle: transferTitle(args.userName, input.product, priced.entries, ref.id),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await db.runTransaction(async (tx) => {
    tx.set(ref, order);
    queueJob(tx, db, "basen.notifyOrder", {orderId: ref.id, kind: "created"});
  });
  return order;
}

export async function cancelOwnOrder(db: FirebaseFirestore.Firestore, args: {uid: string; orderId: string}): Promise<void> {
  const ref = db.collection(ORDERS).doc(args.orderId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const o = snap.data() as BasenOrder | undefined;
    if (!snap.exists || !o || o.uid !== args.uid) throw new ClientError("Zamówienie nie istnieje.");
    if (o.status !== "pending") throw new ClientError("Można anulować tylko niezatwierdzone zamówienie.");
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(ref, {status: "cancelled", decidedBy: args.uid, decidedAt: now, updatedAt: now});
  });
}

/**
 * Zatwierdzenie wpłaty: godziny basenowe na saldo po cenach z chwili zamówienia
 * (użytkownik zapłacił kwotę z maila, nawet jeśli cennik w SETUP zmienił się w międzyczasie).
 */
export async function approveOrder(db: FirebaseFirestore.Firestore, args: {orderId: string; performedBy: string}): Promise<{ledgerId: string; uid: string}> {
  const ref = db.collection(ORDERS).doc(args.orderId);
  const ledgerRef = db.collection("basen_godziny_ledger").doc();
  const vars = await getBasenVars(db);
  const karnetValidUntil = vars.basen_koniec_sezonu;
  let uid = "";
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const o = snap.data() as BasenOrder | undefined;
    if (!snap.exists || !o) throw new ClientError("Zamówienie nie istnieje.");
    if (o.status !== "pending") throw new ClientError("Zamówienie zostało już rozpatrzone albo anulowane.");
    uid = o.uid;
    // Karnet = dofinansowanie: godzinki zdejmowane dopiero przy zatwierdzeniu wpłaty.
    if (o.product !== "jednorazowe") {
      await chargeKarnetGodzinkiInTx(tx, db, {uid: o.uid, product: o.product, ledgerId: ledgerRef.id, vars});
    }
    const pricing: ProductPricing = {
      basen_cena_za_godzine: o.unitPricePln,
      basen_cena_karnet_5: o.product === "karnet5" ? o.amountPln : 0,
      basen_cena_karnet_10: o.product === "karnet10" ? o.amountPln : 0,
    };
    adminAddBasenGodzinyInTx(tx, ledgerRef, {
      uid: o.uid,
      product: o.product,
      count: o.count,
      reason: `zamówienie ${o.id.slice(0, 6).toUpperCase()}, wpłata potwierdzona`,
      performedBy: args.performedBy,
      pricing,
      orderId: o.id,
      karnetValidUntil,
    });
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(ref, {status: "approved", decidedBy: args.performedBy, decidedAt: now, ledgerId: ledgerRef.id, updatedAt: now});
  });
  return {ledgerId: ledgerRef.id, uid};
}

export async function rejectOrder(db: FirebaseFirestore.Firestore, args: {orderId: string; performedBy: string; reason: string}): Promise<void> {
  const reason = String(args.reason || "").trim();
  if (!reason) throw new ClientError("Podaj powód odrzucenia.");
  const ref = db.collection(ORDERS).doc(args.orderId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const o = snap.data() as BasenOrder | undefined;
    if (!snap.exists || !o) throw new ClientError("Zamówienie nie istnieje.");
    if (o.status !== "pending") throw new ClientError("Zamówienie zostało już rozpatrzone albo anulowane.");
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(ref, {status: "rejected", rejectReason: reason.slice(0, 300), decidedBy: args.performedBy, decidedAt: now, updatedAt: now});
    queueJob(tx, db, "basen.notifyOrder", {orderId: o.id, kind: "rejected"});
  });
}

function serialize(o: BasenOrder) {
  const ts = (v: any) => (v && typeof v.toDate === "function" ? v.toDate().toISOString() : null);
  return {
    id: o.id, uid: o.uid, userEmail: o.userEmail, userName: o.userName, product: o.product, count: o.count,
    amountPln: o.amountPln, label: o.label, transferTitle: o.transferTitle, status: o.status,
    rejectReason: o.rejectReason || null, createdAt: ts(o.createdAt), decidedAt: ts(o.decidedAt),
  };
}

/** Zamówienia użytkownika: oczekujące + 5 ostatnich rozpatrzonych, od najnowszych. */
export async function listUserOrders(db: FirebaseFirestore.Firestore, uid: string) {
  const snap = await db.collection(ORDERS).where("uid", "==", uid).get();
  const all = snap.docs.map((d) => d.data() as BasenOrder)
    .sort((a, b) => ((b.createdAt as any)?.toMillis?.() ?? 0) - ((a.createdAt as any)?.toMillis?.() ?? 0));
  return [...all.filter((o) => o.status === "pending"), ...all.filter((o) => o.status !== "pending").slice(0, 5)].map(serialize);
}

/** Zamówienia czekające na potwierdzenie wpłaty — panel opiekunów basenu, od najstarszych. */
export async function listPendingOrders(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection(ORDERS).where("status", "==", "pending").get();
  return snap.docs.map((d) => d.data() as BasenOrder)
    .sort((a, b) => ((a.createdAt as any)?.toMillis?.() ?? 0) - ((b.createdAt as any)?.toMillis?.() ?? 0))
    .map(serialize);
}
