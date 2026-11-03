import * as admin from "firebase-admin";
import {getAppVars, AppVars} from "../setup/app_vars";
import {resolveFunctionRoleEmail} from "../setup/function_roles_service";
import {todayWarsawIso} from "../shared/date_range_utils";
import {normNullish} from "../shared/text_utils";
import {MEMBER_ROLE_KEYS, effectivePaidUntilIso} from "../users/member_standing";

/**
 * Składki i wpisowe zgłaszane w aplikacji (plan: DOCS/Sessions & TO DOs/01.11_skladki_zglaszanie_PLAN.md).
 *
 * Członek zgłasza wpłatę (dues_orders, status pending) i dostaje mail z danymi przelewu.
 * Skarbnik potwierdza → job dues.writeBack wpisuje nową datę do kolumny „Składki" w arkuszu
 * członków i dopiero potem do bazy (arkusz jest jedynym źródłem daty). Kandydat płaci wpisowe
 * = 2 × składka, zawsze za 2 semestry (dopóki Zarząd nie przyjmie go na członka).
 *
 * Nowa data: brak daty (pierwsza wpłata) → koniec bieżącego semestru + (n − 1) kolejnych;
 * jest data → od niej n kolejnych końców semestrów (zaległość schodzi pierwsza).
 * Zaległość powyżej skladki_max_zaleglosc_semestrow → tylko po kontakcie z Zarządem.
 */

export const DUES_ORDERS = "dues_orders";
export const ENTRY_FEE_SEMESTERS = 2;
/** Techniczny górny limit semestrów w jednym zgłoszeniu (ochrona przed literówką; decyzja: bez limitu biznesowego). */
export const MAX_SEMESTERS_PER_ORDER = 99;
export const ADMIN_EMAIL = "admin@morzkulc.pl";

export class DuesClientError extends Error {}

export type DuesKind = "skladka" | "wpisowe";
export type DuesOrderStatus = "pending" | "approved" | "rejected" | "cancelled";
export type WriteBackStatus = "pending" | "done" | "conflict";

export interface DuesOrder {
  id: string;
  uid: string;
  memberId: number;
  userEmail: string;
  userName: string;
  kind: DuesKind;
  semesters: number;
  unitPln: number;
  amountPln: number;
  transferTitle: string;
  status: DuesOrderStatus;
  rejectReason?: string;
  decidedBy?: string;
  writeBack?: {status: WriteBackStatus; from: string; to: string; message?: string};
  createdAt: any;
  updatedAt: any;
  decidedAt?: any;
}

// ─── Daty semestrów ─────────────────────────────────────────────────────────

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Koniec semestru „mm-dd” z SETUP w danym roku; „02-28” = ostatni dzień lutego. */
function endInYear(year: number, mmdd: string): string {
  if (mmdd === "02-28" || mmdd === "02-29") return `${year}-02-${isLeap(year) ? "29" : "28"}`;
  return `${year}-${mmdd}`;
}

function endsAround(year: number, semesterEnds: string[]): string[] {
  const out: string[] = [];
  for (const y of [year - 1, year, year + 1]) for (const e of semesterEnds) out.push(endInYear(y, e));
  return out.sort();
}

/** Najbliższy koniec semestru ≥ iso. */
export function semesterEndOnOrAfter(iso: string, semesterEnds: string[]): string {
  return endsAround(Number(iso.slice(0, 4)), semesterEnds).find((e) => e >= iso) as string;
}

/** Najbliższy koniec semestru > iso. */
export function semesterEndAfter(iso: string, semesterEnds: string[]): string {
  return endsAround(Number(iso.slice(0, 4)), semesterEnds).find((e) => e > iso) as string;
}

/**
 * Liczba zaległych semestrów: końce semestrów po „opłacone do” aż do końca bieżącego semestru.
 * null = brak daty (nigdy nie płacone / pierwsza wpłata). 0 = opłacone.
 */
