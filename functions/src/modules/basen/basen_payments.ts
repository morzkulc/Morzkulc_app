import * as admin from "firebase-admin";
import {BasenSession, ClientError, isSessionCancelled, todayIso} from "./basen_service";

/**
 * Rozliczenie terminów z basenem (prośba obsługi basenu, 24.11.2026) — prosty znacznik
 * przy odbytym terminie, bez kwot i numerów faktur:
 *  - brak pola    = do rozliczenia,
 *  - "invoice"    = faktura wystawiona,
 *  - "cash"       = zapłacono gotówką (z datą zapłaty).
 * Oznacza wyłącznie obsługa basenu (resolveBasenAdminGrant). Terminy kursowe tak samo jak reszta.
 */
export type BasenPaymentStatus = "invoice" | "cash";

export interface BasenSessionPayment {
  status: BasenPaymentStatus;
  date: string | null; // data zapłaty gotówką; null dla faktury
  markedBy: string;
  markedAt: any;
}

export const MAX_SESSIONS_PER_CALL = 100;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export type PaymentInput = {sessionIds: string[]; status: string; date?: string};

/** Walidacja wejścia (czysta). status "none" = cofnięcie do „do rozliczenia”. */
export function parsePaymentInput(body: any, today: string = todayIso()): {sessionIds: string[]; status: BasenPaymentStatus | "none"; date: string | null} {
  const ids = Array.isArray(body?.sessionIds) ? body.sessionIds.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  const sessionIds = Array.from(new Set<string>(ids));
  if (!sessionIds.length) throw new ClientError("Zaznacz co najmniej jeden termin.");
  if (sessionIds.length > MAX_SESSIONS_PER_CALL) throw new ClientError(`Maksymalnie ${MAX_SESSIONS_PER_CALL} terminów naraz.`);
  const status = String(body?.status || "").trim();
  if (status !== "invoice" && status !== "cash" && status !== "none") throw new ClientError("Nieznany status rozliczenia.");
  let date: string | null = null;
  if (status === "cash") {
    date = String(body?.date || "").trim();
    if (!ISO.test(date)) throw new ClientError("Podaj datę zapłaty gotówką.");
    if (date > today) throw new ClientError("Data zapłaty nie może być z przyszłości.");
  }
  return {sessionIds, status, date};
}

/** Oznacza (lub cofa) rozliczenie odbytych terminów — jedna transakcja na całą paczkę. */
export async function setSessionsPayment(
  db: FirebaseFirestore.Firestore,
  args: {sessionIds: string[]; status: BasenPaymentStatus | "none"; date: string | null; markedBy: string; today?: string}
): Promise<{updated: number}> {
  const today = args.today || todayIso();
  const refs = args.sessionIds.map((id) => db.collection("basen_sessions").doc(id));
  await db.runTransaction(async (tx) => {
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    for (const snap of snaps) {
      if (!snap.exists) throw new ClientError(`Nie znaleziono terminu ${snap.id}.`);
      const s = snap.data() as BasenSession;
      if (isSessionCancelled(s)) throw new ClientError(`Termin ${snap.id} jest odwołany — nie rozlicza się go.`);
      if (String(s.date || snap.id) >= today) throw new ClientError(`Termin ${snap.id} jeszcze się nie odbył.`);
    }
    for (const ref of refs) {
      if (args.status === "none") {
        tx.update(ref, {payment: admin.firestore.FieldValue.delete()});
      } else {
        const payment: BasenSessionPayment = {
          status: args.status,
          date: args.status === "cash" ? args.date : null,
          markedBy: args.markedBy,
          markedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        tx.update(ref, {payment});
      }
    }
  });
  return {updated: refs.length};
}