export function overdueSemesters(paidUntilRaw: any, todayIso: string, semesterEnds: string[]): number | null {
  const paid = effectivePaidUntilIso(paidUntilRaw);
  if (!paid) return null;
  if (paid >= todayIso) return 0;
  const current = semesterEndOnOrAfter(todayIso, semesterEnds);
  let n = 0;
  for (let e = semesterEndAfter(paid, semesterEnds); e <= current; e = semesterEndAfter(e, semesterEnds)) n++;
  return n;
}

/** Nowe „opłacone do” po wpłacie za n semestrów. */
export function paidUntilAfterPayment(paidUntilRaw: any, semesters: number, todayIso: string, semesterEnds: string[]): string {
  const paid = effectivePaidUntilIso(paidUntilRaw);
  let e = paid ? semesterEndAfter(paid, semesterEnds) : semesterEndOnOrAfter(todayIso, semesterEnds);
  for (let i = 1; i < semesters; i++) e = semesterEndAfter(e, semesterEnds);
  return e;
}

// ─── Status członka ─────────────────────────────────────────────────────────

export function duesKindFor(userData: any): DuesKind {
  return String(userData?.role_key || "") === "rola_kandydat" ? "wpisowe" : "skladka";
}

/** Tytuł przelewu: „Składka Jan Kowalski (ID: 12); AB12CD” — kod = numer zgłoszenia (decyzja 02.11.2026). */
export function transferTitle(kind: DuesKind, userName: string, memberId: number, orderId: string): string {
  const what = kind === "wpisowe" ? "Wpisowe" : "Składka";
  const name = userName.replace(/[^\p{L}0-9 -]/gu, "").replace(/\s+/g, " ").trim();
  return `${what} ${name} (ID: ${memberId}); ${orderId.slice(0, 6).toUpperCase()}`;
}

export interface DuesStatus {
  /** Czy osoba w ogóle płaci składki/wpisowe przez aplikację. */
  applicable: boolean;
  /** Czy można teraz zgłosić wpłatę (gdy nie — reason). */
  canOrder: boolean;
  reason: string;
  kind: DuesKind;
  paidUntil: string;
  paid: boolean;
  overdue: number | null;
  /** Zaległość powyżej limitu — wpłata tylko po kontakcie z Zarządem. */
  blocked: boolean;
  maxOverdue: number;
  feePln: number;
  /** Wpisowe: zawsze 2 semestry. */
  fixedSemesters: number | null;
  clubAccount: string;
  clubBank: string;
}

export function computeDuesStatus(userData: any, vars: AppVars, todayIso: string = todayWarsawIso()): DuesStatus {
  const kind = duesKindFor(userData);
  const raw = normNullish(userData?.admin?.contributions);
  const paidUntil = effectivePaidUntilIso(raw);
  const base = {
    kind, paidUntil, paid: Boolean(paidUntil && paidUntil >= todayIso), maxOverdue: vars.duesMaxOverdueSemesters,
    feePln: vars.duesFeePln, fixedSemesters: kind === "wpisowe" ? ENTRY_FEE_SEMESTERS : null,
    clubAccount: vars.clubAccount, clubBank: vars.clubBank,
  };
  if (!MEMBER_ROLE_KEYS.includes(String(userData?.role_key || ""))) {
    return {...base, applicable: false, canOrder: false, reason: "Składki dotyczą członków i kandydatów klubu.", overdue: null, blocked: false};
  }
  if (!vars.semesterEnds.length || vars.duesFeePln <= 0) {
    return {...base, applicable: true, canOrder: false, reason: "Zgłaszanie wpłat chwilowo niedostępne (brak ustawień składek w SETUP).", overdue: null, blocked: false};
  }
  const overdue = overdueSemesters(raw, todayIso, vars.semesterEnds);
  const blocked = overdue !== null && overdue > vars.duesMaxOverdueSemesters;
  if (blocked) {
    return {...base, applicable: true, canOrder: false, overdue, blocked,
      reason: `Zaległość w składkach przekracza ${vars.duesMaxOverdueSemesters} semestrów — skontaktuj się z Zarządem (zarzad@morzkulc.pl), który zdecyduje o dalszym postępowaniu.`};
  }
  if (!userData?.memberId) {
    return {...base, applicable: true, canOrder: false, overdue, blocked,
      reason: "Brak numeru członkowskiego w arkuszu członków — skontaktuj się z Zarządem."};
  }
  return {...base, applicable: true, canOrder: true, reason: "", overdue, blocked};
}

/**
 * Przypomnienie (pop-up przy każdym otwarciu aplikacji, bez konsekwencji): zaległość
 * większa niż skladki_popup_zaleglosc_semestrow. Brak daty (null) — bez pop-upu.
 */
export function duesOverdueReminder(userData: any, vars: AppVars, todayIso: string = todayWarsawIso()): {overdue: number; paidUntil: string} | null {
  const st = computeDuesStatus(userData, vars, todayIso);
  if (!st.applicable || st.overdue === null || st.overdue <= vars.duesPopupOverdueSemesters) return null;
  return {overdue: st.overdue, paidUntil: st.paidUntil};
}

/** Podgląd: nowa data i kwota dla 1..maxN semestrów (wpisowe: tylko 2). */
export function duesPreviews(status: DuesStatus, semesterEnds: string[], todayIso: string, maxN = 12): Array<{semesters: number; paidUntil: string; amountPln: number}> {
  const ns = status.fixedSemesters ? [status.fixedSemesters] : Array.from({length: maxN}, (_, i) => i + 1);
  return ns.map((n) => ({semesters: n, paidUntil: paidUntilAfterPayment(status.paidUntil, n, todayIso, semesterEnds), amountPln: n * status.feePln}));
}

// ─── Uprawnienia ────────────────────────────────────────────────────────────

/** Skarbnik (operator funkcji „skarbnik”) albo admin@ — tylko on obsługuje składki. */
export async function isTreasurer(db: FirebaseFirestore.Firestore, email: string): Promise<boolean> {
  const e = normNullish(email).toLowerCase();
  if (!e) return false;
  if (e === ADMIN_EMAIL) return true;
  return (await resolveFunctionRoleEmail(db, "skarbnik")) === e;
}

// ─── Zgłoszenia ─────────────────────────────────────────────────────────────

function enqueueJobInTx(tx: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore, taskId: string, payload: Record<string, unknown>): void {
  const jobRef = db.collection("service_jobs").doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  tx.set(jobRef, {id: jobRef.id, taskId, payload, status: "queued", attempts: 0, createdAt: now, updatedAt: now});
}

export async function createDuesOrder(
  db: FirebaseFirestore.Firestore,
  args: {uid: string; userData: any; userName: string; semesters: unknown}
): Promise<DuesOrder> {
  const vars = await getAppVars(db);
  const status = computeDuesStatus(args.userData, vars);
  if (!status.canOrder) throw new DuesClientError(status.reason || "Zgłoszenie wpłaty niedostępne.");
  const semesters = status.fixedSemesters ?? Math.floor(Number(args.semesters));
  if (!Number.isFinite(semesters) || semesters < 1 || semesters > MAX_SEMESTERS_PER_ORDER) {
    throw new DuesClientError(`Podaj liczbę semestrów od 1 do ${MAX_SEMESTERS_PER_ORDER}.`);
  }
  const ref = db.collection(DUES_ORDERS).doc();
  const memberId = Number(args.userData.memberId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const order: DuesOrder = {
    id: ref.id,
    uid: args.uid,
    memberId,
    userEmail: normNullish(args.userData?.email).toLowerCase(),
    userName: args.userName,
    kind: status.kind,
    semesters,
    unitPln: vars.duesFeePln,
    amountPln: semesters * vars.duesFeePln,
    transferTitle: transferTitle(status.kind, args.userName, memberId, ref.id),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await db.runTransaction(async (tx) => {
    // Jedno otwarte zgłoszenie na osobę (oczekujące albo zatwierdzone, ale jeszcze bez zapisu w arkuszu).
    const open = await tx.get(db.collection(DUES_ORDERS).where("uid", "==", args.uid));
    const busy = open.docs.some((d) => {
      const o = d.data() as DuesOrder;
      return o.status === "pending" || (o.status === "approved" && o.writeBack?.status === "pending");
    });
    if (busy) throw new DuesClientError("Masz już zgłoszoną wpłatę, która czeka na potwierdzenie skarbnika.");
    tx.set(ref, order);
    enqueueJobInTx(tx, db, "dues.notifyOrder", {orderId: ref.id, kind: "created"});
  });
  return order;
}

export async function cancelOwnDuesOrder(db: FirebaseFirestore.Firestore, args: {uid: string; orderId: string}): Promise<void> {
  const ref = db.collection(DUES_ORDERS).doc(args.orderId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const o = snap.data() as DuesOrder | undefined;
    if (!snap.exists || !o || o.uid !== args.uid) throw new DuesClientError("Zgłoszenie nie istnieje.");
    if (o.status !== "pending") throw new DuesClientError("Zgłoszenie zostało już rozpatrzone.");
    tx.update(ref, {status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp()});
  });
}

/**
 * Potwierdzenie wpłaty przez skarbnika: wylicza nową datę od obecnej (z bazy = arkusz po syncu)
 * i kolejkuje dues.writeBack (arkusz → baza → mail). Arkusz sprawdzany jeszcze raz w jobie.
 */
export async function approveDuesOrder(db: FirebaseFirestore.Firestore, args: {orderId: string; performedBy: string; todayIso?: string}): Promise<{from: string; to: string}> {
  const vars = await getAppVars(db);
  if (!vars.semesterEnds.length) throw new DuesClientError("Brak końców semestrów w SETUP.");
  const today = args.todayIso || todayWarsawIso();
  const ref = db.collection(DUES_ORDERS).doc(args.orderId);
  let result = {from: "", to: ""};
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const o = snap.data() as DuesOrder | undefined;
    if (!snap.exists || !o) throw new DuesClientError("Zgłoszenie nie istnieje.");
    if (o.status !== "pending") throw new DuesClientError("Zgłoszenie zostało już rozpatrzone albo anulowane.");
    const userSnap = await tx.get(db.collection("users_active").doc(o.uid));
    const from = effectivePaidUntilIso((userSnap.data() as any)?.admin?.contributions);
    const to = paidUntilAfterPayment(from, o.semesters, today, vars.semesterEnds);
    result = {from, to};
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(ref, {status: "approved", decidedBy: args.performedBy, decidedAt: now, updatedAt: now,
      writeBack: {status: "pending", from, to}});
    enqueueJobInTx(tx, db, "dues.writeBack", {orderId: o.id});
  });
  return result;
}

export async function rejectDuesOrder(db: FirebaseFirestore.Firestore, args: {orderId: string; performedBy: string; reason: string}): Promise<void> {
  const reason = normNullish(args.reason);
  if (!reason) throw new DuesClientError("Podaj powód odrzucenia.");
  const ref = db.collection(DUES_ORDERS).doc(args.orderId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const o = snap.data() as DuesOrder | undefined;
    if (!snap.exists || !o) throw new DuesClientError("Zgłoszenie nie istnieje.");
    if (o.status !== "pending") throw new DuesClientError("Zgłoszenie zostało już rozpatrzone albo anulowane.");
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(ref, {status: "rejected", rejectReason: reason, decidedBy: args.performedBy, decidedAt: now, updatedAt: now});
    enqueueJobInTx(tx, db, "dues.notifyOrder", {orderId: o.id, kind: "rejected"});
  });
}

/** Otwarte zgłoszenie osoby: oczekujące albo zatwierdzone w trakcie zapisu do arkusza. */
export async function getOpenDuesOrder(db: FirebaseFirestore.Firestore, uid: string): Promise<DuesOrder | null> {
  const snap = await db.collection(DUES_ORDERS).where("uid", "==", uid).get();
  const open = snap.docs.map((d) => d.data() as DuesOrder)
    .filter((o) => o.status === "pending" || (o.status === "approved" && o.writeBack?.status !== "done"));
  return open[0] || null;
}

export function formatPln(n: number): string {
  return `${Number(n || 0).toFixed(2).replace(".", ",").replace(",00", "")} zł`;
}

/** "2027-02-28" → "28.02.2027". */
export function formatDatePl(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso || "—";
}
